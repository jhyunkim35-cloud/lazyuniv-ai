// Lucide icon auto-mount.
//
// Usage from anywhere in the app:
//   <i data-lucide="home"></i>
//
// The icon is replaced with an inline SVG automatically — you don't need
// to call createIcons() yourself. A throttled MutationObserver watches
// the document for new [data-lucide] nodes (carded innerHTML strings,
// modal bodies, dynamically-built buttons, etc.) and re-runs the mount
// once per animation frame, batching multiple mutations.
//
// Why automatic instead of explicit:
//   The codebase has many render paths that splat innerHTML strings.
//   Wiring lucide.createIcons() into each one would scatter coupling
//   across folders, transcripts, exam-plan, recorder, etc. Letting any
//   path emit `<i data-lucide=...>` and have it just work keeps the new
//   icon system invisible to feature code.
//
// Anti-loop: lucide.createIcons() replaces matched <i> nodes with <svg>
// and removes the data-lucide attribute, so subsequent passes are no-ops
// on already-converted icons. The rAF throttle prevents burning CPU on
// rapid render bursts.
//
// Depends on: window.lucide (loaded via <script src=".../lucide.min.js">
// in the document head before this file).

(function () {
  // Names we already tried and lucide didn't have. Caching avoids the
  // console-flood scenario where MutationObserver fires every render and
  // lucide.createIcons() warns about the same missing icon every time —
  // because a missing icon never gets its data-lucide attribute stripped,
  // it stays in the DOM forever and re-triggers on every pass.
  const _knownMissing = new Set();

  function kebabToPascal(s) {
    return s.replace(/(^|-)([a-z])/g, (_, __, c) => c.toUpperCase());
  }

  function stripUnknownIcons() {
    if (!window.lucide || !window.lucide.icons) return;
    const nodes = document.querySelectorAll('[data-lucide]');
    for (const node of nodes) {
      const name = node.getAttribute('data-lucide');
      if (!name) continue;
      if (_knownMissing.has(name)) {
        // Already known-missing; remove attribute so this node is silent
        // forever. (Visual fallback: empty <i> — acceptable.)
        node.removeAttribute('data-lucide');
        continue;
      }
      const pascal = kebabToPascal(name);
      if (!(pascal in window.lucide.icons || {}) && !window.lucide[pascal]) {
        _knownMissing.add(name);
        console.warn('[lucide] unknown icon (will be silent after this):', name);
        node.removeAttribute('data-lucide');
      }
    }
  }

  function mount() {
    if (!window.lucide || !window.lucide.createIcons) return;
    stripUnknownIcons();
    try {
      window.lucide.createIcons();
    } catch (e) {
      console.warn('[lucide] createIcons failed:', e && e.message);
    }
  }

  let _scheduled = false;
  function schedule() {
    if (_scheduled) return;
    _scheduled = true;
    requestAnimationFrame(() => {
      _scheduled = false;
      mount();
    });
  }

  // First pass once the DOM is ready (Lucide UMD must already have run
  // because we load it earlier in <head>; this script is a body-end
  // module, so by the time we get here the body exists).
  mount();

  // Subsequent renders: only react to mutations that ADD nodes — pure
  // attribute changes never introduce new icons and would be wasted work.
  const observer = new MutationObserver((mutations) => {
    for (let i = 0; i < mutations.length; i++) {
      if (mutations[i].addedNodes.length > 0) {
        schedule();
        return;
      }
    }
  });
  observer.observe(document.body || document.documentElement, {
    childList: true,
    subtree: true,
  });

  // Manual hook for any code path that needs to be explicit (e.g. swapping
  // a single icon's data-lucide attribute on a node that was already
  // replaced — those need a re-mount because the observer's "addedNodes"
  // check won't trigger on attribute changes).
  window.mountLucideIcons = mount;
})();
