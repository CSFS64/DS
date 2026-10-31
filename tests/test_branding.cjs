/* Run: node --test tests/test_branding.cjs
 * Source / canvas regression checks for branded full-screen and video output.
 */
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const html = fs.readFileSync(path.join(__dirname, "../index.html"), "utf8");
const css = fs.readFileSync(path.join(__dirname, "../css/styles.css"), "utf8");
const app = fs.readFileSync(path.join(__dirname, "../js/app.js"), "utf8");
const video = fs.readFileSync(path.join(__dirname, "../js/video-export.js"), "utf8");
const presentation = fs.readFileSync(path.join(__dirname, "../js/presentation-hud.js"), "utf8");

function section(source, first, last) {
  const a = source.indexOf(first), b = source.indexOf(last, a + first.length);
  assert.ok(a >= 0 && b > a, "section not found " + first);
  return source.slice(a, b);
}

test("288 min/s choice and uploaded logo appear in clean and regular views", () => {
  assert.match(html, /<option value="288">288 min\/s<\/option>/);
  assert.match(html, /class="brand-corner-logo" src="assets\/kalyna-osint-logo\.avif"/);
  assert.match(html, /class="brand-watermark" src="assets\/kalyna-osint-logo\.avif"/);
  assert.match(html, /Deep Strike Activity Map/);
  assert.match(html, /id="brandKyivTime"/);
  assert.match(html, /id="brandBeijingTime"/);
  assert.match(css, /\.map-branding \{ display: block; \}/);
  assert.match(css, /body\.clean-map-view \.brand-meta \{ display: block; \}/);
  assert.match(css, /background: #ff7ece;/, "pink ribbon matches reference");
  assert.match(css, /color: #161019;/, "dark text retains contrast on pink");
  assert.match(css, /\.brand-watermark \{[\s\S]*?opacity: \.065;/);
  assert.match(css, /body\.clean-map-view \.brand-watermark[\s\S]*?opacity: \.065;/);
});

test("visible Kyiv and Beijing clocks follow the archived playback instant", () => {
  const code = section(app, "function renderClocks(", "function renderScrubber(");
  const state = {currentMs: 123000, viewMode: "realtime"};
  const els = {
    clockMoscow: {textContent:""}, clockKyiv:{textContent:""},
    clockBeijing:{textContent:""}, brandKyivTime:{textContent:""},
    brandBeijingTime:{textContent:""}, currentTimeLabel:{textContent:""},
  };
  const fmt = (ms,tz) => tz + "@" + ms;
  const renderClocks = new Function("state","els","formatTime","threatClass",
    code + "return renderClocks;"
  )(state, els, fmt, () => "uav");
  renderClocks([], []);
  assert.equal(els.brandKyivTime.textContent, "Europe/Kyiv@123000");
  assert.equal(els.brandBeijingTime.textContent, "Asia/Shanghai@123000");
  state.currentMs = 345000;
  renderClocks([],[]);
  assert.equal(els.brandKyivTime.textContent, "Europe/Kyiv@345000");
  assert.equal(els.clockBeijing.textContent,els.brandBeijingTime.textContent);
});

test("a single HUD paints the historical clocks and scale in both fullscreen and video", () => {
  assert.match(video, /ctx\.drawImage\(presentationOverlay, 0, 0, w, h\)/);
  assert.match(presentation, /const TITLE = "Deep Strike Activity Map"/);
  assert.match(presentation, /const PINK = "#ff7ece"/);
  assert.match(app, /formatKyiv: ms => formatTime\(ms, "Europe\/Kyiv"\)/);
  assert.match(app, /formatBeijing: ms => formatTime\(ms, "Asia\/Shanghai"\)/);
  assert.match(app, /await window\.DeepstrikePresentation\.preloadLogo\(\)/);
  const mod = { exports: {} };
  new Function("module", presentation)(mod);
  const hud = mod.exports;
  const calls = [];
  const ctx = {
    fillRect:(...args)=>calls.push(["rect",...args]),
    fillText:(...args)=>calls.push(["text",...args]),
    drawImage:(...args)=>calls.push(["image",...args]),
    measureText:(text)=>({width:text.length*21}),
    beginPath:()=>calls.push(["begin"]),
    moveTo:()=>calls.push(["move"]),
    lineTo:()=>calls.push(["line"]),
    stroke:()=>calls.push(["stroke"]),
    save:()=>{}, restore:()=>{},
  };
  const map={unproject:([x,y])=>({lng:x/100,lat:y/100})};
  const ms=123000;
  hud.drawHud(ctx,1920,1080,{
    map,ms,start:0,end:345000,
    formatKyiv:t=>"Europe/Kyiv@"+t,
    formatBeijing:t=>"Asia/Shanghai@"+t,
  });
  const texts=calls.filter(a=>a[0]==="text").map(a=>a[1]);
  assert.ok(texts.includes("Deep Strike Activity Map"));
  assert.ok(texts.includes("Kyiv time: Europe/Kyiv@123000"));
  assert.ok(texts.includes("Beijing time: Asia/Shanghai@123000"));
  assert.ok(texts.some(t=>/\bkm\b|\bm\b/.test(t)),"dynamic ground scale is drawn");
  assert.ok(!texts.some(t=>/Public-source historical alerts/i.test(t)),
    "obsolete banner is removed");
});

test("the static cumulative-route selection is not changed by branding", () => {
  assert.match(app, /function staticRouteWindow\(\)/);
  assert.match(app, /state\.viewMode !== "cumulative"/);
  assert.doesNotMatch(app, /\.slice\(0, 140\)/);
  assert.doesNotMatch(app, /function routeWavePeriods|function buildIllustrativeMissileRoutes/);
});
