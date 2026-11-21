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
await context.close();
