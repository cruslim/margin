import { useCallback, useEffect, useState } from 'react';

export const clamp = (v: number, min: number, max: number) => Math.min(max, Math.max(min, v));

/**
 * Reads a stored number, falling back to `initial` unless it is in range — a
 * saved value can outlive the bounds it was saved under. The missing key is
 * checked separately because `Number(null)` is 0, which would slip through as
 * a legitimate value for any range spanning zero.
 */
export function readStored(storageKey: string, initial: number, min: number, max: number) {
  const raw = localStorage.getItem(storageKey);
  if (raw === null) return initial;
  const saved = Number(raw);
  return Number.isFinite(saved) && saved >= min && saved <= max ? saved : initial;
}

/** Where a pointer falls within `area`, as a clamped 0..1 fraction of its width. */
export function fractionAt(clientX: number, area: { left: number; width: number }, min: number, max: number) {
  return clamp((clientX - area.left) / area.width, min, max);
}

/**
 * Mouse plumbing shared by the drag handles: follows a horizontal drag, mapping
 * each x to a value, and hands the last value to `onDone` so callers write to
 * storage once at the end rather than on every frame.
 */
function trackDrag(
  e: React.MouseEvent,
  valueAt: (clientX: number) => number,
  onMove: (value: number) => void,
  onDone: (value: number) => void,
) {
  e.preventDefault();
  let last = valueAt(e.clientX);
  const move = (ev: MouseEvent) => {
    last = valueAt(ev.clientX);
    onMove(last);
  };
  const up = () => {
    window.removeEventListener('mousemove', move);
    window.removeEventListener('mouseup', up);
    document.body.classList.remove('resizing');
    onDone(last);
  };
  document.body.classList.add('resizing');
  window.addEventListener('mousemove', move);
  window.addEventListener('mouseup', up);
}

/**
 * Draggable panel width, persisted to localStorage. `dir` is +1 when the
 * handle sits on the panel's right edge (drag right = wider) and -1 when it
 * sits on the left edge (drag left = wider).
 */
export function usePanelWidth(key: string, initial: number, min: number, max: number, dir: 1 | -1) {
  const storageKey = `margin.width.${key}`;
  const [width, setWidth] = useState<number>(() => readStored(storageKey, initial, min, max));

  const startDrag = useCallback(
    (e: React.MouseEvent) => {
      const startX = e.clientX;
      const startW = width;
      trackDrag(
        e,
        (x) => clamp(startW + dir * (x - startX), min, max),
        setWidth,
        (w) => localStorage.setItem(storageKey, String(w)),
      );
    },
    [width, min, max, dir, storageKey],
  );

  return { width, startDrag };
}

/**
 * Where a divider sits *inside* a laid-out element, as a fraction of the space
 * it splits. Panel widths don't work for the diff's two sides: they are columns
 * of the diff library's own table, so their pixel widths depend on whatever the
 * pane happens to be, not on a size we own.
 *
 * `override` shadows the saved preference for one file — a wholly added file has
 * no old side worth half the pane, but that shouldn't reset the split you chose
 * for ordinary files. Dragging while an override is active adjusts the override;
 * dragging otherwise updates the saved preference.
 */
export function useSplitFraction(key: string, initial: number, min: number, max: number) {
  const storageKey = `margin.split.${key}`;
  const [stored, setStored] = useState<number>(() => readStored(storageKey, initial, min, max));
  const [override, setOverrideState] = useState<number | null>(null);

  /** Stable identity: DiffPane sets this from an effect keyed on the open file. */
  const setOverride = useCallback((f: number | null) => setOverrideState(f), []);

  const startDrag = useCallback(
    /**
     * `area` is the span being divided, in client coordinates. `preview` paints
     * each frame straight onto the DOM and state is committed only on mouseup:
     * re-rendering DiffPane rebuilds the diff table, which would tear down an
     * open composer mid-drag (see the note on its composer refs).
     */
    (e: React.MouseEvent, area: { left: number; width: number }, preview: (f: number) => void) => {
      if (area.width <= 0) return;
      const perFile = override !== null;
      trackDrag(
        e,
        (x) => fractionAt(x, area, min, max),
        preview,
        (f) => {
          if (perFile) return setOverrideState(f);
          setStored(f);
          localStorage.setItem(storageKey, String(f));
        },
      );
    },
    [override, min, max, storageKey],
  );

  const reset = useCallback(() => {
    setOverrideState(null);
    setStored(initial);
    localStorage.setItem(storageKey, String(initial));
  }, [initial, storageKey]);

  return { fraction: override ?? stored, setOverride, startDrag, reset };
}

/**
 * Whether a panel is collapsed, persisted next to its width so the layout comes
 * back the way you left it. The width is kept while collapsed, so expanding
 * restores the size you had rather than a default.
 */
export function usePanelCollapsed(key: string) {
  const storageKey = `margin.collapsed.${key}`;
  const [collapsed, setCollapsed] = useState(() => localStorage.getItem(storageKey) === '1');

  useEffect(() => {
    localStorage.setItem(storageKey, collapsed ? '1' : '0');
  }, [collapsed, storageKey]);

  const toggle = useCallback(() => setCollapsed((c) => !c), []);
  return { collapsed, toggle };
}

export function ResizeHandle(props: { onMouseDown: (e: React.MouseEvent) => void }) {
  return <div className="resize-handle" onMouseDown={props.onMouseDown} />;
}
