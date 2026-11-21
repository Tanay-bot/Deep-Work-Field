/**
 * Presentation-only motion layer. Nothing here touches app state: it reads
 * the DOM the app already renders and animates it. Every effect is skipped
 * under prefers-reduced-motion.
 */
import '@fontsource/instrument-serif/400.css';
import '@fontsource/instrument-serif/400-italic.css';
import '@fontsource-variable/bricolage-grotesque';
import '@fontsource-variable/jetbrains-mono';
import { gsap } from 'gsap';

const root = document.documentElement;
root.classList.add('js');
const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
const finePointer = window.matchMedia('(hover: hover) and (pointer: fine)').matches;

/* ---------- Intro curtain + hero title ---------------------------------- */
function intro(): void {
  const curtain = document.querySelector<HTMLElement>('.intro');
  const count = document.querySelector<HTMLElement>('.intro-count');
  const words = gsap.utils.toArray<HTMLElement>('.ht-word');
  if (reduce || !curtain || !count) {
    curtain?.classList.add('done');
    return;
  }
  gsap.set(words, { yPercent: 115, rotate: 4 });
  gsap.set('.hero-panel', { opacity: 0, y: 60, rotateX: 20 });
  gsap.set('.hero-stats > div, .hud-corners .hc', { opacity: 0, y: 14 });
  const counter = { v: 0 };
  const tl = gsap.timeline({ defaults: { ease: 'expo.out' } });
  tl.to(counter, {
    v: 100,
    duration: 1.05,
    ease: 'power2.inOut',
    onUpdate: () => {
      count.textContent = String(Math.round(counter.v)).padStart(3, '0');
    },
  })
    .to(curtain, { yPercent: -100, duration: 0.9, ease: 'expo.inOut' }, '+=0.05')
    .add(() => curtain.classList.add('done'))
    .to(words, { yPercent: 0, rotate: 0, duration: 1.4, stagger: 0.09 }, '-=0.45')
    .to('.hero-panel', { opacity: 1, y: 0, rotateX: 0, duration: 1.6 }, '-=1.2')
    .to('.hero-stats > div, .hud-corners .hc', { opacity: 1, y: 0, duration: 1, stagger: 0.06 }, '-=1.1');
}

/* ---------- Scroll reveals ---------------------------------------------- */
function reveals(): void {
  const items = document.querySelectorAll<HTMLElement>('.reveal-up');
  if (reduce || !('IntersectionObserver' in window)) {
    items.forEach((el) => el.classList.add('in'));
    return;
  }
  const io = new IntersectionObserver(
    (entries) => {
      for (const entry of entries) {
        if (!entry.isIntersecting) continue;
        const el = entry.target as HTMLElement;
        const siblings = Array.from(el.parentElement?.children ?? []).filter((c) => c.classList.contains('reveal-up'));
        el.style.transitionDelay = `${Math.max(0, siblings.indexOf(el)) * 90 + (el.closest('.hero') ? 1900 : 0)}ms`;
        el.classList.add('in');
        io.unobserve(el);
      }
    },
    { threshold: 0.12, rootMargin: '0px 0px -6% 0px' },
  );
  items.forEach((el) => io.observe(el));

  // Big section headings: split into lines and rise.
  document.querySelectorAll<HTMLElement>('.reveal-lines').forEach((el) => {
    const parts = el.innerHTML.split(/<br\s*\/?>/i);
    el.innerHTML = parts.map((p) => `<span class="ht-line"><span class="ht-word">${p}</span></span>`).join('');
    const lineWords = el.querySelectorAll('.ht-word');
    gsap.set(lineWords, { yPercent: 115 });
    const lio = new IntersectionObserver(
      (entries) => {
        if (!entries.some((e) => e.isIntersecting)) return;
        gsap.to(lineWords, { yPercent: 0, duration: 1.3, stagger: 0.12, ease: 'expo.out' });
        lio.disconnect();
      },
      { threshold: 0.3 },
    );
    lio.observe(el);
  });
}

/* ---------- Pointer effects --------------------------------------------- */
function cursor(): void {
  const el = document.querySelector<HTMLElement>('.cursor');
  if (!el || !finePointer || reduce) return;
  const xTo = gsap.quickTo(el, 'x', { duration: 0.45, ease: 'power3' });
  const yTo = gsap.quickTo(el, 'y', { duration: 0.45, ease: 'power3' });
  window.addEventListener('pointermove', (e) => {
    el.classList.add('on');
    xTo(e.clientX);
    yTo(e.clientY);
    const interactive = (e.target as HTMLElement).closest?.('a, button, label, select, input, [role="button"], .trace-row');
    el.classList.toggle('hover', !!interactive);
  }, { passive: true });
  document.addEventListener('pointerleave', () => el.classList.remove('on'));
}

function magnetic(): void {
  if (!finePointer || reduce) return;
  document.querySelectorAll<HTMLElement>('.magnetic').forEach((el) => {
    const xTo = gsap.quickTo(el, 'x', { duration: 0.6, ease: 'elastic.out(1, 0.4)' });
    const yTo = gsap.quickTo(el, 'y', { duration: 0.6, ease: 'elastic.out(1, 0.4)' });
    el.addEventListener('pointermove', (e) => {
      const r = el.getBoundingClientRect();
      xTo((e.clientX - (r.left + r.width / 2)) * 0.3);
      yTo((e.clientY - (r.top + r.height / 2)) * 0.4);
    });
    el.addEventListener('pointerleave', () => {
      xTo(0);
      yTo(0);
    });
  });
}

function tilt(): void {
  if (!finePointer || reduce) return;
  const win = document.querySelector<HTMLElement>('.tilt');
  const panel = document.querySelector<HTMLElement>('.hero-panel');
  if (win && panel) {
    window.addEventListener('pointermove', (e) => {
      const nx = e.clientX / window.innerWidth - 0.5;
      const ny = e.clientY / window.innerHeight - 0.5;
      win.style.transform = `rotateY(${-14 + nx * 16}deg) rotateX(${6 - ny * 12}deg) rotateZ(1deg)`;
    }, { passive: true });
  }
  // Spotlight that follows the pointer inside panels and cards.
  document.addEventListener('pointermove', (e) => {
    const host = (e.target as HTMLElement).closest?.('.panel') as HTMLElement | null;
    if (!host) return;
    const r = host.getBoundingClientRect();
    host.style.setProperty('--mx', `${e.clientX - r.left}px`);
    host.style.setProperty('--my', `${e.clientY - r.top}px`);
  }, { passive: true });
}

/* ---------- HUD: clock + state mirrors ---------------------------------- */
function hud(): void {
  const clocks = document.querySelectorAll<HTMLElement>('[data-hud-clock]');
  const states = document.querySelectorAll<HTMLElement>('[data-hud-state]');
  const started = performance.now();
  const tick = () => {
    const s = Math.floor((performance.now() - started) / 1000);
    const text = [Math.floor(s / 3600), Math.floor(s / 60) % 60, s % 60].map((n) => String(n).padStart(2, '0')).join(':');
    clocks.forEach((c) => (c.textContent = text));
  };
  tick();
  window.setInterval(tick, 1000);
  new MutationObserver(() => {
    const focus = root.dataset.focus ?? 'FOCUSED';
    states.forEach((s) => (s.textContent = focus));
  }).observe(root, { attributes: true, attributeFilter: ['data-focus'] });
}

/* ---------- Session entrance -------------------------------------------- */
function sessionEntrance(): void {
  const session = document.getElementById('session');
  if (!session) return;
  new MutationObserver(() => {
    if (session.hidden) return;
    window.scrollTo({ top: 0 });
    if (reduce) return;
    gsap.fromTo('#session-goal', { yPercent: 60, opacity: 0 }, { yPercent: 0, opacity: 1, duration: 1.2, ease: 'expo.out' });
    gsap.fromTo(
      '#session .card',
      { y: 50, opacity: 0, scale: 0.98 },
      { y: 0, opacity: 1, scale: 1, duration: 1, stagger: 0.06, ease: 'expo.out', delay: 0.1, clearProps: 'transform,opacity' },
    );
  }).observe(session, { attributes: true, attributeFilter: ['hidden'] });
}

/* ---------- State word scramble ----------------------------------------- */
function scramble(): void {
  const el = document.getElementById('galaxy-state');
  if (!el || reduce) return;
  const glyphs = 'abcdefghijklmnopqrstuvwxyz';
  let busy = false;
  new MutationObserver(() => {
    if (busy) return;
    const target = el.textContent ?? '';
    busy = true;
    let frame = 0;
    const total = 14;
    const step = () => {
      frame++;
      const live = root.dataset.focus ?? target;
      el.textContent = live
        .split('')
        .map((ch, i) => (i < (frame / total) * live.length ? ch : glyphs[Math.floor(Math.random() * glyphs.length)]))
        .join('');
      if (frame < total) requestAnimationFrame(step);
      else {
        el.textContent = root.dataset.focus ?? target;
        requestAnimationFrame(() => (busy = false));
      }
    };
    step();
  }).observe(el, { childList: true, characterData: true, subtree: true });
}

function boot(): void {
  intro();
  reveals();
  cursor();
  magnetic();
  tilt();
  hud();
  sessionEntrance();
  scramble();
}

if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
else boot();
