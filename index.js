const express = require('express');
const cors = require('cors');
const fetch = require('node-fetch');

const app = express();
app.use(cors());
app.use(express.json({ type: '*/*' }));

const CLIENT_ID = '27414';
const CLIENT_SECRET = 'N9leRn5xrk7KlFWGDk1U2uJN8orViKq7MoscQwW6';
const ANILIST_TOKEN_URL = 'https://anilist.co/api/v2/oauth/token';
const ANILIST_URL = 'https://graphql.anilist.co';
const BACKUP_JSON_URL = 'https://raw.githubusercontent.com/Mythyxs/website/refs/heads/main/anime_backup.json';

let accessToken = null;
let tokenExpiresAt = 0;

async function fetchAccessToken() {
  const now = Date.now();
  if (accessToken && now < tokenExpiresAt) return accessToken;

  console.log('🔐 Fetching new AniList access token...');
  const res = await fetch(ANILIST_TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      grant_type: 'client_credentials',
      client_id: CLIENT_ID,
      client_secret: CLIENT_SECRET
    })
  });

  if (!res.ok) {
    throw new Error('❌ Failed to get AniList access token');
  }

  const data = await res.json();
  accessToken = data.access_token;
  tokenExpiresAt = now + (data.expires_in * 1000);
  console.log('✅ Token received, expires in', data.expires_in, 'seconds');
  return accessToken;
}

let scheduleCache = null;
let lastFetchedTime = null;

app.get('/cached-schedule', async (req, res) => {
  const now = Date.now();
  if (scheduleCache && now - lastFetchedTime < 1000 * 60 * 60) {
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

    const result = [];
    const DELAY_MS = 500;

    for (const anime of relevantTitles) {
      const token = await fetchAccessToken();
      console.log(`⏱️ START processing "${anime.title}" at ${new Date().toISOString()}`);

      try {
        const response = await fetch(ANILIST_URL, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${token}`
          },
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
          continue;
        }

        if (!response.ok) {
          console.error(`❌ Error ${response.status} for "${anime.title}"`);
          continue;
        }

        const json = await response.json();
        const media = json?.data?.Media;

        if (!media) {
          console.log(`❌ No media found for "${anime.title}"`);
          continue;
        }

        console.log(`📺 Found media for "${anime.title}"`);

        const nowSecs = Math.floor(Date.now() / 1000);
        const nextEp = media.nextAiringEpisode;

        if (nextEp && nextEp.episode && nextEp.airingAt) {
          const upcomingNumber = nextEp.episode;
          const upcomingAiringAt = nextEp.airingAt;
          const prevEpisodeNumber = upcomingNumber - 1;
          const prevEpisodeAiringAt = upcomingAiringAt - 7 * 24 * 3600;

          const usePrevious = prevEpisodeNumber > 0 && (nowSecs - prevEpisodeAiringAt) < 24 * 3600;

          result.push({
            title: media.title.english || media.title.romaji || anime.title,
            coverImage: media.coverImage?.medium || media.coverImage?.large || '',
            totalEpisodes: media.episodes || 0,
            nextEpisode: {
              episode: usePrevious ? prevEpisodeNumber : upcomingNumber,
              airingAt: usePrevious ? prevEpisodeAiringAt : upcomingAiringAt
            }
          });
        } else {
          console.log(`❌ No upcoming episode for "${anime.title}"`);
        }
      } catch (err) {
        console.error(`💥 Error fetching "${anime.title}":`, err);
      }

      console.log(`⏳ Waiting ${DELAY_MS}ms before next fetch...`);
      await new Promise(r => setTimeout(r, DELAY_MS));
      console.log(`✅ Finished delay for "${anime.title}" at ${new Date().toISOString()}`);
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

// CORS preflight
app.options('/anilist', (req, res) => res.sendStatus(200));
app.options('/cached-schedule', (req, res) => res.sendStatus(200));

// AniList passthrough
app.post('/anilist', async (req, res) => {
  try {
    const token = await fetchAccessToken();
    const response = await fetch(ANILIST_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${token}`
      },
      body: JSON.stringify(req.body)
    });

    const data = await response.json();
    res.json(data);
  } catch (err) {
    console.error('❌ AniList passthrough failed:', err);
    res.status(500).json({ error: 'AniList passthrough failed' });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`✅ AniList proxy running on port ${PORT}`));
