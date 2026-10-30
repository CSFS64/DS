/* Run: node --test tests/test_route_playback.cjs
 * Regression tests: original static UAV routes belong exclusively to the
 * yellow cumulative pointer, never to realtime playback or video export.
 */
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const js = fs.readFileSync(path.join(__dirname, "../js/app.js"), "utf8");

function section(first, last) {
  const a = js.indexOf(first), b = js.indexOf(last, a + first.length);
  assert.ok(a >= 0 && b > a, "missing code section: " + first);
  return js.slice(a, b);
}
const windowCode = section("function staticRouteWindow(", "function showRouteLoading(");
const keyCode = section("function currentRouteKey(", "async function buildRoutesCooperatively(");
const overlayCode = section("function updateRouteOverlay(", "function installArchiveLayers(");
const originalBuilder = section("async function buildIllustrativeUavRoutes(", "function staticRouteWindow(");

function makeWindow(state, start = 1000, end = 10000) {
  return new Function("state", "selectionStartMs", "selectionEndMs",
    windowCode + keyCode + "return {staticRouteWindow,currentRouteKey};"
  )(state, () => start, () => end);
}

test("initial and realtime states have no static routes, even when time advances", () => {
  const state = { viewMode: "realtime", cumulativeMs: 6000,
    archive: { reports: Array(10), events: Array(5) } };
  const api = makeWindow(state);
  assert.equal(api.staticRouteWindow(), null);
  assert.equal(api.currentRouteKey(), "");
  state.cumulativeMs = 8000;
  assert.equal(api.staticRouteWindow(), null);
});

test("yellow cumulative cursor alone defines the route cutoff", () => {
  const state = { viewMode: "cumulative", cumulativeMs: 1000,
    archive: { reports: [], events: [] } };
  const api = makeWindow(state);
  assert.equal(api.staticRouteWindow(), null, "no history at the initial left endpoint");
  assert.equal(api.currentRouteKey(), "");
  state.cumulativeMs = 4300;
  assert.deepEqual(api.staticRouteWindow(), { start: 1000, end: 4300 });
  assert.match(api.currentRouteKey(), /^1000:4300:/);
  state.cumulativeMs = 12000;
  assert.deepEqual(api.staticRouteWindow(), { start: 1000, end: 10000 },
    "stop at the selected end boundary");
  state.viewMode = "realtime";
  assert.equal(api.staticRouteWindow(), null);
});

test("realtime overlay empties map and does not launch a route computation", () => {
  const calls = [];
  const source = () => ({setData: data => calls.push(data.features.length)});
  const state = {
    mapReady: true, map: { getSource: source }, viewMode: "realtime",
    cumulativeMs: 9000, routesVisible: true, routeSelectionKey: "previous",
    routeDisplayedPhase: "previous", routeBuildPending: true, routeGeneration: 3,
    routeFeatureCount: 140, routeCache: new Map(), routeStaticData: {lines:{}},
    routeFullData: {lines:{}}, routeUpdateTimer: null,
    archive: { reports: [], events: [] },
  };
  let builds = 0, hidden = 0;
  const f = new Function("state", "setRouteLayerVisibility", "staticRouteWindow",
    "currentRouteKey", "EMPTY_FEATURE_COLLECTION", "hideRouteLoading",
    "showRouteLoading", "buildRoutesCooperatively", "selectionStartMs",
    "selectionEndMs", overlayCode + "return updateRouteOverlay;"
  )(state, () => {}, () => makeWindow(state).staticRouteWindow(),
    () => makeWindow(state).currentRouteKey(),
    {type:"FeatureCollection", features:[]}, () => {hidden++;}, () => {},
    () => {builds++;}, () => 1000, () => 10000);
  f();
  assert.deepEqual(calls, [0, 0]);
  assert.equal(builds, 0);
  assert.equal(state.routeFeatureCount, 0);
  assert.equal(state.routeSelectionKey, "");
  assert.ok(hidden > 0);
});

test("changing only the cumulative pointer requests precisely the bounded time range", () => {
  const state = {
    mapReady:true, map:{getSource:()=>({setData:()=>{}})},
    viewMode:"cumulative", cumulativeMs:1000, routesVisible:true,
    routeSelectionKey:"", routeDisplayedPhase:"empty", routeBuildPending:false,
    routeFeatureCount:0, routeCache:new Map(), routeGeneration:0,
    archive:{reports:[{}], events:[{}]}, exportRecording:false,
  };
  const builds=[];
  const f = new Function("state", "setRouteLayerVisibility", "staticRouteWindow",
    "currentRouteKey", "EMPTY_FEATURE_COLLECTION", "hideRouteLoading",
    "showRouteLoading", "buildRoutesCooperatively", "selectionStartMs",
    "selectionEndMs", overlayCode + "return updateRouteOverlay;"
  )(state, () => {}, () => makeWindow(state).staticRouteWindow(),
    () => makeWindow(state).currentRouteKey(),
    {type:"FeatureCollection",features:[]}, () => {}, () => {},
    (...args) => builds.push(args), () => 1000, () => 10000);
  f();
  assert.equal(builds.length, 0, "no first-load route at the yellow origin");
  state.cumulativeMs=4000;
  f();
  assert.equal(builds.length, 1);
  assert.deepEqual(builds[0].slice(0,2),[1000,4000]);
  f();
  assert.equal(builds.length, 1, "do not duplicate a pending build");
  state.cumulativeMs=5000;
  f();
  assert.equal(builds.length, 2);
  assert.deepEqual(builds[1].slice(0,2),[1000,5000]);
  state.viewMode="realtime";
  f();
  assert.equal(builds.length, 2, "playback never generates any routes");
});

test("original route selection and 140 candidate cap are restored; waves and missiles removed", () => {
  assert.match(originalBuilder, /sort\(\(a, b\) => \{\s*if \(Math\.abs\(a\.lat - b\.lat\) > 0\.15\)/);
  assert.match(originalBuilder, /\.slice\(0, 140\)/);
  assert.match(originalBuilder, /rankBorderStarts\(terminal, seed, usedVisibleStarts\)\.slice\(0, 18\)/);
  assert.match(originalBuilder, /routeRegionMetrics\(coords, litRegions\)/);
  assert.match(originalBuilder, /await yieldIfNeeded\(\)/);
  assert.doesNotMatch(js, /function routeWavePeriods|function illustratedRoutesAtTime|function buildIllustrativeMissileRoutes/);
  assert.match(js, /scheduleRouteRefresh\(160\)/);
  assert.match(js, /if \(leavingCumulative\) updateRouteOverlay\(\)/);
  assert.match(js, /if \(state\.exportRecording\)/);
});
