// Service worker LÖMO — минимальный, только чтобы приложение можно было
// "Установить на главный экран" (PWA-критерий установки требует хотя бы
// один fetch-обработчик) и чтобы статическая оболочка (стили/скрипты/
// иконки) грузилась чуть быстрее и была доступна офлайн. Данные (посты,
// сообщения, друзья и т.д.) — ВСЕГДА только с сети, ничего из этого не
// кэшируется: сеть в приоритете для всех запросов, кэш — только запасной
// вариант на случай обрыва связи, чтобы не показывать устаревшие
// посты/сообщения как актуальные.
const CACHE_NAME = "lomo-shell-v1";
const SHELL_FILES = [
  "/styles.css",
  "/app.js",
  "/components.js",
  "/icon-192.png",
  "/icon-512.png"
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(SHELL_FILES))
  );
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k)))
    )
  );
  self.clients.claim();
});

self.addEventListener("fetch", (event) => {
  const url = new URL(event.request.url);
  // /api/* и /ws — живые данные, WebSocket вообще не проходит через fetch,
  // но /api/* явно исключаем, чтобы не пытаться закэшировать ответы чата/
  // друзей/постов. Не-GET (POST/PATCH/DELETE) тоже не трогаем.
  if (event.request.method !== "GET" || url.pathname.startsWith("/api/")) {
    return;
  }
  event.respondWith(
    fetch(event.request)
      .then((response) => {
        const copy = response.clone();
        caches.open(CACHE_NAME).then((cache) => cache.put(event.request, copy));
        return response;
      })
      .catch(() => caches.match(event.request))
  );
});
