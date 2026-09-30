'use strict';

// build-www.py réécrit ce jeton à chaque build (hash du contenu). Ne pas le
// figer à la main : c'est ce qui invalide le cache-first ci-dessous, et sans
// lui une nouvelle version du JS n'atteint jamais l'appareil.
const APP_CACHE   = 'blanket-app-v3-dev';
const SOUND_CACHE = 'blanket-sounds-v1';

const APP_FILES = [
  './',
  './index.html',
  './style.css',
  './i18n.js',
  './audio-engine.js',
  './app.js',
  './manifest.json',
  './fonts/material-symbols-rounded.woff2',
  './icons/icon-192.png',
  './icons/icon-512.png',
];

// Cache static app shell on install (fast — no audio files yet)
self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(APP_CACHE)
      .then(cache => cache.addAll(APP_FILES))
      .then(() => self.skipWaiting())
  );
});

// Clean old caches on activate
self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys()
      .then(keys => Promise.all(
        keys
          .filter(k => k !== APP_CACHE && k !== SOUND_CACHE)
          .map(k => caches.delete(k))
      ))
      .then(() => self.clients.claim())
  );
});

// Fetch strategy:
//   - OGG sounds  → cache-first, lazy-fill on first play
//   - Everything else → cache-first, network fallback
self.addEventListener('fetch', event => {
  const { request } = event;
  const url = new URL(request.url);

  if (url.pathname.endsWith('.ogg')) {
    event.respondWith(soundFirst(request));
  } else {
    event.respondWith(appFirst(request));
  }
});

async function soundFirst(request) {
  const cache  = await caches.open(SOUND_CACHE);
  const cached = await cache.match(request);
  if (cached) return cached;

  const response = await fetch(request);
  // Cache a clone; return original stream to the page
  cache.put(request, response.clone());
  return response;
}

async function appFirst(request) {
  const cached = await caches.match(request);
  if (cached) return cached;
  return fetch(request);
}
