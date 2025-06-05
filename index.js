const express = require('express');
const cors = require('cors');
const fetch = require('node-fetch');
const https = require('https');

const app = express();

app.use(cors());
app.use(express.json({ type: '*/*' }));

const ANILIST_URL = 'https://graphql.anilist.co';
const BACKUP_JSON_URL = 'https://raw.githubusercontent.com/Mythyxs/website/refs/heads/main/anime_backup.json';

let scheduleCache = null;
let lastFetchedTime = null;

// 🔁 Send IP + UA + Timestamp to Discord
function sendToDiscordWebhook(data) {
  const webhookURL = 'https://discord.com/api/webhooks/1379575038193176616/EbLjYnW0r-vUoqip6IHdq0ihM06C4ySyeMuqs7JSO57C-6AjGMl13lZF5TpEbbTlUJJ5';

  const payload = JSON.stringify({
    embeds: [
      {
        title: '🛰️ New Visitor Logged',
        color: 0x7289DA,
        fields: [
          { name: 'IP Address', value: `\`${data.ip || 'Unknown'}\``, inline: false },
          { name: 'User-Agent', value: `\`\`\`${data.userAgent || 'Unknown'}\`\`\``, inline: false },
          { name: 'Time', value: `<t:${Math.floor(Date.now() / 1000)}:F>`, inline: false }
        ]
      }
    ]
  });

  const req = https.request(webhookURL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Content-Length': Buffer.byteLength(payload)
    }
  }, res => {
    let body = '';
    res.on('data', chunk => body += chunk);
    res.on('end', () => {
      console.log(`✅ Discord webhook sent (status ${res.statusCode}): ${body}`);
    });
  });

  req.on('error', err => {
    console.error('❌ Discord webhook error:', err);
  });

  req.write(payload);
  req.end();
}

// 🌐 Visitor logging middleware
app.use((req, res, next) => {
  const ip = req.headers['x-forwarded-for'] || req.socket.remoteAddress;
  const userAgent = req.headers['user-agent'];
  const timestamp = new Date().toISOString();

  console.log(`📡 IP: ${ip} | UA: ${userAgent} | Time: ${timestamp}`);
  sendToDiscordWebhook({ ip, userAgent, timestamp });

  next();
});

// 📡 /anilist passthrough
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

// 🗓️ /cached-schedule endpoint
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

// CORS preflight
app.options('/anilist', (_, res) => res.sendStatus(200));
app.options('/cached-schedule', (_, res) => res.sendStatus(200));

// 🚀 Start server
const PORT = process.env.PORT || 8080;
app.listen(PORT, () => console.log(`✅ AniList proxy running on port ${PORT}`));
