/* ───────────── anilist-proxy/index.js ───────────── */
const express    = require('express');
const cors       = require('cors');
const fetch      = require('node-fetch');
const Bottleneck = require('bottleneck');     // ← npm i bottleneck@^2.19.5

const app = express();

/* ---------- CORS ---------- */
app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');   // tighten if needed
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  next();
});
app.use(express.json({ type: '*/*' }));

/* ---------- Constants ---------- */
const ANILIST_URL      = 'https://graphql.anilist.co';
const BACKUP_JSON_URL  = 'https://raw.githubusercontent.com/Mythyxs/website/refs/heads/main/anime_backup.json';
const CACHE_TTL_MS     = 60 * 60 * 1000;    // 1 hour

/* ---------- Global caches ---------- */
let scheduleCache   = null;                 // whole schedule
let lastFetchedTime = 0;
const mediaCache    = new Map();            // per-title cache
let  buildPromise   = null;                 // “single-flight” guard

/* ---------- Bottleneck limiter (1 concurrent, 700 ms min) ---------- */
const limiter = new Bottleneck({
  maxConcurrent : 1,
  minTime       : 700                      // ≈ 85 req/min  (AniList limit: 90) :contentReference[oaicite:0]{index=0}
});

/* ---------- Helper: fetch Media with per-title cache ---------- */
async function getMedia(title) {
  const now = Date.now();
  const cached = mediaCache.get(title);
  if (cached && now - cached.fetchedAt < CACHE_TTL_MS) return cached.data;

  return limiter.schedule(async () => {
    const res = await fetch(ANILIST_URL, {
      method  : 'POST',
      headers : { 'Content-Type' : 'application/json', 'Accept' : 'application/json' },
      body    : JSON.stringify({
        query : `
          query ($search: String) {
            Media(search: $search, type: ANIME) {
              title  { romaji english }
              coverImage { medium large }
              episodes
              nextAiringEpisode { airingAt episode }
            }
          }`,
        variables : { search: title }
      })
    });

    if (res.status === 429) {           // burst guard – just skip this title
      console.warn(`🚫 429 for ${title}`);
      return null;
    }
    if (!res.ok) {
      console.error(`❌ ${res.status} for ${title}`);
      return null;
    }

    const json  = await res.json();
    const media = json?.data?.Media ?? null;
    if (media) mediaCache.set(title, { data: media, fetchedAt: Date.now() });
    return media;
  });
}

/* ---------- POST /anilist • simple passthrough (also rate-limited) ---------- */
app.post('/anilist', async (req, res) => {
  try {
    const data = await limiter.schedule(() =>
      fetch(ANILIST_URL, {
        method  : 'POST',
        headers : { 'Content-Type': 'application/json', 'Accept': 'application/json' },
        body    : JSON.stringify(req.body)
      }).then(r => r.json())
    );
    res.json(data);
  } catch (err) {
    console.error('❌ AniList passthrough failed:', err);
    res.status(500).json({ error: 'AniList proxy failed' });
  }
});

/* ---------- GET /cached-schedule ---------- */
app.get('/cached-schedule', async (req, res) => {
  const now = Date.now();

  /* serve fresh cache */
  if (scheduleCache && now - lastFetchedTime < CACHE_TTL_MS) {
    console.log('✅ Serving cached schedule');
    return res.json(scheduleCache);
  }

  /* another build in flight → wait for it */
  if (buildPromise) {
    try { return res.json(await buildPromise); }
    catch (e) { /* fall through to rebuild */ }
  }

  /* build schedule (single-flight) */
  buildPromise = (async () => {
    try {
      console.log('🔄 Rebuilding schedule...');
      const listRes   = await fetch(BACKUP_JSON_URL);
      const fullList  = await listRes.json();
      const relevant  = fullList.filter(a =>
        a.category === 'Planned to Watch' || a.category === 'Unfinished / Disinterested'
      );

      const result = [];
      for (const entry of relevant) {
        const media = await getMedia(entry.title);
        if (!media) continue;

        const next = media.nextAiringEpisode;
        result.push({
          title       : media.title.english || media.title.romaji || entry.title,
          coverImage  : media.coverImage?.medium || media.coverImage?.large || '',
          totalEpisodes : media.episodes || 0,
          nextEpisode : next ? { episode: next.episode, airingAt: next.airingAt } : null
        });
      }

      scheduleCache   = result;
      lastFetchedTime = Date.now();
      console.log('✅ Schedule cached');
      return result;
    } finally {
      buildPromise = null;               // clear lock
    }
  })();

  /* wait for build & return */
  try   { res.json(await buildPromise); }
  catch (e) {
    console.error('❌ Schedule build failed:', e);
    res.status(500).json({ error: 'Failed to build schedule' });
  }
});

/* ---------- Pre-flight ---------- */
app.options('/anilist',         (req, res) => res.sendStatus(200));
app.options('/cached-schedule', (req, res) => res.sendStatus(200));

/* ---------- Server ---------- */
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`AniList proxy listening on ${PORT}`));
/* ───────────────────────────────────────────────────── */
