const CACHE_NAME = 'drive-log-v7'; // 대기화면 주소 자동 갱신 + API 응답 지연 시 타임아웃 처리 추가로 버전 올림
const ASSETS = [
  './index.html',
  './style.css',
  './js/app-core.js',
  './js/app-location.js',
  './js/app-drive.js',
  './js/app-history.js',
  './js/app-data.js',
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
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('fetch', event => {
  const req = event.request;

  // API/프록시 요청은 캐싱 대상 아님 — 항상 네트워크로 직행
  if (req.url.includes('naveropenapi') || req.url.includes('drivelog-proxy')) {
    event.respondWith(fetch(req));
    return;
  }

  // HTML(앱 본체) 요청 → Network First
  // 이유: index.html만 수정하고 sw.js를 안 바꿔서 배포하면, 기존 Cache First 방식은
  // 브라우저가 SW 업데이트 자체를 감지 못해 옛날 버전을 계속 보여주는 문제가 있었음.
  // 네트워크를 우선 시도해서 항상 최신 버전을 받아오고, 오프라인일 때만 캐시로 폴백함.
  const isHtmlRequest = req.mode === 'navigate' || req.url.endsWith('index.html') || req.url.endsWith('/');
  if (isHtmlRequest) {
    event.respondWith(
      fetch(req)
        .then(res => {
          const resClone = res.clone();
          caches.open(CACHE_NAME).then(cache => cache.put(req, resClone));
          return res;
        })
        .catch(() => caches.match(req))
    );
    return;
  }

  // 나머지 정적 리소스(아이콘, 매니페스트, CDN 스크립트 등)는 기존처럼 Cache First
  // (자주 안 바뀌는 자산이라 빠른 로딩 + 오프라인 지원 목적)
  event.respondWith(
    caches.match(req).then(cached => cached || fetch(req))
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
    }).then(() => self.clients.claim())
  );
});
