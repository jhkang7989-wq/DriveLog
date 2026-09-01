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
