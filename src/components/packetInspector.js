import './packetInspector.css';

// Packet inspector: a raw, structured view of whatever packet it is handed. It
// is schema-agnostic by design. Packet schemas are owned upstream, not here, so
// this component makes no assumption about packet shape: objects are
// pretty-printed as JSON, strings are shown verbatim.

export function mountPacketInspector(target) {
  if (!target) throw new Error('mountPacketInspector: target is required');

  target.classList.add('packet-inspector');
  target.innerHTML = '';

  const pre = document.createElement('pre');
  pre.className = 'packet-output';
  target.appendChild(pre);

  function clear() {
    pre.textContent = 'no packet loaded.';
    pre.dataset.empty = 'true';
  }

  function setPacket(packet) {
    if (packet == null) {
      clear();
      return;
    }
    if (typeof packet === 'string') {
      pre.textContent = packet;
      pre.dataset.empty = 'false';
      return;
    }
    try {
      pre.textContent = JSON.stringify(packet, null, 2);
      pre.dataset.empty = 'false';
    } catch (err) {
      // Circular or non-serializable. Surface it rather than swallow it.
      const reason = err && err.message ? err.message : String(err);
      pre.textContent = `[unrenderable packet] ${reason}`;
      pre.dataset.empty = 'false';
    }
  }

  clear();
  return { setPacket, clear };
}
