// In-app recorder + audio file STT pipeline.
//
// Three entry points wire into the existing multi-rec list:
//   1. Live mic recording (web MediaRecorder)         — works PC, Android well; iOS limited (foreground only)
//   2. Audio file upload (m4a/mp3/wav/webm/aac/etc.)  — universal fallback, including iOS
//
// After audio is captured we:
//   1. Upload audio blob to Firebase Storage at users/{uid}/recordings/{ts}.{ext}
//   2. Get a downloadURL
//   3. POST that URL to /api/assemblyai?action=transcribe
//   4. Poll /api/assemblyai?action=status&id=...   every 6 seconds
//   5. When completed, wrap text into a File object and feed addRecSlot(file)
//
// Depends on: constants.js (storage, currentUser, txtFiles, _currentView), pptx_parser.js (addRecSlot, setRecSlotFile),
//             ui.js (showToast), firebase_auth.js (currentUser ID token), api.js (none),
//             transcripts_store.js (saveTranscriptFS) — optional; if absent, recorder still works
//             but transcripts won't be persisted to the user's transcript store.

(function () {
  // ── Audio MIME detection (browser quirks) ───────────────
  function pickMimeType() {
    const candidates = [
      'audio/webm;codecs=opus',
      'audio/webm',
      'audio/mp4;codecs=mp4a.40.2',
      'audio/mp4',
      'audio/ogg;codecs=opus',
      'audio/ogg',
    ];
    for (const t of candidates) {
      if (typeof MediaRecorder !== 'undefined' && MediaRecorder.isTypeSupported(t)) return t;
    }
    return '';
  }

  function extFromMime(mime) {
    if (!mime) return 'webm';
    if (mime.startsWith('audio/webm')) return 'webm';
    if (mime.startsWith('audio/mp4'))  return 'm4a';
    if (mime.startsWith('audio/ogg'))  return 'ogg';
    if (mime.startsWith('audio/wav') || mime.startsWith('audio/x-wav')) return 'wav';
    if (mime.startsWith('audio/mpeg')) return 'mp3';
    return 'bin';
  }

  function isiOS() {
    return /iPad|iPhone|iPod/.test(navigator.userAgent)
      || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  }

  // ── Pill drag state ─────────────────────────────────────
  let pillPos = null; // {x, y} pixels from viewport top-left, or null for default

  function loadPillPos() {
    try {
      const s = localStorage.getItem('recorder.pillPos');
      if (s) pillPos = JSON.parse(s);
    } catch (e) {}
  }

  function savePillPos(x, y) {
    pillPos = { x, y };
    try { localStorage.setItem('recorder.pillPos', JSON.stringify({ x, y })); } catch (e) {}
  }

  // ── Inline SVG icons for pill buttons (no lucide dependency) ──
  const SVG_PAUSE  = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="6" y="4" width="4" height="16"/><rect x="14" y="4" width="4" height="16"/></svg>';
  const SVG_PLAY   = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polygon points="5 3 19 12 5 21 5 3"/></svg>';
  const SVG_STOP   = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="18" height="18" rx="2"/></svg>';
  const SVG_EXPAND = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="15 3 21 3 21 9"/><polyline points="9 21 3 21 3 15"/><line x1="21" y1="3" x2="14" y2="10"/><line x1="3" y1="21" x2="10" y2="14"/></svg>';

  // ── CSS injection ────────────────────────────────────────
  function injectPillStyles() {
    if (document.getElementById('recorder-pill-styles')) return;
    const style = document.createElement('style');
    style.id = 'recorder-pill-styles';
    style.textContent = `
      /* Minimized: whole modal wrapper becomes click-through */
      .recorder-modal--minimized {
        pointer-events: none !important;
      }

      /* Minimized: backdrop is invisible + click-through */
      .recorder-modal--minimized .recorder-backdrop {
        background: transparent !important;
        pointer-events: none !important;
      }

      /* Minimized: panel becomes a compact floating pill */
      .recorder-modal--minimized .recorder-panel {
        position: fixed !important;
        width: 280px !important;
        min-height: 0 !important;
        height: auto !important;
        border-radius: 999px !important;
        padding: 0 !important;
        transform: none !important;
        z-index: 10001 !important;
        box-shadow: 0 4px 28px rgba(0,0,0,0.28) !important;
        display: flex !important;
        align-items: center !important;
        overflow: hidden !important;
        cursor: grab !important;
        flex-direction: row !important;
        pointer-events: auto !important;
      }
      .recorder-modal--minimized .recorder-panel:active {
        cursor: grabbing !important;
      }

      /* Hide full modal chrome while minimized */
      .recorder-modal--minimized .recorder-head,
      .recorder-modal--minimized .recorder-body {
        display: none !important;
      }

      /* Pill content — hidden in full mode, shown in minimized mode */
      .recorder-pill {
        display: none;
      }
      .recorder-modal--minimized .recorder-pill {
        display: flex !important;
        align-items: center;
        gap: 8px;
        padding: 12px 14px;
        width: 100%;
        user-select: none;
        -webkit-user-select: none;
      }

      .rec-dot {
        width: 10px;
        height: 10px;
        border-radius: 50%;
        background: #ef4444;
        flex-shrink: 0;
        animation: recDotBlink 1.2s ease-in-out infinite;
      }
      .rec-dot--paused {
        animation: none !important;
        opacity: 0.35;
      }
      @keyframes recDotBlink {
        0%, 100% { opacity: 1; }
        50%       { opacity: 0.2; }
      }

      .rec-pill-timer {
        font-size: 13px;
        font-weight: 600;
        font-variant-numeric: tabular-nums;
        letter-spacing: 0.04em;
        flex: 1;
        min-width: 0;
        white-space: nowrap;
      }

      .rec-pill-btn {
        background: none;
        border: none;
        padding: 5px;
        cursor: pointer;
        border-radius: 50%;
        display: flex;
        align-items: center;
        justify-content: center;
        flex-shrink: 0;
        transition: background 0.12s;
        line-height: 0;
      }
      .rec-pill-btn:hover { background: rgba(128,128,128,0.15); }
      .rec-pill-btn svg   { width: 15px; height: 15px; }
      .rec-pill-btn--stop   { color: #ef4444; }
      .rec-pill-btn--expand { opacity: 0.65; }
      .rec-pill-btn--expand:hover { opacity: 1; }
    `;
    document.head.appendChild(style);
  }

  // ── Modal singleton ─────────────────────────────────────
  let modalEl = null;
  let modalState = {
    phase: 'idle', // idle | requesting | recording | paused | uploading | transcribing | completed | error
    rec: null,
    chunks: [],
    stream: null,
    mime: '',
    startTime: 0,
    elapsedAtPause: 0,
    timerHandle: null,
    levelHandle: null,
    audioCtx: null,
    analyser: null,
    pollHandle: null,
    targetSlotId: null,
    objectUrl: null,
    audioStoragePath: null,
    recordingDurationSec: null,
  };

  function ensureModal() {
    if (modalEl) return modalEl;
    injectPillStyles();

    modalEl = document.createElement('div');
    modalEl.id = 'recorderModal';
    modalEl.className = 'recorder-modal hidden';
    modalEl.innerHTML = `
      <div class="recorder-backdrop"></div>
      <div class="recorder-panel" role="dialog" aria-modal="true" aria-label="녹음">
        <div class="recorder-head">
          <div class="recorder-title" id="recTitle">녹음하기</div>
          <button class="recorder-minimize" id="recMinimizeBtn" aria-label="최소화" style="display:none"><i data-lucide="minimize-2" class="icon-sm"></i></button>
          <button class="recorder-close" id="recCloseBtn" aria-label="닫기"><i data-lucide="x" class="icon-sm"></i></button>
        </div>

        <div class="recorder-body" id="recBody">
          <!-- Idle: pick mode -->
          <div class="rec-screen rec-screen-idle" data-screen="idle">
            <p class="rec-help">강의를 직접 녹음하거나, 이미 녹음된 오디오 파일을 업로드하세요. STT가 끝나면 자동으로 녹취록 슬롯에 채워집니다.</p>
            <div class="rec-ios-warn" id="recIosWarn" style="display:none">
              <strong>iOS 사용자 안내</strong><br>
              녹음 도중 화면을 끄거나 다른 앱으로 전환하면 마이크가 멈춥니다. 녹음 동안 lazyuniv-ai 화면을 켜둔 상태로 유지해주세요.
            </div>
            <div class="rec-mode-grid">
              <button class="rec-mode-card" id="recPickLive">
                <div class="rec-mode-icon"><i data-lucide="mic"></i></div>
                <div class="rec-mode-title">직접 녹음</div>
                <div class="rec-mode-sub">PC · 안드로이드 권장</div>
              </button>
              <label class="rec-mode-card" for="recFileInput">
                <div class="rec-mode-icon"><i data-lucide="upload"></i></div>
                <div class="rec-mode-title">오디오 파일 업로드</div>
                <div class="rec-mode-sub">mp3 · m4a · wav · webm</div>
              </label>
              <input type="file" id="recFileInput" accept="audio/*,.m4a,.mp3,.wav,.webm,.ogg,.aac,.flac" style="display:none" />
            </div>
          </div>

          <!-- Recording / paused -->
          <div class="rec-screen rec-screen-live" data-screen="live">
            <div class="rec-timer" id="recTimer">00:00</div>
            <div class="rec-meter"><div class="rec-meter-bar" id="recMeterBar"></div></div>
            <div class="rec-status" id="recLiveStatus">녹음 중…</div>
            <div class="rec-actions">
              <button class="rec-btn rec-btn-secondary" id="recPauseBtn">일시정지</button>
              <button class="rec-btn rec-btn-stop" id="recStopBtn">녹음 종료</button>
            </div>
            <button class="rec-cancel-link" id="recCancelLiveBtn">취소</button>
          </div>

          <!-- Uploading -->
          <div class="rec-screen rec-screen-upload" data-screen="upload">
            <div class="rec-progress-wrap">
              <div class="rec-progress-bar" id="recUploadBar"></div>
            </div>
            <div class="rec-status" id="recUploadStatus">업로드 준비 중…</div>
          </div>

          <!-- Transcribing (AssemblyAI polling) -->
          <div class="rec-screen rec-screen-stt" data-screen="stt">
            <div class="rec-spinner"></div>
            <div class="rec-status" id="recSttStatus">텍스트 변환 중…</div>
            <div class="rec-stt-hint">강의 90분 기준 약 30~60분 소요됩니다. 이 창을 닫아도 처리는 계속됩니다.</div>
            <button class="rec-cancel-link" id="recHideSttBtn">창 닫기 (백그라운드 진행)</button>
          </div>

          <!-- Completed -->
          <div class="rec-screen rec-screen-done" data-screen="done">
            <div class="rec-done-icon"><i data-lucide="check"></i></div>
            <div class="rec-status" id="recDoneStatus">변환 완료</div>
            <div class="rec-done-hint">녹취록 슬롯에 텍스트가 추가되었습니다. 분석을 시작하세요.</div>
            <div class="rec-actions">
              <button class="rec-btn rec-btn-primary" id="recDoneCloseBtn">확인</button>
            </div>
          </div>

          <!-- Error -->
          <div class="rec-screen rec-screen-error" data-screen="error">
            <div class="rec-error-icon"><i data-lucide="alert-triangle"></i></div>
            <div class="rec-status" id="recErrorStatus">오류가 발생했습니다.</div>
            <div class="rec-actions">
              <button class="rec-btn rec-btn-primary" id="recErrorRetryBtn">다시 시도</button>
            </div>
          </div>
        </div>

        <!-- Compact pill content (visible only when minimized) -->
        <div class="recorder-pill" id="recorderPill">
          <div class="rec-dot" id="recPillDot"></div>
          <div class="rec-pill-timer" id="recPillTimer">00:00</div>
          <button class="rec-pill-btn rec-pill-btn--pause"  id="recPillPauseBtn"  aria-label="일시정지"></button>
          <button class="rec-pill-btn rec-pill-btn--stop"   id="recPillStopBtn"   aria-label="녹음 종료"></button>
          <button class="rec-pill-btn rec-pill-btn--expand" id="recPillExpandBtn" aria-label="확장"></button>
        </div>
      </div>
    `;
    document.body.appendChild(modalEl);

    // Set pill button icons (inline SVG — no lucide mounting needed)
    modalEl.querySelector('#recPillPauseBtn').innerHTML  = SVG_PAUSE;
    modalEl.querySelector('#recPillStopBtn').innerHTML   = SVG_STOP;
    modalEl.querySelector('#recPillExpandBtn').innerHTML = SVG_EXPAND;

    // Wire static handlers
    modalEl.querySelector('#recCloseBtn').addEventListener('click', closeModalIfSafe);
    modalEl.querySelector('.recorder-backdrop').addEventListener('click', handleBackdropClick);
    modalEl.querySelector('#recMinimizeBtn').addEventListener('click', minimizePill);
    modalEl.querySelector('#recPickLive').addEventListener('click', startLiveRecording);
    modalEl.querySelector('#recFileInput').addEventListener('change', onFilePicked);
    modalEl.querySelector('#recPauseBtn').addEventListener('click', togglePause);
    modalEl.querySelector('#recStopBtn').addEventListener('click', stopRecording);
    modalEl.querySelector('#recCancelLiveBtn').addEventListener('click', cancelLiveRecording);
    modalEl.querySelector('#recHideSttBtn').addEventListener('click', hideModal);
    modalEl.querySelector('#recDoneCloseBtn').addEventListener('click', hideModal);
    modalEl.querySelector('#recErrorRetryBtn').addEventListener('click', () => switchScreen('idle'));

    // Pill controls
    modalEl.querySelector('#recPillPauseBtn').addEventListener('click', togglePause);
    modalEl.querySelector('#recPillStopBtn').addEventListener('click', stopRecording);
    modalEl.querySelector('#recPillExpandBtn').addEventListener('click', expandPill);

    // Drag
    initPillDrag(
      modalEl.querySelector('#recorderPill'),
      modalEl.querySelector('.recorder-panel')
    );

    // Block ESC while minimized — prevents accidental cancel via any external handler
    document.addEventListener('keydown', function (e) {
      if (e.key === 'Escape'
          && modalEl
          && !modalEl.classList.contains('hidden')
          && modalEl.classList.contains('recorder-modal--minimized')) {
        e.stopImmediatePropagation();
      }
    }, true);

    return modalEl;
  }

  // ── Backdrop click: auto-minimize during active recording ──
  function handleBackdropClick() {
    if (modalState.phase === 'recording' || modalState.phase === 'paused') {
      minimizePill();
    } else {
      closeModalIfSafe();
    }
  }

  // ── Pill minimize / expand ───────────────────────────────
  function minimizePill() {
    ensureModal();
    loadPillPos();

    const panelEl = modalEl.querySelector('.recorder-panel');

    modalEl.classList.add('recorder-modal--minimized');
    modalEl.classList.remove('hidden');

    // Position after the CSS `position: fixed` has taken effect
    requestAnimationFrame(function () {
      const pillWidth  = 280;
      const pillHeight = panelEl.offsetHeight || 52;
      let x, y;
      if (pillPos && typeof pillPos.x === 'number' && typeof pillPos.y === 'number') {
        x = Math.max(0, Math.min(window.innerWidth  - pillWidth,  pillPos.x));
        y = Math.max(0, Math.min(window.innerHeight - pillHeight, pillPos.y));
      } else {
        x = window.innerWidth  - pillWidth  - 24;
        y = window.innerHeight - pillHeight - 24;
      }
      panelEl.style.left = x + 'px';
      panelEl.style.top  = y + 'px';
    });

    updatePillUI();
  }

  function expandPill() {
    ensureModal();
    const panelEl = modalEl.querySelector('.recorder-panel');

    modalEl.classList.remove('recorder-modal--minimized');
    panelEl.style.left = '';
    panelEl.style.top  = '';

    updatePillUI();
  }

  function updatePillUI() {
    if (!modalEl) return;
    const dot      = modalEl.querySelector('#recPillDot');
    const pauseBtn = modalEl.querySelector('#recPillPauseBtn');
    if (!dot || !pauseBtn) return;

    const paused = modalState.phase === 'paused';
    dot.classList.toggle('rec-dot--paused', paused);
    pauseBtn.innerHTML = paused ? SVG_PLAY : SVG_PAUSE;
    pauseBtn.setAttribute('aria-label', paused ? '재개' : '일시정지');

    // Sync pill timer to main timer's current text
    const mainTimer = document.getElementById('recTimer');
    const pillTimer = document.getElementById('recPillTimer');
    if (mainTimer && pillTimer) pillTimer.textContent = mainTimer.textContent;
  }

  // ── Pill drag (mouse + touch) ────────────────────────────
  function initPillDrag(pillEl, panelEl) {
    let dragging  = false;
    let startX    = 0, startY    = 0;
    let startLeft = 0, startTop  = 0;

    function dragStart(clientX, clientY) {
      dragging   = true;
      startX     = clientX;
      startY     = clientY;
      const rect = panelEl.getBoundingClientRect();
      startLeft  = rect.left;
      startTop   = rect.top;
      panelEl.style.transition  = 'none';
      document.body.style.userSelect = 'none';
    }

    function dragMove(clientX, clientY) {
      if (!dragging) return;
      const w = panelEl.offsetWidth  || 280;
      const h = panelEl.offsetHeight || 52;
      const newLeft = Math.max(0, Math.min(window.innerWidth  - w, startLeft + (clientX - startX)));
      const newTop  = Math.max(0, Math.min(window.innerHeight - h, startTop  + (clientY - startY)));
      panelEl.style.left = newLeft + 'px';
      panelEl.style.top  = newTop  + 'px';
    }

    function dragEnd() {
      if (!dragging) return;
      dragging = false;
      document.body.style.userSelect = '';
      panelEl.style.transition = '';
      const rect = panelEl.getBoundingClientRect();
      savePillPos(rect.left, rect.top);
    }

    // Mouse events
    pillEl.addEventListener('mousedown', function (e) {
      if (e.button !== 0 || e.target.closest('button')) return;
      e.preventDefault();
      dragStart(e.clientX, e.clientY);
    });
    document.addEventListener('mousemove', function (e) { if (dragging) dragMove(e.clientX, e.clientY); });
    document.addEventListener('mouseup',   function ()  { dragEnd(); });

    // Touch events
    pillEl.addEventListener('touchstart', function (e) {
      if (e.target.closest('button')) return;
      e.preventDefault();
      const t = e.touches[0];
      dragStart(t.clientX, t.clientY);
    }, { passive: false });
    document.addEventListener('touchmove', function (e) {
      if (!dragging) return;
      const t = e.touches[0];
      dragMove(t.clientX, t.clientY);
    }, { passive: true });
    document.addEventListener('touchend', function () { dragEnd(); });
  }

  // ── Screen switching ─────────────────────────────────────
  function switchScreen(name) {
    if (!modalEl) return;
    modalEl.querySelectorAll('.rec-screen').forEach(el => {
      el.classList.toggle('active', el.dataset.screen === name);
    });
    modalState.screen = name;

    // Show minimize button only on the live (recording) screen
    const minimizeBtn = modalEl.querySelector('#recMinimizeBtn');
    if (minimizeBtn) minimizeBtn.style.display = (name === 'live') ? '' : 'none';

    window.mountLucideIcons?.();
  }

  function showModal(targetSlotId = null) {
    ensureModal();
    // If already minimized (recording in background), just surface it
    if (modalEl.classList.contains('recorder-modal--minimized')) {
      expandPill();
      return;
    }
    modalState.targetSlotId = targetSlotId;
    modalEl.classList.remove('hidden');
    document.getElementById('recIosWarn').style.display = isiOS() ? 'block' : 'none';
    switchScreen('idle');
  }

  function hideModal() {
    if (!modalEl) return;
    modalEl.classList.add('hidden');
    modalEl.classList.remove('recorder-modal--minimized');
    const panelEl = modalEl.querySelector('.recorder-panel');
    if (panelEl) { panelEl.style.left = ''; panelEl.style.top = ''; }
  }

  function closeModalIfSafe() {
    if (modalState.phase === 'recording' || modalState.phase === 'paused') {
      if (!confirm('녹음을 취소하시겠습니까? 현재까지 녹음한 내용은 사라집니다.')) return;
      cancelLiveRecording();
      return;
    }
    if (modalState.phase === 'uploading') {
      if (!confirm('업로드를 취소하시겠습니까?')) return;
    }
    hideModal();
  }

  // ── Live recording ──────────────────────────────────────
  async function startLiveRecording() {
    if (!currentUser) {
      window.showToast?.('🔑 로그인 후 이용할 수 있습니다.');
      return;
    }
    if (typeof MediaRecorder === 'undefined' || !navigator.mediaDevices?.getUserMedia) {
      switchScreen('error');
      document.getElementById('recErrorStatus').textContent =
        '이 브라우저는 녹음을 지원하지 않습니다. 오디오 파일 업로드를 사용해주세요.';
      return;
    }

    modalState.chunks = [];
    modalState.startTime = 0;
    modalState.elapsedAtPause = 0;

    try {
      modalState.stream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
      });
    } catch (err) {
      console.error('[recorder] getUserMedia denied', err);
      switchScreen('error');
      document.getElementById('recErrorStatus').textContent =
        '마이크 권한이 거부되었습니다. 브라우저 설정에서 마이크 사용을 허용해주세요.';
      return;
    }

    modalState.mime = pickMimeType();
    try {
      modalState.rec = new MediaRecorder(modalState.stream, modalState.mime ? { mimeType: modalState.mime } : undefined);
    } catch (err) {
      console.error('[recorder] MediaRecorder init failed', err);
      releaseStream();
      switchScreen('error');
      document.getElementById('recErrorStatus').textContent = '녹음을 시작할 수 없습니다.';
      return;
    }

    modalState.rec.addEventListener('dataavailable', (e) => {
      if (e.data && e.data.size > 0) modalState.chunks.push(e.data);
    });
    modalState.rec.addEventListener('error', (e) => {
      console.error('[recorder] MediaRecorder error', e);
    });
    modalState.rec.addEventListener('stop', onRecorderStopped);

    // Small timeslice keeps memory bounded and enables partial-crash recovery
    modalState.rec.start(5000);
    modalState.startTime = Date.now();
    modalState.elapsedAtPause = 0;

    setupAudioMeter(modalState.stream);
    startTimer();
    switchScreen('live');
    document.getElementById('recPauseBtn').textContent = '일시정지';
    document.getElementById('recLiveStatus').textContent = '녹음 중…';
  }

  function startTimer() {
    if (modalState.timerHandle) clearInterval(modalState.timerHandle);
    modalState.timerHandle = setInterval(() => {
      const ms = (modalState.phase === 'recording')
        ? (modalState.elapsedAtPause + (Date.now() - modalState.startTime))
        : modalState.elapsedAtPause;
      const totalSec = Math.floor(ms / 1000);
      const m = String(Math.floor(totalSec / 60)).padStart(2, '0');
      const s = String(totalSec % 60).padStart(2, '0');
      const h = Math.floor(totalSec / 3600);
      const timeStr = h > 0 ? `${h}:${m}:${s}` : `${m}:${s}`;
      const el = document.getElementById('recTimer');
      if (el) el.textContent = timeStr;
      // Mirror to pill timer while minimized
      const pillTimer = document.getElementById('recPillTimer');
      if (pillTimer) pillTimer.textContent = timeStr;
    }, 250);
    // Must set phase AFTER wiring the interval — phase drives the ms calculation above
    modalState.phase = 'recording';
  }

  function setupAudioMeter(stream) {
    try {
      const Ctx = window.AudioContext || window.webkitAudioContext;
      modalState.audioCtx = new Ctx();
      const src = modalState.audioCtx.createMediaStreamSource(stream);
      modalState.analyser = modalState.audioCtx.createAnalyser();
      modalState.analyser.fftSize = 256;
      src.connect(modalState.analyser);
      const buf = new Uint8Array(modalState.analyser.frequencyBinCount);
      const bar = document.getElementById('recMeterBar');
      modalState.levelHandle = setInterval(() => {
        if (!modalState.analyser) return;
        // While paused, freeze the meter at 0 so users see clearly that
        // nothing is being captured. The MediaStream itself stays live
        // (MediaRecorder.pause() doesn't stop the underlying track), so
        // without this guard the bar would keep dancing despite pause.
        if (modalState.phase === 'paused') {
          if (bar) bar.style.width = '0%';
          return;
        }
        modalState.analyser.getByteTimeDomainData(buf);
        let sum = 0;
        for (let i = 0; i < buf.length; i++) {
          const v = (buf[i] - 128) / 128;
          sum += v * v;
        }
        const rms = Math.sqrt(sum / buf.length);
        const pct = Math.min(100, Math.round(rms * 240));
        if (bar) bar.style.width = pct + '%';
      }, 80);
    } catch (e) {
      // Audio meter is decorative — silent fallback is fine
    }
  }

  function togglePause() {
    if (!modalState.rec) return;
    if (modalState.rec.state === 'recording') {
      modalState.rec.pause();
      modalState.elapsedAtPause += Date.now() - modalState.startTime;
      modalState.phase = 'paused';
      document.getElementById('recPauseBtn').textContent = '재개';
      document.getElementById('recLiveStatus').textContent = '일시정지됨';
    } else if (modalState.rec.state === 'paused') {
      modalState.rec.resume();
      modalState.startTime = Date.now();
      modalState.phase = 'recording';
      document.getElementById('recPauseBtn').textContent = '일시정지';
      document.getElementById('recLiveStatus').textContent = '녹음 중…';
    }
    updatePillUI();
  }

  function stopRecording() {
    if (!modalState.rec) return;
    // Expand first so the user can see upload/STT progress
    if (modalEl && modalEl.classList.contains('recorder-modal--minimized')) {
      expandPill();
    }
    if (modalState.rec.state !== 'inactive') {
      modalState.rec.stop(); // triggers onRecorderStopped
    }
  }

  function cancelLiveRecording() {
    if (modalState.rec && modalState.rec.state !== 'inactive') {
      // Detach stop handler so we don't try to upload a half-blob
      modalState.rec.removeEventListener('stop', onRecorderStopped);
      try { modalState.rec.stop(); } catch (e) {}
    }
    teardownLiveCapture();
    modalState.chunks = [];
    hideModal();
  }

  function teardownLiveCapture() {
    if (modalState.timerHandle) { clearInterval(modalState.timerHandle); modalState.timerHandle = null; }
    if (modalState.levelHandle) { clearInterval(modalState.levelHandle); modalState.levelHandle = null; }
    if (modalState.audioCtx)    { try { modalState.audioCtx.close(); } catch(e){} modalState.audioCtx = null; }
    modalState.analyser = null;
    releaseStream();
  }

  function releaseStream() {
    if (modalState.stream) {
      try { modalState.stream.getTracks().forEach(t => t.stop()); } catch (e) {}
      modalState.stream = null;
    }
  }

  async function onRecorderStopped() {
    teardownLiveCapture();
    const ext  = extFromMime(modalState.mime);
    const blob = new Blob(modalState.chunks, { type: modalState.mime || 'audio/webm' });
    modalState.chunks = [];

    if (blob.size < 5 * 1024) {
      switchScreen('error');
      document.getElementById('recErrorStatus').textContent =
        '녹음된 내용이 너무 짧습니다. 다시 시도해주세요.';
      return;
    }

    // Capture total duration; paused time already in elapsedAtPause
    const finalMs = modalState.phase === 'recording'
      ? modalState.elapsedAtPause + (Date.now() - modalState.startTime)
      : modalState.elapsedAtPause;
    modalState.recordingDurationSec = Math.max(1, Math.floor(finalMs / 1000));

    const filename = 'recording_' + new Date().toISOString().replace(/[:.]/g, '-') + '.' + ext;
    handleAudioBlob(blob, filename);
  }

  // ── File upload entry ───────────────────────────────────
  function onFilePicked(ev) {
    const file = ev.target.files && ev.target.files[0];
    ev.target.value = '';
    if (!file) return;
    if (!currentUser) {
      window.showToast?.('🔑 로그인 후 이용할 수 있습니다.');
      return;
    }
    if (file.size > 500 * 1024 * 1024) {
      switchScreen('error');
      document.getElementById('recErrorStatus').textContent =
        '파일이 너무 큽니다 (최대 500MB). 더 작은 파일을 사용해주세요.';
      return;
    }
    handleAudioBlob(file, file.name);
  }

  // ── Upload to Firebase Storage + AssemblyAI pipeline ───
  async function handleAudioBlob(blob, filename) {
    if (!currentUser) {
      window.showToast?.('🔑 로그인 후 이용할 수 있습니다.');
      return;
    }
    switchScreen('upload');
    document.getElementById('recUploadStatus').textContent = '업로드 중…';
    document.getElementById('recUploadBar').style.width = '0%';

    const path = 'users/' + currentUser.uid + '/recordings/'
               + Date.now() + '_' + Math.random().toString(36).slice(2, 8)
               + '_' + filename.replace(/[^\w.-]/g, '_');

    modalState.audioStoragePath = path;

    let downloadUrl;
    try {
      const ref = storage.ref(path);
      const task = ref.put(blob, { contentType: blob.type || 'application/octet-stream' });
      task.on('state_changed', (snap) => {
        const pct = snap.totalBytes ? (snap.bytesTransferred / snap.totalBytes * 100) : 0;
        const bar = document.getElementById('recUploadBar');
        const lbl = document.getElementById('recUploadStatus');
        if (bar) bar.style.width = pct.toFixed(1) + '%';
        if (lbl) lbl.textContent = `업로드 중… ${pct.toFixed(0)}%`;
      });
      await task;
      downloadUrl = await ref.getDownloadURL();
    } catch (err) {
      console.error('[recorder] storage upload failed', err);
      switchScreen('error');
      document.getElementById('recErrorStatus').textContent =
        '업로드에 실패했습니다. 인터넷 연결을 확인해주세요.';
      return;
    }

    switchScreen('stt');
    document.getElementById('recSttStatus').textContent = '텍스트 변환 시작 중…';

    let transcriptId;
    try {
      const idToken = await currentUser.getIdToken();
      const tr = await fetch('/api/assemblyai?action=transcribe', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'authorization': 'Bearer ' + idToken,
        },
        body: JSON.stringify({ audio_url: downloadUrl }),
      });
      const trJson = await tr.json();
      if (!tr.ok || !trJson.transcript_id) {
        throw new Error(trJson.error || 'transcribe_failed');
      }
      transcriptId = trJson.transcript_id;
    } catch (err) {
      console.error('[recorder] transcribe start failed', err);
      switchScreen('error');
      document.getElementById('recErrorStatus').textContent =
        '텍스트 변환을 시작하지 못했습니다. (' + (err.message || 'unknown') + ')';
      return;
    }

    document.getElementById('recSttStatus').textContent = '텍스트 변환 중… (대기열)';
    const pollStart = Date.now();
    const POLL_INTERVAL = 6000;
    const MAX_POLL_MS = 90 * 60 * 1000;

    async function poll() {
      try {
        const idToken = await currentUser.getIdToken();
        const r = await fetch('/api/assemblyai?action=status&id=' + encodeURIComponent(transcriptId), {
          headers: { 'authorization': 'Bearer ' + idToken },
        });
        const j = await r.json();
        if (!r.ok) {
          throw new Error(j.error || 'status_failed');
        }
        const elapsedSec = Math.floor((Date.now() - pollStart) / 1000);
        const elapsedLabel = formatElapsed(elapsedSec);
        const lbl = document.getElementById('recSttStatus');

        if (j.status === 'queued')          lbl.textContent = `대기열에서 차례를 기다리는 중… (${elapsedLabel})`;
        else if (j.status === 'processing') lbl.textContent = `텍스트 변환 중… (${elapsedLabel})`;
        else if (j.status === 'completed') {
          deliverTranscript(j.text || '', filename);
          return;
        } else if (j.status === 'error') {
          throw new Error(j.error_msg || 'transcription_error');
        }

        if (Date.now() - pollStart > MAX_POLL_MS) {
          throw new Error('처리 시간이 너무 오래 걸립니다. 잠시 후 다시 시도해주세요.');
        }
        modalState.pollHandle = setTimeout(poll, POLL_INTERVAL);
      } catch (err) {
        console.error('[recorder] poll failed', err);
        switchScreen('error');
        document.getElementById('recErrorStatus').textContent =
          '변환 중 오류가 발생했습니다. (' + (err.message || 'unknown') + ')';
      }
    }
    modalState.pollHandle = setTimeout(poll, 1500);
  }

  function formatElapsed(sec) {
    const m = Math.floor(sec / 60);
    const s = sec % 60;
    if (m === 0) return `${s}초`;
    return `${m}분 ${s}초`;
  }

  async function deliverTranscript(text, sourceFilename) {
    if (modalState.pollHandle) { clearTimeout(modalState.pollHandle); modalState.pollHandle = null; }

    const cleanText = (text || '').trim();
    if (!cleanText) {
      switchScreen('error');
      document.getElementById('recErrorStatus').textContent =
        '변환된 텍스트가 비어있습니다. 녹음 파일을 확인해주세요.';
      return;
    }

    // Step 1: persist to transcript store
    let savedTranscript = null;
    if (typeof saveTranscriptFS === 'function') {
      try {
        savedTranscript = await saveTranscriptFS({
          text: cleanText,
          audioFilename: sourceFilename || '',
          durationSec: modalState.recordingDurationSec,
        });
      } catch (err) {
        console.error('[recorder] saveTranscriptFS failed:', err);
        window.showToast?.('⚠️ 녹취록 자동 저장에 실패했습니다. 슬롯에는 추가됩니다.');
      }
    }

    // Step 2: delete original audio from Storage (best-effort)
    if (modalState.audioStoragePath) {
      const pathToDelete = modalState.audioStoragePath;
      modalState.audioStoragePath = null;
      storage.ref(pathToDelete).delete().catch((e) => {
        console.warn('[recorder] audio delete failed (non-fatal):', e.message);
      });
    }

    // Step 3: feed text into new-note slots (existing behavior)
    const baseName = (sourceFilename || 'recording').replace(/\.[^.]+$/, '');
    const file = new File([cleanText], baseName + '.txt', { type: 'text/plain' });

    let didFillSlot = false;
    if (modalState.targetSlotId != null && typeof setRecSlotFile === 'function') {
      setRecSlotFile(modalState.targetSlotId, file);
      didFillSlot = true;
    } else {
      const emptySlot = (typeof txtFiles !== 'undefined') ? txtFiles.find(s => !s.file) : null;
      if (emptySlot && typeof setRecSlotFile === 'function') {
        setRecSlotFile(emptySlot.id, file);
        didFillSlot = true;
      } else if (typeof addRecSlot === 'function' && _currentView === 'new') {
        addRecSlot(file);
        didFillSlot = true;
      }
    }

    switchScreen('done');
    const status = document.getElementById('recDoneStatus');
    if (status) {
      const lenLabel   = `${cleanText.length.toLocaleString()}자`;
      const savedLabel = savedTranscript ? ' · 내 녹취록에 저장됨' : '';
      status.textContent = `변환 완료 · ${lenLabel}${savedLabel}`;
    }

    if (didFillSlot && savedTranscript) {
      window.showToast?.('🎙️ 녹취록이 슬롯에 추가되고 내 녹취록에도 저장되었습니다.');
    } else if (savedTranscript) {
      window.showToast?.('🎙️ 내 녹취록에 저장되었습니다.');
    } else if (didFillSlot) {
      window.showToast?.('🎙️ 녹취록이 추가되었습니다.');
    }
  }

  // ── Public entry ────────────────────────────────────────
  window.openRecorderModal = function (targetSlotId) {
    showModal(targetSlotId);
  };
})();
