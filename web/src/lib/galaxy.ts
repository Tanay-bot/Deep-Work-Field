import type { FocusState } from '../../../shared/src/types';
import { DEFAULT_THRESHOLDS } from '../../../shared/src/config';

type ThreeAny = any;

function canvasHasPixels(canvas: HTMLCanvasElement): boolean {
  try {
    const probe = document.createElement('canvas');
    probe.width = 120;
    probe.height = 90;
    const context = probe.getContext('2d');
    if (!context) return false;
    context.drawImage(canvas, 0, 0, probe.width, probe.height);
    const data = context.getImageData(0, 0, probe.width, probe.height).data;
    for (let i = 3; i < data.length; i += 4) {
      if (data[i] > 0) return true;
    }
    return false;
  } catch {
    return false;
  }
}

export interface GalaxyOptions {
  maxParticles?: number;
  minParticles?: number;
  frameBudgetMs?: number;
}

/**
 * The galaxy is a single point cloud. Focus state changes the target cloud
 * shape; points ease toward it. If a frame takes longer than the budget the
 * draw range shrinks, and it recovers when frames get cheap again.
 */
export class Galaxy {
  private THREE: ThreeAny;
  private renderer: ThreeAny;
  private scene: ThreeAny;
  private camera: ThreeAny;
  private points: ThreeAny;
  private geometry: ThreeAny;
  private targets: Float32Array;
  private base: Float32Array;
  private maxParticles: number;
  private minParticles: number;
  private drawCount: number;
  private frameBudget: number;
  private state: FocusState = 'FOCUSED';
  private raf = 0;
  private lastFrame = 0;
  private slowFrames = 0;
  private fastFrames = 0;
  private disposed = false;
  private pipWindow: Window | null = null;
  private pipRaf = 0;
  private pipContext: CanvasRenderingContext2D | null = null;
  private pipDots: { x: number; y: number; vx: number; vy: number; r: number }[] = [];
  backend: 'webgpu' | 'webgl' = 'webgl';

  static async create(canvas: HTMLCanvasElement, options: GalaxyOptions = {}): Promise<Galaxy> {
    let THREE: ThreeAny = null;
    let renderer: ThreeAny = null;
    let backend: 'webgpu' | 'webgl' = 'webgl';
    const nav = navigator as Navigator & { gpu?: unknown };
    if (nav.gpu) {
      try {
        THREE = await import(/* @vite-ignore */ 'three/webgpu');
        renderer = new THREE.WebGPURenderer({ canvas, antialias: true, alpha: true });
        if (typeof renderer.init === 'function') await renderer.init();
        backend = 'webgpu';
      } catch {
        try {
          renderer?.dispose?.();
        } catch {
          /* ignore */
        }
        THREE = null;
        renderer = null;
      }
    }
    if (!THREE) {
      THREE = await import('three');
      renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true });
      backend = 'webgl';
    }
    const galaxy = new Galaxy(THREE, renderer, backend, canvas, options);
    if (backend === 'webgpu') {
      // A WebGPU context can initialize and still produce no visible point
      // cloud (driver/material mismatch). Probe the actual canvas once, then
      // fall back to a fresh canvas with WebGL rather than shipping a blank sky.
      await new Promise((resolve) => setTimeout(resolve, 700));
      if (!canvasHasPixels(canvas)) {
        galaxy.dispose();
        const replacement = document.createElement('canvas');
        replacement.id = canvas.id;
        replacement.className = canvas.className;
        replacement.setAttribute('aria-hidden', 'true');
        canvas.replaceWith(replacement);
        const gl = await import('three');
        const glRenderer = new gl.WebGLRenderer({ canvas: replacement, antialias: true, alpha: true });
        return new Galaxy(gl, glRenderer, 'webgl', replacement, options);
      }
    }
    return galaxy;
  }

  private constructor(THREE: ThreeAny, renderer: ThreeAny, backend: 'webgpu' | 'webgl', canvas: HTMLCanvasElement, options: GalaxyOptions) {
    this.THREE = THREE;
    this.renderer = renderer;
    this.backend = backend;
    this.maxParticles = options.maxParticles ?? DEFAULT_THRESHOLDS.galaxyMaxParticles;
    this.minParticles = options.minParticles ?? DEFAULT_THRESHOLDS.galaxyMinParticles;
    this.frameBudget = options.frameBudgetMs ?? DEFAULT_THRESHOLDS.frameBudgetMs;
    this.drawCount = this.maxParticles;

    this.renderer.setPixelRatio?.(Math.min(window.devicePixelRatio || 1, 1.75));
    this.renderer.setSize?.(canvas.clientWidth || window.innerWidth, canvas.clientHeight || window.innerHeight, false);
    this.renderer.setClearColor?.(0x000000, 0);

    this.scene = new THREE.Scene();
    this.camera = new THREE.PerspectiveCamera(55, (canvas.clientWidth || 1) / (canvas.clientHeight || 1), 0.1, 100);
    this.camera.position.set(-1.7, 2.1, 6.2);
    this.camera.lookAt(0, 0, 0);

    this.base = new Float32Array(this.maxParticles * 3);
    this.targets = new Float32Array(this.maxParticles * 3);
    const colors = new Float32Array(this.maxParticles * 3);
    for (let i = 0; i < this.maxParticles; i++) {
      const t = i / this.maxParticles;
      const arm = i % 4;
      const radius = 0.28 + t * 4.1;
      const angle = t * Math.PI * 6.4 + (arm * Math.PI) / 2 + (Math.random() - 0.5) * 0.5;
      this.base[i * 3] = Math.cos(angle) * radius;
      this.base[i * 3 + 1] = (Math.random() - 0.5) * 0.55 * (1 - t * 0.5);
      this.base[i * 3 + 2] = Math.sin(angle) * radius;
      const warm = Math.random();
      colors[i * 3] = 0.55 + warm * 0.45;
      colors[i * 3 + 1] = 0.7 + warm * 0.25;
      colors[i * 3 + 2] = 1;
    }
    this.geometry = new THREE.BufferGeometry();
    this.geometry.setAttribute('position', new THREE.BufferAttribute(this.base.slice(), 3));
    this.geometry.setAttribute('color', new THREE.BufferAttribute(colors, 3));
    this.geometry.setDrawRange(0, this.drawCount);
    const material =
      backend === 'webgpu' && THREE.PointsNodeMaterial
        ? new THREE.PointsNodeMaterial({ size: 2.4, sizeAttenuation: false, transparent: true, opacity: 0.9, depthWrite: false, blending: THREE.AdditiveBlending, vertexColors: true })
        : new THREE.PointsMaterial({ size: 0.021, transparent: true, opacity: 0.78, depthWrite: false, blending: THREE.AdditiveBlending, vertexColors: true, sizeAttenuation: true });
    this.points = new THREE.Points(this.geometry, material);
    this.scene.add(this.points);
    this.computeTargets('FOCUSED');

    const resize = () => {
      const w = canvas.clientWidth || window.innerWidth;
      const h = canvas.clientHeight || window.innerHeight;
      this.renderer.setSize?.(w, h, false);
      this.camera.aspect = w / Math.max(1, h);
      this.camera.updateProjectionMatrix();
    };
    window.addEventListener('resize', resize);
    this.lastFrame = performance.now();
    this.animate();
  }

  private computeTargets(state: FocusState): void {
    for (let i = 0; i < this.maxParticles; i++) {
      const i3 = i * 3;
      if (state === 'DRIFTING') {
        const r = 2.6 + Math.random() * 4.4;
        const theta = Math.random() * Math.PI * 2;
        const phi = Math.acos(2 * Math.random() - 1);
        this.targets[i3] = Math.sin(phi) * Math.cos(theta) * r;
        this.targets[i3 + 1] = Math.cos(phi) * r * 0.7;
        this.targets[i3 + 2] = Math.sin(phi) * Math.sin(theta) * r;
      } else if (state === 'UNCERTAIN') {
        const r = 1.8 + Math.random() * 2.6;
        const theta = Math.random() * Math.PI * 2;
        this.targets[i3] = Math.cos(theta) * r;
        this.targets[i3 + 1] = (Math.random() - 0.5) * 2.4;
        this.targets[i3 + 2] = Math.sin(theta) * r;
      } else {
        const t = i / this.maxParticles;
        const arm = i % 4;
        const radius = 0.24 + t * (state === 'WRITING' ? 3.2 : 4.1);
        const angle = t * Math.PI * (state === 'WRITING' ? 9.5 : 6.4) + (arm * Math.PI) / 2;
        this.targets[i3] = Math.cos(angle) * radius;
        this.targets[i3 + 1] = (Math.random() - 0.5) * (state === 'WRITING' ? 0.25 : 0.5) * (1 - t * 0.5);
        this.targets[i3 + 2] = Math.sin(angle) * radius;
      }
    }
  }

  setState(state: FocusState): void {
    if (state === this.state) return;
    this.state = state;
    this.computeTargets(state);
    const host = document.getElementById('galaxy-state');
    if (host) host.textContent = state;
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

    const position = this.geometry.getAttribute('position');
    const array = position.array as Float32Array;
    const ease = this.state === 'DRIFTING' ? 0.028 : 0.045;
    for (let i = 0; i < this.drawCount; i++) {
      const i3 = i * 3;
      array[i3] += (this.targets[i3] - array[i3]) * ease;
      array[i3 + 1] += (this.targets[i3 + 1] - array[i3 + 1]) * ease;
      array[i3 + 2] += (this.targets[i3 + 2] - array[i3 + 2]) * ease;
    }
    position.needsUpdate = true;
    this.points.rotation.y += this.state === 'DRIFTING' ? 0.0012 : 0.0032;
    try {
      this.renderer.render(this.scene, this.camera);
    } catch {
      /* WebGPU can fail after init on some drivers; the WebGL fallback is
         created by the caller only if create() failed. Keep the UI alive. */
    }
  };

  /**
   * Must be called from a user gesture. Document PiP is Chrome-only; when it is
   * missing we fall back to an in-page panel (handled by the caller).
   */
  async openPiP(): Promise<'pip' | 'unavailable' | 'denied'> {
    const dpip = (window as unknown as { documentPictureInPicture?: any }).documentPictureInPicture;
    if (!dpip || typeof dpip.requestWindow !== 'function') return 'unavailable';
    try {
      const pip = await dpip.requestWindow({ width: 360, height: 250, disallowReturnToOpener: false });
      this.closePiP();
      this.pipWindow = pip;
      pip.document.title = 'Deep Work Field · galaxy';
      pip.document.body.style.cssText = 'margin:0;background:#050914;color:#dbe7ff;font:12px ui-sans-serif,system-ui,sans-serif;overflow:hidden';
      const canvas = pip.document.createElement('canvas');
      canvas.style.cssText = 'width:100%;height:100%;display:block';
      pip.document.body.appendChild(canvas);
      const label = pip.document.createElement('div');
      label.style.cssText = 'position:fixed;left:12px;bottom:10px;letter-spacing:.12em;text-transform:uppercase;font-size:10px;opacity:.65';
      label.textContent = 'mini-galaxy';
      pip.document.body.appendChild(label);
      const ctx = canvas.getContext('2d');
      if (!ctx) return 'denied';
      this.pipContext = ctx;
      this.pipDots = Array.from({ length: 220 }, () => ({
        x: Math.random() * 360,
        y: Math.random() * 250,
        vx: (Math.random() - 0.5) * 0.5,
        vy: (Math.random() - 0.5) * 0.5,
        r: 0.6 + Math.random() * 1.4,
      }));
      const frame = () => {
        if (!this.pipWindow || this.pipWindow.closed) return;
        this.pipRaf = requestAnimationFrame(frame);
        const w = canvas.clientWidth;
        const h = canvas.clientHeight;
        if (canvas.width !== w || canvas.height !== h) {
          canvas.width = w;
          canvas.height = h;
        }
        ctx.clearRect(0, 0, w, h);
        const gradient = ctx.createRadialGradient(w / 2, h / 2, 0, w / 2, h / 2, Math.max(w, h) / 1.2);
        gradient.addColorStop(0, this.state === 'DRIFTING' ? 'rgba(255,120,80,.15)' : 'rgba(90,150,255,.14)');
        gradient.addColorStop(1, 'rgba(5,9,20,0)');
        ctx.fillStyle = gradient;
        ctx.fillRect(0, 0, w, h);
        const spread = this.state === 'DRIFTING' ? 2.4 : this.state === 'UNCERTAIN' ? 1.5 : 0.6;
        for (const dot of this.pipDots) {
          dot.x += dot.vx * spread;
          dot.y += dot.vy * spread;
          if (dot.x < 0) dot.x = w;
          if (dot.x > w) dot.x = 0;
          if (dot.y < 0) dot.y = h;
          if (dot.y > h) dot.y = 0;
          ctx.fillStyle = this.state === 'DRIFTING' ? 'rgba(255,170,130,.75)' : this.state === 'UNCERTAIN' ? 'rgba(180,200,230,.55)' : 'rgba(150,195,255,.85)';
          ctx.beginPath();
          ctx.arc(dot.x, dot.y, dot.r, 0, Math.PI * 2);
          ctx.fill();
        }
        const text = this.state;
        ctx.fillStyle = 'rgba(220,235,255,.8)';
        ctx.font = '11px ui-monospace, monospace';
        ctx.fillText(text, 12, 20);
      };
      frame();
      pip.addEventListener('pagehide', () => {
        this.pipWindow = null;
        cancelAnimationFrame(this.pipRaf);
      });
      return 'pip';
    } catch {
      return 'denied';
    }
  }

  private closePiP(): void {
    cancelAnimationFrame(this.pipRaf);
    if (this.pipWindow && !this.pipWindow.closed) this.pipWindow.close();
    this.pipWindow = null;
    this.pipContext = null;
  }

  dispose(): void {
    this.disposed = true;
    cancelAnimationFrame(this.raf);
    this.closePiP();
    this.geometry?.dispose?.();
    this.renderer?.dispose?.();
  }
}
