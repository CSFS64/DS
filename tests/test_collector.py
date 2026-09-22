import json
import unittest
from datetime import datetime, timezone
from pathlib import Path

from collector.collect import parse_telegram_html, pair_alerts, extract_reports

ROOT = Path(__file__).resolve().parents[1]

class CollectorTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cfg = json.loads((ROOT / "data" / "sources.json").read_text(encoding="utf-8"))
        cls.source = next(s for s in cfg["sources"] if s["channel"] == "operativno31")
        cls.html = (ROOT / "tests" / "fixtures" / "telegram_sample.html").read_text(encoding="utf-8")

    def test_parse_and_pair_region(self):
        posts = parse_telegram_html(self.html, "operativno31")
        self.assertEqual(len(posts), 3)
        events, unmatched = pair_alerts(
            posts,
            self.source,
            datetime(2026, 9, 21, 0, 0, tzinfo=timezone.utc),
            datetime(2026, 9, 22, 0, 0, tzinfo=timezone.utc),
        )
        region_events = [e for e in events if e["scope"] == "region"]
        self.assertEqual(len(region_events), 1)
        self.assertEqual(region_events[0]["place"], "Belgorod Oblast")
        self.assertFalse([u for u in unmatched if u["type"] == "unmatched_start"])

    def test_local_count(self):
        posts = parse_telegram_html(self.html, "operativno31")
        reports = extract_reports(
            posts,
            self.source,
            datetime(2026, 9, 21, 0, 0, tzinfo=timezone.utc),
            datetime(2026, 9, 22, 0, 0, tzinfo=timezone.utc),
        )
        self.assertTrue(any(r["place"] == "Belgorod" and r["count"] == 2 and r["count_type"] == "attacked" for r in reports))

if __name__ == "__main__":
    unittest.main()
