lucide.createIcons();

// 길게 누르기 시 나오는 브라우저 기본 메뉴(웹 검색/공유 등) 차단 — 입력 요소는 예외
document.addEventListener('contextmenu', e => {
  if (!['INPUT', 'TEXTAREA'].includes(e.target.tagName)) e.preventDefault();
});

// 핀치줌/더블탭줌 차단 — 뷰포트 메타태그(user-scalable=no)나 CSS(touch-action)가
// TWA(크롬 Custom Tabs) 환경에서는 무시되는 것이 확인되어, 터치 이벤트 자체를 막는
// 더 확실한 방식으로 처리함(PWA/일반 브라우저에서도 동일하게 동작).
document.addEventListener('touchstart', e => {
  if (e.touches.length > 1) e.preventDefault(); // 두 손가락 이상 터치(핀치) 자체를 차단
}, { passive: false });

let lastTouchEnd = 0;
document.addEventListener('touchend', e => {
  const now = Date.now();
  if (now - lastTouchEnd <= 300) e.preventDefault(); // 더블탭 줌 차단
  lastTouchEnd = now;
}, false);

// DriveLogPro(네이티브 웹뷰 앱)에서만 window.AndroidBridge가 존재함 — 기존 DriveLog(TWA)나
// 일반 브라우저에서는 이 함수가 그냥 아무 일도 안 하고 조용히 넘어간다(안전한 기능 감지).
function callNativeBridge(methodName, ...args) {
  if (window.AndroidBridge && typeof window.AndroidBridge[methodName] === 'function') {
    return window.AndroidBridge[methodName](...args);
  }
}

// 앱을 자정 넘어서까지 계속 켜놓고 있으면 "오늘 누적 거리"가 어제 날짜 기준으로 멈춰있는 문제가
// 있었음 — updateMainUI()가 운행 시작/종료 등 데이터가 바뀌는 시점에만 호출되고, 시간이 그냥
// 흘러서 날짜가 바뀌는 것 자체로는 재계산이 안 됐기 때문. 5분마다 KST 기준 날짜가 바뀌었는지
// 확인해서, 바뀌었으면 화면을 다시 계산함 (PWA/TWA/DriveLogPro 전부 해당하는 문제라 조건 없이 적용).
// 자정 넘고 최대 5분 내 갱신되면 충분해서 간격을 넉넉하게 잡음 — 매번 하는 일도 날짜 문자열
// 비교뿐이라 API 호출 같은 무거운 작업은 아니지만, 굳이 자주 돌 필요는 없음.
let lastKnownKSTDate = getKSTDateString();
setInterval(() => {
  const nowKSTDate = getKSTDateString();
  if (nowKSTDate !== lastKnownKSTDate) {
    lastKnownKSTDate = nowKSTDate;
    updateMainUI();
  }
}, 5 * 60 * 1000);

// DriveLogPro에서 백그라운드로 감지된 정차(경유지 후보)를 주기적으로 확인해서 반영.
// 도착 시점에도 한 번 더 확인하지만(app-drive.js), 운행 중에 화면을 보고 있다면 그때그때
// 바로 반영되는 게 자연스러워서 20초 간격으로도 확인한다. 기존 DriveLog(TWA)/브라우저에는
// window.AndroidBridge 자체가 없어서 이 setInterval은 등록만 되고 매번 조용히 아무 일도 안 함.
// 같은 주기로 네이티브 추적 서비스가 예기치 않게 죽어있는지도 확인해서 자동 복구를 시도한다
// (제조사 알림 정리 등으로 서비스가 죽는 문제 대응 — recoverNativeTrackingIfNeeded in app-drive.js).
if (window.AndroidBridge) {
  setInterval(() => {
    drainPendingNativeWaypoints();
    recoverNativeTrackingIfNeeded();
  }, 20000);
  // 앱을 다시 열었을 때(백그라운드→포그라운드) 20초를 기다리지 않고 바로 한 번 더 확인 —
  // 사용자가 "알림이 없어졌네" 하고 앱을 여는 순간 최대한 빨리 복구되도록
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) recoverNativeTrackingIfNeeded();
  });
}

// 서비스워커 등록 (에셋 캐싱 → 오프라인 지원용).
if ('serviceWorker' in navigator) {
  // updateViaCache: 'none' — sw.js 자체가 크롬의 일반 HTTP 캐시에 걸려서 업데이트 확인할 때마다
  // 옛날 파일을 계속 보게 되는 문제가 있었음(배포해도 새 코드가 반영이 안 됨). 이 옵션으로
  // sw.js는 항상 네트워크에서 새로 받아오도록 강제함.
  navigator.serviceWorker.register('./sw.js', { updateViaCache: 'none' }).catch(err => console.warn('SW 등록 실패:', err));
}

// ★ 생성한 Cloudflare 프록시 주소 (반드시 https:// 로 시작해야 합니다)
const PROXY_URL = "https://drivelog-proxy.jhkang7989.workers.dev";

let appState = {
  isRunning: false,
  currentTrip: null,
  records: [],
  settings: { darkMode: true, haptic: true, addressPref: 'jibun', offsetPercent: 3, waypointsEnabled: true }
};

function showAlert(message) {
  return new Promise(resolve => {
    document.getElementById('alert-message').innerText = message;
    const actions = document.getElementById('alert-actions');
    actions.innerHTML = `<button class="modal-btn modal-btn-save" id="alert-ok-btn">확인</button>`;
    document.getElementById('alert-modal').classList.add('active');
    document.getElementById('alert-ok-btn').onclick = () => {
      document.getElementById('alert-modal').classList.remove('active');
      resolve();
    };
  });
}

function showConfirm(message) {
  return new Promise(resolve => {
    document.getElementById('alert-message').innerText = message;
    const actions = document.getElementById('alert-actions');
    actions.innerHTML = `
      <button class="modal-btn modal-btn-cancel" id="confirm-cancel-btn">취소</button>
      <button class="modal-btn modal-btn-save" id="confirm-ok-btn">확인</button>
    `;
    document.getElementById('alert-modal').classList.add('active');
    document.getElementById('confirm-cancel-btn').onclick = () => {
      document.getElementById('alert-modal').classList.remove('active');
      resolve(false);
    };
    document.getElementById('confirm-ok-btn').onclick = () => {
      document.getElementById('alert-modal').classList.remove('active');
      resolve(true);
    };
  });
}

// 저장된 상태를 읽어온다 — localStorage 사본과 네이티브 파일 사본 중 더 최신인 쪽(savedAt 기준).
//
// 안드로이드 웹뷰는 크롬과 달리 프로세스 종료 시 DOM 저장소를 디스크로 내려써주지 않아서,
// localStorage.setItem()이 화면엔 반영됐는데도 디스크에 닿기 전에 프로세스가 죽으면 그 쓰기가
// 통째로 사라진다. 실제로 "NFC로 출발을 찍었는데 잠시 뒤 다시 들어가보면 출발 전 상태로
// 돌아가 있다"는 증상이 여기서 나온다(순수 PWA에서는 크롬이 종료 시 flush 해줘서 안 생겼음).
// DriveLogPro에서는 saveData()가 같은 내용을 네이티브 파일에도 fsync까지 해서 저장해두므로,
// 그런 유실이 일어났으면 여기서 네이티브 사본이 더 최신으로 판별돼 복구된다.
function readSavedState() {
  const parse = (raw) => {
    try { return raw ? JSON.parse(raw) : null; } catch (e) { console.warn('저장된 상태 파싱 실패:', e); return null; }
  };
  const webState = parse(localStorage.getItem('driveRecords_v4'));
  const nativeState = parse(callNativeBridge('loadStateBackup'));

  if (!nativeState) return { state: webState, recovered: false };
  if (!webState) return { state: nativeState, recovered: true };

  const nativeIsNewer = (nativeState.savedAt || 0) > (webState.savedAt || 0);
  return { state: nativeIsNewer ? nativeState : webState, recovered: nativeIsNewer };
}

function loadData() {
  const { state, recovered } = readSavedState();
  if (state) appState = state;
  if (recovered) {
    // 웹 쪽 사본이 뒤처져 있었으므로 다시 맞춰둔다(다음 실행 때 또 비교할 필요 없게)
    localStorage.setItem('driveRecords_v4', JSON.stringify(appState));
    // 실제로 유실이 일어났다는 신호라서 사용자에게도 알려준다 — 이 토스트가 뜬다는 건
    // 위에서 설명한 웹뷰 저장 유실이 실제로 발생했고 백업본으로 복구됐다는 뜻.
    setTimeout(() => showToast('운행 상태가 유실될 뻔해서 백업본으로 복구했어요.', 3000), 900);
  }

  document.getElementById('setting-darkmode').checked = appState.settings.darkMode !== false;
  document.getElementById('setting-haptic').checked = appState.settings.haptic !== false;
  document.getElementById('setting-address').value = appState.settings.addressPref || 'jibun';
  document.getElementById('setting-offset').value = appState.settings.offsetPercent || 3;
  document.getElementById('setting-waypoints').checked = appState.settings.waypointsEnabled !== false;

  toggleDarkMode(true);
  updateMainUI();

  // NFC 단축어 자동 실행 로직 — GPS가 실제로 잡힐 때까지 기다렸다가 실행 (최대 8초)
  // URL의 ?action=toggle은 index.html 맨 위 인라인 스크립트에서 이미 훨씬 이른 시점에
  // 지워졌고, 그때 window.__pendingAction에 담아둔 값을 여기서 꺼내 쓴다 (자세한 이유는
  // 그 스크립트의 주석 참고 — 프로세스가 죽었다 복원될 때 저절로 재실행되는 문제 방지).
  if (window.__pendingAction === 'toggle') {
      window.__pendingAction = null;
      showLoading(true, "NFC 인식됨 - GPS 위치 확인 중...");
      const maxWaitMs = 8000;
      const checkIntervalMs = 300;
      let waited = 0;

      const waitForGps = setInterval(() => {
        if (currentLocation) {
          clearInterval(waitForGps);
          showLoading(false);
          toggleDrive();
        } else {
          waited += checkIntervalMs;
          if (waited >= maxWaitMs) {
            clearInterval(waitForGps);
            showLoading(false);
            showAlert('GPS 신호를 받지 못했습니다.\n하늘이 잘 보이는 곳에서 다시 태그하거나, 앱에서 직접 "출발/도착" 버튼을 눌러주세요.');
          }
        }
      }, checkIntervalMs);
  }
}

function saveData() {
  appState.savedAt = Date.now(); // 웹 사본과 네이티브 사본 중 어느 쪽이 최신인지 판별하는 기준
  const json = JSON.stringify(appState);

  // localStorage.setItem이 예외를 던지면(저장공간 부족 등) 그 아래 네이티브 백업 저장과
  // updateMainUI()가 통째로 건너뛰어지는 문제가 있었음 — 메모리 상태는 이미 바뀌었는데 어느
  // 쪽에도 저장이 안 되고 화면도 안 갱신되는, 이 세션 내내 쫓아다닌 "찍혔는데 사라짐"류 버그가
  // 또 다른 계기(저장공간 부족)로 재발할 수 있는 구멍이었음. try/catch로 감싸서 한쪽이 실패해도
  // 나머지는 마저 시도하게 한다.
  let webSaveOk = true;
  try {
    localStorage.setItem('driveRecords_v4', json);
  } catch (e) {
    webSaveOk = false;
    console.error('localStorage 저장 실패:', e);
  }

  // 웹뷰 localStorage는 프로세스가 갑자기 죽으면 마지막 쓰기가 유실될 수 있어서, 같은 내용을
  // 네이티브 파일에도 즉시(동기적으로 fsync까지) 한 부 더 써둔다 — readSavedState() 주석 참고.
  // PWA/TWA에서는 브릿지가 없어 조용히 무시되고 기존과 동일하게 동작함.
  const nativeSaveOk = callNativeBridge('saveStateBackup', json);

  // 웹 저장이 실패했는데 네이티브 백업마저 없거나(PWA/TWA) 실패했으면, 이 변경은 어디에도
  // 안 남은 것 — 사용자가 알아채야 다시 시도하거나 수동으로라도 대응할 수 있음.
  if (!webSaveOk && nativeSaveOk !== true) {
    showToast('⚠️ 저장에 실패했어요. 방금 내용이 유실될 수 있어요.', 3000);
  }

  updateMainUI();
}

function saveSettings() {
  appState.settings.darkMode = document.getElementById('setting-darkmode').checked;
  appState.settings.haptic = document.getElementById('setting-haptic').checked;
  appState.settings.addressPref = document.getElementById('setting-address').value;
  appState.settings.offsetPercent = parseFloat(document.getElementById('setting-offset').value) || 0;
  appState.settings.waypointsEnabled = document.getElementById('setting-waypoints').checked;
  triggerHaptic();
  saveData();
  renderHistory();
  updateWaypointButtonVisibility();
}

function toggleDarkMode(init = false) {
  if(!init) saveSettings();
  const isDark = appState.settings.darkMode;
  document.body.setAttribute('data-theme', isDark ? 'dark' : 'light');
  const logoImg = document.getElementById('header-logo-img');
  if (logoImg) logoImg.src = isDark ? 'header_logo.png' : 'header_logo_light.png';
}

function triggerHaptic() { if (appState.settings.haptic && navigator.vibrate) navigator.vibrate(50); }

function switchTab(tabId) {
  if (typeof clearSummarySelection === 'function') clearSummarySelection(false); // 다른 탭으로 가면 합치기 선택 모드 해제
  document.querySelectorAll('.tab-content').forEach(el => el.classList.remove('active'));
  document.querySelectorAll('.nav-item').forEach(el => el.classList.remove('active'));
  document.getElementById(`tab-${tabId}`).classList.add('active');
  document.getElementById(`nav-${tabId}`).classList.add('active');
  if(tabId === 'history') renderHistory();
}

function showLoading(show, text="처리중...") {
  document.getElementById('loading-overlay').style.display = show ? 'flex' : 'none';
  document.getElementById('loading-text').innerText = text;
}

// 확인 버튼 없이 잠깐 떴다 사라지는 짧은 안내(경유지 저장 완료, 최대 개수 안내 등) — showAlert와 달리 흐름을 막지 않음
let toastTimer = null;

// 토스트 내용을 DOM으로 직접 구성 — 메시지는 textContent로만 넣어서 주소 등 외부 문자열이
// 섞여도 HTML로 해석되지 않음. icon은 lucide 아이콘 이름(선택).
function fillToast(toast, message, icon) {
  toast.replaceChildren();
  if (icon) {
    const iconEl = document.createElement('span');
    iconEl.className = 'toast-icon';
    const i = document.createElement('i');
    i.setAttribute('data-lucide', icon);
    iconEl.appendChild(i);
    toast.appendChild(iconEl);
  }
  const text = document.createElement('span');
  text.textContent = message;
  toast.appendChild(text);
  if (icon && typeof lucide !== 'undefined') lucide.createIcons();
}

function showToast(message, duration = 1800, icon = null) {
  const toast = document.getElementById('toast');
  if (!toast) return;
  toast.classList.remove('has-action');
  fillToast(toast, message, icon);
  toast.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toast.classList.remove('show'), duration);
}

// "되돌리기" 버튼이 달린 토스트 — 실행 직후에만 잠깐 누를 수 있음(기본 5초)
function showUndoToast(message, onUndo, duration = 5000) {
  const toast = document.getElementById('toast');
  if (!toast) return;
  fillToast(toast, message, null);
  const btn = document.createElement('button');
  btn.className = 'toast-action';
  btn.textContent = '되돌리기';
  btn.onclick = () => {
    clearTimeout(toastTimer);
    toast.classList.remove('show', 'has-action');
    onUndo();
  };
  toast.appendChild(btn);
  toast.classList.add('has-action', 'show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toast.classList.remove('show', 'has-action'), duration);
}

// 한국시간(KST, UTC+9) 기준 날짜 문자열(YYYY-MM-DD) 반환
// — 기기의 시간대 설정과 무관하게 항상 한국시간 기준으로 고정 (toISOString()은 UTC라서 새벽 시간대에 날짜가 하루 밀리는 문제가 있었음)
function getKSTDateString(date = new Date()) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Seoul', year: 'numeric', month: '2-digit', day: '2-digit' }).format(date);
}

// "YYYY-MM-DD" 문자열을 한글 요일 한 글자로 변환 — 정오(12:00) KST로 고정 해석해서
// 기기 시간대에 따라 하루 밀리는 문제(getKSTDateString과 동일한 이유) 방지
function getWeekdayKo(dateString) {
  const days = ['일', '월', '화', '수', '목', '금', '토'];
  return days[new Date(`${dateString}T12:00:00+09:00`).getDay()];
}

// 주말 색 구분 — 토요일 블루, 일요일 로즈(둘 다 톤 다운), 평일은 null(기본 텍스트색 유지)
function getWeekdayColor(dateString) {
  const day = new Date(`${dateString}T12:00:00+09:00`).getDay();
  if (day === 0) return '#D66060';
  if (day === 6) return '#6498CF';
  return null;
}
