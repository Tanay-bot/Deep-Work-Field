import type { FocusState } from '../../../shared/src/types';
import { DEFAULT_THRESHOLDS } from '../../../shared/src/config';
import * as THREE from 'three';

export interface GalaxyOptions {
  maxParticles?: number;
  minParticles?: number;
  frameBudgetMs?: number;
}

/** Per-state palette: [core, mid, rim] in linear-ish RGB, plus a dust tint. */
const PALETTE: Record<FocusState, { core: [number, number, number]; mid: [number, number, number]; rim: [number, number, number]; css: string }> = {
  FOCUSED: { core: [1.0, 0.93, 0.78], mid: [1.0, 0.66, 0.24], rim: [0.36, 0.55, 1.0], css: '#ffb547' },
  WRITING: { core: [0.92, 1.0, 0.95], mid: [0.42, 0.98, 0.82], rim: [0.25, 0.55, 0.95], css: '#6ff5d2' },
  UNCERTAIN: { core: [0.95, 0.93, 1.0], mid: [0.7, 0.68, 0.86], rim: [0.42, 0.42, 0.6], css: '#b8b2d8' },
  DRIFTING: { core: [1.0, 0.86, 0.8], mid: [1.0, 0.3, 0.16], rim: [0.75, 0.12, 0.32], css: '#ff4d2e' },
};

const STATE_INDEX: Record<FocusState, number> = { FOCUSED: 0, WRITING: 1, UNCERTAIN: 2, DRIFTING: 3 };

const VERT = /* glsl */ `
  uniform float uTime;
  uniform float uPixelRatio;
  uniform float uSize;
  uniform vec4 uW;          // weights: focused spiral, writing spiral, uncertain ring, drift scatter
  uniform vec3 uCore;
  uniform vec3 uMid;
  uniform vec3 uRim;
  uniform float uPulse;
  attribute vec3 aSpiral;
  attribute vec3 aTight;
  attribute vec3 aRing;
  attribute vec3 aScatter;
  attribute vec4 aSeed;     // x: radius 0..1, y: size jitter, z: phase, w: arm brightness
  varying vec3 vColor;
  varying float vAlpha;

  vec3 rotY(vec3 p, float a) { float c = cos(a), s = sin(a); return vec3(c * p.x - s * p.z, p.y, s * p.x + c * p.z); }

  void main() {
    float r = aSeed.x;
    // Differential rotation: inner stars orbit faster than outer ones.
    float spin = uTime * (0.05 + 0.32 / (r * 6.0 + 0.6));
    vec3 spiral = rotY(aSpiral, spin);
    vec3 tight = rotY(aTight, spin * 1.6);
    vec3 ring = rotY(aRing, uTime * 0.04 + sin(uTime * 0.3 + aSeed.z) * 0.08);
    ring.y += sin(uTime * 0.8 + aSeed.z * 6.0) * 0.18;
    vec3 scatter = aScatter + vec3(
      sin(uTime * 0.21 + aSeed.z * 9.0),
      cos(uTime * 0.17 + aSeed.z * 7.0),
      sin(uTime * 0.19 + aSeed.z * 5.0)) * 0.35;
    vec3 p = spiral * uW.x + tight * uW.y + ring * uW.z + scatter * uW.w;

    vec4 mv = modelViewMatrix * vec4(p, 1.0);
    gl_Position = projectionMatrix * mv;

    float twinkle = 0.75 + 0.25 * sin(uTime * (1.5 + aSeed.y * 3.0) + aSeed.z * 40.0);
    float size = uSize * (0.35 + aSeed.y * 1.25) * (1.0 + uPulse * 0.6 * (1.0 - r));
    gl_PointSize = size * uPixelRatio * (7.0 / -mv.z) * twinkle;

    vec3 c = mix(uCore, uMid, smoothstep(0.0, 0.32, r));
    c = mix(c, uRim, smoothstep(0.3, 0.95, r));
    vColor = c * (0.65 + aSeed.w * 0.7);
    vAlpha = (0.55 + 0.45 * twinkle) * (1.0 - r * 0.35);
  }
`;

const FRAG = /* glsl */ `
  varying vec3 vColor;
  varying float vAlpha;
  void main() {
    vec2 uv = gl_PointCoord - 0.5;
    float d = length(uv);
    if (d > 0.5) discard;
    float core = exp(-d * d * 60.0);
    float halo = exp(-d * d * 9.0) * 0.45;
    float a = (core + halo) * vAlpha;
    gl_FragColor = vec4(vColor * (core * 1.6 + halo), a);
  }
`;

const STAR_VERT = /* glsl */ `
  uniform float uTime;
  uniform float uPixelRatio;
  attribute vec2 aSeed;
  varying float vA;
  void main() {
    vec4 mv = modelViewMatrix * vec4(position, 1.0);
    gl_Position = projectionMatrix * mv;
    float tw = 0.5 + 0.5 * sin(uTime * (0.6 + aSeed.y * 2.0) + aSeed.x * 50.0);
    vA = 0.25 + tw * 0.75;
    gl_PointSize = (0.8 + aSeed.y * 1.8) * uPixelRatio;
  }
`;

const STAR_FRAG = /* glsl */ `
  varying float vA;
  void main() {
    float d = length(gl_PointCoord - 0.5);
    if (d > 0.5) discard;
    gl_FragColor = vec4(vec3(0.85, 0.88, 1.0), (1.0 - d * 2.0) * vA * 0.7);
  }
`;

const DUST_VERT = /* glsl */ `
  uniform float uTime;
  uniform float uPixelRatio;
  uniform vec3 uTint;
  uniform float uSpread;
  attribute vec3 aSeed;
  varying vec3 vC;
  varying float vA;
  void main() {
    float r = length(position.xz);
    float a = uTime * (0.02 + 0.06 / (r + 0.8));
    float c = cos(a), s = sin(a);
    vec3 p = vec3(c * position.x - s * position.z, position.y, s * position.x + c * position.z) * (1.0 + uSpread * 0.9);
    vec4 mv = modelViewMatrix * vec4(p, 1.0);
    gl_Position = projectionMatrix * mv;
    gl_PointSize = (60.0 + aSeed.x * 140.0) * uPixelRatio * (6.0 / -mv.z);
    vC = mix(uTint, vec3(0.25, 0.32, 0.65), aSeed.y);
    vA = 0.05 + aSeed.z * 0.05;
  }
`;

const DUST_FRAG = /* glsl */ `
  varying vec3 vC;
  varying float vA;
  void main() {
    float d = length(gl_PointCoord - 0.5);
    if (d > 0.5) discard;
    float f = exp(-d * d * 10.0);
    gl_FragColor = vec4(vC, f * vA);
  }
`;

function gauss(): number {
  // Box-Muller; clamp the tails so arms stay readable.
  const u = Math.max(1e-6, Math.random());
  const v = Math.random();
  return Math.max(-2.5, Math.min(2.5, Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v)));
}

/**
 * A shader-driven spiral galaxy. Every focus state is a precomputed shape
 * stored as a vertex attribute; the CPU only eases four blend weights, so
 * state changes morph on the GPU without touching the position buffer.
 * If a frame takes longer than the budget the draw range shrinks, and it
 * recovers when frames get cheap again.
 */
export class Galaxy {
  private renderer: THREE.WebGLRenderer;
  private scene: THREE.Scene;
  private camera: THREE.PerspectiveCamera;
  private group: THREE.Group;
  private geometry: THREE.BufferGeometry;
  private material: THREE.ShaderMaterial;
  private starMaterial: THREE.ShaderMaterial;
  private dustMaterial: THREE.ShaderMaterial;
  private maxParticles: number;
  private minParticles: number;
  private drawCount: number;
  private frameBudget: number;
  private state: FocusState = 'FOCUSED';
  private weights = new THREE.Vector4(1, 0, 0, 0);
  private targetWeights = new THREE.Vector4(1, 0, 0, 0);
  private colors = { core: new THREE.Color(), mid: new THREE.Color(), rim: new THREE.Color() };
  private targetColors = { core: new THREE.Color(), mid: new THREE.Color(), rim: new THREE.Color() };
  private pointer = { x: 0, y: 0, tx: 0, ty: 0 };
  private scroll = 0;
  private layout: 'hero' | 'session' = 'hero';
  private groupX = 3.4;
  private groupY = 1.5;
  private projected = new THREE.Vector3();
  private frameIndex = 0;
  private pulse = 0;
  private raf = 0;
  private lastFrame = 0;
  private slowFrames = 0;
  private fastFrames = 0;
  private disposed = false;
  private clock = new THREE.Clock();
  private reduceMotion = false;
  private pipWindow: Window | null = null;
  private pipRaf = 0;
  backend: 'webgpu' | 'webgl' = 'webgl';

  static async create(canvas: HTMLCanvasElement, options: GalaxyOptions = {}): Promise<Galaxy> {
    const renderer = new THREE.WebGLRenderer({ canvas, antialias: false, alpha: true, powerPreference: 'high-performance' });
    return new Galaxy(renderer, canvas, options);
  }

  private constructor(renderer: THREE.WebGLRenderer, canvas: HTMLCanvasElement, options: GalaxyOptions) {
    this.renderer = renderer;
    this.maxParticles = options.maxParticles ?? DEFAULT_THRESHOLDS.galaxyMaxParticles;
    this.minParticles = options.minParticles ?? DEFAULT_THRESHOLDS.galaxyMinParticles;
    this.frameBudget = options.frameBudgetMs ?? DEFAULT_THRESHOLDS.frameBudgetMs;
    this.drawCount = this.maxParticles;
    this.reduceMotion = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false;

    const pr = Math.min(window.devicePixelRatio || 1, 1.75);
    this.renderer.setPixelRatio(pr);
    this.renderer.setSize(canvas.clientWidth || window.innerWidth, canvas.clientHeight || window.innerHeight, false);
    this.renderer.setClearColor(0x000000, 0);

    this.scene = new THREE.Scene();
    this.camera = new THREE.PerspectiveCamera(50, (canvas.clientWidth || 1) / (canvas.clientHeight || 1), 0.1, 200);
    this.camera.position.set(0, 3.1, 7.4);
    this.camera.lookAt(0, 0, 0);
    this.group = new THREE.Group();
    this.group.rotation.z = -0.32;
    this.group.rotation.x = 0.18;
    this.scene.add(this.group);

    // --- Main galaxy -------------------------------------------------------
    const n = this.maxParticles;
    const spiral = new Float32Array(n * 3);
    const tight = new Float32Array(n * 3);
    const ring = new Float32Array(n * 3);
    const scatter = new Float32Array(n * 3);
    const seed = new Float32Array(n * 4);
    const ARMS = 3;
    for (let i = 0; i < n; i++) {
      const i3 = i * 3;
      const t = Math.pow(Math.random(), 1.6);
      const radius = 0.12 + t * 4.4;
      const arm = i % ARMS;
      const twist = radius * 1.45;
      const jitter = (0.08 + t * 0.42) * gauss();
      const angle = (arm / ARMS) * Math.PI * 2 + twist + jitter * 0.6;
      const thick = (0.06 + 0.22 * (1 - t)) * gauss() * 0.5;
      spiral[i3] = Math.cos(angle) * radius + gauss() * 0.06 * (1 + t * 2);
      spiral[i3 + 1] = thick;
      spiral[i3 + 2] = Math.sin(angle) * radius + gauss() * 0.06 * (1 + t * 2);

      const tr = 0.1 + t * 3.1;
      const ta = (arm / ARMS) * Math.PI * 2 + tr * 2.4 + jitter * 0.3;
      tight[i3] = Math.cos(ta) * tr;
      tight[i3 + 1] = thick * 0.4;
      tight[i3 + 2] = Math.sin(ta) * tr;

      const rr = 2.0 + gauss() * 0.35 + (Math.random() < 0.15 ? Math.random() * 1.5 : 0);
      const ra = Math.random() * Math.PI * 2;
      ring[i3] = Math.cos(ra) * rr;
      ring[i3 + 1] = gauss() * 0.22;
      ring[i3 + 2] = Math.sin(ra) * rr;

      const sr = 3 + Math.pow(Math.random(), 0.6) * 6.5;
      const theta = Math.random() * Math.PI * 2;
      const phi = Math.acos(2 * Math.random() - 1);
      scatter[i3] = Math.sin(phi) * Math.cos(theta) * sr * 1.3;
      scatter[i3 + 1] = Math.cos(phi) * sr * 0.6;
      scatter[i3 + 2] = Math.sin(phi) * Math.sin(theta) * sr;

      seed[i * 4] = t;
      seed[i * 4 + 1] = Math.pow(Math.random(), 3);
      seed[i * 4 + 2] = Math.random();
      seed[i * 4 + 3] = Math.abs(jitter) < 0.12 ? 1 : Math.random() * 0.6;
    }
    this.geometry = new THREE.BufferGeometry();
    this.geometry.setAttribute('position', new THREE.BufferAttribute(spiral, 3));
    this.geometry.setAttribute('aSpiral', new THREE.BufferAttribute(spiral, 3));
    this.geometry.setAttribute('aTight', new THREE.BufferAttribute(tight, 3));
    this.geometry.setAttribute('aRing', new THREE.BufferAttribute(ring, 3));
    this.geometry.setAttribute('aScatter', new THREE.BufferAttribute(scatter, 3));
    this.geometry.setAttribute('aSeed', new THREE.BufferAttribute(seed, 4));
    this.geometry.setDrawRange(0, this.drawCount);
    this.geometry.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 20);

    this.setPalette('FOCUSED', true);
    this.material = new THREE.ShaderMaterial({
      vertexShader: VERT,
      fragmentShader: FRAG,
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      uniforms: {
        uTime: { value: 0 },
        uPixelRatio: { value: pr },
        uSize: { value: 13 },
        uW: { value: this.weights },
        uCore: { value: this.colors.core },
        uMid: { value: this.colors.mid },
        uRim: { value: this.colors.rim },
        uPulse: { value: 0 },
      },
    });
    this.group.add(new THREE.Points(this.geometry, this.material));

    // --- Nebula dust --------------------------------------------------------
    const dustCount = 160;
    const dustPos = new Float32Array(dustCount * 3);
    const dustSeed = new Float32Array(dustCount * 3);
    for (let i = 0; i < dustCount; i++) {
      const r = 0.4 + Math.random() * 3.8;
      const a = (i % 3) * ((Math.PI * 2) / 3) + r * 1.45 + gauss() * 0.35;
      dustPos[i * 3] = Math.cos(a) * r;
      dustPos[i * 3 + 1] = gauss() * 0.15;
      dustPos[i * 3 + 2] = Math.sin(a) * r;
      dustSeed[i * 3] = Math.random();
      dustSeed[i * 3 + 1] = Math.random();
      dustSeed[i * 3 + 2] = Math.random();
    }
    const dustGeo = new THREE.BufferGeometry();
    dustGeo.setAttribute('position', new THREE.BufferAttribute(dustPos, 3));
    dustGeo.setAttribute('aSeed', new THREE.BufferAttribute(dustSeed, 3));
    this.dustMaterial = new THREE.ShaderMaterial({
      vertexShader: DUST_VERT,
      fragmentShader: DUST_FRAG,
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      uniforms: { uTime: { value: 0 }, uPixelRatio: { value: pr }, uTint: { value: this.colors.mid }, uSpread: { value: 0 } },
    });
    this.group.add(new THREE.Points(dustGeo, this.dustMaterial));

    // --- Background starfield ----------------------------------------------
    const starCount = 2600;
    const starPos = new Float32Array(starCount * 3);
    const starSeed = new Float32Array(starCount * 2);
    for (let i = 0; i < starCount; i++) {
      const r = 30 + Math.random() * 40;
      const theta = Math.random() * Math.PI * 2;
      const phi = Math.acos(2 * Math.random() - 1);
      starPos[i * 3] = Math.sin(phi) * Math.cos(theta) * r;
      starPos[i * 3 + 1] = Math.cos(phi) * r;
      starPos[i * 3 + 2] = Math.sin(phi) * Math.sin(theta) * r;
      starSeed[i * 2] = Math.random();
      starSeed[i * 2 + 1] = Math.pow(Math.random(), 4);
    }
    const starGeo = new THREE.BufferGeometry();
    starGeo.setAttribute('position', new THREE.BufferAttribute(starPos, 3));
    starGeo.setAttribute('aSeed', new THREE.BufferAttribute(starSeed, 2));
    this.starMaterial = new THREE.ShaderMaterial({
      vertexShader: STAR_VERT,
      fragmentShader: STAR_FRAG,
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      uniforms: { uTime: { value: 0 }, uPixelRatio: { value: pr } },
    });
    this.scene.add(new THREE.Points(starGeo, this.starMaterial));

    const resize = () => {
      const w = canvas.clientWidth || window.innerWidth;
      const h = canvas.clientHeight || window.innerHeight;
      this.renderer.setSize(w, h, false);
      this.camera.aspect = w / Math.max(1, h);
      this.camera.updateProjectionMatrix();
    };
    window.addEventListener('resize', resize);
    window.addEventListener('pointermove', (event) => {
      this.pointer.tx = (event.clientX / window.innerWidth) * 2 - 1;
      this.pointer.ty = (event.clientY / window.innerHeight) * 2 - 1;
    }, { passive: true });
    this.lastFrame = performance.now();
    this.animate();
  }

  private setPalette(state: FocusState, immediate = false): void {
    const p = PALETTE[state];
    this.targetColors.core.setRGB(...p.core);
    this.targetColors.mid.setRGB(...p.mid);
    this.targetColors.rim.setRGB(...p.rim);
    if (immediate) {
      this.colors.core.copy(this.targetColors.core);
      this.colors.mid.copy(this.targetColors.mid);
      this.colors.rim.copy(this.targetColors.rim);
    }
  }

  setState(state: FocusState): void {
    if (state === this.state) return;
    this.state = state;
    const w = [0, 0, 0, 0];
    w[STATE_INDEX[state]] = 1;
    this.targetWeights.set(w[0], w[1], w[2], w[3]);
    this.setPalette(state);
    this.pulse = 1;
  }

  /** 0..1 page scroll progress; dollies the camera through the disc. */
  setScroll(progress: number): void {
    this.scroll = Math.max(0, Math.min(1, progress));
  }

  /** Hero puts the galaxy off to the right; session centers it behind the HUD. */
  setLayout(layout: 'hero' | 'session'): void {
    this.layout = layout;
  }

  private animate = (): void => {
    if (this.disposed) return;
    this.raf = requestAnimationFrame(this.animate);
    const now = performance.now();
    const dt = now - this.lastFrame;
    this.lastFrame = now;

    if (dt > this.frameBudget) {
      this.slowFrames++;
      this.fastFrames = 0;
      if (this.slowFrames > 20 && this.drawCount > this.minParticles) {
        this.drawCount = Math.max(this.minParticles, Math.floor(this.drawCount * 0.85));
        this.geometry.setDrawRange(0, this.drawCount);
        this.slowFrames = 0;
      }
    } else if (dt < 13) {
      this.fastFrames++;
      this.slowFrames = 0;
      if (this.fastFrames > 90 && this.drawCount < this.maxParticles) {
        this.drawCount = Math.min(this.maxParticles, Math.floor(this.drawCount * 1.08));
        this.geometry.setDrawRange(0, this.drawCount);
        this.fastFrames = 0;
      }
    }

    const landing = document.getElementById('landing');
    this.layout = landing && !landing.hidden ? 'hero' : 'session';
    this.scroll = this.layout === 'hero' ? Math.min(1, window.scrollY / (window.innerHeight * 1.4)) : 0;
    const t = this.clock.getElapsedTime() * (this.reduceMotion ? 0.15 : 1);
    const ease = this.state === 'DRIFTING' ? 0.03 : 0.045;
    this.weights.x += (this.targetWeights.x - this.weights.x) * ease;
    this.weights.y += (this.targetWeights.y - this.weights.y) * ease;
    this.weights.z += (this.targetWeights.z - this.weights.z) * ease;
    this.weights.w += (this.targetWeights.w - this.weights.w) * ease;
    this.colors.core.lerp(this.targetColors.core, 0.05);
    this.colors.mid.lerp(this.targetColors.mid, 0.05);
    this.colors.rim.lerp(this.targetColors.rim, 0.05);
    this.pulse *= 0.94;

    this.material.uniforms.uTime.value = t;
    this.material.uniforms.uPulse.value = this.pulse;
    this.starMaterial.uniforms.uTime.value = t;
    this.dustMaterial.uniforms.uTime.value = t;
    this.dustMaterial.uniforms.uSpread.value = this.weights.w;

    // Pointer parallax and scroll dolly.
    this.pointer.x += (this.pointer.tx - this.pointer.x) * 0.04;
    this.pointer.y += (this.pointer.ty - this.pointer.y) * 0.04;
    const wide = this.camera.aspect > 1.1;
    const targetX = this.layout === 'hero' ? (wide ? 3.0 + this.scroll * 0.6 : 1.6) : 0;
    const targetY = this.layout === 'hero' ? (wide ? 2.9 : 2.6) * (1 - this.scroll) : 0;
    this.groupX += (targetX - this.groupX) * 0.05;
    this.groupY += (targetY - this.groupY) * 0.05;
    this.group.position.x = this.groupX;
    this.group.position.y = this.groupY;
    this.group.rotation.x = 0.18 + this.scroll * 0.9;
    const dist = 7.2 - this.scroll * 1.6 + (this.layout === 'session' ? 1.2 : 0) + (wide ? 0 : 4.5);
    this.camera.position.set(this.pointer.x * 0.6, 4.3 - this.scroll * 2.4 - this.pointer.y * 0.4, dist);
    this.camera.lookAt(this.groupX * 0.25, 0, 0);
    this.camera.updateMatrixWorld();
    const fade = (this.layout === 'hero' ? 1 - this.scroll * 0.7 : 0.85) * (wide ? 1 : 0.55);
    this.renderer.domElement.style.opacity = fade.toFixed(3);

    // Publish the core's screen position so the DOM thread can start there.
    if (this.layout === 'hero' && (this.frameIndex++ & 1) === 0) {
      this.projected.set(this.groupX, this.groupY, 0).project(this.camera);
      const w = this.renderer.domElement.clientWidth;
      const h = this.renderer.domElement.clientHeight;
      const rootStyle = document.documentElement.style;
      rootStyle.setProperty('--gx', String(((this.projected.x + 1) / 2) * w));
      rootStyle.setProperty('--gy', String(((1 - this.projected.y) / 2) * h));
    }

    this.renderer.render(this.scene, this.camera);
  };

  /**
   * Must be called from a user gesture. Document PiP is Chrome-only; when it is
   * missing we fall back to an in-page panel (handled by the caller).
   */
  async openPiP(): Promise<'pip' | 'unavailable' | 'denied'> {
    const dpip = (window as unknown as { documentPictureInPicture?: any }).documentPictureInPicture;
    if (!dpip || typeof dpip.requestWindow !== 'function') return 'unavailable';
    try {
      const pip: Window = await dpip.requestWindow({ width: 320, height: 320, disallowReturnToOpener: false });
      this.closePiP();
      this.pipWindow = pip;
      pip.document.title = 'Deep Work Field · galaxy';
      pip.document.body.style.cssText = 'margin:0;background:#050407;color:#efe7d6;overflow:hidden;font-family:ui-monospace,monospace';
      const canvas = pip.document.createElement('canvas');
      canvas.style.cssText = 'position:fixed;inset:0;width:100%;height:100%;display:block';
      pip.document.body.appendChild(canvas);
      const ctx = canvas.getContext('2d');
      if (!ctx) return 'denied';
      const stars = Array.from({ length: 900 }, (_, i) => {
        const t = Math.pow(Math.random(), 1.5);
        const arm = i % 3;
        return {
          r: 0.04 + t * 0.9,
          a: (arm / 3) * Math.PI * 2 + t * 4.2 + gauss() * 0.25 * (0.3 + t),
          s: 0.4 + Math.pow(Math.random(), 3) * 2.2,
          sx: Math.random() * 2 - 1,
          sy: Math.random() * 2 - 1,
          p: Math.random() * 10,
        };
      });
      let spread = 0;
      const frame = (ms: number) => {
        if (!this.pipWindow || this.pipWindow.closed) return;
        this.pipRaf = pip.requestAnimationFrame(frame);
        const dpr = pip.devicePixelRatio || 1;
        const w = canvas.clientWidth;
        const h = canvas.clientHeight;
        if (canvas.width !== Math.round(w * dpr)) {
          canvas.width = Math.round(w * dpr);
          canvas.height = Math.round(h * dpr);
        }
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
        const time = ms / 1000;
        const target = this.state === 'DRIFTING' ? 1 : this.state === 'UNCERTAIN' ? 0.45 : 0;
        spread += (target - spread) * 0.04;
        ctx.globalCompositeOperation = 'source-over';
        ctx.fillStyle = 'rgba(5,4,7,0.35)';
        ctx.fillRect(0, 0, w, h);
        const col = PALETTE[this.state].css;
        const R = Math.min(w, h) * 0.42;
        const glow = ctx.createRadialGradient(w / 2, h / 2, 0, w / 2, h / 2, R * 1.2);
        glow.addColorStop(0, col + '55');
        glow.addColorStop(1, 'rgba(0,0,0,0)');
        ctx.globalCompositeOperation = 'lighter';
        ctx.fillStyle = glow;
        ctx.fillRect(0, 0, w, h);
        ctx.fillStyle = col;
        for (const star of stars) {
          const ang = star.a + time * (0.15 + 0.5 / (star.r * 8 + 1));
          const gx = Math.cos(ang) * star.r * R;
          const gy = Math.sin(ang) * star.r * R * 0.55;
          const x = w / 2 + gx * (1 - spread) + star.sx * w * 0.6 * spread + Math.sin(time + star.p) * 6 * spread;
          const y = h / 2 + gy * (1 - spread) + star.sy * h * 0.6 * spread;
          ctx.globalAlpha = 0.35 + 0.65 * Math.abs(Math.sin(time * 1.3 + star.p));
          ctx.fillRect(x, y, star.s, star.s);
        }
        ctx.globalAlpha = 1;
        ctx.globalCompositeOperation = 'source-over';
        ctx.font = 'italic 34px "Instrument Serif", Georgia, serif';
        ctx.fillStyle = '#efe7d6';
        ctx.fillText(this.state.toLowerCase(), 16, h - 22);
        ctx.font = '10px ui-monospace, monospace';
        ctx.fillStyle = col;
        ctx.fillText('DEEP WORK FIELD · LIVE', 16, 22);
      };
      this.pipRaf = pip.requestAnimationFrame(frame);
      pip.addEventListener('pagehide', () => {
        this.pipWindow = null;
      });
      return 'pip';
    } catch {
      return 'denied';
    }
  }

  private closePiP(): void {
    if (this.pipWindow && !this.pipWindow.closed) {
      this.pipWindow.cancelAnimationFrame(this.pipRaf);
      this.pipWindow.close();
    }
    this.pipWindow = null;
  }

  dispose(): void {
    this.disposed = true;
    cancelAnimationFrame(this.raf);
    this.closePiP();
    this.geometry.dispose();
    this.material.dispose();
    this.renderer.dispose();
  }
}
