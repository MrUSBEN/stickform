// Export: copies the publishable files from the working folder (dev/) into the public repository folder
// (public/, a sibling of dev/). Run it with `npm run export` in source/.
//   - Only an allow-list is copied; nothing else in dev/ is ever read for export.
//   - Files in public/ that are no longer in the allow-list are deleted (the .git folder is left alone).
//   - presets/, models/, objects/ and renders/ exist in public/ with only a .gitkeep (models/ and objects/ also
//     a short README); anything placed in them is ignored and removed from the export.
//   - Before anything is written, every text file (including the built stickform.html) is checked for personal
//     names, paths and e-mail addresses. A hit stops the export with the file, line and column. Fix the source,
//     not the check.
// The personal terms are not in this file (it is published too): they are read from publish/scrub-private.json,
// which is never exported.
import { readFileSync, writeFileSync, readdirSync, statSync, existsSync, mkdirSync, rmSync, rmdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const here = path.dirname(fileURLToPath(import.meta.url));
const SOURCE = path.dirname(here);
const DEV = path.dirname(SOURCE);
const OUTER = path.dirname(DEV);
const PUBLIC = path.join(OUTER, 'public');
const PUBLISH = path.join(DEV, 'publish');

if (!existsSync(PUBLISH)) {
  console.error(`Export stopped: ${PUBLISH} not found. This script only runs from the maintainer's dev/ + public/ folder layout.`);
  process.exit(2);
}

// ---- what goes -----------------------------------------------------------------------------------------------
const SOURCE_ITEMS = ['index.html', 'package.json', 'tsconfig.json', 'scripts', 'server', 'src', 'tests', 'vendor/three'];
const SKIP_DIRS = new Set(['node_modules', 'output', '.git']);                 // anywhere inside the items above
const SKIP_FILE = f => /\.(map|log)$/i.test(f) || f === 'Thumbs.db' || f === '.DS_Store';
const SKIP_REL = rel => /^source\/tests\/baselines\/renders\/(xbot|vrm)-[^/]*\.png$/.test(rel)   // renders of other people's characters
  || rel === 'source/tests/README.md';                                                          // replaced by publish/tests-README.md
const DOCS = {                       // publish/<file> -> public/<path>
  'README.md': 'README.md',
  'source-README.md': 'source/README.md',
  'tests-README.md': 'source/tests/README.md',
  'models-README.md': 'models/README.md',
  'objects-README.md': 'objects/README.md',
  '.gitignore': '.gitignore',
  '.gitattributes': '.gitattributes',
};
const KEEP_DIRS = ['presets', 'models', 'objects', 'renders'];
const TEXT_EXT = new Set(['.mjs', '.js', '.ts', '.json', '.html', '.md', '.txt', '.bat', '.css', '.svg', '.gitignore', '.gitkeep']);

const plan = new Map();              // relative path (forward slashes) -> { from } or { data }
const add = (rel, entry) => plan.set(rel, entry);
function walk(dir, rel, out) {
  for (const name of readdirSync(dir).sort()) {
    const full = path.join(dir, name), r = rel ? `${rel}/${name}` : name;
    if (statSync(full).isDirectory()) { if (!SKIP_DIRS.has(name)) walk(full, r, out); }
    else if (!SKIP_FILE(name)) out.push([r, full]);
  }
}
for (const f of ['stickform.html', 'Start Stickform.bat']) {
  const p = path.join(DEV, f);
  if (!existsSync(p)) { console.error(`Export stopped: ${f} is missing from dev/. Run npm run build first.`); process.exit(2); }
  add(f, { from: p });
}
for (const item of SOURCE_ITEMS) {
  const p = path.join(SOURCE, item);
  if (!existsSync(p)) { console.error(`Export stopped: source/${item} is missing.`); process.exit(2); }
  if (statSync(p).isDirectory()) { const l = []; walk(p, `source/${item}`, l); for (const [r, full] of l) if (!SKIP_REL(r)) add(r, { from: full }); }
  else add(`source/${item}`, { from: p });
}
for (const [src, dest] of Object.entries(DOCS)) {
  const p = path.join(PUBLISH, src);
  if (!existsSync(p)) { console.error(`Export stopped: publish/${src} is missing.`); process.exit(2); }
  add(dest, { from: p });
}
for (const d of KEEP_DIRS) add(`${d}/.gitkeep`, { data: Buffer.alloc(0) });

// ---- scrub check ---------------------------------------------------------------------------------------------
const privatePath = path.join(PUBLISH, 'scrub-private.json');
if (!existsSync(privatePath)) { console.error('Export stopped: publish/scrub-private.json is missing, so the personal-terms check cannot run.'); process.exit(2); }
const priv = JSON.parse(readFileSync(privatePath, 'utf8'));
const RULES = [
  ...priv.terms.map(t => ({ why: 'personal term', re: new RegExp(t.pattern, t.flags ?? '') })),
  { why: 'drive-letter path', re: /(?<![A-Za-z0-9_])[A-Za-z]:[\\/](?![\\/])/ },
  { why: 'Windows profile path', re: /\\Users\\[^\\\s"']+|\/Users\/[^/\s"']+|\/home\/[^/\s"']+/ },
];
const isText = (rel, buf) => TEXT_EXT.has(path.extname(rel).toLowerCase()) || rel.endsWith('.gitignore') || (!buf.subarray(0, 4096).includes(0) && !/\.(png|jpe?g|glb|vrm|gif|webp|ico|woff2?)$/i.test(rel));

const hits = [];
const contents = new Map();
for (const [rel, e] of plan) {
  const buf = e.data ?? readFileSync(e.from);
  contents.set(rel, buf);
  if (!isText(rel, buf)) continue;
  const text = buf.toString('utf8');
  const lines = text.split('\n');
  lines.forEach((line, i) => {
    for (const rule of RULES) {
      const m = rule.re.exec(line);
      if (m) hits.push(`${rel}:${i + 1}:${m.index + 1}  ${rule.why}  …${line.slice(Math.max(0, m.index - 30), m.index + 50).replace(/\s+/g, ' ')}…`);
    }
  });
  if (rel === 'source/package.json') {
    const walkJson = (v, k) => { if (typeof v === 'string') { if (/^([A-Za-z]:[\\/]|\/|\\\\)/.test(v)) hits.push(`${rel}  absolute path in "${k}": ${v}`); } else if (v && typeof v === 'object') for (const [kk, vv] of Object.entries(v)) walkJson(vv, kk); };
    walkJson(JSON.parse(text), '');
  }
}
if (hits.length) {
  console.error(`\nSCRUB CHECK FAILED: ${hits.length} problem${hits.length === 1 ? '' : 's'} found. Nothing was exported.\n`);
  for (const h of hits.slice(0, 60)) console.error('  ' + h);
  if (hits.length > 60) console.error(`  … and ${hits.length - 60} more`);
  console.error('\nFix the source (or the publish/ docs), rebuild, and run the export again.');
  process.exit(1);
}

// ---- write: mirror the plan into public/ -----------------------------------------------------------------------
mkdirSync(PUBLIC, { recursive: true });
let added = 0, changed = 0, removed = 0;
for (const [rel, buf] of contents) {
  const dest = path.join(PUBLIC, ...rel.split('/'));
  mkdirSync(path.dirname(dest), { recursive: true });
  if (existsSync(dest)) { if (readFileSync(dest).equals(buf)) continue; changed++; } else added++;
  writeFileSync(dest, buf);
}
(function prune(dir, rel) {
  for (const name of readdirSync(dir)) {
    const full = path.join(dir, name), r = rel ? `${rel}/${name}` : name;
    if (!rel && name === '.git') continue;
    if (statSync(full).isDirectory()) { prune(full, r); if (!readdirSync(full).length) rmdirSync(full); }
    else if (!plan.has(r)) { rmSync(full); removed++; }
  }
})(PUBLIC, '');
for (const d of KEEP_DIRS) mkdirSync(path.join(PUBLIC, d), { recursive: true });

// ---- verify what is there ---------------------------------------------------------------------------------------
const left = [];
(function list(dir, rel) {
  for (const name of readdirSync(dir)) {
    const full = path.join(dir, name), r = rel ? `${rel}/${name}` : name;
    if (!rel && name === '.git') continue;
    if (statSync(full).isDirectory()) list(full, r); else left.push(r);
  }
})(PUBLIC, '');
const stray = left.filter(r => !plan.has(r));
const never = left.filter(r => /^(archive|design|renders\/(?!\.gitkeep$)|models\/(?!\.gitkeep$|README\.md$)|objects\/(?!\.gitkeep$|README\.md$)|presets\/(?!\.gitkeep$))/.test(r) || r === 'stickform-handoff.md' || /node_modules|tests\/output/.test(r));
if (stray.length || never.length || left.length !== plan.size) {
  console.error('Export check failed: public/ does not match the plan.', { stray, never });
  process.exit(1);
}
console.log(`Exported ${plan.size} files to ${PUBLIC}: ${added} added, ${changed} changed, ${removed} removed. Scrub check passed.`);
