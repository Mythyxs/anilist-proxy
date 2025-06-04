const express = require('express');
const cors = require('cors');
const fetch = require('node-fetch');

const app = express();

// CORS
app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*'); // You can restrict to your domain
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  next();
});
app.use(express.json({ type: '*/*' }));

const ANILIST_URL = 'https://graphql.anilist.co';
const BACKUP_JSON_URL = 'https://raw.githubusercontent.com/Mythyxs/website/refs/heads/main/anime_backup.json';

let scheduleCache = null;
let lastFetchedTime = null;

// ========== /anilist POST passthrough ==========
app.post('/anilist', async (req, res) => {
  try {
    console.log('🔄 Incoming body:', JSON.stringify(req.body, null, 2));
    const response = await fetch(ANILIST_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
      body: JSON.stringify(req.body),
    });
    const data = await response.json();
    console.log('✅ AniList response:', data);
    res.json(data);
  } catch (err) {
    console.error('❌ AniList fetch failed:', err);
    res.status(500).json({ error: 'AniList proxy failed' });
  }
});

// ========== /cached-schedule GET route ==========
app.get('/cached-schedule', async (req, res) => {
  const now = Date.now();
  if (scheduleCache && now - lastFetchedTime < 1000 * 60 * 60) { // 1 hour cache
    console.log('✅ Returning cached schedule');
    return res.json(scheduleCache);
  }

  try {
    console.log('🔄 Fetching anime_backup.json...');
    const jsonRes = await fetch(BACKUP_JSON_URL);
    const animeList = await jsonRes.json();

    const relevantTitles = animeList.filter(a =>
      a.category === 'Planned to Watch' || a.category === 'Unfinished / Disinterested'
    );

    const BATCH_SIZE = 5;
    const BATCH_DELAY_MS = 1000;
    const result = [];

    for (let i = 0; i < relevantTitles.length; i += BATCH_SIZE) {
      const batch = relevantTitles.slice(i, i + BATCH_SIZE);

      const batchResults = await Promise.all(batch.map(async (anime) => {
        const response = await fetch(ANILIST_URL, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
          body: JSON.stringify({
            query: `
              query ($search: String) {
                Media(search: $search, type: ANIME) {
                  title { romaji english }
                  coverImage { medium large }
                  episodes
                  nextAiringEpisode { airingAt episode }
                }
              }`,
            variables: { search: anime.title }
          })
        });

        const json = await response.json();
        const media = json?.data?.Media;

        // Smarter handling for just-aired episodes
        if (!media) return null;

        let nextEp = media.nextAiringEpisode;
        const nowSec = Date.now() / 1000;

        let episodeNumber = nextEp?.episode;
        let airingAt = nextEp?.airingAt;

        if (episodeNumber && airingAt) {
          const timeSinceAir = nowSec - airingAt;
          if (timeSinceAir < 86400) {
            // keep showing this episode
          } else {
            // fallback: simulate that last episode aired
            airingAt -= 7 * 24 * 60 * 60; // estimate previous episode time
            episodeNumber -= 1;
          }
        } else {
          // fallback if AniList gives no airing info at all
          airingAt = 0;
          episodeNumber = 1;
        }

        return {
          title: media.title.english || media.title.romaji || anime.title,
          coverImage: media.coverImage?.medium || media.coverImage?.large || '',
          totalEpisodes: media.episodes || 0,
          nextEpisode: {
            episode: episodeNumber,
            airingAt: airingAt
          }
        };
      }));

      result.push(...batchResults.filter(Boolean));
      if (i + BATCH_SIZE < relevantTitles.length) {
        await new Promise(r => setTimeout(r, BATCH_DELAY_MS));
      }
    }

    scheduleCache = result;
    lastFetchedTime = now;
    console.log('✅ Cached schedule updated');
    res.json(result);

  } catch (err) {
    console.error('❌ Failed to fetch schedule:', err);
    res.status(500).json({ error: 'Failed to build schedule' });
  }
});

// Handle preflight
app.options('/anilist', (req, res) => res.sendStatus(200));
app.options('/cached-schedule', (req, res) => res.sendStatus(200));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`AniList proxy running on port ${PORT}`));
