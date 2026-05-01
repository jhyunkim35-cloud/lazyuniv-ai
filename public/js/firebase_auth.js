// Firebase auth UI helpers: update DOM on login/logout, Google sign-in, sign-out.
// Depends on: constants.js (currentUser, auth), ui.js (showToast, showSuccessToast), firestore_sync.js (syncNotesOnLogin), home_view.js (renderHomeView).

function updateAuthUI() {
  const loginBtn = document.getElementById('loginBtn');
  const userInfo = document.getElementById('userInfo');
  const userName = document.getElementById('userName');
  const userAvatar = document.getElementById('userAvatar');
  const landingView = document.getElementById('landingView');
  const sidebar = document.getElementById('sidebar');
  const homeView = document.getElementById('homeView');
  const newNoteView = document.getElementById('newNoteView');

  if (currentUser) {
    loginBtn.style.display = 'none';
    userInfo.style.display = 'flex';
    userName.textContent = currentUser.displayName || currentUser.email;
    userAvatar.src = currentUser.photoURL || '';
    landingView.style.display = 'none';
    sidebar.style.display = '';
    // Show whichever view was active, default to home
    if (newNoteView.style.display !== 'block') {
      homeView.style.display = '';
    }
    syncNotesOnLogin().then(() => {
      renderHomeView();
      // Start realtime listeners after the initial backfill finishes —
      // any subsequent change on any device flows in within ~1 second.
      startRealtimeSync();
    });
    const sidebarAvatar = document.getElementById('sidebarAvatar');
    const sidebarUserName = document.getElementById('sidebarUserName');
    if (sidebarAvatar) sidebarAvatar.src = currentUser.photoURL || '';
    if (sidebarUserName) sidebarUserName.textContent = currentUser.displayName || currentUser.email;
  } else {
    // Tear down realtime listeners first so they don't fire after logout
    if (typeof stopRealtimeSync === 'function') stopRealtimeSync();
    loginBtn.style.display = '';
    userInfo.style.display = 'none';
    landingView.style.display = '';
    sidebar.style.display = 'none';
    homeView.style.display = 'none';
    newNoteView.style.display = 'none';
  }
}

async function loginWithGoogle() {
  try {
    const provider = new firebase.auth.GoogleAuthProvider();
    await auth.signInWithPopup(provider);
  } catch (e) {
    if (e.code !== 'auth/popup-closed-by-user') showToast('❌ 로그인 실패: ' + e.message);
  }
}

async function logout() {
  await auth.signOut();
  showSuccessToast('로그아웃 완료');
}
