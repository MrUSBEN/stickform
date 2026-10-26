// Build: bundle src/main.ts (with the vendored three.js) and inline it into index.html, producing one
// self-contained page at ../stickform.html that opens straight from disk (no server needed).
import * as esbuild from 'esbuild';
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const vendor = path.join(root, 'vendor', 'three');
// Resolve "three" and "three/addons/..." to the vendored copy (three.js r186, MIT licence, see vendor/three/LICENSE).
const threeVendor = {
  name: 'three-vendor',
  setup(b) {
    b.onResolve({ filter: /^three$/ }, () => ({ path: path.join(vendor, 'build', 'three.module.js') }));
    b.onResolve({ filter: /^three\/addons\// }, a => ({ path: path.join(vendor, 'examples', 'jsm', a.path.slice('three/addons/'.length)) }));
  },
};
const result = await esbuild.build({
  entryPoints: [path.join(root, 'src', 'main.ts')],
  bundle: true, minify: true, format: 'iife', target: 'es2020', write: false,
  plugins: [threeVendor], legalComments: 'none',
  banner: { js: '/* Stickform. Includes three.js r186 (MIT licence, copyright 2010-2025 three.js authors). */' },
});
const js = result.outputFiles[0].text.replace(/<\/script/gi, '<\\/script');
const html = readFileSync(path.join(root, 'index.html'), 'utf8').replace('<script>/*APP*/</script>', () => `<script>${js}</script>`);
const out = path.join(root, '..', 'stickform.html');
writeFileSync(out, html);
console.log(`wrote ${out} (${(html.length / 1024).toFixed(0)} KB)`);
