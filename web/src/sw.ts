/// <reference lib="webworker" />
/**
 * Service worker Retinova.
 * - Kerangka aplikasi (HTML, JS, CSS, font, ONNX Runtime) disimpan saat dipasang, jadi aplikasi terbuka tanpa sinyal.
 * - Data dari server (GET /api) memakai jaringan dulu; saat offline dipakai salinan terakhir yang pernah dibuka.
 * - Foto retina disimpan setelah pertama kali dilihat.
 * Model AI tidak lewat sini; diunduh dan disimpan sendiri oleh lib/offline/ai.worker.ts.
 */
import { clientsClaim } from "workbox-core";
import { cleanupOutdatedCaches, createHandlerBoundToURL, precacheAndRoute } from "workbox-precaching";
import { NavigationRoute, registerRoute } from "workbox-routing";
import { CacheFirst, NetworkFirst } from "workbox-strategies";
import { ExpirationPlugin } from "workbox-expiration";
import { CacheableResponsePlugin } from "workbox-cacheable-response";

declare const self: ServiceWorkerGlobalScope;

precacheAndRoute(self.__WB_MANIFEST);
cleanupOutdatedCaches();
// Pemasangan pertama langsung mengendalikan halaman yang terbuka; pembaruan tetap menunggu aplikasi ditutup
clientsClaim();

registerRoute(
  new NavigationRoute(createHandlerBoundToURL("/index.html"), {
    denylist: [/^\/api\//, /^\/images\//, /^\/lab/, /^\/health/, /^\/docs/, /^\/openapi/],
  }),
);

// Status login, berkas model, dan gambar langsung kamera selalu dari server
const NO_CACHE = /^\/api\/(auth|offline|devices|esp32|predict)/;

registerRoute(
  ({ url, request }) => request.method === "GET" && url.origin === self.location.origin && url.pathname.startsWith("/api/") && !NO_CACHE.test(url.pathname),
  new NetworkFirst({
    cacheName: "api",
    networkTimeoutSeconds: 8,
    plugins: [
      new CacheableResponsePlugin({ statuses: [200] }),
      new ExpirationPlugin({ maxEntries: 300, maxAgeSeconds: 30 * 86400 }),
      {
        // Tandai jawaban dari cache agar aplikasi tahu sedang offline (lihat lib/api.ts)
        cachedResponseWillBeUsed: async ({ cachedResponse }) => {
          if (!cachedResponse) return cachedResponse;
          const headers = new Headers(cachedResponse.headers);
          headers.set("x-retinova-cache", "1");
          return new Response(await cachedResponse.blob(), { status: cachedResponse.status, headers });
        },
      },
    ],
  }),
);

registerRoute(
  ({ url }) => url.origin === self.location.origin && url.pathname.startsWith("/images/"),
  new CacheFirst({
    cacheName: "images",
    plugins: [new CacheableResponsePlugin({ statuses: [200] }), new ExpirationPlugin({ maxEntries: 400, maxAgeSeconds: 30 * 86400 })],
  }),
);

self.addEventListener("message", (e) => {
  if (e.data === "SKIP_WAITING") self.skipWaiting();
});
