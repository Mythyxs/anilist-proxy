const express = require('express');
const cors = require('cors');
const fetch = require('node-fetch');

const app = express();

app.use(cors());
app.use(express.json({ type: '*/*' }));

const ANILIST_URL = 'https://graphql.anilist.co';
const BACKUP_JSON_URL = 'https://raw.githubusercontent.com/Mythyxs/website/refs/heads/main/anime_backup.json';

let scheduleCache = null;
let lastFetchedTime = null;

// /anilist passthrough
app.post('/anilist', async (req, res) => {
  try {
    const response = await fetch(ANILIST_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify(req.body),
    });
    const data = await response.json();
    res.json(data);
  } catch (err) {
    console.error('❌ AniList fetch failed:', err);
    res.status(500).json({ error: 'AniList proxy failed' });
  }
});

// /cached-schedule endpoint
app.get('/cached-schedule', async (req, res) => {
  const now = Date.now();

  if (scheduleCache && now - lastFetchedTime < 1000 * 60 * 60) {
    console.log('✅ Returning cached schedule');
    return res.json(scheduleCache);
  }

  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 8000);

    const jsonRes = await fetch(BACKUP_JSON_URL, { signal: controller.signal });
    clearTimeout(timeout);

    const animeList = await jsonRes.json();

    const relevantTitles = animeList.filter(a =>
      a.category === 'Planned to Watch' || a.category === 'Unfinished / Disinterested'
    );

    const result = [];
    const DELAY_MS = 100;

    for (const anime of relevantTitles) {
      try {
        const response = await fetch(ANILIST_URL, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
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
            variables: { search: anime.title },
          }),
        });

        if (response.status === 429) {
          console.warn(`🚫 Rate limit hit while fetching ${anime.title}`);
          continue;
        }

        if (!response.ok) {
          console.error(`❌ Error ${response.status} for ${anime.title}`);
          continue;
        }

        const json = await response.json();
        const media = json?.data?.Media;
        if (!media) continue;

        const nowSecs = Math.floor(Date.now() / 1000);
        const nextEp = media.nextAiringEpisode;

        if (nextEp && nextEp.episode && nextEp.airingAt) {
          const upcomingNumber = nextEp.episode;
          const upcomingAiringAt = nextEp.airingAt;

          const prevEpisodeNumber = upcomingNumber - 1;
          const prevEpisodeAiringAt = upcomingAiringAt - 7 * 24 * 3600;

          const isRecent = prevEpisodeNumber > 0 && (nowSecs - prevEpisodeAiringAt) < 86400;

          result.push({
            title: media.title.english || media.title.romaji || anime.title,
            coverImage: media.coverImage?.medium || media.coverImage?.large || '',
            totalEpisodes: media.episodes || 0,
            nextEpisode: {
              episode: isRecent ? prevEpisodeNumber : upcomingNumber,
              airingAt: isRecent ? prevEpisodeAiringAt : upcomingAiringAt,
            },
          });
        }

        await new Promise(r => setTimeout(r, DELAY_MS));
      } catch (err) {
        console.error(`Error fetching ${anime.title}:`, err);
      }
    }

    scheduleCache = result;
    lastFetchedTime = now;
    console.log('✅ Cached schedule updated');
    res.json(result);
  } catch (err) {
    console.error('❌ Failed to build schedule:', err);
    res.status(500).json({ error: 'Failed to fetch schedule' });
  }
});

// ------------------------------------------------ ROBLOX WHITELIST / PROXY STUFF ------------------------------------------------ 
// In-memory HWID whitelist
const WHITELIST = [
  "CC8995C0-3E17-4CB9-AC30-3364A8C3719C",
  "dd928f96-61e4-4247-99db-5dfc2e77a39b",
  "FA5D0F51-F0AE-4311-8122-0DF905C6069B",
  "B722AB45-9873-4094-B92E-E9C8549F4DC3",
  "9BFC9376-77AB-431E-8FC6-B547AA4F4228",
  "55e3782f-df86-4bc5-b5dc-389314d3c956",
  "C172AAF2-3DB6-4B67-8658-1FB9334E825B",
  "C6452844-C695-490E-A12E-C1BE4E609B68",
  "16542119-F0BC-4C3D-9FEB-DC9FFB2468BC"
];

// Serve whitelist as plain text (newline-separated)
app.get('/whitelist', (req, res) => {
  console.log('📥 /whitelist requested');
  res.setHeader('Content-Type', 'text/plain');
  res.setHeader('Cache-Control', 'no-store');
  res.send(WHITELIST.join('\n'));
});



// ------------------------------------------------ ROBLOX WHITELIST / PROXY STUFF ------------------------------------------------ 

// Preflight
app.options('/anilist', (_, res) => res.sendStatus(200));
app.options('/cached-schedule', (_, res) => res.sendStatus(200));

// ✅ Start server
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`✅ AniList proxy running on port ${PORT}`));
