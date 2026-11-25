const test=require("node:test");
const assert=require("node:assert/strict");
const {Timeline,parseCoordinates,parseZoned,normalizeList,historical,displayRows,layoutLabels,animationState,LIFE_MS,DELAY_MS}=require("../js/archive-events.js");
const row=(id,ms)=>({id,name:"Historical record "+id,lat:0,lon:0,datetime:new Date(ms).toISOString()});
const f=(ms,mode="realtime",running=true,start=0,end=100000000)=>({ms,mode,running,start,end});
test("validates coordinates and exact UTC conversions",()=>{
  assert.deepEqual(parseCoordinates("0.125, -1.5"),{lat:.125,lon:-1.5});
  assert.throws(()=>parseCoordinates("91, 0"));
  assert.throws(()=>parseCoordinates("0, 181"));
  assert.equal(parseZoned("2025-01-01T12:00","Europe/Kyiv"),"2025-01-01T10:00:00.000Z");
  assert.equal(parseZoned("2025-07-01T12:00","Europe/Kyiv"),"2025-07-01T09:00:00.000Z");
  assert.throws(()=>parseZoned("2025-10-26T03:30","Europe/Kyiv"));
});
test("no quantity cap; all crossed events trigger; wall time controls expiration",()=>{
  const t=new Timeline();t.setRows(Array.from({length:20},(_,i)=>row(String(i),i*1000)));
  t.begin(f(0),true);
  assert.equal(t.frame(f(20000),100).length,20);
  assert.equal(t.frame(f(90000000),100+LIFE_MS-1).length,20);
  assert.equal(t.frame(f(90000000),100+LIFE_MS).length,0);
});
test("yellow mode includes complete selected range regardless of cursor",()=>{
  const t=new Timeline();t.setRows([row("a",1000),row("b",2000),row("c",3000)]);
  assert.deepEqual(t.frame(f(1000,"cumulative",false,1000,2000),0).map(x=>x.row.id),["a","b"]);
  assert.equal(t.frame(f(1000,"cumulative",false,1000,2000),100000).length,2);
});
test("seek does not trigger skipped records; replay triggers again; paused markers fade",()=>{
  const t=new Timeline();t.setRows([row("a",1000)]);
  t.begin(f(0),true);assert.equal(t.frame(f(1000),1).length,1);
  assert.equal(t.frame(f(1000,"realtime",false),1+LIFE_MS).length,0);
  t.seek(f(5000,"realtime",false));assert.equal(t.frame(f(5000,"realtime",false),2).length,0);
  t.begin(f(0),true);assert.equal(t.frame(f(1000),3).length,1);
});
test("delayed records only and duplicate ids rejected",()=>{
  assert.equal(historical([row("a",0),row("b",1)],DELAY_MS).length,1);
  assert.throws(()=>normalizeList([row("a",0),row("a",1)]));
});

test("local preview can be rendered immediately without relaxing public archive delay",()=>{
  const now=DELAY_MS+1000;
  const result=displayRows([row("old",0),row("recent-public",now-1)],[row("local",now-1)],now);
  assert.deepEqual(result.map(r=>r.id),["old","local"]);
});
test("labels use separate screen positions for coincident points and stay in view",()=>{
  const points=Array.from({length:6},()=>({x:200,y:130,w:100,h:24}));
  const boxes=layoutLabels(points,500,300);
  assert.equal(boxes.length,points.length);
  assert.equal(new Set(boxes.map(b=>b.x+":"+b.y)).size,boxes.length);
  for(const b of boxes)assert.ok(b.x>=0&&b.y>=0&&b.x+b.w<=500&&b.y+b.h<=300);
});
test("burst evolves from white flash to fire and smoke and ends at fixed wall time",()=>{
  assert.equal(animationState(0).flash,1);
  assert.ok(animationState(150).fire>0);
  assert.equal(animationState(600).flash,0);
  assert.ok(animationState(1800).smoke>0);
  assert.equal(animationState(LIFE_MS).label,0);
});
