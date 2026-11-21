/**
 * Voice nudge.
 *
 * Kokoro (kokoro-js on WebGPU) is the production path: it must be preloaded at
 * session start with a progress bar, and falls back to device speech. This
 * build ships the fallback only; the model is ~90 MB and is not bundled, so
 * `preload` reports that honestly instead of pretending. The interface is the
 * one the Kokoro loader needs (progress callback, ready flag, speak, cancel).
 */
export type VoiceProgress = (fraction: number, label: string) => void;

export class Voice {
  private utterance: SpeechSynthesisUtterance | null = null;
  private kokoroReady = false;
  backend: 'kokoro' | 'device' | 'silent' = 'silent';

  async preload(onProgress: VoiceProgress): Promise<void> {
    onProgress(0.1, 'Checking voice backend');
    const synth = window.speechSynthesis;
    if (!synth) {
      this.backend = 'silent';
      onProgress(1, 'No speech engine available');
      return;
    }
    // Kokoro is intentionally not bundled in this build; see README.
    this.kokoroReady = false;
    this.backend = 'device';
    onProgress(1, 'Device voice ready (Kokoro model not bundled)');
  }

  get ready(): boolean {
    return this.backend === 'device' || this.kokoroReady;
  }

  speak(text: string): boolean {
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
  }
}
