import type { StudyEvent } from '../../../shared/src/types';
import type { StudyRecord } from './db';
import { newId } from '../../../shared/src/checkpoint';

/**
 * Study mode records the worksheet tab the student picks in Chrome's share
 * picker. Audio is disabled and the in-page galaxy is hidden (or lives in a
 * Picture-in-Picture window that is not part of the captured tab), so the
 * labeler cannot tell which mode is running.
 */
export class StudyRecorder {
  active = false;
  sessionId = '';
  goal = '';
  mode = '';
  startedAt = 0;
  events: StudyEvent[] = [];
  onEnded: (() => void) | null = null;
  private stream: MediaStream | null = null;
  private recorder: MediaRecorder | null = null;
  private chunks: Blob[] = [];
  private mimeType = '';

  async start(sessionId: string, goal: string, mode: string): Promise<{ ok: boolean; error?: string }> {
    if (this.active) return { ok: true };
    try {
      this.stream = await navigator.mediaDevices.getDisplayMedia({
        video: { displaySurface: 'browser' } as unknown as MediaTrackConstraints,
        audio: false,
      });
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : 'Screen sharing was not granted.' };
    }
    const track = this.stream.getVideoTracks()[0];
    const settings = track?.getSettings?.() as { displaySurface?: string } | undefined;
    if (settings?.displaySurface && settings.displaySurface !== 'browser') {
      this.stream.getTracks().forEach((t) => t.stop());
      this.stream = null;
      return { ok: false, error: 'Pick a Chrome tab (the worksheet), not a window or the whole screen.' };
    }
    this.sessionId = sessionId;
    this.goal = goal;
    this.mode = mode;
    this.startedAt = Date.now();
    this.events = [];
    this.chunks = [];
    const candidates = ['video/webm;codecs=vp9', 'video/webm;codecs=vp8', 'video/webm'];
    this.mimeType = candidates.find((type) => MediaRecorder.isTypeSupported(type)) ?? '';
    try {
      this.recorder = this.mimeType
        ? new MediaRecorder(this.stream, { mimeType: this.mimeType })
        : new MediaRecorder(this.stream);
    } catch (error) {
      this.stream.getTracks().forEach((t) => t.stop());
      this.stream = null;
      return { ok: false, error: error instanceof Error ? error.message : 'Recorder could not start.' };
    }
    this.recorder.ondataavailable = (event) => {
      if (event.data && event.data.size > 0) this.chunks.push(event.data);
    };
    track?.addEventListener('ended', () => {
      if (this.active) this.onEnded?.();
    });
    this.recorder.start(1000);
    this.active = true;
    this.log('session-start', `mode=${mode}; goal=${goal}`);
    this.log('mode', mode);
    return { ok: true };
  }

  setMode(mode: string): void {
    this.mode = mode;
    this.log('mode', mode);
  }

  log(type: StudyEvent['type'], detail: string, state?: StudyEvent['state']): void {
    if (!this.sessionId) return;
    this.events.push({
      id: newId('ev'),
      sessionId: this.sessionId,
      t: Date.now(),
      type,
      detail,
      state,
    });
  }

  async stop(): Promise<StudyRecord | null> {
    if (!this.active || !this.recorder) {
      this.active = false;
      return null;
    }
    this.log('session-end', 'recording stopped');
    const recorder = this.recorder;
    const chunks = this.chunks;
    const ended = new Promise<void>((resolve) => {
      recorder.addEventListener('stop', () => resolve(), { once: true });
    });
    try {
      if (recorder.state !== 'inactive') recorder.stop();
    } catch {
      /* already stopped */
    }
    await Promise.race([ended, new Promise((resolve) => setTimeout(resolve, 2500))]);
    this.stream?.getTracks().forEach((t) => t.stop());
    this.recorder = null;
    this.stream = null;
    this.active = false;
    const record: StudyRecord = {
      id: newId('study'),
      sessionId: this.sessionId,
      goal: this.goal,
      mode: this.mode,
      startedAt: this.startedAt,
      endedAt: Date.now(),
      events: this.events.map((e) => ({ t: e.t, type: e.type, detail: e.detail, state: e.state })),
      video: chunks.length ? new Blob(chunks, { type: this.mimeType || 'video/webm' }) : undefined,
      mimeType: this.mimeType,
    };
    this.sessionId = '';
    this.events = [];
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
        Math.max(0, event.t - record.startedAt),
        event.type,
        event.state ?? '',
        record.mode,
        detail,
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
