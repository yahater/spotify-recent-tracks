/* =========================================================================
   Spotify Live Player — client-side only, no server, no client secret.
   Uses Authorization Code + PKCE (safe for a public static page) plus the
   Web Playback SDK for in-browser playback control. Requires Premium.

   SETUP (see README section at bottom of this file):
   1. Paste your Spotify app's Client ID below.
   2. In your Spotify Developer Dashboard, add this page's exact URL as a
      Redirect URI (e.g. https://yourname.github.io/spotify-recent-tracks/player.html)
   ========================================================================= */

const CLIENT_ID = "PASTE_YOUR_SPOTIFY_CLIENT_ID_HERE";
const REDIRECT_URI = window.location.origin + window.location.pathname;
const SCOPES = [
  "streaming",
  "user-read-email",
  "user-read-private",
  "user-read-playback-state",
  "user-modify-playback-state",
  "user-read-currently-playing",
  "user-library-read",
  "user-library-modify",
  "playlist-read-private",
  "playlist-read-collaborative",
].join(" ");

const TOKEN_KEY = "sp_player_tokens"; // { access_token, refresh_token, expires_at }

/* ---------------------------- PKCE helpers ---------------------------- */

function randomString(length) {
  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  let out = "";
  const rand = new Uint8Array(length);
  crypto.getRandomValues(rand);
  for (let i = 0; i < length; i++) out += chars[rand[i] % chars.length];
  return out;
}

async function sha256Base64Url(input) {
  const data = new TextEncoder().encode(input);
  const digest = await crypto.subtle.digest("SHA-256", data);
  let str = "";
  const bytes = new Uint8Array(digest);
  for (let i = 0; i < bytes.length; i++) str += String.fromCharCode(bytes[i]);
  return btoa(str).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

async function redirectToSpotifyAuth() {
  const verifier = randomString(64);
  sessionStorage.setItem("sp_pkce_verifier", verifier);
  const challenge = await sha256Base64Url(verifier);

  const params = new URLSearchParams({
    client_id: CLIENT_ID,
    response_type: "code",
    redirect_uri: REDIRECT_URI,
    scope: SCOPES,
    code_challenge_method: "S256",
    code_challenge: challenge,
  });
  window.location.href = "https://accounts.spotify.com/authorize?" + params.toString();
}

async function exchangeCodeForToken(code) {
  const verifier = sessionStorage.getItem("sp_pkce_verifier");
  const body = new URLSearchParams({
    client_id: CLIENT_ID,
    grant_type: "authorization_code",
    code,
    redirect_uri: REDIRECT_URI,
    code_verifier: verifier,
  });
  const res = await fetch("https://accounts.spotify.com/api/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
  });
  if (!res.ok) throw new Error("Token exchange failed: " + (await res.text()));
  return res.json();
}

async function refreshAccessToken(refresh_token) {
  const body = new URLSearchParams({
    client_id: CLIENT_ID,
    grant_type: "refresh_token",
    refresh_token,
  });
  const res = await fetch("https://accounts.spotify.com/api/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
  });
  if (!res.ok) throw new Error("Token refresh failed: " + (await res.text()));
  return res.json();
}

function saveTokens(tokenResponse) {
  const existing = loadTokens() || {};
  const tokens = {
    access_token: tokenResponse.access_token,
    refresh_token: tokenResponse.refresh_token || existing.refresh_token,
    expires_at: Date.now() + (tokenResponse.expires_in - 60) * 1000,
  };
  localStorage.setItem(TOKEN_KEY, JSON.stringify(tokens));
  return tokens;
}

function loadTokens() {
  const raw = localStorage.getItem(TOKEN_KEY);
  return raw ? JSON.parse(raw) : null;
}

function clearTokens() {
  localStorage.removeItem(TOKEN_KEY);
}

async function getValidAccessToken() {
  let tokens = loadTokens();
  if (!tokens) return null;
  if (Date.now() >= tokens.expires_at) {
    const refreshed = await refreshAccessToken(tokens.refresh_token);
    tokens = saveTokens(refreshed);
  }
  return tokens.access_token;
}

/* ------------------------------ Web API -------------------------------- */

async function api(path, opts = {}) {
  const token = await getValidAccessToken();
  if (!token) throw new Error("Not authenticated");
  const res = await fetch("https://api.spotify.com/v1" + path, {
    ...opts,
    headers: {
      Authorization: "Bearer " + token,
      "Content-Type": "application/json",
      ...(opts.headers || {}),
    },
  });
  if (res.status === 204 || res.status === 202) return null;
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`API ${path} failed (${res.status}): ${text}`);
  }
  const ct = res.headers.get("content-type") || "";
  return ct.includes("application/json") ? res.json() : null;
}

/* ------------------------------- State ---------------------------------- */

let deviceId = null;
let player = null;
let currentSongs = [];       // [{uri, name, artists, album}]
let currentContextUri = null; // playlist/album context, if any
let localVolume = 0.7;
let progressPollTimer = null;

/* -------------------------------- Boot ----------------------------------- */

window.addEventListener("DOMContentLoaded", init);

async function init() {
  const urlParams = new URLSearchParams(window.location.search);
  const code = urlParams.get("code");

  if (code) {
    try {
      const tokenResponse = await exchangeCodeForToken(code);
      saveTokens(tokenResponse);
      window.history.replaceState({}, document.title, REDIRECT_URI);
    } catch (e) {
      showLoginError(e.message);
    }
  }

  document.getElementById("login-btn").addEventListener("click", redirectToSpotifyAuth);
  document.getElementById("logout-btn").addEventListener("click", () => {
    clearTokens();
    window.location.reload();
  });

  const tokens = loadTokens();
  if (!tokens) {
    showLogin();
    return;
  }

  try {
    await getValidAccessToken(); // will refresh/validate
    showApp();
  } catch (e) {
    clearTokens();
    showLogin();
    showLoginError("Session expired, please reconnect.");
  }
}

function showLogin() {
  document.getElementById("login-screen").classList.remove("hidden");
  document.getElementById("app").classList.add("hidden");
}
function showLoginError(msg) {
  const el = document.getElementById("login-error");
  el.textContent = msg;
  el.classList.remove("hidden");
  showLogin();
}
function showApp() {
  document.getElementById("login-screen").classList.add("hidden");
  document.getElementById("app").classList.remove("hidden");
  wireUpUI();
  loadPlaylists();
  loadView("discover");
}

/* --------------------------- Web Playback SDK ---------------------------- */

window.onSpotifyWebPlaybackSDKReady = () => {
  // The SDK loads immediately on page load, before we may be authenticated.
  // We only actually construct the player once we have tokens.
  const tryInit = async () => {
    const token = await getValidAccessToken().catch(() => null);
    if (!token) { setTimeout(tryInit, 800); return; }
    initPlayer();
  };
  tryInit();
};

function initPlayer() {
  if (player) return;
  player = new Spotify.Player({
    name: "spotui (browser)",
    getOAuthToken: (cb) => { getValidAccessToken().then(cb); },
    volume: localVolume,
  });

  player.addListener("ready", ({ device_id }) => {
    deviceId = device_id;
  });
  player.addListener("not_ready", () => { deviceId = null; });
  player.addListener("player_state_changed", (state) => {
    if (state) renderPlayerState(state);
  });
  player.addListener("initialization_error", ({ message }) => console.error(message));
  player.addListener("authentication_error", ({ message }) => console.error(message));
  player.addListener("account_error", ({ message }) => console.error("Account error (Premium required):", message));

  player.connect();
}

/* -------------------------------- Views ---------------------------------- */

async function loadView(view) {
  document.querySelectorAll("#library-list .nav-item").forEach((li) => {
    li.classList.toggle("active", li.dataset.view === view);
  });
  document.querySelectorAll("#playlists-list .nav-item").forEach((li) => li.classList.remove("active"));
  setSongsLabel(view === "discover" ? "Songs" :
                view === "recent" ? "Recently Played" :
                view === "top" ? "Top Tracks" :
                view === "liked" ? "Liked Songs" : "Songs");

  currentContextUri = null;

  if (view === "discover") {
    const data = await api("/browse/featured-playlists?limit=1").catch(() => null);
    if (data && data.playlists && data.playlists.items[0]) {
      await loadPlaylistTracks(data.playlists.items[0].id, data.playlists.items[0].uri);
    } else {
      renderSongs([]);
    }
  } else if (view === "recent") {
    const data = await api("/me/player/recently-played?limit=50");
    const seen = new Set();
    const tracks = [];
    for (const item of data.items) {
      if (seen.has(item.track.id)) continue;
      seen.add(item.track.id);
      tracks.push(item.track);
    }
    renderSongs(tracks.map(trackToRow));
  } else if (view === "top") {
    const data = await api("/me/top/tracks?limit=50");
    renderSongs(data.items.map(trackToRow));
  } else if (view === "liked") {
    const data = await api("/me/tracks?limit=50");
    renderSongs(data.items.map((i) => trackToRow(i.track)));
  }
}

async function loadPlaylists() {
  const list = document.getElementById("playlists-list");
  const data = await api("/me/playlists?limit=50").catch(() => null);
  list.innerHTML = "";
  if (!data || !data.items.length) {
    list.innerHTML = '<li class="nav-item dim">no playlists</li>';
    return;
  }
  data.items.forEach((pl) => {
    const li = document.createElement("li");
    li.className = "nav-item";
    li.textContent = pl.name;
    li.title = pl.name;
    li.addEventListener("click", () => {
      document.querySelectorAll("#library-list .nav-item, #playlists-list .nav-item").forEach((n) => n.classList.remove("active"));
      li.classList.add("active");
      setSongsLabel(pl.name);
      loadPlaylistTracks(pl.id, pl.uri);
    });
    list.appendChild(li);
  });
}

async function loadPlaylistTracks(playlistId, playlistUri) {
  currentContextUri = playlistUri;
  const data = await api(`/playlists/${playlistId}/tracks?limit=100`).catch(() => null);
  if (!data) { renderSongs([]); return; }
  const rows = data.items.filter((i) => i.track).map((i) => trackToRow(i.track));
  renderSongs(rows);
}

async function runSearch(query) {
  currentContextUri = null;
  setSongsLabel(`Search: "${query}"`);
  document.querySelectorAll("#library-list .nav-item, #playlists-list .nav-item").forEach((n) => n.classList.remove("active"));
  const data = await api("/search?type=track&limit=30&q=" + encodeURIComponent(query));
  renderSongs(data.tracks.items.map(trackToRow));
}

function trackToRow(track) {
  return {
    uri: track.uri,
    name: track.name,
    artists: track.artists.map((a) => a.name).join(", "),
    album: track.album ? track.album.name : "",
  };
}

function setSongsLabel(text) {
  document.getElementById("songs-panel-label").textContent = text;
}

/* -------------------------------- Rendering ------------------------------- */

function renderSongs(rows) {
  currentSongs = rows;
  const list = document.getElementById("songs-list");
  list.innerHTML = "";
  rows.forEach((row, idx) => {
    const li = document.createElement("li");
    li.className = "song-row";
    li.innerHTML = `<span class="col-title">${escapeHtml(row.name)}</span><span class="col-artist">${escapeHtml(row.artists)}</span><span class="col-album">${escapeHtml(row.album)}</span>`;
    li.addEventListener("click", () => {
      document.querySelectorAll(".song-row").forEach((n) => n.classList.remove("selected"));
      li.classList.add("selected");
      playFromRow(idx);
    });
    list.appendChild(li);
  });
}

function escapeHtml(str) {
  const div = document.createElement("div");
  div.textContent = str || "";
  return div.innerHTML;
}

function renderPlayerState(state) {
  const track = state.track_window.current_track;
  document.getElementById("now-track").textContent = track ? track.name : "Nothing playing";
  document.getElementById("now-artist").textContent = track ? track.artists.map((a) => a.name).join(", ") : "—";
  document.getElementById("status-state").textContent = state.paused ? "Paused" : "Playing";
  document.getElementById("status-shuffle").textContent = state.shuffle ? "On" : "Off";
  document.getElementById("status-repeat").textContent = state.repeat_mode === 0 ? "Off" : state.repeat_mode === 1 ? "Context" : "Track";

  document.getElementById("time-total").textContent = msToTime(state.duration);
  updateProgress(state.position, state.duration, state.paused);

  document.querySelectorAll(".song-row").forEach((row) => row.classList.remove("playing"));
  if (track) {
    const idx = currentSongs.findIndex((s) => s.uri === track.uri);
    const rows = document.querySelectorAll(".song-row");
    if (idx >= 0 && rows[idx]) rows[idx].classList.add("playing");
  }
}

function updateProgress(position, duration, paused) {
  clearInterval(progressPollTimer);
  const render = (pos) => {
    document.getElementById("time-elapsed").textContent = msToTime(pos);
    document.getElementById("progress-fill").style.width = duration ? `${Math.min(100, (pos / duration) * 100)}%` : "0%";
  };
  render(position);
  if (!paused) {
    const start = Date.now();
    progressPollTimer = setInterval(() => {
      const pos = Math.min(duration, position + (Date.now() - start));
      render(pos);
      if (pos >= duration) clearInterval(progressPollTimer);
    }, 500);
  }
}

function msToTime(ms) {
  if (!ms && ms !== 0) return "0:00";
  const totalSec = Math.floor(ms / 1000);
  const m = Math.floor(totalSec / 60);
  const s = totalSec % 60;
  return `${m}:${s.toString().padStart(2, "0")}`;
}

/* -------------------------------- Playback -------------------------------- */

async function ensureDevice() {
  if (deviceId) return deviceId;
  await new Promise((r) => setTimeout(r, 500));
  if (deviceId) return deviceId;
  throw new Error("Player device not ready yet — try again in a moment.");
}

async function playFromRow(idx) {
  const dev = await ensureDevice().catch((e) => { console.error(e); return null; });
  if (!dev) return;
  const body = currentContextUri
    ? { context_uri: currentContextUri, offset: { position: idx } }
    : { uris: currentSongs.map((s) => s.uri) , offset: { position: idx } };
  await api(`/me/player/play?device_id=${dev}`, { method: "PUT", body: JSON.stringify(body) });
}

async function togglePlayPause() {
  const state = await player.getCurrentState();
  if (!state) {
    // nothing loaded yet on this device — start from top of current list
    if (currentSongs.length) return playFromRow(0);
    return;
  }
  if (state.paused) await player.resume();
  else await player.pause();
}

async function skipNext() {
  const dev = await ensureDevice().catch(() => null);
  if (dev) await api(`/me/player/next?device_id=${dev}`, { method: "POST" });
}
async function skipPrevious() {
  const dev = await ensureDevice().catch(() => null);
  if (dev) await api(`/me/player/previous?device_id=${dev}`, { method: "POST" });
}

async function toggleShuffle() {
  const state = await player.getCurrentState();
  const next = !(state && state.shuffle);
  const dev = await ensureDevice().catch(() => null);
  if (dev) await api(`/me/player/shuffle?state=${next}&device_id=${dev}`, { method: "PUT" });
}

async function cycleRepeat() {
  const state = await player.getCurrentState();
  const modes = ["off", "context", "track"];
  const current = state ? state.repeat_mode : 0;
  const next = modes[(current + 1) % 3];
  const dev = await ensureDevice().catch(() => null);
  if (dev) await api(`/me/player/repeat?state=${next}&device_id=${dev}`, { method: "PUT" });
}

async function toggleLike() {
  const state = await player.getCurrentState();
  const track = state && state.track_window.current_track;
  if (!track) return;
  const id = track.id;
  const contains = await api(`/me/tracks/contains?ids=${id}`);
  if (contains[0]) {
    await api(`/me/tracks?ids=${id}`, { method: "DELETE" });
  } else {
    await api(`/me/tracks?ids=${id}`, { method: "PUT" });
  }
}

async function changeVolume(delta) {
  localVolume = Math.max(0, Math.min(1, localVolume + delta));
  document.getElementById("status-volume").textContent = `${Math.round(localVolume * 100)}%`;
  if (player) await player.setVolume(localVolume);
}

/* --------------------------------- Wiring --------------------------------- */

function wireUpUI() {
  document.querySelectorAll("#library-list .nav-item").forEach((li) => {
    li.addEventListener("click", () => loadView(li.dataset.view));
  });

  document.getElementById("search-input").addEventListener("keydown", (e) => {
    if (e.key === "Enter" && e.target.value.trim()) {
      runSearch(e.target.value.trim());
    }
  });

  document.getElementById("btn-playpause").addEventListener("click", togglePlayPause);
  document.getElementById("btn-next").addEventListener("click", skipNext);
  document.getElementById("btn-prev").addEventListener("click", skipPrevious);
  document.getElementById("btn-shuffle").addEventListener("click", toggleShuffle);
  document.getElementById("btn-repeat").addEventListener("click", cycleRepeat);
  document.getElementById("btn-like").addEventListener("click", toggleLike);
  document.getElementById("btn-volminus").addEventListener("click", () => changeVolume(-0.1));
  document.getElementById("btn-volplus").addEventListener("click", () => changeVolume(0.1));

  document.getElementById("status-volume").textContent = `${Math.round(localVolume * 100)}%`;
}

/* =========================================================================
   README

   1. Spotify Developer Dashboard (developer.spotify.com/dashboard) → your app
      → Settings → Redirect URIs → add the exact URL this page will live at,
      e.g. https://yourname.github.io/spotify-recent-tracks/player.html
      (must match REDIRECT_URI above exactly, including https and no trailing slash).

   2. Paste your app's Client ID into CLIENT_ID at the top of this file.
      This is NOT the client secret — the Client ID is not sensitive and is
      safe to ship in public client-side JS. Never put the client secret here.

   3. This flow (Authorization Code + PKCE) is entirely separate from the
      GitHub Action's SPOTIFY_CACHE-based auth used by getrec_wo_duplicates.py.
      Nothing here touches that — both can run side by side.

   4. Playback control (play/pause/skip/volume) requires Spotify Premium;
      free accounts can browse but Spotify's API will reject playback calls.

   5. Tokens are kept in this browser's localStorage/sessionStorage only —
      nothing is sent anywhere except Spotify's own API.
   ========================================================================= */
