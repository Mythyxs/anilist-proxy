const express = require('express');
const cors = require('cors');
const fetch = require('node-fetch');

const app = express();

// Explicit CORS settings
app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*'); // Or restrict to 'https://shemxz.com'
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  next();
});

app.use(express.json({ type: '*/*' }));

const ANILIST_URL = 'https://graphql.anilist.co';

app.post('/anilist', async (req, res) => {
  try {
    console.log('🔄 Incoming body:', JSON.stringify(req.body, null, 2));

    const response = await fetch(ANILIST_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Accept': 'application/json',
      },
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

// Handle preflight CORS requests
app.options('/anilist', (req, res) => {
  res.sendStatus(200);
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`AniList proxy running on port ${PORT}`));
