#!/usr/bin/env python3
from __future__ import annotations
import argparse, io, json, math, re, zipfile
from collections import defaultdict
from pathlib import Path
import requests

ROOT = Path(__file__).resolve().parents[1]
REGIONS = ROOT / 'data' / 'regions.json'
OUT = ROOT / 'data' / 'cities.json'
RU_URL = 'https://download.geonames.org/export/dump/RU.zip'
ADMIN1_URL = 'https://download.geonames.org/export/dump/admin1CodesASCII.txt'
ADMIN2_URL = 'https://download.geonames.org/export/dump/admin2Codes.txt'
UA = 'DeepstrikeArchivePlaceCatalog/3.0 (historical archive)'

STOP = {
    'republic','oblast','krai','kray','region','autonomous','okrug','district','federal','city','of','the',
    'республика','область','край','автономный','автономная','округ','город','г'
}

def norm(s: str) -> str:
    s = str(s or '').lower().replace('ё','е')
    s = re.sub(r'[^a-zа-я0-9]+',' ',s)
    return ' '.join(t for t in s.split() if t not in STOP)

def russian_forms(value: str) -> list[str]:
    value = str(value or '').strip()
    if not value or not re.search(r'[А-Яа-яЁё]', value): return []
    words=value.split(); w=words[-1]; lw=w.lower().replace('ё','е'); out=[]
    def emit(last): out.append(' '.join(words[:-1]+[last]))
    if lw.endswith('а') and len(w)>3:
        b=w[:-1]; [emit(b+x) for x in ('е','ы','у','ой')]
    elif lw.endswith('я') and len(w)>3:
        b=w[:-1]; [emit(b+x) for x in ('е','и','ю','ей')]
    elif lw.endswith('ь') and len(w)>3:
        b=w[:-1]; [emit(b+x) for x in ('и','ью')]
    elif not lw.endswith(('ово','ево','ино','ы','и')) and re.search(r'[бвгджзклмнпрстфхцчшщ]$', lw):
        [emit(w+x) for x in ('е','а','у','ом')]
    return out

def region_aliases(reg):
    vals=[reg.get('region',''),reg.get('region_label',''),*(reg.get('geo_aliases') or [])]
    return [norm(v) for v in vals if norm(v)]

def best_region(name, ascii_name, regions):
    names={norm(name),norm(ascii_name)}-{''}; best=None;score=-1
    for r in regions:
        for a in region_aliases(r):
            for n in names:
                if a==n: sc=100
                elif len(a)>=4 and (a in n or n in a): sc=min(len(a),len(n))
                else: continue
                if sc>score: best=r['region'];score=sc
    return best

def aliases_for(*vals, limit=40):
    expanded=[]
    for raw in vals:
        if isinstance(raw,list):
            expanded.extend(raw); continue
        if raw: expanded.append(raw)
    out=[];seen=set()
    for v in list(expanded):
        if v: expanded.extend(russian_forms(v))
    for v in expanded:
        v=str(v or '').strip()
        if not v or len(v)>90 or not re.search(r'[A-Za-zА-Яа-яЁё]',v): continue
        k=v.casefold()
        if k in seen: continue
        seen.add(k);out.append(v)
        if len(out)>=limit: break
    return out

def download(session,url):
    r=session.get(url,timeout=120);r.raise_for_status();return r.content

def main():
    ap=argparse.ArgumentParser();ap.add_argument('--output',default=str(OUT));ap.add_argument('--min-population',type=int,default=1000);args=ap.parse_args()
    regions=json.loads(REGIONS.read_text(encoding='utf-8'))['regions']
    s=requests.Session();s.headers['User-Agent']=UA
    admin1={}
    for line in download(s,ADMIN1_URL).decode('utf-8','replace').splitlines():
        p=line.split('\t')
        if len(p)>=3 and p[0].startswith('RU.'): admin1[p[0].split('.',1)[1]]=(p[1],p[2])
    admin2={}
    for line in download(s,ADMIN2_URL).decode('utf-8','replace').splitlines():
        p=line.split('\t')
        if len(p)>=3 and p[0].startswith('RU.'): admin2[p[0]]=(p[1],p[2])
    raw=download(s,RU_URL)
    with zipfile.ZipFile(io.BytesIO(raw)) as z:
        name=next(n for n in z.namelist() if n.upper().endswith('RU.TXT'))
        txt=z.read(name).decode('utf-8','replace')
    city_rows=[]; admin2_points=defaultdict(list); admin2_features={}; unmapped=set()
    for line in txt.splitlines():
        c=line.split('\t')
        if len(c)<19 or c[8]!='RU': continue
        try: lat=float(c[4]);lon=float(c[5]);pop=int(c[14] or 0)
        except Exception: continue
        a1=c[10].strip(); a2=c[11].strip(); arow=admin1.get(a1)
        region=best_region(arow[0],arow[1],regions) if arow else None
        if not region: unmapped.add(a1); continue
        fclass=c[6]; fcode=c[7]; name=c[1].strip(); ascii_name=c[2].strip(); alt=c[3].split(',') if c[3] else []

        # GeoNames' admin2Codes list often contains transliterated labels only
        # and many districts have no populated-place row carrying the ADM2 code.
        # Keep the actual ADM2 feature: it supplies coordinates and, crucially,
        # alternate Russian names such as "Богучарский район".
        if fclass=='A' and fcode=='ADM2' and a2:
            admin2_features[f'RU.{a1}.{a2}']={
                'id':int(c[0]), 'name':name, 'ascii_name':ascii_name, 'alt':alt,
                'lat':lat, 'lon':lon, 'region':region, 'feature_code':fcode,
            }
            continue

        if fclass!='P':
            continue
        if a2: admin2_points[f'RU.{a1}.{a2}'].append((lat,lon,max(pop,1),fcode,name,ascii_name,region))
        if pop < args.min_population and not fcode.startswith('PPLA'): continue
        city_rows.append({
            'id':int(c[0]),'name':ascii_name or name,'label':name,'region':region,'type':'city',
            'lat':lat,'lon':lon,'population':pop,'feature_code':fcode,
            'aliases':aliases_for(name,ascii_name,alt,limit=42),
        })
    city_rows.sort(key=lambda x:(x['region'],-x['population'],x['name']))
    municipalities=[]
    all_admin2_codes=sorted(set(admin2) | set(admin2_features) | set(admin2_points))
    for code in all_admin2_codes:
        native,ascii_name=admin2.get(code,('',''))
        feat=admin2_features.get(code)
        pts=admin2_points.get(code) or []

        if feat:
            lat=feat['lat']; lon=feat['lon']; region=feat['region']
            pop=max((x[2] for x in pts),default=0)
        elif pts:
            seats=[x for x in pts if x[3]=='PPLA2']
            if seats:
                lat,lon,pop,_,_,_,region=max(seats,key=lambda x:x[2])
            else:
                region=pts[0][6]; weights=[max(1,math.sqrt(x[2])) for x in pts]; sw=sum(weights)
                lat=sum(x[0]*w for x,w in zip(pts,weights))/sw
                lon=sum(x[1]*w for x,w in zip(pts,weights))/sw
                pop=max(x[2] for x in pts)
        else:
            continue

        vals=[native,ascii_name]
        if feat:
            vals.extend([feat.get('name',''),feat.get('ascii_name',''),feat.get('alt') or []])

        # Retain full administrative names plus conservative bare forms.
        # The collector generates case variants (район -> районе, adjective
        # -ский -> -ском etc.) at parse time.
        expanded=[]
        for value in vals:
            if isinstance(value,list):
                expanded.extend(value)
            elif value:
                expanded.append(value)
        for value in list(expanded):
            bare=re.sub(r'\b(?:район|округ|муниципальный|городской|муниципальное образование)\b',' ',str(value),flags=re.I)
            bare=' '.join(bare.split())
            if len(bare)>=4:
                expanded.append(bare)
        aliases=aliases_for(expanded,limit=80)
        label=(feat.get('name') if feat else None) or native or ascii_name
        canonical=(feat.get('ascii_name') if feat else None) or ascii_name or label
        municipalities.append({
            'id':code,'name':canonical,'label':label,'region':region,'type':'municipality',
            'lat':lat,'lon':lon,'population':pop,'feature_code':'ADM2','aliases':aliases
        })
    municipalities.sort(key=lambda x:(x['region'],x['label']))
    payload={'schema_version':4,'source':'GeoNames RU populated places + direct ADM2 features + admin1/admin2 codes','license':'CC BY 4.0','source_url':RU_URL,'country':'RU','count':len(city_rows),'municipality_count':len(municipalities),'cities':city_rows,'municipalities':municipalities}
    path=Path(args.output);path.parent.mkdir(parents=True,exist_ok=True);path.write_text(json.dumps(payload,ensure_ascii=False,separators=(',',':'))+'\n',encoding='utf-8')
    print(f'wrote {path}: {len(city_rows)} populated places/admin seats + {len(municipalities)} ADM2 representatives')
    if unmapped: print('unmapped admin1 codes:',sorted(unmapped)[:20])
if __name__=='__main__': main()
