import type { Checkpoint } from './types';
import { CHECKPOINT_SCHEMA_VERSION } from './types';
import { normalizePassage } from './fragments';
import { buildTextIndex } from './verify';

export function newId(prefix = 'id'): string {
  const c = globalThis.crypto as Crypto | undefined;
  if (c && 'randomUUID' in c) return `${prefix}_${c.randomUUID()}`;
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
}

export function slugify(text: string): string {
  return normalizePassage(text)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48) || 'spot';
}

export interface CaptureOptions {
  goal?: string;
  /** Use the selection text rather than the element's whole text. */
  anchorText?: string;
  problemId?: string;
  savedFrame?: string;
  answerRegion?: string;
}

/**
 * Captures the passage represented by a DOM element. The prefix/suffix are the
 * 30 normalized characters on either side of the passage in document order.
 */
export function captureCheckpointFromElement(
  doc: Document,
  element: Element,
  options: CaptureOptions = {},
): Checkpoint | null {
  const view = doc.defaultView;
  if (!view) return null;
  const anchorElement = element.matches('h1,h2,h3,h4,h5,h6,p,li,td,label')
    ? element
    : (element.querySelector('h1,h2,h3,h4,h5,h6,[data-anchor-text]') ?? element);
  const anchorText = normalizePassage(options.anchorText ?? anchorElement.textContent ?? '');
  if (!anchorText) return null;
  const anchor = anchorText.length > 140 ? anchorText.slice(0, 140).replace(/\s+\S*$/, '') : anchorText;
  const normalizedAnchor = anchor.toLowerCase();

  const index = buildTextIndex(doc);
  let start = -1;
  let from = 0;
  while (true) {
    const found = index.text.indexOf(normalizedAnchor, from);
    if (found === -1) break;
    const entry = index.map[found];
    if (entry && element.contains(entry.node)) {
      start = found;
      break;
    }
    from = found + 1;
  }
  if (start === -1) start = index.text.indexOf(normalizedAnchor);
  if (start === -1) return null;
  const end = start + normalizedAnchor.length;

  // Word-aligned context reads better in the saved-context UI and in the
  // fragment URL than a raw 34-character slice that starts mid-word.
  const beforeWindowStart = Math.max(0, start - 52);
  let contextBefore = index.text.slice(beforeWindowStart, start).trim();
  const firstSpace = contextBefore.indexOf(' ');
  if (beforeWindowStart > 0 && firstSpace !== -1) contextBefore = contextBefore.slice(firstSpace + 1);
  const afterWindowEnd = Math.min(index.text.length, end + 52);
  let contextAfter = index.text.slice(end, afterWindowEnd).trim();
  const lastSpace = contextAfter.lastIndexOf(' ');
  if (afterWindowEnd < index.text.length && lastSpace !== -1) contextAfter = contextAfter.slice(0, lastSpace);
  const problemHost = element.closest('[data-problem-id]') as HTMLElement | null;
  const problemId =
    options.problemId ??
    problemHost?.dataset.problemId ??
    slugify(anchor).split('-').slice(0, 3).join('-');

  return {
    schemaVersion: CHECKPOINT_SCHEMA_VERSION,
    id: newId('cp'),
    createdAt: Date.now(),
    goal: options.goal ?? '',
    url: view.location.href.split('#')[0],
    docId: `${view.location.origin}${view.location.pathname}`,
    problemId,
    anchor,
    prefix: contextBefore,
    suffix: contextAfter,
    title: doc.title || view.location.hostname,
    selectorHint: problemHost ? `[data-problem-id="${problemHost.dataset.problemId}"]` : undefined,
    savedFrame: options.savedFrame,
    answerRegion: options.answerRegion,
  };
}

/**
 * Picks a sensible anchor for manual capture: the current selection's closest
 * heading/paragraph, else the heading nearest the middle of the viewport.
 */
export function pickAnchorElement(doc: Document): Element | null {
  const selection = doc.getSelection();
  if (selection && !selection.isCollapsed && selection.rangeCount > 0) {
    const node = selection.getRangeAt(0).startContainer;
    const el = node.nodeType === Node.ELEMENT_NODE ? (node as Element) : node.parentElement;
    const meaningful = el?.closest('h1,h2,h3,h4,h5,h6,p,li,td,label,[data-problem-id]');
    if (meaningful) return meaningful;
    if (el) return el;
  }
  const view = doc.defaultView;
  const vh = view?.innerHeight ?? 800;
  const candidates = Array.from(doc.querySelectorAll('h1,h2,h3,h4,h5,h6,[data-problem-id]')) as HTMLElement[];
  let best: HTMLElement | null = null;
  let bestDistance = Infinity;
  for (const el of candidates) {
    const rect = el.getBoundingClientRect();
    if (rect.height <= 0 || rect.bottom <= 0 || rect.top >= vh) continue;
    const distance = Math.abs(rect.top + rect.height / 2 - vh / 2);
    if (distance < bestDistance) {
      best = el;
      bestDistance = distance;
    }
  }
  return best;
}

/**
 * The answer region is the nearest containing section/form after the anchor.
 * Falls back to the anchor's parent element when the page has no sections.
 */
export function findAnswerRegion(doc: Document, element: Element, maxDepth = 6): Element {
  let current: Element | null = element;
  for (let depth = 0; depth < maxDepth && current; depth++) {
    if (current.matches('section,form,fieldset,[data-answer-region]')) return current;
    current = current.parentElement;
  }
  return element.parentElement ?? element;
}
