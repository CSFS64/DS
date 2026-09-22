#!/usr/bin/env python3
"""Collect delayed historical UAV-alert posts from official public Telegram channels.

The collector intentionally applies a default 24-hour archive lag. It fetches public
channel pages, pairs START/END alerts, extracts local official UAV-count reports when
possible, and writes data/events.json for the static GitHub Pages frontend.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
import sys
import time
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any

import requests
from bs4 import BeautifulSoup

ROOT = Path(__file__).resolve().parents[1]
DEFAULT_SOURCES = ROOT / "data" / "sources.json"
DEFAULT_OUTPUT = ROOT / "data" / "events.json"

USER_AGENT = (
    "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/131.0 Safari/537.36 DeepstrikeArchive/1.0"
)

START_MARKERS = (
    "опасность атаки бпла",
    "беспилотная опасность",
    "угроза атаки бпла",
    "угроза непосредственного удара бпла",
    "тревога в связи с угрозой непосредственного удара бпла",
)
END_MARKERS = (
    "отбой опасности атаки бпла",
    "отбой беспилотной опасности",
    "отбой опасности бпла",
    "отмена непосредственной опасности атаки бпла",
    "отмена непосредственной угрозы",
    "отбой угрозы атаки бпла",
)
REGION_PHRASES = (
    "на всей территории области",
    "на территории региона",
    "на территории всего региона",
    "в регионе",
    "курская область: опасность атаки бпла",
    "курская область: внимание! отбой опасности атаки бпла",
)
CLOSE_ALL_LOCAL_PHRASES = (
    "во всех муниципалитетах",
    "во всех муниципальных образованиях",
)
MOD_DERIVED_MARKERS = (
    "минобороны россии",
    "министерство обороны",
    "по данным минобороны",
    "сообщило минобороны",
    "forwarded from минобороны",
)

@dataclass
class Post:
    channel: str
    post_id: int
    published_at: datetime
    text: str
    url: str
    forwarded_from: str | None = None

    @property
    def normalized(self) -> str:
        return normalize(self.text)


def normalize(text: str) -> str:
    return " ".join(text.lower().replace("ё", "е").split())


def parse_iso(value: str) -> datetime:
    value = value.replace("Z", "+00:00")
    dt = datetime.fromisoformat(value)
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=timezone.utc)
    return dt.astimezone(timezone.utc)


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
) -> list[Post]:
    # Pull extra context before the requested window so starts can pair with ends.
    context_start = start_utc - timedelta(hours=24)
    all_posts: dict[int, Post] = {}
    before: int | None = None

    for _ in range(max_pages):
        html = fetch_page(session, channel, before)
        page = parse_telegram_html(html, channel)
        if not page:
            break
        for post in page:
            all_posts[post.post_id] = post
        oldest = min(page, key=lambda p: p.published_at)
        if oldest.published_at <= context_start:
            break
        min_id = min(p.post_id for p in page)
        if before == min_id:
            break
        before = min_id
        time.sleep(0.35)

    return sorted(
        (p for p in all_posts.values() if context_start <= p.published_at <= end_utc),
        key=lambda p: (p.published_at, p.post_id),
    )


def text_kind(text: str) -> str | None:
    n = normalize(text)
    if any(marker in n for marker in END_MARKERS):
        return "end"
    if any(marker in n for marker in START_MARKERS):
        return "start"
    return None


def is_region_message(text: str, source: dict[str, Any]) -> bool:
    n = normalize(text)
    region_label = normalize(source.get("region_label", ""))
    if any(p in n for p in REGION_PHRASES):
        return True
    if "на всей территории" in n and ("област" in n or "регион" in n):
        return True
    if region_label and region_label in n and not extract_places(text, source):
        return True
    return False


def extract_places(text: str, source: dict[str, Any]) -> list[dict[str, Any]]:
    n = normalize(text)
    matches = []
    for place in source.get("places", []):
        aliases = [normalize(a) for a in place.get("aliases", [])]
        def alias_present(alias: str) -> bool:
            if not alias:
                return False
            return re.search(r"(?<![а-яa-z0-9])" + re.escape(alias) + r"(?![а-яa-z0-9])", n) is not None
        if any(alias_present(alias) for alias in aliases):
            matches.append(place)
    # Deduplicate while preserving source order.
    seen = set()
    out = []
    for p in matches:
        if p["name"] in seen:
            continue
        seen.add(p["name"])
        out.append(p)
    return out


def alert_scope(place: dict[str, Any] | None) -> str:
    if not place:
        return "region"
    return "city" if place.get("type") == "city" else "municipality"


def stable_id(*parts: str) -> str:
    raw = "|".join(parts).encode("utf-8")
    return hashlib.sha1(raw).hexdigest()[:16]


def pair_alerts(posts: list[Post], source: dict[str, Any], window_start: datetime, window_end: datetime):
    open_alerts: dict[str, list[dict[str, Any]]] = {}
    events: list[dict[str, Any]] = []
    unmatched: list[dict[str, Any]] = []

    def key_for(place_name: str) -> str:
        return f"{source['region']}::{place_name}"

    def open_one(place_name: str, scope: str, post: Post):
        key = key_for(place_name)
        bucket = open_alerts.setdefault(key, [])
        # Avoid duplicate starts that arrive within a minute for the same place.
        if bucket and abs((post.published_at - bucket[-1]["post"].published_at).total_seconds()) < 60:
            return
        bucket.append({"post": post, "scope": scope})

    def close_one(place_name: str, end_post: Post, reason: str = "direct"):
        key = key_for(place_name)
        bucket = open_alerts.get(key) or []
        if not bucket:
            return
        start_item = bucket.pop(0)
        start_post: Post = start_item["post"]
        if end_post.published_at < start_post.published_at:
            return
        # Only emit complete events that intersect the requested archive window.
        if end_post.published_at < window_start or start_post.published_at > window_end:
            return
        events.append({
            "id": stable_id(source["channel"], str(start_post.post_id), str(end_post.post_id), place_name),
            "region": source["region"],
            "place": place_name,
            "scope": start_item["scope"],
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
                open_one(source["region"], "region", post)
            for place in places:
                open_one(place["name"], alert_scope(place), post)
            if not region_message and not places:
                # Unknown local scope: keep diagnostic, don't invent a city.
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
                # A region-wide clear also clears any local alerts nested inside it.
                close_one(source["region"], post, "regional_clear")
                for key in list(open_alerts.keys()):
                    if key.endswith(f"::{source['region']}"):
                        continue
                    while open_alerts.get(key):
                        close_one(key.split("::", 1)[1], post, "regional_clear")
            for place in places:
                close_one(place["name"], post, "direct")

    # Keep diagnostics for anything that never received a matching clear.
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
    combined = normalize(post.text + " " + (post.forwarded_from or ""))
    return any(marker in combined for marker in MOD_DERIVED_MARKERS)


def sentence_split(text: str) -> list[str]:
    return [s.strip() for s in re.split(r"(?<=[.!?])\s+|\n+", text) if s.strip()]


def classify_count_sentence(sentence: str) -> list[tuple[int, str, int | None, str | None]]:
    """Return (count, type, secondary_count, secondary_type) tuples.

    Conservative by design: if a sentence is ambiguous, it returns nothing instead of
    fabricating a count type.
    """
    n = normalize(sentence)
    out = []

    # e.g. "совершены атаки 19 БПЛА, из которых 11 сбиты"
    m = re.search(r"(?:атаки|атакован[а-я]*|атаковали|нанесены удары)\D{0,28}(\d+)\s*(?:бпла|беспилотник\w*)", n)
    if m:
        primary = int(m.group(1))
        sec = re.search(r"из которых\s+(\d+)\s+(?:подавлен\w*\s+и\s+)?сбит\w*", n)
        out.append((primary, "attacked", int(sec.group(1)) if sec else None, "shot_down" if sec else None))
        return out

    # e.g. "обнаружены и уничтожены 6 беспилотных летательных аппаратов"
    m = re.search(r"обнаружен\w*\s+и\s+уничтожен\w*\D{0,12}(\d+)\s+(?:беспилот\w*|бпла)", n)
    if m:
        out.append((int(m.group(1)), "detected_and_destroyed", None, None))
        return out

    # e.g. "сбиты 4 БПЛА" / "уничтожено 5 беспилотников"
    m = re.search(r"(?:сбит\w*|уничтожен\w*|подавлен\w*|обезврежен\w*)\D{0,12}(\d+)\s*(?:бпла|беспилотник\w*)", n)
    if m:
        out.append((int(m.group(1)), "destroyed_or_suppressed", None, None))
        return out

    # e.g. "Белгород атакован 2 беспилотниками"
    m = re.search(r"атакован\w*\D{0,20}(\d+)\s+беспилотник\w*", n)
    if m:
        out.append((int(m.group(1)), "attacked", None, None))
        return out

    return out


def infer_report_place(sentence: str, source: dict[str, Any]) -> tuple[str, str]:
    places = extract_places(sentence, source)
    if places:
        p = places[0]
        return p["name"], alert_scope(p)
    return source["region"], "region"


def extract_reports(posts: list[Post], source: dict[str, Any], window_start: datetime, window_end: datetime):
    reports = []
    for post in posts:
        if post.published_at < window_start or post.published_at > window_end:
            continue
        if mod_derived(post):
            continue
        if not any(token in normalize(post.text) for token in ("бпла", "беспилот")):
            continue
        for sentence in sentence_split(post.text):
            for count, ctype, secondary_count, secondary_type in classify_count_sentence(sentence):
                place, scope = infer_report_place(sentence, source)
                reports.append({
                    "id": stable_id(source["channel"], str(post.post_id), place, ctype, str(count)),
                    "region": source["region"],
                    "place": place,
                    "scope": scope,
                    "at": post.published_at.isoformat(),
                    "count": count,
                    "count_type": ctype,
                    "secondary_count": secondary_count,
                    "secondary_type": secondary_type,
                    "text": sentence,
                    "source_name": source["source_name"],
                    "url": post.url,
                })
    # De-duplicate repeated sentence parses.
    unique = {r["id"]: r for r in reports}
    return sorted(unique.values(), key=lambda r: r["at"])


def collect(args) -> dict[str, Any]:
    cfg = json.loads(Path(args.sources).read_text(encoding="utf-8"))
    now = datetime.now(timezone.utc)
    window_end = now - timedelta(hours=args.safety_lag_hours)
    window_start = window_end - timedelta(hours=args.lookback_hours)

    session = requests.Session()
    session.headers.update({"User-Agent": USER_AGENT, "Accept-Language": "ru,en;q=0.8"})

    all_events = []
    all_reports = []
    all_unmatched = []
    statuses = []

    for source in cfg.get("sources", []):
        if not source.get("enabled", False):
            continue
        channel = source["channel"]
        try:
            posts = fetch_posts_for_window(session, channel, window_start, window_end, max_pages=args.max_pages)
            events, unmatched = pair_alerts(posts, source, window_start, window_end)
            reports = extract_reports(posts, source, window_start, window_end)
            all_events.extend(events)
            all_reports.extend(reports)
            all_unmatched.extend(unmatched)
            statuses.append({
                "channel": channel,
                "ok": True,
                "posts": len(posts),
                "events": len(events),
                "reports": len(reports),
            })
            print(f"{channel}: posts={len(posts)} events={len(events)} reports={len(reports)}", file=sys.stderr)
        except Exception as exc:
            statuses.append({"channel": channel, "ok": False, "error": str(exc)})
            print(f"{channel}: ERROR {exc}", file=sys.stderr)

    all_events.sort(key=lambda e: (e["start"], e["region"], e["place"]))
    all_reports.sort(key=lambda r: (r["at"], r["region"], r["place"]))
    return {
        "schema_version": 1,
        "generated_at": now.isoformat(),
        "safety_lag_hours": args.safety_lag_hours,
        "window_start": window_start.isoformat(),
        "window_end": window_end.isoformat(),
        "events": all_events,
        "reports": all_reports,
        "unmatched": all_unmatched,
        "source_status": statuses,
    }


def main():
    p = argparse.ArgumentParser()
    p.add_argument("--sources", default=str(DEFAULT_SOURCES))
    p.add_argument("--output", default=str(DEFAULT_OUTPUT))
    p.add_argument("--lookback-hours", type=int, default=int(os.getenv("LOOKBACK_HOURS", "48")))
    p.add_argument("--safety-lag-hours", type=int, default=int(os.getenv("SAFETY_LAG_HOURS", "24")))
    p.add_argument("--max-pages", type=int, default=18)
    args = p.parse_args()
    # Keep this project as a historical archive rather than a live alert monitor.
    args.safety_lag_hours = max(24, args.safety_lag_hours)
    args.lookback_hours = max(24, args.lookback_hours)
    data = collect(args)
    if data["source_status"] and not any(s.get("ok") for s in data["source_status"]):
        raise RuntimeError("all configured sources failed; keeping the previous archive file")
    out = Path(args.output)
    out.parent.mkdir(parents=True, exist_ok=True)
    tmp = out.with_suffix(out.suffix + ".tmp")
    tmp.write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8")
    tmp.replace(out)
    print(f"wrote {out}: {len(data['events'])} paired alerts, {len(data['reports'])} reports", file=sys.stderr)


if __name__ == "__main__":
    main()
