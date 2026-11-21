import type { Checkpoint, VerifyResult } from './types';
import { foldCase, normalizePassage } from './fragments';

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
 *
 * - A separator space is inserted only where a *block* boundary is crossed,
 *   so a word split across inline markup ("lim<b>iting</b>") stays one word.
 * - Whitespace-only nodes still count as whitespace between inline elements.
 * - Hidden ancestors (display:none, visibility:hidden) are skipped, not just
 *   the immediate parent.
 * - Case folding never changes length, so every index maps to one DOM char.
 */
export function buildTextIndex(root: Document | Element): TextIndex {
  const doc = root.nodeType === 9 ? (root as Document) : (root as Element).ownerDocument;
  const map: TextIndexEntry[] = [];
  let text = '';
  if (!doc) return { text, map };
  const view = doc.defaultView;
  const blockCache = new Map<Element, Element>();
  const hiddenCache = new Map<Element, boolean>();

  const isHidden = (el: Element): boolean => {
    const cached = hiddenCache.get(el);
    if (cached !== undefined) return cached;
    let hidden = false;
    const style = view?.getComputedStyle(el);
    if (style && (style.display === 'none' || style.visibility === 'hidden')) hidden = true;
    else if (el.parentElement) hidden = isHidden(el.parentElement);
    hiddenCache.set(el, hidden);
    return hidden;
  };
  const blockOf = (el: Element): Element => {
    const cached = blockCache.get(el);
    if (cached) return cached;
    let current: Element = el;
    while (current.parentElement) {
      const display = view?.getComputedStyle(current).display ?? '';
      const inline = display ? display.startsWith('inline') || display === 'contents' : !BLOCK_TAGS.has(current.tagName.toUpperCase());
      if (!inline) break;
      current = current.parentElement;
    }
    blockCache.set(el, current);
    return current;
  };

  const walker = doc.createTreeWalker(root as Node, NodeFilter.SHOW_TEXT, {
    acceptNode(node: Node) {
      const parent = (node as Text).parentElement;
      if (!parent) return NodeFilter.FILTER_REJECT;
      if (parent.closest('script,style,noscript,template,textarea,select,option,head,title,svg,canvas')) return NodeFilter.FILTER_REJECT;
      // Do not reject on getClientRects(): a freshly opened background tab can
      // report zero rects before its first paint. The viewport check below
      // still requires the matched range to be genuinely visible.
      if (isHidden(parent)) return NodeFilter.FILTER_REJECT;
      return NodeFilter.FILTER_ACCEPT;
    },
  });

  let previousBlock: Element | null = null;
  let node: Node | null;
  while ((node = walker.nextNode())) {
    const tn = node as Text;
    const parent = tn.parentElement;
    if (!parent) continue;
    const block = blockOf(parent);
    if (text.length > 0 && !text.endsWith(' ') && previousBlock !== null && block !== previousBlock) {
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
        const lower = ch.toLowerCase();
        text += lower.length === 1 ? lower : ch;
        map.push({ node: tn, offset: i });
      }
    }
    if (data.trim()) previousBlock = block;
  }
  return { text, map };
}

export function rangeFor(index: TextIndex, start: number, end: number): Range | null {
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
  contextMatches: number;
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

/** Every client rect of the range must be visible, not just its bounding box. */
function rangeVisible(range: Range, view: Window): boolean {
  const rects = Array.from(range.getClientRects()).filter((r) => r.width > 0 && r.height > 0);
  if (rects.length === 0) return false;
  if (!rects.every((r) => isRectInViewport(r, view))) return false;
  // Clipped by a scrolling ancestor? Check the first rect's centre hits the passage.
  const r = rects[0];
  const hit = view.document.elementFromPoint?.(r.left + Math.min(r.width / 2, 20), r.top + r.height / 2);
  const host = range.startContainer.parentElement;
  return !hit || !host || hit === host || host.contains(hit) || hit.contains(host);
}

type VerifyTarget = Pick<Checkpoint, 'anchor' | 'prefix' | 'suffix'> & Partial<Pick<Checkpoint, 'selectorHint'>>;

/**
 * Collects *every* occurrence whose anchor, prefix and suffix all match before
 * deciding anything. If more than one survives, a stable structural hint (the
 * problem container saved at capture) may break the tie; viewport position
 * never does. Still tied → 'ambiguous', which callers must treat as a failure.
 */
export function verifyCheckpointOnce(doc: Document, checkpoint: VerifyTarget): VerifyOnce {
  const view = doc.defaultView;
  const base: VerifyOnce = { match: false, inViewport: false, reason: 'unreadable', candidates: 0, contextMatches: 0 };
  if (!view) return base;
  const anchor = foldCase(normalizePassage(checkpoint.anchor));
  const prefix = foldCase(normalizePassage(checkpoint.prefix));
  const suffix = foldCase(normalizePassage(checkpoint.suffix));
  if (!anchor) return { ...base, reason: 'no-match' };

  const index = buildTextIndex(doc);
  let from = 0;
  let candidates = 0;
  let survivors: { start: number; end: number; range: Range }[] = [];

  while (true) {
    const start = index.text.indexOf(anchor, from);
    if (start === -1) break;
    from = start + 1;
    candidates++;
    const end = start + anchor.length;
    if (prefix) {
      // The captured prefix is trimmed, so take a margin and compare the tail.
      const before = index.text.slice(Math.max(0, start - prefix.length - 8), start).trim();
      if (!before.endsWith(prefix)) continue;
    }
    if (suffix) {
      const after = index.text.slice(end, end + suffix.length + 8).trim();
      if (!after.startsWith(suffix)) continue;
    }
    const range = rangeFor(index, start, end);
    if (range) survivors.push({ start, end, range });
  }

  if (survivors.length > 1 && checkpoint.selectorHint) {
    let scoped: typeof survivors = [];
    try {
      scoped = survivors.filter((s) => !!s.range.startContainer.parentElement?.closest(checkpoint.selectorHint!));
    } catch {
      scoped = [];
    }
    if (scoped.length >= 1) survivors = scoped;
  }

  const contextMatches = survivors.length;
  if (contextMatches === 0) {
    return { ...base, reason: candidates > 0 ? 'context-mismatch' : 'no-match', candidates };
  }
  if (contextMatches > 1) {
    return { ...base, reason: 'ambiguous', candidates, contextMatches };
  }
  const only = survivors[0];
  const rect = only.range.getBoundingClientRect();
  const visible = rangeVisible(only.range, view);
  return {
    match: true,
    inViewport: visible,
    reason: visible ? 'ok' : 'not-in-viewport',
    candidates,
    contextMatches,
    matchedText: index.text.slice(only.start, only.end),
    range: only.range,
    rect: { top: rect.top, bottom: rect.bottom, left: rect.left, right: rect.right },
  };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Waits for Chrome's fragment scroll (or the page) to land the passage, then
 * scrolls the unique match itself at most ONCE. The result records which of
 * the two produced the landing, so a broken native fragment is not hidden.
 * Ambiguity ends the attempt once the document has finished loading.
 */
export async function verifyCheckpointAsync(
  doc: Document,
  checkpoint: VerifyTarget,
  options: { attempts?: number; retryMs?: number; scrollAfter?: number } = {},
): Promise<VerifyResult> {
  const attempts = options.attempts ?? 12;
  const retryMs = options.retryMs ?? 250;
  const scrollAfter = options.scrollAfter ?? 2;
  let last: VerifyOnce = { match: false, inViewport: false, reason: 'unreadable', candidates: 0, contextMatches: 0 };
  let scrolled = false;

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
        contextMatches: last.contextMatches,
        landing: scrolled ? 'dom-scroll' : 'native',
        rect: last.rect,
        matchedText: last.matchedText,
        range: last.range,
        attempts: attempt,
      };
    }
    if (last.reason === 'ambiguous' && doc.readyState === 'complete') break;
    if (!scrolled && attempt > scrollAfter && last.match && last.range) {
      scrolled = true;
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
    contextMatches: last.contextMatches,
    rect: last.rect,
    matchedText: last.matchedText,
    attempts,
  };
}
