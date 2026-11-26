const test=require("node:test");
const assert=require("node:assert/strict");
const {Timeline,parseCoordinates,parseZoned,normalizeList,historical,displayRows,localDisplayRows,mergeDrafts,dateFilter,layoutLabels,StableLabels,animationState,leaderGeometry,drawLabel,drawLeader,drawBurst,drawMarkerBacking,LIFE_MS,DELAY_MS}=require("../js/archive-events.js");
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

test("public archive shows only eligible published rows, and migration retains drafts",()=>{
  const now=DELAY_MS+1000;
  const result=displayRows([row("old",0),row("recent-public",now-1)],now);
  assert.deepEqual(result.map(r=>r.id),["old"]);
  assert.deepEqual(mergeDrafts([row("a",1)],[row("a",2),row("b",3)]).map(r=>r.id),["a","b"]);
  assert.equal(mergeDrafts([row("a",1)],[row("a",2)])[0].datetime,row("a",2).datetime);
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
  assert.ok(ops.filter(op=>op[0]==="arc").every(op=>op[1]<=23));
});

test("annotation backplate covers the city dot before the foreground symbol and fades at end",()=>{
  const ops=[];
  const ctx={save(){},restore(){},translate(){},beginPath(){},closePath(){},moveTo(){},lineTo(){},
    arc(x,y,r){ops.push(["arc",r])},
    fill(){ops.push(["fill",this.fillStyle,this.globalAlpha])},
    stroke(){ops.push(["stroke",this.strokeStyle])}};
  const item={static:false,age:900};
  drawMarkerBacking(ctx,item,0,0);drawBurst(ctx,item,0,0);
  assert.deepEqual(ops[0],["arc",14]);assert.equal(ops[1][1],"#091219");
  assert.ok(ops[1][2]>.9);
  assert.ok(ops.some(o=>o[0]==="stroke"&&o[1]==="#ffc15a"));
  assert.equal(animationState(LIFE_MS).backing,0);
  ops.length=0;drawMarkerBacking(ctx,{static:false,age:LIFE_MS},0,0);
  assert.equal(ops.length,0);
});

test("date filters are inclusive Kyiv calendar dates and handle UTC day changes",()=>{
  const rows=[row("a",Date.parse("2025-01-01T21:59:00Z")),row("b",Date.parse("2025-01-01T22:00:00Z")),row("c",Date.parse("2025-01-02T22:00:00Z"))];
  assert.deepEqual(dateFilter(rows,"2025-01-02","2025-01-02").map(r=>r.id),["b"]);
  assert.equal(dateFilter(rows,"","").length,3);
});
test("scrubber shows events inside representable slider tick in both directions and does not expire",()=>{
  const t=new Timeline();t.setRows([row("a",1000000),row("b",2500000)]);
  const frame=ms=>f(ms,"realtime",false,0,100000000);
  t.seek(frame(1020000),true);
  assert.deepEqual(t.frame(frame(1020000),1).map(x=>x.row.id),["a"]);
  assert.equal(t.frame(frame(1020000),9999999).length,1);
  t.seek(frame(2500000),true);assert.deepEqual(t.frame(frame(2500000),2).map(x=>x.row.id),["b"]);
  t.seek(frame(1000000),true);assert.deepEqual(t.frame(frame(1000000),3).map(x=>x.row.id),["a"]);
  t.begin({...frame(1000000),running:true});
  const played=t.frame({...frame(1000000),running:true},4);
  assert.equal(played.length,1);assert.equal(played[0].static,false);
});
test("label offsets remain stable throughout a moving camera gesture",()=>{
  const layout=new StableLabels(),pts=(x,y)=>[{x,y,w:100,h:24,item:{row:{id:"a"}}}];
  const a=layout.frame(pts(200,130),500,300,"a",false,0)[0];
  const b=layout.frame(pts(201,131),500,300,"b",true,20)[0];
  const c=layout.frame(pts(410,230),500,300,"c",true,40)[0];
  assert.equal(b.x-201,a.x-200);assert.equal(b.y-131,a.y-130);
  assert.equal(c.x-410,a.x-200);assert.equal(c.y-230,a.y-130);
  const d=layout.frame(pts(410,230),500,300,"c",false,60)[0];
  assert.equal(d.x,c.x);assert.equal(d.y,c.y);
  const e=layout.frame(pts(410,230),500,300,"c",false,240)[0];
  assert.ok(e.x>=0&&e.x+100<=500&&e.y>=0&&e.y+24<=300);
});

test("local pending records appear in playback but do not enter public display",()=>{
  const now=DELAY_MS+1000;
  const published=[row("old",0),row("recent-public",now-1)];
  const drafts=[row("local",now-1),row("old",1)];
  const local=localDisplayRows(published,drafts,now);
  assert.deepEqual(local.map(r=>r.id),["old","local"]);
  assert.equal(local[0].datetime,row("old",0).datetime);
  assert.deepEqual(displayRows(published,now).map(r=>r.id),["old"]);
  const timeline=new Timeline();
  timeline.setRows(local);
  assert.deepEqual(timeline.frame(f(0,"cumulative",false,0,now),0).map(x=>x.row.id),["old","local"]);
  assert.deepEqual(localDisplayRows(published,[],now).map(r=>r.id),["old"]);
  assert.equal(historical([row("twelve",now-12*3600000)],now).length,0);
});
