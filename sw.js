// Offline shell cache + network-first JSON cache
const SHELL_CACHE = 'sb-shell-v4';
const DATA_CACHE  = 'sb-data-v2';

const SHELL = [
  '/', '/index.html',
  '/assets/styles.css',
  '/src/app.js', '/src/data.js', '/src/search-worker.js',
  '/manifest.webmanifest', '/favicon.svg'
];

self.addEventListener('install', (e)=>{
  e.waitUntil((async()=>{
    const c = await caches.open(SHELL_CACHE);
    try { await c.addAll(SHELL); } catch(_) { /* ok when hosted under a subpath */ }
    self.skipWaiting();
  })());
});

self.addEventListener('activate', (e)=>{
  e.waitUntil((async()=>{
    const keep = new Set([SHELL_CACHE, DATA_CACHE]);
    for (const k of await caches.keys()){
      if(!keep.has(k)) await caches.delete(k);
    }
    self.clients.claim();
  })());
});

self.addEventListener('fetch', (e)=>{
  const url = new URL(e.request.url);
  if(url.origin !== location.origin) return;

  // JSON: network-first so new data wins without hard reload
  if(url.pathname.endsWith('.json')){
    e.respondWith((async()=>{
      const cache = await caches.open(DATA_CACHE);
      try{
        const fresh = await fetch(e.request, { cache: 'no-store' });
        if (fresh.ok) cache.put(e.request, fresh.clone());
        return fresh;
      }catch{
        const cached = await cache.match(e.request);
        return cached || new Response('Offline', { status: 503, statusText: 'Offline' });
      }
    })());
    return;
  }

  // Everything else: cache-first (fast shell)
  e.respondWith((async()=>{
    const cache = await caches.open(SHELL_CACHE);
    const cached = await cache.match(e.request);
    if(cached) return cached;
    try{
      const res = await fetch(e.request);
      if(res.ok && (url.pathname.startsWith('/assets/') || url.pathname.startsWith('/src/'))){
        cache.put(e.request, res.clone());
      }
      return res;
    }catch{
      return cached || new Response('Offline', { status: 503, statusText: 'Offline' });
    }
  })());
});
