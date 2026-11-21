import { contentTerms } from './embed';
import type { Checkpoint } from './types';

/** What the extension reports about the active tab, once a second while a session listens. */
export interface ScreenSample {
  url: string;
  title: string;
  /** Text currently inside the viewport (empty for pages the extension cannot read). */
  text: string;
  /** True for chrome://, the Web Store, PDFs in Chrome's viewer, etc. */
  restricted: boolean;
  t: number;
}

export interface ScreenMatch {
  sim: number;
  matched: string[];
  total: number;
  reason: string;
}

/**
 * Real-screen goal matcher. Coverage of the goal's content terms in the tab's
 * title + visible text, so a long page is not diluted the way a whole-text
 * cosine is. The saved checkpoint is explicit context: being on the very page
 * the student saved counts as on-task evidence on its own.
 */
export function matchScreen(goal: string, sample: ScreenSample, checkpoint?: Pick<Checkpoint, 'docId' | 'anchor'> | null): ScreenMatch {
  const goalTerms = [...new Set(contentTerms(goal))];
  const screenTerms = new Set(contentTerms(`${sample.title} ${sample.text}`));
  const matched = goalTerms.filter((term) => screenTerms.has(term) || [...screenTerms].some((s) => s.length > 4 && term.length > 4 && (s.startsWith(term) || term.startsWith(s))));
  const coverage = goalTerms.length ? matched.length / goalTerms.length : 0;
  let sim = coverage;
  let reason = `${matched.length}/${goalTerms.length} goal terms on screen${matched.length ? ` (${matched.slice(0, 4).join(', ')})` : ''}`;
  let sameDoc = false;
  try {
    const here = new URL(sample.url);
    sameDoc = !!checkpoint?.docId && `${here.origin}${here.pathname}` === checkpoint.docId;
  } catch {
    sameDoc = false;
  }
  if (sameDoc) {
    sim = Math.max(sim, 0.8);
    reason += '; this is the page you saved';
  }
  if (sample.restricted) reason += '; page text unreadable, title only';
  return { sim: Number(sim.toFixed(3)), matched, total: goalTerms.length, reason };
}
