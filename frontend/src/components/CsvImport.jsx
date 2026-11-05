import { useState } from 'react';
import { previewImport, applyImport } from '../api.js';

// ---------------------------------------------------------------------------
// CSV import — moved unchanged from the retired Archive page.
// ---------------------------------------------------------------------------

function PreviewResults({ preview }) {
  const {
    row_count, detected_metadata_columns, detected_date_columns,
    candidate_date_columns, unrecognized_columns, sample_rows, warnings,
  } = preview;

  const detected = Object.entries(detected_metadata_columns).filter(([, v]) => v !== null);

  return (
    <div className="import-result">
      <div><strong>Rows detected:</strong> {row_count}</div>

      {warnings.length > 0 && (
        <div>
          <div className="import-subhead import-warn-text">Warnings</div>
          <ul className="import-list import-warn-text">
            {warnings.map((w, i) => <li key={i}>{w}</li>)}
          </ul>
        </div>
      )}

      {detected.length > 0 && (
        <div>
          <div className="import-subhead">Detected metadata columns</div>
          <table className="dash-table">
            <thead><tr><th>Field</th><th>CSV Header</th></tr></thead>
            <tbody>
              {detected.map(([field, header]) => (
                <tr key={field}><td>{field}</td><td>{header}</td></tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {detected_date_columns.length > 0 && (
        <div>
          <strong>Date columns ({detected_date_columns.length}):</strong>{' '}
          {detected_date_columns.slice(0, 6).join(', ')}{detected_date_columns.length > 6 ? ' …' : ''}
        </div>
      )}

      {candidate_date_columns.length > 0 && (
        <div className="import-warn-text">
          <strong>Non-ISO date-like headers (not imported):</strong>{' '}
          {candidate_date_columns.join(', ')}
        </div>
      )}

      {unrecognized_columns.length > 0 && (
        <div className="import-muted-text">
          <strong>Unrecognized columns:</strong> {unrecognized_columns.join(', ')}
        </div>
      )}

      {sample_rows.length > 0 && (
        <div>
          <div className="import-subhead">Sample rows (up to 5)</div>
          <table className="dash-table">
            <thead>
              <tr>{Object.keys(sample_rows[0]).map((k) => <th key={k}>{k}</th>)}</tr>
            </thead>
            <tbody>
              {sample_rows.map((row, i) => (
                <tr key={i}>{Object.values(row).map((v, j) => <td key={j}>{String(v)}</td>)}</tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

function ImportSummary({ summary }) {
  const { tasks_created, completions_created, rows_skipped, potential_duplicates, warnings, errors } = summary;
  return (
    <div className="import-result">
      <div className="import-success-text">Import complete</div>
      <div>Tasks created: <strong>{tasks_created}</strong></div>
      <div>Completions created: <strong>{completions_created}</strong></div>
      <div>Rows skipped: <strong>{rows_skipped}</strong></div>
      {potential_duplicates.length > 0 && (
        <div>
          <div className="import-subhead import-warn-text">
            Potential duplicates skipped ({potential_duplicates.length})
          </div>
          <ul className="import-list import-warn-text">
            {potential_duplicates.map((d, i) => <li key={i}>{d}</li>)}
          </ul>
        </div>
      )}
      {warnings.length > 0 && (
        <div>
          <div className="import-subhead import-warn-text">Warnings</div>
          <ul className="import-list import-warn-text">
            {warnings.map((w, i) => <li key={i}>{w}</li>)}
          </ul>
        </div>
      )}
      {errors.length > 0 && (
        <div>
          <div className="import-subhead import-error-text">Errors</div>
          <ul className="import-list import-error-text">
            {errors.map((e, i) => <li key={i}>{e}</li>)}
          </ul>
        </div>
      )}
    </div>
  );
}

// ImportPreview renders only its inner content — Archive wraps it in ws-frame.
function ImportPreviewBody() {
  const [file, setFile]             = useState(null);
  const [preview, setPreview]       = useState(null);
  const [loading, setLoading]       = useState(false);
  const [error, setError]           = useState(null);
  const [confirmed, setConfirmed]   = useState(false);
  const [applyLoading, setApplyLoading] = useState(false);
  const [applyResult, setApplyResult]   = useState(null);
  const [applyError, setApplyError]     = useState(null);

  const previewHasName = preview?.detected_metadata_columns?.name != null;

  async function handlePreview() {
    if (!file) return;
    setLoading(true);
    setError(null);
    setApplyResult(null);
    setApplyError(null);
    setConfirmed(false);
    try {
      setPreview(await previewImport(file));
    } catch (e) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  }

  async function handleApply() {
    if (!file || !confirmed) return;
    setApplyLoading(true);
    setApplyError(null);
    setApplyResult(null);
    try {
      setApplyResult(await applyImport(file));
    } catch (e) {
      setApplyError(e.message);
    } finally {
      setApplyLoading(false);
    }
  }

  return (
    <div className="ws-frame-body" style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>
      {/* Dry-run banner — design report .ban pattern */}
      <div className="import-file-row">
        <input
          type="file"
          accept=".csv"
          style={{ fontSize: '12px' }}
          onChange={(e) => {
            setFile(e.target.files[0] || null);
            setPreview(null);
            setConfirmed(false);
            setApplyResult(null);
            setApplyError(null);
          }}
        />
        <button
          className="btn-archive-sheet"
          onClick={handlePreview}
          disabled={!file || loading}
        >
          {loading ? 'Parsing…' : 'Preview CSV'}
        </button>
      </div>

      {error && <div className="grid-status error" style={{ padding: '4px 0' }}>Error: {error}</div>}
      {preview && <PreviewResults preview={preview} />}

      {preview && previewHasName && (
        <div className="import-apply-row">
          <label className="import-confirm-label">
            <input
              type="checkbox"
              checked={confirmed}
              onChange={(e) => setConfirmed(e.target.checked)}
              style={{ marginTop: '2px' }}
            />
            I exported a backup and understand this will create new tasks.
          </label>
          <button
            className="btn-archive-sheet"
            onClick={handleApply}
            disabled={!confirmed || applyLoading}
            style={{ alignSelf: 'flex-start' }}
          >
            {applyLoading ? 'Importing…' : 'Apply Import'}
          </button>
        </div>
      )}

      {applyError && (
        <div className="grid-status error" style={{ padding: '4px 0' }}>Error: {applyError}</div>
      )}
      {applyResult && <ImportSummary summary={applyResult} />}
    </div>
  );
}

export default function CsvImport() {
  return (
    <div className="ws-frame">
      <div className="ws-frame-header">
        <span>Import CSV</span>
      </div>
      <ImportPreviewBody />
    </div>
  );
}
