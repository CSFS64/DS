# Deepstrike Alert Archive v7 update

This patch focuses on delayed historical data coverage.

## Changes

- Fixes the `0 CITY CATALOG` issue by adding the missing GitHub Actions catalog-build step.
- Generates a nationwide GeoNames city catalog and approximate ADM2/municipality catalog.
- Adds conservative Russian place-name inflection aliases so phrases such as `в Шуе`, `в Калуге`, and `в Курске` can resolve to catalog places.
- Loads the city catalog in the frontend so catalogued cities have map lamps independently of hand-written `sources.json` entries.
- Local city/municipality alerts always activate the parent region fill as well.
- Replaces the ambiguous `nn52signal` source with the official Nizhny Novgorod governor channel.
- Expands verified official Telegram coverage to at least 27 regional/governor/government sources.
- Refines MOD filtering: a governor's own local report is kept even if it says MOD/PVO forces performed the interception; explicit copied/attributed MOD statistics remain excluded.
- When a local total and city list are split across lines in one official post, named places are preserved as report/activity markers.
- Keeps older paired events/reports instead of replacing the whole archive every day. The overlapping recent window is regenerated each run.
- Default update window increases to 72 hours before the fixed 24-hour archive lag, with deeper Telegram pagination.

## Important interpretation

The map shows official reported alert/activity geography. It does not interpolate or infer aircraft/UAV trajectories between regions that did not publish a warning.
