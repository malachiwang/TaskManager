// Keyboard help panel — P4 Keyboard Discoverability.
// Purely presentational — no internal state.
// Rendered conditionally by TaskGrid when helpOpen is true.

import { KEYBIND_HELP } from '../keybinds.js';

export default function KeyboardHelp({ panelRef, closeButtonRef, onClose }) {
  return (
    <div
      ref={panelRef}
      className="ws-kbd-help-panel"
      role="dialog"
      aria-label="Keyboard shortcuts"
      aria-modal="false"
    >
      <div className="ws-kbd-help-head">
        <span>Keyboard Shortcuts</span>
        <button
          ref={closeButtonRef}
          type="button"
          className="ws-kbd-help-close"
          aria-label="Close keyboard shortcuts"
          onClick={onClose}
        >
          ×
        </button>
      </div>
      {KEYBIND_HELP.map((section) => (
        <div key={section.group} className="ws-kbd-help-section">
          <div className="ws-kbd-help-title">{section.group}</div>
          {section.items.map((item) => (
            <div key={item.keys} className="ws-kbd-help-row">
              <span className="ws-kbd-help-key">{item.keys}</span>
              <span className="ws-kbd-help-desc">{item.desc}</span>
            </div>
          ))}
        </div>
      ))}
    </div>
  );
}
