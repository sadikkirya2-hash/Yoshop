const CACHE_NAME = 'yoshop-v23'; // Increment this version number whenever you make changes!
const urlsToCache = [
  '/',
  '/index.html',
  '/app.js',
  '/style.css',
  '/assets/icons/android192x192.png',
  '/assets/icons/android512x512.png',
  '/assets/icons/ios192.png',
  '/assets/icons/ios512.png',
  '/assets/icons/wind400.png',
  '/assets/icons/market.png',
  '/assets/icons/icon.png',
  'https://cdn.jsdelivr.net/npm/chart.js',
  'https://cdnjs.cloudflare.com/ajax/libs/jspdf/2.5.1/jspdf.umd.min.js',
  'https://cdnjs.cloudflare.com/ajax/libs/jspdf-autotable/3.5.29/jspdf.plugin.autotable.min.js',
  'https://cdnjs.cloudflare.com/ajax/libs/html2canvas/1.4.1/html2canvas.min.js',
  'https://cdn.jsdelivr.net/npm/jsbarcode@3.11.5/dist/JsBarcode.all.min.js',
  'https://www.gstatic.com/firebasejs/12.13.0/firebase-app.js',
  'https://www.gstatic.com/firebasejs/12.13.0/firebase-analytics.js',
  'https://www.gstatic.com/firebasejs/12.13.0/firebase-firestore.js',
  'https://www.gstatic.com/firebasejs/12.13.0/firebase-storage.js',
  'https://www.gstatic.com/firebasejs/12.13.0/firebase-auth.js'
];

self.addEventListener('install', (event) => {
  // Forces the waiting service worker to become the active service worker.
  self.skipWaiting();
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then((cache) => {
        console.log('Opened cache');
        // Cache files individually. If one fails, it won't stop the others.
        return Promise.all(
          urlsToCache.map((url) => {
            return cache.add(url).catch((err) => {
              console.error('Failed to cache:', url, err);
            });
          })
        );
      })
  );
});

self.addEventListener('fetch', (event) => {
  // Bypass service worker for development server scripts to avoid 502/MIME errors
  if (event.request.url.includes('fiveserver.js') || event.request.url.includes('livereload.js')) {
    return;
  }

  event.respondWith(
    caches.match(event.request, { ignoreSearch: true })
      .then((response) => {
        // Cache hit - return response
        if (response) {
          return response;
        }
        
        return fetch(event.request)
          .then((networkResponse) => {
            // If manifest fetch fails in preview tunnel, return an empty 204 response instead of erroring.
            if (event.request.url.endsWith('/manifest.json') && networkResponse.status !== 200) {
              return new Response(null, { status: 204, statusText: 'No Manifest in Preview' });
            }

            // Cache images and Firebase Storage assets dynamically when they are successfully fetched
            if (networkResponse && networkResponse.status === 200 && (event.request.destination === 'image' || event.request.url.includes('firebasestorage.googleapis.com'))) {
              const responseToCache = networkResponse.clone();
              caches.open(CACHE_NAME).then((cache) => {
                cache.put(event.request, responseToCache);
              });
            }
            return networkResponse;
          })
          .catch((err) => {
            // If fetch fails (offline or blocked), and it's a navigation request, return index.html
            if (event.request.mode === 'navigate') {
              return caches.match('/index.html');
            }
            return new Response('Offline: Resource not available', { status: 408, headers: { 'Content-Type': 'text/plain' } });
          })
      })
  );
});

// Listen for message from client to force update
self.addEventListener('message', (event) => {
  if (event.data && event.data.type === 'SKIP_WAITING') {
    self.skipWaiting();
  }
});

self.addEventListener('activate', (event) => {
  const cacheWhitelist = [CACHE_NAME];
  event.waitUntil(
    caches.keys().then((cacheNames) => {
      return Promise.all(
        cacheNames.map((cacheName) => {
          if (cacheWhitelist.indexOf(cacheName) === -1) {
            return caches.delete(cacheName);
          }
        })
      );
    }).then(() => {
      // Take control of all clients immediately
      return self.clients.claim();
    })
  );
});