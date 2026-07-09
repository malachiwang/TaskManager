// Keyboard help panel.
// Receives resolvedKb from the host page so labels reflect any active custom
// bindings. Customizable commands get a small ✎ marker; a binding changed
// from its default also shows the default so the panel never lies about
// what a key currently does.

import { KEYBIND_HELP, KEYBINDS, bindingLabel, bindingSignature, normalizeBinding } from '../keybinds.js';

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
          {section.note && (
            <div className="ws-kbd-help-note">{section.note}</div>
          )}
          {section.items.map((item) => {
            const def = item.action ? KEYBINDS[item.action] : null;
            const resolved = item.action && resolvedKb ? resolvedKb[item.action] : null;
            const label = resolved ? bindingLabel(resolved) : item.keys;
            const changed = def && resolved
              && bindingSignature(resolved) !== bindingSignature(normalizeBinding(def));
            const rowKey = item.action ?? item.keys;
            return (
              <div key={rowKey} className="ws-kbd-help-row">
                <span className="ws-kbd-help-key">{label}</span>
                <span className="ws-kbd-help-desc">
                  {item.desc}
                  {changed && (
                    <span className="ws-kbd-help-changed"> · default {bindingLabel(normalizeBinding(def))}</span>
                  )}
                </span>
                {def?.customizable && (
                  <span className="ws-kbd-help-custom" title="Customizable in Settings">✎</span>
                )}
              </div>
            );
          })}
        </div>
      ))}
      <div className="ws-kbd-help-note ws-kbd-help-footnote">
        ✎ marks customizable shortcuts — change them in Settings → Keyboard shortcuts.
      </div>
    </div>
  );
}
