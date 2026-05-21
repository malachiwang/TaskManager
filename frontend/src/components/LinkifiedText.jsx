// Safe URL linkifier — no dangerouslySetInnerHTML, no markdown, no dependencies.
//
// Detects http://, https://, and www. URLs in plain text and renders them as
// <a> elements. Everything else renders as plain text. Dangerous schemes
// (javascript:, data:, file:, etc.) are blocked at the href-normalization step.

import { URL_RE, stripTrailingPunct, normalizeHref } from '../linkUtils.js';

export default function LinkifiedText({ text, className }) {
  if (!text) return null;

  const parts = [];
  const re = new RegExp(URL_RE.source, 'g');
  let lastIndex = 0;
  let match;

  while ((match = re.exec(text)) !== null) {
    // Plain text before this match.
    if (match.index > lastIndex) {
      parts.push(text.slice(lastIndex, match.index));
    }

    const raw      = stripTrailingPunct(match[0]);
    const trailing = match[0].slice(raw.length); // punctuation stripped from end
    const href     = normalizeHref(raw);

    if (href) {
      parts.push(
        <a
          key={match.index}
          href={href}
          className="note-link"
          target="_blank"
          rel="noopener noreferrer"
          onClick={(e) => e.stopPropagation()}
        >
          {raw}
        </a>
      );
    } else {
      // Blocked scheme — render as plain text.
      parts.push(raw);
    }

    if (trailing) parts.push(trailing);
    lastIndex = match.index + match[0].length;
  }

  // Remaining text after the last match.
  if (lastIndex < text.length) {
    parts.push(text.slice(lastIndex));
  }

  return <span className={className}>{parts}</span>;
}
