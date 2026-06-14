import './fileCabinet.css';

// File cabinet: the research file as a manila folder with tabbed sections, surfaced
// as a drawer that slides up from a handle at the bottom of the canvas page.
//
// It is a DATA VIEW (like the Packet Inspector), not a conversation writer and not
// the composer, so the TurnGate rule is untouched: it never writes to Poe's feed. It
// reads a small, documented presentation contract and is schema-agnostic by design
// (Autonomy Charter): the RQPacket -> folders mapping lives in a Loop 1 adapter
// (rqfolders.js), never here. This component only renders whatever folders it is handed.
//
// Contract:
//   folders = [{ id, label, fields: [{ label, value, state }] }]
//     state (optional): 'filled' | 'empty' | 'unknown'. 'empty'/'unknown' dim the value.
//   A folder tab shows a small marker when any of its fields is 'filled'.
//
// API: mountFileCabinet(target, { onToggle }) -> { setFolders, setOpen, isOpen, clear }.

const HANDLE_OPEN = 'open research file';
const HANDLE_CLOSE = 'close research file';
const EMPTY_COPY = 'No research file yet. It fills in as you and Poe define the study.';

export function mountFileCabinet(target, { onToggle } = {}) {
  if (!target) throw new Error('mountFileCabinet: target is required');

  target.classList.add('file-cabinet');
  target.innerHTML = '';

  let folders = [];
  let activeId = null;
  let open = false;

  // ----- drawer (pops up above the handle) -----
  const drawer = document.createElement('div');
  drawer.className = 'file-cabinet-drawer';
  drawer.hidden = true;

  const tabs = document.createElement('div');
  tabs.className = 'file-cabinet-tabs';
  tabs.setAttribute('role', 'tablist');
  tabs.setAttribute('aria-label', 'Research file sections');

  const body = document.createElement('div');
  body.className = 'file-cabinet-body';

  drawer.appendChild(tabs);
  drawer.appendChild(body);

  // ----- handle (always visible, toggles the drawer) -----
  const handle = document.createElement('button');
  handle.type = 'button';
  handle.className = 'file-cabinet-handle';
  handle.setAttribute('aria-expanded', 'false');

  const handleTag = document.createElement('span');
  handleTag.className = 'bracket file-cabinet-handle-tag';
  handleTag.textContent = '[FILE]';
  const handleText = document.createElement('span');
  handleText.className = 'file-cabinet-handle-text';
  const handleCaret = document.createElement('span');
  handleCaret.className = 'file-cabinet-handle-caret';
  handle.appendChild(handleTag);
  handle.appendChild(document.createTextNode(' '));
  handle.appendChild(handleText);
  handle.appendChild(handleCaret);
  handle.addEventListener('click', () => setOpen(!open));

  target.appendChild(drawer);
  target.appendChild(handle);

  function bracket(text) {
    const span = document.createElement('span');
    span.className = 'bracket';
    span.textContent = text;
    return span;
  }

  function folderHasContent(folder) {
    return Array.isArray(folder.fields) && folder.fields.some((f) => f && f.state === 'filled');
  }

  function renderTabs() {
    tabs.replaceChildren();
    folders.forEach((folder) => {
      const tab = document.createElement('button');
      tab.type = 'button';
      tab.className = 'fc-tab';
      tab.dataset.folder = folder.id;
      tab.setAttribute('role', 'tab');
      const selected = folder.id === activeId;
      tab.setAttribute('aria-selected', String(selected));
      tab.classList.toggle('is-active', selected);
      if (folderHasContent(folder)) tab.dataset.filled = 'true';

      const label = document.createElement('span');
      label.className = 'fc-tab-label';
      label.textContent = folder.label;
      tab.appendChild(label);
      tab.addEventListener('click', () => setActive(folder.id));
      tabs.appendChild(tab);
    });
  }

  function renderBody() {
    body.replaceChildren();
    const folder = folders.find((f) => f.id === activeId);
    if (!folder) {
      const empty = document.createElement('p');
      empty.className = 'file-cabinet-empty';
      empty.textContent = EMPTY_COPY;
      body.appendChild(empty);
      return;
    }
    const list = document.createElement('dl');
    list.className = 'fc-fields';
    (folder.fields || []).forEach((field) => {
      const row = document.createElement('div');
      row.className = 'fc-field';
      const dt = document.createElement('dt');
      dt.className = 'fc-field-label';
      dt.appendChild(bracket(`[${field.label}]`));
      const dd = document.createElement('dd');
      dd.className = 'fc-field-value';
      if (field.state === 'empty' || field.state === 'unknown') dd.dataset.placeholder = 'true';
      dd.textContent = field.value == null ? '' : String(field.value);
      row.appendChild(dt);
      row.appendChild(dd);
      list.appendChild(row);
    });
    body.appendChild(list);
  }

  function syncHandle() {
    handle.setAttribute('aria-expanded', String(open));
    handle.dataset.open = String(open);
    handleText.textContent = open ? HANDLE_CLOSE : HANDLE_OPEN;
    handleCaret.textContent = open ? ' v' : ' ^';
  }

  // ----- public API -----
  function setActive(id) {
    if (!folders.some((f) => f.id === id)) return;
    activeId = id;
    renderTabs();
    renderBody();
  }

  function setFolders(next) {
    folders = Array.isArray(next) ? next.filter((f) => f && f.id != null) : [];
    // Preserve the open section across updates; default to the first.
    if (!folders.some((f) => f.id === activeId)) {
      activeId = folders.length ? folders[0].id : null;
    }
    renderTabs();
    renderBody();
  }

  function setOpen(next) {
    open = Boolean(next);
    drawer.hidden = !open;
    syncHandle();
    if (typeof onToggle === 'function') onToggle(open);
  }

  function clear() {
    setFolders([]);
  }

  syncHandle();
  renderBody();

  return {
    setFolders,
    setActive,
    setOpen,
    isOpen: () => open,
    getActive: () => activeId,
    clear,
  };
}
