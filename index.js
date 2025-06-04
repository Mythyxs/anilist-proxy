const express = require('express');
const cors = require('cors');
const fetch = require('node-fetch');

const app = express();
app.use(cors());

// Allow any content type (important fix)
app.use(express.text({ type: '*/*' }));
app.use(express.json({ type: '*/*' }));

const ANILIST_URL = 'https://graphql.anilist.co';

app.post('/anilist', async (req, res) => {
  let body = req.body;

  // If request was sent as raw text, manually parse JSON
  if (typeof body === 'string') {
    try {
      body = JSON.parse(body);
    } catch (err) {
      return res.status(400).json({ error: 'Invalid JSON body' });
    }
  }

  try {
    const response = await fetch(ANILIST_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
      body: JSON.stringify(body),
    });
    const data = await response.json();
    res.json(data);
  } catch (err) {
    console.error('AniList fetch failed:', err);
    res.status(500).json({ error: 'AniList proxy failed' });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`AniList proxy running on port ${PORT}`));
