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
// Per-anime cache to avoid re-fetching data for titles seen within the last hour
const animeCache = {};

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
  const nowMs = Date.now();

  // If scheduleCache is fresh (within the last hour), return it immediately
  if (scheduleCache && nowMs - lastFetchedTime < 1000 * 60 * 60) {
    console.log('✅ Returning cached schedule');
    return res.json(scheduleCache);
  }

  try {
    console.log('🔄 Fetching anime_backup.json...');
    const jsonRes = await fetch(BACKUP_JSON_URL);
    const animeList = await jsonRes.json();

    // Filter to only the categories we care about
    const relevantTitles = animeList.filter(a =>
      a.category === 'Planned to Watch' || a.category === 'Unfinished / Disinterested'
    );

    const result = [];
    const DELAY_MS = 500;

    for (const anime of relevantTitles) {
      const loopStart = Date.now();
      console.log(`⏱️ START processing "${anime.title}" at ${new Date(loopStart).toISOString()}`);

      // Check per-anime cache
      const cacheEntry = animeCache[anime.title];
      if (cacheEntry && (loopStart - cacheEntry.fetchedAt) < 1000 * 60 * 60) {
        console.log(`🗃️ Using cached result for "${anime.title}"`);
        result.push(cacheEntry.data);
        console.log(`⏰ Skipping fetch and delay for "${anime.title}" (cached within last hour)`);
        continue;
      }

      // Not in cache or cache expired, fetch from AniList
      try {
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

        if (response.status === 429) {
          console.warn(`🚫 Rate limit hit while fetching "${anime.title}"`);
        } else if (!response.ok) {
          console.error(`❌ HTTP ${response.status} error for "${anime.title}"`);
        } else {
          const json = await response.json();
          const media = json?.data?.Media;

          if (!media) {
            console.log(`⚠️ No media found for "${anime.title}"`);
          } else {
            console.log(`📺 Found media for "${anime.title}"`);

            const nowSecs = Math.floor(Date.now() / 1000);
            const nextEp = media.nextAiringEpisode;
            let entry = null;

            if (nextEp && nextEp.episode && nextEp.airingAt) {
              const upcomingNumber = nextEp.episode;
              const upcomingAiringAt = nextEp.airingAt;
              const prevEpisodeNumber = upcomingNumber - 1;
              const prevEpisodeAiringAt = upcomingAiringAt - 7 * 24 * 3600;

              if (prevEpisodeNumber > 0 && (nowSecs - prevEpisodeAiringAt) < 24 * 3600) {
                entry = {
                  title: media.title.english || media.title.romaji || anime.title,
                  coverImage: media.coverImage?.medium || media.coverImage?.large || '',
                  totalEpisodes: media.episodes || 0,
                  nextEpisode: {
                    episode: prevEpisodeNumber,
                    airingAt: prevEpisodeAiringAt
                  }
                };
              } else {
                entry = {
                  title: media.title.english || media.title.romaji || anime.title,
                  coverImage: media.coverImage?.medium || media.coverImage?.large || '',
                  totalEpisodes: media.episodes || 0,
                  nextEpisode: {
                    episode: upcomingNumber,
                    airingAt: upcomingAiringAt
                  }
                };
              }
            } else {
              console.log(`❌ No upcoming episode for "${anime.title}"`);
            }

            if (entry) {
              // Store in per-anime cache
              animeCache[anime.title] = {
                data: entry,
                fetchedAt: Date.now()
              };
              result.push(entry);
            }
          }
        }
      } catch (err) {
        console.error(`💥 Error fetching data for "${anime.title}":`, err);
      }

      console.log(`⏳ Waiting ${DELAY_MS}ms before next fetch...`);
      await new Promise(r => setTimeout(r, DELAY_MS));
      console.log(`✅ Finished delay for "${anime.title}" at ${new Date().toISOString()}`);
    }

    scheduleCache = result;
    lastFetchedTime = Date.now();
    console.log('✅ Cached schedule updated');
    res.json(result);

  } catch (err) {
    console.error('❌ Failed to build schedule:', err);
    res.status(500).json({ error: 'Failed to build schedule' });
  }
});

// Handle preflight OPTIONS
app.options('/anilist', (req, res) => res.sendStatus(200));
app.options('/cached-schedule', (req, res) => res.sendStatus(200));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`AniList proxy running on port ${PORT}`));
