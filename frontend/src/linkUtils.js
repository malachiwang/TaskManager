// Shared safe-link parsing helpers — used by LinkifiedText and LinkPopover.
//
// Supports display-text links like [label](https://example.com) plus bare
// http://, https://, www., and mailto: links. Unsafe schemes stay plain text.

export const URL_RE = /https?:\/\/\S+|www\.\S+|mailto:[^\s<>()]+/gi;
const MARKDOWN_LINK_RE = /\[([^\]\n]+)\]\(([^()\s]+)\)/g;
const SAFE_PROTOCOLS = new Set(['http:', 'https:', 'mailto:']);

export function stripTrailingPunct(s) {
  return s.replace(/[.,;:!?)\]'"]+$/, '');
}

export function normalizeHref(raw) {
  if (!raw) return null;
  const trimmed = raw.trim();
  const href = /^www\./i.test(trimmed) ? `https://${trimmed}` : trimmed;

  try {
    const parsed = new URL(href);
    return SAFE_PROTOCOLS.has(parsed.protocol) ? href : null;
  } catch {
    return null;
  }
}

export function displayLinkLabel(url) {
  try {
    const u = new URL(url);
    if (u.protocol === 'mailto:') return u.pathname || url;
    const path = u.pathname.length > 20
      ? u.pathname.slice(0, 18) + '\u2026'
      : u.pathname;
    return u.hostname + path;
  } catch {
    return url.slice(0, 40);
  }
}

function parseBareLinks(text, offset = 0) {
  const tokens = [];
  const re = new RegExp(URL_RE.source, 'gi');
  let lastIndex = 0;
  let match;

  while ((match = re.exec(text)) !== null) {
    if (match.index > lastIndex) {
      tokens.push({ type: 'text', text: text.slice(lastIndex, match.index) });
    }

    const raw = stripTrailingPunct(match[0]);
    const trailing = match[0].slice(raw.length);
    const href = normalizeHref(raw);

    if (href) {
      tokens.push({
        type: 'link',
        raw,
        href,
        text: raw,
        label: displayLinkLabel(href),
        start: offset + match.index,
      });
    } else {
      tokens.push({ type: 'text', text: raw });
    }

    if (trailing) tokens.push({ type: 'text', text: trailing });
    lastIndex = match.index + match[0].length;
  }

  if (lastIndex < text.length) {
    tokens.push({ type: 'text', text: text.slice(lastIndex) });
  }

  return tokens;
}

export function tokenizeLinkText(text) {
  if (!text) return [];

  const tokens = [];
  const re = new RegExp(MARKDOWN_LINK_RE.source, 'g');
  let lastIndex = 0;
  let match;

  while ((match = re.exec(text)) !== null) {
    if (match.index > lastIndex) {
      tokens.push(...parseBareLinks(text.slice(lastIndex, match.index), lastIndex));
    }

    const [raw, label, url] = match;
    const href = normalizeHref(url);
    if (href) {
      tokens.push({
        type: 'link',
        raw,
        href,
        text: label,
        label,
        start: match.index,
      });
    } else {
      tokens.push({ type: 'text', text: raw });
    }

    lastIndex = match.index + raw.length;
  }

  if (lastIndex < text.length) {
    tokens.push(...parseBareLinks(text.slice(lastIndex), lastIndex));
  }

  return tokens;
}

// Returns [{raw, href, label}] for every safe link found in text.
export function extractLinks(text) {
  return tokenizeLinkText(text)
    .filter((token) => token.type === 'link')
    .map((token) => ({
      raw: token.raw,
      href: token.href,
      label: token.label || displayLinkLabel(token.href),
    }));
}

// Returns true if text contains at least one safe link.
export function hasLinks(text) {
  return tokenizeLinkText(text).some((token) => token.type === 'link');
}
