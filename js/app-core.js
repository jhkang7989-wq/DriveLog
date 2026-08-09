lucide.createIcons();

// 길게 누르기 시 나오는 브라우저 기본 메뉴(웹 검색/공유 등) 차단 — 입력 요소는 예외
document.addEventListener('contextmenu', e => {
  if (!['INPUT', 'TEXTAREA'].includes(e.target.tagName)) e.preventDefault();
});

// ★ 생성한 Cloudflare 프록시 주소 (반드시 https:// 로 시작해야 합니다)
const PROXY_URL = "https://drivelog-proxy.jhkang7989.workers.dev";

let appState = {
  isRunning: false,
  currentTrip: null,
  records: [],
  settings: { darkMode: true, haptic: true, addressPref: 'jibun', offsetPercent: 3 }
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

  toggleDarkMode(true);
  updateMainUI();

  // NFC 단축어 자동 실행 로직 — GPS가 실제로 잡힐 때까지 기다렸다가 실행 (최대 8초)
  const urlParams = new URLSearchParams(window.location.search);
  if (urlParams.get('action') === 'toggle') {
      // 재실행/중복실행 방지를 위해 URL의 쿼리 파라미터를 즉시 제거
      const newUrl = window.location.protocol + "//" + window.location.host + window.location.pathname;
      window.history.replaceState({path:newUrl}, '', newUrl);

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
  localStorage.setItem('driveRecords_v4', JSON.stringify(appState));
  updateMainUI();
}

function saveSettings() {
  appState.settings.darkMode = document.getElementById('setting-darkmode').checked;
  appState.settings.haptic = document.getElementById('setting-haptic').checked;
  appState.settings.addressPref = document.getElementById('setting-address').value;
  appState.settings.offsetPercent = parseFloat(document.getElementById('setting-offset').value) || 0;
  triggerHaptic();
  saveData();
  renderHistory();
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
  triggerHaptic();
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

// 한국시간(KST, UTC+9) 기준 날짜 문자열(YYYY-MM-DD) 반환
// — 기기의 시간대 설정과 무관하게 항상 한국시간 기준으로 고정 (toISOString()은 UTC라서 새벽 시간대에 날짜가 하루 밀리는 문제가 있었음)
function getKSTDateString(date = new Date()) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Seoul', year: 'numeric', month: '2-digit', day: '2-digit' }).format(date);
}
