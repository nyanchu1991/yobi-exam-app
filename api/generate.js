import { timingSafeEqual } from 'node:crypto';

// サーバー側で固定する設定（クライアントからは変更できない）
// 用途ごとにモデルを固定する。画面側は用途（purpose）を指定するだけで、モデル名は選べない
const MODELS = {
  generate: 'claude-haiku-4-5',  // 問題の生成
  explain: 'claude-sonnet-5-5',  // 過去問のAI解説（判例・条文の正確さを優先）
  daily: 'claude-sonnet-5-5',    // 今日の一問（1日1回。本試験レベルの正確さを優先）
};
const DEFAULT_PURPOSE = 'generate';
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
    console.warn('[api] 401 passphrase mismatch');
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
  const purpose = Object.hasOwn(MODELS, body.purpose) ? body.purpose : DEFAULT_PURPOSE;
  const model = MODELS[purpose];

  const started = Date.now();
  console.log(`[api] start purpose=${purpose} model=${model} max_tokens=${maxTokens} chars=${totalChars}`);

  // ストリーミングで受け取り、できた分からすぐ画面側へ送る。
  // スマホの回線では、何も届かない状態が20秒以上続くと接続が切られることがあるため
  let response;
  try {
    response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': process.env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model,
        max_tokens: maxTokens,
        stream: true,
        messages: messages.map(m => ({ role: m.role, content: m.content })),
      }),
    });
  } catch (err) {
    console.error(`[api] exception purpose=${purpose} model=${model} ms=${Date.now() - started}`, err);
    return res.status(502).json({ error: 'AIに接続できませんでした。' });
  }

  if (!response.ok) {
    const data = await response.json().catch(() => ({}));
    console.error(`[api] anthropic error purpose=${purpose} model=${model} status=${response.status} type=${data.error?.type} message=${data.error?.message} ms=${Date.now() - started}`);
    return res.status(response.status).json({ error: data.error?.message || 'Anthropic API returned an error' });
  }

  // 画面側へは1行1つのJSON（NDJSON）で送る：{"t":"文字"} … 最後に {"done":true,"stop_reason":"…","model":"…"}
  res.statusCode = 200;
  res.setHeader('Content-Type', 'application/x-ndjson; charset=utf-8');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('X-Accel-Buffering', 'no');
  const send = obj => res.write(JSON.stringify(obj) + '\n');
  send({ start: true }); // すぐに1行送って接続を生かす

  let text = '', stop = null, usedModel = model, outTokens = null, buf = '';
  const decoder = new TextDecoder();
  try {
    for await (const chunk of response.body) {
      buf += decoder.decode(chunk, { stream: true });
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i).trim();
        buf = buf.slice(i + 1);
        if (!line.startsWith('data:')) continue;
        let ev;
        try { ev = JSON.parse(line.slice(5)); } catch { continue; }
        if (ev.type === 'message_start') usedModel = ev.message?.model || usedModel;
        else if (ev.type === 'content_block_delta' && ev.delta?.type === 'text_delta') {
          text += ev.delta.text;
          send({ t: ev.delta.text });
        } else if (ev.type === 'message_delta') {
          stop = ev.delta?.stop_reason || stop;
          outTokens = ev.usage?.output_tokens ?? outTokens;
        } else if (ev.type === 'error') {
          throw new Error(ev.error?.message || 'stream error');
        }
      }
    }
    send({ done: true, stop_reason: stop, model: usedModel });
    console.log(`[api] ok purpose=${purpose} model=${usedModel} stop=${stop} out_tokens=${outTokens} text_chars=${text.length} ms=${Date.now() - started} head=${JSON.stringify(text.slice(0, 120))}`);
  } catch (err) {
    console.error(`[api] stream exception purpose=${purpose} model=${model} ms=${Date.now() - started}`, err);
    send({ error: 'AIの返答の受信中にエラーが発生しました。' });
  }
  res.end();
}
