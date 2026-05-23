import { useState, useRef } from 'react';
import DateCell from './DateCell.jsx';
import LinkifiedText from './LinkifiedText.jsx';
import LinkPopover from './LinkPopover.jsx';
import { hasLinks, extractLinks } from '../linkUtils.js';

// Map urgency value to a CSS class for color coding.
function urgencyClass(urgency) {
  if (urgency >= 8) return 'urg-critical';
  if (urgency >= 6) return 'urg-high';
  if (urgency >= 3) return 'urg-noticeable';
  return 'urg-low';
}

export default function TaskRow({
  task, dates, todayStr, completions, notes, selectedCell, colLayout,
  onIncrement, onClear, onEdit, onSelect,
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
    <tr className={rowClass}>
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
      <td className="meta-col sticky-col col-status" style={cs('col-status')}>{task.status}</td>
      <td className="meta-col sticky-col col-active-from" style={cs('col-active-from')}>{task.active_from || ''}</td>
      <td className="meta-col sticky-col col-cat" style={cs('col-cat')}>{task.category}</td>
      <td className="meta-col sticky-col col-task" title={task.name} style={cs('col-task')}>{task.name}</td>
      <td className="meta-col sticky-col col-sub" title={task.subtask} style={cs('col-sub')}>{task.subtask || ''}</td>
      <td className="meta-col scroll-meta-col col-freq" style={cs('col-freq')}>{task.interval_days}d</td>
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
