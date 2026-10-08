// Service Worker：缓存应用外壳。
//
// 策略是缓存优先。页面入口、脚本、worker、wasm_exec.js 与 WASM 都用不带
// 查询参数的固定路径，版本由 CACHE_NAME 管理——make build-wasm 会把这五个
// 文件的内容哈希写进来，任何一个变了缓存名就变，新 SW 安装时清掉旧缓存。
// 因此页面上的 HTML、JS 与 WASM 必然是同一版本，不会出现新 JS 调旧 wasm。
//
// 代价是换版要用户点一次：新的 SW 只在下次打开才接管。viewer 用一条横幅
// 提示"重新加载即可使用最新功能"。
//
// 用户文档一律不进缓存。?file= 下载带 cache: 'no-store'，这里据此放行，
// 否则同一个地址会读到上一次的副本，而且文档会占满 Cache Storage。

/** 由 make build-wasm 按内容哈希替换。 */
const CACHE_NAME = 'ofd-toolbox_8c9e2bd033d3145a';

/** 纳入外壳缓存的固定路径。 */
const SHELL = [
  './',
  './index.html',
  './app.js',
  './worker.js',
  './toolbox.css',
  './wasm_exec.js',
  './toolbox.wasm',
  './wechat-qr.png',
  './wechat-search.png',
  './icon-192.png',
  './icon-512.png',
  './icon-maskable-192.png',
  './icon-maskable-512.png',
  './apple-touch-icon.png',
  './favicon-32.png',
];

self.addEventListener('install', (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE_NAME);
    // 逐个 add 而不是 addAll：addAll 是原子的，任一资源取不到就整批失败、
    // 新 SW 装不上，浏览器会永久继续用旧缓存且没有任何提示。逐个添加失败
    // 只影响那一个，并在控制台列出。
    for (const path of SHELL) {
      try {
        await cache.add(new Request(path, { cache: 'reload' }));
      } catch (error) {
        console.warn('[OFD 工具箱 SW] 预缓存失败：', path, error);
      }
    }
    await self.skipWaiting();
  })());
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const names = await caches.keys();
    await Promise.all(
      names
        .filter((name) => name.startsWith('ofd-toolbox_') && name !== CACHE_NAME)
        .map((name) => caches.delete(name)),
    );
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', (event) => {
  const request = event.request;
  if (request.method !== 'GET') return;

  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;

  // 文档下载不进缓存：既不该占存储，也不该读到陈旧副本。
  if (request.cache === 'no-store') return;

  event.respondWith((async () => {
    const cached = await caches.match(request, { ignoreSearch: true });
    if (cached) return cached;
    try {
      const response = await fetch(request);
      if (response.ok && response.type === 'basic') {
        const cache = await caches.open(CACHE_NAME);
        cache.put(request, response.clone());
      }
      return response;
    } catch (error) {
      // 离线且没缓存：让请求自然失败，由界面显示错误。
      throw error;
    }
  })());
});

// 新 SW 装好后通知页面，由界面决定何时提示用户刷新。
self.addEventListener('message', (event) => {
  if (event.data && event.data.type === 'skipWaiting') self.skipWaiting();
});
