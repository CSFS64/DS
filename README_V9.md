# v9 — cumulative pointer + clean lamps + incremental archive updates

## Frontend

- Inactive city/municipality archive points are fully invisible. OpenFreeMap's own place labels remain visible; archive lamps appear only for active formal alerts (red) or local official activity/reports (amber).
- Removed the six-hour post-clear region trace. Once a formal alert ends, the normal realtime playback immediately clears it.
- Added a third amber `Σ` pointer on the START/END timeline. Dragging it switches the map to cumulative mode: every formal alert that overlapped the interval from START through the pointer remains lit. Pressing PLAY or dragging the normal playback scrubber switches back to realtime mode.

## Collector

Scheduled/manual incremental runs no longer re-fetch the full lookback window every time.

- Existing `data/events.json` remains cumulative.
- Incremental runs read the previous `window_end` and collect only the new safe archive edge plus an 18-hour overlap.
- The overlap allows alerts spanning two runs to be repaired without re-fetching days of older history.
- A manual `backfill` mode remains available from GitHub Actions when parser/source changes require reprocessing a wider recent window.
- Telegram context reduced to 48 hours and maximum pages to 50 for normal runs.
- The scheduled workflow now runs every six hours, while retaining the project's 24-hour archive delay.

### GitHub Actions manual options

`Actions → Update delayed archive data → Run workflow`

- `mode = incremental` — normal fast update; preserve old archive and fetch only the new edge + overlap.
- `mode = backfill` — re-fetch `backfill_hours` of recent delayed history, then merge it into the archive.

Old records before the regenerated overlap/backfill window are kept; they are not downloaded again in normal incremental mode.
