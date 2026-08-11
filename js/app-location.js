/* GPS 제어 */
let currentLocation = null;
navigator.geolocation.watchPosition(
  (pos) => {
    currentLocation = { lat: pos.coords.latitude, lng: pos.coords.longitude, accuracy: pos.coords.accuracy };
    const acc = pos.coords.accuracy;
    const dot = document.getElementById('gps-dot');
    const txt = document.getElementById('gps-text');
    dot.className = 'gps-dot ' + (acc < 30 ? 'green' : acc < 100 ? 'yellow' : 'red');
    txt.innerText = acc < 30 ? 'GPS 매우좋음' : acc < 100 ? 'GPS 양호' : 'GPS 약함';

    if(!appState.isRunning && document.getElementById('location-text').innerText.includes('파악')) {
      fetchAndDisplayAddress(currentLocation.lat, currentLocation.lng);
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
// 애매하면 최대 1.8초 동안 몇 번 더 측정해서 그중 가장 정확한 값을 골라 반환
function getBestLocation(maxWaitMs = 1800, goodAccuracyThreshold = 15) {
  return new Promise((resolve) => {
    if (!currentLocation) { resolve(null); return; }
    if (currentLocation.accuracy != null && currentLocation.accuracy <= goodAccuracyThreshold) {
      resolve(currentLocation);
      return;
    }
    let best = currentLocation;
    const start = Date.now();
    const interval = setInterval(() => {
      if (currentLocation && (best.accuracy == null || (currentLocation.accuracy != null && currentLocation.accuracy < best.accuracy))) {
        best = currentLocation;
      }
      if (Date.now() - start >= maxWaitMs || (best.accuracy != null && best.accuracy <= goodAccuracyThreshold)) {
        clearInterval(interval);
        resolve(best);
      }
    }, 300);
  });
}

/* API 호출 로직 (Cloudflare 프록시 서버 경유) */
async function getAddressesFromCoords(lat, lng) {
  if (!navigator.onLine) return { road: `오프라인(위도:${lat.toFixed(4)})`, jibun: `오프라인(경도:${lng.toFixed(4)})` };

  try {
    // 진짜 목표 주소를 프록시 서버에 ?target= 형태로 넘김
    const targetUrl = encodeURIComponent(`https://maps.apigw.ntruss.com/map-reversegeocode/v2/gc?coords=${lng},${lat}&orders=addr,roadaddr&output=json`);
    const response = await fetch(`${PROXY_URL}/?target=${targetUrl}`);

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
    const response = await fetch(`${PROXY_URL}/?target=${targetUrl}`);

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
