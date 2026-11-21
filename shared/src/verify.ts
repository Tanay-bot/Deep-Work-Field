import type { Checkpoint, VerifyResult } from './types';
import { normalizePassage } from './fragments';

export interface TextIndexEntry {
  node: Text;
  offset: number;
}

export interface TextIndex {
  text: string;
  map: TextIndexEntry[];
}

const SKIP_TAGS = new Set([
  'SCRIPT', 'STYLE', 'NOSCRIPT', 'TEMPLATE', 'TEXTAREA', 'SELECT', 'OPTION', 'HEAD', 'TITLE', 'SVG', 'CANVAS',
]);

const BLOCK_TAGS = new Set([
  'ADDRESS', 'ARTICLE', 'ASIDE', 'BLOCKQUOTE', 'DD', 'DIV', 'DL', 'DT', 'FIELDSET', 'FIGCAPTION', 'FIGURE',
  'FOOTER', 'FORM', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'HEADER', 'HR', 'LI', 'MAIN', 'NAV', 'OL', 'P', 'PRE',
  'SECTION', 'TABLE', 'TBODY', 'TD', 'TH', 'TR', 'UL',
]);

/**
 * Builds a normalized text index with a per-character map back to DOM text
 * nodes, so a passage that spans elements can still be matched and ranged.
 * Hidden and non-content nodes (script, style, inputs) are skipped.
 */
export function buildTextIndex(root: Document | Element): TextIndex {
  const doc = root.nodeType === 9 ? (root as Document) : (root as Element).ownerDocument;
  const map: TextIndexEntry[] = [];
  let text = '';
  if (!doc) return { text, map };
  const walker = doc.createTreeWalker(root as Node, NodeFilter.SHOW_TEXT, {
    acceptNode(node: Node) {
      const parent = (node as Text).parentElement;
      if (!parent) return NodeFilter.FILTER_REJECT;
      if (SKIP_TAGS.has(parent.tagName.toUpperCase())) return NodeFilter.FILTER_REJECT;
      if (!(node as Text).data.trim()) return NodeFilter.FILTER_REJECT;
      const view = doc.defaultView;
      const style = view?.getComputedStyle(parent);
      if (style && (style.display === 'none' || style.visibility === 'hidden')) return NodeFilter.FILTER_REJECT;
      // Do not reject on getClientRects(): a freshly opened background tab can
      // report zero rects before its first paint, which would make every
      // restore look unverifiable. The viewport check below still requires the
      // matched range to be genuinely visible.
      return NodeFilter.FILTER_ACCEPT;
    },
  });

  let previousParent: Element | null = null;
  let node: Node | null;
  while ((node = walker.nextNode())) {
    const tn = node as Text;
    const parent = tn.parentElement;
    if (!parent) continue;
    const isBlock = BLOCK_TAGS.has(parent.tagName.toUpperCase());
    if (text.length > 0 && !text.endsWith(' ') && (isBlock || previousParent !== parent)) {
      text += ' ';
      map.push({ node: tn, offset: 0 });
    }
    const data = tn.data;
    for (let i = 0; i < data.length; i++) {
      const ch = data[i];
      if (/\s/.test(ch)) {
        if (text.length === 0 || text.endsWith(' ')) continue;
        text += ' ';
        map.push({ node: tn, offset: i });
      } else {
        text += ch.toLowerCase();
        map.push({ node: tn, offset: i });
      }
    }
    previousParent = parent;
  }
  return { text, map };
}

function rangeFor(index: TextIndex, start: number, end: number): Range | null {
  const first = index.map[start];
  const last = index.map[end - 1];
  if (!first || !last) return null;
  try {
    const range = first.node.ownerDocument.createRange();
    range.setStart(first.node, first.offset);
    range.setEnd(last.node, last.offset + 1);
    return range;
  } catch {
    return null;
  }
}

export interface VerifyOnce {
  match: boolean;
  inViewport: boolean;
  reason: VerifyResult['reason'];
  candidates: number;
  rect?: { top: number; bottom: number; left: number; right: number };
  matchedText?: string;
  range?: Range;
}

export function isRectInViewport(rect: DOMRect, view: Window): boolean {
  return (
    rect.height > 0 &&
    rect.bottom > 0 &&
    rect.top < view.innerHeight &&
    rect.right > 0 &&
    rect.left < view.innerWidth
  );
}

/**
 * Finds every occurrence of the anchor, rejects those whose preceding and
 * following text do not match the checkpoint, then requires the surviving
 * passage to be inside the visible viewport. This is what stops the answer-key
 * twin from being accepted.
 */
export function verifyCheckpointOnce(doc: Document, checkpoint: Pick<Checkpoint, 'anchor' | 'prefix' | 'suffix'>): VerifyOnce {
  const view = doc.defaultView;
  const base: VerifyOnce = { match: false, inViewport: false, reason: 'unreadable', candidates: 0 };
  if (!view) return base;
  const anchor = normalizePassage(checkpoint.anchor).toLowerCase();
  const prefix = normalizePassage(checkpoint.prefix).toLowerCase();
  const suffix = normalizePassage(checkpoint.suffix).toLowerCase();
  if (!anchor) return { ...base, reason: 'no-match' };

  const index = buildTextIndex(doc);
  let from = 0;
  let candidates = 0;
  let fallback: { range: Range; rect: DOMRect } | null = null;
  let contextMismatches = 0;

  while (true) {
    const start = index.text.indexOf(anchor, from);
    if (start === -1) break;
    from = start + 1;
    candidates++;
    const end = start + anchor.length;

    if (prefix) {
      // The captured prefix is trimmed, so an exact-length slice can lose its
      // first character to the boundary space. Take a margin and compare the
      // tail, which keeps whitespace normalization from breaking verification.
      const before = index.text.slice(Math.max(0, start - prefix.length - 8), start).trim();
      if (!before.endsWith(prefix)) {
        contextMismatches++;
        continue;
      }
    }
    if (suffix) {
      const after = index.text.slice(end, end + suffix.length + 8).trim();
      if (!after.startsWith(suffix)) {
        contextMismatches++;
        continue;
      }
    }

    const range = rangeFor(index, start, end);
    if (!range) {
      contextMismatches++;
      continue;
    }
    const rect = range.getBoundingClientRect();
    if (!fallback) fallback = { range, rect };
    if (isRectInViewport(rect, view)) {
      return {
        match: true,
        inViewport: true,
        reason: 'ok',
        candidates,
        matchedText: index.text.slice(start, end),
        range,
        rect: { top: rect.top, bottom: rect.bottom, left: rect.left, right: rect.right },
      };
    }
  }

  if (fallback) {
    return {
      match: true,
      inViewport: false,
      reason: 'not-in-viewport',
      candidates,
      matchedText: anchor,
      range: fallback.range,
      rect: { top: fallback.rect.top, bottom: fallback.rect.bottom, left: fallback.rect.left, right: fallback.rect.right },
    };
  }
  return {
    match: false,
    inViewport: false,
    reason: candidates > 0 || contextMismatches > 0 ? 'context-mismatch' : 'no-match',
    candidates,
  };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Retries while Chrome performs the fragment scroll, then scrolls the matched
 * range itself once before giving up. A restore is only "ok" when the passage
 * is genuinely visible; otherwise the caller must show "Saved context only".
 */
export async function verifyCheckpointAsync(
  doc: Document,
  checkpoint: Pick<Checkpoint, 'anchor' | 'prefix' | 'suffix'>,
  options: { attempts?: number; retryMs?: number; scrollAfter?: number } = {},
): Promise<VerifyResult> {
  const attempts = options.attempts ?? 12;
  const retryMs = options.retryMs ?? 250;
  const scrollAfter = options.scrollAfter ?? 2;
  let last: VerifyOnce = { match: false, inViewport: false, reason: 'unreadable', candidates: 0 };

  for (let attempt = 1; attempt <= attempts; attempt++) {
    if (!doc.defaultView) {
      return { ok: false, reason: 'unreadable', candidates: 0, attempts: attempt };
    }
    last = verifyCheckpointOnce(doc, checkpoint);
    if (last.match && last.inViewport) {
      return {
        ok: true,
        reason: 'ok',
        candidates: last.candidates,
        rect: last.rect,
        matchedText: last.matchedText,
        attempts: attempt,
      };
    }
    if (attempt > scrollAfter && last.range) {
      try {
        const parent = last.range.startContainer.parentElement;
        parent?.scrollIntoView({ block: 'center', inline: 'nearest', behavior: 'auto' });
      } catch {
        /* detached node */
      }
    }
    await sleep(retryMs);
  }

  return {
    ok: false,
    reason: last.reason === 'ok' ? 'not-in-viewport' : last.reason,
    candidates: last.candidates,
    rect: last.rect,
    matchedText: last.matchedText,
    attempts,
  };
}
