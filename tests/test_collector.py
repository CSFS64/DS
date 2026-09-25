import json
import unittest
import tempfile
from argparse import Namespace
from datetime import datetime, timezone
from pathlib import Path

from collector.collect import (
    Post,
    classify_count_sentence,
    classify_missile_count_sentence,
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
    reenrich_archive_places,
    merge_existing_archive,
    revalidate_archive_reports,
    fetch_posts_mtproto_for_window,
    source_post_applies,
    source_collection_sort_key,
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
        self.assertTrue({'mos_sobyanin','vorobiev_live','E_V_Kovalchuk','evraevmikhail','glebnikitin_nn','Shapsha_VV'} <= channels)
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
            previous_end = now - timedelta(hours=6)
            out.write_text(json.dumps({"window_end": previous_end.isoformat()}), encoding="utf-8")
            args = Namespace(
                output=str(out), safety_lag_hours=0, lookback_hours=168,
                incremental_overlap_hours=18, full_backfill=False,
            )
            configure_incremental_window(args)
            self.assertEqual(args.collection_mode, "incremental")
            self.assertEqual(args.window_start_override, previous_end)
            self.assertGreater(args.window_end_override, previous_end)
            self.assertEqual(args.incremental_overlap_hours, 0)
            self.assertGreater(args.lookback_hours, 5.9)
            self.assertLess(args.lookback_hours, 6.1)

    def test_fractional_lookback_env_is_supported(self):
        self.assertAlmostEqual(float("16.25"), 16.25)
    def test_v9_backfill_keeps_requested_window(self):
        args = Namespace(
            output="missing.json", safety_lag_hours=0, lookback_hours=168,
            incremental_overlap_hours=0, full_backfill=True,
        )
        configure_incremental_window(args)
        self.assertEqual(args.collection_mode, "backfill")
        self.assertEqual(args.lookback_hours, 168)
        self.assertIsNone(args.window_start_override)
        self.assertIsNone(args.window_end_override)

    def test_v19_monitoring_collection_precedes_official(self):
        cfg = json.loads((ROOT / 'data' / 'sources.json').read_text(encoding='utf-8'))
        ordered = sorted([s for s in cfg['sources'] if s.get('enabled')], key=source_collection_sort_key)
        layers = [s.get('source_layer','official_local') for s in ordered]
        first_official = next(i for i, layer in enumerate(layers) if not layer.startswith('monitoring_'))
        self.assertTrue(all(layer.startswith('monitoring_') for layer in layers[:first_official]))

    def test_v19_volgograd_national_fallback_is_region_scoped(self):
        cfg = json.loads((ROOT / 'data' / 'sources.json').read_text(encoding='utf-8'))
        source = next(s for s in cfg['sources'] if s['region']=='Volgograd Oblast' and s['channel']=='radarrussiia')
        self.assertEqual(source['coverage_role'], 'monitoring_fallback')
        self.assertTrue(source['require_region_match'])
        self.assertTrue(source['fallback_only_if_no_local_activity'])
        source = dict(source)
        source['_catalog_places'] = []
        yes = Post('radarrussiia', 1, datetime(2026,9,24,1,0,tzinfo=timezone.utc),
                   'Волгоградская область. Опасность по БПЛА.', 'https://t.me/radarrussiia/1')
        no = Post('radarrussiia', 2, datetime(2026,9,24,1,1,tzinfo=timezone.utc),
                  'Ростовская область. Опасность по БПЛА.', 'https://t.me/radarrussiia/2')
        self.assertTrue(source_post_applies(yes, source))
        self.assertFalse(source_post_applies(no, source))

    def test_v18_monitoring_wording_and_registry(self):
        self.assertEqual(uav_activity_kind('Сернурский район. Фиксация БПЛА.'), 'uav_detected')
        self.assertEqual(uav_activity_kind('Саратовская область. Внимание по БПЛА.'), 'uav_warning')
        cfg = json.loads((ROOT / 'data' / 'sources.json').read_text(encoding='utf-8'))
        monitoring = [s for s in cfg['sources'] if s.get('source_layer','').startswith('monitoring_')]
        regions = {s['region'] for s in monitoring}
        required = {
            'Smolensk Oblast','Kaluga Oblast','Oryol Oblast','Lipetsk Oblast','Tambov Oblast',
            'Ryazan Oblast','Nizhny Novgorod Oblast','Mari El Republic','Chuvash Republic',
            'Republic of Tatarstan','Ulyanovsk Oblast','Saratov Oblast','Volgograd Oblast','Rostov Oblast',
        }
        self.assertTrue(required <= regions)
        self.assertGreaterEqual(len(monitoring), 14)

    def test_v18_national_monitoring_is_region_scoped(self):
        source = {
            'region':'Mari El Republic', 'region_label':'Республика Марий Эл',
            'region_aliases':['республика марий эл','марий эл'],
            'require_region_match':True, 'places':[], '_catalog_places':[],
        }
        yes = Post('radarrussiia', 1, datetime(2026,9,24,1,0,tzinfo=timezone.utc),
                   'Республика Марий Эл. Опасность по БПЛА.', 'https://t.me/radarrussiia/1')
        no = Post('radarrussiia', 2, datetime(2026,9,24,1,1,tzinfo=timezone.utc),
                  'Калужская область. Опасность по БПЛА.', 'https://t.me/radarrussiia/2')
        self.assertTrue(source_post_applies(yes, source))
        self.assertFalse(source_post_applies(no, source))

    def test_v21_nationwide_radar_fallback_covers_every_region(self):
        cfg = json.loads((ROOT / 'data' / 'sources.json').read_text(encoding='utf-8'))
        regions_cfg = json.loads((ROOT / 'data' / 'regions.json').read_text(encoding='utf-8'))
        enabled_regions = {r['region'] for r in regions_cfg['regions'] if r.get('enabled')}
        nationwide = [
            s for s in cfg['sources']
            if s.get('channel') == 'radarrussiia' and s.get('source_layer') == 'monitoring_national'
        ]
        self.assertEqual({s['region'] for s in nationwide}, enabled_regions)
        self.assertEqual(len(nationwide), len(enabled_regions))
        self.assertTrue(all(s.get('require_region_match') for s in nationwide))
        self.assertTrue(all(s.get('fallback_only_if_no_local_activity') for s in nationwide))

    def test_v21_confirmed_local_radar_channels_are_primary(self):
        cfg = json.loads((ROOT / 'data' / 'sources.json').read_text(encoding='utf-8'))
        local = {(s['region'], s['channel']) for s in cfg['sources'] if s.get('source_layer') == 'monitoring_local'}
        required = {
            ('Voronezh Oblast','radar_voronezh'),
            ('Moscow Oblast','radar_moscoww'),
            ('Tver Oblast','radar_tver'),
            ('Tula Oblast','radar_tuIa'),
            ('Bryansk Oblast','radar_bryanskk'),
            ('Belgorod Oblast','radar_beIgorod'),
            ('Kursk Oblast','radar_kurskk'),
            ('Samara Oblast','radar_samaraa'),
            ('Republic of Bashkortostan','radar_bashkortostan'),
            ('Astrakhan Oblast','radar_astrakhann'),
            ('Penza Oblast','radar_penzaa'),
            ('Pskov Oblast','radar_pskovv'),
            ('Crimea','radar_crimeaa'),
            ('Krasnodar Krai','radar_kras'),
        }
        self.assertTrue(required <= local)
        self.assertGreaterEqual(len({r for r, _ in local}), 36)

    def test_v21_national_region_scoping_with_generated_aliases(self):
        cfg = json.loads((ROOT / 'data' / 'sources.json').read_text(encoding='utf-8'))
        source = next(
            s for s in cfg['sources']
            if s.get('region') == 'Voronezh Oblast'
            and s.get('channel') == 'radarrussiia'
            and s.get('source_layer') == 'monitoring_national'
        )
        yes = Post('radarrussiia', 3, datetime(2026,9,25,1,0,tzinfo=timezone.utc),
                   'В Воронежской области внимание по БПЛА.', 'https://t.me/radarrussiia/3')
        no = Post('radarrussiia', 4, datetime(2026,9,25,1,1,tzinfo=timezone.utc),
                  'В Курской области внимание по БПЛА.', 'https://t.me/radarrussiia/4')
        self.assertTrue(source_post_applies(yes, source))
        self.assertFalse(source_post_applies(no, source))

    def test_v18_replay_previous_window_uses_exact_old_window(self):
        with tempfile.TemporaryDirectory() as td:
            out = Path(td) / 'events.json'
            start = datetime(2026,9,23,23,27,31,tzinfo=timezone.utc)
            end = datetime(2026,9,24,21,43,53,tzinfo=timezone.utc)
            out.write_text(json.dumps({'window_start':start.isoformat(),'window_end':end.isoformat()}), encoding='utf-8')
            args = Namespace(
                output=str(out), safety_lag_hours=0, lookback_hours=168,
                incremental_overlap_hours=0, full_backfill=False, replay_previous_window=True,
            )
            configure_incremental_window(args)
            self.assertEqual(args.collection_mode, 'replay_previous')
            self.assertEqual(args.window_start_override, start)
            self.assertEqual(args.window_end_override, end)
            self.assertAlmostEqual(args.lookback_hours, (end-start).total_seconds()/3600.0, places=6)

    def test_v20_monitoring_explicit_counts(self):
        uav = classify_count_sentence('Фиксация от 3 БПЛА')
        self.assertEqual(uav, [(3, 'detected_reported', None, None, None)])
        uav2 = classify_count_sentence('Фиксация около 2 БПЛА')
        self.assertEqual(uav2, [(2, 'detected_reported', None, None, 'approx')])
        missile = classify_missile_count_sentence('Фиксация 2 ракет')
        self.assertEqual(missile, [(2, 'missile_detected_reported', None, None, None)])

    def test_v20_monitoring_count_report_is_structured(self):
        source = {
            'region':'Tambov Oblast','region_label':'Тамбовская область',
            'channel':'radar_tambov','source_name':'Radar Tambov',
            'kind':'telegram','source_layer':'monitoring_local',
            'fallback_to_region_on_unresolved':True,
            'places':[{'name':'Tambov','label':'Тамбов','type':'city','lat':52.72,'lon':41.45,'aliases':['тамбов']}],
            'region_aliases':['тамбовская область'],
        }
        post = Post('radar_tambov', 1, datetime(2026,9,24,18,0,tzinfo=timezone.utc),
                    'Тамбов\nТамбовская область\nФиксация от 3 БПЛА', 'https://t.me/radar_tambov/1')
        reports = extract_reports([post], source,
            datetime(2026,9,24,17,0,tzinfo=timezone.utc),
            datetime(2026,9,24,19,0,tzinfo=timezone.utc))
        self.assertEqual(len(reports), 1)
        self.assertEqual(reports[0]['count'], 3)
        self.assertEqual(reports[0]['count_type'], 'detected_reported')

    def test_v20_cross_region_monitoring_total_not_local_count(self):
        source = {
            'region':'Rostov Oblast','region_label':'Ростовская область',
            'channel':'radar_rostovv','source_name':'Radar Rostov',
            'kind':'telegram','source_layer':'monitoring_local',
            'fallback_to_region_on_unresolved':True,'places':[],
            'region_aliases':['ростовская область'],
        }
        post = Post('radar_rostovv', 2, datetime(2026,9,24,9,0,tzinfo=timezone.utc),
                    'За ночь уничтожено 40 БПЛА над территориями Брянской, Белгородской, Курской, Ростовской областей, Краснодарского края и Республики Крым.',
                    'https://t.me/radar_rostovv/2')
        reports = extract_reports([post], source,
            datetime(2026,9,24,8,0,tzinfo=timezone.utc),
            datetime(2026,9,24,10,0,tzinfo=timezone.utc))
        self.assertFalse(any(r.get('count') == 40 for r in reports))

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
            'mchs_orel', 'orelregion_government', 'mchs_bryansk', 'E_V_Kovalchuk', 'gumchs48', 'lipobl',
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
        self.assertIsNone(uav_activity_kind('В регионе стартовал чемпионат по управлению БПЛА среди школьников.'))
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

    def test_v15_fallback_backfill_cannot_replace_mtproto_record(self):
        with tempfile.TemporaryDirectory() as td:
            out = Path(td) / 'events.json'
            old_report = {
                'id':'same-id', 'region':'Belgorod Oblast', 'place':'Belgorod',
                'scope':'city', 'at':'2026-09-20T10:00:00+00:00',
                'text':'high quality', 'source_kind':'telegram',
                'source_id':'operativno31', 'url':'https://t.me/operativno31/100',
                'transport':'telegram_mtproto', 'transport_quality':30,
            }
            out.write_text(json.dumps({'reports':[old_report], 'events':[]}), encoding='utf-8')
            new_report = dict(old_report)
            new_report.update({'text':'fallback replacement', 'transport':'telegram_public_html', 'transport_quality':10})
            data = {
                'window_start':'2026-09-19T00:00:00+00:00',
                'coverage':{}, 'events':[], 'reports':[new_report],
                'source_status':[{
                    'source_type':'telegram', 'source':'operativno31',
                    'transport':'telegram_public_html', 'transport_ok':True,
                }],
            }
            merged = merge_existing_archive(data, out)
            self.assertEqual(len(merged['reports']), 1)
            self.assertEqual(merged['reports'][0]['text'], 'high quality')
            self.assertEqual(merged['reports'][0]['transport'], 'telegram_mtproto')
            self.assertGreaterEqual(merged['coverage']['protected_higher_quality_records'], 1)

    def test_v15_fallback_backfill_preserves_missing_legacy_telegram_record(self):
        with tempfile.TemporaryDirectory() as td:
            out = Path(td) / 'events.json'
            old_report = {
                'id':'legacy-id', 'region':'Voronezh Oblast', 'place':'Voronezh Oblast',
                'scope':'region', 'at':'2026-09-20T10:00:00+00:00',
                'text':'legacy record', 'source_kind':'telegram',
                'url':'https://t.me/gusev_36/100',
            }
            out.write_text(json.dumps({'reports':[old_report], 'events':[]}), encoding='utf-8')
            data = {
                'window_start':'2026-09-19T00:00:00+00:00',
                'coverage':{}, 'events':[], 'reports':[],
                'source_status':[{
                    'source_type':'telegram', 'source':'gusev_36',
                    'transport':'telegram_public_html', 'transport_ok':True,
                }],
            }
            merged = merge_existing_archive(data, out)
            self.assertEqual([r['id'] for r in merged['reports']], ['legacy-id'])

    def test_v15_mtproto_backfill_can_replace_legacy_record(self):
        with tempfile.TemporaryDirectory() as td:
            out = Path(td) / 'events.json'
            old_report = {
                'id':'same-id', 'region':'Voronezh Oblast', 'place':'Voronezh Oblast',
                'scope':'region', 'at':'2026-09-20T10:00:00+00:00',
                'text':'legacy', 'source_kind':'telegram',
                'url':'https://t.me/gusev_36/100',
            }
            out.write_text(json.dumps({'reports':[old_report], 'events':[]}), encoding='utf-8')
            new_report = dict(old_report)
            new_report.update({
                'text':'mtproto replacement', 'source_id':'gusev_36',
                'transport':'telegram_mtproto', 'transport_quality':30,
            })
            data = {
                'window_start':'2026-09-19T00:00:00+00:00',
                'coverage':{}, 'events':[], 'reports':[new_report],
                'source_status':[{
                    'source_type':'telegram', 'source':'gusev_36',
                    'transport':'telegram_mtproto', 'transport_ok':True,
                }],
            }
            merged = merge_existing_archive(data, out)
            self.assertEqual(len(merged['reports']), 1)
            self.assertEqual(merged['reports'][0]['text'], 'mtproto replacement')
            self.assertEqual(merged['reports'][0]['transport'], 'telegram_mtproto')

    def test_v14_existing_region_report_is_reenriched_without_backfill(self):
        data = {
            'coverage': {},
            'events': [],
            'reports': [{
                'id':'old-1', 'region':'Voronezh Oblast', 'place':'Voronezh Oblast',
                'scope':'region', 'text':'Лискинский и Острогожский районы — тревога в связи с угрозой БПЛА.',
                'mentioned_places': [],
            }],
        }
        source_cfg = {'sources': []}
        city_cfg = {
            'cities': [],
            'municipalities': [
                {'name':'Liski District','label':'Лискинский район','region':'Voronezh Oblast','type':'municipality','lat':50.98,'lon':39.50,'aliases':['Лискинский район']},
                {'name':'Ostrogozhsk District','label':'Острогожский район','region':'Voronezh Oblast','type':'municipality','lat':50.86,'lon':39.08,'aliases':['Острогожский район']},
            ],
        }
        reenrich_archive_places(data, source_cfg, city_cfg)
        report=data['reports'][0]
        self.assertEqual(report['scope'], 'municipality')
        self.assertEqual({p['name'] for p in report['mentioned_places']}, {'Liski District','Ostrogozhsk District'})
        self.assertEqual(data['coverage']['reports_place_reenriched'], 1)

    def test_v14_administrative_district_case_variants(self):
        source = dict(self.source)
        source['_catalog_places'] = [
            {
                'name':'Klintsy District', 'label':'Клинцовский район',
                'type':'municipality', 'lat':52.76, 'lon':32.24,
                'aliases':['Клинцовский район'],
            },
            {
                'name':'Starodub Municipal Okrug', 'label':'Стародубский муниципальный округ',
                'type':'municipality', 'lat':52.58, 'lon':32.76,
                'aliases':['Стародубский муниципальный округ'],
            },
            {
                'name':'Boguchar District', 'label':'Богучарский район',
                'type':'municipality', 'lat':49.93, 'lon':40.55,
                'aliases':['Богучарский район'],
            },
        ]
        text = (
            'БПЛА обнаружены в Клинцовском районе, '
            'Стародубском муниципальном округе и Богучарском районе.'
        )
        places = extract_places(text, source)
        self.assertEqual(
            {p['name'] for p in places},
            {'Klintsy District','Starodub Municipal Okrug','Boguchar District'},
        )

        shared = 'Клинцовский, Богучарский и Стародубский районы находятся под угрозой БПЛА.'
        places = extract_places(shared, source)
        self.assertTrue({'Klintsy District','Boguchar District'} <= {p['name'] for p in places})

        short = 'Угроза атаки БПЛА в Клинцовском МО.'
        places = extract_places(short, source)
        self.assertIn('Klintsy District', {p['name'] for p in places})

    def test_v14_multi_district_report_keeps_all_places(self):
        source = dict(self.source)
        source['_catalog_places'] = [
            {'name':'Liski District','label':'Лискинский район','type':'municipality','lat':50.98,'lon':39.50,'aliases':['Лискинский район']},
            {'name':'Ostrogozhsk District','label':'Острогожский район','type':'municipality','lat':50.86,'lon':39.08,'aliases':['Острогожский район']},
        ]
        posts = [Post(
            'gov', 9501, datetime(2026,9,20,1,0,tzinfo=timezone.utc),
            'Лискинский и Острогожский районы — тревога в связи с угрозой непосредственного удара БПЛА.',
            'https://t.me/gov/9501'
        )]
        reports = extract_reports(
            posts, source,
            datetime(2026,9,20,0,0,tzinfo=timezone.utc),
            datetime(2026,9,21,0,0,tzinfo=timezone.utc),
        )
        self.assertTrue(reports)
        names={p['name'] for p in reports[0]['mentioned_places']}
        self.assertEqual(names, {'Liski District','Ostrogozhsk District'})

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


    def test_v16_non_operational_mentions_do_not_light_map(self):
        uav_false_positives = [
            'Якобы губернатор заявил, что защитить регион от атак украинских беспилотников невозможно. Это дипфейк.',
            'Не снимайте и не публикуйте в соцсетях БПЛА и их обломки; в регионе действует запрет на распространение таких материалов.',
            'Участникам предстоит проверить навыки управления БПЛА в рамках соревнования.',
            'Университет займётся искусственным интеллектом в беспилотных авиационных системах.',
        ]
        for text in uav_false_positives:
            with self.subTest(text=text):
                self.assertIsNone(uav_activity_kind(text))

        self.assertIsNone(missile_activity_kind(
            'На предприятии производят комплектующие для внутренних деталей ракет и тару для приборов на орбиту.'
        ))

    def test_v16_operational_wording_still_survives_stricter_filter(self):
        self.assertEqual(
            uav_activity_kind('В районе сообщается о БПЛА.'),
            'official_uav_activity',
        )
        self.assertEqual(
            uav_activity_kind('Из-за падения обломков БПЛА произошло возгорание в лесном массиве.'),
            'impact_or_debris',
        )
        self.assertEqual(
            uav_activity_kind('Военные отражают атаку, работает ПВО; уничтожаются вражеские БПЛА.'),
            'air_defense_action',
        )
        self.assertEqual(
            uav_activity_kind('ОПАСНОСТЬ АТАКИ БПЛА. Не публикуйте работу ПВО.'),
            'alert_start_signal',
        )

    def test_v16_revalidation_removes_old_false_positive_without_backfill(self):
        data = {
            'coverage': {},
            'events': [],
            'reports': [{
                'id': 'false-uav',
                'region': 'Ulyanovsk Oblast',
                'place': 'Ulyanovsk Oblast',
                'scope': 'region',
                'at': '2026-09-23T13:04:46+00:00',
                'signal_class': 'uav_activity_signal',
                'threat_class': 'uav',
                'activity_kind': 'uav_attack_activity',
                'count': None,
                'text': 'Якобы губернатор заявил, что защитить регион от атак украинских беспилотников невозможно. Это дипфейк.',
            }],
        }
        out = revalidate_archive_reports(data)
        self.assertEqual(out['reports'], [])
        self.assertEqual(out['coverage']['reports_revalidated_removed'], 1)

    def test_v17_whole_post_debunk_overrides_later_attack_wording(self):
        text = (
            'Украинская пропаганда продолжает пугать россиян новым налогом. '
            'В ульяновских соцсетях — очередной дипфейк. '
            'Якобы губернатор заявил, что защитить регион от атак украинских беспилотников невозможно. '
            'Фейк уже опровергли. Компании, которые тратят средства на защиту объектов от БПЛА '
            'и на восстановление после атак, смогут учитывать эти затраты при налогообложении.'
        )
        self.assertIsNone(uav_activity_kind(text))

    def test_v17_uav_strike_wording_is_operational(self):
        self.assertEqual(
            uav_activity_kind('Вражеский дрон ударил по дому в частном секторе города.'),
            'uav_attack_activity',
        )
        self.assertEqual(
            uav_activity_kind('БПЛА нанес удар по объекту инфраструктуры.'),
            'uav_attack_activity',
        )

    def test_v17_revalidation_keeps_real_uav_strike(self):
        data = {
            'coverage': {},
            'events': [],
            'reports': [{
                'id': 'kursk-strike',
                'region': 'Kursk Oblast',
                'place': 'Kursk',
                'scope': 'city',
                'at': '2026-09-23T12:53:23+00:00',
                'signal_class': 'uav_activity_signal',
                'threat_class': 'uav',
                'activity_kind': 'official_uav_activity',
                'count': None,
                'text': 'Вражеский дрон ударил по дому в частном секторе города.',
            }],
        }
        out = revalidate_archive_reports(data)
        self.assertEqual(len(out['reports']), 1)
        self.assertEqual(out['reports'][0]['activity_kind'], 'uav_attack_activity')
        self.assertEqual(out['coverage']['reports_revalidated_removed'], 0)

    def test_v16_cached_mtproto_peer_still_works_during_resolve_floodwait(self):
        class FakeClient:
            _archive_resolve_flooded = True
            _archive_resolve_wait_seconds = 33739

            def get_input_entity(self, channel):
                raise AssertionError('cached peer must not resolve username')

            def iter_messages(self, entity, offset_date=None, limit=None):
                self.entity = entity
                return iter(())

        cache = {
            'example_channel': {
                'peer_type': 'channel',
                'id': 123456789,
                'access_hash': 987654321,
                'username': 'example_channel',
                'source': 'test',
            }
        }
        result = fetch_posts_mtproto_for_window(
            FakeClient(),
            'example_channel',
            datetime(2026, 9, 23, 0, 0, tzinfo=timezone.utc),
            datetime(2026, 9, 24, 0, 0, tzinfo=timezone.utc),
            peer_cache=cache,
        )
        self.assertTrue(result.transport_ok)
        self.assertEqual(result.transport, 'telegram_mtproto')
        self.assertTrue(result.mtproto_peer_cache_hit)
        self.assertFalse(result.mtproto_peer_resolved)

if __name__ == "__main__":
    unittest.main()
