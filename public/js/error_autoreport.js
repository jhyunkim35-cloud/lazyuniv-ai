// Automatic error capture -> bugReports Firestore collection (source:'auto').
// Phase C of the bug-report system:
//   Phase A = rolling console buffer + Sentry breadcrumbs (constants.js)
//   Phase B = manual report modal (bug_report.js)
//   Phase C = this file: detect errors and file a report with no user action
//
// Triggers:
//   - Uncaught exceptions          (window 'error' event)
//   - Unhandled promise rejections ('unhandledrejection' event)
//   - API/backend errors           (api.js calls window.reportAutoError on !res.ok)
//
// Guards (spam / cost / loop protection -- the whole point of this file):
//   - Reentrancy flag    : the reporter never reports its own failure
//   - Signature dedup    : the same error is reported at most once per session
//   - Session cap        : at most MAX_AUTO_REPORTS auto-reports per page load
//   - Noise filter       : cross-origin "Script error.", ResizeObserver loop,
//                          and errors from non-app scripts (extensions) are dropped
//   - Auth required      : bugReports rules need request.auth; logged-out errors
//                          are left to Sentry only (cannot satisfy the rule)
//
// Privacy: identical contract to the manual modal. NEVER includes note content,
// transcript text, quiz data, Firebase ID tokens, or payment keys. recentLogs
// is trimmed to AUTO_LOG_LINES.

(function () {
  'use strict';

  const MAX_AUTO_REPORTS = 12;     // hard per-session cap
  const AUTO_LOG_LINES   = 80;     // trimmed breadcrumb buffer for auto reports
  const STACK_MAX        = 2000;   // trim stack so docs stay small

  let _sent = 0;                   // accepted reports this session
  let _reporting = false;          // reentrancy guard
  const _seen = new Set();         // signatures already reported

  // Return true for known-benign / un-actionable noise that should be dropped.
  function isNoise(message, filename, stack) {
    const m = (message == null ? '' : String(message)).trim();
    // Cross-origin script errors arrive as a bare "Script error." with no
    // usable stack -- almost always a browser extension (incl. the dev's own
    // MAX-AI) or a third-party script. Nothing we can fix.
    if (/^Script error\.?$/i.test(m) && !stack) return true;
    // Benign layout-thrash warning some browsers raise; not a real bug.
    if (/ResizeObserver loop/i.test(m)) return true;
    // Errors whose source file is not one of our own scripts (extension /
    // injected third-party code). Empty filename => allow (inline/app code).
    if (filename) {
      try {
        const host = new URL(filename, location.href).host;
        if (host && host !== location.host) return true;
      } catch (_) { /* unparseable -- let it through */ }
    }
    return false;
  }

  function signatureOf(kind, message, stack) {
    const firstFrame = String(stack || '').split('\n').find(l => /:\d+:\d+/.test(l)) || '';
    return (kind + '|' + String(message || '').slice(0, 200) + '|' + firstFrame.trim()).slice(0, 400);
  }

  // Single entry point. Fire-and-forget; never throws.
  // opts: { stack, filename, status, endpoint, error }
  function reportAutoError(kind, message, opts) {
    opts = opts || {};
    try {
      if (_reporting) return;                 // do not report our own failure
      if (_sent >= MAX_AUTO_REPORTS) return;

      const stack = String(opts.stack || '').slice(0, STACK_MAX);
      const filename = opts.filename || null;
      if (isNoise(message, filename, stack)) return;

      const sig = signatureOf(kind, message, stack);
      if (_seen.has(sig)) return;             // dedup

      const user = (typeof firebase !== 'undefined' && firebase.auth)
        ? firebase.auth().currentUser : null;
      if (!user) return;                      // logged out -> Sentry only

      _reporting = true;
      try {
        _seen.add(sig);
        _sent++;

        // Best-effort Sentry cross-reference (same idea as the manual modal).
        let sentryEventId = null;
        try {
          if (window.Sentry && opts.error instanceof Error && typeof Sentry.captureException === 'function') {
            sentryEventId = Sentry.captureException(opts.error, { tags: { source: 'auto_error', kind } }) || null;
          } else if (window.Sentry && typeof Sentry.captureMessage === 'function') {
            sentryEventId = Sentry.captureMessage('[auto] ' + String(message).slice(0, 140), {
              level: 'error', tags: { source: 'auto_error', kind },
            }) || null;
          }
        } catch (_) {}

        let recentLogs = [];
        try {
          if (typeof window.getRecentLogs === 'function') recentLogs = window.getRecentLogs(AUTO_LOG_LINES);
        } catch (_) {}

        let cacheVersion = null;
        try {
          cacheVersion = document.querySelector('script[src*="constants.js"]')?.src.match(/v=([^&]+)/)?.[1] || null;
        } catch (_) {}
        let noteId = null;
        try { noteId = (typeof currentNoteId !== 'undefined') ? currentNoteId : null; } catch (_) {}
        let activeFolderId = null;
        try { activeFolderId = (typeof _activeFolderId !== 'undefined') ? _activeFolderId : null; } catch (_) {}

        // bugReports rules require a non-empty string message <= 2000 chars.
        let msg = ('[' + kind + '] ' + String(message == null ? 'unknown error' : message)).slice(0, 2000);
        if (!msg) msg = 'auto error';

        const payload = {
          source: 'auto',
          kind: kind,
          userId: user.uid,
          userDisplayName: user.displayName || null,
          email: user.email || null,
          message: msg,
          errorStack: stack || null,
          httpStatus: (typeof opts.status === 'number') ? opts.status : null,
          endpoint: opts.endpoint || null,
          attachedLogs: recentLogs.length > 0,
          recentLogs: recentLogs.length ? recentLogs : null,
          url: location.href,
          userAgent: (navigator.userAgent || '').slice(0, 500),
          viewport: { w: window.innerWidth, h: window.innerHeight },
          language: navigator.language || null,
          tzOffsetMinutes: new Date().getTimezoneOffset(),
          currentNoteId: noteId,
          activeFolderId: activeFolderId,
          cacheVersion: cacheVersion,
          sentryEventId: sentryEventId,
          createdAt: firebase.firestore.FieldValue.serverTimestamp(),
        };

        // Fire-and-forget. Swallow write failures -- the original error was
        // already captured by the wrapped console.error + Sentry, so a failed
        // report must never cascade into another error.
        firebase.firestore().collection('bugReports').add(payload).catch(function () {});
      } finally {
        _reporting = false;                   // reset synchronously after dispatch
      }
    } catch (_) {
      _reporting = false;
    }
  }

  // Uncaught exceptions.
  window.addEventListener('error', function (e) {
    // Resource load failures (img/script 404) also fire 'error' but carry an
    // element target and no e.error -- they are not JS exceptions, skip them.
    if (e && e.target && e.target !== window && e.target.tagName) return;
    const err = e && e.error;
    reportAutoError(
      'uncaught',
      (e && e.message) || (err && err.message) || 'uncaught error',
      { stack: err && err.stack, filename: e && e.filename, error: err instanceof Error ? err : null }
    );
  });

  // Unhandled promise rejections.
  window.addEventListener('unhandledrejection', function (e) {
    const reason = e && e.reason;
    const message = (reason && reason.message) || (typeof reason === 'string' ? reason : 'unhandled rejection');
    reportAutoError(
      'promise',
      message,
      { stack: reason && reason.stack, error: reason instanceof Error ? reason : null }
    );
  });

  // Exposed for api.js (and any other deliberate call site, e.g. a pipeline
  // catch block that wants to file the last generation error).
  window.reportAutoError = reportAutoError;
})();
