# v12 — reliable Telegram history + multi-source regional stack

v12 fixes the source-layer failure identified from the real archive snapshot: a regional source could return HTTP 200 yet yield zero parseable Telegram messages, while the old UI still described the source as healthy. At the same time, the 89 regional MChS RSS endpoints are useful as auxiliary feeds but did not provide a nationwide UAV-alert history.

## What changed

### 1. Telegram MTProto is now the preferred history transport

When the three GitHub Actions secrets below exist, the collector reads public official channel history with Telethon/Telegram MTProto instead of depending on `t.me/s/...` HTML:

- `TELEGRAM_API_ID`
- `TELEGRAM_API_HASH`
- `TELEGRAM_SESSION`

The public HTML collector remains as a fallback. A public Telegram page that returns HTTP successfully but produces **zero parsed messages is now a failed fetch**, not evidence that the region was quiet.

Source status now records:

- transport (`telegram_mtproto` or `telegram_public_html`)
- transport success
- whether the requested time window was covered
- parsed post count
- oldest/newest parsed post
- UAV activity / alert / event / report counts
- explicit fetch error

The top bar exposes `MTPROTO ON/OFF`, high-resolution region coverage, region fetch health, and failed source count.

### 2. Multiple official sources can cover the same region

The collector now deliberately treats `data/sources.json` as a source stack rather than a one-region/one-channel mapping. Governor/government, regional MChS, operational headquarters, and municipal official channels can all be read and merged. Event/report IDs still deduplicate repeated records.

The registry contains **67 enabled official Telegram sources covering 47 regions**, including additional official sources for the gap regions identified during the v11 audit: Oryol, Bryansk, Lipetsk, Ryazan, Tambov, Moscow Oblast, Nizhny Novgorod, Mari El, Ulyanovsk, Volgograd, Rostov and Krasnodar.

MAX channel URLs are stored only as provenance/coverage metadata where known. v12 does **not** pretend to have anonymous nationwide MAX history ingestion; the current collector does not scrape MAX message history.

### 3. MChS RSS is explicitly auxiliary

The 89 MChS regional RSS endpoints remain configured because they can still contribute occasional official records and health evidence, but they are no longer presented as the nationwide alert fallback. Their status is labeled `RSS AUX`.

### 4. GitHub Actions source-health summary

Every data run adds a Markdown source-health report to the Action job summary. It identifies regions where every configured high-resolution source failed, plus partially degraded stacks. This makes a future missing region diagnosable without printing a giant PowerShell table.

## One-time Telegram setup

The reliable-history path requires a Telegram user session. The session credential can authenticate as that Telegram account; **it is not scoped read-only**. Prefer a dedicated Telegram account and treat the generated session string like a password.

1. Create a Telegram API application at `https://my.telegram.org` and obtain an API ID and API hash.
2. In the project directory install dependencies:

```powershell
pip install -r requirements.txt
```

3. Generate a StringSession locally:

```powershell
python scripts/create_telegram_session.py
```

4. In GitHub open:

`Repository → Settings → Secrets and variables → Actions → New repository secret`

Create exactly these three repository secrets:

```text
TELEGRAM_API_ID
TELEGRAM_API_HASH
TELEGRAM_SESSION
```

Never commit those values to the repository and do not paste them into chat.

After the next collection, the web app should display `MTPROTO ON`. If it displays `MTPROTO OFF`, the Action did not receive all three secrets and is using the less reliable public-HTML fallback.

## First v12 collection

Because v12 changes the transport and source stack, run one deliberate recent backfill after deployment:

```text
Actions → Update delayed archive data → Run workflow
mode = backfill
backfill_hours = 168
```

After that, return to normal `incremental` runs. The archive still enforces the 24-hour historical lag.

## Interpretation

A missing region is no longer silently equivalent to “no activity.” If no working high-resolution source covered that region/window, source health reports it as a coverage gap. The map itself still lights only records supported by official source material; it does not interpolate neighboring regions or infer a UAV route.
