function buildCSVBlob(forceMode) {
  const mode = forceMode || historyViewMode;
  const escape = str => `"${String(str || '').replace(/"/g, '""')}"`;

  const grouped = appState.records.reduce((acc, obj) => { if (!acc[obj.date]) acc[obj.date] = []; acc[obj.date].push(obj); return acc; }, {});
  const sortedDates = Object.keys(grouped).sort((a, b) => new Date(a) - new Date(b)); // 오래된 날짜부터

  let csvContent;

  if (mode === 'summary') {
    // 화면의 "일지용 요약" 보기와 동일하게 지역 합산해서 출력
    csvContent = "﻿일자,출발지,도착지,주행거리(km)\n";
    sortedDates.forEach(date => {
      const groups = buildSummaryGroups(grouped[date]);
      let dailySum = 0;
      groups.forEach(g => {
        dailySum += g.distance;
        csvContent += `${date},${escape(formatRegionAddress(g.startAddr))},${escape(formatRegionAddress(g.destAddrRaw))},${g.distance.toFixed(1)}\n`;
      });
      csvContent += `${date} 총합,,,${dailySum.toFixed(1)}\n`;
    });
  } else {
    // 기존 상세보기 형식 그대로
    csvContent = "﻿일자,출발시간,도착시간,출발지,도착지,주행거리(km),비고\n";
    sortedDates.forEach(date => {
      const records = [...grouped[date]].sort((a,b) => new Date(a.startTime) - new Date(b.startTime));
      let dailySum = 0;
      records.forEach(r => {
        dailySum += r.distance;
        let sAddr = appState.settings.addressPref === 'road' ? (r.startAddrRoad || r.startAddrJibun) : (r.startAddrJibun || r.startAddrRoad);
        let eAddr = appState.settings.addressPref === 'road' ? (r.endAddrRoad || r.endAddrJibun) : (r.endAddrJibun || r.endAddrRoad);
        csvContent += `${r.date},${new Date(r.startTime).toLocaleTimeString([], {hour: '2-digit', minute:'2-digit', timeZone: 'Asia/Seoul'})},${r.endTime ? new Date(r.endTime).toLocaleTimeString([], {hour: '2-digit', minute:'2-digit', timeZone: 'Asia/Seoul'}) : ''},${escape(sAddr)},${escape(eAddr)},${r.distance.toFixed(1)},${escape(r.note)}\n`;
      });
      csvContent += `${date} 총합,,,,,${dailySum.toFixed(1)}\n`;
    });
  }

  const modeLabel = mode === 'summary' ? '요약' : '상세';
  const filename = `운행기록_${modeLabel}_${getKSTDateString()}.csv`;
  const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });
  return { blob, filename };
}

async function downloadCSV() {
  if(!appState.records || appState.records.length === 0) { await showAlert('데이터가 없습니다.'); return; }
  triggerHaptic();

  const modeLabel = historyViewMode === 'summary' ? '일지용 요약' : '상세';
  const ok = await showConfirm(`"${modeLabel}" 보기 기준으로 CSV 파일을 다운로드하시겠습니까?`);
  if (!ok) return;

  const { blob, filename } = buildCSVBlob();

  // data URI 대신 Blob 방식 사용 — iOS 홈 화면(standalone) PWA에서 data URI 다운로드가
  // 씹히거나 새 탭에 텍스트로만 열리는 문제가 있어서, 호환성이 더 나은 Blob+ObjectURL로 변경
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

async function shareCSV() {
  if(!appState.records || appState.records.length === 0) { await showAlert('데이터가 없습니다.'); return; }

  triggerHaptic();
  // 공유는 차량일지 등록용이라 항상 "일지용 요약" 형식으로 고정, 확인창 없이 바로 공유창 오픈
  const { blob, filename } = buildCSVBlob('summary');

  try {
    const file = new File([blob], filename, { type: 'text/csv' });
    if (navigator.canShare && navigator.canShare({ files: [file] })) {
      await navigator.share({ files: [file], title: '운행기록 CSV' });
      return;
    }
  } catch (e) {
    if (e.name === 'AbortError') return; // 사용자가 공유 취소
    console.warn('공유 실패:', e);
  }

  // 공유 API 미지원 환경 → 안내 후 다운로드로 대체
  await showAlert('이 환경에서는 공유 기능을 지원하지 않아 다운로드로 대체합니다.\n(카카오톡 등 일부 앱은 CSV 파일 첨부를 지원하지 않을 수 있어요 — 메일 앱을 이용해보세요)');
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function toggleNfcGuide() {
  const body = document.getElementById('nfc-guide-body');
  const toggle = document.getElementById('nfc-guide-toggle');
  const isOpen = body.style.display === 'block';
  body.style.display = isOpen ? 'none' : 'block';
  toggle.classList.toggle('open', !isOpen);
}

async function copyNfcUrl() {
  const text = document.getElementById('nfc-url-text').innerText;
  try {
    await navigator.clipboard.writeText(text);
    await showAlert('주소가 복사됐습니다.');
  } catch(e) {
    console.warn('클립보드 복사 실패:', e);
    await showAlert('복사에 실패했습니다. 직접 길게 눌러서 복사해주세요.');
  }
}

function toggleEnvSettings() {
  const body = document.getElementById('env-settings-body');
  const toggle = document.getElementById('env-settings-toggle');
  const isOpen = body.style.display === 'block';
  body.style.display = isOpen ? 'none' : 'block';
  toggle.classList.toggle('open', !isOpen);
}

function toggleAdvancedSettings() {
  const body = document.getElementById('advanced-settings-body');
  const toggle = document.getElementById('advanced-toggle');
  const isOpen = body.style.display === 'block';
  body.style.display = isOpen ? 'none' : 'block';
  toggle.classList.toggle('open', !isOpen);
}

async function deletePastMonths() {
  if (!appState.records || appState.records.length === 0) { await showAlert('삭제할 데이터가 없습니다.'); return; }
  triggerHaptic();

  const currentMonth = getKSTDateString().slice(0, 7); // 예: "2026-08"
  const toDelete = appState.records.filter(r => r.date.slice(0, 7) !== currentMonth);
  const toKeep = appState.records.filter(r => r.date.slice(0, 7) === currentMonth);

  if (toDelete.length === 0) { await showAlert('이번 달 이전 기록이 없습니다.'); return; }

  const totalKm = toDelete.reduce((sum, r) => sum + r.distance, 0).toFixed(1);
  const ok = await showConfirm(`이번 달 이전 기록 ${toDelete.length}건 (총 ${totalKm}km)이 삭제됩니다.\n백업하지 않았다면 먼저 백업을 권장합니다.\n계속하시겠습니까?`);
  if (!ok) return;

  appState.records = toKeep;
  saveData();
  renderHistory();
  updateMainUI();
}

async function resetData() {
  const ok = await showConfirm('정말로 모든 데이터를 삭제하시겠습니까? (복구 불가능)');
  if (!ok) return;
  localStorage.removeItem('driveRecords_v4');
  // 네이티브 백업본까지 같이 지워야 함 — 안 지우면 다음 실행 때 그게 더 최신으로 판별돼
  // 지운 데이터가 그대로 되살아난다(readSavedState 참고)
  callNativeBridge('clearStateBackup');
  window.location.reload();
}

function recordBackupTime() {
  localStorage.setItem('lastBackupTime', new Date().toISOString());
  renderLastBackupLabel();
}

function renderLastBackupLabel() {
  const el = document.getElementById('last-backup-label');
  if (!el) return;
  const saved = localStorage.getItem('lastBackupTime');
  if (!saved) { el.innerText = '아직 백업한 적 없음'; return; }
  const diffMs = Date.now() - new Date(saved).getTime();
  const diffDays = Math.floor(diffMs / (1000 * 60 * 60 * 24));
  if (diffDays <= 0) el.innerText = '마지막 백업: 오늘';
  else el.innerText = `마지막 백업: ${diffDays}일 전`;
}

async function exportBackup() {
  triggerHaptic();
  const jsonContent = JSON.stringify(appState, null, 2);
  const fixedFilename = '운행기록_백업.json'; // 날짜 안 붙임 — 매번 같은 이름으로 저장되게

  // DriveLogPro(네이티브 웹뷰)는 일반 WebView라 <a download>/showSaveFilePicker 둘 다 안 먹힘
  // (WebView는 다운로드를 기본 지원 안 함) — 네이티브가 직접 다운로드 폴더에 저장하도록 위임
  if (window.AndroidBridge && typeof window.AndroidBridge.saveJsonBackup === 'function') {
    const result = callNativeBridge('saveJsonBackup', jsonContent, fixedFilename);
    if (result === 'OK') { recordBackupTime(); await showAlert('다운로드 폴더에 저장됐습니다.'); }
    else { await showAlert('백업 저장 실패: ' + result); }
    return;
  }

  // 지원되는 브라우저(주로 PC 크롬 계열)는 저장 위치를 직접 골라 진짜 덮어쓰기 가능
  if (window.showSaveFilePicker) {
    try {
      const handle = await window.showSaveFilePicker({
        suggestedName: fixedFilename,
        types: [{ description: 'JSON 백업 파일', accept: { 'application/json': ['.json'] } }]
      });
      const writable = await handle.createWritable();
      await writable.write(jsonContent);
      await writable.close();
      recordBackupTime();
      return;
    } catch (e) {
      if (e.name === 'AbortError') return; // 사용자가 저장 취소
      console.warn('파일 저장 API 실패, 일반 다운로드로 대체:', e);
    }
  }

  // 미지원 환경(대부분 모바일) → 고정 파일명으로 일반 다운로드
  const blob = new Blob([jsonContent], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = fixedFilename;
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  setTimeout(() => URL.revokeObjectURL(url), 1000);
  recordBackupTime();
}

// 데이터 복원 버튼 — DriveLogPro(네이티브 웹뷰)는 표준 <input type="file">이 이 기기에서
// "파일을 읽는 중 오류"로 실패하는 게 확인돼서(선택은 되는데 내용 읽기가 안 됨), 네이티브가
// 파일 선택+읽기를 직접 처리하는 브릿지로 완전히 우회함. 그 외(PWA/TWA)는 기존 방식 그대로.
function triggerRestore() {
  triggerHaptic();
  if (window.AndroidBridge && typeof window.AndroidBridge.pickBackupFile === 'function') {
    callNativeBridge('pickBackupFile');
  } else {
    document.getElementById('restore-file-input').click();
  }
}

async function handleRestoreFile(event) {
  const file = event.target.files[0];
  event.target.value = ''; // 같은 파일을 다시 선택할 수 있도록 초기화
  if (!file) return;

  try {
    const text = await file.text();
    await applyBackupJson(text);
  } catch (e) {
    console.error('백업 복원 오류:', e);
    await showAlert('파일을 읽는 중 오류가 발생했습니다.\n올바른 JSON 백업 파일인지 확인해주세요.');
  }
}

// DriveLogPro 네이티브 브릿지가 파일을 직접 읽어서 여기로 내용을 전달함 (MainActivity.deliverBackupFileToWeb).
// jsonText가 null이면 파일 선택 취소 또는 네이티브 측 읽기 실패.
window.onNativeBackupFilePicked = function(jsonText) {
  if (jsonText === null || jsonText === undefined) return;
  applyBackupJson(jsonText);
};

// handleRestoreFile / onNativeBackupFilePicked 양쪽이 공유하는 실제 복원 로직
async function applyBackupJson(jsonText) {
  try {
    const parsed = JSON.parse(jsonText);

    if (!parsed || typeof parsed !== 'object' || !Array.isArray(parsed.records)) {
      await showAlert('올바른 백업 파일이 아닙니다.');
      return;
    }

    const currentCount = (appState.records || []).length;
    const ok = await showConfirm(`백업 파일을 불러오면 현재 데이터(${currentCount}건)는 사라지고\n백업 데이터(${parsed.records.length}건)로 교체됩니다.\n계속하시겠습니까?`);
    if (!ok) return;

    // 백업 파일 안의 savedAt은 백업을 만들던 시점 값이라 지금 네이티브 백업본보다 옛날이다 —
    // 그대로 두면 다시 열 때 네이티브 쪽이 더 최신으로 판별돼 복원이 없던 일이 된다.
    // 지금 시각으로 도장을 찍고 네이티브 사본도 같이 갱신해서 양쪽을 맞춰둔다.
    parsed.savedAt = Date.now();
    const restoredJson = JSON.stringify(parsed);
    localStorage.setItem('driveRecords_v4', restoredJson);
    callNativeBridge('saveStateBackup', restoredJson);
    window.location.reload();
  } catch (e) {
    console.error('백업 복원 오류:', e);
    await showAlert('파일을 읽는 중 오류가 발생했습니다.\n올바른 JSON 백업 파일인지 확인해주세요.');
  }
}

async function forceRefreshApp() {
  showLoading(true, "앱을 새로고침하는 중...");
  try {
    if ('caches' in window) {
      const keys = await caches.keys();
      await Promise.all(keys.map(k => caches.delete(k)));
    }
    if ('serviceWorker' in navigator) {
      const regs = await navigator.serviceWorker.getRegistrations();
      await Promise.all(regs.map(r => r.unregister()));
    }
  } catch(e) {
    console.error('새로고침 처리 중 오류:', e);
  }
  window.location.reload();
}

/* 진단 로그 화면 — 웹 기록(localStorage)과 DriveLogPro 네이티브 기록을 시각순으로 합쳐서 보여주고 복사할 수 있게 함 */
function getAppVersionText() {
  const native = callNativeBridge('getAppVersion');
  return `웹 v${WEB_BUILD} · 앱 ${native ? native + ' / ' + callNativeBridge('getBridgeVersion') : '(DriveLogPro 아님)'}`;
}

function renderAppVersionLabel() {
  const el = document.getElementById('app-version-label');
  if (el) el.innerText = getAppVersionText();
}

function getMergedDiagLines() {
  let web = [];
  try { web = JSON.parse(localStorage.getItem(DIAG_KEY) || '[]'); } catch (e) { /* 손상된 기록은 무시 */ }
  const nativeText = callNativeBridge('getDiagLog');
  const native = nativeText ? nativeText.split('\n').filter(Boolean) : [];
  // 두 기록 모두 "YYYY-MM-DD HH:mm:ss.SSS"(한국시간)로 시작해서 그 23글자만 비교하면 시간순이 됨.
  // 같은 밀리초에 찍힌 줄은 각 기록 안의 원래 순서를 유지하도록(정렬은 안정 정렬) 시각만 비교한다.
  return web.concat(native).sort((a, b) => {
    const ta = a.slice(0, 23), tb = b.slice(0, 23);
    return ta < tb ? -1 : (ta > tb ? 1 : 0);
  });
}

function openDiagModal() {
  triggerHaptic();
  const lines = getMergedDiagLines();
  document.getElementById('diag-modal-version').innerText = `${getAppVersionText()} · ${lines.length}줄`;
  const pre = document.getElementById('diag-modal-text');
  pre.textContent = lines.length ? lines.join('\n') : '(기록 없음)';
  document.getElementById('diag-modal').classList.add('active');
  pre.scrollTop = pre.scrollHeight; // 최근 기록이 보이게
}

function closeDiagModal() {
  document.getElementById('diag-modal').classList.remove('active');
}

async function copyDiagLog() {
  const text = `${getAppVersionText()}\n${getMergedDiagLines().join('\n')}`;
  try {
    await navigator.clipboard.writeText(text);
  } catch (e) {
    // 클립보드 API가 막힌 환경 대비 — 임시 입력창으로 복사
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.cssText = 'position:fixed; opacity:0;';
    document.body.appendChild(ta);
    ta.select();
    try { document.execCommand('copy'); } catch (e2) { /* 실패하면 아래 안내가 그대로 뜸 */ }
    document.body.removeChild(ta);
  }
  showToast('로그를 복사했어요', 1800, 'clipboard-check');
}

async function clearDiagLogs() {
  const ok = await showConfirm('진단 로그를 모두 지울까요?');
  if (!ok) return;
  localStorage.removeItem(DIAG_KEY);
  callNativeBridge('clearDiagLog');
  openDiagModal();
}

window.onload = () => { loadData(); renderLastBackupLabel(); renderAppVersionLabel(); };
