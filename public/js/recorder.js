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
  // Chrome/FF/Edge usually do webm/opus. iOS Safari only does mp4/aac.
  // We let MediaRecorder pick a default it actually supports.
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
    return ''; // browser default
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
      || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1); // iPadOS desktop UA
  }

  // ── Modal singleton ─────────────────────────────────────
  let modalEl = null;
  let modalState = {
    phase: 'idle', // idle | requesting | recording | paused | uploading | transcribing | completed | error
    rec: null,            // MediaRecorder
    chunks: [],           // Blob[]
    stream: null,         // MediaStream
    mime: '',
    startTime: 0,
    elapsedAtPause: 0,
    timerHandle: null,
    levelHandle: null,
    audioCtx: null,
    analyser: null,
    pollHandle: null,
    targetSlotId: null,   // existing rec slot id, if user clicked '녹음' on an empty slot
    objectUrl: null,      // for preview playback
    // ── Recorded-audio bookkeeping (new in transcript-store flow) ──
    // We hold onto Storage path + total recording duration so that, after
    // STT completes, we can:
    //   1. save the transcript to the user's transcript store with metadata
    //   2. delete the original audio (per user's "audio: delete after STT"
    //      decision — saves a lot of Storage quota)
    audioStoragePath: null,   // 'users/{uid}/recordings/{ts}_..._name.ext'
    recordingDurationSec: null, // null for file uploads (no duration knowable cheaply)
  };

  function ensureModal() {
    if (modalEl) return modalEl;
    modalEl = document.createElement('div');
    modalEl.id = 'recorderModal';
    modalEl.className = 'recorder-modal hidden';
    modalEl.innerHTML = `
      <div class="recorder-backdrop"></div>
      <div class="recorder-panel" role="dialog" aria-modal="true" aria-label="녹음">
        <div class="recorder-head">
          <div class="recorder-title" id="recTitle">녹음하기</div>
          <button class="recorder-close" id="recCloseBtn" aria-label="닫기">×</button>
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
                <div class="rec-mode-icon">●</div>
                <div class="rec-mode-title">직접 녹음</div>
                <div class="rec-mode-sub">PC · 안드로이드 권장</div>
              </button>
              <label class="rec-mode-card" for="recFileInput">
                <div class="rec-mode-icon">↑</div>
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
            <div class="rec-done-icon">✓</div>
            <div class="rec-status" id="recDoneStatus">변환 완료</div>
            <div class="rec-done-hint">녹취록 슬롯에 텍스트가 추가되었습니다. 분석을 시작하세요.</div>
            <div class="rec-actions">
              <button class="rec-btn rec-btn-primary" id="recDoneCloseBtn">확인</button>
            </div>
          </div>

          <!-- Error -->
          <div class="rec-screen rec-screen-error" data-screen="error">
            <div class="rec-error-icon">!</div>
            <div class="rec-status" id="recErrorStatus">오류가 발생했습니다.</div>
            <div class="rec-actions">
              <button class="rec-btn rec-btn-primary" id="recErrorRetryBtn">다시 시도</button>
            </div>
          </div>
        </div>
      </div>
    `;
    document.body.appendChild(modalEl);

    // Wire static handlers — only need to do this once
    modalEl.querySelector('#recCloseBtn').addEventListener('click', closeModalIfSafe);
    modalEl.querySelector('.recorder-backdrop').addEventListener('click', closeModalIfSafe);
    modalEl.querySelector('#recPickLive').addEventListener('click', startLiveRecording);
    modalEl.querySelector('#recFileInput').addEventListener('change', onFilePicked);
    modalEl.querySelector('#recPauseBtn').addEventListener('click', togglePause);
    modalEl.querySelector('#recStopBtn').addEventListener('click', stopRecording);
    modalEl.querySelector('#recCancelLiveBtn').addEventListener('click', cancelLiveRecording);
    modalEl.querySelector('#recHideSttBtn').addEventListener('click', hideModal);
    modalEl.querySelector('#recDoneCloseBtn').addEventListener('click', hideModal);
    modalEl.querySelector('#recErrorRetryBtn').addEventListener('click', () => switchScreen('idle'));

    return modalEl;
  }

  function switchScreen(name) {
    if (!modalEl) return;
    modalEl.querySelectorAll('.rec-screen').forEach(el => {
      el.classList.toggle('active', el.dataset.screen === name);
    });
    modalState.phase = name;
  }

  function showModal(targetSlotId = null) {
    ensureModal();
    modalState.targetSlotId = targetSlotId;
    modalEl.classList.remove('hidden');
    document.getElementById('recIosWarn').style.display = isiOS() ? 'block' : 'none';
    switchScreen('idle');
  }

  function hideModal() {
    if (modalEl) modalEl.classList.add('hidden');
  }

  function closeModalIfSafe() {
    // Don't let user close while recording — would lose audio. They have to
    // hit "녹음 종료" or "취소".
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

    // Use a small timeslice so dataavailable fires periodically — keeps memory
    // bounded and lets us recover something if the tab crashes mid-record.
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
      const el = document.getElementById('recTimer');
      if (el) el.textContent = h > 0 ? `${h}:${m}:${s}` : `${m}:${s}`;
    }, 250);
    // Re-set phase to recording so the timer math above works
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
        modalState.analyser.getByteTimeDomainData(buf);
        // RMS amplitude
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
  }

  function stopRecording() {
    if (!modalState.rec) return;
    if (modalState.rec.state !== 'inactive') {
      modalState.rec.stop(); // triggers onRecorderStopped
    }
  }

  function cancelLiveRecording() {
    if (modalState.rec && modalState.rec.state !== 'inactive') {
      // Detach the stop handler so we don't try to upload a half-blob
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

    // Capture total duration (paused chunks already accumulated into elapsedAtPause;
    // if we stopped while still recording, add the final running segment).
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
    ev.target.value = ''; // allow picking same file again later
    if (!file) return;
    if (!currentUser) {
      window.showToast?.('🔑 로그인 후 이용할 수 있습니다.');
      return;
    }
    // Cap at 500 MB — AssemblyAI accepts huge files but our UX assumes
    // one lecture at a time.
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

    // Remember path so deliverTranscript can delete the audio after STT.
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

    // Kick off transcription
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

    // Poll status
    document.getElementById('recSttStatus').textContent = '텍스트 변환 중… (대기열)';
    const pollStart = Date.now();
    const POLL_INTERVAL = 6000;
    const MAX_POLL_MS = 90 * 60 * 1000; // 90 min hard cap

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

        if (j.status === 'queued')         lbl.textContent = `대기열에서 차례를 기다리는 중… (${elapsedLabel})`;
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
    modalState.pollHandle = setTimeout(poll, 1500); // first poll quickly
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

    // ── Step 1: persist to the user's transcript store ───────────────
    // This MUST happen before we touch the new-note slots, because the
    // user's primary expectation now is "every recording I make ends up
    // in 내 녹취록". Slot integration is a secondary convenience and
    // will silently no-op when nobody's on the new-note page.
    let savedTranscript = null;
    if (typeof saveTranscriptFS === 'function') {
      try {
        savedTranscript = await saveTranscriptFS({
          text: cleanText,
          audioFilename: sourceFilename || '',
          durationSec: modalState.recordingDurationSec,
        });
      } catch (err) {
        // Non-fatal — we still want to deliver the text into a slot below
        // so the user can at least analyze it right now. We just couldn't
        // save it for later. Surface this loudly though, because losing a
        // 90-min lecture's transcript silently would be terrible.
        console.error('[recorder] saveTranscriptFS failed:', err);
        window.showToast?.('⚠️ 녹취록 자동 저장에 실패했습니다. 슬롯에는 추가됩니다.');
      }
    }

    // ── Step 2: delete the original audio from Storage ───────────────
    // User chose "delete after STT" for cost reasons. Best-effort —
    // a stray audio file is fine, just chews quota.
    if (modalState.audioStoragePath) {
      const pathToDelete = modalState.audioStoragePath;
      modalState.audioStoragePath = null;
      storage.ref(pathToDelete).delete().catch((e) => {
        console.warn('[recorder] audio delete failed (non-fatal):', e.message);
      });
    }

    // ── Step 3: feed text into the new-note slots (existing behavior) ─
    // Wrap as a File so the existing pipeline (which reads .file.text())
    // accepts it transparently.
    const baseName = (sourceFilename || 'recording').replace(/\.[^.]+$/, '');
    const file = new File([cleanText], baseName + '.txt', { type: 'text/plain' });

    // Find an empty slot to fill, or push a new one.
    let didFillSlot = false;
    if (modalState.targetSlotId != null && typeof setRecSlotFile === 'function') {
      setRecSlotFile(modalState.targetSlotId, file);
      didFillSlot = true;
    } else {
      // Try to fill the first empty existing slot — feels more natural than always appending.
      const emptySlot = (typeof txtFiles !== 'undefined') ? txtFiles.find(s => !s.file) : null;
      if (emptySlot && typeof setRecSlotFile === 'function') {
        setRecSlotFile(emptySlot.id, file);
        didFillSlot = true;
      } else if (typeof addRecSlot === 'function' && _currentView === 'new') {
        // Only auto-append a new slot when the user is actually on the
        // new-note page — otherwise this would silently mutate slot
        // state for a future analysis and surprise the user. When they
        // recorded from home, the transcript is already in the store.
        addRecSlot(file);
        didFillSlot = true;
      }
    }

    switchScreen('done');
    const status = document.getElementById('recDoneStatus');
    if (status) {
      const lenLabel = `${cleanText.length.toLocaleString()}자`;
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
