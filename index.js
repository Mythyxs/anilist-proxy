// anilist-proxy/index.js
// FULL WORKING FILE  ── paste over the old one
//-------------------------------------------------
const express = require('express');
const cors = require('cors');
const fetch = require('node-fetch');
const Bottleneck = require('bottleneck');

const app = express();

// ─────────────────────────────────────────────────
// CORS
// ─────────────────────────────────────────────────
app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');      // tighten if you want
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  next();
});
app.use(express.json({ type: '*/*' }));

// ─────────────────────────────────────────────────
// CONSTANTS
// ─────────────────────────────────────────────────
const ANILIST_URL        = 'https://graphql.anilist.co';
const BACKUP_JSON_URL    = 'https://raw.githubusercontent.com/Mythyxs/website/refs/heads/main/anime_backup.json';
const SCHEDULE_CACHE_MS  = 60 * 60 * 1000;   // 1 hour
const MIN_TIME_MS        = 700;              // 700 ms → ~85 req/min (safe)
const BURST_LIMIT        = 90;               // AniList minute quota

// ─────────────────────────────────────────────────
// GLOBAL STATE
// ─────────────────────────────────────────────────
let scheduleCache   = null;      // last completed schedule (array)
let lastFetchedTime = 0;         // Date.now() when above was built
let buildPromise    = null;      // Promise for an in-progress build

// per-process cache of individual Media responses
const mediaCache = new Map();    // title → { data, fetchedAt: Date }

// ─────────────────────────────────────────────────
// Bottleneck – hard guarantees that we NEVER exceed API limits
// ─────────────────────────────────────────────────
const limiter = new Bottleneck({
  minTime: MIN_TIME_MS,
  maxConcurrent: 1,
  reservoir: BURST_LIMIT,
  reservoirRefreshAmount: BURST_LIMIT,
  reservoirRefreshInterval: 60 * 1000
});

// Helper: wrap any fn in limiter
const limitedFetch = (...args) => limiter.schedule(() => fetch(...args));

// ─────────────────────────────────────────────────
// /anilist – pure passthrough (still rate-limited)
// ─────────────────────────────────────────────────
app.post('/anilist', async (req, res) => {
  try {
    const aniRes = await limitedFetch(ANILIST_URL, {
      method : 'POST',
      headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
      body   : JSON.stringify(req.body)
    });
    const data = await aniRes.json();
    res.status(aniRes.status).json(data);
  } catch (err) {
    console.error('❌ /anilist error', err);
    res.status(500).json({ error: 'AniList proxy failed' });
  }
});

// ─────────────────────────────────────────────────
// /cached-schedule – main entry point from website
// ─────────────────────────────────────────────────
app.get('/cached-schedule', async (req, res) => {
  const now = Date.now();

  // Serve hot cache
  if (scheduleCache && (now - lastFetchedTime) < SCHEDULE_CACHE_MS) {
    return res.json(scheduleCache);
  }

  // Someone else is already rebuilding → wait for them
  if (buildPromise) {
    try { return res.json(await buildPromise); }
    catch { /* fall through to rebuild */ }
  }

  // Build (and remember the Promise so we don't stampede)
  buildPromise = buildSchedule();
  try {
    const fresh = await buildPromise;
    scheduleCache   = fresh;
    lastFetchedTime = Date.now();
    res.json(fresh);
  } catch (err) {
    console.error('❌ buildSchedule failed', err);
    res.status(500).json({ error: 'Failed to build schedule' });
  } finally {
    buildPromise = null;   // allow future builds
  }
});

// ─────────────────────────────────────────────────
// Schedule builder
// ─────────────────────────────────────────────────
async function buildSchedule () {
  console.log('🔄 Building schedule …');

  // 1) Grab your personal anime list
  const listRes   = await fetch(BACKUP_JSON_URL);
  const animeList = await listRes.json();

  // 2) Only titles in the two user categories
  const relevant = animeList.filter(a =>
    a.category === 'Planned to Watch' || a.category === 'Unfinished / Disinterested'
  );

  const results = [];

  for (const anime of relevant) {
    const media = await getMedia(anime.title);
    if (!media) continue;

    const nowSecs = Math.floor(Date.now() / 1000);
    const nextEp  = media.nextAiringEpisode;

    // exactly the same push logic you already had
    if (nextEp && nextEp.episode && nextEp.airingAt) {
      const upcomingNumber   = nextEp.episode;
      const upcomingAiringAt = nextEp.airingAt;

      const prevEpisodeNumber   = upcomingNumber - 1;
      const prevEpisodeAiringAt = upcomingAiringAt - 7 * 24 * 3600;

      const usePrev = prevEpisodeNumber > 0 &&
                      (nowSecs - prevEpisodeAiringAt) < 24 * 3600;

      results.push({
        title       : media.title.english || media.title.romaji || anime.title,
        coverImage  : media.coverImage?.medium || media.coverImage?.large || '',
        totalEpisodes: media.episodes || 0,
        nextEpisode : {
          episode  : usePrev ? prevEpisodeNumber : upcomingNumber,
          airingAt : usePrev ? prevEpisodeAiringAt : upcomingAiringAt
        }
      });
    } else {
      console.log(`ℹ️  No upcoming episode for ${anime.title}`);
    }
  }

  console.log(`✅ Schedule ready – ${results.length} items`);
  return results;
}

// ─────────────────────────────────────────────────
// Single-title fetch with its own 1-hour cache
// ─────────────────────────────────────────────────
async function getMedia (title) {
  // 1h per-title cache
  const cached = mediaCache.get(title);
  if (cached && (Date.now() - cached.fetchedAt) < SCHEDULE_CACHE_MS) {
    return cached.data;
  }

  // Build GraphQL body once
  const body = JSON.stringify({
    query: `
      query ($search: String) {
        Media(search: $search, type: ANIME) {
          title { romaji english }
          coverImage { medium large }
          episodes
          nextAiringEpisode { airingAt episode }
        }
      }`,
    variables: { search: title }
  });

  try {
    const res  = await limitedFetch(ANILIST_URL, {
      method : 'POST',
      headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
      body
    });

    if (res.status === 429) {
      console.warn(`🚫 429 for "${title}" – skipped`);
      return null;
    }
    if (!res.ok) {
      console.error(`❌ ${res.status} for "${title}"`);
      return null;
    }

    const json  = await res.json();
    const media = json?.data?.Media;
    if (media) {
      mediaCache.set(title, { data: media, fetchedAt: Date.now() });
    }
    return media;

  } catch (err) {
    console.error(`❌ Fetch failed for "${title}"`, err);
    return null;
  }
}

// ─────────────────────────────────────────────────
// Preflight
// ─────────────────────────────────────────────────
app.options('/anilist',          (_, res) => res.sendStatus(200));
app.options('/cached-schedule',  (_, res) => res.sendStatus(200));

// ─────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`AniList proxy ✅  up on ${PORT}`));
