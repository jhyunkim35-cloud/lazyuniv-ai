// Transcript store — saves STT-completed lecture transcripts so the user can
// browse and reuse them later, decoupled from the new-note flow.
//
// Backing store: Firestore at users/{uid}/transcripts/{id}. We do NOT
// mirror to IndexedDB — transcripts are text-only and the home page
// always loads with network anyway, so a Firestore-first pattern (matching
// firestore_sync.js for notes) is enough. If we want offline list later,
// add an IDB store the same way notes do.
//
// Schema:
//   {
//     id:            uuid
//     title:         string  ("녹취록 2026-05-02 16:35" by default)
//     text:          string  (the STT result, capped at MAX_TRANSCRIPT_CHARS)
//     charCount:     number  (text length for display, even after cap)
//     durationSec:   number | null  (recording length; null for file upload)
//     audioFilename: string  (original blob/file name)
//     truncated:     boolean (true if text was clipped to fit Firestore 1MB)
//     createdAt:     ISO string
//     updatedAt:     ISO string
//     usedInNoteIds: string[]  (note ids this transcript was attached to)
//     diarizationJobId: string | null  (U7b: set when delivered before the
//                        local diarization worker finished — transcripts_view.js
//                        polls ?action=labels once and clears this on upgrade)
//     speakerNames:  { [speakerNum: string]: string }  (U15: display-only
//                        rename map, e.g. {"1":"교수님"} — stored text keeps
//                        "발화자 N:" untouched)
//   }
//
// Firestore single-doc 1MB limit: Korean text averages ~3 bytes/char in
// UTF-8, so we cap at 300_000 chars (~900KB) with margin for the rest of
// the doc. Truncation is rare (a 90-min lecture STT is typically 30-50k
// chars) but the safety net matters because dropping a write would lose
// the only copy of the transcript.

const MAX_TRANSCRIPT_CHARS = 300000;

function userTranscriptsRef() {
  if (!currentUser) return null;
  return db.collection('users').doc(currentUser.uid).collection('transcripts');
}

// "녹취록 2026-05-02 16:35" — local time, 24h, no seconds.
function defaultTranscriptTitle(date = new Date()) {
  const yyyy = date.getFullYear();
  const mm   = String(date.getMonth() + 1).padStart(2, '0');
  const dd   = String(date.getDate()).padStart(2, '0');
  const hh   = String(date.getHours()).padStart(2, '0');
  const mi   = String(date.getMinutes()).padStart(2, '0');
  return `녹취록 ${yyyy}-${mm}-${dd} ${hh}:${mi}`;
}

// Save a freshly-completed transcript. Returns the saved record.
// Throws if not logged in — caller should toast and bail.
async function saveTranscriptFS({ text, audioFilename, durationSec, diarizationJobId }) {
  const ref = userTranscriptsRef();
  if (!ref) throw new Error('not_logged_in');

  const cleanText = (text || '').trim();
  if (!cleanText) throw new Error('empty_text');

  const id  = uuidv4();
  const now = new Date();
  const nowISO = now.toISOString();

  let stored = cleanText;
  let truncated = false;
  if (stored.length > MAX_TRANSCRIPT_CHARS) {
    stored = stored.slice(0, MAX_TRANSCRIPT_CHARS);
    truncated = true;
  }

  const record = {
    id,
    title: defaultTranscriptTitle(now),
    text: stored,
    charCount: cleanText.length, // pre-truncation count for honest display
    durationSec: typeof durationSec === 'number' && durationSec > 0 ? durationSec : null,
    audioFilename: audioFilename || '',
    truncated,
    createdAt: nowISO,
    updatedAt: nowISO,
    usedInNoteIds: [],
    diarizationJobId: diarizationJobId || null,
  };

  await ref.doc(id).set(record);
  return record;
}

async function getAllTranscriptsFS() {
  const ref = userTranscriptsRef();
  if (!ref) return [];
  try {
    const snap = await ref.orderBy('createdAt', 'desc').get();
    return snap.docs.map(d => d.data());
  } catch (e) {
    console.warn('[getAllTranscriptsFS] failed:', e.message);
    return [];
  }
}

async function getTranscriptFS(id) {
  const ref = userTranscriptsRef();
  if (!ref || !id) return null;
  try {
    const doc = await ref.doc(id).get();
    return doc.exists ? doc.data() : null;
  } catch (e) {
    console.warn('[getTranscriptFS] failed:', id, e.message);
    return null;
  }
}

async function deleteTranscriptFS(id) {
  const ref = userTranscriptsRef();
  if (!ref || !id) return;
  await ref.doc(id).delete();
}

async function renameTranscriptFS(id, newTitle) {
  const ref = userTranscriptsRef();
  if (!ref || !id) return null;
  const trimmed = (newTitle || '').trim();
  if (!trimmed) return null;
  const patch = { title: trimmed, updatedAt: new Date().toISOString() };
  await ref.doc(id).update(patch);
  return patch;
}

// U7b: apply the late speaker-label upgrade once the local diarization
// worker finishes — swaps in the labeled text and clears diarizationJobId so
// transcripts_view.js's fire-and-forget check stops polling this doc.
async function applyDiarizationLabelsFS(id, { text, charCount }) {
  const ref = userTranscriptsRef();
  if (!ref || !id) return null;
  const patch = {
    text,
    charCount: typeof charCount === 'number' ? charCount : (text || '').length,
    diarizationJobId: null,
    updatedAt: new Date().toISOString(),
  };
  await ref.doc(id).update(patch);
  return patch;
}

// U15: display-time speaker-name mapping (e.g. {"1":"교수님"}) — does NOT
// touch the stored transcript text (labels stay "발화자 N:" in storage).
// Consumers apply the mapping at render/consume time (transcripts_view.js).
async function saveSpeakerNamesFS(id, speakerNames) {
  const ref = userTranscriptsRef();
  if (!ref || !id) return null;
  const patch = { speakerNames: speakerNames || {}, updatedAt: new Date().toISOString() };
  await ref.doc(id).update(patch);
  return patch;
}

// U17: deixis annotation layer — stored beside text, text itself never rewritten
// (same contract as speakerNames). [{q, ref, slide, conf:'high'}]
async function saveDeixisAnnotationsFS(id, deixisAnnotations) {
  const ref = userTranscriptsRef();
  if (!ref || !id) return null;
  const patch = { deixisAnnotations: deixisAnnotations || [], updatedAt: new Date().toISOString() };
  await ref.doc(id).set(patch, { merge: true });
  return patch;
}

// Attach a transcript to a note (for "used in" tracking). Best-effort.
async function markTranscriptUsedInNote(transcriptId, noteId) {
  const ref = userTranscriptsRef();
  if (!ref || !transcriptId || !noteId) return;
  try {
    await ref.doc(transcriptId).update({
      usedInNoteIds: firebase.firestore.FieldValue.arrayUnion(noteId),
      updatedAt: new Date().toISOString(),
    });
  } catch (e) {
    console.warn('[markTranscriptUsedInNote] failed:', e.message);
  }
}

// Make available globally — recorder.js, transcripts_view.js consume these.
window.saveTranscriptFS         = saveTranscriptFS;
window.getAllTranscriptsFS      = getAllTranscriptsFS;
window.getTranscriptFS          = getTranscriptFS;
window.deleteTranscriptFS       = deleteTranscriptFS;
window.renameTranscriptFS       = renameTranscriptFS;
window.applyDiarizationLabelsFS = applyDiarizationLabelsFS;
window.saveSpeakerNamesFS       = saveSpeakerNamesFS;
window.saveDeixisAnnotationsFS  = saveDeixisAnnotationsFS;
window.markTranscriptUsedInNote = markTranscriptUsedInNote;
window.defaultTranscriptTitle   = defaultTranscriptTitle;
