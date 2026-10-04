/* 타임라인 및 엑셀 다운로드 */
let expandedDates = new Set();
let historyViewMode = 'detail';
let hasAutoExpandedHistory = false; // 최초 1회만 최근 날짜를 자동으로 펼침 — 이후 사용자가 직접 접어도 다시 펴지지 않도록

function setHistoryViewMode(mode) {
  triggerHaptic();
  summarySelection = null; // 보기 방식을 바꾸면 합치기 선택 모드는 해제
  historyViewMode = mode;
  document.getElementById('btn-view-detail').classList.toggle('active', mode === 'detail');
  document.getElementById('btn-view-summary').classList.toggle('active', mode === 'summary');
  const csvLabel = document.getElementById('csv-mode-label');
  if (csvLabel) csvLabel.innerText = mode === 'summary' ? '요약' : '상세';
  renderHistory();
}

function toggleDateGroup(date) {
  triggerHaptic();
  summarySelection = null;
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

// 실제 주소가 아닌 자리표시/오류 문자열인지 — "(확인중) 위도:37.6" 같은 임시 주소를 공백으로
// 잘라 두 번째 조각("위도:37.6")을 지역명으로 오인해서 요약에 엉뚱한 슬롯이 생기던 문제가 있었음.
function isUnknownAddr(addr) {
  return !addr || addr.includes('API오류') || addr.includes('주소 정보 없음') || addr.includes('(확인중)');
}

function escapeHtml(str) {
  return String(str).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// 주소 문자열에서 지역명(시/군/구)만 추출 — 요약보기 그룹 병합 판단 전용 (표시용 아님)
function extractRegion(addr) {
  if (isUnknownAddr(addr)) return null;
  const parts = addr.trim().split(/\s+/);
  return parts.length >= 2 ? parts[1] : (parts[0] || null);
}

// 상세보기용 — 시/도만 축약하고 나머지(시/군/구~번지)는 전부 그대로 표기
function formatFullAddress(addr) {
  if (isUnknownAddr(addr)) return addr;
  const parts = addr.trim().split(/\s+/);
  if (parts.length > 0) parts[0] = SIDO_ABBR[parts[0]] || parts[0];
  return parts.join(' ');
}

// 일지용 요약보기용 — 시/도(축약) + 시/군/구까지만 (세종은 시/군/구 단계가 없어 '세종'만 표기)
function formatRegionAddress(addr) {
  if (isUnknownAddr(addr)) return addr;
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

  // leg마다 붙는 메타(recordId/destWpIds/destIsEnd/mergedStops)는 "슬롯 합치기"가 어느 지점을
  // 건너뛰어야 하는지 찾는 데만 쓰고, 거리·주소 계산 결과에는 영향이 없다.
  const wholeTripLeg = () => [{
    startAddr, destAddr: endAddr, destRegionKey: extractRegion(endAddr), distance: r.distance,
    recordId: r.id, destWpIds: [], destIsEnd: true,
    mergedStops: groupSkippedRuns((r.waypoints || []).filter(w => w.summarySkip)
      .map(w => ({ id: w.id, region: extractRegion(addrOf(w.addrRoad, w.addrJibun)) })), r.id)
  }];

  if (!r.waypoints || r.waypoints.length === 0) return wholeTripLeg(); // 경유지 없는 기록(과거 기록 포함)은 기존과 완전히 동일

  const points = [{ addr: startAddr }];
  r.waypoints.forEach(w => points.push({ addr: addrOf(w.addrRoad, w.addrJibun), rawLeg: w.legDistanceKm, isRestArea: !!w.restAreaName, skip: !!w.summarySkip, wpId: w.id }));
  points.push({ addr: endAddr, rawLeg: r.finalLegKm || 0, isEnd: true });

  // 같은 지역이 연속되면 노드 하나로 합침(구간 경계가 되는 지점만 노드로 남김).
  // 휴게소로 자동 인식된 경유지(isRestArea)와, 사용자가 요약에서 "합치기"로 건너뛰라고 표시한
  // 경유지(skip)는 지역 경계로 취급하지 않음 — 잠깐 들른 지역 때문에 일지용 요약에 불필요한
  // 구간이 생기면 헷갈리기 때문.
  // 노드/last를 전혀 건드리지 않고 거리만 pendingCarry에 담아뒀다가 다음 "진짜" 지점에 그대로
  // 얹어서 넘김 — 그래야 이 거리가 유실되지 않고 항상 어딘가의 실제 구간에 정확히 반영됨.
  const nodes = [];
  let pendingCarry = 0;
  let pendingSkipped = [];
  points.forEach(p => {
    if (p.isRestArea) {
      pendingCarry += (p.rawLeg || 0);
      return;
    }
    if (p.skip) {
      pendingCarry += (p.rawLeg || 0);
      pendingSkipped.push({ id: p.wpId, region: extractRegion(p.addr) });
      return;
    }
    const region = extractRegion(p.addr);
    const last = nodes[nodes.length - 1];
    const legWithCarry = (p.rawLeg || 0) + pendingCarry;
    pendingCarry = 0;
    let node;
    if (last && region && last._region === region) {
      last.rawLegSum += legWithCarry;
      node = last;
    } else {
      node = { addr: p.addr, _region: region, rawLegSum: legWithCarry, wpIds: [], hasEnd: false, mergedStops: [] };
      nodes.push(node);
    }
    if (p.wpId != null) node.wpIds.push(p.wpId);
    if (p.isEnd) node.hasEnd = true;
    if (pendingSkipped.length) {
      node.mergedStops.push(...groupSkippedRuns(pendingSkipped, r.id));
      pendingSkipped = [];
    }
  });
  if (nodes.length <= 1) return wholeTripLeg(); // 지역 추출 실패 등 예외 상황 — 통짜 구간으로 폴백

  const rawTotal = nodes.reduce((sum, n, i) => (i === 0 ? sum : sum + n.rawLegSum), 0);
  if (rawTotal <= 0) return wholeTripLeg(); // 구간별 원본 거리를 못 구한 경우도 통짜 구간으로 폴백
  const scale = r.distance / rawTotal;

  const legs = [];
  for (let i = 1; i < nodes.length; i++) {
    const n = nodes[i];
    legs.push({
      startAddr: nodes[i - 1].addr, destAddr: n.addr, destRegionKey: n._region, distance: n.rawLegSum * scale,
      recordId: r.id,
      // 도착 지점이 기록의 끝(도착지)을 포함하면 그 경계는 경유지 표시가 아니라 "기록 사이 연결"로만 합칠 수 있음
      destWpIds: n.hasEnd ? [] : n.wpIds, destIsEnd: n.hasEnd,
      mergedStops: n.mergedStops
    });
  }
  return legs;
}

// 건너뛰기로 표시된 연속 경유지를 같은 지역끼리 묶어서 "합쳐진 정차" 목록 항목으로 만든다
function groupSkippedRuns(skipped, recordId) {
  const runs = [];
  skipped.forEach(s => {
    const lastRun = runs[runs.length - 1];
    if (lastRun && lastRun.region === s.region) lastRun.wpIds.push(s.id);
    else runs.push({ kind: 'skip', recordId, region: s.region, wpIds: [s.id] });
  });
  return runs;
}

// 도착지 지역이 바뀔 때까지 연속된 구간을 하나로 합산 (일지용 요약 보기 전용)
// records는 반드시 시간순(오름차순)으로 전달해야 함
function buildSummaryGroups(records) {
  const groups = [];
  let prevRecord = null;
  records.forEach(r => {
    let legs = buildRecordLegs(r);

    // 사용자가 "기록 사이"를 합쳐둔 경우(summaryJoinPrevId): 앞 기록의 마지막 구간과 이 기록의
    // 첫 구간을 하나로 이음. 각 기록의 distance는 이미 그 기록 안에서 완결된 값이라 기록을
    // 넘나드는 거리 이월은 필요 없고, 두 구간의 거리를 그냥 더하면 됨. 바로 앞 기록이 그 ID가
    // 아니면(중간 기록이 삭제됐거나 순서가 바뀐 경우) 표시를 무시해서 엉뚱한 곳에 안 붙게 함.
    const prevGroup = groups[groups.length - 1];
    if (r.summaryJoinPrevId != null && prevRecord && prevRecord.id === r.summaryJoinPrevId && prevGroup && legs.length > 0) {
      const first = legs[0];
      prevGroup.mergedStops.push({ kind: 'join', recordId: r.id, region: prevGroup._destRegionKey });
      prevGroup.distance += first.distance;
      prevGroup.destAddrRaw = first.destAddr || prevGroup.destAddrRaw;
      prevGroup._destRegionKey = first.destRegionKey;
      prevGroup.lastLeg = first;
      prevGroup.mergedStops.push(...first.mergedStops);
      legs = legs.slice(1);
    }

    legs.forEach(leg => {
      const last = groups[groups.length - 1];
      if (last && leg.destRegionKey && last._destRegionKey === leg.destRegionKey) {
        last.distance += leg.distance;
        last.destAddrRaw = leg.destAddr || last.destAddrRaw; // 표시용 원본 주소는 최신 도착지로 갱신
        last.lastLeg = leg;
        last.mergedStops.push(...leg.mergedStops);
      } else {
        groups.push({
          startAddr: leg.startAddr,
          destAddrRaw: leg.destAddr,
          _destRegionKey: leg.destRegionKey,
          distance: leg.distance,
          firstLeg: leg,
          lastLeg: leg,
          mergedStops: [...leg.mergedStops]
        });
      }
    });
    prevRecord = r;
  });
  return groups;
}

/* 일지용 요약 "슬롯 합치기" — 요약 카드를 길게 눌러 선택 → 이어지는 옆 카드를 탭하면 합쳐짐.
   원본 기록/상세보기/날짜 총거리는 건드리지 않고, 요약 계산(buildRecordLegs/buildSummaryGroups)에만
   반영된다. 표시는 두 곳에 저장: 한 기록 안이면 경유지의 summarySkip, 기록 사이면 뒤 기록의
   summaryJoinPrevId. 둘 다 appState 안이라 saveData()를 거치며 네이티브 백업/JSON 백업에 자동 포함. */
let summaryGroupsByDate = {};
let summarySelection = null; // { date, idx } — idx는 그 날짜 요약 그룹의 시간순 인덱스
let summaryIgnoreTapUntil = 0;
const SUMMARY_LONG_PRESS_MS = 500;

function clearSummarySelection(rerender) {
  summarySelection = null;
  if (rerender) renderHistory();
}

// lo번째 그룹과 lo+1번째 그룹을 합칠 수 있는지 판단하고, 합칠 때 어떤 표시를 남길지 계획한다
function planSummaryMerge(groups, lo) {
  const a = groups[lo], b = groups[lo + 1];
  if (!a || !b) return { ok: false, reason: 'none' };

  // 앞 슬롯의 도착 지역과 뒤 슬롯의 출발 지역이 이어져야 함(주소 문자열은 기록마다 달라서 지역으로 비교)
  const aDest = a._destRegionKey;
  const bStart = extractRegion(b.startAddr);
  if (aDest && bStart && aDest !== bStart) return { ok: false, reason: 'gap' };

  const lastLeg = a.lastLeg, firstLeg = b.firstLeg;
  let change;
  if (lastLeg.recordId === firstLeg.recordId) {
    if (!lastLeg.destWpIds.length) return { ok: false, reason: 'unmergeable' };
    change = { kind: 'skip', recordId: lastLeg.recordId, wpIds: lastLeg.destWpIds.slice() };
  } else {
    change = { kind: 'join', recordId: firstLeg.recordId, prevId: lastLeg.recordId };
  }
  return { ok: true, change, startAddr: a.startAddr, destAddr: b.destAddrRaw, distance: a.distance + b.distance };
}

function applySummaryChange(change) {
  const r = appState.records.find(x => x.id === change.recordId);
  if (!r) return;
  if (change.kind === 'skip') {
    (r.waypoints || []).forEach(w => { if (change.wpIds.includes(w.id)) w.summarySkip = true; });
  } else {
    r.summaryJoinPrevId = change.prevId;
  }
}

function revertSummaryChange(change) {
  const r = appState.records.find(x => x.id === change.recordId);
  if (!r) return;
  if (change.kind === 'skip') {
    (r.waypoints || []).forEach(w => { if (change.wpIds.includes(w.id)) delete w.summarySkip; });
  } else {
    delete r.summaryJoinPrevId;
  }
}

function onSummaryLongPress(card) {
  summaryIgnoreTapUntil = Date.now() + 700; // 길게 누른 손가락을 뗄 때 따라오는 click이 바로 "탭"으로 처리되지 않게
  summarySelection = { date: card.dataset.date, idx: parseInt(card.dataset.idx, 10) };
  renderHistory();
}

function onSummaryTap(card) {
  if (Date.now() < summaryIgnoreTapUntil || !summarySelection) return;
  const date = card.dataset.date;
  const idx = parseInt(card.dataset.idx, 10);

  if (date === summarySelection.date && idx === summarySelection.idx) { clearSummarySelection(true); return; }
  if (date !== summarySelection.date || Math.abs(idx - summarySelection.idx) !== 1) {
    showToast('이어지는 슬롯끼리만 합칠 수 있어요');
    return;
  }
  confirmSummaryMerge(date, Math.min(idx, summarySelection.idx));
}

async function confirmSummaryMerge(date, lo) {
  const plan = planSummaryMerge(summaryGroupsByDate[date] || [], lo);
  if (!plan.ok) {
    showToast(plan.reason === 'unmergeable' ? '이 지점은 합칠 수 없어요' : '이어지는 슬롯끼리만 합칠 수 있어요');
    return;
  }
  const ok = await showConfirm(`${formatRegionAddress(plan.startAddr)} → ${formatRegionAddress(plan.destAddr)}\n${plan.distance.toFixed(1)} km 로 합칠까요?`);
  if (!ok) return;

  applySummaryChange(plan.change);
  summarySelection = null;
  saveData();
  renderHistory();
  showUndoToast('슬롯을 합쳤어요', () => {
    revertSummaryChange(plan.change);
    saveData();
    renderHistory();
  });
}

// 요약 카드 길게 누르기 — 세로 스크롤과 안 부딪히게 손가락이 10px 넘게 움직이면 취소
function attachSummaryHandlers() {
  document.querySelectorAll('.summary-card').forEach(card => {
    let timer = null, startX = 0, startY = 0, fired = false;
    const cancel = () => { if (timer) { clearTimeout(timer); timer = null; } };
    const start = (x, y) => {
      cancel();
      fired = false;
      startX = x; startY = y;
      timer = setTimeout(() => { timer = null; fired = true; triggerHaptic(); onSummaryLongPress(card); }, SUMMARY_LONG_PRESS_MS);
    };
    const move = (x, y) => {
      if (timer && (Math.abs(x - startX) > 10 || Math.abs(y - startY) > 10)) cancel();
    };

    card.addEventListener('touchstart', e => start(e.touches[0].clientX, e.touches[0].clientY), { passive: true });
    card.addEventListener('touchmove', e => move(e.touches[0].clientX, e.touches[0].clientY), { passive: true });
    card.addEventListener('touchend', cancel);
    card.addEventListener('touchcancel', cancel);

    // 데스크톱 테스트용 마우스 지원
    card.addEventListener('mousedown', e => start(e.clientX, e.clientY));
    card.addEventListener('mousemove', e => move(e.clientX, e.clientY));
    card.addEventListener('mouseup', cancel);
    card.addEventListener('mouseleave', cancel);

    card.addEventListener('click', () => {
      if (fired) { fired = false; return; }
      onSummaryTap(card);
    });
  });
}

// 합쳐진 정차 목록 — 여기서 정차별로 분리할 수 있음
function openMergedModal(date, idx) {
  const g = (summaryGroupsByDate[date] || [])[idx];
  if (!g || !g.mergedStops.length) return;
  triggerHaptic();
  const list = document.getElementById('merged-modal-list');
  list.innerHTML = g.mergedStops.map((s, i) => `<div class="waypoint-item">
      <div class="waypoint-item-info">
        <div class="waypoint-item-addr">${escapeHtml(s.region || '지역 미상')}</div>
        <div class="waypoint-item-meta">${s.kind === 'skip' ? `경유 ${s.wpIds.length}곳` : '기록 사이 연결'}</div>
      </div>
      <button class="waypoint-item-delete merged-split-btn" aria-label="분리" onclick="splitMergedStop('${date}', ${idx}, ${i})"><i data-lucide="unlink"></i></button>
    </div>`).join('');
  lucide.createIcons();
  document.getElementById('merged-modal').classList.add('active');
}

function closeMergedModal() {
  document.getElementById('merged-modal').classList.remove('active');
}

function splitMergedStop(date, idx, i) {
  const g = (summaryGroupsByDate[date] || [])[idx];
  const stop = g && g.mergedStops[i];
  if (!stop) return;
  revertSummaryChange(stop);
  closeMergedModal();
  saveData();
  renderHistory();
  showToast('분리했어요');
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
      const groups = buildSummaryGroups(chronological);
      summaryGroupsByDate[date] = groups;
      const sel = (summarySelection && summarySelection.date === date) ? summarySelection.idx : null;
      if (sel !== null) {
        html += `<div class="summary-hint"><span>합칠 슬롯을 탭하세요</span><button onclick="clearSummarySelection(true)">취소</button></div>`;
      }
      // 화면은 최신순(역순)으로 그리지만 idx는 시간순 인덱스를 그대로 유지해서 합치기 대상 계산에 씀
      groups.map((g, i) => ({ g, i })).reverse().forEach(({ g, i }) => {
        let cls = 'summary-card';
        if (sel !== null) {
          if (i === sel) cls += ' selected';
          else if (Math.abs(i - sel) === 1 && planSummaryMerge(groups, Math.min(i, sel)).ok) cls += ' candidate';
        }
        const mergedIcon = g.mergedStops.length
          ? `<span class="summary-merged-icon" onclick="event.stopPropagation(); openMergedModal('${date}', ${i})"><i data-lucide="link"></i></span>`
          : '';
        html += `<div class="${cls}" data-date="${date}" data-idx="${i}">
          <div class="summary-route">${formatRegionAddress(g.startAddr)} → ${formatRegionAddress(g.destAddrRaw)}</div>
          <span class="summary-right">${mergedIcon}<span class="summary-distance">${g.distance.toFixed(1)} km</span></span>
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
  attachSummaryHandlers();
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
  // 이 트립이 처음 마감될 때 실제로 적용됐던 오차보정%을 써야 함 — 지금의(더 최신) 설정값을
  // 쓰면, 나중에 설정을 바꾼 뒤 옛날 기록의 경유지를 하나 지웠을 뿐인데 그 기록 전체 거리가
  // 당시와 다른 보정률로 조용히 재계산돼버림. offsetPercentUsed가 없는(이 필드가 생기기 전)
  // 과거 기록은 지금 설정값으로 폴백.
  const offsetPercent = r.offsetPercentUsed != null ? r.offsetPercentUsed : appState.settings.offsetPercent;
  r.distance = Math.round((rawTotalKm * (1 + (offsetPercent / 100))) * 10) / 10;
  // 자동경고 슬롯(비어있거나 이미 경고였던 경우)만 갱신 — 사용자가 직접 써둔 비고는 그대로 보존.
  const noteWasAutoWarning = !r.note || r.note.includes('추정치');
  if (noteWasAutoWarning) {
    r.note = anyEstimated ? "⚠️ 거리 추정치(직선거리 기반)" : "";
  }

  saveData();
  renderWaypointModal();
  renderHistory();
  showLoading(false);
}
