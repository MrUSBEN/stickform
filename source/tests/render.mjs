// Render checks: every preset rendered on the mannequin (three-quarter) and on sample characters (front), compared
// pixel by pixel with saved baseline images. Also writes contact sheets to tests/output/ for a quick visual check.
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { BASE, OUT, openApp, loadModel } from './lib.mjs';

const SIZE = 320;
/** A pixel counts as changed if any channel differs by more than this. */
const PIXEL_TOL = 48;
/** At most this share of pixels may change. Software rendering differs slightly between machines. */
const SHARE_TOL = 0.006;

const SETS = [
  { rig: 'mannequin', file: null, cam: 'q' },
  { rig: 'xbot', file: 'Xbot.glb', cam: 'front' },
  { rig: 'vrm', file: 'VRM1_Constraint_Twist_Sample.vrm', cam: 'front' },
];
const slug = t => t.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');

export async function renderTests(browser, C, update) {
  const { page, ctx, errors } = await openApp(browser);
  C.section('Renders (compared with baseline images)');
  const sheet = [];
  let rigIndex = 0;
  for (const set of SETS) {
    if (set.file) {
      if (!(await loadModel(page, set.file))) { C.skip(`${set.rig} renders compared with baseline images`, `models/${set.file} is missing`); continue; }
      rigIndex++;
    }
    const shots = await page.evaluate(([ri, cam, size]) => {
      const s = window.stickform;
      s.setRig(s.rigs[ri]);
      const out = [];
      for (const d of s.BUILTIN) {
        s.loadPose(d);
        Object.assign(s.out, { w: size, h: size, background: 'white', shadow: true, preset: cam });
        s.outVP.applyPreset(cam);
        out.push({ name: d.name, url: s.outVP.renderPNG() });
      }
      return out;
    }, [set.file ? rigIndex : 0, set.cam, SIZE]);
    for (const sh of shots) {
      const file = path.join(BASE, 'renders', `${set.rig}-${slug(sh.name)}.png`);
      const cur = Buffer.from(sh.url.split(',')[1], 'base64');
      sheet.push({ label: `${set.rig} · ${sh.name}`, url: sh.url });
      if (update || !existsSync(file)) { writeFileSync(file, cur); continue; }
      const r = await page.evaluate(async ([a, b, tol]) => {
        const load = src => new Promise(res => { const i = new Image(); i.onload = () => res(i); i.src = src; });
        const [ia, ib] = await Promise.all([load(a), load('data:image/png;base64,' + b)]);
        if (ia.width !== ib.width || ia.height !== ib.height) return { share: 1, diffUrl: null };
        const w = ia.width, h = ia.height, c = document.createElement('canvas'); c.width = w; c.height = h;
        const x = c.getContext('2d');
        const px = img => { x.clearRect(0, 0, w, h); x.drawImage(img, 0, 0); return x.getImageData(0, 0, w, h); };
        const A = px(ia).data, B = px(ib).data, D = x.createImageData(w, h);
        let n = 0;
        for (let i = 0; i < A.length; i += 4) {
          const m = Math.max(Math.abs(A[i] - B[i]), Math.abs(A[i + 1] - B[i + 1]), Math.abs(A[i + 2] - B[i + 2]), Math.abs(A[i + 3] - B[i + 3]));
          const bad = m > tol; if (bad) n++;
          D.data[i] = bad ? 230 : A[i] * 0.3 + 170; D.data[i + 1] = bad ? 40 : A[i + 1] * 0.3 + 170; D.data[i + 2] = bad ? 40 : A[i + 2] * 0.3 + 170; D.data[i + 3] = 255;
        }
        x.putImageData(D, 0, 0);
        return { share: n / (w * h), diffUrl: c.toDataURL('image/png') };
      }, [sh.url, readFileSync(file).toString('base64'), PIXEL_TOL]);
      const ok = C.ok(r.share <= SHARE_TOL, `${set.rig} · ${sh.name}`, `${(r.share * 100).toFixed(2)}% of pixels changed (allowed ${(SHARE_TOL * 100).toFixed(1)}%); see tests/output/`);
      if (!ok) {
        writeFileSync(path.join(OUT, `FAIL-${set.rig}-${slug(sh.name)}-now.png`), cur);
        if (r.diffUrl) writeFileSync(path.join(OUT, `FAIL-${set.rig}-${slug(sh.name)}-diff.png`), Buffer.from(r.diffUrl.split(',')[1], 'base64'));
      }
    }
  }
  // Contact sheet: one row per character, one column per preset.
  const sheetUrl = await page.evaluate(async items => {
    const load = src => new Promise(res => { const i = new Image(); i.onload = () => res(i); i.src = src; });
    const cols = 10, cell = 180, lab = 22, rows = Math.ceil(items.length / cols);
    const c = document.createElement('canvas'); c.width = cols * cell; c.height = rows * (cell + lab);
    const x = c.getContext('2d'); x.fillStyle = '#ffffff'; x.fillRect(0, 0, c.width, c.height);
    x.font = '11px sans-serif'; x.fillStyle = '#333';
    for (let i = 0; i < items.length; i++) {
      const im = await load(items[i].url), cx = (i % cols) * cell, cy = Math.floor(i / cols) * (cell + lab);
      x.drawImage(im, cx, cy, cell, cell); x.fillText(items[i].label.slice(0, 32), cx + 4, cy + cell + 15);
    }
    return c.toDataURL('image/png');
  }, sheet);
  writeFileSync(path.join(OUT, 'contact-sheet.png'), Buffer.from(sheetUrl.split(',')[1], 'base64'));
  C.section('Render page errors');
  C.ok(errors.length === 0, 'no errors in the browser console', errors.slice(0, 5).join(' | '));
  await ctx.close();
}
