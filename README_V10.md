# v10 — display-first UAV activity parsing

This release changes the collector from a strict paired-alert archive into a **display-first delayed historical activity archive** while preserving formal START/END intervals when they are available.

## What changes

- Formal alert wording is expanded to include additional regional templates such as:
  - `Воздушная опасность`
  - `угроза подлёта БПЛА`
  - `Опасное небо`
  - existing `Беспилотная опасность`, `опасность/угроза атаки БПЛА`, `АТАКА БПЛА`, etc.
- Clear wording is expanded correspondingly, including `отбой по угрозе подлёта БПЛА` and additional `воздушная опасность` forms.
- Any official local post with a clear UAV reference plus operational wording is now kept as a timestamped activity signal even if it cannot be paired into a full interval.
- Broad activity families include attack, approach/flight, detection, air-defence/EW action, debris/impact, and restrictions explicitly tied to UAVs.
- Obvious non-operational posts about manufacturing, exhibitions, procurement, training, agriculture, etc. are filtered unless they also contain clear operational context.
- Unpaired formal START posts become red point signals in playback instead of disappearing.
- Unpaired END/clear posts are retained as historical evidence but are not treated as a live formal interval.
- Countless activity reports remain visible.
- Multi-place official posts light every matched place from the nationwide place catalog.
- Russian case variants are generated at parse time for manually configured aliases as well as catalog aliases.

## Frontend

- Cumulative `Σ` mode now accumulates both paired formal alerts **and** timestamped official UAV activity signals.
- A region with any local activity signal is highlighted together with the local place marker.
- Top status now distinguishes regions with any record from regions with a full paired alert.

## Important semantics

The UI still distinguishes evidence types:

- **Formal paired interval:** START and END are known.
- **Formal start signal:** an official START exists but no matching END was found in the collected context.
- **Official UAV activity signal:** attack/detection/movement/PVO/debris/etc. was reported, but there is no formal interval.
- **Clear signal:** an END/clear message exists without a matched START.

Point signals are deliberately not assigned invented durations. They are displayed around their timestamp and remain available in cumulative mode.

The project retains its minimum 24-hour archive delay; this release does not turn it into a real-time alert system.
