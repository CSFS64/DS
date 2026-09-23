#!/usr/bin/env python3
"""Print a compact Markdown source-health report from data/events.json."""
from __future__ import annotations
import json
from collections import defaultdict
from pathlib import Path

path = Path('data/events.json')
if not path.exists():
    print('## Source health\n\n`data/events.json` is missing.')
    raise SystemExit(0)

data = json.loads(path.read_text(encoding='utf-8'))
coverage = data.get('coverage') or {}
rows = [r for r in (data.get('source_status') or []) if r.get('source_type') == 'telegram']
by_region = defaultdict(list)
for row in rows:
    by_region[row.get('region') or 'Unknown'].append(row)

print('## v12 official-source health')
print()
print(f"- MTProto: **{'ON' if coverage.get('telegram_mtproto_enabled') else 'OFF'}**")
print(f"- High-resolution regions configured: **{coverage.get('high_resolution_regions_configured', 0)}**")
print(f"- Regions with at least one transport-OK source: **{coverage.get('high_resolution_regions_transport_ok', 0)}**")
print(f"- Failed high-resolution sources: **{coverage.get('high_resolution_sources_failed', 0)}**")
print(f"- MChS RSS alert regions (auxiliary only): **{coverage.get('mchs_regions_with_alert_posts', 0)}**")
if coverage.get('telegram_mtproto_error'):
    print(f"- MTProto setup error: `{coverage['telegram_mtproto_error']}`")

bad = []
for region, rr in sorted(by_region.items()):
    active = [x for x in rr if x.get('expected_active', True)]
    if not active:
        continue
    if not any(x.get('transport_ok') for x in active):
        bad.append((region, 'NO WORKING HIGH-RES SOURCE', active))
    elif any(x.get('health') in {'failed','degraded'} for x in active):
        bad.append((region, 'PARTIAL / DEGRADED', active))

print()
print('### Coverage gaps')
if not bad:
    print('No configured high-resolution region has an obvious transport gap in this run.')
else:
    print('| Region | State | Sources |')
    print('|---|---|---|')
    for region, state, rr in bad:
        parts=[]
        for x in rr:
            parts.append(f"@{x.get('source')}={x.get('health','?')}({x.get('posts',0)} posts)")
        print(f"| {region} | {state} | {'; '.join(parts)} |")
