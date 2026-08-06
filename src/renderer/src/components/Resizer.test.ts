import type { MouseEvent as ReactMouseEvent } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { clamp, fractionAt, readStored, trackDrag } from './Resizer.js';

/** Enough of the Storage API for readStored; the node env has none of its own. */
function stubStorage(seed: Record<string, string> = {}) {
  const store = new Map(Object.entries(seed));
  (globalThis as { localStorage?: unknown }).localStorage = {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => void store.set(k, v),
  };
}

describe('clamp', () => {
  it('passes values inside the range through', () => {
    expect(clamp(0.42, 0.05, 0.95)).toBe(0.42);
  });

  it('holds at each bound', () => {
    expect(clamp(-3, 0.05, 0.95)).toBe(0.05);
    expect(clamp(99, 0.05, 0.95)).toBe(0.95);
  });
});

describe('readStored', () => {
  beforeEach(() => stubStorage());
  afterEach(() => {
    delete (globalThis as { localStorage?: unknown }).localStorage;
  });

  it('falls back to the initial value when nothing is saved', () => {
    expect(readStored('margin.split.diff', 0.5, 0.05, 0.95)).toBe(0.5);
  });

  it('returns a saved value that is in range', () => {
    stubStorage({ 'margin.split.diff': '0.3' });
    expect(readStored('margin.split.diff', 0.5, 0.05, 0.95)).toBe(0.3);
  });

  it('rejects a saved value that falls outside the current bounds', () => {
    // A width saved before the min was raised, or a hand-edited entry.
    stubStorage({ 'margin.width.review': '90' });
    expect(readStored('margin.width.review', 340, 260, 720)).toBe(340);
  });

  it('rejects junk rather than yielding NaN', () => {
    stubStorage({ 'margin.split.diff': 'wide' });
    expect(readStored('margin.split.diff', 0.5, 0.05, 0.95)).toBe(0.5);
  });

  it('does not read a missing key as zero', () => {
    // Number(null) is 0, which sits inside a range spanning zero and would
    // otherwise be taken for a real saved value.
    expect(readStored('margin.split.absent', 0.5, -1, 1)).toBe(0.5);
  });
});

describe('fractionAt', () => {
  const area = { left: 200, width: 800 };

  it('maps a pointer to its share of the area', () => {
    expect(fractionAt(600, area, 0.05, 0.95)).toBe(0.5);
    expect(fractionAt(400, area, 0.05, 0.95)).toBe(0.25);
  });

  it('clamps rather than letting a side vanish', () => {
    expect(fractionAt(-500, area, 0.05, 0.95)).toBe(0.05);
    expect(fractionAt(5000, area, 0.05, 0.95)).toBe(0.95);
  });

  it('measures from the area, not the viewport', () => {
    // The diff's split starts after the line-number gutter, so a pointer at the
    // window's midpoint is not the split's midpoint.
    expect(fractionAt(200, area, 0.05, 0.95)).toBe(0.05);
  });
});

/** Enough of window and document.body for trackDrag; the node env has neither. */
function stubDom() {
  const listeners = new Map<string, Set<(e: unknown) => void>>();
  const classes = new Set<string>();
  const g = globalThis as Record<string, unknown>;
  g.window = {
    addEventListener: (type: string, fn: (e: unknown) => void) => {
      if (!listeners.has(type)) listeners.set(type, new Set());
      listeners.get(type)!.add(fn);
    },
    removeEventListener: (type: string, fn: (e: unknown) => void) => {
      listeners.get(type)?.delete(fn);
    },
  };
  g.document = {
    body: { classList: { add: (c: string) => classes.add(c), remove: (c: string) => classes.delete(c) } },
  };
  return {
    classes,
    listenerCount: (type: string) => listeners.get(type)?.size ?? 0,
    fire: (type: string, clientX?: number) => listeners.get(type)?.forEach((fn) => fn({ clientX })),
  };
}

describe('trackDrag', () => {
  let dom: ReturnType<typeof stubDom>;
  const press = (clientX: number) =>
    ({ clientX, preventDefault: () => {} }) as ReactMouseEvent;

  beforeEach(() => {
    dom = stubDom();
  });
  afterEach(() => {
    const g = globalThis as Record<string, unknown>;
    delete g.window;
    delete g.document;
  });

  it('follows the pointer and commits the last value once', () => {
    const onMove = vi.fn();
    const onDone = vi.fn();
    trackDrag(press(100), (x) => x, onMove, onDone);
    dom.fire('mousemove', 140);
    dom.fire('mousemove', 180);
    dom.fire('mouseup');
    expect(onMove.mock.calls).toEqual([[140], [180]]);
    expect(onDone.mock.calls).toEqual([[180]]);
  });

  it('holds the resizing class back until the pointer moves', () => {
    // It disables pointer events document-wide. Setting it on mousedown took the
    // handle out of the hit test for the following mouseup, so the click — and
    // with it any double-click — landed on <body> instead of the handle.
    trackDrag(press(100), (x) => x, vi.fn(), vi.fn());
    expect(dom.classes.has('resizing')).toBe(false);
    dom.fire('mousemove', 140);
    expect(dom.classes.has('resizing')).toBe(true);
    dom.fire('mouseup');
    expect(dom.classes.has('resizing')).toBe(false);
  });

  it('commits nothing for a press that never moves', () => {
    // Otherwise a click on the seam snaps the split to wherever it landed.
    const onDone = vi.fn();
    trackDrag(press(100), (x) => x, vi.fn(), onDone);
    dom.fire('mouseup');
    expect(onDone).not.toHaveBeenCalled();
  });

  it('lets go of its listeners on mouseup', () => {
    trackDrag(press(100), (x) => x, vi.fn(), vi.fn());
    expect(dom.listenerCount('mousemove')).toBe(1);
    dom.fire('mouseup');
    expect(dom.listenerCount('mousemove')).toBe(0);
    expect(dom.listenerCount('mouseup')).toBe(0);
  });
});
