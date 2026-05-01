// Global constants, shared state, DOM refs, Firebase init.
// Loaded BEFORE the main inline script. Everything else depends on this.

// ===== Firebase init =====
const firebaseConfig = {
  apiKey: "AIzaSyC68aMiCvyfR3QycxUknmxB3z7NS0qRE2g",
  authDomain: "lazyuniv-ai.firebaseapp.com",
  projectId: "lazyuniv-ai",
  storageBucket: "lazyuniv-ai.firebasestorage.app",
  messagingSenderId: "152431469306",
  appId: "1:152431469306:web:a7292a51bd41b31a229f43"
};
firebase.initializeApp(firebaseConfig);
const auth    = firebase.auth();
const db      = firebase.firestore();
const storage = firebase.storage();
let currentUser = null;

// ===== PDF.js lazy-load slot =====
let pdfjsLib = null;

// ===== Debug logger =====
const _debugLog = [];
function debugLog(tag, msg, data = null) {
  const ts = ((performance.now()) / 1000).toFixed(1) + 's';
  const entry = `[${ts}][${tag}] ${msg}` + (data != null ? ' | ' + (typeof data === 'string' ? data : JSON.stringify(data)) : '');
  _debugLog.push(entry);
  console.log(entry);
}

// ===== Constants =====
const MAX_ITERATIONS        = 2;
const USE_ADVISOR = false;  // DISABLED: advisor never invoked, only adds latency
const MAX_FILE_SIZE_BYTES  = 200 * 1024 * 1024;  // 200MB hard limit
const WARN_FILE_SIZE_BYTES = 100 * 1024 * 1024;  // 100MB soft warning
const MAX_PDF_PAGES        = 200;                  // hard page count limit
const WARN_PDF_PAGES       = 100;                  // soft page count warning
const DEVELOPER_EMAILS = ['jhyun.kim35@gmail.com'];
const MAX_TOKENS_NOTES      = 24000;
const MAX_TOKENS_CRITIQUE   = 4096;
const DONE_SIGNAL           = '검토 완료 — 수정 필요 없음';
const TOAST_DURATION_MS     = 5000;
const PROGRESS_HIDE_DELAY_MS = 1200;  // used by setProgress(null)

const FOLDER_COLORS = [
  { name: '기본', value: 'var(--text-muted)' },
  { name: '빨강', value: '#ef4444' },
  { name: '주황', value: '#f97316' },
  { name: '노랑', value: '#eab308' },
  { name: '초록', value: '#22c55e' },
  { name: '파랑', value: '#3b82f6' },
  { name: '보라', value: '#8b5cf6' },
  { name: '분홍', value: '#ec4899' },
];

const REC_ORDINALS = ['1교시','2교시','3교시','4교시','5교시','6교시','7교시','8교시','9교시','10교시'];
const QUIZ_CHOICES_PREFIX = ['①', '②', '③', '④', '⑤'];
const CLASSIFY_LABELS = { theory: '이론', research: '연구', case: '사례', other: '기타' };
const CLASSIFY_COLORS = { theory: '#7c3aed', research: '#0ea5e9', case: '#10b981', other: '#6b7280' };
const DB_NAME    = 'meetingAppDB';
const DB_VERSION = 3;

const AGENT_META = {
  1: { icon: '📝', name: '노트 작성자' },
  2: { icon: '🔍', name: '비평가'      },
};

// ===== Mutable shared state =====
let pptFile  = null;
let txtFiles = [];   // [{id, file}] — ordered slots for multi-recording
let recIdCounter   = 0;

let storedPptText              = '';
let storedFilteredText         = '';
let storedNotesText            = '';
let storedHighlightedTranscript = '';

let extractedImages    = [];   // [{slideNumber, imageBase64, mimeType, fileName}]
let recommendedSlides  = [];   // [slideNumber, ...]
let imageAnalysisMode  = 'text';   // 'text' = Mode 1 (free) | 'vision' = Mode 2 (paid)
let visionModel        = 'haiku';  // 'haiku' | 'sonnet'
let imageDescriptions  = {};       // slideNumber → description (Mode 2 only)

let isRunning      = false;      // double-click guard
let abortController = null;      // cancel support
let currentNoteId  = null;       // id of the note currently loaded
let _accordionOpenLabels = new Set();
let _noteDrag      = null;       // active pointer-drag state object
let _lastGenerationError = '';   // last pipeline error message for debug report

let _classifyCache = null;       // { noteId, items } — cleared when different note loaded

let isBatchMode = false;
let batchQueue  = [];   // [{id, pptFile, txtFile, status}]
let batchIdCounter = 0;
let _batchRunning      = false;
let _batchProgress     = { done: 0, total: 0 };
let _batchBuddyVisible = false; // true while buddy should float over non-batch views
let batchPptStaging = null;
let batchSessionStaging = []; // [{id, txtFile, professorNum}]
let batchSessionIdCounter = 0;

let _currentNotionNoteId = null;
let _currentView = 'home';
let _activeFolderId = null; // null=all, 'none'=uncategorized, uuid=folder

// B1: per-analysis UUID, set in pipeline.js runAgentPipeline start, cleared
// in finally. api.js auto-injects this into every billable fetch body so
// the server can bill the analysis exactly once regardless of how many
// agent calls happen inside it. null when no pipeline is running.
let _currentAnalysisId = null;

let toastTimer;

let _bulkSelectMode = false;
const _selectedNoteIds = new Set();

let feedStartTime = null;
let elapsedTimer = null;
let elapsedStart = null;
let iterChipData = [];
let _notesCollapsed = false;
let progressHideTimer = null;

// ===== Cached DOM refs =====
// CAUTION: this file is loaded just before the main inline <script> in <body>,
// so all elements below are already parsed when these lines run.
const apiKeyEl   = document.getElementById('apiKey');
const analyzeBtn = document.getElementById('analyzeBtn');
const resultsEl  = document.getElementById('results');
const toast      = document.getElementById('toast');

const quizBtn         = document.getElementById('quizBtn');
const notionCopyBtn   = document.getElementById('notionCopyBtn');
const dlNotionFileBtn = document.getElementById('dlNotionFileBtn');
const copyNotesBtn    = document.getElementById('copyNotesBtn');
const dlTxtBtn        = document.getElementById('dlTxtBtn');
const dlMdBtn         = document.getElementById('dlMdBtn');
const dlPdfBtn        = document.getElementById('dlPdfBtn');
const splitViewBtn    = document.getElementById('splitViewBtn');

const progressWrap  = document.getElementById('progressWrap');
const progressFill  = document.getElementById('progressFill');
const progressLabel = document.getElementById('progressLabel');
const progressPct   = document.getElementById('progressPct');

// ===== Helpers =====
/* Sleep that rejects immediately when the user clicks cancel.
   Plain setTimeout ignores AbortSignal, so a 429 retry wait of up to
   30 s would appear frozen after the user presses the cancel button. */
function abortableSleep(ms) {
  return new Promise((resolve, reject) => {
    if (abortController?.signal.aborted) {
      reject(new DOMException('Aborted', 'AbortError'));
      return;
    }
    const timer = setTimeout(resolve, ms);
    abortController?.signal.addEventListener('abort', () => {
      clearTimeout(timer);
      reject(new DOMException('Aborted', 'AbortError'));
    }, { once: true });
  });
}

function uuidv4() {
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, c => {
    const r = Math.random() * 16 | 0;
    return (c === 'x' ? r : (r & 0x3 | 0x8)).toString(16);
  });
}
