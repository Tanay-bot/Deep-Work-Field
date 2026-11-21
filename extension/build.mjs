import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { build } from 'esbuild';
import { cpSync, existsSync, mkdirSync, rmSync } from 'node:fs';
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
cpSync(resolve(here, 'pdf'), resolve(out, 'pdf'), { recursive: true });

// The zip holds one top-level folder, so "unzip → Load unpacked → pick the folder" just works.
// A copy is published with the web app so judges can download it from the demo site.
const zipName = resolve(root, 'extension', 'deep-work-field-extension.zip');
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
if (existsSync(zipName)) {
  cpSync(zipName, publicZip);
  console.log(`published: ${publicZip}`);
}

if (!existsSync(resolve(out, 'background.js'))) {
  throw new Error('Extension build did not produce background.js');
}
console.log(`Extension built at ${out}`);
