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

// Urgency → color-band thresholds. DISPLAY ONLY — this maps a computed urgency
// to a CSS color class; it does not change the urgency value or any stored data.
//
// Recalibrated in P4.0A. The urgency formula (backend logic.py) saturates fast:
// a task at exactly its interval (days_since ≈ interval_days) already scores
// ~8.7–9.2, so the previous critical>=8 cutoff painted nearly every due/overdue
// task full red — the grid looked uniformly "red 10" and gave no ranking.
// These bands (for a default priority-5 task) mean, in overdue terms:
//   critical (red):   >= 9.5  → ~1.5× interval overdue and beyond
//   high (amber):     >= 8.0  → around the due point
//   noticeable:       >= 5.0  → approaching due (~0.4× interval)
//   low (muted):      <  5.0  → fresh
// NOTE: the formula still compresses everything past ~2.5× interval into ~10,
// so very-overdue tasks remain indistinguishable numerically — differentiating
// those requires a scoring change (deferred to Pressure V2 / P4.0B), not display.
const URG_CRITICAL   = 9.5;
const URG_HIGH       = 8.0;
const URG_NOTICEABLE = 5.0;

function urgencyClass(urgency) {
  if (urgency >= URG_CRITICAL)   return 'urg-critical';
  if (urgency >= URG_HIGH)       return 'urg-high';
  if (urgency >= URG_NOTICEABLE) return 'urg-noticeable';
  return 'urg-low';
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
