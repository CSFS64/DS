import json
import unittest
from datetime import datetime, timezone
from pathlib import Path

from collector.collect import (
    extract_reports,
    mchs_source,
    pair_alerts,
    parse_mchs_rss,
    parse_telegram_html,
)

ROOT = Path(__file__).resolve().parents[1]


class CollectorTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cfg = json.loads((ROOT / "data" / "sources.json").read_text(encoding="utf-8"))
        cls.source = next(s for s in cfg["sources"] if s["channel"] == "operativno31")
        cls.html = (ROOT / "tests" / "fixtures" / "telegram_sample.html").read_text(encoding="utf-8")
        regions = json.loads((ROOT / "data" / "regions.json").read_text(encoding="utf-8"))
        cls.belgorod_region = next(r for r in regions["regions"] if r["id"] == "31")
        cls.rss = (ROOT / "tests" / "fixtures" / "mchs_sample.xml").read_text(encoding="utf-8")

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

    def test_mchs_rss_region_fallback(self):
        posts = parse_mchs_rss(self.rss, self.belgorod_region)
        self.assertEqual(len(posts), 2)
        source = mchs_source(self.belgorod_region)
        events, unmatched = pair_alerts(
            posts,
            source,
            datetime(2026, 9, 21, 0, 0, tzinfo=timezone.utc),
            datetime(2026, 9, 22, 0, 0, tzinfo=timezone.utc),
        )
        self.assertEqual(len(events), 1)
        self.assertEqual(events[0]["region"], "Belgorod Oblast")
        self.assertEqual(events[0]["scope"], "region")
        self.assertEqual(events[0]["source_kind"], "mchs_rss")
        self.assertFalse([u for u in unmatched if u["type"] == "unmatched_start"])

    def test_regions_registry_is_nationwide(self):
        regions = json.loads((ROOT / "data" / "regions.json").read_text(encoding="utf-8"))
        self.assertEqual(len(regions["regions"]), 89)
        self.assertTrue(all(r.get("mchs_rss_url") for r in regions["regions"]))


if __name__ == "__main__":
    unittest.main()
