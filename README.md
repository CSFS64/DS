# Deepstrike Alert Archive — v5

Responsive GitHub Pages archive for **delayed historical** regional UAV-alert records from official local sources.

## What v5 changes

### Rich vector map

The frontend now uses **MapLibre GL JS + OpenFreeMap** instead of raster PNG/JPEG tiles or an empty boundary-only map.

The base map therefore contains normal map context — roads, cities, rivers, borders and labels — while the alert overlay remains ours:

- city / municipality alert → red luminous point;
- region alert → region polygon highlighted cyan;
- both can be active at once;
- local `data/russia.geojson` is used only as the administrative alert overlay, not as the entire basemap.

Primary style:

```text
https://tiles.openfreemap.org/styles/dark
```

A Liberty style is kept as a style-load fallback. OpenFreeMap uses OpenStreetMap-derived vector data and does not require an API key for its public instance.

### Better START/END pairing

Older builds missed common official clear messages such as:

```text
режим «Беспилотная опасность» снят
отменен режим «Беспилотная опасность»
ОТБОЙ беспилотной и ракетной опасности
снята угроза атаки беспилотных воздушных средств
```

Those variants are now recognized. Repeated “danger remains in effect” messages do not create duplicate open alerts.

### Coverage status now means something

`81/89 REGION FEEDS` in the older UI only meant that 81 RSS URLs returned HTTP successfully. It did **not** mean that 81 regions had UAV-alert posts.

v5 reports separate metrics:

- `REGIONS WITH EVENTS` — regions with a successfully paired START/END event in the current archive window;
- `RSS ALERT-CAPABLE` — MChS RSS feeds that actually contained UAV START/END posts in the window;
- `HIGH-RES ALERT-CAPABLE` — configured local Telegram sources that actually contained UAV START/END posts;
- `UNMATCHED` — START messages for which no clear was found in the collected context.

The raw HTTP health metric is still retained in `data/events.json` for diagnostics, but is no longer presented as alert coverage.

## Source layers

### High-resolution official local sources

`data/sources.json` currently contains nine official sources:

1. Belgorod Oblast — `@operativno31`
2. Kursk Oblast — `@gubernator_46`
3. Voronezh Oblast — `@gusev_36`
4. Lipetsk Oblast — `@igor_artamonov48`
5. Tula Oblast — `@regionbez71`
6. Republic of Tatarstan — `@nashtatarstan_official`
7. Penza Oblast — `@omelnichenko`
8. Republic of Bashkortostan — `@mchsrb01`
9. Samara Oblast — `@fedorishchev_official`

These feeds can resolve city / municipality names when they are explicitly present in the official post. If a valid alert cannot be resolved below the region, it falls back to region precision and records that provenance.

### Nationwide fallback

`data/regions.json` still contains all 89 configured regional MChS websites/RSS feeds. This is a **fallback and diagnostic layer**, not a guarantee that the website RSS mirrors every MChS mobile-app push.

The collector never treats “RSS URL returned HTTP 200” as evidence that the region had an alert.

### RSChS MAX channels

MChS has created regional RSChS MAX channels which are useful first-party alert sources. They are not automatically ingested by this project yet because the documented MAX channel-history API requires authorization and, for `chat_id` history access, bot administrator access to the channel. The public channel metadata endpoint is not a historical-post API.

So v5 does **not** pretend to have nationwide MAX history collection. Expansion is done with verified public official feeds that can be archived reproducibly.

## Data flow

```text
Official local Telegram sources ──────┐
                                      ├─ collector/collect.py
Official regional MChS RSS fallback ─┘
                    │
                    ├─ START/END classification
                    ├─ city / municipality / region resolution
                    ├─ conservative pairing
                    ├─ local UAV-count extraction (optional)
                    └─ MOD-derived count exclusion
                    │
                    ▼
              data/events.json
                    │
                    ▼
        GitHub Pages / MapLibre playback UI
```

The collector enforces a minimum **24-hour archive lag**.

## Deploy / update

From the project directory:

```powershell
git add .
git commit -m "v5 vector map and alert parser expansion"
git pull --rebase origin main
git push
```

Then in GitHub:

1. **Actions → Deploy GitHub Pages** — wait for green.
2. **Actions → Update delayed archive data → Run workflow** — run one collection with the new parser/source list.
3. Wait for the data commit to trigger Pages deployment again.
4. Hard-refresh the site (`Ctrl+F5`).

The data Action defaults to a 48-hour collection window ending at least 24 hours before the current time.

## Project files

```text
.
├── index.html
├── css/
│   └── styles.css
├── js/
│   └── app.js
├── data/
│   ├── events.json       # generated archive snapshot (do not replace in patches)
│   ├── sources.json      # high-resolution official sources
│   ├── regions.json      # 89-region MChS fallback registry
│   └── russia.geojson    # local region overlay, installed by the v4 map installer
├── collector/
│   ├── __init__.py
│   └── collect.py
├── tests/
│   ├── fixtures/
│   └── test_collector.py
└── .github/workflows/
    ├── pages.yml
    └── update-data.yml
```

## Important limitations

- Public Telegram HTML is not a formal archival API; its markup can change.
- MChS website RSS does not necessarily contain every push sent by the MChS app / RSChS system.
- Local authorities use many templates and grammatical forms; unpaired starts are exposed rather than silently guessed.
- `attacked`, `detected`, `destroyed`, `shot down`, and `suppressed` UAV counts are kept as different categories.
- Posts explicitly attributed/forwarded from the Russian Ministry of Defence are excluded from local-count extraction.
- OpenFreeMap's public instance is convenient and keyless but does not offer an SLA. The alert overlay and archive data remain independent of the basemap service.

## v9 update

See `README_V9.md`. v9 hides inactive archive point markers, removes post-clear region trails, adds a cumulative `Σ` timeline pointer, and changes scheduled data collection to incremental updates (new safe archive edge + overlap) instead of re-fetching the full lookback on every run.

## v10 parser behavior

v10 prioritizes retaining official local UAV activity instead of discarding posts that do not form a perfect START/END pair. See `README_V10.md` for the activity classes and display semantics.
