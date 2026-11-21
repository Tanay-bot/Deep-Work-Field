// Automated checks for the failures that would be embarrassing in a demo.
// Runs the real shared/ code in headless Chromium against small fixtures.
//   npm test
import { build } from 'esbuild';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { createRequire } from 'node:module';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..');
const require = createRequire(import.meta.url);
const { chromium } = require('playwright');

const entry = `
  export * from '${root}/shared/src/verify.ts';
  export * from '${root}/shared/src/checkpoint.ts';
  export * from '${root}/shared/src/fragments.ts';
  export { FocusEngine } from '${root}/shared/src/engine.ts';
  export { focusByHour } from '${root}/shared/src/planner.ts';
  export { matchScreen } from '${root}/shared/src/screen.ts';
  export { DEFAULT_THRESHOLDS } from '${root}/shared/src/config.ts';
`;
const bundle = await build({
  stdin: { contents: entry, resolveDir: root, loader: 'ts' },
  bundle: true,
  write: false,
  format: 'iife',
  globalName: 'DWF',
  target: 'es2020',
});
const lib = bundle.outputFiles[0].text;
const worksheet = readFileSync(resolve(root, 'demo/worksheet-a.html'), 'utf8').replace(/<script[^>]*src=[^>]*><\/script>/g, '');

const browser = await chromium.launch({ channel: 'chromium' });
const page = await browser.newPage({ viewport: { width: 1200, height: 800 } });
let failed = 0;
const results = [];

async function run(name, html, fn) {
  await page.setContent(html, { waitUntil: 'load' });
  await page.addScriptTag({ content: lib });
  try {
    const detail = await page.evaluate(fn);
    if (detail !== true) throw new Error(typeof detail === 'string' ? detail : JSON.stringify(detail));
    results.push(`  ✓ ${name}`);
  } catch (error) {
    failed++;
    results.push(`  ✗ ${name}\n      ${String(error.message ?? error).split('\n')[0]}`);
  }
}

// 1. The original demo: two identical "4b" headings, distinguished by context.
await run('twin 4b headings: verifies the Part II problem, never the answer key', worksheet, async () => {
  const heading = document.querySelector('[data-problem-id="4b"] h3');
  const cp = DWF.captureCheckpointFromElement(document, heading, { goal: 'chem' });
  if (!cp) return 'capture failed';
  document.querySelector('[data-problem-id="4b-key"]').scrollIntoView();
  const onKey = DWF.verifyCheckpointOnce(document, cp);
  if (onKey.reason !== 'not-in-viewport') return `with the answer key in view expected not-in-viewport, got ${onKey.reason}`;
  if (onKey.candidates !== 2 || onKey.contextMatches !== 1) return `expected 2 candidates / 1 context match, got ${onKey.candidates}/${onKey.contextMatches}`;
  heading.scrollIntoView({ block: 'center' });
  const r = DWF.verifyCheckpointOnce(document, cp);
  if (!r.match || !r.inViewport) return `expected verified, got ${r.reason}`;
  return r.range.startContainer.parentElement.closest('[data-problem-id]').dataset.problemId === '4b' || 'matched the wrong container';
});

// 2. Harder fixture: headings AND surrounding lines identical → must abstain.
const identical = `<!doctype html><body style="font:16px serif">
  <section><p>Practice set</p><h3>4b. Limiting reagent</h3><p>A 10.0 g sample of aluminum</p></section>
  <div style="height:1400px"></div>
  <section><p>Practice set</p><h3>4b. Limiting reagent</h3><p>A 10.0 g sample of aluminum</p></section></body>`;
await run('identical heading + identical context: reports ambiguous, never picks by visibility', identical, async () => {
  const cp = { anchor: '4b. Limiting reagent', prefix: 'Practice set', suffix: 'A 10.0 g sample' };
  const r = DWF.verifyCheckpointOnce(document, cp);
  if (r.reason !== 'ambiguous' || r.match) return `expected ambiguous, got ${r.reason}`;
  const a = await DWF.verifyCheckpointAsync(document, cp, { attempts: 3, retryMs: 10 });
  return (a.ok === false && a.reason === 'ambiguous') || `async expected ambiguous failure, got ${a.reason}`;
});

// 3. Same, but a stable problem id breaks the tie (visibility does not).
const identicalWithIds = identical
  .replace('<section>', '<section data-problem-id="set1-4b">')
  .replace(/<section>(?=[^]*$)/, '<section data-problem-id="set2-4b">');
await run('identical context with problem ids: the saved id selects the right one', identicalWithIds, async () => {
  const cp = { anchor: '4b. Limiting reagent', prefix: 'Practice set', suffix: 'A 10.0 g sample', selectorHint: '[data-problem-id="set2-4b"]' };
  document.querySelector('[data-problem-id="set2-4b"]').scrollIntoView();
  const r = DWF.verifyCheckpointOnce(document, cp);
  if (!r.match) return `expected a match, got ${r.reason}`;
  return r.range.startContainer.parentElement.closest('[data-problem-id]').dataset.problemId === 'set2-4b' || 'picked set1';
});

// 4. Selection capture saves the occurrence the user actually selected.
await run('selection capture: selecting the 2nd repeated phrase saves the 2nd', '<p id="p">alpha beta gamma. alpha beta delta.</p>', async () => {
  const text = document.getElementById('p').firstChild;
  const second = text.data.lastIndexOf('alpha beta');
  const range = document.createRange();
  range.setStart(text, second);
  range.setEnd(text, second + 'alpha beta'.length);
  const cp = DWF.captureCheckpointFromRange(document, range, {});
  if (!cp) return 'capture returned null';
  return (cp.anchor === 'alpha beta' && cp.suffix.startsWith('delta') && cp.prefix.endsWith('gamma.')) || JSON.stringify(cp);
});

// 5. Inline markup inside a word, and a selection spanning nodes.
await run('inline-formatted word and multi-node selection map correctly', '<h3 id="h">Lim<b>iting</b> <i>reagent</i></h3><p>next line</p>', async () => {
  const idx = DWF.buildTextIndex(document);
  if (!idx.text.includes('limiting reagent next line')) return `index was "${idx.text}"`;
  const h = document.getElementById('h');
  const range = document.createRange();
  range.setStart(h.firstChild, 0);
  range.setEnd(h.querySelector('i').firstChild, 7);
  const cp = DWF.captureCheckpointFromRange(document, range, {});
  return (cp && cp.anchor === 'Limiting reagent') || `anchor was ${cp && cp.anchor}`;
});

// 6. Hidden ancestors are not matchable text.
await run('text under a hidden ancestor is ignored', '<div style="display:none"><p><span>4b. Limiting reagent</span></p></div><p>visible</p>', async () => {
  const idx = DWF.buildTextIndex(document);
  return !idx.text.includes('limiting') || `hidden text indexed: "${idx.text}"`;
});

// 7. Accented / case-expanding characters keep a 1:1 offset map.
await run('case folding keeps offsets 1:1 (İ, ß, accents)', '<p>Größe İstanbul café 4b</p>', async () => {
  const idx = DWF.buildTextIndex(document);
  if (idx.text.length !== idx.map.length) return 'text and map lengths differ';
  const at = idx.text.indexOf('4b');
  const e = idx.map[at];
  return e.node.data.slice(e.offset, e.offset + 2) === '4b' || 'offset drifted';
});

// 8. Fragment URLs follow the spec: '-' and ',' percent-encoded, app hash kept.
await run('fragment URL: hyphen/comma encoded, existing hash preserved', '<p>x</p>', async () => {
  const url = DWF.buildTextFragmentUrl('https://ex.com/a#/route', { anchor: 'well-known, sure', prefix: 'Part II-', suffix: 'next' });
  const want = 'https://ex.com/a#/route:~:text=Part%20II%2D-,well%2Dknown%2C%20sure,-next';
  return url === want || url;
});

// 9. Engine: a gap in sampling must not satisfy the 3 s drift hold.
await run('engine: a sampling gap restarts the drift hold (fake clock)', '<p>x</p>', async () => {
  const t = { ...DWF.DEFAULT_THRESHOLDS };
  const engine = new DWF.FocusEngine({ thresholds: t, mode: 'screen-only', goal: 'g', corrections: [] });
  const off = (ms) => engine.update({ t: ms, screenText: '', onTaskSimilarity: 0.05, embedding: [], face: null, source: 'scripted' });
  off(0); off(500); off(1000);
  const afterGap = off(6000); // 5 s of nothing, then one drifting sample
  if (afterGap.distractionLogged || afterGap.nudge) return 'gap was counted as held drift';
  let loggedAt = null;
  for (let ms = 6500; ms <= 9500; ms += 500) if (off(ms).distractionLogged && loggedAt === null) loggedAt = ms;
  return loggedAt === 9000 || `expected the log exactly 3 s after the gap (9000), got ${loggedAt}`;
});

// 10. Engine: one nudge per drift episode.
await run('engine: one nudge per episode, even past the cooldown', '<p>x</p>', async () => {
  const t = { ...DWF.DEFAULT_THRESHOLDS, nudgeCooldownMs: 1000 };
  const engine = new DWF.FocusEngine({ thresholds: t, mode: 'screen-only', goal: 'g', corrections: [] });
  let nudges = 0;
  for (let ms = 0; ms <= 20000; ms += 500) {
    const d = engine.update({ t: ms, screenText: '', onTaskSimilarity: 0.05, embedding: [], face: null, source: 'scripted' });
    if (d.nudge) nudges++;
  }
  return nudges === 1 || `nudged ${nudges} times in one episode`;
});

// 12. Planner: scripted demo data never counts; hours need enough samples.
await run('planner: ignores scripted samples, suggests only well-sampled hours', '<p>x</p>', async () => {
  const at = (h) => new Date(2026, 10, 21, h, 5).getTime();
  const mk = (h, state, source) => ({ t: at(h), state, inputs: { source } });
  const entries = [
    ...Array.from({ length: 100 }, () => mk(9, 'FOCUSED', 'scripted')),
    ...Array.from({ length: 80 }, (_, i) => mk(16, i < 60 ? 'FOCUSED' : 'DRIFTING', 'dom')),
    ...Array.from({ length: 10 }, () => mk(20, 'FOCUSED', 'dom')),
  ];
  const r = DWF.focusByHour(entries, 50);
  if (r.hours[9].samples !== 0) return 'scripted samples were counted';
  if (r.suggestions.length !== 1 || r.suggestions[0].hour !== 16) return JSON.stringify(r.suggestions);
  return Math.abs(r.suggestions[0].focus - 0.75) < 1e-9 || `focus ${r.suggestions[0].focus}`;
});

// 13. Live screen matcher: the saved page counts as on-task; distractions don't.
await run('screen matcher: goal-term coverage and saved-page context', '<p>x</p>', async () => {
  const goal = 'AP Chem unit 4 limiting reagent';
  const sheet = DWF.matchScreen(goal, { url: 'https://a.test/ws.html#x', title: 'Worksheet', text: 'Problem 6', restricted: false, t: 0 }, { docId: 'https://a.test/ws.html', anchor: '4b' });
  const fun = DWF.matchScreen(goal, { url: 'https://yt.test/v', title: 'Minecraft parkour', text: 'best jumps', restricted: false, t: 0 }, null);
  return (sheet.sim >= 0.8 && fun.sim === 0) || JSON.stringify({ sheet, fun });
});

// 11. Chrome's own scroll-to-text must land the right 4b — no app scrolling.
{
  const name = 'native text fragment: Chrome itself lands Part II 4b (block-local terms)';
  try {
    const native = await browser.newPage({ viewport: { width: 1200, height: 800 } });
    await native.route('https://dwf.test/**', (route) => route.fulfill({ contentType: 'text/html', body: worksheet }));
    await native.goto('https://dwf.test/worksheet.html');
    await native.addScriptTag({ content: lib });
    const url = await native.evaluate(() => {
      const cp = DWF.captureCheckpointFromElement(document, document.querySelector('[data-problem-id="4b"] h3'), {});
      return DWF.buildTextFragmentUrl(location.href, cp);
    });
    await native.goto('about:blank');
    await native.goto(url);
    await native.waitForTimeout(1200);
    const where = await native.evaluate(() => {
      const top = (sel) => Math.round(document.querySelector(sel).getBoundingClientRect().top);
      return { y: Math.round(scrollY), problem: top('[data-problem-id="4b"] h3'), key: top('[data-problem-id="4b-key"] h3'), vh: innerHeight };
    });
    await native.close();
    const ok = where.y > 0 && where.problem >= 0 && where.problem < where.vh && !(where.key >= 0 && where.key < where.vh);
    if (!ok) throw new Error(`${url.split('#')[1]} → ${JSON.stringify(where)}`);
    results.push(`  ✓ ${name}`);
  } catch (error) {
    failed++;
    results.push(`  ✗ ${name}\n      ${String(error.message ?? error).split('\n')[0]}`);
  }
}

await browser.close();
console.log(results.join('\n'));
console.log(failed ? `\n${failed} failed` : `\nall ${results.length} passed`);
process.exit(failed ? 1 : 0);
