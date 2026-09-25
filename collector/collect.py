#!/usr/bin/env python3
"""Collect delayed historical UAV-alert records from official local sources.

Sources are deliberately separated into two layers:
  1. High-resolution official local Telegram channels configured in data/sources.json.
  2. A nationwide region-level fallback using the official regional MChS RSS feeds
     configured in data/regions.json. RSS is treated as a fallback/diagnostic layer,
     not as proof that every MChS mobile-app push is mirrored to the website feed.

The collector is normally run manually and has no mandatory archive lag. It records
a snapshot up to the time the workflow is launched; network/API and workflow latency
mean it is still not a real-time alerting system. START/END alerts are paired
conservatively; if a valid official alert cannot be resolved to a configured
city/municipality, it can be retained at parent-region precision rather than silently
dropped.
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
from urllib.parse import quote_plus
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

try:
    from telethon.sync import TelegramClient
    from telethon.sessions import StringSession
    from telethon.tl.types import InputPeerChannel, InputPeerUser, InputPeerChat
except Exception:  # optional; public HTML fallback remains available
    TelegramClient = None
    StringSession = None
    InputPeerChannel = None
    InputPeerUser = None
    InputPeerChat = None

ROOT = Path(__file__).resolve().parents[1]
DEFAULT_SOURCES = ROOT / "data" / "sources.json"
DEFAULT_REGIONS = ROOT / "data" / "regions.json"
DEFAULT_CITIES = ROOT / "data" / "cities.json"
DEFAULT_OUTPUT = ROOT / "data" / "events.json"
DEFAULT_TELEGRAM_PEERS = ROOT / "data" / "telegram_peers.json"

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
    r"\b(?:опасност\w*|угроз\w*|тревог\w*|внимани\w*|опасн\w*\s+неб\w*)\b",
    r"\b(?:объявлен\w*|введен\w*|действует|сохраняется)\b.{0,100}\b(?:режим\w*|опасност\w*|угроз\w*)\b",
    # attack / strike / approach / flight / detection
    r"\b(?:атак\w*|удар\w*|пораж\w*|врезал\w*)\b",
    r"\b(?:летит|летят|летел\w*|движ\w*|направля\w*|приближа\w*|подлета\w*|подлет\w*|пролет\w*|следу\w*)\b",
    r"\b(?:обнаруж\w*|зафиксир\w*|замеч\w*|выявл\w*|наблюда\w*|фиксиру\w*|фиксац\w*)\b",
    # air-defence / EW response
    r"\b(?:(?:сбит\w*|сбил\w*)|уничтож\w*|перехват\w*|подав\w*|нейтрализ\w*|обезвреж\w*|ликвидир\w*)\b",
    r"\b(?:пво|рэб)\b.{0,80}\b(?:работа\w*|отража\w*|(?:сбит\w*|сбил\w*)|уничтож\w*|подав\w*)\b",
    r"\b(?:работа\w*|отража\w*)\b.{0,80}\b(?:пво|рэб)\b",
    # impact / debris / incident
    r"\b(?:обломк\w*|падени\w*|прилет\w*|попадани\w*|взрыв\w*|поврежден\w*)\b",
    # restrictions explicitly tied to UAVs
    r"\b(?:ковер|ограничен\w*|закрыт\w*|приостанов\w*)\b",
))

UAV_ARTICLE_REJECTION_PATTERNS = tuple(re.compile(p) for p in (
    # Strong whole-post debunk framing. This is intentionally narrower than
    # sentence-level exclusions so a real alert followed by generic advice such
    # as "do not publish PVO footage" remains operational.
    r"\bочередн\w*\s+дипфейк\w*\b",
    r"\bэто\s+(?:очередн\w*\s+)?(?:фейк\w*|дипфейк\w*)\b",
    r"\b(?:фейк\w*|дипфейк\w*)\b.{0,120}\b(?:опроверг\w*|не\s+соответству\w*\s+действительност\w*)\b",
    r"\b(?:опроверг\w*|разоблачил\w*)\b.{0,120}\b(?:фейк\w*|дипфейк\w*)\b",
    r"\bпропаганд\w*.{0,120}\b(?:пугат\w*|фейк\w*|дипфейк\w*)\b",
))

NON_OPERATIONAL_UAV_PATTERNS = tuple(re.compile(p) for p in (
    r"\b(?:производ\w*|разработк\w*|изготовлен\w*|сборк\w*|закупк\w*|контракт\w*)\b",
    r"\b(?:выставк\w*|форум\w*|соревнован\w*|чемпионат\w*|фестивал\w*|кружок\w*|обучен\w*|учебн\w*|учени\w*|тренировк\w*|инструктаж\w*|памятк\w*|профилактич\w*)\b",
    r"\b(?:алгоритм\w*\s+действ\w*|правил\w*\s+поведен\w*)\b",
    r"\b(?:сельскохозяйствен\w*|доставк\w*|аэрофотосъем\w*)\b",
    r"\b(?:фейк\w*|дипфейк\w*|фейкодел\w*|дезинформац\w*|опроверг\w*|якобы|пропаганд\w*)\b",
    r"\b(?:не\s+снимайте|не\s+публикуйте|запрет\w*|запрещен\w*|фотографирован\w*|видеосъем\w*|распространен\w*)\b",
    r"\b(?:научн\w*|исследован\w*|университет\w*|институт\w*|лаборатор\w*|образован\w*|студент\w*)\b",
))

UAV_WEAK_OPERATIONAL_PATTERNS = tuple(re.compile(p) for p in (
    r"\b(?:сообща\w*|поступил\w*\s+информац\w*)\b.{0,70}\b(?:бпла|беспилотн\w*|дрон\w*)\b",
    r"\b(?:бпла|беспилотн\w*|дрон\w*)\b.{0,70}\b(?:в\s+район\w*|в\s+округ\w*|в\s+город\w*|над\s+территор\w*|над\s+город\w*|в\s+неб\w*|поблизост\w*)\b",
    r"\b(?:в\s+район\w*|в\s+округ\w*|в\s+город\w*|над\s+территор\w*|над\s+город\w*|в\s+неб\w*)\b.{0,70}\b(?:бпла|беспилотн\w*|дрон\w*)\b",
))

MISSILE_START_PATTERNS = tuple(re.compile(p) for p in (
    r"\bракетн\w*\s+(?:опасност\w*|угроз\w*)\b",
    r"\b(?:опасност\w*|угроз\w*)\s+(?:ракетн\w*\s+(?:атак\w*|удар\w*)|применени\w*\s+ракетн\w*\s+вооружени\w*)\b",
    r"\b(?:объявлен\w*|введен\w*|действует|сохраняется)\b.{0,100}\bракетн\w*.{0,50}\b(?:опасност\w*|угроз\w*)\b",
))
MISSILE_END_PATTERNS = tuple(re.compile(p) for p in (
    r"\bотбой\b.{0,100}\bракетн\w*\s+(?:опасност\w*|угроз\w*)\b",
    r"\b(?:снят|снята|снято|сняты|отменен|отменена|отменено|отменены|отмена)\b.{0,100}\bракетн\w*\s+(?:опасност\w*|угроз\w*)\b",
    r"\bракетн\w*\s+(?:опасност\w*|угроз\w*).{0,100}\b(?:снят|снята|снято|сняты|отменен|отменена|отменено|отменены)\b",
))
MISSILE_REFERENCE_PATTERNS = tuple(re.compile(p) for p in (
    r"\bракет\w*\b",
    r"\bкрылат\w*\s+ракет\w*\b",
    r"\bбаллистич\w*\s+ракет\w*\b",
))
MISSILE_OPERATIONAL_PATTERNS = tuple(re.compile(p) for p in (
    r"\b(?:опасност\w*|угроз\w*|тревог\w*)\b",
    r"\b(?:атак\w*|удар\w*|обстрел\w*|пуск\w*|запуск\w*)\b",
    r"\b(?:летит|летят|летел\w*|движ\w*|направля\w*|приближа\w*|подлета\w*|подлет\w*|пролет\w*)\b",
    r"\b(?:обнаруж\w*|зафиксир\w*|замеч\w*|выявл\w*|наблюда\w*|фиксиру\w*)\b",
    r"\b(?:(?:сбит\w*|сбил\w*)|уничтож\w*|перехват\w*|нейтрализ\w*|ликвидир\w*)\b",
    r"\b(?:пво|про)\b.{0,100}\b(?:работа\w*|отража\w*|(?:сбит\w*|сбил\w*)|уничтож\w*|перехват\w*)\b",
    r"\b(?:работа\w*|отража\w*)\b.{0,100}\b(?:пво|про)\b",
    r"\b(?:обломк\w*|падени\w*|прилет\w*|попадани\w*|взрыв\w*|поврежден\w*)\b",
))
NON_OPERATIONAL_MISSILE_PATTERNS = tuple(re.compile(p) for p in (
    r"\b(?:производ\w*|разработк\w*|изготовлен\w*|сборк\w*|закупк\w*|контракт\w*|комплектующ\w*|сертификац\w*)\b",
    r"\b(?:выставк\w*|форум\w*|соревнован\w*|фестивал\w*|учебн\w*|учени\w*|научн\w*|исследован\w*|университет\w*)\b",
    r"\b(?:ракетн\w*\s+комплекс\w*|космическ\w*|носител\w*|орбит\w*|фанер\w*)\b",
    r"\b(?:фейк\w*|дипфейк\w*|дезинформац\w*|опроверг\w*|якобы)\b",
))


def missile_text_kind(text: str) -> str | None:
    n = normalize(text)
    if any(p.search(n) for p in MISSILE_END_PATTERNS):
        return "end"
    if any(p.search(n) for p in MISSILE_START_PATTERNS):
        return "start"
    return None


def has_missile_reference(text: str) -> bool:
    n = normalize(text)
    return any(p.search(n) for p in MISSILE_REFERENCE_PATTERNS)


def missile_activity_kind(text: str) -> str | None:
    formal = missile_text_kind(text)
    if formal == "start":
        return "alert_start_signal"
    if formal == "end":
        return "alert_end_signal"

    chunks = [s.strip() for s in re.split(r"(?<=[.!?])\s+|\n+", str(text)) if s.strip()] or [str(text)]
    for chunk in chunks:
        if not has_missile_reference(chunk):
            continue
        n = normalize(chunk)
        if any(p.search(n) for p in NON_OPERATIONAL_MISSILE_PATTERNS):
            continue
        if re.search(r"\b(?:обломк\w*|падени\w*|прилет\w*|попадани\w*|поврежден\w*)\b", n):
            return "impact_or_debris"
        if re.search(r"\b(?:(?:сбит\w*|сбил\w*)|уничтож\w*|перехват\w*|нейтрализ\w*|ликвидир\w*)\b", n):
            return "air_defense_action"
        if re.search(r"\b(?:обнаруж\w*|зафиксир\w*|замеч\w*|выявл\w*|наблюда\w*)\b", n):
            return "missile_detected"
        if re.search(r"\b(?:летит|летят|летел\w*|движ\w*|направля\w*|приближа\w*|подлета\w*|подлет\w*|пролет\w*)\b", n):
            return "missile_movement"
        if re.search(r"\b(?:пуск\w*|запуск\w*)\b", n):
            return "missile_launch"
        if re.search(r"\b(?:атак\w*|удар\w*|обстрел\w*)\b", n):
            return "missile_attack_activity"
        if any(p.search(n) for p in MISSILE_OPERATIONAL_PATTERNS):
            return "official_missile_activity"
        continue
    return None

def activity_signals(text: str) -> list[tuple[str, str]]:
    out: list[tuple[str, str]] = []
    uav = uav_activity_kind(text)
    if uav is not None:
        out.append(("uav", uav))
    missile = missile_activity_kind(text)
    if missile is not None:
        out.append(("missile", missile))
    return out


def alert_threat_kinds(text: str) -> list[tuple[str, str]]:
    out: list[tuple[str, str]] = []
    uav = text_kind(text)
    if uav is not None:
        out.append(("uav", uav))
    missile = missile_text_kind(text)
    if missile is not None:
        out.append(("missile", missile))
    return out

def has_uav_reference(text: str) -> bool:
    n = normalize(text)
    return any(p.search(n) for p in UAV_REFERENCE_PATTERNS) or "опасное небо" in n


def uav_activity_kind(text: str) -> str | None:
    """Classify operational UAV wording without cross-sentence false matches."""
    whole = normalize(text)
    if any(p.search(whole) for p in UAV_ARTICLE_REJECTION_PATTERNS):
        return None

    formal = text_kind(text)
    if formal == "start":
        return "alert_start_signal"
    if formal == "end":
        return "alert_end_signal"

    chunks = [s.strip() for s in re.split(r"(?<=[.!?])\s+|\n+", str(text)) if s.strip()] or [str(text)]
    for chunk in chunks:
        if not has_uav_reference(chunk):
            continue
        n = normalize(chunk)
        if any(p.search(n) for p in NON_OPERATIONAL_UAV_PATTERNS):
            continue
        if re.search(r"\b(?:обломк\w*|падени\w*|прилет\w*|попадани\w*|поврежден\w*)\b", n):
            return "impact_or_debris"
        if re.search(r"\b(?:(?:сбит\w*|сбил\w*)|уничтож\w*|перехват\w*|подав\w*|нейтрализ\w*|обезвреж\w*|ликвидир\w*)\b", n):
            return "air_defense_action"
        if re.search(r"\b(?:обнаруж\w*|зафиксир\w*|замеч\w*|выявл\w*|наблюда\w*|фиксиру\w*|фиксац\w*)\b", n):
            return "uav_detected"
        if re.search(r"\bвнимани\w*\b", n):
            return "uav_warning"
        if re.search(r"\b(?:летит|летят|летел\w*|движ\w*|направля\w*|приближа\w*|подлета\w*|подлет\w*|пролет\w*|следу\w*)\b", n):
            return "uav_movement"
        if re.search(r"\b(?:атак\w*|удар\w*|пораж\w*|врезал\w*)\b", n):
            return "uav_attack_activity"
        if any(p.search(n) for p in UAV_OPERATIONAL_PATTERNS):
            return "official_uav_activity"
        if any(p.search(n) for p in UAV_WEAK_OPERATIONAL_PATTERNS):
            return "official_uav_activity"
    return None

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


@dataclass
class FetchResult:
    posts: list[Post]
    transport: str
    transport_ok: bool = True
    window_complete: bool = False
    error: str | None = None
    oldest: datetime | None = None
    newest: datetime | None = None
    raw_items: int = 0
    mtproto_peer_cache_hit: bool = False
    mtproto_peer_resolved: bool = False


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

def fetch_page(
    session: requests.Session,
    channel: str,
    before: int | None = None,
    query: str | None = None,
) -> str:
    url = f"https://t.me/s/{channel}"
    params = []
    if before:
        params.append(f"before={int(before)}")
    if query:
        params.append("q=" + quote_plus(query))
    if params:
        url += "?" + "&".join(params)
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


# Public Telegram channel search is useful for high-volume government channels:
# it lets us find relevant historical posts without paging through every unrelated
# press release.  Search is only a supplementary path; chronological paging is
# still retained and every accepted record remains a link to the original post.
TELEGRAM_ACTIVITY_QUERIES = (
    "БПЛА",
    "беспилот",
    "беспилотная опасность",
    "угроза атаки БПЛА",
    "дрон",
    "воздушная опасность",
    "опасное небо",
    "угроза подлета",
    "угроза подлёта",
    "ракета",
    "ракетная опасность",
    "ракетная угроза",
)


def _page_into_dict(all_posts: dict[int, Post], page: list[Post]) -> None:
    for post in page:
        all_posts[int(post.post_id)] = post


def _paginate_telegram(
    session: requests.Session,
    channel: str,
    context_start: datetime,
    end_utc: datetime,
    max_pages: int,
    query: str | None = None,
) -> dict[int, Post]:
    out: dict[int, Post] = {}
    before: int | None = None
    for _ in range(max_pages):
        page = parse_telegram_html(fetch_page(session, channel, before, query=query), channel)
        if not page:
            break
        _page_into_dict(out, page)

        # Do NOT stop merely because one anomalously old item exists on a page.
        # Stop only after the whole page has moved older than the context window.
        newest = max(p.published_at for p in page)
        if newest < context_start:
            break

        min_id = min(int(p.post_id) for p in page)
        if before is not None and min_id >= before:
            break
        before = min_id
        time.sleep(0.10)
    return out


def fetch_posts_html_for_window(
    session: requests.Session,
    channel: str,
    start_utc: datetime,
    end_utc: datetime,
    max_pages: int = 18,
    context_hours: int = 48,
) -> list[Post]:
    context_start = start_utc - timedelta(hours=max(12, context_hours))
    all_posts: dict[int, Post] = {}

    # 1) Chronological history remains the authoritative crawl.
    all_posts.update(_paginate_telegram(
        session, channel, context_start, end_utc, max_pages=max_pages, query=None
    ))

    # 2) Recall-oriented search passes catch UAV posts in channels that publish
    # hundreds of unrelated items.  Search pages are cheap enough that we can
    # use several wording families and deduplicate by Telegram post id.
    search_pages = max(3, min(12, max_pages // 4))
    for query in TELEGRAM_ACTIVITY_QUERIES:
        try:
            all_posts.update(_paginate_telegram(
                session, channel, context_start, end_utc,
                max_pages=search_pages, query=query,
            ))
        except Exception:
            # Supplementary search failure must not discard chronological data.
            pass

    return sorted(
        (p for p in all_posts.values() if context_start <= p.published_at <= end_utc),
        key=lambda p: (p.published_at, str(p.post_id)),
    )


# ---------------------------------------------------------------------------
# Reliable Telegram transport + source-health diagnostics
# ---------------------------------------------------------------------------

def _fetch_result(posts: list[Post], context_start: datetime, *, transport: str,
                  transport_ok: bool = True, window_complete: bool = False,
                  error: str | None = None, raw_items: int | None = None,
                  mtproto_peer_cache_hit: bool = False,
                  mtproto_peer_resolved: bool = False) -> FetchResult:
    posts = sorted(posts, key=lambda p: (p.published_at, str(p.post_id)))
    return FetchResult(
        posts=posts,
        transport=transport,
        transport_ok=transport_ok,
        window_complete=window_complete,
        error=error,
        oldest=posts[0].published_at if posts else None,
        newest=posts[-1].published_at if posts else None,
        raw_items=len(posts) if raw_items is None else raw_items,
        mtproto_peer_cache_hit=mtproto_peer_cache_hit,
        mtproto_peer_resolved=mtproto_peer_resolved,
    )


def _channel_cache_key(channel: str) -> str:
    return str(channel or "").strip().lstrip("@").lower()


def load_telegram_peer_cache(path: Path) -> dict[str, dict[str, Any]]:
    """Load non-secret Telegram peer metadata used to avoid username resolves.

    The cache contains only entity type/id/access_hash. It does NOT contain the
    Telegram authorization key or StringSession credential.
    """
    if not path.exists():
        return {}
    try:
        payload = json.loads(path.read_text(encoding="utf-8"))
    except Exception as exc:
        print(f"telegram peer cache: ignoring unreadable {path}: {exc}", file=sys.stderr)
        return {}
    raw = payload.get("peers", payload) if isinstance(payload, dict) else {}
    if not isinstance(raw, dict):
        return {}

    out: dict[str, dict[str, Any]] = {}
    for channel, entry in raw.items():
        if not isinstance(entry, dict):
            continue
        key = _channel_cache_key(channel)
        peer_type = str(entry.get("peer_type") or "").lower()
        try:
            peer_id = int(entry.get("id"))
        except Exception:
            continue
        access_hash = entry.get("access_hash")
        if peer_type in {"channel", "user"}:
            try:
                access_hash = int(access_hash)
            except Exception:
                continue
        elif peer_type != "chat":
            continue
        out[key] = {
            "peer_type": peer_type,
            "id": peer_id,
            **({"access_hash": access_hash} if peer_type in {"channel", "user"} else {}),
            "username": key,
            "source": entry.get("source") or "persisted",
        }
    return out


def save_telegram_peer_cache(path: Path, peers: dict[str, dict[str, Any]]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    payload = {
        "version": 1,
        "updated_at": datetime.now(timezone.utc).isoformat(),
        "note": "Entity metadata only; no Telegram auth/session credential is stored here.",
        "peers": {k: peers[k] for k in sorted(peers)},
    }
    tmp = path.with_suffix(path.suffix + ".tmp")
    tmp.write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")
    tmp.replace(path)


def _input_peer_from_cache(entry: dict[str, Any] | None):
    if not entry:
        return None
    peer_type = entry.get("peer_type")
    try:
        if peer_type == "channel" and InputPeerChannel is not None:
            return InputPeerChannel(int(entry["id"]), int(entry["access_hash"]))
        if peer_type == "user" and InputPeerUser is not None:
            return InputPeerUser(int(entry["id"]), int(entry["access_hash"]))
        if peer_type == "chat" and InputPeerChat is not None:
            return InputPeerChat(int(entry["id"]))
    except Exception:
        return None
    return None


def _store_input_peer(peer_cache: dict[str, dict[str, Any]], channel: str, peer,
                      *, source: str) -> bool:
    key = _channel_cache_key(channel)
    entry: dict[str, Any] | None = None
    try:
        if InputPeerChannel is not None and isinstance(peer, InputPeerChannel):
            entry = {
                "peer_type": "channel",
                "id": int(peer.channel_id),
                "access_hash": int(peer.access_hash),
                "username": key,
                "source": source,
            }
        elif InputPeerUser is not None and isinstance(peer, InputPeerUser):
            entry = {
                "peer_type": "user",
                "id": int(peer.user_id),
                "access_hash": int(peer.access_hash),
                "username": key,
                "source": source,
            }
        elif InputPeerChat is not None and isinstance(peer, InputPeerChat):
            entry = {
                "peer_type": "chat",
                "id": int(peer.chat_id),
                "username": key,
                "source": source,
            }
    except (TypeError, ValueError):
        return False
    if entry is None:
        return False
    changed = peer_cache.get(key) != entry
    peer_cache[key] = entry
    return changed


def preload_peer_cache_from_dialogs(client, peer_cache: dict[str, dict[str, Any]],
                                    channels: list[str]) -> tuple[int, str | None]:
    """Seed peers from the account's existing dialogs without ResolveUsername.

    During a ResolveUsername FloodWait, official channels already followed by
    this account can still use MTProto because GetDialogs supplies access hashes.
    """
    wanted = {_channel_cache_key(c) for c in channels if c}
    missing = wanted - set(peer_cache)
    if not missing:
        return 0, None
    added = 0
    try:
        for dialog in client.iter_dialogs(limit=None):
            entity = getattr(dialog, "entity", None)
            username = _channel_cache_key(getattr(entity, "username", ""))
            if not username or username not in missing:
                continue
            peer = getattr(dialog, "input_entity", None)
            if peer is None:
                peer = client.get_input_entity(entity)
            if _store_input_peer(peer_cache, username, peer, source="dialog"):
                added += 1
            missing.discard(username)
            if not missing:
                break
    except Exception as exc:
        return added, str(exc)
    return added, None


def make_telegram_mtproto_client():
    """Return an authenticated read-only Telegram client when secrets exist.

    The authorization credential remains a StringSession in GitHub Secrets.
    Entity ids/access hashes are persisted separately in data/telegram_peers.json
    so normal archive runs do not repeatedly call ResolveUsernameRequest.
    """
    api_id = (os.getenv("TELEGRAM_API_ID") or "").strip()
    api_hash = (os.getenv("TELEGRAM_API_HASH") or "").strip()
    session_string = (os.getenv("TELEGRAM_SESSION") or "").strip()
    if not (api_id and api_hash and session_string):
        return None
    if TelegramClient is None or StringSession is None:
        raise RuntimeError("Telethon is not installed but Telegram MTProto secrets are configured")
    client = TelegramClient(StringSession(session_string), int(api_id), api_hash)
    client.connect()
    if not client.is_user_authorized():
        client.disconnect()
        raise RuntimeError("TELEGRAM_SESSION is present but is not authorized")
    return client


def _resolve_mtproto_peer(client, channel: str,
                          peer_cache: dict[str, dict[str, Any]]) -> tuple[Any, bool, bool]:
    key = _channel_cache_key(channel)
    cached = _input_peer_from_cache(peer_cache.get(key))
    if cached is not None:
        return cached, True, False

    if getattr(client, "_archive_resolve_flooded", False):
        wait_s = int(getattr(client, "_archive_resolve_wait_seconds", 0) or 0)
        suffix = f" ({wait_s}s remaining when observed)" if wait_s else ""
        raise RuntimeError(f"MTProto peer cache miss while ResolveUsername flood-wait is active{suffix}")

    resolve_delay = max(0.0, float(os.getenv("TELEGRAM_RESOLVE_DELAY_SECONDS", "5.0")))
    last_resolve = float(getattr(client, "_archive_last_resolve_monotonic", 0.0) or 0.0)
    wait_for = resolve_delay - (time.monotonic() - last_resolve)
    if wait_for > 0:
        time.sleep(wait_for)

    try:
        peer = client.get_input_entity(channel)
    finally:
        setattr(client, "_archive_last_resolve_monotonic", time.monotonic())

    stored = _store_input_peer(peer_cache, channel, peer, source="resolved")
    if not stored and _input_peer_from_cache(peer_cache.get(key)) is None:
        raise RuntimeError(f"MTProto resolved @{key} but did not return a cacheable input peer")
    return peer, False, True


def fetch_posts_mtproto_for_window(client, channel: str, start_utc: datetime,
                                    end_utc: datetime, context_hours: int = 48,
                                    max_messages: int = 20000,
                                    peer_cache: dict[str, dict[str, Any]] | None = None) -> FetchResult:
    context_start = start_utc - timedelta(hours=max(12, context_hours))
    peer_cache = peer_cache if peer_cache is not None else {}
    entity, cache_hit, resolved_now = _resolve_mtproto_peer(client, channel, peer_cache)
    posts: list[Post] = []
    scanned = 0
    reached_old_edge = False

    for msg in client.iter_messages(
        entity,
        offset_date=end_utc + timedelta(seconds=1),
        limit=max_messages,
    ):
        scanned += 1
        if not getattr(msg, "date", None):
            continue
        dt = msg.date.astimezone(timezone.utc) if msg.date.tzinfo else msg.date.replace(tzinfo=timezone.utc)
        if dt < context_start:
            reached_old_edge = True
            break
        text = (getattr(msg, "message", None) or "").strip()
        if not text:
            continue
        fwd_name = None
        fwd = getattr(msg, "fwd_from", None)
        if fwd is not None:
            fwd_name = getattr(fwd, "from_name", None)
        posts.append(Post(
            channel=channel,
            post_id=int(msg.id),
            published_at=dt,
            text=text,
            url=f"https://t.me/{channel}/{int(msg.id)}",
            forwarded_from=fwd_name,
        ))

    complete = reached_old_edge or scanned < max_messages
    return _fetch_result(
        posts,
        context_start,
        transport="telegram_mtproto",
        window_complete=complete,
        raw_items=scanned,
        mtproto_peer_cache_hit=cache_hit,
        mtproto_peer_resolved=resolved_now,
    )


def fetch_telegram_with_fallback(session: requests.Session, channel: str,
                                 start_utc: datetime, end_utc: datetime,
                                 max_pages: int, context_hours: int,
                                 mt_client=None,
                                 peer_cache: dict[str, dict[str, Any]] | None = None) -> FetchResult:
    errors: list[str] = []
    if mt_client is not None:
        try:
            mt_result = fetch_posts_mtproto_for_window(
                mt_client, channel, start_utc, end_utc,
                context_hours=context_hours,
                max_messages=int(os.getenv("TELEGRAM_MT_MAX_MESSAGES", "20000")),
                peer_cache=peer_cache,
            )
            if mt_result.posts or mt_result.raw_items > 1:
                return mt_result
            errors.append("mtproto returned suspiciously empty history (raw_items <= 1)")
        except Exception as exc:
            message = str(exc)
            errors.append(f"mtproto: {message}")
            if "ResolveUsernameRequest" in message and ("A wait of" in message or "FloodWait" in type(exc).__name__):
                setattr(mt_client, "_archive_resolve_flooded", True)
                m = re.search(r"A wait of\s+(\d+)\s+seconds", message)
                if m:
                    setattr(mt_client, "_archive_resolve_wait_seconds", int(m.group(1)))
                print(
                    "telegram MTProto ResolveUsername flood-wait detected; "
                    "cached peers continue on MTProto, uncached peers use HTML fallback",
                    file=sys.stderr,
                )

    context_start = start_utc - timedelta(hours=max(12, context_hours))
    try:
        posts = fetch_posts_html_for_window(
            session, channel, start_utc, end_utc,
            max_pages=max_pages, context_hours=context_hours,
        )
    except Exception as exc:
        errors.append(f"html: {exc}")
        return _fetch_result([], context_start, transport="telegram_public_html",
                             transport_ok=False, window_complete=False,
                             error="; ".join(errors))

    if not posts:
        errors.append("public Telegram page returned zero parseable messages")
        return _fetch_result([], context_start, transport="telegram_public_html",
                             transport_ok=False, window_complete=False,
                             error="; ".join(errors))

    oldest = min(p.published_at for p in posts)
    complete = oldest <= context_start + timedelta(hours=2)
    return _fetch_result(posts, context_start, transport="telegram_public_html",
                         transport_ok=True, window_complete=complete,
                         error="; ".join(errors) if errors else None)

def source_status_row(source_type: str, source_name: str, region: str,
                      fetched: FetchResult, events, reports, alert_stats,
                      *, source_layer: str = "official_local",
                      expected_active: bool = True,
                      scoped_posts: list[Post] | None = None,
                      window_posts: list[Post] | None = None,
                      window_alert_stats: dict[str, int] | None = None) -> dict[str, Any]:
    if not expected_active and not fetched.posts:
        health = "inactive"
    elif fetched.transport == "telegram_mtproto" and fetched.transport_ok and fetched.window_complete and not fetched.posts:
        health = "quiet"  # authenticated history was read; no posts in this window
    elif not fetched.transport_ok:
        health = "failed"
    elif fetched.window_complete:
        health = "healthy"
    else:
        health = "degraded"

    # An HTML source expected to be active but returning no parsed history is a
    # failure, not evidence that the region had no UAV activity.
    ok = health in {"healthy", "degraded", "quiet"}
    scoped_posts = fetched.posts if scoped_posts is None else scoped_posts
    window_posts = scoped_posts if window_posts is None else window_posts
    window_alert_stats = alert_stats if window_alert_stats is None else window_alert_stats
    scoped_oldest = min((p.published_at for p in scoped_posts), default=None)
    scoped_newest = max((p.published_at for p in scoped_posts), default=None)
    return {
        "source_type": source_type,
        "source": source_name,
        "region": region,
        "source_layer": source_layer,
        "expected_active": bool(expected_active),
        "ok": ok,
        "health": health,
        "transport": fetched.transport,
        "transport_ok": fetched.transport_ok,
        "window_complete": fetched.window_complete,
        "posts": len(scoped_posts),
        "context_posts": len(scoped_posts),
        "window_posts": len(window_posts),
        "raw_items": fetched.raw_items,
        "mtproto_peer_cache_hit": fetched.mtproto_peer_cache_hit,
        "mtproto_peer_resolved": fetched.mtproto_peer_resolved,
        "oldest_post": scoped_oldest.isoformat() if scoped_oldest else None,
        "newest_post": scoped_newest.isoformat() if scoped_newest else None,
        "error": fetched.error,
        "events": len(events),
        "reports": len(reports),
        **alert_stats,
        **{f"window_{k}": v for k, v in window_alert_stats.items()},
        **({"error": fetched.error} if fetched.error else {}),
    }

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
    # Evaluate sentence-by-sentence so a missile clear in one sentence cannot
    # accidentally clear a UAV alert mentioned in another sentence.
    chunks = [s.strip() for s in re.split(r"(?<=[.!?;])\s+", str(text)) if s.strip()] or [str(text)]
    for chunk in chunks:
        n = normalize(chunk)

        # Explicit continuation wording is a formal ongoing UAV state. This must
        # win over a nearby clear verb that belongs to another threat type, e.g.
        # "Ракетная опасность отменена, Беспилотная опасность сохраняется".
        if (
            re.search(r"\\bбеспилотн\\w*\\s+опасност\\w*.{0,60}\\b(?:сохраняется|действует)\\b", n)
            or re.search(r"\\b(?:сохраняется|действует)\\b.{0,60}\\bбеспилотн\\w*\\s+опасност\\w*", n)
        ):
            return "start"

        if any(marker in n for marker in END_MARKERS) or any(p.search(n) for p in END_PATTERNS):
            return "end"
        if any(marker in n for marker in START_MARKERS) or any(p.search(n) for p in START_PATTERNS):
            return "start"
    return None


def alert_post_stats(posts: list[Post]) -> dict[str, int]:
    starts = 0
    ends = 0
    activity = 0
    uav_activity = 0
    missile_activity = 0
    missile_starts = 0
    missile_ends = 0
    for post in posts:
        uav_kind = text_kind(post.text)
        missile_kind = missile_text_kind(post.text)
        if uav_kind == "start" or missile_kind == "start":
            starts += 1
        if uav_kind == "end" or missile_kind == "end":
            ends += 1
        if missile_kind == "start":
            missile_starts += 1
        elif missile_kind == "end":
            missile_ends += 1
        signals = activity_signals(post.text)
        if signals:
            activity += 1
        if any(threat == "uav" for threat, _ in signals):
            uav_activity += 1
        if any(threat == "missile" for threat, _ in signals):
            missile_activity += 1
    uav_reference_posts = sum(1 for post in posts if has_uav_reference(post.text))
    missile_reference_posts = sum(1 for post in posts if has_missile_reference(post.text))
    return {
        "alert_posts": starts + ends,
        "start_posts": starts,
        "end_posts": ends,
        "activity_posts": activity,
        "uav_activity_posts": uav_activity,
        "missile_activity_posts": missile_activity,
        "uav_reference_posts": uav_reference_posts,
        "missile_reference_posts": missile_reference_posts,
        "unclassified_reference_posts": max(0, uav_reference_posts + missile_reference_posts - uav_activity - missile_activity),
        "missile_start_posts": missile_starts,
        "missile_end_posts": missile_ends,
    }

ADMIN_NOUN_CASES = {
    "район": ("районе", "района", "району", "районом"),
    "округ": ("округе", "округа", "округу", "округом"),
    "город": ("городе", "города", "городу", "городом"),
    "поселок": ("поселке", "поселка", "поселку", "поселком"),
    "посёлок": ("посёлке", "посёлка", "посёлку", "посёлком"),
    "село": ("селе", "села", "селу", "селом"),
    "станица": ("станице", "станицы", "станицу", "станицей"),
    "деревня": ("деревне", "деревни", "деревню", "деревней"),
}

def _ru_adjective_case(word: str, case: str) -> str:
    """Inflect common Russian administrative adjectives conservatively."""
    lw = word.lower().replace("ё", "е")
    suffixes = (
        ("ский", {"prep": "ском", "gen": "ского", "dat": "скому", "inst": "ским"}),
        ("цкий", {"prep": "цком", "gen": "цкого", "dat": "цкому", "inst": "цким"}),
        ("ый", {"prep": "ом", "gen": "ого", "dat": "ому", "inst": "ым"}),
        ("ой", {"prep": "ом", "gen": "ого", "dat": "ому", "inst": "ым"}),
        ("ий", {"prep": "ем", "gen": "его", "dat": "ему", "inst": "им"}),
        ("ая", {"prep": "ой", "gen": "ой", "dat": "ой", "inst": "ой"}),
        ("яя", {"prep": "ей", "gen": "ей", "dat": "ей", "inst": "ей"}),
    )
    for suffix, endings in suffixes:
        if lw.endswith(suffix):
            repl = endings.get(case)
            if repl:
                return word[:-len(suffix)] + repl
    return word

def administrative_alias_variants(value: str) -> list[str]:
    """Generate phrase-level cases such as 'Клинцовском районе'.

    Official notices often name districts/okrugs adjectivally rather than using
    the settlement name itself. GeoNames ADM2 aliases give us the nominative
    phrase; these variants cover the common prepositional/genitive/dative forms.
    """
    raw = str(value or "").strip()
    if not raw or not re.search(r"[А-Яа-яЁё]", raw):
        return [raw] if raw else []

    words = raw.split()
    lowered = [w.lower().replace("ё", "е").strip(".,:;()[]{}«»\"'") for w in words]
    admin_idx = next((i for i, w in enumerate(lowered) if w in ADMIN_NOUN_CASES), None)
    if admin_idx is None:
        return [raw]

    out = [raw]
    cases = ("prep", "gen", "dat", "inst")
    noun_key = lowered[admin_idx]
    noun_forms = ADMIN_NOUN_CASES[noun_key]
    for case, noun_form in zip(cases, noun_forms):
        variant = list(words)
        variant[admin_idx] = noun_form
        # Inflect adjectives that belong to the administrative phrase. This
        # handles e.g. Стародубский муниципальный округ -> ... округе.
        for i in range(admin_idx):
            variant[i] = _ru_adjective_case(variant[i], case)
        out.append(" ".join(variant))
    return list(dict.fromkeys(out))

def alias_variants(value: str) -> list[str]:
    """Generate conservative Russian case variants for place aliases at parse time."""
    raw = str(value or "").strip()
    if not raw:
        return []
    out = [raw]
    words = raw.split()
    if words and re.search(r"[А-Яа-яЁё]", words[-1]):
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
    for variant in list(out):
        out.extend(administrative_alias_variants(variant))
    return list(dict.fromkeys(v for v in out if v))


ADMIN_CONTEXT_RE = re.compile(
    r"\b(?:"
    r"район(?:ы|ов|ах|ам|ами|е|а|у|ом)?|"
    r"округ(?:а|ов|ах|ам|ами|е|у|ом)?|"
    r"муниципалитет(?:ы|ов|ах|ам|ами|е|а|у|ом)?|"
    r"муниципальн\w*\s+(?:район\w*|округ\w*)|"
    r"городск\w*\s+округ\w*|"
    r"\bмо\b"
    r")\b"
)

def administrative_head_variants(value: str) -> list[str]:
    """Return the distinctive adjective part of an administrative alias.

    This lets us resolve compact official phrasing such as
    "Лискинский и Острогожский районы" or
    "Боровского, Жуковского ... муниципальных округов".
    """
    raw = str(value or "").strip()
    if not raw or not re.search(r"[А-Яа-яЁё]", raw):
        return []
    words = raw.split()
    clean = [w.lower().replace("ё", "е").strip(".,:;()[]{}«»\"'") for w in words]
    admin_idx = next((i for i, w in enumerate(clean) if w in ADMIN_NOUN_CASES), None)
    if admin_idx is None or admin_idx == 0:
        return []

    prefixes = [words[:admin_idx]]
    if admin_idx > 1:
        prefixes.append(words[:1])

    out = []
    for prefix in prefixes:
        out.append(" ".join(prefix))
        for case in ("prep", "gen", "dat", "inst"):
            out.append(" ".join(_ru_adjective_case(w, case) for w in prefix))
    return list(dict.fromkeys(v for v in out if len(normalize(v)) >= 4))


def extract_places(text: str, source: dict[str, Any]) -> list[dict[str, Any]]:
    n = normalize(text)
    matches = []

    def alias_present(alias: str) -> bool:
        if not alias:
            return False
        return re.search(r"(?<![а-яa-z0-9])" + re.escape(alias) + r"(?![а-яa-z0-9])", n) is not None

    def administrative_head_present(place: dict[str, Any]) -> bool:
        if place.get("type") not in ("district", "municipality", "okrug"):
            return False
        for raw_alias in place.get("aliases", []) or []:
            for raw_head in administrative_head_variants(raw_alias):
                head = normalize(raw_head)
                if not head:
                    continue
                for m in re.finditer(r"(?<![а-яa-z0-9])" + re.escape(head) + r"(?![а-яa-z0-9])", n):
                    # Shared administrative nouns often appear once after a
                    # coordinated list of adjectives, so inspect a generous
                    # local window rather than requiring adjacency.
                    window = n[max(0, m.start() - 40): min(len(n), m.end() + 180)]
                    if ADMIN_CONTEXT_RE.search(window):
                        return True
        return False

    for place in [*(source.get("places", []) or []), *(source.get("_catalog_places", []) or [])]:
        aliases = [normalize(v) for a in place.get("aliases", []) for v in alias_variants(a)]
        if any(alias_present(alias) for alias in aliases) or administrative_head_present(place):
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


def source_post_applies(post: Post, source: dict[str, Any]) -> bool:
    """Limit shared/national monitoring feeds to the configured region.

    Local channels are trusted to be region-scoped by channel identity. Shared
    feeds must explicitly mention the region or a catalogued place in it, so one
    nationwide post cannot be attributed to every configured region.
    """
    if not source.get("require_region_match"):
        return True
    return is_region_message(post.text, source) or bool(extract_places(post.text, source))


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

    def key_for(place_name: str, threat_class: str) -> str:
        return f"{source['region']}::{threat_class}::{place_name}"

    def open_one(place_name: str, scope: str, post: Post, threat_class: str,
                 precision: str = "exact", place_meta: dict[str, Any] | None = None):
        key = key_for(place_name, threat_class)
        bucket = open_alerts.setdefault(key, [])
        if bucket:
            return
        bucket.append({
            "post": post, "scope": scope, "precision": precision,
            "place_meta": place_meta or {}, "threat_class": threat_class,
        })

    def close_one(place_name: str, end_post: Post, threat_class: str, reason: str = "direct"):
        key = key_for(place_name, threat_class)
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
            "id": stable_id(
                source.get("channel", source.get("source_id", "source")),
                str(start_post.post_id), str(end_post.post_id), place_name, threat_class,
            ),
            "region": source["region"],
            "place": place_name,
            "scope": start_item["scope"],
            "precision": start_item.get("precision", "exact"),
            "alert_type": f"{threat_class}_alert",
            "threat_class": threat_class,
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
        threat_kinds = alert_threat_kinds(post.text)
        if not threat_kinds:
            continue
        n = post.normalized
        places = extract_places(post.text, source)
        region_message = is_region_message(post.text, source)

        for threat_class, kind in threat_kinds:
            if kind == "start":
                if region_message:
                    open_one(source["region"], "region", post, threat_class, "exact_region")
                for place in places:
                    open_one(place["name"], alert_scope(place), post, threat_class, "exact_local", place)
                if not region_message and not places:
                    if source.get("fallback_to_region_on_unresolved", False):
                        open_one(source["region"], "region", post, threat_class, "parent_region_fallback")
                        unmatched.append({
                            "type": "start_scope_fell_back_to_region",
                            "threat_class": threat_class,
                            "region": source["region"], "url": post.url, "text": post.text,
                        })
                    else:
                        unmatched.append({
                            "type": "unresolved_start_scope", "threat_class": threat_class,
                            "url": post.url, "text": post.text,
                        })

            elif kind == "end":
                if any(p in n for p in CLOSE_ALL_LOCAL_PHRASES):
                    for key in list(open_alerts.keys()):
                        _, key_threat, place_name = key.split("::", 2)
                        if key_threat != threat_class or place_name == source["region"]:
                            continue
                        while open_alerts.get(key):
                            close_one(place_name, post, threat_class, "all_local_clear")
                    continue

                if region_message:
                    close_one(source["region"], post, threat_class, "regional_clear")
                    for key in list(open_alerts.keys()):
                        _, key_threat, place_name = key.split("::", 2)
                        if key_threat != threat_class or place_name == source["region"]:
                            continue
                        while open_alerts.get(key):
                            close_one(place_name, post, threat_class, "regional_clear")
                for place in places:
                    close_one(place["name"], post, threat_class, "direct")
                if not region_message and not places and source.get("fallback_to_region_on_unresolved", False):
                    close_one(source["region"], post, threat_class, "parent_region_fallback_clear")

    for key, bucket in open_alerts.items():
        _, threat_class, place_name = key.split("::", 2)
        for item in bucket:
            p: Post = item["post"]
            unmatched.append({
                "type": "unmatched_start",
                "threat_class": threat_class,
                "region": source["region"],
                "place": place_name,
                "start": p.published_at.isoformat(),
                "url": p.url,
                "text": p.text,
            })
    return events, unmatched

def mod_derived(post: Post, source: dict[str, Any] | None = None) -> bool:
    # Forwarded federal MOD posts are provenance duplicates. A local authority's
    # own post that says "по данным Минобороны" is retained when it also names
    # the region or a configured local place; otherwise a national digest could
    # be falsely attributed to the source's region.
    forwarded = normalize(post.forwarded_from or "")
    if "минобороны" in forwarded or "министерство обороны" in forwarded:
        return True
    text = normalize(post.text)
    if not any(marker in text for marker in MOD_DERIVED_MARKERS):
        return False
    if source is not None and (is_region_message(post.text, source) or extract_places(post.text, source)):
        return False
    return True

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

    # Monitoring/Radar wording: "Фиксация 2 БПЛА", "Фиксация от 3 БПЛА".
    m = re.search(r"\bфиксац\w*\b\s*(?:от\s+|сразу\s+)?(?:(более|свыше|около|примерно|порядка)\s+)?(\d+)\s*(?:бпла|беспилотник\w*)", n)
    if m:
        out.append((int(m.group(2)), "detected_reported", None, None, q(m.group(1))))
        return out

    m = re.search(r"(?:атаки|атакован[а-я]*|атаковали|нанесены удары)\D{0,28}(?:(более|свыше|около|примерно|порядка)\s+)?(\d+)\s*(?:бпла|беспилотник\w*)", n)
    if m:
        primary = int(m.group(2))
        sec = re.search(r"из которых\s+(\d+)\s+(?:подавлен\w*\s+и\s+)?(?:сбит\w*|сбил\w*)", n)
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

def classify_missile_count_sentence(sentence: str) -> list[tuple[int, str, int | None, str | None, str | None]]:
    n = normalize(sentence)
    out = []

    def q(prefix: str | None) -> str | None:
        if not prefix:
            return None
        prefix = normalize(prefix)
        if "более" in prefix or "свыше" in prefix: return "at_least"
        if "около" in prefix or "примерно" in prefix or "порядка" in prefix: return "approx"
        return None

    m = re.search(r"\bфиксац\w*\b\s*(?:от\s+|сразу\s+)?(?:(более|свыше|около|примерно|порядка)\s+)?(\d+)\s*(?:ракет\w*)", n)
    if m:
        out.append((int(m.group(2)), "missile_detected_reported", None, None, q(m.group(1))))
        return out

    m = re.search(r"(?:летит|летят|движ\w*|направля\w*|подлета\w*)\D{0,18}(?:(более|свыше|около|примерно|порядка)\s+)?(\d+)\s*(?:ракет\w*)", n)
    if m:
        out.append((int(m.group(2)), "missile_incoming_reported", None, None, q(m.group(1))))
        return out

    return out


def cross_region_aggregate_count_text(text: str) -> bool:
    """Detect nationwide/multi-region aggregate totals that must not be assigned to one region."""
    n = normalize(text)
    if not any(marker in n for marker in ("над территориями", "в регионах", "над регионами")):
        return False
    admin_groups = len(re.findall(r"\b(?:област\w*|кра\w*|республик\w*|автономн\w*\s+округ\w*)\b", n))
    return admin_groups >= 2


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
        if mod_derived(post, source):
            continue

        whole_signals = activity_signals(post.text)
        npost = normalize(post.text)
        if not whole_signals and not any(token in npost for token in ("бпла", "беспилот", "дрон", "ракет")):
            continue

        produced_threats: set[str] = set()

        # Preserve explicit UAV/missile quantities when the source states them.
        # Multi-region aggregate totals are not assigned to one local region.
        for sentence in sentence_split(post.text):
            numeric_sets = [
                ("uav", classify_count_sentence(sentence)),
                ("missile", classify_missile_count_sentence(sentence)),
            ]
            for threat_class, counts in numeric_sets:
                if not counts:
                    continue
                if (
                    str(source.get("source_layer") or "").startswith("monitoring_")
                    and cross_region_aggregate_count_text(sentence)
                ):
                    continue

                activity_kind = (
                    uav_activity_kind(sentence)
                    if threat_class == "uav"
                    else missile_activity_kind(sentence)
                ) or next((kind for threat, kind in whole_signals if threat == threat_class), None)
                if activity_kind is None:
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
                signal_class = "missile_activity_signal" if threat_class == "missile" else "uav_activity_signal"

                for count, ctype, secondary_count, secondary_type, qualifier in counts:
                    reports.append({
                        "id": stable_id(source.get("channel", source.get("source_id", "source")), str(post.post_id), place, ctype, str(count), threat_class),
                        "region": source["region"], "place": place, "scope": scope,
                        "at": post.published_at.isoformat(), "count": count, "count_type": ctype,
                        "signal_class": signal_class,
                        "threat_class": threat_class,
                        "activity_kind": activity_kind,
                        "count_qualifier": qualifier, "secondary_count": secondary_count, "secondary_type": secondary_type,
                        "text": sentence, "source_name": source["source_name"], "url": post.url,
                        "source_kind": source.get("kind", "official"),
                        "lat": primary_place.get("lat") if primary_place else None,
                        "lon": primary_place.get("lon") if primary_place else None,
                        "mentioned_places": mentioned_places,
                    })
                    produced_threats.add(threat_class)

        # Display-first policy for both UAV and missile activity.
        for threat_class, activity_kind in whole_signals:
            if threat_class in produced_threats:
                continue
            mentioned = infer_report_places(post.text, source)
            primary_place = mentioned[0] if mentioned else None
            place = primary_place["name"] if primary_place else source["region"]
            scope = alert_scope(primary_place) if primary_place else "region"
            display_type = activity_kind if activity_kind.startswith("alert_") else "official_activity"
            signal_class = (
                "formal_alert_signal" if activity_kind == "alert_start_signal"
                else "alert_clear_signal" if activity_kind == "alert_end_signal"
                else "missile_activity_signal" if threat_class == "missile"
                else "uav_activity_signal"
            )
            reports.append({
                "id": stable_id(source.get("channel", source.get("source_id", "source")), str(post.post_id), place, activity_kind, threat_class),
                "region": source["region"], "place": place, "scope": scope,
                "at": post.published_at.isoformat(), "count": None, "count_type": display_type,
                "activity_kind": activity_kind,
                "signal_class": signal_class,
                "threat_class": threat_class,
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


TRANSPORT_QUALITY = {
    "telegram_mtproto": 30,
    # Legacy Telegram records predate per-record provenance. Treat them as
    # better than HTML fallback so a degraded backfill can never erase them.
    "legacy_telegram_unknown": 20,
    "telegram_public_html": 10,
    "mchs_rss": 5,
    "unknown": 0,
}

def transport_quality(transport: str | None, source_kind: str | None = None) -> int:
    if transport:
        return TRANSPORT_QUALITY.get(str(transport), 0)
    if source_kind == "telegram":
        return TRANSPORT_QUALITY["legacy_telegram_unknown"]
    if source_kind == "mchs_rss":
        return TRANSPORT_QUALITY["mchs_rss"]
    return 0

def record_source_id(record: dict[str, Any]) -> str | None:
    source_id = record.get("source_id")
    if source_id:
        return str(source_id)
    # Legacy Telegram records did not store source_id; recover the channel from
    # the message/source URL so source-level transport protection still works.
    for field in ("url", "start_url", "end_url", "source_url"):
        value = str(record.get(field) or "")
        m = re.search(r"(?:https?://)?t\.me/(?:s/)?([^/?#]+)", value)
        if m:
            return m.group(1)
    return None

def source_collection_sort_key(source: dict[str, Any]) -> tuple[int, int, str]:
    """Collect coverage-primary monitoring before official/corroborating feeds."""
    layer = str(source.get("source_layer") or "official_local")
    default_rank = 0 if layer == "monitoring_local" else 1 if layer == "monitoring_national" else 2
    coverage_priority = int(source.get("coverage_priority", default_rank))
    config_priority = int(source.get("priority", 50) or 50)
    return (coverage_priority, config_priority, str(source.get("channel") or ""))


def annotate_provenance(records: list[dict[str, Any]], source: dict[str, Any],
                        transport: str, window_complete: bool) -> None:
    source_id = str(source.get("channel") or source.get("source_id") or "")
    quality = transport_quality(transport, source.get("kind"))
    for record in records:
        record["source_id"] = source_id
        record["transport"] = transport
        record["transport_quality"] = quality
        record["transport_window_complete"] = bool(window_complete)
        record["source_layer"] = source.get("source_layer", "official_local")
        record["verified_official"] = bool(source.get("verified_official", False))
        record["coverage_role"] = source.get(
            "coverage_role",
            "primary_monitoring" if source.get("source_layer") == "monitoring_local"
            else "monitoring_fallback" if source.get("source_layer") == "monitoring_national"
            else "cross_validation",
        )
        record["coverage_priority"] = int(source.get("coverage_priority", 50) or 50)
        record["verification_weight"] = int(
            source.get("verification_weight", 100 if source.get("verified_official") else 70) or 0
        )
        if source.get("monitoring_family"):
            record["monitoring_family"] = source["monitoring_family"]

def record_quality(record: dict[str, Any]) -> int:
    stored = record.get("transport_quality")
    if isinstance(stored, (int, float)):
        return int(stored)
    return transport_quality(record.get("transport"), record.get("source_kind"))


def collect(args) -> dict[str, Any]:
    source_cfg = json.loads(Path(args.sources).read_text(encoding="utf-8"))
    region_cfg = json.loads(Path(args.regions).read_text(encoding="utf-8"))
    peer_cache_path = Path(getattr(args, "telegram_peer_cache", DEFAULT_TELEGRAM_PEERS))
    peer_cache = load_telegram_peer_cache(peer_cache_path)
    peer_cache_initial = len(peer_cache)
    dialog_peers_added = 0
    dialog_peer_error = None
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
    window_end = getattr(args, "window_end_override", None) or (now - timedelta(hours=args.safety_lag_hours))
    window_start = getattr(args, "window_start_override", None) or (window_end - timedelta(hours=args.lookback_hours))

    all_events: list[dict[str, Any]] = []
    all_reports: list[dict[str, Any]] = []
    all_unmatched: list[dict[str, Any]] = []
    statuses: list[dict[str, Any]] = []

    # High-resolution official source stack first.  Multiple independent sources
    # per region are intentional (governor/government + emergency/ops channels).
    # MTProto is preferred; public Telegram HTML is only a fallback.
    session = make_session()
    mt_client = None
    mtproto_enabled = False
    mtproto_error = None
    try:
        mt_client = make_telegram_mtproto_client()
        mtproto_enabled = mt_client is not None
        if mt_client is not None:
            configured_channels = [
                str(s.get("channel"))
                for s in sorted(source_cfg.get("sources", []), key=source_collection_sort_key)
                if s.get("enabled", False) and s.get("kind", "telegram") == "telegram" and s.get("channel")
            ]
            dialog_peers_added, dialog_peer_error = preload_peer_cache_from_dialogs(
                mt_client, peer_cache, configured_channels
            )
            if dialog_peers_added:
                save_telegram_peer_cache(peer_cache_path, peer_cache)
                print(
                    f"telegram peer cache: seeded {dialog_peers_added} peers from existing dialogs",
                    file=sys.stderr,
                )
            if dialog_peer_error:
                print(f"telegram peer cache dialog preload warning: {dialog_peer_error}", file=sys.stderr)
    except Exception as exc:
        mtproto_error = str(exc)
        print(f"telegram MTProto setup ERROR: {exc}; falling back to public HTML", file=sys.stderr)

    telegram_fetch_cache: dict[str, FetchResult] = {}
    try:
        for source0 in sorted(source_cfg.get("sources", []), key=source_collection_sort_key):
            if not source0.get("enabled", False):
                continue
            source = dict(source0)
            if source.get("kind", "telegram") != "telegram":
                continue
            source["_catalog_places"] = cities_by_region.get(source.get("region", ""), [])
            channel = source["channel"]
            try:
                cache_hit = channel in telegram_fetch_cache
                if cache_hit:
                    fetched = telegram_fetch_cache[channel]
                else:
                    before_peer_count = len(peer_cache)
                    fetched = fetch_telegram_with_fallback(
                        session, channel, window_start, window_end,
                        max_pages=args.max_pages, context_hours=args.context_hours,
                        mt_client=mt_client,
                        peer_cache=peer_cache,
                    )
                    telegram_fetch_cache[channel] = fetched
                    if len(peer_cache) != before_peer_count:
                        save_telegram_peer_cache(peer_cache_path, peer_cache)
                posts = [p for p in fetched.posts if source_post_applies(p, source)]
                window_posts = [p for p in posts if window_start <= p.published_at <= window_end]
                events, unmatched = pair_alerts(posts, source, window_start, window_end)
                reports = extract_reports(posts, source, window_start, window_end)
                candidate_events = len(events)
                candidate_reports = len(reports)
                fallback_suppressed = False
                if source.get("fallback_only_if_no_local_activity"):
                    local_present = any(
                        r.get("region") == source.get("region")
                        and r.get("source_layer") == "monitoring_local"
                        and window_start <= parse_iso(r.get("at")) <= window_end
                        for r in all_reports
                        if r.get("at")
                    )
                    if local_present:
                        events = []
                        reports = []
                        unmatched = []
                        fallback_suppressed = True
                annotate_provenance(events, source, fetched.transport, fetched.window_complete)
                annotate_provenance(reports, source, fetched.transport, fetched.window_complete)
                all_events.extend(events); all_reports.extend(reports); all_unmatched.extend(unmatched)
                alert_stats = alert_post_stats(posts)
                window_alert_stats = alert_post_stats(window_posts)
                row = source_status_row(
                    "telegram", channel, source["region"], fetched, events, reports, alert_stats,
                    source_layer=source.get("source_layer", "official_local"),
                    expected_active=source.get("expected_active", True),
                    scoped_posts=posts,
                    window_posts=window_posts,
                    window_alert_stats=window_alert_stats,
                )
                row["coverage_role"] = source.get(
                    "coverage_role",
                    "primary_monitoring" if source.get("source_layer") == "monitoring_local"
                    else "monitoring_fallback" if source.get("source_layer") == "monitoring_national"
                    else "cross_validation",
                )
                row["coverage_priority"] = int(source.get("coverage_priority", 50) or 50)
                row["verification_weight"] = int(source.get("verification_weight", 100 if source.get("verified_official") else 70) or 0)
                row["fetch_cache_hit"] = bool(cache_hit)
                row["fallback_suppressed"] = bool(fallback_suppressed)
                row["candidate_events"] = candidate_events
                row["candidate_reports"] = candidate_reports
                statuses.append(row)
                print(
                    f"telegram {channel}: health={row['health']} transport={row['transport']} "
                    f"cache={'hit' if cache_hit else 'miss'} fallback={'suppressed' if fallback_suppressed else 'used'} "
                    f"posts={len(posts)} window_posts={len(window_posts)} "
                    f"alerts={window_alert_stats['alert_posts']} "
                    f"starts={window_alert_stats['start_posts']} ends={window_alert_stats['end_posts']} "
                    f"events={len(events)} reports={len(reports)}",
                    file=sys.stderr,
                )
            except Exception as exc:
                statuses.append({
                    "source_type": "telegram", "source": channel, "region": source["region"],
                    "source_layer": source.get("source_layer", "official_local"),
                    "coverage_role": source.get("coverage_role", "cross_validation"),
                    "coverage_priority": int(source.get("coverage_priority", 50) or 50),
                    "verification_weight": int(source.get("verification_weight", 100 if source.get("verified_official") else 70) or 0),
                    "expected_active": source.get("expected_active", True),
                    "ok": False, "health": "failed", "transport": "unknown",
                    "transport_ok": False, "window_complete": False, "posts": 0,
                    "events": 0, "reports": 0, "alert_posts": 0, "start_posts": 0,
                    "end_posts": 0, "activity_posts": 0, "error": str(exc),
                })
                print(f"telegram {channel}: ERROR {exc}", file=sys.stderr)
    finally:
        if mt_client is not None:
            try:
                mt_client.disconnect()
            except Exception:
                pass
        if peer_cache != load_telegram_peer_cache(peer_cache_path):
            save_telegram_peer_cache(peer_cache_path, peer_cache)

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
        annotate_provenance(events, source, "mchs_rss", False)
        annotate_provenance(reports, source, "mchs_rss", False)
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
                    "source_type": "mchs_rss", "source": region["mchs_rss_url"], "region": region["region"],
                    "source_layer": "auxiliary_rss", "ok": True,
                    "health": "auxiliary", "transport": "mchs_rss", "transport_ok": True,
                    "window_complete": False, "posts": len(posts),
                    "oldest_post": min((p.published_at for p in posts), default=None).isoformat() if posts else None,
                    "newest_post": max((p.published_at for p in posts), default=None).isoformat() if posts else None,
                    "events": len(events), "reports": len(reports), **alert_stats,
                })
            except Exception as exc:
                statuses.append({
                    "source_type": "mchs_rss", "source": region.get("mchs_rss_url"), "region": region["region"],
                    "source_layer": "auxiliary_rss", "ok": False, "health": "failed",
                    "transport": "mchs_rss", "transport_ok": False, "window_complete": False,
                    "posts": 0, "events": 0, "reports": 0, "alert_posts": 0,
                    "start_posts": 0, "end_posts": 0, "activity_posts": 0,
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
    regions_with_missile_activity = sorted({s["region"] for s in statuses if s.get("missile_activity_posts", 0) > 0})
    regions_with_any_record = sorted({e["region"] for e in all_events} | {r["region"] for r in all_reports})
    hi_res_regions_with_events = sorted({e["region"] for e in all_events if e.get("source_kind") == "telegram"})
    configured_hi_regions = {
        s.get("region") for s in source_cfg.get("sources", [])
        if s.get("enabled", False) and s.get("kind", "telegram") == "telegram" and s.get("region")
    }
    transport_ok_hi_regions = {s.get("region") for s in telegram_status if s.get("transport_ok")}
    activity_hi_regions = {s.get("region") for s in telegram_status if s.get("activity_posts", 0) > 0}
    failed_hi_regions = {
        region for region in configured_hi_regions
        if not any(s.get("region") == region and s.get("transport_ok") for s in telegram_status)
    }
    return {
        "schema_version": 7,
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
            "regions_with_missile_activity_posts": len(regions_with_missile_activity),
            "regions_with_any_record": len(regions_with_any_record),
            "regions_with_paired_alerts": len(regions_with_events),
            "high_resolution_sources_configured": len([s for s in source_cfg.get("sources", []) if s.get("enabled", False) and s.get("kind", "telegram") == "telegram"]),
            "high_resolution_regions_configured": len(configured_hi_regions),
            "high_resolution_regions_transport_ok": len(transport_ok_hi_regions),
            "high_resolution_regions_failed": len(failed_hi_regions),
            "high_resolution_regions_with_activity_posts": len(activity_hi_regions),
            "high_resolution_sources_ok": sum(1 for s in telegram_status if s.get("ok")),
            "high_resolution_sources_healthy": sum(1 for s in telegram_status if s.get("health") == "healthy"),
            "high_resolution_sources_degraded": sum(1 for s in telegram_status if s.get("health") == "degraded"),
            "high_resolution_sources_failed": sum(1 for s in telegram_status if s.get("health") == "failed"),
            "high_resolution_sources_quiet": sum(1 for s in telegram_status if s.get("health") == "quiet"),
            "high_resolution_sources_with_alert_posts": sum(1 for s in telegram_status if s.get("alert_posts", 0) > 0),
            "high_resolution_sources_with_activity_posts": sum(1 for s in telegram_status if s.get("activity_posts", 0) > 0),
            "high_resolution_regions_with_events": len(hi_res_regions_with_events),
            "telegram_mtproto_enabled": mtproto_enabled,
            "telegram_mtproto_error": mtproto_error,
            "telegram_mtproto_sources_used": sum(1 for s in telegram_status if s.get("transport") == "telegram_mtproto" and s.get("transport_ok")),
            "telegram_public_html_sources_used": sum(1 for s in telegram_status if s.get("transport") == "telegram_public_html"),
            "high_resolution_sources_window_complete": sum(1 for s in telegram_status if s.get("window_complete")),
            "telegram_peer_cache_entries": len(peer_cache),
            "telegram_peer_cache_initial_entries": peer_cache_initial,
            "telegram_peer_cache_dialog_added": dialog_peers_added,
            "telegram_peer_cache_hits": sum(1 for s in telegram_status if s.get("mtproto_peer_cache_hit")),
            "telegram_peer_resolved_this_run": sum(1 for s in telegram_status if s.get("mtproto_peer_resolved")),
            "telegram_mtproto_resolve_flooded": bool(getattr(mt_client, "_archive_resolve_flooded", False)) if mt_client is not None else False,
            "telegram_mtproto_resolve_wait_seconds": int(getattr(mt_client, "_archive_resolve_wait_seconds", 0) or 0) if mt_client is not None else 0,
            "telegram_dialog_preload_error": dialog_peer_error,
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
    """Merge a new collection window without downgrading historical provenance.

    A lower-quality transport (especially public Telegram HTML fallback) may add
    new records, but it must never delete or replace records previously obtained
    through MTProto. Legacy Telegram records without transport metadata are also
    protected from HTML fallback, because their exact provenance cannot be
    reconstructed safely.

    A later MTProto backfill is allowed to replace legacy/fallback records.
    """
    if not output_path.exists():
        data["coverage"]["archive_events_total"] = len(data.get("events", []))
        data["coverage"]["archive_reports_total"] = len(data.get("reports", []))
        data["coverage"]["archive_regions_with_records"] = len(
            {e.get("region") for e in data.get("events", []) if e.get("region")}
            | {r.get("region") for r in data.get("reports", []) if r.get("region")}
        )
        data["coverage"]["archive_regions_with_local_records"] = len(
            {e.get("region") for e in data.get("events", []) if e.get("region") and e.get("scope") in ("city","municipality")}
            | {r.get("region") for r in data.get("reports", []) if r.get("region") and (r.get("scope") in ("city","municipality") or (r.get("mentioned_places") or []))}
        )
        data["coverage"]["protected_higher_quality_records"] = 0
        return data

    try:
        old = json.loads(output_path.read_text(encoding="utf-8"))
        cutoff = parse_iso(data["window_start"])
    except Exception:
        return data

    status_by_source: dict[str, dict[str, Any]] = {}
    for status in data.get("source_status", []) or []:
        source = status.get("source")
        if source:
            status_by_source[str(source)] = status

    def current_source_quality(record: dict[str, Any]) -> int:
        source_id = record_source_id(record)
        status = status_by_source.get(source_id or "")
        if status is None:
            return 0
        return transport_quality(status.get("transport"), record.get("source_kind"))

    protected = 0

    def old_record_should_survive(record: dict[str, Any], time_field: str) -> bool:
        nonlocal protected
        try:
            timestamp = parse_iso(record.get(time_field))
        except Exception:
            return False
        if timestamp < cutoff:
            return True

        old_quality = record_quality(record)
        new_quality = current_source_quality(record)
        if old_quality > new_quality:
            protected += 1
            return True
        return False

    keep_events = [
        e for e in old.get("events", [])
        if old_record_should_survive(e, "end" if e.get("end") else "start")
    ]
    keep_reports = [
        r for r in old.get("reports", [])
        if old_record_should_survive(r, "at")
    ]

    def prefer_higher_quality(records: list[dict[str, Any]]) -> list[dict[str, Any]]:
        chosen: dict[str, dict[str, Any]] = {}
        for record in records:
            rid = record.get("id")
            if not rid:
                continue
            existing = chosen.get(rid)
            # Equal quality prefers the later/newer item in the input list.
            if existing is None or record_quality(record) >= record_quality(existing):
                chosen[rid] = record
        return list(chosen.values())

    data["events"] = sorted(
        prefer_higher_quality([*keep_events, *data.get("events", [])]),
        key=lambda e: (e.get("start", ""), e.get("region", ""), e.get("place", "")),
    )
    data["reports"] = sorted(
        prefer_higher_quality([*keep_reports, *data.get("reports", [])]),
        key=lambda r: (r.get("at", ""), r.get("region", ""), r.get("place", "")),
    )

    data["coverage"]["protected_higher_quality_records"] = protected
    data["coverage"]["archive_events_total"] = len(data["events"])
    data["coverage"]["archive_reports_total"] = len(data["reports"])
    archive_regions = {e.get("region") for e in data["events"] if e.get("region")} | {r.get("region") for r in data["reports"] if r.get("region")}
    archive_local_regions = {e.get("region") for e in data["events"] if e.get("scope") in ("city","municipality")} | {r.get("region") for r in data["reports"] if r.get("scope") in ("city","municipality") or (r.get("mentioned_places") or [])}
    data["coverage"]["archive_regions_with_records"] = len(archive_regions)
    data["coverage"]["archive_regions_with_local_records"] = len({x for x in archive_local_regions if x})
    return data


def revalidate_archive_reports(data: dict[str, Any]) -> dict[str, Any]:
    """Re-run non-formal archived activity through the current classifier."""
    kept: list[dict[str, Any]] = []
    removed = 0
    reclassified = 0
    for report in data.get("reports", []) or []:
        signal_class = report.get("signal_class")
        threat = report.get("threat_class")
        text = str(report.get("text") or "").strip()

        if signal_class in {"formal_alert_signal", "alert_clear_signal"} or not text:
            kept.append(report)
            continue

        kind = None
        if threat == "uav" and signal_class == "uav_activity_signal":
            kind = uav_activity_kind(text)
        elif threat == "missile" and signal_class == "missile_activity_signal":
            kind = missile_activity_kind(text)
        else:
            kept.append(report)
            continue

        if kind is None or kind in {"alert_start_signal", "alert_end_signal"}:
            removed += 1
            continue
        if report.get("activity_kind") != kind:
            report["activity_kind"] = kind
            if report.get("count") is None:
                report["count_type"] = "official_activity"
            reclassified += 1
        kept.append(report)

    data["reports"] = kept
    coverage = data.setdefault("coverage", {})
    coverage["reports_revalidated_removed"] = removed
    coverage["reports_revalidated_reclassified"] = reclassified
    coverage["archive_reports_total"] = len(kept)
    archive_regions = {e.get("region") for e in data.get("events", []) if e.get("region")} | {
        r.get("region") for r in kept if r.get("region")
    }
    coverage["archive_regions_with_records"] = len(archive_regions)
    return data


def reenrich_archive_places(data: dict[str, Any], source_cfg: dict[str, Any],
                            city_cfg: dict[str, Any]) -> dict[str, Any]:
    """Re-run place extraction on stored report text without re-fetching sources.

    This is intentionally separate from network collection. When the place
    catalog/parser improves, a normal incremental run can upgrade old region-only
    reports to city/municipality precision using text already stored in
    events.json; no 168-hour Telegram backfill is required.
    """
    by_region: dict[str, list[dict[str, Any]]] = {}
    for place in [*(city_cfg.get("cities", []) or []), *(city_cfg.get("municipalities", []) or [])]:
        region = place.get("region")
        if region:
            by_region.setdefault(region, []).append(place)

    configured_places: dict[str, list[dict[str, Any]]] = {}
    for source in source_cfg.get("sources", []) or []:
        region = source.get("region")
        if not region:
            continue
        configured_places.setdefault(region, []).extend(source.get("places", []) or [])

    changed = 0
    for report in data.get("reports", []) or []:
        text = str(report.get("text") or "").strip()
        region = report.get("region")
        if not text or not region:
            continue
        source = {
            "region": region,
            "places": configured_places.get(region, []),
            "_catalog_places": by_region.get(region, []),
        }
        places = extract_places(text, source)
        if not places:
            continue

        primary = places[0]
        new_scope = alert_scope(primary)
        old_signature = (
            report.get("place"), report.get("scope"),
            tuple(p.get("name") for p in report.get("mentioned_places", []) or []),
        )
        report["place"] = primary["name"]
        report["scope"] = new_scope
        report["lat"] = primary.get("lat")
        report["lon"] = primary.get("lon")
        report["mentioned_places"] = [
            {
                "name": p["name"],
                "label": p.get("label", p["name"]),
                "type": p.get("type", "city"),
                "lat": p.get("lat"),
                "lon": p.get("lon"),
            }
            for p in places[:120]
        ]
        new_signature = (
            report.get("place"), report.get("scope"),
            tuple(p.get("name") for p in report.get("mentioned_places", []) or []),
        )
        if new_signature != old_signature:
            changed += 1

    archive_regions = {e.get("region") for e in data.get("events", []) if e.get("region")} | {
        r.get("region") for r in data.get("reports", []) if r.get("region")
    }
    archive_local_regions = {
        e.get("region") for e in data.get("events", [])
        if e.get("region") and e.get("scope") in ("city", "municipality")
    } | {
        r.get("region") for r in data.get("reports", [])
        if r.get("region") and (
            r.get("scope") in ("city", "municipality") or (r.get("mentioned_places") or [])
        )
    }
    data.setdefault("coverage", {})["archive_regions_with_records"] = len(archive_regions)
    data["coverage"]["archive_regions_with_local_records"] = len(archive_local_regions)
    data["coverage"]["reports_place_reenriched"] = changed
    return data


def configure_incremental_window(args) -> None:
    """For normal manual runs, collect exactly from the previous cursor to now.

    Older records remain in events.json. Fetchers may read extra context before
    window_start so a START just before the cursor can still pair with an END
    after it, but reports before the cursor are not re-added. A backfill remains
    available only when explicitly selected.
    """
    replay_previous = bool(getattr(args, "replay_previous_window", False))
    args.collection_mode = "backfill" if args.full_backfill else ("replay_previous" if replay_previous else "incremental")
    args.window_start_override = None
    args.window_end_override = None
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

    if replay_previous:
        try:
            previous_start = parse_iso(old.get("window_start", ""))
            previous_window_end = parse_iso(old.get("window_end", ""))
        except Exception:
            args.collection_mode = "initial"
            return
        args.window_start_override = previous_start
        args.window_end_override = previous_window_end
        args.lookback_hours = max(0.0, (previous_window_end - previous_start).total_seconds() / 3600.0)
        args.incremental_overlap_hours = 0
        return

    target_end = datetime.now(timezone.utc) - timedelta(hours=args.safety_lag_hours)
    if previous_end > target_end:
        previous_end = target_end

    args.window_start_override = previous_end
    args.window_end_override = target_end
    args.lookback_hours = max(0.0, (target_end - previous_end).total_seconds() / 3600.0)
    args.incremental_overlap_hours = 0


def main():
    p = argparse.ArgumentParser()
    p.add_argument("--sources", default=str(DEFAULT_SOURCES))
    p.add_argument("--regions", default=str(DEFAULT_REGIONS))
    p.add_argument("--cities", default=str(DEFAULT_CITIES))
    p.add_argument("--output", default=str(DEFAULT_OUTPUT))
    p.add_argument("--telegram-peer-cache", default=str(DEFAULT_TELEGRAM_PEERS))
    p.add_argument("--lookback-hours", type=int, default=int(os.getenv("LOOKBACK_HOURS", "120")))
    p.add_argument("--safety-lag-hours", type=int, default=int(os.getenv("SAFETY_LAG_HOURS", "0")))
    p.add_argument("--max-pages", type=int, default=int(os.getenv("TELEGRAM_MAX_PAGES", "50")))
    p.add_argument("--context-hours", type=int, default=int(os.getenv("TELEGRAM_CONTEXT_HOURS", "48")))
    p.add_argument("--incremental-overlap-hours", type=int, default=int(os.getenv("INCREMENTAL_OVERLAP_HOURS", "0")))
    p.add_argument("--full-backfill", action="store_true", default=os.getenv("FULL_BACKFILL", "0") == "1")
    p.add_argument("--replay-previous-window", action="store_true", default=os.getenv("REPLAY_PREVIOUS_WINDOW", "0") == "1")
    p.add_argument("--mchs-workers", type=int, default=int(os.getenv("MCHS_WORKERS", "8")))
    args = p.parse_args()
    args.safety_lag_hours = max(0, args.safety_lag_hours)
    args.lookback_hours = max(0, args.lookback_hours)
    args.context_hours = max(12, args.context_hours)
    args.incremental_overlap_hours = max(0, args.incremental_overlap_hours)
    configure_incremental_window(args)
    print(
        f"collection mode={args.collection_mode} lookback={args.lookback_hours}h "
        f"overlap={args.incremental_overlap_hours}h lag={args.safety_lag_hours}h",
        file=sys.stderr,
    )

    data = collect(args)
    data = merge_existing_archive(data, Path(args.output))
    data = revalidate_archive_reports(data)
    source_cfg = json.loads(Path(args.sources).read_text(encoding="utf-8"))
    city_path = Path(args.cities)
    city_cfg = json.loads(city_path.read_text(encoding="utf-8")) if city_path.exists() else {"cities": [], "municipalities": []}
    data = reenrich_archive_places(data, source_cfg, city_cfg)
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
