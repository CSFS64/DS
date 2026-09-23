import json
import unittest
from datetime import datetime, timezone
from pathlib import Path

from collector.collect import (
    Post,
    classify_count_sentence,
    extract_places,
    extract_reports,
    mchs_source,
    pair_alerts,
    parse_mchs_rss,
    parse_telegram_html,
    text_kind,
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


    def test_regional_clear_wording_variants(self):
        self.assertEqual(text_kind('В Татарстане введен режим «Беспилотная опасность»'), 'start')
        self.assertEqual(text_kind('В Татарстане снят режим «Беспилотная опасность»'), 'end')
        self.assertEqual(text_kind('На территории Пензенской области отменен режим «Беспилотная опасность».'), 'end')
        self.assertEqual(text_kind('Снята угроза атаки БПЛА.'), 'end')
        self.assertEqual(text_kind('Снята угроза атаки беспилотных воздушных средств.'), 'end')
        self.assertEqual(text_kind('ОТБОЙ беспилотной и ракетной опасности на территории Самарской области.'), 'end')
        self.assertEqual(text_kind('В Тольятти действует режим «АТАКА БПЛА».'), 'start')

    def test_high_resolution_registry_expanded(self):
        cfg = json.loads((ROOT / 'data' / 'sources.json').read_text(encoding='utf-8'))
        channels = {s['channel'] for s in cfg['sources'] if s.get('enabled')}
        self.assertTrue({'regionbez71', 'nashtatarstan_official', 'omelnichenko', 'mchsrb01', 'fedorishchev_official'} <= channels)
        self.assertTrue({'mos_sobyanin','vorobiev_live','avbogomaz','evraevmikhail','glebnikitin_nn','Shapsha_VV'} <= channels)
        self.assertTrue({'ivanovoobl','anohin67','busargin_r','officialmordovia','ulgovru','RostovRegion','kondratyevvi','chuvashia_region','rgn_34'} <= channels)
        self.assertNotIn('nn52signal', channels)
        self.assertGreaterEqual(len(channels), 40)


    def test_samara_city_then_regional_clear_pairs_city(self):
        cfg = json.loads((ROOT / 'data' / 'sources.json').read_text(encoding='utf-8'))
        source = next(s for s in cfg['sources'] if s['channel'] == 'fedorishchev_official')
        posts = [
            Post('fedorishchev_official', 1, datetime(2026, 9, 20, 20, 0, tzinfo=timezone.utc),
                 'Внимание! На территории Самарской области действует режим «БЕСПИЛОТНАЯ ОПАСНОСТЬ».', 'https://t.me/x/1'),
            Post('fedorishchev_official', 2, datetime(2026, 9, 20, 22, 0, tzinfo=timezone.utc),
                 'В Тольятти действует режим «АТАКА БПЛА».', 'https://t.me/x/2'),
            Post('fedorishchev_official', 3, datetime(2026, 9, 21, 3, 0, tzinfo=timezone.utc),
                 'Объявлен ОТБОЙ беспилотной опасности на территории Самарской области.', 'https://t.me/x/3'),
        ]
        events, unmatched = pair_alerts(
            posts, source,
            datetime(2026, 9, 20, 0, 0, tzinfo=timezone.utc),
            datetime(2026, 9, 22, 0, 0, tzinfo=timezone.utc),
        )
        self.assertTrue(any(e['place'] == 'Samara Oblast' and e['scope'] == 'region' for e in events))
        self.assertTrue(any(e['place'] == 'Tolyatti' and e['scope'] == 'city' for e in events))
        self.assertFalse([u for u in unmatched if u['type'] == 'unmatched_start'])

    def test_tatarstan_region_alias_is_exact_region(self):
        cfg = json.loads((ROOT / 'data' / 'sources.json').read_text(encoding='utf-8'))
        source = next(s for s in cfg['sources'] if s['channel'] == 'nashtatarstan_official')
        posts = [
            Post('nashtatarstan_official', 1, datetime(2026, 9, 20, 2, 0, tzinfo=timezone.utc),
                 'В Татарстане введен режим «Беспилотная опасность».', 'https://t.me/x/1'),
            Post('nashtatarstan_official', 2, datetime(2026, 9, 20, 5, 0, tzinfo=timezone.utc),
                 'В Татарстане снят режим «Беспилотная опасность».', 'https://t.me/x/2'),
        ]
        events, _ = pair_alerts(
            posts, source,
            datetime(2026, 9, 20, 0, 0, tzinfo=timezone.utc),
            datetime(2026, 9, 21, 0, 0, tzinfo=timezone.utc),
        )
        self.assertEqual(len(events), 1)
        self.assertEqual(events[0]['place'], 'Republic of Tatarstan')
        self.assertEqual(events[0]['precision'], 'exact_region')

    def test_v6_nizhny_clear_and_report_count(self):
        self.assertEqual(text_kind('Отмена сигнала "ОПАСНОСТЬ АТАКИ БПЛА".'), 'end')
        rows = classify_count_sentence('С 03:00 до 05:00 силы ПВО и РЭБ сбили и подавили 249 БПЛА в 17 округах.')
        self.assertTrue(rows)
        self.assertEqual(rows[0][0], 249)
        self.assertEqual(rows[0][1], 'destroyed_or_suppressed')

    def test_v6_catalog_place_can_resolve_without_hardcoding(self):
        source = dict(self.source)
        source['_catalog_places'] = [{
            'name':'Sample City','label':'Тестоград','type':'city','lat':55.0,'lon':40.0,
            'aliases':['Тестоград']
        }]
        matches = extract_places('В Тестограде пока спокойно. Тестоград: опасность БПЛА.', source)
        self.assertTrue(any(p['name']=='Sample City' for p in matches))

    def test_regions_registry_is_nationwide(self):
        regions = json.loads((ROOT / "data" / "regions.json").read_text(encoding="utf-8"))
        self.assertEqual(len(regions["regions"]), 89)
        self.assertTrue(all(r.get("mchs_rss_url") for r in regions["regions"]))

    def test_v7_generic_threat_clear_and_inflected_city_alias(self):
        self.assertEqual(text_kind('Над территорией области обнаружены БПЛА. Угроза снята.'), 'end')
        cfg = json.loads((ROOT / 'data' / 'sources.json').read_text(encoding='utf-8'))
        source = next(s for s in cfg['sources'] if s['channel'] == 'ivanovoobl')
        matches = extract_places('В Шуе сохраняется режим опасности атаки БПЛА.', source)
        self.assertTrue(any(p['name'] == 'Shuya' for p in matches))

    def test_v7_official_local_report_not_rejected_for_mentioning_mod(self):
        from collector.collect import mod_derived
        local = Post('gov', 1, datetime(2026,9,20,1,0,tzinfo=timezone.utc),
                     'Силами ПВО Министерства обороны уничтожены 13 БПЛА над городом Калуга.', 'https://t.me/gov/1')
        copied = Post('gov', 2, datetime(2026,9,20,2,0,tzinfo=timezone.utc),
                      'По данным Минобороны России уничтожены 13 БПЛА.', 'https://t.me/gov/2')
        self.assertFalse(mod_derived(local))
        self.assertTrue(mod_derived(copied))


    def test_v8_additional_official_sources_and_wording(self):
        cfg = json.loads((ROOT / 'data' / 'sources.json').read_text(encoding='utf-8'))
        channels = {s['channel'] for s in cfg['sources'] if s.get('enabled')}
        self.assertTrue({'solntsev_official','udmurt_gov','mahonin59','gov74','pul69','novgorodinfo','filimonov_official','pskov_oblast','kurganskayaobl','drozdenko_au_lo','miduralofficial'} <= channels)
        self.assertEqual(text_kind('Отбой воздушной опасности в Ленинградской области.'), 'end')
        self.assertEqual(text_kind('Отбой сигнала «Опасное небо».'), 'end')

    def test_v8_countless_local_incident_becomes_activity_report(self):
        cfg = json.loads((ROOT / 'data' / 'sources.json').read_text(encoding='utf-8'))
        source = next(s for s in cfg['sources'] if s['channel'] == 'filimonov_official')
        posts = [Post('filimonov_official', 1, datetime(2026,9,20,1,0,tzinfo=timezone.utc),
                      'Идет атака БПЛА на череповецкую промышленную зону. Действует ПВО.', 'https://t.me/x/1')]
        reports = extract_reports(posts, source, datetime(2026,9,20,0,0,tzinfo=timezone.utc), datetime(2026,9,21,0,0,tzinfo=timezone.utc))
        self.assertEqual(len(reports), 1)
        self.assertEqual(reports[0]['count_type'], 'official_activity')
        self.assertEqual(reports[0]['place'], 'Cherepovets')

if __name__ == "__main__":
    unittest.main()
