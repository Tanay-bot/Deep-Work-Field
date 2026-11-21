import type { Checkpoint } from './types';

/**
 * Escape a fragment term: dashes and commas inside the text are doubled, then
 * each part is URL-encoded. The separators added afterwards stay single.
 */
export function encodeFragmentTerm(text: string): string {
  return encodeURIComponent(text.replace(/-/g, '--').replace(/,/g, ',,'));
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
  return `${baseUrl.split('#')[0]}#:~:text=${parts.join(',')}`;
}

/** True when a URL already carries a scroll-to-text fragment. */
export function hasTextFragment(url: string): boolean {
  return url.includes('#:~:text=');
}
