/* node --test tests/test_route_smooth.cjs
 * Moving routes update on display frames, independent of GeoJSON workers.
 */
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const painter = require("../js/route-canvas.js");
const anim = require("../js/route-animation.js");
const app = fs.readFileSync(path.join(__dirname, "../js/app.js"), "utf8");
const video = fs.readFileSync(path.join(__dirname, "../js/video-export.js"), "utf8");
const html = fs.readFileSync(path.join(__dirname, "../index.html"), "utf8");
const css = fs.readFileSync(path.join(__dirname, "../css/styles.css"), "utf8");

function fragment(source, first, last) {
  const start = source.indexOf(first), end = source.indexOf(last, start + first.length);
  assert.ok(start >= 0 && end > start, "section missing: " + first);
  return source.slice(start, end);
}

test("route painter wakes hidden canvas before measuring; no pointers captured", () => {
  assert.match(html, /id="playbackRouteCanvas"/);
  assert.match(html, /src="js\/route-canvas\.js"/);
  assert.match(css, /\.playback-route-canvas\s*\{[^}]*pointer-events:\s*none/s);
  const ops = [];
  const ctx = {
    setTransform(...a){ops.push(["transform",...a]);},
    clearRect(...a){ops.push(["clear",...a]);},
    beginPath(){ops.push(["begin"]);},
    moveTo(...a){ops.push(["move",...a]);},
    lineTo(...a){ops.push(["line",...a]);},
    stroke(){ops.push(["stroke"]);},
    fill(){ops.push(["fill"]);},
    closePath(){ops.push(["close"]);},
    save(){ops.push(["save"]);},
    restore(){ops.push(["restore"]);},
  };
  const canvas = {
    hidden:true,width:0,height:0,
    get clientWidth(){return this.hidden ? 0 : 800;},
    get clientHeight(){return this.hidden ? 0 : 450;},
    getContext(){return ctx;},
  };
  const map = {getZoom:()=>7,project:p=>({x:p.lng*20+200,y:p.lat*20+150})};
  const frame={count:1,lines:{features:[{
    properties:{route_id:"r1",confidence:.9,route_weight:1.1},
    geometry:{coordinates:[[0,0],[1,0],[2,0]]}
  }]},arrows:{features:[{properties:{route_id:"r1"}}]}};
  assert.equal(painter.paint(canvas,map,frame),1);
  assert.equal(canvas.hidden,false);
  assert.equal(canvas.width,800);
  assert.equal(canvas.height,450);
  assert.ok(ops.some(x=>x[0]==="fill"),"moving tip is painted with its line");
  ops.length=0;
  assert.equal(painter.paint(canvas,map,{count:0}),0);
  assert.equal(canvas.hidden,true);
  assert.equal(ops.length,0,"no empty canvas repaint between waves");
});

test("288 min/s runs at display rate, independent of 10Hz map updates", () => {
  const source = fragment(app,"function togglePlayback()","function sourceStatusText(");
  const state = {timer:null,exportBusy:false,viewMode:"cumulative",
    playbackActivated:false,currentMs:0};
  let id=0,cancelled=0;
  const scheduled=new Map();
  const rAF = fn => {const next=++id;scheduled.set(next,fn);return next;};
  const cancel = frame => {cancelled++;scheduled.delete(frame);};
  const els={playButton:{classList:{add(){},remove(){}},textContent:""},
    speedSelect:{value:"288"}};
  let mapUpdates=0,waveUpdates=0;
  const obj = new Function("state","els","selectionStartMs","selectionEndMs",
    "performance","render","updateRouteOverlay","requestAnimationFrame",
    "cancelAnimationFrame",source+"return {togglePlayback,stopPlayback};")(
      state,els,()=>0,()=>10*3600000,{now:()=>0},
      ()=>{mapUpdates++;},()=>{waveUpdates++;},rAF,cancel);
  obj.togglePlayback();
  for(let i=1;i<=60;i++){
    const id=state.timer, frame=scheduled.get(id);
    assert.equal(typeof frame,"function");
    scheduled.delete(id);
    frame(i*1000/60);
  }
  assert.ok(Math.abs(state.currentMs-288*60000)<100,
    "historical clock advances 288 minutes for one second at 288 min/s");
  assert.ok(waveUpdates>=60,"routes update at approx. 60Hz");
  assert.ok(mapUpdates<15,"whole map state updates separately and less often");
  obj.stopPlayback();
  assert.equal(state.timer,null);
  assert.ok(cancelled>0);
});

test("head moves on every display frame between published observation anchors", () => {
  const base=Date.parse("2026-10-20T00:00:00Z");
  const feature={type:"Feature",properties:{
    route_id:"x",latest_at:new Date(base+2*3600000).toISOString()
  },geometry:{type:"LineString",coordinates:[[0,0],[1,0],[2,0]]}};
  const prep=anim.prepare({lines:{features:[feature]}});
  const a=anim.renderAt(prep,base+90*60000);
  const b=anim.renderAt(prep,base+91*60000);
  assert.equal(a.count,1);
  assert.equal(b.count,1);
  const x1=a.lines.features[0].geometry.coordinates.at(-1)[0];
  const x2=b.lines.features[0].geometry.coordinates.at(-1)[0];
  assert.ok(x2>x1,"leading tip moves when simulation clock advances");
  assert.ok(x2-x1<.08,"one historical minute never jumps along most of the path");
});

test("playback canvas has no per-frame GeoJSON setData; static mode remains untouched", () => {
  const realtime=fragment(app,"function updatePlaybackRouteOverlay(","function setRouteLayerVisibility(");
  const staticMode=fragment(app,"function updateRouteOverlay()","function installArchiveLayers(");
  assert.doesNotMatch(realtime,/\.setData\(/);
  assert.match(realtime,/DeepstrikeRouteAnimation\.renderAt/);
  assert.match(realtime,/painter\?\.paint\(canvas, state\.map, frame\)/);
  assert.match(staticMode,/lineSource\.setData\(state\.routeStaticData\.lines\)/);
  assert.match(app,/state\.timer = requestAnimationFrame\(step\)/);
  assert.doesNotMatch(app,/state\.timer = setInterval/);
});

test("export composites the overlay between basemap and branding",()=>{
  assert.match(app,/routeOverlay: els\.playbackRouteCanvas/);
  const source=fragment(video,"function drawVideoFrame(","function sleep(");
  const draw=new Function(source+"return drawVideoFrame;")();
  const imgs=[];
  const ctx={
    canvas:{width:1920,height:1080},fillRect(){},fillText(){},save(){},restore(){},
    measureText:t=>({width:t.length*20}),drawImage:img=>imgs.push(img)
  };
  const map={width:1920,height:1080};
  const overlay={width:1920,height:1080,hidden:false};
  const hud={width:1920,height:1080,hidden:false};
  draw(ctx,map,0,0,100,()=>"",()=>"",null,overlay,hud);
  assert.equal(imgs[0],map);
  assert.equal(imgs[1],overlay);
  assert.equal(imgs[2],hud,"same presentation HUD as fullscreen");
  assert.equal(imgs.length,3,"map, dynamic canvas and shared HUD; no black footer");
  imgs.length=0;overlay.hidden=true;
  draw(ctx,map,0,0,100,()=>"",()=>"",null,overlay,hud);
  assert.equal(imgs.length,2,"only map and shared HUD after a wave ends");
});
