/**
 * Real face cues with MediaPipe Face Landmarker, fully on-device. The wasm and
 * the model are served from /mediapipe/ (same origin, cached for offline).
 *
 * Calibration decides what "head down" means for this person and camera:
 * look at the screen, then at your notes. Pitch is reported relative to the
 * screen pose, signed so that positive = toward the notes, which removes any
 * dependence on the matrix's sign convention or the camera's mounting angle.
 */
import type { FaceCue } from '../../../shared/src/types';

type Landmarker = {
  detectForVideo: (video: HTMLVideoElement, t: number) => {
    faceLandmarks: unknown[];
    faceBlendshapes?: { categories: { categoryName: string; score: number }[] }[];
    facialTransformationMatrixes?: { data: number[] }[];
  };
  close: () => void;
};

export interface FaceCalibration {
  screenPitch: number;
  notesPitch: number;
  at: number;
}

const CAL_KEY = 'dwf:face-calibration';

export class FaceSensor {
  private landmarker: Landmarker | null = null;
  private stream: MediaStream | null = null;
  readonly video: HTMLVideoElement;
  private lastT = 0;
  calibration: FaceCalibration | null = null;
  latest: FaceCue | null = null;
  rawPitch: number | null = null;

  constructor() {
    this.video = document.createElement('video');
    this.video.muted = true;
    this.video.playsInline = true;
    try {
      const raw = localStorage.getItem(CAL_KEY);
      this.calibration = raw ? (JSON.parse(raw) as FaceCalibration) : null;
    } catch {
      this.calibration = null;
    }
  }

  get running(): boolean {
    return !!this.stream && !!this.landmarker;
  }

  /** Asks for the camera and loads the model. Must follow a user gesture. */
  async start(onProgress: (label: string) => void = () => {}): Promise<void> {
    if (this.running) return;
    onProgress('Asking for the camera…');
    this.stream = await navigator.mediaDevices.getUserMedia({ video: { width: 320, height: 240, facingMode: 'user' }, audio: false });
    this.video.srcObject = this.stream;
    await this.video.play();
    onProgress('Loading the on-device face model…');
    try {
      const vision = await import('@mediapipe/tasks-vision');
      const fileset = await vision.FilesetResolver.forVisionTasks(new URL('mediapipe', document.baseURI).href.replace(/\/$/, ''));
      this.landmarker = (await vision.FaceLandmarker.createFromOptions(fileset, {
        baseOptions: { modelAssetPath: new URL('mediapipe/face_landmarker.task', document.baseURI).href, delegate: 'CPU' },
        runningMode: 'VIDEO',
        numFaces: 1,
        outputFaceBlendshapes: true,
        outputFacialTransformationMatrixes: true,
      })) as unknown as Landmarker;
    } catch (error) {
      this.stop();
      throw error;
    }
    onProgress('Face cues on.');
  }

  stop(): void {
    this.stream?.getTracks().forEach((track) => track.stop());
    this.stream = null;
    this.video.srcObject = null;
    this.landmarker?.close();
    this.landmarker = null;
    this.latest = null;
  }

  /** One detection. Called on every live sample and on a visible-tab timer. */
  sample(thresholdDeg: number): FaceCue | null {
    if (!this.landmarker || this.video.readyState < 2) return this.latest;
    const t = Math.max(performance.now(), this.lastT + 1);
    this.lastT = t;
    let result;
    try {
      result = this.landmarker.detectForVideo(this.video, t);
    } catch {
      return this.latest;
    }
    if (!result.faceLandmarks.length) {
      this.rawPitch = null;
      this.latest = { present: false, headDown: false, eyesClosed: false };
      return this.latest;
    }
    const m = result.facialTransformationMatrixes?.[0]?.data;
    // Column-major 4x4: rotation about the x axis = atan2(R21, R22).
    const pitch = m ? (Math.atan2(m[6], m[10]) * 180) / Math.PI : 0;
    this.rawPitch = pitch;
    const shapes = result.faceBlendshapes?.[0]?.categories ?? [];
    const score = (name: string) => shapes.find((c) => c.categoryName === name)?.score ?? 0;
    const eyesClosed = score('eyeBlinkLeft') > 0.6 && score('eyeBlinkRight') > 0.6;
    const cal = this.calibration;
    // Relative pitch, positive toward the notes. Uncalibrated: raw, sign unknown.
    const direction = cal ? Math.sign(cal.notesPitch - cal.screenPitch) || 1 : 1;
    const relative = cal ? (pitch - cal.screenPitch) * direction : pitch;
    const span = cal ? Math.abs(cal.notesPitch - cal.screenPitch) : Infinity;
    // Head down past the calibrated midpoint, or past the configured threshold.
    const headDown = cal ? relative >= Math.min(thresholdDeg, span / 2) : false;
    this.latest = { present: true, headDown, eyesClosed, pitchDeg: Number(relative.toFixed(1)) };
    return this.latest;
  }

  /** Averages raw pitch over a few seconds while the user holds a pose. */
  async capturePose(ms = 2500): Promise<number | null> {
    const values: number[] = [];
    const end = performance.now() + ms;
    while (performance.now() < end) {
      this.sample(18);
      if (this.rawPitch !== null) values.push(this.rawPitch);
      await new Promise((resolve) => setTimeout(resolve, 120));
    }
    if (values.length < 5) return null;
    values.sort((a, b) => a - b);
    return values[Math.floor(values.length / 2)];
  }

  saveCalibration(screenPitch: number, notesPitch: number): FaceCalibration {
    this.calibration = { screenPitch, notesPitch, at: Date.now() };
    try {
      localStorage.setItem(CAL_KEY, JSON.stringify(this.calibration));
    } catch {
      /* private mode */
    }
    return this.calibration;
  }
}
