import type { Correction, CorrectionVote } from './types';
import { cosine, EMBEDDING_VERSION } from './embed';

export interface Neighbor {
  correction: Correction;
  distance: number;
}

export function nearestCorrections(
  corrections: Correction[],
  embedding: number[],
  goal: string,
  k: number,
  maxDistance: number,
): Neighbor[] {
  // One vote per source moment: repeated corrections of the same trace entry
  // count once (latest wins). Lab corrections are explicit simulations and
  // keep their own ids. Corrections from another embedder version are ignored.
  const latest = new Map<string, Correction>();
  for (const c of corrections) {
    if (c.goal !== goal || (c.featureVersion ?? 1) !== EMBEDDING_VERSION) continue;
    const key = c.lab ? c.id : (c.traceId ?? c.id);
    const prev = latest.get(key);
    if (!prev || c.createdAt >= prev.createdAt) latest.set(key, c);
  }
  return [...latest.values()]
    .map((c) => ({ correction: c, distance: 1 - cosine(embedding, c.embedding) }))
    .filter((n) => Number.isFinite(n.distance) && n.distance <= maxDistance)
    .sort((a, b) => a.distance - b.distance)
    .slice(0, k);
}

/**
 * 4 of 5 same-label neighbors override; a 3–2 split forces UNCERTAIN. The
 * decision uses raw counts; the distance-weighted totals are diagnostic only.
 */
export function correctionVote(
  corrections: Correction[],
  embedding: number[],
  goal: string,
  k: number,
  maxDistance: number,
  supermajority: number,
): CorrectionVote {
  const neighbors = nearestCorrections(corrections, embedding, goal, k, maxDistance);
  const onTask = neighbors.filter((n) => n.correction.label === 'on-task').length;
  const drift = neighbors.filter((n) => n.correction.label === 'drift').length;
  let weightedOnTask = 0;
  let weightedDrift = 0;
  for (const n of neighbors) {
    const weight = 1 / (n.distance + 0.05);
    if (n.correction.label === 'on-task') weightedOnTask += weight;
    else weightedDrift += weight;
  }
  let decision: CorrectionVote['decision'] = 'none';
  if (neighbors.length === k) {
    if (onTask >= supermajority) decision = 'on-task';
    else if (drift >= supermajority) decision = 'drift';
    else decision = 'split';
  }
  return {
    neighbors: neighbors.length,
    onTask,
    drift,
    decision,
    threshold: maxDistance,
    weightedOnTask: Number(weightedOnTask.toFixed(3)),
    weightedDrift: Number(weightedDrift.toFixed(3)),
  };
}
