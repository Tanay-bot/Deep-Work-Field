import type { Checkpoint } from './types';

/**
 * Escape a fragment term per the Text Fragments spec: percent-encode the term,
 * and also encode '-' (which encodeURIComponent leaves alone) so it cannot be
 * read as a prefix/suffix separator. ',' and '&' are already encoded.
 */
export function encodeFragmentTerm(text: string): string {
  return encodeURIComponent(text).replace(/-/g, '%2D');
}

/** Case folding that never changes length, so offsets stay 1:1 with the DOM. */
export function foldCase(text: string): string {
  let out = '';
  for (const ch of text) {
    const lower = ch.toLowerCase();
    out += lower.length === ch.length ? lower : ch;
  }
  return out;
}

export function normalizePassage(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

/** Chrome scrolls to `#:~:text=prefix-,start,-suffix` on a real navigation. */
export function buildTextFragmentUrl(baseUrl: string, checkpoint: Pick<Checkpoint, 'anchor' | 'prefix' | 'suffix'>): string {
  const anchor = normalizePassage(checkpoint.anchor);
  if (!anchor) return baseUrl.split('#')[0];
  const prefix = normalizePassage(checkpoint.prefix);
  const suffix = normalizePassage(checkpoint.suffix);
  const parts: string[] = [];
  if (prefix) parts.push(`${encodeFragmentTerm(prefix)}-`);
  parts.push(encodeFragmentTerm(anchor));
  if (suffix) parts.push(`-${encodeFragmentTerm(suffix)}`);
  // Keep an app's own hash (hash routers) and append the directive after it.
  const [base, hash = ''] = baseUrl.split('#');
  const ownHash = hash.split(':~:')[0];
  return `${base}#${ownHash}:~:text=${parts.join(',')}`;
}

/** True when a URL already carries a scroll-to-text fragment. */
export function hasTextFragment(url: string): boolean {
  return url.includes('#:~:text=');
}
