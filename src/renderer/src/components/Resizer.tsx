import { useCallback, useEffect, useState } from 'react';

/**
 * Draggable panel width, persisted to localStorage. `dir` is +1 when the
 * handle sits on the panel's right edge (drag right = wider) and -1 when it
 * sits on the left edge (drag left = wider).
 */
export function usePanelWidth(key: string, initial: number, min: number, max: number, dir: 1 | -1) {
  const storageKey = `margin.width.${key}`;
  const [width, setWidth] = useState<number>(() => {
    const saved = Number(localStorage.getItem(storageKey));
    return Number.isFinite(saved) && saved >= min && saved <= max ? saved : initial;
  });

  const startDrag = useCallback(
    (e: React.MouseEvent) => {
      e.preventDefault();
      const startX = e.clientX;
      const startW = width;
      let lastW = startW;
      const onMove = (ev: MouseEvent) => {
        lastW = Math.min(max, Math.max(min, startW + dir * (ev.clientX - startX)));
        setWidth(lastW);
      };
      const onUp = () => {
        window.removeEventListener('mousemove', onMove);
        window.removeEventListener('mouseup', onUp);
        document.body.classList.remove('resizing');
        localStorage.setItem(storageKey, String(lastW));
      };
      document.body.classList.add('resizing');
      window.addEventListener('mousemove', onMove);
      window.addEventListener('mouseup', onUp);
    },
    [width, min, max, dir, storageKey],
  );

  return { width, startDrag };
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
