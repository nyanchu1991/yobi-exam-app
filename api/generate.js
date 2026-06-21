export default async function handler(req, res) {
  if (req.method === 'GET') {
    if (!process.env.ANTHROPIC_API_KEY) {
      console.error('API Error: ANTHROPIC_API_KEY is not set.');
      return res.status(500).json({ error: 'Server configuration error: API key is missing.' });
    }
    try {
      console.log('Fetching available models from Anthropic...');
      const response = await fetch('https://api.anthropic.com/v1/models', {
        method: 'GET',
        headers: {
          'x-api-key': process.env.ANTHROPIC_API_KEY,
          'anthropic-version': '2023-06-01',
        }
      });
      const data = await response.json();
      console.log('Anthropic GET /v1/models response:', JSON.stringify(data));
      return res.status(response.status).json(data);
    } catch (err) {
      console.error('API Proxy Models Exception:', err);
      return res.status(500).json({ error: err.message });
    }
  }

  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  if (!process.env.ANTHROPIC_API_KEY) {
    console.error('API Error: ANTHROPIC_API_KEY is not set.');
    return res.status(500).json({ error: 'Server configuration error: API key is missing.' });
  }

  try {
    let requestBody = req.body;
    if (typeof requestBody === 'string') {
      try {
        requestBody = JSON.parse(requestBody);
      } catch (e) {
        console.warn('Failed to parse request body string as JSON:', e);
      }
    }

    console.log('Sending request to Anthropic with payload:', JSON.stringify(requestBody));

    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': process.env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify(requestBody),
    });

    const data = await response.json();

    if (!response.ok) {
      const errorMsg = data.error?.message || 'Anthropic API returned an error';
      console.error('Anthropic API Error:', data.error || data);
      return res.status(response.status).json({ error: errorMsg });
    }

    return res.status(response.status).json(data);
  } catch (err) {
    console.error('API Proxy Exception:', err);
    return res.status(500).json({ error: 'An internal server error occurred while processing the request.' });
  }
}
