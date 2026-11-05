import { createContext, useContext, useEffect, useRef, useState } from 'react';
import { navigationMatches, nextSearchIndex } from '../navigation.js';
import { searchWorkspace } from '../api.js';

// App provides the handler that opens a result (tm-clean 11).
export const WorkspaceNavigation = createContext(() => {});

// Workspace search beside the help control (tm-clean 11; logic ported from
// drift-ref). Styling reuses the grid search input and the Section combobox
// list — no new CSS.
export default function WorkspaceSearch() {
  const onOpen = useContext(WorkspaceNavigation);
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
    if (!query.trim()) { setBusy(false); return undefined; }
    setBusy(true);
    const timer = setTimeout(async () => {
      try {
        const data = await searchWorkspace(query, controller.signal);
        if (!controller.signal.aborted) setMatches(data);
      } catch (err) {
        if (!controller.signal.aborted) setError('Search unavailable. Try again.');
      } finally {
        if (!controller.signal.aborted) setBusy(false);
      }
    }, 150);
    return () => { clearTimeout(timer); controller.abort(); };
  }, [query]);

  useEffect(() => {
    if (open) document.getElementById(`workspace-result-${index}`)?.scrollIntoView({ block: 'nearest' });
  }, [index, open]);

  function select(result) {
    if (!result) return;
    onOpen(result); setOpen(false); setQuery(''); input.current?.blur();
  }

  const showList = open && query.trim() !== '';
  const status = error || (busy ? 'Searching…' : !results.length ? 'No results found.' : '');
  return (
    <div
      className="tm-combobox"
      onBlur={(e) => { if (!e.currentTarget.contains(e.relatedTarget)) setOpen(false); }}
    >
      <input
        id="workspace-search"
        ref={input}
        className="ws-filter-input"
        type="search"
        role="combobox"
        aria-label="Search workspace"
        placeholder="Search workspace…"
        autoComplete="off"
        value={query}
        aria-expanded={showList}
        aria-controls="workspace-results"
        aria-autocomplete="list"
        aria-activedescendant={showList && results[index] ? `workspace-result-${index}` : undefined}
        onChange={(e) => { setQuery(e.target.value); setOpen(true); setMatches([]); setIndex(0); }}
        onFocus={() => setOpen(true)}
        onKeyDown={(e) => {
          e.stopPropagation();
          if (e.key === 'Escape') { e.preventDefault(); if (showList) setOpen(false); else e.currentTarget.blur(); }
          if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
            e.preventDefault(); setOpen(true);
            setIndex((i) => nextSearchIndex(i, e.key === 'ArrowDown' ? 1 : -1, results.length));
          }
          if (e.key === 'Enter') { e.preventDefault(); select(results[index]); }
        }}
      />
      {showList && (
        <ul className="tm-combobox-list" role="listbox" id="workspace-results" aria-label="Search results">
          {results.map((r, i) => (
            <li
              key={`${r.kind}-${r.id ?? r.label}-${r.date}-${r.entryId}-${i}`}
              id={`workspace-result-${i}`}
              role="option"
              aria-selected={index === i}
              className={`tm-combobox-option${index === i ? ' tm-combobox-option--hl' : ''}`}
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => select(r)}
            >
              {r.label}{' '}
              <span className="dash-muted">
                {r.kind === 'navigation' ? 'Go to page' : `${r.detail || r.kind}${r.date ? ` · ${r.date}` : ''}`}
              </span>
            </li>
          ))}
          {status && <li className="tm-combobox-option" role="presentation" aria-live="polite">{status}</li>}
        </ul>
      )}
    </div>
  );
}
