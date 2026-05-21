import { useEffect, useRef } from 'react';

export default function LinkPopover({ links, anchorRect, onClose }) {
  const panelRef = useRef(null);

  useEffect(() => {
    function onMouseDown(e) {
      if (panelRef.current && !panelRef.current.contains(e.target)) {
        onClose();
      }
    }
    function onKeyDown(e) {
      if (e.key === 'Escape') onClose();
    }
    // Close on any scroll (grid scroll, window scroll) so popover doesn't drift.
    function onScroll() {
      onClose();
    }
    document.addEventListener('mousedown', onMouseDown);
    document.addEventListener('keydown', onKeyDown);
    window.addEventListener('scroll', onScroll, true); // capture phase catches all scrolling
    return () => {
      document.removeEventListener('mousedown', onMouseDown);
      document.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('scroll', onScroll, true);
    };
  }, [onClose]);

  if (!links || links.length === 0) return null;

  return (
    <div
      ref={panelRef}
      className="task-link-popover"
      style={{
        top:  anchorRect.bottom + 4,
        left: anchorRect.left,
      }}
      role="dialog"
      aria-label="Detected links"
    >
      <div className="task-link-popover-title">Detected links</div>
      <ul className="task-link-list">
        {links.map((link, i) => (
          <li key={i} className="task-link-item">
            <a
              href={link.href}
              className="task-link-url"
              target="_blank"
              rel="noopener noreferrer"
              title={link.href}
              onClick={(e) => e.stopPropagation()}
            >
              {link.label}
            </a>
          </li>
        ))}
      </ul>
    </div>
  );
}
