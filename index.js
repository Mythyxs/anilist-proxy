const express = require('express');
const cors = require('cors');
const fetch = require('node-fetch');

const app = express();

// Allow CORS and ensure JSON is parsed regardless of content-type
app.use(cors());
app.use(express.json({ type: '*/*' }));

const ANILIST_URL = 'https://graphql.anilist.co';

// Main proxy endpoint
app.post('/anilist', async (req, res) => {
  try {
    console.log('🔄 Incoming body:', req.body); // Log what your site sends

    const response = await fetch(ANILIST_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Accept': 'application/json',
      },
      body: JSON.stringify(req.body),
    });

    const data = await response.json();
    console.log('✅ AniList response:', data); // Log what AniList replies

    res.json(data);
  } catch (err) {
    console.error('❌ AniList fetch failed:', err);
    res.status(500).json({ error: 'AniList proxy failed' });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`AniList proxy running on port ${PORT}`));
