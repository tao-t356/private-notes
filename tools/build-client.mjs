import { build } from 'esbuild';
import { fileURLToPath } from 'node:url';

await build({
  absWorkingDir: fileURLToPath(new URL('../', import.meta.url)),
  entryPoints: ['public/app.js'],
  outfile: 'public/app.bundle.js',
  bundle: true,
  format: 'iife',
  target: ['safari12'],
  minify: true,
  legalComments: 'none'
});
