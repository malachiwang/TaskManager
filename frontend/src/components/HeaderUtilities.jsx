import { createContext, useContext, useEffect, useRef, useState } from 'react';
import WorkspaceSearch from './WorkspaceSearch.jsx';
import KeyboardHelp from './KeyboardHelp.jsx';
import { isTypingTarget, matchKeybind, resolveKeybinds } from '../keybinds.js';

export const WorkspaceNavigation = createContext(() => {});

function UtilityHelp() {
  const [open, setOpen] = useState(false);
  const anchor = useRef(null);
  const trigger = useRef(null);
  const close = useRef(null);
  function dismiss() { setOpen(false); trigger.current?.focus(); }
  useEffect(() => {
    if (open) close.current?.focus();
    function outside(event) { if (!anchor.current?.contains(event.target)) setOpen(false); }
    function key(event) {
      if (isTypingTarget(event.target)) return;
      const kb = resolveKeybinds();
      if (open && matchKeybind(event, kb.CLEAR_SELECTION)) { event.preventDefault(); dismiss(); }
      else if ((open || !document.querySelector('.task-modal-overlay, [role="dialog"]')) && matchKeybind(event, kb.TOGGLE_HELP)) {
        event.preventDefault(); setOpen(value => !value);
      }
    }
    document.addEventListener('pointerdown', outside);
    window.addEventListener('keydown', key);
    return () => { document.removeEventListener('pointerdown', outside); window.removeEventListener('keydown', key); };
  }, [open]);
  return <div className="ws-kbd-help-anchor" ref={anchor}>
    <button ref={trigger} type="button" className="ws-kbd-help-btn" aria-label="Keyboard shortcuts"
      aria-haspopup="dialog" aria-expanded={open} onClick={() => setOpen(value => !value)}>?</button>
    {open && <KeyboardHelp closeButtonRef={close} onClose={dismiss} resolvedKb={resolveKeybinds()} />}
  </div>;
}

export default function HeaderUtilities({ children }) {
  const onOpen = useContext(WorkspaceNavigation);
  return <div className="header-utilities">
    <WorkspaceSearch onOpen={onOpen} />
    {children || <UtilityHelp />}
  </div>;
}
