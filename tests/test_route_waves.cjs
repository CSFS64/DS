/* node --test tests/test_route_waves.cjs
 * Playback visual interpolation tests. Source observations are historical:
 * a route wave is a visualization, never a measured continuous flight track.
 */
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const wave = require("../js/route-animation.js");
const app = fs.readFileSync(path.join(__dirname, "../js/app.js"), "utf8");
const html = fs.readFileSync(path.join(__dirname, "../index.html"), "utf8");

const base = Date.parse("2026-10-20T00:00:00Z");
const H = 3600000;
function route(id, arrive, points = [[0,0], [1,0], [2,0]]) {
  return {
    type: "Feature",
    properties: {route_id:id, latest_at:new Date(arrive).toISOString(),
      confidence:.8, route_weight:1.1},
    geometry:{type:"LineString",coordinates:points},
  };
}
function ready(features, anchors = new Map()) {
  return wave.prepare({lines:{type:"FeatureCollection",features},animationAnchors:anchors});
}
test("head moves forward smoothly then tail follows and eventually reaches target", () => {
  const r = wave.prepareRoute(route("a",base+4*H), [
    {lon:1,lat:0,at:base+2*H}, {lon:2,lat:0,at:base+4*H}
  ]);
  assert.ok(r.start < base+2*H);
  assert.equal(wave.headAt(r,r.start),0);
  assert.equal(wave.headAt(r,r.arrival),1);
  assert.ok(Math.abs(wave.headAt(r,base+2*H)-.5)<.002,
    "mid-route observation should anchor the head position");
  const times=Array.from({length:51},(_,i)=>r.start+(r.arrival-r.start)*i/50);
  let prev=-1;
  for(const time of times){
    const head=wave.headAt(r,time);
    assert.ok(head>=prev,"head never jumps backward");
    assert.ok(head>=0 && head<=1);
    prev=head;
  }
  const growing = wave.waveAt(r,r.start+(r.arrival-r.start)*.45);
  assert.ok(growing && growing.head>growing.tail);
  const atTarget = wave.waveAt(r,r.arrival);
  assert.ok(atTarget && atTarget.head===1 && atTarget.tail>0 &&
    atTarget.tail<1,"when the head arrives the tail is still moving");
  const shrinking = wave.waveAt(r,r.arrival+r.lag*.65);
  assert.ok(shrinking && shrinking.head===1 && shrinking.tail>atTarget.tail,
    "tail keeps moving to target after head arrives");
  assert.equal(wave.waveAt(r,r.end),null,"no leftover line after tail arrives");
  assert.equal(wave.waveAt(r,r.end+H),null);
});
test("map draws only moving segment and NO standing arrow after arrival",()=>{
  const f=route("a",base+4*H);
  const prep=ready([f],new Map([["a",[
    {lon:1,lat:0,at:base+2*H},{lon:2,lat:0,at:base+4*H}
  ]]]));
  const r=prep.index.get(Math.floor((base+3*H)/H))[0];
  const moving=wave.renderAt(prep,base+3*H);
  assert.equal(moving.count,1);
  assert.equal(moving.arrows.features.length,1);
  assert.ok(moving.lines.features[0].geometry.coordinates[0][0]>0,
    "tail should have left the launch side of the path");
  assert.ok(moving.lines.features[0].geometry.coordinates.at(-1)[0]<2,
    "the moving head has not reached target yet");
  const arrived=wave.renderAt(prep,r.arrival+1);
  assert.equal(arrived.lines.features.length,1);
  assert.equal(arrived.arrows.features.length,0,
    "the arrow vanishes when the leading edge stops at the target");
  const cleared=wave.renderAt(prep,r.end);
  assert.equal(cleared.lines.features.length,0);
  assert.equal(cleared.arrows.features.length,0);
  assert.deepEqual(f.geometry.coordinates,[[0,0],[1,0],[2,0]],
    "static source geometry must never be mutated");
});
test("separate observed flights produce separate waves instead of accumulated arrows",()=>{
  const first=route("a",base+3*H);
  const second=route("b",base+12*H);
  const prep=ready([first,second]);
  assert.equal(prep.count,2);
  assert.equal(wave.renderAt(prep,base+2*H).count,1);
  assert.equal(wave.renderAt(prep,base+8*H).count,0);
  assert.equal(wave.renderAt(prep,base+11*H).count,1);
  assert.equal(wave.renderAt(prep,base+16*H).count,0);
  assert.equal(wave.renderAt(prep,base+16*H).arrows.features.length,0);
});
test("performance: only selected hour bucket is examined, not all history",()=>{
  const all=Array.from({length:800},(_,i)=>
    route("r"+i,base+(i*4+2)*H));
  const prep=ready(all);
  assert.equal(prep.count,800);
  assert.ok((prep.index.get(Math.floor((base+1.5*H)/H))||[]).length<10);
  assert.equal(wave.renderAt(prep,base+1.5*H).count,1);
});
test("realtime animation is independent from cumulative static route inference",()=>{
  assert.match(html, /src="js\/route-animation\.js"/);
  assert.ok(html.indexOf('src="js/route-animation.js"') <
            html.indexOf('src="js/app.js"'));
  assert.match(app,/function staticRouteWindow\(\)/);
  assert.match(app,/function updatePlaybackRouteOverlay\(/);
  assert.match(app,/const data = await buildIllustrativeUavRoutes\(/);
  assert.match(app,/animationAnchors\.set\(props\.route_id/);
  assert.match(app,/playbackRangeKey\(\)/);
  assert.match(app,/state\.playbackActivated = true;/);
  assert.match(app,/state\.playbackActivated = previous\.playbackActivated;/);
  assert.doesNotMatch(app,/\.slice\(0, 140\)/);
  assert.doesNotMatch(app,/function buildIllustrativeMissileRoutes/);
});
