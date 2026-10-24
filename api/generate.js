import { timingSafeEqual } from 'node:crypto';

// サーバー側で固定する設定（クライアントからは変更できない）
const MODEL = 'claude-haiku-4-5';
const MAX_TOKENS_LIMIT = 4000;
const MAX_PROMPT_CHARS = 30000;

function passphraseMatches(given) {
  const expected = process.env.APP_PASSPHRASE;
  if (!expected || typeof given !== 'string') return false;
  const a = Buffer.from(given);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  if (!process.env.ANTHROPIC_API_KEY || !process.env.APP_PASSPHRASE) {
    console.error('API Error: ANTHROPIC_API_KEY or APP_PASSPHRASE is not set.');
    return res.status(500).json({ error: 'サーバー設定エラー: 環境変数 ANTHROPIC_API_KEY と APP_PASSPHRASE を設定してください。' });
  }

  if (!passphraseMatches(req.headers['x-app-passphrase'])) {
    return res.status(401).json({ error: '合言葉が違います。' });
  }

  let body = req.body;
  if (typeof body === 'string') {
    try { body = JSON.parse(body); } catch { body = null; }
  }

  // 受け付けるのはテキストのメッセージ配列と max_tokens だけ
  const messages = body?.messages;
  const validMessages = Array.isArray(messages) && messages.length > 0 && messages.length <= 10 &&
    messages.every(m => (m?.role === 'user' || m?.role === 'assistant') && typeof m.content === 'string');
  if (!validMessages) {
    return res.status(400).json({ error: 'リクエストの形式が不正です。' });
  }
  const totalChars = messages.reduce((n, m) => n + m.content.length, 0);
  if (totalChars > MAX_PROMPT_CHARS) {
    return res.status(400).json({ error: 'プロンプトが長すぎます。' });
  }
  const requested = Number(body.max_tokens);
  const maxTokens = Number.isFinite(requested) && requested > 0
    ? Math.min(Math.floor(requested), MAX_TOKENS_LIMIT)
    : 2000;

  try {
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': process.env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: MODEL,
        max_tokens: maxTokens,
        messages: messages.map(m => ({ role: m.role, content: m.content })),
      }),
    });

    const data = await response.json();

    if (!response.ok) {
      console.error('Anthropic API Error:', response.status, data.error?.type);
      return res.status(response.status).json({ error: data.error?.message || 'Anthropic API returned an error' });
    }

    return res.status(200).json(data);
  } catch (err) {
    console.error('API Proxy Exception:', err);
    return res.status(500).json({ error: 'An internal server error occurred while processing the request.' });
  }
}
