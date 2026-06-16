import { describe, expect, it, vi } from 'vitest';
import { mountMatrixRain } from '../src/components/matrixRain.js';

// The Matrix transition overlay. jsdom has no 2D canvas context, so the real-render
// path is exercised with an injected fake context + a synchronous frame source, the
// same DI rationale as the Observatory harness.

function fakeCtx() {
  return {
    fillStyle: '',
    font: '',
    fillRect: vi.fn(),
    fillText: vi.fn(),
  };
}

describe('mountMatrixRain', () => {
  it('requires a target', () => {
    expect(() => mountMatrixRain(null)).toThrow();
  });

  it('mounts a canvas overlay and tears it down on destroy', () => {
    const target = document.createElement('div');
    const rain = mountMatrixRain(target);
    const canvas = target.querySelector('canvas.matrix-rain');
    expect(canvas).toBeTruthy();
    rain.destroy();
    expect(target.querySelector('canvas.matrix-rain')).toBeNull();
  });

  it('no-ops (resolves) when there is no 2D context (jsdom / unsupported)', async () => {
    const target = document.createElement('div');
    const rain = mountMatrixRain(target); // jsdom getContext('2d') -> null
    expect(rain.hasContext()).toBe(false);
    await expect(rain.play(1000)).resolves.toBeUndefined();
  });

  it('drives the animation to completion with an injected context and frame source', async () => {
    const target = document.createElement('div');
    const ctx = fakeCtx();
    // Synchronous frame source + a clock that advances past the duration in a few frames.
    const requestFrame = (cb) => {
      cb();
      return 1;
    };
    let t = 0;
    const now = () => {
      const v = t;
      t += 60;
      return v;
    };
    const rain = mountMatrixRain(target, { context: ctx, requestFrame, now, random: () => 0.5 });
    expect(rain.hasContext()).toBe(true);
    await rain.play(100); // start=0; frames at 60 (<100) then 120 (>=100) -> resolve
    expect(ctx.fillRect).toHaveBeenCalled();
    expect(ctx.fillText).toHaveBeenCalled();
  });

  it('destroy stops a running animation (cancelFrame called)', () => {
    const target = document.createElement('div');
    const cancelFrame = vi.fn();
    // A frame source that does not auto-advance, so the loop is left pending.
    const rain = mountMatrixRain(target, {
      context: fakeCtx(),
      requestFrame: () => 7,
      cancelFrame,
      now: () => 0,
    });
    rain.play(1000);
    rain.destroy();
    expect(cancelFrame).toHaveBeenCalledWith(7);
  });
});
