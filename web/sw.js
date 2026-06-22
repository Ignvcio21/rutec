/* Service worker minimo: cachea la cascara de la app para que cargue rapido
   y funcione aunque la red este lenta. Las llamadas a /api siempre van a la red. */
const CACHE = "rutec-v13";
const ASSETS = [
  "./",
  "index.html",
  "styles.css",
  "app.js",
  "manifest.webmanifest",
  "icon-192.png",
  "icon-512.png",
];

self.addEventListener("install", (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(ASSETS)).then(() => self.skipWaiting()));
});

self.addEventListener("activate", (e) => {
  e.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))
    ).then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (e) => {
  // Solo interceptar GET; las subidas (POST /api/ocr) van directo a la red.
  if (e.request.method !== "GET") return;
  const url = new URL(e.request.url);
  // No tocar otros dominios (mapas, Leaflet, etc.) ni la API.
  if (url.origin !== location.origin) return;
  if (url.pathname.startsWith("/api/")) return;
  // RED PRIMERO: siempre intenta traer lo último; si no hay internet, usa la copia.
  e.respondWith(
    fetch(e.request)
      .then((resp) => {
        const copy = resp.clone();
        caches.open(CACHE).then((c) => c.put(e.request, copy)).catch(() => {});
        return resp;
      })
      .catch(() => caches.match(e.request))
  );
});
