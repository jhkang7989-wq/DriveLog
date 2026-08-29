/* 운행 로직 */
async function toggleDrive() {
  triggerHaptic();
  if (!currentLocation) { await showAlert('GPS 위치를 파악하는 중입니다.'); return; }

  showLoading(true, "위치 정보를 처리하고 있습니다...");
  const loc = await getBestLocation(); // 정확도 좋으면 즉시, 애매하면 짧게 재측정해서 가장 정확한 좌표 사용

  if (!appState.isRunning) {
    const addr = await getAddressesFromCoords(loc.lat, loc.lng);
    appState.currentTrip = { id: Date.now(), startTime: new Date().toISOString(), startLat: loc.lat, startLng: loc.lng, startAddrRoad: addr.road, startAddrJibun: addr.jibun, waypoints: [] };
    appState.isRunning = true;
    saveData();
    showTripNotification();
  } else {
    const endAddr = await getAddressesFromCoords(loc.lat, loc.lng);
    const trip = appState.currentTrip;
    const waypoints = trip.waypoints || [];

    // 총거리 = 출발→경유1→경유2→...→도착 순으로 이어지는 구간 거리의 합
    // (경유지가 없으면 lastPoint가 출발지가 되어 기존 방식과 동일하게 동작)
    const lastPoint = waypoints.length > 0 ? waypoints[waypoints.length - 1] : { lat: trip.startLat, lng: trip.startLng };
    const finalLegResult = await calculateDistance(lastPoint.lat, lastPoint.lng, loc.lat, loc.lng);

    const rawTotalKm = waypoints.reduce((sum, w) => sum + w.legDistanceKm, 0) + finalLegResult.distanceKm;
    const anyEstimated = waypoints.some(w => w.legEstimated) || finalLegResult.estimated;
    // 계기판 오차 보정은 구간마다가 아니라 전체 합산 거리에 딱 한 번만 적용 (반올림 오차 누적 방지)
    let finalDistance = Math.round((rawTotalKm * (1 + (appState.settings.offsetPercent / 100))) * 10) / 10;

    if (!appState.records) appState.records = [];
    appState.records.push({
      id: trip.id, date: getKSTDateString(), startTime: trip.startTime, endTime: new Date().toISOString(),
      startLat: trip.startLat, startLng: trip.startLng, endLat: loc.lat, endLng: loc.lng,
      startAddrRoad: trip.startAddrRoad, startAddrJibun: trip.startAddrJibun, endAddrRoad: endAddr.road, endAddrJibun: endAddr.jibun,
      waypoints: waypoints, finalLegKm: finalLegResult.distanceKm, finalLegEstimated: finalLegResult.estimated,
      distance: finalDistance, note: anyEstimated ? "⚠️ 거리 추정치(직선거리 기반)" : ""
    });

    appState.isRunning = false;
    appState.currentTrip = null;
    saveData();
    closeTripNotification();

    if (anyEstimated) {
      document.getElementById('location-text').innerHTML = `<span style="color:#FFB74D;">거리 계산 API 오류 발생</span><br>(직선거리 기반으로 추정 계산되었습니다)`;
    }
  }
  showLoading(false);
}

// 운행 중 알림에 "경유 기록" 액션 버튼을 띄움 — 네비 앱 등 다른 화면 보는 중에도
// 알림창만 내려서 바로 경유지를 찍을 수 있게 하기 위함 (TWA의 알림 위임 기능 사용, 별도 네이티브 코드 불필요).
// "경유 버튼 표시" 설정을 꺼둔 경우엔 이 알림도 띄우지 않음 — 화면 버튼과 같은 on/off로 묶어 일관되게 취급.
async function showTripNotification() {
  // TODO(임시 진단용): 원인 확인되면 이 debug 로그/showAlert 블록 지우고 catch의 console.warn만 남길 것
  const debug = [];
  try {
    if (appState.settings.waypointsEnabled === false) { debug.push('경유 설정 꺼짐 → 중단'); return; }
    if (!('serviceWorker' in navigator) || !('Notification' in window)) { debug.push('SW 또는 Notification API 자체가 없음 → 중단'); return; }

    debug.push('진입 전 권한: ' + Notification.permission);
    if (Notification.permission === 'default') await Notification.requestPermission();
    debug.push('요청 후 권한: ' + Notification.permission);
    if (Notification.permission !== 'granted') { debug.push('권한 미허용 → 중단'); return; }

    const reg = await navigator.serviceWorker.ready;
    debug.push('SW ready 통과, scope=' + reg.scope);
    await reg.showNotification('DriveLog 운행 중', {
      body: '경유지를 기록하려면 아래 버튼을 눌러주세요.',
      tag: 'drivelog-trip',
      requireInteraction: true,
      icon: 'app_icon.png',
      actions: [{ action: 'add-waypoint', title: '경유 기록' }]
    });
    debug.push('showNotification 호출 완료 (에러 없음)');
  } catch (e) {
    console.warn('운행 알림 표시 실패:', e);
    debug.push('예외 발생: ' + e.name + ' - ' + e.message);
  } finally {
    await showAlert('[진단]\n' + debug.join('\n'));
  }
}

async function closeTripNotification() {
  if (!('serviceWorker' in navigator)) return;
  try {
    const reg = await navigator.serviceWorker.ready;
    const notifications = await reg.getNotifications({ tag: 'drivelog-trip' });
    notifications.forEach(n => n.close());
  } catch (e) {
    console.warn('운행 알림 닫기 실패:', e);
  }
}

const MAX_WAYPOINTS = 5;

async function addWaypoint() {
  triggerHaptic();
  if (!appState.isRunning || !appState.currentTrip) return;

  if (!appState.currentTrip.waypoints) appState.currentTrip.waypoints = [];
  if (appState.currentTrip.waypoints.length >= MAX_WAYPOINTS) {
    showToast(`경유지는 최대 ${MAX_WAYPOINTS}개까지 기록할 수 있어요.`);
    return;
  }
  if (!currentLocation) { showToast('GPS 위치를 파악하는 중입니다.'); return; }

  const loc = await getBestLocation();
  const addr = await getAddressesFromCoords(loc.lat, loc.lng);

  const trip = appState.currentTrip;
  const prevPoint = trip.waypoints.length > 0 ? trip.waypoints[trip.waypoints.length - 1] : { lat: trip.startLat, lng: trip.startLng };
  const legResult = await calculateDistance(prevPoint.lat, prevPoint.lng, loc.lat, loc.lng);

  trip.waypoints.push({
    id: Date.now(),
    timestamp: new Date().toISOString(),
    lat: loc.lat, lng: loc.lng,
    addrRoad: addr.road, addrJibun: addr.jibun,
    legDistanceKm: legResult.distanceKm,
    legEstimated: legResult.estimated
  });

  saveData();
  updateWaypointButtonLabel();
  showToast('경유지가 저장됐어요.');
}

function updateWaypointButtonVisibility() {
  const wrapper = document.getElementById('waypoint-btn-wrapper');
  if (!wrapper) return;
  wrapper.style.display = (appState.isRunning && appState.settings.waypointsEnabled !== false) ? 'flex' : 'none';
  updateWaypointButtonLabel();
}

// 운행 중 몇 개를 찍었는지 버튼에서 바로 보이도록 — 상세 모달은 완료된 기록에만 있어 운행 중엔 달리 확인할 방법이 없음
function updateWaypointButtonLabel() {
  const btn = document.getElementById('btn-waypoint');
  if (!btn) return;
  const count = (appState.currentTrip && appState.currentTrip.waypoints) ? appState.currentTrip.waypoints.length : 0;
  btn.innerText = count > 0 ? `경유 ${count}` : '경유';
}

function updateMainUI() {
  const btn = document.getElementById('btn-toggle-drive');
  const btnText = document.getElementById('btn-text');
  const btnIcon = document.getElementById('btn-icon');

  if (appState.isRunning) {
    btn.classList.add('is-running'); btnText.innerText = '도착'; btnIcon.setAttribute('data-lucide', 'square'); lucide.createIcons();
  } else {
    btn.classList.remove('is-running'); btnText.innerText = '출발'; btnIcon.setAttribute('data-lucide', 'play'); lucide.createIcons();
  }
  updateWaypointButtonVisibility();

  const today = getKSTDateString();
  const currentMonth = today.substring(0, 7);
  let todayDist = 0, monthDist = 0;

  (appState.records || []).forEach(r => {
    if (r.date === today) todayDist += r.distance;
    if (r.date.startsWith(currentMonth)) monthDist += r.distance;
  });
  document.getElementById('today-distance').innerText = todayDist.toFixed(1);
  document.getElementById('month-distance').innerText = monthDist.toFixed(1);
}
