import type { TraceEntry } from './types';

export interface HourStat {
  hour: number;
  samples: number;
  /** Share of decided samples (not UNCERTAIN) that were FOCUSED or WRITING. */
  focus: number;
}

export interface PlannerResult {
  hours: HourStat[];
  suggestions: HourStat[];
  totalSamples: number;
}

/**
 * Focus-by-hour curve across saved sessions. Only real signals count
 * (live DOM/OCR); the scripted demo never feeds the planner. An hour needs
 * `minSamples` decided samples before it can be suggested.
 */
export function focusByHour(entries: Pick<TraceEntry, 't' | 'state' | 'inputs'>[], minSamples = 60): PlannerResult {
  const bins = Array.from({ length: 24 }, (_, hour) => ({ hour, on: 0, decided: 0, samples: 0 }));
  let total = 0;
  for (const e of entries) {
    if (e.inputs?.source === 'scripted' || e.inputs?.source === 'none') continue;
    const bin = bins[new Date(e.t).getHours()];
    bin.samples++;
    total++;
    if (e.state === 'UNCERTAIN') continue;
    bin.decided++;
    if (e.state === 'FOCUSED' || e.state === 'WRITING') bin.on++;
  }
  const hours = bins.map((b) => ({ hour: b.hour, samples: b.samples, focus: b.decided ? b.on / b.decided : 0 }));
  const suggestions = hours
    .filter((h) => bins[h.hour].decided >= minSamples)
    .sort((a, b) => b.focus - a.focus)
    .slice(0, 2);
  return { hours, suggestions, totalSamples: total };
}
