// Docs check: warns when the docs have fallen behind the work. Run it with `npm run docs-check` in source/.
//   1. Source files newer than the handoff (stickform-handoff.md, whose top session-log entry is written last in a session).
//   2. Files in publish/ older than the matching dev README.
// Warnings only: exit code 0, unless --strict is given (then 1 when anything is flagged).
// Like the export, this only runs from the maintainer's dev/ + public/ folder layout.
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const here = path.dirname(fileURLToPath(import.meta.url));
const SOURCE = path.dirname(here);
const DEV = path.dirname(SOURCE);
const HANDOFF = path.join(DEV, 'stickform-handoff.md');
const PUBLISH = path.join(DEV, 'publish');
const strict = process.argv.includes('--strict');

if (!existsSync(PUBLISH) || !existsSync(HANDOFF)) {
  console.error('Docs check skipped: needs the maintainer\'s dev/ folder (publish/ and the handoff).');
  process.exit(2);
}

const mtime = p => statSync(p).mtimeMs;
const rel = p => path.relative(DEV, p).split(path.sep).join('/');
const when = ms => new Date(ms).toISOString().slice(0, 16).replace('T', ' ');
const SKIP_DIRS = new Set(['node_modules', 'output', 'baselines', 'vendor', '.git']);
const SKIP_FILE = f => /\.(map|log|md)$/i.test(f) || f === 'package-lock.json';

function walk(dir, out) {
  for (const name of readdirSync(dir)) {
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) { if (!SKIP_DIRS.has(name)) walk(full, out); }
    else if (!SKIP_FILE(name)) out.push(full);
  }
  return out;
}

let warnings = 0;

// 1. Source newer than the session log.
const logTime = mtime(HANDOFF);
const sources = [path.join(SOURCE, 'index.html'), path.join(SOURCE, 'package.json'), path.join(SOURCE, 'tsconfig.json')];
for (const d of ['src', 'server', 'scripts', 'tests']) walk(path.join(SOURCE, d), sources);
const newer = sources.filter(f => existsSync(f) && mtime(f) > logTime + 1000).sort((a, b) => mtime(b) - mtime(a));
if (newer.length) {
  warnings++;
  console.warn(`WARN  ${newer.length} source file(s) are newer than the handoff (last saved ${when(logTime)}). Add a session-log entry:`);
  for (const f of newer.slice(0, 10)) console.warn(`        ${rel(f)}  (${when(mtime(f))})`);
  if (newer.length > 10) console.warn(`        ... and ${newer.length - 10} more`);
}

// The top session-log entry should be dated; show it so a stale one is easy to spot.
const text = readFileSync(HANDOFF, 'utf8');
const logAt = text.indexOf('**Session log');
const top = logAt < 0 ? null : /^- ([A-Z][a-z]+ \d{1,2}, \d{4}[^:]*):/m.exec(text.slice(logAt));
if (!top) { warnings++; console.warn('WARN  No dated session-log entry found in the handoff (section 16).'); }
else console.log(`Top session-log entry: ${top[1]}`);

// 2. publish/ files older than the matching dev README.
const PAIRS = [
  ['README.md', 'publish/README.md'],
  ['source/README.md', 'publish/source-README.md'],
  ['source/tests/README.md', 'publish/tests-README.md'],
];
for (const [devRel, pubRel] of PAIRS) {
  const d = path.join(DEV, devRel), p = path.join(DEV, pubRel);
  if (!existsSync(d) || !existsSync(p)) { warnings++; console.warn(`WARN  Missing file in the pair ${devRel} / ${pubRel}.`); continue; }
  if (mtime(p) < mtime(d) - 1000) {
    warnings++;
    console.warn(`WARN  ${pubRel} (${when(mtime(p))}) is older than ${devRel} (${when(mtime(d))}). Carry the change over to the public text.`);
  }
}

console.log(warnings ? `Docs check: ${warnings} warning(s).` : 'Docs check: docs are up to date.');
process.exit(strict && warnings ? 1 : 0);
