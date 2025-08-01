import json
from pathlib import Path

# Load recent track entries
log_path = Path("recent_tracks_log.json")
html_path = Path("recent_tracks.html")

# Read the JSON lines
entries = []
with open(log_path, "r", encoding="utf-8") as f:
    for line in f:
        try:
            entries.append(json.loads(line.strip()))
        except json.JSONDecodeError:
            continue

# Sort entries by played_at timestamp (newest first)
entries.sort(key=lambda x: x['played_at'], reverse=True)

# Create HTML content with embedded JavaScript for sorting
html = """
<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <title>Recently Played Tracks</title>
    <style>
        body {
            font-family: sans-serif;
            background: #f5f5f5;
            padding: 2rem;
        }
        .header {
            display: flex;
            justify-content: space-between;
            align-items: center;
            margin-bottom: 2rem;
        }
        .sort-btn {
            background: #1DB954;
            color: white;
            border: none;
            padding: 10px 20px;
            border-radius: 25px;
            cursor: pointer;
            font-size: 14px;
            transition: background-color 0.3s;
        }
        .sort-btn:hover {
            background: #1ed760;
        }
        .track {
            display: flex;
            align-items: center;
            background: white;
            margin-bottom: 1rem;
            padding: 1rem;
            border-radius: 10px;
            box-shadow: 0 2px 6px rgba(0,0,0,0.1);
        }
        img {
            height: 80px;
            width: 80px;
            object-fit: cover;
            border-radius: 5px;
            margin-right: 1rem;
        }
        .info {
            line-height: 1.4;
        }
        a {
            color: #1DB954;
            text-decoration: none;
        }
        .current-order {
            font-size: 14px;
            color: #666;
            margin-left: 10px;
        }
    </style>
</head>
<body>
    <div class="header">
        <h1>Recently Played Tracks</h1>
        <div>
            <button class="sort-btn" onclick="toggleSort()">
                Sort by Date/Time
            </button>
            <span class="current-order" id="orderIndicator">Newest First</span>
        </div>
    </div>
    <div id="tracksContainer">
"""

# Convert entries to JavaScript array
js_entries = json.dumps(entries, ensure_ascii=False)

# Add tracks to HTML (already sorted newest first)
for entry in entries:
    html += f"""
    <div class="track" data-played-at="{entry['played_at']}">
        <img src="{entry['album_image']}" alt="Album Art">
        <div class="info">
            <strong>{entry['track_name']}</strong><br>
            Artist(s): {', '.join(entry['artists']) if isinstance(entry['artists'], list) else entry['artists']}<br>
            Played at: {entry['played_at']}<br>
            <a href="{entry['track_url']}" target="_blank">Track Link</a> |
            <a href="{entry['album_url']}" target="_blank">Album Link</a>
        </div>
    </div>
    """

# Add JavaScript for sorting functionality
html += f"""
    </div>

    <script>
        const entries = {js_entries};
        let isNewestFirst = true;

        function toggleSort() {{
            isNewestFirst = !isNewestFirst;
            const container = document.getElementById('tracksContainer');
            const orderIndicator = document.getElementById('orderIndicator');
            
            // Sort entries based on current order
            const sortedEntries = [...entries].sort((a, b) => {{
                const dateA = new Date(a.played_at);
                const dateB = new Date(b.played_at);
                return isNewestFirst ? dateB - dateA : dateA - dateB;
            }});
            
            // Clear container
            container.innerHTML = '';
            
            // Rebuild tracks with sorted order
            sortedEntries.forEach(entry => {{
                const trackDiv = document.createElement('div');
                trackDiv.className = 'track';
                trackDiv.setAttribute('data-played-at', entry.played_at);
                
                const artistsText = Array.isArray(entry.artists) ? entry.artists.join(', ') : entry.artists;
                
                trackDiv.innerHTML = `
                    <img src="${{entry.album_image}}" alt="Album Art">
                    <div class="info">
                        <strong>${{entry.track_name}}</strong><br>
                        Artist(s): ${{artistsText}}<br>
                        Played at: ${{entry.played_at}}<br>
                        <a href="${{entry.track_url}}" target="_blank">Track Link</a> |
                        <a href="${{entry.album_url}}" target="_blank">Album Link</a>
                    </div>
                `;
                
                container.appendChild(trackDiv);
            }});
            
            // Update order indicator
            orderIndicator.textContent = isNewestFirst ? 'Newest First' : 'Oldest First';
        }}
    </script>
</body>
</html>
"""

# Write to file
with open(html_path, "w", encoding="utf-8") as f:
    f.write(html)

print(f"✅ HTML file created with sorting functionality: {html_path.absolute()}")
