// オフライン対応用の Service Worker
// - アプリ本体（画面・過去問データ・アイコン）は端末に保存し、電波がなくても開けるようにする
// - ネットにつながるときは常に最新版を取りに行き、保存分も更新する（ネット優先）
// - AI機能（/api/）は保存しない
const CACHE = 'yobi-app-v1';
const FONT_CACHE = 'yobi-fonts-v1';
const APP_FILES = [
  '/',
  '/questions.js',
  '/manifest.webmanifest',
  '/icons/apple-touch-icon.png',
  '/icons/icon-192.png',
  '/icons/icon-512.png',
];
const NETWORK_TIMEOUT_MS = 5000; // 電波が弱いときはこの時間で保存分に切り替える

self.addEventListener('install', event => {
  event.waitUntil(caches.open(CACHE).then(c => c.addAll(APP_FILES)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(k => k !== CACHE && k !== FONT_CACHE).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', event => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);

  // Google Fonts：保存分があればそれを使い、裏で更新する
  if (url.hostname === 'fonts.googleapis.com' || url.hostname === 'fonts.gstatic.com') {
    event.respondWith(staleWhileRevalidate(req, FONT_CACHE));
    return;
  }
  if (url.origin !== self.location.origin) return;
  if (url.pathname.startsWith('/api/')) return;

  // 画面を開くときは、どのURLでもアプリ本体（/）として扱う
  const key = req.mode === 'navigate' ? '/' : url.pathname;
  event.respondWith(networkFirst(req, key));
});

async function networkFirst(req, key) {
  const cache = await caches.open(CACHE);
  const network = fetch(req).then(res => {
    if (res.ok) cache.put(key, res.clone());
    return res;
  });
  network.catch(() => {}); // 時間切れで保存分を返したあとに失敗しても、エラーを残さない
  const timeout = new Promise(resolve => setTimeout(resolve, NETWORK_TIMEOUT_MS, null));
  try {
    const res = await Promise.race([network, timeout]);
    if (res) return res;
    // 時間切れ：保存分があればそれを返す（通信はそのまま続け、終わったら保存分を更新）
    const cached = await cache.match(key);
    return cached || await network;
  } catch {
    const cached = await cache.match(key);
    if (cached) return cached;
    throw new Error('offline and not cached: ' + key);
  }
}

async function staleWhileRevalidate(req, cacheName) {
  const cache = await caches.open(cacheName);
  const cached = await cache.match(req);
  const network = fetch(req).then(res => {
    if (res.ok || res.type === 'opaque') cache.put(req, res.clone());
    return res;
  }).catch(() => cached);
  return cached || network;
}
