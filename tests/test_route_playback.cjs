/* Run with: node --test tests/test_route_playback.cjs
 * Isolates the browser-independent route functions without launching MapLibre.
 */
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const js = fs.readFileSync(path.join(__dirname, "../js/app.js"), "utf8");

function section(first, last) {
  const a = js.indexOf(first), b = js.indexOf(last, a + first.length);
  assert.ok(a >= 0 && b > a, "expected code section: " + first);
  return js.slice(a, b);
}
const geometry = section("function routePointProgress(", "async function buildIllustrativeUavRoutes(");
const animation = section("function routeWavePeriods(", "function showRouteLoading(");
const missiles = section("function buildIllustrativeMissileRoutes(", "async function buildIllustrativeRoutes(");

const flatDistance = (a, b) => Math.hypot(a.lon - b.lon, a.lat - b.lat);
const lineLength = points => points.slice(1).reduce((total, p, i) =>
  total + Math.hypot(p[0] - points[i][0], p[1] - points[i][1]), 0);
const local = (a, b) => ({ x: b.lon - a.lon, y: b.lat - a.lat });

const geo = new Function("haversineKm", "routeLengthKm", "localVectorKm",
  "bearingDeg", "selectionStartMs", "selectionEndMs", "isStrongObservationKind",
  geometry + animation + "\nreturn {routeTimingForNodes,groupWaveTerminals,routeRevealProgress,routeWavePeriods,activeRouteWave,clipRouteWave,illustratedRoutesAtTime};"
)(flatDistance, lineLength, local, () => 90, () => 0, () => 100000, kind => kind === "uav_movement");

test("animated wave advances smoothly then its tail follows and clears", () => {
  const coords = [[0, 0], [1, 0], [2, 0]];
  const nodes = [
    { lon: 1, lat: 0, windows: [{ from: 0, to: 3600000 }] },
    { lon: 2, lat: 0, windows: [{ from: 1800000, to: 5400000 }] },
  ];
  const feature = {
    type: "Feature", properties: { threat: "uav" },
    geometry: { type: "LineString", coordinates: coords },
    _timing: geo.routeTimingForNodes(coords, nodes),
  };
  const atStart = geo.activeRouteWave(feature, 0);
  const early = geo.activeRouteWave(feature, 1000000);
  const middle = geo.activeRouteWave(feature, 3000000);
  const late = geo.activeRouteWave(feature, 4700000);
  assert.equal(atStart, null);
  assert.ok(early && early.head > early.tail, "head should have appeared");
  assert.ok(middle && middle.head >= early.head, "head never moves backwards");
  assert.ok(late && late.tail > 0, "tail must begin to advance");
  assert.ok(late.tail < late.head, "tail must remain behind head");
  assert.equal(geo.activeRouteWave(feature, 5400000), null, "clear immediately after the last alert");
  assert.deepEqual(feature.geometry.coordinates, coords, "static geometry must remain unchanged");
  const segment = geo.clipRouteWave(feature, late.tail, late.head);
  assert.ok(segment.geometry.coordinates[0][0] > 0, "moving tail cannot remain stuck at origin");
  assert.ok(segment.geometry.coordinates.at(-1)[0] <= 2);
  const justBefore = geo.activeRouteWave(feature, 2999000);
  const justAfter = geo.activeRouteWave(feature, 3001000);
  assert.ok(Math.abs(justAfter.head - justBefore.head) < .1, "no instantaneous path growth");
});

test("candidate route grouping merges redundant same-wave locations without an arbitrary count cap", () => {
  const many = [];
  for (let i = 0; i < 800; i++) {
    const region = "region-" + (i % 40);
    many.push({ region, lon: i % 40, lat: 0, at: Math.floor(i / 40) * 60000,
      weight: 1, observations: 1, kind: "uav_detected", placeName: "test" });
  }
  const grouped = geo.groupWaveTerminals(many);
  assert.ok(grouped.length < 80, "duplicate burst observations must not create 800 routes");
  const unique = many.concat([{ region: "independent", lon: 100, lat: 0,
    at: 7000000, kind: "uav_movement", weight: 1 }]);
  assert.ok(geo.groupWaveTerminals(unique).some(p => p.region === "independent"),
    "independent observations must not be discarded by a global cap");
});

test("one missile report must not imply an invented flight path", () => {
  const start = { at: 0, lon: 40, lat: 50, region: "A", place: "A",
    recordKey: "a", windows: [{ from: 0, to: 600000 }] };
  const end = { at: 1800000, lon: 42, lat: 50, region: "B", place: "B",
    recordKey: "b", windows: [{ from: 1800000, to: 2400000 }] };
  let observations = [start];
  const api = new Function("routePlaceCatalog", "routeObservationNodes",
    "haversineKm", "smoothInterpolatingRoute", "routeTimingForNodes",
    "bearingDeg", "buildIllustrativeUavRoutes", "groupWaveTerminals",
    missiles + "\nreturn {buildIllustrativeMissileRoutes};"
  )(() => ({}), () => observations, (a, b) => flatDistance(a, b) * 50,
    points => points.map(p => [p.lon, p.lat]), geo.routeTimingForNodes,
    () => 90, () => ({ lines: { features: [] }, arrows: { features: [] } }),
    geo.groupWaveTerminals);
  assert.equal(api.buildIllustrativeMissileRoutes(0, 10000000).lines.features.length, 0);
  observations = [start, end];
  const result = api.buildIllustrativeMissileRoutes(0, 10000000);
  assert.equal(result.lines.features.length, 1);
  assert.equal(result.lines.features[0].properties.threat, "missile");
  assert.equal(result.lines.features[0]._timing.length, 2);
});

test("export uses selected range and configured playback speed", () => {
  assert.match(js, /durationSeconds\s*=\s*\(end - start\)\s*\/\s*\(minutesPerSecond \* 60 \* 1000\)/);
  assert.doesNotMatch(js, /videoDurationSelect/);
  assert.doesNotMatch(js, /archive-place-route-unlinked/);
  assert.doesNotMatch(js, /\.slice\(0, 140\)/);
  assert.match(js, /await buildIllustrativeRoutes\(start, end, cancelled\)/);
  assert.match(js, /state\.activeEventHours\.get\(archiveHour\(ms\)\)/);
});
