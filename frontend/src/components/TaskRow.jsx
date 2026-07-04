import { useState, useEffect, useRef } from 'react';
import DateCell from './DateCell.jsx';
import LinkifiedText from './LinkifiedText.jsx';
import LinkPopover from './LinkPopover.jsx';
import { hasLinks, extractLinks } from '../linkUtils.js';

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

// Inline editable text cell — single click selects (via td class), double click edits.
// Blur commits; Escape cancels; Enter commits. Blank task names are rejected.
function InlineTextCell({
  value, colKey, taskId,
  isEditing,
  onSelectMeta, onStartTextEdit, onCommitTextEdit, onCancelTextEdit,
}) {
  const [draft, setDraft] = useState(value ?? '');
  const inputRef = useRef(null);
  const cancelledRef = useRef(false);

  useEffect(() => {
    if (isEditing) {
      setDraft(value ?? '');
      inputRef.current?.focus();
      inputRef.current?.select();
    }
  }, [isEditing]); // intentionally omits `value` — only reset on mode entry

  function commit() {
    const trimmed = draft.trim();
    if (colKey === 'col-task' && !trimmed) {
      onCancelTextEdit();
      return;
    }
    onCommitTextEdit(taskId, colKey, trimmed);
  }

  function handleKeyDown(e) {
    if (e.key === 'Enter') {
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
    if (cancelledRef.current) {
      cancelledRef.current = false;
      return;
    }
    commit();
  }

  if (isEditing) {
    return (
      <input
        ref={inputRef}
        className="cell-edit-input"
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onKeyDown={handleKeyDown}
        onBlur={handleBlur}
      />
    );
  }

  return (
    <span
      onClick={() => onSelectMeta(taskId, colKey)}
      onDoubleClick={() => onStartTextEdit(taskId, colKey)}
    >
      {value ?? ''}
    </span>
  );
}

// Map urgency value to a CSS class for color coding.
function urgencyClass(urgency) {
  if (urgency >= 8) return 'urg-critical';
  if (urgency >= 6) return 'urg-high';
  if (urgency >= 3) return 'urg-noticeable';
  return 'urg-low';
}

export default function TaskRow({
  task, dates, todayStr, completions, notes, selectedCell, colLayout,
  selectedMetaCell, editingTextCell, armedCell,
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

  const rowClass = ['task-row', isPaused ? 'paused' : '', isScheduled ? 'scheduled' : '', isEnded ? 'ended' : '']
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
    <tr className={rowClass} data-task-id={task.id}>
      <td className="meta-col sticky-col col-actions" style={cs('col-actions')}>
        <button
          className="action-btn"
          onClick={() => onEdit(task)}
          title="Edit task"
        >✏</button>
      </td>
      <td className={`meta-col sticky-col col-urg ${isPaused || isScheduled || isEnded ? '' : urgencyClass(task.urgency)}`} style={cs('col-urg')}>
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
