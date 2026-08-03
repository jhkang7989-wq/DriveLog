const CACHE_NAME = 'drive-log-v1';
const ASSETS = [
  './index.html',
  './manifest.json',
  'https://unpkg.com/lucide@latest'
];

// 설치 시 에셋 캐싱
self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then(cache => {
        console.log('Opened cache');
        return cache.addAll(ASSETS);
      })
  );
});

// 오프라인 작동을 위한 캐시 우선 반환 (Network fallback)
self.addEventListener('fetch', event => {
  // API 요청(네이버 지도 등)은 캐싱하지 않고 네트워크 우선 (오프라인일 경우 HTML 내에서 좌표 저장 로직으로 처리됨)
  if (event.request.url.includes('naveropenapi')) {
    event.respondWith(fetch(event.request));
    return;
  }

  // 앱 리소스는 Cache First 전략
  event.respondWith(
    caches.match(event.request)
      .then(response => {
        // 캐시에 있으면 반환, 없으면 네트워크 요청
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
    })
  );
});