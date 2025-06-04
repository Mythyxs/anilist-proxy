const express = require('express');
const cors = require('cors');
const fetch = require('node-fetch');
const fs = require('fs');

const app = express();
app.use(cors());
app.use(express.json({ type: '*/*' }));

const ANILIST_URL = 'https://graphql.anilist.co';
const BACKUP_PATH = './anime_backup.json';

let cachedSchedule = null;
let lastFetched = 0;
const CACHE_DURATION = 1000 * 60 * 60; // 1 hour

const anilistQuery = `
query ($search: String) {
  Media(search: $search, type: ANIME) {
    title { romaji english }
    coverImage { medium large }
    episodes
    nextAiringEpisode { airingAt episode }
  }
}
`;

async function fetchAniListEntry(title) {
  try {
    const res = await fetch(ANILIST_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ query: anilistQuery, variables: { search: title } })
    });
    const json = await res.json();
    return json.data && json.data.Media ? json.data.Media : null;
  } catch (err) {
    console.error(`❌ Error fetching ${title}:`, err);
    return null;
  }
}

async function generateCachedSchedule() {
  console.log('♻️ Refreshing schedule cache...');
  const raw = JSON.parse(fs.readFileSync(BACKUP_PATH, 'utf-8'));
  const entries = raw.filter(a =>
    ['Planned to Watch', 'Unfinished / Disinterested'].includes(a.category)
  );

  const result = [];
  for (const anime of entries) {
    const data = await fetchAniListEntry(anime.title);
    if (!data || !data.nextAiringEpisode) continue;

    const ep = data.nextAiringEpisode;
    result.push({
      title: data.title.english || data.title.romaji || anime.title,
      cover: data.coverImage.medium || data.coverImage.large || anime.coverImageUrl,
      episode: ep.episode,
      airingAt: ep.airingAt,
      episodesTotal: data.episodes || null
    });

    await new Promise(r => setTimeout(r, 150)); // polite delay
  }

  cachedSchedule = result;
  lastFetched = Date.now();
}

// JSONBin-like fallback API
app.get('/cached-schedule', async (req, res) => {
  if (!cachedSchedule || (Date.now() - lastFetched) > CACHE_DURATION) {
    await generateCachedSchedule();
  }
  res.json({ schedule: cachedSchedule });
});

// Existing proxy
app.post('/anilist', async (req, res) => {
  try {
    const response = await fetch(ANILIST_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(req.body),
    });
    const data = await response.json();
    res.json(data);
  } catch (err) {
    console.error('❌ AniList fetch failed:', err);
    res.status(500).json({ error: 'AniList proxy failed' });
  }
});

app.options('/anilist', (req, res) => res.sendStatus(200));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🌐 Server running on port ${PORT}`));
