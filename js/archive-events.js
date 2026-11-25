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

  let timeline,options,canvas,records=[],editing=null,busy=false,loaded=false,raf=0,lastDrawKey="";
  const byId=id=>document.getElementById(id);
  function notice(s){byId("archiveEventStatus").textContent=s;}
  function setRecords(rows){
    records=normalizeList(rows);
    timeline.setRows(historical(records));
    lastDrawKey="";
    refreshList();
  }
  function refreshList(){
    const list=byId("archiveEventList");
    list.replaceChildren();
    for(const r of historical(records).slice().reverse()){
      const li=document.createElement("div");li.className="archive-event-row";
      const label=document.createElement("span");label.textContent=r.name+" · "+zoneParts(Date.parse(r.datetime),"Europe/Kyiv").replace("T"," ");
      const edit=document.createElement("button");edit.type="button";edit.textContent="EDIT";edit.disabled=busy;
      edit.onclick=()=>{editing=r;byId("archiveEventName").value=r.name;byId("archiveEventCoordinates").value=r.lat+", "+r.lon;
        byId("archiveEventZone").value="Europe/Kyiv";byId("archiveEventTime").value=zoneParts(Date.parse(r.datetime),"Europe/Kyiv");
        byId("archiveEventSave").textContent="SAVE EDIT";notice("正在编辑 · "+r.name);};
      const del=document.createElement("button");del.type="button";del.textContent="DELETE";del.disabled=busy;
      del.onclick=()=>{if(confirm("删除这条历史归档记录？"))mutate({kind:"delete",before:r});};
      li.append(label,edit,del);list.append(li);
    }
    byId("archiveEventCount").textContent=String(historical(records).length);
  }
  function clearForm(){
    editing=null;byId("archiveEventForm").reset();byId("archiveEventSave").textContent="ADD EVENT";
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
    finally{busy=false;byId("archiveEventSave").disabled=false;refreshList();}
  }
  async function load(){
    if(busy)return;
    loaded=false;byId("archiveEventSave").disabled=true;notice("正在读取归档…");
    try{
      const res=await fetch("data/strike-events.json",{cache:"no-store"});
      if(!res.ok)throw new Error("归档读取失败（HTTP "+res.status+"）");
      setRecords(await res.json());loaded=true;notice("归档已加载 · 手动记录 / 延迟至少 24h");
    }catch(e){notice(e.message||"归档读取失败");}
    finally{byId("archiveEventSave").disabled=!loaded;}
  }

  function paint(items,map){
    if(!map||!items.length){canvas.hidden=true;lastDrawKey="";return;}
    const container=map.getContainer(),w=container.clientWidth,h=container.clientHeight;
    if(!w||!h){canvas.hidden=true;return;}
    const dpr=Math.min(2,Math.max(1,window.devicePixelRatio||1));
    const cw=Math.round(w*dpr),ch=Math.round(h*dpr);
    const center=map.getCenter();
    const staticOnly=items.every(x=>x.static);
    const key=staticOnly?[cw,ch,center.lng,center.lat,map.getZoom(),map.getBearing(),map.getPitch(),items.map(x=>x.row.id).join(",")].join("|"):"";
    if(staticOnly&&key===lastDrawKey&&!canvas.hidden)return;
    lastDrawKey=key;
    canvas.hidden=false;
    if(canvas.width!==cw)canvas.width=cw;
    if(canvas.height!==ch)canvas.height=ch;
    const ctx=canvas.getContext("2d");if(!ctx)return;
    ctx.setTransform(dpr,0,0,dpr,0,0);ctx.clearRect(0,0,w,h);
    ctx.font="600 12px system-ui, sans-serif";ctx.textAlign="left";ctx.textBaseline="middle";
    for(const item of items){
      const {row,age}=item,p=map.project([row.lon,row.lat]),x=p.x,y=p.y;
      if(!Number.isFinite(x)||!Number.isFinite(y)||x<-70||x>w+70||y<-70||y>h+70)continue;
      const fade=item.static?1:Math.max(0,1-age/LIFE_MS);
      ctx.save();ctx.translate(x,y);
      if(item.static){
        ctx.strokeStyle="#ffcb70";ctx.lineWidth=1.7;ctx.beginPath();ctx.arc(0,0,7,0,Math.PI*2);ctx.stroke();
        ctx.fillStyle="#ffad48";ctx.beginPath();ctx.arc(0,0,3,0,Math.PI*2);ctx.fill();
      }else{
        const t=age/LIFE_MS,radius=6+34*Math.min(1,t*1.6);
        ctx.globalAlpha=fade;ctx.strokeStyle="#ffad48";ctx.lineWidth=2;ctx.beginPath();ctx.arc(0,0,radius,0,Math.PI*2);ctx.stroke();
        const glow=ctx.createRadialGradient(0,0,0,0,0,Math.max(8,18*(1-t)));
        glow.addColorStop(0,"#fff3bd");glow.addColorStop(.3,"#ffae49");glow.addColorStop(1,"rgba(255,95,30,0)");
        ctx.fillStyle=glow;ctx.beginPath();ctx.arc(0,0,Math.max(8,18*(1-t)),0,Math.PI*2);ctx.fill();
      }
      ctx.globalAlpha=fade;ctx.strokeStyle="rgba(3,8,13,.95)";ctx.lineWidth=3.5;ctx.lineJoin="round";
      ctx.strokeText(row.name,12,-11);ctx.fillStyle="#ffe4a8";ctx.fillText(row.name,12,-11);ctx.restore();
    }
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
    byId("archiveEventForm").addEventListener("submit",e=>{
      e.preventDefault();
      try{
        const name=byId("archiveEventName").value.trim();
        if(!name||name.length>120)throw new Error("请输入名称（最多 120 字符）");
        const coords=parseCoordinates(byId("archiveEventCoordinates").value);
        const datetime=parseZoned(byId("archiveEventTime").value,byId("archiveEventZone").value);
        if(Date.parse(datetime)>Date.now()-DELAY_MS)throw new Error("仅支持距当前至少 24 小时的历史记录");
        const id=editing?editing.id:(globalThis.crypto?.randomUUID?.()||"event-"+Date.now()+"-"+Math.random().toString(36).slice(2));
        const row=normalize({id,name,...coords,datetime});
        mutate(editing?{kind:"edit",before:editing,row}:{kind:"add",row});
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
  const api={init,sync,begin,seek,Timeline,parseCoordinates,parseZoned,zoneParts,normalizeList,historical,LIFE_MS,DELAY_MS};
  if(typeof module!=="undefined"&&module.exports)module.exports=api;
  if(root)root.DeepstrikeArchiveEvents=api;
})(typeof window!=="undefined"?window:null);
