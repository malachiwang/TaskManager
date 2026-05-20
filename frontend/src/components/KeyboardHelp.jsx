// Keyboard help panel.
// Receives resolvedKb from TaskGrid so labels reflect any active custom bindings.

import { KEYBIND_HELP, bindingLabel } from '../keybinds.js';

export default function KeyboardHelp({ panelRef, closeButtonRef, onClose, resolvedKb }) {
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
          {section.items.map((item) => {
            const label = item.action && resolvedKb
              ? bindingLabel(resolvedKb[item.action])
              : item.keys;
            const rowKey = item.action ?? item.keys;
            return (
              <div key={rowKey} className="ws-kbd-help-row">
                <span className="ws-kbd-help-key">{label}</span>
                <span className="ws-kbd-help-desc">{item.desc}</span>
              </div>
            );
          })}
        </div>
      ))}
    </div>
  );
}
