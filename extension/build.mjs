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

const zipName = resolve(root, 'extension', 'deep-work-field-extension.zip');
rmSync(zipName, { force: true });
try {
  execFileSync('zip', ['-qr', zipName, '.'], { cwd: out, stdio: 'ignore' });
  console.log(`zip: ${zipName}`);
} catch {
  try {
    execFileSync('python3', ['-m', 'zipfile', '-c', zipName, '.'], { cwd: out, stdio: 'ignore' });
    console.log(`zip (python): ${zipName}`);
  } catch {
    console.log('zip not created (no zip or python3). Load extension/dist unpacked.');
  }
}

if (!existsSync(resolve(out, 'background.js'))) {
  throw new Error('Extension build did not produce background.js');
}
console.log(`Extension built at ${out}`);
