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

test("video canvas burns two changing time labels, corner logo and faint watermark into frames", () => {
  const code = section(video, 'const BRAND_TITLE =', 'function sleep(');
  const draw = new Function(code + "return drawVideoFrame;")();
  const calls = [];
  const ctx = {
    canvas:{width:1920,height:1080},
    fillRect:(...a)=>calls.push(["rect",...a]),
    drawImage:(...a)=>calls.push(["image",...a]),
    fillText:(...a)=>calls.push(["text",...a]),
    measureText:t=>({width:t.length*22}),
    save:()=>calls.push(["save"]),
    restore:()=>calls.push(["restore"]),
    set globalAlpha(x){calls.push(["alpha",x]);},
  };
  const mapCanvas={width:1920,height:1080};
  const logo={naturalWidth:220,naturalHeight:208};
  const kyiv=ms=>"10/16 "+(ms===0?"03:50":"08:38");
  const beijing=ms=>"10/16 "+(ms===0?"08:50":"13:38");
  draw(ctx,mapCanvas,0,0,28800000,kyiv,beijing,logo);
  let labels=calls.filter(a=>a[0]==="text").map(a=>a[1]);
  assert.ok(labels.includes("Deep Strike Activity Map"));
  assert.ok(labels.includes("Kyiv time: 10/16 03:50"));
  assert.ok(labels.includes("Beijing time: 10/16 08:50"));
  assert.equal(calls.filter(a=>a[0]==="image").length,3,
    "map + faint center watermark + top-right logo");
  assert.ok(calls.some(a=>a[0]==="alpha" && a[1]===.065));
  calls.length=0;
  draw(ctx,mapCanvas,28800000,0,28800000,kyiv,beijing,logo);
  labels=calls.filter(a=>a[0]==="text").map(a=>a[1]);
  assert.ok(labels.includes("Kyiv time: 10/16 08:38"));
  assert.ok(labels.includes("Beijing time: 10/16 13:38"));
  assert.match(video, /await loadBrandLogo\(brandLogoSrc\)/);
  assert.match(video, /const BRAND_PINK = "#ff7ece"/);
  assert.match(video, /ctx\.fillStyle = BRAND_PINK;/);
  assert.match(app, /formatKyiv: ms => formatTime\(ms, "Europe\/Kyiv"\)/);
  assert.match(app, /formatBeijing: ms => formatTime\(ms, "Asia\/Shanghai"\)/);
});

test("the static cumulative-route selection is not changed by branding", () => {
  assert.match(app, /function staticRouteWindow\(\)/);
  assert.match(app, /state\.viewMode !== "cumulative"/);
  assert.match(app, /\.slice\(0, 140\)/);
  assert.doesNotMatch(app, /function routeWavePeriods|function buildIllustrativeMissileRoutes/);
});
