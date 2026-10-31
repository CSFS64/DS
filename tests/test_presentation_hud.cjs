/* node --test tests/test_presentation_hud.cjs */
const test=require("node:test");
const assert=require("node:assert/strict");
const fs=require("node:fs");
const path=require("node:path");
const read=x=>fs.readFileSync(path.join(__dirname,"..",x),"utf8");
const hudCode=read("js/presentation-hud.js");
const video=read("js/video-export.js");
const css=read("css/styles.css");
const html=read("index.html");
const app=read("js/app.js");
const mod={exports:{}};
new Function("module",hudCode)(mod);
const hud=mod.exports;

test("CLEAN VIEW fills 16:9 and exports the exact same 1920x1080 pixels",()=>{
  assert.equal(hud.FRAME_W,1920);
  assert.equal(hud.FRAME_H,1080);
  assert.match(css,/body\.clean-map-view \.app-shell \{\s*display: flex;/);
  assert.match(css,/body\.clean-map-view \.map-panel\s*\{[^}]*aspect-ratio:\s*16\s*\/\s*9;/s);
  assert.match(css,/width:\s*min\(100vw,\s*177\.7777778dvh\)/);
  assert.match(css,/height:\s*min\(100dvh,\s*56\.25vw\)/);
  assert.match(app,/presentationOverlay: els\.presentationHudCanvas/);
  assert.match(video,/const WIDTH = 1920;/);
  assert.match(video,/const HEIGHT = 1080;/);
  assert.doesNotMatch(video,/Math\.min\(w \/ mapCanvas\.width/,"no letterbox fitting");
  assert.match(video,/ctx\.drawImage\(mapCanvas, 0, 0, w, h\)/);
  assert.match(video,/ctx\.drawImage\(presentationOverlay, 0, 0, w, h\)/);
  assert.match(html,/id="presentationHudCanvas"/);
  assert.ok(html.indexOf('src="js/presentation-hud.js"') <
    html.indexOf('src="js/app.js"'));
});

test("bottom footer is gone; only the 5px blue progress bar is anchored to bottom",()=>{
  assert.doesNotMatch(video,/Public-source historical alerts/i);
  assert.doesNotMatch(hudCode,/Public-source historical alerts ·/i);
  assert.match(css,/\.presentation-progress\s*\{[^}]*bottom:\s*0;[^}]*height:\s*5px;/s);
  assert.match(css,/\.presentation-progress-fill\s*\{[^}]*background:\s*#39d8ff;/s);
  assert.match(video,/ctx\.fillRect\(0, h - 5, w \* p, 5\)/);
  assert.match(hudCode,/© OpenStreetMap contributors · OpenFreeMap/);
  assert.match(app,/function updatePresentationProgress\(\)/);
  assert.match(app,/updatePresentationProgress\(\);\s*if \(state\.currentMs >= end\)/);
  assert.equal(hud.progress(0,0,100),0);
  assert.equal(hud.progress(50,0,100),.5);
  assert.equal(hud.progress(150,0,100),1);
  assert.equal(hud.progress(100,100,100),0);
});

test("scale bar is a real geographic distance at viewport's lower left",()=>{
  const makeMap=degreesPerPx=>({
    unproject:([x,y])=>({lng:(x-960)*degreesPerPx,lat:55})
  });
  const near=hud.scaleAt(makeMap(.0003),1920,1080);
  const far=hud.scaleAt(makeMap(.01),1920,1080);
  assert.ok(near && far);
  assert.ok(near.y > 980);
  assert.ok(near.x < 100);
  assert.ok(near.px > 0 && near.px <= 202);
  assert.ok(far.px > 0 && far.px <= 202);
  assert.ok(far.km>near.km,"bar represents larger distances when zoomed out");
  const physicalMax=hud.haversineKm(
    {lat:55,lng:0},{lat:55,lng:.0003*201.6}
  );
  assert.ok(near.km<=physicalMax,"bar must never claim farther than its pixels");
  assert.ok([1,2,5].some(k=>Math.abs(near.km/
    (10**Math.floor(Math.log10(near.km)))-k)<1e-6));
});

test("HUD can draw on canonical 1920x1080 canvas at a different CSS viewport size",()=>{
  const ops=[];
  const ctx={
    setTransform(...x){ops.push(["transform",...x]);},
    clearRect(...x){ops.push(["clear",...x]);},
    drawImage(){ops.push(["image"]);},
    fillText(text){ops.push(["text",text]);},
    fillRect(...x){ops.push(["rect",...x]);},
    measureText:text=>({width:text.length*19}),
    save(){},restore(){},beginPath(){},moveTo(){},lineTo(){},stroke(){},
  };
  const canvas={
    width:0,height:0,clientWidth:1280,clientHeight:720,
    getContext:()=>ctx,
  };
  const map={unproject:([x,y])=>({lng:x*.001,lat:50})};
  const result=hud.paint(canvas,{map,ms:123000,
    formatKyiv:t=>"Kyiv"+t,formatBeijing:t=>"Beijing"+t});
  assert.equal(canvas.width,1920);
  assert.equal(canvas.height,1080);
  assert.ok(result && result.km>0);
  assert.ok(result.px>0);
  assert.ok(ops.some(o=>o[0]==="text"&&o[1]==="Kyiv time: Kyiv123000"));
});

test("video uses full-bleed layering and guards unexpected distorted source shapes",()=>{
  const start=video.indexOf("function drawVideoFrame(");
  const end=video.indexOf("function sleep(",start);
  assert.ok(start>=0&&end>start);
  const draw=new Function(video.slice(start,end)+"return drawVideoFrame;")();
  const events=[];
  const ctx={
    canvas:{width:1920,height:1080},
    drawImage:(src,...args)=>events.push(["image",src,...args]),
    fillRect:(...args)=>events.push(["rect",...args]),
  };
  const map={width:1920,height:1080};
  const routes={width:1920,height:1080,hidden:false};
  const overlay={width:1920,height:1080,hidden:false};
  draw(ctx,map,50,0,100,()=>"",()=>"",null,routes,overlay);
  assert.deepEqual(events.slice(0,3).map(e=>e[1]),[map,routes,overlay]);
  assert.ok(events.every(e=>e[0]!=="image"||e[2]===0),
    "all layers start at left edge (no sidebars)");
  assert.deepEqual(events.slice(-2).map(e=>e.slice(1)),[[0,1075,1920,5],[0,1075,960,5]]);
  assert.throws(()=>draw(ctx,{width:1920,height:1200},50,0,100,()=>"",()=>"",null,routes,overlay),/16:9/);
});
