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
  function glow(ctx,x,y,r,stops){
    if(r<=0)return;
    const g=ctx.createRadialGradient(x,y,0,x,y,r);
    for(const [at,color] of stops)g.addColorStop(at,color);
    circle(ctx,x,y,r,g);
  }
  function seeded(id){
    let n=2166136261;
    for(const c of String(id)){n=Math.imul(n^c.charCodeAt(0),16777619);}
    return ()=>{n=(Math.imul(n,1664525)+1013904223)|0;return(n>>>0)/4294967296;};
  }
  function animationState(age){
    const t=clamp(age/1000,0,LIFE_MS/1000);
    return {t,flash:Math.max(0,1-t/.22),fire:Math.min(1,t/.10)*Math.max(0,1-t/1.45),
      smoke:Math.min(1,t/.48)*Math.max(0,1-t/4.4),label:Math.min(1,Math.max(0,(LIFE_MS-age)/850))};
  }
  function drawBurst(ctx,item,x,y){
    ctx.save();ctx.translate(x,y);
    if(item.static){
      ctx.fillStyle="#ffb24b";ctx.strokeStyle="#fff1c8";ctx.lineWidth=1;
      ctx.beginPath();
      for(let i=0;i<16;i++){const a=-Math.PI/2+i*Math.PI/8,r=i%2?3.5:8;
        if(i===0)ctx.moveTo(Math.cos(a)*r,Math.sin(a)*r);else ctx.lineTo(Math.cos(a)*r,Math.sin(a)*r);}
      ctx.closePath();ctx.fill();ctx.stroke();circle(ctx,0,0,2.4,"#fff9e6");
      ctx.restore();return;
    }
    const {t,flash,fire,smoke}=animationState(item.age);
    const random=seeded(item.row.id);
    if(smoke>0){
      for(let i=0;i<10;i++){
        const a=random()*Math.PI*2,speed=3+random()*8,sz=5+random()*6;
        const px=Math.cos(a)*speed*t,py=Math.sin(a)*speed*t-t*3;
        const r=sz+4*t;
        glow(ctx,px,py,r,[[0,"rgba(76,70,65,"+(.38*smoke)+")"],[.62,"rgba(48,46,44,"+(.28*smoke)+")"],[1,"rgba(40,38,37,0)"]]);
      }
    }
    if(t<1){
      ctx.globalAlpha=(1-t)*.75;ctx.strokeStyle="#ffe4a1";ctx.lineWidth=1.4;
      ctx.beginPath();ctx.arc(0,0,5+46*t,0,Math.PI*2);ctx.stroke();ctx.globalAlpha=1;
    }
    if(fire>0){
      const spread=5+16*Math.min(1,t/.65);
      for(let i=0;i<12;i++){
        const a=random()*Math.PI*2,d=random()*spread,r=5+random()*8+spread*.25;
        glow(ctx,Math.cos(a)*d,Math.sin(a)*d,r,[[0,"rgba(255,248,181,"+fire+")"],[.25,"rgba(255,187,56,"+fire+")"],[.65,"rgba(243,77,12,"+(.8*fire)+")"],[1,"rgba(150,24,4,0)"]]);
      }
      glow(ctx,0,0,12+spread*.35,[[0,"rgba(255,255,230,"+fire+")"],[.4,"rgba(255,191,52,"+fire+")"],[1,"rgba(255,82,4,0)"]]);
    }
    if(t<1.8){
      const sparkAlpha=Math.max(0,1-t/1.8);
      ctx.lineWidth=1.2;ctx.lineCap="round";
      for(let i=0;i<15;i++){
        const a=random()*Math.PI*2,v=13+random()*30,d=v*Math.min(t,1.4);
        ctx.strokeStyle="rgba(255,192,82,"+sparkAlpha+")";
        ctx.beginPath();ctx.moveTo(Math.cos(a)*d,Math.sin(a)*d);ctx.lineTo(Math.cos(a)*(d+3),Math.sin(a)*(d+3));ctx.stroke();
      }
    }
    if(flash>0)glow(ctx,0,0,24+10*flash,[[0,"rgba(255,255,255,"+flash+")"],[.32,"rgba(255,241,171,"+flash+")"],[1,"rgba(255,150,45,0)"]]);
    if(t>=1.25){const a=animationState(item.age).label;circle(ctx,0,0,2.5,"rgba(255,194,105,"+a+")");}
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
    ctx.font="600 13px system-ui, sans-serif";ctx.textAlign="left";ctx.textBaseline="middle";
    const points=[];
    for(const item of items){
      const p=map.project([item.row.lon,item.row.lat]),x=p.x,y=p.y;
      if(!Number.isFinite(x)||!Number.isFinite(y)||x<-70||x>w+70||y<-70||y>h+70)continue;
      const lines=wrapLabel(ctx,item.row.name,Math.min(220,Math.max(65,w-20)));
      const width=Math.max(...lines.map(l=>ctx.measureText(l).width))+12;
      points.push({item,x,y,lines,w:width,h:lines.length*16+6});
      drawBurst(ctx,item,x,y);
    }
    const boxes=layoutLabels(points,w,h);
    // Render the leaders after all fire/smoke, and the labels last.
    points.forEach((p,i)=>{
      const b=boxes[i],a=p.item.static?1:animationState(p.item.age).label;
      const endX=b.x+b.w/2>=p.x?b.x:b.x+b.w,endY=b.y+b.h/2;
      ctx.save();ctx.globalAlpha=a;ctx.lineWidth=1.1;ctx.strokeStyle="#fff";
      ctx.beginPath();ctx.moveTo(p.x,p.y);
      const elbow=endX+(endX>p.x?-8:8);
      ctx.lineTo(elbow,endY);ctx.lineTo(endX,endY);ctx.stroke();ctx.restore();
    });
    points.forEach((p,i)=>{
      const b=boxes[i],a=p.item.static?1:animationState(p.item.age).label;
      ctx.save();ctx.globalAlpha=a;
      ctx.fillStyle="rgba(4,10,15,.78)";ctx.fillRect(b.x,b.y,b.w,b.h);
      ctx.fillStyle="#fff";p.lines.forEach((l,j)=>ctx.fillText(l,b.x+6,b.y+11+j*16));ctx.restore();
    });
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
  const api={init,sync,begin,seek,Timeline,parseCoordinates,parseZoned,zoneParts,normalizeList,historical,displayRows,layoutLabels,animationState,LIFE_MS,DELAY_MS};
  if(typeof module!=="undefined"&&module.exports)module.exports=api;
  if(root)root.DeepstrikeArchiveEvents=api;
})(typeof window!=="undefined"?window:null);
