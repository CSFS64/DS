/* User-entered, delayed historical event annotations. No live feeds.
 * A simulated clock controls triggering; a monotonic clock controls fading.
 */
(function (root) {
  "use strict";
  const LIFE_MS = 5000;
  const DELAY_MS = 24 * 60 * 60 * 1000;
  const API = "https://api.github.com/repos/CSFS64/DS/contents/data/strike-events.json";
  const ZONES = ["Europe/Kyiv","Europe/Moscow","Asia/Shanghai","UTC"];

  function parseCoordinates(value) {
    const m = String(value).trim().match(/^([+-]?(?:\d+(?:\.\d*)?|\.\d+))\s*,\s*([+-]?(?:\d+(?:\.\d*)?|\.\d+))$/);
    if (!m) throw new Error("坐标格式为 纬度, 经度");
    const lat = Number(m[1]), lon = Number(m[2]);
    if (!Number.isFinite(lat) || !Number.isFinite(lon) || Math.abs(lat)>90 || Math.abs(lon)>180)
      throw new Error("坐标超出有效范围");
    return {lat,lon};
  }
  function zoneParts(ms, zone) {
    const parts = new Intl.DateTimeFormat("en-CA", {timeZone:zone, year:"numeric",month:"2-digit",day:"2-digit",
      hour:"2-digit",minute:"2-digit",second:"2-digit",hourCycle:"h23"}).formatToParts(ms);
    const p = Object.fromEntries(parts.map(x=>[x.type,x.value]));
    return p.year+"-"+p.month+"-"+p.day+"T"+p.hour+":"+p.minute+":"+p.second;
  }
  function parseZoned(value, zone) {
    if (!ZONES.includes(zone) || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2})?$/.test(value)) throw new Error("请输入有效日期时间");
    const wanted = value.length===16 ? value+":00" : value;
    const naive = Date.parse(wanted+"Z");
    if (!Number.isFinite(naive)) throw new Error("日期时间无效");
    // Resolve wall time by matching exact local components, not the browser's
    // local time zone. Ambiguous/nonexistent DST times require UTC entry.
    const candidates = [];
    for (let h=-14*60; h<=14*60; h+=15) {
      const ms = naive+h*60000;
      if (zoneParts(ms,zone)===wanted) candidates.push(ms);
    }
    if (candidates.length!==1) throw new Error("该本地时间不存在或存在夏令时歧义，请改用 UTC");
    return new Date(candidates[0]).toISOString();
  }
  function normalize(row) {
    if (!row || typeof row.id!=="string" || !row.id || row.id.length>100 ||
        typeof row.name!=="string" || !row.name.trim() || row.name.length>120 ||
        typeof row.lat!=="number" || typeof row.lon!=="number" ||
        !Number.isFinite(row.lat) || !Number.isFinite(row.lon) ||
        Math.abs(row.lat)>90 || Math.abs(row.lon)>180 ||
        typeof row.datetime!=="string" || !/Z$/.test(row.datetime) || !Number.isFinite(Date.parse(row.datetime))) {
      throw new Error("归档文件含有无效记录");
    }
    return {id:row.id,name:row.name.trim(),lat:row.lat,lon:row.lon,datetime:new Date(row.datetime).toISOString()};
  }
  function normalizeList(rows) {
    if (!Array.isArray(rows)) throw new Error("归档文件必须是 JSON 数组");
    const result=rows.map(normalize);
    if (new Set(result.map(r=>r.id)).size!==result.length) throw new Error("归档文件存在重复 ID");
    return result.sort((a,b)=>Date.parse(a.datetime)-Date.parse(b.datetime)||a.id.localeCompare(b.id));
  }
  function historical(rows, now=Date.now()) {
    return rows.filter(r=>Date.parse(r.datetime)<=now-DELAY_MS);
  }
  // Local editorial previews are not committed to the public archive.
  function displayRows(published, previews, now=Date.now()) {
    return normalizeList([...historical(published,now),...previews]);
  }
  function lowerBound(rows, time) {
    let lo=0,hi=rows.length;
    while(lo<hi){const mid=(lo+hi)>>1;if(rows[mid].ms<time)lo=mid+1;else hi=mid;}
    return lo;
  }
  class Timeline {
    constructor(){this.rows=[];this.active=[];this.previous=null;this.key="";}
    setRows(rows){this.rows=rows.map(r=>({...r,ms:Date.parse(r.datetime)})).sort((a,b)=>a.ms-b.ms);this.reset();}
    reset(){this.active=[];this.previous=null;this.key="";}
    context(f){const key=f.mode+":"+f.start+":"+f.end;if(key!==this.key){this.active=[];this.previous=null;this.key=key;}}
    begin(f,fresh=false){this.context(f);if(fresh||this.previous===null||this.previous!==f.ms){this.active=[];this.previous=f.ms-1;}}
    seek(f){this.context(f);this.active=[];this.previous=f.ms;}
    frame(f,now){
      this.context(f);
      if(f.mode==="cumulative"){
        const lo=lowerBound(this.rows,f.start);
        const out=[];
        for(let i=lo;i<this.rows.length&&this.rows[i].ms<=f.end;i++)out.push({row:this.rows[i],age:0,static:true});
        return out;
      }
      if(this.previous===null)this.previous=f.running?f.ms-1:f.ms;
      if(f.ms<this.previous||(!f.running&&f.ms!==this.previous)){this.active=[];this.previous=f.ms;}
      if(f.running){
        const lo=lowerBound(this.rows,Math.max(f.start,this.previous+0.0001));
        for(let i=lo;i<this.rows.length;i++){
          const row=this.rows[i];if(row.ms>f.ms||row.ms>f.end)break;
          if(row.ms>this.previous)this.active.push({row,born:now});
        }
        this.previous=f.ms;
      }
      this.active=this.active.filter(x=>now-x.born<LIFE_MS);
      return this.active.map(x=>({row:x.row,age:Math.max(0,now-x.born),static:false}));
    }
  }

  function base64Encode(s){
    const b=new TextEncoder().encode(s);let binary="";
    for(let i=0;i<b.length;i+=8192)binary+=String.fromCharCode(...b.subarray(i,i+8192));
    return btoa(binary);
  }
  function base64Decode(s){return new TextDecoder().decode(Uint8Array.from(atob(s.replace(/\s/g,"")),c=>c.charCodeAt(0)));}
  async function github(token,method,body){
    const res=await fetch(API+(method==="GET"?"?ref=main":""),{method,cache:"no-store",credentials:"omit",redirect:"error",
      headers:{Authorization:"Bearer "+token,Accept:"application/vnd.github+json","Content-Type":"application/json","X-GitHub-Api-Version":"2022-11-28"},
      ...(body?{body:JSON.stringify(body)}:{})});
    if(!res.ok){
      if(res.status===409||res.status===422)throw new Error("GitHub 文件版本已变化或写入被拒绝，请刷新后重试");
      if(res.status===401||res.status===403||res.status===404)throw new Error("GitHub 权限不足，请检查令牌、仓库权限和有效期（HTTP "+res.status+"）");
      throw new Error("GitHub 请求失败（HTTP "+res.status+"）");
    }
    return res.json();
  }
  async function saveRemote(token,operation){
    const remote=await github(token,"GET");
    if(remote.encoding!=="base64"||typeof remote.content!=="string"||!remote.sha)throw new Error("无法读取 GitHub 归档文件");
    const rows=normalizeList(JSON.parse(base64Decode(remote.content)));
    let next;
    if(operation.kind==="add"){
      if(rows.some(r=>r.id===operation.row.id))throw new Error("记录已存在，请刷新");
      next=[...rows,operation.row];
    }else{
      const current=rows.find(r=>r.id===operation.before.id);
      if(!current||JSON.stringify(current)!==JSON.stringify(operation.before))throw new Error("这条记录已被其他操作修改，请刷新后再编辑");
      next=operation.kind==="delete"?rows.filter(r=>r.id!==current.id):rows.map(r=>r.id===current.id?operation.row:r);
    }
    next=normalizeList(next);
    const result=await github(token,"PUT",{message:"data: update historical event archive",branch:"main",sha:remote.sha,
      content:base64Encode(JSON.stringify(next,null,2)+"\n")});
    return {rows:next,commit:result.commit?.sha||""};
  }

  const PREVIEW_KEY="ds.archive.editorial-preview.v1";
  let timeline,options,canvas,records=[],previews=[],editing=null,busy=false,loaded=false,raf=0,lastDrawKey="";
  function readPreviews(){
    try{return normalizeList(JSON.parse(sessionStorage.getItem(PREVIEW_KEY)||"[]"));}
    catch(_){return [];}
  }
  function savePreviews(rows){
    previews=normalizeList(rows);
    try{sessionStorage.setItem(PREVIEW_KEY,JSON.stringify(previews));}catch(_){}
    refreshTimeline();
  }
  function refreshTimeline(){
    timeline.setRows(displayRows(records,previews));
    lastDrawKey="";
    refreshList();
  }
  function isPreview(row){return previews.some(r=>r.id===row.id);}
  function updateMode(){
    const local=byId("archiveEventMode").value==="preview";
    byId("archiveEventSave").disabled=busy||(!local&&!loaded);
    byId("archiveEventSave").textContent=editing?"SAVE EDIT":local?"ADD LOCAL PREVIEW":"ADD EVENT";
  }
  const byId=id=>document.getElementById(id);
  function notice(s){byId("archiveEventStatus").textContent=s;}
  function setRecords(rows){
    records=normalizeList(rows);
    refreshTimeline();
  }
  function refreshList(){
    const list=byId("archiveEventList");
    list.replaceChildren();
    for(const r of displayRows(records,previews).slice().reverse()){
      const li=document.createElement("div");li.className="archive-event-row";
      const local=isPreview(r);
      const label=document.createElement("span");label.textContent=(local?"[LOCAL] ":"")+r.name+" · "+zoneParts(Date.parse(r.datetime),"Europe/Kyiv").replace("T"," ");
      const edit=document.createElement("button");edit.type="button";edit.textContent="EDIT";edit.disabled=busy;
      edit.onclick=()=>{editing=r;byId("archiveEventName").value=r.name;byId("archiveEventCoordinates").value=r.lat+", "+r.lon;
        byId("archiveEventZone").value="Europe/Kyiv";byId("archiveEventTime").value=zoneParts(Date.parse(r.datetime),"Europe/Kyiv");
        byId("archiveEventMode").value=local?"preview":"archive";byId("archiveEventMode").disabled=true;
        updateMode();notice("正在编辑 · "+r.name);};
      const del=document.createElement("button");del.type="button";del.textContent="DELETE";del.disabled=busy;
      del.onclick=()=>{if(confirm("删除这条记录？")){
        if(local){savePreviews(previews.filter(x=>x.id!==r.id));if(editing?.id===r.id)clearForm();notice("本地记录已删除");}
        else mutate({kind:"delete",before:r});
      }};
      li.append(label,edit,del);list.append(li);
    }
    byId("archiveEventCount").textContent=String(historical(records).length)+(previews.length?" + "+previews.length+" LOCAL":"");
  }
  function clearForm(){
    const mode=byId("archiveEventMode").value;
    editing=null;byId("archiveEventForm").reset();byId("archiveEventMode").value=mode;
    byId("archiveEventMode").disabled=false;updateMode();
    // Token is deliberately a separate field; never included in form/reset.
  }
  async function mutate(op){
    if(busy||!loaded)return;
    const token=byId("archiveEventToken").value.trim();
    if(!token){notice("请输入仅限 DS 仓库的 GitHub 写入令牌");return;}
    busy=true;byId("archiveEventSave").disabled=true;refreshList();notice("正在写入 GitHub…");
    try{
      const r=await saveRemote(token,op);
      setRecords(r.rows);clearForm();
      notice("GitHub 已保存 · "+r.commit.slice(0,7)+" · Pages 将自动发布");
    }catch(e){notice(e.message||"写入失败");}
    finally{busy=false;updateMode();refreshList();}
  }
  async function load(){
    if(busy)return;
    loaded=false;updateMode();notice("正在读取归档…");
    try{
      const res=await fetch("data/strike-events.json",{cache:"no-store"});
      if(!res.ok)throw new Error("归档读取失败（HTTP "+res.status+"）");
      setRecords(await res.json());loaded=true;notice("公开历史归档已加载 · 可独立添加本地演示");
    }catch(e){notice(e.message||"归档读取失败");}
    finally{updateMode();}
  }

  function clamp(v,a,b){return Math.min(Math.max(v,a),Math.max(a,b));}
  function overlap(a,b){
    return Math.max(0,Math.min(a.x+a.w,b.x+b.w)-Math.max(a.x,b.x))*
      Math.max(0,Math.min(a.y+a.h,b.y+b.h)-Math.max(a.y,b.y));
  }
  // Prefer nearby clear positions, then expand the leader. No labels are
  // silently discarded, including when the selected range is very crowded.
  function layoutLabels(points,w,h){
    const used=[],out=[];
    const obstacles=points.map(p=>({x:p.x-13,y:p.y-13,w:26,h:26}));
    for(const p of points){
      let best=null,score=Infinity;
      for(const distance of [0,24,48,76,112,156]){
        for(const side of [1,-1]){
          for(const vertical of [-1,1,0]){
            const dx=side*(42+distance),dy=vertical*(32+distance*.68);
            const x=clamp(p.x+dx+(side<0?-p.w:0),5,w-p.w-5);
            const y=clamp(p.y+dy-p.h/2,5,h-p.h-5);
            const box={x,y,w:p.w,h:p.h};
            let penalty=used.reduce((s,b)=>s+overlap(box,b)*25,0);
            penalty+=obstacles.reduce((s,b)=>s+overlap(box,b)*8,0);
            const cost=penalty+Math.hypot(x+p.w/2-p.x,y+p.h/2-p.y)*.12;
            if(cost<score){best=box;score=cost;}
          }
        }
        if(score<25)break;
      }
      used.push(best);out.push(best);
    }
    return out;
  }
  function wrapLabel(ctx,text,maxWidth){
    const lines=[];let line="";
    for(const ch of Array.from(text)){
      if(line&&ctx.measureText(line+ch).width>maxWidth){lines.push(line);line=ch;}
      else line+=ch;
    }
    if(line)lines.push(line);
    return lines.length?lines:[""];
  }
  function circle(ctx,x,y,r,fill){
    ctx.fillStyle=fill;ctx.beginPath();ctx.arc(x,y,Math.max(.1,r),0,Math.PI*2);ctx.fill();
  }
  function easeOut(t){t=clamp(t,0,1);return 1-Math.pow(1-t,3);}
  function smooth(t){t=clamp(t,0,1);return t*t*(3-2*t);}
  // All times are actual elapsed milliseconds, not archive playback time.
  function animationState(age){
    const t=clamp(age,0,LIFE_MS),fade=1-smooth((t-3900)/1100);
    const labelIn=smooth((t-490)/260);
    return {
      flash:1-smooth(t/160),
      expansion:easeOut(t/540),
      pulse:1-smooth(t/780),
      marker:fade,
      leader:easeOut((t-135)/410),
      leaderAlpha:fade,
      label:labelIn*fade,
      labelSlide:7*(1-easeOut((t-490)/260))
    };
  }
  function markerStroke(ctx,r,alpha,color){
    if(alpha<=0)return;
    ctx.globalAlpha=alpha;ctx.strokeStyle=color;ctx.lineWidth=1;
    ctx.beginPath();ctx.arc(0,0,r,0,Math.PI*2);ctx.stroke();
  }
  function drawBurst(ctx,item,x,y){
    const a=item.static?{flash:0,expansion:1,pulse:0,marker:1}:animationState(item.age);
    if(a.marker<=0)return;
    ctx.save();ctx.translate(x,y);
    // Small, hollow, map-scale symbols use the same amber as the archive legend.
    // No opaque fill, fireball, smoke, or large radial-gradient sprite.
    if(a.pulse>0){
      markerStroke(ctx,5+15*a.expansion,.7*a.pulse,"#ffc15a");
      markerStroke(ctx,3+9*a.expansion,.5*a.pulse,"#fff0cf");
    }
    ctx.globalAlpha=a.marker;
    ctx.strokeStyle="#ffc15a";ctx.lineWidth=1.2;
    ctx.beginPath();
    const r=6.5;
    ctx.moveTo(0,-r);ctx.lineTo(r,0);ctx.lineTo(0,r);ctx.lineTo(-r,0);ctx.closePath();
    ctx.stroke();
    // Discrete outward ticks evoke the burst without covering map content.
    ctx.globalAlpha=a.marker*(item.static?.72:.76+.24*a.pulse);
    ctx.strokeStyle="#ffc15a";ctx.lineWidth=1.1;ctx.beginPath();
    const inner=9+2*a.pulse,outer=12+4*a.pulse;
    for(let i=0;i<4;i++){
      const angle=Math.PI/4+i*Math.PI/2;
      ctx.moveTo(Math.cos(angle)*inner,Math.sin(angle)*inner);
      ctx.lineTo(Math.cos(angle)*outer,Math.sin(angle)*outer);
    }
    ctx.stroke();
    ctx.globalAlpha=a.marker;ctx.shadowColor="#ffc15a";ctx.shadowBlur=3;
    circle(ctx,0,0,2,"#ffe4ae");ctx.shadowBlur=0;
    if(a.flash>0){
      ctx.globalAlpha=a.flash*.9;
      circle(ctx,0,0,2+2*a.flash,"#fffdf2");
    }
    ctx.restore();
  }
  // Reveal a two-segment leader by physical path length, including the elbow.
  // The line begins outside the event symbol and ends at the label edge.
  function leaderGeometry(point,box,progress){
    const endX=box.x+box.w/2>=point.x?box.x:box.x+box.w;
    const endY=box.y+box.h/2;
    const side=endX>=point.x?1:-1;
    const elbow={x:endX-side*12,y:endY};
    const dx=elbow.x-point.x,dy=elbow.y-point.y;
    const initial=Math.hypot(dx,dy);
    const gap=Math.min(8,initial*.45);
    const start=initial?{x:point.x+dx*gap/initial,y:point.y+dy*gap/initial}:{x:point.x,y:point.y};
    const end={x:endX,y:endY};
    const first=Math.hypot(elbow.x-start.x,elbow.y-start.y);
    const second=Math.hypot(end.x-elbow.x,end.y-elbow.y);
    let left=(first+second)*clamp(progress,0,1);
    const path=[start];
    if(left<=0)return {path,side};
    if(first>0&&left<first){
      path.push({x:start.x+(elbow.x-start.x)*left/first,y:start.y+(elbow.y-start.y)*left/first});
      return {path,side};
    }
    path.push(elbow);left-=first;
    if(second>0&&left>0){
      const fraction=clamp(left/second,0,1);
      path.push({x:elbow.x+(end.x-elbow.x)*fraction,y:elbow.y+(end.y-elbow.y)*fraction});
    }
    return {path,side};
  }
  function drawLeader(ctx,p,b,a){
    if(a.leader<=0||a.leaderAlpha<=0)return;
    const {path}=leaderGeometry(p,b,a.leader);
    if(path.length<2)return;
    ctx.save();ctx.globalAlpha=.9*a.leaderAlpha;
    ctx.strokeStyle="#f5f7fa";ctx.lineWidth=1;
    ctx.lineCap="round";ctx.lineJoin="round";
    ctx.beginPath();ctx.moveTo(path[0].x,path[0].y);
    for(const v of path.slice(1))ctx.lineTo(v.x,v.y);
    ctx.stroke();ctx.restore();
  }
  function drawLabel(ctx,p,b,a){
    if(a.label<=0)return;
    const side=b.x+b.w/2>=p.x?1:-1;
    ctx.save();ctx.globalAlpha=a.label;
    // Only a very fine dark glyph outline for legibility, not a tooltip box.
    ctx.strokeStyle="rgba(4,10,15,.92)";ctx.lineWidth=2;
    ctx.lineJoin="round";ctx.fillStyle="#f5f7fa";
    p.lines.forEach((line,j)=>{
      const x=b.x+4+side*a.labelSlide,y=b.y+9+j*15;
      ctx.strokeText(line,x,y);ctx.fillText(line,x,y);
    });
    ctx.restore();
  }
  function paint(items,map){
    if(!map||!items.length){canvas.hidden=true;lastDrawKey="";return;}
    const container=map.getContainer(),w=container.clientWidth,h=container.clientHeight;
    if(!w||!h){canvas.hidden=true;return;}
    const dpr=Math.min(2,Math.max(1,window.devicePixelRatio||1));
    const cw=Math.round(w*dpr),ch=Math.round(h*dpr);
    const center=map.getCenter(),staticOnly=items.every(x=>x.static);
    const key=staticOnly?[cw,ch,center.lng,center.lat,map.getZoom(),map.getBearing(),map.getPitch(),items.map(x=>x.row.id).join(",")].join("|"):"";
    if(staticOnly&&key===lastDrawKey&&!canvas.hidden)return;
    lastDrawKey=key;canvas.hidden=false;
    if(canvas.width!==cw)canvas.width=cw;
    if(canvas.height!==ch)canvas.height=ch;
    const ctx=canvas.getContext("2d");if(!ctx)return;
    ctx.setTransform(dpr,0,0,dpr,0,0);ctx.clearRect(0,0,w,h);
    ctx.font="500 12px system-ui, sans-serif";ctx.textAlign="left";ctx.textBaseline="middle";
    const points=[];
    for(const item of items){
      const p=map.project([item.row.lon,item.row.lat]),x=p.x,y=p.y;
      if(!Number.isFinite(x)||!Number.isFinite(y)||x<-70||x>w+70||y<-70||y>h+70)continue;
      const lines=wrapLabel(ctx,item.row.name,Math.min(220,Math.max(65,w-20)));
      const width=Math.max(...lines.map(l=>ctx.measureText(l).width))+8;
      points.push({item,x,y,lines,w:width,h:lines.length*15+3});
      drawBurst(ctx,item,x,y);
    }
    const boxes=layoutLabels(points,w,h);
    // Paint line and glyphs separately, above the same compact symbol.
    const visualStates=points.map(p=>p.item.static?
      {leader:1,leaderAlpha:1,label:1,labelSlide:0}:animationState(p.item.age));
    points.forEach((p,i)=>drawLeader(ctx,p,boxes[i],visualStates[i]));
    points.forEach((p,i)=>drawLabel(ctx,p,boxes[i],visualStates[i]));
  }
  function sync(){
    if(!timeline||!options)return;
    const f=options.frame();
    if(!Number.isFinite(f.ms)||!Number.isFinite(f.start)||!Number.isFinite(f.end))return;
    paint(timeline.frame(f,performance.now()),options.map());
  }
  function begin(ms,fresh=false){if(timeline){timeline.begin({...options.frame(),ms},fresh);lastDrawKey="";}}
  function seek(ms){if(timeline){timeline.seek({...options.frame(),ms});lastDrawKey="";}}
  function init(config){
    if(timeline)return;
    options=config;timeline=new Timeline();canvas=byId("archiveEventCanvas");
    previews=readPreviews();refreshTimeline();
    byId("archiveEventMode").addEventListener("change",updateMode);updateMode();
    byId("archiveEventForm").addEventListener("submit",e=>{
      e.preventDefault();
      try{
        const name=byId("archiveEventName").value.trim();
        if(!name||name.length>120)throw new Error("请输入名称（最多 120 字符）");
        const coords=parseCoordinates(byId("archiveEventCoordinates").value);
        const datetime=parseZoned(byId("archiveEventTime").value,byId("archiveEventZone").value);
        const local=byId("archiveEventMode").value==="preview";
        if(!local&&Date.parse(datetime)>Date.now()-DELAY_MS){
          throw new Error("公开历史归档延迟 24h；请选择 LOCAL PREVIEW 立即制作演示");
        }
        const id=editing?editing.id:(globalThis.crypto?.randomUUID?.()||"event-"+Date.now()+"-"+Math.random().toString(36).slice(2));
        const row=normalize({id,name,...coords,datetime});
        if(local){
          savePreviews(editing?previews.map(r=>r.id===id?row:r):[...previews,row]);
          clearForm();
          options.includeTime?.(Date.parse(datetime));
          notice("本地演示已保存 · 可立即播放和导出 · 不上传 GitHub");
        }else mutate(editing?{kind:"edit",before:editing,row}:{kind:"add",row});
      }catch(e){notice(e.message||"输入无效");}
    });
    byId("archiveEventCancel").onclick=()=>{clearForm();notice("已取消编辑");};
    byId("archiveEventClearToken").onclick=()=>{byId("archiveEventToken").value="";notice("已清除令牌");};
    byId("archiveEventReload").onclick=load;
    window.addEventListener("pagehide",()=>{byId("archiveEventToken").value="";});
    load();
    function tick(){if(!options.frame().exporting)sync();raf=requestAnimationFrame(tick);}
    raf=requestAnimationFrame(tick);
  }
  const api={init,sync,begin,seek,Timeline,parseCoordinates,parseZoned,zoneParts,normalizeList,historical,displayRows,layoutLabels,animationState,leaderGeometry,drawLabel,drawLeader,drawBurst,LIFE_MS,DELAY_MS};
  if(typeof module!=="undefined"&&module.exports)module.exports=api;
  if(root)root.DeepstrikeArchiveEvents=api;
})(typeof window!=="undefined"?window:null);
