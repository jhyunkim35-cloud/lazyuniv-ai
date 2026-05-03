// Timetable data layer: per-user lecture schedule entries.
// Depends on: constants.js (db, currentUser).

(function () {

  // ── Private IDB (separate from main meetingAppDB to avoid version conflicts) ──

  const _IDB_NAME = 'timetableDB';
  const _IDB_VER  = 1;

  function _openIDB() {
    return new Promise((resolve, reject) => {
      const req = indexedDB.open(_IDB_NAME, _IDB_VER);
      req.onupgradeneeded = e => {
        const idb = e.target.result;
        if (!idb.objectStoreNames.contains('timetable')) {
          const store = idb.createObjectStore('timetable', { keyPath: 'entryId' });
          store.createIndex('dayOfWeek', 'dayOfWeek', { unique: false });
        }
      };
      req.onsuccess = e => resolve(e.target.result);
      req.onerror   = e => reject(e.target.error);
    });
  }

  function _idbPut(entry) {
    return _openIDB().then(conn => new Promise((res, rej) => {
      const tx = conn.transaction('timetable', 'readwrite');
      tx.objectStore('timetable').put(entry);
      tx.oncomplete = () => res(entry);
      tx.onerror    = e => rej(e.target.error);
    }));
  }

  function _idbGet(entryId) {
    return _openIDB().then(conn => new Promise((res, rej) => {
      const req = conn.transaction('timetable', 'readonly').objectStore('timetable').get(entryId);
      req.onsuccess = e => res(e.target.result || null);
      req.onerror   = e => rej(e.target.error);
    }));
  }

  function _idbGetAll() {
    return _openIDB().then(conn => new Promise((res, rej) => {
      const req = conn.transaction('timetable', 'readonly').objectStore('timetable').getAll();
      req.onsuccess = e => res(e.target.result || []);
      req.onerror   = e => rej(e.target.error);
    }));
  }

  function _idbDelete(entryId) {
    return _openIDB().then(conn => new Promise((res, rej) => {
      const tx = conn.transaction('timetable', 'readwrite');
      tx.objectStore('timetable').delete(entryId);
      tx.oncomplete = () => res();
      tx.onerror    = e => rej(e.target.error);
    }));
  }

  // ── Firestore ref ─────────────────────────────────────────────

  function _userTimetableRef() {
    if (typeof currentUser === 'undefined' || !currentUser) return null;
    return db.collection('users').doc(currentUser.uid).collection('timetable');
  }

  // ── Sort helper ───────────────────────────────────────────────

  function _sortEntries(entries) {
    return entries.slice().sort((a, b) => {
      if (a.dayOfWeek !== b.dayOfWeek) return a.dayOfWeek - b.dayOfWeek;
      return (a.startTime || '').localeCompare(b.startTime || '');
    });
  }

  // ── Public API ────────────────────────────────────────────────

  window.newTimetableEntry = function (partial) {
    const now = new Date().toISOString();
    return Object.assign({
      entryId:    crypto.randomUUID(),
      courseName: '',
      folderId:   null,
      dayOfWeek:  1,
      startTime:  '09:00',
      endTime:    '10:30',
      autoRecord: false,
      createdAt:  now,
      updatedAt:  now,
    }, partial || {});
  };

  window.saveTimetableEntry = async function (entry) {
    const now = new Date().toISOString();
    const record = Object.assign({}, entry, { updatedAt: now });
    if (!record.createdAt) record.createdAt = now;

    await _idbPut(record);

    const ref = _userTimetableRef();
    if (ref) {
      await ref.doc(record.entryId).set(record, { merge: true });
    }
    return record;
  };

  window.getTimetableEntry = async function (entryId) {
    const ref = _userTimetableRef();
    if (ref) {
      try {
        const doc = await ref.doc(entryId).get();
        if (doc.exists) {
          const data = doc.data();
          await _idbPut(data).catch(() => {});
          return data;
        }
      } catch (e) {
        console.warn('[getTimetableEntry] Firestore read failed, falling back to IDB:', e.message);
      }
    }
    return _idbGet(entryId);
  };

  window.listTimetableEntries = async function () {
    const ref = _userTimetableRef();
    if (ref) {
      try {
        const snap = await ref.get();
        const entries = snap.docs.map(d => d.data());
        const conn = await _openIDB();
        await new Promise((res, rej) => {
          const tx = conn.transaction('timetable', 'readwrite');
          const store = tx.objectStore('timetable');
          for (const e of entries) store.put(e);
          tx.oncomplete = res;
          tx.onerror = ev => rej(ev.target.error);
        });
        return _sortEntries(entries);
      } catch (e) {
        console.warn('[listTimetableEntries] Firestore read failed, falling back to IDB:', e.message);
      }
    }
    const all = await _idbGetAll();
    return _sortEntries(all);
  };

  window.deleteTimetableEntry = async function (entryId) {
    await _idbDelete(entryId);
    const ref = _userTimetableRef();
    if (ref) {
      await ref.doc(entryId).delete();
    }
  };

})();
