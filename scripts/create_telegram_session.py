#!/usr/bin/env python3
"""Create a Telethon StringSession for the archive collector.

Run this locally once. The resulting TELEGRAM_SESSION authenticates as the
Telegram account used during login; it is not a read-only credential. Prefer a
dedicated account for this collector, treat the session string like a password,
and store it only in GitHub Actions Secrets. Never commit or paste it into chat.
"""
from getpass import getpass
from telethon.sync import TelegramClient
from telethon.sessions import StringSession

print("Create a Telegram user session for public-channel history collection.")
print("Recommendation: use a dedicated Telegram account for this collector.")
api_id = int(input("TELEGRAM_API_ID: ").strip())
api_hash = getpass("TELEGRAM_API_HASH: ").strip()
phone = input("Telegram phone number (international format): ").strip()

client = TelegramClient(StringSession(), api_id, api_hash)
client.start(phone=phone)
print("\nTELEGRAM_SESSION (store ONLY in GitHub Secrets; treat it like a password):\n")
print(client.session.save())
client.disconnect()
