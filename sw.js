const CACHE_NAME = 'drive-log-v51'; // 자정 넘으면 오늘 누적거리 자동 갱신
const ASSETS = [
  './index.html',
  './style.css',
  './js/app-core.js',
  './js/rest-areas-data.js',
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
    // 캐시 키는 쿼리스트링(?action=toggle 등) 없이 항상 index.html 기준으로 고정.
    // NFC용 ?action=toggle이 붙은 URL을 그대로 캐시 키로 쓰면, 나중에 오프라인 폴백이나
    // 브라우저의 탐색 기록 복원 시 그 URL이 다시 열리면서 NFC를 안 찍었는데도 출발/도착이
    // 저절로 실행되는 문제가 있었음.
    const cacheKey = new Request(new URL('./index.html', req.url).toString());
    event.respondWith(
      fetch(req)
        .then(res => {
          const resClone = res.clone();
          caches.open(CACHE_NAME).then(cache => cache.put(cacheKey, resClone));
          return res;
        })
        .catch(() => caches.match(cacheKey))
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
