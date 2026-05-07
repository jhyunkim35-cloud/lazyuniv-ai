// In-app recorder + audio file STT pipeline.
//
// Three entry points wire into the existing multi-rec list:
//   1. Live mic recording (web MediaRecorder)         ??works PC, Android well; iOS limited (foreground only)
//   2. Audio file upload (m4a/mp3/wav/webm/aac/etc.)  ??universal fallback, including iOS
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
//             transcripts_store.js (saveTranscriptFS) ??optional; if absent, recorder still works
//             but transcripts won't be persisted to the user's transcript store.

(function () {
  // ?? Audio MIME detection (browser quirks) ???????????????
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

  // ?? Pill drag state ?????????????????????????????????????
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

  // ?? Inline SVG icons for pill buttons (no lucide dependency) ??
  const SVG_PAUSE  = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="6" y="4" width="4" height="16"/><rect x="14" y="4" width="4" height="16"/></svg>';
  const SVG_PLAY   = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polygon points="5 3 19 12 5 21 5 3"/></svg>';
  const SVG_STOP   = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="18" height="18" rx="2"/></svg>';
  const SVG_EXPAND = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="15 3 21 3 21 9"/><polyline points="9 21 3 21 3 15"/><line x1="21" y1="3" x2="14" y2="10"/><line x1="3" y1="21" x2="10" y2="14"/></svg>';

  // ?? CSS injection ????????????????????????????????????????
  function injectPillStyles() {
    if (document.getElementById('recorder-pill-styles')) return;
    const style = document.createElement('style');
    style.id = 'recorder-pill-styles';
    style.textContent = `
      /* Minimized: whole modal wrapper becomes click-through */
      .recorder-modal--minimized {
        pointer-events: none !important;
      }

      /* Minimized: backdrop is invisible + click-through.
         IMPORTANT: also kill backdrop-filter, otherwise the blur(2px)
         from .recorder-backdrop in index.html stays applied to the
         whole viewport (the element keeps inset:0) and the page looks
         hazy while the pill floats. */
      .recorder-modal--minimized .recorder-backdrop {
        display: none !important;
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

      /* Pill content ??hidden in full mode, shown in minimized mode */
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

      /* ?? Top-center grabber (replaces header minimize button) ??
         Mobile-sheet pattern: a wide horizontal handle at the very
         top of the panel. On hover/touch, the handle highlights and
         a "?묎쾶 蹂닿린" label fades in below it so the affordance is
         unambiguous on first encounter ??far more discoverable than
         a tiny corner icon. Click the whole area to minimize. */
      /* Mini "?묎쾶 蹂닿린" affordance pinned to the top-center of the
         recorder panel. Uses a Picture-in-Picture icon + label so the
         action is unambiguous on first encounter ??far more discoverable
         than a tiny corner icon. Click the whole area to minimize. */
      .recorder-grabber {
        display: none;
        flex-direction: row;
        align-items: center;
        justify-content: center;
        gap: 6px;
        width: auto;
        margin: 8px auto 4px;
        padding: 6px 14px;
        background: rgba(124,58,237,0.08);
        border: 1px solid rgba(124,58,237,0.18);
        border-radius: 999px;
        cursor: pointer;
        color: var(--primary, #7c3aed);
        transition: background 0.15s ease, border-color 0.15s ease, transform 0.15s ease;
        flex-shrink: 0;
        font-family: inherit;
        font-size: 12px;
        font-weight: 600;
        letter-spacing: 0.01em;
        line-height: 1;
      }
      .recorder-grabber.is-visible { display: inline-flex; }
      .recorder-grabber-icon {
        width: 14px;
        height: 14px;
        flex-shrink: 0;
        display: block;
      }
      .recorder-grabber-label {
        white-space: nowrap;
      }
      .recorder-grabber:hover,
      .recorder-grabber:focus-visible {
        background: rgba(124,58,237,0.14);
        border-color: rgba(124,58,237,0.35);
        outline: none;
      }
      .recorder-grabber:active {
        transform: scale(0.97);
      }
      /* Hide entirely while minimized ??pill replaces it */
      .recorder-modal--minimized .recorder-grabber { display: none !important; }

      /* ?? STT 3-stage progress tracker ??????????? */
      .rec-stt-stages {
        display: flex;
        align-items: center;
        justify-content: center;
        gap: 0;
        margin: 0 0 1.1rem;
        width: 100%;
      }
      .rec-stt-stage {
        display: flex;
        flex-direction: column;
        align-items: center;
        gap: 5px;
        flex-shrink: 0;
      }
      .rec-stt-stage-line {
        flex: 1;
        height: 2px;
        min-width: 14px;
        max-width: 44px;
        background: var(--border, #252545);
      }
      .rec-stt-stage-dot {
        width: 30px; height: 30px;
        border-radius: 50%;
        background: var(--surface3, #1e1e36);
        border: 2px solid var(--border, #252545);
        display: flex; align-items: center; justify-content: center;
        font-size: 11px; font-weight: 700;
        color: var(--text-muted, #8888aa);
        transition: border-color 0.3s, background 0.3s;
        position: relative; overflow: hidden;
      }
      .rec-stt-stage--done .rec-stt-stage-dot {
        background: rgba(74,222,128,0.15);
        border-color: #4ade80; color: #4ade80;
      }
      .rec-stt-stage--active .rec-stt-stage-dot {
        background: rgba(124,77,255,0.15);
        border-color: var(--primary, #7c4dff);
        color: transparent;
      }
      .rec-stt-stage-dot--spinner::after {
        content: '';
        position: absolute;
        width: 14px; height: 14px;
        border: 2.5px solid transparent;
        border-top-color: var(--primary, #7c4dff);
        border-radius: 50%;
        animation: recSttSpin 0.8s linear infinite;
      }
      @keyframes recSttSpin { to { transform: rotate(360deg); } }
      .rec-stt-stage-label {
        font-size: 10px;
        color: var(--text-muted, #8888aa);
        white-space: nowrap; text-align: center;
        max-width: 72px; line-height: 1.3;
      }
      .rec-stt-stage--active .rec-stt-stage-label {
        color: var(--primary, #7c4dff); font-weight: 600;
      }
      .rec-stt-stage--done .rec-stt-stage-label { color: #4ade80; }

      /* ?? STT elapsed + hint strips ??????????????? */
      .rec-stt-elapsed {
        font-size: 0.95rem; font-weight: 700;
        font-variant-numeric: tabular-nums;
        color: var(--text, #e2e2f2);
        margin-bottom: 0.55rem; letter-spacing: 0.04em;
      }
      .rec-stt-close-note {
        font-size: 0.78rem;
        color: var(--primary, #7c4dff);
        background: rgba(124,77,255,0.10);
        border-radius: 6px; padding: 0.4rem 0.75rem;
        margin: 0.5rem 0; text-align: center; line-height: 1.4;
      }
      .rec-stt-long-warn {
        display: none;
        font-size: 0.78rem; color: #fbbf24;
        background: rgba(251,191,36,0.10);
        border-radius: 6px; padding: 0.4rem 0.75rem;
        margin-top: 0.4rem; text-align: center;
      }

      /* ?? Engine selector ??????????????????????????? */
      .rec-engine-header {
        font-size: 1.05rem; font-weight: 700;
        color: var(--text, #e2e2f2); margin-bottom: 0.35rem;
      }
      .rec-engine-duration {
        font-size: 0.82rem; color: var(--text-muted, #8888aa); margin-bottom: 1.1rem;
      }
      .rec-engine-options { display: flex; flex-direction: column; gap: 0.55rem; margin-bottom: 1.2rem; }
      .rec-engine-option {
        display: flex; align-items: center; gap: 0.75rem;
        padding: 0.85rem 1rem; border: 2px solid var(--border, #252545);
        border-radius: 10px; cursor: pointer; transition: border-color 0.15s, background 0.15s;
      }
      .rec-engine-option--selected {
        border-color: var(--primary, #7c4dff);
        background: rgba(124,77,255,0.07);
      }
      .rec-engine-option input[type="radio"] {
        flex-shrink: 0; accent-color: var(--primary, #7c4dff); width: 16px; height: 16px; cursor: pointer;
      }
      .rec-engine-option-title { font-weight: 600; font-size: 0.93rem; color: var(--text, #e2e2f2); }
      .rec-engine-option-desc  { font-size: 0.78rem; color: var(--text-muted, #8888aa); margin-top: 0.18rem; }

      /* ?? Secondary button variant (done modal) ??? */
      .rec-btn-secondary {
        background: var(--surface2, #16162a);
        color: var(--text, #e2e2f2);
        border: 1px solid var(--border, #252545);
      }
      .rec-btn-secondary:hover { background: var(--surface3, #1e1e36); }

      /* ?? STT background pill ??????????????????????????? */
      .rec-pill-stt-spinner {
        width: 14px; height: 14px;
        border: 2px solid rgba(96,165,250,0.25);
        border-top-color: #60a5fa;
        border-radius: 50%;
        animation: recSttSpin 0.8s linear infinite;
        flex-shrink: 0;
      }
      .rec-pill-stt-label {
        font-size: 13px; font-weight: 600;
        flex: 1; min-width: 0;
        white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
        color: #93c5fd;
      }
      .rec-pill-stt-elapsed {
        font-size: 12px; font-variant-numeric: tabular-nums;
        letter-spacing: 0.04em;
        color: rgba(147,197,253,0.7); flex-shrink: 0; white-space: nowrap;
      }
      .recorder-modal--minimized.recorder-modal--stt .recorder-panel {
        background: #0c1424 !important;
        border: 1px solid rgba(96,165,250,0.22) !important;
      }
      .recorder-modal--minimized.recorder-modal--stt-long .recorder-panel {
        border-color: rgba(251,191,36,0.35) !important;
      }
      .recorder-modal--minimized.recorder-modal--stt-long .rec-pill-stt-label,
      .recorder-modal--minimized.recorder-modal--stt-long .rec-pill-stt-elapsed {
        color: #fbbf24;
      }
      .recorder-modal--minimized.recorder-modal--stt-long .rec-pill-stt-spinner {
        border-top-color: #fbbf24;
        border-color: rgba(251,191,36,0.25);
      }
    `;
    document.head.appendChild(style);
  }

  // ?? Modal singleton ?????????????????????????????????????
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
    pollStart: 0,           // timestamp when STT polling started (for elapsed display)
    sttElapsedHandle: null, // setInterval handle for MM:SS elapsed display during STT
    pendingFile: null,      // transcript File held for "?ㅼ쓬: 媛뺤쓽 ?먮즺 異붽??섍린" CTA
    sttEngine: 'assemblyai', // 'assemblyai' | 'google' ??set by engine selector
    pendingBlob: null,       // audio Blob held between engine selector and handleAudioBlob
    pendingFilename: null,
  };

  function ensureModal() {
    if (modalEl) return modalEl;
    injectPillStyles();

    modalEl = document.createElement('div');
    modalEl.id = 'recorderModal';
    modalEl.className = 'recorder-modal hidden';
    modalEl.innerHTML = `
      <div class="recorder-backdrop"></div>
      <div class="recorder-panel" role="dialog" aria-modal="true" aria-label="?뱀쓬">
        <button class="recorder-grabber" id="recMinimizeBtn" aria-label="?묎쾶 蹂닿린 (PIP)" title="?묎쾶 蹂닿린 (PIP)">
          <svg class="recorder-grabber-icon" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
            <path d="M21 9V6a2 2 0 0 0-2-2H5a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h7"/>
            <rect x="13" y="13" width="8" height="6" rx="1" fill="currentColor" stroke="none"/>
          </svg>
          <span class="recorder-grabber-label">?묎쾶 蹂닿린</span>
        </button>
        <div class="recorder-head">
          <div class="recorder-title" id="recTitle">?뱀쓬?섍린</div>
          <button class="recorder-close" id="recCloseBtn" aria-label="?リ린" title="?リ린"><i data-lucide="x" class="icon-sm"></i></button>
        </div>

        <div class="recorder-body" id="recBody">
          <!-- Idle: pick mode -->
          <div class="rec-screen rec-screen-idle" data-screen="idle">
            <p class="rec-help">媛뺤쓽瑜?吏곸젒 ?뱀쓬?섍굅?? ?대? ?뱀쓬???ㅻ뵒???뚯씪???낅줈?쒗븯?몄슂. STT媛 ?앸굹硫??먮룞?쇰줈 ?뱀랬濡??щ’??梨꾩썙吏묐땲??</p>
            <div class="rec-ios-warn" id="recIosWarn" style="display:none">
              <strong>iOS ?ъ슜???덈궡</strong><br>
              ?뱀쓬 ?꾩쨷 ?붾㈃???꾧굅???ㅻⅨ ?깆쑝濡??꾪솚?섎㈃ 留덉씠?ш? 硫덉땅?덈떎. ?뱀쓬 ?숈븞 Notyx ?붾㈃??耳쒕몦 ?곹깭濡??좎??댁＜?몄슂.
            </div>
            <div class="rec-mode-grid">
              <button class="rec-mode-card" id="recPickLive">
                <div class="rec-mode-icon"><i data-lucide="mic"></i></div>
                <div class="rec-mode-title">吏곸젒 ?뱀쓬</div>
                <div class="rec-mode-sub">PC 쨌 ?덈뱶濡쒖씠??沅뚯옣</div>
              </button>
              <label class="rec-mode-card" for="recFileInput">
                <div class="rec-mode-icon"><i data-lucide="upload"></i></div>
                <div class="rec-mode-title">?ㅻ뵒???뚯씪 ?낅줈??/div>
                <div class="rec-mode-sub">mp3 쨌 m4a 쨌 wav 쨌 webm</div>
              </label>
              <input type="file" id="recFileInput" accept="audio/*,.m4a,.mp3,.wav,.webm,.ogg,.aac,.flac" style="display:none" />
            </div>
          </div>

          <!-- Recording / paused -->
          <div class="rec-screen rec-screen-live" data-screen="live">
            <div class="rec-timer" id="recTimer">00:00</div>
            <div class="rec-meter"><div class="rec-meter-bar" id="recMeterBar"></div></div>
            <div class="rec-status" id="recLiveStatus">?뱀쓬 以묅?/div>
            <div class="rec-actions">
              <button class="rec-btn rec-btn-secondary" id="recPauseBtn">?쇱떆?뺤?</button>
              <button class="rec-btn rec-btn-stop" id="recStopBtn">?뱀쓬 醫낅즺</button>
            </div>
            <button class="rec-cancel-link" id="recCancelLiveBtn">痍⑥냼</button>
          </div>

          <!-- Engine selector (live recording only) -->
          <div class="rec-screen rec-screen-engine-select" data-screen="engine-select">
            <div class="rec-engine-header">STT ?붿쭊 ?좏깮</div>
            <div class="rec-engine-duration" id="recEngineDurationLabel">?뱀쓬 ?쒓컙: 怨꾩궛 以묅?/div>
            <div class="rec-engine-options">
              <label class="rec-engine-option rec-engine-option--selected" id="recEngineOptAAI">
                <input type="radio" name="sttEngine" value="assemblyai" id="recEngineAssemblyAI" checked>
                <div>
                  <div class="rec-engine-option-title">湲곕낯 (AssemblyAI)</div>
                  <div class="rec-engine-option-desc">臾대즺 쨌 鍮좊쫫 쨌 ?뺥솗??蹂댄넻</div>
                </div>
              </label>
              <label class="rec-engine-option" id="recEngineOptGoogle">
                <input type="radio" name="sttEngine" value="google" id="recEngineGoogle">
                <div>
                  <div class="rec-engine-option-title">Google STT (Chirp_2)</div>
                  <div class="rec-engine-option-desc">?쒓뎅???뺥솗??理쒖긽 쨌 <span id="recEnginePriceLabel">1,500??</span></div>
                </div>
              </label>
            </div>
            <div class="rec-actions">
              <button class="rec-btn rec-btn-primary" id="recEngineProceedBtn">怨꾩냽 ??/button>
            </div>
            <button class="rec-cancel-link" id="recEngineCancelBtn">痍⑥냼 (?뱀쓬 ?뚭린)</button>
          </div>

          <!-- Uploading -->
          <div class="rec-screen rec-screen-upload" data-screen="upload">
            <div class="rec-progress-wrap">
              <div class="rec-progress-bar" id="recUploadBar"></div>
            </div>
            <div class="rec-status" id="recUploadStatus">?낅줈??以鍮?以묅?/div>
          </div>

          <!-- Transcribing (AssemblyAI polling) -->
          <div class="rec-screen rec-screen-stt" data-screen="stt">
            <div class="rec-stt-stages">
              <div class="rec-stt-stage rec-stt-stage--done" id="recSttStage1">
                <div class="rec-stt-stage-dot">??/div>
                <div class="rec-stt-stage-label">???낅줈??/div>
              </div>
              <div class="rec-stt-stage-line"></div>
              <div class="rec-stt-stage rec-stt-stage--active" id="recSttStage2">
                <div class="rec-stt-stage-dot rec-stt-stage-dot--spinner"></div>
                <div class="rec-stt-stage-label" id="recSttStage2Label">??蹂???湲?以?/div>
              </div>
              <div class="rec-stt-stage-line"></div>
              <div class="rec-stt-stage rec-stt-stage--pending" id="recSttStage3">
                <div class="rec-stt-stage-dot">??/div>
                <div class="rec-stt-stage-label">?щ’ 梨꾩슦湲?/div>
              </div>
            </div>
            <div class="rec-status" id="recSttStatus">?띿뒪??蹂???쒖옉 以묅?/div>
            <div class="rec-stt-elapsed" id="recSttElapsed">寃쎄낵 00:00</div>
            <div class="rec-stt-hint">蹂댄넻 媛뺤쓽 湲몄씠??30~50% ?쒓컙???뚯슂?⑸땲??(90遺?媛뺤쓽 ??30~45遺?</div>
            <div class="rec-stt-close-note">?뮕 ??李쎌쓣 ?レ븘??蹂?섏? 怨꾩냽?⑸땲?? 寃곌낵???먮룞?쇰줈 ?뱀랬濡??щ’??異붽??⑸땲??</div>
            <div class="rec-stt-long-warn" id="recSttLongWarn">?좑툘 湲?媛뺤쓽???쒓컙????嫄몃┫ ???덉뒿?덈떎. 議곌툑留?湲곕떎?ㅼ＜?몄슂.</div>
            <button class="rec-cancel-link" id="recHideSttBtn">李??リ린 (諛깃렇?쇱슫??吏꾪뻾)</button>
          </div>

          <!-- Completed -->
          <div class="rec-screen rec-screen-done" data-screen="done">
            <div class="rec-done-icon"><i data-lucide="check"></i></div>
            <div class="rec-status" id="recDoneStatus">蹂???꾨즺</div>
            <div class="rec-done-hint" id="recDoneHint">?뱀랬濡??щ’???띿뒪?멸? 異붽??섏뿀?듬땲?? 遺꾩꽍???쒖옉?섏꽭??</div>
            <div class="rec-done-byo-hint" id="recDoneBYOHint" style="font-size:0.75rem;color:var(--text-muted,#aaa);margin:0.4rem 0 0;line-height:1.45">?뮕 ?뺥솗?꾧? 遺議깊븯硫?<a href="https://clovanote.naver.com" target="_blank" rel="noopener" style="color:var(--accent,#7c9ef8)">?대줈諛붾끂??/a>?먯꽌 蹂????.txt ?낅줈??媛??/div>
            <div class="rec-actions">
              <button class="rec-btn rec-btn-secondary" id="recDoneCloseBtn">?뺤씤</button>
              <button class="rec-btn rec-btn-primary" id="recDoneGoNewBtn" style="display:none">?ㅼ쓬: 媛뺤쓽 ?먮즺 異붽??섍린 ??/button>
            </div>
          </div>

          <!-- Error -->
          <div class="rec-screen rec-screen-error" data-screen="error">
            <div class="rec-error-icon"><i data-lucide="alert-triangle"></i></div>
            <div class="rec-status" id="recErrorStatus">?ㅻ쪟媛 諛쒖깮?덉뒿?덈떎.</div>
            <div class="rec-actions">
              <button class="rec-btn rec-btn-primary" id="recErrorRetryBtn">?ㅼ떆 ?쒕룄</button>
            </div>
          </div>
        </div>

        <!-- Compact pill content (visible only when minimized) -->
        <div class="recorder-pill" id="recorderPill">
          <!-- Recording pill content -->
          <div id="recPillRecContent" style="display:flex;align-items:center;gap:8px;width:100%">
            <div class="rec-dot" id="recPillDot"></div>
            <div class="rec-pill-timer" id="recPillTimer">00:00</div>
            <button class="rec-pill-btn rec-pill-btn--pause"  id="recPillPauseBtn"  aria-label="?쇱떆?뺤?"></button>
            <button class="rec-pill-btn rec-pill-btn--stop"   id="recPillStopBtn"   aria-label="?뱀쓬 醫낅즺"></button>
            <button class="rec-pill-btn rec-pill-btn--expand" id="recPillExpandBtn" aria-label="?뺤옣"></button>
          </div>
          <!-- STT pill content -->
          <div id="recPillSttContent" style="display:none;align-items:center;gap:8px;width:100%">
            <div class="rec-pill-stt-spinner"></div>
            <div class="rec-pill-stt-label" id="recPillSttLabel">蹂??以묅?/div>
            <div class="rec-pill-stt-elapsed" id="recPillSttElapsed">00:00</div>
            <button class="rec-pill-btn rec-pill-btn--expand" id="recPillSttExpandBtn" aria-label="?뺤옣"></button>
          </div>
        </div>
      </div>
    `;
    document.body.appendChild(modalEl);

    // Set pill button icons (inline SVG ??no lucide mounting needed)
    modalEl.querySelector('#recPillPauseBtn').innerHTML     = SVG_PAUSE;
    modalEl.querySelector('#recPillStopBtn').innerHTML      = SVG_STOP;
    modalEl.querySelector('#recPillExpandBtn').innerHTML    = SVG_EXPAND;
    modalEl.querySelector('#recPillSttExpandBtn').innerHTML = SVG_EXPAND;

    // Wire static handlers
    modalEl.querySelector('#recCloseBtn').addEventListener('click', closeModalIfSafe);
    modalEl.querySelector('.recorder-backdrop').addEventListener('click', handleBackdropClick);
    modalEl.querySelector('#recMinimizeBtn').addEventListener('click', minimizePill);
    modalEl.querySelector('#recPickLive').addEventListener('click', startLiveRecording);
    modalEl.querySelector('#recFileInput').addEventListener('change', onFilePicked);
    modalEl.querySelector('#recPauseBtn').addEventListener('click', togglePause);
    modalEl.querySelector('#recStopBtn').addEventListener('click', stopRecording);
    modalEl.querySelector('#recCancelLiveBtn').addEventListener('click', cancelLiveRecording);
    modalEl.querySelector('#recHideSttBtn').addEventListener('click', minimizePill);
    modalEl.querySelector('#recDoneCloseBtn').addEventListener('click', hideModal);
    modalEl.querySelector('#recDoneGoNewBtn').addEventListener('click', () => {
      const file = modalState.pendingFile;
      hideModal();
      if (typeof switchView === 'function') switchView('new');
      if (file && typeof addRecSlot === 'function') {
        // Small delay so switchView finishes rendering before DOM manipulation
        setTimeout(() => addRecSlot(file), 80);
      }
    });
    modalEl.querySelector('#recErrorRetryBtn').addEventListener('click', () => switchScreen('idle'));

    // Engine selector
    modalEl.querySelector('#recEngineProceedBtn').addEventListener('click', onEngineProceed);
    modalEl.querySelector('#recEngineCancelBtn').addEventListener('click', cancelFromEngineSelect);
    modalEl.querySelectorAll('input[name="sttEngine"]').forEach(function (radio) {
      radio.addEventListener('change', function () {
        modalEl.querySelector('#recEngineOptAAI').classList.toggle('rec-engine-option--selected',
          modalEl.querySelector('#recEngineAssemblyAI').checked);
        modalEl.querySelector('#recEngineOptGoogle').classList.toggle('rec-engine-option--selected',
          modalEl.querySelector('#recEngineGoogle').checked);
      });
    });

    // Pill controls
    modalEl.querySelector('#recPillPauseBtn').addEventListener('click', togglePause);
    modalEl.querySelector('#recPillStopBtn').addEventListener('click', stopRecording);
    modalEl.querySelector('#recPillExpandBtn').addEventListener('click', expandPill);
    modalEl.querySelector('#recPillSttExpandBtn').addEventListener('click', expandPill);

    // Drag
    initPillDrag(
      modalEl.querySelector('#recorderPill'),
      modalEl.querySelector('.recorder-panel')
    );

    // Block ESC while minimized ??prevents accidental cancel via any external handler
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

  // ?? Backdrop click: auto-minimize during active recording or STT ??
  function handleBackdropClick() {
    if (modalState.phase === 'recording' || modalState.phase === 'paused' || modalState.phase === 'transcribing') {
      minimizePill();
    } else {
      closeModalIfSafe();
    }
  }

  // ?? Pill minimize / expand ???????????????????????????????
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
    const phase      = modalState.phase;
    const recContent = modalEl.querySelector('#recPillRecContent');
    const sttContent = modalEl.querySelector('#recPillSttContent');

    if (phase === 'transcribing') {
      if (recContent) recContent.style.display = 'none';
      if (sttContent) sttContent.style.display = 'flex';
      modalEl.classList.add('recorder-modal--stt');
    } else {
      if (recContent) recContent.style.display = 'flex';
      if (sttContent) sttContent.style.display = 'none';
      modalEl.classList.remove('recorder-modal--stt');
      modalEl.classList.remove('recorder-modal--stt-long');

      const dot      = modalEl.querySelector('#recPillDot');
      const pauseBtn = modalEl.querySelector('#recPillPauseBtn');
      if (dot && pauseBtn) {
        const paused = phase === 'paused';
        dot.classList.toggle('rec-dot--paused', paused);
        pauseBtn.innerHTML = paused ? SVG_PLAY : SVG_PAUSE;
        pauseBtn.setAttribute('aria-label', paused ? '?ш컻' : '?쇱떆?뺤?');
        const mainTimer = document.getElementById('recTimer');
        const pillTimer = document.getElementById('recPillTimer');
        if (mainTimer && pillTimer) pillTimer.textContent = mainTimer.textContent;
      }
    }
  }

  // ?? Pill drag (mouse + touch) ????????????????????????????
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

  // ?? Screen switching ?????????????????????????????????????
  function switchScreen(name) {
    if (!modalEl) return;
    modalEl.querySelectorAll('.rec-screen').forEach(el => {
      el.classList.toggle('active', el.dataset.screen === name);
    });
    modalState.screen = name;

    // Show minimize button on screens where backgrounding makes sense:
    // - 'live'         (recording in progress ??let it run in the background)
    // - 'stt'          (transcribing in progress ??same idea)
    // The grabber has `display: none` by default and switches to flex via
    // .is-visible ??toggling style.display directly would lose the flex
    // and break the bar/label layout.
    const minimizeBtn = modalEl.querySelector('#recMinimizeBtn');
    if (minimizeBtn) minimizeBtn.classList.toggle('is-visible', name === 'live' || name === 'stt');

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
      if (!confirm('?뱀쓬??痍⑥냼?섏떆寃좎뒿?덇퉴? ?꾩옱源뚯? ?뱀쓬???댁슜? ?щ씪吏묐땲??')) return;
      cancelLiveRecording();
      return;
    }
    if (modalState.phase === 'uploading') {
      if (!confirm('?낅줈?쒕? 痍⑥냼?섏떆寃좎뒿?덇퉴?')) return;
    }
    if (modalState.phase === 'transcribing') {
      minimizePill();
      return;
    }
    hideModal();
  }

  // ?? Live recording ??????????????????????????????????????
  async function startLiveRecording() {
    if (modalState.phase === 'transcribing') {
      window.showToast?.('?좑툘 ?댁쟾 蹂?섏씠 ?앸궃 ???쒖옉?섏꽭??');
      return;
    }
    if (!currentUser) {
      window.showToast?.('?뵎 濡쒓렇?????댁슜?????덉뒿?덈떎.');
      return;
    }
    if (typeof MediaRecorder === 'undefined' || !navigator.mediaDevices?.getUserMedia) {
      switchScreen('error');
      document.getElementById('recErrorStatus').textContent =
        '??釉뚮씪?곗????뱀쓬??吏?먰븯吏 ?딆뒿?덈떎. ?ㅻ뵒???뚯씪 ?낅줈?쒕? ?ъ슜?댁＜?몄슂.';
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
        '留덉씠??沅뚰븳??嫄곕??섏뿀?듬땲?? 釉뚮씪?곗? ?ㅼ젙?먯꽌 留덉씠???ъ슜???덉슜?댁＜?몄슂.';
      return;
    }

    modalState.mime = pickMimeType();
    try {
      modalState.rec = new MediaRecorder(modalState.stream, modalState.mime ? { mimeType: modalState.mime } : undefined);
    } catch (err) {
      console.error('[recorder] MediaRecorder init failed', err);
      releaseStream();
      switchScreen('error');
      document.getElementById('recErrorStatus').textContent = '?뱀쓬???쒖옉?????놁뒿?덈떎.';
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
    document.getElementById('recPauseBtn').textContent = '?쇱떆?뺤?';
    document.getElementById('recLiveStatus').textContent = '?뱀쓬 以묅?;
  }

  function startTimer() {
    if (modalState.timerHandle) clearInterval(modalState.timerHandle);
    modalState.timerHandle = setInterval(() => {
      const ms = (modalState.phase === 'recording')
        ? (modalState.elapsedAtPause + (Date.now() - modalState.startTime))
        : modalState.elapsedAtPause;
      const totalSec = Math.floor(ms / 1000);
      const h = Math.floor(totalSec / 3600);
      const m = String(Math.floor(totalSec / 60) % 60).padStart(2, '0');
      const s = String(totalSec % 60).padStart(2, '0');
      const timeStr = h > 0 ? `${h}:${m}:${s}` : `${m}:${s}`;
      const el = document.getElementById('recTimer');
      if (el) el.textContent = timeStr;
      // Mirror to pill timer while minimized
      const pillTimer = document.getElementById('recPillTimer');
      if (pillTimer) pillTimer.textContent = timeStr;
    }, 250);
    // Must set phase AFTER wiring the interval ??phase drives the ms calculation above
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
      // Audio meter is decorative ??silent fallback is fine
    }
  }

  function togglePause() {
    if (!modalState.rec) return;
    if (modalState.rec.state === 'recording') {
      modalState.rec.pause();
      modalState.elapsedAtPause += Date.now() - modalState.startTime;
      modalState.phase = 'paused';
      document.getElementById('recPauseBtn').textContent = '?ш컻';
      document.getElementById('recLiveStatus').textContent = '?쇱떆?뺤???;
    } else if (modalState.rec.state === 'paused') {
      modalState.rec.resume();
      modalState.startTime = Date.now();
      modalState.phase = 'recording';
      document.getElementById('recPauseBtn').textContent = '?쇱떆?뺤?';
      document.getElementById('recLiveStatus').textContent = '?뱀쓬 以묅?;
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
        '?뱀쓬???댁슜???덈Т 吏㏃뒿?덈떎. ?ㅼ떆 ?쒕룄?댁＜?몄슂.';
      return;
    }

    // Capture total duration; paused time already in elapsedAtPause
    const finalMs = modalState.phase === 'recording'
      ? modalState.elapsedAtPause + (Date.now() - modalState.startTime)
      : modalState.elapsedAtPause;
    modalState.recordingDurationSec = Math.max(1, Math.floor(finalMs / 1000));

    const filename = 'recording_' + new Date().toISOString().replace(/[:.]/g, '-') + '.' + ext;

    // Store pending audio, reset engine choice, show selector
    modalState.pendingBlob = blob;
    modalState.pendingFilename = filename;
    modalState.sttEngine = 'assemblyai';
    showEngineSelector();
  }

  // ?? Engine selector (live recording only) ??????????????
  function showEngineSelector() {
    const durationMin = Math.ceil(modalState.recordingDurationSec / 60);
    const { minutes, priceKRW } = (typeof priceFor === 'function')
      ? priceFor(durationMin)
      : { minutes: Math.ceil(durationMin / 30) * 30, priceKRW: 1500 };

    const durLbl = document.getElementById('recEngineDurationLabel');
    if (durLbl) durLbl.textContent = '?뱀쓬 ?쒓컙: ' + durationMin + '遺?;

    const priceLbl = document.getElementById('recEnginePriceLabel');
    if (priceLbl) priceLbl.textContent = priceKRW.toLocaleString() + '??';

    // Reset to default
    const aaiRadio = document.getElementById('recEngineAssemblyAI');
    if (aaiRadio) aaiRadio.checked = true;
    if (modalEl) {
      modalEl.querySelector('#recEngineOptAAI')?.classList.add('rec-engine-option--selected');
      modalEl.querySelector('#recEngineOptGoogle')?.classList.remove('rec-engine-option--selected');
    }

    switchScreen('engine-select');
  }

  async function onEngineProceed() {
    const selected = modalEl?.querySelector('input[name="sttEngine"]:checked')?.value || 'assemblyai';
    modalState.sttEngine = selected;

    if (selected === 'google') {
      const durationMin = Math.ceil(modalState.recordingDurationSec / 60);
      const { minutes, priceKRW } = (typeof priceFor === 'function')
        ? priceFor(durationMin)
        : { minutes: Math.ceil(durationMin / 30) * 30, priceKRW: 1500 };

      const confirmed = confirm(
        `??媛뺤쓽??${minutes}遺꾩엯?덈떎.\nGoogle STT 蹂??鍮꾩슜: ${priceKRW.toLocaleString()}??n寃곗젣?섏떆寃좎뒿?덇퉴?`
      );
      if (!confirmed) return; // stay on engine selector

      try {
        if (typeof payForSttEntitlement !== 'function') throw new Error('寃곗젣 紐⑤뱢??濡쒕뱶?섏? ?딆븯?듬땲??');
        await payForSttEntitlement(durationMin);
        // payment succeeded ??sttEngine stays 'google'
      } catch (e) {
        // payment cancelled or failed ??fall back to assemblyai automatically
        modalState.sttEngine = 'assemblyai';
        window.showToast?.('寃곗젣 痍⑥냼 ??湲곕낯 STT濡?吏꾪뻾?⑸땲??);
      }
    }

    const blob = modalState.pendingBlob;
    const filename = modalState.pendingFilename;
    modalState.pendingBlob = null;
    modalState.pendingFilename = null;
    handleAudioBlob(blob, filename);
  }

  function cancelFromEngineSelect() {
    modalState.pendingBlob = null;
    modalState.pendingFilename = null;
    modalState.sttEngine = 'assemblyai';
    hideModal();
  }

  // ?? File upload entry ???????????????????????????????????
  function onFilePicked(ev) {
    const file = ev.target.files && ev.target.files[0];
    ev.target.value = '';
    if (!file) return;
    if (modalState.phase === 'transcribing') {
      window.showToast?.('?좑툘 ?댁쟾 蹂?섏씠 ?앸궃 ???쒖옉?섏꽭??');
      return;
    }
    if (!currentUser) {
      window.showToast?.('?뵎 濡쒓렇?????댁슜?????덉뒿?덈떎.');
      return;
    }
    if (file.size > 500 * 1024 * 1024) {
      switchScreen('error');
      document.getElementById('recErrorStatus').textContent =
        '?뚯씪???덈Т ?쎈땲??(理쒕? 500MB). ???묒? ?뚯씪???ъ슜?댁＜?몄슂.';
      return;
    }
    modalState.sttEngine = 'assemblyai'; // file uploads always use free AssemblyAI path
    handleAudioBlob(file, file.name);
  }

  // ?? Upload to Firebase Storage + AssemblyAI pipeline ???
  async function handleAudioBlob(blob, filename) {
    if (!currentUser) {
      window.showToast?.('?뵎 濡쒓렇?????댁슜?????덉뒿?덈떎.');
      return;
    }
    switchScreen('upload');
    document.getElementById('recUploadStatus').textContent = '?낅줈??以묅?;
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
        if (lbl) lbl.textContent = `?낅줈??以묅?${pct.toFixed(0)}%`;
      });
      await task;
      downloadUrl = await ref.getDownloadURL();
    } catch (err) {
      console.error('[recorder] storage upload failed', err);
      switchScreen('error');
      document.getElementById('recErrorStatus').textContent =
        '?낅줈?쒖뿉 ?ㅽ뙣?덉뒿?덈떎. ?명꽣???곌껐???뺤씤?댁＜?몄슂.';
      return;
    }

    switchScreen('stt');
    modalState.phase = 'transcribing';
    document.getElementById('recSttStatus').textContent = '?띿뒪??蹂???쒖옉 以묅?;

    // Determine STT endpoint based on selected engine
    const sttApi = modalState.sttEngine === 'google' ? '/api/google-stt' : '/api/assemblyai';

    // Track when polling started for elapsed display and long-wait warning
    modalState.pollStart = Date.now();

    // MM:SS elapsed counter ??updates every second while STT is in progress
    if (modalState.sttElapsedHandle) clearInterval(modalState.sttElapsedHandle);
    modalState.sttElapsedHandle = setInterval(() => {
      const sec = Math.floor((Date.now() - modalState.pollStart) / 1000);
      const mm  = String(Math.floor(sec / 60)).padStart(2, '0');
      const ss  = String(sec % 60).padStart(2, '0');
      const el  = document.getElementById('recSttElapsed');
      if (el) el.textContent = `寃쎄낵 ${mm}:${ss}`;
      const pillElapsed = document.getElementById('recPillSttElapsed');
      if (pillElapsed) pillElapsed.textContent = `${mm}:${ss}`;
      if (sec >= 300) {
        const warn = document.getElementById('recSttLongWarn');
        if (warn) warn.style.display = '';
        if (modalEl) modalEl.classList.add('recorder-modal--stt-long');
      }
    }, 1000);

    let transcriptId;
    try {
      const idToken = await currentUser.getIdToken();
      const tr = await fetch(sttApi + '?action=transcribe', {
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
        '?띿뒪??蹂?섏쓣 ?쒖옉?섏? 紐삵뻽?듬땲?? (' + (err.message || 'unknown') + ')';
      return;
    }

    document.getElementById('recSttStatus').textContent = '?湲곗뿴?먯꽌 李⑤?瑜?湲곕떎由щ뒗 以묅?;
    const pollStart = Date.now();
    const POLL_INTERVAL = 6000;
    const MAX_POLL_MS = 90 * 60 * 1000;

    async function poll() {
      try {
        const idToken = await currentUser.getIdToken();
        const r = await fetch(sttApi + '?action=status&id=' + encodeURIComponent(transcriptId), {
          headers: { 'authorization': 'Bearer ' + idToken },
        });
        const j = await r.json();
        if (!r.ok) {
          throw new Error(j.error || 'status_failed');
        }
        const lbl      = document.getElementById('recSttStatus');
        const stLabel  = document.getElementById('recSttStage2Label');
        const pillLbl  = document.getElementById('recPillSttLabel');

        if (j.status === 'queued') {
          lbl.textContent = '?湲곗뿴?먯꽌 李⑤?瑜?湲곕떎由щ뒗 以묅?;
          if (stLabel)  stLabel.textContent = '??蹂???湲?以?;
          if (pillLbl)  pillLbl.textContent = '?湲?以묅?;
        } else if (j.status === 'processing') {
          lbl.textContent = '?띿뒪??蹂??以묅?;
          if (stLabel)  stLabel.textContent = '???띿뒪??蹂??以?;
          if (pillLbl)  pillLbl.textContent = '蹂??以묅?;
        } else if (j.status === 'completed') {
          deliverTranscript(j.text || '', filename);
          return;
        } else if (j.status === 'error') {
          throw new Error(j.error_msg || 'transcription_error');
        }

        if (Date.now() - pollStart > MAX_POLL_MS) {
          throw new Error('泥섎━ ?쒓컙???덈Т ?ㅻ옒 嫄몃┰?덈떎. ?좎떆 ???ㅼ떆 ?쒕룄?댁＜?몄슂.');
        }
        modalState.pollHandle = setTimeout(poll, POLL_INTERVAL);
      } catch (err) {
        console.error('[recorder] poll failed', err);
        if (modalState.sttElapsedHandle) { clearInterval(modalState.sttElapsedHandle); modalState.sttElapsedHandle = null; }
        modalState.phase = 'error';
        if (modalEl) {
          modalEl.classList.remove('recorder-modal--minimized');
          modalEl.classList.remove('recorder-modal--stt');
          modalEl.classList.remove('recorder-modal--stt-long');
          modalEl.classList.remove('hidden');
          const panelEl = modalEl.querySelector('.recorder-panel');
          if (panelEl) { panelEl.style.left = ''; panelEl.style.top = ''; }
        }
        switchScreen('error');
        document.getElementById('recErrorStatus').textContent =
          '蹂??以??ㅻ쪟媛 諛쒖깮?덉뒿?덈떎. (' + (err.message || 'unknown') + ')';
      }
    }
    modalState.pollHandle = setTimeout(poll, 1500);
  }

  function formatElapsed(sec) {
    const m = Math.floor(sec / 60);
    const s = sec % 60;
    if (m === 0) return `${s}珥?;
    return `${m}遺?${s}珥?;
  }

  async function deliverTranscript(text, sourceFilename) {
    if (modalState.pollHandle) { clearTimeout(modalState.pollHandle); modalState.pollHandle = null; }

    const cleanText = (text || '').trim();
    if (!cleanText) {
      switchScreen('error');
      document.getElementById('recErrorStatus').textContent =
        '蹂?섎맂 ?띿뒪?멸? 鍮꾩뼱?덉뒿?덈떎. ?뱀쓬 ?뚯씪???뺤씤?댁＜?몄슂.';
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
        window.showToast?.('?좑툘 ?뱀랬濡??먮룞 ??μ뿉 ?ㅽ뙣?덉뒿?덈떎. ?щ’?먮뒗 異붽??⑸땲??');
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

    // Clear STT elapsed interval now that we're done processing
    if (modalState.sttElapsedHandle) { clearInterval(modalState.sttElapsedHandle); modalState.sttElapsedHandle = null; }
    modalState.phase = 'completed';

    // Briefly advance stage tracker: stage 2 ??done, stage 3 ??active
    const _st2 = document.getElementById('recSttStage2');
    const _st3 = document.getElementById('recSttStage3');
    if (_st2) _st2.className = 'rec-stt-stage rec-stt-stage--done';
    if (_st3) _st3.className = 'rec-stt-stage rec-stt-stage--active';

    // Step 3: feed text into new-note slots (existing behavior)
    const baseName = (sourceFilename || 'recording').replace(/\.[^.]+$/, '');
    const file = new File([cleanText], baseName + '.txt', { type: 'text/plain' });

    // Always keep a reference so the "?ㅼ쓬" CTA can add it later if needed
    modalState.pendingFile = file;

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
      const lenLabel   = `${cleanText.length.toLocaleString()}??;
      const savedLabel = savedTranscript ? ' 쨌 ???뱀랬濡앹뿉 ??λ맖' : '';
      status.textContent = `蹂???꾨즺 쨌 ${lenLabel}${savedLabel}`;
    }

    // Tailor done-screen hint and CTA based on whether the slot was filled
    const doneHint = document.getElementById('recDoneHint');
    const goNewBtn = document.getElementById('recDoneGoNewBtn');
    const closeBtn = document.getElementById('recDoneCloseBtn');
    if (didFillSlot && _currentView === 'new') {
      // User already on new-note view, slot populated ??just confirm
      if (doneHint) doneHint.textContent = 'PPT/PDF瑜?異붽??섎㈃ AI ?명듃 遺꾩꽍??諛붾줈 ?쒖옉?????덉뒿?덈떎.';
      if (goNewBtn) goNewBtn.style.display = 'none';
      if (closeBtn) { closeBtn.textContent = '?뺤씤'; closeBtn.className = 'rec-btn rec-btn-primary'; }
    } else {
      // User on home/transcripts or slot not filled ??show navigation CTA
      if (doneHint) doneHint.textContent = '???뱀랬濡앹뿉 ??λ릺?덉뒿?덈떎. ???명듃?먯꽌 媛뺤쓽 ?먮즺? ?④퍡 AI 遺꾩꽍???쒖옉?대낫?몄슂.';
      if (goNewBtn) goNewBtn.style.display = '';
      if (closeBtn) { closeBtn.textContent = '?リ린'; closeBtn.className = 'rec-btn rec-btn-secondary'; }
    }

    // Surface the modal if the user had hidden or minimized it during background processing
    if (modalEl && (modalEl.classList.contains('hidden') || modalEl.classList.contains('recorder-modal--minimized'))) {
      modalEl.classList.remove('hidden');
      modalEl.classList.remove('recorder-modal--minimized');
      modalEl.classList.remove('recorder-modal--stt');
      modalEl.classList.remove('recorder-modal--stt-long');
      const panelEl = modalEl.querySelector('.recorder-panel');
      if (panelEl) { panelEl.style.left = ''; panelEl.style.top = ''; }
    }

    if (didFillSlot && savedTranscript) {
      window.showToast?.('?럺截??뱀랬濡앹씠 ?щ’??異붽??섍퀬 ???뱀랬濡앹뿉????λ릺?덉뒿?덈떎.');
    } else if (savedTranscript) {
      window.showToast?.('?럺截????뱀랬濡앹뿉 ??λ릺?덉뒿?덈떎. ???명듃?먯꽌 ?쒖슜?대낫?몄슂!');
    } else if (didFillSlot) {
      window.showToast?.('?럺截??뱀랬濡앹씠 異붽??섏뿀?듬땲??');
    }
  }

  // ?? Public entry ????????????????????????????????????????
  window.openRecorderModal = function (targetSlotId) {
    showModal(targetSlotId);
  };
})();
