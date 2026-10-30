#!/usr/bin/env python3
"""Delete retrospectively aggregated UAV/missile summaries from events.json.

Always run this script in repository root.  It rewrites the real tracked JSON,
not a separate browser filter; can safely be re-run (idempotent).
"""
from __future__ import annotations

import argparse
import json
import os
import sys
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from collector.collect import purge_archive_aggregate_summaries  # noqa: E402


def purge_file(path: Path, *, dry_run: bool = False) -> tuple[int, int]:
    data = json.loads(path.read_text(encoding="utf-8"))
    previous_events = len(data.get("events", []))
    previous_reports = len(data.get("reports", []))
    data = purge_archive_aggregate_summaries(data)
    removed_reports = previous_reports - len(data["reports"])
    removed_events = previous_events - len(data["events"])
    print(
        f"purge summaries: reports {previous_reports} -> {len(data['reports'])} "
        f"(-{removed_reports}); events {previous_events} -> {len(data['events'])} "
        f"(-{removed_events})"
    )
    if not dry_run and (removed_reports or removed_events):
        # Ensure an interrupted process cannot leave an incomplete data file.
        fd, tmp = tempfile.mkstemp(prefix=path.name + ".", suffix=".tmp", dir=path.parent)
        try:
            with os.fdopen(fd, "w", encoding="utf-8") as file:
                json.dump(data, file, ensure_ascii=False, indent=2)
            os.replace(tmp, path)
        finally:
            if os.path.exists(tmp):
                os.unlink(tmp)
    return removed_reports, removed_events


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--path", type=Path, default=ROOT / "data" / "events.json")
    parser.add_argument("--dry-run", action="store_true")
    args = parser.parse_args()
    purge_file(args.path, dry_run=args.dry_run)


if __name__ == "__main__":
    main()
