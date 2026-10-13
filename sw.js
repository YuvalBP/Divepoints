// Service worker: keeps the installed app fresh and lets it open without reception.
// - App files (page, js, css, data, manifest): network first, so every launch
//   with reception gets the latest deploy (bypasses the 10-min HTTP cache);
//   after a few seconds without an answer, or offline, the last cached copy.
// - Bundled imagery tiles, icons and version-pinned libraries (Leaflet,
//   Firebase SDK, fonts): cache first, they never change at the same URL.
// - Everything else (Firestore, sign-in, live Esri/OSM tiles): untouched.
const APP = "dp-app-v1";
const STATIC = "dp-static-v1";
const SHELL = [
  "./", "css/style.css", "js/app.js", "manifest.webmanifest",
  "data/sites.js", "data/coast.js", "data/bathy.js", "data/places.js",
  "data/ridges.js", "data/firebase-config.js",
  "icons/icon-192.png", "icons/icon.svg",
];
const PINNED = [
  "https://unpkg.com/leaflet@1.9.4/",
  "https://unpkg.com/leaflet.markercluster@1.5.3/",
  "https://www.gstatic.com/firebasejs/10.12.2/",
  "https://fonts.googleapis.com/css2",
  "https://fonts.gstatic.com/",
];
const NETWORK_WAIT_MS = 3500;

self.addEventListener("install", (e) => {
  e.waitUntil(
    caches.open(APP)
      .then((c) => c.addAll(SHELL.map((u) => new Request(u, { cache: "reload" }))))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener("activate", (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== APP && k !== STATIC).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (e) => {
  const req = e.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);
  if (url.origin === location.origin) {
    if (url.pathname.includes("/tiles/") || url.pathname.includes("/icons/")) {
      e.respondWith(cacheFirst(req));
    } else {
      e.respondWith(networkFirst(req));
    }
  } else if (PINNED.some((p) => req.url.startsWith(p))) {
    e.respondWith(cacheFirst(req));
  }
});

function cacheable(res) {
  return res && (res.ok || res.type === "opaque");
}

async function cacheFirst(req) {
  const hit = await caches.match(req);
  if (hit) return hit;
  const res = await fetch(req);
  if (cacheable(res)) {
    const copy = res.clone();
    caches.open(STATIC).then((c) => c.put(req, copy));
  }
  return res;
}

async function networkFirst(req) {
  const cache = await caches.open(APP);
  // The page is cached under "./"; ?v=… and other queries map to the same copy.
  const key = req.mode === "navigate" ? new Request(new URL("./", location).href) : req;
  const fromNetwork = fetch(req, { cache: "no-cache" }).then((res) => {
    if (res.ok) cache.put(key, res.clone());
    return res;
  });
  const cached = await cache.match(key, { ignoreSearch: true });
  if (!cached) return fromNetwork;
  const timeout = new Promise((resolve) => setTimeout(() => resolve(cached), NETWORK_WAIT_MS));
  return Promise.race([fromNetwork.catch(() => cached), timeout]);
}
