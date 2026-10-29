import { useEffect, useRef, useState } from 'react';
import { navigationMatches, nextSearchIndex } from '../navigation.js';
import { matchKeybind, resolveKeybinds, isTypingTarget } from '../keybinds.js';

export default function WorkspaceSearch({ onOpen }) {
  const [query, setQuery] = useState('');
  const [matches, setMatches] = useState([]);
  const [open, setOpen] = useState(false);
  const [index, setIndex] = useState(0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const input = useRef(null);
  const results = [...navigationMatches(query), ...matches];

  useEffect(() => {
    const controller = new AbortController();
    setMatches([]); setIndex(0); setError('');
    if (!query.trim()) { setBusy(false); return; }
    setBusy(true);
    const timer = setTimeout(async () => {
      try {
        const response = await fetch(`/api/search/workspace?q=${encodeURIComponent(query)}`, { signal: controller.signal });
        if (!response.ok) throw new Error('Search unavailable. Try again.');
        const data = await response.json();
        if (!controller.signal.aborted) setMatches(data);
      } catch (err) {
        if (!controller.signal.aborted) setError(err.message);
      } finally {
        if (!controller.signal.aborted) setBusy(false);
      }
    }, 150);
    return () => { clearTimeout(timer); controller.abort(); };
  }, [query]);

  useEffect(() => {
    function focusSearch(event) {
      if (isTypingTarget(event.target) || document.querySelector('[role="dialog"], [role="alertdialog"], .task-modal-overlay')) return;
      const kb = resolveKeybinds();
      const next = matchKeybind(event, kb.FOCUS_NEXT);
      const previous = matchKeybind(event, kb.FOCUS_PREVIOUS);
      if ((next || previous) && event.key !== 'Tab') {
        const focusable = [...document.querySelectorAll('button, input, select, textarea, a[href], [tabindex="0"]')]
          .filter(el => !el.disabled && el.getClientRects().length);
        const index = focusable.indexOf(document.activeElement);
        event.preventDefault(); focusable[(index + (previous ? -1 : 1) + focusable.length) % focusable.length]?.focus();
        return;
      }
      if (matchKeybind(event, kb.FOCUS_SEARCH)) {
        event.preventDefault(); input.current?.focus();
      }
    }
    window.addEventListener('keydown', focusSearch);
    return () => window.removeEventListener('keydown', focusSearch);
  }, []);

  function select(result) {
    if (!result) return;
    onOpen(result); setOpen(false); setQuery(''); input.current?.blur();
  }
  return <div className="workspace-search" onBlur={event => {
    if (!event.currentTarget.contains(event.relatedTarget)) setOpen(false);
  }}>
    <div className="workspace-search-field">
      <input id="workspace-search" ref={input} type="search" role="combobox" aria-label="Search workspace"
        placeholder="Search tasks, reading, pages…" autoComplete="off" value={query}
        aria-expanded={open && !!query.trim()} aria-controls="workspace-results" aria-autocomplete="list"
        aria-activedescendant={open && results[index] ? `workspace-result-${index}` : undefined}
        onChange={e => { setQuery(e.target.value); setOpen(true); setMatches([]); setIndex(0); }}
        onFocus={() => setOpen(true)} onKeyDown={e => {
          e.stopPropagation();
          if (e.key === 'Escape') { setOpen(false); e.preventDefault(); }
          if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
            e.preventDefault(); setOpen(true); setIndex(i => nextSearchIndex(i, e.key === 'ArrowDown' ? 1 : -1, results.length));
          }
          if (e.key === 'Enter') { e.preventDefault(); select(results[index]); }
        }} />
      {query && <button aria-label="Clear search" onClick={() => { setQuery(''); input.current?.focus(); }}>×</button>}
    </div>
    {open && query.trim() && <div className="workspace-search-results">
      <div role="listbox" id="workspace-results" aria-label="Search results">
        {results.map((r, i) => <button key={`${r.kind}-${r.id ?? r.label}-${r.date}-${r.snapshotId}-${r.entryId}-${i}`}
          id={`workspace-result-${i}`} role="option" aria-selected={index === i}
          className={index === i ? 'is-selected' : ''} onMouseDown={e => e.preventDefault()} onClick={() => select(r)}>
          <strong>{r.label}</strong><small>{r.kind === 'navigation' ? 'Go to page' : `${r.detail || r.kind}${r.date ? ` · ${r.date}` : ''}`}</small>
        </button>)}
      </div>
      <div role="status">{error || (busy ? 'Searching…' : !results.length ? 'No results found.' : '')}</div>
    </div>}
  </div>;
}
