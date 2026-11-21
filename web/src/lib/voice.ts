/**
 * Voice nudge. Default: the browser's own speech synthesis (on-device for
 * most system voices, no download). Optional: Kokoro-82M (kokoro-js, q8 ONNX
 * on the vendored WebAssembly runtime). The model is ~90 MB, too large to
 * ship with the site, so it is a one-time download the user starts; it is
 * then served from the browser cache, offline, and the app loads it from
 * cache on later visits. Any Kokoro failure falls back to device speech.
 */
import { withModelEnv } from './models';

export type VoiceProgress = (fraction: number, label: string) => void;

const KOKORO_MODEL = 'onnx-community/Kokoro-82M-v1.0-ONNX';
const KOKORO_VOICE = 'af_heart';
const KOKORO_FLAG = 'dwf:kokoro-downloaded';

type Kokoro = { generate: (text: string, options: { voice: string }) => Promise<{ audio: Float32Array; sampling_rate: number }> };

export class Voice {
  private utterance: SpeechSynthesisUtterance | null = null;
  private kokoro: Kokoro | null = null;
  private loading: Promise<boolean> | null = null;
  private audioContext: AudioContext | null = null;
  private source: AudioBufferSourceNode | null = null;
  /** Pre-synthesized lines: Kokoro takes seconds on WebAssembly, a nudge must not wait. */
  private prepared = new Map<string, Promise<{ audio: Float32Array; sampling_rate: number }>>();
  backend: 'kokoro' | 'device' | 'silent' = 'silent';

  get downloaded(): boolean {
    try {
      return localStorage.getItem(KOKORO_FLAG) === '1';
    } catch {
      return false;
    }
  }

  async preload(onProgress: VoiceProgress): Promise<void> {
    onProgress(0.1, 'Checking voice backend');
    this.backend = window.speechSynthesis ? 'device' : 'silent';
    onProgress(1, this.backend === 'device' ? 'Device voice ready. HD voice (Kokoro) is optional.' : 'No speech engine available');
    // Previously downloaded: load from the browser cache, no network needed.
    if (this.downloaded) void this.loadKokoro(onProgress);
  }

  /** Downloads once (user gesture), then loads from cache. Resolves true when Kokoro is ready. */
  loadKokoro(onProgress: VoiceProgress): Promise<boolean> {
    if (this.kokoro) return Promise.resolve(true);
    if (this.loading) return this.loading;
    const files = new Map<string, number>();
    this.loading = withModelEnv(
      (env) => {
        env.allowRemoteModels = true;
        env.allowLocalModels = false;
        env.useBrowserCache = true;
      },
      async () => {
        const { KokoroTTS } = await import('kokoro-js');
        const tts = await KokoroTTS.from_pretrained(KOKORO_MODEL, {
          dtype: 'q8',
          device: 'wasm',
          progress_callback: (p: { status?: string; file?: string; progress?: number }) => {
            if (p.status === 'progress' && p.file && typeof p.progress === 'number') {
              files.set(p.file, p.progress);
              const avg = [...files.values()].reduce((a, b) => a + b, 0) / files.size;
              onProgress(avg / 100, `${this.downloaded ? 'Loading' : 'Downloading'} HD voice… ${Math.round(avg)}%`);
            }
          },
        });
        return tts as unknown as Kokoro;
      },
    )
      .then((tts) => {
        this.kokoro = tts;
        this.backend = 'kokoro';
        try {
          localStorage.setItem(KOKORO_FLAG, '1');
        } catch {
          /* private mode: it will simply download again next time */
        }
        onProgress(1, 'HD voice ready (Kokoro, on this device).');
        return true;
      })
      .catch(() => {
        this.loading = null;
        onProgress(1, 'HD voice could not load here; using the device voice.');
        return false;
      });
    return this.loading;
  }

  get ready(): boolean {
    return this.backend !== 'silent';
  }

  /** Synthesizes a line in the background so a later speak() is instant. */
  prepare(text: string): void {
    if (!this.kokoro || this.prepared.has(text)) return;
    if (this.prepared.size > 8) this.prepared.delete(this.prepared.keys().next().value as string);
    const job = this.kokoro.generate(text, { voice: KOKORO_VOICE });
    job.catch(() => this.prepared.delete(text));
    this.prepared.set(text, job);
  }

  /**
   * Instant: a prepared Kokoro line plays if it is already synthesized;
   * otherwise the device voice speaks now (and the line is prepared for next time).
   */
  speak(text: string): boolean {
    const job = this.prepared.get(text);
    if (this.kokoro && job) {
      let settled = false;
      void job.then((out) => {
        settled = true;
        this.play(out);
      });
      // Not ready within a beat: do not keep the student waiting.
      setTimeout(() => {
        if (!settled) this.speakDevice(text);
      }, 150);
      return true;
    }
    if (this.kokoro) this.prepare(text);
    return this.speakDevice(text);
  }

  private play(out: { audio: Float32Array; sampling_rate: number }): number {
    this.cancel();
    this.audioContext ??= new AudioContext();
    const buffer = this.audioContext.createBuffer(1, out.audio.length, out.sampling_rate);
    buffer.copyToChannel(new Float32Array(out.audio), 0);
    const source = this.audioContext.createBufferSource();
    source.buffer = buffer;
    source.connect(this.audioContext.destination);
    source.start();
    this.source = source;
    return buffer.duration;
  }

  /** Synthesizes with Kokoro and plays through Web Audio. */
  async speakKokoro(text: string): Promise<number> {
    if (!this.kokoro) throw new Error('Kokoro not loaded');
    this.prepare(text);
    return this.play(await this.prepared.get(text)!);
  }

  private speakDevice(text: string): boolean {
    if (!('speechSynthesis' in window)) return false;
    try {
      window.speechSynthesis.cancel();
      const utterance = new SpeechSynthesisUtterance(text);
      utterance.rate = 0.98;
      utterance.pitch = 1;
      utterance.volume = 0.95;
      const preferred = window.speechSynthesis
        .getVoices()
        .find((v) => /en[-_](US|GB)/i.test(v.lang) && /natural|samantha|google|aria/i.test(v.name));
      if (preferred) utterance.voice = preferred;
      this.utterance = utterance;
      window.speechSynthesis.speak(utterance);
      return true;
    } catch {
      return false;
    }
  }

  cancel(): void {
    this.utterance = null;
    if ('speechSynthesis' in window) window.speechSynthesis.cancel();
    try {
      this.source?.stop();
    } catch {
      /* already stopped */
    }
    this.source = null;
  }
}
