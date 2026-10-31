/* Regression: historic missile routes share UAV infrastructure but never
 * merge their evidence, origin assumptions, or color palettes.
 * Run: node --test tests/test_missile_routes.cjs
 */
const test=require("node:test");
const assert=require("node:assert/strict");
const fs=require("node:fs");
const path=require("node:path");
const app=fs.readFileSync(path.join(__dirname,"../js/app.js"),"utf8");
const canvasSource=fs.readFileSync(path.join(__dirname,"../js/route-canvas.js"),"utf8");
const anim=require("../js/route-animation.js");
const html=fs.readFileSync(path.join(__dirname,"../index.html"),"utf8");
const css=fs.readFileSync(path.join(__dirname,"../css/styles.css"),"utf8");
const section=(from,to)=>{
  const a=app.indexOf(from),b=app.indexOf(to,a+from.length);
  assert.ok(a>=0&&b>a,"missing: "+from);
  return app.slice(a,b);
};

test("missile observations and UAV observations are deliberately isolated",()=>{
  const body=section("function routeObservationPoints(","function haversineKm(");
  const resolve=new Function(
    "threatClass","reportRepresentsLiveThreat","routeEvidenceCount",
    "routeCountWeight","normalizeAdminNameStrict","regionRepresentativePoint",
    "resolveRouteCatalogPlace",
    body+"\nreturn routeObservationPoints;"
  )(
    r=>r.threat_class,()=>true,()=>null,()=>1,
    name=>String(name).toLowerCase(),()=>null,()=>null
  );
  const p={
    threat_class:"missile",id:"a",region:"Test Oblast",
    activity_kind:"missile_detected",scope:"city",
    place:"Test City",lon:35.2,lat:51.1
  };
  const catalog={exact:new Map(),aliases:new Map()};
  const missile=resolve(p,100,"report",catalog,"missile");
  assert.equal(missile.length,1);
  assert.equal(missile[0].threat,"missile");
  assert.equal(missile[0].kind,"missile_detected");
  assert.deepEqual(resolve(p,100,"report",catalog,"uav"),[]);
  const uav={...p,id:"b",threat_class:"uav",activity_kind:"uav_detected"};
  assert.equal(resolve(uav,100,"report",catalog,"missile").length,0);
  assert.equal(resolve(uav,100,"report",catalog,"uav").length,1);
});

test("only missile-active regions are used in missile route scoring",()=>{
  const code=section("function selectedWindowThreatRegions(","function routeRegionMetrics(");
  const state={archive:{
    reports:[
      {region:"M",at:"2026-11-01T01:00:00Z",threat_class:"missile"},
      {region:"U",at:"2026-11-01T01:00:00Z",threat_class:"uav"}
    ],
    events:[{region:"E",start:"2026-11-01T00:00:00Z",
      end:"2026-11-01T02:00:00Z",threat_class:"missile"}]
  }};
  const fn=new Function("state","threatClass","reportRepresentsLiveThreat",
    "selectedWindowUavRegions",code+"return selectedWindowThreatRegions;")(
      state,r=>r.threat_class,()=>true,()=>new Set(["uav-only"])
    );
  const start=Date.parse("2026-11-01T00:00:00Z");
  const end=Date.parse("2026-11-01T02:00:00Z");
  assert.deepEqual([...fn(start,end,"missile")].sort(),["E","M"]);
  assert.deepEqual([...fn(start,end,"uav")],["uav-only"]);
});

test("combined static and dynamic routes keep threat-specific IDs and time anchors",async()=>{
  const body=section("async function buildIllustrativeMissileRoutes(","// Only the yellow cumulative cursor");
  const a={lines:{features:[{properties:{route_id:"uav-route-0",threat:"uav"}}]},
    arrows:{features:[{properties:{threat:"uav"}}]},
    animationAnchors:new Map([["uav-route-0",[{at:100}]]]),
    evidenceStates:[]};
  const b={lines:{features:[{properties:{route_id:"missile-route-0",threat:"missile"}}]},
    arrows:{features:[{properties:{threat:"missile"}}]},
    animationAnchors:new Map([["missile-route-0",[{at:200}]]]),
    evidenceStates:[]};
  const combined=new Function("buildIllustrativeUavRoutes",body+
    "\nreturn buildIllustrativeAllRoutes;")(
    async(start,end,cancelled,threat="uav")=>threat==="missile"?b:a
  );
  const output=await combined(0,1000,()=>false);
  assert.deepEqual(output.lines.features.map(f=>f.properties.threat),["uav","missile"]);
  assert.deepEqual([...output.animationAnchors.keys()],["uav-route-0","missile-route-0"]);
  assert.equal(output.arrows.features.length,2);
});

test("shorter missile wave and 60 fps head/tail disappearance reuse same animation",()=>{
  const base=Date.parse("2026-11-01T00:00:00Z");
  const feature=threat=>({
    type:"Feature",
    properties:{route_id:threat+"-route-0",threat,
      latest_at:new Date(base+3600000).toISOString()},
    geometry:{type:"LineString",coordinates:[[36,55],[37,55],[38,55]]}
  });
  const u=anim.prepareRoute(feature("uav"),[]);
  const m=anim.prepareRoute(feature("missile"),[]);
  assert.ok(m.arrival-m.start < u.arrival-u.start);
  assert.ok(m.lag < u.lag);
  const halfway=(m.start+m.arrival)/2;
  const prep=anim.prepare({lines:{features:[feature("missile")]}});
  const midpoint=anim.renderAt(prep,halfway);
  assert.equal(midpoint.count,1);
  assert.equal(midpoint.arrows.features[0].properties.threat,"missile");
  const tail=anim.renderAt(prep,m.arrival + m.lag*.5);
  assert.equal(tail.count,1);
  assert.equal(tail.arrows.features.length,0,"arrow vanishes once leading tip arrives");
  assert.equal(anim.renderAt(prep,m.end).count,0,"tail follows and disappears");
});

test("static MapLibre and dynamic canvas both use rose red for missile, orange for UAV",()=>{
  assert.match(app,/"line-color": \["case", \["==", \["get", "threat"\], "missile"\], "#ff4a73", "#ff8b1f"\]/);
  assert.match(app,/"text-color": \["case", \["==", \["get", "threat"\], "missile"\], "#ff537c", "#ff9a2f"\]/);
  assert.match(canvasSource,/missile \? "#ff4a73" : "#ff8b1f"/);
  assert.match(canvasSource,/route\.threat === "missile" \? "#ff537c" : "#ff9a2f"/);
  assert.match(html,/legend-route-missile/);
  assert.match(css,/\.legend-route-missile::after \{ border-top-color: #ff537c; \}/);
  assert.match(app,/const data = await buildIllustrativeAllRoutes\(start, end, cancelled\)/);
  assert.match(app,/const data = await buildIllustrativeAllRoutes\(\s*selectionStartMs\(\)/);
  assert.doesNotMatch(app,/\.slice\(0, 140\)/);
});
