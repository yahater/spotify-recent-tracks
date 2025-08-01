import json
import os
import spotipy
from spotipy.oauth2 import SpotifyOAuth

# File path for log
LOG_FILE = "recent_tracks_log.json"

# Setup Spotify auth
sp = spotipy.Spotify(auth_manager=SpotifyOAuth(
    client_id=os.getenv("SPOTIFY_CLIENT_ID"),
    client_secret=os.getenv("SPOTIFY_CLIENT_SECRET"),
    redirect_uri="http://127.0.0.1:8888/callback",
    scope="user-read-recently-played",
    cache_path=".cache"
))

# Load existing played_at timestamps
existing_played_at = set()
if os.path.exists(LOG_FILE):
    with open(LOG_FILE, "r", encoding="utf-8") as f:
        for line in f:
            try:
                entry = json.loads(line.strip())
                existing_played_at.add(entry["played_at"])
            except json.JSONDecodeError:
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

# Append only new entries to file
with open(LOG_FILE, "a", encoding="utf-8") as f:
    for entry in new_entries:
        f.write(json.dumps(entry, ensure_ascii=False) + "\n")

print(f"✅ Added {len(new_entries)} new tracks to the log.")
