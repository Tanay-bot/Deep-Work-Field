/**
 * OCR screen reader fallback for apps outside the browser. The student shares
 * a window or the whole screen once; every few seconds one frame is
 * downscaled and read with Tesseract.js on-device. Worker, wasm core and the
 * English model are vendored under /tesseract (no CDN). Frames are never
 * stored; only the recognized text is passed to the goal matcher.
 */
type TesseractWorker = {
  recognize: (image: HTMLCanvasElement) => Promise<{ data: { text: string; confidence: number } }>;
  terminate: () => Promise<unknown>;
};

export interface OcrSample {
  text: string;
  confidence: number;
  label: string;
  t: number;
}

export class ScreenReader {
  private stream: MediaStream | null = null;
  private video = document.createElement('video');
  private canvas = document.createElement('canvas');
  private worker: TesseractWorker | null = null;
  private timer = 0;
  private busy = false;
  label = '';
  onSample: ((sample: OcrSample) => void) | null = null;
  onEnded: (() => void) | null = null;

  get running(): boolean {
    return !!this.stream;
  }

  /** Must follow a user gesture (screen-share picker). */
  async start(onProgress: (label: string) => void = () => {}, everyMs = 3000): Promise<void> {
    if (this.stream) return;
    onProgress('Pick the window or screen to watch…');
    this.stream = await navigator.mediaDevices.getDisplayMedia({ video: { frameRate: 1 }, audio: false });
    const track = this.stream.getVideoTracks()[0];
    const surface = (track?.getSettings?.() as { displaySurface?: string } | undefined)?.displaySurface ?? 'screen';
    this.label = surface === 'monitor' ? 'whole screen' : surface === 'window' ? 'a window' : 'a tab';
    track?.addEventListener('ended', () => {
      this.stop();
      this.onEnded?.();
    });
    this.video.muted = true;
    this.video.srcObject = this.stream;
    await this.video.play();
    try {
      onProgress('Loading on-device OCR…');
      const { createWorker } = await import('tesseract.js');
      const base = new URL('tesseract/', document.baseURI).href;
      this.worker = (await createWorker('eng', 1, {
        workerPath: `${base}worker.min.js`,
        corePath: base,
        langPath: base,
        gzip: true,
        workerBlobURL: false,
      })) as unknown as TesseractWorker;
    } catch (error) {
      this.stop();
      throw error;
    }
    onProgress(`Reading ${this.label} every ${Math.round(everyMs / 1000)} s.`);
    this.timer = window.setInterval(() => void this.tick(), everyMs);
    void this.tick();
  }

  private async tick(): Promise<void> {
    if (!this.worker || this.busy || this.video.readyState < 2) return;
    this.busy = true;
    try {
      const vw = this.video.videoWidth;
      const vh = this.video.videoHeight;
      const scale = Math.min(1, 1400 / Math.max(1, vw));
      this.canvas.width = Math.round(vw * scale);
      this.canvas.height = Math.round(vh * scale);
      const ctx = this.canvas.getContext('2d', { willReadFrequently: true });
      if (!ctx) return;
      ctx.filter = 'grayscale(1) contrast(1.4)';
      ctx.drawImage(this.video, 0, 0, this.canvas.width, this.canvas.height);
      const { data } = await this.worker.recognize(this.canvas);
      const text = data.text.replace(/\s+/g, ' ').trim().slice(0, 1600);
      this.onSample?.({ text, confidence: data.confidence, label: this.label, t: Date.now() });
    } catch {
      /* one failed frame is skipped; the next tick retries */
    } finally {
      this.busy = false;
    }
  }

  stop(): void {
    clearInterval(this.timer);
    this.timer = 0;
    this.stream?.getTracks().forEach((track) => track.stop());
    this.stream = null;
    this.video.srcObject = null;
    void this.worker?.terminate();
    this.worker = null;
  }

  /** Reads one image directly (used by tests and the upload path). */
  static async readImage(canvas: HTMLCanvasElement): Promise<string> {
    const { createWorker } = await import('tesseract.js');
    const base = new URL('tesseract/', document.baseURI).href;
    const worker = (await createWorker('eng', 1, { workerPath: `${base}worker.min.js`, corePath: base, langPath: base, gzip: true, workerBlobURL: false })) as unknown as TesseractWorker;
    try {
      return (await worker.recognize(canvas)).data.text;
    } finally {
      await worker.terminate();
    }
  }
}
