import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { build } from 'esbuild';
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..');
const out = resolve(here, 'dist');

rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });

await build({
  entryPoints: {
    background: resolve(here, 'src/background.ts'),
    content: resolve(here, 'src/content.ts'),
    popup: resolve(here, 'src/popup.ts'),
  },
  bundle: true,
  outdir: out,
  format: 'iife',
  target: ['chrome114'],
  sourcemap: false,
  minify: false,
  logLevel: 'info',
});

for (const file of ['manifest.json', 'popup.html', 'popup.css']) {
  cpSync(resolve(here, file), resolve(out, file));
}
// Test-only build: headless Chromium cannot click a permission prompt, so the
// e2e build pre-grants site access. It is never zipped or published.
const e2e = process.env.DWF_E2E === '1';
if (e2e) {
  const manifestPath = resolve(out, 'manifest.json');
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  manifest.host_permissions = ['<all_urls>'];
  writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
  console.log('E2E build: site access pre-granted (not for distribution).');
}
cpSync(resolve(here, 'pdf'), resolve(out, 'pdf'), { recursive: true });
rmSync(resolve(out, 'pdf', 'README.md'), { force: true });
// PDF route: PDF.js is ESM with top-level await, so it is bundled as a module.
await build({
  entryPoints: { 'pdf/pdf': resolve(here, 'src/pdf.ts') },
  bundle: true,
  outdir: out,
  format: 'esm',
  target: ['chrome114'],
  logLevel: 'warning',
});
const pdfjsDir = resolve(root, 'node_modules/pdfjs-dist');
cpSync(resolve(pdfjsDir, 'build/pdf.worker.min.mjs'), resolve(out, 'pdf/pdf.worker.min.mjs'));
cpSync(resolve(pdfjsDir, 'web/pdf_viewer.css'), resolve(out, 'pdf/pdf_viewer.css'));

// The zip holds one top-level folder, so "unzip → Load unpacked → pick the folder" just works.
// A copy is published with the web app so judges can download it from the demo site.
const zipName = resolve(root, 'extension', e2e ? 'deep-work-field-extension-e2e.zip' : 'deep-work-field-extension.zip');
const publicZip = resolve(root, 'web', 'public', 'deep-work-field-extension.zip');
const stage = mkdtempSync(resolve(tmpdir(), 'dwf-zip-'));
cpSync(out, resolve(stage, 'deep-work-field-extension'), { recursive: true });
rmSync(zipName, { force: true });
try {
  execFileSync('zip', ['-qrX', zipName, 'deep-work-field-extension'], { cwd: stage, stdio: 'ignore' });
  console.log(`zip: ${zipName}`);
} catch {
  try {
    execFileSync('python3', ['-m', 'zipfile', '-c', zipName, 'deep-work-field-extension'], { cwd: stage, stdio: 'ignore' });
    console.log(`zip (python): ${zipName}`);
  } catch {
    console.log('zip not created (no zip or python3). Load extension/dist unpacked.');
  }
}
rmSync(stage, { recursive: true, force: true });
if (existsSync(zipName) && !e2e) {
  cpSync(zipName, publicZip);
  console.log(`published: ${publicZip}`);
}

if (!existsSync(resolve(out, 'background.js'))) {
  throw new Error('Extension build did not produce background.js');
}
console.log(`Extension built at ${out}`);
