// Shared safe-link parsing helpers — used by LinkifiedText and LinkPopover.
//
// Supports display-text links like [label](https://example.com) plus bare
// http://, https://, www., and mailto: links. Unsafe schemes stay plain text.

export const URL_RE = /https?:\/\/\S+|www\.\S+|mailto:[^\s<>()]+/gi;
const MARKDOWN_LINK_RE = /\[([^\]\n]*)\]\(([^()\s]+)\)/g;
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

export function normalizeSafeUrl(raw) {
  return normalizeHref(raw);
}

export function isSafeHref(raw) {
  return normalizeSafeUrl(raw) !== null;
}

function normalizeLinkLabel(label, fallback) {
  const cleaned = String(label ?? '')
    .replace(/[\r\n]+/g, ' ')
    .replace(/[\[\]]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return cleaned || fallback;
}

export function buildMarkdownLink(label, rawUrl) {
  const href = normalizeSafeUrl(rawUrl);
  if (!href) return null;
  return `[${normalizeLinkLabel(label, href)}](${href})`;
}

export function spliceMarkdownLink(text, start, end, label, rawUrl) {
  const value = String(text ?? '');
  const markdown = buildMarkdownLink(label, rawUrl);
  if (!markdown) return null;

  const safeStart = Math.min(Math.max(Number(start) || 0, 0), value.length);
  const safeEnd = Math.min(Math.max(Number(end) || safeStart, safeStart), value.length);
  return {
    text: `${value.slice(0, safeStart)}${markdown}${value.slice(safeEnd)}`,
    markdown,
    cursor: safeStart + markdown.length,
  };
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
    const preceding = text.slice(lastIndex, match.index);

    const raw = stripTrailingPunct(match[0]);
    const trailing = match[0].slice(raw.length);
    const href = text.slice(Math.max(0, match.index - 2), match.index) === ']('
      ? null
      : normalizeHref(raw);

    // Legacy malformed "Labelhttps://…" — a safe URL glued directly onto a
    // non-empty label with no separating whitespace (e.g. produced before
    // Insert Link stored proper markdown). Show the label as the clickable
    // text and hide the raw URL, instead of printing "Label" + the URL.
    // Only fires for safe hrefs; spaced bare URLs keep their existing display.
    if (href && /\S$/.test(preceding)) {
      const label = preceding.replace(/\s+/g, ' ').trim();
      tokens.push({
        type: 'link',
        raw: preceding + raw,
        href,
        text: label,
        label,
        start: offset + lastIndex,
      });
      if (trailing) tokens.push({ type: 'text', text: trailing });
      lastIndex = match.index + match[0].length;
      continue;
    }

    if (match.index > lastIndex) {
      tokens.push({ type: 'text', text: preceding });
    }

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

// First-pass detection for legacy malformed "Label<safeURL>" values where a
// safe URL is glued directly onto a non-empty label with no separating
// whitespace (e.g. "Addresshttps://news.google.com/…"). Returns tokens showing
// the label as the clickable text with the URL hidden, or null if the string is
// not a glued case (letting the normal markdown/bare passes handle it).
function detectGluedLabelLink(text) {
  // If proper markdown link syntax is present, the markdown pass owns labels.
  if (MARKDOWN_LINK_RE.test(text)) { MARKDOWN_LINK_RE.lastIndex = 0; return null; }

  const m = new RegExp(URL_RE.source, 'i').exec(text);
  if (!m) return null;

  const idx = m.index;
  if (idx <= 0) return null;                    // URL at start → no preceding label
  if (/\s/.test(text[idx - 1])) return null;    // whitespace before URL → spaced, not glued

  const label = text.slice(0, idx).replace(/\s+/g, ' ').trim();
  if (!label) return null;                      // label must be non-empty

  const raw = stripTrailingPunct(m[0]);
  const href = normalizeHref(raw);
  if (!href) return null;                        // unsafe → leave as plain text

  const tokens = [{
    type: 'link',
    raw: text.slice(0, idx) + raw,
    href,
    text: label,
    label,
    start: 0,
  }];
  // Tokenize anything after the consumed URL normally (handles trailing text or
  // additional links). `idx > 0` guarantees the remainder is strictly shorter.
  const rest = m[0].slice(raw.length) + text.slice(idx + m[0].length);
  if (rest) tokens.push(...tokenizeLinkText(rest));
  return tokens;
}

// True when a link's *visible* text is itself a raw URL (e.g. the legacy
// Insert Link output `[https://x](https://x)`), so displaying it leaks URL text.
function isUrlLikeLabel(label) {
  if (!label) return false;
  return new RegExp(`^(?:${URL_RE.source})$`, 'i').test(label.trim());
}

// Display-only cleanup for legacy malformed values (verified in the real DB):
//   Address[https://x](https://x)            → link "Address" → x
//   [Academic Work](x)[https://x](https://x) → link "Academic Work" → x
//   Clean disheshttps://x[https://x](https://x)[https://x](https://x)
//                                             → link "Clean dishes" → x
// Any link token whose visible text is itself a URL is collapsed into the
// immediately-adjacent preceding label text (which becomes the clickable
// text), or dropped as redundant when it directly follows a link to the same
// href. Standalone / whitespace-separated URLs keep their normal display.
// Saved data is never mutated — this only shapes the rendered tokens.
function collapseLegacyUrlLabels(tokens) {
  const out = [];
  for (const tok of tokens) {
    if (tok.type === 'link' && isUrlLikeLabel(tok.text)) {
      const prev = out[out.length - 1];
      if (prev && prev.type === 'text' && /\S$/.test(prev.text)) {
        const label = prev.text.replace(/\s+/g, ' ').trim();
        out.pop();
        out.push({ ...tok, text: label, label, raw: prev.text + tok.raw, start: prev.start ?? tok.start });
        continue;
      }
      if (prev && prev.type === 'link' && prev.href === tok.href) {
        continue; // redundant "[url](url)" glued right after an equivalent link
      }
    }
    out.push(tok);
  }
  return out;
}

export function tokenizeLinkText(text) {
  if (!text) return [];

  const glued = detectGluedLabelLink(text);
  if (glued) return collapseLegacyUrlLabels(glued);

  const tokens = [];
  const re = new RegExp(MARKDOWN_LINK_RE.source, 'g');
  let lastIndex = 0;
  let match;

  while ((match = re.exec(text)) !== null) {
    if (match.index > lastIndex) {
      tokens.push(...parseBareLinks(text.slice(lastIndex, match.index), lastIndex));
    }

    const [raw, label, url] = match;
    const href = label ? normalizeHref(url) : null;
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

  return collapseLegacyUrlLabels(tokens);
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
