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
    nativeTrackingRecoveryAttempted = false;
    callNativeBridge('startTracking');
  } else {
    // 도착 확정 전, 그사이 백그라운드에서 자동 감지된 정차가 있으면 먼저 경유지로 반영해서
    // 최종 거리 계산에 빠짐없이 포함되게 함
    await drainPendingNativeWaypoints();

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
    callNativeBridge('stopTracking');

    if (anyEstimated) {
      document.getElementById('location-text').innerHTML = `<span style="color:#FFB74D;">거리 계산 API 오류 발생</span><br>(직선거리 기반으로 추정 계산되었습니다)`;
    }
  }
  showLoading(false);
}

const MAX_WAYPOINTS = 30;

// 실제 경유지 등록 로직 — 화면의 "경유" 버튼(addWaypoint)과 DriveLogPro의 백그라운드 자동 정차
// 감지(drainPendingNativeWaypoints) 양쪽에서 공유해서 쓴다. silent면 최대개수 초과 안내 외의
// 토스트를 안 띄움(자동 감지분은 여러 건을 한꺼번에 조용히 처리하고 마지막에 한 번만 안내하기 위함).
async function addWaypointAtLocation(loc, { silent = false } = {}) {
  if (!appState.isRunning || !appState.currentTrip) return false;

  if (!appState.currentTrip.waypoints) appState.currentTrip.waypoints = [];
  if (appState.currentTrip.waypoints.length >= MAX_WAYPOINTS) {
    if (!silent) showToast(`경유지는 최대 ${MAX_WAYPOINTS}개까지 기록할 수 있어요.`);
    return false;
  }

  const addr = await getAddressesFromCoords(loc.lat, loc.lng);
  const restAreaName = findNearbyRestArea(loc.lat, loc.lng); // 휴게소 자동 라벨링 — 거래처/밭 방문과 구분용

  const trip = appState.currentTrip;
  const prevPoint = trip.waypoints.length > 0 ? trip.waypoints[trip.waypoints.length - 1] : { lat: trip.startLat, lng: trip.startLng };
  const legResult = await calculateDistance(prevPoint.lat, prevPoint.lng, loc.lat, loc.lng);

  trip.waypoints.push({
    id: Date.now(),
    timestamp: new Date().toISOString(),
    lat: loc.lat, lng: loc.lng,
    addrRoad: addr.road, addrJibun: addr.jibun,
    legDistanceKm: legResult.distanceKm,
    legEstimated: legResult.estimated,
    restAreaName: restAreaName || undefined
  });

  saveData();
  updateWaypointButtonLabel();
  if (!silent) showToast('경유지가 저장됐어요.');
  return true;
}

async function addWaypoint() {
  triggerHaptic();
  if (!appState.isRunning || !appState.currentTrip) return;
  if (!currentLocation) { showToast('GPS 위치를 파악하는 중입니다.'); return; }

  const loc = await getBestLocation();
  await addWaypointAtLocation(loc);
}

// DriveLogPro 백그라운드 정차 감지로 쌓인 경유지 후보를 반영. 네이티브는 좌표/시각만 넘기고,
// 주소 변환·거리 계산은 여기서(addWaypointAtLocation) 기존 로직을 그대로 재사용해 처리한다.
// 기존 DriveLog(TWA)/브라우저에는 callNativeBridge가 항상 undefined를 반환하니 완전히 안전.
async function drainPendingNativeWaypoints() {
  if (!appState.isRunning || !appState.currentTrip) return;

  const raw = callNativeBridge('getPendingWaypoints');
  if (!raw) return;

  let points;
  try { points = JSON.parse(raw); } catch (e) { return; }
  if (!Array.isArray(points) || points.length === 0) return;

  let addedCount = 0;
  for (const point of points) {
    const added = await addWaypointAtLocation({ lat: point.lat, lng: point.lng }, { silent: true });
    if (added) addedCount++;
  }
  callNativeBridge('clearPendingWaypoints');

  if (addedCount > 0) showToast(`🚗 자동 감지된 정차 ${addedCount}건이 경유지로 기록됐어요.`);
}

// 제조사 알림 정리("전체 지우기" 등)로 DriveLogPro 네이티브 추적 서비스가 예기치 않게 죽는 경우가
// 있어서(삼성 원UI 등, setOngoing으로도 못 막음 확인됨), 웹이 "운행 중"으로 아는데 네이티브 서비스가
// 실제로는 안 살아있는 상태를 주기적으로 감지해서 조용히 재시작하는 자가복구 로직.
// 재시도가 실패해도 계속 반복 시도/알림 스팸하지 않도록 한 번 시도 후 복구 확인될 때까지 대기.
let nativeTrackingRecoveryAttempted = false;
function recoverNativeTrackingIfNeeded() {
  if (!appState.isRunning || !window.AndroidBridge) return;

  const active = callNativeBridge('isTrackingActive');
  if (active) { nativeTrackingRecoveryAttempted = false; return; }
  if (nativeTrackingRecoveryAttempted) return;

  nativeTrackingRecoveryAttempted = true;
  callNativeBridge('startTracking');
  showToast('⚠️ 추적이 중단되어 자동으로 재시작했습니다.');
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
