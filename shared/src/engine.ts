import type { Mode } from './config';
import type { Correction, CorrectionVote, FaceCue, FocusState, SignalInput, VoteCounts } from './types';
import { correctionVote } from './knn';
import type { Thresholds } from './config';

export interface EngineDecision {
  state: FocusState;
  votes: VoteCounts;
  reasons: string[];
  smoothedSimilarity: number;
  distractionLogged: boolean;
  nudge: boolean;
  correction: CorrectionVote | null;
}

interface Sample {
  t: number;
  sim: number;
}

export interface EngineOptions {
  mode: Mode;
  goal: string;
  thresholds: Thresholds;
  corrections: Correction[];
}

/**
 * Rules, in order:
 *  - resume-only never detects: no state changes, no nudges.
 *  - screen-only uses the smoothed goal similarity alone.
 *  - full fusion combines screen and face evidence. On-task screen + head down
 *    is WRITING (never a distraction). Contradictory evidence is UNCERTAIN.
 *  - UNCERTAIN never nudges. A distraction is only logged after DRIFTING has
 *    held for the configured hold (3 s).
 *  - Corrections override only on a k-neighbour supermajority; 3–2 => UNCERTAIN.
 */
export class FocusEngine {
  private history: Sample[] = [];
  private driftSince: number | null = null;
  private lastNudgeAt = -Infinity;
  private loggedThisEpisode = false;
  private runStartedAt = -Infinity;
  private correction: CorrectionVote | null = null;
  private options: EngineOptions;

  constructor(options: EngineOptions) {
    this.options = options;
  }

  updateOptions(options: Partial<EngineOptions>): void {
    this.options = { ...this.options, ...options };
  }

  resetRun(t: number): void {
    this.runStartedAt = t;
    this.driftSince = null;
    this.loggedThisEpisode = false;
  }

  update(input: SignalInput): EngineDecision {
    const { thresholds, mode } = this.options;
    this.history.push({ t: input.t, sim: input.onTaskSimilarity });
    const cutoff = input.t - thresholds.smoothingWindowMs;
    this.history = this.history.filter((s) => s.t >= cutoff);
    const smoothed =
      this.history.reduce((sum, s) => sum + s.sim, 0) / Math.max(1, this.history.length);

    const reasons: string[] = [];
    const votes: VoteCounts = { drift: 0, onTask: 0, uncertain: 0 };
    let state: FocusState = 'UNCERTAIN';
    let correction: CorrectionVote | null = null;

    if (mode === 'resume-only') {
      votes.onTask = 1;
      state = 'FOCUSED';
      reasons.push('Resume-only mode: detection is off.');
    } else if (mode === 'screen-only') {
      if (smoothed >= thresholds.onTaskSimilarity) {
        state = 'FOCUSED';
        votes.onTask = 1;
        reasons.push(`Screen similarity ${smoothed.toFixed(2)} >= on-task ${thresholds.onTaskSimilarity.toFixed(2)}.`);
      } else if (smoothed <= thresholds.offTaskSimilarity) {
        state = 'DRIFTING';
        votes.drift = 1;
        reasons.push(`Screen similarity ${smoothed.toFixed(2)} <= off-task ${thresholds.offTaskSimilarity.toFixed(2)}.`);
      } else {
        state = 'UNCERTAIN';
        votes.uncertain = 1;
        reasons.push(`Screen similarity ${smoothed.toFixed(2)} is between thresholds; abstaining.`);
      }
    } else {
      const screenOn = smoothed >= thresholds.onTaskSimilarity;
      const screenOff = smoothed <= thresholds.offTaskSimilarity;
      const face = input.face;

      if (!face || !face.present) {
        state = 'UNCERTAIN';
        votes.uncertain = 1;
        reasons.push('No face signal in full-fusion mode; abstaining instead of guessing.');
      } else if (face.eyesClosed) {
        state = 'UNCERTAIN';
        votes.uncertain = 1;
        reasons.push('Eyes closed: presence is ambiguous; abstaining.');
      } else if (screenOn && face.headDown) {
        state = 'WRITING';
        votes.onTask = 1;
        reasons.push('On-task screen + head down: writing, not drifting.');
      } else if (screenOn && !face.headDown) {
        state = 'FOCUSED';
        votes.onTask = 1;
        reasons.push(`On-task screen (${smoothed.toFixed(2)}) and head up.`);
      } else if (screenOff && !face.headDown) {
        state = 'DRIFTING';
        votes.drift = 1;
        reasons.push(`Off-task screen (${smoothed.toFixed(2)}) and head up.`);
      } else if (screenOff && face.headDown) {
        state = 'UNCERTAIN';
        votes.uncertain = 1;
        reasons.push('Off-task screen but head down: signals conflict (writing on paper?); abstaining.');
      } else {
        state = 'UNCERTAIN';
        votes.uncertain = 1;
        reasons.push('Screen similarity in the dead zone: abstaining.');
      }

      if (face?.pitchDeg !== undefined) {
        reasons.push(`Face pitch ${face.pitchDeg.toFixed(1)}° (head-down threshold ${thresholds.headDownPitchDeg}°).`);
      }
    }

    // Correction memory can override a provisional call, but only when there
    // are enough qualifying neighbours and the vote is decisive.
    if (mode !== 'resume-only' && this.options.corrections.length > 0) {
      correction = correctionVote(
        this.options.corrections,
        input.embedding,
        this.options.goal,
        thresholds.correctionK,
        thresholds.correctionMaxDistance,
        thresholds.correctionSupermajority,
      );
      if (correction.decision === 'on-task') {
        state = input.face?.present && input.face.headDown && mode === 'full' ? 'WRITING' : 'FOCUSED';
        reasons.push(`Correction memory override: ${correction.onTask}/${correction.neighbors} similar moments were marked on-task.`);
      } else if (correction.decision === 'drift') {
        state = 'DRIFTING';
        reasons.push(`Correction memory override: ${correction.drift}/${correction.neighbors} similar moments were marked drift.`);
      } else if (correction.decision === 'split') {
        state = 'UNCERTAIN';
        reasons.push(`Correction memory is split ${correction.onTask}–${correction.drift}; treating the call as UNCERTAIN.`);
      } else if (correction.neighbors > 0) {
        reasons.push(`Correction memory has ${correction.neighbors}/${thresholds.correctionK} qualifying neighbours; no override.`);
      }
    }

    // Drift timing: a distraction is only logged (and a nudge only allowed)
    // once DRIFTING has held for the full hold window.
    if (state === 'DRIFTING') {
      if (this.driftSince === null || this.driftSince < this.runStartedAt) this.driftSince = input.t;
    } else {
      this.driftSince = null;
      this.loggedThisEpisode = false;
    }
    const heldMs = this.driftSince === null ? 0 : input.t - this.driftSince;
    const held = state === 'DRIFTING' && heldMs >= thresholds.driftHoldMs;
    let distractionLogged = false;
    if (held && !this.loggedThisEpisode) {
      distractionLogged = true;
      this.loggedThisEpisode = true;
    }
    const nudge =
      held &&
      mode !== 'resume-only' &&
      state === 'DRIFTING' &&
      input.t - this.lastNudgeAt >= thresholds.nudgeCooldownMs;
    if (nudge) this.lastNudgeAt = input.t;
    if (state === 'DRIFTING' && !held) {
      reasons.push(`Drift held ${Math.max(0, Math.round(heldMs))} ms of ${thresholds.driftHoldMs} ms; no nudge yet.`);
    }

    this.correction = correction;
    return {
      state,
      votes,
      reasons,
      smoothedSimilarity: Number(smoothed.toFixed(4)),
      distractionLogged,
      nudge,
      correction,
    };
  }

  get lastCorrection(): CorrectionVote | null {
    return this.correction;
  }
}
