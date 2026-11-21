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

/**
 * Chrome scrolls to `#:~:text=prefix-,start[,end],-suffix` on a real
 * navigation. Each term must sit inside one block, so a checkpoint's
 * block-local `fragment` terms are used when present; otherwise the stored
 * prefix/suffix are trimmed to a few words as a best effort.
 */
export function buildTextFragmentUrl(baseUrl: string, checkpoint: Pick<Checkpoint, 'anchor' | 'prefix' | 'suffix' | 'fragment'>): string {
  const anchor = normalizePassage(checkpoint.anchor);
  const [base, hash = ''] = baseUrl.split('#');
  const ownHash = hash.split(':~:')[0];
  if (!anchor) return ownHash ? `${base}#${ownHash}` : base;
  const tail = (t: string) => normalizePassage(t).split(' ').filter(Boolean).slice(-6).join(' ');
  const head = (t: string) => normalizePassage(t).split(' ').filter(Boolean).slice(0, 6).join(' ');
  const f = checkpoint.fragment ?? { prefix: tail(checkpoint.prefix), start: anchor, suffix: head(checkpoint.suffix) };
  const parts: string[] = [];
  if (f.prefix) parts.push(`${encodeFragmentTerm(normalizePassage(f.prefix))}-`);
  parts.push(encodeFragmentTerm(normalizePassage(f.start)));
  if (f.end) parts.push(encodeFragmentTerm(normalizePassage(f.end)));
  if (f.suffix) parts.push(`-${encodeFragmentTerm(normalizePassage(f.suffix))}`);
  // Keep an app's own hash (hash routers) and append the directive after it.
  return `${base}#${ownHash}:~:text=${parts.join(',')}`;
}

/** True when a URL already carries a scroll-to-text fragment. */
export function hasTextFragment(url: string): boolean {
  return url.includes('#:~:text=');
}
