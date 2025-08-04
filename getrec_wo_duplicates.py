import json
import os
import spotipy
from spotipy.oauth2 import SpotifyOAuth
from datetime import datetime, timedelta

# File path for log
LOG_FILE = "recent_tracks_log.json"

# Setup Spotify auth using environment variables
sp = spotipy.Spotify(auth_manager=SpotifyOAuth(
    client_id=os.getenv("SPOTIFY_CLIENT_ID"),
    client_secret=os.getenv("SPOTIFY_CLIENT_SECRET"),
    redirect_uri="http://127.0.0.1:8888/callback",
    scope="user-read-recently-played",
    cache_path=".cache"
))

# Load existing entries and filter out old ones (older than 3 months)
existing_entries = []
existing_played_at = set()
three_months_ago = datetime.now() - timedelta(days=90)

if os.path.exists(LOG_FILE):
    with open(LOG_FILE, "r", encoding="utf-8") as f:
        for line in f:
            try:
                entry = json.loads(line.strip())
                # Parse the played_at timestamp (ISO format: 2024-01-15T10:30:00.000Z)
                played_at_dt = datetime.fromisoformat(entry["played_at"].replace('Z', '+00:00')).replace(tzinfo=None)
                
                # Only keep entries from the last 3 months
                if played_at_dt >= three_months_ago:
                    existing_entries.append(entry)
                    existing_played_at.add(entry["played_at"])
            except (json.JSONDecodeError, ValueError, KeyError):
                continue

# Fetch recent tracks from Spotify
results = sp.current_user_recently_played(limit=50)

# Prepare new, unique entries
new_entries = []
for item in results["items"]:
    played_at = item["played_at"]
    if played_at in existing_played_at:
        continue  # Skip duplicates

    track = item["track"]
    album = track["album"]
    
    log_entry = {
        "track_name": track["name"],
        "artists": [artist["name"] for artist in track["artists"]],
        "played_at": played_at,
        "album_name": album["name"],
        "album_image": album["images"][0]["url"] if album["images"] else None,
        "album_url": album["external_urls"]["spotify"],
        "track_url": track["external_urls"]["spotify"]
    }

    new_entries.append(log_entry)

# Combine existing and new entries
all_entries = existing_entries + new_entries

# Sort all entries by played_at timestamp (oldest first, newest at the end)
all_entries.sort(key=lambda x: x["played_at"])

# Rewrite the entire file with sorted, filtered entries
with open(LOG_FILE, "w", encoding="utf-8") as f:
    for entry in all_entries:
        f.write(json.dumps(entry, ensure_ascii=False) + "\n")

# Calculate how many old entries were removed
old_entries_removed = len(existing_played_at) - len(existing_entries) if os.path.exists(LOG_FILE) else 0

print(f"✅ Added {len(new_entries)} new tracks to the log.")
print(f"📅 Removed {old_entries_removed} entries older than 3 months.")
print(f"📝 Total tracks in log: {len(all_entries)} (sorted by date, newest at the end)")