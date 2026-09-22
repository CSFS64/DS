# Deepstrike Alert Archive

A responsive GitHub Pages site for browsing **delayed historical** regional UAV-alert records from official local sources.

## What is included

- Dark military / high-tech map UI for desktop and mobile.
- City/municipality lamps: active alert = illuminated red point, otherwise dim.
- Region-level alert: the ADM1 region is highlighted; city lamps can be active at the same time.
- Start/end date controls, generated timeline ticks, two draggable range handles, scrubber, and autoplay.
- Moscow / Kyiv / Beijing time conversion in the UI.
- Official-source links on each archived event/report.
- Static GitHub Pages frontend (`index.html`, `css/`, `js/`).
- Python collector run by GitHub Actions. The browser never scrapes Telegram directly.
- **24-hour minimum archive lag**; the default collector window is the 48 hours before that lag.
- Conservative parser: only paired START + END alerts are shown. Missing clears stay in `unmatched` diagnostics instead of being guessed.
- Local counts are optional. Posts attributed/forwarded from the Russian Ministry of Defence are excluded from count extraction.

## Current seed data

`data/events.json` includes a real recent seed snapshot from the official Belgorod regional operations HQ (`@operativno31`) for **21 September 2026**, including:

- Belgorod / Belgorodsky District UAV alert at 05:04 MSK.
- Belgorod Oblast region-wide UAV alert at 05:25 MSK.
- Region-wide clear at 14:44 MSK.
- A later Belgorodsky District alert 16:12–16:52 MSK.
- A local official report that Belgorod was attacked by 2 UAVs that morning.

The first successful `Update delayed archive data` workflow run replaces the seed with a fresh 24h-delayed archive snapshot from configured official sources.

## Deploy

1. Create an empty GitHub repository.
2. Upload/push this entire folder to the `main` branch.
3. In **Settings → Pages**, choose **GitHub Actions** as the source if GitHub has not selected it automatically.
4. Open **Actions → Deploy GitHub Pages → Run workflow** once if needed.
5. Open **Actions → Update delayed archive data → Run workflow** to perform the first real source collection immediately.
6. After that, the collector runs once per day automatically. A changed `data/events.json` is committed by the Actions bot and Pages redeploys.

No API token or Telegram account is required for the current public-page collector.

## Data flow

```text
Official public Telegram channels
        ↓
GitHub Actions / collector/collect.py
        ↓
START/END pairing + local count extraction
        ↓
data/events.json
        ↓
GitHub Pages
        ↓
Map + timeline playback
```

GitHub Pages itself is static. This is why source collection happens in Actions instead of JavaScript in the browser: public Telegram pages generally should not be relied on for cross-origin browser fetching, and server-side collection gives us stable raw timestamps and post IDs.

## Source configuration

Edit `data/sources.json` to add sources. Each source contains:

- `region`: must match the region `name_latin` in the Russian ADM1 GeoJSON when possible.
- `channel`: public Telegram channel handle.
- `source_name` / `source_url`.
- `places`: city or municipality coordinates plus Russian name/inflection aliases.

The starter config contains verified source definitions for:

- Belgorod Oblast — `@operativno31`
- Kursk Oblast — `@gubernator_46`
- Voronezh Oblast — `@gusev_36`
- Lipetsk Oblast — `@igor_artamonov48`

The architecture is source-list driven, so expanding coverage does not require changing the frontend.

## Parser behavior

Alert START phrases currently include forms such as:

- `опасность атаки БПЛА`
- `беспилотная опасность`
- `угроза атаки БПЛА`
- `тревога в связи с угрозой непосредственного удара БПЛА`

Alert END phrases include:

- `отбой опасности атаки БПЛА`
- `отбой беспилотной опасности`
- `отмена непосредственной опасности атаки БПЛА`

A region-wide clear can close local alerts nested inside that same active regional period. This is recorded with `end_match: regional_clear` so the provenance is visible rather than hidden.

## Files

```text
.
├── index.html
├── css/
│   └── styles.css
├── js/
│   └── app.js
├── data/
│   ├── events.json
│   └── sources.json
├── collector/
│   ├── __init__.py
│   └── collect.py
├── tests/
│   ├── fixtures/telegram_sample.html
│   └── test_collector.py
├── .github/workflows/
│   ├── pages.yml
│   └── update-data.yml
├── requirements.txt
└── README.md
```

## Map boundaries

The frontend loads Russian ADM1 GeoJSON from the public `codeforgermany/click_that_hood` dataset. If that external GeoJSON fails, configured regions fall back to approximate circles so the UI remains usable.

## Important limitations

- Telegram public HTML is not a formal API and its markup may change; `source_status` in `events.json` exposes collection failures.
- Different regions use different alert wording. Unknown scopes are retained in diagnostics rather than assigned to a city by guesswork.
- A local government saying `attacked`, `detected`, `destroyed`, `shot down`, or `suppressed` are not treated as interchangeable categories.
- The starter source list is not yet nationwide. Add/verify more official local feeds in `data/sources.json`; the UI and collector are already designed for that expansion.
