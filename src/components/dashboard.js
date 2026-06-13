import './dashboard.css';

// Dashboard and loop navigator.
//
// The dashboard is the landing view shown before any loop is active: the RAW
// logo, the current session state, and a Begin button that launches Loop 1. The
// loop navigator renders the six loops; it derives lock state from the session
// store and holds none of its own. Both receive session state through
// setSession(session) and report user intent through callbacks. Neither contains
// loop-specific logic: launching or navigating to a loop is reported out, and the
// loop orchestrator (a later phase) mounts into the center canvas.
//
// Both read a small, documented set of presentation fields from the session and
// are tolerant of their absence. The session schema is owned upstream (Autonomy
// Charter); these components never define or mutate it.
//
//   session.researchQuestion  string   shown on the dashboard if present
//   session.currentLoop       number   shown on the dashboard
//   session.lastActiveAt      number|string  shown on the dashboard
//   session.completedLoops    number[] drives navigator lock state

const LOOP_COUNT = 6;

function formatTimestamp(value) {
  if (value == null) return 'never';
  const d = typeof value === 'number' ? new Date(value) : new Date(String(value));
  if (Number.isNaN(d.getTime())) return String(value);
  return d.toISOString();
}

// ---------------------------------------------------------------------------
// Loop navigator. Lock state is derived from session.completedLoops on every
// setSession; the navigator keeps the injected session as the source of truth
// and no independent lock state. A loop is unlocked when it is Loop 1 or its
// immediately preceding loop is complete.
// ---------------------------------------------------------------------------
export function mountLoopNav(target, { onSelectLoop, activeLoop = 1 } = {}) {
  if (!target) throw new Error('mountLoopNav: target is required');

  target.classList.add('loop-nav');
  target.setAttribute('role', 'navigation');
  target.setAttribute('aria-label', 'Loop navigation');
  target.innerHTML = '';

  let session = null;
  let active = Number(activeLoop);
  const navItems = new Map();

  function isUnlocked(n) {
    if (n === 1) return true;
    const completed = session && Array.isArray(session.completedLoops) ? session.completedLoops : [];
    return completed.includes(n - 1);
  }

  function paint(btn, n) {
    const locked = !isUnlocked(n);
    btn.disabled = locked;
    btn.dataset.locked = String(locked);
    btn.setAttribute('aria-disabled', String(locked));
    btn.setAttribute('aria-pressed', String(!locked && n === active));
    btn.innerHTML = locked
      ? `<span class="nav-label">LOOP ${n}</span><span class="nav-lock bracket">[LOCKED]</span>`
      : `<span class="nav-label">LOOP ${n}</span>`;
  }

  function applyLocks() {
    navItems.forEach((btn, n) => paint(btn, n));
  }

  for (let n = 1; n <= LOOP_COUNT; n += 1) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'nav-item';
    btn.dataset.loop = String(n);
    target.appendChild(btn);
    navItems.set(n, btn);
  }
  applyLocks();

  // Delegated click: a locked loop is disabled, so it never selects. Delegation
  // survives the per-button relabel in paint().
  target.addEventListener('click', (event) => {
    const btn = event.target.closest('.nav-item');
    if (!btn || btn.disabled) return;
    const n = Number(btn.dataset.loop);
    setActiveLoop(n);
    if (typeof onSelectLoop === 'function') onSelectLoop(n);
  });

  function setSession(next) {
    session = next || null;
    applyLocks();
  }

  function setActiveLoop(n) {
    active = Number(n);
    navItems.forEach((btn, key) => {
      btn.setAttribute('aria-pressed', String(!btn.disabled && key === active));
    });
  }

  return { setSession, setActiveLoop, isUnlocked };
}

// ---------------------------------------------------------------------------
// Dashboard landing view.
// ---------------------------------------------------------------------------
export function mountDashboard(target, { onBegin } = {}) {
  if (!target) throw new Error('mountDashboard: target is required');

  target.classList.add('dashboard');
  target.innerHTML = '';

  // ----- logo -----
  const logo = document.createElement('div');
  logo.className = 'dashboard-logo';
  logo.innerHTML = `
    <p class="dashboard-mark">RAW</p>
    <p class="dashboard-sub">OPUS CC RAW MIRROR</p>
  `;

  // ----- session state -----
  const state = document.createElement('dl');
  state.className = 'dashboard-state';
  state.setAttribute('aria-label', 'Session state');

  function field(key, label, def) {
    const wrap = document.createElement('div');
    wrap.className = 'dashboard-field';
    const dt = document.createElement('dt');
    dt.className = 'bracket';
    dt.textContent = label;
    const dd = document.createElement('dd');
    dd.id = `dash-${key}`;
    dd.textContent = def;
    wrap.appendChild(dt);
    wrap.appendChild(dd);
    state.appendChild(wrap);
    return dd;
  }

  const questionEl = field('question', '[RESEARCH_QUESTION]', 'No research question set.');
  const loopEl = field('loop', '[CURRENT_LOOP]', 'not started');
  const activeEl = field('active', '[LAST_ACTIVE]', 'never');

  // ----- begin -----
  const begin = document.createElement('button');
  begin.type = 'button';
  begin.className = 'dashboard-begin';
  begin.id = 'dashboard-begin';
  begin.textContent = 'Begin';
  begin.addEventListener('click', () => {
    if (typeof onBegin === 'function') onBegin();
  });

  target.appendChild(logo);
  target.appendChild(state);
  target.appendChild(begin);

  function setSession(session) {
    const s = session || {};
    questionEl.textContent =
      typeof s.researchQuestion === 'string' && s.researchQuestion.length > 0
        ? s.researchQuestion
        : 'No research question set.';
    loopEl.textContent = s.currentLoop != null ? `LOOP ${s.currentLoop}` : 'not started';
    activeEl.textContent = formatTimestamp(s.lastActiveAt);
  }

  return { setSession };
}
