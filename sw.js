const CACHE_NAME = 'yoshop-v18'; // Increment this version number whenever you make changes!
const urlsToCache = [
  '/',
  '/index.html',
  '/manifest.json',
  '/app.js',
  '/style.css',
  '/assets/icons/icon.png',
  '/assets/icons/market.png',
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
          .catch((err) => {
            // If fetch fails (offline or blocked), and it's a navigation request, return index.html
            if (event.request.mode === 'navigate') {
              return caches.match('/index.html');
            }
            // Re-throw the error to avoid the "Failed to convert value to Response" TypeError.
            throw err;
          });
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