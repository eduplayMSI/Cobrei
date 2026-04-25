const CACHE_NAME = 'cobrei-v1';
const urlsToCache = [
  '/',
  '/index.html',
  '/style.css',
  '/script.js',
  '/manifest.json'
  // Remova ícones daqui – eles já são cacheados pelo navegador via manifesto
];

self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then(cache => {
        console.log('Cache aberto');
        // Tenta adicionar cada URL, ignorando falhas individuais
        return Promise.allSettled(
          urlsToCache.map(url => cache.add(url).catch(err => console.warn(`Falha ao cachear ${url}:`, err)))
        );
      })
      .catch(err => console.error('Erro no cache:', err))
  );
  self.skipWaiting();
});

self.addEventListener('fetch', event => {
  event.respondWith(
    caches.match(event.request)
      .then(response => response || fetch(event.request))
  );
});

self.addEventListener('activate', event => {
  event.waitUntil(clients.claim());
});