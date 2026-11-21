import type { StudyEvent } from '../../../shared/src/types';
import type { StudyRecord } from './db';
import { newId } from '../../../shared/src/checkpoint';

type StudyStatus = 'idle' | 'requesting' | 'recording' | 'stopping';
type LoggedEvent = StudyEvent & { elapsed: number; mode: string };

/** Recordings stop on their own after this long, so a forgotten tab cannot fill the disk. */
const MAX_RECORDING_MS = 2 * 60 * 60 * 1000;

/**
 * Study mode records the browser tab the student picks in Chrome's share
 * picker (the code cannot confirm it is the worksheet; the UI says "the tab
 * you pick"). Audio is off and the galaxy lives outside the captured tab, so
 * a labeler cannot tell which mode ran.
 *
 * Lifecycle: idle → requesting → recording → stopping → idle. start() and
 * stop() are safe to call twice; Chrome's own "Stop sharing" and the length
 * cap go through the same stop path. Timing uses a monotonic clock.
 */
export class StudyRecorder {
  status: StudyStatus = 'idle';
  sessionId = '';
  goal = '';
  mode = '';
  startedAt = 0;
  events: LoggedEvent[] = [];
  onEnded: (() => void) | null = null;
  private startPerf = 0;
  private stream: MediaStream | null = null;
  private recorder: MediaRecorder | null = null;
  private chunks: Blob[] = [];
  private mimeType = '';
  private capTimer = 0;
  private stopping: Promise<StudyRecord | null> | null = null;
  private captureError = false;

  get active(): boolean {
    return this.status === 'recording';
  }

  private cleanup(): void {
    clearTimeout(this.capTimer);
    this.stream?.getTracks().forEach((t) => t.stop());
    this.stream = null;
    this.recorder = null;
  }

  async start(sessionId: string, goal: string, mode: string): Promise<{ ok: boolean; error?: string }> {
    if (this.status === 'recording') return { ok: true };
    if (this.status !== 'idle') return { ok: false, error: 'A recording is already starting or stopping.' };
    this.status = 'requesting';
    try {
      this.stream = await navigator.mediaDevices.getDisplayMedia({
        video: { displaySurface: 'browser' } as unknown as MediaTrackConstraints,
        audio: false,
      });
      const track = this.stream.getVideoTracks()[0];
      const settings = track?.getSettings?.() as { displaySurface?: string } | undefined;
      if (settings?.displaySurface && settings.displaySurface !== 'browser') {
        throw new Error('Pick a Chrome tab, not a window or the whole screen.');
      }
      const candidates = ['video/webm;codecs=vp9', 'video/webm;codecs=vp8', 'video/webm'];
      this.mimeType = candidates.find((type) => MediaRecorder.isTypeSupported(type)) ?? '';
      this.recorder = this.mimeType ? new MediaRecorder(this.stream, { mimeType: this.mimeType }) : new MediaRecorder(this.stream);
      this.chunks = [];
      this.captureError = false;
      this.recorder.ondataavailable = (event) => {
        if (event.data && event.data.size > 0) this.chunks.push(event.data);
      };
      this.recorder.onerror = () => {
        this.captureError = true;
        this.onEnded?.();
      };
      track?.addEventListener('ended', () => {
        if (this.status === 'recording') this.onEnded?.();
      });
      this.recorder.start(1000);
    } catch (error) {
      this.cleanup();
      this.status = 'idle';
      return { ok: false, error: error instanceof Error ? error.message : 'Screen sharing was not granted.' };
    }
    this.sessionId = sessionId;
    this.goal = goal;
    this.mode = mode;
    this.startedAt = Date.now();
    this.startPerf = performance.now();
    this.events = [];
    this.status = 'recording';
    this.capTimer = window.setTimeout(() => this.onEnded?.(), MAX_RECORDING_MS);
    this.log('session-start', `mode=${mode}; goal=${goal}`);
    this.log('mode', mode);
    return { ok: true };
  }

  setMode(mode: string): void {
    this.mode = mode;
    this.log('mode', mode);
  }

  log(type: StudyEvent['type'], detail: string, state?: StudyEvent['state']): void {
    if (!this.sessionId || this.status !== 'recording') return;
    this.events.push({
      id: newId('ev'),
      sessionId: this.sessionId,
      t: Date.now(),
      elapsed: Math.round(performance.now() - this.startPerf),
      type,
      detail,
      state,
      mode: this.mode,
    });
  }

  stop(): Promise<StudyRecord | null> {
    if (this.stopping) return this.stopping;
    if (this.status !== 'recording' || !this.recorder) return Promise.resolve(null);
    this.stopping = this.finish().finally(() => {
      this.stopping = null;
    });
    return this.stopping;
  }

  private async finish(): Promise<StudyRecord | null> {
    this.log('session-end', 'recording stopped');
    this.status = 'stopping';
    const recorder = this.recorder!;
    const chunks = this.chunks;
    let finalized = false;
    const ended = new Promise<void>((resolve) => {
      recorder.addEventListener('stop', () => {
        finalized = true;
        resolve();
      }, { once: true });
    });
    try {
      if (recorder.state !== 'inactive') recorder.stop();
      else finalized = true;
    } catch {
      /* already stopped */
    }
    await Promise.race([ended, new Promise((resolve) => setTimeout(resolve, 2500))]);
    this.cleanup();
    const record: StudyRecord = {
      id: newId('study'),
      sessionId: this.sessionId,
      goal: this.goal,
      mode: this.mode,
      startedAt: this.startedAt,
      endedAt: Date.now(),
      events: this.events.map((e) => ({ t: e.t, elapsed: e.elapsed, type: e.type, detail: e.detail, state: e.state, mode: e.mode })),
      video: chunks.length ? new Blob(chunks, { type: this.mimeType || 'video/webm' }) : undefined,
      mimeType: this.mimeType,
      incomplete: !finalized || this.captureError,
    };
    this.sessionId = '';
    this.events = [];
    this.status = 'idle';
    return record;
  }
}

export function studyCsv(record: StudyRecord): string {
  const rows = ['session_id,timestamp_iso,elapsed_ms,type,state,mode,detail'];
  for (const event of record.events) {
    const detail = `"${String(event.detail).replace(/"/g, '""')}"`;
    rows.push(
      [
        record.sessionId,
        new Date(event.t).toISOString(),
        event.elapsed ?? Math.max(0, event.t - record.startedAt),
        event.type,
        event.state ?? '',
        event.mode ?? record.mode,
        event.type === 'session-end' && record.incomplete ? `"${String(event.detail).replace(/"/g, '""')}; INCOMPLETE recording"` : detail,
      ].join(','),
    );
  }
  return rows.join('\n') + '\n';
}

export function downloadBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  setTimeout(() => URL.revokeObjectURL(url), 4000);
}
