import './sidebar.css';
import { mountLoopNav } from './dashboard.js';

// Sidebar: brand, loop navigation, a session status indicator, and a settings
// button. The loop navigation is the session-driven navigator from dashboard.js,
// mounted into the sidebar's nav region: the sidebar renders the section chrome
// and delegates the loops and their lock state to the navigator, which reads lock
// state from the session (it holds none of its own). The sidebar carries no loop
// logic and no unlock state; it forwards the session through setSession.

export function mountSidebar(target, {
  activeLoop = 1,
  onSelectLoop,
  onNewSession,
  onClearSession,
  onSettings,
} = {}) {
  if (!target) throw new Error('mountSidebar: target is required');

  target.classList.add('sidebar');
  target.setAttribute('aria-label', 'Loop navigation and session controls');
  target.innerHTML = '';

  // ----- brand -----
  const brand = document.createElement('div');
  brand.className = 'brand-block';
  brand.innerHTML = '<h1 class="brand">OPUS CC</h1>';

  // ----- loop navigation section (chrome here, loops delegated) -----
  const nav = document.createElement('nav');
  nav.className = 'loop-nav-section';
  nav.setAttribute('aria-label', 'Loops');
  nav.innerHTML = '<p class="sidebar-label"><span class="bracket">[LOOPS]</span></p>';
  const navMount = document.createElement('div');
  nav.appendChild(navMount);

  // ----- session status indicator + controls -----
  const session = document.createElement('div');
  session.className = 'session-block';
  session.setAttribute('aria-label', 'Session');
  session.innerHTML = `
    <p class="sidebar-label"><span class="bracket">[SESSION]</span></p>
    <div class="session-status" id="session-status" data-state="idle">
      <span class="session-dot" aria-hidden="true"></span>
      <span class="session-id" id="session-id">S?</span>
      <span class="session-state" id="session-state">idle</span>
    </div>
  `;

  const controls = document.createElement('div');
  controls.className = 'session-controls';

  const newBtn = document.createElement('button');
  newBtn.type = 'button';
  newBtn.className = 'control-btn';
  newBtn.id = 'new-session';
  newBtn.textContent = 'NEW SESSION';
  newBtn.addEventListener('click', () => {
    if (typeof onNewSession === 'function') onNewSession();
  });

  const clearBtn = document.createElement('button');
  clearBtn.type = 'button';
  clearBtn.className = 'control-btn';
  clearBtn.id = 'clear-session';
  clearBtn.textContent = 'RESET';
  clearBtn.addEventListener('click', () => {
    if (typeof onClearSession === 'function') onClearSession();
  });

  controls.appendChild(newBtn);
  controls.appendChild(clearBtn);
  session.appendChild(controls);

  // ----- settings -----
  const footer = document.createElement('div');
  footer.className = 'sidebar-footer';
  const settingsBtn = document.createElement('button');
  settingsBtn.type = 'button';
  settingsBtn.className = 'control-btn settings-btn';
  settingsBtn.id = 'settings-btn';
  settingsBtn.textContent = 'SETTINGS';
  settingsBtn.addEventListener('click', () => {
    if (typeof onSettings === 'function') onSettings();
  });
  footer.appendChild(settingsBtn);

  target.appendChild(brand);
  target.appendChild(nav);
  target.appendChild(session);
  target.appendChild(footer);

  // The navigator owns the loops and their lock state.
  const loopNav = mountLoopNav(navMount, { onSelectLoop, activeLoop });

  const sessionStatus = session.querySelector('#session-status');
  const sessionIdEl = session.querySelector('#session-id');
  const sessionStateEl = session.querySelector('#session-state');

  // ----- API -----
  function setSessionId(id) {
    sessionIdEl.textContent = id;
  }

  function setSessionStatus(state) {
    sessionStatus.dataset.state = state;
    sessionStateEl.textContent = state;
  }

  return {
    // Loop navigation is delegated; the sidebar forwards the session through.
    setSession: loopNav.setSession,
    setActiveLoop: loopNav.setActiveLoop,
    isUnlocked: loopNav.isUnlocked,
    setSessionId,
    setSessionStatus,
  };
}
