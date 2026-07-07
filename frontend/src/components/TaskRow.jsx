import { useState, useEffect, useRef } from 'react';
import { createPortal } from 'react-dom';
import DateCell from './DateCell.jsx';
import LinkifiedText from './LinkifiedText.jsx';
import LinkPopover from './LinkPopover.jsx';
import { spliceMarkdownLink, hasLinks, extractLinks, normalizeSafeUrl } from '../linkUtils.js';
import { urgencyClass, urgencyReason } from '../urgency.js';

function displayStatus(task) {
  if (task.is_ended) return 'Finished';
  if (task.is_paused === 1) return 'Hiatus';
  return 'Active';
}

function formatActiveFrom(isoDate) {
  if (!isoDate) return '';
  const [, m, d] = isoDate.split('-').map(Number);
  return `${m}/${d}`;
}

function stopLinkUiEvent(e) {
  e.preventDefault();
  e.stopPropagation();
}

function stopLinkUiPropagation(e) {
  e.stopPropagation();
}

// Inline editable text cell — single click selects (via td class), double click edits.
// Blur commits; Escape cancels; Enter commits. Blank task names are rejected.
function InlineTextCell({
  value, colKey, taskId,
  isEditing,
  onSelectMeta, onStartTextEdit, onCommitTextEdit, onCancelTextEdit,
}) {
  const supportsLinks = colKey === 'col-task' || colKey === 'col-sub';
  const [draft, setDraft] = useState(value ?? '');
  const [insertLinkState, setInsertLinkState] = useState(null);
  const [linkText, setLinkText] = useState('');
  const [linkUrl, setLinkUrl] = useState('');
  const editorWrapRef = useRef(null);
  const inputRef = useRef(null);
  const linkUrlRef = useRef(null);
  const cancelledRef = useRef(false);
  const insertingLinkRef = useRef(false);

  useEffect(() => {
    if (isEditing) {
      setDraft(value ?? '');
      setInsertLinkState(null);
      inputRef.current?.focus();
      inputRef.current?.select();
    }
  }, [isEditing]); // intentionally omits `value` — only reset on mode entry

  useEffect(() => {
    if (!insertLinkState) return;
    const raf = requestAnimationFrame(() => linkUrlRef.current?.focus());
    return () => cancelAnimationFrame(raf);
  }, [insertLinkState]);

  function commit() {
    const trimmed = draft.trim();
    if (colKey === 'col-task' && !trimmed) {
      onCancelTextEdit();
      return;
    }
    onCommitTextEdit(taskId, colKey, trimmed);
  }

  function getSelection() {
    const el = inputRef.current;
    const len = draft.length;
    if (!el || typeof el.selectionStart !== 'number' || typeof el.selectionEnd !== 'number') {
      return { start: len, end: len, selectedText: '' };
    }
    const start = el.selectionStart;
    const end = el.selectionEnd;
    return { value: draft, start, end, selectedText: draft.slice(start, end) };
  }

  function openInsertLink(e = null) {
    if (e) stopLinkUiEvent(e);
    const selection = getSelection();
    const anchorRect = editorWrapRef.current?.getBoundingClientRect?.()
      || inputRef.current?.getBoundingClientRect?.();
    insertingLinkRef.current = true;
    setInsertLinkState({
      field: colKey,
      taskId,
      value: selection.value,
      start: selection.start,
      end: selection.end,
      selectedText: selection.selectedText,
      anchorRect: anchorRect
        ? {
            top: anchorRect.top,
            right: anchorRect.right,
            bottom: anchorRect.bottom,
            left: anchorRect.left,
          }
        : null,
    });
    setLinkText(selection.selectedText);
    setLinkUrl('');
  }

  function closeInsertLink() {
    setInsertLinkState(null);
    insertingLinkRef.current = false;
    requestAnimationFrame(() => inputRef.current?.focus());
  }

  function insertMarkdownLink() {
    if (!insertLinkState) return;
    const result = spliceMarkdownLink(
      insertLinkState.value,
      insertLinkState.start,
      insertLinkState.end,
      linkText,
      linkUrl,
    );
    if (!result) return;
    setDraft(result.text);
    setInsertLinkState(null);
    insertingLinkRef.current = false;
    requestAnimationFrame(() => {
      inputRef.current?.focus();
      inputRef.current?.setSelectionRange(result.cursor, result.cursor);
    });
  }

  function handleKeyDown(e) {
    if (supportsLinks && (e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
      e.preventDefault();
      e.stopPropagation();
      openInsertLink();
    } else if (e.key === 'Enter') {
      e.preventDefault();
      e.stopPropagation();
      cancelledRef.current = false;
      commit();
    } else if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      cancelledRef.current = true;
      onCancelTextEdit();
    }
  }

  function handleBlur() {
    if (insertingLinkRef.current) return;
    if (cancelledRef.current) {
      cancelledRef.current = false;
      return;
    }
    commit();
  }

  if (isEditing) {
    const linkUrlSafe = normalizeSafeUrl(linkUrl);
    const insertLinkPanel = supportsLinks && insertLinkState
      ? createPortal(
          <span
            className="insert-link-panel insert-link-panel--cell"
            style={(() => {
              if (!insertLinkState.anchorRect) return undefined;
              const panelWidth = Math.min(
                Math.max(insertLinkState.anchorRect.right - insertLinkState.anchorRect.left, 320),
                window.innerWidth - 16,
              );
              return {
                top: insertLinkState.anchorRect.bottom + 4,
                left: Math.max(8, Math.min(insertLinkState.anchorRect.left, window.innerWidth - panelWidth - 8)),
                width: panelWidth,
              };
            })()}
            role="dialog"
            aria-label="Insert link"
            onMouseDown={stopLinkUiPropagation}
            onClick={stopLinkUiPropagation}
            onDoubleClick={stopLinkUiPropagation}
          >
            <label className="insert-link-field">
              <span>Text</span>
              <input
                className="cell-edit-input"
                value={linkText}
                onChange={(e) => setLinkText(e.target.value)}
                onMouseDown={stopLinkUiPropagation}
                onClick={stopLinkUiPropagation}
                onBlur={() => {}}
              />
            </label>
            <label className="insert-link-field">
              <span>URL</span>
              <input
                ref={linkUrlRef}
                className="cell-edit-input"
                value={linkUrl}
                onChange={(e) => setLinkUrl(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && linkUrlSafe) {
                    e.preventDefault();
                    e.stopPropagation();
                    insertMarkdownLink();
                  }
                  if (e.key === 'Escape') {
                    e.preventDefault();
                    e.stopPropagation();
                    closeInsertLink();
                  }
                }}
                onMouseDown={stopLinkUiPropagation}
                onClick={stopLinkUiPropagation}
                onBlur={() => {}}
                placeholder="https://example.com"
              />
            </label>
            {linkUrl && !linkUrlSafe && (
              <span className="insert-link-error">Use http, https, mailto, or www links.</span>
            )}
            <span className="insert-link-actions">
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
            </span>
          </span>,
          document.body,
        )
      : null;
    return (
      <span ref={editorWrapRef} className="cell-edit-wrap">
        <span className="cell-edit-main">
          <input
            ref={inputRef}
            className="cell-edit-input"
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={handleKeyDown}
            onBlur={handleBlur}
          />
          {supportsLinks && (
            <button
              type="button"
              className="insert-link-btn insert-link-btn--cell"
              onMouseDown={openInsertLink}
              onClick={stopLinkUiEvent}
            >
              Link
            </button>
          )}
        </span>
        {insertLinkPanel}
      </span>
    );
  }

  return (
    <span
      onClick={() => onSelectMeta(taskId, colKey)}
      onDoubleClick={() => onStartTextEdit(taskId, colKey)}
    >
      {supportsLinks ? <LinkifiedText text={value ?? ''} /> : (value ?? '')}
    </span>
  );
}


export default function TaskRow({
  task, dates, todayStr, completions, notes, selectedCell, colLayout,
  selectedMetaCell, editingTextCell, armedCell,
  reorderEnabled, isDragOver, isDragSource, onHandlePointerDown,
  onIncrement, onClear, onEdit, onSelect,
  onSelectMeta, onStartTextEdit, onCommitTextEdit, onCancelTextEdit,
}) {
  const [anchorRect, setAnchorRect] = useState(null); // non-null = popover open
  const badgeRef = useRef(null);

  const isPaused = task.is_paused === 1;
  const isScheduled = task.is_scheduled === true;
  const isEnded = task.is_ended === true;
  const isOverdue =
    !isPaused &&
    !isScheduled &&
    !isEnded &&
    task.days_since != null &&
    task.interval_days != null &&
    task.days_since >= task.interval_days;

  // Returns inline style for a metadata column cell.
  // minWidth + maxWidth = width enforces the cell against table layout compression.
  // Sticky cols additionally get left; non-sticky cols get width constraints only.
  function cs(col) {
    const w = colLayout.widths[col];
    const style = { width: w, minWidth: w, maxWidth: w };
    if (colLayout.offsets[col] !== undefined) style.left = colLayout.offsets[col];
    return style;
  }

  const isSelectedMeta = (col) => selectedMetaCell?.taskId === task.id && selectedMetaCell?.col === col;
  const isEditingMeta  = (col) => editingTextCell?.taskId  === task.id && editingTextCell?.col  === col;

  const rowClass = ['task-row', isPaused ? 'paused' : '', isScheduled ? 'scheduled' : '', isEnded ? 'ended' : '', isDragOver ? 'drag-over' : '', isDragSource ? 'drag-source' : '']
    .filter(Boolean).join(' ');

  const noteLinks = hasLinks(task.notes) ? extractLinks(task.notes) : [];

  function handleBadgeClick(e) {
    e.stopPropagation();
    if (anchorRect) {
      setAnchorRect(null);
    } else {
      setAnchorRect(badgeRef.current.getBoundingClientRect());
    }
  }

  return (
    <tr
      className={rowClass}
      data-task-id={task.id}
    >
      <td className="meta-col sticky-col col-actions" style={cs('col-actions')}>
        <div className="row-action-group">
          {reorderEnabled && (
            <span
              className="drag-handle"
              onPointerDown={(e) => onHandlePointerDown(e, task.id)}
            >⠿</span>
          )}
          <button
            className="action-btn"
            onClick={() => onEdit(task)}
            title="Task details"
          >EDIT</button>
        </div>
      </td>
      <td className={`meta-col sticky-col col-urg ${isPaused || isScheduled || isEnded ? '' : urgencyClass(task.urgency)}`} style={cs('col-urg')} title={urgencyReason(task)}>
        {isPaused || isScheduled || isEnded ? '—' : task.urgency}
      </td>
      <td className="meta-col sticky-col col-pri" style={cs('col-pri')}>{task.priority}</td>
      <td className="meta-col sticky-col col-status" style={cs('col-status')}>{displayStatus(task)}</td>
      <td className="meta-col sticky-col col-active-from" style={cs('col-active-from')}>{formatActiveFrom(task.active_from)}</td>
      <td className={`meta-col sticky-col col-cat${isSelectedMeta('col-cat') ? ' meta-selected' : ''}`} style={cs('col-cat')}>
        <InlineTextCell value={task.category} colKey="col-cat" taskId={task.id}
          isEditing={isEditingMeta('col-cat')}
          onSelectMeta={onSelectMeta} onStartTextEdit={onStartTextEdit}
          onCommitTextEdit={onCommitTextEdit} onCancelTextEdit={onCancelTextEdit} />
      </td>
      <td className={`meta-col sticky-col col-task${isSelectedMeta('col-task') ? ' meta-selected' : ''}`}
          title={isEditingMeta('col-task') ? undefined : task.name} style={cs('col-task')}>
        <InlineTextCell value={task.name} colKey="col-task" taskId={task.id}
          isEditing={isEditingMeta('col-task')}
          onSelectMeta={onSelectMeta} onStartTextEdit={onStartTextEdit}
          onCommitTextEdit={onCommitTextEdit} onCancelTextEdit={onCancelTextEdit} />
      </td>
      <td className={`meta-col sticky-col col-sub${isSelectedMeta('col-sub') ? ' meta-selected' : ''}`}
          title={isEditingMeta('col-sub') ? undefined : (task.subtask || undefined)} style={cs('col-sub')}>
        <InlineTextCell value={task.subtask || ''} colKey="col-sub" taskId={task.id}
          isEditing={isEditingMeta('col-sub')}
          onSelectMeta={onSelectMeta} onStartTextEdit={onStartTextEdit}
          onCommitTextEdit={onCommitTextEdit} onCancelTextEdit={onCancelTextEdit} />
      </td>
      <td className="meta-col scroll-meta-col col-freq" style={cs('col-freq')}>{task.interval_days}</td>
      <td className={`meta-col scroll-meta-col col-days${isOverdue ? ' days-overdue' : ''}`} style={cs('col-days')}>{isPaused || isScheduled || isEnded ? '—' : task.days_since}</td>
      <td className="meta-col scroll-meta-col col-notes" title={task.notes} style={cs('col-notes')}>
        <div className="col-notes-inner">
          <span className="notes-text"><LinkifiedText text={task.notes || ''} /></span>
          {noteLinks.length > 0 && (
            <button
              ref={badgeRef}
              type="button"
              className={`task-link-badge${anchorRect ? ' task-link-badge--open' : ''}`}
              aria-label="Show links for task"
              aria-expanded={!!anchorRect}
              aria-haspopup="true"
              onClick={handleBadgeClick}
            >⊹</button>
          )}
        </div>
        {anchorRect && (
          <LinkPopover
            links={noteLinks}
            anchorRect={anchorRect}
            onClose={() => setAnchorRect(null)}
          />
        )}
      </td>
      {dates.map((date) => {
        const isFuture = date > todayStr;
        const count = completions[`${task.id}:${date}`] || 0;
        const noteKey = `${task.id}:${date}`;
        const hasNote = !!notes[noteKey];
        const noteText = notes[noteKey] || '';
        return (
          <DateCell
            key={date}
            taskId={task.id}
            date={date}
            count={count}
            isFuture={isFuture}
            isToday={date === todayStr}
            isPaused={isPaused}
            activeFrom={task.active_from || null}
            endDate={task.end_date || null}
            isSelected={selectedCell?.taskId === task.id && selectedCell?.date === date}
            isArmed={armedCell?.taskId === task.id && armedCell?.date === date}
            hasNote={hasNote}
            noteText={noteText}
            onIncrement={onIncrement}
            onClear={onClear}
            onSelect={onSelect}
          />
        );
      })}
    </tr>
  );
}
