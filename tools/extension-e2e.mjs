// End-to-end check of the unpacked extension in Chromium.
//   npm run build:extension && npm run dev   (in another shell)
//   node tools/extension-e2e.mjs
// Saves Part II 4b from the demo worksheet, then fires TWO restores at once:
// each must settle its own tab with its own restoreId, and nothing may be left pending.
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';

const require = createRequire(import.meta.url);
const { chromium } = require('playwright');
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const ext = resolve(root, 'extension/dist');
const base = process.env.DWF_BASE ?? 'http://localhost:3000';

const context = await chromium.launchPersistentContext(mkdtempSync(resolve(tmpdir(), 'dwf-')), {
  headless: true,
  channel: 'chromium',
  args: [`--disable-extensions-except=${ext}`, `--load-extension=${ext}`],
});
let [worker] = context.serviceWorkers();
if (!worker) worker = await context.waitForEvent('serviceworker');
const extId = new URL(worker.url()).host;
const fail = (msg) => {
  console.error(`✗ ${msg}`);
  process.exitCode = 1;
};

const app = await context.newPage();
await app.goto(`${base}/`, { waitUntil: 'load' });
await app.waitForFunction(() => /connected/.test(document.getElementById('extension-status')?.textContent ?? ''), null, { timeout: 8000 }).catch(() => {});
const status = await app.textContent('#extension-status');
if (!/connected/.test(status ?? '')) fail(`web app did not connect to the pinned extension ID: "${status}"`);
else console.log(`✓ web app connected with no ID pasted ("${status}")`);
await app.close();

const sheet = await context.newPage();
await sheet.goto(`${base}/demo/worksheet-a.html`, { waitUntil: 'load' });
await sheet.evaluate(() => {
  const h = document.querySelector('[data-problem-id="4b"] h3');
  h.scrollIntoView({ block: 'center' });
  const r = document.createRange();
  r.selectNodeContents(h);
  getSelection().removeAllRanges();
  getSelection().addRange(r);
});
const panel = await context.newPage();
await panel.goto(`chrome-extension://${extId}/popup.html`);
await sheet.bringToFront();
const saved = await panel.evaluate(() => chrome.runtime.sendMessage({ type: 'DWF_SAVE_CHECKPOINT_FROM_POPUP', goal: 'AP Chem' }));
if (!saved?.ok) fail(`save failed: ${saved?.error}`);
else console.log(`✓ saved "${saved.checkpoint.anchor}" · problem ${saved.checkpoint.problemId} · prefix "${saved.checkpoint.prefix.slice(-24)}"`);
if (saved?.checkpoint?.answerRegion || saved?.checkpoint?.savedFrame) fail('save response leaked answer text or screenshot');
await sheet.close();

const id = saved.checkpoint.id;
const [a, b] = await panel.evaluate(
  (cid) => Promise.all([chrome.runtime.sendMessage({ type: 'DWF_RESTORE_FROM_POPUP', id: cid }), chrome.runtime.sendMessage({ type: 'DWF_RESTORE_FROM_POPUP', id: cid })]),
  id,
);
if (!a?.ok || !b?.ok) fail(`restore start failed: ${a?.error ?? b?.error}`);
if (a?.restoreId === b?.restoreId) fail('two restores shared one restoreId');
else console.log(`✓ two concurrent restores: ${a.restoreId} / ${b.restoreId}`);

const deadline = Date.now() + 20000;
let state;
while (Date.now() < deadline) {
  state = await panel.evaluate(() => chrome.storage.local.get(['dwf:pending', 'dwf:lastResult']));
  if (Object.keys(state['dwf:pending'] ?? {}).length === 0 && state['dwf:lastResult']?.status !== 'pending') break;
  await new Promise((r) => setTimeout(r, 300));
}
const pendingLeft = Object.keys(state?.['dwf:pending'] ?? {}).length;
if (pendingLeft) fail(`${pendingLeft} restore(s) still pending`);
else console.log('✓ both restores settled; nothing left pending');
const last = state?.['dwf:lastResult'];
if (last?.status !== 'verified') fail(`last result ${JSON.stringify(last)}`);
else console.log(`✓ last result verified · restoreId ${last.restoreId} · landing ${last.landing}`);

for (const p of context.pages()) {
  if (!p.url().includes('worksheet-a')) continue;
  const where = await p.evaluate(() => {
    const prob = document.querySelector('[data-problem-id="4b"] h3').getBoundingClientRect();
    const key = document.querySelector('[data-problem-id="4b-key"] h3').getBoundingClientRect();
    return { problemTop: Math.round(prob.top), keyTop: Math.round(key.top), vh: innerHeight };
  });
  const ok = where.problemTop >= 0 && where.problemTop < where.vh && !(where.keyTop >= 0 && where.keyTop < where.vh);
  if (!ok) fail(`tab landed wrong: ${JSON.stringify(where)}`);
  else console.log(`✓ restore tab shows Part II 4b (top ${where.problemTop}px), answer key offscreen (${where.keyTop}px)`);
}
// A stale verification reply (wrong restoreId) must be ignored, not recorded.
{
  const started = await panel.evaluate((cid) => chrome.runtime.sendMessage({ type: 'DWF_RESTORE_FROM_POPUP', id: cid }), id);
  const tabs = await panel.evaluate(() => chrome.tabs.query({}));
  const restoreTab = tabs[tabs.length - 1];
  const stale = await panel.evaluate(
    (tabId) =>
      chrome.scripting
        .executeScript({
          target: { tabId },
          func: () => chrome.runtime.sendMessage({ type: 'DWF_VERIFY_RESULT', restoreId: 'rs_stale_old', checkpointId: 'x', result: { ok: false, reason: 'no-match', candidates: 0, attempts: 1 } }),
        })
        .then((r) => r[0]?.result),
    restoreTab.id,
  );
  if (!stale?.stale) fail(`stale reply was not rejected: ${JSON.stringify(stale)}`);
  await new Promise((r) => setTimeout(r, 4000));
  const after = await panel.evaluate(() => chrome.storage.local.get('dwf:lastResult'));
  const lr = after['dwf:lastResult'];
  if (lr?.restoreId !== started.restoreId || lr?.status !== 'verified') fail(`after a stale reply, last result was ${JSON.stringify(lr)}`);
  else console.log('✓ stale verify reply ignored; the real restore still verified');
}

// Hash-routed page: the app's own hash survives save → restore.
{
  const routed = worksheetHtml => worksheetHtml;
  await context.route('https://hashapp.test/**', async (r) => {
    const res = await fetch(`${base}/demo/worksheet-a.html`);
    r.fulfill({ contentType: 'text/html', body: routed(await res.text()) });
  });
  const app3 = await context.newPage();
  await app3.goto('https://hashapp.test/course#/lesson/4');
  await app3.evaluate(() => {
    const h = document.querySelector('[data-problem-id="4b"] h3');
    h.scrollIntoView({ block: 'center' });
    const r = document.createRange();
    r.selectNodeContents(h);
    getSelection().removeAllRanges();
    getSelection().addRange(r);
  });
  await app3.bringToFront();
  const saved2 = await panel.evaluate(() => chrome.runtime.sendMessage({ type: 'DWF_SAVE_CHECKPOINT_FROM_POPUP', goal: 'AP Chem' }));
  await app3.close();
  const r2 = await panel.evaluate((cid) => chrome.runtime.sendMessage({ type: 'DWF_RESTORE_FROM_POPUP', id: cid }), saved2?.checkpoint?.id);
  await new Promise((r) => setTimeout(r, 4000));
  const lr = (await panel.evaluate(() => chrome.storage.local.get('dwf:lastResult')))['dwf:lastResult'];
  const keptHash = /^https:\/\/hashapp\.test\/course#\/lesson\/4:~:text=/.test(r2?.url ?? '');
  if (!keptHash || lr?.status !== 'verified') fail(`hash route lost or not verified: ${r2?.url} → ${lr?.status}`);
  else console.log(`✓ hash-routed page restored with its route kept (#/lesson/4) and verified (${lr.landing})`);
}

if (process.env.DWF_POPUP_SHOT) {
  await panel.setViewportSize({ width: 360, height: 560 });
  await panel.reload();
  await panel.waitForTimeout(600);
  await panel.screenshot({ path: process.env.DWF_POPUP_SHOT });
}

// Live screen path: the real active tab drives the focus engine.
{
  const app2 = await context.newPage();
  await app2.goto(`${base}/`, { waitUntil: 'load' });
  await app2.waitForFunction(() => !document.getElementById('live-btn').disabled, null, { timeout: 8000 }).catch(() => {});
  await app2.evaluate(() => {
    const sel = document.getElementById('mode-select');
    sel.value = 'screen-only';
    sel.dispatchEvent(new Event('change', { bubbles: true }));
    document.getElementById('live-btn').click();
  });
  const work = await context.newPage();
  await work.goto(`${base}/demo/worksheet-a.html`);
  await work.bringToFront();
  await work.waitForTimeout(3500);
  const onTask = await app2.textContent('#live-status');
  if (!/FOCUSED/.test(onTask ?? '')) fail(`live worksheet tab not FOCUSED: ${onTask}`);
  else console.log(`✓ live: worksheet tab → ${onTask.trim()}`);
  await context.route('https://distraction.test/**', (r) => r.fulfill({ contentType: 'text/html', body: '<title>Minecraft parkour compilation</title><h1>Best Minecraft parkour jumps 2026</h1><p>Funny moments, no commentary.</p>' }));
  const fun = await context.newPage();
  await fun.goto('https://distraction.test/video');
  await fun.bringToFront();
  const nudged = await app2.waitForFunction(() => !document.getElementById('nudge').hidden, null, { timeout: 15000 }).then(() => true).catch(() => false);
  const drift = await app2.textContent('#live-status');
  if (!nudged) fail(`live distraction tab did not nudge: ${drift}`);
  else console.log(`✓ live: distraction tab → nudge shown (${drift.trim()})`);
}
await context.close();
