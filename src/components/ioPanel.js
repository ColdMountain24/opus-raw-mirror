import './ioPanel.css';
import { mountAgentConsole } from './agentConsole.js';
import { mountPacketInspector } from './packetInspector.js';

// IO panel: hosts two tabs, Agent Console and Packet Inspector, plus a slim
// debug trace footer (the dispatcher telemetry surface, populated in later
// phases) and a collapsed rail. The panel owns its own collapse rendering via a
// data-collapsed attribute; it reports the collapse intent through a callback so
// the shell can resize the grid. It stays loop-agnostic.

const TABS = [
  { id: 'console', label: '[AGENT_CONSOLE]' },
  { id: 'packet', label: '[PACKET]' },
];

const DEBUG_FIELDS = [
  ['session', '[SESSION]', 'S?'],
  ['prompt', '[PROMPT_VER]', '-'],
  ['model', '[MODEL]', '-'],
  ['retries', '[RETRIES]', '0'],
  ['fallback', '[FALLBACK]', 'none'],
  ['cache', '[CACHE]', 'cold'],
];

export function mountIoPanel(target, { onToggleCollapse } = {}) {
  if (!target) throw new Error('mountIoPanel: target is required');

  target.classList.add('io-panel');
  target.innerHTML = '';
  target.dataset.collapsed = 'false';
  target.dataset.activeTab = 'console';

  const tabEls = new Map();
  const panelEls = new Map();
  const debugEls = new Map();

  // ----- header: tablist + collapse control -----
  const header = document.createElement('header');
  header.className = 'io-header';

  const tablist = document.createElement('div');
  tablist.className = 'io-tabs';
  tablist.setAttribute('role', 'tablist');
  tablist.setAttribute('aria-label', 'IO panel views');

  TABS.forEach((tab) => {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'io-tab';
    btn.id = `io-tabbtn-${tab.id}`;
    btn.dataset.tab = tab.id;
    btn.setAttribute('role', 'tab');
    btn.setAttribute('aria-controls', `io-tab-${tab.id}`);
    btn.innerHTML = `<span class="bracket">${tab.label}</span>`;
    btn.addEventListener('click', () => setActiveTab(tab.id));
    tablist.appendChild(btn);
    tabEls.set(tab.id, btn);
  });

  const collapseBtn = document.createElement('button');
  collapseBtn.type = 'button';
  collapseBtn.className = 'io-toggle';
  collapseBtn.id = 'io-toggle';
  collapseBtn.setAttribute('aria-expanded', 'true');
  collapseBtn.setAttribute('aria-controls', 'io-body');
  collapseBtn.title = 'Collapse IO panel';
  collapseBtn.textContent = 'COLLAPSE';
  collapseBtn.addEventListener('click', () => setCollapsed(true));

  header.appendChild(tablist);
  header.appendChild(collapseBtn);

  // ----- body: tab panels -----
  const body = document.createElement('div');
  body.className = 'io-body';
  body.id = 'io-body';

  TABS.forEach((tab) => {
    const panel = document.createElement('div');
    panel.className = 'io-tabpanel';
    panel.id = `io-tab-${tab.id}`;
    panel.setAttribute('role', 'tabpanel');
    panel.setAttribute('aria-labelledby', `io-tabbtn-${tab.id}`);
    body.appendChild(panel);
    panelEls.set(tab.id, panel);
  });

  // ----- debug trace footer -----
  const footer = document.createElement('div');
  footer.className = 'io-debug';
  footer.setAttribute('aria-label', 'Dispatcher trace');
  const dl = document.createElement('dl');
  dl.className = 'debug-fields';
  dl.id = 'debug-fields';
  DEBUG_FIELDS.forEach(([key, label, def]) => {
    const row = document.createElement('div');
    row.className = 'debug-row';
    const dt = document.createElement('dt');
    dt.className = 'bracket';
    dt.textContent = label;
    const dd = document.createElement('dd');
    dd.id = `dbg-${key}`;
    dd.textContent = def;
    row.appendChild(dt);
    row.appendChild(dd);
    dl.appendChild(row);
    debugEls.set(key, dd);
  });
  footer.appendChild(dl);

  // ----- collapsed rail: vertical label doubles as the expand control -----
  const rail = document.createElement('button');
  rail.type = 'button';
  rail.className = 'io-rail';
  rail.id = 'io-rail';
  rail.setAttribute('aria-label', 'Expand IO panel');
  rail.title = 'Expand IO panel';
  rail.innerHTML = '<span class="io-rail-label bracket">[IO]</span>';
  rail.addEventListener('click', () => setCollapsed(false));

  target.appendChild(header);
  target.appendChild(body);
  target.appendChild(footer);
  target.appendChild(rail);

  // ----- mount the two views into their panels -----
  const consoleApi = mountAgentConsole(panelEls.get('console'));
  const packetApi = mountPacketInspector(panelEls.get('packet'));

  // ----- behavior -----
  function setActiveTab(id) {
    if (!panelEls.has(id)) return;
    target.dataset.activeTab = id;
    tabEls.forEach((btn, key) => {
      const selected = key === id;
      btn.setAttribute('aria-selected', String(selected));
      btn.classList.toggle('is-active', selected);
    });
    panelEls.forEach((panel, key) => {
      panel.hidden = key !== id;
    });
  }

  function setCollapsed(collapsed) {
    const next = Boolean(collapsed);
    target.dataset.collapsed = String(next);
    collapseBtn.setAttribute('aria-expanded', String(!next));
    if (typeof onToggleCollapse === 'function') onToggleCollapse(next);
  }

  function setTrace(patch = {}) {
    Object.entries(patch).forEach(([key, value]) => {
      const dd = debugEls.get(key);
      if (dd) dd.textContent = String(value);
    });
  }

  setActiveTab('console');
  setCollapsed(false);

  return {
    console: consoleApi,
    packet: packetApi,
    setActiveTab,
    setCollapsed,
    setTrace,
    isCollapsed: () => target.dataset.collapsed === 'true',
    activeTab: () => target.dataset.activeTab,
  };
}
