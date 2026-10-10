import { build } from 'esbuild';
import { fileURLToPath } from 'node:url';

await build({
  absWorkingDir: fileURLToPath(new URL('../', import.meta.url)),
  entryPoints: { 'app.bundle': 'public/app.js', 'share.bundle': 'public/share.js' },
  outdir: 'public',
  bundle: true,
  format: 'iife',
  target: ['safari12'],
  minify: true,
  legalComments: 'none'
});
