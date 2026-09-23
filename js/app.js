const MOSCOW_OFFSET = "+03:00";
const OPENFREEMAP_DARK = "https://tiles.openfreemap.org/styles/dark";
const OPENFREEMAP_FALLBACK = "https://tiles.openfreemap.org/styles/liberty";
const REGION_GEOJSON_URLS = [
  "data/russia.geojson",
  "https://raw.githubusercontent.com/codeforgermany/click_that_hood/48ba05ad4c6969e3b3c25735492169227ae411f1/public/data/russia.geojson",
];

const state = {
  archive: null,
  sources: null,
  regions: null,
  cities: { cities: [], municipalities: [], count: 0 },
  map: null,
  mapReady: false,
  baseStyleFallbackUsed: false,
  regionGeoJson: null,
  regionFeatureIds: new Map(),
  placeFeatureIds: new Map(),
  regionMatchedCount: 0,
  previousActiveRegionIds: new Set(),
  previousActivePlaceIds: new Set(),
  previousReportRegionIds: new Set(),
  previousReportPlaceIds: new Set(),
  currentMs: 0,
  cumulativeMs: 0,
  viewMode: "realtime",
  timelineStartMs: 0,
  timelineEndMs: 0,
  timer: null,
};

const $ = (id) => document.getElementById(id);
const els = {
  dataStatus: $("dataStatus"), archiveLamp: $("archiveLamp"), detailPanel: $("detailPanel"),
  detailClose: $("detailClose"), detailEyebrow: $("detailEyebrow"), detailTitle: $("detailTitle"),
  detailBody: $("detailBody"), detailSource: $("detailSource"), dateStart: $("dateStart"), dateEnd: $("dateEnd"),
  tickLayer: $("tickLayer"), eventBars: $("eventBars"), selectionBand: $("selectionBand"), cumulativeBand: $("cumulativeBand"), reportDots: $("reportDots"),
  rangeStart: $("rangeStart"), rangeEnd: $("rangeEnd"), rangeCumulative: $("rangeCumulative"),
  handleStart: $("handleStart"), handleEnd: $("handleEnd"), handleCumulative: $("handleCumulative"),
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

function normalizeAdminNameStrict(value) {
  return String(value || "")
    .toLowerCase()
    .replace(/ё/g, "е")
    .replace(/[–—−]/g, "-")
    .replace(/[^a-zа-я0-9]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function normalizeAdminName(value) {
  return normalizeAdminNameStrict(value)
    .replace(/\b(the|federal city|autonomous oblast|autonomous okrug|autonomous district|republic of|republic|oblast|krai|region)\b/g, " ")
    .replace(/\b(республика|область|край|автономная область|автономный округ|город федерального значения)\b/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function sourcePlaceIndex() {
  const map = new Map();
  const add = (region, place) => {
    if (!region || !place?.name || place.lat == null || place.lon == null) return;
    const key = `${region}::${place.name}`;
    if (!map.has(key)) map.set(key, { ...place, region, key });
  };
  // Nationwide city/municipality catalog built by GitHub Actions.  These
  // points exist independently of whether we already have a dedicated source
  // for that city, so every catalogued city can become active when an official
  // regional source names it.
  for (const place of [...(state.cities.cities || []), ...(state.cities.municipalities || [])]) {
    add(place.region, { ...place, type: place.type || "city" });
  }
  for (const source of state.sources.sources || []) {
    for (const place of source.places || []) add(source.region, place);
  }
  // v6: dynamically collected cities/municipalities are not required to be
  // hard-coded in sources.json. Coordinates stored by the collector are enough.
  for (const event of state.archive.events || []) {
    if (event.scope !== "region") add(event.region, {
      name: event.place, label: event.place_label || event.place,
      type: event.scope || "city", lat: event.lat, lon: event.lon,
    });
  }
  for (const report of state.archive.reports || []) {
    if (report.scope !== "region") add(report.region, {
      name: report.place, label: report.place_label || report.place,
      type: report.scope || "city", lat: report.lat, lon: report.lon,
    });
    for (const place of report.mentioned_places || []) add(report.region, place);
  }
  return map;
}

function regionAliases(region, normalizer = normalizeAdminName) {
  return [region.region, region.region_label, ...(region.geo_aliases || [])]
    .map(normalizer)
    .filter(Boolean);
}

async function loadJson(path, cache = "no-store") {
  const res = await fetch(path, { cache });
  if (!res.ok) throw new Error(`${path}: HTTP ${res.status}`);
  return res.json();
}

async function loadOptionalJson(path, fallback) {
  try { return await loadJson(path); } catch (_) { return fallback; }
}

async function fetchFirstJson(urls) {
  let lastError = null;
  for (const url of urls) {
    try {
      return await loadJson(url, url.startsWith("data/") ? "no-store" : "force-cache");
    } catch (err) {
      lastError = err;
    }
  }
  throw lastError || new Error("No GeoJSON source available");
}

async function init() {
  try {
    [state.archive, state.sources, state.regions, state.cities] = await Promise.all([
      loadJson("data/events.json"),
      loadJson("data/sources.json"),
      loadJson("data/regions.json"),
      loadOptionalJson("data/cities.json", { cities: [], municipalities: [], count: 0 }),
    ]);
  } catch (err) {
    console.error(err);
    els.dataStatus.textContent = "DATA LOAD FAILED";
    return;
  }

  initializeDates();
  wireControls();
  rebuildTimeline();
  updateDataStatus();

  try {
    state.regionGeoJson = await fetchFirstJson(REGION_GEOJSON_URLS);
  } catch (err) {
    console.warn("Admin overlay unavailable; base vector map will still render", err);
  }

  initMap();
}

function coverageNumber(key, fallback = null) {
  const value = state.archive?.coverage?.[key];
  return Number.isFinite(value) ? value : fallback;
}

function updateDataStatus() {
  const generated = state.archive.generated_at ? formatTime(Date.parse(state.archive.generated_at), "Europe/Moscow") : "—";
  const configured = coverageNumber("regions_configured", state.regions.regions?.length ?? 0);
  const regionsWithEvents = coverageNumber(
    "regions_with_paired_alerts",
    new Set((state.archive.events || []).map(e => e.region)).size,
  );
  const regionsWithRecords = coverageNumber(
    "archive_regions_with_records",
    coverageNumber(
      "regions_with_any_record",
      new Set([
        ...(state.archive.events || []).map(e => e.region),
        ...(state.archive.reports || []).map(r => r.region),
      ]).size,
    ),
  );
  const regionsWithLocalRecords = coverageNumber(
    "archive_regions_with_local_records",
    new Set([
      ...(state.archive.events || []).filter(e => ["city","municipality"].includes(e.scope)).map(e => e.region),
      ...(state.archive.reports || []).filter(r => ["city","municipality"].includes(r.scope) || (r.mentioned_places || []).length).map(r => r.region),
    ]).size,
  );
  const rssHttpOk = coverageNumber(
    "region_feeds_http_ok",
    (state.archive.source_status || []).filter(s => s.source_type === "mchs_rss" && s.transport_ok).length,
  );
  const hiCfg = (state.sources.sources || []).filter(s => s.enabled && (s.kind || "telegram") === "telegram").length;
  const hiHealthy = coverageNumber(
    "high_resolution_sources_healthy",
    (state.archive.source_status || []).filter(s => s.source_type === "telegram" && s.health === "healthy").length,
  );
  const hiRegionCfg = coverageNumber(
    "high_resolution_regions_configured",
    new Set((state.archive.source_status || []).filter(s => s.source_type === "telegram").map(s => s.region)).size,
  );
  const hiRegionOk = coverageNumber(
    "high_resolution_regions_transport_ok",
    new Set((state.archive.source_status || []).filter(s => s.source_type === "telegram" && s.transport_ok).map(s => s.region)).size,
  );
  const hiFailed = coverageNumber(
    "high_resolution_sources_failed",
    (state.archive.source_status || []).filter(s => s.source_type === "telegram" && s.health === "failed").length,
  );
  const hiAlertCapable = coverageNumber(
    "high_resolution_sources_with_alert_posts",
    (state.archive.source_status || []).filter(s => s.source_type === "telegram" && (s.alert_posts || 0) > 0).length,
  );
  const hiActivityCapable = coverageNumber(
    "high_resolution_sources_with_activity_posts",
    (state.archive.source_status || []).filter(s => s.source_type === "telegram" && (s.activity_posts || 0) > 0).length,
  );
  const unmatched = coverageNumber(
    "unmatched_starts",
    (state.archive.unmatched || []).filter(u => u.type === "unmatched_start").length,
  );

  els.dataStatus.textContent = [
    `${state.archive.events.length} PAIRED`,
    `${regionsWithRecords}/${configured} REGIONS WITH RECORDS`,
    `${regionsWithLocalRecords}/${configured} LOCAL-REGIONS`,
    `${regionsWithEvents}/${configured} PAIRED-REGIONS`,
    `${hiRegionCfg}/${configured} HIGH-RES REGIONS`,
    `${hiRegionOk}/${hiRegionCfg || 0} REGION FETCH OK`,
    `${hiFailed} SOURCE FETCH FAILED`,
    `${hiActivityCapable}/${hiCfg} CURRENT HIGH-RES ACTIVITY`,
    `${state.archive.coverage?.telegram_mtproto_enabled ? "MTPROTO ON" : "MTPROTO OFF"}`,
    `${rssHttpOk}/${configured} RSS AUX HTTP`,
    `${coverageNumber("city_catalog_count", state.cities?.cities?.length || 0)} CITIES`,
    `${coverageNumber("municipality_catalog_count", state.cities?.municipalities?.length || 0)} DISTRICTS`,
    `${unmatched} UNMATCHED`,
    `UPDATED ${generated} MSK`,
    `${state.archive.safety_lag_hours ?? 24}H ARCHIVE LAG`,
  ].join(" · ");
}

function initMap() {
  const MapLibre = window.maplibregl;
  if (!MapLibre) {
    els.dataStatus.textContent += " · MAPLIBRE LOAD FAILED";
    return;
  }

  state.map = new MapLibre.Map({
    container: "map",
    style: OPENFREEMAP_DARK,
    center: [45, 55],
    zoom: 3.35,
    minZoom: 2,
    maxZoom: 13,
    attributionControl: true,
    cooperativeGestures: false,
    renderWorldCopies: false,
  });

  state.map.addControl(new MapLibre.NavigationControl({ showCompass: false }), "bottom-right");

  const styleTimeout = window.setTimeout(() => {
    if (!state.mapReady && !state.baseStyleFallbackUsed) {
      state.baseStyleFallbackUsed = true;
      console.warn("OpenFreeMap dark style did not finish loading; trying Liberty fallback");
      state.map.setStyle(OPENFREEMAP_FALLBACK);
    }
  }, 12000);

  state.map.on("load", () => {
    window.clearTimeout(styleTimeout);
    state.mapReady = true;
    installArchiveLayers();
    render();
  });

  state.map.on("style.load", () => {
    if (!state.mapReady) return;
    installArchiveLayers();
    render();
  });

  state.map.on("error", (ev) => {
    const message = ev?.error?.message || String(ev?.error || "map error");
    console.warn("MapLibre:", message);
  });

  state.map.on("click", (ev) => handleMapClick(ev));
}

function firstSymbolLayerId() {
  const layers = state.map?.getStyle()?.layers || [];
  return layers.find(l => l.type === "symbol")?.id;
}

function prepareRegionGeoJson() {
  if (!state.regionGeoJson?.features) return null;
  state.regionFeatureIds.clear();
  let nextId = 1;
  let matched = 0;

  const featureRows = state.regionGeoJson.features.map(feature => {
    const clone = { ...feature, properties: { ...(feature.properties || {}) } };
    const rawNames = Object.values(clone.properties)
      .filter(v => typeof v === "string" && v.length < 180);
    const strictNames = new Set(rawNames.map(normalizeAdminNameStrict).filter(Boolean));
    const looseNames = new Set(rawNames.map(normalizeAdminName).filter(Boolean));

    // Preserve administrative type first: Moscow != Moscow Oblast,
    // Novgorod Oblast != Nizhny Novgorod Oblast, Altai Krai != Altai Republic.
    const strictCandidates = (state.regions.regions || []).filter(region =>
      regionAliases(region, normalizeAdminNameStrict).some(a => strictNames.has(a)),
    );
    let candidates = strictCandidates;
    if (!candidates.length) {
      candidates = (state.regions.regions || []).filter(region => {
        const aliases = regionAliases(region, normalizeAdminName);
        const exact = aliases.some(a => looseNames.has(a));
        return exact || aliases.some(a => a.length >= 5 && [...looseNames].some(n => n.length >= 5 && (n.includes(a) || a.includes(n))));
      });
    }

    const canonical = candidates.length === 1 ? candidates[0].region : null;
    if (!canonical && candidates.length > 1) {
      console.warn("Ambiguous archive region geometry", clone.properties, candidates.map(r => r.region));
    }

    clone.id = nextId++;
    clone.properties.archive_region = canonical || "";
    if (canonical && !state.regionFeatureIds.has(canonical)) {
      state.regionFeatureIds.set(canonical, clone.id);
      matched += 1;
    }
    return clone;
  });
  state.regionMatchedCount = matched;
  return { type: "FeatureCollection", features: featureRows };
}
function preparePlacesGeoJson() {
  state.placeFeatureIds.clear();
  let nextId = 1;
  const features = [];
  for (const [key, place] of sourcePlaceIndex()) {
    if (place.lat == null || place.lon == null) continue;
    const id = nextId++;
    state.placeFeatureIds.set(key, id);
    features.push({
      type: "Feature",
      id,
      geometry: { type: "Point", coordinates: [Number(place.lon), Number(place.lat)] },
      properties: {
        key,
        region: place.region,
        place: place.name,
        label: place.label || place.name,
        place_type: place.type || "municipality",
      },
    });
  }
  return { type: "FeatureCollection", features };
}

function installArchiveLayers() {
  if (!state.map?.isStyleLoaded()) return;

  if (state.map.getLayer("archive-region-fill")) state.map.removeLayer("archive-region-fill");
  if (state.map.getLayer("archive-region-line")) state.map.removeLayer("archive-region-line");
  if (state.map.getLayer("archive-place-glow")) state.map.removeLayer("archive-place-glow");
  if (state.map.getLayer("archive-place-dot")) state.map.removeLayer("archive-place-dot");
  if (state.map.getLayer("archive-place-label")) state.map.removeLayer("archive-place-label");
  if (state.map.getSource("archive-regions")) state.map.removeSource("archive-regions");
  if (state.map.getSource("archive-places")) state.map.removeSource("archive-places");

  const beforeId = firstSymbolLayerId();

  const regionData = prepareRegionGeoJson();
  if (regionData) {
    state.map.addSource("archive-regions", { type: "geojson", data: regionData });
    state.map.addLayer({
      id: "archive-region-fill",
      type: "fill",
      source: "archive-regions",
      paint: {
        "fill-color": ["case",
          ["boolean", ["feature-state", "missileActive"], false], "#ff334d",
          ["boolean", ["feature-state", "active"], false], "#39d8ff",
          ["boolean", ["feature-state", "missileReport"], false], "#ff8a33",
          ["boolean", ["feature-state", "report"], false], "#ffb347",
          "#39d8ff"
        ],
        "fill-opacity": ["case",
          ["boolean", ["feature-state", "missileActive"], false], 0.24,
          ["boolean", ["feature-state", "active"], false], 0.17,
          ["boolean", ["feature-state", "missileReport"], false], 0.13,
          ["boolean", ["feature-state", "report"], false], 0.09,
          0.0
        ],
      },
    }, beforeId);
    state.map.addLayer({
      id: "archive-region-line",
      type: "line",
      source: "archive-regions",
      paint: {
        "line-color": ["case",
          ["boolean", ["feature-state", "missileActive"], false], "#ff6678",
          ["boolean", ["feature-state", "active"], false], "#62e2ff",
          ["boolean", ["feature-state", "missileReport"], false], "#ff9f4a",
          ["boolean", ["feature-state", "report"], false], "#ffc15a",
          "#31566a"
        ],
        "line-width": ["case",
          ["boolean", ["feature-state", "missileActive"], false], 2.5,
          ["boolean", ["feature-state", "active"], false], 2.2,
          ["boolean", ["feature-state", "missileReport"], false], 1.8,
          ["boolean", ["feature-state", "report"], false], 1.6,
          0.65
        ],
        "line-opacity": ["case",
          ["boolean", ["feature-state", "missileActive"], false], 1,
          ["boolean", ["feature-state", "active"], false], 0.95,
          ["boolean", ["feature-state", "missileReport"], false], 0.9,
          ["boolean", ["feature-state", "report"], false], 0.85,
          0.25
        ],
      },
    }, beforeId);
  }

  state.map.addSource("archive-places", { type: "geojson", data: preparePlacesGeoJson() });
  state.map.addLayer({
    id: "archive-place-glow",
    type: "circle",
    source: "archive-places",
    paint: {
      "circle-radius": ["interpolate", ["linear"], ["zoom"], 3, 8, 7, 15, 11, 20],
      "circle-color": ["case",
        ["boolean", ["feature-state", "missileActive"], false], "#ff334d",
        ["boolean", ["feature-state", "active"], false], "#39d8ff",
        ["boolean", ["feature-state", "missileReport"], false], "#ff8a33",
        "#ffb347"
      ],
      "circle-opacity": ["case",
        ["boolean", ["feature-state", "missileActive"], false], 0.34,
        ["boolean", ["feature-state", "active"], false], 0.28,
        ["boolean", ["feature-state", "missileReport"], false], 0.25,
        ["boolean", ["feature-state", "report"], false], 0.22,
        0
      ],
      "circle-blur": 0.7,
    },
  });
  state.map.addLayer({
    id: "archive-place-dot",
    type: "circle",
    source: "archive-places",
    paint: {
      "circle-radius": ["interpolate", ["linear"], ["zoom"], 3, 2.4, 7, 4.2, 11, 5.5],
      "circle-color": ["case",
        ["boolean", ["feature-state", "missileActive"], false], "#ff334d",
        ["boolean", ["feature-state", "active"], false], "#39d8ff",
        ["boolean", ["feature-state", "missileReport"], false], "#ff8a33",
        ["boolean", ["feature-state", "report"], false], "#ffb347",
        "#506571"
      ],
      "circle-stroke-color": ["case",
        ["boolean", ["feature-state", "missileActive"], false], "#ffd8dc",
        ["boolean", ["feature-state", "active"], false], "#d6f7ff",
        ["boolean", ["feature-state", "missileReport"], false], "#ffe0bf",
        ["boolean", ["feature-state", "report"], false], "#ffe0a8",
        "#99aeb9"
      ],
      "circle-stroke-width": ["case", ["any", ["boolean", ["feature-state", "missileActive"], false], ["boolean", ["feature-state", "active"], false]], 1.6, ["any", ["boolean", ["feature-state", "missileReport"], false], ["boolean", ["feature-state", "report"], false]], 1.3, 0],
      "circle-stroke-opacity": ["case", ["any", ["boolean", ["feature-state", "missileActive"], false], ["boolean", ["feature-state", "active"], false], ["boolean", ["feature-state", "missileReport"], false], ["boolean", ["feature-state", "report"], false]], 1, 0],
      "circle-opacity": ["case", ["any", ["boolean", ["feature-state", "missileActive"], false], ["boolean", ["feature-state", "active"], false]], 1, ["any", ["boolean", ["feature-state", "missileReport"], false], ["boolean", ["feature-state", "report"], false]], 0.95, 0],
    },
  });
  state.map.addLayer({
    id: "archive-place-label",
    type: "symbol",
    source: "archive-places",
    minzoom: 4.2,
    layout: {
      "text-field": ["get", "label"],
      "text-font": ["Noto Sans Regular"],
      "text-size": ["interpolate", ["linear"], ["zoom"], 4, 9, 8, 11, 12, 13],
      "text-offset": [0, 1.05],
      "text-anchor": "top",
      "text-allow-overlap": false,
    },
    paint: {
      "text-color": "#b9ccd5",
      "text-halo-color": "#071018",
      "text-halo-width": 1.5,
      "text-halo-blur": 0.6,
      "text-opacity": ["case", ["any", ["boolean", ["feature-state", "missileActive"], false], ["boolean", ["feature-state", "active"], false], ["boolean", ["feature-state", "missileReport"], false], ["boolean", ["feature-state", "report"], false]], 1, 0],
    },
  });
}

function handleMapClick(ev) {
  if (!state.mapReady) return;
  const placeFeatures = state.map.queryRenderedFeatures(ev.point, { layers: ["archive-place-dot", "archive-place-glow"] });
  if (placeFeatures.length) {
    showPlaceDetail(placeFeatures[0].properties.key);
    return;
  }
  const regionFeatures = state.map.getLayer("archive-region-fill")
    ? state.map.queryRenderedFeatures(ev.point, { layers: ["archive-region-fill"] })
    : [];
  const regionName = regionFeatures.find(f => f.properties?.archive_region)?.properties?.archive_region;
  if (regionName) {
    showRegionDetail(regionName);
    return;
  }
  els.detailPanel.hidden = true;
}

function initializeDates() {
  const fallbackNow = Date.now() - 24 * 3600 * 1000;
  // events.json is cumulative from v7 onward, but the default view should remain
  // the newest delayed collection window rather than expanding across history.
  const minMs = Date.parse(state.archive.window_start || fallbackNow);
  const maxMs = Date.parse(state.archive.window_end || fallbackNow);
  els.dateStart.value = isoDateInZone(minMs);
  els.dateEnd.value = isoDateInZone(maxMs);
}

function wireControls() {
  els.dateStart.addEventListener("change", rebuildTimeline);
  els.dateEnd.addEventListener("change", rebuildTimeline);
  els.rangeStart.addEventListener("input", () => updateSelection("start"));
  els.rangeEnd.addEventListener("input", () => updateSelection("end"));
  els.rangeCumulative.addEventListener("input", () => {
    stopPlayback();
    state.viewMode = "cumulative";
    state.cumulativeMs = timelineMsFromRange(+els.rangeCumulative.value);
    state.cumulativeMs = Math.min(Math.max(state.cumulativeMs, selectionStartMs()), selectionEndMs());
    state.currentMs = state.cumulativeMs;
    updateCumulativeHandle();
    render();
  });
  els.scrubber.addEventListener("input", () => {
    state.viewMode = "realtime";
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
  els.rangeCumulative.value = 0;
  state.currentMs = state.timelineStartMs;
  state.cumulativeMs = state.timelineStartMs;
  state.viewMode = "realtime";
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
  state.cumulativeMs = Math.min(Math.max(state.cumulativeMs || selectionStartMs(), selectionStartMs()), selectionEndMs());
  const cp = (state.cumulativeMs - state.timelineStartMs) / (state.timelineEndMs - state.timelineStartMs);
  els.rangeCumulative.value = Math.round(Math.min(1, Math.max(0, cp)) * 1000);
  updateCumulativeHandle();
  render();
}

function updateCumulativeHandle() {
  const raw = +els.rangeCumulative.value;
  const startPct = +els.rangeStart.value / 10;
  const endPct = +els.rangeEnd.value / 10;
  const pct = Math.min(endPct, Math.max(startPct, raw / 10));
  els.handleCumulative.style.left = `${pct}%`;
  els.handleCumulative.textContent = `Σ ${formatTime(state.cumulativeMs || timelineMsFromRange(raw), "Europe/Moscow")}`;
  els.cumulativeBand.style.left = `${startPct}%`;
  els.cumulativeBand.style.width = `${Math.max(0, pct - startPct)}%`;
  els.cumulativeBand.classList.toggle("active", state.viewMode === "cumulative");
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
  for (const event of state.archive.events || []) {
    const start = Date.parse(event.start), end = Date.parse(event.end);
    if (end < state.timelineStartMs || start > state.timelineEndMs) continue;
    const left = Math.max(0, pctInTimeline(Math.max(start, state.timelineStartMs)));
    const right = Math.min(100, pctInTimeline(Math.min(end, state.timelineEndMs)));
    const bar = document.createElement("span");
    const eventThreat = event.threat_class || (String(event.alert_type || "").startsWith("missile") ? "missile" : "uav");
    bar.className = `event-bar ${event.scope === "region" ? "region" : "city"} ${eventThreat === "missile" ? "missile" : "uav"}`;
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
    dot.type = "button";
    dot.className = `report-dot ${(report.threat_class || "uav") === "missile" ? "missile" : "uav"}`;
    dot.style.left = `${pctInTimeline(ms)}%`;
    dot.title = `${report.place}: ${report.count ?? "—"}`;
    dot.addEventListener("click", () => showReportDetail(report));
    els.reportDots.appendChild(dot);
  }
}

function activeEvents() {
  return (state.archive.events || []).filter(e => state.currentMs >= Date.parse(e.start) && state.currentMs <= Date.parse(e.end));
}

function activeReports() {
  const span = 45 * 60 * 1000;
  return (state.archive.reports || []).filter(r => Math.abs(state.currentMs - Date.parse(r.at)) <= span);
}

function cumulativeEvents() {
  const start = selectionStartMs();
  const end = Math.min(Math.max(state.cumulativeMs, start), selectionEndMs());
  return (state.archive.events || []).filter(e => Date.parse(e.end) >= start && Date.parse(e.start) <= end);
}

function cumulativeReports() {
  const start = selectionStartMs();
  const end = Math.min(Math.max(state.cumulativeMs, start), selectionEndMs());
  return (state.archive.reports || []).filter(r => {
    const at = Date.parse(r.at);
    return at >= start && at <= end;
  });
}

function render() {
  const cumulative = state.viewMode === "cumulative";
  const active = cumulative ? cumulativeEvents() : activeEvents();
  const reports = cumulative ? cumulativeReports() : activeReports();
  renderMap(active, reports);
  renderClocks(active, reports);
  renderScrubber();
  updateCumulativeHandle();
}

function threatClass(record) {
  return record?.threat_class || (String(record?.alert_type || "").startsWith("missile") ? "missile" : "uav");
}

function setFeatureActive(source, id, active, missile = false) {
  if (!state.mapReady || !state.map.getSource(source) || id == null) return;
  try { state.map.setFeatureState({ source, id }, { active, missileActive: active && missile }); } catch (_) {}
}

function clearThreatFeatureState(source, id) {
  if (!state.mapReady || !state.map.getSource(source) || id == null) return;
  try { state.map.setFeatureState({ source, id }, { active: false, missileActive: false, report: false, missileReport: false }); } catch (_) {}
}

function renderMap(active, reports = []) {
  if (state.mapReady) {
    for (const id of new Set([...state.previousActiveRegionIds, ...state.previousReportRegionIds])) clearThreatFeatureState("archive-regions", id);
    for (const id of new Set([...state.previousActivePlaceIds, ...state.previousReportPlaceIds])) clearThreatFeatureState("archive-places", id);
    state.previousActiveRegionIds.clear();
    state.previousActivePlaceIds.clear();
    state.previousReportRegionIds.clear();
    state.previousReportPlaceIds.clear();

    // Hierarchy rule: a local alert necessarily means its parent region is active.
    // The city/municipality dot gives precision; the region fill gives containment.
    for (const event of active) {
      const missile = threatClass(event) === "missile";
      const rid = state.regionFeatureIds.get(event.region);
      if (rid != null) {
        setFeatureActive("archive-regions", rid, true, missile);
        state.previousActiveRegionIds.add(rid);
      }
      if (event.scope !== "region") {
        const key = `${event.region}::${event.place}`;
        const id = state.placeFeatureIds.get(key);
        if (id != null) {
          setFeatureActive("archive-places", id, true, missile);
          state.previousActivePlaceIds.add(id);
        }
      }
    }


    // Official local reports are shown as amber activity, not mislabelled as a
    // formal alert. This makes Moscow-style governor/mayor incident reporting
    // visible even when no explicit START/END warning was published.
    for (const report of reports) {
      const formalSignal = report.signal_class === "formal_alert_signal";
      const missile = threatClass(report) === "missile";
      const rid = state.regionFeatureIds.get(report.region);
      if (rid != null) {
        if (formalSignal) {
          setFeatureActive("archive-regions", rid, true, missile);
          state.previousActiveRegionIds.add(rid);
        } else {
          try { state.map.setFeatureState({ source: "archive-regions", id: rid }, missile ? { missileReport: true } : { report: true }); } catch (_) {}
          state.previousReportRegionIds.add(rid);
        }
      }
      const mentioned = (report.mentioned_places?.length ? report.mentioned_places : [report]);
      for (const place of mentioned) {
        const key = `${report.region}::${place.name || report.place}`;
        const id = state.placeFeatureIds.get(key);
        if (id != null) {
          if (formalSignal) {
            setFeatureActive("archive-places", id, true, missile);
            state.previousActivePlaceIds.add(id);
          } else {
            try { state.map.setFeatureState({ source: "archive-places", id }, missile ? { missileReport: true } : { report: true }); } catch (_) {}
            state.previousReportPlaceIds.add(id);
          }
        }
      }
    }
  }
  els.archiveLamp.classList.toggle("on", active.length > 0 || reports.length > 0);
}

function renderClocks(active, reports = []) {
  els.clockMoscow.textContent = formatTime(state.currentMs, "Europe/Moscow");
  els.clockKyiv.textContent = formatTime(state.currentMs, "Europe/Kyiv");
  els.clockBeijing.textContent = formatTime(state.currentMs, "Asia/Shanghai");
  if (state.viewMode === "cumulative") {
    const regionCount = new Set(active.map(e => e.region)).size;
    const placeCount = new Set(active.filter(e => e.scope !== "region").map(e => `${e.region}::${e.place}`)).size;
    const reportRegions = new Set(reports.map(r => r.region));
    const allRegions = new Set([...active.map(e => e.region), ...reportRegions]);
    const reportPlaces = new Set(reports.flatMap(r => (r.mentioned_places?.length ? r.mentioned_places : [r]).map(p => `${r.region}::${p.name || r.place}`)));
    const allPlaces = new Set([...active.filter(e => e.scope !== "region").map(e => `${e.region}::${e.place}`), ...reportPlaces]);
    els.currentTimeLabel.textContent = `Σ START → ${formatTime(state.cumulativeMs, "Europe/Moscow")} MSK · ${allRegions.size} REGIONS · ${allPlaces.size} LOCAL`;
  } else {
    const reportCount = reports.length;
    els.currentTimeLabel.textContent = `${formatTime(state.currentMs, "Europe/Moscow")} MSK · ${active.length} ALERT${active.length === 1 ? "" : "S"} · ${reportCount} REPORT${reportCount === 1 ? "" : "S"}`;
  }
}

function renderScrubber() {
  const a = selectionStartMs(), b = selectionEndMs();
  const p = b > a ? (state.currentMs - a) / (b - a) : 0;
  els.scrubber.value = Math.round(Math.min(1, Math.max(0, p)) * 1000);
}

function togglePlayback() {
  if (state.timer) { stopPlayback(); return; }
  state.viewMode = "realtime";
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

function sourceStatusText(region) {
  const rows = (state.archive.source_status || []).filter(s => s.region === region);
  if (!rows.length) return "Collector status: no source-status row in this snapshot";
  return rows.map(s => {
    const kind = s.source_type === "telegram" ? "HIGH-RES" : "RSS AUX";
    const health = String(s.health || (s.ok ? "legacy-ok" : "failed")).toUpperCase();
    const transport = s.transport ? ` · ${s.transport}` : "";
    const window = s.window_complete ? " · WINDOW OK" : (s.source_type === "telegram" ? " · WINDOW ?" : "");
    const activity = s.activity_posts ?? s.alert_posts ?? 0;
    const uav = s.uav_activity_posts ?? null;
    const missile = s.missile_activity_posts ?? null;
    const threatCounts = uav == null && missile == null ? `${activity} ACTIVITY` : `${uav ?? 0} UAV · ${missile ?? 0} MISSILE`;
    const counts = `${s.posts ?? 0} posts · ${threatCounts} · ${s.events ?? 0} paired · ${s.reports ?? 0} signals`;
    const err = s.error ? ` · ${s.error}` : "";
    const source = s.source_type === "telegram" ? ` @${s.source}` : "";
    return `${kind}${source} ${health}${transport}${window}: ${counts}${err}`;
  }).join("\n");
}

function showPlaceDetail(key) {
  const split = key.indexOf("::");
  const region = split >= 0 ? key.slice(0, split) : "";
  const place = split >= 0 ? key.slice(split + 2) : key;
  const candidates = (state.archive.events || []).filter(e => e.region === region && e.place === place);
  const current = candidates.find(e => state.currentMs >= Date.parse(e.start) && state.currentMs <= Date.parse(e.end));
  const nearest = current || [...candidates].sort((a,b) => Math.abs(Date.parse(a.start) - state.currentMs) - Math.abs(Date.parse(b.start) - state.currentMs))[0];
  const reports = (state.archive.reports || []).filter(r => r.region === region && (r.place === place || r.place === region));
  if (!nearest && !reports.length) {
    els.detailEyebrow.textContent = "CONFIGURED HIGH-RES PLACE";
    els.detailTitle.textContent = place;
    els.detailBody.textContent = sourceStatusText(region);
    const src = (state.sources.sources || []).find(s => s.region === region);
    els.detailSource.href = src?.source_url || "#";
    els.detailPanel.hidden = false;
    return;
  }

  els.detailEyebrow.textContent = current ? "ACTIVE AT PLAYBACK TIME" : "ARCHIVED EVENT";
  els.detailTitle.textContent = place;
  if (nearest) {
    const s = Date.parse(nearest.start), e = Date.parse(nearest.end);
    const related = reports.filter(r => Date.parse(r.at) >= s - 2 * 3600000 && Date.parse(r.at) <= e + 6 * 3600000);
    let text = `${formatTime(s, "Europe/Moscow")} → ${formatTime(e, "Europe/Moscow")} MSK\nDuration ${formatDuration(s,e)}`;
    if (nearest.precision === "parent_region_fallback") text += "\nPrecision: parent-region fallback";
    if (related.length) text += `\n\nLocal reports:\n${related.map(r => `• ${r.count ?? "—"} ${r.count_type || "reported"}`).join("\n")}`;
    text += `\n\n${sourceStatusText(region)}`;
    els.detailBody.textContent = text;
    els.detailSource.href = nearest.start_url || nearest.source_url;
  } else {
    els.detailBody.textContent = `${reports[0].text || `${reports[0].count ?? "—"} ${reports[0].count_type || "reported"}`}\n\n${sourceStatusText(region)}`;
    els.detailSource.href = reports[0].url;
  }
  els.detailPanel.hidden = false;
}

function showRegionDetail(regionName) {
  const regionCfg = (state.regions.regions || []).find(r => r.region === regionName);
  const candidates = (state.archive.events || []).filter(e => e.region === regionName && e.scope === "region");
  const current = candidates.find(e => state.currentMs >= Date.parse(e.start) && state.currentMs <= Date.parse(e.end));
  const nearest = current || [...candidates].sort((a,b) => Math.abs(Date.parse(a.start) - state.currentMs) - Math.abs(Date.parse(b.start) - state.currentMs))[0];
  const localActive = activeEvents().filter(e => e.region === regionName && e.scope !== "region");

  els.detailEyebrow.textContent = current ? "REGION ALERT ACTIVE" : "REGION ARCHIVE";
  els.detailTitle.textContent = regionCfg?.region_label || regionName;
  let body = sourceStatusText(regionName);
  if (nearest) {
    const s = Date.parse(nearest.start), e = Date.parse(nearest.end);
    body = `${formatTime(s, "Europe/Moscow")} → ${formatTime(e, "Europe/Moscow")} MSK\nDuration ${formatDuration(s,e)}\n\n${body}`;
  }
  if (localActive.length) body += `\n\nLocal alerts now:\n${localActive.map(e => `• ${e.place}`).join("\n")}`;
  els.detailBody.textContent = body;
  els.detailSource.href = nearest?.start_url || regionCfg?.mchs_operational_url || "#";
  els.detailPanel.hidden = false;
}

function showReportDetail(report) {
  const missile = threatClass(report) === "missile";
  els.detailEyebrow.textContent = report.signal_class === "formal_alert_signal"
    ? `UNPAIRED FORMAL ${missile ? "MISSILE" : "UAV"} ALERT START`
    : report.signal_class === "alert_clear_signal"
      ? `UNPAIRED ${missile ? "MISSILE" : "UAV"} ALERT CLEAR SIGNAL`
      : `LOCAL OFFICIAL ${missile ? "MISSILE" : "UAV"} ACTIVITY`;
  els.detailTitle.textContent = report.place;
  els.detailBody.textContent = `${formatTime(Date.parse(report.at), "Europe/Moscow")} MSK\n${report.text || `${report.count ?? "—"} ${report.count_type || "reported"}`}`;
  els.detailSource.href = report.url;
  els.detailPanel.hidden = false;
}

window.addEventListener("resize", () => { if (state.archive) buildTicks(); });
init();
