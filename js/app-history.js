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

// 기록 하나(출발~경유~도착)를 "지역이 바뀌는 지점"마다 여러 구간(leg)으로 쪼갬 — 일지용 요약 보기 전용.
// 하루 출발/도착만 찍고 나머지는 전부 자동 경유로 기록되는 사용 방식이라, 경유지를 거치며 지역이
// 바뀌면 레코드가 여러 개일 때와 동일하게 별도 줄로 나눠서 보여주기 위함. 같은 지역 안에서 찍힌
// 경유지는 별도 줄을 만들지 않고 그 구간 거리에 합쳐진다.
// 구간별 거리는 원본(raw, 보정 전) 구간 거리 비율대로 record.distance(보정 적용된 최종값)를 배분해서
// 계산 — 그래야 쪼갠 구간들의 합이 항상 원래 총거리와 정확히 일치한다.
function buildRecordLegs(r) {
  const addrOf = (road, jibun) => (appState.settings.addressPref === 'road' ? (road || jibun) : (jibun || road)) || '(주소 정보 없음)';
  const startAddr = addrOf(r.startAddrRoad, r.startAddrJibun);
  const endAddr = addrOf(r.endAddrRoad, r.endAddrJibun);
  const wholeTripLeg = [{ startAddr, destAddr: endAddr, destRegionKey: extractRegion(endAddr), distance: r.distance }];

  if (!r.waypoints || r.waypoints.length === 0) return wholeTripLeg; // 경유지 없는 기록(과거 기록 포함)은 기존과 완전히 동일

  const points = [{ addr: startAddr }];
  r.waypoints.forEach(w => points.push({ addr: addrOf(w.addrRoad, w.addrJibun), rawLeg: w.legDistanceKm, isRestArea: !!w.restAreaName }));
  points.push({ addr: endAddr, rawLeg: r.finalLegKm || 0 });

  // 같은 지역이 연속되면 노드 하나로 합침(구간 경계가 되는 지점만 노드로 남김).
  // 휴게소로 자동 인식된 경유지(isRestArea)는 지역 경계로 취급하지 않음 — 출발지에서 잠깐 다른
  // 지역의 휴게소를 들렀다 온 것만으로 일지용 요약에 불필요한 구간이 생기면 헷갈리기 때문.
  // 노드/last를 전혀 건드리지 않고 거리만 pendingCarry에 담아뒀다가 다음 "진짜" 지점에 그대로
  // 얹어서 넘김 — 그래야 이 거리가 유실되지 않고 항상 어딘가의 실제 구간에 정확히 반영됨.
  const nodes = [];
  let pendingCarry = 0;
  points.forEach(p => {
    if (p.isRestArea) {
      pendingCarry += (p.rawLeg || 0);
      return;
    }
    const region = extractRegion(p.addr);
    const last = nodes[nodes.length - 1];
    const legWithCarry = (p.rawLeg || 0) + pendingCarry;
    pendingCarry = 0;
    if (last && region && last._region === region) {
      last.rawLegSum += legWithCarry;
    } else {
      nodes.push({ addr: p.addr, _region: region, rawLegSum: legWithCarry });
    }
  });
  if (nodes.length <= 1) return wholeTripLeg; // 지역 추출 실패 등 예외 상황 — 통짜 구간으로 폴백

  const rawTotal = nodes.reduce((sum, n, i) => (i === 0 ? sum : sum + n.rawLegSum), 0);
  if (rawTotal <= 0) return wholeTripLeg; // 구간별 원본 거리를 못 구한 경우도 통짜 구간으로 폴백
  const scale = r.distance / rawTotal;

  const legs = [];
  for (let i = 1; i < nodes.length; i++) {
    legs.push({ startAddr: nodes[i - 1].addr, destAddr: nodes[i].addr, destRegionKey: nodes[i]._region, distance: nodes[i].rawLegSum * scale });
  }
  return legs;
}

// 도착지 지역이 바뀔 때까지 연속된 구간을 하나로 합산 (일지용 요약 보기 전용)
// records는 반드시 시간순(오름차순)으로 전달해야 함
function buildSummaryGroups(records) {
  const groups = [];
  records.forEach(r => {
    buildRecordLegs(r).forEach(leg => {
      const last = groups[groups.length - 1];
      if (last && leg.destRegionKey && last._destRegionKey === leg.destRegionKey) {
        last.distance += leg.distance;
        last.destAddrRaw = leg.destAddr || last.destAddrRaw; // 표시용 원본 주소는 최신 도착지로 갱신
      } else {
        groups.push({
          startAddr: leg.startAddr,
          destAddrRaw: leg.destAddr,
          _destRegionKey: leg.destRegionKey,
          distance: leg.distance
        });
      }
    });
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

    const weekdayColor = getWeekdayColor(date);
    const weekdaySpan = weekdayColor ? `<span style="color:${weekdayColor};">(${getWeekdayKo(date)})</span>` : `(${getWeekdayKo(date)})`;
    html += `<div class="card-date ${isExpanded ? '' : 'collapsed'}" onclick="toggleDateGroup('${date}')">
      <span>${date} ${weekdaySpan}</span>
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
            ${r.note ? (() => {
              const isWarn = r.note.includes('추정치');
              const cleanNote = r.note.replace(/[✏️⚠️]/gu, '').trim();
              return isWarn
                ? `<div class="card-note-badge card-note-warning">${cleanNote}</div>`
                : `<div class="card-note-badge">비고 : ${cleanNote}</div>`;
            })() : ''}
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
    currentlyOpenSwipeCard.style.transition = 'transform 0.32s cubic-bezier(0.2, 0.9, 0.3, 1)';
    currentlyOpenSwipeCard.style.transform = 'translateX(0)';
    currentlyOpenSwipeCard = null;
  }
}

function attachSwipeHandlers() {
  document.querySelectorAll('.timeline-card').forEach(card => {
    let startX = 0, startY = 0, currentX = 0, initialX = 0;
    let dragging = false, moved = false, axisLocked = null;
    let touchStartTime = 0, lastX = 0, lastTime = 0, velocityX = 0;

    const onStart = (x, y) => {
      // 다른 카드가 열려있었다면 부드럽게 닫기
      if (currentlyOpenSwipeCard && currentlyOpenSwipeCard !== card) {
        closeOpenSwipeCard();
      }

      // 현재 카드의 열림 여부에 따른 초기 위치 기억 (닫혀있으면 0, 열려있으면 -64)
      const isOpen = (currentlyOpenSwipeCard === card);
      initialX = isOpen ? -SWIPE_OPEN_PX : 0;
      currentX = initialX;

      startX = x;
      startY = y;
      lastX = x;
      touchStartTime = Date.now();
      lastTime = touchStartTime;
      velocityX = 0;
      dragging = true;
      moved = false;
      axisLocked = null;
      card.style.transition = 'none'; // 드래그 중에는 손끝 실시간 추종
    };

    const onMove = (x, y) => {
      if (!dragging) return;
      const dx = x - startX;
      const dy = y - startY;

      // 방향 판정: 초기 미세 흔들림(7px 이하) 무시
      if (axisLocked === null) {
        if (Math.abs(dx) < 7 && Math.abs(dy) < 7) return;
        if (Math.abs(dx) > Math.abs(dy) * 1.2) {
          axisLocked = 'x';
        } else {
          axisLocked = 'y';
          return;
        }
      }
      if (axisLocked !== 'x') return; // 세로 스크롤일 때는 카드 이동 없음

      // 순간 속도 추적 (px/ms)
      const now = Date.now();
      const dt = now - lastTime;
      if (dt > 10) {
        velocityX = (x - lastX) / dt;
        lastX = x;
        lastTime = now;
      }

      // 새 위치 = 초기 위치 + 이동 거리
      let targetX = initialX + dx;

      // 한계점 완충 (오른쪽으로 넘기거나 왼쪽 최대치를 넘길 때 텐션)
      if (targetX > 0) {
        targetX = targetX * 0.2;
      } else if (targetX < -SWIPE_OPEN_PX) {
        const over = targetX + SWIPE_OPEN_PX;
        targetX = -SWIPE_OPEN_PX + (over * 0.25);
      }

      if (Math.abs(dx) > 3) moved = true;
      currentX = targetX;
      card.style.transform = `translateX(${currentX}px)`;
    };

    const onEnd = () => {
      if (!dragging) return;
      dragging = false;

      // 실크 스프링 감속 트랜지션 복원
      card.style.transition = 'transform 0.32s cubic-bezier(0.2, 0.9, 0.3, 1)';

      if (axisLocked !== 'x') {
        card.style.transform = `translateX(${initialX}px)`;
        return;
      }

      // 1) 순간 제스처(플릭) 판정: 손가락을 휙 튕겼을 때
      if (velocityX > 0.22) {
        // 오른쪽으로 빠르게 튕김 -> 부드럽게 닫힘
        card.style.transform = 'translateX(0)';
        if (currentlyOpenSwipeCard === card) currentlyOpenSwipeCard = null;
      } else if (velocityX < -0.22) {
        // 왼쪽으로 빠르게 튕김 -> 부드럽게 열림
        card.style.transform = `translateX(-${SWIPE_OPEN_PX}px)`;
        currentlyOpenSwipeCard = card;
      } else {
        // 2) 위치 기준 판정: 45% 이상 열렸는지 여부
        if (currentX < -SWIPE_OPEN_PX * 0.45) {
          card.style.transform = `translateX(-${SWIPE_OPEN_PX}px)`;
          currentlyOpenSwipeCard = card;
        } else {
          card.style.transform = 'translateX(0)';
          if (currentlyOpenSwipeCard === card) currentlyOpenSwipeCard = null;
        }
      }
    };

    card.addEventListener('touchstart', e => onStart(e.touches[0].clientX, e.touches[0].clientY), { passive: true });
    card.addEventListener('touchmove', e => onMove(e.touches[0].clientX, e.touches[0].clientY), { passive: true });
    card.addEventListener('touchend', onEnd);
    card.addEventListener('touchcancel', onEnd);

    // 데스크톱 테스트용 마우스 지원
    card.addEventListener('mousedown', e => onStart(e.clientX, e.clientY));
    card.addEventListener('mousemove', e => { if (dragging) onMove(e.clientX, e.clientY); });
    card.addEventListener('mouseup', onEnd);
    card.addEventListener('mouseleave', () => { if (dragging) onEnd(); });

    // 스와이프(드래그)가 아니었을 때만 편집 모달 열기
    card.addEventListener('click', () => {
      if (moved) { moved = false; return; }
      if (currentlyOpenSwipeCard === card) {
        closeOpenSwipeCard();
        return;
      }
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
    note: document.getElementById('add-note').value.trim() || '수동 입력'
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
    const restBadge = w.restAreaName ? `<span class="waypoint-rest-badge">${w.restAreaName}휴게소</span>` : '';
    html += `<div class="waypoint-item">
      <div class="waypoint-item-info">
        <div class="waypoint-item-addr">${formatFullAddress(addr || '(주소 정보 없음)')} ${restBadge}</div>
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
