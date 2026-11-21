/**
 * Lightweight local embedder (hashed bag of words). It is deterministic, runs
 * in milliseconds, needs no model download, and works offline. The ML embedder
 * adapter in the web app uses the same interface, so this can be swapped for
 * Transformers.js without touching the engine or correction memory.
 */
const STOPWORDS = new Set(
  ('a an the and or but if then than that this these those is are was were be been being to of in on at for from by with as it its ' +
    'you your we our they their he she his her i me my not no do does did done can could should would will just so up out about into ' +
    'over after before while during very more most some any all each other such only own same too also').split(' '),
);

function fnv1a(str: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

export const EMBEDDING_DIMS = 192;
/** Bump whenever tokenization or hashing changes: stored corrections from another version are ignored. */
export const EMBEDDING_VERSION = 2;

const SHORT_STOPWORDS = new Set(['an', 'as', 'at', 'be', 'by', 'do', 'go', 'he', 'if', 'in', 'is', 'it', 'me', 'my', 'no', 'of', 'oh', 'ok', 'on', 'or', 'so', 'to', 'up', 'us', 'we']);

/** Content terms of a text: lowercase alphanumerics, 2+ chars, no function words. */
export function contentTerms(text: string): string[] {
  const tokens = text.toLowerCase().match(/[a-z0-9]+/g) ?? [];
  return tokens.filter((t) => t.length >= 2 && !STOPWORDS.has(t) && !SHORT_STOPWORDS.has(t));
}

export function embedText(text: string, dims = EMBEDDING_DIMS): number[] {
  const vec = new Array<number>(dims).fill(0);
  const tokens = text.toLowerCase().match(/[a-z0-9]+/g) ?? [];
  const counts = new Map<string, number>();
  for (const token of tokens) {
    // Keep short task identifiers and element symbols ("4b", "al", "cl"):
    // two-character tokens survive unless they are common function words.
    if (token.length < 2 || STOPWORDS.has(token) || SHORT_STOPWORDS.has(token)) continue;
    counts.set(token, (counts.get(token) ?? 0) + 1);
  }
  for (const [token, count] of counts) {
    const h = fnv1a(token);
    const idx = h % dims;
    const sign = (h >>> 16) & 1 ? 1 : -1;
    vec[idx] += sign * (1 + Math.log(count));
    // A second hashed slot makes collisions less destructive.
    const idx2 = (h >>> 7) % dims;
    vec[idx2] += sign * 0.5 * (1 + Math.log(count));
  }
  let mag = 0;
  for (const v of vec) mag += v * v;
  mag = Math.sqrt(mag);
  if (mag > 0) for (let i = 0; i < dims; i++) vec[i] /= mag;
  return vec;
}

export function cosine(a: number[], b: number[]): number {
  let dot = 0;
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) dot += a[i] * b[i];
  return dot;
}
