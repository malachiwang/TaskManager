import { useState, useEffect } from 'react';

function dateLabel(isoDate) {
  const [y, m, day] = isoDate.split('-').map(Number);
  return new Date(y, m - 1, day).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

export default function EditBar({ selectedCell, tasks, completions, todayStr, onIncrement, onClear, onSetCount }) {
  const [setMode, setSetMode] = useState(false);
  const [inputVal, setInputVal] = useState('');

  // Reset set-count input whenever selection changes.
  useEffect(() => {
    setSetMode(false);
    setInputVal('');
  }, [selectedCell]);

  if (!selectedCell) {
    return (
      <div className="edit-bar">
        <span className="edit-bar-empty">Click a date cell to select it</span>
      </div>
    );
  }

  const { taskId, date } = selectedCell;
  const task = tasks.find((t) => t.id === taskId);
  const count = completions[`${taskId}:${date}`] || 0;
  const isFuture = date > todayStr;
  const isPaused = task ? task.is_paused === 1 : false;
  const isDisabled = isFuture || isPaused;

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

  return (
    <div className="edit-bar">
      <div className="edit-bar-info">
        <span className="edit-bar-task">{task ? task.name : `Task #${taskId}`}</span>
        <span className="edit-bar-sep">·</span>
        <span className="edit-bar-date">{dateLabel(date)}</span>
        <span className="edit-bar-sep">·</span>
        {isDisabled ? (
          <span className="edit-bar-disabled">{isFuture ? 'future date' : 'paused'}</span>
        ) : (
          <span className="edit-bar-count">count: {count}</span>
        )}
      </div>
      {!isDisabled && (
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
        </div>
      )}
    </div>
  );
}
