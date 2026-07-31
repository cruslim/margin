import { useState } from 'react';

export interface BranchOption {
  value: string;
  label: string;
}

export function filterOptions(options: BranchOption[], query: string): BranchOption[] {
  const q = query.trim().toLowerCase();
  if (!q) return options;
  return options.filter((o) => o.label.toLowerCase().includes(q));
}

/**
 * Searchable dropdown for picking a branch. Options keep the order they are
 * given in (branches arrive newest-first from the main process).
 */
export function BranchSelect(props: {
  value: string;
  options: BranchOption[];
  onChange: (value: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [active, setActive] = useState(0);

  const filtered = filterOptions(props.options, query);
  const selected = props.options.find((o) => o.value === props.value);

  // Functional update: a duplicated event in one batch (mousedown and click both
  // landing on the trigger) would otherwise read the same stale `open` twice and
  // leave the menu where it started.
  const toggle = () => {
    setOpen((o) => !o);
    setQuery('');
    setActive(0);
  };

  const pick = (value: string) => {
    props.onChange(value);
    setOpen(false);
  };

  return (
    <div
      className="branch-select"
      onBlur={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setOpen(false);
      }}
    >
      <button type="button" className="branch-select-trigger" onClick={toggle}>
        <span className="branch-select-label">{selected?.label ?? props.value}</span>
        <span className="branch-select-caret">▾</span>
      </button>
      {open && (
        <div className="branch-select-menu">
          <input
            autoFocus
            placeholder="Search branches…"
            value={query}
            onChange={(e) => {
              setQuery(e.target.value);
              setActive(0);
            }}
            onKeyDown={(e) => {
              if (e.key === 'ArrowDown') {
                e.preventDefault();
                setActive((i) => Math.min(i + 1, filtered.length - 1));
              } else if (e.key === 'ArrowUp') {
                e.preventDefault();
                setActive((i) => Math.max(i - 1, 0));
              } else if (e.key === 'Enter') {
                e.preventDefault();
                if (filtered[active]) pick(filtered[active].value);
              } else if (e.key === 'Escape') {
                e.stopPropagation();
                setOpen(false);
              }
            }}
          />
          <div className="branch-select-list">
            {filtered.map((o, i) => (
              <div
                key={o.value}
                ref={i === active ? (el) => el?.scrollIntoView({ block: 'nearest' }) : undefined}
                className={`branch-option ${i === active ? 'active' : ''} ${o.value === props.value ? 'selected' : ''}`}
                // preventDefault keeps focus in the search input so blur
                // doesn't close the menu before click registers
                onMouseDown={(e) => e.preventDefault()}
                // preventDefault again on the click: if this widget ever ends up
                // inside a <label>, the label's activation behaviour would fire a
                // second click on the trigger and reopen what pick just closed.
                onClick={(e) => {
                  e.preventDefault();
                  pick(o.value);
                }}
                onMouseEnter={() => setActive(i)}
              >
                {o.label}
              </div>
            ))}
            {filtered.length === 0 && <div className="branch-option none">No branches match</div>}
          </div>
        </div>
      )}
    </div>
  );
}
