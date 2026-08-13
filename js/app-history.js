/* 타임라인 및 엑셀 다운로드 */
let expandedDates = new Set();
let historyViewMode = 'detail';
let hasAutoExpandedHistory = false; // 최초 1회만 최근 날짜를 자동으로 펼침 — 이후 사용자가 직접 접어도 다시 펴지지 않도록

function setHistoryViewMode(mode) {
  triggerHaptic();
  historyViewMode = mode;
  document.getElementById('btn-view-detail').classList.toggle('active', mode === 'detail');
  document.getElementById('btn-view-summary').classList.toggle('active', mode === 'summary');
  const csvLabel = document.getElementById('csv-mode-label');
  if (csvLabel) csvLabel.innerText = mode === 'summary' ? '요약' : '상세';
  renderHistory();
}

function toggleDateGroup(date) {
  triggerHaptic();
  if (expandedDates.has(date)) expandedDates.delete(date); else expandedDates.add(date);
  renderHistory();
}

// 시/도 축약 매핑 (신규/구 명칭 둘 다 대응)
const SIDO_ABBR = {
  '서울특별시': '서울', '부산광역시': '부산', '대구광역시': '대구', '인천광역시': '인천',
  '광주광역시': '광주', '대전광역시': '대전', '울산광역시': '울산', '세종특별자치시': '세종',
  '경기도': '경기',
  '강원특별자치도': '강원', '강원도': '강원',
  '충청북도': '충북', '충청남도': '충남',
  '전북특별자치도': '전북', '전라북도': '전북', '전라남도': '전남',
  '경상북도': '경북', '경상남도': '경남',
  '제주특별자치도': '제주', '제주도': '제주'
};

// 주소 문자열에서 지역명(시/군/구)만 추출 — 요약보기 그룹 병합 판단 전용 (표시용 아님)
function extractRegion(addr) {
  if (!addr || addr.includes('API오류') || addr.includes('주소 정보 없음')) return null;
  const parts = addr.trim().split(/\s+/);
  return parts.length >= 2 ? parts[1] : (parts[0] || null);
}

// 상세보기용 — 시/도만 축약하고 나머지(시/군/구~번지)는 전부 그대로 표기
function formatFullAddress(addr) {
  if (!addr || addr.includes('API오류') || addr.includes('주소 정보 없음')) return addr;
  const parts = addr.trim().split(/\s+/);
  if (parts.length > 0) parts[0] = SIDO_ABBR[parts[0]] || parts[0];
  return parts.join(' ');
}

// 일지용 요약보기용 — 시/도(축약) + 시/군/구까지만 (세종은 시/군/구 단계가 없어 '세종'만 표기)
function formatRegionAddress(addr) {
  if (!addr || addr.includes('API오류') || addr.includes('주소 정보 없음')) return addr;
  const parts = addr.trim().split(/\s+/);
  const sido = SIDO_ABBR[parts[0]] || parts[0];
  if (sido === '세종') return '세종';
  return parts.length >= 2 ? `${sido} ${parts[1]}` : sido;
}

// 도착지 지역이 바뀔 때까지 연속된 구간을 하나로 합산 (일지용 요약 보기 전용)
// records는 반드시 시간순(오름차순)으로 전달해야 함
function buildSummaryGroups(records) {
  const groups = [];
  records.forEach(r => {
    const sAddr = appState.settings.addressPref === 'road' ? (r.startAddrRoad || r.startAddrJibun) : (r.startAddrJibun || r.startAddrRoad);
    const eAddr = appState.settings.addressPref === 'road' ? (r.endAddrRoad || r.endAddrJibun) : (r.endAddrJibun || r.endAddrRoad);
    const destRegionKey = extractRegion(eAddr); // 병합 판단 전용 키

    const last = groups[groups.length - 1];
    if (last && destRegionKey && last._destRegionKey === destRegionKey) {
      last.distance += r.distance;
      last.destAddrRaw = eAddr || last.destAddrRaw; // 표시용 원본 주소는 최신 도착지로 갱신
    } else {
      groups.push({
        startAddr: sAddr || '(주소 정보 없음)',
        destAddrRaw: eAddr || '(주소 정보 없음)',
        _destRegionKey: destRegionKey,
        distance: r.distance
      });
    }
  });
  return groups;
}

function renderHistory() {
  currentlyOpenSwipeCard = null; // 새로 렌더링되므로 기존 카드 참조 초기화
  const list = document.getElementById('history-list');
  list.innerHTML = '';
  if(!appState.records || appState.records.length === 0) { list.innerHTML = '<div style="text-align:center; color:var(--text-muted); margin-top:50px;">운행 기록이 없습니다.</div>'; return; }

  const grouped = appState.records.reduce((acc, obj) => { if (!acc[obj.date]) acc[obj.date] = []; acc[obj.date].push(obj); return acc; }, {});
  const sortedDates = Object.keys(grouped).sort((a, b) => new Date(b) - new Date(a));

  // 최초 렌더링 시에만 가장 최근 날짜를 기본으로 펼쳐둠 (그 이후엔 사용자가 접고 펴는 걸 그대로 존중)
  if (!hasAutoExpandedHistory && sortedDates.length > 0) {
    expandedDates.add(sortedDates[0]);
    hasAutoExpandedHistory = true;
  }

  let html = '';
  sortedDates.forEach(date => {
    const chronological = grouped[date]; // 원본 순서 = 시간순(오름차순)
    const dailyTotal = chronological.reduce((sum, r) => sum + r.distance, 0).toFixed(1);
    const isExpanded = expandedDates.has(date);

    html += `<div class="card-date ${isExpanded ? '' : 'collapsed'}" onclick="toggleDateGroup('${date}')">
      <span>${date}</span>
      <span class="card-date-right">
        <span class="card-date-total">${dailyTotal} km</span>
        <i data-lucide="chevron-down" class="date-chevron"></i>
      </span>
    </div>`;

    html += `<div class="date-group-body" style="display:${isExpanded ? 'block' : 'none'};">`;

    if (historyViewMode === 'summary') {
      buildSummaryGroups(chronological).slice().reverse().forEach(g => {
        html += `<div class="summary-card">
          <div class="summary-route">${formatRegionAddress(g.startAddr)} → ${formatRegionAddress(g.destAddrRaw)}</div>
          <span class="summary-distance">${g.distance.toFixed(1)} km</span>
        </div>`;
      });
    } else {
      chronological.slice().reverse().forEach(r => {
        let sAddr = appState.settings.addressPref === 'road' ? (r.startAddrRoad || r.startAddrJibun) : (r.startAddrJibun || r.startAddrRoad);
        let eAddr = appState.settings.addressPref === 'road' ? (r.endAddrRoad || r.endAddrJibun) : (r.endAddrJibun || r.endAddrRoad);

        if(!sAddr || sAddr.includes('API오류')) sAddr = '(주소 정보 없음)';
        if(!eAddr || eAddr.includes('API오류')) eAddr = '(주소 정보 없음)';

        let sTime = new Date(r.startTime).toLocaleTimeString([], {hour: '2-digit', minute:'2-digit', timeZone: 'Asia/Seoul'});
        let eTime = r.endTime ? new Date(r.endTime).toLocaleTimeString([], {hour: '2-digit', minute:'2-digit', timeZone: 'Asia/Seoul'}) : '진행중';

        const hasWaypoints = r.waypoints && r.waypoints.length > 0;

        html += `<div class="swipe-wrapper" data-id="${r.id}">
          <div class="swipe-delete-bg" onclick="deleteRecord(${r.id})"><i data-lucide="trash-2" style="width:18px; height:18px;"></i></div>
          <div class="timeline-card ${hasWaypoints ? 'has-waypoints' : ''}" data-id="${r.id}">
            <div class="card-row-top">
              <span class="card-time">${sTime} ~ ${eTime}</span>
              <span class="card-distance-group">
                ${hasWaypoints ? `<span class="waypoint-badge" onclick="event.stopPropagation(); openWaypointModal(${r.id})">경유 ${r.waypoints.length}</span>` : ''}
                <span class="card-distance">${r.distance.toFixed(1)} km</span>
              </span>
            </div>
            <div class="card-addr-row"><span class="card-addr-label">출발</span>${formatFullAddress(sAddr)}</div>
            <div class="card-addr-row"><span class="card-addr-label">도착</span>${formatFullAddress(eAddr)}</div>
            ${r.note ? (r.note.startsWith('⚠️') ? `<div class="card-note-badge card-note-warning">${r.note}</div>` : `<div class="card-note-badge">비고 : ${r.note}</div>`) : ''}
          </div>
        </div>`;
      });
    }

    html += `</div>`;
  });

  list.innerHTML = html;
  lucide.createIcons();
  attachSwipeHandlers();
}

/* 카드 스와이프(좌측으로 밀어 삭제) 처리 */
const SWIPE_OPEN_PX = 64;
let currentlyOpenSwipeCard = null; // 지금 열려있는(스와이프된) 카드 하나만 추적

function closeOpenSwipeCard() {
  if (currentlyOpenSwipeCard) {
    currentlyOpenSwipeCard.style.transition = 'transform 0.25s ease';
    currentlyOpenSwipeCard.style.transform = 'translateX(0)';
    currentlyOpenSwipeCard = null;
  }
}

function attachSwipeHandlers() {
  document.querySelectorAll('.timeline-card').forEach(card => {
    let startX = 0, startY = 0, currentX = 0, dragging = false, moved = false, axisLocked = null; // axisLocked: null(미판정) | 'x'(가로 스와이프) | 'y'(세로 스크롤)

    const onStart = (x, y) => {
      // 다른 카드가 열려있었다면 이번 카드 조작 시작과 동시에 자동으로 닫기
      if (currentlyOpenSwipeCard && currentlyOpenSwipeCard !== card) {
        closeOpenSwipeCard();
      }
      startX = x; startY = y; dragging = true; moved = false; axisLocked = null; card.style.transition = 'none';
    };
    const onMove = (x, y) => {
      if (!dragging) return;
      const dx = x - startX;
      const dy = y - startY;

      // 방향이 뚜렷해지기 전(대각선 초반 움직임)까진 판단 보류 — 목록을 세로로 스크롤하려던 손가락이
      // 살짝 대각선으로 흔들렸다고 바로 삭제 버튼이 열리는 걸 방지
      if (axisLocked === null) {
        if (Math.abs(dx) < 8 && Math.abs(dy) < 8) return;
        axisLocked = Math.abs(dx) > Math.abs(dy) * 1.3 ? 'x' : 'y';
      }
      if (axisLocked === 'y') return; // 세로 스크롤 의도로 판정 -> 카드는 움직이지 않음

      // 왼쪽으로만 밀리게 제한 (오른쪽으로는 안 열림), 최대 SWIPE_OPEN_PX 만큼만
      let delta = Math.min(0, Math.max(dx, -SWIPE_OPEN_PX));
      if (Math.abs(delta) > 5) moved = true;
      currentX = delta;
      card.style.transform = `translateX(${currentX}px)`;
    };
    const onEnd = () => {
      if (!dragging) return;
      dragging = false;
      card.style.transition = 'transform 0.25s ease';
      // 가로 스와이프로 판정된 상태에서 충분히(65% 이상) 밀렸을 때만 완전히 열어서 고정, 아니면 원위치
      if (axisLocked === 'x' && currentX < -SWIPE_OPEN_PX * 0.65) {
        card.style.transform = `translateX(-${SWIPE_OPEN_PX}px)`;
        currentlyOpenSwipeCard = card;
      } else {
        card.style.transform = 'translateX(0)';
        if (currentlyOpenSwipeCard === card) currentlyOpenSwipeCard = null;
      }
    };

    card.addEventListener('touchstart', e => onStart(e.touches[0].clientX, e.touches[0].clientY), { passive: true });
    card.addEventListener('touchmove', e => onMove(e.touches[0].clientX, e.touches[0].clientY), { passive: true });
    card.addEventListener('touchend', onEnd);

    // 데스크톱 테스트용 마우스 지원
    card.addEventListener('mousedown', e => onStart(e.clientX, e.clientY));
    card.addEventListener('mousemove', e => { if (dragging) onMove(e.clientX, e.clientY); });
    card.addEventListener('mouseup', onEnd);
    card.addEventListener('mouseleave', () => { if (dragging) onEnd(); });

    // 스와이프(드래그)가 아니었을 때만 편집 모달 열기
    card.addEventListener('click', () => {
      if (moved) { moved = false; return; }
      editRecord(parseInt(card.dataset.id));
    });
  });
}

async function deleteRecord(id) {
  const ok = await showConfirm('이 운행 기록을 삭제하시겠습니까?');
  if (!ok) {
    // 취소 시 카드 원위치
    const card = document.querySelector(`.timeline-card[data-id="${id}"]`);
    if (card) card.style.transform = 'translateX(0)';
    if (currentlyOpenSwipeCard === card) currentlyOpenSwipeCard = null;
    return;
  }
  appState.records = appState.records.filter(r => r.id !== id);
  saveData();
  renderHistory();
}

function openAddModal() {
  document.getElementById('add-date').value = getKSTDateString();
  const now = new Date();
  const kstNow = new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Seoul', hour: '2-digit', minute: '2-digit', hour12: false }).format(now);
  document.getElementById('add-start-time').value = kstNow;
  document.getElementById('add-end-time').value = kstNow;
  document.getElementById('add-start-addr').value = '';
  document.getElementById('add-end-addr').value = '';
  document.getElementById('add-distance').value = '';
  document.getElementById('add-note').value = '';
  document.getElementById('add-modal').classList.add('active');
}

function closeAddModal() {
  document.getElementById('add-modal').classList.remove('active');
}

async function saveAddModal() {
  const dateVal = document.getElementById('add-date').value;
  const startTimeVal = document.getElementById('add-start-time').value;
  const endTimeVal = document.getElementById('add-end-time').value;
  const startAddr = document.getElementById('add-start-addr').value.trim();
  const endAddr = document.getElementById('add-end-addr').value.trim();
  const distanceVal = parseFloat(document.getElementById('add-distance').value);

  if (!dateVal || !startTimeVal || !endTimeVal || isNaN(distanceVal)) {
    await showAlert('날짜, 출발/도착 시간, 거리는 필수 입력입니다.');
    return;
  }

  // 입력값을 한국시간(KST, UTC+9) 기준으로 명시적으로 해석 — 기기 시간대 설정과 무관하게 항상 정확하도록
  const startTimeISO = new Date(`${dateVal}T${startTimeVal}:00+09:00`).toISOString();
  const endTimeISO = new Date(`${dateVal}T${endTimeVal}:00+09:00`).toISOString();

  if (!appState.records) appState.records = [];
  appState.records.push({
    id: Date.now(),
    date: dateVal,
    startTime: startTimeISO,
    endTime: endTimeISO,
    startAddrRoad: startAddr, startAddrJibun: startAddr,
    endAddrRoad: endAddr, endAddrJibun: endAddr,
    distance: distanceVal,
    note: document.getElementById('add-note').value.trim() || '✏️ 수동 입력'
  });
  saveData();
  expandedDates.add(dateVal); // 방금 추가한 날짜는 펼쳐서 바로 보이게
  renderHistory();
  updateMainUI();
  closeAddModal();
}

let editingRecordId = null;

function editRecord(id) {
  const r = appState.records.find(x => x.id === id);
  if(!r) return;
  editingRecordId = id;
  document.getElementById('edit-distance').value = r.distance;
  document.getElementById('edit-note').value = r.note || '';
  document.getElementById('edit-modal').classList.add('active');
}

function closeEditModal() {
  document.getElementById('edit-modal').classList.remove('active');
  editingRecordId = null;
}

function saveEditModal() {
  const r = appState.records.find(x => x.id === editingRecordId);
  if(!r) return closeEditModal();

  const newDist = parseFloat(document.getElementById('edit-distance').value);
  if(!isNaN(newDist)) r.distance = newDist;
  r.note = document.getElementById('edit-note').value;

  saveData();
  renderHistory();
  closeEditModal();
}

/* 경유지 상세 모달 */
let waypointModalRecordId = null;

function openWaypointModal(id) {
  triggerHaptic();
  waypointModalRecordId = id;
  renderWaypointModal();
  document.getElementById('waypoint-modal').classList.add('active');
}

function closeWaypointModal() {
  document.getElementById('waypoint-modal').classList.remove('active');
  waypointModalRecordId = null;
}

function renderWaypointModal() {
  const r = appState.records.find(x => x.id === waypointModalRecordId);
  const list = document.getElementById('waypoint-modal-list');
  if (!r || !r.waypoints || r.waypoints.length === 0) { closeWaypointModal(); return; }

  let html = '';
  r.waypoints.forEach((w, idx) => {
    const addr = appState.settings.addressPref === 'road' ? (w.addrRoad || w.addrJibun) : (w.addrJibun || w.addrRoad);
    const time = new Date(w.timestamp).toLocaleTimeString([], {hour: '2-digit', minute:'2-digit', timeZone: 'Asia/Seoul'});
    html += `<div class="waypoint-item">
      <div class="waypoint-item-info">
        <div class="waypoint-item-addr">${formatFullAddress(addr || '(주소 정보 없음)')}</div>
        <div class="waypoint-item-meta">${time} · 이전 구간 ${w.legDistanceKm.toFixed(1)}km</div>
      </div>
      <button class="waypoint-item-delete" onclick="deleteWaypoint(${idx})"><i data-lucide="x"></i></button>
    </div>`;
  });
  list.innerHTML = html;
  lucide.createIcons();
}

// 경유지 1개 삭제 시, 그 경유지 양옆 두 지점을 잇는 구간 1개만 새로 계산해서 이어붙임
// (전체 경로를 통째로 다시 계산하지 않음 — 나머지 구간은 그대로 유지)
async function deleteWaypoint(idx) {
  const r = appState.records.find(x => x.id === waypointModalRecordId);
  if (!r || !r.waypoints) return;

  const ok = await showConfirm('이 경유지를 삭제하시겠습니까?');
  if (!ok) return;

  showLoading(true, "구간 거리를 다시 계산하고 있습니다...");

  const prevPoint = idx > 0 ? r.waypoints[idx - 1] : { lat: r.startLat, lng: r.startLng };
  const nextPoint = idx < r.waypoints.length - 1 ? r.waypoints[idx + 1] : { lat: r.endLat, lng: r.endLng };
  const mergedLeg = await calculateDistance(prevPoint.lat, prevPoint.lng, nextPoint.lat, nextPoint.lng);

  const isLastWaypoint = idx === r.waypoints.length - 1;
  r.waypoints.splice(idx, 1);

  if (isLastWaypoint) {
    // 마지막 경유지를 지운 경우 -> 도착까지 이어지는 마지막 구간을 새로 계산
    r.finalLegKm = mergedLeg.distanceKm;
    r.finalLegEstimated = mergedLeg.estimated;
  } else {
    // 중간 경유지를 지운 경우 -> 삭제된 자리 다음 경유지의 "이전 구간" 거리를 새로 계산한 값으로 교체
    r.waypoints[idx].legDistanceKm = mergedLeg.distanceKm;
    r.waypoints[idx].legEstimated = mergedLeg.estimated;
  }

  const rawTotalKm = r.waypoints.reduce((sum, w) => sum + w.legDistanceKm, 0) + (r.finalLegKm || 0);
  const anyEstimated = r.waypoints.some(w => w.legEstimated) || r.finalLegEstimated;
  r.distance = Math.round((rawTotalKm * (1 + (appState.settings.offsetPercent / 100))) * 10) / 10;
  r.note = anyEstimated ? "⚠️ 거리 추정치(직선거리 기반)" : "";

  saveData();
  renderWaypointModal();
  renderHistory();
  showLoading(false);
}
