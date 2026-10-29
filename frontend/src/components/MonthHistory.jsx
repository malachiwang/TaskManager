import { useEffect, useState } from 'react';
import { fetchArchives, fetchArchive } from '../api.js';

// Read-only compatibility for historical task versions that only exist in snapshots.
export default function MonthHistory({ month, selectedId, onSelect, targetId }) {
  const [records, setRecords] = useState([]);
  const [snapshot, setSnapshot] = useState(null);
  const [error, setError] = useState('');
  const start = `${month.year}-${String(month.month).padStart(2, '0')}-01`;
  const end = `${month.year}-${String(month.month).padStart(2, '0')}-31`;
  useEffect(() => {
    let alive = true;
    fetchArchives().then(rows => { if (alive) setRecords(rows); }).catch(e => { if (alive) setError(e.message); });
    return () => { alive = false; };
  }, []);
  useEffect(() => {
    let alive = true;
    setSnapshot(null); setError('');
    if (selectedId !== null) fetchArchive(selectedId).then(row => {
      if (alive) setSnapshot(row.snapshot_data_json);
    }).catch(e => { if (alive) setError(e.message); });
    return () => { alive = false; };
  }, [selectedId]);
  useEffect(() => {
    if (snapshot && targetId) document.querySelector(`tr[data-history-task="${targetId}"]`)?.scrollIntoView({ block: 'center' });
  }, [snapshot, targetId]);
  const options = records.filter(r => r.start_date <= end && r.end_date >= start);
  const dates = [];
  if (snapshot) {
    const d = new Date(`${snapshot.start_date}T00:00:00Z`);
    while (d.toISOString().slice(0, 10) <= snapshot.end_date) {
      dates.push(d.toISOString().slice(0, 10)); d.setUTCDate(d.getUTCDate() + 1);
    }
  }
  if (!options.length && selectedId === null && !error) return null;
  return <section className="month-history" aria-label="Monthly history">
    <label>History <select aria-label="Monthly history" value={selectedId ?? ''} onChange={e => onSelect(e.target.value ? Number(e.target.value) : null)}>
      <option value="">Current records</option>
      {options.map(r => <option key={r.id} value={r.id}>{r.name} · {r.archived_at.slice(0, 10)} · saved version #{r.id}</option>)}
    </select></label>
    {error && <p role="alert">Could not load history: {error}</p>}
    {selectedId !== null && !snapshot && !error && <p role="status">Loading history…</p>}
    {snapshot && <>
      <p>Saved version · {snapshot.start_date} – {snapshot.end_date} · read only</p>
      <div className="archive-grid-wrapper"><table className="task-grid archive-grid"><thead><tr>
        {['Task', 'Subtask', 'Section', 'Category', 'Status', 'Priority', 'Frequency', 'Saved urgency', 'Days since', 'Last done', 'Manual last done', 'Active from', 'Finished on', 'Notes', ...dates].map(h => <th key={h}>{h}</th>)}
      </tr></thead><tbody>{(snapshot.tasks || []).map(t => <tr key={t.id} data-history-task={t.id} className={targetId === t.id ? 'history-selected' : ''}>
        <td>{t.name}</td><td>{t.subtask}</td><td>{t.section}</td><td>{t.category}</td><td>{t.status}</td><td>{t.priority}</td><td>{t.interval_days}d</td><td>{t.urgency ?? '—'}</td><td>{t.days_since ?? '—'}</td><td>{t.effective_last_done || t.latest_completion || '—'}</td><td>{t.manual_last_done_override || '—'}</td><td>{t.active_from || '—'}</td><td>{t.end_date || '—'}</td><td>{t.notes}</td>
        {dates.map(d => <td key={d} title={t.cell_notes?.[d]}>{t.completions?.[d] || ''}{t.cell_notes?.[d] && <small className="history-note">{t.cell_notes[d]}</small>}</td>)}
      </tr>)}</tbody></table></div>
    </>}
  </section>;
}
