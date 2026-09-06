/* GPS 제어 */
let currentLocation = null;
let lastAddressFetchLoc = null;
let lastAddressFetchTime = 0;
navigator.geolocation.watchPosition(
  (pos) => {
    currentLocation = { lat: pos.coords.latitude, lng: pos.coords.longitude, accuracy: pos.coords.accuracy, timestamp: pos.timestamp };
    const acc = pos.coords.accuracy;
    const dot = document.getElementById('gps-dot');
    const txt = document.getElementById('gps-text');
    dot.className = 'gps-dot ' + (acc < 30 ? 'green' : acc < 100 ? 'yellow' : 'red');
    txt.innerText = acc < 30 ? 'GPS 매우좋음' : acc < 100 ? 'GPS 양호' : 'GPS 약함';

    if(!appState.isRunning) {
      const isInitial = document.getElementById('location-text').innerText.includes('파악');
      // 최초 1회 표시 후에도, 50m 이상 이동했고 마지막 조회로부터 5초 이상 지났으면 주소를 다시 갱신
      const movedFar = lastAddressFetchLoc &&
        getDistanceFromLatLonInKm(lastAddressFetchLoc.lat, lastAddressFetchLoc.lng, currentLocation.lat, currentLocation.lng) > 0.05;
      const cooledDown = Date.now() - lastAddressFetchTime > 5000;
      if (isInitial || (movedFar && cooledDown)) {
        lastAddressFetchLoc = { lat: currentLocation.lat, lng: currentLocation.lng };
        lastAddressFetchTime = Date.now();
        fetchAndDisplayAddress(currentLocation.lat, currentLocation.lng);
      }
    }
  },
  (err) => {
    document.getElementById('gps-dot').className = 'gps-dot red';
    const txt = document.getElementById('gps-text');
    if (err.code === 1) { // PERMISSION_DENIED
      txt.innerText = 'GPS 권한 거부됨';
    } else if (err.code === 2) { // POSITION_UNAVAILABLE
      txt.innerText = 'GPS 신호없음';
    } else { // TIMEOUT 등
      txt.innerText = 'GPS 수신불가';
    }
  },
  { enableHighAccuracy: true, maximumAge: 0, timeout: 5000 }
);

// 출발/도착 확정 시 사용할 위치를 반환 — 이미 정확도가 충분히 좋으면 즉시,
// 애매하면 최대 1.8초 동안 몇 번 더 측정해서 그중 가장 정확한 값을 골라 반환.
//
// currentLocation은 watchPosition이 마지막으로 갱신해둔 값인데, 앱이 백그라운드로 밀려나 있는
// 동안엔 이 콜백 자체가 안 불릴 수 있어서(WebView가 화면 안 보이면 GPS 워치를 쉬게 함), 오래전
// 위치(예: 아까 정차했던 곳)가 그대로 남아있을 수 있음. 도착 버튼을 눌렀을 때 이 오래된 값을
// "지금 위치"로 착각해서 써버리면 실제로는 딴 데 있는데 엉뚱한 주소로 도착 기록이 남는 문제가
// 생김 — 그래서 정확도만 보지 않고 GeolocationPosition.timestamp로 신선도도 함께 확인한다.
const STALE_LOCATION_MS = 20000;
function getBestLocation(maxWaitMs = 1800, goodAccuracyThreshold = 15) {
  return new Promise((resolve) => {
    const isFresh = (loc) => loc && loc.timestamp != null && (Date.now() - loc.timestamp) <= STALE_LOCATION_MS;

    if (!currentLocation) { resolve(null); return; }
    if (isFresh(currentLocation) && currentLocation.accuracy != null && currentLocation.accuracy <= goodAccuracyThreshold) {
      resolve(currentLocation);
      return;
    }
    // 처음부터 신선한 값이 없다는 건 방금 백그라운드에서 돌아왔을 가능성이 높다는 뜻 — 평소
    // 기준(1.8초)으론 GPS가 다시 잡히기엔 너무 짧아서, 이 경우엔 최대 8초까지 기다려준다.
    const effectiveMaxWaitMs = isFresh(currentLocation) ? maxWaitMs : Math.max(maxWaitMs, 8000);
    let best = isFresh(currentLocation) ? currentLocation : null;
    const start = Date.now();
    const interval = setInterval(() => {
      if (isFresh(currentLocation) && (!best || best.accuracy == null || (currentLocation.accuracy != null && currentLocation.accuracy < best.accuracy))) {
        best = currentLocation;
      }
      if (Date.now() - start >= effectiveMaxWaitMs || (best && best.accuracy != null && best.accuracy <= goodAccuracyThreshold)) {
        clearInterval(interval);
        // maxWaitMs를 다 기다려도 신선한 위치를 못 얻었으면(오래 백그라운드에 있었던 경우), 없는
        // 것보다는 낫다고 보고 오래된 값이라도 마지막 수단으로 사용한다.
        resolve(best || currentLocation);
      }
    }, 300);
  });
}

// 지정 시간 내 응답이 없으면 요청을 중단 — 프록시/네이버 API가 지연될 때 "위치 정보를 파악하고 있습니다" 화면에서 무한정 멈추는 것 방지
function fetchWithTimeout(url, timeoutMs = 8000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  return fetch(url, { signal: controller.signal }).finally(() => clearTimeout(timer));
}

/* API 호출 로직 (Cloudflare 프록시 서버 경유) */
async function getAddressesFromCoords(lat, lng) {
  if (!navigator.onLine) return { road: `오프라인(위도:${lat.toFixed(4)})`, jibun: `오프라인(경도:${lng.toFixed(4)})` };

  try {
    // 진짜 목표 주소를 프록시 서버에 ?target= 형태로 넘김
    const targetUrl = encodeURIComponent(`https://maps.apigw.ntruss.com/map-reversegeocode/v2/gc?coords=${lng},${lat}&orders=addr,roadaddr&output=json`);
    const response = await fetchWithTimeout(`${PROXY_URL}/?target=${targetUrl}`);

    if (!response.ok) {
      console.warn(`주소 변환 API 실패 (status ${response.status})`);
    }

    const data = await response.json();

    let road = "", jibun = "";
    if(data.results && data.results.length > 0) {
      data.results.forEach(res => {
        // area4 = 리(里) — 동 지역은 비어있고, 리 단위 지역(면 소속)에서만 채워짐
        const area4 = (res.region.area4 && res.region.area4.name) ? res.region.area4.name + " " : "";
        const name = res.region.area1.name + " " + res.region.area2.name + " " + res.region.area3.name + " " + area4;
        if(res.name === 'roadaddr') road = name + res.land.name + " " + res.land.number1;
        if(res.name === 'addr') jibun = name + res.land.number1 + (res.land.number2 ? "-"+res.land.number2 : "");
      });
    }
    return { road: road.trim(), jibun: jibun.trim() };
  } catch(e) {
    console.error("주소 변환 프록시 오류:", e);
    return { road: `(API오류) 위도:${lat.toFixed(4)}`, jibun: `(API오류) 경도:${lng.toFixed(4)}` };
  }
}

async function calculateDistance(startLat, startLng, endLat, endLng) {
  const straightDist = getDistanceFromLatLonInKm(startLat, startLng, endLat, endLng);

  // 이동거리가 너무 짧으면(30m 미만) 출발=도착으로 간주하고 API 호출 자체를 생략
  // (Directions API가 출발/도착이 동일하거나 너무 가까우면 400 에러를 반환하는 문제 예방 + API 사용량 절약)
  const MIN_DISTANCE_KM = 0.03;
  if (straightDist < MIN_DISTANCE_KM) {
    return { distanceKm: straightDist, estimated: false };
  }

  if (!navigator.onLine) return { distanceKm: straightDist * 1.3, estimated: true };

  try {
    const targetUrl = encodeURIComponent(`https://maps.apigw.ntruss.com/map-direction/v1/driving?start=${startLng},${startLat}&goal=${endLng},${endLat}`);
    const response = await fetchWithTimeout(`${PROXY_URL}/?target=${targetUrl}`);

    if (!response.ok) {
      console.warn(`거리 계산 API 실패 (status ${response.status}) - 직선거리로 대체`);
      return { distanceKm: straightDist * 1.3, estimated: true };
    }

    const data = await response.json();
    if(data.route && data.route.traoptimal) {
      return { distanceKm: data.route.traoptimal[0].summary.distance / 1000, estimated: false };
    }
    return { distanceKm: straightDist * 1.3, estimated: true };
  } catch(e) {
    console.error("거리 계산 프록시 오류:", e);
    return { distanceKm: straightDist * 1.3, estimated: true };
  }
}

function getDistanceFromLatLonInKm(lat1, lon1, lat2, lon2) {
  const R = 6371; const dLat = (lat2-lat1) * (Math.PI/180); const dLon = (lon2-lon1) * (Math.PI/180);
  const a = Math.sin(dLat/2) * Math.sin(dLat/2) + Math.cos(lat1 * (Math.PI/180)) * Math.cos(lat2 * (Math.PI/180)) * Math.sin(dLon/2) * Math.sin(dLon/2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a)); return R * c;
}

// 경유지가 전국 고속도로 휴게소(REST_AREAS, rest-areas-data.js) 근처인지 확인 — 자동 감지된 정차가
// 거래처/밭 방문인지 그냥 휴게소 정차인지 나중에 내역에서 구분할 수 있게 라벨을 붙여주기 위함.
// 반경 300m 이내면 매칭(휴게소 부지가 넓어서 진입로 쪽에서 찍혀도 잡히도록 여유를 둠).
function findNearbyRestArea(lat, lng, radiusKm = 0.3) {
  if (typeof REST_AREAS === 'undefined') return null;
  for (const area of REST_AREAS) {
    if (getDistanceFromLatLonInKm(lat, lng, area.lat, area.lng) <= radiusKm) {
      return area.name;
    }
  }
  return null;
}

async function fetchAndDisplayAddress(lat, lng) {
  const addr = await getAddressesFromCoords(lat, lng);
  const pref = appState.settings.addressPref;
  const resultAddr = pref === 'road' ? (addr.road || addr.jibun) : (addr.jibun || addr.road);

  if(!resultAddr || resultAddr.includes('API오류')) {
     document.getElementById('location-text').innerHTML = `<span style="color:#F44336;">주소 변환 API 오류 발생</span><br>(좌표로 대체 기록됩니다)`;
  } else {
     document.getElementById('location-text').innerText = resultAddr;
  }
}
