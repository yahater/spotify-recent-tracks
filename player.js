/* =========================================================================
   Spotify Live Player — client-side only, no server, no client secret.

   Architecture in one paragraph: this page authenticates directly against
   Spotify using OAuth "Authorization Code with PKCE" — a flow designed for
   public clients (browser apps, mobile apps) that can't keep a secret safe.
   Once logged in, it uses the Web Playback SDK to register this browser tab
   as a real Spotify Connect device, and the regular Web API for everything
   else (search, playlists, library, transport controls). None of this talks
   to a server we control — every request goes straight from this browser to
   Spotify's own domains. This is entirely separate from the GitHub Action /
   SPOTIFY_CACHE flow that regenerates index.html; that one runs server-side
   in Actions and this one never touches it.

   SETUP:
   1. Paste your Spotify app's Client ID below (not the secret — the Client
      ID is a public identifier, safe to ship in JS anyone can view-source).
   2. In your Spotify Developer Dashboard, add this page's exact URL as a
      Redirect URI (e.g. https://yourname.github.io/spotify-recent-tracks/player.html)
   Full README block at the bottom of this file.
   ========================================================================= */

const CLIENT_ID = "d538883735cd45a7b1ba694cb0ac11f8";

// Wherever this page is actually hosted — Spotify will bounce the browser
// back to this exact URL after login, so it must be registered verbatim in
// the dashboard (see README at the bottom).
const REDIRECT_URI = window.location.origin + window.location.pathname;

// Every permission the app will ever ask for, requested up front at login.
// If you get an "Insufficient client scope" 403 from a new API call later,
// it means the endpoint needs a scope that isn't listed here yet — add it
// here AND force a fresh login (old tokens keep the scopes they were
// originally granted with; editing this list doesn't retroactively upgrade
// a token you already have cached).
const SCOPES = [
  "streaming",                    // required to open a Web Playback SDK device
  "user-read-email",              // required by the SDK's own init handshake
  "user-read-private",            // required by the SDK's own init handshake
  "user-read-playback-state",     // read what's currently playing/paused/shuffled
  "user-modify-playback-state",   // play/pause/skip/seek/volume/shuffle/repeat
  "user-read-currently-playing",  // currently-playing track details
  "user-read-recently-played",    // "Recently Played" view
  "user-top-read",                // "Top Tracks" view
  "user-library-read",            // "Liked Songs" view + checking like status
  "user-library-modify",          // the [Like] button (save/unsave a track)
  "playlist-read-private",        // list + open your own playlists
  "playlist-read-collaborative",  // list + open playlists you collaborate on
].join(" ");

// localStorage key holding { access_token, refresh_token, expires_at }.
// Deliberately in localStorage (persists across tabs/reloads) rather than
// sessionStorage, so you don't have to re-login every time you open the
// page. Trade-off: the refresh token sits on disk in this browser profile
// indefinitely — see the security note in the README at the bottom.
const TOKEN_KEY = "sp_player_tokens";

/* ---------------------------- PKCE helpers -----------------------------
   PKCE ("Proof Key for Code Exchange") is what lets a public, secret-less
   client like this do the Authorization Code flow safely: instead of a
   client secret, we generate a random "verifier", send a hash of it
   ("challenge") with the initial redirect, then prove we hold the original
   verifier when exchanging the code for a token. An attacker who
   intercepts the authorization code alone can't complete the exchange
   without the verifier, which never leaves this browser until that step.
   ------------------------------------------------------------------------ */

// Cryptographically-random string used as the PKCE code_verifier.
function randomString(length) {
  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  let out = "";
  const rand = new Uint8Array(length);
  crypto.getRandomValues(rand);
  for (let i = 0; i < length; i++) out += chars[rand[i] % chars.length];
  return out;
}

// SHA-256 hash of the verifier, base64url-encoded (no padding) — this is
// the PKCE "code_challenge" sent up front, per Spotify/OAuth spec.
async function sha256Base64Url(input) {
  const data = new TextEncoder().encode(input);
  const digest = await crypto.subtle.digest("SHA-256", data);
  let str = "";
  const bytes = new Uint8Array(digest);
  for (let i = 0; i < bytes.length; i++) str += String.fromCharCode(bytes[i]);
  return btoa(str).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

// Step 1 of login: stash a fresh verifier for this attempt, then send the
// browser to Spotify's own login/consent screen. Spotify — not this page —
// collects the user's password; we never see it.
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

// Step 2 of login: Spotify redirected back here with a one-time ?code=.
// Trade it in for real tokens, proving we started the flow by supplying the
// original verifier that matches the challenge we sent in step 1.
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

// Access tokens expire after ~1hr. PKCE public clients are allowed to use
// the refresh_token grant without a client secret, so this stays secretless
// too — this is what keeps you logged in across visits without re-consenting.
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

// Persist tokens to localStorage. Spotify doesn't always return a new
// refresh_token on a refresh call, so keep the old one if a new one wasn't
// issued — losing it would force a full re-login for no reason.
function saveTokens(tokenResponse) {
  const existing = loadTokens() || {};
  const tokens = {
    access_token: tokenResponse.access_token,
    refresh_token: tokenResponse.refresh_token || existing.refresh_token,
    // Subtract 60s as safety margin so we refresh slightly before Spotify
    // would actually reject the token, avoiding edge-case race conditions.
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

// The single choke point every API call goes through: returns a token
// that's guaranteed not-yet-expired, silently refreshing first if needed.
// Returns null if the user has never logged in at all.
async function getValidAccessToken() {
  let tokens = loadTokens();
  if (!tokens) return null;
  if (Date.now() >= tokens.expires_at) {
    const refreshed = await refreshAccessToken(tokens.refresh_token);
    tokens = saveTokens(refreshed);
  }
  return tokens.access_token;
}

/* ------------------------------ Web API ---------------------------------
   Thin wrapper around fetch() for every regular (non-playback-SDK) call to
   Spotify's REST API: attaches the bearer token, and — this is the fix for
   the "revoked access" edge case — if Spotify itself rejects the token as
   unauthorized (401), we assume it's dead for good (revoked, wrong scopes
   that can't self-heal, etc.), wipe it, and force the login screen again
   rather than let every subsequent call fail silently forever.
   ------------------------------------------------------------------------ */

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

  if (res.status === 204 || res.status === 202) return null; // success, no body

  if (res.status === 401) {
    // Token looked valid locally (not expired yet) but Spotify disagrees —
    // most likely the user revoked this app's access from their Spotify
    // account settings. No amount of retrying fixes this; start over.
    clearTokens();
    showLoginError("Your Spotify session was rejected — please reconnect.");
    throw new Error("401 Unauthorized — cleared local session.");
  }

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`API ${path} failed (${res.status}): ${text}`);
  }

  const ct = res.headers.get("content-type") || "";
  return ct.includes("application/json") ? res.json() : null;
}

/* ------------------------------- State -----------------------------------
   Small bit of global state the UI functions below read/write. Kept as
   plain module-level variables since this is a single-page vanilla-JS app
   with no framework/store — deliberately simple for a personal project.
   ------------------------------------------------------------------------ */

let deviceId = null;          // this browser tab's Spotify Connect device ID, once ready
let player = null;            // the Spotify.Player (Web Playback SDK) instance
let currentSongs = [];        // rows currently shown in the songs table: [{uri, name, artists, album}]
let currentContextUri = null; // playlist/album URI backing the current list, if any (null for search/liked/top/recent, which aren't a single Spotify "context")
let localVolume = 0.7;        // 0..1, this device's own volume (independent of other Spotify devices)
let progressPollTimer = null; // interval id for the locally-interpolated progress bar

/* -------------------------------- Boot ------------------------------------
   Runs once on page load. Handles three cases: (a) we just got redirected
   back from Spotify with a fresh ?code=, (b) we already have a saved
   session from a previous visit, (c) neither — show the login screen.
   ------------------------------------------------------------------------ */

window.addEventListener("DOMContentLoaded", init);

async function init() {
  const urlParams = new URLSearchParams(window.location.search);
  const code = urlParams.get("code");

  if (code) {
    // We're on the redirect-back leg of login. Trade the code for tokens,
    // then scrub ?code= from the URL so a page refresh doesn't try (and
    // fail) to reuse an already-consumed one-time code.
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
    await getValidAccessToken(); // touches the refresh path if needed, throws if truly dead
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

/* --------------------------- Web Playback SDK -----------------------------
   Spotify's SDK script (loaded via <script> tag in player.html) calls this
   global callback on its own once it's parsed — which can happen before
   we've finished checking whether the user is even logged in. So instead
   of constructing the player immediately, we poll briefly until a valid
   access token exists, THEN construct it.
   ------------------------------------------------------------------------ */

window.onSpotifyWebPlaybackSDKReady = () => {
  const tryInit = async () => {
    const token = await getValidAccessToken().catch(() => null);
    if (!token) { setTimeout(tryInit, 800); return; }
    initPlayer();
  };
  tryInit();
};

// Creates this browser tab as a real, controllable Spotify Connect device
// named "spotui (browser)". Audio actually plays through this tab, so the
// tab needs to stay open — this isn't remote-controlling your phone/desktop
// app, it *is* the playback device.
function initPlayer() {
  if (player) return; // guard against double-init if the poll above ever overlaps
  player = new Spotify.Player({
    name: "spotui (browser)",
    getOAuthToken: (cb) => { getValidAccessToken().then(cb); }, // SDK calls this whenever it needs a fresh token
    volume: localVolume,
  });

  player.addListener("ready", ({ device_id }) => {
    deviceId = device_id; // now controllable via /me/player/... device_id= calls
  });
  player.addListener("not_ready", () => { deviceId = null; });
  player.addListener("player_state_changed", (state) => {
    // Fires on every play/pause/track-change/seek — this is what keeps the
    // now-playing bar and progress bar in sync in near-real-time.
    if (state) renderPlayerState(state);
  });
  player.addListener("initialization_error", ({ message }) => console.error(message));
  player.addListener("authentication_error", ({ message }) => console.error(message));
  player.addListener("account_error", ({ message }) => console.error("Account error (Premium required):", message));

  player.connect();
}

/* -------------------------------- Views ------------------------------------
   The four sidebar entries under "Library". Each one fetches a different
   Spotify endpoint and dumps the result into the shared songs table.
   ------------------------------------------------------------------------ */

async function loadView(view) {
  document.querySelectorAll("#library-list .nav-item").forEach((li) => {
    li.classList.toggle("active", li.dataset.view === view);
  });
  document.querySelectorAll("#playlists-list .nav-item").forEach((li) => li.classList.remove("active"));
  setSongsLabel(view === "discover" ? "Songs" :
                view === "recent" ? "Recently Played" :
                view === "top" ? "Top Tracks" :
                view === "liked" ? "Liked Songs" : "Songs");

  currentContextUri = null; // none of these four views is a single playlist/album context

  try {
    if (view === "discover") {
      // NOTE: /browse/featured-playlists was deprecated by Spotify for API
      // apps created after Nov 2024 and may 404 permanently depending on
      // when your app was registered. Fall back to Liked Songs so this
      // tab is never just a dead end with no explanation.
      const data = await api("/browse/featured-playlists?limit=1").catch(() => null);
      if (data && data.playlists && data.playlists.items[0]) {
        await loadPlaylistTracks(data.playlists.items[0].id, data.playlists.items[0].uri);
      } else {
        setSongsLabel("Discover (unavailable — showing Liked Songs)");
        const liked = await api("/me/tracks?limit=50");
        renderSongs(liked.items.map((i) => trackToRow(i.track)));
      }
    } else if (view === "recent") {
      const data = await api("/me/player/recently-played?limit=50");
      // The same track can appear multiple times (played more than once
      // recently) — de-dupe by track id so the list reads like a history
      // of songs, not a raw play-event log.
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
  } catch (e) {
    console.error(e);
    setSongsLabel(`${view} — failed to load (see console)`);
    renderSongs([]);
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
    li.textContent = pl.name; // textContent, not innerHTML — safe against a maliciously-named playlist
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
  // Remembering the playlist's own URI (not just its tracks) lets playback
  // use Spotify's native "context" playback — so Next/Previous/Shuffle
  // behave exactly as if you'd pressed play on this playlist inside the
  // real Spotify app, rather than a flat list of URIs with no context.
  currentContextUri = playlistUri;
  const data = await api(`/playlists/${playlistId}/tracks?limit=100`).catch(() => null);
  if (!data) { renderSongs([]); return; }
  const rows = data.items.filter((i) => i.track).map((i) => trackToRow(i.track)); // filter out null tracks (local files / removed tracks Spotify sometimes returns as null)
  renderSongs(rows);
}

async function runSearch(query) {
  currentContextUri = null; // search results aren't a Spotify "context" — playback falls back to an explicit uris: list
  setSongsLabel(`Search: "${query}"`);
  document.querySelectorAll("#library-list .nav-item, #playlists-list .nav-item").forEach((n) => n.classList.remove("active"));
  try {
    const data = await api("/search?type=track&limit=30&q=" + encodeURIComponent(query));
    renderSongs(data.tracks.items.map(trackToRow));
  } catch (e) {
    console.error(e);
    setSongsLabel(`Search failed — see console`);
    renderSongs([]);
  }
}

// Normalizes a Spotify track object down to just what the songs table needs.
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

/* -------------------------------- Rendering --------------------------------
   Pure DOM-painting functions — no network calls in here, just turning
   in-memory state into what's on screen.
   ------------------------------------------------------------------------ */

function renderSongs(rows) {
  currentSongs = rows; // playFromRow()/playback code reads this by index
  const list = document.getElementById("songs-list");
  list.innerHTML = "";
  rows.forEach((row, idx) => {
    const li = document.createElement("li");
    li.className = "song-row";
    // Track title/artist/album come from Spotify but are still untrusted
    // strings (a track could theoretically be named with HTML) — escaped
    // before going into innerHTML.
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
  return div.innerHTML; // browser does the escaping for us
}

// Called on every Web Playback SDK "player_state_changed" event — updates
// the now-playing text, status line, progress bar, and which row in the
// songs table shows the "▶" playing indicator.
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
    // Matches the playing track back to a row in the CURRENTLY DISPLAYED
    // list by URI. If you're browsing a different view than what's
    // actually playing, nothing will highlight — that's expected, not a bug.
    const idx = currentSongs.findIndex((s) => s.uri === track.uri);
    const rows = document.querySelectorAll(".song-row");
    if (idx >= 0 && rows[idx]) rows[idx].classList.add("playing");
  }
}

// The SDK only pushes a new state on actual events (play/pause/seek/track
// change), not every second — so between events we interpolate the
// progress bar locally with setInterval based on elapsed wall-clock time,
// rather than polling Spotify constantly just to move a progress bar.
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
      if (pos >= duration) clearInterval(progressPollTimer); // stop ticking past the end; the next real state_changed event will correct/replace this
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

/* -------------------------------- Playback ---------------------------------
   Transport controls. Two different mechanisms are used deliberately:
   - Play/Pause/Volume go through the SDK's own player object directly
     (player.resume()/pause()/setVolume()) since it already holds live state
     and this avoids an extra round trip for the most-used buttons.
   - Everything else (play-a-specific-track, next, previous, shuffle,
     repeat) goes through the regular Web API with ?device_id= pointing at
     this tab, since the SDK object doesn't expose those directly.
   ------------------------------------------------------------------------ */

// Web API calls need this tab's Spotify Connect device_id, which only
// exists once the SDK's "ready" event has fired. On a slow connection the
// user might click a control before that happens — give it one short grace
// period rather than failing instantly.
async function ensureDevice() {
  if (deviceId) return deviceId;
  await new Promise((r) => setTimeout(r, 500));
  if (deviceId) return deviceId;
  throw new Error("Player device not ready yet — try again in a moment.");
}

// Starts playback at a specific row. If the current list came from a
// playlist, uses Spotify's native context playback (so next/prev/shuffle
// work across the whole playlist); otherwise sends an explicit list of
// track URIs (search results, liked songs, etc. aren't a single "context").
async function playFromRow(idx) {
  const dev = await ensureDevice().catch((e) => { console.error(e); return null; });
  if (!dev) return;
  const body = currentContextUri
    ? { context_uri: currentContextUri, offset: { position: idx } }
    : { uris: currentSongs.map((s) => s.uri), offset: { position: idx } };
  await api(`/me/player/play?device_id=${dev}`, { method: "PUT", body: JSON.stringify(body) });
}

async function togglePlayPause() {
  if (!player) return; // SDK hasn't connected yet
  const state = await player.getCurrentState();
  if (!state) {
    // Nothing has ever been loaded onto this device this session —
    // "play/pause" with nothing playing means "start the visible list".
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
  if (!player) return;
  const state = await player.getCurrentState();
  const next = !(state && state.shuffle);
  const dev = await ensureDevice().catch(() => null);
  if (dev) await api(`/me/player/shuffle?state=${next}&device_id=${dev}`, { method: "PUT" });
}

async function cycleRepeat() {
  if (!player) return;
  const state = await player.getCurrentState();
  const modes = ["off", "context", "track"]; // off -> repeat whole context -> repeat single track -> off...
  const current = state ? state.repeat_mode : 0;
  const next = modes[(current + 1) % 3];
  const dev = await ensureDevice().catch(() => null);
  if (dev) await api(`/me/player/repeat?state=${next}&device_id=${dev}`, { method: "PUT" });
}

// Saves/unsaves the currently-playing track to Liked Songs, toggling based
// on its current state (Spotify has no single "toggle like" endpoint).
async function toggleLike() {
  if (!player) return;
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

// Adjusts THIS device's volume only (via the SDK directly) — doesn't touch
// the volume of any other Spotify Connect device, since this tab is its
// own independent playback device.
async function changeVolume(delta) {
  localVolume = Math.max(0, Math.min(1, localVolume + delta));
  document.getElementById("status-volume").textContent = `${Math.round(localVolume * 100)}%`;
  if (player) await player.setVolume(localVolume);
}

/* --------------------------------- Wiring ---------------------------------
   Attaches every button/input's event listener once, after login succeeds
   and the app UI is actually visible (showApp() calls this).
   ------------------------------------------------------------------------ */

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

   5. Security note: tokens live only in this browser's localStorage/
      sessionStorage — nothing is ever sent to a server we control. The
      trade-off of localStorage (vs. re-logging in every visit) is that the
      refresh token persists on disk in this browser profile until you hit
      the [⏻] logout button or clear the site's storage — log out on any
      shared/public computer when you're done.

   6. Known limitation: /browse/featured-playlists (used for "Discover") is
      deprecated for Spotify apps created after Nov 2024 and may always
      404 depending on your app's age — this code falls back to Liked Songs
      in that case rather than showing a dead tab.
   ========================================================================= */
