import { useState, useEffect, useRef } from 'react';
import LinkifiedText from './LinkifiedText.jsx';
import { hasLinks, normalizeSafeUrl, spliceMarkdownLink } from '../linkUtils.js';

function dateLabel(isoDate) {
  const [y, m, day] = isoDate.split('-').map(Number);
  return new Date(y, m - 1, day).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

function stopLinkUiEvent(e) {
  e.preventDefault();
  e.stopPropagation();
}

function stopLinkUiPropagation(e) {
  e.stopPropagation();
}

export default function EditBar({ selectedCell, tasks, completions, notes, todayStr, cellOverrides, rangeSelection, feedback, onIncrement, onClear, onSetCount, onSaveNote, onConvertToText, onRestoreCheckbox, onEditOverride, onRangeDelete, onRangeRestore }) {
  const [setMode, setSetMode] = useState(false);
  const [inputVal, setInputVal] = useState('');
  const [noteVal, setNoteVal] = useState('');
  const [linkPanelOpen, setLinkPanelOpen] = useState(false);
  const [linkText, setLinkText] = useState('');
  const [linkUrl, setLinkUrl] = useState('');
  const [linkSelection, setLinkSelection] = useState({ value: '', start: 0, end: 0 });
  // Two-step confirm for restoring checkbox mode over non-empty text (P9.1).
  const [confirmRestore, setConfirmRestore] = useState(false);
  // Two-step confirm for range restore when text would be removed (P10.0).
  const [confirmRangeRestore, setConfirmRangeRestore] = useState(false);
  const noteInputRef = useRef(null);
  const linkUrlRef = useRef(null);
  const noteOrigRef = useRef('');
  const skipSaveRef = useRef(false);

  const isRange = !!rangeSelection && rangeSelection.count > 1;

  // Reset set-count input and note whenever selection changes.
  useEffect(() => {
    setSetMode(false);
    setInputVal('');
    const key = selectedCell ? `${selectedCell.taskId}:${selectedCell.date}` : null;
    const val = key ? (notes[key] || '') : '';
    setNoteVal(val);
    noteOrigRef.current = val;
    setLinkPanelOpen(false);
    setConfirmRestore(false);
  }, [selectedCell]); // eslint-disable-line react-hooks/exhaustive-deps

  // Reset range-restore confirmation whenever the range changes shape.
  useEffect(() => {
    setConfirmRangeRestore(false);
  }, [rangeSelection]);

  const feedbackLine = feedback ? (
    <div className="edit-bar-feedback" role="status">{feedback}</div>
  ) : null;

  if (isRange) {
    const { count, checkboxCount, overrideCount, overrideWithText, lockedCount, cells } = rangeSelection;
    return (
      <div className="edit-bar edit-bar--active">
        <div className="edit-bar-info">
          <span className="edit-bar-task">{count} cells selected</span>
          <span className="edit-bar-sep">·</span>
          <span className="edit-bar-count">
            {checkboxCount} checkbox{checkboxCount !== 1 ? 'es' : ''} · {overrideCount} text
            {lockedCount > 0 ? ` · ${lockedCount} locked` : ''}
          </span>
        </div>
        <div className="edit-bar-actions">
          <button
            className="edit-bar-btn"
            title="Convert selected checkboxes to blank text cells and blank selected text cells. Completion history is kept."
            onClick={() => onRangeDelete(cells)}
            disabled={checkboxCount === 0 && overrideWithText === 0}
          >
            Delete → blank text cells
          </button>
          {overrideCount > 0 && (
            confirmRangeRestore ? (
              <>
                <span className="edit-bar-restore-warn">
                  Restore checkboxes for {overrideCount} cell{overrideCount !== 1 ? 's' : ''}?
                  This removes text from {overrideWithText} cell{overrideWithText !== 1 ? 's' : ''} and
                  reveals the underlying checkbox states.
                </span>
                <button
                  className="edit-bar-btn edit-bar-btn--danger"
                  onClick={() => { setConfirmRangeRestore(false); onRangeRestore(cells); }}
                >
                  Confirm restore
                </button>
                <button className="edit-bar-btn" onClick={() => setConfirmRangeRestore(false)}>✕</button>
              </>
            ) : (
              <button
                className="edit-bar-btn"
                onClick={() => {
                  if (overrideWithText > 0) setConfirmRangeRestore(true);
                  else onRangeRestore(cells);
                }}
              >
                Restore checkboxes
              </button>
            )
          )}
          <span className="edit-bar-hint">Del converts · Esc collapses range</span>
        </div>
        {feedbackLine}
      </div>
    );
  }

  if (!selectedCell) {
    return (
      <div className="edit-bar">
        <span className="edit-bar-empty">Click a date cell to select it</span>
        {feedbackLine}
      </div>
    );
  }

  const { taskId, date } = selectedCell;
  const task = tasks.find((t) => t.id === taskId);
  const count = completions[`${taskId}:${date}`] || 0;
  const isFuture = date > todayStr;
  const isPaused = task ? task.is_paused === 1 : false;
  const isBeforeActiveFrom = !!(task?.active_from && date < task.active_from);
  const isAfterEndDate = !!(task?.end_date && date > task.end_date);
  const isDisabled = isFuture || isPaused || isBeforeActiveFrom || isAfterEndDate;
  // Text-override state for the selected cell (P9.1). undefined = checkbox mode.
  const overrideText = cellOverrides ? cellOverrides[`${taskId}:${date}`] : undefined;
  const isTextOverride = overrideText !== undefined;

  function handleRestoreClick() {
    // Non-empty text requires a second confirming click; empty restores directly.
    if (overrideText && !confirmRestore) {
      setConfirmRestore(true);
      return;
    }
    setConfirmRestore(false);
    onRestoreCheckbox(taskId, date);
  }

  function handleNoteBlur() {
    if (skipSaveRef.current) { skipSaveRef.current = false; return; }
    if (noteVal !== noteOrigRef.current) {
      noteOrigRef.current = noteVal;
      onSaveNote(taskId, date, noteVal);
    }
  }

  function handleNoteKey(e) {
    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k' && !isDisabled) {
      e.preventDefault();
      openInsertLink();
      return;
    }
    if (e.key === 'Enter') { e.target.blur(); }
    if (e.key === 'Escape') {
      skipSaveRef.current = true;
      setNoteVal(noteOrigRef.current);
      setLinkPanelOpen(false);
      e.target.blur();
    }
  }

  function getNoteSelection() {
    const el = noteInputRef.current;
    const len = noteVal.length;
    if (!el || typeof el.selectionStart !== 'number' || typeof el.selectionEnd !== 'number') {
      return { start: len, end: len, selectedText: '' };
    }
    const start = el.selectionStart;
    const end = el.selectionEnd;
    return { value: noteVal, start, end, selectedText: noteVal.slice(start, end) };
  }

  function openInsertLink(e = null) {
    if (e) stopLinkUiEvent(e);
    const selection = getNoteSelection();
    setLinkSelection({ value: selection.value, start: selection.start, end: selection.end });
    setLinkText(selection.selectedText);
    setLinkUrl('');
    setLinkPanelOpen(true);
    requestAnimationFrame(() => linkUrlRef.current?.focus());
  }

  function closeInsertLink() {
    setLinkPanelOpen(false);
    requestAnimationFrame(() => noteInputRef.current?.focus());
  }

  function insertMarkdownLink() {
    const result = spliceMarkdownLink(
      linkSelection.value,
      linkSelection.start,
      linkSelection.end,
      linkText,
      linkUrl,
    );
    if (!result) return;
    setNoteVal(result.text);
    noteOrigRef.current = result.text;
    onSaveNote(taskId, date, result.text);
    setLinkPanelOpen(false);
    requestAnimationFrame(() => {
      noteInputRef.current?.focus();
      noteInputRef.current?.setSelectionRange(result.cursor, result.cursor);
    });
  }

  function handleApplySet() {
    const n = parseInt(inputVal, 10);
    if (isNaN(n) || n < 0) return;
    onSetCount(taskId, date, n);
    setSetMode(false);
    setInputVal('');
  }

  function handleInputKey(e) {
    if (e.key === 'Enter') handleApplySet();
    if (e.key === 'Escape') { setSetMode(false); setInputVal(''); }
  }

  const linkUrlSafe = normalizeSafeUrl(linkUrl);

  return (
    <div className="edit-bar edit-bar--active">
      <div className="edit-bar-info">
        <span className="edit-bar-task">{task ? task.name : `Task #${taskId}`}</span>
        <span className="edit-bar-sep">·</span>
        <span className="edit-bar-date">{dateLabel(date)}</span>
        <span className="edit-bar-sep">·</span>
        {isTextOverride ? (
          <span className="edit-bar-count">text cell</span>
        ) : isDisabled ? (
          <span className="edit-bar-disabled">
            {isFuture ? 'future date' : isAfterEndDate ? 'after task end date' : isBeforeActiveFrom ? 'before active date' : 'on hiatus'}
          </span>
        ) : (
          <span className="edit-bar-count">count: {count}</span>
        )}
      </div>
      {isTextOverride ? (
        /* Text-override cell (P9.1): edit/restore controls replace the
           completion actions. Restoring over non-empty text needs a second
           confirming click so text is never lost by accident. */
        <div className="edit-bar-actions">
          {!isDisabled && (
            <button className="edit-bar-btn primary" onClick={() => onEditOverride(taskId, date)}>
              Edit text
            </button>
          )}
          {confirmRestore ? (
            <>
              <span className="edit-bar-restore-warn">Deletes this cell&rsquo;s text</span>
              <button className="edit-bar-btn edit-bar-btn--danger" onClick={handleRestoreClick}>
                Confirm restore
              </button>
              <button className="edit-bar-btn" onClick={() => setConfirmRestore(false)}>✕</button>
            </>
          ) : (
            <button className="edit-bar-btn" onClick={handleRestoreClick}>
              Restore checkbox
            </button>
          )}
        </div>
      ) : !isDisabled && (
        <div className="edit-bar-actions">
          <button className="edit-bar-btn primary" onClick={() => onIncrement(taskId, date)}>+1</button>
          <button
            className="edit-bar-btn"
            onClick={() => onClear(taskId, date)}
            disabled={count === 0}
          >Clear</button>
          {setMode ? (
            <>
              <input
                type="number"
                min="0"
                className="edit-bar-input"
                value={inputVal}
                onChange={(e) => setInputVal(e.target.value)}
                onKeyDown={handleInputKey}
                autoFocus
              />
              <button className="edit-bar-btn primary" onClick={handleApplySet}>Apply</button>
              <button className="edit-bar-btn" onClick={() => { setSetMode(false); setInputVal(''); }}>✕</button>
            </>
          ) : (
            <button className="edit-bar-btn" onClick={() => { setSetMode(true); setInputVal(String(count)); }}>Set…</button>
          )}
          <button
            className="edit-bar-btn"
            title="Convert this date cell to a text cell (checkbox is hidden, not deleted)"
            onClick={() => onConvertToText(taskId, date)}
          >Text…</button>
        </div>
      )}
      <div className="edit-bar-note-row">
        <label className="edit-bar-note-label" htmlFor="eb-note">Note</label>
        <input
          ref={noteInputRef}
          id="eb-note"
          type="text"
          className="edit-bar-note-input"
          value={noteVal}
          readOnly={isFuture || isBeforeActiveFrom || isAfterEndDate}
          onChange={(e) => setNoteVal(e.target.value)}
          onBlur={handleNoteBlur}
          onKeyDown={handleNoteKey}
          placeholder={isFuture || isBeforeActiveFrom ? '' : 'Add a note…'}
        />
        {!isDisabled && (
          <button
            type="button"
            className="insert-link-btn insert-link-btn--editbar"
            onMouseDown={openInsertLink}
            onClick={stopLinkUiEvent}
          >
            Insert link
          </button>
        )}
      </div>
      {linkPanelOpen && !isDisabled && (
        <div
          className="insert-link-panel insert-link-panel--editbar"
          role="dialog"
          aria-label="Insert link"
          onMouseDown={stopLinkUiPropagation}
          onClick={stopLinkUiPropagation}
        >
          <label className="insert-link-field">
            <span>Text</span>
            <input
              className="edit-bar-note-input"
              value={linkText}
              onChange={(e) => setLinkText(e.target.value)}
              onMouseDown={stopLinkUiPropagation}
              onClick={stopLinkUiPropagation}
            />
          </label>
          <label className="insert-link-field">
            <span>URL</span>
            <input
              ref={linkUrlRef}
              className="edit-bar-note-input"
              value={linkUrl}
              onChange={(e) => setLinkUrl(e.target.value)}
              onMouseDown={stopLinkUiPropagation}
              onClick={stopLinkUiPropagation}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && linkUrlSafe) {
                  e.preventDefault();
                  insertMarkdownLink();
                }
                if (e.key === 'Escape') {
                  e.preventDefault();
                  closeInsertLink();
                }
              }}
              placeholder="https://example.com"
            />
          </label>
          {linkUrl && !linkUrlSafe && (
            <div className="insert-link-error">Use http, https, mailto, or www links.</div>
          )}
          <div className="insert-link-actions">
            <button type="button" className="edit-bar-btn" onMouseDown={stopLinkUiEvent} onClick={(e) => { stopLinkUiEvent(e); closeInsertLink(); }}>
              Cancel
            </button>
            <button
              type="button"
              className="edit-bar-btn primary"
              onMouseDown={stopLinkUiEvent}
              onClick={(e) => { stopLinkUiEvent(e); insertMarkdownLink(); }}
              disabled={!linkUrlSafe}
            >
              Insert
            </button>
          </div>
        </div>
      )}
      {hasLinks(noteVal) && (
        <div className="edit-bar-note-preview">
          <span className="edit-bar-note-preview-label">Links</span>
          <LinkifiedText text={noteVal} />
        </div>
      )}
      {feedbackLine}
    </div>
  );
}
