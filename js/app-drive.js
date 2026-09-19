/* 운행 로직 */
// NFC 태그 한 번이 출발/도착을 두 번 토글해버리는 문제 방지용 가드.
// 재실행 경로가 전부 "페이지를 통째로 다시 로드"하는 형태라서(같은 태그가 인텐트로 두 번
// 배달되거나, 액티비티가 재생성되면서 저장된 NFC 인텐트가 다시 실행되는 경우 —
// MainActivity 참고) 자바스크립트 변수에 시각을 담아두면 리로드 때마다 초기화돼서 아무 소용이
// 없다. 반드시 localStorage처럼 리로드를 넘어 살아남는 곳에 기록해야 함.
const TOGGLE_DEBOUNCE_MS = 10000;
const LAST_TOGGLE_KEY = 'driveLog_lastToggleAt';
function shouldSkipDuplicateToggle() {
  try {
    const last = parseInt(localStorage.getItem(LAST_TOGGLE_KEY) || '0', 10);
    const now = Date.now();
    if (last && now - last < TOGGLE_DEBOUNCE_MS) return true;
    localStorage.setItem(LAST_TOGGLE_KEY, String(now));
  } catch (e) {
    // localStorage를 못 쓰는 환경이면 가드 없이 그냥 진행 (기능 자체를 막진 않음)
  }
  return false;
}

async function toggleDrive() {
  if (shouldSkipDuplicateToggle()) return;

  triggerHaptic();

  if (!currentLocation) { await showAlert('GPS 위치를 파악하는 중입니다.'); return; }

  showLoading(true, "위치 정보를 처리하고 있습니다...");
  const loc = await getBestLocation(); // 정확도 좋으면 즉시, 애매하면 짧게 재측정해서 가장 정확한 좌표 사용

  if (!appState.isRunning) {
    // ★ 도착 쪽과 동일한 이유로, 주소 조회(최대 8초)를 기다리기 전에 "운행 시작" 자체부터 먼저
    // 확정해서 저장한다 — 이 대기 중에 앱이 백그라운드로 밀리면 출발 자체가 저장 안 된 채 날아가서
    // "출발이 풀린 것"처럼 보이는 문제가 있었음. 주소는 우선 좌표 표시로 채워두고 아래에서 patch.
    const tripId = Date.now();
    appState.currentTrip = {
      id: tripId, startTime: new Date().toISOString(), startLat: loc.lat, startLng: loc.lng,
      startAddrRoad: `(확인중) 위도:${loc.lat.toFixed(4)}`, startAddrJibun: `(확인중) 경도:${loc.lng.toFixed(4)}`,
      waypoints: []
    };
    appState.isRunning = true;
    saveData();
    nativeTrackingRecoveryAttempted = false;
    callNativeBridge('startTracking');
    showLoading(false);

    const addr = await getAddressesFromCoords(loc.lat, loc.lng);
    // 그사이 이미 도착 처리로 트립이 닫혔을 수 있으니, 여전히 같은 트립이 진행 중일 때만 patch
    if (appState.currentTrip && appState.currentTrip.id === tripId) {
      appState.currentTrip.startAddrRoad = addr.road;
      appState.currentTrip.startAddrJibun = addr.jibun;
      saveData();
    }
    return;
  } else {
    const trip = appState.currentTrip;

    // 도착 확정 전, 그사이 백그라운드에서 자동 감지된 정차가 있으면 경유지로 반영 — 단, 여기선
    // 주소조회/거리계산 API를 부르지 않고 좌표만 빠르게 편입시킨다("★ 즉시 확정" 참고, 정밀
    // 주소/거리는 트립을 닫은 뒤 아래에서 마저 채운다). 실시간 경유 버튼/평상시 20초 주기 드레인은
    // 그쪽 나름대로 서두를 이유가 없어서 여전히 addWaypointAtLocation을 그대로 씀.
    const newlyDrained = fastDrainPendingNativeWaypoints(trip);

    const waypoints = trip.waypoints || [];

    // 총거리 = 출발→경유1→경유2→...→도착 순으로 이어지는 구간 거리의 합
    // (경유지가 없으면 lastPoint가 출발지가 되어 기존 방식과 동일하게 동작)
    const lastPoint = waypoints.length > 0 ? waypoints[waypoints.length - 1] : { lat: trip.startLat, lng: trip.startLng };

    // ★ 주소 변환/정밀 거리 계산(둘 다 API 호출, 최대 8초씩)을 기다리기 전에 "운행 종료" 자체부터
    // 먼저 확정해서 저장한다 — 실사용 중 이 두 API 호출이 끝나기 전에 앱이 백그라운드로 밀려나거나
    // 강제 종료되면, isRunning이 true로 남아버려서 도착 처리한 게 통째로 사라지고 "도착이 다시
    // 풀린 것처럼" 보이는 문제가 있었음(그 사이 네이티브 추적도 안 멈춰서, 나중에 도착을 다시 누르면
    // 그동안 더 쌓인 경유/거리까지 한 여행에 합쳐져 거리가 말도 안 되게 커지는 2차 피해로 이어짐).
    // 우선 직선거리 기반 추정치로 즉시 기록을 남기고, 아래에서 정밀 계산이 끝나는 대로 같은 기록을
    // patch한다 — 기존에 API 실패 시 쓰던 "⚠️ 거리 추정치" 표시 방식을 그대로 재사용.
    const straightFinalKm = getDistanceFromLatLonInKm(lastPoint.lat, lastPoint.lng, loc.lat, loc.lng);
    const provisionalRawTotal = waypoints.reduce((sum, w) => sum + w.legDistanceKm, 0) + straightFinalKm * 1.3;
    const provisionalDistance = Math.round((provisionalRawTotal * (1 + (appState.settings.offsetPercent / 100))) * 10) / 10;

    const recordId = trip.id;
    if (!appState.records) appState.records = [];
    appState.records.push({
      id: recordId, date: getKSTDateString(), startTime: trip.startTime, endTime: new Date().toISOString(),
      startLat: trip.startLat, startLng: trip.startLng, endLat: loc.lat, endLng: loc.lng,
      startAddrRoad: trip.startAddrRoad, startAddrJibun: trip.startAddrJibun,
      endAddrRoad: `(확인중) 위도:${loc.lat.toFixed(4)}`, endAddrJibun: `(확인중) 경도:${loc.lng.toFixed(4)}`,
      waypoints: waypoints, finalLegKm: straightFinalKm * 1.3, finalLegEstimated: true,
      distance: provisionalDistance, note: "⚠️ 거리 추정치(직선거리 기반)",
      // 이 트립을 마감한 시점의 오차보정%을 같이 남겨둔다 — 나중에 설정을 바꾼 뒤 경유지를
      // 삭제/수정해서 거리를 재계산할 때(deleteWaypoint), 그때의 설정이 아니라 이 트립이 실제로
      // 마감될 때 쓰인 보정률을 그대로 재사용해야 과거 기록이 조용히 안 바뀜.
      offsetPercentUsed: appState.settings.offsetPercent
    });

    appState.isRunning = false;
    appState.currentTrip = null;
    saveData();
    callNativeBridge('stopTracking');
    showLoading(false);

    // 여기서부터는 이미 "출발" 버튼으로 돌아간 뒤 — 정밀 주소/거리를 뒤늦게 계산해서 같은 기록에 반영.
    // 방금 fastDrainPendingNativeWaypoints로 좌표만 빠르게 편입됐던 경유지들도 여기서 마저 정밀화한다
    // (lat/lng는 안 바뀌니 순서와 무관하게 안전 — waypoints 배열은 이미 저장된 기록과 참조를 공유해서
    // 여기서 값을 채우면 그 기록에도 그대로 반영됨).
    for (const wp of newlyDrained) {
      const idx = waypoints.indexOf(wp);
      const prevPoint = idx > 0 ? waypoints[idx - 1] : { lat: trip.startLat, lng: trip.startLng };
      const [wpAddr, wpLeg] = await Promise.all([
        getAddressesFromCoords(wp.lat, wp.lng),
        calculateDistance(prevPoint.lat, prevPoint.lng, wp.lat, wp.lng)
      ]);
      wp.addrRoad = wpAddr.road;
      wp.addrJibun = wpAddr.jibun;
      wp.legDistanceKm = wpLeg.distanceKm;
      wp.legEstimated = wpLeg.estimated;
    }

    // ★주의: 총거리/note는 위 경유지 정밀화와 아래 도착주소/최종구간 정밀화가 "전부" 끝난 뒤
    // 딱 한 번만 재계산한다 — 일부만 끝난 채로 먼저 확정해버리면 절반은 정밀·절반은 추정인 상태로
    // 총거리가 어중간하게 저장될 수 있음.
    const endAddr = await getAddressesFromCoords(loc.lat, loc.lng);
    const finalLegResult = await calculateDistance(lastPoint.lat, lastPoint.lng, loc.lat, loc.lng);
    const rawTotalKm = waypoints.reduce((sum, w) => sum + w.legDistanceKm, 0) + finalLegResult.distanceKm;
    const anyEstimated = waypoints.some(w => w.legEstimated) || finalLegResult.estimated;
    // 계기판 오차 보정은 구간마다가 아니라 전체 합산 거리에 딱 한 번만 적용 (반올림 오차 누적 방지)
    const finalDistance = Math.round((rawTotalKm * (1 + (appState.settings.offsetPercent / 100))) * 10) / 10;

    const rec = (appState.records || []).find(r => r.id === recordId);
    if (rec) {
      rec.endAddrRoad = endAddr.road;
      rec.endAddrJibun = endAddr.jibun;
      rec.finalLegKm = finalLegResult.distanceKm;
      rec.finalLegEstimated = finalLegResult.estimated;
      rec.distance = finalDistance;
      rec.note = anyEstimated ? "⚠️ 거리 추정치(직선거리 기반)" : "";
      saveData();
    }

    if (anyEstimated) {
      document.getElementById('location-text').innerHTML = `<span style="color:#FFB74D;">거리 계산 API 오류 발생</span><br>(직선거리 기반으로 추정 계산되었습니다)`;
    }
    return;
  }
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

  const trip = appState.currentTrip;
  const lastWaypoint = trip.waypoints.length > 0 ? trip.waypoints[trip.waypoints.length - 1] : null;
  const restAreaName = findNearbyRestArea(loc.lat, loc.lng); // 휴게소 자동 라벨링 — 거래처/밭 방문과 구분용

  // 같은 휴게소 안에서 짧게 이동(주차장→주유소 등)한 것만으로 정차감지가 "출발"로 오판해서 또
  // 정차로 잡히는 경우가 실주행에서 확인됨 — 직전 경유지와 같은 휴게소 라벨이면 중복으로 보고 생략.
  // (API 호출 전에 먼저 걸러서 불필요한 주소변환 호출도 아낀다)
  if (restAreaName && lastWaypoint && lastWaypoint.restAreaName === restAreaName) {
    return false;
  }

  const addr = await getAddressesFromCoords(loc.lat, loc.lng);
  const prevPoint = lastWaypoint || { lat: trip.startLat, lng: trip.startLng };
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

// toggleDrive() 도착 처리 전용 — drainPendingNativeWaypoints와 하는 일은 같지만(네이티브에
// 쌓인 정차 좌표를 경유지로 편입), 주소조회/거리계산 API를 아예 안 부르고 좌표만 즉시 편입시킨다.
// 도착 확정 자체를 최대한 빨리 끝내기 위함(자세한 이유는 toggleDrive의 "★" 주석 참고) — 정밀
// 주소/거리는 트립을 닫은 뒤 toggleDrive에서 마저 채운다. 반환값(새로 추가된 경유지 객체 배열)을
// 그 후속 정밀화 단계가 그대로 사용한다.
function fastDrainPendingNativeWaypoints(trip) {
  const added = [];
  const raw = callNativeBridge('getPendingWaypoints');
  if (!raw) return added;

  let points;
  try { points = JSON.parse(raw); } catch (e) { return added; }
  if (!Array.isArray(points) || points.length === 0) return added;

  if (!trip.waypoints) trip.waypoints = [];

  // 네이티브가 정차를 감지한 시각(point.timestamp)이 있는데도 "지금(드레인 시각)"으로 찍어버리면,
  // 하루 종일 못 비워진 채 쌓여있다가 도착할 때 한꺼번에 편입되는 경우 전부 도착 시각으로 찍혀서
  // 실제 정차 시각을 알 수 없게 됨 — 반드시 point.timestamp를 그대로 써야 함.
  const DUPLICATE_RADIUS_KM = 0.1; // TrackingService가 같은 정차를 두 번 기록해 보낸 경우의 방어선(자세한 배경은 PendingWaypointStore 주석 참고)
  const DUPLICATE_WINDOW_MS = 30 * 60 * 1000; // 이 시간 안에서만 "같은 정차의 재기록"으로 보고 걸러냄 — 몇 시간 뒤 같은 거래처를 진짜로 다시 방문한 경우까지 막지 않기 위함

  for (const point of points) {
    if (trip.waypoints.length >= MAX_WAYPOINTS) break;

    // 서비스가 재시작되면서 같은 정차를 두 번 보내는 경우가 있어서, 네이티브 쪽 방어와 별개로
    // 여기서도 한 번 더 막는다 — 위치만 보면 진짜 재방문까지 막아버리니, 시간도 가까울 때만 중복으로 판단.
    const isDuplicateCoord = trip.waypoints.some(w => {
      const timeGapMs = point.timestamp ? Math.abs(point.timestamp - new Date(w.timestamp).getTime()) : 0;
      return timeGapMs <= DUPLICATE_WINDOW_MS && getDistanceFromLatLonInKm(w.lat, w.lng, point.lat, point.lng) <= DUPLICATE_RADIUS_KM;
    });
    if (isDuplicateCoord) continue;

    const lastWaypoint = trip.waypoints.length > 0 ? trip.waypoints[trip.waypoints.length - 1] : null;
    const restAreaName = findNearbyRestArea(point.lat, point.lng);
    // addWaypointAtLocation과 동일한 휴게소 중복 방지 로직 (자세한 이유는 그쪽 주석 참고)
    if (restAreaName && lastWaypoint && lastWaypoint.restAreaName === restAreaName) continue;

    const prevPoint = lastWaypoint || { lat: trip.startLat, lng: trip.startLng };
    const straightKm = getDistanceFromLatLonInKm(prevPoint.lat, prevPoint.lng, point.lat, point.lng);

    const wp = {
      id: Date.now() + added.length,
      timestamp: point.timestamp ? new Date(point.timestamp).toISOString() : new Date().toISOString(),
      lat: point.lat, lng: point.lng,
      addrRoad: `(확인중) 위도:${point.lat.toFixed(4)}`, addrJibun: `(확인중) 경도:${point.lng.toFixed(4)}`,
      legDistanceKm: straightKm * 1.3,
      legEstimated: true,
      restAreaName: restAreaName || undefined
    };
    trip.waypoints.push(wp);
    added.push(wp);
  }

  callNativeBridge('clearPendingWaypoints');
  return added;
}

// DriveLogPro 백그라운드 정차 감지로 쌓인 경유지 후보를 반영. 네이티브는 좌표/시각만 넘기고,
// 주소 변환·거리 계산은 여기서(addWaypointAtLocation) 기존 로직을 그대로 재사용해 처리한다.
// 기존 DriveLog(TWA)/브라우저에는 callNativeBridge가 항상 undefined를 반환하니 완전히 안전.
// (실시간 경유 버튼/평상시 20초 주기 자동 감지 전용 — 도착 처리 전용은 위 fastDrainPendingNativeWaypoints)
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
