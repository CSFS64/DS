const REGION_GEOJSON_URLS = [
  "data/russia.geojson",
  "https://raw.githubusercontent.com/codeforgermany/click_that_hood/main/public/data/russia.geojson",
];
const PRIMARY_TILE_URL = "https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png";
const OSM_FALLBACK_TILE_URL = "https://tile.openstreetmap.org/{z}/{x}/{y}.png";
const MOSCOW_OFFSET = "+03:00";

const state = {
  archive: null,
  sources: null,
  regions: null,
  map: null,
  tileLayer: null,
  tileErrors: 0,
  regionLayers: new Map(),
  cityMarkers: new Map(),
  currentMs: 0,
  timelineStartMs: 0,
  timelineEndMs: 0,
  timer: null,
};

const $ = (id) => document.getElementById(id);
const els = {
  dataStatus: $("dataStatus"), archiveLamp: $("archiveLamp"), detailPanel: $("detailPanel"),
  detailClose: $("detailClose"), detailEyebrow: $("detailEyebrow"), detailTitle: $("detailTitle"),
  detailBody: $("detailBody"), detailSource: $("detailSource"), dateStart: $("dateStart"), dateEnd: $("dateEnd"),
  tickLayer: $("tickLayer"), eventBars: $("eventBars"), selectionBand: $("selectionBand"), reportDots: $("reportDots"),
  rangeStart: $("rangeStart"), rangeEnd: $("rangeEnd"), handleStart: $("handleStart"), handleEnd: $("handleEnd"),
  playButton: $("playButton"), scrubber: $("scrubber"), currentTimeLabel: $("currentTimeLabel"), speedSelect: $("speedSelect"),
  clockMoscow: $("clockMoscow"), clockKyiv: $("clockKyiv"), clockBeijing: $("clockBeijing"),
};

function parseMoscowDate(dateStr, endOfDay = false) {
  const t = endOfDay ? "23:59:59" : "00:00:00";
  return Date.parse(`${dateStr}T${t}${MOSCOW_OFFSET}`);
}

function isoDateInZone(ms, zone = "Europe/Moscow") {
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone: zone, year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(new Date(ms));
  const by = Object.fromEntries(parts.map(p => [p.type, p.value]));
  return `${by.year}-${by.month}-${by.day}`;
}

function formatTime(ms, zone, includeDate = true) {
  const opts = { timeZone: zone, hour: "2-digit", minute: "2-digit", hour12: false };
  if (includeDate) Object.assign(opts, { month: "2-digit", day: "2-digit" });
  return new Intl.DateTimeFormat("zh-CN", opts).format(new Date(ms));
}

function formatDuration(start, end) {
  const mins = Math.max(0, Math.round((end - start) / 60000));
  const h = Math.floor(mins / 60), m = mins % 60;
  return h ? `${h}h ${m}m` : `${m}m`;
}

function normalizeAdminName(value) {
  return String(value || "")
    .toLowerCase()
    .replace(/ё/g, "е")
    .replace(/[–—−]/g, "-")
    .replace(/[^a-zа-я0-9]+/g, " ")
    .trim();
}

function sourcePlaceIndex() {
  const map = new Map();
  for (const source of state.sources.sources || []) {
    for (const place of source.places || []) {
      const key = `${source.region}::${place.name}`;
      if (!map.has(key)) map.set(key, place);
    }
  }
  return map;
}

async function loadJson(path) {
  const res = await fetch(path, { cache: "no-store" });
  if (!res.ok) throw new Error(`${path}: HTTP ${res.status}`);
  return res.json();
}

async function init() {
  try {
    [state.archive, state.sources, state.regions] = await Promise.all([
      loadJson("data/events.json"),
      loadJson("data/sources.json"),
      loadJson("data/regions.json"),
    ]);
  } catch (err) {
    console.error(err);
    els.dataStatus.textContent = "DATA LOAD FAILED";
    return;
  }

  initMap();
  await loadRegions();
  createCityLamps();
  initializeDates();
  wireControls();
  rebuildTimeline();
  render();
  updateDataStatus();
}

function updateDataStatus() {
  const generated = state.archive.generated_at ? formatTime(Date.parse(state.archive.generated_at), "Europe/Moscow") : "—";
  const c = state.archive.coverage || {};
  const configured = c.regions_configured ?? state.regions.regions?.length ?? 0;
  const rssOk = c.regions_rss_ok;
  const hiRes = c.high_resolution_sources_configured ?? state.sources.sources?.filter(s => s.enabled).length ?? 0;
  const coverageText = configured
    ? `${Number.isInteger(rssOk) ? `${rssOk}/${configured}` : `PENDING/${configured}`} REGION FEEDS · ${hiRes} HIGH-RES`
    : `${hiRes} HIGH-RES`;
  els.dataStatus.textContent = `${state.archive.events.length} PAIRED ALERTS · ${coverageText} · UPDATED ${generated} MSK · ${state.archive.safety_lag_hours ?? 24}H ARCHIVE LAG`;
}

function initMap() {
  state.map = L.map("map", {
    zoomControl: true,
    attributionControl: true,
    minZoom: 3,
    maxZoom: 11,
    preferCanvas: true,
  }).setView([53.2, 39.0], 5);

  state.tileLayer = L.tileLayer(PRIMARY_TILE_URL, {
    subdomains: "abcd",
    maxZoom: 20,
    maxNativeZoom: 20,
    attribution: "© OpenStreetMap contributors © CARTO",
    updateWhenIdle: true,
    updateWhenZooming: false,
    keepBuffer: 4,
  });

  state.tileLayer.on("tileerror", (ev) => {
    state.tileErrors += 1;
    const tile = ev.tile;
    const coords = ev.coords;
    if (!tile || !coords) return;

    // One coordinate-preserving fallback attempt. The previous build had no
    // tileerror handler, so a single failed raster request remained a black square.
    if (tile.dataset.fallbackProvider !== "osm") {
      tile.dataset.fallbackProvider = "osm";
      tile.src = OSM_FALLBACK_TILE_URL
        .replace("{z}", String(coords.z))
        .replace("{x}", String(coords.x))
        .replace("{y}", String(coords.y));
      return;
    }

    // If both providers fail, keep the map usable without a broken-image icon.
    tile.style.visibility = "hidden";
  });

  state.tileLayer.addTo(state.map);
}

async function fetchRegionGeoJson() {
  let lastError = null;
  for (const url of REGION_GEOJSON_URLS) {
    try {
      const res = await fetch(url, { cache: "force-cache" });
      if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
      return await res.json();
    } catch (err) {
      lastError = err;
    }
  }
  throw lastError || new Error("No region GeoJSON source available");
}

function regionAliases(region) {
  return [region.region, region.region_label, ...(region.geo_aliases || [])]
    .map(normalizeAdminName)
    .filter(Boolean);
}

async function loadRegions() {
  try {
    const data = await fetchRegionGeoJson();
    const featureLayers = [];
    L.geoJSON(data, {
      style: () => regionStyle(false),
      onEachFeature: (feature, layer) => {
        const names = new Set();
        for (const value of Object.values(feature.properties || {})) {
          if (typeof value === "string" && value.length < 160) names.add(normalizeAdminName(value));
        }
        featureLayers.push({ layer, names, feature });
      },
    }).addTo(state.map);

    for (const region of state.regions.regions || []) {
      const aliases = regionAliases(region);
      const matched = featureLayers.find(entry => aliases.some(a => entry.names.has(a)));
      if (matched) state.regionLayers.set(region.region, matched.layer);
    }

    // Preserve compatibility with event names that are already exact GeoJSON values.
    for (const entry of featureLayers) {
      for (const name of entry.names) {
        if (!state.regionLayers.has(name)) state.regionLayers.set(name, entry.layer);
      }
    }
  } catch (err) {
    console.warn("Region GeoJSON unavailable; region highlighting limited to configured center fallbacks", err);
    for (const source of state.sources.sources || []) {
      if (!source.region_center || state.regionLayers.has(source.region)) continue;
      const layer = L.circle(source.region_center, { radius: 120000, ...regionStyle(false) }).addTo(state.map);
      state.regionLayers.set(source.region, layer);
    }
  }
}

function regionStyle(active) {
  return active ? {
    color: "#39d8ff", weight: 1.7, opacity: .95, fillColor: "#39d8ff", fillOpacity: .13,
  } : {
    color: "#2b485a", weight: .7, opacity: .28, fillColor: "#071018", fillOpacity: 0,
  };
}

function getRegionLayer(regionName) {
  if (state.regionLayers.has(regionName)) return state.regionLayers.get(regionName);
  const region = (state.regions.regions || []).find(r => r.region === regionName);
  if (region) {
    for (const alias of regionAliases(region)) {
      if (state.regionLayers.has(alias)) return state.regionLayers.get(alias);
    }
  }
  return null;
}

function createCityLamps() {
  const index = sourcePlaceIndex();
  for (const [key, place] of index) {
    if (place.lat == null || place.lon == null) continue;
    const icon = L.divIcon({
      className: "city-lamp-icon",
      html: `<div class="city-lamp-wrap"><div class="city-lamp"></div><div class="city-lamp-label">${escapeHtml(place.label || place.name)}</div></div>`,
      iconSize: [96, 34], iconAnchor: [48, 8],
    });
    const marker = L.marker([place.lat, place.lon], { icon, keyboard: true }).addTo(state.map);
    marker.on("click", () => showPlaceDetail(key));
    state.cityMarkers.set(key, marker);
  }
}

function initializeDates() {
  const events = state.archive.events;
  const fallbackNow = Date.now() - 24 * 3600 * 1000;
  const minMs = events.length ? Math.min(...events.map(e => Date.parse(e.start))) : Date.parse(state.archive.window_start || fallbackNow);
  const maxMs = events.length ? Math.max(...events.map(e => Date.parse(e.end))) : Date.parse(state.archive.window_end || fallbackNow);
  els.dateStart.value = isoDateInZone(minMs);
  els.dateEnd.value = isoDateInZone(maxMs);
}

function wireControls() {
  els.dateStart.addEventListener("change", rebuildTimeline);
  els.dateEnd.addEventListener("change", rebuildTimeline);
  els.rangeStart.addEventListener("input", () => updateSelection("start"));
  els.rangeEnd.addEventListener("input", () => updateSelection("end"));
  els.scrubber.addEventListener("input", () => {
    state.currentMs = selectionStartMs() + (selectionEndMs() - selectionStartMs()) * (+els.scrubber.value / 1000);
    render();
  });
  els.playButton.addEventListener("click", togglePlayback);
  els.detailClose.addEventListener("click", () => { els.detailPanel.hidden = true; });
}

function rebuildTimeline() {
  if (!els.dateStart.value || !els.dateEnd.value) return;
  if (els.dateStart.value > els.dateEnd.value) els.dateEnd.value = els.dateStart.value;
  state.timelineStartMs = parseMoscowDate(els.dateStart.value, false);
  state.timelineEndMs = parseMoscowDate(els.dateEnd.value, true);
  els.rangeStart.value = 0;
  els.rangeEnd.value = 1000;
  state.currentMs = state.timelineStartMs;
  buildTicks();
  buildEventBars();
  buildReportDots();
  updateSelection();
}

function timelineMsFromRange(v) {
  return state.timelineStartMs + (state.timelineEndMs - state.timelineStartMs) * (v / 1000);
}
function selectionStartMs() { return timelineMsFromRange(+els.rangeStart.value); }
function selectionEndMs() { return timelineMsFromRange(+els.rangeEnd.value); }
function pctInTimeline(ms) { return ((ms - state.timelineStartMs) / (state.timelineEndMs - state.timelineStartMs)) * 100; }

function updateSelection(changed) {
  let a = +els.rangeStart.value, b = +els.rangeEnd.value;
  if (a > b) {
    if (changed === "start") b = a; else a = b;
    els.rangeStart.value = a; els.rangeEnd.value = b;
  }
  els.selectionBand.style.left = `${a / 10}%`;
  els.selectionBand.style.width = `${(b - a) / 10}%`;
  els.handleStart.style.left = `${a / 10}%`;
  els.handleEnd.style.left = `${b / 10}%`;
  els.handleStart.textContent = formatTime(timelineMsFromRange(a), "Europe/Moscow");
  els.handleEnd.textContent = formatTime(timelineMsFromRange(b), "Europe/Moscow");
  state.currentMs = Math.min(Math.max(state.currentMs, selectionStartMs()), selectionEndMs());
  render();
}

function buildTicks() {
  els.tickLayer.innerHTML = "";
  const duration = state.timelineEndMs - state.timelineStartMs;
  const days = duration / 86400000;
  const count = window.innerWidth < 520 ? 5 : days <= 2 ? 9 : days <= 7 ? 8 : 7;
  for (let i = 0; i < count; i++) {
    const p = i / (count - 1);
    const ms = state.timelineStartMs + duration * p;
    const tick = document.createElement("span"); tick.className = "tick"; tick.style.left = `${p * 100}%`;
    const label = document.createElement("span"); label.className = "tick-label"; label.style.left = `${p * 100}%`;
    label.textContent = days <= 1.5
      ? formatTime(ms, "Europe/Moscow", false)
      : new Intl.DateTimeFormat("zh-CN", { timeZone: "Europe/Moscow", month: "2-digit", day: "2-digit", hour: "2-digit", hour12: false }).format(new Date(ms));
    els.tickLayer.append(tick, label);
  }
}

function buildEventBars() {
  els.eventBars.innerHTML = "";
  for (const event of state.archive.events) {
    const start = Date.parse(event.start), end = Date.parse(event.end);
    if (end < state.timelineStartMs || start > state.timelineEndMs) continue;
    const left = Math.max(0, pctInTimeline(Math.max(start, state.timelineStartMs)));
    const right = Math.min(100, pctInTimeline(Math.min(end, state.timelineEndMs)));
    const bar = document.createElement("span");
    bar.className = `event-bar ${event.scope === "region" ? "region" : "city"}`;
    if (event.precision === "parent_region_fallback") bar.classList.add("fallback");
    bar.style.left = `${left}%`; bar.style.width = `${Math.max(.3, right - left)}%`;
    bar.title = `${event.place} ${formatTime(start, "Europe/Moscow")}–${formatTime(end, "Europe/Moscow")}`;
    els.eventBars.appendChild(bar);
  }
}

function buildReportDots() {
  els.reportDots.innerHTML = "";
  for (const report of state.archive.reports || []) {
    const ms = Date.parse(report.at);
    if (ms < state.timelineStartMs || ms > state.timelineEndMs) continue;
    const dot = document.createElement("button");
    dot.type = "button"; dot.className = "report-dot"; dot.style.left = `${pctInTimeline(ms)}%`;
    dot.title = `${report.place}: ${report.count ?? "—"}`;
    dot.addEventListener("click", () => showReportDetail(report));
    els.reportDots.appendChild(dot);
  }
}

function activeEvents() {
  return state.archive.events.filter(e => state.currentMs >= Date.parse(e.start) && state.currentMs <= Date.parse(e.end));
}

function render() {
  const active = activeEvents();
  renderMap(active);
  renderClocks(active);
  renderScrubber();
}

function renderMap(active) {
  // Reset all known region polygons once, then activate by canonical region id.
  const resetLayers = new Set();
  for (const region of state.regions.regions || []) {
    const layer = getRegionLayer(region.region);
    if (layer && !resetLayers.has(layer)) {
      layer.setStyle?.(regionStyle(false));
      resetLayers.add(layer);
    }
  }

  const activeRegions = new Set(active.filter(e => e.scope === "region").map(e => e.region));
  for (const regionName of activeRegions) {
    const layer = getRegionLayer(regionName);
    layer?.setStyle?.(regionStyle(true));
  }

  const activePlaces = new Set(active.filter(e => e.scope !== "region").map(e => `${e.region}::${e.place}`));
  for (const [key, marker] of state.cityMarkers) {
    const el = marker.getElement()?.querySelector(".city-lamp");
    if (el) el.classList.toggle("is-active", activePlaces.has(key));
  }
  els.archiveLamp.classList.toggle("on", active.length > 0);
}

function renderClocks(active) {
  els.clockMoscow.textContent = formatTime(state.currentMs, "Europe/Moscow");
  els.clockKyiv.textContent = formatTime(state.currentMs, "Europe/Kyiv");
  els.clockBeijing.textContent = formatTime(state.currentMs, "Asia/Shanghai");
  els.currentTimeLabel.textContent = `${formatTime(state.currentMs, "Europe/Moscow")} MSK · ${active.length} ACTIVE`;
}

function renderScrubber() {
  const a = selectionStartMs(), b = selectionEndMs();
  const p = b > a ? (state.currentMs - a) / (b - a) : 0;
  els.scrubber.value = Math.round(Math.min(1, Math.max(0, p)) * 1000);
}

function togglePlayback() {
  if (state.timer) { stopPlayback(); return; }
  const start = selectionStartMs(), end = selectionEndMs();
  if (state.currentMs >= end) state.currentMs = start;
  els.playButton.classList.add("is-playing"); els.playButton.textContent = "Ⅱ PAUSE";
  state.timer = setInterval(() => {
    const minutesPerSecond = +els.speedSelect.value;
    state.currentMs += minutesPerSecond * 60 * 1000 * 0.1;
    if (state.currentMs >= end) { state.currentMs = end; stopPlayback(); }
    render();
  }, 100);
}

function stopPlayback() {
  clearInterval(state.timer); state.timer = null;
  els.playButton.classList.remove("is-playing"); els.playButton.textContent = "▶ PLAY";
}

function showPlaceDetail(key) {
  const [region, place] = key.split("::");
  const candidates = state.archive.events.filter(e => e.region === region && e.place === place);
  const current = candidates.find(e => state.currentMs >= Date.parse(e.start) && state.currentMs <= Date.parse(e.end));
  const nearest = current || candidates.sort((a,b) => Math.abs(Date.parse(a.start) - state.currentMs) - Math.abs(Date.parse(b.start) - state.currentMs))[0];
  const reports = (state.archive.reports || []).filter(r => r.region === region && (r.place === place || r.place === region));
  if (!nearest && !reports.length) return;

  els.detailEyebrow.textContent = current ? "ACTIVE AT PLAYBACK TIME" : "ARCHIVED EVENT";
  els.detailTitle.textContent = place;
  if (nearest) {
    const s = Date.parse(nearest.start), e = Date.parse(nearest.end);
    const related = reports.filter(r => Date.parse(r.at) >= s - 2 * 3600000 && Date.parse(r.at) <= e + 6 * 3600000);
    let text = `${formatTime(s, "Europe/Moscow")} → ${formatTime(e, "Europe/Moscow")} MSK\nDuration ${formatDuration(s,e)}`;
    if (nearest.precision === "parent_region_fallback") text += "\nPrecision: mapped to parent region (local place not resolved)";
    if (related.length) text += `\n\nLocal reports:\n${related.map(r => `• ${r.count ?? "—"} ${r.count_type || "reported"}`).join("\n")}`;
    els.detailBody.textContent = text;
    els.detailSource.href = nearest.start_url || nearest.source_url;
  } else {
    els.detailBody.textContent = reports[0].text || `${reports[0].count ?? "—"} ${reports[0].count_type || "reported"}`;
    els.detailSource.href = reports[0].url;
  }
  els.detailPanel.hidden = false;
}

function showReportDetail(report) {
  els.detailEyebrow.textContent = "LOCAL OFFICIAL REPORT";
  els.detailTitle.textContent = report.place;
  els.detailBody.textContent = `${formatTime(Date.parse(report.at), "Europe/Moscow")} MSK\n${report.text || `${report.count ?? "—"} ${report.count_type || "reported"}`}`;
  els.detailSource.href = report.url;
  els.detailPanel.hidden = false;
}

function escapeHtml(str) {
  return String(str).replace(/[&<>'"]/g, ch => ({ "&":"&amp;", "<":"&lt;", ">":"&gt;", "'":"&#39;", '"':"&quot;" }[ch]));
}

window.addEventListener("resize", () => { if (state.archive) buildTicks(); });
init();
