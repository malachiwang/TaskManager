// External link opening — shared by every safe-link renderer.
//
// In the browser/dev build, safe links keep their normal <a target="_blank">
// behavior. In the packaged Tauri app, WKWebView ignores target="_blank", so
// clicks are intercepted and routed through the Tauri opener plugin, which
// hands the URL to the system browser / mail client. Every href is
// re-validated through the shared safe-link utility before opening — unsafe
// schemes never reach the opener regardless of how the DOM was manipulated.

import { normalizeSafeUrl } from './linkUtils.js';
import { openUrl } from '@tauri-apps/plugin-opener';

export function isTauri() {
  return typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;
}

// Click handler for safe-link <a> elements. Stops propagation so grid/cell
// selection never triggers from a link click. Returns nothing; failures are
// logged, never thrown into React handlers.
export function handleSafeLinkClick(e, rawHref) {
  e.stopPropagation();
  const href = normalizeSafeUrl(rawHref);
  if (!href) {
    // Should be unreachable (only safe links are rendered as <a>), but if an
    // unsafe href appears, keep it fully inert.
    e.preventDefault();
    return;
  }
  if (isTauri()) {
    e.preventDefault();
    openUrl(href).catch((err) => {
      console.error('external link open failed:', err);
    });
  }
  // Browser/dev: let the anchor's target="_blank" rel="noopener noreferrer"
  // behavior proceed unchanged.
}
