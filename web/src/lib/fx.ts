/**
 * Presentation-only motion layer. Nothing here touches app state: it reads
 * the DOM the app already renders and animates it. Headline and CTA are
 * visible at first paint; motion is spent on the thread and on state changes.
 */
import '@fontsource/instrument-serif/400.css';
import '@fontsource/instrument-serif/400-italic.css';
import '@fontsource-variable/bricolage-grotesque';
import '@fontsource-variable/jetbrains-mono';
import { gsap } from 'gsap';

const root = document.documentElement;
root.classList.add('js');
const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

/* ---------- The thread: galaxy core → the 4b underline ------------------ */
function thread(): void {
  const hero = document.querySelector<HTMLElement>('.hero');
  const svg = document.querySelector<SVGSVGElement>('.thread');
  const path = svg?.querySelector<SVGPathElement>('.thread-path');
  const point = svg?.querySelector<SVGCircleElement>('.thread-point');
  const target = document.querySelector<HTMLElement>('.thread-target');
  const sheet = document.querySelector<HTMLElement>('.paper-front');
  const landing = document.getElementById('landing');
  if (!hero || !svg || !path || !point || !target || !landing || !sheet) return;

  const start = performance.now() + 250;
  const duration = 1100;
  let visible = true;
  new IntersectionObserver((entries) => (visible = entries[0]?.isIntersecting ?? true)).observe(hero);

  const frame = (now: number) => {
    requestAnimationFrame(frame);
    if (!visible || landing.hidden) return;
    const h = hero.getBoundingClientRect();
    const t = target.getBoundingClientRect();
    const css = getComputedStyle(root);
    const gx = parseFloat(css.getPropertyValue('--gx'));
    const gy = parseFloat(css.getPropertyValue('--gy'));
    const sx = Number.isFinite(gx) && gx > 0 ? Math.min(gx, window.innerWidth - 20) - h.left : h.width - 30;
    const sy = Number.isFinite(gy) && gy > -400 ? Math.max(gy, 30) - h.top : 40;
    const ex = t.right - h.left;
    const ey = t.bottom + 1 - h.top;
    // Sweep out past the sheet's right edge, then run in along the underline.
    const edge = sheet.getBoundingClientRect().right - h.left;
    const swing = Math.max(edge + 70, sx + 40);
    const d =
      `M ${sx.toFixed(1)} ${sy.toFixed(1)} ` +
      `C ${(swing + 40).toFixed(1)} ${(sy + (ey - sy) * 0.35).toFixed(1)}, ` +
      `${(swing + 30).toFixed(1)} ${ey.toFixed(1)}, ${(edge - 2).toFixed(1)} ${ey.toFixed(1)} ` +
      `L ${ex.toFixed(1)} ${ey.toFixed(1)}`;
    path.setAttribute('d', d);
    const len = path.getTotalLength();
    const p = reduce ? 1 : Math.min(1, Math.max(0, (now - start) / duration));
    const eased = 1 - Math.pow(1 - p, 3);
    path.style.strokeDasharray = `${(len * eased).toFixed(1)} ${len.toFixed(1)}`;
    const tip = path.getPointAtLength(len * eased);
    point.setAttribute('cx', tip.x.toFixed(1));
    point.setAttribute('cy', tip.y.toFixed(1));
    point.setAttribute('r', (p < 1 ? 3 : 4 + Math.sin(now / 400) * 1.2).toFixed(2));
  };
  requestAnimationFrame(frame);
}

/* ---------- Section reveals (below the fold only) ----------------------- */
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
        el.style.transitionDelay = `${Math.max(0, siblings.indexOf(el)) * 70}ms`;
        el.classList.add('in');
        io.unobserve(el);
      }
    },
    { threshold: 0.1 },
  );
  items.forEach((el) => io.observe(el));
}

/* ---------- Subtle spotlight inside panels ------------------------------ */
function spotlight(): void {
  if (reduce) return;
  document.addEventListener('pointermove', (e) => {
    const host = (e.target as HTMLElement).closest?.('.panel') as HTMLElement | null;
    if (!host) return;
    const r = host.getBoundingClientRect();
    host.style.setProperty('--mx', `${e.clientX - r.left}px`);
    host.style.setProperty('--my', `${e.clientY - r.top}px`);
  }, { passive: true });
}

/* ---------- Session entrance -------------------------------------------- */
function sessionEntrance(): void {
  const session = document.getElementById('session');
  if (!session) return;
  new MutationObserver(() => {
    if (session.hidden) return;
    window.scrollTo({ top: 0 });
    if (reduce) return;
    gsap.fromTo(
      '#session .card',
      { y: 24, opacity: 0 },
      { y: 0, opacity: 1, duration: 0.45, stagger: 0.04, ease: 'power3.out', clearProps: 'transform,opacity' },
    );
  }).observe(session, { attributes: true, attributeFilter: ['hidden'] });
}

function boot(): void {
  thread();
  reveals();
  spotlight();
  sessionEntrance();
}

if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
else boot();
