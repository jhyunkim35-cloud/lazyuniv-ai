// IndexedDB layer. Pure local storage for notes, folders, quiz results.
// Depends on: constants.js (DB_NAME, DB_VERSION, uuidv4, getNextSortOrder).

function openDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = e => {
      const db = e.target.result;
      if (!db.objectStoreNames.contains('notes')) {
        const ns = db.createObjectStore('notes', { keyPath: 'id' });
        ns.createIndex('folderId',   'folderId',   { unique: false });
        ns.createIndex('createdAt',  'createdAt',  { unique: false });
        ns.createIndex('title',      'title',      { unique: false });
      }
      if (!db.objectStoreNames.contains('folders')) {
        const fs = db.createObjectStore('folders', { keyPath: 'id' });
        fs.createIndex('name', 'name', { unique: false });
      }
      if (!db.objectStoreNames.contains('quizResults')) {
        const qr = db.createObjectStore('quizResults', { keyPath: 'id' });
        qr.createIndex('noteId',    'noteId',    { unique: false });
        qr.createIndex('timestamp', 'timestamp', { unique: false });
      }
    };
    req.onsuccess = e => resolve(e.target.result);
    req.onerror   = e => reject(e.target.error);
  });
}

async function saveQuizResult(result) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction('quizResults', 'readwrite');
    tx.objectStore('quizResults').put(result);
    tx.oncomplete = () => {
      resolve(result);
      // Fire-and-forget Firestore write — don't block quiz flow
      const user = firebase.auth().currentUser;
      if (user) {
        firebase.firestore()
          .collection('users').doc(user.uid)
          .collection('quizResults').doc(result.id)
          .set(result, { merge: true })
          .catch(e => console.warn('Firestore quizResult save failed:', e));
      }
    };
    tx.onerror    = e => reject(e.target.error);
    tx.onabort    = e => reject(e.target.error);
  });
}

async function getQuizResultsByNote(noteId) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx      = db.transaction('quizResults', 'readonly');
    const store   = tx.objectStore('quizResults');
    const index   = store.index('noteId');
    const req     = index.getAll(noteId);
    req.onsuccess = e => {
      const results = e.target.result || [];
      results.sort((a, b) => b.timestamp.localeCompare(a.timestamp));
      resolve(results);
    };
    req.onerror = e => reject(e.target.error);
  });
}

async function saveNote(note) {
  const db  = await openDB();
  const now = new Date().toISOString();
  // Assign sortOrder for brand-new notes that don't already have one
  let sortOrder = note.sortOrder;
  if (sortOrder === undefined && !note.id) {
    sortOrder = await getNextSortOrder(note.folderId ?? null);
  }
  const record = Object.assign({ folderId: null, createdAt: now }, note, {
    id:        note.id || uuidv4(),
    updatedAt: now,
    ...(sortOrder !== undefined ? { sortOrder } : {}),
  });
  return new Promise((resolve, reject) => {
    const tx  = db.transaction('notes', 'readwrite');
    tx.objectStore('notes').put(record);
    tx.oncomplete = () => resolve(record);
    tx.onerror    = e => reject(e.target.error);
    tx.onabort    = e => reject(e.target.error);
  });
}

async function getNote(id) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const req = db.transaction('notes', 'readonly').objectStore('notes').get(id);
    req.onsuccess = e => resolve(e.target.result);
    req.onerror   = e => reject(e.target.error);
  });
}

async function getAllNotes() {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const req = db.transaction('notes', 'readonly').objectStore('notes').getAll();
    req.onsuccess = e => resolve(e.target.result.sort((a, b) => (b.updatedAt || '').localeCompare(a.updatedAt || '')));
    req.onerror   = e => reject(e.target.error);
  });
}

async function updateNoteOrder(orderedIds) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx    = db.transaction('notes', 'readwrite');
    const store = tx.objectStore('notes');
    let i = 0;
    function next() {
      if (i >= orderedIds.length) return;
      const sortIndex = i++;
      const req = store.get(orderedIds[sortIndex]);
      req.onsuccess = () => {
        if (req.result) store.put(Object.assign({}, req.result, { sortOrder: sortIndex }));
        next();
      };
      req.onerror = e => reject(e.target.error);
    }
    tx.oncomplete = resolve;
    tx.onerror    = e => reject(e.target.error);
    next();
  });
}

async function deleteNote(id) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction('notes', 'readwrite');
    tx.objectStore('notes').delete(id);
    tx.oncomplete = () => {
      resolve();
      // Fire-and-forget Firestore cleanup — note + all its quiz results
      const user = firebase.auth().currentUser;
      if (user) {
        const userFs = firebase.firestore().collection('users').doc(user.uid);
        userFs.collection('notes').doc(id)
          .delete()
          .catch(e => console.warn('Firestore note delete failed:', e));
        // Delete quiz results whose noteId matches the deleted note
        userFs.collection('quizResults').where('noteId', '==', id).get()
          .then(snap => snap.forEach(doc => doc.ref.delete()))
          .catch(e => console.warn('Firestore quizResults cleanup failed:', e));
      }
    };
    tx.onerror    = e => reject(e.target.error);
    tx.onabort    = e => reject(e.target.error);
  });
}

async function searchNotes(query) {
  const all = await getAllNotes();
  const q   = query.toLowerCase();
  return all.filter(n => (n.title || '').toLowerCase().includes(q) || (n.notesText || '').toLowerCase().includes(q));
}

async function saveFolder(folder) {
  const db  = await openDB();
  const now = new Date().toISOString();
  const record = Object.assign({ createdAt: now }, folder, { id: folder.id || uuidv4() });
  return new Promise((resolve, reject) => {
    const tx  = db.transaction('folders', 'readwrite');
    tx.objectStore('folders').put(record);
    tx.oncomplete = () => resolve(record);
    tx.onerror    = e => reject(e.target.error);
    tx.onabort    = e => reject(e.target.error);
  });
}

async function getAllFolders() {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const req = db.transaction('folders', 'readonly').objectStore('folders').getAll();
    req.onsuccess = e => resolve(e.target.result.sort((a, b) => (a.name || '').localeCompare(b.name || '')));
    req.onerror   = e => reject(e.target.error);
  });
}

async function deleteFolder(id) {
  const db = await openDB();
  // Move notes in this folder to uncategorized
  const all = await getAllNotes();
  const inFolder = all.filter(n => n.folderId === id);
  const tx = db.transaction(['notes', 'folders'], 'readwrite');
  for (const note of inFolder) {
    tx.objectStore('notes').put(Object.assign({}, note, { folderId: null }));
  }
  tx.objectStore('folders').delete(id);
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => {
      resolve();
      // Also delete from Firestore — fire-and-forget safety net
      const user = firebase.auth().currentUser;
      if (user) {
        firebase.firestore()
          .collection('users').doc(user.uid)
          .collection('folders').doc(id)
          .delete()
          .catch(e => console.warn('Firestore folder delete failed:', e));
      }
    };
    tx.onerror    = e => reject(e.target.error);
  });
}

async function renameFolder(id, newName, color) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const store = db.transaction('folders', 'readwrite').objectStore('folders');
    const get = store.get(id);
    get.onsuccess = () => {
      const rec = Object.assign({}, get.result, { name: newName }, color !== undefined ? { color } : {});
      const put = store.put(rec);
      put.onsuccess = () => resolve(rec);
      put.onerror   = e => reject(e.target.error);
    };
    get.onerror = e => reject(e.target.error);
  });
}

async function getStorageSize() {
  if (navigator.storage && navigator.storage.estimate) {
    const { usage } = await navigator.storage.estimate();
    return usage || 0;
  }
  // Fallback: rough estimate from note content lengths
  const notes = await getAllNotesFS();
  return notes.reduce((sum, n) => sum + JSON.stringify(n).length, 0);
}

/* ═══════════════════════════════════════════════
   Clear all storage
═══════════════════════════════════════════════ */
async function clearAllStorage() {
  if (!confirm('모든 저장된 노트와 폴더를 삭제하시겠습니까? 이 작업은 되돌릴 수 없습니다.')) return;
  try {
    const db = await openDB();
    await new Promise((resolve, reject) => {
      const tx = db.transaction(['notes', 'folders'], 'readwrite');
      tx.objectStore('notes').clear();
      tx.objectStore('folders').clear();
      tx.oncomplete = resolve;
      tx.onerror    = e => reject(e.target.error);
    });
    currentNoteId = null;
    showSuccessToast('🗑 저장소 초기화 완료');
    renderSavedNotes();
    renderHomeView();
  } catch (e) {
    showToast(`❌ 초기화 실패: ${e.message}`);
  }
}
