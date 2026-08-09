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
  if (ok) { localStorage.removeItem('driveRecords_v4'); window.location.reload(); }
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

async function handleRestoreFile(event) {
  const file = event.target.files[0];
  event.target.value = ''; // 같은 파일을 다시 선택할 수 있도록 초기화
  if (!file) return;

  try {
    const text = await file.text();
    const parsed = JSON.parse(text);

    if (!parsed || typeof parsed !== 'object' || !Array.isArray(parsed.records)) {
      await showAlert('올바른 백업 파일이 아닙니다.');
      return;
    }

    const currentCount = (appState.records || []).length;
    const ok = await showConfirm(`백업 파일을 불러오면 현재 데이터(${currentCount}건)는 사라지고\n백업 데이터(${parsed.records.length}건)로 교체됩니다.\n계속하시겠습니까?`);
    if (!ok) return;

    localStorage.setItem('driveRecords_v4', JSON.stringify(parsed));
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

window.onload = () => { loadData(); renderLastBackupLabel(); };
