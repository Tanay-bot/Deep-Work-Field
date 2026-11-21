import { defineConfig, type Plugin } from 'vite';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createReadStream, existsSync, mkdirSync, readdirSync, copyFileSync } from 'node:fs';
import type { IncomingMessage, ServerResponse } from 'node:http';

const here = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolve(here, '..');
const demoDir = resolve(projectRoot, 'demo');

function demoWorksheets(): Plugin {
  return {
    name: 'dwf-demo-worksheets',
    configureServer(server) {
      server.middlewares.use('/demo', (req: IncomingMessage, res: ServerResponse, next) => {
        const name = (req.url || '').split('?')[0].replace(/^\/+/, '');
        if (!/^[a-z0-9-]+\.(html|js)$/.test(name)) return next();
        const file = resolve(demoDir, name);
        if (!existsSync(file)) return next();
        res.setHeader('Content-Type', name.endsWith('.html') ? 'text/html; charset=utf-8' : 'text/javascript; charset=utf-8');
        createReadStream(file).pipe(res);
      });
    },
    closeBundle() {
      const out = resolve(projectRoot, 'web/dist/demo');
      mkdirSync(out, { recursive: true });
      for (const name of readdirSync(demoDir)) {
        if (name.endsWith('.html') || name.endsWith('.js')) {
          copyFileSync(resolve(demoDir, name), resolve(out, name));
        }
      }
    },
  };
}

const extraHosts = (process.env.__VITE_ADDITIONAL_SERVER_ALLOWED_HOSTS ?? '')
  .split(',')
  .map((host) => host.trim())
  .filter(Boolean);

export default defineConfig({
  root: resolve(projectRoot, 'web'),
  publicDir: resolve(projectRoot, 'web/public'),
  base: '/',
  plugins: [demoWorksheets()],
  server: {
    host: '0.0.0.0',
    port: 3000,
    strictPort: true,
    allowedHosts: extraHosts.length ? ['localhost', '127.0.0.1', ...extraHosts] : undefined,
    fs: { allow: [projectRoot] },
  },
  build: {
    outDir: resolve(projectRoot, 'web/dist'),
    emptyOutDir: true,
    target: 'es2022',
    sourcemap: false,
  },
});
