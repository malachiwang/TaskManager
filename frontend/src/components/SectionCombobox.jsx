import { useId, useState } from 'react';

// SectionCombobox (P11.1) — freeform text input with existing-section
// suggestions. Never restricts input to the suggestion list: typing a
// brand-new section works exactly like the plain input it replaces.
//
// Filtering uses what the user has TYPED since focusing (not the initial
// value), so focusing a field that already holds "Health" still shows every
// section rather than just "Health".
export default function SectionCombobox({ id, value, onChange, suggestions, placeholder }) {
  const [open, setOpen] = useState(false);
  const [filterText, setFilterText] = useState('');
  const [highlight, setHighlight] = useState(-1);
  const listId = useId();

  const query = filterText.trim().toLowerCase();
  const filtered = query
    ? suggestions.filter((s) => s.toLowerCase().includes(query))
    : suggestions;
  const showList = open && filtered.length > 0;

  function openList() {
    setOpen(true);
    setFilterText('');
    setHighlight(-1);
  }

  function closeList() {
    setOpen(false);
    setHighlight(-1);
  }

  function select(name) {
    onChange(name);
    closeList();
  }

  function handleKeyDown(e) {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      if (!showList) {
        if (suggestions.length > 0) openList();
        return;
      }
      const delta = e.key === 'ArrowDown' ? 1 : -1;
      setHighlight((h) => {
        const next = h + delta;
        if (next < 0) return filtered.length - 1;
        if (next >= filtered.length) return 0;
        return next;
      });
      return;
    }
    if (e.key === 'Enter' && showList && highlight >= 0) {
      // Consume Enter only when actually picking a suggestion — otherwise the
      // form's normal Enter-to-save behavior stays intact.
      e.preventDefault();
      select(filtered[highlight]);
      return;
    }
    if (e.key === 'Escape' && open) {
      // Close the dropdown only, keeping the typed text; stopPropagation so
      // the grid's global Escape handler doesn't close the whole modal.
      e.preventDefault();
      e.stopPropagation();
      closeList();
    }
  }

  return (
    <div className="tm-combobox">
      <input
        id={id}
        className="task-modal-input"
        role="combobox"
        aria-expanded={showList}
        aria-controls={listId}
        aria-autocomplete="list"
        aria-activedescendant={highlight >= 0 ? `${listId}-${highlight}` : undefined}
        autoComplete="off"
        value={value}
        placeholder={placeholder}
        onChange={(e) => {
          onChange(e.target.value);
          setFilterText(e.target.value);
          setOpen(true);
          setHighlight(-1);
        }}
        onFocus={openList}
        onClick={() => { if (!open) openList(); }}
        onBlur={closeList}
        onKeyDown={handleKeyDown}
      />
      {showList && (
        <ul className="tm-combobox-list" role="listbox" id={listId} aria-label="Existing sections">
          {filtered.map((s, i) => (
            <li
              key={s}
              id={`${listId}-${i}`}
              role="option"
              aria-selected={i === highlight}
              className={`tm-combobox-option${i === highlight ? ' tm-combobox-option--hl' : ''}`}
              onMouseDown={(e) => e.preventDefault() /* keep input focus so blur doesn't eat the click */}
              onClick={() => select(s)}
              onMouseEnter={() => setHighlight(i)}
            >
              {s}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
