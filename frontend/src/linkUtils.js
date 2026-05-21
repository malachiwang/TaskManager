// Shared URL parsing helpers — used by LinkifiedText and LinkPopover.
//
// Detects http://, https://, and www. URLs in plain text.
// Dangerous schemes (javascript:, data:, file:, ftp:, mailto:) are blocked.

export const URL_RE = /https?:\/\/\S+|www\.\S+/g;

export function stripTrailingPunct(s) {
  return s.replace(/[.,;:!?)\]'"]+$/, '');
}

export function normalizeHref(raw) {
  if (/^https?:\/\//i.test(raw)) return raw;
  if (/^www\./i.test(raw))       return `https://${raw}`;
  return null; // block javascript:, data:, file:, mailto:, ftp:, etc.
}

export function displayLinkLabel(url) {
  try {
    const u = new URL(url);
    const path = u.pathname.length > 20
      ? u.pathname.slice(0, 18) + '\u2026'
      : u.pathname;
    return u.hostname + path;
  } catch {
    return url.slice(0, 40);
  }
}

// Returns [{raw, href, label}] for every safe URL found in text.
export function extractLinks(text) {
  if (!text) return [];
  const re = new RegExp(URL_RE.source, 'g');
  const results = [];
  let match;
  while ((match = re.exec(text)) !== null) {
    const raw  = stripTrailingPunct(match[0]);
    const href = normalizeHref(raw);
    if (href) {
      results.push({ raw, href, label: displayLinkLabel(href) });
    }
  }
  return results;
}

// Returns true if text contains at least one safe linkable URL.
export function hasLinks(text) {
  if (!text) return false;
  const re = new RegExp(URL_RE.source, 'g');
  let match;
  while ((match = re.exec(text)) !== null) {
    if (normalizeHref(stripTrailingPunct(match[0])) !== null) return true;
  }
  return false;
}
