/* 운행 로직 */
async function toggleDrive() {
  triggerHaptic();
  if (!currentLocation) { await showAlert('GPS 위치를 파악하는 중입니다.'); return; }

  showLoading(true, "위치 정보를 처리하고 있습니다...");
  const loc = await getBestLocation(); // 정확도 좋으면 즉시, 애매하면 짧게 재측정해서 가장 정확한 좌표 사용

  if (!appState.isRunning) {
    const addr = await getAddressesFromCoords(loc.lat, loc.lng);
    appState.currentTrip = { id: Date.now(), startTime: new Date().toISOString(), startLat: loc.lat, startLng: loc.lng, startAddrRoad: addr.road, startAddrJibun: addr.jibun };
    appState.isRunning = true;
    saveData();
  } else {
    const endAddr = await getAddressesFromCoords(loc.lat, loc.lng);
    const trip = appState.currentTrip;
    const distResult = await calculateDistance(trip.startLat, trip.startLng, loc.lat, loc.lng);
    let finalDistance = Math.round((distResult.distanceKm * (1 + (appState.settings.offsetPercent / 100))) * 10) / 10;

    if (!appState.records) appState.records = [];
    appState.records.push({ id: trip.id, date: getKSTDateString(), startTime: trip.startTime, endTime: new Date().toISOString(), startAddrRoad: trip.startAddrRoad, startAddrJibun: trip.startAddrJibun, endAddrRoad: endAddr.road, endAddrJibun: endAddr.jibun, distance: finalDistance, note: distResult.estimated ? "⚠️ 거리 추정치(직선거리 기반)" : "" });

    appState.isRunning = false;
    appState.currentTrip = null;
    saveData();

    if (distResult.estimated) {
      document.getElementById('location-text').innerHTML = `<span style="color:#FFB74D;">거리 계산 API 오류 발생</span><br>(직선거리 기반으로 추정 계산되었습니다)`;
    }
  }
  showLoading(false);
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
