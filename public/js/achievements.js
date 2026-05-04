// Achievement system: catalog, unlock logic, toast UI, grid renderer.
// Depends on: gamification.js (getGamificationState, saveGamificationState).

(function () {

  const ACHIEVEMENTS = [
    { id: 'first_note',    icon: 'sparkles',      title: '첫 노트',     desc: '첫 노트를 생성했어요',         condition: s => s.totalNotes     >= 1   },
    { id: 'first_review',  icon: 'check',          title: '첫 복습',     desc: '첫 SRS 카드를 복습했어요',     condition: s => s.totalReviews   >= 1   },
    { id: 'first_quiz',    icon: 'graduation-cap', title: '첫 퀴즈',     desc: '첫 퀴즈를 풀었어요',           condition: s => s.totalQuizzes   >= 1   },
    { id: 'streak_3',      icon: 'flame',          title: '3일 연속',    desc: '3일 연속 학습',                condition: s => s.streakDays     >= 3   },
    { id: 'streak_7',      icon: 'flame',          title: '7일 연속',    desc: '일주일 연속 학습',             condition: s => s.streakDays     >= 7   },
    { id: 'streak_30',     icon: 'flame',          title: '30일 연속',   desc: '한 달 연속 학습',              condition: s => s.streakDays     >= 30  },
    { id: 'streak_100',    icon: 'flame',          title: '100일 연속',  desc: '백일 연속 학습',               condition: s => s.streakDays     >= 100 },
    { id: 'xp_100',        icon: 'star',           title: '100 XP',      desc: '100 XP 달성',                  condition: s => s.xpTotal        >= 100  },
    { id: 'xp_500',        icon: 'star',           title: '500 XP',      desc: '500 XP 달성',                  condition: s => s.xpTotal        >= 500  },
    { id: 'xp_1000',       icon: 'star',           title: '1,000 XP',    desc: '1,000 XP 달성',                condition: s => s.xpTotal        >= 1000 },
    { id: 'xp_5000',       icon: 'star',           title: '5,000 XP',    desc: '5,000 XP 달성',                condition: s => s.xpTotal        >= 5000 },
    { id: 'reviews_50',    icon: 'check',          title: '50장 복습',   desc: '카드 50장 복습 완료',          condition: s => s.totalReviews   >= 50  },
    { id: 'reviews_500',   icon: 'check',          title: '500장 복습',  desc: '카드 500장 복습 완료',         condition: s => s.totalReviews   >= 500 },
    { id: 'notes_10',      icon: 'book-open',      title: '10개 노트',   desc: '노트 10개 생성',               condition: s => s.totalNotes     >= 10  },
    { id: 'notes_50',      icon: 'book-open',      title: '50개 노트',   desc: '노트 50개 생성',               condition: s => s.totalNotes     >= 50  },
    { id: 'perfect_quiz',  icon: 'sparkles',       title: '만점 퀴즈',   desc: '퀴즈 만점 달성',               condition: s => s.perfectQuizzes >= 1   },
    { id: 'goal_streak_7', icon: 'target',         title: '목표 일주일', desc: '7일 연속 목표 달성',           condition: s => s.goalStreak     >= 7   },
  ];

  function _fmtYmd(d) {
    return d.getFullYear() + '-' +
           String(d.getMonth() + 1).padStart(2, '0') + '-' +
           String(d.getDate()).padStart(2, '0');
  }

  function _computeGoalStreak(state) {
    const dp   = state.dailyProgress || {};
    const goal = state.dailyGoal     || 5;
    const isGoalMet = ymd => {
      const p = dp[ymd];
      return p && (p.completed ||
        (p.cardsReviewed   || 0) >= goal ||
        (p.notesCreated    || 0) >= 1    ||
        (p.quizzesCompleted|| 0) >= 1);
    };
    const today = new Date();
    const d     = new Date(today);
    // If today's goal not yet met, start counting from yesterday
    if (!isGoalMet(_fmtYmd(d))) d.setDate(d.getDate() - 1);
    let streak = 0;
    for (let i = 0; i < 31; i++) {
      if (isGoalMet(_fmtYmd(d))) { streak++; d.setDate(d.getDate() - 1); }
      else break;
    }
    return streak;
  }

  function _buildStats(state) {
    return {
      streakDays:     state.streak        || 0,
      xpTotal:        state.xp            || 0,
      totalNotes:     state.totalNotes     || 0,
      totalReviews:   state.totalReviews   || 0,
      totalQuizzes:   state.totalQuizzes   || 0,
      perfectQuizzes: state.perfectQuizzes || 0,
      goalStreak:     _computeGoalStreak(state),
    };
  }

  // Returns achievements newly unlocked (not yet in state.unlockedIds).
  function checkAchievements(state) {
    const stats    = _buildStats(state);
    const unlocked = state.unlockedIds || [];
    return ACHIEVEMENTS.filter(a => !unlocked.includes(a.id) && a.condition(stats));
  }

  // Batch-checks state, writes newly unlocked IDs + dates, saves once, then shows toasts.
  async function runAchievementChecks(state) {
    try {
      const newly = checkAchievements(state);
      if (!newly.length) return;
      if (!state.unlockedIds)   state.unlockedIds   = [];
      if (!state.unlockedDates) state.unlockedDates = {};
      const now = new Date().toISOString();
      newly.forEach(a => {
        if (!state.unlockedIds.includes(a.id)) {
          state.unlockedIds.push(a.id);
          state.unlockedDates[a.id] = now;
        }
      });
      if (typeof saveGamificationState === 'function') await saveGamificationState(state);
      newly.forEach((a, i) => setTimeout(() => _showAchievementToast(a), i * 2200));
    } catch (e) {
      console.warn('[runAchievementChecks]', e);
    }
  }

  // Unlocks a single achievement by ID (reads state fresh — safe for one-off calls).
  async function unlockAchievement(id) {
    try {
      if (typeof getGamificationState !== 'function') return;
      const state = await getGamificationState();
      if (!state.unlockedIds) state.unlockedIds = [];
      if (state.unlockedIds.includes(id)) return;
      if (!state.unlockedDates) state.unlockedDates = {};
      state.unlockedIds.push(id);
      state.unlockedDates[id] = new Date().toISOString();
      if (typeof saveGamificationState === 'function') await saveGamificationState(state);
      const a = ACHIEVEMENTS.find(x => x.id === id);
      if (a) _showAchievementToast(a);
    } catch (e) {
      console.warn('[unlockAchievement]', e);
    }
  }

  // ── Toast UI ──────────────────────────────────────────────────

  function _showAchievementToast(achievement) {
    const prev = document.getElementById('achievementToast');
    if (prev) prev.remove();

    const toast = document.createElement('div');
    toast.id = 'achievementToast';
    toast.className = 'achievement-toast';
    toast.innerHTML =
      `<div class="achievement-toast-icon"><i data-lucide="${achievement.icon}" style="width:40px;height:40px;"></i></div>` +
      `<div class="achievement-toast-label">🏆 업적 달성</div>` +
      `<div class="achievement-toast-title">${achievement.title}</div>` +
      `<div class="achievement-toast-desc">${achievement.desc}</div>` +
      `<button class="achievement-toast-btn" id="achievToastOk">확인</button>`;

    document.body.appendChild(toast);
    window.mountLucideIcons?.();

    // Trigger enter animation on next frame
    requestAnimationFrame(() => requestAnimationFrame(() => toast.classList.add('achievement-toast--in')));

    const dismiss = () => {
      clearTimeout(timer);
      toast.classList.remove('achievement-toast--in');
      toast.classList.add('achievement-toast--out');
      setTimeout(() => { if (toast.isConnected) toast.remove(); }, 450);
    };
    const timer = setTimeout(dismiss, 4000);
    const okBtn = document.getElementById('achievToastOk');
    if (okBtn) okBtn.addEventListener('click', dismiss);
  }

  // ── Achievement grid ──────────────────────────────────────────

  async function renderAchievementGrid(parent, stateHint) {
    if (!parent) return;
    let state = stateHint;
    if (!state && typeof getGamificationState === 'function') {
      state = await getGamificationState().catch(() => ({}));
    }
    state = state || {};

    const unlockedIds   = state.unlockedIds   || [];
    const unlockedDates = state.unlockedDates  || {};
    const count         = unlockedIds.length;
    const total         = ACHIEVEMENTS.length;

    parent.innerHTML =
      `<div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:0.85rem;">` +
        `<span style="font-size:0.88rem;font-weight:700;color:var(--text);">내 업적</span>` +
        `<span style="font-size:0.8rem;color:var(--text-muted);">${count} / ${total} 달성</span>` +
      `</div>` +
      `<div class="achievement-grid"></div>`;

    const grid = parent.querySelector('.achievement-grid');
    ACHIEVEMENTS.forEach(a => {
      const isUnlocked = unlockedIds.includes(a.id);
      const dateStr    = unlockedDates[a.id]
        ? new Date(unlockedDates[a.id]).toLocaleDateString('ko-KR')
        : '';
      const cell = document.createElement('div');
      cell.className = 'achievement-cell' + (isUnlocked ? ' achievement-unlocked' : ' achievement-locked');
      cell.title = isUnlocked ? `${a.desc}\n달성일: ${dateStr}` : `잠금: ${a.desc}`;
      cell.innerHTML =
        `<div class="achievement-icon"><i data-lucide="${a.icon}"></i></div>` +
        `<div class="achievement-title">${a.title}</div>` +
        (isUnlocked ? '' : '<div class="achievement-lock">잠금</div>');
      grid.appendChild(cell);
    });

    window.mountLucideIcons?.();
  }

  // ── Style injection ────────────────────────────────────────────

  function _injectStyles() {
    if (document.getElementById('achievementStyles')) return;
    const style = document.createElement('style');
    style.id = 'achievementStyles';
    style.textContent = `
.achievement-toast {
  position:fixed;top:1.5rem;left:50%;
  transform:translateX(-50%) translateY(-160px);
  z-index:10001;
  background:linear-gradient(135deg,#1e1e3a 0%,#2a1a4a 100%);
  border:1px solid rgba(255,215,0,.35);
  border-radius:16px;padding:1.25rem 1.75rem;
  min-width:280px;max-width:360px;
  box-shadow:0 0 32px rgba(255,215,0,.18),0 8px 40px rgba(0,0,0,.55);
  text-align:center;opacity:0;
}
.achievement-toast--in  { animation:achievToastIn  .55s cubic-bezier(.34,1.56,.64,1) forwards; }
.achievement-toast--out { animation:achievToastOut .4s ease-in forwards; }
@keyframes achievToastIn {
  from { transform:translateX(-50%) translateY(-160px); opacity:0; }
  60%  { transform:translateX(-50%) translateY(10px);   opacity:1; }
  to   { transform:translateX(-50%) translateY(0);      opacity:1; }
}
@keyframes achievToastOut {
  from { transform:translateX(-50%) translateY(0);      opacity:1; }
  to   { transform:translateX(-50%) translateY(-130px); opacity:0; }
}
.achievement-toast-icon {
  color:gold;margin-bottom:.5rem;
  filter:drop-shadow(0 0 8px rgba(255,215,0,.55));
  animation:achievSparkle 1.8s ease-in-out infinite;
}
@keyframes achievSparkle {
  0%,100% { filter:drop-shadow(0 0 8px rgba(255,215,0,.55)); }
  50%     { filter:drop-shadow(0 0 18px rgba(255,215,0,.9)); }
}
.achievement-toast-label {
  font-size:.75rem;color:rgba(255,215,0,.75);
  font-weight:600;margin-bottom:.25rem;letter-spacing:.04em;
}
.achievement-toast-title { font-size:1.15rem;font-weight:800;color:#fff;margin-bottom:.3rem; }
.achievement-toast-desc  { font-size:.85rem;color:rgba(255,255,255,.6);margin-bottom:1rem; }
.achievement-toast-btn {
  padding:.45rem 1.5rem;
  background:rgba(255,215,0,.14);
  border:1px solid rgba(255,215,0,.35);
  border-radius:8px;color:rgba(255,215,0,.9);
  font-size:.9rem;font-weight:700;cursor:pointer;transition:background .15s;
}
.achievement-toast-btn:hover { background:rgba(255,215,0,.22); }
.achievement-grid {
  display:grid;
  grid-template-columns:repeat(auto-fill,minmax(82px,1fr));
  gap:.6rem;
}
@media(max-width:500px){ .achievement-grid { grid-template-columns:repeat(3,1fr); } }
.achievement-cell {
  border-radius:10px;padding:.7rem .35rem .55rem;
  text-align:center;position:relative;
  border:1px solid rgba(255,255,255,.07);
  transition:transform .15s;cursor:default;
}
.achievement-cell.achievement-unlocked {
  background:linear-gradient(135deg,rgba(124,77,255,.14) 0%,rgba(255,215,0,.09) 100%);
  border-color:rgba(255,215,0,.22);
}
.achievement-cell.achievement-unlocked:hover { transform:translateY(-2px); }
.achievement-cell.achievement-locked {
  background:var(--surface2,#16162a);filter:grayscale(1);opacity:.42;
}
.achievement-icon { width:28px;height:28px;margin:0 auto .35rem;color:var(--primary,#7c4dff); }
.achievement-icon svg { width:28px;height:28px; }
.achievement-cell.achievement-unlocked .achievement-icon {
  color:gold;filter:drop-shadow(0 0 4px rgba(255,215,0,.4));
}
.achievement-title { font-size:.7rem;line-height:1.3;color:var(--text-muted,#8888aa);word-break:keep-all; }
.achievement-cell.achievement-unlocked .achievement-title { color:var(--text,#e2e2f2); }
.achievement-lock {
  position:absolute;inset:0;display:flex;align-items:center;justify-content:center;
  font-size:.62rem;color:rgba(255,255,255,.3);pointer-events:none;border-radius:10px;
}
`;
    document.head.appendChild(style);
  }

  _injectStyles();

  window.ACHIEVEMENTS          = ACHIEVEMENTS;
  window.checkAchievements     = checkAchievements;
  window.runAchievementChecks  = runAchievementChecks;
  window.unlockAchievement     = unlockAchievement;
  window.renderAchievementGrid = renderAchievementGrid;

})();
