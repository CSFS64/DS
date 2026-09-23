#!/usr/bin/env python3
"""Collect delayed historical UAV-alert records from official local sources.

Sources are deliberately separated into two layers:
  1. High-resolution official local Telegram channels configured in data/sources.json.
  2. A nationwide region-level fallback using the official regional MChS RSS feeds
     configured in data/regions.json. RSS is treated as a fallback/diagnostic layer,
     not as proof that every MChS mobile-app push is mirrored to the website feed.

The collector enforces a minimum 24-hour archive lag. It never acts as a live alert
monitor. START/END alerts are paired conservatively; if a valid official alert cannot
be resolved to a configured city/municipality, it can be retained at parent-region
precision rather than silently dropped.
"""
from __future__ import annotations

import argparse
import hashlib
import html as html_lib
import json
import os
import re
import sys
import time
from concurrent.futures import ThreadPoolExecutor, as_completed
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from email.utils import parsedate_to_datetime
from pathlib import Path
from typing import Any
from xml.etree import ElementTree as ET

import requests
from requests.adapters import HTTPAdapter
from urllib3.util.retry import Retry
from bs4 import BeautifulSoup

ROOT = Path(__file__).resolve().parents[1]
DEFAULT_SOURCES = ROOT / "data" / "sources.json"
DEFAULT_REGIONS = ROOT / "data" / "regions.json"
DEFAULT_CITIES = ROOT / "data" / "cities.json"
DEFAULT_OUTPUT = ROOT / "data" / "events.json"

USER_AGENT = (
    "DeepstrikeArchive/3.0 (+https://github.com/; historical archive; 24h+ lag) "
    "requests/2"
)

START_MARKERS = (
    "опасность атаки бпла",
    "беспилотная опасность",
    "угроза атаки бпла",
    "угроза непосредственного удара бпла",
    "тревога в связи с угрозой непосредственного удара бпла",
    "режим атака бпла",
    "угроза беспилотной атаки",
    "опасность бпла",
    "воздушная опасность",
    "режим воздушная опасность",
    "угроза подлета бпла",
    "угроза подлета беспилотников",
    "опасное небо",
)
END_MARKERS = (
    "отбой опасности атаки бпла",
    "отбой беспилотной опасности",
    "отбой опасности бпла",
    "отмена непосредственной опасности атаки бпла",
    "отмена непосредственной угрозы",
    "отбой угрозы атаки бпла",
    "снята угроза атаки беспилотных воздушных средств",
    "отмена сигнала опасность атаки бпла",
    "отменен сигнал опасность атаки бпла",
    "отменена опасность атаки бпла",
    "отбой воздушной опасности",
    "отбой режима воздушная опасность",
    "отбой сигнала опасное небо",
    "отмена сигнала опасное небо",
)

# Regional authorities use many word orders for the same clear message.  These
# regexes intentionally focus on the UAV-danger phrase and clear verbs, rather
# than relying on one exact template.
END_PATTERNS = tuple(re.compile(p) for p in (
    r"\bотбой\b.{0,80}\b(?:беспилотн\w*|бпла)\b",
    r"\b(?:снят|снята|снято|сняты|отменен|отменена|отменено|отменены|отмена)\b.{0,100}\bбеспилотн\w*\s+опасност\w*",
    r"\bбеспилотн\w*\s+опасност\w*.{0,100}\b(?:снят|снята|снято|сняты|отменен|отменена|отменено|отменены)\b",
    r"\b(?:снят|снята|отменен|отменена)\b.{0,100}\bугроз\w*\s+атак\w*\s+(?:бпла|беспилотн\w*)",
    r"\bотмен\w*\b.{0,70}\bсигнал\w*.{0,50}\bопасност\w*\s+атак\w*\s+бпла\b",
    r"\bугроз\w*\s+атак\w*\s+(?:бпла|беспилотн\w*).{0,100}\b(?:снят|снята|отменен|отменена)\b",
    r"\bугроз\w*\s+(?:снят|снята|снято|отменен|отменена|отменено)\b",
    r"\b(?:снят|снята|снято|отменен|отменена|отменено)\b.{0,50}\bугроз\w*\b",
    r"\bотбой\b.{0,70}\bвоздушн\w*\s+опасност\w*",
    r"\b(?:снят|отменен|отбой)\w*\b.{0,70}\bопасн\w*\s+неб\w*",
    r"\bотбой\b.{0,90}\bугроз\w*.{0,35}\bподлет\w*.{0,35}\b(?:бпла|беспилотн\w*)\b",
    r"\b(?:снят|снята|отменен|отменена|отбой)\w*\b.{0,100}\bвоздушн\w*\s+опасност\w*",
))
START_PATTERNS = tuple(re.compile(p) for p in (
    r"\b(?:объявлен\w*|введен\w*|действует|сохраняется)\b.{0,110}\bбеспилотн\w*\s+опасност\w*",
    r"\b(?:объявлен\w*|введен\w*|действует|сохраняется)\b.{0,110}\bвоздушн\w*\s+опасност\w*",
    r"\b(?:опасност\w*|угроз\w*)\s+атак\w*\s+(?:бпла|беспилотн\w*)\b",
    r"\bугроз\w*\s+беспилотн\w*\s+атак\w*\b",
    r"\bопасност\w*\s+(?:бпла|беспилотн\w*)\b",
    r"\bрежим\s+атака\s+бпла\b",
    r"\bтревог\w*.{0,80}\b(?:бпла|беспилотн\w*)\b",
    r"\bугроз\w*.{0,30}\bподлет\w*.{0,30}\b(?:бпла|беспилотн\w*)\b",
    r"\b(?:объявлен\w*|введен\w*|действует|сохраняется)\b.{0,80}\bопасн\w*\s+неб\w*",
))

# Broad historical-activity classifier.  Official regional channels use far more
# wording than formal START/END templates.  We therefore keep any post that has
# a clear UAV reference plus operational context as a point-in-time signal.  It
# is displayed as activity unless a paired formal alert provides a real interval.
UAV_REFERENCE_PATTERNS = tuple(re.compile(p) for p in (
    r"\bбпла\b",
    r"\bбеспилотн\w*\b",
    r"\bдрон\w*\b",
    r"\bбеспилотн\w*\s+(?:летательн\w*\s+аппарат\w*|воздушн\w*\s+(?:суд\w*|средств\w*|аппарат\w*))\b",
))

UAV_OPERATIONAL_PATTERNS = tuple(re.compile(p) for p in (
    # warnings / danger / threat
    r"\b(?:опасност\w*|угроз\w*|тревог\w*|опасн\w*\s+неб\w*)\b",
    r"\b(?:объявлен\w*|введен\w*|действует|сохраняется)\b.{0,100}\b(?:режим\w*|опасност\w*|угроз\w*)\b",
    # attack / approach / flight / detection
    r"\bатак\w*\b",
    r"\b(?:летит|летят|летел\w*|движ\w*|направля\w*|приближа\w*|подлета\w*|подлет\w*|пролет\w*|следу\w*)\b",
    r"\b(?:обнаруж\w*|зафиксир\w*|замеч\w*|выявл\w*|наблюда\w*|фиксиру\w*)\b",
    # air-defence / EW response
    r"\b(?:сбит\w*|уничтож\w*|перехват\w*|подав\w*|нейтрализ\w*|обезвреж\w*|ликвидир\w*)\b",
    r"\b(?:пво|рэб)\b.{0,80}\b(?:работа\w*|отража\w*|сбит\w*|уничтож\w*|подав\w*)\b",
    r"\b(?:работа\w*|отража\w*)\b.{0,80}\b(?:пво|рэб)\b",
    # impact / debris / incident
    r"\b(?:обломк\w*|падени\w*|прилет\w*|попадани\w*|взрыв\w*|поврежден\w*)\b",
    # restrictions explicitly tied to UAVs
    r"\b(?:ковер|ограничен\w*|закрыт\w*|приостанов\w*)\b",
))

NON_OPERATIONAL_UAV_PATTERNS = tuple(re.compile(p) for p in (
    r"\b(?:производств\w*|разработк\w*|изготовлен\w*|сборк\w*|закупк\w*|контракт\w*)\b",
    r"\b(?:выставк\w*|форум\w*|соревнован\w*|фестивал\w*|кружок\w*|обучен\w*|учебн\w*)\b",
    r"\b(?:сельскохозяйствен\w*|доставк\w*|аэрофотосъем\w*)\b",
))

def has_uav_reference(text: str) -> bool:
    n = normalize(text)
    return any(p.search(n) for p in UAV_REFERENCE_PATTERNS) or "опасное небо" in n


def uav_activity_kind(text: str) -> str | None:
    """Classify any clearly operational UAV wording from an official local source.

    This intentionally prioritizes recall for the delayed historical display.
    Formal alert START/END still use text_kind(); everything else is retained as
    a timestamped official signal instead of being silently discarded.
    """
    n = normalize(text)
    formal = text_kind(text)
    if formal == "start":
        return "alert_start_signal"
    if formal == "end":
        return "alert_end_signal"
    if not has_uav_reference(text):
        return None
    if any(p.search(n) for p in NON_OPERATIONAL_UAV_PATTERNS) and not any(p.search(n) for p in UAV_OPERATIONAL_PATTERNS):
        return None
    if not any(p.search(n) for p in UAV_OPERATIONAL_PATTERNS):
        return None
    if re.search(r"\b(?:обломк\w*|падени\w*|прилет\w*|попадани\w*|поврежден\w*)\b", n):
        return "impact_or_debris"
    if re.search(r"\b(?:сбит\w*|уничтож\w*|перехват\w*|подав\w*|нейтрализ\w*|обезвреж\w*)\b", n):
        return "air_defense_action"
    if re.search(r"\b(?:обнаруж\w*|зафиксир\w*|замеч\w*|выявл\w*|наблюда\w*)\b", n):
        return "uav_detected"
    if re.search(r"\b(?:летит|летят|движ\w*|направля\w*|приближа\w*|подлета\w*|подлет\w*|пролет\w*)\b", n):
        return "uav_movement"
    if re.search(r"\bатак\w*\b", n):
        return "uav_attack_activity"
    return "official_uav_activity"

REGION_PHRASES = (
    "на всей территории области",
    "на всей территории республики",
    "на всей территории края",
    "на всей территории автономного округа",
    "на территории региона",
    "на территории всего региона",
    "по всей области",
    "по всей республике",
    "по всему краю",
)
CLOSE_ALL_LOCAL_PHRASES = (
    "во всех муниципалитетах",
    "во всех муниципальных образованиях",
)
MOD_DERIVED_MARKERS = (
    "по данным минобороны",
    "сообщило минобороны",
    "минобороны россии сообщает",
    "министерство обороны сообщает",
    "официальное сообщение минобороны",
)


def make_session() -> requests.Session:
    session = requests.Session()
    retry = Retry(
        total=2,
        connect=2,
        read=2,
        backoff_factor=0.45,
        status_forcelist=(429, 500, 502, 503, 504),
        allowed_methods=frozenset({"GET"}),
        raise_on_status=False,
    )
    adapter = HTTPAdapter(max_retries=retry, pool_connections=16, pool_maxsize=16)
    session.mount("https://", adapter)
    session.mount("http://", adapter)
    session.headers.update({"User-Agent": USER_AGENT, "Accept-Language": "ru,en;q=0.8"})
    return session


@dataclass
class Post:
    channel: str
    post_id: str | int
    published_at: datetime
    text: str
    url: str
    forwarded_from: str | None = None

    @property
    def normalized(self) -> str:
        return normalize(self.text)


def normalize(text: str) -> str:
    value = str(text).lower().replace("ё", "е")
    # Normalize quote/dash/punctuation variants used by regional alert templates.
    value = re.sub(r"[«»„“”\"'`…,:;.!?()\[\]{}<>|/\\–—−-]+", " ", value)
    return " ".join(value.split())


def parse_iso(value: str) -> datetime:
    value = value.replace("Z", "+00:00")
    dt = datetime.fromisoformat(value)
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=timezone.utc)
    return dt.astimezone(timezone.utc)


def stable_id(*parts: str) -> str:
    raw = "|".join(parts).encode("utf-8")
    return hashlib.sha1(raw).hexdigest()[:16]


def strip_html(value: str) -> str:
    if not value:
        return ""
    return BeautifulSoup(html_lib.unescape(value), "html.parser").get_text(" ", strip=True)


# ---------------------------------------------------------------------------
# Telegram public-page collector
# ---------------------------------------------------------------------------

def fetch_page(session: requests.Session, channel: str, before: int | None = None) -> str:
    url = f"https://t.me/s/{channel}"
    if before:
        url += f"?before={before}"
    r = session.get(url, timeout=30)
    r.raise_for_status()
    return r.text


def parse_telegram_html(html: str, channel: str) -> list[Post]:
    soup = BeautifulSoup(html, "html.parser")
    posts: list[Post] = []
    for wrap in soup.select(".tgme_widget_message_wrap"):
        msg = wrap.select_one(".tgme_widget_message")
        if msg is None:
            continue
        data_post = msg.get("data-post", "")
        m = re.search(r"/(\d+)$", data_post)
        if not m:
            continue
        post_id = int(m.group(1))
        time_el = wrap.select_one("time")
        if not time_el or not time_el.get("datetime"):
            continue
        try:
            published = parse_iso(time_el["datetime"])
        except Exception:
            continue
        text_el = wrap.select_one(".tgme_widget_message_text")
        text = text_el.get_text(" ", strip=True) if text_el else ""
        forwarded_el = wrap.select_one(".tgme_widget_message_forwarded_from_name")
        forwarded = forwarded_el.get_text(" ", strip=True) if forwarded_el else None
        posts.append(Post(
            channel=channel,
            post_id=post_id,
            published_at=published,
            text=text,
            url=f"https://t.me/{channel}/{post_id}",
            forwarded_from=forwarded,
        ))
    return posts


def fetch_posts_for_window(
    session: requests.Session,
    channel: str,
    start_utc: datetime,
    end_utc: datetime,
    max_pages: int = 18,
    context_hours: int = 48,
) -> list[Post]:
    context_start = start_utc - timedelta(hours=max(12, context_hours))
    all_posts: dict[int, Post] = {}
    before: int | None = None

    for _ in range(max_pages):
        page = parse_telegram_html(fetch_page(session, channel, before), channel)
        if not page:
            break
        for post in page:
            all_posts[int(post.post_id)] = post
        oldest = min(page, key=lambda p: p.published_at)
        if oldest.published_at <= context_start:
            break
        min_id = min(int(p.post_id) for p in page)
        if before == min_id:
            break
        before = min_id
        time.sleep(0.15)

    return sorted(
        (p for p in all_posts.values() if context_start <= p.published_at <= end_utc),
        key=lambda p: (p.published_at, str(p.post_id)),
    )


# ---------------------------------------------------------------------------
# Official MChS regional RSS fallback
# ---------------------------------------------------------------------------

def parse_rss_date(value: str) -> datetime | None:
    if not value:
        return None
    try:
        dt = parsedate_to_datetime(value)
        if dt.tzinfo is None:
            dt = dt.replace(tzinfo=timezone.utc)
        return dt.astimezone(timezone.utc)
    except Exception:
        try:
            return parse_iso(value)
        except Exception:
            return None


def parse_mchs_rss(xml_text: str, region_cfg: dict[str, Any]) -> list[Post]:
    root = ET.fromstring(xml_text)
    posts: list[Post] = []
    channel = f"mchs-{region_cfg['id']}"
    for item in root.findall(".//item"):
        title = (item.findtext("title") or "").strip()
        description = strip_html(item.findtext("description") or "")
        link = (item.findtext("link") or region_cfg["mchs_operational_url"]).strip()
        guid = (item.findtext("guid") or link or title).strip()
        published = parse_rss_date(item.findtext("pubDate") or item.findtext("date") or "")
        if published is None:
            continue
        text = " ".join(x for x in (title, description) if x).strip()
        posts.append(Post(
            channel=channel,
            post_id=stable_id(guid),
            published_at=published,
            text=text,
            url=link,
        ))
    return posts


def fetch_mchs_posts_for_window(
    session: requests.Session,
    region_cfg: dict[str, Any],
    start_utc: datetime,
    end_utc: datetime,
    context_hours: int = 48,
) -> list[Post]:
    context_start = start_utc - timedelta(hours=max(12, context_hours))
    r = session.get(region_cfg["mchs_rss_url"], timeout=18)
    r.raise_for_status()
    posts = parse_mchs_rss(r.text, region_cfg)
    return sorted(
        (p for p in posts if context_start <= p.published_at <= end_utc),
        key=lambda p: (p.published_at, str(p.post_id)),
    )


# ---------------------------------------------------------------------------
# Shared parsing
# ---------------------------------------------------------------------------

def text_kind(text: str) -> str | None:
    n = normalize(text)
    if any(marker in n for marker in END_MARKERS) or any(p.search(n) for p in END_PATTERNS):
        return "end"
    if any(marker in n for marker in START_MARKERS) or any(p.search(n) for p in START_PATTERNS):
        return "start"
    return None


def alert_post_stats(posts: list[Post]) -> dict[str, int]:
    starts = 0
    ends = 0
    activity = 0
    for post in posts:
        kind = text_kind(post.text)
        if kind == "start":
            starts += 1
        elif kind == "end":
            ends += 1
        if uav_activity_kind(post.text) is not None:
            activity += 1
    return {
        "alert_posts": starts + ends,
        "start_posts": starts,
        "end_posts": ends,
        "activity_posts": activity,
    }


def alias_variants(value: str) -> list[str]:
    """Generate conservative Russian case variants for place aliases at parse time."""
    raw = str(value or "").strip()
    if not raw:
        return []
    out = [raw]
    words = raw.split()
    if not words or not re.search(r"[А-Яа-яЁё]", words[-1]):
        return out
    w = words[-1]
    lw = w.lower().replace("ё", "е")
    base = words[:-1]
    def add(last: str):
        out.append(" ".join([*base, last]))
    if lw.endswith("а") and len(w) > 3:
        stem = w[:-1]
        for ending in ("е", "ы", "у", "ой"):
            add(stem + ending)
    elif lw.endswith("я") and len(w) > 3:
        stem = w[:-1]
        for ending in ("е", "и", "ю", "ей"):
            add(stem + ending)
    elif lw.endswith("ь") and len(w) > 3:
        stem = w[:-1]
        for ending in ("и", "ью"):
            add(stem + ending)
    elif not lw.endswith(("ово", "ево", "ино", "ы", "и")) and re.search(r"[бвгджзклмнпрстфхцчшщ]$", lw):
        for ending in ("е", "а", "у", "ом"):
            add(w + ending)
    # Common feminine genitive -зы/-сы etc. can be missed when a manually
    # configured alias only contains nominative; the -а rule above covers it.
    return list(dict.fromkeys(out))


def extract_places(text: str, source: dict[str, Any]) -> list[dict[str, Any]]:
    n = normalize(text)
    matches = []
    for place in [*(source.get("places", []) or []), *(source.get("_catalog_places", []) or [])]:
        aliases = [normalize(v) for a in place.get("aliases", []) for v in alias_variants(a)]

        def alias_present(alias: str) -> bool:
            if not alias:
                return False
            return re.search(r"(?<![а-яa-z0-9])" + re.escape(alias) + r"(?![а-яa-z0-9])", n) is not None

        if any(alias_present(alias) for alias in aliases):
            matches.append(place)

    seen = set()
    out = []
    for p in matches:
        if p["name"] in seen:
            continue
        seen.add(p["name"])
        out.append(p)
    return out


def is_region_message(text: str, source: dict[str, Any]) -> bool:
    n = normalize(text)
    places = extract_places(text, source)
    if source.get("default_scope") == "region" and not places:
        return True
    region_label = normalize(source.get("region_label", ""))
    region_aliases = [normalize(a) for a in source.get("region_aliases", []) if normalize(a)]
    if any(p in n for p in REGION_PHRASES):
        return True
    if "на всей территории" in n and any(w in n for w in ("област", "республик", "кра", "округ", "регион")):
        return True
    if region_label and region_label in n and not places:
        return True
    if not places and any(alias in n for alias in region_aliases):
        return True
    return False


def alert_scope(place: dict[str, Any] | None) -> str:
    if not place:
        return "region"
    ptype = place.get("type", "municipality")
    if ptype == "city":
        return "city"
    if ptype in ("district", "municipality", "okrug"):
        return "municipality"
    return ptype


def pair_alerts(posts: list[Post], source: dict[str, Any], window_start: datetime, window_end: datetime):
    open_alerts: dict[str, list[dict[str, Any]]] = {}
    events: list[dict[str, Any]] = []
    unmatched: list[dict[str, Any]] = []

    def key_for(place_name: str) -> str:
        return f"{source['region']}::{place_name}"

    def open_one(place_name: str, scope: str, post: Post, precision: str = "exact", place_meta: dict[str, Any] | None = None):
        key = key_for(place_name)
        bucket = open_alerts.setdefault(key, [])
        # Official channels frequently repeat "danger remains in effect" while an
        # alert is open. Treat alerts as state, not as a stack of repeated starts.
        if bucket:
            return
        bucket.append({"post": post, "scope": scope, "precision": precision, "place_meta": place_meta or {}})

    def close_one(place_name: str, end_post: Post, reason: str = "direct"):
        key = key_for(place_name)
        bucket = open_alerts.get(key) or []
        if not bucket:
            return
        start_item = bucket.pop(0)
        start_post: Post = start_item["post"]
        if end_post.published_at < start_post.published_at:
            return
        if end_post.published_at < window_start or start_post.published_at > window_end:
            return
        events.append({
            "id": stable_id(source.get("channel", source.get("source_id", "source")), str(start_post.post_id), str(end_post.post_id), place_name),
            "region": source["region"],
            "place": place_name,
            "scope": start_item["scope"],
            "precision": start_item.get("precision", "exact"),
            "alert_type": "uav_alert",
            "start": start_post.published_at.isoformat(),
            "end": end_post.published_at.isoformat(),
            "source_name": source["source_name"],
            "source_url": source["source_url"],
            "start_url": start_post.url,
            "end_url": end_post.url,
            "start_text": start_post.text,
            "end_text": end_post.text,
            "end_match": reason,
            "source_kind": source.get("kind", "official"),
            "lat": start_item.get("place_meta", {}).get("lat"),
            "lon": start_item.get("place_meta", {}).get("lon"),
        })

    for post in posts:
        kind = text_kind(post.text)
        if not kind:
            continue
        n = post.normalized
        places = extract_places(post.text, source)
        region_message = is_region_message(post.text, source)

        if kind == "start":
            if region_message:
                open_one(source["region"], "region", post, "exact_region")
            for place in places:
                open_one(place["name"], alert_scope(place), post, "exact_local", place)
            if not region_message and not places:
                if source.get("fallback_to_region_on_unresolved", False):
                    open_one(source["region"], "region", post, "parent_region_fallback")
                    unmatched.append({
                        "type": "start_scope_fell_back_to_region",
                        "region": source["region"], "url": post.url, "text": post.text,
                    })
                else:
                    unmatched.append({"type": "unresolved_start_scope", "url": post.url, "text": post.text})

        elif kind == "end":
            if any(p in n for p in CLOSE_ALL_LOCAL_PHRASES):
                for key in list(open_alerts.keys()):
                    if key.endswith(f"::{source['region']}"):
                        continue
                    while open_alerts.get(key):
                        close_one(key.split("::", 1)[1], post, "all_local_clear")
                continue

            if region_message:
                close_one(source["region"], post, "regional_clear")
                for key in list(open_alerts.keys()):
                    if key.endswith(f"::{source['region']}"):
                        continue
                    while open_alerts.get(key):
                        close_one(key.split("::", 1)[1], post, "regional_clear")
            for place in places:
                close_one(place["name"], post, "direct")
            if not region_message and not places and source.get("fallback_to_region_on_unresolved", False):
                close_one(source["region"], post, "parent_region_fallback_clear")

    for key, bucket in open_alerts.items():
        for item in bucket:
            p: Post = item["post"]
            unmatched.append({
                "type": "unmatched_start",
                "region": source["region"],
                "place": key.split("::", 1)[1],
                "start": p.published_at.isoformat(),
                "url": p.url,
                "text": p.text,
            })
    return events, unmatched


def mod_derived(post: Post) -> bool:
    # Reject numbers that are merely copied/forwarded from the federal MOD, but
    # do not reject a governor's own local report just because it says local PVO
    # or MOD forces performed the interception.
    forwarded = normalize(post.forwarded_from or "")
    if "минобороны" in forwarded or "министерство обороны" in forwarded:
        return True
    text = normalize(post.text)
    return any(marker in text for marker in MOD_DERIVED_MARKERS)


def sentence_split(text: str) -> list[str]:
    return [s.strip() for s in re.split(r"(?<=[.!?])\s+|\n+", text) if s.strip()]


def classify_count_sentence(sentence: str) -> list[tuple[int, str, int | None, str | None, str | None]]:
    n = normalize(sentence)
    out = []

    def q(prefix: str | None) -> str | None:
        if not prefix:
            return None
        prefix = normalize(prefix)
        if "более" in prefix or "свыше" in prefix: return "at_least"
        if "около" in prefix or "примерно" in prefix or "порядка" in prefix: return "approx"
        return None

    m = re.search(r"(?:атаки|атакован[а-я]*|атаковали|нанесены удары)\D{0,28}(?:(более|свыше|около|примерно|порядка)\s+)?(\d+)\s*(?:бпла|беспилотник\w*)", n)
    if m:
        primary = int(m.group(2))
        sec = re.search(r"из которых\s+(\d+)\s+(?:подавлен\w*\s+и\s+)?сбит\w*", n)
        out.append((primary, "attacked", int(sec.group(1)) if sec else None, "shot_down" if sec else None, q(m.group(1))))
        return out

    m = re.search(r"обнаружен\w*\s+и\s+уничтожен\w*\D{0,12}(?:(более|свыше|около|примерно|порядка)\s+)?(\d+)\s+(?:беспилот\w*|бпла)", n)
    if m:
        out.append((int(m.group(2)), "detected_and_destroyed", None, None, q(m.group(1))))
        return out

    # Common governor phrasing: "сбили и подавили 249 БПЛА", "уничтожены 13 БПЛА".
    m = re.search(r"(?:сбил\w*|уничтожен\w*|подавил\w*|подавлен\w*|обезврежен\w*|нейтрализован\w*)(?:\s+и\s+(?:сбил\w*|уничтожен\w*|подавил\w*|подавлен\w*))?\D{0,16}(?:(более|свыше|около|примерно|порядка)\s+)?(\d+)\s*(?:бпла|беспилотник\w*)", n)
    if m:
        out.append((int(m.group(2)), "destroyed_or_suppressed", None, None, q(m.group(1))))
        return out

    m = re.search(r"(?:летел\w*|направлял\w*|двигал\w*)\D{0,18}(?:(более|свыше|около|примерно|порядка)\s+)?(\d+)\s*(?:бпла|беспилотник\w*)", n)
    if m:
        out.append((int(m.group(2)), "incoming_reported", None, None, q(m.group(1))))
        return out

    m = re.search(r"атакован\w*\D{0,20}(?:(более|свыше|около|примерно|порядка)\s+)?(\d+)\s+беспилотник\w*", n)
    if m:
        out.append((int(m.group(2)), "attacked", None, None, q(m.group(1))))
        return out

    return out

def infer_report_places(sentence: str, source: dict[str, Any]) -> list[dict[str, Any]]:
    places = extract_places(sentence, source)
    return places


def is_official_activity_text(text: str) -> bool:
    return uav_activity_kind(text) is not None


def extract_reports(posts: list[Post], source: dict[str, Any], window_start: datetime, window_end: datetime):
    reports = []
    for post in posts:
        if post.published_at < window_start or post.published_at > window_end:
            continue
        if mod_derived(post):
            continue
        npost = normalize(post.text)
        whole_activity_kind = uav_activity_kind(post.text)
        if whole_activity_kind is None and not any(token in npost for token in ("бпла", "беспилот", "дрон")):
            continue
        produced_for_post = False
        for sentence in sentence_split(post.text):
            counts = classify_count_sentence(sentence)
            if not counts:
                continue
            mentioned = infer_report_places(sentence, source) or infer_report_places(post.text, source)
            primary_place = mentioned[0] if mentioned else None
            place = primary_place["name"] if primary_place else source["region"]
            scope = alert_scope(primary_place) if primary_place else "region"
            mentioned_places = [
                {"name": p["name"], "label": p.get("label", p["name"]), "type": p.get("type", "city"),
                 "lat": p.get("lat"), "lon": p.get("lon")}
                for p in mentioned[:120]
            ]
            for count, ctype, secondary_count, secondary_type, qualifier in counts:
                reports.append({
                    "id": stable_id(source.get("channel", source.get("source_id", "source")), str(post.post_id), place, ctype, str(count)),
                    "region": source["region"], "place": place, "scope": scope,
                    "at": post.published_at.isoformat(), "count": count, "count_type": ctype,
                    "signal_class": "uav_activity_signal",
                    "activity_kind": uav_activity_kind(sentence) or whole_activity_kind or "official_uav_activity",
                    "count_qualifier": qualifier, "secondary_count": secondary_count, "secondary_type": secondary_type,
                    "text": sentence, "source_name": source["source_name"], "url": post.url,
                    "source_kind": source.get("kind", "official"),
                    "lat": primary_place.get("lat") if primary_place else None,
                    "lon": primary_place.get("lon") if primary_place else None,
                    "mentioned_places": mentioned_places,
                })
                produced_for_post = True
        # Display-first historical policy: any clearly operational UAV wording
        # from an official local source is retained as a timestamped signal, even
        # when START/END cannot be paired. Paired intervals still remain the
        # authoritative red alert windows; these point signals prevent real local
        # activity from disappearing merely because the wording is non-standard.
        activity_kind = uav_activity_kind(post.text)
        if not produced_for_post and activity_kind is not None:
            mentioned = infer_report_places(post.text, source)
            primary_place = mentioned[0] if mentioned else None
            place = primary_place["name"] if primary_place else source["region"]
            scope = alert_scope(primary_place) if primary_place else "region"
            display_type = activity_kind if activity_kind.startswith("alert_") else "official_activity"
            signal_class = (
                "formal_alert_signal" if activity_kind == "alert_start_signal"
                else "alert_clear_signal" if activity_kind == "alert_end_signal"
                else "uav_activity_signal"
            )
            reports.append({
                "id": stable_id(source.get("channel", source.get("source_id", "source")), str(post.post_id), place, activity_kind),
                "region": source["region"], "place": place, "scope": scope,
                "at": post.published_at.isoformat(), "count": None, "count_type": display_type,
                "activity_kind": activity_kind,
                "signal_class": signal_class,
                "count_qualifier": None, "secondary_count": None, "secondary_type": None,
                "text": post.text, "source_name": source["source_name"], "url": post.url,
                "source_kind": source.get("kind", "official"),
                "lat": primary_place.get("lat") if primary_place else None,
                "lon": primary_place.get("lon") if primary_place else None,
                "mentioned_places": [
                    {"name": p["name"], "label": p.get("label", p["name"]), "type": p.get("type", "city"),
                     "lat": p.get("lat"), "lon": p.get("lon")} for p in mentioned[:120]
                ],
            })
    unique = {r["id"]: r for r in reports}
    return sorted(unique.values(), key=lambda r: r["at"])

def mchs_source(region_cfg: dict[str, Any]) -> dict[str, Any]:
    return {
        "source_id": f"mchs-{region_cfg['id']}",
        "channel": f"mchs-{region_cfg['id']}",
        "kind": "mchs_rss",
        "region": region_cfg["region"],
        "region_label": region_cfg["region_label"],
        "region_aliases": [region_cfg.get("region_label", ""), *(region_cfg.get("geo_aliases") or [])],
        "source_name": f"ГУ МЧС России — {region_cfg['region_label']}",
        "source_url": region_cfg["mchs_operational_url"],
        "default_scope": "region",
        "fallback_to_region_on_unresolved": True,
        "places": [],
    }


def collect(args) -> dict[str, Any]:
    source_cfg = json.loads(Path(args.sources).read_text(encoding="utf-8"))
    region_cfg = json.loads(Path(args.regions).read_text(encoding="utf-8"))
    city_path = Path(args.cities)
    city_cfg = json.loads(city_path.read_text(encoding="utf-8")) if city_path.exists() else {"cities": [], "municipalities": []}
    cities_by_region: dict[str, list[dict[str, Any]]] = {}
    for city in [*(city_cfg.get("cities", []) or []), *(city_cfg.get("municipalities", []) or [])]:
        cities_by_region.setdefault(city.get("region", ""), []).append({
            "name": city.get("name"), "label": city.get("label") or city.get("name"), "type": city.get("type", "city"),
            "lat": city.get("lat"), "lon": city.get("lon"), "population": city.get("population", 0),
            "aliases": city.get("aliases") or [city.get("label") or city.get("name")],
        })
    now = datetime.now(timezone.utc)
    window_end = now - timedelta(hours=args.safety_lag_hours)
    window_start = window_end - timedelta(hours=args.lookback_hours)

    all_events: list[dict[str, Any]] = []
    all_reports: list[dict[str, Any]] = []
    all_unmatched: list[dict[str, Any]] = []
    statuses: list[dict[str, Any]] = []

    # High-resolution Telegram feeds first.
    session = make_session()
    for source0 in source_cfg.get("sources", []):
        if not source0.get("enabled", False):
            continue
        source = dict(source0)
        source["_catalog_places"] = cities_by_region.get(source.get("region", ""), [])
        channel = source["channel"]
        try:
            posts = fetch_posts_for_window(
                session, channel, window_start, window_end,
                max_pages=args.max_pages, context_hours=args.context_hours,
            )
            events, unmatched = pair_alerts(posts, source, window_start, window_end)
            reports = extract_reports(posts, source, window_start, window_end)
            all_events.extend(events); all_reports.extend(reports); all_unmatched.extend(unmatched)
            alert_stats = alert_post_stats(posts)
            statuses.append({
                "source_type": "telegram", "source": channel, "region": source["region"], "ok": True,
                "posts": len(posts), "events": len(events), "reports": len(reports), **alert_stats,
            })
            print(
                f"telegram {channel}: posts={len(posts)} alerts={alert_stats['alert_posts']} "
                f"starts={alert_stats['start_posts']} ends={alert_stats['end_posts']} "
                f"events={len(events)} reports={len(reports)}",
                file=sys.stderr,
            )
        except Exception as exc:
            statuses.append({"source_type": "telegram", "source": channel, "region": source["region"], "ok": False, "error": str(exc)})
            print(f"telegram {channel}: ERROR {exc}", file=sys.stderr)

    # Nationwide official region-level RSS fallback. One request per region, in a
    # bounded worker pool so a slow regional site does not block the entire job.
    enabled_regions = [r for r in region_cfg.get("regions", []) if r.get("enabled", True)]

    def collect_region(region: dict[str, Any]):
        local_session = make_session()
        source = mchs_source(region)
        source["_catalog_places"] = cities_by_region.get(region.get("region", ""), [])
        posts = fetch_mchs_posts_for_window(
            local_session, region, window_start, window_end, context_hours=args.context_hours
        )
        events, unmatched = pair_alerts(posts, source, window_start, window_end)
        reports = extract_reports(posts, source, window_start, window_end)
        return region, posts, events, reports, unmatched

    with ThreadPoolExecutor(max_workers=max(1, args.mchs_workers)) as pool:
        future_map = {pool.submit(collect_region, r): r for r in enabled_regions}
        for future in as_completed(future_map):
            region = future_map[future]
            try:
                _, posts, events, reports, unmatched = future.result()
                all_events.extend(events); all_reports.extend(reports); all_unmatched.extend(unmatched)
                alert_stats = alert_post_stats(posts)
                statuses.append({
                    "source_type": "mchs_rss", "source": region["mchs_rss_url"], "region": region["region"], "ok": True,
                    "posts": len(posts), "events": len(events), "reports": len(reports), **alert_stats,
                })
            except Exception as exc:
                statuses.append({
                    "source_type": "mchs_rss", "source": region.get("mchs_rss_url"), "region": region["region"], "ok": False,
                    "error": str(exc),
                })

    # Stable de-duplication within each source-derived id.
    all_events = list({e["id"]: e for e in all_events}.values())
    all_reports = list({r["id"]: r for r in all_reports}.values())
    all_events.sort(key=lambda e: (e["start"], e["region"], e["place"]))
    all_reports.sort(key=lambda r: (r["at"], r["region"], r["place"]))

    rss_status = [s for s in statuses if s["source_type"] == "mchs_rss"]
    telegram_status = [s for s in statuses if s["source_type"] == "telegram"]
    regions_with_events = sorted({e["region"] for e in all_events})
    regions_with_alert_posts = sorted({s["region"] for s in statuses if s.get("alert_posts", 0) > 0})
    regions_with_activity_posts = sorted({s["region"] for s in statuses if s.get("activity_posts", 0) > 0})
    regions_with_any_record = sorted({e["region"] for e in all_events} | {r["region"] for r in all_reports})
    hi_res_regions_with_events = sorted({e["region"] for e in all_events if e.get("source_kind") == "telegram"})
    return {
        "schema_version": 4,
        "generated_at": now.isoformat(),
        "safety_lag_hours": args.safety_lag_hours,
        "window_start": window_start.isoformat(),
        "window_end": window_end.isoformat(),
        "collection_mode": getattr(args, "collection_mode", "backfill"),
        "effective_lookback_hours": args.lookback_hours,
        "incremental_overlap_hours": getattr(args, "incremental_overlap_hours", None),
        "coverage": {
            "regions_configured": len(enabled_regions),
            # Legacy HTTP-health metric retained for old frontends.
            "regions_rss_ok": sum(1 for s in rss_status if s.get("ok")),
            "region_feeds_http_ok": sum(1 for s in rss_status if s.get("ok")),
            "mchs_regions_with_alert_posts": sum(1 for s in rss_status if s.get("alert_posts", 0) > 0),
            "regions_with_any_alert_posts": len(regions_with_alert_posts),
            "regions_with_activity_posts": len(regions_with_activity_posts),
            "regions_with_any_record": len(regions_with_any_record),
            "regions_with_paired_alerts": len(regions_with_events),
            "high_resolution_sources_configured": len([s for s in source_cfg.get("sources", []) if s.get("enabled", False)]),
            "high_resolution_sources_ok": sum(1 for s in telegram_status if s.get("ok")),
            "high_resolution_sources_with_alert_posts": sum(1 for s in telegram_status if s.get("alert_posts", 0) > 0),
            "high_resolution_sources_with_activity_posts": sum(1 for s in telegram_status if s.get("activity_posts", 0) > 0),
            "high_resolution_regions_with_events": len(hi_res_regions_with_events),
            "city_catalog_count": len(city_cfg.get("cities", [])),
            "municipality_catalog_count": len(city_cfg.get("municipalities", [])),
            "unmatched_starts": sum(1 for u in all_unmatched if u.get("type") == "unmatched_start"),
        },
        "events": all_events,
        "reports": all_reports,
        "unmatched": all_unmatched,
        "source_status": sorted(statuses, key=lambda s: (s.get("region", ""), s.get("source_type", ""))),
    }



def merge_existing_archive(data: dict[str, Any], output_path: Path) -> dict[str, Any]:
    """Keep older historical records while regenerating the current window.

    The collector used to replace events.json with only the newest lookback
    window.  That is unsuitable for an archive.  Records before the current
    window are retained; the overlapping window is regenerated from sources so
    parser fixes can correct recent history.
    """
    if not output_path.exists():
        data["coverage"]["archive_events_total"] = len(data.get("events", []))
        data["coverage"]["archive_reports_total"] = len(data.get("reports", []))
        return data
    try:
        old = json.loads(output_path.read_text(encoding="utf-8"))
        cutoff = parse_iso(data["window_start"])
    except Exception:
        return data

    keep_events = []
    for e in old.get("events", []):
        try:
            if parse_iso(e.get("end") or e.get("start")) < cutoff:
                keep_events.append(e)
        except Exception:
            pass
    keep_reports = []
    for r in old.get("reports", []):
        try:
            if parse_iso(r.get("at")) < cutoff:
                keep_reports.append(r)
        except Exception:
            pass

    data["events"] = sorted(
        {e["id"]: e for e in [*keep_events, *data.get("events", [])]}.values(),
        key=lambda e: (e.get("start", ""), e.get("region", ""), e.get("place", "")),
    )
    data["reports"] = sorted(
        {r["id"]: r for r in [*keep_reports, *data.get("reports", [])]}.values(),
        key=lambda r: (r.get("at", ""), r.get("region", ""), r.get("place", "")),
    )
    data["coverage"]["archive_events_total"] = len(data["events"])
    data["coverage"]["archive_reports_total"] = len(data["reports"])
    return data

def configure_incremental_window(args) -> None:
    """Shrink scheduled/manual incremental runs to only the new archive edge.

    Existing historical records remain in events.json.  For an incremental run
    we collect from the previous safe window end minus a small overlap through
    the newest safe cutoff.  The overlap lets START/END pairs that straddle two
    runs be regenerated without re-fetching the full historical lookback.
    """
    args.collection_mode = "backfill" if args.full_backfill else "incremental"
    if args.full_backfill:
        return
    out = Path(args.output)
    if not out.exists():
        args.collection_mode = "initial"
        return
    try:
        old = json.loads(out.read_text(encoding="utf-8"))
        previous_end = parse_iso(old.get("window_end", ""))
    except Exception:
        args.collection_mode = "initial"
        return

    target_end = datetime.now(timezone.utc) - timedelta(hours=args.safety_lag_hours)
    delta_h = max(0.0, (target_end - previous_end).total_seconds() / 3600.0)
    needed = int(delta_h + args.incremental_overlap_hours + 0.999)
    args.lookback_hours = max(args.incremental_overlap_hours, needed, 6)


def main():
    p = argparse.ArgumentParser()
    p.add_argument("--sources", default=str(DEFAULT_SOURCES))
    p.add_argument("--regions", default=str(DEFAULT_REGIONS))
    p.add_argument("--cities", default=str(DEFAULT_CITIES))
    p.add_argument("--output", default=str(DEFAULT_OUTPUT))
    p.add_argument("--lookback-hours", type=int, default=int(os.getenv("LOOKBACK_HOURS", "120")))
    p.add_argument("--safety-lag-hours", type=int, default=int(os.getenv("SAFETY_LAG_HOURS", "24")))
    p.add_argument("--max-pages", type=int, default=int(os.getenv("TELEGRAM_MAX_PAGES", "50")))
    p.add_argument("--context-hours", type=int, default=int(os.getenv("TELEGRAM_CONTEXT_HOURS", "48")))
    p.add_argument("--incremental-overlap-hours", type=int, default=int(os.getenv("INCREMENTAL_OVERLAP_HOURS", "18")))
    p.add_argument("--full-backfill", action="store_true", default=os.getenv("FULL_BACKFILL", "0") == "1")
    p.add_argument("--mchs-workers", type=int, default=int(os.getenv("MCHS_WORKERS", "8")))
    args = p.parse_args()
    args.safety_lag_hours = max(24, args.safety_lag_hours)
    args.lookback_hours = max(6, args.lookback_hours)
    args.context_hours = max(12, args.context_hours)
    args.incremental_overlap_hours = max(6, args.incremental_overlap_hours)
    configure_incremental_window(args)
    print(
        f"collection mode={args.collection_mode} lookback={args.lookback_hours}h "
        f"overlap={args.incremental_overlap_hours}h lag={args.safety_lag_hours}h",
        file=sys.stderr,
    )

    data = collect(args)
    data = merge_existing_archive(data, Path(args.output))
    if data["source_status"] and not any(s.get("ok") for s in data["source_status"]):
        raise RuntimeError("all configured sources failed; keeping the previous archive file")

    out = Path(args.output)
    out.parent.mkdir(parents=True, exist_ok=True)
    tmp = out.with_suffix(out.suffix + ".tmp")
    tmp.write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8")
    tmp.replace(out)
    print(
        f"wrote {out}: {len(data['events'])} paired alerts, {len(data['reports'])} reports; "
        f"regions-with-events {data['coverage']['regions_with_paired_alerts']}/{data['coverage']['regions_configured']}; "
        f"MChS HTTP {data['coverage']['region_feeds_http_ok']}/{data['coverage']['regions_configured']}",
        file=sys.stderr,
    )


if __name__ == "__main__":
    main()
