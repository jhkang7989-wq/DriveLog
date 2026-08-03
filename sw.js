const CACHE_NAME = 'drive-log-v1';
const ASSETS = [
  './index.html',
  './manifest.json',
  './app_icon.png',
  'https://unpkg.com/lucide@latest'
];

// 설치 시 에셋 캐싱 (개별 처리 — 하나 실패해도 install 전체는 성공)
self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then(cache => {
        return Promise.all(
          ASSETS.map(url =>
            cache.add(url).catch(err => {
              console.warn(`[SW] 캐싱 실패 (무시하고 진행): ${url}`, err);
            })
          )
        );
      })
      .then(() => self.skipWaiting()) // 새 SW를 바로 활성화 (사용자가 탭을 다 안 닫아도 됨)
  );
});

// 오프라인 작동을 위한 캐시 우선 반환 (Network fallback)
self.addEventListener('fetch', event => {
  // API 요청(네이버 지도 프록시 등)은 캐싱하지 않고 네트워크 우선
  if (event.request.url.includes('naveropenapi') || event.request.url.includes('drivelog-proxy')) {
    event.respondWith(fetch(event.request));
    return;
  }

  // 앱 리소스는 Cache First 전략
  event.respondWith(
    caches.match(event.request)
      .then(response => {
        return response || fetch(event.request);
      })
  );
});

// 구버전 캐시 삭제
self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys().then(cacheNames => {
      return Promise.all(
        cacheNames.map(cacheName => {
          if (cacheName !== CACHE_NAME) {
            return caches.delete(cacheName);
          }
        })
      );
    }).then(() => self.clients.claim()) // 열려있는 탭들도 바로 새 SW가 제어하도록
  );
});
