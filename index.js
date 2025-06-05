/* ───────────── anilist-proxy/index.js ─────────────
 *
 *  • One GraphQL call instead of N-per-title
 *  • Uses AniList OAuth2 client-credentials flow
 *  • 1-hour cache + single-flight guard
 * ------------------------------------------------- */
const express = require('express');
const cors    = require('cors');
const fetch   = require('node-fetch');

const app = express();

/* ---------- CORS ---------- */
app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');   // tighten if desired
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  next();
});
app.use(express.json({ type: '*/*' }));

/* ---------- Config (put your real creds in Render’s env vars) ---------- */
const ANILIST_URL      = 'https://graphql.anilist.co';
const BACKUP_JSON_URL  = 'https://raw.githubusercontent.com/Mythyxs/website/refs/heads/main/anime_backup.json';
const CLIENT_ID        = process.env.ANILIST_CLIENT_ID     || '27414';
const CLIENT_SECRET    = process.env.ANILIST_CLIENT_SECRET || 'N9leRn5xrk7KlFWGDk1U2uJN8orViKq7MoscQwW6';
const CACHE_TTL_MS     = 60 * 60 * 1000;   // 1 hour

/* ---------- In-memory caches ---------- */
let scheduleCache   = null;
let lastFetchedTime = 0;
let buildPromise    = null;
let auth            = { token: null, expires: 0 };

/* ---------- Helper: get (and cache) an OAuth token ---------- */
async function getAuthToken () {
  const now = Date.now();
  if (auth.token && now < auth.expires - 60_000) return auth.token;  // 1-min early refresh

  const res  = await fetch('https://anilist.co/api/v2/oauth/token', {
    method : 'POST',
    headers: { 'Content-Type': 'application/json' },
    body   : JSON.stringify({
      grant_type   : 'client_credentials',
      client_id    : CLIENT_ID,
      client_secret: CLIENT_SECRET
    })
  });

  if (!res.ok) throw new Error(`OAuth ${res.status}`);

  const json   = await res.json();
  auth.token   = json.access_token;
  auth.expires = now + (json.expires_in * 1000);
  console.log(`✅ AniList token (expires in ${(json.expires_in / 3600).toFixed(1)} h)`);
  return auth.token;
}

/* ---------- Helper: build one batched GraphQL query ---------- */
function makeBatchedQuery (titles) {
  // GraphQL aliases must be unique, e.g. a0, a1, …
  const fields = titles.map((t, i) => `a${i}: Media(search:"${t.replace(/"/g, '\\"')}", type: ANIME) {
      title { romaji english }
      coverImage { medium large }
      episodes
      nextAiringEpisode { episode airingAt }
    }`).join('\n');

  return `query { ${fields} }`;
}

/* ---------- Build (or serve) the /cached-schedule ---------- */
app.get('/cached-schedule', async (req, res) => {
  const now = Date.now();
  if (scheduleCache && now - lastFetchedTime < CACHE_TTL_MS) {
    console.log('✅ Serving cached schedule');
    return res.json(scheduleCache);
  }

  if (buildPromise) {                    // another build in flight → await it
    try { return res.json(await buildPromise); }
    catch { /* fall through to new build */ }
  }

  buildPromise = (async () => {
    try {
      console.log('🔄 Rebuilding schedule...');
      const listRes   = await fetch(BACKUP_JSON_URL);
      const allAnime  = await listRes.json();
      const needsEp   = allAnime.filter(a =>
        a.category === 'Planned to Watch' || a.category === 'Unfinished / Disinterested'
      );
      if (!needsEp.length) return [];

      /* 1️⃣  grab a token */
      const token   = await getAuthToken();

      /* 2️⃣  one batched GraphQL call */
      const gqBody  = { query: makeBatchedQuery(needsEp.map(a => a.title)) };
      const gqRes   = await fetch(ANILIST_URL, {
        method : 'POST',
        headers: {
          'Content-Type' : 'application/json',
          'Accept'       : 'application/json',
          'Authorization': `Bearer ${token}`
        },
        body   : JSON.stringify(gqBody)
      });

      if (gqRes.status === 429) throw new Error('Still 429 – oAuth bucket exhausted');
      if (!gqRes.ok)             throw new Error(`AniList ${gqRes.status}`);

      const gqJson   = await gqRes.json();
      const data     = gqJson.data || {};
      const result   = [];

      needsEp.forEach((entry, idx) => {
        const media = data[`a${idx}`];
        if (!media) return;
        result.push({
          title        : media.title.english || media.title.romaji || entry.title,
          coverImage   : media.coverImage?.medium || media.coverImage?.large || '',
          totalEpisodes: media.episodes || 0,
          nextEpisode  : media.nextAiringEpisode
            ? { episode: media.nextAiringEpisode.episode, airingAt: media.nextAiringEpisode.airingAt }
            : null
        });
      });

      scheduleCache   = result;
      lastFetchedTime = Date.now();
      console.log(`✅ Schedule cached (${result.length} titles)`);
      return result;
    } finally {
      buildPromise = null;
    }
  })();

  try   { res.json(await buildPromise); }
  catch (e) {
    console.error('❌ Schedule build failed:', e);
    res.status(500).json({ error: 'Failed to build schedule' });
  }
});

/* ---------- Simple passthrough (still useful for other queries) ---------- */
app.post('/anilist', async (req, res) => {
  try {
    const token = await getAuthToken();
    const data  = await fetch(ANILIST_URL, {
      method : 'POST',
      headers: {
        'Content-Type' : 'application/json',
        'Accept'       : 'application/json',
        'Authorization': `Bearer ${token}`
      },
      body   : JSON.stringify(req.body)
    }).then(r => r.json());

    res.json(data);
  } catch (err) {
    console.error('❌ Passthrough failed:', err);
    res.status(500).json({ error: 'AniList proxy failed' });
  }
});

/* ---------- Pre-flight ---------- */
app.options('/anilist',         (_, res) => res.sendStatus(200));
app.options('/cached-schedule', (_, res) => res.sendStatus(200));

/* ---------- Listen ---------- */
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`AniList proxy listening on ${PORT}`));
/* ───────────────────────────────────────────────────── */
