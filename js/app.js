const MOSCOW_OFFSET = "+03:00";
const OPENFREEMAP_DARK = "https://tiles.openfreemap.org/styles/dark";
const OPENFREEMAP_FALLBACK = "https://tiles.openfreemap.org/styles/liberty";
const REGION_GEOJSON_URLS = [
  "data/russia.geojson",
  "https://raw.githubusercontent.com/codeforgermany/click_that_hood/48ba05ad4c6969e3b3c25735492169227ae411f1/public/data/russia.geojson",
];

const UAV_ROUTE_ANCHORS = [
  { id: "chernihiv", lon: 31.55, lat: 52.05, corridor: "north" },
  { id: "sumy", lon: 34.65, lat: 51.00, corridor: "north" },
  { id: "kharkiv", lon: 36.70, lat: 50.08, corridor: "northeast" },
  { id: "donbas", lon: 39.15, lat: 48.35, corridor: "east" },
  { id: "azov", lon: 36.65, lat: 46.45, corridor: "south" },
  { id: "black-sea", lon: 32.20, lat: 45.35, corridor: "south" },
];
const EMPTY_FEATURE_COLLECTION = Object.freeze({ type: "FeatureCollection", features: [] });

const state = {
  archive: null,
  sources: null,
  regions: null,
  cities: { cities: [], municipalities: [], count: 0 },
  map: null,
  mapReady: false,
  baseStyleFallbackUsed: false,
  regionGeoJson: null,
  ukraineGeoJson: null,
  regionFeatureIds: new Map(),
  regionCentroids: new Map(),
  placeFeatureIds: new Map(),
  regionMatchedCount: 0,
  previousActiveRegionIds: new Set(),
  previousActivePlaceIds: new Set(),
  previousReportRegionIds: new Set(),
  previousReportPlaceIds: new Set(),
  previousRoutePlaceIds: new Set(),
  ukraineBorderCandidates: null,
  currentMs: 0,
  cumulativeMs: 0,
  viewMode: "realtime",
  timelineStartMs: 0,
  timelineEndMs: 0,
  timer: null,
  routesVisible: true,
  routeSelectionKey: "",
  routeFeatureCount: 0,
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
  routeToggle: $("routeToggle"),
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

  try {
    state.ukraineGeoJson = await loadJson("data/ukraine-regions.geojson", "force-cache");
  } catch (err) {
    console.warn("Detailed Ukraine boundary support geometry unavailable", err);
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
  const mtprotoUsed = coverageNumber(
    "telegram_mtproto_sources_used",
    (state.archive.source_status || []).filter(s => s.source_type === "telegram" && s.transport === "telegram_mtproto" && s.transport_ok).length,
  );
  const hiWindowComplete = coverageNumber(
    "high_resolution_sources_window_complete",
    (state.archive.source_status || []).filter(s => s.source_type === "telegram" && s.window_complete).length,
  );
  const peerCacheEntries = coverageNumber("telegram_peer_cache_entries", 0);
  const resolveFlooded = Boolean(state.archive.coverage?.telegram_mtproto_resolve_flooded);
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
    `${hiRegionOk}/${hiRegionCfg || 0} REGION TRANSPORT OK`,
    `${hiFailed} SOURCE FETCH FAILED`,
    `${hiWindowComplete}/${hiCfg} WINDOW COMPLETE`,
    `${mtprotoUsed}/${hiCfg} MTPROTO${resolveFlooded ? " · RESOLVE WAIT" : ""}`,
    `${peerCacheEntries}/${hiCfg} PEER CACHE`,
    `${hiActivityCapable}/${hiCfg} CURRENT HIGH-RES ACTIVITY`,
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

function geometryBounds(geometry) {
  const coords = geometry?.coordinates;
  if (!coords) return null;
  let minLon = Infinity, minLat = Infinity, maxLon = -Infinity, maxLat = -Infinity;
  const visit = value => {
    if (!Array.isArray(value)) return;
    if (value.length >= 2 && Number.isFinite(+value[0]) && Number.isFinite(+value[1])) {
      const lon = +value[0], lat = +value[1];
      minLon = Math.min(minLon, lon); maxLon = Math.max(maxLon, lon);
      minLat = Math.min(minLat, lat); maxLat = Math.max(maxLat, lat);
      return;
    }
    for (const child of value) visit(child);
  };
  visit(coords);
  if (!Number.isFinite(minLon)) return null;
  return { minLon, minLat, maxLon, maxLat };
}


function boundaryCoordKey(coord, decimals = 5) {
  return Number(coord[0]).toFixed(decimals) + "," + Number(coord[1]).toFixed(decimals);
}

function outerRingsFromGeometry(geometry) {
  if (!geometry?.coordinates) return [];
  if (geometry.type === "Polygon") return geometry.coordinates.length ? [geometry.coordinates[0]] : [];
  if (geometry.type === "MultiPolygon") {
    return geometry.coordinates.flatMap(poly => poly?.length ? [poly[0]] : []);
  }
  return [];
}

function buildOuterBoundaryGeoJson(collection, code) {
  if (!collection?.features?.length) return null;

  // Administrative regions share exact boundary edges in both source datasets.
  // Toggle identical undirected segments: internal ADM1 edges occur twice and
  // disappear, while the national exterior remains.  This preserves the native
  // high-detail geometry instead of drawing a coarse low-resolution polygon.
  const edgeMap = new Map();
  for (const feature of collection.features) {
    for (const ring of outerRingsFromGeometry(feature.geometry)) {
      for (let i = 1; i < ring.length; i++) {
        const a = ring[i - 1], b = ring[i];
        if (!Array.isArray(a) || !Array.isArray(b)) continue;
        if (!Number.isFinite(+a[0]) || !Number.isFinite(+a[1]) ||
            !Number.isFinite(+b[0]) || !Number.isFinite(+b[1])) continue;
        // Avoid rendering a dateline-crossing segment as a line across Eurasia.
        if (Math.abs(+a[0] - +b[0]) > 180) continue;
        const ak = boundaryCoordKey(a), bk = boundaryCoordKey(b);
        const key = ak < bk ? ak + "|" + bk : bk + "|" + ak;
        if (edgeMap.has(key)) edgeMap.delete(key);
        else edgeMap.set(key, { a: [+a[0], +a[1]], b: [+b[0], +b[1]], ak, bk });
      }
    }
  }

  const adjacency = new Map();
  const edges = [...edgeMap.values()].map((edge, id) => ({ ...edge, id }));
  const attach = (key, id) => {
    if (!adjacency.has(key)) adjacency.set(key, []);
    adjacency.get(key).push(id);
  };
  for (const edge of edges) {
    attach(edge.ak, edge.id);
    attach(edge.bk, edge.id);
  }

  const used = new Set();
  const lines = [];
  const walk = startId => {
    const first = edges[startId];
    if (!first || used.has(startId)) return null;
    let currentId = startId;
    let currentKey = first.ak;
    const coords = [];
    while (currentId != null && !used.has(currentId)) {
      const edge = edges[currentId];
      used.add(currentId);
      const forward = edge.ak === currentKey;
      const from = forward ? edge.a : edge.b;
      const to = forward ? edge.b : edge.a;
      if (!coords.length) coords.push(from);
      coords.push(to);
      currentKey = forward ? edge.bk : edge.ak;
      const next = (adjacency.get(currentKey) || []).find(id => !used.has(id));
      currentId = next ?? null;
    }
    return coords.length >= 2 ? coords : null;
  };

  // Start open chains at non-degree-2 vertices, then consume remaining loops.
  for (const [key, ids] of adjacency) {
    if (ids.length === 2) continue;
    for (const id of ids) {
      const line = walk(id);
      if (line) lines.push(line);
    }
  }
  for (const edge of edges) {
    if (used.has(edge.id)) continue;
    const line = walk(edge.id);
    if (line) lines.push(line);
  }

  return {
    type: "Feature",
    properties: { code, detail: "admin-region-derived" },
    geometry: { type: "MultiLineString", coordinates: lines },
  };
}

function detailedCountryBorderGeoJson() {
  const features = [];
  const russia = buildOuterBoundaryGeoJson(state.regionGeoJson, "RUS");
  const ukraine = buildOuterBoundaryGeoJson(state.ukraineGeoJson, "UKR");
  if (russia) features.push(russia);
  if (ukraine) features.push(ukraine);
  return { type: "FeatureCollection", features };
}

function prepareRegionGeoJson() {
  if (!state.regionGeoJson?.features) return null;
  state.regionFeatureIds.clear();
  state.regionCentroids.clear();
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
      const bounds = geometryBounds(clone.geometry);
      if (bounds) {
        state.regionCentroids.set(canonical, {
          lon: (bounds.minLon + bounds.maxLon) / 2,
          lat: (bounds.minLat + bounds.maxLat) / 2,
        });
      }
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


function routePlaceCatalog() {
  const exact = sourcePlaceIndex();
  const aliases = new Map();
  for (const [key, place] of exact) {
    for (const value of [place.name, place.label]) {
      const n = normalizeAdminNameStrict(value);
      if (!n) continue;
      const aliasKey = place.region + "::" + n;
      if (!aliases.has(aliasKey)) aliases.set(aliasKey, { ...place, key });
    }
  }
  return { exact, aliases };
}

function resolveRouteCatalogPlace(catalog, region, ...names) {
  for (const name of names) {
    if (!name) continue;
    const exactKey = region + "::" + name;
    if (catalog.exact.has(exactKey)) return catalog.exact.get(exactKey);
    const alias = catalog.aliases.get(region + "::" + normalizeAdminNameStrict(name));
    if (alias) return alias;
  }
  return null;
}

function routeObservationPoints(record, atMs, sourceType, catalog) {
  if (threatClass(record) !== "uav" || record.signal_class === "alert_clear_signal") return [];
  const points = [];
  const seen = new Set();
  const recordKey = String(record.id || record.url || [record.region, record.at || record.start, record.place].join("|"));
  const kind = record.activity_kind || record.alert_type || "";
  const formal = record.signal_class === "formal_alert_signal" || sourceType === "alert";

  const add = (candidate, fallbackName, precision, weight = 1) => {
    const resolved = candidate && Number.isFinite(+candidate.lon) && Number.isFinite(+candidate.lat)
      ? candidate
      : resolveRouteCatalogPlace(
          catalog,
          record.region || "",
          candidate?.name,
          candidate?.label,
          fallbackName,
        );
    if (!resolved || !Number.isFinite(+resolved.lon) || !Number.isFinite(+resolved.lat)) return;

    const lon = +resolved.lon, lat = +resolved.lat;
    const placeName = resolved.name || candidate?.name || fallbackName || record.place || record.region;
    const placeLabel = resolved.label || candidate?.label || placeName;
    const placeKey = resolved.key || ((record.region || "") + "::" + placeName);
    const coordKey = lon.toFixed(4) + ":" + lat.toFixed(4);
    if (seen.has(coordKey)) return;
    seen.add(coordKey);
    const nodeKey = [
      record.region || "",
      normalizeAdminNameStrict(placeName),
      lon.toFixed(4),
      lat.toFixed(4),
    ].join("|");

    points.push({
      lon, lat,
      place: placeLabel,
      placeName,
      placeKey,
      nodeKey,
      precision: resolved.type || precision || "local",
      region: record.region || "",
      at: atMs,
      sourceType,
      kind,
      formal,
      recordKey,
      weight,
    });
  };

  // The route engine now resolves locations through the same city/municipality
  // catalog used to render the visible map dots. This removes the old state
  // where the map knew a point's coordinates but the route engine did not.
  for (const p of (record.mentioned_places || []).slice(0, 8)) {
    add(p, p.label || p.name, p.type || "local", 1.0);
  }
  if (record.scope !== "region") {
    add(
      { lon: record.lon, lat: record.lat, name: record.place, label: record.place_label },
      record.place,
      record.scope || "local",
      1.0,
    );
  }
  return points;
}

function haversineKm(a, b) {
  const rad = x => x * Math.PI / 180;
  const dLat = rad(b.lat - a.lat);
  const dLon = rad(b.lon - a.lon);
  const lat1 = rad(a.lat), lat2 = rad(b.lat);
  const h = Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLon / 2) ** 2;
  return 6371 * 2 * Math.atan2(Math.sqrt(h), Math.sqrt(Math.max(0, 1 - h)));
}

function bearingDeg(a, b) {
  const rad = x => x * Math.PI / 180;
  const deg = x => x * 180 / Math.PI;
  const lat1 = rad(a.lat), lat2 = rad(b.lat), dLon = rad(b.lon - a.lon);
  const y = Math.sin(dLon) * Math.cos(lat2);
  const x = Math.cos(lat1) * Math.sin(lat2) -
    Math.sin(lat1) * Math.cos(lat2) * Math.cos(dLon);
  return (deg(Math.atan2(y, x)) + 360) % 360;
}

function angleDiffDeg(a, b) {
  const d = Math.abs(a - b) % 360;
  return Math.min(d, 360 - d);
}

function routeHash(value) {
  let h = 2166136261;
  for (const ch of String(value)) {
    h ^= ch.charCodeAt(0);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

function buildUkraineBorderCandidates() {
  if (state.ukraineBorderCandidates?.length) return state.ukraineBorderCandidates;
  const outline = buildOuterBoundaryGeoJson(state.ukraineGeoJson, "UKR");
  const lines = outline?.geometry?.coordinates || [];
  const candidates = [];
  let id = 0;

  // Sample the actual high-detail national outline. Every generated route
  // therefore begins exactly on a border/coastline vertex, never from an
  // arbitrary point inside Ukraine.
  for (const line of lines) {
    if (!Array.isArray(line) || line.length < 2) continue;
    let last = null;
    for (let i = 0; i < line.length; i++) {
      const coord = line[i];
      if (!Array.isArray(coord) || !Number.isFinite(+coord[0]) || !Number.isFinite(+coord[1])) continue;
      const point = { lon: +coord[0], lat: +coord[1], borderId: "ukr-border-" + (id++) };
      if (!last || haversineKm(last, point) >= 14 || i === line.length - 1) {
        candidates.push(point);
        last = point;
      }
    }
  }
  state.ukraineBorderCandidates = candidates;
  return candidates;
}

function selectBorderStart(terminal, seed, usedStarts) {
  const candidates = buildUkraineBorderCandidates();
  if (!candidates.length) return null;

  const ranked = candidates
    .map(point => ({ point, distance: haversineKm(point, terminal) }))
    .sort((a, b) => a.distance - b.distance);
  const bestDistance = ranked[0].distance;
  const shortlist = ranked.filter(x => x.distance <= bestDistance + 150).slice(0, 90);

  let best = shortlist[0];
  let bestScore = Infinity;
  for (const item of shortlist) {
    const nearestUsed = usedStarts.length
      ? Math.min(...usedStarts.map(p => haversineKm(p, item.point)))
      : Infinity;
    const crowdPenalty =
      nearestUsed < 28 ? (28 - nearestUsed) * 8 :
      nearestUsed < 65 ? (65 - nearestUsed) * 1.7 : 0;
    const jitter = (routeHash(seed + "|" + item.point.borderId) % 1000) / 1000 * 18;
    const score = item.distance + crowdPenalty + jitter;
    if (score < bestScore) {
      bestScore = score;
      best = item;
    }
  }
  const chosen = { ...best.point, borderDistanceKm: best.distance };
  usedStarts.push(chosen);
  return chosen;
}

function dedupeRouteObservations(observations) {
  const sorted = [...observations].sort((a, b) => a.at - b.at);
  const out = [];
  for (const node of sorted) {
    const last = [...out].reverse().find(x =>
      x.region === node.region && x.placeName === node.placeName &&
      Math.abs(x.at - node.at) <= 60 * 60 * 1000
    );
    if (last) {
      last.observations += 1;
      last.weight = Math.max(last.weight, node.weight);
      last.at = Math.min(last.at, node.at);
      last.formal = last.formal || node.formal;
      continue;
    }
    out.push({ ...node, observations: 1 });
  }
  return out;
}

function isEndpointOnlyKind(kind) {
  return ["uav_attack_activity", "impact_or_debris"].includes(kind);
}

function isStrongObservationKind(kind) {
  return [
    "uav_movement",
    "air_defense_action",
    "uav_attack_activity",
    "impact_or_debris",
    "official_uav_activity",
  ].includes(kind);
}

function corridorProjection(anchor, terminal, point) {
  const meanLat = (anchor.lat + terminal.lat) * 0.5 * Math.PI / 180;
  const kmLon = 111.32 * Math.cos(meanLat);
  const kmLat = 110.57;
  const tx = (terminal.lon - anchor.lon) * kmLon;
  const ty = (terminal.lat - anchor.lat) * kmLat;
  const px = (point.lon - anchor.lon) * kmLon;
  const py = (point.lat - anchor.lat) * kmLat;
  const length = Math.sqrt(tx * tx + ty * ty) || 1;
  return {
    routeLengthKm: length,
    progressKm: (px * tx + py * ty) / length,
    crossTrackKm: Math.abs(px * ty - py * tx) / length,
  };
}

function plausibleSegment(a, b, terminal, anchor) {
  if (a.recordKey === b.recordKey) return false;
  const dtHours = (b.at - a.at) / 3600000;
  if (dtHours < 0.12 || dtHours > 5.5) return false;

  const distance = haversineKm(a, b);
  if (distance < 15 || distance > 800) return false;
  const speed = distance / dtHours;
  if (speed < 55 || speed > 560) return false;

  const pa = corridorProjection(anchor, terminal, a);
  const pb = corridorProjection(anchor, terminal, b);
  if (pb.progressKm <= pa.progressKm + 10) return false;

  const crossLimit = Math.max(55, Math.min(150, pb.routeLengthKm * 0.14));
  if (pa.crossTrackKm > crossLimit || pb.crossTrackKm > crossLimit) return false;

  const corridorBearing = bearingDeg(anchor, terminal);
  const segmentBearing = bearingDeg(a, b);
  if (angleDiffDeg(corridorBearing, segmentBearing) > 52) return false;
  return true;
}

function bestSupportChain(nodes, terminal, anchor) {
  const termProj = corridorProjection(anchor, terminal, terminal);
  const maxAgeHours = Math.min(8.5, Math.max(2.2, termProj.routeLengthKm / 120));
  const candidates = nodes
    .filter(n => n !== terminal)
    .filter(n => n.at < terminal.at)
    .filter(n => (terminal.at - n.at) / 3600000 <= maxAgeHours)
    .filter(n => !isEndpointOnlyKind(n.kind))
    .map(n => ({ node: n, proj: corridorProjection(anchor, terminal, n) }))
    .filter(x => {
      const crossLimit = Math.max(55, Math.min(150, termProj.routeLengthKm * 0.14));
      return x.proj.progressKm > 15 &&
        x.proj.progressKm < termProj.progressKm - 12 &&
        x.proj.crossTrackKm <= crossLimit;
    })
    .sort((a, b) => a.node.at - b.node.at || a.proj.progressKm - b.proj.progressKm);

  const dp = candidates.map(x => ({
    score: (isStrongObservationKind(x.node.kind) ? 2.0 : 1.0) +
      x.node.observations * 0.15 - x.proj.crossTrackKm * 0.004,
    prev: -1,
  }));

  for (let i = 0; i < candidates.length; i++) {
    for (let j = 0; j < i; j++) {
      if (!plausibleSegment(candidates[j].node, candidates[i].node, terminal, anchor)) continue;
      const score = dp[j].score +
        (isStrongObservationKind(candidates[i].node.kind) ? 2.0 : 1.0) +
        candidates[i].node.observations * 0.15 -
        candidates[i].proj.crossTrackKm * 0.004;
      if (score > dp[i].score) {
        dp[i].score = score;
        dp[i].prev = j;
      }
    }
  }

  let bestIndex = -1;
  let bestScore = 0;
  for (let i = 0; i < candidates.length; i++) {
    if (!plausibleSegment(candidates[i].node, terminal, terminal, anchor)) continue;
    const score = dp[i].score + 2.4;
    if (score > bestScore) {
      bestScore = score;
      bestIndex = i;
    }
  }

  const chain = [];
  while (bestIndex >= 0) {
    chain.push(candidates[bestIndex].node);
    bestIndex = dp[bestIndex].prev;
  }
  chain.reverse();
  return chain;
}

function localVectorKm(a, b, refLat) {
  const kmLon = 111.32 * Math.cos(refLat * Math.PI / 180);
  return {
    x: (b.lon - a.lon) * kmLon,
    y: (b.lat - a.lat) * 110.57,
  };
}

function offsetPointKm(point, xKm, yKm, refLat) {
  const kmLon = Math.max(20, 111.32 * Math.cos(refLat * Math.PI / 180));
  return {
    lon: point.lon + xKm / kmLon,
    lat: point.lat + yKm / 110.57,
    synthetic: true,
  };
}

function naturalSegmentSupports(a, b, seed, segmentIndex) {
  const distance = haversineKm(a, b);
  if (distance < 75) return [];
  const refLat = (a.lat + b.lat) / 2;
  const v = localVectorKm(a, b, refLat);
  const len = Math.sqrt(v.x * v.x + v.y * v.y) || 1;
  const nx = -v.y / len, ny = v.x / len;
  const routeSign = (routeHash(seed) & 1) ? 1 : -1;
  const modulation = 0.84 + ((routeHash(seed + "|" + segmentIndex) % 33) / 100);
  const bendKm = Math.min(24, Math.max(4.5, distance * 0.028)) * routeSign * modulation;

  return [0.34, 0.68].map((fraction, idx) => {
    const base = {
      lon: a.lon + (b.lon - a.lon) * fraction,
      lat: a.lat + (b.lat - a.lat) * fraction,
    };
    const envelope = Math.sin(Math.PI * fraction);
    const localBend = bendKm * envelope * (idx === 0 ? 0.92 : 1.0);
    return offsetPointKm(base, nx * localBend, ny * localBend, refLat);
  });
}

function expandRouteWithNaturalSupports(points, seed) {
  const out = [];
  for (let i = 0; i < points.length - 1; i++) {
    const a = points[i], b = points[i + 1];
    if (!out.length) out.push(a);
    out.push(...naturalSegmentSupports(a, b, seed, i));
    out.push(b);
  }
  return out;
}

function tangentDirection(points, i, refLat) {
  if (points.length < 2) return { x: 1, y: 0 };
  const prev = points[Math.max(0, i - 1)];
  const next = points[Math.min(points.length - 1, i + 1)];
  const v = localVectorKm(prev, next, refLat);
  const len = Math.sqrt(v.x * v.x + v.y * v.y) || 1;
  return { x: v.x / len, y: v.y / len };
}

function smoothInterpolatingRoute(points, samplesPerSegment = 7) {
  if (points.length < 2) return points.map(p => [p.lon, p.lat]);
  const refLat = points.reduce((sum, p) => sum + p.lat, 0) / points.length;
  const out = [];

  for (let i = 0; i < points.length - 1; i++) {
    const a = points[i], b = points[i + 1];
    const segment = localVectorKm(a, b, refLat);
    const segLen = Math.sqrt(segment.x * segment.x + segment.y * segment.y) || 1;
    const ta = tangentDirection(points, i, refLat);
    const tb = tangentDirection(points, i + 1, refLat);
    const prevLen = i > 0 ? haversineKm(points[i - 1], a) : segLen;
    const nextLen = i + 2 < points.length ? haversineKm(b, points[i + 2]) : segLen;
    const handleA = Math.min(segLen * 0.30, prevLen * 0.34, 75);
    const handleB = Math.min(segLen * 0.30, nextLen * 0.34, 75);
    const c1 = offsetPointKm(a, ta.x * handleA, ta.y * handleA, refLat);
    const c2 = offsetPointKm(b, -tb.x * handleB, -tb.y * handleB, refLat);

    for (let step = 0; step < samplesPerSegment; step++) {
      const t = step / samplesPerSegment;
      const u = 1 - t;
      const lon = u*u*u*a.lon + 3*u*u*t*c1.lon + 3*u*t*t*c2.lon + t*t*t*b.lon;
      const lat = u*u*u*a.lat + 3*u*u*t*c1.lat + 3*u*t*t*c2.lat + t*t*t*b.lat;
      if (!out.length || Math.abs(out[out.length - 1][0] - lon) > 1e-8 || Math.abs(out[out.length - 1][1] - lat) > 1e-8) {
        out.push([lon, lat]);
      }
    }
    // The real observation/support waypoint itself is always included exactly.
    out.push([b.lon, b.lat]);
  }
  return out;
}

function buildIllustrativeUavRoutes(startMs, endMs) {
  const catalog = routePlaceCatalog();
  const raw = [];
  for (const report of state.archive.reports || []) {
    const at = Date.parse(report.at);
    if (at >= startMs && at <= endMs) raw.push(...routeObservationPoints(report, at, "report", catalog));
  }
  for (const event of state.archive.events || []) {
    const start = Date.parse(event.start);
    const end = Date.parse(event.end);
    if (end < startMs || start > endMs) continue;
    raw.push(...routeObservationPoints(event, Math.max(start, startMs), "alert", catalog));
  }

  const nodes = dedupeRouteObservations(raw);
  let terminals = nodes.filter((node, idx) => {
    if (isStrongObservationKind(node.kind)) return true;
    return !nodes.some((other, j) =>
      j !== idx &&
      other.at >= node.at &&
      other.at - node.at <= 90 * 60 * 1000 &&
      haversineKm(node, other) < 45 &&
      isStrongObservationKind(other.kind)
    );
  });

  terminals = terminals
    .sort((a, b) => b.at - a.at || b.observations - a.observations)
    .slice(0, 90)
    .sort((a, b) => a.at - b.at);

  const lineFeatures = [];
  const arrowFeatures = [];
  const linkedNodeKeys = new Set();
  const usedBorderStarts = [];

  terminals.forEach((terminal, index) => {
    const seed = [terminal.region, terminal.placeName, terminal.at, index].join("|");
    const borderStart = selectBorderStart(terminal, seed, usedBorderStarts);
    if (!borderStart) return;

    const supports = bestSupportChain(nodes, terminal, borderStart);
    const chain = [...supports, terminal];
    chain.forEach(node => linkedNodeKeys.add(node.nodeKey));

    const evidenceWaypoints = [borderStart, ...chain];
    const expanded = expandRouteWithNaturalSupports(evidenceWaypoints, seed);
    const compact = [];
    for (const p of expanded) {
      if (!compact.length || haversineKm(compact[compact.length - 1], p) > 4) compact.push(p);
    }
    const coords = smoothInterpolatingRoute(compact, compact.length > 8 ? 6 : 8);
    if (coords.length < 2) return;

    const evidence = chain.reduce((sum, n) => sum + n.observations, 0);
    const supportCount = supports.length;
    const confidence = Math.min(
      1,
      0.24 +
      supportCount * 0.17 +
      Math.min(0.22, evidence * 0.035) +
      (isStrongObservationKind(terminal.kind) ? 0.12 : 0)
    );

    const props = {
      route_id: "uav-route-" + index,
      target: terminal.place,
      region: terminal.region,
      start_border_id: borderStart.borderId,
      evidence_nodes: chain.length,
      inferred_support_nodes: supportCount,
      observations: evidence,
      confidence,
      earliest_at: new Date(chain[0].at).toISOString(),
      latest_at: new Date(terminal.at).toISOString(),
      illustrative: true,
    };

    lineFeatures.push({
      type: "Feature",
      properties: props,
      geometry: { type: "LineString", coordinates: coords },
    });

    const a = coords[coords.length - 2], b = coords[coords.length - 1];
    arrowFeatures.push({
      type: "Feature",
      properties: {
        ...props,
        bearing: bearingDeg({ lon: a[0], lat: a[1] }, { lon: b[0], lat: b[1] }),
      },
      geometry: { type: "Point", coordinates: b },
    });
  });

  const evidenceStates = nodes.map(node => ({
    placeKey: node.placeKey,
    nodeKey: node.nodeKey,
    linked: linkedNodeKeys.has(node.nodeKey),
    formal: node.formal,
  }));

  return {
    lines: { type: "FeatureCollection", features: lineFeatures },
    arrows: { type: "FeatureCollection", features: arrowFeatures },
    evidenceStates,
  };
}

function setRouteLayerVisibility() {
  if (!state.mapReady) return;
  const visibility = state.routesVisible ? "visible" : "none";
  for (const id of [
    "archive-uav-route-glow",
    "archive-uav-route-casing",
    "archive-uav-route-line",
    "archive-uav-route-highlight",
    "archive-uav-route-arrows",
    "archive-place-route-unlinked",
  ]) {
    if (state.map.getLayer(id)) state.map.setLayoutProperty(id, "visibility", visibility);
  }
  if (els.routeToggle) {
    els.routeToggle.classList.toggle("is-on", state.routesVisible);
    els.routeToggle.setAttribute("aria-pressed", String(state.routesVisible));
    const label = els.routeToggle.querySelector(".route-toggle-label");
    if (label) {
      label.textContent = "示意无人机路线 " + (state.routesVisible ? "ON" : "OFF") + " · " + state.routeFeatureCount;
    }
  }
}

function applyRouteEvidenceStates(evidenceStates) {
  if (!state.mapReady || !state.map.getSource("archive-places")) return;
  for (const id of state.previousRoutePlaceIds) {
    try {
      state.map.setFeatureState(
        { source: "archive-places", id },
        { routeLinked: false, routeUnlinked: false },
      );
    } catch (_) {}
  }
  state.previousRoutePlaceIds.clear();

  for (const evidence of evidenceStates || []) {
    const id = state.placeFeatureIds.get(evidence.placeKey);
    if (id == null) continue;
    try {
      state.map.setFeatureState(
        { source: "archive-places", id },
        evidence.linked ? { routeLinked: true, routeUnlinked: false } : { routeLinked: false, routeUnlinked: true },
      );
      state.previousRoutePlaceIds.add(id);
    } catch (_) {}
  }
}

function updateRouteOverlay(force = false) {
  if (!state.mapReady) return;
  const lineSource = state.map.getSource("archive-uav-routes");
  const arrowSource = state.map.getSource("archive-uav-route-arrows");
  if (!lineSource || !arrowSource) return;
  const start = selectionStartMs();
  const end = selectionEndMs();
  const key = [
    Math.round(start),
    Math.round(end),
    state.archive.reports?.length || 0,
    state.archive.events?.length || 0,
  ].join(":");
  if (!force && key === state.routeSelectionKey) {
    setRouteLayerVisibility();
    return;
  }
  state.routeSelectionKey = key;
  const data = buildIllustrativeUavRoutes(start, end);
  state.routeFeatureCount = data.lines.features.length;
  lineSource.setData(data.lines);
  arrowSource.setData(data.arrows);
  applyRouteEvidenceStates(data.evidenceStates);
  setRouteLayerVisibility();
}

function installArchiveLayers() {
  if (!state.map?.isStyleLoaded()) return;

  for (const id of [
    "archive-place-label", "archive-place-dot", "archive-place-route-unlinked", "archive-place-glow",
    "archive-uav-route-arrows", "archive-uav-route-highlight", "archive-uav-route-line",
    "archive-uav-route-casing", "archive-uav-route-glow",
    "archive-russia-border-main", "archive-russia-border-casing", "archive-russia-border-glow",
    "archive-ukraine-border-main", "archive-ukraine-border-casing", "archive-ukraine-border-glow",
    "archive-region-line", "archive-region-fill",
  ]) {
    if (state.map.getLayer(id)) state.map.removeLayer(id);
  }
  for (const id of [
    "archive-places", "archive-uav-route-arrows", "archive-uav-routes",
    "archive-country-borders", "archive-regions"
  ]) {
    if (state.map.getSource(id)) state.map.removeSource(id);
  }

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

  const countryBorders = detailedCountryBorderGeoJson();
  if (countryBorders.features.length) {
    state.map.addSource("archive-country-borders", { type: "geojson", data: countryBorders });

    // Equal visual weight, distinct cool hues.  A dark casing keeps the line
    // crisp against both the base map and bright alert fills.
    const addCountryBorderLayers = (code, slug, color, glow) => {
      state.map.addLayer({
        id: "archive-" + slug + "-border-glow",
        type: "line",
        source: "archive-country-borders",
        filter: ["==", ["get", "code"], code],
        layout: { "line-cap": "round", "line-join": "round" },
        paint: {
          "line-color": glow,
          "line-width": ["interpolate", ["linear"], ["zoom"], 3, 7.5, 7, 10.5, 11, 14],
          "line-opacity": 0.22,
          "line-blur": 2.8,
        },
      }, beforeId);
      state.map.addLayer({
        id: "archive-" + slug + "-border-casing",
        type: "line",
        source: "archive-country-borders",
        filter: ["==", ["get", "code"], code],
        layout: { "line-cap": "round", "line-join": "round" },
        paint: {
          "line-color": "#031018",
          "line-width": ["interpolate", ["linear"], ["zoom"], 3, 4.2, 7, 5.8, 11, 7.2],
          "line-opacity": 0.92,
        },
      }, beforeId);
      state.map.addLayer({
        id: "archive-" + slug + "-border-main",
        type: "line",
        source: "archive-country-borders",
        filter: ["==", ["get", "code"], code],
        layout: { "line-cap": "round", "line-join": "round" },
        paint: {
          "line-color": color,
          "line-width": ["interpolate", ["linear"], ["zoom"], 3, 1.55, 7, 2.15, 11, 2.75],
          "line-opacity": 0.94,
        },
      }, beforeId);
    };

    addCountryBorderLayers("UKR", "ukraine", "#61e3cf", "#38bfae");
    addCountryBorderLayers("RUS", "russia", "#8dbbd2", "#5c8ea6");
  }

  state.map.addSource("archive-uav-routes", { type: "geojson", data: EMPTY_FEATURE_COLLECTION });
  state.map.addSource("archive-uav-route-arrows", { type: "geojson", data: EMPTY_FEATURE_COLLECTION });

  state.map.addLayer({
    id: "archive-uav-route-glow",
    type: "line",
    source: "archive-uav-routes",
    layout: {
      "line-cap": "round",
      "line-join": "round",
      "visibility": state.routesVisible ? "visible" : "none",
    },
    paint: {
      "line-color": "#ff7218",
      "line-width": ["interpolate", ["linear"], ["zoom"], 3, 6.8, 7, 9.5, 11, 12.5],
      "line-opacity": ["interpolate", ["linear"], ["get", "confidence"], 0.3, 0.10, 1, 0.26],
      "line-blur": 3.6,
    },
  }, beforeId);

  state.map.addLayer({
    id: "archive-uav-route-casing",
    type: "line",
    source: "archive-uav-routes",
    layout: {
      "line-cap": "round",
      "line-join": "round",
      "visibility": state.routesVisible ? "visible" : "none",
    },
    paint: {
      "line-color": "#6f2c08",
      "line-width": ["interpolate", ["linear"], ["zoom"], 3, 3.5, 7, 4.5, 11, 5.6],
      "line-opacity": ["interpolate", ["linear"], ["get", "confidence"], 0.3, 0.50, 1, 0.88],
    },
  }, beforeId);

  state.map.addLayer({
    id: "archive-uav-route-line",
    type: "line",
    source: "archive-uav-routes",
    layout: {
      "line-cap": "round",
      "line-join": "round",
      "visibility": state.routesVisible ? "visible" : "none",
    },
    paint: {
      "line-color": "#ff8b1f",
      "line-width": ["interpolate", ["linear"], ["zoom"], 3, 1.35, 7, 1.85, 11, 2.45],
      "line-opacity": ["interpolate", ["linear"], ["get", "confidence"], 0.3, 0.62, 1, 0.96],
    },
  }, beforeId);

  state.map.addLayer({
    id: "archive-uav-route-highlight",
    type: "line",
    source: "archive-uav-routes",
    minzoom: 3.2,
    layout: {
      "line-cap": "round",
      "line-join": "round",
      "visibility": state.routesVisible ? "visible" : "none",
    },
    paint: {
      "line-color": "#ffc263",
      "line-width": ["interpolate", ["linear"], ["zoom"], 3, 0.35, 7, 0.55, 11, 0.8],
      "line-opacity": ["interpolate", ["linear"], ["get", "confidence"], 0.3, 0.22, 1, 0.62],
    },
  }, beforeId);

  state.map.addLayer({
    id: "archive-uav-route-arrows",
    type: "symbol",
    source: "archive-uav-route-arrows",
    minzoom: 3,
    layout: {
      "visibility": state.routesVisible ? "visible" : "none",
      "text-field": "▲",
      "text-font": ["Noto Sans Regular"],
      "text-size": ["interpolate", ["linear"], ["zoom"], 3, 10, 7, 13, 11, 16],
      "text-rotate": ["get", "bearing"],
      "text-rotation-alignment": "map",
      "text-allow-overlap": true,
      "text-ignore-placement": true,
    },
    paint: {
      "text-color": "#ff9a2f",
      "text-halo-color": "#5e2608",
      "text-halo-width": 1.1,
      "text-opacity": ["interpolate", ["linear"], ["get", "confidence"], 0.3, 0.55, 1, 1],
    },
  });

  state.routeSelectionKey = "";
  state.previousRoutePlaceIds.clear();

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
    id: "archive-place-route-unlinked",
    type: "circle",
    source: "archive-places",
    layout: {
      "visibility": state.routesVisible ? "visible" : "none",
    },
    paint: {
      "circle-radius": ["interpolate", ["linear"], ["zoom"], 3, 5.6, 7, 8.4, 11, 11.5],
      "circle-color": ["case",
        ["boolean", ["feature-state", "active"], false], "#39d8ff",
        ["boolean", ["feature-state", "report"], false], "#ffb347",
        "#7893a1"
      ],
      "circle-opacity": ["case",
        ["all",
          ["boolean", ["feature-state", "routeUnlinked"], false],
          ["any",
            ["boolean", ["feature-state", "active"], false],
            ["boolean", ["feature-state", "report"], false]
          ]
        ], 0.055,
        0
      ],
      "circle-stroke-color": ["case",
        ["boolean", ["feature-state", "active"], false], "#8ceaff",
        ["boolean", ["feature-state", "report"], false], "#ffd17c",
        "#91a9b6"
      ],
      "circle-stroke-width": ["interpolate", ["linear"], ["zoom"], 3, 1.0, 7, 1.35, 11, 1.7],
      "circle-stroke-opacity": ["case",
        ["all",
          ["boolean", ["feature-state", "routeUnlinked"], false],
          ["any",
            ["boolean", ["feature-state", "active"], false],
            ["boolean", ["feature-state", "report"], false]
          ]
        ], 0.88,
        0
      ],
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
  if (els.routeToggle) {
    els.routeToggle.addEventListener("click", () => {
      state.routesVisible = !state.routesVisible;
      setRouteLayerVisibility();
      if (state.routesVisible) updateRouteOverlay(true);
    });
  }
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
  updateRouteOverlay();
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
    const peer = s.source_type === "telegram" && s.mtproto_peer_cache_hit
      ? " · PEER CACHE"
      : (s.source_type === "telegram" && s.mtproto_peer_resolved ? " · PEER RESOLVED" : "");
    const window = s.window_complete ? " · WINDOW OK" : (s.source_type === "telegram" ? " · WINDOW ?" : "");
    const activity = s.activity_posts ?? s.alert_posts ?? 0;
    const uav = s.uav_activity_posts ?? null;
    const missile = s.missile_activity_posts ?? null;
    const threatCounts = uav == null && missile == null ? `${activity} ACTIVITY` : `${uav ?? 0} UAV · ${missile ?? 0} MISSILE`;
    const counts = `${s.posts ?? 0} posts · ${threatCounts} · ${s.events ?? 0} paired · ${s.reports ?? 0} signals`;
    const err = s.error ? ` · ${s.error}` : "";
    const source = s.source_type === "telegram" ? ` @${s.source}` : "";
    return `${kind}${source} ${health}${transport}${peer}${window}: ${counts}${err}`;
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
