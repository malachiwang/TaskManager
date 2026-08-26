import { useEffect, useMemo, useRef, useState } from 'react';

// Command palette (V5.1 Part II) — one keyboard-first entry point for
// Calendar operations. Purely dispatch: every command runs the exact same
// handler the equivalent button uses, so the palette adds no semantics of
// its own and nothing is destructive until a row is explicitly chosen.
//
// `commands`: [{ id, label, hint?, keywords?, run }] — already filtered for
// context by the caller (irrelevant commands are simply not passed in).
// `freeTextActions`: [{ id, label(query), run(query) }] — offered when the
// query matches no command (V5.2 routes natural-language creation and
// Calendar search through this seam).

function matches(query, cmd) {
  const hay = `${cmd.label} ${cmd.keywords ?? ''}`.toLowerCase();
  return query.toLowerCase().split(/\s+/).filter(Boolean)
    .every((tok) => hay.includes(tok));
}

export default function CommandPalette({
  open, onClose, commands, freeTextActions = [], placeholder = 'Type a command…',
}) {
  const [query, setQuery] = useState('');
  const [activeIdx, setActiveIdx] = useState(0);
  const inputRef = useRef(null);
  const listRef = useRef(null);

  useEffect(() => {
    if (open) {
      setQuery('');
      setActiveIdx(0);
      // Focus after mount — the palette renders in the same tick it opens.
      requestAnimationFrame(() => inputRef.current?.focus());
    }
  }, [open]);

  const filtered = useMemo(
    () => (query.trim() ? commands.filter((c) => matches(query, c)) : commands),
    [commands, query],
  );
  // Free-text rows appear only for a non-empty query, after real matches.
  const freeRows = query.trim()
    ? freeTextActions.map((a) => ({
      id: `free:${a.id}`,
      label: a.label(query.trim()),
      hint: a.hint,
      run: () => a.run(query.trim()),
    }))
    : [];
  const rows = [...filtered, ...freeRows];

  useEffect(() => {
    setActiveIdx((i) => Math.min(i, Math.max(0, rows.length - 1)));
  }, [rows.length]);

  useEffect(() => {
    const el = listRef.current?.querySelector('.cmdk-row.is-active');
    el?.scrollIntoView({ block: 'nearest' });
  }, [activeIdx]);

  if (!open) return null;

  function runRow(row) {
    onClose();
    row.run();
  }

  function onKeyDown(e) {
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      onClose();
    } else if (e.key === 'ArrowDown') {
      e.preventDefault();
      setActiveIdx((i) => Math.min(rows.length - 1, i + 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setActiveIdx((i) => Math.max(0, i - 1));
    } else if (e.key === 'Enter') {
      e.preventDefault();
      if (rows[activeIdx]) runRow(rows[activeIdx]);
    }
  }

  return (
    <div className="cmdk-overlay" onClick={onClose}>
      <div className="cmdk" role="dialog" aria-label="Command palette"
        onClick={(e) => e.stopPropagation()}>
        <input
          ref={inputRef}
          className="cmdk-input"
          placeholder={placeholder}
          value={query}
          onChange={(e) => { setQuery(e.target.value); setActiveIdx(0); }}
          onKeyDown={onKeyDown}
          aria-label="Command search"
        />
        <div className="cmdk-list" ref={listRef} role="listbox">
          {rows.length === 0 && (
            <div className="cmdk-empty">No matching command.</div>
          )}
          {rows.map((row, i) => (
            <button
              key={row.id}
              type="button"
              role="option"
              aria-selected={i === activeIdx}
              className={`cmdk-row${i === activeIdx ? ' is-active' : ''}`}
              onMouseEnter={() => setActiveIdx(i)}
              onClick={() => runRow(row)}
            >
              <span className="cmdk-label">{row.label}</span>
              {row.hint && <span className="cmdk-hint">{row.hint}</span>}
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}
