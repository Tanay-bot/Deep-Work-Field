// Shipped build (no site access at install): live mode must still nudge from tab titles.
//   npm run build:extension && npm run dev, then: node tools/extension-noperm-e2e.mjs
import { createRequire } from 'node:module';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
const require = createRequire(import.meta.url);
const { chromium } = require('playwright');
const ext = new URL('../extension/dist', import.meta.url).pathname;
const ctx = await chromium.launchPersistentContext(mkdtempSync(join(tmpdir(), 'dwf-t-')), { headless: true, channel: 'chromium', args: [`--disable-extensions-except=${ext}`, `--load-extension=${ext}`] });
let [w] = ctx.serviceWorkers(); if (!w) w = await ctx.waitForEvent('serviceworker');
const app = await ctx.newPage();
await app.goto((process.env.DWF_BASE ?? 'http://localhost:3000') + '/');
await app.waitForFunction(() => !document.getElementById('live-btn').disabled, null, { timeout: 8000 });
await app.evaluate(() => { const s = document.getElementById('mode-select'); s.value = 'screen-only'; s.dispatchEvent(new Event('change', { bubbles: true })); document.getElementById('live-btn').click(); });
await ctx.route('https://distraction.test/**', (r) => r.fulfill({ contentType: 'text/html', body: '<title>Minecraft parkour compilation</title><h1>jumps</h1>' }));
const fun = await ctx.newPage(); await fun.goto('https://distraction.test/v'); await fun.bringToFront();
const nudged = await app.waitForFunction(() => !document.getElementById('nudge').hidden, null, { timeout: 20000 }).then(() => true).catch(() => false);
if (!nudged) process.exitCode = 1;
console.log(nudged ? '✓' : '✗', 'shipped build, no site access: distraction tab →', (await app.textContent('#live-status')).trim());
const perms = await w.evaluate(() => chrome.permissions.getAll());
console.log('granted origins at install:', JSON.stringify(perms.origins));
await ctx.close();
