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

        // --- Updated logic for nextEpisode selection ---
        if (!media) {
          return null;
        }

        // AniList’s “nextAiringEpisode” refers to the upcoming episode (N). We want to decide:
        // – If episode N-1 aired < 24 hours ago, return (N-1, its airtime) so the client shows “Aired X hours ago.”  
        // – Otherwise, return the true “next” (N, its future airtime).

        const nowSecs = Math.floor(Date.now() / 1000);
        const nextEp = media.nextAiringEpisode;

        // Fallback values, in case AniList has no nextAiringEpisode
        let chosenEpisode = 1;
        let chosenAiringAt = 0;

        // 1) If AniList gave us a “nextAiringEpisode”:
        if (nextEp && nextEp.episode && nextEp.airingAt) {
          const upcomingNumber = nextEp.episode;
          const upcomingAiringAt = nextEp.airingAt;

          // Estimate when episode (N-1) would have aired:
          // AniList doesn’t expose “last aired” info directly, but episodes are weekly,
          // so we assume: prevEpisodeTime ≈ nextEpisodeTime – 7 days (604 800 s).
          const prevEpisodeNumber = upcomingNumber - 1;
          const prevEpisodeAiringAt = upcomingAiringAt - 7 * 24 * 3600;

          // If prevEpisodeNumber > 0 and it aired within last 24 hrs, show that instead:
          const secondsSincePrevAired = nowSecs - prevEpisodeAiringAt;
          if (prevEpisodeNumber > 0 && secondsSincePrevAired < 24 * 3600) {
            chosenEpisode = prevEpisodeNumber;
            chosenAiringAt = prevEpisodeAiringAt;
          } else {
            // Otherwise show the actual upcoming episode normally:
            chosenEpisode = upcomingNumber;
            chosenAiringAt = upcomingAiringAt;
          }

        // 2) If AniList gave us no “nextAiringEpisode” (e.g. show ended, etc.)
        } else {
          // We’ll show “EP 1” with airingAt=0, so it will appear as “Aired” immediately.
          // You can tweak this fallback if you’d rather omit finished/unknown shows entirely.
          chosenEpisode = 1;
          chosenAiringAt = 0;
        }

        return {
          title: media.title.english || media.title.romaji || anime.title,
          coverImage: media.coverImage?.medium || media.coverImage?.large || '',
          totalEpisodes: media.episodes || 0,
          nextEpisode: {
            episode: chosenEpisode,
            airingAt: chosenAiringAt
          }
        };
        // --- End updated logic ---
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
