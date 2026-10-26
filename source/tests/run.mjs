// Stickform test runner.
//   node tests/run.mjs              run everything against ../stickform.html
//   node tests/run.mjs --update     accept the current results as the new baselines
//   node tests/run.mjs logic ui     run only some groups (logic, ui, render)
// Prints a short summary; full results go to tests/output/report.txt.
import { writeFileSync, readdirSync, rmSync } from 'node:fs';
import path from 'node:path';
import { launch, Checks, OUT, missingModels } from './lib.mjs';
import { logicTests } from './logic.mjs';
import { uiTests, folderTests, serverTests } from './ui.mjs';
import { renderTests } from './render.mjs';

const args = process.argv.slice(2);
const update = args.includes('--update');
const only = args.filter(a => !a.startsWith('--'));
const want = g => !only.length || only.includes(g);

for (const f of readdirSync(OUT)) if (f.startsWith('FAIL-') || f === 'report.txt') rmSync(path.join(OUT, f));
const C = new Checks();
const absent = missingModels();
if (absent.length) console.log(`Note: models/ is missing ${absent.join(', ')}.
Checks that need them are skipped and listed as SKIPPED below; everything else, including the built-in mannequin, is tested.
Optional sample characters: see models/README.md.
`);
const t0 = Date.now();
const browser = await launch();
const groups = [['logic', logicTests], ['ui', async (b, C) => { await uiTests(b, C); await folderTests(b, C); await serverTests(b, C); }], ['render', renderTests]];
try {
  for (const [g, fn] of groups) {
    if (!want(g)) continue;
    try { await fn(browser, C, update); }
    catch (e) { C.section(g); C.ok(false, `${g} tests stopped early`, String(e.stack || e).split('\n').slice(0, 3).join(' ')); }
  }
} finally { await browser.close(); }

// Report
const lines = [];
let last = '';
for (const r of C.results) {
  if (r.group !== last) { lines.push('', `## ${r.group}`); last = r.group; }
  lines.push(`${r.skipped ? 'SKIP' : r.pass ? 'pass' : 'FAIL'}  ${r.name}${r.skipped ? `  (skipped: ${r.skipped})` : ''}${r.detail ? `  (${r.detail})` : ''}`);
}
const skipped = C.results.filter(r => r.skipped), fail = C.failed, secs = ((Date.now() - t0) / 1000).toFixed(0);
const head = `Stickform tests, ${new Date().toISOString()}${update ? ' (baselines updated)' : ''}\n${C.results.length - fail.length - skipped.length} passed, ${fail.length} failed, ${skipped.length} skipped, ${secs} s`;
writeFileSync(path.join(OUT, 'report.txt'), head + '\n' + lines.join('\n') + '\n');

// Short console summary: counts per group, then only the failures.
const byGroup = new Map();
for (const r of C.results) { const g = byGroup.get(r.group) || [0, 0]; if (!r.skipped) g[r.pass ? 0 : 1]++; byGroup.set(r.group, g); }
console.log(head.split('\n')[1] + (update ? ' (baselines updated)' : ''));
for (const [g, [p, f]] of byGroup) console.log(`  ${f ? 'FAIL' : 'ok  '}  ${g}: ${p}/${p + f}`);
if (fail.length) {
  console.log('\nFailures:');
  for (const r of fail.slice(0, 40)) console.log(`  - [${r.group}] ${r.name}${r.detail ? `: ${r.detail}` : ''}`);
  if (fail.length > 40) console.log(`  … and ${fail.length - 40} more in tests/output/report.txt`);
}
console.log('\nReport: tests/output/report.txt · contact sheet: tests/output/contact-sheet.png');
process.exit(fail.length ? 1 : 0);
