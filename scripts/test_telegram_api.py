import os
import sys
from telethon.sync import TelegramClient
from telethon.sessions import StringSession


def normalize_channel(value: str) -> str:
    value = value.strip()

    if value.startswith("https://t.me/"):
        value = value.split("https://t.me/", 1)[1]

    if value.startswith("http://t.me/"):
        value = value.split("http://t.me/", 1)[1]

    value = value.split("?")[0]
    value = value.strip("/")

    if value.startswith("@"):
        value = value[1:]

    return value


api_id = os.environ.get("TELEGRAM_API_ID", "").strip()
api_hash = os.environ.get("TELEGRAM_API_HASH", "").strip()
session = os.environ.get("TELEGRAM_SESSION", "").strip()

channel_raw = os.environ.get("TEST_CHANNEL", "").strip()
limit = int(os.environ.get("TEST_LIMIT", "10"))

if not api_id:
    sys.exit("ERROR: TELEGRAM_API_ID is missing")

if not api_hash:
    sys.exit("ERROR: TELEGRAM_API_HASH is missing")

if not session:
    sys.exit("ERROR: TELEGRAM_SESSION is missing")

if not channel_raw:
    sys.exit("ERROR: TEST_CHANNEL is missing")

channel = normalize_channel(channel_raw)

print("=== Telegram API connectivity test ===")
print(f"Target channel: {channel}")
print(f"Message limit: {limit}")
print()

client = TelegramClient(
    StringSession(session),
    int(api_id),
    api_hash,
)

try:
    client.start()

    me = client.get_me()

    if not me:
        sys.exit("ERROR: Telegram session could not authenticate")

    print("AUTH: OK")
    print(f"Account ID: {me.id}")
    print()

    entity = client.get_entity(channel)

    print("CHANNEL RESOLUTION: OK")
    print(f"Channel title: {getattr(entity, 'title', '(unknown)')}")
    print(f"Channel ID: {entity.id}")
    print()

    messages = client.get_messages(entity, limit=limit)

    print(f"MESSAGES RECEIVED: {len(messages)}")
    print("=" * 70)

    for msg in messages:
        text = (msg.raw_text or "").replace("\r", " ").replace("\n", " ")
        text = " ".join(text.split())

        if len(text) > 300:
            text = text[:300] + "..."

        print(
            f"ID={msg.id} "
            f"DATE={msg.date.isoformat() if msg.date else 'unknown'}"
        )

        if text:
            print(text)
        else:
            print("[no text]")

        print("-" * 70)

finally:
    client.disconnect()
