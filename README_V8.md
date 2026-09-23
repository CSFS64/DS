# v8 notes

- Inactive city lamps are hidden; the base map remains uncluttered.
- Active city/municipality alerts still light a red point and always activate the parent region.
- Regions with a formal alert in the previous six hours retain a faint cyan trace. This is a rolling history of official alerts, not an inferred UAV route.
- High-resolution official Telegram registry expanded to 40 sources.
- Countless first-party incident posts (for example, an official statement that a city is under UAV attack) are retained as amber activity reports.
- GeoNames catalog now uses the full RU dump, includes settlements >=1000 population plus administrative seats, and derives ADM2 representatives.
- Collector lookback defaults to 120h and actually merges old archive records instead of replacing them.
