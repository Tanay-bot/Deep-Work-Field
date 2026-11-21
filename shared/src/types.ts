import type { Mode } from './config';

export type FocusState = 'FOCUSED' | 'DRIFTING' | 'WRITING' | 'UNCERTAIN';

/** Schema version for anything persisted in IndexedDB or chrome.storage. */
export const CHECKPOINT_SCHEMA_VERSION = 1;

export interface Checkpoint {
  schemaVersion: number;
  id: string;
  createdAt: number;
  goal: string;
  /** URL with the hash removed. */
  url: string;
  /** Canvas/document identity, e.g. origin + pathname. */
  docId: string;
  /** Problem identifier such as "4b" when one can be derived. */
  problemId: string;
  /** Exact anchor passage as it appears in the page. */
  anchor: string;
  prefix: string;
  suffix: string;
  title: string;
  /** Optional data attribute of the captured element. */
  selectorHint?: string;
  /** Last on-task frame as a data URL (extension capture). */
  savedFrame?: string;
  /** The answer region text that qualified at capture time, if any. */
  answerRegion?: string;
}

export interface FaceCue {
  present: boolean;
  headDown: boolean;
  eyesClosed: boolean;
  /** Pitch in degrees, positive = looking down. */
  pitchDeg?: number;
}

export interface SignalInput {
  t: number;
  /** Screen text used for the goal matcher (DOM text or OCR fallback). */
  screenText: string;
  /** Cosine similarity between screen text and the session goal. */
  onTaskSimilarity: number;
  /** Embedding of screenText, used for correction memory lookup. */
  embedding: number[];
  face: FaceCue | null;
  source: 'dom' | 'ocr' | 'scripted' | 'none';
}

export interface Correction {
  id: string;
  goal: string;
  createdAt: number;
  label: 'on-task' | 'drift';
  embedding: number[];
  /** Short excerpt of the moment, shown in the UI. */
  excerpt: string;
  traceId?: string;
}

export interface CorrectionVote {
  neighbors: number;
  onTask: number;
  drift: number;
  decision: 'on-task' | 'drift' | 'split' | 'none';
  threshold: number;
  weightedOnTask: number;
  weightedDrift: number;
}

export interface VoteCounts {
  drift: number;
  onTask: number;
  uncertain: number;
}

export interface TraceEntry {
  id: string;
  sessionId: string;
  t: number;
  state: FocusState;
  inputs: {
    mode: Mode;
    screenText: string;
    onTaskSimilarity: number;
    smoothedSimilarity: number;
    face: FaceCue | null;
    source: SignalInput['source'];
  };
  votes: VoteCounts;
  reasons: string[];
  distractionLogged: boolean;
  nudge: boolean;
  correction?: CorrectionVote;
}

export interface SessionRecord {
  id: string;
  goal: string;
  mode: Mode;
  startedAt: number;
  endedAt?: number;
  checkpointId?: string;
  thresholdsFrozen: boolean;
}

export interface StudyEvent {
  id: string;
  sessionId: string;
  t: number;
  type: 'session-start' | 'mode' | 'state' | 'drift' | 'nudge' | 'first-edit' | 'resume' | 'restore-failed' | 'correction' | 'session-end';
  detail: string;
  state?: FocusState;
}

export interface VerifyResult {
  ok: boolean;
  reason: 'ok' | 'no-match' | 'context-mismatch' | 'not-in-viewport' | 'unreadable' | 'ambiguous';
  candidates: number;
  /** Occurrences whose anchor, prefix and suffix all matched. Exactly one is required for ok. */
  contextMatches?: number;
  /** How the passage reached the viewport: Chrome's fragment scroll / page itself, or our one DOM scroll. */
  landing?: 'native' | 'dom-scroll';
  /** Local only (not serializable): the verified range, for scoping edit tracking. */
  range?: Range;
  rect?: { top: number; bottom: number; left: number; right: number };
  matchedText?: string;
  attempts: number;
}
