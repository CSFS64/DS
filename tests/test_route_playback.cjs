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
const geometry = section("function routePointProgress(", "function buildIllustrativeUavRoutes(");
const animation = section("function routeRevealProgress(", "function setRouteLayerVisibility()");
const missiles = section("function buildIllustrativeMissileRoutes(", "// The geometry remains an inference");

const flatDistance = (a, b) => Math.hypot(a.lon - b.lon, a.lat - b.lat);
const lineLength = points => points.slice(1).reduce((total, p, i) =>
  total + Math.hypot(p[0] - points[i][0], p[1] - points[i][1]), 0);
const local = (a, b) => ({ x: b.lon - a.lon, y: b.lat - a.lat });

const geo = new Function("haversineKm", "routeLengthKm", "localVectorKm",
  "bearingDeg", "selectionStartMs", "selectionEndMs",
  geometry + animation + "\nreturn {routeTimingForNodes,routeRevealProgress,clippedIllustrativeLine,illustratedRoutesAtTime};"
)(flatDistance, lineLength, local, () => 90, () => 0, () => 100000);

test("route draws only when the exact source-record window is active", () => {
  const coordinates = [[0, 0], [1, 0], [2, 0]];
  const nodes = [
    { lon: 1, lat: 0, windows: [{ from: 100, to: 200 }] },
    { lon: 2, lat: 0, windows: [{ from: 250, to: 350 }] },
  ];
  const line = {
    type: "Feature", properties: { threat: "uav" },
    geometry: { type: "LineString", coordinates },
    _timing: geo.routeTimingForNodes(coordinates, nodes),
  };
  for (const [time, progress] of [[99, 0], [100, .5], [200, .5],
    [201, 0], [249, 0], [250, 1], [350, 1], [351, 0]]) {
    assert.equal(geo.routeRevealProgress(line, time), progress, "time " + time);
  }
  assert.deepEqual(geo.clippedIllustrativeLine(line, .5).geometry.coordinates,
    [[0, 0], [1, 0]]);
  assert.equal(geo.illustratedRoutesAtTime({ lines: { features: [line] } }, 351)
    .lines.features.length, 0);
});

test("one missile report must not imply an invented flight path", () => {
  const start = { at: 0, lon: 40, lat: 50, region: "A", place: "A",
    recordKey: "a", windows: [{ from: 0, to: 600000 }] };
  const end = { at: 1800000, lon: 42, lat: 50, region: "B", place: "B",
    recordKey: "b", windows: [{ from: 1800000, to: 2400000 }] };
  let observations = [start];
  const api = new Function("routePlaceCatalog", "routeObservationNodes",
    "haversineKm", "smoothInterpolatingRoute", "routeTimingForNodes",
    "bearingDeg", "buildIllustrativeUavRoutes",
    missiles + "\nreturn {buildIllustrativeMissileRoutes};"
  )(() => ({}), () => observations, (a, b) => flatDistance(a, b) * 50,
    points => points.map(p => [p.lon, p.lat]), geo.routeTimingForNodes,
    () => 90, () => ({ lines: { features: [] }, arrows: { features: [] } }));
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
});
