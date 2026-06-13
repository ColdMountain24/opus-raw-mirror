import './agentConsole.css';

// Agent console: a live, scrolling feed of agent activity. Each entry renders
// as [AGENT_NAME] STATUS_MESSAGE. The bracketed agent name uses the amber
// bracket token; a running agent's message uses the active (green) token; a
// completed entry dims to 60 percent. This component renders only what it is
// handed. It holds no agent logic and no packet schema; those are owned
// upstream.

const STATES = new Set(['pending', 'running', 'done', 'error']);

export function mountAgentConsole(target) {
  if (!target) throw new Error('mountAgentConsole: target is required');

  target.classList.add('agent-console');
  target.innerHTML = '';

  const feed = document.createElement('div');
  feed.className = 'console-feed';
  feed.setAttribute('role', 'log');
  feed.setAttribute('aria-live', 'polite');
  feed.setAttribute('aria-label', 'Agent activity');

  // Idle placeholder. Unique copy, never a generic "Loading...".
  const empty = document.createElement('p');
  empty.className = 'console-empty';
  empty.textContent = 'idle. No agent chain running.';
  feed.appendChild(empty);

  target.appendChild(feed);

  let seq = 0;
  const entries = new Map();

  function syncEmpty() {
    empty.style.display = entries.size === 0 ? '' : 'none';
  }

  function render(entry) {
    entry.el.dataset.state = entry.state;
    entry.el.querySelector('.console-msg').textContent = entry.message;
  }

  function pushEntry({ agent, message = '', state = 'running' } = {}) {
    if (!agent) throw new Error('pushEntry: agent name is required');
    const safeState = STATES.has(state) ? state : 'running';
    const id = `e${(seq += 1)}`;

    const el = document.createElement('div');
    el.className = 'console-entry';
    el.dataset.entry = id;

    const name = document.createElement('span');
    name.className = 'bracket console-agent';
    name.textContent = `[${agent}]`;

    const msg = document.createElement('span');
    msg.className = 'console-msg';

    el.appendChild(name);
    el.appendChild(document.createTextNode(' '));
    el.appendChild(msg);
    feed.appendChild(el);

    const entry = { id, agent, message, state: safeState, el };
    entries.set(id, entry);
    render(entry);
    syncEmpty();
    feed.scrollTop = feed.scrollHeight;
    return id;
  }

  function updateEntry(id, patch = {}) {
    const entry = entries.get(id);
    if (!entry) return false;
    if (typeof patch.message === 'string') entry.message = patch.message;
    if (patch.state && STATES.has(patch.state)) entry.state = patch.state;
    render(entry);
    feed.scrollTop = feed.scrollHeight;
    return true;
  }

  function complete(id, message) {
    const patch = { state: 'done' };
    if (typeof message === 'string') patch.message = message;
    return updateEntry(id, patch);
  }

  function clear() {
    entries.clear();
    feed.querySelectorAll('.console-entry').forEach((el) => el.remove());
    syncEmpty();
  }

  return {
    pushEntry,
    updateEntry,
    complete,
    clear,
    get size() {
      return entries.size;
    },
  };
}
