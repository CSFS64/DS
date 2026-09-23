import json
import unittest
import tempfile
from argparse import Namespace
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
    uav_activity_kind,
    missile_text_kind,
    missile_activity_kind,
    configure_incremental_window,
    FetchResult,
    source_status_row,
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

    def test_v9_incremental_window_uses_previous_cursor(self):
        with tempfile.TemporaryDirectory() as td:
            out = Path(td) / "events.json"
            from datetime import timedelta
            now = datetime.now(timezone.utc)
            # Previous safe cutoff roughly six hours behind the new one.
            previous_end = now - timedelta(hours=30)
            out.write_text(json.dumps({"window_end": previous_end.isoformat()}), encoding="utf-8")
            args = Namespace(
                output=str(out), safety_lag_hours=24, lookback_hours=168,
                incremental_overlap_hours=18, full_backfill=False,
            )
            configure_incremental_window(args)
            self.assertEqual(args.collection_mode, "incremental")
            self.assertGreaterEqual(args.lookback_hours, 23)
            self.assertLess(args.lookback_hours, 40)

    def test_v9_backfill_keeps_requested_window(self):
        args = Namespace(
            output="missing.json", safety_lag_hours=24, lookback_hours=168,
            incremental_overlap_hours=18, full_backfill=True,
        )
        configure_incremental_window(args)
        self.assertEqual(args.collection_mode, "backfill")
        self.assertEqual(args.lookback_hours, 168)

    def test_v10_broad_alert_wording(self):
        self.assertEqual(text_kind('На территории города Пензы объявлен режим «Воздушная опасность».'), 'start')
        self.assertEqual(text_kind('В Самарской области объявлена угроза подлёта БПЛА.'), 'start')
        self.assertEqual(text_kind('Отбой по угрозе подлёта БПЛА.'), 'end')
        self.assertEqual(text_kind('Объявлен режим «Опасное небо».'), 'start')

    def test_v10_any_operational_uav_wording_is_signal(self):
        cases = {
            'В районе города обнаружен беспилотник.': 'uav_detected',
            'Два БПЛА движутся в направлении города.': 'uav_movement',
            'ПВО отражает атаку беспилотников.': 'uav_attack_activity',
            'Обломки БПЛА упали на окраине города.': 'impact_or_debris',
            'Силами ПВО уничтожен БПЛА.': 'air_defense_action',
        }
        for text, expected in cases.items():
            with self.subTest(text=text):
                self.assertEqual(uav_activity_kind(text), expected)
        self.assertIsNone(uav_activity_kind('Обсудили производство БПЛА на предприятии.'))

    def test_v10_unpaired_formal_start_is_still_display_signal(self):
        cfg = json.loads((ROOT / 'data' / 'sources.json').read_text(encoding='utf-8'))
        source = next(s for s in cfg['sources'] if s['channel'] == 'omelnichenko')
        posts = [Post('omelnichenko', 9001, datetime(2026,9,20,1,0,tzinfo=timezone.utc),
                      'На территории города Пензы объявлен режим «Воздушная опасность».', 'https://t.me/x/9001')]
        reports = extract_reports(posts, source, datetime(2026,9,20,0,0,tzinfo=timezone.utc), datetime(2026,9,21,0,0,tzinfo=timezone.utc))
        self.assertTrue(reports)
        self.assertEqual(reports[0]['count_type'], 'alert_start_signal')
        self.assertEqual(reports[0]['signal_class'], 'formal_alert_signal')
        self.assertEqual(reports[0]['place'], 'Penza')

    def test_v12_multi_source_stack_for_known_gap_regions(self):
        cfg = json.loads((ROOT / 'data' / 'sources.json').read_text(encoding='utf-8'))
        enabled = [s for s in cfg['sources'] if s.get('enabled')]
        channels = {s['channel'] for s in enabled}
        required = {
            'mchs_orel', 'mchs_bryansk', 'gumchs48', 'lipobl',
            'pavelmalkov_official', 'PervyshovEA', 'gu_mchs_tambov',
            'mchs_mo', 'govrme12', 'mchs12gov', 'mchs_ulyanovsk',
            'mchs34', 'volgadmin', 'Yuri_Slusar', 'mchs_rostov',
            'opershtab23', 'mchs_kuban',
        }
        self.assertGreaterEqual(len(enabled), 67)
        self.assertTrue(required <= channels)

    def test_v13_classifier_is_sentence_scoped_and_display_first(self):
        # Operational word in an unrelated sentence must not combine with a
        # later training/instruction sentence to create a false activity hit.
        text = (
            'На объекте зафиксировано 460 нарушений пожарной безопасности. '
            'В школах проходят тренировки по алгоритмам действий при угрозе БПЛА.'
        )
        self.assertIsNone(uav_activity_kind(text))
        # An official local post explicitly reporting a UAV remains visible even
        # if it uses wording outside the current operational regex families.
        self.assertEqual(uav_activity_kind('В районе сообщается о БПЛА.'), 'official_uav_activity')
    def test_v13_mixed_missile_clear_uav_continues(self):
        mixed = (
            'Режим «Ракетная опасность» на территории Республики Татарстан отменен. '
            'Он был введен сегодня рано утром. '
            'Режим «Беспилотная опасность» сохраняется.'
        )
        self.assertEqual(text_kind(mixed), 'start')
        self.assertEqual(missile_text_kind(mixed), 'end')

        cfg = json.loads((ROOT / 'data' / 'sources.json').read_text(encoding='utf-8'))
        source = next(s for s in cfg['sources'] if s['channel'] == 'nashtatarstan_official')
        posts = [
            Post('nashtatarstan_official', 9401, datetime(2026,9,20,1,0,tzinfo=timezone.utc),
                 'В Татарстане введен режим «Ракетная опасность».', 'https://t.me/x/9401'),
            Post('nashtatarstan_official', 9402, datetime(2026,9,20,1,5,tzinfo=timezone.utc),
                 'В Татарстане введен режим «Беспилотная опасность».', 'https://t.me/x/9402'),
            Post('nashtatarstan_official', 9403, datetime(2026,9,20,2,0,tzinfo=timezone.utc),
                 mixed, 'https://t.me/x/9403'),
        ]
        events, unmatched = pair_alerts(
            posts, source,
            datetime(2026,9,20,0,0,tzinfo=timezone.utc),
            datetime(2026,9,21,0,0,tzinfo=timezone.utc),
        )
        self.assertEqual(len([e for e in events if e.get('threat_class') == 'missile']), 1)
        self.assertEqual(len([e for e in events if e.get('threat_class') == 'uav']), 0)
        self.assertTrue(any(u.get('type') == 'unmatched_start' and u.get('threat_class') == 'uav' for u in unmatched))
    def test_v13_shot_down_russian_inflections(self):
        self.assertEqual(missile_activity_kind('ПВО сбила ракету над территорией области.'), 'air_defense_action')
        self.assertEqual(missile_activity_kind('Ракета сбита силами ПВО.'), 'air_defense_action')
        self.assertEqual(uav_activity_kind('ПВО сбили два БПЛА над областью.'), 'air_defense_action')
        self.assertEqual(uav_activity_kind('БПЛА сбиты силами ПВО.'), 'air_defense_action')
    def test_v13_missile_activity_and_formal_pairing(self):
        self.assertEqual(missile_text_kind('В регионе объявлена ракетная опасность.'), 'start')
        self.assertEqual(missile_text_kind('Отбой ракетной опасности.'), 'end')
        self.assertEqual(missile_activity_kind('ПВО сбила ракету над территорией области.'), 'air_defense_action')
        self.assertEqual(missile_activity_kind('Обломки ракеты упали в городе.'), 'impact_or_debris')
        self.assertIsNone(missile_activity_kind('Обсудили производство ракетных комплексов.'))

        source = dict(self.source)
        posts = [
            Post('gov', 9101, datetime(2026,9,20,1,0,tzinfo=timezone.utc),
                 'В Белгородской области объявлена ракетная опасность.', 'https://t.me/x/9101'),
            Post('gov', 9102, datetime(2026,9,20,2,0,tzinfo=timezone.utc),
                 'Отбой ракетной опасности в Белгородской области.', 'https://t.me/x/9102'),
        ]
        events, _ = pair_alerts(
            posts, source,
            datetime(2026,9,20,0,0,tzinfo=timezone.utc),
            datetime(2026,9,21,0,0,tzinfo=timezone.utc),
        )
        missile = [e for e in events if e.get('threat_class') == 'missile']
        self.assertEqual(len(missile), 1)
        self.assertEqual(missile[0]['alert_type'], 'missile_alert')

    def test_v13_missile_unpaired_signal_is_retained(self):
        source = dict(self.source)
        posts = [Post('gov', 9201, datetime(2026,9,20,1,0,tzinfo=timezone.utc),
                      'Над Белгородом ПВО уничтожила ракету, обломки упали на окраине.', 'https://t.me/x/9201')]
        reports = extract_reports(
            posts, source,
            datetime(2026,9,20,0,0,tzinfo=timezone.utc),
            datetime(2026,9,21,0,0,tzinfo=timezone.utc),
        )
        missile = [r for r in reports if r.get('threat_class') == 'missile']
        self.assertTrue(missile)
        self.assertEqual(missile[0]['signal_class'], 'missile_activity_signal')

    def test_v13_local_mod_summary_with_region_context_is_retained(self):
        from collector.collect import mod_derived
        cfg = json.loads((ROOT / 'data' / 'sources.json').read_text(encoding='utf-8'))
        source = next(s for s in cfg['sources'] if s['channel'] == 'rgn_34')
        local = Post('rgn_34', 9301, datetime(2026,9,20,1,0,tzinfo=timezone.utc),
                     'По данным Минобороны России, над территорией Волгоградской области уничтожены БПЛА.',
                     'https://t.me/x/9301')
        generic = Post('rgn_34', 9302, datetime(2026,9,20,2,0,tzinfo=timezone.utc),
                       'По данным Минобороны России уничтожены БПЛА в нескольких регионах.',
                       'https://t.me/x/9302')
        self.assertFalse(mod_derived(local, source))
        self.assertTrue(mod_derived(generic, source))

    def test_v12_zero_post_public_html_is_not_fake_success(self):
        fetched = FetchResult(
            posts=[], transport='telegram_public_html', transport_ok=False,
            window_complete=False, error='public Telegram page returned zero parseable messages'
        )
        row = source_status_row(
            'telegram', 'tmbcan', 'Tambov Oblast', fetched, [], [],
            {'alert_posts': 0, 'start_posts': 0, 'end_posts': 0, 'activity_posts': 0}
        )
        self.assertFalse(row['ok'])
        self.assertEqual(row['health'], 'failed')
        self.assertEqual(row['posts'], 0)

    def test_v12_authenticated_complete_zero_post_window_can_be_quiet(self):
        fetched = FetchResult(
            posts=[], transport='telegram_mtproto', transport_ok=True,
            window_complete=True
        )
        row = source_status_row(
            'telegram', 'example', 'Example Oblast', fetched, [], [],
            {'alert_posts': 0, 'start_posts': 0, 'end_posts': 0, 'activity_posts': 0}
        )
        self.assertTrue(row['ok'])
        self.assertEqual(row['health'], 'quiet')

    def test_v10_countless_multi_place_activity_is_retained(self):
        source = dict(self.source)
        source['_catalog_places'] = [
            {'name':'Alpha','label':'Альфа','type':'city','lat':50,'lon':36,'aliases':['альфа','альфе']},
            {'name':'Beta','label':'Бета','type':'city','lat':51,'lon':37,'aliases':['бета','бете']},
        ]
        posts = [Post('gov', 1, datetime(2026,9,20,1,0,tzinfo=timezone.utc),
                      'БПЛА замечены в Альфе и Бете, ПВО работает.', 'https://t.me/gov/1')]
        reports = extract_reports(posts, source, datetime(2026,9,20,0,0,tzinfo=timezone.utc), datetime(2026,9,21,0,0,tzinfo=timezone.utc))
        self.assertEqual(len(reports), 1)
        names = {p['name'] for p in reports[0]['mentioned_places']}
        self.assertEqual(names, {'Alpha','Beta'})

if __name__ == "__main__":
    unittest.main()
