/* Deep Work Field service worker: app shell + demo worksheets + runtime assets.
 * The build replaces __DWF_VERSION__ and __DWF_PRECACHE__ (see web/vite.config.ts), so every
 * deploy gets its own cache and the essential built JS/CSS/fonts are precached, not just HTML. */
const VERSION = 'dwf-__DWF_VERSION__';
const SHELL = `${VERSION}-shell`;
const RUNTIME = `${VERSION}-runtime`;
const BUILT = /* __DWF_PRECACHE__ */ [];
const PRECACHE = ['/', '/index.html', '/demo/worksheet-a.html', '/demo/worksheet-b.html', '/demo/demo-helper.js', ...BUILT];

self.addEventListener('install', (event) => {
  event.waitUntil(
    (async () => {
      const cache = await caches.open(SHELL);
      const results = await Promise.all(
        PRECACHE.map(async (url) => {
          try {
            await cache.add(new Request(url, { cache: 'reload' }));
            return true;
          } catch (error) {
            return false;
          }
        }),
      );
      // The shell and its built assets are essential: fail the install (keep the
      // previous worker) rather than activate one that cannot start offline.
      if (results.slice(0, 2).includes(false) || results.slice(5).includes(false)) throw new Error('precache incomplete');
      await self.skipWaiting();
    })(),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      const keys = await caches.keys();
      // Only Deep Work Field's own old caches; never another app's on this origin.
      await Promise.all(keys.filter((key) => key.startsWith('dwf-') && !key.startsWith(VERSION)).map((key) => caches.delete(key)));
      await self.clients.claim();
    })(),
  );
});

self.addEventListener('fetch', (event) => {
  const request = event.request;
  if (request.method !== 'GET') return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;

  if (request.mode === 'navigate') {
    event.respondWith(
      (async () => {
        try {
          const fresh = await fetch(request);
          const cache = await caches.open(SHELL);
          cache.put(request, fresh.clone());
          return fresh;
        } catch (error) {
          const cache = await caches.open(SHELL);
          const hit = (await cache.match(request, { ignoreSearch: true })) || (await caches.match(request, { ignoreSearch: true }));
          if (hit) return hit;
          if (url.pathname.startsWith('/demo/')) {
            return new Response(
              '<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Offline</title>' +
                '<body style="margin:0;display:grid;place-items:center;min-height:100vh;background:#050407;color:#efe7d6;font:16px/1.5 system-ui,sans-serif">' +
                '<div style="max-width:28rem;padding:24px"><h1 style="font:400 32px Georgia,serif">This worksheet is not cached yet</h1>' +
                '<p>You are offline and this page was never opened while online, so there is nothing saved to show. Open it once online and it will work offline after that.</p></div>',
              { status: 503, headers: { 'Content-Type': 'text/html; charset=utf-8' } },
            );
          }
          return (await cache.match('/index.html')) || Response.error();
        }
      })(),
    );
    return;
  }

  event.respondWith(
    (async () => {
      const cache = await caches.open(RUNTIME);
      const cached = await cache.match(request);
      const network = fetch(request)
        .then((response) => {
          if (response.ok) cache.put(request, response.clone());
          return response;
        })
        .catch(() => null);
      return cached || (await network) || Response.error();
    })(),
  );
});
