// Firestore cloud sync + usage tracking + image upload.
// Depends on: constants.js (auth, db, storage, currentUser, DEVELOPER_EMAILS),
//             storage.js (saveNote, getNote, getAllNotes, getAllFolders, saveFolder,
//                         deleteNote, deleteFolder, renameFolder, updateNoteOrder, openDB).

function userNotesRef() {
  if (!currentUser) return null;
  return db.collection('users').doc(currentUser.uid).collection('notes');
}
function userFoldersRef() {
  if (!currentUser) return null;
  return db.collection('users').doc(currentUser.uid).collection('folders');
}

// M1: Validate folder color against FOLDER_COLORS whitelist to prevent CSS injection.
// Accepts only values from the predefined palette (or null/undefined to clear).
function sanitizeFolderColor(color) {
  if (color == null || color === '') return null;
  if (typeof color !== 'string') return null;
  if (typeof FOLDER_COLORS === 'undefined') return null;
  const allowed = FOLDER_COLORS.some(c => c.value === color);
  return allowed ? color : null;
}
async function saveNoteFS(note) {
  // ───── GHOST NOTE DIAGNOSTIC (temp, remove after debugging) ─────
  const _hasTitle = note && note.title && note.title.trim();
  const _hasContent = note && (note.notesText || note.markdownContent) &&
                      (note.notesText || note.markdownContent).trim();
  if (!_hasTitle || !_hasContent) {
    console.warn('🔴 GHOST CANDIDATE saveNoteFS called with empty data!', {
      id: note?.id,
      title: note?.title || '(empty)',
      hasNotesText: !!note?.notesText,
      hasMarkdown: !!note?.markdownContent,
      notesTextLen: note?.notesText?.length || 0,
      type: note?.type,
    });
    console.trace('Call stack:');
    return note;
  }
  console.log('[saveNoteFS]', note?.id, '|', note?.title || '(no title)', '|', _hasContent ? 'has content' : 'EMPTY');
  // ───── END DIAGNOSTIC ─────
  const now = new Date().toISOString();
  const id = note.id || uuidv4();
  const record = Object.assign({ folderId: null, createdAt: now }, note, { id, updatedAt: now });

  // Always save full data to IndexedDB (local cache with base64 images)
  await saveNote(record);

  // If logged in, upload images to Storage and save to Firestore
  const ref = userNotesRef();
  if (ref) {
    const toSave = Object.assign({}, record);
    delete toSave.notesHtml;
    // A2 fix: Don't blindly run all images through uploadSlideImages.
    //
    // saveNoteFS gets called from two very different places:
    //   1. Fresh analysis  → toSave.slideImages is base64 (needs upload)
    //   2. Folder move / image insert / folder delete → toSave.extractedImages
    //      is the hydrated viewer shape (mimeType:'url' pointing at Firebase
    //      Storage URLs that already exist).
    //
    // If we run case 2 through uploadSlideImages, two things break:
    //   - Hydrate's .filter(Boolean) may have dropped null slots, so the
    //     re-emitted slideImageUrls array shrinks (this is the 4/17 PPT
    //     corruption pattern).
    //   - It's wasted work — those URLs already exist on Storage.
    //
    // The guard: if every extractedImages entry is already a uploaded URL,
    // keep the existing slideImageUrls (which the spread copied from
    // `record` → `note`) untouched.
    if (toSave.slideImages && toSave.slideImages.length) {
      // Case 1: fresh base64 from analysis pipeline — must upload
      toSave.slideImageUrls = await uploadSlideImages(id, toSave.slideImages);
    } else if (toSave.extractedImages && toSave.extractedImages.length) {
      const allUrlTyped = toSave.extractedImages.every(img =>
        img && img.mimeType === 'url' &&
        typeof img.imageBase64 === 'string' &&
        img.imageBase64.startsWith('https://')
      );
      if (!allUrlTyped) {
        // Case 2b: at least one entry is base64 (e.g. user inserted a new
        // image into the note) — re-upload the whole set.
        toSave.slideImageUrls = await uploadSlideImages(id, toSave.extractedImages);
      }
      // Case 2a (allUrlTyped): leave toSave.slideImageUrls alone — it was
      // copied from the spread of `record` and is already correct.
    }
    delete toSave.slideImages;
    delete toSave.extractedImages;
    delete toSave.filteredText;

    // Progressive size reduction until under 900KB
    const stripOrder = ['pipelineLog', 'highlightedTranscript', 'pptText', 'recText'];
    for (const key of stripOrder) {
      if (JSON.stringify(toSave).length <= 900000) break;
      console.warn('saveNoteFS: stripping', key, '(' + JSON.stringify(toSave[key] || '').length + ' chars)');
      delete toSave[key];
    }

    const finalSize = JSON.stringify(toSave).length;
    if (finalSize > 950000) {
      console.error('saveNoteFS: STILL too large after all strips:', finalSize,
        Object.keys(toSave).map(k => k + ':' + JSON.stringify(toSave[k] || '').length).join(', '));
      return record; // skip Firestore write, IndexedDB already saved
    }

    await ref.doc(id).set(toSave, { merge: true });
  }
  return record;
}
// ─────────────────────────────────────────────────────────────────
// Firestore is the truth source. IDB is an offline-only cache.
//
// Reads go to Firestore first; on success the result is mirrored into
// IDB so an offline reload still has data. On any failure (network
// down, SDK error, not-logged-in) we fall back to IDB so the UI never
// breaks. This single rule kills the "Edge has stale data" class of
// bugs because there's no longer any per-browser source of truth that
// can drift.
//
// Hydration policy (very important — this is what corrupted the PPT
// slide URLs before): when we read a note from Firestore we may build
// `extractedImages` from `slideImageUrls` for the viewer. That field
// is FOR DISPLAY ONLY. saveNoteFS guards against it being sent back
// up — see uploadSlideImages, which keeps URL-typed entries as-is.
// ─────────────────────────────────────────────────────────────────

function _hydrateNoteForViewer(note) {
  if (!note) return note;
  if (!note.notesHtml && note.notesText && typeof renderMarkdown === 'function') {
    note.notesHtml = renderMarkdown(note.notesText);
  }
  if (note.slideImageUrls && !note.extractedImages) {
    note.extractedImages = note.slideImageUrls
      .map((url, i) => url
        ? { slideNumber: i + 1, imageBase64: url, mimeType: 'url' }
        : null)
      .filter(Boolean);
  }
  return note;
}

async function getNoteFS(id) {
  // Logged-out path: just hit IDB
  const ref = userNotesRef();
  if (!ref) return getNote(id);
  try {
    const doc = await ref.doc(id).get();
    if (doc.exists) {
      const data = _hydrateNoteForViewer(doc.data());
      // Mirror to IDB for offline. Use the lower-level put so we bypass
      // saveNote's ghost guard — Firestore data is canonical even if the
      // title is somehow blank, the user can still see it.
      try {
        const conn = await openDB();
        await new Promise((res, rej) => {
          const tx = conn.transaction('notes', 'readwrite');
          tx.objectStore('notes').put(data);
          tx.oncomplete = res;
          tx.onerror = e => rej(e.target.error);
        });
      } catch (e) { /* IDB mirror is best-effort */ }
      return data;
    }
    // Doc doesn't exist on Firestore — fall back to IDB so notes the user
    // is actively editing locally (not yet pushed) still open.
    return getNote(id);
  } catch (e) {
    console.warn('[getNoteFS] Firestore read failed, falling back to IDB:', id, e.message);
    return getNote(id);
  }
}

async function getAllNotesFS() {
  const ref = userNotesRef();
  if (!ref) return getAllNotes();
  try {
    const snap = await ref.get();
    const notes = snap.docs.map(d => _hydrateNoteForViewer(d.data()));
    // Mirror set into IDB as a side effect so future offline loads work.
    // We don't delete IDB-only notes here — that's the realtime listener's
    // job in v2; for now an IDB-only note still appears so the user never
    // sees their unsynced work vanish.
    try {
      const conn = await openDB();
      await new Promise((res, rej) => {
        const tx = conn.transaction('notes', 'readwrite');
        const store = tx.objectStore('notes');
        for (const n of notes) store.put(n);
        tx.oncomplete = res;
        tx.onerror = e => rej(e.target.error);
      });
    } catch (e) { /* best-effort */ }
    return notes.sort((a, b) => (b.updatedAt || '').localeCompare(a.updatedAt || ''));
  } catch (e) {
    console.warn('[getAllNotesFS] Firestore read failed, falling back to IDB:', e.message);
    return getAllNotes();
  }
}
async function deleteNoteFS(id) {
  await deleteNote(id);
  const ref = userNotesRef();
  if (ref) {
    await ref.doc(id).delete();
    await deleteSlideImages(id);
  }
  // Track deletion for sync
  if (currentUser) {
    const deletedKey = 'deleted_notes_' + currentUser.uid;
    const deleted = JSON.parse(localStorage.getItem(deletedKey) || '[]');
    // M2: dedupe + cap at 200 (drop oldest) to prevent unbounded localStorage growth
    if (!deleted.includes(id)) deleted.push(id);
    const capped = deleted.length > 200 ? deleted.slice(deleted.length - 200) : deleted;
    localStorage.setItem(deletedKey, JSON.stringify(capped));
  }
}
async function searchNotesFS(query) {
  const all = await getAllNotesFS();
  const q = query.toLowerCase();
  return all.filter(n => (n.title || '').toLowerCase().includes(q) || (n.notesText || '').toLowerCase().includes(q));
}

// Ghost-note prevention helper.
//
// Firestore's `set(..., {merge:true})` will create a new doc if one doesn't
// already exist — that's how partial updates from folder moves and renames
// were silently spawning empty notes (no title, no body) on Firestore in the
// first place. Use this helper for every partial-field write to a note doc:
//
//   - If the doc exists  -> apply patch via update() (truly partial, no creation)
//   - If the doc is missing AND IndexedDB has the full note with real content,
//     fall through to saveNoteFS() which already gates on title+content.
//   - If the doc is missing AND local data is also empty, refuse the write —
//     better to skip a save than to materialise a ghost row.
//
// Returns true on success (any path), false if the write was refused.
async function safeNotePartialUpdate(noteId, partial) {
  const ref = userNotesRef();
  if (!ref || !noteId) return false;
  try {
    await ref.doc(noteId).update(partial);
    return true;
  } catch (e) {
    const code = e && (e.code || '');
    const isMissing = code === 'not-found' || code === 'firestore/not-found' ||
                      /no document to update|not found/i.test(e.message || '');
    if (!isMissing) {
      console.warn('[safeNotePartialUpdate] update error', noteId, e);
      return false;
    }
    // Doc missing on Firestore — recover from local IndexedDB if it has real data.
    let local = null;
    try { local = await getNote(noteId); } catch {}
    const hasTitle   = local && local.title && local.title.trim();
    const hasContent = local && (local.notesText || local.markdownContent) &&
                       (local.notesText || local.markdownContent).trim();
    if (!local || !hasTitle || !hasContent) {
      console.warn('[safeNotePartialUpdate] doc missing AND local empty/missing — refusing to create ghost note',
        noteId, { localExists: !!local, hasTitle, hasContent });
      return false;
    }
    // Local has real data — push it through saveNoteFS so it goes through the
    // existing ghost guard there, and merge in the requested partial fields.
    const merged = Object.assign({}, local, partial);
    try {
      await saveNoteFS(merged);
      return true;
    } catch (e2) {
      console.warn('[safeNotePartialUpdate] fallback saveNoteFS failed', noteId, e2);
      return false;
    }
  }
}

async function saveFolderFS(folder) {
  const ref = userFoldersRef();
  if (!ref) return saveFolder(folder);
  const id = folder.id || uuidv4();
  // M1: sanitize color against whitelist before persisting
  const safeFolder = Object.assign({}, folder, { color: sanitizeFolderColor(folder.color) });
  const record = Object.assign({ createdAt: new Date().toISOString() }, safeFolder, { id });
  await ref.doc(id).set(record, { merge: true });
  return record;
}
async function getAllFoldersFS() {
  const ref = userFoldersRef();
  if (!ref) return getAllFolders();
  try {
    const snap = await ref.orderBy('name').get();
    const folders = snap.docs.map(d => d.data());
    // Mirror to IDB so offline page loads still show folders
    try {
      const conn = await openDB();
      await new Promise((res, rej) => {
        const tx = conn.transaction('folders', 'readwrite');
        const store = tx.objectStore('folders');
        for (const f of folders) store.put(f);
        tx.oncomplete = res;
        tx.onerror = e => rej(e.target.error);
      });
    } catch (e) { /* best-effort */ }
    return folders;
  } catch (e) {
    console.warn('[getAllFoldersFS] Firestore read failed, falling back to IDB:', e.message);
    return getAllFolders();
  }
}
async function deleteFolderFS(id) {
  const ref = userFoldersRef();
  if (!ref) return deleteFolder(id);
  const notes = await getAllNotesFS();
  for (const note of notes.filter(n => n.folderId === id)) {
    await saveNoteFS(Object.assign({}, note, { folderId: null }));
  }
  await ref.doc(id).delete();
  // Also purge from IndexedDB — prevents ghost folder on next login sync
  await deleteFolder(id);
}
async function renameFolderFS(id, newName, color) {
  const ref = userFoldersRef();
  if (!ref) return renameFolder(id, newName, color);
  const doc = await ref.doc(id).get();
  if (!doc.exists) return;
  // M1: sanitize color against whitelist before persisting
  const safeColor = color !== undefined ? sanitizeFolderColor(color) : undefined;
  const updated = Object.assign({}, doc.data(), { name: newName }, safeColor !== undefined ? { color: safeColor } : {});
  await ref.doc(id).set(updated);
  return updated;
}
async function updateNoteOrderFS(orderedIds) {
  // Always update IndexedDB so renderHomeView() (which reads IDB) sees the new order
  await updateNoteOrder(orderedIds);
  const ref = userNotesRef();
  if (!ref) return;
  const batch = db.batch();
  orderedIds.forEach((id, sortIndex) => {
    batch.update(ref.doc(id), { sortOrder: sortIndex });
  });
  await batch.commit();
}

async function migrateLocalToFirestore() {
  if (!currentUser) return;
  const migrated = localStorage.getItem('fs_migrated_' + currentUser.uid);
  if (migrated) return;
  try {
    const localNotes = await getAllNotes();
    const localFolders = await getAllFolders();
    if (localFolders.length > 0 || localNotes.length > 0) {
      showToast('📦 로컬 노트를 클라우드로 이전 중...');
      for (const folder of localFolders) {
        try { await saveFolderFS(folder); } catch (e) { console.warn('Folder migration skip:', e); }
      }
      let ok = 0;
      for (const note of localNotes) {
        if (!note.title?.trim() || !(note.notesText || note.markdownContent)?.trim()) {
          console.warn('[migrate] skipped empty legacy note', note.id);
          continue;
        }
        try { await saveNoteFS(note); ok++; } catch (e) { console.warn('Note migration skip:', note.id, e.message); }
      }
      showSuccessToast('☁️ ' + ok + '/' + localNotes.length + '개 노트 이전 완료');
    }
  } catch (e) {
    console.error('Migration error:', e);
  }
  // Always set flag so we don't retry
  localStorage.setItem('fs_migrated_' + currentUser.uid, 'true');
}

async function syncNotesOnLogin() {
  if (!currentUser) return;
  const synced = sessionStorage.getItem('synced_' + currentUser.uid);
  if (synced) return;
  try {
    const ref = userNotesRef();
    const fRef = userFoldersRef();
    if (!ref || !fRef) return;

    const [localNotes, localFolders, fsNotesSnap, fsFoldersSnap] = await Promise.all([
      getAllNotes(), getAllFolders(),
      ref.get(), fRef.get()
    ]);

    const fsNotes = fsNotesSnap.docs.map(d => d.data());
    const fsFolders = fsFoldersSnap.docs.map(d => d.data());
    const fsNoteMap = Object.fromEntries(fsNotes.map(n => [n.id, n]));
    const localNoteMap = Object.fromEntries(localNotes.map(n => [n.id, n]));
    const fsFolderMap = Object.fromEntries(fsFolders.map(f => [f.id, f]));
    const localFolderMap = Object.fromEntries(localFolders.map(f => [f.id, f]));

    // 1. Process deleted notes tracked in localStorage
    const deletedKey = 'deleted_notes_' + currentUser.uid;
    const deletedIds = JSON.parse(localStorage.getItem(deletedKey) || '[]');
    const successfulDeletes = [];
    for (const did of deletedIds) {
      try {
        await ref.doc(did).delete();
        successfulDeletes.push(did);
      } catch(e) {
        console.warn('Firestore delete failed, will retry next sync:', did, e);
      }
    }
    // Only remove successfully deleted IDs; keep failed ones for next sync
    if (successfulDeletes.length === deletedIds.length) {
      localStorage.removeItem(deletedKey);
    } else {
      const remaining = deletedIds.filter(id => !successfulDeletes.includes(id));
      localStorage.setItem(deletedKey, JSON.stringify(remaining));
    }
    // Purge any zombie notes that exist in IndexedDB despite being on the delete list
    for (const did of deletedIds) {
      try { await deleteNote(did); } catch(e) {}
    }
    const deletedSet = new Set(deletedIds);

    // 2. Firestore에 있는데 로컬에 없으면 → 로컬에 저장 (단, 삭제 목록에 없는 경우만)
    for (const fsNote of fsNotes) {
      if (deletedSet.has(fsNote.id)) continue;
      if (!localNoteMap[fsNote.id]) {
        // Skip ghost notes from Firestore (empty title AND empty content)
        const _hasTitle = fsNote.title && fsNote.title.trim();
        const _hasContent = (fsNote.notesText || fsNote.markdownContent) &&
                            (fsNote.notesText || fsNote.markdownContent).trim();
        if (!_hasTitle && !_hasContent) {
          console.warn('[sync] skipping ghost note from Firestore:', fsNote.id);
          continue;
        }
        if (!fsNote.notesHtml && fsNote.notesText) fsNote.notesHtml = renderMarkdown(fsNote.notesText);
        if (fsNote.slideImageUrls && !fsNote.extractedImages) {
          fsNote.extractedImages = fsNote.slideImageUrls.map((url, i) => url ? { slideNumber: i + 1, imageBase64: url, mimeType: 'url' } : null).filter(Boolean);
        }
        await saveNote(fsNote);
      }
    }
    for (const fsFolder of fsFolders) {
      if (!localFolderMap[fsFolder.id]) await saveFolder(fsFolder);
    }

    // 3. 로컬에 있는데 Firestore에 없으면 → Firestore에 업로드
    // HOTFIX: disabled to prevent ghost note resurrection
    // for (const ln of localNotes) {
    //   if (deletedSet.has(ln.id)) continue;
    //   if (!fsNoteMap[ln.id]) {
    //     try { await saveNoteFS(ln); } catch (e) { console.warn('Sync upload skip:', ln.id, e.message); }
    //   }
    // }
    // for (const lf of localFolders) {
    //   if (!fsFolderMap[lf.id]) {
    //     try { await saveFolderFS(lf); } catch (e) { console.warn('Folder sync skip:', e.message); }
    //   }
    // }

    // 4. 둘 다 있으면 → updatedAt 비교
    for (const fsNote of fsNotes) {
      if (deletedSet.has(fsNote.id)) continue;
      const local = localNoteMap[fsNote.id];
      if (!local) continue;
      const fsTime = fsNote.updatedAt || '';
      const localTime = local.updatedAt || '';
      if (fsTime > localTime) {
        const merged = Object.assign({}, fsNote, { slideImages: local.slideImages, notesHtml: local.notesHtml, extractedImages: local.extractedImages });
        await saveNote(merged);
      } else if (localTime > fsTime) {
        // HOTFIX: disabled to prevent ghost note resurrection
        // try { await saveNoteFS(local); } catch (e) { console.warn('Sync push skip:', e.message); }
      }
    }

    // 5. Sync quiz results from Firestore → IndexedDB (merge only, never delete)
    try {
      const qrSnap = await firebase.firestore()
        .collection('users').doc(currentUser.uid)
        .collection('quizResults').get();
      const idbQr = await openDB();
      for (const doc of qrSnap.docs) {
        const fsQr = doc.data();
        await new Promise((res, rej) => {
          const tx  = idbQr.transaction('quizResults', 'readwrite');
          const req = tx.objectStore('quizResults').get(fsQr.id);
          req.onsuccess = e => {
            const local = e.target.result;
            // Add if absent; keep the newer record if both exist
            if (!local || (fsQr.timestamp && local.timestamp && fsQr.timestamp > local.timestamp)) {
              tx.objectStore('quizResults').put(fsQr);
            }
            tx.oncomplete = () => res();
            tx.onerror    = ev => rej(ev.target.error);
          };
          req.onerror = ev => rej(ev.target.error);
        }).catch(e => console.warn('quizResult IDB merge failed:', fsQr.id, e));
      }
    } catch (e) {
      console.warn('Quiz results sync failed (non-critical):', e);
    }

    // 6. Convert slideImageUrls for any local note missing extractedImages
    const allLocal = await getAllNotes();
    for (const note of allLocal) {
      if (note.slideImageUrls && !note.extractedImages) {
        note.extractedImages = note.slideImageUrls.map((url, i) => url ? { slideNumber: i + 1, imageBase64: url, mimeType: 'url' } : null).filter(Boolean);
        await saveNote(note);
      }
    }

    sessionStorage.setItem('synced_' + currentUser.uid, 'true');
  } catch (e) {
    console.error('Sync error:', e);
  }
}

// getUserUsage, incrementUsage, canAnalyze, setPaidPlan moved to /js/payment.js

async function uploadSlideImages(noteId, slideImages) {
  if (!currentUser || !slideImages || !slideImages.length) return [];
  const urls = [];
  for (let i = 0; i < slideImages.length; i++) {
    const img = slideImages[i];
    if (!img) { urls.push(null); continue; }
    // If already a storage URL, keep it
    if (typeof img === 'string' && img.startsWith('https://')) { urls.push(img); continue; }
    // Upload base64 to Firebase Storage
    const path = 'users/' + currentUser.uid + '/notes/' + noteId + '/slide_' + i + '.png';
    const ref = storage.ref(path);
    try {
      let data, contentType = 'image/png';
      if (typeof img === 'object' && img.imageBase64) {
        if (img.mimeType === 'url' && typeof img.imageBase64 === 'string' && img.imageBase64.startsWith('https://')) {
          urls.push(img.imageBase64);
          continue;
        }
        data = img.imageBase64;
        contentType = img.mimeType || 'image/png';
      } else if (typeof img === 'string' && img.includes('base64,')) {
        data = img.split('base64,')[1];
      } else if (typeof img === 'string') {
        data = img;
      } else {
        urls.push(null); continue;
      }
      // Convert base64url → standard base64 before upload
      data = data.replace(/-/g, '+').replace(/_/g, '/');
      if (data.length % 4) data += '='.repeat(4 - (data.length % 4));
      await ref.putString(data, 'base64', { contentType });
      const url = await ref.getDownloadURL();
      urls.push(url);
    } catch (e) {
      console.error('Slide upload error:', i, e);
      urls.push(null);
    }
  }
  return urls;
}

async function deleteSlideImages(noteId) {
  if (!currentUser) return;
  const prefix = 'users/' + currentUser.uid + '/notes/' + noteId + '/';
  try {
    const listRef = storage.ref(prefix);
    const list = await listRef.listAll();
    await Promise.all(list.items.map(item => item.delete()));
  } catch (e) {
    console.error('deleteSlideImages error:', e);
  }
}

async function getNextSortOrder(folderId, excludeId = null) {
  // B3 fix: Use a timestamp-based sortOrder to avoid race conditions on
  // concurrent folder moves. The previous Math.max(...) + 1 logic required
  // a read-then-write that two simultaneous moves could collide on,
  // returning the same value and producing duplicate sortOrder entries.
  //
  // Date.now() gives millisecond uniqueness, and since notes sort ASC by
  // sortOrder, a freshly-added note (large timestamp) lands at the end of
  // its folder — matching the previous "max + 1" intent. Existing
  // small-integer sortOrders from manual drag-reorder still sort first.
  // The folderId/excludeId args are kept for API compatibility but unused.
  return Date.now();
}
