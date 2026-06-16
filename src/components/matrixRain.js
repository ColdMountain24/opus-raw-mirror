import './matrixRain.css';

// The Digital Rain / Matrix Code transition.
//
// A transient full-surface overlay that plays when the app enters Loop 2 (the
// data-loop="2" flip), bridging the Loop 1 look to the Loop 2 (aged-paper) look. By
// user direction (2026-06-14) this is the CLASSIC green-on-black Matrix rain - a
// deliberate, time-boxed exception to the Dusty/Win98 visual law, confined to the
// transition; it fades out to reveal the dusty Loop 2 surface beneath.
//
// Canvas + requestAnimationFrame are dependency-injected and guarded (the same DI
// rationale as the Observatory and Poe's measure()): jsdom has no 2D context, so play()
// is a no-op that resolves immediately rather than throwing. It owns its DOM + CSS and
// returns a method API: play(durationMs) -> Promise, destroy().

const GLYPHS = 'アカサタナハマヤラワ0123456789ABCDEFｱｶｻﾀﾅ<>=*+#';
const FONT_SIZE = 14;

export function mountMatrixRain(target, opts = {}) {
  if (!target) throw new Error('mountMatrixRain: target is required');

  const doc = opts.document || (typeof document !== 'undefined' ? document : null);
  const now = typeof opts.now === 'function' ? opts.now : () => Date.now();
  const raf =
    opts.requestFrame ||
    (typeof requestAnimationFrame === 'function' ? requestAnimationFrame.bind(globalThis) : null);
  const caf =
    opts.cancelFrame ||
    (typeof cancelAnimationFrame === 'function' ? cancelAnimationFrame.bind(globalThis) : null);
  const random = typeof opts.random === 'function' ? opts.random : Math.random;

  let canvas = null;
  let ctx = null;
  if (doc) {
    canvas = doc.createElement('canvas');
    canvas.className = 'matrix-rain';
    canvas.setAttribute('aria-hidden', 'true');
    target.appendChild(canvas);
    // Injected context wins (tests); otherwise the real 2D context (null in jsdom).
    ctx = opts.context || (typeof canvas.getContext === 'function' ? canvas.getContext('2d') : null);
  }

  let running = false;
  let frameId = null;
  let columns = [];

  function seed() {
    const w = (canvas.width = target.clientWidth || canvas.width || 800);
    const h = (canvas.height = target.clientHeight || canvas.height || 600);
    const cols = Math.max(1, Math.floor(w / FONT_SIZE));
    columns = new Array(cols).fill(0).map(() => Math.floor(random() * (h / FONT_SIZE)));
  }

  function drawFrame(elapsed, durationMs) {
    const w = canvas.width;
    const h = canvas.height;
    // Translucent black wash leaves fading green trails.
    ctx.fillStyle = 'rgba(0, 0, 0, 0.08)';
    ctx.fillRect(0, 0, w, h);
    // Fade the overlay out over the last 40% so the dusty surface emerges.
    const fadeFrom = durationMs * 0.6;
    if (canvas.style) {
      canvas.style.opacity =
        elapsed > fadeFrom ? String(Math.max(0, 1 - (elapsed - fadeFrom) / (durationMs - fadeFrom))) : '1';
    }
    ctx.fillStyle = '#00ff66';
    ctx.font = `${FONT_SIZE}px monospace`;
    for (let i = 0; i < columns.length; i += 1) {
      const ch = GLYPHS[Math.floor(random() * GLYPHS.length)];
      const y = columns[i] * FONT_SIZE;
      ctx.fillText(ch, i * FONT_SIZE, y);
      columns[i] = y > h && random() > 0.975 ? 0 : columns[i] + 1;
    }
  }

  // Play the rain for durationMs, then resolve. A no-op (resolved) when there is no 2D
  // context or no animation frame source (jsdom / unsupported), so callers can always
  // await it.
  function play(durationMs = 1500) {
    if (!ctx || !raf || !canvas) return Promise.resolve();
    running = true;
    seed();
    const start = now();
    return new Promise((resolve) => {
      const frame = () => {
        if (!running) {
          resolve();
          return;
        }
        const elapsed = now() - start;
        drawFrame(elapsed, durationMs);
        if (elapsed >= durationMs) {
          running = false;
          resolve();
          return;
        }
        frameId = raf(frame);
      };
      frameId = raf(frame);
    });
  }

  function destroy() {
    running = false;
    if (frameId != null && caf) {
      try {
        caf(frameId);
      } catch (_err) {
        // a stale frame id is harmless
      }
      frameId = null;
    }
    if (canvas && target.contains(canvas)) target.removeChild(canvas);
    canvas = null;
    ctx = null;
  }

  return { play, destroy, hasContext: () => Boolean(ctx) };
}
