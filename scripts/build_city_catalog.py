#!/usr/bin/env python3
from __future__ import annotations
import argparse, io, json, re, zipfile
from pathlib import Path
import requests

ROOT = Path(__file__).resolve().parents[1]
REGIONS = ROOT / 'data' / 'regions.json'
OUT = ROOT / 'data' / 'cities.json'
CITIES_URL = 'https://download.geonames.org/export/dump/cities5000.zip'
ADMIN1_URL = 'https://download.geonames.org/export/dump/admin1CodesASCII.txt'
ADMIN2_URL = 'https://download.geonames.org/export/dump/admin2Codes.txt'
UA = 'DeepstrikeArchiveCityCatalog/1.0 (historical archive)'

STOP = {
    'republic','oblast','krai','kray','region','autonomous','okrug','district','federal','city','of','the',
    'республика','область','край','автономный','автономная','округ','город','г'
}

def norm(s: str) -> str:
    s = str(s or '').lower().replace('ё','е')
    s = re.sub(r'[^a-zа-я0-9]+',' ',s)
    toks=[t for t in s.split() if t not in STOP]
    return ' '.join(toks)

def russian_forms(value: str) -> list[str]:
    """Generate conservative common case forms for Russian place names.

    This is intentionally small and deterministic; it improves matching of
    official phrases such as "в Калуге", "в Шуе", "в Курске" without using a
    general fuzzy matcher that could create false geographic matches.
    """
    value = str(value or '').strip()
    if not value or not re.search(r'[А-Яа-яЁё]', value):
        return []
    words=value.split()
    if not words: return []
    w=words[-1]
    lw=w.lower().replace('ё','е')
    stems=[]
    def emit(last):
        arr=words[:-1]+[last]
        stems.append(' '.join(arr))
    if lw.endswith('а') and len(w)>3:
        base=w[:-1]; emit(base+'е'); emit(base+'ы'); emit(base+'у'); emit(base+'ой')
    elif lw.endswith('я') and len(w)>3:
        base=w[:-1]; emit(base+'е'); emit(base+'и'); emit(base+'ю'); emit(base+'ей')
    elif lw.endswith('ь') and len(w)>3:
        base=w[:-1]; emit(base+'и'); emit(base+'ью')
    elif lw.endswith(('ово','ево','ино','ы')):
        pass
    elif re.search(r'[бвгджзклмнпрстфхцчшщ]$', lw):
        emit(w+'е'); emit(w+'а'); emit(w+'у'); emit(w+'ом')
    return stems

def region_aliases(reg: dict) -> list[str]:
    vals=[reg.get('region',''), reg.get('region_label',''), *(reg.get('geo_aliases') or [])]
    return [norm(v) for v in vals if norm(v)]

def best_region(name: str, asciiname: str, regions: list[dict]) -> str|None:
    names={norm(name),norm(asciiname)}-{''}
    best=None; score=-1
    for r in regions:
        for a in region_aliases(r):
            for n in names:
                if a==n: sc=100
                elif len(a)>=4 and (a in n or n in a): sc=min(len(a),len(n))
                else: continue
                if sc>score: best=r['region'];score=sc
    return best

def download(session, url):
    r=session.get(url,timeout=90)
    r.raise_for_status(); return r.content

def main():
    ap=argparse.ArgumentParser()
    ap.add_argument('--output',default=str(OUT))
    ap.add_argument('--min-population',type=int,default=5000)
    args=ap.parse_args()
    regions=json.loads(REGIONS.read_text(encoding='utf-8'))['regions']
    s=requests.Session(); s.headers['User-Agent']=UA
    admin_text=download(s,ADMIN1_URL).decode('utf-8','replace')
    admin2_text=download(s,ADMIN2_URL).decode('utf-8','replace')
    admin={}
    for line in admin_text.splitlines():
        parts=line.split('\t')
        if len(parts)>=3 and parts[0].startswith('RU.'):
            admin[parts[0].split('.',1)[1]]=(parts[1],parts[2])
    admin2={}
    for line in admin2_text.splitlines():
        parts=line.split('\t')
        if len(parts)>=3 and parts[0].startswith('RU.'):
            admin2[parts[0]]=(parts[1],parts[2])
    raw=download(s,CITIES_URL)
    with zipfile.ZipFile(io.BytesIO(raw)) as z:
        txt=z.read('cities5000.txt').decode('utf-8','replace')
    out=[]; unmapped={}
    admin2_candidates={}
    for line in txt.splitlines():
        cols=line.split('\t')
        if len(cols)<19 or cols[8]!='RU' or cols[6]!='P': continue
        try:
            pop=int(cols[14] or 0); lat=float(cols[4]); lon=float(cols[5])
        except Exception: continue
        if pop < args.min_population and not cols[7].startswith('PPLA'): continue
        a1=cols[10]; arow=admin.get(a1)
        region=best_region(arow[0],arow[1],regions) if arow else None
        if not region:
            unmapped[a1]=arow
            continue
        name=cols[1].strip(); ascii_name=cols[2].strip(); alt=cols[3].split(',') if cols[3] else []
        a2=cols[11].strip()
        if a2:
            key=f'RU.{a1}.{a2}'
            rank=(1 if cols[7]=='PPLA2' else 0, pop)
            prev=admin2_candidates.get(key)
            if prev is None or rank>prev['rank']:
                admin2_candidates[key]={'rank':rank,'lat':lat,'lon':lon,'region':region,'population':pop}
        aliases=[]
        base_values=[name,ascii_name,*alt]
        expanded=[]
        for rawv in base_values:
            expanded.append(rawv)
            expanded.extend(russian_forms(rawv))
        seen_alias=set()
        for v in expanded:
            v=v.strip()
            if not v or len(v)>80: continue
            if not re.search(r'[A-Za-zА-Яа-яЁё]',v): continue
            k=v.casefold()
            if k not in seen_alias:
                aliases.append(v); seen_alias.add(k)
            if len(aliases)>=36: break
        out.append({
            'id':int(cols[0]),'name':ascii_name or name,'label':name,'region':region,
            'lat':lat,'lon':lon,'population':pop,'feature_code':cols[7],'aliases':aliases,
        })
    out.sort(key=lambda x:(x['region'],-x['population'],x['name']))
    municipalities=[]
    for code,meta in admin2.items():
        cand=admin2_candidates.get(code)
        if not cand: continue
        native,ascii_name=meta
        aliases=[]
        for v in [native,ascii_name,*russian_forms(native)]:
            v=(v or '').strip()
            if v and v.casefold() not in {x.casefold() for x in aliases}: aliases.append(v)
        municipalities.append({
            'id':code,'name':ascii_name or native,'label':native,'region':cand['region'],
            'type':'municipality','lat':cand['lat'],'lon':cand['lon'],
            'population':cand['population'],'aliases':aliases[:24],
        })
    municipalities.sort(key=lambda x:(x['region'],x['label']))
    payload={
        'schema_version':2,'source':'GeoNames cities5000 + admin2Codes','license':'CC BY 4.0',
        'source_url':CITIES_URL,'country':'RU','count':len(out),
        'municipality_count':len(municipalities),'cities':out,'municipalities':municipalities,
    }
    path=Path(args.output);path.parent.mkdir(parents=True,exist_ok=True)
    path.write_text(json.dumps(payload,ensure_ascii=False,separators=(',',':'))+'\n',encoding='utf-8')
    print(f'wrote {path}: {len(out)} cities/admin seats + {len(municipalities)} admin2 approximations')
    if unmapped: print('unmapped admin1 codes:',sorted(unmapped)[:20])

if __name__=='__main__': main()
