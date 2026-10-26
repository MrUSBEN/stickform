// Shared helpers for the Stickform test suite: browser launch, page setup, model loading, a tiny check collector.
import { createRequire } from 'node:module';
import { readFileSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const TESTS = path.dirname(fileURLToPath(import.meta.url));
export const SOURCE = path.dirname(TESTS);
export const PROJECT = path.dirname(SOURCE);
export const APP = path.join(PROJECT, 'stickform.html');
export const MODELS = path.join(PROJECT, 'models');
export const PRESETS = path.join(PROJECT, 'presets');
export const BASE = path.join(TESTS, 'baselines');
export const OUT = path.join(TESTS, 'output');
for (const d of [BASE, OUT, path.join(BASE, 'renders')]) mkdirSync(d, { recursive: true });

export function playwright() {
  const require = createRequire(import.meta.url);
  try { return require('playwright'); }
  catch {
    console.error('Playwright is not installed. In the source folder run:\n  npm install\n  npx playwright install chromium');
    process.exit(2);
  }
}

/** Software WebGL everywhere, so renders match closely between machines. */
export async function launch() {
  const { chromium } = playwright();
  return chromium.launch({ args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--disable-gpu-sandbox'] });
}

/** A fresh page on the built app (fresh browser storage), with console errors collected. */
export async function openApp(browser, size = { width: 1440, height: 900 }) {
  if (!existsSync(APP)) throw new Error(`App not built: ${APP}. Run npm run build.`);
  const ctx = await browser.newContext({ viewport: size, acceptDownloads: true });
  await ctx.addInitScript(() => { window.stickformNoLock = true; }); // headless pointer lock reports no real movement
  const page = await ctx.newPage();
  const errors = [];
  page.on('console', m => {
    if (m.type() !== 'error') return;
    const t = m.text();
    if (/fonts\.g|ERR_TUNNEL|ERR_NAME_NOT_RESOLVED|ERR_INTERNET_DISCONNECTED|Failed to load resource/.test(t)) return; // web fonts offline
    errors.push(t);
  });
  page.on('pageerror', e => errors.push('page error: ' + e.message));
  await page.goto(pathToFileURL(APP).href);
  await page.waitForFunction(() => !!window.stickform);
  await page.waitForTimeout(300);
  return { page, ctx, errors };
}

export const MODEL_FILES = ['Xbot.glb', 'Soldier.glb', 'Michelle.glb', 'VRM1_Constraint_Twist_Sample.vrm'];

/** Which of the optional sample characters are not in models/ (the repository ships none; see models/README.md). */
export function missingModels() { return MODEL_FILES.filter(f => !existsSync(path.join(MODELS, f))); }

/** A starter pose from src/presets.json as pose-file text, so tests do not depend on what is in presets/. */
export function starterText(id) {
  const all = JSON.parse(readFileSync(path.join(SOURCE, 'src', 'presets.json'), 'utf8'));
  return JSON.stringify(all.find(d => d.id === id), null, 1);
}

/** Load a model file from the project's models folder into the page. Returns false if it is missing. */
export async function loadModel(page, file) {
  const f = path.join(MODELS, file);
  if (!existsSync(f)) return false;
  const b64 = readFileSync(f).toString('base64');
  await page.evaluate(async ([b64, name]) => {
    const bin = Uint8Array.from(atob(b64), c => c.charCodeAt(0));
    await window.stickform.loadModelBuffer(bin.buffer, name);
  }, [b64, file]);
  return true;
}

/** Collects pass/fail results by group. */
export class Checks {
  constructor() { this.results = []; this.group = ''; }
  section(name) { this.group = name; }
  ok(cond, name, detail = '') { this.results.push({ group: this.group, name, pass: !!cond, detail: cond ? '' : detail }); return !!cond; }
  /** A check that cannot run here (a sample character is not in models/, presets/ is empty). Counts as passed, listed as skipped. */
  skip(name, why) { this.results.push({ group: this.group, name, pass: true, skipped: why, detail: '' }); return true; }
  eq(a, b, name) { const p = JSON.stringify(a) === JSON.stringify(b); return this.ok(p, name, `expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`); }
  get failed() { return this.results.filter(r => !r.pass); }
}

export function readJSON(f, d = null) { try { return JSON.parse(readFileSync(f, 'utf8')); } catch { return d; } }
export function writeJSON(f, o) { writeFileSync(f, JSON.stringify(o, null, 1) + '\n'); }

/** Connect the app to an in-memory stand-in for the project folder (the real folder picker needs a person).
 *  `files`: { 'presets/x.json': text | { b64 } }. Read back with readFake. */
export async function useFakeFolder(page, files = {}) {
  await page.evaluate(async files => {
    class FH {
      constructor(name, data) { this.kind = 'file'; this.name = name; this.data = data; this.mtime = Date.now(); }
      async getFile() { return new File([this.data], this.name, { lastModified: this.mtime }); }
      async createWritable() { const self = this, parts = []; return { async write(d) { parts.push(d); }, async close() { self.data = new Blob(parts); self.mtime = Date.now(); } }; }
    }
    class DH {
      constructor(name) { this.kind = 'directory'; this.name = name; this.items = new Map(); }
      async getDirectoryHandle(n, o = {}) { let h = this.items.get(n); if (!h) { if (!o.create) throw new DOMException('not found', 'NotFoundError'); h = new DH(n); this.items.set(n, h); } return h; }
      async getFileHandle(n, o = {}) { let h = this.items.get(n); if (!h) { if (!o.create) throw new DOMException('not found', 'NotFoundError'); h = new FH(n, new Blob([])); this.items.set(n, h); } return h; }
      async removeEntry(n) { this.items.delete(n); }
      async *entries() { for (const e of this.items) yield e; }
    }
    const root = new DH('Stickform project');
    for (const [path, content] of Object.entries(files)) {
      const [d, f] = path.split('/');
      const fh = await (await root.getDirectoryHandle(d, { create: true })).getFileHandle(f, { create: true });
      fh.data = content && content.b64 ? new Blob([Uint8Array.from(atob(content.b64), c => c.charCodeAt(0))]) : new Blob([content]);
    }
    window.__root = root;
    await window.stickform.project.use(root);
  }, files);
}
/** Files in a stand-in folder subfolder: { name: size }. */
export async function listFake(page, dir) {
  return page.evaluate(async dir => { const d = window.__root.items.get(dir); const o = {}; if (d) for (const [n, h] of d.items) o[n] = h.data.size; return o; }, dir);
}
export async function readFake(page, path) {
  return page.evaluate(async path => { const [d, f] = path.split('/'); const h = window.__root.items.get(d)?.items.get(f); return h ? await h.data.text() : null; }, path);
}
