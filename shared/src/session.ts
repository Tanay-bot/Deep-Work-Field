import type { FocusState, VerifyResult } from './types';
import type { Mode } from './config';

/**
 * One vocabulary for restore outcomes, shared by the web app, the extension
 * worker, the popup and the PDF viewer.
 */
export type RestoreStatus = 'none' | 'saved' | 'restoring' | 'verified' | 'ambiguous' | 'saved-context' | 'unavailable' | 'cancelled';

export const RESTORE_LABEL: Record<RestoreStatus, string> = {
  none: 'No place saved yet',
  saved: 'Saved',
  restoring: 'Checking the passage…',
  verified: 'Verified',
  ambiguous: 'Multiple matching passages',
  'saved-context': 'Saved context only',
  unavailable: 'This page needs the Chrome extension',
  cancelled: 'Restore cancelled',
};

/** Maps a verifier result onto the shared vocabulary. */
export function restoreStatusFromResult(result: Pick<VerifyResult, 'ok' | 'reason'>): RestoreStatus {
  if (result.ok) return 'verified';
  if (result.reason === 'ambiguous') return 'ambiguous';
  return 'saved-context';
}

export type SignalSource = 'none' | 'scripted' | 'dom' | 'ocr';

export interface SessionSnapshot {
  sessionId: string | null;
  goal: string;
  mode: Mode;
  /** 'off' in Resume-only: detection is not running. */
  focus: FocusState | 'off';
  source: SignalSource;
  checkpoint: { id: string; problemId: string; anchor: string } | null;
  restore: { status: RestoreStatus; reason?: string; landing?: 'native' | 'dom-scroll'; via?: 'web' | 'extension' };
}

type Listener = (snapshot: SessionSnapshot, previous: SessionSnapshot) => void;

/** The single source of truth for session status. Render from it; never from the DOM. */
export class SessionStore {
  private snapshot: SessionSnapshot;
  private listeners = new Set<Listener>();

  constructor(initial: SessionSnapshot) {
    this.snapshot = initial;
  }

  get(): SessionSnapshot {
    return this.snapshot;
  }

  set(patch: Partial<SessionSnapshot>): void {
    const previous = this.snapshot;
    const next = { ...previous, ...patch };
    if (next.mode === 'resume-only') next.focus = 'off';
    if (JSON.stringify(next) === JSON.stringify(previous)) return;
    this.snapshot = next;
    for (const listener of this.listeners) listener(next, previous);
  }

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    listener(this.snapshot, this.snapshot);
    return () => this.listeners.delete(listener);
  }
}
