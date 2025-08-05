import json
import os
from datetime import datetime

def generate_html_page():
    """Convert recent_tracks_log.json to an HTML page"""
    
    # Read the JSON log file
    tracks = []
    if os.path.exists("recent_tracks_log.json"):
        with open("recent_tracks_log.json", "r", encoding="utf-8") as f:
            for line in f:
                try:
                    track = json.loads(line.strip())
                    tracks.append(track)
                except json.JSONDecodeError:
                    continue
    
    # Sort by played_at (newest first for display)
    tracks.sort(key=lambda x: x["played_at"], reverse=True)
    
    # Generate HTML
    html_content = f"""<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>My Spotify Listening History</title>
    <link rel="icon" href="favicon.png" type="image/png">
    <style>
        body {{
            font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif;
            background: linear-gradient(135deg, #1db954, #191414);
            color: white;
            margin: 0;
            padding: 20px;
            min-height: 100vh;
        }}
        .container {{
            max-width: 1200px;
            margin: 0 auto;
            background: rgba(0, 0, 0, 0.8);
            border-radius: 15px;
            padding: 30px;
            backdrop-filter: blur(10px);
        }}
        h1 {{
            text-align: center;
            color: #1db954;
            font-size: 2.5em;
            margin-bottom: 10px;
        }}
        .stats {{
            text-align: center;
            margin-bottom: 30px;
            color: #b3b3b3;
        }}
        .track-grid {{
            display: grid;
            grid-template-columns: repeat(auto-fill, minmax(min(350px, 100%), 1fr));
            gap: 20px;
            width: 100%;
        }}
        .track-card {{
            background: rgba(255, 255, 255, 0.1);
            border-radius: 12px;
            padding: 20px;
            transition: transform 0.3s ease, box-shadow 0.3s ease;
            border: 1px solid rgba(29, 185, 84, 0.3);
            width: 100%;
            box-sizing: border-box;
            max-width: 100%;
            overflow: hidden;
        }}
        .track-card:hover {{
            transform: translateY(-5px);
            box-shadow: 0 10px 25px rgba(29, 185, 84, 0.3);
        }}
        .track-header {{
            display: flex;
            align-items: center;
            margin-bottom: 15px;
        }}
        .album-image {{
            width: 60px;
            height: 60px;
            border-radius: 8px;
            margin-right: 15px;
            object-fit: cover;
        }}
        .track-info h3 {{
            margin: 0 0 5px 0;
            font-size: 1.2em;
            color: #1db954;
            word-wrap: break-word;
            overflow-wrap: break-word;
        }}
        .track-info .artists {{
            margin: 0;
            color: #b3b3b3;
            font-size: 0.9em;
            word-wrap: break-word;
            overflow-wrap: break-word;
        }}
        .album-name {{
            color: #888;
            font-size: 0.85em;
            margin: 10px 0;
            word-wrap: break-word;
            overflow-wrap: break-word;
        }}
        
        /* Mobile responsive adjustments */
        @media (max-width: 768px) {{
            body {{
                padding: 5px;
            }}
            
            .container {{
                padding: 15px;
                margin: 0;
                border-radius: 10px;
            }}
            
            .track-grid {{
                grid-template-columns: 1fr;
                gap: 15px;
            }}
            
            .track-card {{
                padding: 15px;
            }}
            
            .track-header {{
                flex-direction: column;
                align-items: flex-start;
            }}
            
            .album-image, .no-image {{
                margin-right: 0;
                margin-bottom: 10px;
            }}
            
            h1 {{
                font-size: 2em;
            }}
        }}
        .played-at {{
            color: #666;
            font-size: 0.8em;
            text-align: right;
        }}
        .track-links {{
            margin-top: 10px;
        }}
        .track-links a {{
            color: #1db954;
            text-decoration: none;
            font-size: 0.85em;
            margin-right: 15px;
        }}
        .track-links a:hover {{
            text-decoration: underline;
        }}
        .no-image {{
            width: 60px;
            height: 60px;
            background: #333;
            border-radius: 8px;
            display: flex;
            align-items: center;
            justify-content: center;
            margin-right: 15px;
            font-size: 0.8em;
            color: #666;
        }}
    </style>
</head>
<body>
    <div class="container">
        <h1>🎵 My Spotify Listening History</h1>
        <div class="stats">
            <p>Total tracks: {len(tracks)} | Last updated: {datetime.now().strftime('%B %d, %Y at %I:%M %p')}</p>
        </div>
        
        <div class="track-grid">"""
    
    # Add each track
    for track in tracks:
        # Format the played_at timestamp
        try:
            played_dt = datetime.fromisoformat(track["played_at"].replace('Z', '+00:00'))
            played_formatted = played_dt.strftime('%B %d, %Y at %I:%M %p')
        except:
            played_formatted = track["played_at"]
        
        # Format artists
        artists_str = ", ".join(track["artists"])
        
        # Album image or placeholder
        if track.get("album_image"):
            image_html = f'<img src="{track["album_image"]}" alt="Album cover" class="album-image">'
        else:
            image_html = '<div class="no-image">♪</div>'
        
        html_content += f"""
            <div class="track-card">
                <div class="track-header">
                    {image_html}
                    <div class="track-info">
                        <h3>{track["track_name"]}</h3>
                        <p class="artists">{artists_str}</p>
                    </div>
                </div>
                <div class="album-name">📀 {track["album_name"]}</div>
                <div class="track-links">
                    <a href="{track["track_url"]}" target="_blank">🎵 Track</a>
                    <a href="{track["album_url"]}" target="_blank">💿 Album</a>
                </div>
                <div class="played-at">🕒 {played_formatted}</div>
            </div>"""
    
    html_content += """
        </div>
    </div>
</body>
</html>"""
    
    # Write HTML file
    with open("index.html", "w", encoding="utf-8") as f:
        f.write(html_content)
    
    print(f"✅ Generated index.html with {len(tracks)} tracks")

if __name__ == "__main__":
    generate_html_page()