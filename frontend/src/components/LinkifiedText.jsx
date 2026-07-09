// Safe link renderer — no dangerouslySetInnerHTML and no dependencies.
//
// Renders safe display-text links and bare URLs as <a> elements. Everything
// else, including unsafe protocols, stays plain text.

import { tokenizeLinkText } from '../linkUtils.js';
import { handleSafeLinkClick } from '../openExternalLink.js';

export default function LinkifiedText({ text, className }) {
  if (!text) return null;

  const parts = tokenizeLinkText(text).map((token, i) => {
    if (token.type !== 'link') return token.text;
    return (
      <a
        key={`${token.start}-${i}`}
        href={token.href}
        className="note-link"
        target="_blank"
        rel="noopener noreferrer"
        onClick={(e) => handleSafeLinkClick(e, token.href)}
      >
        {token.text}
      </a>
    );
  });

  return <span className={className}>{parts}</span>;
}
