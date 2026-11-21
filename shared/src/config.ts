/**
 * Every numeric threshold used by detection, verification, UI and capture.
 * Nothing outside this file may hard-code a threshold. The freeze flag is
 * persisted separately (localStorage / chrome.storage) and blocks edits.
 */
export interface Thresholds {
  sessionTickMs: number;
  smoothingWindowMs: number;
  onTaskSimilarity: number;
  offTaskSimilarity: number;
  driftHoldMs: number;
  nudgeCooldownMs: number;
  correctionK: number;
  correctionMaxDistance: number;
  correctionSupermajority: number;
  minQualifyingChars: number;
  calibrationMs: number;
  headDownPitchDeg: number;
  eyeClosedRatio: number;
  faceLostMs: number;
  galaxyMaxParticles: number;
  galaxyMinParticles: number;
  frameBudgetMs: number;
  verifyAttempts: number;
  verifyRetryMs: number;
  verifyScrollAfter: number;
  ocrMinIntervalMs: number;
  answerRegionMaxDepth: number;
  studyCsvVersion: number;
}

export const DEFAULT_THRESHOLDS: Readonly<Thresholds> = Object.freeze({
  sessionTickMs: 500,
  smoothingWindowMs: 4000,
  onTaskSimilarity: 0.55,
  offTaskSimilarity: 0.38,
  driftHoldMs: 3000,
  nudgeCooldownMs: 45000,
  correctionK: 5,
  correctionMaxDistance: 0.28,
  correctionSupermajority: 4,
  minQualifyingChars: 10,
  calibrationMs: 30000,
  headDownPitchDeg: 18,
  eyeClosedRatio: 0.35,
  faceLostMs: 2500,
  galaxyMaxParticles: 9000,
  galaxyMinParticles: 2200,
  frameBudgetMs: 20,
  verifyAttempts: 12,
  verifyRetryMs: 250,
  verifyScrollAfter: 2,
  ocrMinIntervalMs: 4000,
  answerRegionMaxDepth: 6,
  studyCsvVersion: 1,
});

export const THRESHOLD_META: Record<keyof Thresholds, { label: string; min: number; max: number; step: number }> = {
  sessionTickMs: { label: 'Signal tick (ms)', min: 100, max: 2000, step: 50 },
  smoothingWindowMs: { label: 'Smoothing window (ms)', min: 1000, max: 15000, step: 500 },
  onTaskSimilarity: { label: 'On-task similarity', min: 0.2, max: 0.95, step: 0.01 },
  offTaskSimilarity: { label: 'Off-task similarity', min: 0.05, max: 0.8, step: 0.01 },
  driftHoldMs: { label: 'Drift hold before nudge (ms)', min: 1000, max: 15000, step: 250 },
  nudgeCooldownMs: { label: 'Nudge cooldown (ms)', min: 5000, max: 300000, step: 5000 },
  correctionK: { label: 'Correction neighbors (k)', min: 3, max: 9, step: 1 },
  correctionMaxDistance: { label: 'Correction distance threshold', min: 0.05, max: 0.9, step: 0.01 },
  correctionSupermajority: { label: 'Correction supermajority', min: 3, max: 5, step: 1 },
  minQualifyingChars: { label: 'First qualifying edit (chars)', min: 1, max: 50, step: 1 },
  calibrationMs: { label: 'Calibration (ms)', min: 5000, max: 120000, step: 5000 },
  headDownPitchDeg: { label: 'Head-down pitch (deg)', min: 5, max: 60, step: 1 },
  eyeClosedRatio: { label: 'Eye-closed ratio', min: 0.1, max: 0.9, step: 0.05 },
  faceLostMs: { label: 'Face-lost grace (ms)', min: 500, max: 10000, step: 250 },
  galaxyMaxParticles: { label: 'Galaxy max particles', min: 500, max: 20000, step: 500 },
  galaxyMinParticles: { label: 'Galaxy min particles', min: 200, max: 8000, step: 200 },
  frameBudgetMs: { label: 'Frame budget (ms)', min: 8, max: 40, step: 1 },
  verifyAttempts: { label: 'Restore verification attempts', min: 1, max: 40, step: 1 },
  verifyRetryMs: { label: 'Verification retry (ms)', min: 50, max: 2000, step: 50 },
  verifyScrollAfter: { label: 'Scroll-to-anchor after attempts', min: 0, max: 20, step: 1 },
  ocrMinIntervalMs: { label: 'OCR minimum interval (ms)', min: 1000, max: 20000, step: 500 },
  answerRegionMaxDepth: { label: 'Answer region max DOM depth', min: 2, max: 12, step: 1 },
  studyCsvVersion: { label: 'Study CSV version', min: 1, max: 1, step: 1 },
};

export type Mode = 'resume-only' | 'screen-only' | 'full';

export const MODES: { id: Mode; name: string; blurb: string }[] = [
  {
    id: 'resume-only',
    name: 'Resume-only',
    blurb: 'Checkpoints and verified restore. No detection, no nudges.',
  },
  {
    id: 'screen-only',
    name: 'Screen-only nudges',
    blurb: 'On-device screen text decides focus. No camera.',
  },
  {
    id: 'full',
    name: 'Full fusion',
    blurb: 'Screen text + face cues, correction memory, and verified restore.',
  },
];
