lucide.createIcons();

// 길게 누르기 시 나오는 브라우저 기본 메뉴(웹 검색/공유 등) 차단 — 입력 요소는 예외
document.addEventListener('contextmenu', e => {
  if (!['INPUT', 'TEXTAREA'].includes(e.target.tagName)) e.preventDefault();
});

// 서비스워커 등록 — 운행 중 알림(경유 기록 액션 버튼)을 띄우려면 SW 기반 알림 API가 필요해서 등록.
// 알림의 액션 버튼을 눌렀을 때 sw.js가 postMessage로 알려주면, 앱이 열려있던 창에서 바로 경유지를 기록한다.
if ('serviceWorker' in navigator) {
  // updateViaCache: 'none' — sw.js 자체가 크롬의 일반 HTTP 캐시에 걸려서 업데이트 확인할 때마다
  // 옛날 파일을 계속 보게 되는 문제가 있었음(배포해도 진단 코드가 계속 예전 버전으로 실행됨).
  // 이 옵션으로 sw.js는 항상 네트워크에서 새로 받아오도록 강제함.
  navigator.serviceWorker.register('./sw.js', { updateViaCache: 'none' }).catch(err => console.warn('SW 등록 실패:', err));
  navigator.serviceWorker.addEventListener('message', event => {
    if (event.data && event.data.type === 'add-waypoint') addWaypoint();
  });
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

function loadData() {
  const data = localStorage.getItem('driveRecords_v4');
  if (data) appState = JSON.parse(data);

  document.getElementById('setting-darkmode').checked = appState.settings.darkMode !== false;
  document.getElementById('setting-haptic').checked = appState.settings.haptic !== false;
  document.getElementById('setting-address').value = appState.settings.addressPref || 'jibun';
  document.getElementById('setting-offset').value = appState.settings.offsetPercent || 3;
  document.getElementById('setting-waypoints').checked = appState.settings.waypointsEnabled !== false;

  toggleDarkMode(true);
  updateMainUI();

  // NFC 단축어 자동 실행 로직 — GPS가 실제로 잡힐 때까지 기다렸다가 실행 (최대 8초)
  const urlParams = new URLSearchParams(window.location.search);
  const action = urlParams.get('action');
  if (action === 'toggle' || action === 'waypoint') {
      // 재실행/중복실행 방지를 위해 URL의 쿼리 파라미터를 즉시 제거
      const newUrl = window.location.protocol + "//" + window.location.host + window.location.pathname;
      window.history.replaceState({path:newUrl}, '', newUrl);

      const isWaypoint = action === 'waypoint';
      showLoading(true, isWaypoint ? "경유 기록 - GPS 위치 확인 중..." : "NFC 인식됨 - GPS 위치 확인 중...");
      const maxWaitMs = 8000;
      const checkIntervalMs = 300;
      let waited = 0;

      const waitForGps = setInterval(() => {
        if (currentLocation) {
          clearInterval(waitForGps);
          showLoading(false);
          if (isWaypoint) addWaypoint(); else toggleDrive();
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
  localStorage.setItem('driveRecords_v4', JSON.stringify(appState));
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
function showToast(message, duration = 1800) {
  const toast = document.getElementById('toast');
  if (!toast) return;
  toast.innerText = message;
  toast.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toast.classList.remove('show'), duration);
}

// 한국시간(KST, UTC+9) 기준 날짜 문자열(YYYY-MM-DD) 반환
// — 기기의 시간대 설정과 무관하게 항상 한국시간 기준으로 고정 (toISOString()은 UTC라서 새벽 시간대에 날짜가 하루 밀리는 문제가 있었음)
function getKSTDateString(date = new Date()) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Seoul', year: 'numeric', month: '2-digit', day: '2-digit' }).format(date);
}
