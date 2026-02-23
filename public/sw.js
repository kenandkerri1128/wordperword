self.addEventListener('install', (e) => {
    console.log('[Service Worker] Installed');
});

self.addEventListener('fetch', (e) => {
    // Basic fetch passthrough to satisfy PWA install requirements
    e.respondWith(fetch(e.request).catch(() => {
        return new Response("Offline mode not supported. Please connect to the internet.");
    }));
});