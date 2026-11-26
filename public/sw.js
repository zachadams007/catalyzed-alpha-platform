// KILL-SWITCH service worker (2026-06-25).
//
// Catalyzed Alpha no longer uses a service worker. It pinned users to stale
// builds (a warm iOS standalone PWA never re-navigated, so deploys never showed),
// and offline caching buys nothing for an app that needs the network for live
// quotes/signals anyway. This SW exists ONLY to UNDO any previously-installed one:
// it clears all caches, unregisters itself, and reloads. After it runs once per
// device, there is no service worker - every load is fresh from the network
// (index.html is no-cache; assets are content-hashed + immutable). New visitors
// never register a SW (the registration was removed from main.tsx). Safe to delete
// this file once every known install has cycled through it.
self.addEventListener("install", () => self.skipWaiting());

self.addEventListener("activate", (event) => {
  event.waitUntil(
    (async () => {
      try {
        const keys = await caches.keys();
        await Promise.all(keys.map((k) => caches.delete(k)));
      } catch {
        /* best-effort cache purge */
      }
      try {
        await self.registration.unregister();
      } catch {
        /* already gone */
      }
      // Force every open tab/PWA window to reload onto the SW-free, fresh build.
      const clients = await self.clients.matchAll({ type: "window" });
      for (const client of clients) {
        try {
          client.navigate(client.url);
        } catch {
          /* client may not be navigable */
        }
      }
    })(),
  );
});

// No fetch handler: requests go straight to the network (no caching, no staleness).
