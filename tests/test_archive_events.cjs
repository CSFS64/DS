const test=require("node:test");
const assert=require("node:assert/strict");
const {Timeline,parseCoordinates,parseZoned,normalizeList,historical,displayRows,layoutLabels,animationState,leaderGeometry,drawLabel,drawLeader,drawBurst,LIFE_MS,DELAY_MS}=require("../js/archive-events.js");
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
test("compact marker, progressive leader and delayed text share fixed wall-clock lifetime",()=>{
  const a0=animationState(0),a1=animationState(300),a2=animationState(620),a3=animationState(900);
  assert.equal(a0.flash,1);assert.equal(a0.leader,0);assert.equal(a0.label,0);
  assert.equal(a1.flash,0);assert.ok(a1.leader>0&&a1.leader<1);assert.equal(a1.label,0);
  assert.equal(a2.leader,1);assert.ok(a2.label>0&&a2.label<1);assert.ok(a2.labelSlide>0);
  assert.equal(a3.label,1);assert.equal(a3.labelSlide,0);
  assert.ok(animationState(4600).label<1);
  assert.equal(animationState(LIFE_MS).label,0);assert.equal(animationState(LIFE_MS).marker,0);
  assert.equal(animationState(LIFE_MS).leaderAlpha,0);
});
test("leader reveals the diagonal before its horizontal end",()=>{
  const point={x:20,y:40},box={x:110,y:5,w:70,h:20};
  const empty=leaderGeometry(point,box,0).path;
  const partial=leaderGeometry(point,box,.3).path;
  const full=leaderGeometry(point,box,1).path;
  assert.equal(empty.length,1);assert.equal(partial.length,2);assert.equal(full.length,3);
  assert.deepEqual(full.at(-1),{x:110,y:15});
  assert.ok(partial[1].x<full[1].x);
  assert.deepEqual(leaderGeometry({x:200,y:50},box,1).path.at(-1),{x:180,y:15});
});
test("renderer uses no filled label background and text appears only after leader begins",()=>{
  const ops=[];
  const ctx={save(){},restore(){},beginPath(){},stroke(){},fill(){},translate(){},
    moveTo(x,y){ops.push(["move",x,y])},lineTo(x,y){ops.push(["line",x,y])},
    closePath(){},arc(x,y,r){ops.push(["arc",r])},
    fillRect(){ops.push(["background"])},
    fillText(s){ops.push(["text",s])},strokeText(s){ops.push(["outline",s])}};
  const point={x:20,y:40,lines:["Example"]},box={x:110,y:5,w:70,h:20};
  drawLeader(ctx,point,box,animationState(0));drawLabel(ctx,point,box,animationState(0));
  assert.equal(ops.length,0);
  drawLeader(ctx,point,box,animationState(300));drawLabel(ctx,point,box,animationState(300));
  assert.ok(ops.some(op=>op[0]==="line"));assert.ok(!ops.some(op=>op[0]==="text"));
  drawBurst(ctx,{static:false,age:150},20,40);
  drawLabel(ctx,point,box,animationState(900));
  assert.ok(ops.some(op=>op[0]==="text"));assert.ok(ops.some(op=>op[0]==="outline"));
  assert.ok(!ops.some(op=>op[0]==="background"));
  assert.ok(ops.filter(op=>op[0]==="arc").every(op=>op[1]<=20));
});
