// Interface checks: click through the app like a user and check what happens.
import { readFileSync } from 'node:fs';
import { openApp, loadModel, useFakeFolder, listFake, readFake, MODELS, starterText } from './lib.mjs';
import { existsSync, mkdtempSync, mkdirSync, copyFileSync, writeFileSync, readdirSync, rmSync } from 'node:fs';
import { fork } from 'node:child_process';
import os from 'node:os';
import http from 'node:http';
import { APP, SOURCE } from './lib.mjs';
import path from 'node:path';


export async function uiTests(browser, C) {
  const { page: p, ctx, errors } = await openApp(browser);
  const ev = (fn, arg) => p.evaluate(fn, arg);
  const tags = () => ev(() => window.stickform.sketch.strokes.map(s => s.tag).join(','));
  const pressed = sel => p.getAttribute(sel, 'aria-pressed');

  // ---- layout
  C.section('Layout');
  for (const [w, h] of [[1440, 900], [1280, 720], [1920, 1080]]) {
    await p.setViewportSize({ width: w, height: h }); await p.waitForTimeout(250);
    const sc = await ev(() => [document.documentElement.scrollWidth, document.documentElement.scrollHeight, innerWidth, innerHeight]);
    C.ok(sc[0] <= sc[2] && sc[1] <= sc[3], `no page scroll at ${w} × ${h}`, `page is ${sc[0]} × ${sc[1]}`);
  }
  await p.setViewportSize({ width: 1440, height: 900 }); await p.waitForTimeout(250);
  C.eq(await p.locator('#thumbs .thumb').count(), 10, 'every preset in the inspector thumbnails');
  C.ok(await ev(() => { const t = document.getElementById('thumbs'); return t.scrollHeight > t.clientHeight + 20 && getComputedStyle(t).overflowY === 'auto'; }), 'the thumbnails scroll');
  const wDefault = (await p.locator('#vp-sketch').boundingBox()).width;
  C.ok(await p.isVisible('#vp-sketch') && await p.isVisible('#vp-output') && !(await p.isVisible('#vp-orbit')), 'sketch and 3D viewports open, orbit closed');

  // ---- presets
  C.section('Presets');
  await p.click('#thumbs .thumb:nth-child(3)'); await p.waitForTimeout(150);
  C.eq(await p.textContent('#pnametext'), 'High kick', 'clicking a thumbnail loads that pose and names it');
  C.eq(await p.getAttribute('#thumbs .thumb:nth-child(3)', 'aria-current'), 'true', 'loaded thumbnail is marked current');
  C.ok(await p.isHidden('#pedited'), 'a freshly loaded pose is not marked edited');
  await p.click('#thumbs .thumb:nth-child(1)'); await p.waitForTimeout(150);

  // ---- tools
  C.section('Tool rail and shortcuts');
  for (const [k, t] of [['v', 'select'], ['e', 'erase'], ['b', 'brush'], ['p', 'pen']]) {
    await p.keyboard.press(k);
    C.eq(await pressed(`.rail [data-tool="${t}"]`), 'true', `key ${k.toUpperCase()} picks ${t}`);
  }

  // ---- selection, retag, swap, delete, undo, redo
  C.section('Selection pill and retag');
  const before = await tags();
  const armPt = await ev(() => {
    const s = window.stickform, st = s.sketch.strokes.find(x => x.tag === 'armL');
    const q = st.pts[Math.floor(st.pts.length * 0.7)], px = s.canvas.toPx(q), r = document.getElementById('sk').getBoundingClientRect();
    return [r.left + px.x, r.top + px.y];
  });
  await p.keyboard.press('v'); await p.mouse.click(armPt[0], armPt[1]); await p.waitForTimeout(100);
  C.ok(await p.isVisible('#pill'), 'clicking a stroke shows the selection pill');
  C.eq(await p.textContent('#pillname'), 'Arm left', 'pill names the stroke\'s tag');
  await p.click('#pillretag');
  C.ok(await p.isVisible('#retagpop'), 'Retag opens the picker');
  C.eq(await p.locator('#retagpop .rt').count(), 9, 'picker offers nine tags');
  await p.keyboard.press('2'); await p.waitForTimeout(100);
  C.eq(await p.textContent('#pillname'), 'Arm right', 'number key retags the selected stroke');
  const after = await tags();
  C.ok(after.includes('armL') && after.includes('armR'), 'taking a held tag swaps the two strokes', after);
  await p.keyboard.press('Control+z');
  C.eq(await tags(), before, 'undo restores the tags');
  await p.keyboard.press('Control+y');
  C.eq(await tags(), after, 'redo reapplies the retag');
  await p.keyboard.press('Control+z');
  await p.mouse.click(armPt[0], armPt[1]); await p.keyboard.press('s'); await p.waitForTimeout(100);
  C.eq(await p.textContent('#pillname'), 'Arm right', 'S swaps left and right on the selected limb');
  await p.keyboard.press('Control+z');
  await p.mouse.click(armPt[0], armPt[1]);
  const n0 = await ev(() => window.stickform.sketch.strokes.length);
  await p.keyboard.press('Delete');
  C.eq(await ev(() => window.stickform.sketch.strokes.length), n0 - 1, 'Delete removes the selected stroke');
  C.ok(await p.isHidden('#pill'), 'pill hides when nothing is selected');
  await p.keyboard.press('Control+z');
  C.eq(await ev(() => window.stickform.sketch.strokes.length), n0, 'undo brings the stroke back');
  C.ok(await p.isVisible('#pedited'), 'changes mark the pose as edited');

  // ---- drawing a figure from scratch
  C.section('Drawing');
  await p.click('#clear');
  C.eq(await ev(() => window.stickform.sketch.strokes.length), 0, 'Clear empties the sketch');
  C.ok((await p.textContent('#status')).includes('Draw a head'), 'empty sketch shows the starting hint');
  await p.keyboard.press('p');
  const r = await p.locator('#sk').boundingBox();
  const P = (x, y) => [r.x + r.width * x, r.y + r.height * y];
  const stroke = async pts => { await p.mouse.move(...P(...pts[0])); await p.mouse.down(); for (const q of pts.slice(1)) await p.mouse.move(...P(...q), { steps: 6 }); await p.mouse.up(); };
  const circ = []; for (let i = 0; i <= 24; i++) { const a = i / 24 * Math.PI * 2; circ.push([0.5 + 0.045 * Math.cos(a), 0.22 + 0.035 * Math.sin(a)]); }
  await stroke(circ);
  await stroke([[0.5, 0.257], [0.5, 0.52]]);
  await stroke([[0.5, 0.29], [0.4, 0.38], [0.33, 0.30]]);
  await stroke([[0.5, 0.29], [0.6, 0.36], [0.68, 0.45]]);
  await stroke([[0.5, 0.52], [0.45, 0.66], [0.44, 0.8]]);
  await stroke([[0.5, 0.52], [0.58, 0.64], [0.66, 0.74]]);
  await p.waitForTimeout(150);
  C.eq((await tags()).split(',').sort().join(','), 'armL,armR,head,legL,legR,spine', 'six pen strokes are auto-tagged as a full figure');
  C.ok(await ev(() => !!window.stickform.J), 'the drawn figure poses the character');
  C.ok((await p.textContent('#status')).includes('all tagged'), 'status line reports all tagged');
  await p.keyboard.press('e'); await p.mouse.click(...P(0.62, 0.69)); await p.waitForTimeout(100);
  C.eq((await tags()).split(',').length, 5, 'Erase removes the clicked stroke');
  await p.keyboard.press('Control+z');
  // brush
  await p.click('#brushbtn');
  C.ok(await p.isVisible('#brushpop'), 'tag brush opens the Paint as menu');
  await p.click('#brushpop .mi:nth-of-type(5)'); // Leg right
  await stroke([[0.5, 0.52], [0.6, 0.62], [0.7, 0.7]]);
  const br = await ev(() => window.stickform.sketch.strokes.filter(s => s.tag === 'legR').map(s => s.lock));
  C.eq(br, [true], 'a brush stroke replaces the old one and is locked to its tag');
  // mirror and faces away
  await p.keyboard.press('p');
  const x0 = await ev(() => window.stickform.sketch.strokes.find(s => s.tag === 'head').pts[0].x);
  await p.keyboard.press('m'); await p.waitForTimeout(100);
  const x1 = await ev(() => window.stickform.sketch.strokes.find(s => s.tag === 'head').pts[0].x);
  C.ok(Math.abs(x0 - x1) > 0.01, 'M mirrors the drawing');
  C.ok(await ev(() => window.stickform.sketch.strokes.find(s => s.lock).tag === 'legL'), 'mirroring swaps locked left/right tags');
  await p.keyboard.press('a');
  C.ok(await ev(() => window.stickform.sketch.away) && await pressed('#away') === 'true', 'A toggles faces away');
  await p.keyboard.press('a');

  // ---- 3D viewport and output
  C.section('3D viewport and output');
  for (const cam of ['front', 'side', 'q']) {
    await p.click(`#cams button[data-cam="${cam}"]`);
    C.eq(await ev(() => window.stickform.out.preset), cam, `camera button ${cam} selects that preset`);
  }
  const vb = await p.locator('#v3').boundingBox();
  await p.mouse.move(vb.x + vb.width / 2, vb.y + vb.height / 2); await p.mouse.down(); await p.mouse.move(vb.x + vb.width / 2 + 80, vb.y + vb.height / 2, { steps: 5 }); await p.mouse.up();
  C.eq(await ev(() => window.stickform.out.preset), 'free', 'orbiting the 3D view switches to Free');
  await p.click('#cams button[data-cam="q"]');
  for (const [i, asp] of [[2, 2 / 3], [3, 3 / 2], [4, 9 / 16], [1, 1]]) {
    await p.click(`#aspects button:nth-child(${i})`); await p.waitForTimeout(80);
    const o = await ev(() => [window.stickform.out.w / window.stickform.out.h]);
    const fb = await p.locator('#frame').boundingBox();
    C.ok(Math.abs(o[0] - asp) < 0.01 && Math.abs(fb.width / fb.height - asp) < 0.02, `aspect chip ${i} sets output and frame to ${asp.toFixed(2)}`);
  }
  await p.click('#bgs button:nth-child(3)');
  C.eq(await ev(() => window.stickform.out.background), 'dark', 'background swatch sets the output background');
  C.ok((await p.textContent('#summary')).includes('Dark'), 'summary chip shows the background');
  await p.click('#oshadow');
  C.eq(await ev(() => window.stickform.out.shadow), false, 'shadow switch turns the ground shadow off');
  await p.click('#oshadow'); await p.click('#bgs button:nth-child(1)');
  await p.click('#overlay');
  C.eq(await ev(() => window.stickform.stage.showOverlay), true, 'stick overlay toggle');
  await p.click('#overlay');

  // ---- output sizes: 16:9 and custom
  C.section('Output size');
  await p.click('#aspects button:has-text("16:9")');
  C.eq(await ev(() => [window.stickform.out.w, window.stickform.out.h]), [1536, 864], '16:9 chip sets 1536 × 864');
  await p.fill('#ow', '1000'); await p.press('#ow', 'Enter'); await p.fill('#oh', '700'); await p.press('#oh', 'Enter');
  C.eq(await ev(() => [window.stickform.out.w, window.stickform.out.h]), [1000, 700], 'typing a width and height sets a custom size');
  C.ok(await ev(() => [...document.querySelectorAll('#aspects button')].every(b => b.getAttribute('aria-pressed') === 'false')), 'no aspect chip is marked for an odd size');
  await p.fill('#ow', '9000'); await p.press('#ow', 'Enter');
  C.ok(await ev(() => window.stickform.out.w) === 1000 && /4096/.test(await p.textContent('#toast')), 'sizes over 4096 are refused with a note');
  await p.click('#oswap');
  C.eq(await ev(() => [window.stickform.out.w, window.stickform.out.h]), [700, 1000], 'swap turns width and height round');
  { const fr = await p.locator('#frame').boundingBox(); C.ok(Math.abs(fr.width / fr.height - 0.7) < 0.02, 'the dashed frame follows the custom shape', JSON.stringify(fr)); }

  // ---- render: file, size, and that the PNG shows what the frame shows
  C.section('Render');
  await p.click('#cams button[data-cam="front"]'); await p.waitForTimeout(150);
  const shot = await p.locator('#frame').screenshot();
  const [dl] = await Promise.all([p.waitForEvent('download'), p.keyboard.press('Control+Enter')]);
  C.ok(/^stickform-.+-mannequin-\d{8}-\d{6}(-\d+)?\.png$/.test(dl.suggestedFilename()), 'Ctrl Enter downloads a named PNG', dl.suggestedFilename());
  const png = readFileSync(await dl.path());
  const cmp = await ev(async ([a, b]) => {
    const load = src => new Promise(res => { const i = new Image(); i.onload = () => res(i); i.src = src; });
    const [ia, ib] = await Promise.all([load('data:image/png;base64,' + a), load('data:image/png;base64,' + b)]);
    const px = img => { const c = document.createElement('canvas'); c.width = c.height = 96; const x = c.getContext('2d'); x.drawImage(img, 0, 0, 96, 96); return x.getImageData(0, 0, 96, 96).data; };
    const A = px(ia), B = px(ib); let d = 0; for (let i = 0; i < A.length; i += 4) d += Math.abs(A[i] - B[i]) + Math.abs(A[i + 1] - B[i + 1]) + Math.abs(A[i + 2] - B[i + 2]);
    return { w: ib.width, h: ib.height, diff: d / (96 * 96 * 3) };
  }, [shot.toString('base64'), png.toString('base64')]);
  const o = await ev(() => [window.stickform.out.w, window.stickform.out.h]);
  C.eq([cmp.w, cmp.h], o, 'PNG has the chosen output size');
  C.ok(cmp.diff < 14, 'PNG shows what the dashed frame shows', `mean pixel difference ${cmp.diff.toFixed(1)}`);
  C.ok((await p.textContent('#tab-renders')).includes('1'), 'Renders tab counts the render');
  await p.click('#tab-renders');
  C.eq(await p.locator('#rgrid .rcard').count(), 1, 'Renders tab lists the render');
  // a second render, so the preview can step between two
  await p.click('#tab-pose'); await Promise.all([p.waitForEvent('download'), p.keyboard.press('Control+Enter')]); await p.click('#tab-renders'); await p.waitForTimeout(150);
  { const n = await ev(() => window.stickform.renders.map(r => r.name)); C.ok(n.length === 2 && n[0] !== n[1], 'two renders never share a file name (same second: -2)', JSON.stringify(n)); }
  C.ok(await p.isDisabled('#rprev') && await p.isDisabled('#rren') && await p.isDisabled('#rdel'), 'Preview, Rename and Delete wait for a selection');
  await p.click('#rgrid .rcard:nth-child(1)');
  C.ok(await p.getAttribute('#rgrid .rcard:nth-child(1)', 'aria-current') === 'true' && !(await p.isDisabled('#rren')), 'clicking a render selects it');
  await p.click('#rren'); await p.fill('#tx-in', 'my render'); await p.click('#tx-ok'); await p.waitForTimeout(150);
  C.ok((await ev(() => window.stickform.renders.map(r => r.name))).includes('my render.png') && (await p.textContent('#rgrid .rcard:nth-child(1) .meta b')) === 'my render', 'Rename gives the render a new name', JSON.stringify(await ev(() => window.stickform.renders.map(r => r.name))));
  await p.dblclick('#rgrid .rcard:nth-child(1)'); await p.waitForTimeout(250);
  const pvOk = () => ev(() => { const d = document.getElementById('dlg-preview'), i = document.getElementById('pv-img'), r = d.getBoundingClientRect(); return { open: d.open, w: i.naturalWidth, full: r.width >= innerWidth - 1 && r.height >= innerHeight - 1, name: document.getElementById('pv-name').textContent, meta: document.getElementById('pv-meta').textContent }; });
  const pv1 = await pvOk();
  C.ok(pv1.open && pv1.w > 0 && pv1.full && pv1.name === 'my render.png', 'double-click opens the preview over the whole window', JSON.stringify(pv1));
  C.ok(/\d+ × \d+ px/.test(pv1.meta) && pv1.meta.includes('1 of 2'), 'the preview shows the pixel size and where it is in the list', pv1.meta);
  await p.keyboard.press('ArrowRight'); await p.waitForTimeout(150);
  C.ok((await pvOk()).meta.includes('2 of 2') && await p.getAttribute('#rgrid .rcard:nth-child(2)', 'aria-current') === 'true', 'Right arrow shows the next render');
  await p.keyboard.press('z');
  C.ok(await ev(() => document.getElementById('pv-stage').classList.contains('actual')), 'Z (or a click on the image) shows it at actual size');
  await p.keyboard.press('z');
  await p.keyboard.press('Delete'); await p.waitForTimeout(100);
  C.ok(await ev(() => document.getElementById('dlg-confirm').open), 'Delete in the preview asks first');
  await p.click('#cf-ok'); await p.waitForTimeout(200);
  const pv2 = await pvOk();
  C.ok(pv2.open && pv2.name === 'my render.png' && await p.locator('#rgrid .rcard').count() === 1 && (await p.textContent('#tab-renders')).includes('1'), 'after deleting, the preview moves to the remaining render', JSON.stringify(pv2));
  await p.keyboard.press('Escape'); await p.waitForTimeout(100);
  C.ok(!(await ev(() => document.getElementById('dlg-preview').open)), 'Esc closes the preview');
  await p.click('#tab-pose');

  await p.click('#aspects button:has-text("1:1")');

  // ---- save pose and rename
  C.section('Pose name and files');
  await p.click('#pname'); await p.fill('#pnameinput', 'Test pose'); await p.keyboard.press('Enter');
  C.eq(await p.textContent('#pnametext'), 'Test pose', 'clicking the name renames the pose');
  const [pf] = await Promise.all([p.waitForEvent('download'), p.keyboard.press('Control+s')]);
  C.eq(pf.suggestedFilename(), 'test-pose.stickform.json', 'Ctrl S saves a pose file named after the pose');
  const pj = JSON.parse(readFileSync(await pf.path(), 'utf8'));
  C.ok(pj.format === 'stickform-pose' && pj.strokes.length > 0 && pj.output?.w, 'saved pose file has strokes and output size');
  C.ok(await p.isHidden('#pedited'), 'saving clears the edited mark');

  // ---- library
  C.section('Library');
  await p.keyboard.press('l');
  C.ok(await p.isVisible('#ws-library'), 'L opens the Library');
  C.ok(await p.getAttribute('#liball', 'aria-pressed') === 'true' && await p.locator('#libgrid .thumb').count() === 10 && !(await p.isVisible('#libtabs button[data-lib="b"]')), 'Library opens on All: the ten starter poses, no built-in / mine split');
  C.ok(await p.isDisabled('#libuse'), '"Use as starting pose" waits for a selection');
  await p.click('#libsave'); await p.fill('#tx-in', 'My test'); await p.click('#tx-ok');
  await p.waitForFunction(() => document.getElementById('liball').textContent.includes('11'), null, { timeout: 2000 }).catch(() => {});
  C.ok((await p.textContent('#liball')).includes('11') && (await p.textContent('#libposes')).includes('11'), 'Save current pose adds it (All and Poses)');
  await p.click('#libgrid .thumb:has-text("My test")'); await p.click('#libdel');
  C.ok(await p.isVisible('#dlg-confirm'), 'Delete asks first'); await p.click('#cf-ok'); await p.waitForTimeout(150);
  C.ok((await p.textContent('#liball')).includes('10'), 'Delete removes it');
  await p.click('#libgrid .thumb:has-text("Lying on the side")'); await p.keyboard.press('F2'); await p.fill('#tx-in', 'Lying down'); await p.click('#tx-ok'); await p.waitForTimeout(80);
  C.ok(await p.locator('#libgrid .thumb:has-text("Lying down")').count() === 1 && await p.locator('#libgrid .thumb:has-text("Lying on the side")').count() === 0, 'a starter pose can be renamed (F2) like any other');
  await p.click('#libgrid .thumb:has-text("High kick")'); await p.click('#libdel'); await p.click('#cf-ok'); await p.waitForTimeout(100);
  C.ok((await p.textContent('#liball')).includes('9'), '… and deleted');
  await p.click('#settings'); await p.click('#st-starters'); await p.click('#dlg-settings [data-close]'); await p.waitForTimeout(80);
  C.ok((await p.textContent('#liball')).includes('10') && await p.locator('#libgrid .thumb:has-text("High kick")').count() === 1 && await p.locator('#libgrid .thumb:has-text("Lying on the side")').count() === 0, 'Settings › Restore starter poses puts back only the deleted one (the renamed one stays renamed)', JSON.stringify([await p.textContent('#liball'), await p.locator('#libgrid .thumb .tlab').allTextContents()]));
  await p.click('#libgrid .thumb:has-text("Lying down")'); await p.click('#libuse');
  C.ok(await p.isVisible('#ws-pose') && (await p.textContent('#pnametext')) === 'Lying down', 'Use as starting pose loads it and returns to Pose');

  // ---- viewports
  C.section('Viewports');
  await p.click('#vp-output .vpbar .ib[aria-label="Add viewport"]'); await p.click('text=3D · orbit'); await p.waitForTimeout(200);
  C.ok(await p.isVisible('#vp-orbit'), 'Add viewport opens the orbit view');
  C.eq(await p.locator('.split').count(), 2, 'a splitter between each pair of viewports');
  const sp = await p.locator('.split').first().boundingBox(), w0 = (await p.locator('#vp-sketch').boundingBox()).width;
  await p.mouse.move(sp.x + 4, sp.y + 200); await p.mouse.down(); await p.mouse.move(sp.x - 120, sp.y + 200, { steps: 5 }); await p.mouse.up();
  const w1 = (await p.locator('#vp-sketch').boundingBox()).width;
  C.ok(w1 < w0 - 80, 'dragging a splitter resizes the viewports', `${w0} → ${w1}`);
  const g = await p.locator('#vp-orbit .grip').boundingBox(), sk = await p.locator('#vp-sketch').boundingBox();
  await p.mouse.move(g.x + 10, g.y + 10); await p.mouse.down(); await p.mouse.move(sk.x + 30, sk.y + 300, { steps: 6 }); await p.mouse.up();
  C.eq(await ev(() => window.stickform.layout().cols[0][0]), 'orbit', 'dragging a grip to the left edge of another viewport docks it there');
  { const g2 = await p.locator('#vp-orbit .grip').boundingBox(), o = await p.locator('#vp-output').boundingBox();
    await p.mouse.move(g2.x + 10, g2.y + 10); await p.mouse.down(); await p.mouse.move(o.x + o.width / 2, o.y + o.height - 30, { steps: 6 }); await p.mouse.up(); await p.waitForTimeout(150); }
  const ob = await p.locator('#vp-orbit').boundingBox(), ou = await p.locator('#vp-output').boundingBox();
  C.ok(Math.abs(ob.x - ou.x) < 2 && ob.y > ou.y + 100 && JSON.stringify(await ev(() => window.stickform.layout().cols)) === '[["sketch"],["output","orbit"]]', 'dropping on the bottom edge stacks it below');
  const hs = await p.locator('.hsplit').first().boundingBox();
  await p.mouse.move(hs.x + hs.width / 2, hs.y + 4); await p.mouse.down(); await p.mouse.move(hs.x + hs.width / 2, hs.y - 120, { steps: 5 }); await p.mouse.up();
  C.ok((await p.locator('#vp-output').boundingBox()).height < ou.height - 80, 'a row splitter resizes stacked viewports');
  await p.click('#vp-sketch .vpbar .ib[aria-label="Add viewport"]'); await p.click('.pop .mi >> text=2 × 2 sketch views + 3D'); await p.waitForTimeout(250);
  const bx = await Promise.all(['sketch', 'view1', 'view2', 'view3', 'output'].map(k => p.locator('#vp-' + k).boundingBox()));
  const near = (a, b) => Math.abs(a - b) < 3;
  C.ok(near(bx[0].y, bx[1].y) && near(bx[2].y, bx[3].y) && near(bx[0].x, bx[2].x) && near(bx[1].x, bx[3].x) && bx[2].y > bx[0].y + 100 && bx[1].x > bx[0].x + 100 && bx[4].x > bx[1].x + 100 && await p.isHidden('#vp-orbit'), 'Layouts › 2 × 2 sketch views + 3D tiles four sketch views next to the 3D view');
  await p.click('#vp-view3 .vpbar .ib[aria-label="Close viewport"]'); await p.click('#vp-view2 .vpbar .ib[aria-label="Close viewport"]'); await p.click('#vp-view1 .vpbar .ib[aria-label="Close viewport"]');
  await p.click('#vp-output .vpbar .ib[aria-label="Add viewport"]'); await p.click('.pop .mi >> text=3D · orbit'); await p.waitForTimeout(150);
  await p.click('#vp-orbit .vpbar .ib[aria-label="Maximise viewport"]');
  C.ok(await p.isHidden('#vp-sketch') && await p.isVisible('#vp-orbit'), 'Maximise shows only that viewport');
  await p.click('#vp-orbit .vpbar .ib[aria-label="Restore viewport"]');
  await p.click('#vp-orbit .vpbar .ib[aria-label="Close viewport"]');
  C.ok(await p.isHidden('#vp-orbit'), 'Close hides the viewport');
  const lay = await ev(() => JSON.stringify(window.stickform.layout()));
  await p.reload(); await p.waitForFunction(() => !!window.stickform); await p.waitForTimeout(200);
  C.ok(await p.isHidden('#vp-orbit') && await ev(() => JSON.stringify(window.stickform.layout())) === lay, 'layout is remembered after reload');
  await p.click('#settings'); await p.click('#st-layout'); await p.click('#dlg-settings [data-close]');
  C.ok(Math.abs((await p.locator('#vp-sketch').boundingBox()).width - wDefault) < 4, 'Settings › Reset restores the default layout');

  // ---- settings
  C.section('Settings');
  await p.click('#settings');
  await p.click('#st-ground');
  C.eq(await p.getAttribute('#st-ground', 'aria-checked'), 'false', 'Keep feet on the ground can be turned off');
  await p.click('#st-ground'); await p.click('#dlg-settings [data-close]');

  // ---- edit pen, drafts, pins, precision tools, sketch views
  C.section('Edit pen and drafts');
  await p.click('#thumbs .thumb:nth-child(1)'); await p.waitForTimeout(150);
  const S = () => ev(() => window.stickform);
  void S;
  const st = () => ev(() => ({ drafts: window.stickform.posing.drafts.map(d => d.part), ordered: window.stickform.sketch.strokes.filter(s => s.ordered).length, aL2: window.stickform.J.aL2, sel: window.stickform.posing.sel, pins: [...window.stickform.posing.pins] }));
  const frontPx = X => ev(X => { const s = window.stickform, f = s.internals.FRAME.get(s.J), q = s.canvas.toPx({ x: f.o.x + X[0] / f.s, y: f.o.y - X[1] / f.s }), r = document.getElementById('sk').getBoundingClientRect(); return [r.left + q.x, r.top + q.y]; }, X);
  const joint = n => ev(n => window.stickform.J[n], n);
  const drag = async (pts, shift = false) => { if (shift) await p.keyboard.down('Shift'); await p.mouse.move(...pts[0]); await p.mouse.down(); for (const q of pts.slice(1)) await p.mouse.move(...q, { steps: 4 }); await p.mouse.up(); if (shift) await p.keyboard.up('Shift'); await p.waitForTimeout(120); };
  await p.keyboard.press('d');
  C.eq(await pressed('.rail [data-tool="edit"]'), 'true', 'D picks the edit pen');
  const rawStrokes = await ev(() => JSON.stringify(window.stickform.sketch.strokes));
  const sh = await frontPx(await joint('shL')), y0 = (await st()).aL2[1];
  const up = async () => drag([sh, [sh[0] - 15, sh[1] - 40], [sh[0] - 25, sh[1] - 80], [sh[0] - 45, sh[1] - 95]]);
  await up();
  let s1 = await st();
  C.ok(s1.aL2[1] > y0 + 0.5, 'a guide drawn up from the shoulder raises the arm');
  C.eq(s1.drafts, ['armL'], 'the guide picks the arm and makes a draft');
  C.ok(s1.ordered === 9, 'the drawing is redrawn from the pose: clean and joined (9 parts)', `ordered strokes: ${s1.ordered}`);
  C.ok(await p.isVisible('#editbar'), 'the draft list appears');
  { const eb = await p.locator('#editbar').boundingBox(), pa = await p.locator('#paper').boundingBox(), rail = await p.locator('#ws-pose > .rail').boundingBox();
    C.ok(eb.x >= pa.x && eb.y >= pa.y && eb.x + eb.width <= pa.x + pa.width && eb.x >= rail.x + rail.width && eb.x < pa.x + 20, 'it sits at the left of the sketch paper, clear of the tool rail', JSON.stringify([eb, pa])); }
  await p.keyboard.press('Escape');
  C.ok(Math.abs((await st()).aL2[1] - y0) < 1e-6 && await ev(() => JSON.stringify(window.stickform.sketch.strokes)) === rawStrokes, 'Esc discards the draft and restores the original drawing');
  await up(); const yUp = (await st()).aL2[1];
  const sh2 = await frontPx(await joint('shL'));
  await drag([sh2, [sh2[0] - 50, sh2[1] + 5], [sh2[0] - 100, sh2[1] + 10]]);
  s1 = await st();
  C.ok(Math.abs(s1.aL2[1] - yUp) > 0.2 && s1.drafts.length === 1, 'redrawing the guide replaces the draft');
  await p.keyboard.press('Enter');
  s1 = await st();
  C.ok(s1.drafts.length === 0 && Math.abs(s1.aL2[1] - (await joint('aL2'))[1]) < 1e-9, 'Enter applies: the draft ends and the pose stays');
  await p.keyboard.press('Control+z');
  C.eq((await st()).drafts, ['armL'], 'undo after Apply brings the draft back');
  await p.keyboard.press('Control+y');

  C.section('Sketch views');
  await p.click('#vp-sketch .vpbar .ib[aria-label="Add viewport"]'); await p.click('.pop .mi >> text=Right side'); await p.waitForTimeout(150);
  C.ok(await p.isVisible('#vp-view1') && (await p.inputValue('#vp-view1 select')) === 'right', 'Add viewport › Right side opens a side sketch view');
  await p.click('#vp-sketch .vpbar .ib[aria-label="Add viewport"]'); await p.click('.pop .mi >> text=Top'); await p.waitForTimeout(150);
  C.ok(await p.isVisible('#vp-view2') && (await p.inputValue('#vp-view2 select')) === 'top', 'a second view (Top) opens beside it');
  const tile = (n, X) => ev(([n, X]) => { const s = window.stickform, v = document.querySelector(`#vp-view${n} select`).value, V = s.internals.VIEWS[v]; const r = document.querySelector(`#vp-view${n} canvas`).getBoundingClientRect(); const k = Math.min(r.width, r.height) / 4.6, cx = r.width / 2, cy = v === 'top' ? r.height / 2 : r.height * 0.47; const d = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2]; return [r.left + cx + d(X, V.right) * k, r.top + cy - d(X, V.up) * k, k]; }, [n, X]);
  // Spine: lean forward in the side view (the figure faces screen left there).
  let P0 = await tile(1, await joint('P')); const k1 = P0[2];
  await drag([[P0[0], P0[1]], [P0[0] - k1 * 0.15, P0[1] - k1 * 0.4], [P0[0] - k1 * 0.4, P0[1] - k1 * 0.75], [P0[0] - k1 * 0.6, P0[1] - k1 * 0.85]]);
  C.eq((await st()).drafts.slice(-1), ['spine'], 'a guide going up from the pelvis in the side view edits the spine');
  C.ok((await joint('N'))[2] > 0.3, 'the spine leans forward (toward the face)', JSON.stringify(await joint('N')));
  C.ok(await p.isVisible('#ebalt'), 'the draft bar offers Tab for the other part the guide could mean');
  const alt = await p.textContent('#ebalt');
  await p.keyboard.press('Tab');
  C.ok(alt.includes((await st()).drafts.slice(-1)[0] === 'hip' ? 'Hips' : (await ev(() => window.stickform.posing.drafts.at(-1).part)) === 'legL' ? 'Leg left' : '???'), 'Tab moves the guide to that part', alt);
  await p.keyboard.press('Tab'); // back round to the spine if needed
  while ((await st()).drafts.slice(-1)[0] !== 'spine') await p.keyboard.press('Tab');
  await p.keyboard.press('Enter');
  // Facing: a tick drawn up and forward from the head in the side view makes the head look up (it used to only turn).
  { const H = await tile(1, await joint('H')), r = k1 * 0.17;
    await drag([[H[0], H[1]], [H[0] - r * 0.4, H[1] - r * 0.4], [H[0] - r * 0.75, H[1] - r * 0.75]]);
    for (let i = 0; i < 4 && (await st()).drafts.slice(-1)[0] !== 'face'; i++) await p.keyboard.press('Tab');
    const hz = await ev(() => { const h = window.stickform.rig.bones.head, q = h.getWorldQuaternion(h.quaternion.clone()); return new h.position.constructor(0, 0, 1).applyQuaternion(q).toArray(); });
    const f = await joint('f');
    C.ok((await st()).drafts.slice(-1)[0] === 'face' && f[1] > 0.4 && hz[1] > 0.35, 'a facing tick drawn upward in the side view makes the head look up', JSON.stringify({ f, hz }));
    await p.keyboard.press('Escape'); }
  // Legs: thigh level, shin down, with Shift; then copy to the other side.
  P0 = await tile(1, await joint('hpL'));
  await drag([[P0[0], P0[1]], [P0[0] - k1 * 0.4, P0[1] + k1 * 0.05], [P0[0] - k1 * 0.8, P0[1] + k1 * 0.02], [P0[0] - k1 * 0.82, P0[1] + k1 * 0.4], [P0[0] - k1 * 0.8, P0[1] + k1 * 0.75]], true);
  const leg = (await st()).drafts.slice(-1)[0];
  C.ok(leg === 'legL' || leg === 'legR', 'a guide from the hip in the side view edits a leg', leg);
  const th = await ev(l => { const J = window.stickform.J, a = l === 'legL' ? ['hpL', 'lL1', 'lL2'] : ['hpR', 'lR1', 'lR2']; return [J[a[1]].map((v, i) => v - J[a[0]][i]), J[a[2]].map((v, i) => v - J[a[1]][i])]; }, leg);
  C.ok(Math.abs(th[0][1]) < 1e-6 && Math.abs(th[1][0]) < 1e-6 && Math.abs(th[1][2]) < 1e-6, 'Shift snaps the thigh level and the shin straight down', JSON.stringify(th));
  await p.keyboard.press('Enter');
  await p.keyboard.press('v');
  const mid = await ev(l => { const J = window.stickform.J, a = l === 'legL' ? ['hpL', 'lL1'] : ['hpR', 'lR1']; return J[a[0]].map((v, i) => (v + J[a[1]][i]) / 2); }, leg);
  const tm = await tile(1, mid);
  await p.mouse.click(tm[0], tm[1]); await p.waitForTimeout(80);
  C.eq(await ev(() => window.stickform.posing.sel), leg + '1', 'clicking the thigh in the side view selects it');
  C.ok(Math.abs(Number(await p.inputValue('#pb-rx'))) > 60, 'the Pose card shows its rotation from the idle pose (a level thigh: about 90° on X)', await p.inputValue('#pb-rx'));
  await p.keyboard.press('c'); await p.waitForTimeout(80);
  const legs = await ev(() => { const J = window.stickform.J; return [J.lL1, J.lR1, J.lL2, J.lR2].map(v => v.map(x => +x.toFixed(4))); });
  C.ok(legs[0][1] === legs[1][1] && legs[0][2] === legs[1][2] && legs[2][1] === legs[3][1] && legs[2][2] === legs[3][2], 'C copies the leg to the other side: level and parallel', JSON.stringify(legs));
  // Nudge: arrows turn the selected bone; one undo step for a run of nudges.
  const e0 = await ev(() => window.stickform.posing.angles(window.stickform.internals.dirsOf(window.stickform.J)[window.stickform.posing.sel]).elevation);
  await p.keyboard.press('ArrowUp'); await p.keyboard.press('ArrowUp'); await p.keyboard.press('Shift+ArrowUp');
  const e1 = await ev(() => window.stickform.posing.angles(window.stickform.internals.dirsOf(window.stickform.J)[window.stickform.posing.sel]).elevation);
  C.ok(Math.abs(e1 - e0 - 11) < 0.01, 'arrow keys nudge 5°, with Shift 1°', `${e0} → ${e1}`);
  await p.keyboard.press('Control+z');
  const e2 = await ev(() => window.stickform.posing.angles(window.stickform.internals.dirsOf(window.stickform.J)[window.stickform.posing.sel] || [0, 0, 1]).elevation);
  C.ok(Math.abs(e2 - e0) < 0.01, 'one undo takes back a run of nudges', `${e1} → ${e2}`);
  // Precise numbers for the selected bone (Parallel to / Square to are gone)
  const ua = await ev(() => { const J = window.stickform.J; return J.shL.map((v, i) => (v + J.aL1[i]) / 2); });
  const fu = await frontPx(ua);
  await p.mouse.click(...fu); await p.waitForTimeout(60);
  C.eq(await ev(() => window.stickform.posing.sel), 'armL1', 'clicking the upper arm in the front sketch selects it');
  C.ok(await p.isVisible('#pbone') && !(await p.isVisible('#ppar')) && !(await p.isVisible('#psq')), 'the Pose card shows its numbers (no Parallel to / Square to)');
  await p.fill('#pb-rx', '0'); await p.press('#pb-rx', 'Tab'); await p.fill('#pb-ry', '0'); await p.press('#pb-ry', 'Tab'); await p.fill('#pb-rz', '-30'); await p.press('#pb-rz', 'Enter'); await p.waitForTimeout(60);
  { const d = await ev(() => window.stickform.internals.dirsOf(window.stickform.J).armL1), l = Math.hypot(-0.5, -0.865, -0.03), i0 = [-0.5 / l, -0.865 / l, -0.03 / l], c = Math.cos(-Math.PI / 6), sn = Math.sin(-Math.PI / 6);
    const want = [i0[0] * c - i0[1] * sn, i0[0] * sn + i0[1] * c, i0[2]], err = Math.hypot(d[0] - want[0], d[1] - want[1], d[2] - want[2]);
    const shown = [await p.inputValue('#pb-rx'), await p.inputValue('#pb-ry'), await p.inputValue('#pb-rz')].join(' ');
    C.ok(err < 1e-3 && shown === '0 0 -30', 'rotation X Y Z (from the idle pose): typing 0 0 -30 turns the upper arm 30° about Z, and the numbers stay as typed', JSON.stringify({ err, shown })); }
  { const r = [0, 0, 0].map((_, i) => i);
    await p.fill('#pb-rz', '0'); await p.press('#pb-rz', 'Enter'); await p.waitForTimeout(60);
    const d = await ev(() => window.stickform.internals.dirsOf(window.stickform.J).armL1), l = Math.hypot(-0.5, -0.865, -0.03);
    C.ok(Math.hypot(d[0] + 0.5 / l, d[1] + 0.865 / l, d[2] + 0.03 / l) < 1e-3, '0 0 0 is the idle direction', JSON.stringify(d + r)); }
  // drag a number: changes it live, one undo per drag, Shift finer; a click without dragging types
  await ev(() => document.activeElement?.blur()); // (a box being typed in drags to select text, as usual)
  { const bb = await p.locator('#pb-rz').boundingBox(), y = bb.y + bb.height / 2, x = bb.x + bb.width / 2;
    const n0 = await ev(() => window.stickform.canvas.exportHistory().u.length);
    await p.mouse.move(x, y); await p.mouse.down(); for (let k = 1; k <= 8; k++) await p.mouse.move(x + k * 10, y); await p.mouse.up(); await p.waitForTimeout(60);
    const v1 = Number(await p.inputValue('#pb-rz')), n1 = await ev(() => window.stickform.canvas.exportHistory().u.length);
    C.ok(Math.abs(v1 - 40) < 1.5 && n1 === n0 + 1, 'dragging a number box right raises it (0.5° per pixel) as one undo step', JSON.stringify({ v1, steps: n1 - n0 }));
    { const o = [await p.inputValue('#pb-rx'), await p.inputValue('#pb-ry')]; C.ok(o[0] === '0' && o[1] === '0', 'dragging Z leaves X and Y exactly as they were (no jumping between axes)', JSON.stringify(o)); }
    { // position: dragging X keeps Y and Z as they were; an end the bone cannot reach is marked
      const b2 = await p.locator('#pb-x').boundingBox(), y2 = b2.y + b2.height / 2, x2 = b2.x + b2.width / 2;
      const yz0 = [await p.inputValue('#pb-y'), await p.inputValue('#pb-z')], x0v = Number(await p.inputValue('#pb-x'));
      await p.mouse.move(x2, y2); await p.mouse.down(); for (let k = 1; k <= 10; k++) await p.mouse.move(x2 - k * 10, y2); await p.mouse.up(); await p.waitForTimeout(60);
      const yz1 = [await p.inputValue('#pb-y'), await p.inputValue('#pb-z')], x1v = Number(await p.inputValue('#pb-x'));
      C.ok(JSON.stringify(yz0) === JSON.stringify(yz1) && Math.abs(x1v - (x0v - 0.4)) < 0.02, 'dragging the end position X moves only X (Y and Z stay as set)', JSON.stringify({ yz0, yz1, x0v, x1v }));
      C.ok(await ev(() => document.getElementById('pb-x').classList.contains('off')), 'a position the bone cannot reach is marked (the real end is in its tooltip)');
      await p.keyboard.press('Control+z'); }
    await p.mouse.move(x, y); await p.keyboard.down('Shift'); await p.mouse.down(); for (let k = 1; k <= 8; k++) await p.mouse.move(x + k * 10, y); await p.mouse.up(); await p.keyboard.up('Shift'); await p.waitForTimeout(60);
    const v2 = Number(await p.inputValue('#pb-rz'));
    C.ok(Math.abs(v2 - v1 - 4) < 0.6, 'with Shift ten times finer', JSON.stringify({ v1, v2 }));
    await p.keyboard.press('Control+z'); await p.keyboard.press('Control+z');
    await p.mouse.click(x, y); await p.waitForTimeout(40);
    C.ok(await ev(() => document.activeElement?.id) === 'pb-rz', 'a click without dragging puts the cursor in the box to type');
    await p.keyboard.press('Escape'); }
  await p.fill('#pb-rz', '-30'); await p.press('#pb-rz', 'Enter'); await p.waitForTimeout(40);
  await p.focus('#pb-rz'); await p.keyboard.press('Control+z');
  C.ok(Math.abs(Number(await ev(() => window.stickform.posing.boneInfo().rot[2])) + 30) > 0.5, 'Ctrl Z inside a number box is the app\'s undo');
  await p.keyboard.press('Control+z');
  // the hand: typing a position bends the whole arm to reach it
  await ev(() => { window.stickform.posing.sel = 'armL2'; window.stickform.update(); });
  C.eq(await ev(() => window.stickform.posing.sel), 'armL2', 'selecting the forearm');
  const shW = await ev(() => { const b = window.stickform.rig.bones.leftUpperArm, q = b.getWorldPosition(b.position.clone()); const r = window.stickform.rig.bones.rightUpperArm.getWorldPosition(b.position.clone()); return [q.toArray(), r.toArray()]; });
  // a reachable point: a quarter of the way from the hand toward the hips
  const handGoal = await ev(() => { const s = window.stickform, e = s.posing.boneInfo().end, h = s.rig.bones.hips.getWorldPosition(s.rig.bones.hips.position.clone()).toArray(); return e.map((v, i) => +(v + (h[i] - v) * 0.25).toFixed(3)); }); void shW;
  await p.fill('#pb-x', String(handGoal[0])); await p.fill('#pb-y', String(handGoal[1])); await p.fill('#pb-z', String(handGoal[2])); await p.press('#pb-z', 'Enter'); await p.waitForTimeout(80);
  { const end = await ev(() => window.stickform.posing.boneInfo().end); const d = Math.hypot(...end.map((v, i) => v - handGoal[i])); C.ok(d < 0.02, 'typing a hand position bends the arm so the hand lands there', `${d.toFixed(3)} m off ${JSON.stringify([end, handGoal, await p.textContent('#toast'), await ev(() => [window.stickform.posing.sel, window.stickform.posing.pins.size, window.stickform.posing.locked])])}`); }
  // reset: part, then the whole pose
  await p.click('#presetpart');
  { const D = await ev(() => window.stickform.internals.dirsOf(window.stickform.J)); C.ok(D.armL1[1] < -0.8 && D.armL1[1] > -0.9 && D.armL2[1] < -0.85, 'Reset arm left puts that arm back to idle (A-pose, about 30° out)', JSON.stringify([D.armL1, D.armL2])); }
  await p.keyboard.press('Escape'); await p.keyboard.press('Escape');
  await p.click('#preset');
  { const D = await ev(() => window.stickform.internals.dirsOf(window.stickform.J)); C.ok(D.spine1[1] > 0.999 && D.legR1[1] < -0.99 && D.face[2] > 0.99 && D.armR1[1] < -0.8, 'Reset pose: spine up, facing forward, legs down, arms in the A-pose (idle)', JSON.stringify([D.spine1, D.legR1, D.face])); }
  await p.keyboard.press('Control+z');
  C.ok((await ev(() => window.stickform.internals.dirsOf(window.stickform.J).spine1))[1] < 0.999, 'one undo brings the pose back');
  { const J = await ev(() => window.stickform.J), c = await frontPx(J.shL.map((v, i) => (v + J.aL1[i]) / 2)); await p.mouse.click(c[0], c[1]); await p.waitForTimeout(60); }

  C.section('Pins');
  await p.keyboard.press('k');
  C.eq((await st()).pins, ['armL'], 'K pins the selected part');
  const armBefore = await ev(() => window.stickform.internals.dirsOf(window.stickform.J).armL1);
  await p.keyboard.press('d');
  const shp = await frontPx(await joint('aL1'));
  await drag([shp, [shp[0] + 30, shp[1] + 40], [shp[0] + 40, shp[1] + 90]]);
  C.ok((await st()).drafts.every(x => x !== 'armL') && (await p.textContent('#toast')).includes('pinned'), 'a guide on a pinned part changes nothing and says why');
  P0 = await tile(1, await joint('P'));
  await drag([[P0[0], P0[1]], [P0[0] + k1 * 0.1, P0[1] - k1 * 0.5], [P0[0] + k1 * 0.2, P0[1] - k1 * 0.95]]);
  const armAfter = await ev(() => window.stickform.internals.dirsOf(window.stickform.J).armL1);
  C.ok(Math.hypot(...armAfter.map((v, i) => v - armBefore[i])) < 1e-4, 'the pinned arm stays put when the spine moves');
  await p.keyboard.press('Enter');
  await p.click('#ppins .pinchip');
  C.eq((await st()).pins, [], 'the pin chip unpins');

  C.section('Edit pen in 3D');
  await p.click('#cams button[data-cam="side"]'); await p.waitForTimeout(150);
  const vis = await ev(() => { const s = window.stickform, cam = s.outVP.camera.position, B = s.rig.bones; const w = ['leftUpperArm', 'rightUpperArm'].map(n => B[n].getWorldPosition(B[n].position.clone())).sort((a, b) => a.distanceTo(cam) - b.distanceTo(cam))[0]; const q = s.outVP.project(w), r = document.getElementById('v3').getBoundingClientRect(); return [r.left + q.x, r.top + q.y]; });
  await drag([vis, [vis[0] + 60, vis[1] - 6], [vis[0] + 120, vis[1] - 12]]);
  const d3 = await ev(() => { const d = window.stickform.posing.drafts.at(-1); return d && [d.part, d.guide.view, Math.abs(d.dirs[0][2])]; });
  C.ok(d3 && d3[0].startsWith('arm') && d3[1] === '3d' && d3[2] > 0.8, 'a guide in the 3D side view moves the nearer arm in depth', JSON.stringify(d3));
  C.eq(await ev(() => window.stickform.out.preset), 'side', 'drawing with the edit pen does not orbit the camera');
  { const eb = await p.locator('#editbar').boundingBox(), tl = await p.locator('#vp-output .tl').boundingBox(), stg = await p.locator('#vp-output .stage3d').boundingBox();
    C.ok(eb && eb.y >= tl.y + tl.height && eb.x < stg.x + 20 && eb.x >= stg.x && eb.y + eb.height <= stg.y + stg.height, 'a 3D guide docks the draft list in that 3D view, below its buttons', JSON.stringify([eb, tl])); }
  await p.keyboard.press('Tab'); await p.waitForTimeout(80);
  { const n = await ev(() => window.stickform.posing.drafts.length); await p.click('#editbar .dr.last .ic:not(.ok)'); C.ok(await ev(() => window.stickform.posing.drafts.length) === n - 1, 'the row ✕ discards that draft'); }
  await drag([vis, [vis[0] + 60, vis[1] - 6], [vis[0] + 120, vis[1] - 12]]);
  await p.keyboard.press('Enter');

  C.section('Saving and mirroring an edited pose');
  await p.keyboard.press('v'); await p.mouse.click(tm[0], tm[1]); await p.keyboard.press('k');
  await p.keyboard.press('Control+s');
  if (await p.evaluate(() => document.getElementById('dlg-text').open)) { await p.fill('#tx-in', 'Edited squat'); }
  const [pe] = await Promise.all([p.waitForEvent('download'), p.evaluate(() => document.getElementById('dlg-text').open) .then(o => o ? p.click('#tx-ok') : null)]);
  const pfe = JSON.parse(readFileSync(await pe.path(), 'utf8'));
  C.ok(pfe.depth && Object.keys(pfe.depth.z).length >= 14 && pfe.strokes.every(s => s.ordered || !s.tag) && (pfe.pins || []).length === 1, 'pose files keep the edited depth, the clean drawing and the pins');
  const Jsaved = await ev(() => JSON.stringify(window.stickform.J));
  await ev(() => window.stickform.loadPose(window.stickform.BUILTIN[0]));
  await ev(f => window.stickform.loadPose(f), pfe);
  const Jre = await ev(() => window.stickform.J);
  const Js = JSON.parse(Jsaved); let dj = 0; for (const n of Object.keys(Js)) for (let i = 0; i < 3; i++) dj = Math.max(dj, Math.abs(Js[n][i] - Jre[n][i]));
  C.ok(dj < 5e-3 && (await st()).pins.length === 1, 'reopening the file gives the same pose and pins', `difference ${dj}`);
  const before2 = await ev(() => window.stickform.J);
  await p.keyboard.press('m'); await p.waitForTimeout(80);
  const after2 = await ev(() => window.stickform.J);
  const mirrorErr = Math.max(...['aL2', 'aR2', 'lL2', 'lR2', 'N', 'H'].map(n => { const m = { aL2: 'aR2', aR2: 'aL2', lL2: 'lR2', lR2: 'lL2', N: 'N', H: 'H' }[n]; return Math.abs(after2[m][0] + before2[n][0]) + Math.abs(after2[m][1] - before2[n][1]) + Math.abs(after2[m][2] - before2[n][2]); }));
  C.ok(mirrorErr < 2e-3, 'M mirrors an edited pose exactly', `difference ${mirrorErr}`);
  await p.keyboard.press('Control+z');
  for (const n of [2, 1]) await p.click(`#vp-view${n} .vpbar .ib[aria-label="Close viewport"]`);
  await p.click('#cams button[data-cam="q"]');
  await p.keyboard.press('p');

  // ---- appearance
  C.section('Appearance');
  const bg = () => ev(() => getComputedStyle(document.body).backgroundColor);
  await p.emulateMedia({ colorScheme: 'dark' });
  const darkBg = await bg();
  await p.click('#settings'); await p.click('#st-theme button[data-theme="light"]');
  const lightBg = await bg();
  C.ok(await ev(() => document.documentElement.dataset.theme) === 'light' && lightBg !== darkBg && await p.getAttribute('#st-theme button[data-theme="light"]', 'aria-pressed') === 'true', 'Settings › Appearance › Light switches the interface to light', `${darkBg} → ${lightBg}`);
  C.ok(await ev(() => getComputedStyle(document.getElementById('paper')).backgroundColor) === 'rgb(244, 242, 236)', 'the sketch paper stays the same in light mode');
  await p.click('#dlg-settings [data-close]');
  await p.reload(); await p.waitForFunction(() => !!window.stickform); await p.waitForTimeout(200);
  C.ok(await ev(() => document.documentElement.dataset.theme) === 'light', 'the choice is remembered');
  await p.emulateMedia({ colorScheme: 'light' });
  await p.click('#settings'); await p.click('#st-theme button[data-theme="system"]');
  C.ok(await ev(() => document.documentElement.dataset.theme) === undefined && await bg() === lightBg, 'System follows the system setting (light here)');
  await p.emulateMedia({ colorScheme: 'dark' });
  C.eq(await bg(), darkBg, 'and switches with it (dark)');
  const paperBg = () => ev(() => getComputedStyle(document.getElementById('paper')).backgroundColor);
  C.eq(await paperBg(), 'rgb(211, 216, 224)', 'in dark mode the sketch paper is bluish grey by default (Auto)');
  await p.waitForTimeout(150);
  C.eq(await ev(() => window.stickform.stage.bg.toString(16)), 'c4cad3', 'and so is the 3D stage');
  await p.click('#st-paper button[title="Light grey"]'); await p.click('#st-stage button[title="Slate"]');
  C.ok(await paperBg() === 'rgb(227, 228, 230)' && await ev(() => window.stickform.stage.bg.toString(16)) === 'a9b1bd' && await pressed('#st-paper button[title="Light grey"]') === 'true', 'Settings › Sketch background and 3D background pick other colours');
  C.ok(await ev(() => { const t = document.querySelector('.vp[data-kind^="view"] .paper, #thumbs .thumb'); return !t || getComputedStyle(t).backgroundColor === 'rgb(227, 228, 230)'; }), 'preset thumbnails follow the sketch colour');
  await p.evaluate(() => { const i = document.querySelector('#st-paper input[type=color]'); i.value = '#a0b0c0'; i.dispatchEvent(new Event('input')); i.dispatchEvent(new Event('change')); });
  C.ok(await paperBg() === 'rgb(160, 176, 192)' && await p.getAttribute('#st-paper label', 'aria-pressed') === 'true', 'a custom colour works too');
  await p.click('#dlg-settings [data-close]');
  await p.reload(); await p.waitForFunction(() => !!window.stickform); await p.waitForTimeout(200);
  C.ok(await paperBg() === 'rgb(160, 176, 192)' && await ev(() => window.stickform.stage.bg.toString(16)) === 'a9b1bd', 'the colours are remembered');
  await p.click('#settings'); await p.click('#st-paper .auto'); await p.click('#st-stage .auto');
  C.eq(await paperBg(), 'rgb(211, 216, 224)', 'Auto goes back to following the theme');
  await p.click('#dlg-settings [data-close]');

  // ---- rotate gizmo
  C.section('Rotate gizmo');
  await ev(() => window.stickform.loadPose(window.stickform.BUILTIN[0])); await p.waitForTimeout(100);
  await p.click('#vp-sketch .vpbar .ib[aria-label="Add viewport"]'); await p.click('.pop .mi >> text=Right side'); await p.waitForTimeout(200);
  await p.keyboard.press('v');
  { const J = await ev(() => window.stickform.J), m = J.shL.map((v, i) => (v + J.aL1[i]) / 2), c = await frontPx(m); await p.mouse.click(c[0], c[1]); }
  const gz = w => ev(w => window.stickform.posing.gizmoHandles(w === 'tile' ? document.querySelector('#vp-view1 canvas') : w), w);
  const dirs = () => ev(() => { const J = window.stickform.J, d = (a, b) => { const v = [0, 1, 2].map(i => J[b][i] - J[a][i]), l = Math.hypot(...v); return v.map(x => x / l); }; return { u: d('shL', 'aL1'), f: d('aL1', 'aL2') }; });
  const g0 = await gz('front');
  C.ok(g0 && g0.ball && g0.rings.z?.length, 'selecting a bone shows the gizmo: a ring and an end ball');
  const und0 = await ev(() => JSON.stringify(window.stickform.J));
  // ball: drag the elbow straight above the shoulder
  { const L = Math.hypot(g0.ball.x - g0.root.x, g0.ball.y - g0.root.y);
    await drag([[g0.ball.x, g0.ball.y], [g0.root.x - L * 0.3, g0.root.y - L * 0.7], [g0.root.x, g0.root.y - L * 1.3]]); }
  const dB = await dirs();
  C.ok(dB.u[1] > 0.97, 'dragging the ball points the upper arm at the pointer', JSON.stringify(dB.u));
  C.eq(await ev(() => window.stickform.posing.sel), 'armL1', 'the bone stays selected');
  await p.keyboard.press('Control+z'); await p.waitForTimeout(80);
  C.ok(await ev(() => JSON.stringify(window.stickform.J)) === und0, 'one undo takes back the whole drag');
  // 3D: the Y ring turns the arm about the vertical axis; the camera does not move
  const camDir = () => ev(() => window.stickform.outVP.camera.quaternion.toArray().map(v => v.toFixed(3)).join()), cam0 = await camDir();
  const d0 = await dirs(), g3 = await gz('output');
  C.ok(g3 && ['x', 'y', 'z'].every(k => g3.rings[k]?.length), 'in 3D the gizmo has X, Y and Z rings');
  { const ys = g3.rings.y, i = ys.reduce((b, q, j) => q.y > ys[b].y ? j : b, 0), q = ys[i]; // front of the Y ring
    await drag([[q.x, q.y], [q.x + 30, q.y], [q.x + 70, q.y + 4]]); }
  const d1 = await dirs(), turned = Math.acos(Math.min(1, d0.u[0] * d1.u[0] + d0.u[2] * d1.u[2] + d0.u[1] * d1.u[1]));
  C.ok(Math.abs(d1.u[1] - d0.u[1]) < 2e-3 && Math.abs(d1.f[1] - d0.f[1]) < 2e-3 && turned > 0.15, 'dragging the Y ring turns the arm about the vertical (forearm carried)', JSON.stringify([d0.u, d1.u]));
  C.eq(await camDir(), cam0, 'grabbing a ring does not orbit the camera');
  await p.keyboard.press('Control+z');
  // side view: its ring turns the arm about the axis out of that view
  const gt = await gz('tile');
  C.ok(gt && Object.keys(gt.rings).length === 1, 'a flat sketch view has one ring (the axis out of the screen) and the ball');
  const t0 = await dirs();
  { const rs = Object.values(gt.rings)[0], q = rs[0]; await drag([[q.x, q.y], [q.x, q.y - 25], [q.x - 6, q.y - 50]]); }
  const t1 = await dirs(), axisName = Object.keys(gt.rings)[0], ai = { x: 0, y: 1, z: 2 }[axisName];
  C.ok(Math.abs(t1.u[ai] - t0.u[ai]) < 2e-3 && Math.hypot(...t1.u.map((v, i) => v - t0.u[i])) > 0.1, 'dragging the side view ring turns the arm in that view plane', JSON.stringify([axisName, t0.u, t1.u]));
  await p.keyboard.press('Control+z');
  // pinned part: no change
  await p.keyboard.press('k');
  const pjz = await ev(() => JSON.stringify(window.stickform.J)), gp = await gz('front');
  await drag([[gp.ball.x, gp.ball.y], [gp.ball.x + 40, gp.ball.y - 60]]);
  C.ok(await ev(() => JSON.stringify(window.stickform.J)) === pjz && /pinned/.test(await p.textContent('#toast')), 'a pinned part ignores the gizmo and says why');
  await p.keyboard.press('k');
  C.ok(!(await p.isDisabled('#copyside')), 'the rail button Copy to other side is ready for the selected arm');
  { const dj = await dirs(); await p.click('#copyside'); const J = await ev(() => window.stickform.J), r = [0, 1, 2].map(i => J.aR1[i] - J.shR[i]), l = Math.hypot(...r);
    C.ok(Math.abs(r[1] / l - dj.u[1]) < 2e-3, 'clicking it copies the arm to the other side', JSON.stringify([r, dj.u])); }
  await p.keyboard.press('Control+z');
  await p.click('#vp-view1 .vpbar .ib[aria-label="Close viewport"]');
  await p.keyboard.press('p');

  // ---- 2D zoom and pan, reset view
  C.section('2D zoom and pan');
  await ev(() => window.stickform.loadPose(window.stickform.BUILTIN[0])); await p.waitForTimeout(100);
  const zz_skb = await p.locator('#sk').boundingBox(), zz_sh0 = await frontPx((await ev(() => window.stickform.J)).shL);
  await p.mouse.move(zz_skb.x + zz_skb.width / 2, zz_skb.y + zz_skb.height / 2); await p.mouse.wheel(0, -500); await p.waitForTimeout(80);
  const zz_z1 = await ev(() => window.stickform.canvas.view.z), zz_sh1 = await frontPx((await ev(() => window.stickform.J)).shL);
  C.ok(zz_z1 > 1.5 && Math.hypot(zz_sh1[0] - zz_sh0[0], zz_sh1[1] - zz_sh0[1]) > 20, 'the wheel zooms the sketch at the pointer', `zoom ${zz_z1}`);
  await p.mouse.move(zz_skb.x + 60, zz_skb.y + 60); await p.mouse.down({ button: 'right' }); await p.mouse.move(zz_skb.x + 140, zz_skb.y + 100, { steps: 4 }); await p.mouse.up({ button: 'right' });
  const zz_sh2 = await frontPx((await ev(() => window.stickform.J)).shL);
  C.ok(Math.abs(zz_sh2[0] - zz_sh1[0] - 80) < 2 && Math.abs(zz_sh2[1] - zz_sh1[1] - 40) < 2, 'right-drag pans it');
  await p.keyboard.down('Space'); await p.mouse.move(zz_skb.x + 60, zz_skb.y + 60); await p.mouse.down(); await p.mouse.move(zz_skb.x + 30, zz_skb.y + 60, { steps: 3 }); await p.mouse.up(); await p.keyboard.up('Space');
  const zz_sh3 = await frontPx((await ev(() => window.stickform.J)).shL);
  C.ok(Math.abs(zz_sh3[0] - zz_sh2[0] + 30) < 2 && await ev(() => window.stickform.sketch.strokes.length) === 9, 'Space + drag pans too (and draws nothing)');
  { await p.keyboard.press('v'); const J = await ev(() => window.stickform.J), m = J.shL.map((v, i) => (v + J.aL1[i]) / 2), c = await frontPx(m); await p.mouse.click(c[0], c[1]);
    C.eq(await ev(() => window.stickform.posing.sel), 'armL1', 'picking still hits the right bone when zoomed'); await p.keyboard.press('Escape'); }
  await p.click('#vp-sketch .vpbar .ib[aria-label="Reset view"]');
  C.ok(await ev(() => JSON.stringify(window.stickform.canvas.view)) === '{"z":1,"x":0,"y":0}', 'Reset view puts the sketch back');
  await p.click('#vp-sketch .vpbar .ib[aria-label="Add viewport"]'); await p.click('.pop .mi >> text=Right side'); await p.waitForTimeout(150);
  { const tb = await p.locator('#vp-view1 canvas').boundingBox(); await p.mouse.move(tb.x + tb.width / 2, tb.y + tb.height / 2); await p.mouse.wheel(0, -400); await p.waitForTimeout(60); }
  C.ok(await ev(() => window.stickform.tileApi.view1.zoom()) > 1.5, 'sketch views zoom too');
  await p.click('#vp-view1 .vpbar .ib[aria-label="Reset view"]');
  C.eq(await ev(() => window.stickform.tileApi.view1.zoom()), 1, 'and reset');
  await p.click('#cams button[data-cam="side"]'); const zz_camS = await ev(() => window.stickform.outVP.camera.position.toArray().join());
  // (from an empty spot: with the select tool, a drag that starts on the body moves the body instead, IK)
  { const vb = await p.locator('#v3').boundingBox(); await p.mouse.move(vb.x + 60, vb.y + vb.height - 60); await p.mouse.down(); await p.mouse.move(vb.x + 180, vb.y + vb.height - 60, { steps: 5 }); await p.mouse.up(); }
  C.eq(await ev(() => window.stickform.out.preset), 'free', 'orbiting the 3D view leaves the preset');
  await p.click('#vp-output .vpbar .ib[aria-label="Reset view"]');
  C.ok(await ev(() => window.stickform.out.preset) === 'side' && await ev(() => window.stickform.outVP.camera.position.toArray().join()) === zz_camS, '3D Reset view goes back to the last camera preset');
  await p.click('#cams button[data-cam="q"]');

  // ---- moving and turning the whole character
  C.section('Move and turn the character');
  const zz_hipsW = () => ev(() => window.stickform.rig.bones.hips.getWorldPosition(window.stickform.rig.bones.hips.position.clone()).toArray());
  const zz_h0 = await zz_hipsW();
  await p.keyboard.press('g'); await p.waitForTimeout(80);
  C.ok(await ev(() => window.stickform.posing.rootSel) && await p.isVisible('#pchar') && await p.getAttribute('#pmove', 'aria-pressed') === 'true', 'G selects the whole character: its numbers show in the Pose card');
  const zz_gr = await gz('output');
  C.ok(zz_gr && ['x', 'y', 'z'].every(k => zz_gr.arrows[k] && zz_gr.rings[k]), 'its 3D gizmo has three rings and three arrows');
  { const a = zz_gr.arrows.x; await drag([[a.x, a.y], [a.x + 40, a.y], [a.x + 90, a.y]]); }
  const zz_pl1 = await ev(() => window.stickform.posing.place), zz_h1 = await zz_hipsW();
  C.ok(zz_pl1.p[0] > 0.1 && Math.abs(zz_pl1.p[1]) < 1e-9 && Math.abs(zz_pl1.p[2]) < 1e-9 && Math.abs(zz_h1[0] - zz_h0[0] - zz_pl1.p[0]) < 1e-3, 'dragging the X arrow moves it along X', JSON.stringify([zz_pl1, zz_h0, zz_h1]));
  await p.keyboard.press('Control+z');
  C.ok((await ev(() => window.stickform.posing.place)).p[0] === 0, 'one undo puts it back');
  await p.fill('#pc-yaw', '90'); await p.press('#pc-yaw', 'Enter'); await p.fill('#pc-y', '0.25'); await p.press('#pc-y', 'Enter');
  const zz_fwd = await ev(() => { const s = window.stickform, B = s.rig.bones, a = B.leftUpperArm.getWorldPosition(B.hips.position.clone()), b = B.rightUpperArm.getWorldPosition(B.hips.position.clone()); return [b.x - a.x, b.z - a.z]; });
  const zz_h2 = await zz_hipsW();
  C.ok(Math.abs(zz_fwd[0]) < 0.03 && Math.abs(zz_fwd[1]) > 0.2 && Math.abs(zz_h2[0] - zz_h0[0]) < 1e-3 && Math.abs(zz_h2[1] - zz_h0[1] - 0.25) < 1e-3, 'Turn 90 turns it about the hips; Y lifts it', JSON.stringify([zz_fwd, zz_h0, zz_h2]));
  // bone gizmo with the character turned: the world X ring is the character's own Z axis now
  await p.keyboard.press('Escape'); await p.keyboard.press('Escape');
  C.ok(!(await ev(() => window.stickform.posing.rootSel)), 'Esc lets go of the character');
  { const J = await ev(() => window.stickform.J), m = J.shL.map((v, i) => (v + J.aL1[i]) / 2), c = await frontPx(m); await p.mouse.click(c[0], c[1]); }
  const zz_tz0 = await dirs(), zz_gt3 = await gz('output');
  { const xs = zz_gt3.rings.x, i = xs.reduce((b, q, j) => q.y < xs[b].y ? j : b, 0), q = xs[i]; await drag([[q.x, q.y], [q.x + 40, q.y], [q.x + 80, q.y + 5]]); }
  const zz_tz1 = await dirs();
  C.ok(Math.abs(zz_tz1.u[2] - zz_tz0.u[2]) < 2e-3 && Math.hypot(...zz_tz1.u.map((v, i) => v - zz_tz0.u[i])) > 0.1, 'bone rings follow the turned character (world X = its own Z here)', JSON.stringify([zz_tz0.u, zz_tz1.u]));
  await p.keyboard.press('Control+z');
  const zz_saved = await ev(() => { const s = window.stickform; return s.poseFile ? s.poseFile('x') : null; });
  if (zz_saved) {
    C.ok(zz_saved.place && Math.abs(zz_saved.place.turn[1] - 90) < 0.1 && Math.abs(zz_saved.place.p[1] - 0.25) < 1e-6, 'pose files keep where the character stands and how it is turned', JSON.stringify(zz_saved.place));
    await ev(f => window.stickform.loadPose(window.stickform.BUILTIN[0]), null);
    C.eq(await ev(() => window.stickform.posing.place.p), [0, 0, 0], 'a preset starts at the middle, unturned');
    await ev(f => window.stickform.loadPose(f), zz_saved);
    C.ok(Math.abs((await ev(() => window.stickform.posing.place.p))[1] - 0.25) < 1e-6, 'reopening the file puts it back');
  } else C.ok(false, 'poseFile hook missing');
  await ev(() => window.stickform.loadPose(window.stickform.BUILTIN[0]));

  // ---- lock the whole character
  C.section('Lock character');
  await p.keyboard.press('v'); await p.keyboard.press('g'); await p.waitForTimeout(60);
  await p.fill('#pc-x', '0.3'); await p.press('#pc-x', 'Enter');
  const lk_J0 = await ev(() => JSON.stringify(window.stickform.J)), lk_p0 = await ev(() => JSON.stringify(window.stickform.posing.place));
  await p.click('#plock');
  C.ok(await ev(() => window.stickform.posing.locked) && await pressed('#plock') === 'true' && (await p.textContent('#plock')).includes('Locked'), 'the Lock button (next to Move / turn) locks the whole character');
  C.ok(await p.isDisabled('#pc-x') && await p.isDisabled('#pc-yaw') && await p.isDisabled('#pc-reset'), 'its position and turn numbers are disabled while locked');
  const lk_gr = await gz('output');
  if (lk_gr) { const a = lk_gr.arrows.x; await drag([[a.x, a.y], [a.x + 40, a.y], [a.x + 90, a.y]]); }
  C.ok(lk_gr && await ev(() => JSON.stringify(window.stickform.posing.place)) === lk_p0, 'dragging its 3D gizmo does not move it', lk_p0);
  await p.keyboard.press('Escape');
  { const J = await ev(() => window.stickform.J), m = J.shL.map((v, i) => (v + J.aL1[i]) / 2), c = await frontPx(m); await p.mouse.click(c[0], c[1]); }
  const lk_selOk = await ev(() => !!window.stickform.posing.sel);
  await p.keyboard.press('ArrowUp'); await p.keyboard.press('ArrowUp');
  C.ok(lk_selOk && await ev(() => JSON.stringify(window.stickform.J)) === lk_J0, 'bones can still be selected, but nudges do nothing');
  C.ok(await ev(() => !document.getElementById('toast').hidden && /locked/i.test(document.getElementById('toast').textContent)), 'it says the character is locked');
  { const r = await ev(() => { const g = window.stickform.posing.gizmoHandles('front'); return g && g.ball; }); if (r) await drag([[r.x, r.y], [r.x + 30, r.y - 40], [r.x + 50, r.y - 60]]); }
  C.ok(await ev(() => JSON.stringify(window.stickform.J)) === lk_J0, 'the rotate gizmo does nothing');
  await p.keyboard.press('Escape'); await p.keyboard.press('d');
  { const J = await ev(() => window.stickform.J), a = await frontPx(J.shL), b = await frontPx([J.shL[0] + 0.3, J.shL[1] + 0.3, 0]); await drag([a, [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2], b]); }
  C.ok(await ev(() => JSON.stringify(window.stickform.J)) === lk_J0 && await ev(() => window.stickform.posing.drafts.length) === 0, 'the edit pen makes no draft');
  await p.keyboard.press('p');
  const lk_n = await ev(() => window.stickform.sketch.strokes.length);
  { const r = await p.locator('#sk').boundingBox(); await drag([[r.x + 30, r.y + 40], [r.x + 60, r.y + 70], [r.x + 90, r.y + 120]]); }
  await p.keyboard.press('m'); await p.keyboard.press('a');
  await p.click('#thumbs .thumb:nth-child(3)');
  C.ok(await ev(() => window.stickform.sketch.strokes.length) === lk_n && await ev(() => JSON.stringify(window.stickform.J)) === lk_J0, 'drawing, mirror, faces away and the preset thumbnails leave it alone');
  await p.keyboard.press('k'); await p.keyboard.press('Shift+K'); // K with nothing selected: no-op; Shift K unlocks
  C.ok(!(await ev(() => window.stickform.posing.locked)), 'Shift K unlocks it');
  await p.keyboard.press('Control+z');
  C.ok(await ev(() => window.stickform.posing.locked), 'locking and unlocking are undo steps');
  const lk_file = await ev(() => window.stickform.poseFile('x'));
  C.ok(lk_file.locked === true, 'pose files remember the lock');
  await ev(f => window.stickform.loadPose(f), { ...lk_file, locked: undefined });
  C.ok(!(await ev(() => window.stickform.posing.locked)), 'a file without the lock opens unlocked');
  await ev(f => window.stickform.loadPose(f), lk_file);
  C.ok(await ev(() => window.stickform.posing.locked) && await ev(() => JSON.stringify(window.stickform.posing.place)) === lk_p0, 'reopening the file locks it again, where it stood');
  await p.click('#plock');
  await p.keyboard.press('v');
  { const J = await ev(() => window.stickform.J), m = J.shL.map((v, i) => (v + J.aL1[i]) / 2), c = await frontPx(m); await p.mouse.click(c[0], c[1]); }
  await p.keyboard.press('ArrowUp');
  C.ok(await ev(() => JSON.stringify(window.stickform.J)) !== lk_J0, 'unlocked, nudges work again');
  await p.keyboard.press('Escape');
  await ev(() => window.stickform.loadPose(window.stickform.BUILTIN[0]));
  await p.click('#vp-view1 .vpbar .ib[aria-label="Close viewport"]');
  await p.keyboard.press('p');

  // ---- several characters
  C.section('Several characters');
  const sc = () => ev(() => window.stickform.actors.map(a => ({ id: a.id, name: a.name, tint: a.tint, vis: a.visible, active: a === window.stickform.active, x: a.group.position.x, color: (() => { let c = null; a.rig.root.traverse(o => { if (!c && o.material?.userData?.body) c = '#' + o.material.color.getHexString(); }); return c; })() })));
  C.ok(await p.isVisible('#charcard') && await p.locator('#chars .crow').count() === 1 && (await p.textContent('#savepose')).includes('Save pose'), 'the Scene card lists the one character');
  await p.click('#addbtn'); await p.click('#addchar'); await p.waitForTimeout(200);
  let A = await sc();
  C.ok(A.length === 2 && A[1].active && A[1].x > 0.5, 'Add puts a second mannequin beside the first and makes it the one being edited', JSON.stringify(A));
  C.ok(A[0].color !== A[1].color && A[1].color === A[1].tint, 'each mannequin gets its own muted colour', JSON.stringify(A.map(a => a.color)));
  C.ok((await p.textContent('#savepose')).includes('Save scene') && await p.isVisible('#camopts'), 'with two characters: Save scene, and camera options appear');
  C.ok((await ev(() => window.stickform.others())).length === 1 && (await ev(() => window.stickform.others()[0].J.P[0])) < -0.5, 'the sketch shows the other one faintly, where it stands (to the left here)');
  await p.keyboard.press('o'); C.eq(await pressed('#ghosts'), 'false', 'O hides the faint figures'); await p.keyboard.press('o');
  // give character 2 its own pose: only it changes
  const J1 = await ev(() => JSON.stringify(window.stickform.actors[0].J));
  await p.click('#thumbs .thumb:nth-child(3)'); await p.waitForTimeout(150);
  C.ok(await ev(() => JSON.stringify(window.stickform.actors[0].J)) === J1 && await ev(() => JSON.stringify(window.stickform.J)) !== J1, 'a preset goes onto the active character only');
  C.ok((await p.textContent('#pnametext')) !== 'High kick', 'and the scene keeps its name');
  // switch: row click, ghost click, [ ], 3D click
  await p.click('#chars .crow:nth-child(1) .cname'); await p.waitForTimeout(100);
  C.ok((await sc())[0].active && await ev(() => JSON.stringify(window.stickform.J)) === J1, 'clicking a name switches to that character (its own drawing comes back)');
  await p.keyboard.press(']'); C.ok((await sc())[1].active, '] goes to the next character');
  await p.keyboard.press('['); C.ok((await sc())[0].active, '[ goes back');
  await p.keyboard.press('v');
  { const o = (await ev(() => window.stickform.others()))[0], h = o.J.aL2[0] > o.J.aR2[0] ? o.J.aL2 : o.J.aR2, e = o.J.aL2[0] > o.J.aR2[0] ? o.J.aL1 : o.J.aR1, c = await frontPx(h.map((v, i) => (v + e[i]) / 2)); await p.mouse.click(c[0], c[1]); await p.waitForTimeout(100); }
  C.ok((await sc())[1].active, 'with V, clicking the faint figure in the sketch switches to it');
  { const pt = await ev(() => { const s = window.stickform, v = s.actors[0].rig.bones.head, w = v.getWorldPosition(v.position.clone()), q = s.outVP.project(w), r = s.outVP.canvas.getBoundingClientRect(); return [r.left + q.x, r.top + q.y]; }); await p.mouse.click(pt[0], pt[1]); await p.waitForTimeout(100); }
  C.ok((await sc())[0].active, 'clicking another character in 3D switches to it');
  // rename, colour, hide, lock, delete, undo
  await p.dblclick('#chars .crow:nth-child(2) .cname'); await p.fill('#tx-in', 'Partner'); await p.press('#tx-in', 'Enter'); // Enter confirms
  await p.waitForFunction(() => window.stickform.actors[1].name === 'Partner', null, { timeout: 3000 }).catch(() => {});
  C.eq((await sc())[1].name, 'Partner', 'double-click a name to rename');
  await p.click('#chars .crow:nth-child(1) .cname');
  await p.click('#chars .crow:nth-child(2) .cdot'); await p.click('#tintpop .tints button[title="Clay"]'); await p.waitForTimeout(80);
  C.ok((await sc())[1].tint === '#c7a796' && (await sc())[1].color === '#c7a796', 'the colour dot changes a mannequin\'s colour');
  await p.click('#chars .crow:nth-child(2) .ci[aria-label^="Hide"]');
  C.ok(!(await sc())[1].vis && await ev(() => !window.stickform.actors[1].group.visible), 'the eye hides a character (3D and render)');
  await p.click('#chars .crow:nth-child(2) .ci[aria-label^="Show"]');
  await p.click('#chars .crow:nth-child(2) .ci[aria-label^="Lock"]');
  C.ok(await ev(() => window.stickform.actors[1].data.locked) && await ev(() => !window.stickform.posing.locked), 'its lock locks that character only');
  await p.click('#chars .crow:nth-child(2) .ci[aria-label^="Unlock"]');
  await p.keyboard.press('Control+z'); await p.keyboard.press('Control+z'); await p.keyboard.press('Control+z'); await p.keyboard.press('Control+z'); await p.waitForTimeout(80);
  C.eq((await sc())[1].tint, '#c7a796', 'undo steps back through lock, show and hide');
  await p.keyboard.press('Control+z'); await p.keyboard.press('Control+z');
  C.ok((await sc())[1].name === 'Character 2' && (await sc())[1].color === (await sc())[1].tint, '… and colour and name (one history for the scene)');
  await p.keyboard.press('Control+y'); await p.keyboard.press('Control+y'); await p.keyboard.press('Control+y'); await p.keyboard.press('Control+y'); await p.keyboard.press('Control+y'); await p.keyboard.press('Control+y');
  C.ok((await sc())[1].name === 'Partner' && (await sc())[1].vis, 'redo brings it all back');
  // camera framing
  const rad = m => ev(m => window.stickform.stage.sphere(m).radius, m);
  C.ok(await rad('all') > await rad('active') + 0.2, 'camera presets frame every visible character (All) or the active one', JSON.stringify([await rad('all'), await rad('active'), await ev(() => window.stickform.stage.groups.map(g => [g.visible, g.children.length, g.position.x])), await sc()]));
  await p.click('#camframe button[data-frame="active"]'); await p.click('#cams button[data-cam="front"]'); await p.waitForTimeout(80);
  const ca = await ev(() => window.stickform.outVP.controls.target.x);
  await p.click('#camframe button[data-frame="all"]'); await p.click('#cams button[data-cam="front"]'); await p.waitForTimeout(80);
  C.ok(Math.abs(await ev(() => window.stickform.outVP.controls.target.x) - ca) > 0.2, 'Active frames the one being edited, All frames the group');
  await p.keyboard.press('g'); await p.fill('#pc-yaw', '90'); await p.press('#pc-yaw', 'Enter'); await p.keyboard.press('Escape');
  await p.click('#camaim'); await p.click('#cams button[data-cam="front"]'); await p.waitForTimeout(80);
  { const d = await ev(() => { const v = window.stickform.outVP, c = v.camera.position.clone().sub(v.controls.target).normalize(); return [c.x, c.z]; }); C.ok(Math.abs(d[0]) > 0.9, 'with "Presets turn with the active one", Front looks at its front', JSON.stringify(d)); }
  await p.click('#camaim'); await p.keyboard.press('Control+z');
  // reach: bring them close, then the hand goes onto the other's shoulder
  await ev(() => { const s = window.stickform; s.posing.movePlace([0, 0, 0]); s.update(); });
  const pid = await ev(() => window.stickform.actors[1].id);
  await ev(id => { const s = window.stickform; s.actors[1].data = { ...s.actors[1].data, place: { p: [0.62, 0, 0], q: [0, 0, 0, 1] } }; s.update(); }, pid);
  await p.click('#thumbs .thumb:nth-child(1)'); await p.waitForTimeout(80);
  await p.keyboard.press('v');
  { const J = await ev(() => window.stickform.J), side = J.aL2[0] > J.aR2[0] ? 'L' : 'R', m = J['a' + side + '1'].map((v, i) => (v + J['a' + side + '2'][i]) / 2), c = await frontPx(m); await p.mouse.click(c[0], c[1]); }
  await p.keyboard.press('r');
  C.ok(await pressed('#preach') === 'true', 'R (or Reach to…) waits for a point to reach');
  const tgtW = await ev(() => { const s = window.stickform, b = s.actors[1].rig.bones; const a = b.leftUpperArm.getWorldPosition(b.hips.position.clone()), c = b.rightUpperArm.getWorldPosition(b.hips.position.clone()); return (a.x < c.x ? a : c).toArray(); });
  { const o = (await ev(() => window.stickform.others()))[0], sh = o.J.shL[0] < o.J.shR[0] ? o.J.shL : o.J.shR, c = await frontPx(sh); await p.mouse.click(c[0], c[1]); await p.waitForTimeout(150); }
  const handD = await ev(t => { const s = window.stickform, B = s.rig.bones, h = [B.leftHand, B.rightHand].map(b => b.getWorldPosition(b.position.clone())); return Math.min(...h.map(v => Math.hypot(v.x - t[0], v.y - t[1], v.z - t[2]))); }, tgtW);
  C.ok(handD < 0.08, 'clicking the other character\'s shoulder puts the hand on it', `hand ${handD.toFixed(3)} m from the shoulder`);
  await p.keyboard.press('Control+z');
  // scene view: arrange from the top
  await p.click('#vp-sketch .vpbar .ib[aria-label="Add viewport"]'); await p.click('.pop .mi >> text=Top'); await p.waitForTimeout(150);
  await p.selectOption('#vp-view1 select.vmode', 'scene'); await p.waitForTimeout(150);
  { const h = await ev(id => window.stickform.tileApi.view1.handle(id), pid), z0 = await ev(() => window.stickform.actors[1].data.place.p[2]);
    await drag([[h.x, h.y], [h.x, h.y + 15], [h.x, h.y + 30]]);
    C.ok(await ev(() => window.stickform.actors[1].data.place.p[2]) > z0 + 0.1, 'Scene view (top): dragging a ◆ moves that character over the floor');
    await p.keyboard.press('Control+z');
    C.ok(Math.abs(await ev(() => window.stickform.actors[1].data.place.p[2]) - z0) < 1e-6, 'one undo per drag');
    const h2 = await ev(id => window.stickform.tileApi.view1.handle(id), pid); await p.mouse.click(h2.x, h2.y); await p.waitForTimeout(80);
    C.ok((await sc())[1].active, 'clicking a character there switches to it'); }
  await p.selectOption('#vp-view1 select.vmode', 'char');
  await p.click('#vp-view1 .vpbar .ib[aria-label="Close viewport"]');
  // Reset frames everyone in 2D; Focus frames one item in every view
  await p.click('#chars .crow:nth-child(1) .cname');
  await ev(() => { const s = window.stickform; s.posing.setPlace([0, 0, 0], [0, 0, 0, 1]); s.actors[1].data = { ...s.actors[1].data, place: { p: [4, 0, 0], q: [0, 0, 0, 1] } }; s.update(); });
  const inSk = async () => ev(() => { const s = window.stickform, f = s.internals.FRAME.get(s.J), r = document.getElementById('sk').getBoundingClientRect();
    const pts = [s.J.H, s.J.lL2, ...s.others().flatMap(o => [o.J.H, o.J.lL2, o.J.aR2, o.J.aL2])].map(X => s.canvas.toPx({ x: f.o.x + X[0] / f.s, y: f.o.y - X[1] / f.s }));
    return { z: s.canvas.view.z, all: pts.every(q => q.x >= 0 && q.x <= r.width && q.y >= 0 && q.y <= r.height) }; });
  await p.click('#vp-sketch .vpbar .ib[aria-label="Reset view"]');
  { const r = await inSk(); C.ok(r.all && r.z < 1, 'Reset view in the sketch zooms out to frame every character, however far apart', JSON.stringify(r)); }
  await p.click('#chars .crow:nth-child(2) .ci[aria-label^="Focus"]'); await p.waitForTimeout(80);
  { const r = await ev(() => { const s = window.stickform, f = s.internals.FRAME.get(s.J), o = s.others()[0], q = s.canvas.toPx({ x: f.o.x + o.J.S1[0] / f.s, y: f.o.y - o.J.S1[1] / f.s }), b = document.getElementById('sk').getBoundingClientRect();
      const t = s.outVP.controls.target, g = s.actors[1].group, hp = s.actors[1].rig.bones.hips.getWorldPosition(t.clone());
      return { cx: q.x / b.width, cy: q.y / b.height, preset: s.out.preset, d: Math.hypot(t.x - hp.x, t.z - hp.z) }; });
    C.ok(Math.abs(r.cx - 0.5) < 0.15 && r.preset === 'free' && r.d < 0.5, 'Focus on a row frames that character in the sketch and in 3D (output camera goes to Free)', JSON.stringify(r)); }
  await p.click('#vp-output .vpbar .ib[aria-label="Reset view"]');
  C.ok(await ev(() => window.stickform.out.preset) !== 'free', 'Reset view in 3D goes back to the camera preset');
  await p.keyboard.press('f'); await p.waitForTimeout(60);
  { const r = await ev(() => { const s = window.stickform, f = s.internals.FRAME.get(s.J), q = s.canvas.toPx({ x: f.o.x + s.J.S1[0] / f.s, y: f.o.y - s.J.S1[1] / f.s }), b = document.getElementById('sk').getBoundingClientRect(); return q.x / b.width; }); C.ok(Math.abs(r - 0.5) < 0.15, 'F focuses the selected character', String(r)); }
  // very far apart, then the window changes size: the framing is redone, nothing is cut off
  await ev(() => { const s = window.stickform; s.actors[1].data = { ...s.actors[1].data, place: { p: [45, 0, 0], q: [0, 0, 0, 1] } }; s.update(); });
  await p.click('#vp-sketch .vpbar .ib[aria-label="Reset view"]');
  { const r = await inSk(); C.ok(r.all, 'Reset frames characters 45 m apart', JSON.stringify(r)); }
  await p.setViewportSize({ width: 1200, height: 760 }); await p.waitForTimeout(300);
  { const r = await inSk(); C.ok(r.all, 'after the window is resized, they are still all in view (Reset keeps holding until you pan or zoom)', JSON.stringify(r)); }
  await p.click('#vp-output .vpbar .ib[aria-label="Reset view"]'); await p.waitForTimeout(80);
  C.ok(await ev(() => { const s = window.stickform, v = s.outVP, c = v.camera, d = c.position.distanceTo(v.controls.target); return c.far > d + 20; }), 'the 3D camera sees that far too (its view distance grows with the scene)');
  // narrow title bars scroll with the mouse wheel
  { const bar = '#vp-output .vpbar';
    const w0 = await ev(b => { const e = document.querySelector(b); return [e.scrollWidth, e.clientWidth]; }, bar);
    await p.setViewportSize({ width: 900, height: 760 }); await p.waitForTimeout(250);
    const o = await ev(b => { const e = document.querySelector(b); return [e.scrollWidth, e.clientWidth, e.classList.contains('ovr')]; }, bar);
    if (o[0] > o[1] + 1) {
      const bb = await p.locator(bar).boundingBox(); await p.mouse.move(bb.x + bb.width / 2, bb.y + 20); await p.mouse.wheel(0, 300); await p.waitForTimeout(100);
      const sl = await ev(b => document.querySelector(b).scrollLeft, bar);
      C.ok(o[2] && sl > 0, 'a title bar too narrow for its buttons fades at the edge and scrolls with the mouse wheel', JSON.stringify([w0, o, sl]));
    } else C.ok(true, 'title bar wide enough at this size (scroll not needed)'); }
  await p.setViewportSize({ width: 1440, height: 900 }); await p.waitForTimeout(250);
  await ev(() => { const s = window.stickform; s.actors[1].data = { ...s.actors[1].data, place: { p: [0.62, 0, 0], q: [0, 0, 0, 1] } }; s.update(); });
  await p.click('#vp-sketch .vpbar .ib[aria-label="Reset view"]');
  C.eq(await ev(() => window.stickform.canvas.view.z), 1, 'when everyone fits, Reset is the usual view');
  // files: a scene file with both, render name, open again
  const sceneF = await ev(() => window.stickform.saveScene());
  C.ok(sceneF.format === 'stickform-scene' && sceneF.characters.length === 2 && sceneF.characters[1].name === 'Partner' && sceneF.characters[1].pose.place, 'Save scene writes both characters (pose, place, model, colour)');
  const [rdl] = await Promise.all([p.waitForEvent('download'), p.keyboard.press('Control+Enter')]);
  C.ok(/-2-characters-/.test(rdl.suggestedFilename()), 'the render is named for the scene', rdl.suggestedFilename());
  await p.click('#chars .crow:nth-child(2) .ci[aria-label^=\"More\"]'); await p.click('#itempop .mi:has-text(\"Delete\")');
  C.eq((await sc()).length, 1, 'Delete removes a character');
  await ev(f => window.stickform.loadScene(f), sceneF); await p.waitForTimeout(150);
  A = await sc();
  C.ok(A.length === 2 && A[1].name === 'Partner' && A[1].tint === '#c7a796', 'opening the scene file brings both back', JSON.stringify(A));
  await ev(() => window.stickform.loadPose(window.stickform.BUILTIN[0]));
  await p.click('#chars .crow:nth-child(2) .ci[aria-label^=\"More\"]'); await p.click('#itempop .mi:has-text(\"Delete\")');
  await p.keyboard.press('p');

  // ---- Attach (lasting contacts) and IK drags
  C.section('Attach and IK drags');
  const holdD = () => ev(() => { const m = window.stickform.marks.find(x => x.active); return m ? { state: m.state, d: Math.hypot(m.T[0] - m.E[0], m.T[1] - m.E[1], m.T[2] - m.E[2]) } : null; });
  const vpPx = (a, b, k) => ev(([a, b, k]) => { const s = window.stickform, B = s.rig.bones, w = B[a].getWorldPosition(B.hips.position.clone()).lerp(B[b].getWorldPosition(B.hips.position.clone()), k), q = s.outVP.project(w), r = s.outVP.canvas.getBoundingClientRect(); return [r.left + q.x, r.top + q.y]; }, [a, b, k]);
  const drag3 = async (a, dx, dy, n = 12) => { await p.mouse.move(a[0], a[1]); await p.mouse.down(); for (let i = 1; i <= n; i++) await p.mouse.move(a[0] + dx * i / n, a[1] + dy * i / n); await p.mouse.up(); await p.waitForTimeout(120); };
  await p.click('#addbtn'); await p.click('#addchar'); await p.waitForTimeout(150);
  await ev(() => { const s = window.stickform; s.posing.movePlace([0.62, 0, 0]); s.update(); });
  const ids = await ev(() => window.stickform.actors.map(a => a.id));
  C.eq(await p.getAttribute('#pattach', 'aria-checked'), 'false', 'Keep attached is off at first (Reach to… snaps once)');
  await p.click('#pattach'); C.eq(await p.getAttribute('#pattach', 'aria-checked'), 'true', 'the Keep attached switch turns on'); await p.click('#pattach');
  // Shift R: reach and attach once
  await p.keyboard.press('v');
  const side = await ev(() => { const J = window.stickform.J; return J.aL2[0] < J.aR2[0] ? 'L' : 'R'; });
  { const J = await ev(() => window.stickform.J), m = J['a' + side + '1'].map((v, i) => (v + J['a' + side + '2'][i]) / 2), c = await frontPx(m); await p.mouse.click(c[0], c[1]); }
  await p.keyboard.press('Shift+R');
  C.ok(await pressed('#preach') === 'true' && await ev(() => window.stickform.posing.reachAttach), 'Shift R waits for a point to hold on to');
  { const o = (await ev(() => window.stickform.others()))[0], c = await frontPx(o.J.S2); await p.mouse.move(c[0], c[1]); await p.waitForTimeout(80);
    const h = await ev(() => window.stickform.posing.reachHover);
    await p.mouse.move(c[0] + 300, c[1] - 300); await p.waitForTimeout(60);
    const off = await ev(() => window.stickform.posing.reachHover);
    C.ok(Array.isArray(h) && off === null, 'while reaching, hovering a character marks where the hand would land (nothing off the body)', JSON.stringify([h, off])); }
  { const o = (await ev(() => window.stickform.others()))[0], sh = o.J.shL[0] > o.J.shR[0] ? o.J.shL : o.J.shR, c = await frontPx(sh); await p.mouse.click(c[0], c[1]); await p.waitForTimeout(150); }
  let cs = await ev(() => window.stickform.posing.contacts);
  C.ok(cs.length === 1 && cs[0].part === 'arm' + side && cs[0].to === ids[0], 'clicking the other character\'s shoulder attaches the hand to it', JSON.stringify(cs));
  { const h = await holdD(); C.ok(h && h.state === 'ok' && h.d < 0.01, 'the hand touches the spot', JSON.stringify(h)); }
  C.ok(await p.isVisible('#pconts') && (await p.textContent('#pconts')).includes('Character 1') && (await p.textContent('#pconts .cst')) === 'touching', 'the Pose card lists the contact (who, where, touching)');
  { // the attached arm carries a link sign in the sketch (pixels drawn next to its hand)
    const J = await ev(() => window.stickform.J), hp = await frontPx(J['a' + side + '2']);
    const px = await ev(([x, y]) => { const cv = document.getElementById('sk'), r = cv.getBoundingClientRect(), k = cv.width / r.width, d = cv.getContext('2d').getImageData(Math.round((x - r.left + 10) * k) - 2, Math.round((y - r.top + 10) * k) - 2, 4, 4).data; let g = 0; for (let i = 0; i < d.length; i += 4) g = Math.max(g, d[i + 1] - d[i]); return g; }, hp);
    C.ok(px > 10, 'an attached hand shows a link sign beside it (like the padlock for pins)', String(px)); }
  C.ok((await p.textContent('#chars .crow:nth-child(2) .cname span')).includes('1 attached'), 'the Scene card shows it on the holder\'s row');
  // it follows the other character: moved, turned, re-posed
  await ev(() => { const s = window.stickform; s.actors[0].data = { ...s.actors[0].data, place: { p: [0.05, -0.05, 0.12], q: [0, 0, 0, 1] } }; s.update(); });
  { const h = await holdD(); C.ok(h.state === 'ok' && h.d < 0.01, 'when the other character moves, the hand follows', JSON.stringify(h)); }
  await ev(() => { const s = window.stickform, a = 0.35; s.actors[0].data = { ...s.actors[0].data, place: { p: [0.05, -0.05, 0.12], q: [0, Math.sin(a / 2), 0, Math.cos(a / 2)] } }; s.update(); });
  { const h = await holdD(); C.ok(h.state === 'ok' && h.d < 0.01, '… and when it turns', JSON.stringify(h)); }
  await ev(() => { const s = window.stickform, k = new s.internals.Sketch(); s.internals.fromFile(k, s.BUILTIN.find(b => /lean/i.test(b.name)) || s.BUILTIN[1]); const d = s.actors[0].data; s.actors[0].data = { ...d, strokes: k.strokes, nid: k.nid, depth: k.depth, flips: k.flips, away: k.away }; s.update(); });
  { const h = await holdD(); C.ok(h && (h.state === 'ok' ? h.d < 0.01 : h.state === 'far'), '… and when it takes another pose (or stretches toward it, marked can\'t reach)', JSON.stringify(h)); }
  await ev(() => { const s = window.stickform, k = new s.internals.Sketch(); s.internals.fromFile(k, s.BUILTIN[0]); const d = s.actors[0].data; s.actors[0].data = { ...d, strokes: k.strokes, nid: k.nid, depth: k.depth, flips: k.flips, away: k.away, place: { p: [0, 0, 0], q: [0, 0, 0, 1] } }; s.update(); });
  // numbers
  await p.fill('#pconts .pcont input >> nth=0', '60'); await p.press('#pconts .pcont input >> nth=0', 'Enter'); await p.waitForTimeout(80);
  C.ok(Math.abs((await ev(() => window.stickform.posing.contacts[0].t)) - 0.6) < 1e-9 && (await holdD()).d < 0.01, 'Along (%) moves the held spot along the bone; the hand goes with it');
  // lock pauses, unlock resumes
  await p.keyboard.press('Shift+K');
  await ev(() => { const s = window.stickform; s.actors[0].data = { ...s.actors[0].data, place: { p: [0, 0, 0.15], q: [0, 0, 0, 1] } }; s.update(); });
  { const h = await holdD(); C.ok(h.state === 'paused' && h.d > 0.05, 'a locked holder pauses its contacts (the hand stays)', JSON.stringify(h)); }
  await p.keyboard.press('Shift+K');
  { const h = await holdD(); C.ok(h.state === 'ok' && h.d < 0.01, 'unlocked, the hand catches up', JSON.stringify(h)); }
  // editing the limb by hand detaches it; undo brings the contact back
  { const J = await ev(() => window.stickform.J), m = J['a' + side + '1'].map((v, i) => (v * 0.3 + J['a' + side + '2'][i] * 0.7)), c = await frontPx(m); await p.mouse.click(c[0], c[1]); }
  await p.keyboard.press('ArrowUp'); await p.waitForTimeout(60);
  C.eq(await ev(() => window.stickform.posing.contacts.length), 0, 'nudging the attached arm frees it (edits detach)');
  await p.keyboard.press('Control+z');
  C.eq(await ev(() => window.stickform.posing.contacts.length), 1, 'undo brings the contact back');
  await p.click('#pconts .pcont button:has-text("Detach")');
  C.eq(await ev(() => window.stickform.posing.contacts.length), 0, 'Detach lets go');
  await p.keyboard.press('Control+z');
  // files: the scene keeps it (by position in the file), a pose on its own does not
  const sf2 = await ev(() => window.stickform.saveScene());
  C.ok(sf2.characters[1].pose.attach?.[0]?.to === 0 && !sf2.characters[0].pose.attach, 'Save scene writes the contact (who by their place in the file)', JSON.stringify(sf2.characters[1].pose.attach));
  C.ok(!(await ev(() => window.stickform.poseFile('x'))).attach, 'a pose saved on its own leaves out contacts with others');
  await ev(f => window.stickform.loadScene(f), sf2); await p.waitForTimeout(150);
  { const c2 = await ev(() => { const s = window.stickform; return [s.posing.contacts, s.actors.map(a => a.id)]; }); C.ok(c2[0].length === 1 && c2[0][0].to === c2[1][0], 'opening the scene file brings the contact back', JSON.stringify(c2)); }
  { const h = await holdD(); C.ok(h.state === 'ok' && h.d < 0.01, '… touching', JSON.stringify(h)); }
  // deleting the held character lets go; undo restores both
  await p.click('#chars .crow:nth-child(1) .ci[aria-label^="More"]'); await p.click('#itempop .mi:has-text("Delete")');
  C.ok(await ev(() => window.stickform.actors.length === 1 && window.stickform.posing.contacts.length === 0), 'deleting the held character removes the contact');
  await p.keyboard.press('Control+z');
  C.ok(await ev(() => window.stickform.actors.length === 2 && window.stickform.posing.contacts.length === 1), 'undo brings back the character and the contact');
  // loops are refused: the held arm cannot hold this arm back
  { const r = await ev(() => { const s = window.stickform, me = s.active, other = s.actors.find(a => a !== me), P = s.posing.contacts[0].part;
      s.posing.contacts = [{ part: P, to: other.id, bone: 'armL2', t: 0.5, off: [0, 0, 0] }]; s.update();
      s.activate(other.id);
      const W = s.worldFigs().find(f => f.id === me.id).J, a1 = P === 'armL' ? W.aL1 : W.aR1, a2 = P === 'armL' ? W.aL2 : W.aR2;
      const V = s.rig.bones.hips.position.clone().set((a1[0] + a2[0]) / 2, (a1[1] + a2[1]) / 2, (a1[2] + a2[2]) / 2);
      const res = s.anchorAt(me.id, V, 'armL');
      s.activate(me.id); return res; });
    C.ok(r === null, 'a loop (two limbs holding each other) is refused', JSON.stringify(r)); }
  await ev(() => { const s = window.stickform; s.posing.contacts = []; s.update(); });
  // a hand on its own hip follows when the spine bends
  await p.keyboard.press('Escape');
  await ev(sd => { window.stickform.posing.sel = 'arm' + sd + '2'; window.stickform.canvas.selected = null; }, side); // (a clicked stroke's pill could cover the hip)
  await p.keyboard.press('Shift+R');
  { const J = await ev(() => window.stickform.J), h = side === 'L' ? J.hpL : J.hpR, c = await frontPx(h.map((v, i) => v * 0.8 + J.P[i] * 0.2)); await p.mouse.click(c[0], c[1]); await p.waitForTimeout(120); }
  { const r = await ev(() => [window.stickform.posing.contacts[0]?.to, document.getElementById('toast').textContent, window.stickform.posing.sel, window.stickform.posing.reaching]);
    C.ok(r[0] === -1, 'a hand can hold its own body', JSON.stringify(r)); }
  await ev(() => window.stickform.posing.bake(d => { const a = 0.4, v = d.spine1; d.spine1 = [v[0] * Math.cos(a) - v[1] * Math.sin(a), v[0] * Math.sin(a) + v[1] * Math.cos(a), v[2]]; }));
  { const h = await holdD(); C.ok(h && (h.state === 'ok' ? h.d < 0.01 : true) && h.state !== 'paused', 'bending the spine: the hand stays on the hip', JSON.stringify(h)); }
  C.ok((await ev(() => window.stickform.poseFile('x'))).attach?.length === 1, 'a pose file keeps contacts with its own body');
  await ev(() => { const s = window.stickform; s.posing.contacts = []; s.loadPose(s.BUILTIN[0]); s.update(); });
  // IK: drag a bone with the select tool
  await p.keyboard.press('Escape'); await p.keyboard.press('v');
  const preset0 = await ev(() => window.stickform.out.preset), J0 = await ev(() => JSON.stringify(window.stickform.J)), pl0 = await ev(() => window.stickform.posing.place.p);
  await drag3(await vpPx('rightHand', 'rightLowerArm', 0.15), -30, -90);
  C.ok(await ev(() => JSON.stringify(window.stickform.J)) !== J0 && await ev(() => window.stickform.out.preset) === preset0, 'dragging a forearm in 3D moves the hand (IK) without orbiting the camera');
  C.ok(await ev(p0 => { const s = window.stickform; return s.posing.place.p.every((v, i) => Math.abs(v - p0[i]) < 1e-6); }, pl0), 'a small drag only bends the arm (the body stays)');
  C.ok(/^arm[LR]2$/.test(await ev(() => window.stickform.posing.sel)), 'the press also selected the bone (forearm)');
  await p.keyboard.press('Control+z');
  C.ok(await ev(() => JSON.stringify(window.stickform.J)) === J0, 'one undo step per drag');
  await drag3(await vpPx('leftFoot', 'leftLowerLeg', 0.2), 300, 0, 20);
  C.ok(await ev(() => Math.hypot(window.stickform.posing.place.p[0], window.stickform.posing.place.p[2])) > 0.2, 'dragged far, the whole body comes along', JSON.stringify(await ev(() => window.stickform.posing.place)));
  await p.keyboard.press('Control+z');
  // pinned feet stay: drag the hips down, the knees bend
  await ev(() => { const s = window.stickform; s.posing.togglePin('legL'); s.posing.togglePin('legR'); });
  const feet = () => ev(() => { const B = window.stickform.rig.bones; return [B.leftFoot, B.rightFoot].map(b => b.getWorldPosition(b.position.clone()).toArray()); });
  const f0 = await feet(), hipY0 = await ev(() => { const B = window.stickform.rig.bones; return B.hips.getWorldPosition(B.hips.position.clone()).y; });
  await drag3(await vpPx('leftUpperLeg', 'rightUpperLeg', 0.5), 0, 80);
  { const f1 = await feet(), dy = hipY0 - await ev(() => { const B = window.stickform.rig.bones; return B.hips.getWorldPosition(B.hips.position.clone()).y; });
    const moved = Math.max(...f1.map((q, i) => Math.hypot(q[0] - f0[i][0], q[1] - f0[i][1], q[2] - f0[i][2])));
    C.ok(dy > 0.1 && moved < 0.03, 'with the legs pinned, dragging the hips down bends the knees and the feet stay put', JSON.stringify({ dy, moved })); }
  await p.keyboard.press('Control+z'); await p.keyboard.press('Control+z'); await p.keyboard.press('Control+z');
  // an attached holder: dragging its body keeps the hand on the other one
  await ev(() => { const s = window.stickform; s.posing.contacts = []; s.update(); });
  { const J = await ev(() => window.stickform.J), m = J['a' + side + '1'].map((v, i) => (v + J['a' + side + '2'][i]) / 2), c = await frontPx(m); await p.mouse.click(c[0], c[1]); }
  await p.keyboard.press('Shift+R');
  { const o = (await ev(() => window.stickform.others()))[0], sh = o.J.shL[0] > o.J.shR[0] ? o.J.shL : o.J.shR, c = await frontPx(sh); await p.mouse.click(c[0], c[1]); await p.waitForTimeout(150); }
  await drag3(await vpPx('hips', 'neck', 0.55), 25, 10);
  { const h = await holdD(); C.ok(await ev(() => window.stickform.posing.contacts.length) === 1 && h.state !== 'paused' && (h.state === 'far' || h.d < 0.01), 'dragging the holder\'s body: the attached hand keeps hold', JSON.stringify(h)); }
  // a drag on the attached arm itself frees it
  { const at = await ev(() => { const s = window.stickform, m = s.marks.find(x => x.active), q = s.outVP.project(s.rig.bones.hips.position.clone().set(...m.E)), r = s.outVP.canvas.getBoundingClientRect(); return [r.left + q.x, r.top + q.y]; });
    await drag3(at, 0, -60); }
  C.eq(await ev(() => window.stickform.posing.contacts.length), 0, 'dragging the attached arm itself frees it');
  // Stick: never lets go; the character not being changed is pulled along by its own IK
  await ev(() => { const s = window.stickform; s.posing.contacts = []; s.loadPose(s.BUILTIN[0]); s.posing.movePlace([0.62, 0, 0]); s.actors[0].data = { ...s.actors[0].data, place: { p: [0, 0, 0], q: [0, 0, 0, 1] } }; s.update(); });
  await ev(sd => { window.stickform.posing.sel = 'arm' + sd + '2'; window.stickform.canvas.selected = null; }, side);
  await p.keyboard.press('Shift+R');
  { const o = (await ev(() => window.stickform.others()))[0], sh = o.J.shL[0] > o.J.shR[0] ? o.J.shL : o.J.shR, c = await frontPx(sh); await p.mouse.click(c[0], c[1]); await p.waitForTimeout(150); }
  C.ok(await p.isVisible('#pconts .cmode button[data-mode="follow"][aria-pressed="true"]'), 'a new contact follows (Follow is the default)');
  await p.click('#pconts .cmode button[data-mode="stick"]');
  C.eq(await ev(() => window.stickform.posing.contacts[0]?.mode), 'stick', 'Stick switches the contact to never let go');
  const hx0 = await ev(() => window.stickform.posing.place.p[0]);
  await ev(id => window.stickform.moveBy(id, [-1.4, 0, 0.3], true), ids[0]);
  { const h = await holdD(), hx = await ev(() => window.stickform.posing.place.p[0]);
    C.ok(h.state === 'ok' && h.d < 0.01 && hx < hx0 - 0.6, 'Stick: moving the held character far away pulls the holder along (hand stays on)', JSON.stringify({ h, hx0, hx })); }
  const ox0 = await ev(() => window.stickform.actors[0].data.place.p[0]);
  await ev(() => { const s = window.stickform, p0 = s.posing.place.p; s.posing.setPlace([p0[0] + 1.5, p0[1], p0[2]], [0, 0, 0, 1]); });
  { const h = await holdD(), ox = await ev(() => window.stickform.actors[0].data.place.p[0]);
    C.ok(h.state === 'ok' && h.d < 0.01 && ox > ox0 + 0.6, '… and moving the holder far away pulls the held character along', JSON.stringify({ h, ox0, ox })); }
  await p.click('#pconts .cmode button[data-mode="follow"]');
  { const hx1 = await ev(() => window.stickform.posing.place.p[0]);
    await ev(id => window.stickform.moveBy(id, [-2, 0, 0], true), ids[0]);
    const h = await holdD();
    C.ok(h.state === 'far' && Math.abs(await ev(() => window.stickform.posing.place.p[0]) - hx1) < 1e-6, 'Follow: too far, the hand only stretches toward it (nobody is pulled)', JSON.stringify(h)); }
  C.ok((await ev(() => window.stickform.saveScene())).characters[1].pose.attach?.[0]?.mode === undefined, 'Follow is the default in files (only Stick is written)');
  // clean up
  await ev(() => { const s = window.stickform; s.posing.contacts = []; s.loadPose(s.BUILTIN[0]); });
  await p.click('#chars .crow:nth-child(1) .ci[aria-label^="More"]'); await p.click('#itempop .mi:has-text("Delete")');
  await p.keyboard.press('Escape'); await p.keyboard.press('p');

  // ---- the tool strip and the help box
  C.section('Tool strip and help');
  C.ok(await p.locator('#ws-pose > .rail').count() === 1 && await p.locator('.vp .rail').count() === 0, 'the tool strip is its own column, not part of any viewport');
  { const sk = await p.locator('#vp-sketch').boundingBox(), rl = await p.locator('#ws-pose > .rail').boundingBox();
    C.ok(rl.x + rl.width <= sk.x + 1 && rl.height > 300, 'it runs down the left of the workspace, beside the viewports', JSON.stringify([rl, sk])); }
  const help = () => ev(() => { const h = document.getElementById('helpbox'); return h && !h.hidden ? { vp: h.closest('.vp')?.id, text: h.textContent } : null; });
  await ev(() => { localStorage.removeItem('stickform.help'); });
  { const sk = await p.locator('#sk').boundingBox(); await p.mouse.move(sk.x + 20, sk.y + 20); await p.mouse.down({ button: 'right' }); await p.mouse.up({ button: 'right' }); await p.waitForTimeout(80); }
  { const h = await help(); C.ok(h && h.vp === 'vp-sketch' && h.text.includes('Pen') && h.text.includes('head circle'), 'the help box shows the active tool in the view being worked in', JSON.stringify(h) + await ev(() => { const h = document.getElementById('helpbox'); const pa = document.getElementById('paper').getBoundingClientRect(); return JSON.stringify({ exists: !!h, hidden: h?.hidden, parent: h?.parentElement?.id, w: pa.width, hgt: pa.height, ws: document.getElementById('ws-pose').hidden }); })); }
  await p.keyboard.press('v');
  { const h = await help() || { text: '' }; C.ok(h.text.includes('Select') && h.text.includes('Drag bone') && h.text.includes('whole character'), 'Select: click, IK drag and G (whole character) are explained', h.text); }
  { const vb = await p.locator('#v3').boundingBox(); await p.mouse.click(vb.x + 40, vb.y + vb.height - 40); await p.waitForTimeout(80); }
  { const h = await help(); C.ok(h.vp === 'vp-output' && h.text.includes('orbit'), 'working in 3D moves the help there (and it says how to orbit)', JSON.stringify(h)); }
  { const hb = await p.locator('#helpbox').boundingBox(), tr = await p.locator('#vp-output .tr').boundingBox(), st = await p.locator('#vp-output .stage3d').boundingBox();
    C.ok(hb.y >= tr.y + tr.height && hb.x + hb.width <= st.x + st.width && hb.height <= st.height * 0.56, 'docked top right below the camera buttons, never more than about half the view', JSON.stringify([hb, tr, st])); }
  await p.click('#vp-output .vpbar .helpbtn');
  C.ok(await help() === null && await ev(() => localStorage.getItem('stickform.help')) === 'false', 'its button hides it (remembered)');
  await p.keyboard.press('?');
  C.ok(await help() !== null, '? shows it again');
  { const J = await ev(() => window.stickform.J), m = J.shL.map((v, i) => (v + J.aL1[i]) / 2), c = await frontPx(m); await p.mouse.click(c[0], c[1]); await p.waitForTimeout(80); }
  { const h = await help(); C.ok(h.vp === 'vp-sketch' && h.text.includes('Upper arm left') && h.text.includes('Rings') && h.text.includes('Ball'), 'a selected bone: the help shows what its handles and keys do', JSON.stringify(h)); }
  C.ok(await p.locator('.insp .phint, #pb-hint, .insp .pchint').count() === 0, 'the inspector holds no instructions, only values and buttons');
  await p.keyboard.press('r');
  { const h = await help(); C.ok(h.text.includes('Reach with the hand') && h.text.includes('Esc'), 'Reach to… explained while it waits for a click', h.text); }
  await p.keyboard.press('Escape'); await p.keyboard.press('Escape'); await p.keyboard.press('d');
  { const h = await help(); C.ok(h.text.includes('Edit pen') && h.text.includes('Shift'), 'the edit pen has its own help', h.text); }
  await p.keyboard.press('p');

  // ---- open tabs and the Save menu
  C.section('Tabs and saving');
  const tabs = () => ev(() => window.stickform.docs.map(d => d === window.stickform.curDoc ? '*' + document.getElementById('pnametext').textContent : d.name));
  await ev(() => { const s = window.stickform; while (s.docs.length > 1) s.docs.splice(0, 1); });
  await p.click('#newtab'); await p.waitForTimeout(100);
  { const D = await ev(() => window.stickform.internals.dirsOf(window.stickform.J)); const t = await tabs();
    C.ok(t.at(-1) === '*Untitled' && D.armL1[1] < -0.8 && D.armL1[1] > -0.9 && await ev(() => window.stickform.actors.length) === 1 && await p.isDisabled('#undo'), '+ opens an untitled tab: one mannequin in the idle A-pose, its own empty history', JSON.stringify(t)); }
  await p.click('#savemenu');
  C.ok(await p.isDisabled('#savepop .mi:has-text("Save scene")') && await p.isVisible('#savepop .mi:has-text("Save pose as")'), 'with one character the Save menu greys out Save scene; Save pose and Save pose as… are there');
  await p.keyboard.press('Escape'); await p.click('body', { position: { x: 5, y: 300 } }).catch(() => {});
  await p.click('#thumbs .thumb:has-text("High kick")'); await p.waitForTimeout(100);
  C.ok((await tabs()).at(-1) === '*High kick' && !(await p.isVisible('#pedited')), 'an untouched tab: a thumbnail opens that pose right here');
  await ev(() => window.stickform.posing.bake(d => { d.armL1 = [0, 1, 0]; }));
  C.ok(await p.isVisible('#pedited'), 'changes mark the tab (dot)');
  const nTabs = (await tabs()).length;
  await p.click('#thumbs .thumb:has-text("Lying")'); await p.waitForTimeout(150);
  { const t = await tabs(); C.ok(t.length === nTabs + 1 && t.at(-1).startsWith('*Lying') && t.includes('High kick'), 'with unsaved changes, a thumbnail opens in a new tab instead (nothing is lost)', JSON.stringify(t)); }
  await p.click('#doctabs .dtab:has-text("High kick") .dname'); await p.waitForTimeout(100);
  C.ok((await ev(() => window.stickform.internals.dirsOf(window.stickform.J).armL1))[1] > 0.99 && await p.isVisible('#pedited') && !(await p.isDisabled('#undo')), 'switching back: the edit, the dot and the undo history are all still there');
  await p.keyboard.press('Control+z');
  C.ok((await ev(() => window.stickform.internals.dirsOf(window.stickform.J).armL1))[1] < 0.9, 'undo works per tab');
  await ev(() => window.stickform.posing.bake(d => { d.armL1 = [0, 1, 0]; }));
  await p.click('#doctabs .dtab[aria-selected="true"] .dx'); await p.waitForTimeout(100);
  C.ok(await p.evaluate(() => document.getElementById('dlg-choice').open && /High kick/.test(document.getElementById('ch-h').textContent)), 'closing a tab with unsaved changes asks: Don’t save, Cancel, Save');
  await p.click('#ch-acts button[value="cancel"]'); await p.waitForTimeout(80);
  C.ok((await tabs()).some(t => t === '*High kick'), 'Cancel keeps it open');
  await p.click('#doctabs .dtab[aria-selected="true"] .dx'); await p.click('#ch-acts button[value="discard"]'); await p.waitForTimeout(100);
  C.ok(!(await tabs()).some(t => t.includes('High kick')), 'Don’t save closes it');
  // ↗ on a thumbnail opens on its own, even inside a scene
  await p.click('#addbtn'); await p.click('#addchar'); await p.waitForTimeout(100);
  const sceneTab = await ev(() => window.stickform.curDoc.id);
  await p.hover('#thumbs .thumb:has-text("Leaning")'); await p.click('#thumbs .thumb:has-text("Leaning") .topen'); await p.waitForTimeout(150);
  C.ok(await ev(() => window.stickform.actors.length) === 1 && (await tabs()).at(-1).startsWith('*Leaning'), 'from a scene, a thumbnail’s ↗ opens that pose in its own tab (the scene stays open in its tab)');
  await ev(id => window.stickform.switchTo(window.stickform.docs.find(d => d.id === id)), sceneTab); await p.waitForTimeout(100);
  C.eq(await ev(() => window.stickform.actors.length), 2, 'and the scene is still there, with both characters');
  await p.click('#chars .crow:nth-child(2) .ci[aria-label^="More"]'); await p.click('#itempop .mi:has-text("Open its pose on its own")'); await p.waitForTimeout(150);
  C.ok(await ev(() => window.stickform.actors.length) === 1, '⋯ › Open its pose on its own: that character’s pose in a new tab');
  // leaving the page with unsaved changes warns
  await ev(() => window.stickform.posing.bake(d => { d.armR1 = [0, 1, 0]; }));
  C.ok(await ev(() => { const e = new Event('beforeunload', { cancelable: true }); dispatchEvent(e); return e.defaultPrevented; }), 'leaving the page with unsaved changes in a tab asks first');
  // tidy up: one clean tab with the standing example
  await ev(() => { const s = window.stickform; for (const d of [...s.docs]) if (d !== s.curDoc) s.docs.splice(s.docs.indexOf(d), 1); });
  while (await ev(() => window.stickform.actors.length) > 1) { await p.click('#chars .crow:nth-child(2) .ci[aria-label^="More"]'); await p.click('#itempop .mi:has-text("Delete")'); }
  await ev(() => window.stickform.loadPose(window.stickform.BUILTIN[0]));

  // ---- characters
  C.section('Characters');
  if (await loadModel(p, 'Xbot.glb')) {
    C.eq(await p.textContent('#rigname'), 'Xbot', 'loading a GLB switches to it');
    await p.click('#rigbtn');
    C.eq(await p.locator('#rigpop .mi[role="menuitemradio"]').count(), 2, 'character menu lists the mannequin and the loaded model');
    await p.click('#rigpop >> text=Bone mapping…');
    C.ok(await p.isVisible('#dlg-map') && (await p.locator('#map select').count()) === 22, 'Bone mapping opens with all 22 slots');
    await p.click('#dlg-map [data-close]');
    await p.click('#rigbtn'); await p.click('#rigpop >> text=Mannequin');
    C.eq(await p.textContent('#rigname'), 'Mannequin', 'switching back to the mannequin');
  } else C.skip('loading a GLB character', 'models/Xbot.glb is missing');

  // ---- new figures become new characters
  C.section('New figures');
  {
    await ev(() => window.stickform.loadPose(window.stickform.BUILTIN[0]));
    await p.click('#clear'); await p.keyboard.press('p');
    const r = await p.locator('#sk').boundingBox();
    const P = (x, y) => [r.x + r.width * x, r.y + r.height * y];
    const stroke = async pts => { await p.mouse.move(...P(...pts[0])); await p.mouse.down(); for (const q of pts.slice(1)) await p.mouse.move(...P(...q), { steps: 5 }); await p.mouse.up(); };
    const head = async (cx, k = 1) => { const c = []; for (let i = 0; i <= 24; i++) { const a = i / 24 * Math.PI * 2; c.push([cx + 0.035 * k * Math.cos(a), 0.22 + 0.03 * k * Math.sin(a)]); } await stroke(c); };
    const spine = async (cx, k = 1) => { const y = v => 0.22 + (v - 0.22) * k; await stroke([[cx, y(0.252)], [cx, y(0.48)]]); };
    const limbs = async (cx, k = 1) => {
      const y = v => 0.22 + (v - 0.22) * k, x = v => cx + v * k;
      await stroke([[cx, y(0.28)], [x(-0.07), y(0.36)], [x(-0.1), y(0.30)]]);
      await stroke([[cx, y(0.28)], [x(0.07), y(0.35)], [x(0.1), y(0.43)]]);
      await stroke([[cx, y(0.48)], [x(-0.04), y(0.6)], [x(-0.05), y(0.72)]]);
      await stroke([[cx, y(0.48)], [x(0.05), y(0.6)], [x(0.07), y(0.7)]]);
    };
    const body = async (cx, k = 1) => { await spine(cx, k); await limbs(cx, k); };
    const n = () => ev(() => window.stickform.actors.length);
    await head(0.3); await body(0.3);
    C.eq(await n(), 1, 'the first figure drawn goes onto the character being edited');
    const drawn1 = await ev(() => JSON.stringify(window.stickform.sketch.strokes.filter(s => !s.splitOf).map(s => s.pts)));
    const view0 = await ev(() => JSON.stringify(window.stickform.canvas.view));
    // drawn higher: in the air; drawn lower: lower (the first character is the anchor)
    { const ys = []; for (const dy of [-0.12, 0.1]) {
        await ev(() => window.stickform.activate(window.stickform.actors[0].id));
        const c = []; for (let i = 0; i <= 24; i++) { const a = i / 24 * Math.PI * 2; c.push([0.66 + 0.03 * Math.cos(a), 0.22 + dy + 0.025 * Math.sin(a)]); } await stroke(c);
        await stroke([[0.66, 0.247 + dy], [0.66, 0.45 + dy]]);
        ys.push(await ev(() => window.stickform.posing.place.p[1]));
        if (dy < 0) C.ok(await ev(() => JSON.stringify(window.stickform.othersFront().find(o => o.name === 'Character 1').strokes)) === drawn1, 'the others\' drawings stay exactly where they were');
        while (await n() > 1) await ev(() => window.stickform.deleteCharacter(window.stickform.actors[1]));
      }
      C.ok(ys.length === 2 && ys[0] > 0.25 && ys[1] < -0.15, 'a figure drawn higher stands in the air, one drawn lower stands lower', JSON.stringify(ys));
    }
    await head(0.72);
    C.ok(await n() === 1 && await ev(() => window.stickform.pending.length) === 1, 'a head drawn away from it waits as a new figure (no character yet)');
    C.ok((await ev(() => document.getElementById('helpbox')?.textContent || '')).includes('New figure'), 'the help box says what the new figure needs');
    await body(0.72);
    const A = await ev(() => window.stickform.actors.map(a => ({ name: a.name, active: a === window.stickform.active, x: a.group.position.x, y: a.group.position.y, s: a.group.scale.toArray() })));
    C.ok(A.length === 2 && A[1].active && A[1].x > 0.4 && Math.abs(A[1].y) < 0.12 && A[1].s.every(v => v === 1), 'with a head and a spine it becomes Character 2, standing to the right where it was drawn, at the same height, normal size', JSON.stringify(A));
    C.ok(await ev(() => JSON.stringify(window.stickform.canvas.view)) === view0, 'the sketch view does not move or zoom when it becomes a character');
    C.eq((await tags()).split(',').sort().join(','), 'armL,armR,head,legL,legR,spine', 'its arms and legs land on it (all six parts tagged)');
    C.eq(await ev(() => window.stickform.pending.length), 0, 'nothing is left waiting');
    C.ok(await ev(() => JSON.stringify(window.stickform.othersFront()[0].strokes)) === drawn1, 'the first character shows faintly exactly as it was drawn (no rescaling, no snapping)');
    // moving a character in 3D moves its faint drawing by the same amount
    { const s0 = await ev(() => window.stickform.othersFront()[0].strokes[0][0]);
      await ev(() => { const s = window.stickform, a = s.actors[0]; a.data = { ...a.data, place: { ...a.data.place, p: [a.data.place.p[0] + 0.5, a.data.place.p[1], a.data.place.p[2]] } }; s.update(); });
      const s1 = await ev(() => window.stickform.othersFront()[0].strokes[0][0]), m = await ev(() => window.stickform.pageMap.m);
      C.ok(Math.abs(s1.x - s0.x - 0.5 / m) < 1e-6 && Math.abs(s1.y - s0.y) < 1e-9, 'moving a character in 3D shifts its faint drawing by the same amount', JSON.stringify([s0, s1, m]));
      await ev(() => { const s = window.stickform, a = s.actors[0]; a.data = { ...a.data, place: { ...a.data.place, p: [a.data.place.p[0] - 0.5, a.data.place.p[1], a.data.place.p[2]] } }; s.update(); }); }
    // a small figure: still normal size (size never comes from the drawing)
    await ev(() => window.stickform.deleteCharacter(window.stickform.actors[1]));
    await head(0.75, 0.5); await spine(0.75, 0.5);
    const B = await ev(() => window.stickform.actors.map(a => ({ s: a.group.scale.toArray(), h: (() => { const b = a.rig.bones.head, f = a.rig.bones.hips; return b.getWorldPosition(b.position.clone()).distanceTo(f.getWorldPosition(f.position.clone())); })() })));
    C.ok(B.length === 2 && B[1].s.every(v => v === 1) && Math.abs(B[1].h - B[0].h) < 0.05, 'a figure drawn half size is still a normal-size character (Scale sets size, in 3D)', JSON.stringify(B));
    // undo: the last stroke and the character it made go together; the head waits again
    await p.keyboard.press('Control+z');
    C.ok(await n() === 1 && await ev(() => window.stickform.pending.length) === 1, 'undo takes back the stroke that made the character (the head waits again)');
    await p.keyboard.press('e'); { const q = await ev(() => { const s = window.stickform, pt = s.pending[0].pts[3], c = s.canvas.toPx(pt), r = document.getElementById('sk').getBoundingClientRect(); return [r.left + c.x, r.top + c.y]; }); await p.mouse.click(q[0], q[1]); }
    C.eq(await ev(() => window.stickform.pending.length), 0, 'Erase removes a waiting stroke');
    await p.keyboard.press('Control+z'); C.eq(await ev(() => window.stickform.pending.length), 1, 'and undo brings it back');
    await p.keyboard.press('p');
    await spine(0.75, 0.5); await limbs(0.75, 0.5);
    C.ok(await n() === 2 && await ev(() => window.stickform.sketch.strokes.filter(s => s.tag).length) === 6, 'drawing it again makes it a character again, and the rest land on it');
    // drawing on another character's faint figure adds to that character
    { const o = (await ev(() => window.stickform.others())).find(x => x.name === 'Character 1');
      const c = await frontPx(o.J.N), c2 = [c[0] - 25, c[1] - 30];
      const id = await ev(() => window.stickform.actors[0].id), k0 = await ev(() => window.stickform.actors[0].data.strokes.length);
      await p.mouse.move(c[0], c[1]); await p.mouse.down(); await p.mouse.move(c2[0], c2[1], { steps: 6 }); await p.mouse.up(); await p.waitForTimeout(80);
      C.ok(await ev(id => window.stickform.active.id === id, id) && await ev(() => window.stickform.sketch.strokes.length) === k0 + 1, 'a stroke on another character\'s faint figure goes to that character (it becomes the active one)');
      await p.keyboard.press('Control+z'); }
    // the setting
    await p.click('#settings'); await p.click('#st-split'); await p.click('#dlg-settings [data-close]');
    { const drawn = () => ev(() => window.stickform.sketch.strokes.filter(s => !s.splitOf).length), k0 = await drawn(), a0 = await n(); await head(0.05);
      C.ok(await drawn() === k0 + 1 && await n() === a0 && await ev(() => window.stickform.pending.length) === 0, 'with the setting off, a stroke anywhere goes to the character being edited'); }
    await p.keyboard.press('Control+z');
    await p.click('#settings'); await p.click('#st-split'); await p.click('#dlg-settings [data-close]');
    C.ok(await ev(() => JSON.parse(localStorage.getItem('stickform.autoSplit'))) === true, 'the setting is remembered');
    while (await n() > 1) await ev(() => window.stickform.deleteCharacter(window.stickform.actors[1]));
    await ev(() => window.stickform.loadPose(window.stickform.BUILTIN[0]));
  }

  // ---- objects: shapes and imported meshes
  C.section('Objects');
  {
    await p.keyboard.press('v');
    await p.click('#addbtn');
    C.ok(await p.locator('#addpop [data-prim]').count() === 10 && await p.isVisible('#addfile'), '+ Add lists ten shapes and Object from file… (saved objects are in the Objects tab)');
    await p.click('#addpop [data-prim="box"]'); await p.waitForTimeout(120);
    const pr = () => ev(() => window.stickform.props.map(o => ({ id: o.id, name: o.name, kind: o.kind, p: o.p, q: o.q, s: o.s, vis: o.group.visible, locked: o.locked, tint: o.tint, look: o.look,
      box: (() => { const b = new (o.group.position.constructor)(); const B = { min: [1e9, 1e9, 1e9], max: [-1e9, -1e9, -1e9] }; o.group.updateMatrixWorld(true); o.group.traverse(m => { if (!m.isMesh) return; const a = m.geometry.attributes.position; for (let i = 0; i < a.count; i++) { b.fromBufferAttribute(a, i).applyMatrix4(m.matrixWorld); for (let k = 0; k < 3; k++) { B.min[k] = Math.min(B.min[k], b.getComponent(k)); B.max[k] = Math.max(B.max[k], b.getComponent(k)); } } }); return B; })() })));
    let O = await pr();
    C.ok(O.length === 1 && O[0].name === 'Box 1' && Math.abs(O[0].box.min[1]) < 1e-3 && Math.abs(O[0].box.max[1] - 0.5) < 1e-3 && Math.abs(O[0].p[0]) > 0.4, 'Box adds a 50 cm box on the floor, beside the character', JSON.stringify(O[0]));
    C.ok(await ev(() => window.stickform.selProp?.name) === 'Box 1' && await p.isVisible('#pobj') && !(await p.isVisible('#pbone')) && !(await p.isVisible('#pmove')), 'it is selected: the Pose card shows its numbers instead of the character\'s');
    C.ok((await p.textContent('#chars')).includes('Box 1') && (await p.textContent('#h-chars-n')) === '2', 'the Scene card lists it under the characters');
    C.ok((await p.textContent('#savepose')).includes('Save scene'), 'with an object the document is a scene');
    // 3D gizmo (F frames the selected object, so its handles are in view whatever the layout)
    await p.keyboard.press('f'); await p.waitForTimeout(80);
    C.ok(await ev(() => window.stickform.out.preset) === 'free', 'F frames the selected object in 3D');
    const og = await gz('output');
    C.ok(og && ['x', 'y', 'z'].every(k => og.arrows[k] && og.rings[k]), 'its 3D gizmo has rings and arrows (centre of the shape)');
    { const a = og.arrows.x; await drag([[a.x, a.y], [a.x + 40, a.y], [a.x + 90, a.y]]); }
    const x1 = (await pr())[0].p;
    C.ok(Math.abs(x1[0] - O[0].p[0]) > 0.05 && Math.abs(x1[1]) < 1e-9, 'dragging the X arrow moves it along X', JSON.stringify([O[0].p, x1]));
    await p.keyboard.press('Control+z'); C.eq((await pr())[0].p, O[0].p, 'one undo puts it back');
    // drag the shape itself (not selected, so no gizmo in the way): it is selected and slides on the floor
    await p.keyboard.press('Escape');
    { const c = await ev(() => { const s = window.stickform, o = s.props[0], v = o.group.localToWorld(o.c.clone()), q = s.outVP.project(v), r = s.outVP.canvas.getBoundingClientRect(); return [r.left + q.x, r.top + q.y]; });
      await drag([c, [c[0] - 20, c[1] + 10], [c[0] - 50, c[1] + 25]]); }
    const pd = (await pr())[0];
    C.ok((Math.abs(pd.p[0] - O[0].p[0]) > 0.03 || Math.abs(pd.p[2] - O[0].p[2]) > 0.03) && Math.abs(pd.p[1]) < 1e-9 && pd.q[3] === 1 && await ev(() => window.stickform.selProp?.name) === 'Box 1', 'pressing a shape selects it, dragging slides it over the floor (it keeps its height)', JSON.stringify([O[0].p, pd.p]));
    // Up and Down lift it
    await p.keyboard.press('ArrowUp'); await p.keyboard.press('ArrowUp'); await p.keyboard.press('Shift+ArrowUp');
    C.ok(Math.abs((await pr())[0].p[1] - 0.11) < 1e-6, 'Up lifts it 5 cm, Shift Up 1 cm', String((await pr())[0].p[1]));
    await p.keyboard.press('Control+z'); C.ok(Math.abs((await pr())[0].p[1]) < 1e-9, 'a run of lifts is one undo step');
    // numbers: rotation about the middle, scale from the bottom, linked
    await p.fill('#po-yaw', '45'); await p.press('#po-yaw', 'Enter');
    O = await pr(); const cx = (O[0].box.min[0] + O[0].box.max[0]) / 2;
    await p.fill('#po-sx', '2'); await p.press('#po-sx', 'Enter');
    O = await pr();
    C.ok(O[0].s.every(v => Math.abs(v - 2) < 1e-9) && Math.abs(O[0].box.min[1]) < 1e-3 && Math.abs(O[0].box.max[1] - 1) < 1e-3, 'Scale X with the link on scales all three; it grows from its bottom (stays on the floor)', JSON.stringify([O[0].s, O[0].box]));
    C.ok(Math.abs((O[0].box.min[0] + O[0].box.max[0]) / 2 - cx) < 1e-3, 'turning and scaling keep it where it stands', JSON.stringify([cx, O[0].box]));
    await p.click('#po-slink');
    await p.fill('#po-sy', '0.5'); await p.press('#po-sy', 'Enter');
    C.eq((await pr())[0].s, [2, 0.5, 2], 'unlinked, one axis scales on its own');
    await p.click('#po-slink');
    await p.click('#po-reset');
    O = await pr(); C.ok(O[0].s.every(v => v === 1) && O[0].q[3] === 1, 'Reset turn and size: no turn, normal size');
    // lock: K too
    await p.keyboard.press('k'); C.ok(await ev(() => window.stickform.selProp.locked), 'K locks the selected object');
    await p.keyboard.press('k'); C.ok(await ev(() => !window.stickform.selProp.locked), 'and unlocks it');
    await p.click('#po-lock');
    C.ok(await ev(() => window.stickform.selProp.locked) && await p.isDisabled('#po-x') && await p.isDisabled('#po-sx'), 'Lock: its numbers are disabled');
    { const g2 = await gz('output'), a = g2.arrows.x, p0 = JSON.stringify((await pr())[0].p); await drag([[a.x, a.y], [a.x + 50, a.y], [a.x + 90, a.y]]); await p.keyboard.press('ArrowUp');
      C.ok(JSON.stringify((await pr())[0].p) === p0, 'and dragging or lifting it does nothing'); }
    await p.click('#po-lock');
    // colour, eye, duplicate, delete
    await p.click('#chars .crow[data-kind="object"] .cdot'); await p.click('#tintpop .tints button[title="Clay"]');
    C.ok(await ev(() => '#' + window.stickform.props[0].group.children[0].material.color.getHexString()) === '#c7a796', 'the colour dot colours the shape');
    await p.click('#chars .crow[data-kind="object"] .ci[aria-label^="Hide"]');
    C.ok(!(await pr())[0].vis, 'the eye hides it'); await p.click('#chars .crow[data-kind="object"] .ci[aria-label^="Show"]');
    await p.click('#po-dup'); await p.waitForTimeout(150);
    O = await pr(); C.ok(O.length === 2 && O[1].name === 'Box 2' && O[1].p[0] > O[0].p[0] + 0.4, 'Duplicate puts a copy beside it', JSON.stringify(O.map(o => [o.name, o.p])));
    await p.keyboard.press('Delete');
    C.eq((await pr()).length, 1, 'Delete removes the selected object');
    await p.keyboard.press('Control+z'); C.eq((await pr()).length, 2, 'undo brings it back');
    await p.keyboard.press('Escape'); C.ok(await ev(() => !window.stickform.selProp) && !(await p.isVisible('#pobj')), 'Esc lets go of it');
    // the other shapes
    for (const k of ['seat', 'sphere', 'cylinder', 'cone', 'capsule', 'torus', 'wedge', 'stairs', 'plane']) await ev(k => window.stickform.addPrimitive(k), k);
    O = await pr();
    C.ok(O.length === 11 && O.every(o => o.box.min[1] > -1e-3 && o.box.min[1] < 1e-3), 'every shape stands on the floor', JSON.stringify(O.map(o => [o.kind, +o.box.min[1].toFixed(4)])));
    const ov = O.filter(o => o.kind !== 'plane'); let clash = 0;
    for (let i = 0; i < ov.length; i++) for (let j = i + 1; j < ov.length; j++) { const a = ov[i].box, b = ov[j].box; if (a.min[0] < b.max[0] - 0.01 && b.min[0] < a.max[0] - 0.01 && a.min[2] < b.max[2] - 0.01 && b.min[2] < a.max[2] - 0.01) clash++; }
    C.eq(clash, 0, 'new shapes are put beside each other, not inside one another');
    C.eq(new Set(O.map(o => o.tint)).size, O.length, 'every new shape gets its own colour (random, muted, unlike the others)');
    { const bad = await ev(() => { const s = window.stickform, out = [];
        for (const o of s.props) { if (['torus', 'stairs'].includes(o.kind)) continue; const m = o.group.children[0], g = m.geometry.index ? m.geometry.toNonIndexed() : m.geometry, a = g.attributes.position, V = o.group.position.constructor, c = new V();
          g.computeBoundingBox(); g.boundingBox.getCenter(c);
          for (let i = 0; i < a.count; i += 3) { const A = new V().fromBufferAttribute(a, i), B = new V().fromBufferAttribute(a, i + 1), Cc = new V().fromBufferAttribute(a, i + 2), nn = B.clone().sub(A).cross(Cc.clone().sub(A));
            if (nn.lengthSq() > 1e-14 && nn.dot(A.clone().add(B).add(Cc).divideScalar(3).sub(c)) < -1e-9) { out.push(o.kind); break; } } }
        return out; });
      C.eq(bad, [], 'every shape\'s faces point outward (no inside-out wedge)'); }
    // Colour & look card follows the selection
    await ev(() => window.stickform.selectProp(window.stickform.props.find(o => o.kind === 'cone')));
    C.eq(await p.textContent('#lk-name'), 'Cone 1', 'the Colour & look card shows the selected object');
    await p.click('#lk-sw button[title="Sage"]');
    C.eq(await ev(() => window.stickform.selProp.tint), '#a9b79e', 'a swatch there colours it');
    { const t0 = await ev(() => window.stickform.selProp.tint); await p.click('#lk-shuffle'); const t1 = await ev(() => window.stickform.selProp.tint);
      C.ok(t1 !== t0 && /^#[0-9a-f]{6}$/.test(t1), 'the shuffle button gives it a new random colour', t1); }
    C.ok(!(await p.isVisible('#lk-lookrow')), 'shapes have no Look (always their colour)');
    await ev(() => window.stickform.selectProp(null));
    C.eq(await p.textContent('#lk-name'), await ev(() => window.stickform.active.name), 'with nothing selected it shows the character being edited');
    // the lock sign
    await ev(() => { const s = window.stickform; s.setProp(s.props[0], { locked: true }); });
    C.ok((await ev(() => window.stickform.objMarks())).some(m => m.locked), 'a locked object shows a padlock in 3D');
    await ev(() => { const s = window.stickform; s.setProp(s.props[0], { locked: false }); });
    // a click on the shape selects it, a click on nothing lets go
    await ev(() => { const s = window.stickform; s.setProp(s.props.find(x => x.kind === 'plane'), { visible: false }); s.selectProp(s.props.find(x => x.kind === 'sphere')); });
    await p.keyboard.press('f'); await ev(() => window.stickform.selectProp(null));
    { const c = await ev(() => { const s = window.stickform, o = s.props.find(x => x.kind === 'sphere'), v = o.group.localToWorld(o.c.clone()), q = s.outVP.project(v), r = s.outVP.canvas.getBoundingClientRect(); return [r.left + q.x, r.top + q.y]; });
      await p.mouse.click(c[0], c[1]); await p.waitForTimeout(80); }
    C.eq(await ev(() => window.stickform.selProp?.kind), 'sphere', 'clicking a shape in 3D selects it');
    await p.click('#cams [data-cam="q"]');
    { const r3 = await p.locator('#v3').boundingBox(); await p.mouse.click(r3.x + r3.width / 2, r3.y + 78); await p.waitForTimeout(80); }
    C.ok(await ev(() => !window.stickform.selProp), 'clicking empty space lets go');
    await ev(() => { const s = window.stickform; s.setProp(s.props.find(x => x.kind === 'plane'), { visible: true }); });
    // scene file and tabs
    const sf = await ev(() => window.stickform.saveScene());
    C.ok(Array.isArray(sf.objects) && sf.objects.length === 11 && sf.objects[0].kind === 'box' && sf.objects[0].place.s.length === 3, 'scene files keep the objects (kind, colour, place, scale)', JSON.stringify(sf.objects?.[0]));
    await ev(() => window.stickform.newTab());
    C.ok(await ev(() => window.stickform.props.length) === 0 && await ev(() => window.stickform.stage.props.length) === 0, 'a new tab has no objects');
    await ev(async f => { await window.stickform.loadScene(f); }, sf);
    O = await pr();
    C.ok(O.length === 11 && JSON.stringify(O.map(o => [o.kind, o.p, o.s])) === JSON.stringify(sf.objects.map(o => [o.kind, o.place.p, o.place.s])), 'opening the scene file puts them back where they were');
    await ev(() => { const s = window.stickform; s.closeTab(s.curDoc); });
    await p.waitForTimeout(150);
    C.eq(await ev(() => window.stickform.props.length), 11, 'switching back to the first tab shows its objects again');
    // imported objects: OBJ (in centimetres) and GLB
    const objTxt = 'v 0 0 0\nv 100 0 0\nv 100 100 0\nv 0 100 0\nv 0 0 100\nv 100 0 100\nv 100 100 100\nv 0 100 100\nf 1 2 3 4\nf 5 8 7 6\nf 1 5 6 2\nf 2 6 7 3\nf 3 7 8 4\nf 5 1 4 8\n';
    await ev(async t => { await window.stickform.addObjectFile(new TextEncoder().encode(t).buffer, 'crate.obj'); }, objTxt);
    O = await pr(); const crate = O[O.length - 1];
    C.ok(crate.kind === 'mesh' && crate.name === 'crate 1' && crate.s[0] < 0.05 && crate.box.max[1] > 0.3 && crate.box.max[1] < 3 && Math.abs(crate.box.min[1]) < 1e-3, 'an OBJ in centimetres comes in at a sensible size, on the floor', JSON.stringify([crate.s, crate.box]));
    await p.fill('#po-sx', '0.03'); await p.press('#po-sx', 'Enter'); await p.click('#po-reset');
    C.ok(Math.abs((await pr()).pop().s[0] - crate.s[0]) < 1e-9, 'its Reset goes back to the size it came in at');
    C.ok(await p.isVisible('#lk-lookrow'), 'imported objects have a Look');
    if (existsSync(path.join(MODELS, 'Soldier.glb'))) {
      await ev(async b64 => { const bin = Uint8Array.from(atob(b64), c => c.charCodeAt(0)); await window.stickform.addObjectFile(bin.buffer, 'Soldier.glb'); }, readFileSync(path.join(MODELS, 'Soldier.glb')).toString('base64'));
      O = await pr(); const so = O[O.length - 1];
      C.ok(so.kind === 'mesh' && so.box.max[1] > 1.5 && so.box.max[1] < 2.2 && Math.abs(so.box.min[1]) < 0.02, 'a GLB comes in at its own size (metres), on the floor', JSON.stringify(so.box));
      const mats = () => ev(() => { const s = window.stickform, o = s.props[s.props.length - 1], out = []; o.group.traverse(m => { if (m.isMesh) out.push(m.material.userData.look || 'original'); }); return [...new Set(out)].join(','); });
      await p.click('#lk-look button[data-look="tint"]'); C.eq(await mats(), 'tint', 'Look › Tint colours its textures');
      await p.click('#lk-look button[data-look="solid"]'); C.eq(await mats(), 'solid', 'Look › Solid makes it one plain colour');
      await p.click('#lk-look button[data-look="original"]'); C.eq(await mats(), 'original', 'Look › Original puts its own materials back');
      await p.keyboard.press('Control+z'); C.eq(await mats(), 'solid', 'looks are undo steps');
      await p.keyboard.press('Control+z'); await p.keyboard.press('Control+z');
      // the Objects tab next to Presets: the file is there (not saved: no folder); drag it into 3D
      await p.click('#pt-o');
      C.ok(await p.isVisible('#othumbs') && !(await p.isVisible('#thumbs')) && await p.locator('#othumbs .thumb[data-obj="Soldier.glb"]').count() === 1 && await p.isVisible('#oimport'), 'the Objects tab next to Presets lists the object files (with Import…)');
      await p.waitForFunction(() => !!document.querySelector('#othumbs .thumb[data-obj="Soldier.glb"] img'), null, { timeout: 15000 }).catch(() => {});
      C.ok(await p.locator('#othumbs .thumb[data-obj="Soldier.glb"] img').count() === 1, 'each tile shows a rendered picture of the object');
      { const n0 = await ev(() => window.stickform.props.length), r3 = await p.locator('#v3').boundingBox();
        await p.locator('#othumbs .thumb[data-obj="Soldier.glb"]').dragTo(p.locator('#v3'), { targetPosition: { x: r3.width * 0.3, y: r3.height * 0.75 } }); await p.waitForTimeout(600);
        const last = await ev(() => { const s = window.stickform; return { n: s.props.length, p: s.props[s.props.length - 1].p, file: s.props[s.props.length - 1].file }; });
        C.ok(last.n === n0 + 1 && last.file === 'Soldier.glb' && last.p[1] === 0, 'dragging a tile into the 3D view puts the object on the floor where it is dropped', JSON.stringify(last)); }
      { const n0 = await ev(() => window.stickform.props.length); await p.click('#othumbs .thumb[data-obj="Soldier.glb"]'); await p.waitForTimeout(400);
        C.eq(await ev(() => window.stickform.props.length), n0 + 1, 'clicking a tile adds it beside the character'); }
      await p.click('#pt-p');
      C.ok(await p.isVisible('#thumbs') && await ev(() => JSON.parse(localStorage.getItem('stickform.ptab'))) === 'p', 'back on Presets (the tab is remembered)');
      // Library › Objects: shapes and files; add from there
      await p.click('#tab-library'); await p.click('#libobj');
      C.ok(await p.locator('#libgrid .thumb').count() === 10 + await ev(() => document.querySelectorAll('#othumbs .thumb[data-obj]').length) && (await p.textContent('#libuse')) === 'Add to scene' && !(await p.isVisible('#libsave')), 'Library › Objects lists the ten shapes and the object files, with Add to scene');
      await p.click('#libgrid .thumb[data-obj="Soldier.glb"]');
      C.ok(!(await p.isDisabled('#libren')) && !(await p.isDisabled('#libdel')), 'a file can be renamed or deleted there');
      await p.click('#libgrid .thumb[data-obj="cone"]');
      C.ok(await p.isDisabled('#libren'), 'shapes can\'t be renamed');
      { const n0 = await ev(() => window.stickform.props.length); await p.click('#libuse'); await p.waitForTimeout(200);
        C.ok(await ev(() => window.stickform.props.length) === n0 + 1 && await ev(() => window.stickform.props[window.stickform.props.length - 1].kind) === 'cone' && await p.isVisible('#ws-pose'), 'Add to scene adds it and goes back to the pose'); }
      await p.click('#tab-library'); await p.click('#liball'); await p.click('#tab-pose');
    } else C.skip('GLB object checks', 'models/Soldier.glb is missing');
    while (await ev(() => window.stickform.props.length)) await ev(() => window.stickform.deleteProp(window.stickform.props[0]));
    await ev(() => window.stickform.selectProp(null));
    await p.click('#cams [data-cam="q"]');
  }

  // ---- scale and looks of characters
  C.section('Character scale and look');
  {
    await ev(() => window.stickform.loadPose(window.stickform.BUILTIN[0]));
    const hipsY = () => ev(() => { const b = window.stickform.rig.bones.hips; return b.getWorldPosition(b.position.clone()).y; });
    const lowY = () => ev(() => { const s = window.stickform; let m = 1e9; s.rig.root.updateMatrixWorld(true); s.rig.allBones.forEach(b => { m = Math.min(m, b.getWorldPosition(b.position.clone()).y); }); return m; });
    const h0 = await hipsY(), l0 = await lowY();
    await p.keyboard.press('v'); await p.keyboard.press('g');
    C.ok(await p.isVisible('#pc-sx') && await p.isVisible('#pc-slink'), 'the whole character has Scale numbers under its position and rotation');
    await p.fill('#pc-sy', '1.5'); await p.press('#pc-sy', 'Enter');
    C.ok((await ev(() => window.stickform.posing.place.s)).every(v => v === 1.5) && Math.abs((await hipsY()) - l0 - (h0 - l0) * 1.5) < 0.01 && Math.abs((await lowY()) - l0) < 0.01, 'Scale 1.5 makes it half as tall again, still standing on the floor', JSON.stringify([h0, l0, await hipsY(), await lowY()]));
    await p.click('#pc-slink'); await p.fill('#pc-sx', '1.2'); await p.press('#pc-sx', 'Enter'); await p.click('#pc-slink');
    C.eq(await ev(() => window.stickform.posing.place.s), [1.2, 1.5, 1.5], 'unlinked: one axis on its own');
    const f = await ev(() => window.stickform.poseFile('x'));
    C.ok(f.place && JSON.stringify(f.place.s) === '[1.2,1.5,1.5]', 'pose files keep the scale', JSON.stringify(f.place));
    await ev(() => window.stickform.loadPose(window.stickform.BUILTIN[0]));
    C.eq(await ev(() => window.stickform.posing.place.s), [1, 1, 1], 'a preset starts at normal size');
    await ev(f => window.stickform.loadPose(f), f);
    C.eq(await ev(() => window.stickform.posing.place.s), [1.2, 1.5, 1.5], 'reopening the file brings the scale back');
    await p.keyboard.press('g');
    // IK drag and bone gizmo on a stretched character still work (and the drawing stays a figure)
    { const J = await ev(() => window.stickform.J), m = J.shL.map((v, i) => (v + J.aL1[i]) / 2), c = await frontPx(m); await p.mouse.click(c[0], c[1]); }
    const d0 = await dirs(), g3 = await gz('output');
    { const xs = g3.rings.y, q = xs[3]; await drag([[q.x, q.y], [q.x + 30, q.y + 10], [q.x + 60, q.y + 20]]); }
    C.ok(Math.hypot(...(await dirs()).u.map((v, i) => v - d0.u[i])) > 0.05, 'the bone gizmo turns bones of a scaled character');
    await p.keyboard.press('Escape');
    await p.click('#pc-reset').catch(() => {}); await ev(() => window.stickform.posing.setPlace([0, 0, 0], [0, 0, 0, 1], [1, 1, 1]));
    // contacts with a scaled character keep touching
    await p.click('#addbtn'); await p.click('#addchar'); await p.waitForTimeout(150);
    await ev(() => { const s = window.stickform; s.posing.movePlace([0.62, 0, 0]); s.update(); });
    const side = await ev(() => { const J = window.stickform.J; return J.aL2[0] < J.aR2[0] ? 'L' : 'R'; });
    { const J = await ev(() => window.stickform.J), m = J['a' + side + '1'].map((v, i) => (v + J['a' + side + '2'][i]) / 2), c = await frontPx(m); await p.mouse.click(c[0], c[1]); }
    await p.keyboard.press('Shift+R');
    { const o = (await ev(() => window.stickform.others()))[0], sh = o.J.shL[0] > o.J.shR[0] ? o.J.shL : o.J.shR, c = await frontPx(sh); await p.mouse.click(c[0], c[1]); await p.waitForTimeout(150); }
    const hold = () => ev(() => { const m = window.stickform.marks.find(x => x.active); return m ? { state: m.state, d: Math.hypot(m.T[0] - m.E[0], m.T[1] - m.E[1], m.T[2] - m.E[2]) } : null; });
    await ev(() => { const s = window.stickform, a = s.actors[0]; a.data = { ...a.data, place: { ...a.data.place, s: [1.15, 1.15, 1.15] } }; s.update(); });
    { const h = await hold(); C.ok(h && h.state === 'ok' && h.d < 0.01, 'a hand attached to a scaled character stays on its spot', JSON.stringify(h)); }
    await ev(() => { const s = window.stickform; s.posing.setPlace(s.posing.place.p, s.posing.place.q, [1.1, 0.9, 1.1]); });
    { const h = await hold(); C.ok(h && h.d < 0.02, 'and when the holder itself is stretched', JSON.stringify(h)); }
    // look of a model character
    if (await loadModel(p, 'Xbot.glb')) {
      const mats = () => ev(() => { const out = []; window.stickform.rig.root.traverse(m => { if (m.isMesh) out.push(m.material.userData.look || 'original'); }); return [...new Set(out)].join(','); });
      C.ok(await p.isVisible('#lk-lookrow') && await pressed('#lk-look button[data-look="original"]') === 'true', 'a model character has a Look (Original at first)');
      await p.click('#lk-look button[data-look="tint"]'); C.eq(await mats(), 'tint', 'Tint colours its textures in its Scene colour');
      await p.click('#lk-look button[data-look="solid"]'); C.eq(await mats(), 'solid', 'Solid is one plain colour');
      await p.click('#chars .crow:nth-child(2) .cdot'); await p.click('#tintpop .tints button[title="Clay"]');
      C.ok(await ev(() => { let c = null; window.stickform.rig.root.traverse(m => { if (!c && m.isMesh) c = '#' + m.material.color.getHexString(); }); return c; }) === '#c7a796', 'the colour dot sets that colour');
      await p.click('#lk-look button[data-look="original"]'); C.eq(await mats(), 'original', 'Original puts its own materials back');
      C.ok(await p.isVisible('#allsolid'), 'the Colour & look card offers Everything in solid colours');
      await p.click('#allsolid'); C.eq(await mats(), 'solid', 'which shows every model in its plain colour');
      C.ok(await p.isDisabled('#lk-look button[data-look="tint"]'), 'while it is on, the per-item looks wait');
      const sf = await ev(() => window.stickform.saveScene());
      C.ok(sf.solid === true, 'scene files remember it');
      await p.keyboard.press('Control+z'); C.eq(await mats(), 'original', 'undo turns it off');
    } else C.skip('Look checks on a loaded model', 'models/Xbot.glb is missing');
    while (await ev(() => window.stickform.actors.length) > 1) await ev(() => window.stickform.deleteCharacter(window.stickform.actors[1]));
    await ev(() => { const s = window.stickform; s.setRig(s.rigs[0]); s.posing.contacts = []; s.loadPose(s.BUILTIN[0]); });
  }

  // ---- objects held by characters, hands and feet on objects
  C.section('Holding and attaching objects');
  {
    await ev(() => { const s = window.stickform; s.loadPose(s.BUILTIN[0]); s.posing.setPlace([0, 0, 0], [0, 0, 0, 1], [1, 1, 1]); });
    await p.click('#cams [data-cam="front"]'); await p.keyboard.press('v');
    const ctr = () => ev(() => { const o = window.stickform.props[0]; return o.group.localToWorld(o.c.clone()).toArray(); });
    const handW = side => ev(side => { const b = window.stickform.rig.bones[side + 'Hand']; return b.getWorldPosition(b.position.clone()).toArray(); }, side);
    const px3 = w => ev(w => { const s = window.stickform, q = s.outVP.project(s.rig.root.position.clone().set(...w)), r = s.outVP.canvas.getBoundingClientRect(); return [r.left + q.x, r.top + q.y]; }, w);
    await ev(() => window.stickform.addPrimitive('box'));
    await ev(() => { const s = window.stickform; s.setProp(s.props[0], { s: [0.3, 0.3, 0.3] }); });
    await p.keyboard.press('r');
    C.ok(await pressed('#po-hold') === 'true' && (await ev(() => document.getElementById('helpbox')?.textContent || '')).includes('Attach'), 'R with an object selected waits for a character to hold it (Attach to…)');
    const hw = await handW('left'); { const c = await px3(hw); await p.mouse.click(c[0], c[1]); await p.waitForTimeout(150); }
    const H = await ev(() => { const o = window.stickform.props[0]; return o.hold && { to: o.hold.to, bone: o.hold.bone }; });
    C.ok(H && H.to === await ev(() => window.stickform.active.id) && /^arm[LR]2$/.test(H.bone), 'clicking the hand in 3D attaches it to that forearm', JSON.stringify(H));
    C.ok(Math.hypot(...(await ctr()).map((v, i) => v - hw[i])) < 0.12, 'its middle goes to the clicked spot');
    C.ok((await p.textContent('#po-holdtxt')).includes('held by') && await p.isVisible('#po-detach'), 'the Pose card says who holds it, with Detach');
    C.ok((await ev(() => window.stickform.objMarks())).some(m => m.held === 'ok'), 'a held object shows a link sign in 3D');
    { const c0 = await ctr(); await ev(() => window.stickform.posing.setPlace([0.4, 0.3, -0.2], [0, 0, 0, 1], [1, 1, 1])); const c1 = await ctr();
      C.ok(Math.abs(c1[0] - c0[0] - 0.4) < 1e-3 && Math.abs(c1[1] - c0[1] - 0.3) < 1e-3 && Math.abs(c1[2] - c0[2] + 0.2) < 1e-3, 'it follows when the character moves', JSON.stringify([c0, c1])); }
    { await ev(() => window.stickform.posing.bake(d => { d.armL1 = [0, 1, 0]; d.armL2 = [0, 1, 0]; d.armR1 = [0, 1, 0]; d.armR2 = [0, 1, 0]; }));
      const c2 = await ctr(), hs = [await handW('left'), await handW('right')];
      C.ok(c2[1] > 1.6 && Math.min(...hs.map(h => Math.hypot(...c2.map((v, i) => v - h[i])))) < 0.15, 'and when the arms are raised it goes up with the hand', JSON.stringify([c2, hs])); }
    // moving it by hand adjusts the grip; it stays held
    await p.fill('#po-z', String((await ev(() => window.stickform.props[0].p[2])) + 0.1)); await p.press('#po-z', 'Enter');
    { const c0 = await ctr(); await ev(() => window.stickform.posing.setPlace([0, 0, 0], [0, 0, 0, 1], [1, 1, 1])); const c1 = await ctr();
      C.ok(await ev(() => !!window.stickform.props[0].hold) && Math.abs(c1[0] - c0[0] + 0.4) < 1e-3, 'moving it by hand keeps it held (a new grip)'); }
    const sf = await ev(() => window.stickform.saveScene());
    C.ok(sf.objects[0].hold && sf.objects[0].hold.to === 0 && sf.objects[0].hold.rel.length === 16, 'scene files keep who holds it', JSON.stringify(sf.objects[0].hold && { to: sf.objects[0].hold.to, bone: sf.objects[0].hold.bone }));
    await p.click('#po-detach');
    C.ok(await ev(() => !window.stickform.props[0].hold), 'Detach lets go');
    await p.keyboard.press('Control+z'); C.ok(await ev(() => !!window.stickform.props[0].hold), 'undo holds it again');
    await ev(async f => { await window.stickform.loadScene(f); }, sf);
    C.ok(await ev(() => { const s = window.stickform, o = s.props[0]; return !!o.hold && o.hold.to === s.actors[0].id; }), 'reopening the scene file: still held');
    await ev(() => window.stickform.selectProp(window.stickform.props[0]));
    await p.click('#po-detach');
    // a hand on an object: Reach to… onto it in 3D, with Keep attached
    await ev(() => { const s = window.stickform, o = s.props[0]; s.loadPose(s.BUILTIN[0]); s.setProp(o, { p: [0.45, 0.9, 0.35], q: [0, 0, 0, 1], s: [0.4, 0.4, 0.4] }); s.selectProp(null); });
    const side = await ev(() => { const J = window.stickform.J; return J.aL2[0] > J.aR2[0] ? 'L' : 'R'; });
    { const J = await ev(() => window.stickform.J), m = J['a' + side + '1'].map((v, i) => (v + J['a' + side + '2'][i]) / 2), c = await frontPx(m); await p.mouse.click(c[0], c[1]); }
    await ev(() => { const s = window.stickform, h = s.posing.boneInfo().real; s.setProp(s.props[0], { p: [h[0], h[1] + 0.05, h[2] + 0.05] }); }); // just above that hand, a little in front
    await p.keyboard.press('Shift+R');
    { const c = await px3(await ctr()); await p.mouse.click(c[0], c[1]); await p.waitForTimeout(150); }
    let cs = await ev(() => window.stickform.posing.contacts);
    C.ok(cs.length === 1 && cs[0].obj === await ev(() => window.stickform.props[0].id) && cs[0].to === -2, 'Shift R, then a click on an object in 3D attaches the hand to it', JSON.stringify(cs));
    const hold = () => ev(() => { const m = window.stickform.marks.find(x => x.active); return m ? { state: m.state, d: Math.hypot(m.T[0] - m.E[0], m.T[1] - m.E[1], m.T[2] - m.E[2]) } : null; });
    { const h = await hold(); C.ok(h && h.state === 'ok' && h.d < 0.01, 'the hand touches the spot', JSON.stringify(h)); }
    C.ok((await p.textContent('#pconts')).includes('Box 1'), 'the Pose card lists the contact with the object');
    await ev(() => { const s = window.stickform, o = s.props[0]; s.setProp(o, { p: [o.p[0] + 0.05, o.p[1] + 0.1, o.p[2]] }); });
    { const h = await hold(); C.ok(h && h.state === 'ok' && h.d < 0.01, 'when the object moves, the hand follows', JSON.stringify(h)); }
    await ev(() => { const s = window.stickform, o = s.props[0]; s.setProp(o, { q: [0, Math.sin(0.3), 0, Math.cos(0.3)] }); });
    { const h = await hold(); C.ok(h && h.state === 'ok' && h.d < 0.01, 'and when it turns', JSON.stringify(h)); }
    const sf2 = await ev(() => window.stickform.saveScene());
    C.ok(JSON.stringify(sf2.characters[0].pose.attach) && sf2.characters[0].pose.attach[0].obj === 0 && sf2.characters[0].pose.attach[0].to === -2, 'scene files keep the contact (the object by its place in the file)', JSON.stringify(sf2.characters[0].pose.attach));
    await ev(async f => { await window.stickform.loadScene(f); }, sf2);
    { const h = await hold(); C.ok(await ev(() => window.stickform.posing.contacts[0]?.obj === window.stickform.props[0].id) && h && h.d < 0.01, 'reopening the scene: the hand is on the object again', JSON.stringify(h)); }
    // the loop: an object held by the hand that also holds on to it
    await ev(() => { const s = window.stickform; s.selectProp(s.props[0]); s.startHoldPick(); });
    { const b = await ev(side => window.stickform.posing.contacts[0].part, side); const hw2 = await handW(b === 'armL' ? 'left' : 'right'); const c = await px3(hw2); await p.mouse.click(c[0], c[1]); await p.waitForTimeout(120); }
    C.ok(await ev(() => !window.stickform.props[0].hold) && /loop/i.test(await p.textContent('#toast')), 'an object can\'t be held by the hand that holds on to it (a loop)');
    await p.keyboard.press('Escape');
    await ev(() => { const s = window.stickform; s.deleteProp(s.props[0]); });
    C.eq(await ev(() => window.stickform.posing.contacts.length), 0, 'deleting the object lets the hand go');
    await p.keyboard.press('Control+z'); C.eq(await ev(() => window.stickform.posing.contacts.length), 1, 'undo brings both back');
    while (await ev(() => window.stickform.props.length)) await ev(() => window.stickform.deleteProp(window.stickform.props[0]));
    await ev(() => { const s = window.stickform; s.posing.contacts = []; s.selectProp(null); s.loadPose(s.BUILTIN[0]); });
    await p.click('#cams [data-cam="q"]');
  }

  C.section('Interface page errors');
  C.ok(errors.length === 0, 'no errors in the browser console', errors.slice(0, 5).join(' | '));
  await ctx.close();
}

/** The project folder: an in-memory stand-in folder (the real picker needs a person). */
export async function folderTests(browser, C) {
  const { page: p, ctx, errors } = await openApp(browser);
  C.section('Project folder');
  C.eq((await p.textContent('#projtext')).trim(), 'Connect folder', 'header offers to connect a folder');
  const sq = starterText('squat-side');
  const files = { 'presets/custom pose 1.json': sq.replace(/"name":\s*"[^"]*"/, '"name": "Deep squat (side view)"'), 'presets/example.stickform.json': starterText('example'), 'renders/README.txt': 'x' };
  const xbot = path.join(MODELS, 'Xbot.glb');
  if (existsSync(xbot)) files['models/Xbot.glb'] = { b64: readFileSync(xbot).toString('base64') };
  await useFakeFolder(p, files); await p.waitForTimeout(400);
  C.eq((await p.textContent('#projtext')).trim(), 'Stickform project', 'header shows the connected folder');
  const th = await p.locator('#thumbs .thumb .tlab').allTextContents();
  C.ok(th.length === 2 && th.includes('custom pose 1') && th.includes('example'), 'the thumbnails list exactly what is in presets/ (the folder is the source of truth)', JSON.stringify(th));
  if (files['models/Xbot.glb']) {
    await p.click('#rigbtn');
    const menu = await p.locator('#rigpop .mi').allTextContents();
    C.ok(menu.some(t => t.startsWith('Xbot') && t.includes('models/')), 'character menu lists models/ without loading', JSON.stringify(menu));
    await p.click('#rigpop .mi >> text=Xbot'); await p.waitForFunction(() => document.getElementById('rigname').textContent === 'Xbot', null, { timeout: 15000 }).catch(() => {});
    C.eq(await p.textContent('#rigname'), 'Xbot', 'picking it loads it from the folder');
    await p.click('#rigbtn'); await p.click('#rigpop .mi >> text=Mannequin');
  } else C.skip('character menu lists and loads models/ files', 'models/Xbot.glb is missing');
  // save a new pose: name dialog, written into presets/ with the skeleton
  await p.click('#thumbs .thumb:has-text("example")'); await p.waitForTimeout(100);
  await p.keyboard.press('Control+Shift+s'); await p.waitForTimeout(100);
  C.ok(await p.evaluate(() => document.getElementById('dlg-text').open), 'Save as asks for a name');
  await p.fill('#tx-in', 'Test squat'); await p.click('#tx-ok'); await p.waitForTimeout(300);
  const saved = JSON.parse(await readFake(p, 'presets/test-squat.stickform.json') || '{}');
  C.ok(saved.name === 'Test squat' && saved.skeleton?.joints?.H && saved.strokes?.length, 'the pose goes to presets/ with its strokes and the 3D skeleton', JSON.stringify(Object.keys(saved)));
  // edit and Ctrl+S: same file, no dialog
  await p.click('#vp-sketch canvas', { position: { x: 5, y: 5 } }); await p.keyboard.press('m'); await p.waitForTimeout(100);
  await p.keyboard.press('Control+s'); await p.waitForTimeout(200);
  C.ok(await p.evaluate(() => document.getElementById('dlg-choice').open && /test-squat/.test(document.getElementById('ch-p').textContent)), 'Ctrl S into the open file asks first: Overwrite, Save as new, Cancel');
  await p.click('#ch-acts button[value="cancel"]'); await p.waitForTimeout(100);
  const ts0 = await readFake(p, 'presets/test-squat.stickform.json');
  C.ok(ts0 === JSON.stringify(saved) || JSON.parse(ts0).strokes.length === saved.strokes.length, 'Cancel leaves the file as it was');
  await p.keyboard.press('Control+s'); await p.waitForTimeout(200); await p.click('#ch-acts button[value="new"]'); await p.waitForTimeout(150);
  C.ok(await p.evaluate(() => document.getElementById('dlg-text').open), 'Save as new… asks for a name'); await p.fill('#tx-in', 'Test squat mirrored'); await p.click('#tx-ok'); await p.waitForTimeout(300);
  C.ok('test-squat-mirrored.stickform.json' in await listFake(p, 'presets') && (await p.textContent('#pnametext')) === 'Test squat mirrored', 'the variation gets its own file, and the tab its name');
  await p.click('#vp-sketch canvas', { position: { x: 5, y: 5 } }); await p.keyboard.press('m'); await p.waitForTimeout(100);
  await p.keyboard.press('Control+s'); await p.waitForTimeout(200); await p.click('#ch-acts button[value="yes"]'); await p.waitForTimeout(300);
  C.ok(Object.keys(await listFake(p, 'presets')).length === 4 && !(await p.isVisible('#pedited')), 'Overwrite saves into the same file');
  // render: goes to renders/, listed in Renders
  await p.keyboard.press('Control+Enter'); await p.waitForTimeout(900);
  const rl = Object.entries(await listFake(p, 'renders')).filter(([n]) => n.endsWith('.png'));
  C.ok(rl.length === 1 && rl[0][1] > 1000, 'Render PNG writes into renders/', JSON.stringify(rl));
  await p.click('#tab-renders'); await p.waitForTimeout(300);
  C.eq(await p.locator('#rgrid .rcard').count(), 1, 'Renders lists the files in renders/');
  await p.click('#rgrid .rcard'); await p.keyboard.press('F2'); await p.fill('#tx-in', 'hero shot'); await p.click('#tx-ok'); await p.waitForTimeout(300);
  { const n = Object.keys(await listFake(p, 'renders')).filter(n => n.endsWith('.png')); C.ok(n.length === 1 && n[0] === 'hero shot.png', 'F2 renames the file in renders/', JSON.stringify(n)); }
  await p.keyboard.press('Enter'); await p.waitForTimeout(300);
  C.ok(await p.evaluate(() => document.getElementById('dlg-preview').open && document.getElementById('pv-img').naturalWidth > 0), 'Enter opens the preview of the selected render');
  await p.keyboard.press('Escape');
  // library: Mine lists folder poses; delete removes the file
  await p.click('#tab-library'); await p.click('#libtabs button[data-lib="a"]'); await p.waitForTimeout(150);
  const mine = await p.locator('#libgrid .thumb .tlab').allTextContents();
  C.ok(mine.includes('test-squat') && mine.includes('custom pose 1'), 'Library, Mine lists the folder poses', JSON.stringify(mine));
  await p.click('#libgrid .thumb[title="presets/test-squat.stickform.json"]'); await p.click('#libdel');
  C.ok(await p.isVisible('#dlg-confirm'), 'deleting a folder pose asks first');
  await p.click('#cf-ok'); await p.waitForTimeout(300);
  C.ok(!('test-squat.stickform.json' in await listFake(p, 'presets')), 'confirmed delete removes the file');
  // a scene: two characters saved as one file, listed under Scenes, opened again
  await p.click('#tab-pose'); await p.click('#addbtn'); await p.click('#addchar'); await p.waitForTimeout(150);
  await p.keyboard.press('Control+s'); await p.waitForTimeout(150);
  if (await p.evaluate(() => document.getElementById('dlg-text').open)) { await p.fill('#tx-in', 'Duo'); await p.click('#tx-ok'); }
  await p.waitForTimeout(300);
  let scf = null; for (const n of Object.keys(await listFake(p, 'presets'))) if (JSON.parse(await readFake(p, 'presets/' + n)).format === 'stickform-scene') scf = n;
  const scd = scf ? JSON.parse(await readFake(p, 'presets/' + scf)) : {};
  C.ok(scd.format === 'stickform-scene' && scd.characters?.length === 2, 'with two characters, Save scene writes one scene file into presets/', scf);
  await p.click('#tab-library'); await p.click('#libtabs button[data-lib="s"]'); await p.waitForTimeout(150);
  C.ok(await p.locator('#libgrid .thumb').count() === 1 && (await p.textContent('#libgrid .thumb .scn')).includes('2 characters'), 'Library › Scenes lists it, marked with its character count');
  await p.click('#tab-pose'); await p.click('#doctabs .dtab[aria-selected="true"] .dx'); await p.waitForTimeout(150);
  C.ok(!(await p.evaluate(() => document.getElementById('dlg-choice').open)) && await p.evaluate(() => window.stickform.actors.length) === 1, 'a saved tab closes without asking (one untitled tab is left)');
  await p.click('#tab-library'); await p.click('#libtabs button[data-lib="s"]'); await p.click('#libgrid .thumb'); await p.click('#libuse'); await p.waitForTimeout(300);
  C.ok(await p.evaluate(() => window.stickform.actors.length) === 2, 'Open brings the scene back with both characters');
  const ev = (fn, arg) => p.evaluate(fn, arg);
  // The mix-up from chat 2: a scene that started from a pose file, re-posed from another pose file, then saved.
  await p.click('#tab-library'); await p.click('#libtabs button[data-lib="a"]'); await p.click('#libgrid .thumb:has-text("custom pose 1")'); await p.click('#libuse'); await p.waitForTimeout(150);
  C.ok(await p.evaluate(() => window.stickform.actors.length === 1 && window.stickform.curDoc.id === window.stickform.docs.at(-1).id || window.stickform.actors.length === 1), 'Library › Open opens the pose in its own tab (the scene tab stays open)');
  const custom0 = await readFake(p, 'presets/custom pose 1.json');
  await p.click('#addbtn'); await p.click('#addchar'); await p.waitForTimeout(100);
  await p.click('#thumbs .thumb:has-text("custom pose 1")'); await p.waitForTimeout(100); // a pose file onto the new character
  await p.keyboard.press('Control+s'); await p.waitForTimeout(150);
  const note = await p.evaluate(() => document.getElementById('dlg-text').open ? document.getElementById('tx-note').textContent : null);
  C.ok(!!note && /scene/.test(note), 'a pose that grew into a scene asks for a scene name first (with a note why)', String(note));
  await p.fill('#tx-in', 'Pair'); await p.click('#tx-ok'); await p.waitForTimeout(300);
  C.ok(JSON.parse(await readFake(p, 'presets/pair.stickform.json') || '{}').format === 'stickform-scene' && await readFake(p, 'presets/custom pose 1.json') === custom0, 'it saves as its own scene file; the pose files are untouched');
  await p.click('#chars .crow:nth-child(1) .cname'); await p.keyboard.press('v');
  await ev(() => window.stickform.posing.bake(d => { d.armL1 = [0, 1, 0]; })); await p.keyboard.press('Control+s'); await p.waitForTimeout(200); await p.click('#ch-acts button[value="yes"]'); await p.waitForTimeout(300);
  { let ok = false; // (saving is asynchronous: wait up to 3 s for the file)
    for (let k = 0; k < 30 && !ok; k++) { ok = !(await p.evaluate(() => document.getElementById('dlg-text').open || document.getElementById('dlg-confirm').open)) && !!JSON.parse(await readFake(p, 'presets/pair.stickform.json') || '{}').characters?.[0]?.pose?.depth; if (!ok) await p.waitForTimeout(100); }
    C.ok(ok, 'after that, Ctrl S saves pose changes straight into the scene file'); }
  // one character's pose on its own: its pose came from "custom pose 1", so Save offers that file (asking first)
  await p.click('#chars .crow:nth-child(2) .cname'); await p.click('#savemenu');
  C.ok((await p.textContent('#savepop')).includes('custom pose 1.json'), 'the Save menu offers to save Character 2’s pose back into the preset it came from');
  await p.click('#savepop .mi:has-text("pose as")'); await p.waitForTimeout(100);
  await p.fill('#tx-in', 'Solo'); await p.click('#tx-ok'); await p.waitForTimeout(300);
  C.ok(JSON.parse(await readFake(p, 'presets/solo.stickform.json') || '{}').format === 'stickform-pose' && await readFake(p, 'presets/custom pose 1.json') === custom0, 'Save menu › Save Character 2’s pose as… writes just that character as a new pose file');
  await p.click('#savemenu'); await p.click('#savepop .mi:has-text("’s pose")'); await p.waitForTimeout(150);
  C.ok(await p.evaluate(() => document.getElementById('dlg-choice').open && /solo/.test(document.getElementById('ch-p').textContent)), '… after which it is tied to that new file, and saving it again asks before overwriting');
  await p.click('#ch-acts button[value="yes"]'); await p.waitForTimeout(250);
  // down to one character: a pose, saved in its own file
  await p.click('#chars .crow:nth-child(2) .ci[aria-label^="More"]'); await p.click('#itempop .mi:has-text("Delete")');
  await p.keyboard.press('Control+s'); await p.waitForTimeout(150);
  C.ok(await p.evaluate(() => document.getElementById('dlg-text').open && /pose file/.test(document.getElementById('tx-note').textContent)), 'a scene down to one character asks for a pose name (the scene file stays)');
  await p.fill('#tx-in', 'custom pose 1 again'); await p.click('#tx-ok'); await p.waitForTimeout(300);
  C.ok(JSON.parse(await readFake(p, 'presets/custom-pose-1-again.stickform.json') || '{}').format === 'stickform-pose' && JSON.parse(await readFake(p, 'presets/pair.stickform.json')).characters.length === 2, 'saved as a pose; the scene keeps both characters');
  // replacing another file says what it holds; declining asks for another name
  await p.keyboard.press('Control+Shift+s'); await p.waitForTimeout(100); await p.fill('#tx-in', 'Pair'); await p.click('#tx-ok'); await p.waitForTimeout(200);
  C.ok(await p.evaluate(() => document.getElementById('dlg-confirm').open && /scene with 2 characters/.test(document.getElementById('cf-p').textContent)), 'saving over another file says what it is (a scene with 2 characters)');
  await p.click('#dlg-confirm button[value="cancel"]').catch(() => p.keyboard.press('Escape')); await p.waitForTimeout(150);
  C.ok(await p.evaluate(() => document.getElementById('dlg-text').open), 'Cancel there asks for another name instead of giving up');
  await p.keyboard.press('Escape');
  // Library rename
  await p.click('#tab-library'); await p.click('#libtabs button[data-lib="a"]'); await p.click('#libgrid .thumb:has-text("solo")'); await p.keyboard.press('F2');
  await p.fill('#tx-in', 'Solo kick'); await p.click('#tx-ok'); await p.waitForTimeout(300);
  { const L = await listFake(p, 'presets'); C.ok('solo-kick.stickform.json' in L && !('solo.stickform.json' in L) && JSON.parse(await readFake(p, 'presets/solo-kick.stickform.json')).name === 'Solo kick', 'Library › Rename (F2) renames the pose and its file', JSON.stringify(Object.keys(L))); }
  await p.click('#libgrid .thumb:has-text("pair")'); await p.click('#libren'); await p.fill('#tx-in', 'Duo kick'); await p.click('#tx-ok'); await p.waitForTimeout(300);
  C.ok(JSON.parse(await readFake(p, 'presets/duo-kick.stickform.json') || '{}').name === 'Duo kick', 'scenes rename the same way');
  // a starter in presets/ is just a file: edit it and save it back
  await p.click('#libgrid .thumb:has-text("example")'); await p.click('#libuse'); await p.waitForTimeout(100);
  await ev(() => window.stickform.posing.bake(d => { d.armR1 = [0, 1, 0]; })); await p.keyboard.press('Control+s'); await p.waitForTimeout(200); await p.click('#ch-acts button[value="yes"]'); await p.waitForTimeout(300);
  C.ok(!(await p.evaluate(() => document.getElementById('dlg-text').open)) && JSON.parse(await readFake(p, 'presets/example.stickform.json')).depth, 'a starter pose opened from presets/ saves straight back into its file (Ctrl S)',
    JSON.stringify([await p.evaluate(() => [document.querySelector('dialog[open]')?.id, document.getElementById('pnametext').textContent, document.getElementById('toast').textContent]), Object.keys(await listFake(p, 'presets'))]));
  await p.keyboard.press('Escape');
  // that file's thumbnail again, with unsaved changes in its tab: the saved version opens in a new tab beside it
  await ev(() => window.stickform.posing.bake(d => { d.armL1 = [0, 1, 0]; }));
  { const n0 = await ev(() => window.stickform.docs.length);
    await p.click('#thumbs .thumb[title="presets/example.stickform.json"]'); await p.waitForTimeout(150);
    const r = await ev(() => { const s = window.stickform; return [s.docs.length, s.dirty, s.docs.filter(d => d !== s.curDoc && d.file === 'example.stickform.json' && d.dirty).length]; });
    C.ok(r[0] === n0 + 1 && !r[1] && r[2] === 1, 'clicking the open file’s own thumbnail while it has unsaved changes opens the saved version in a new tab (the changes stay in theirs)', JSON.stringify([n0, r])); }
  await p.click('#doctabs .dtab[aria-selected="true"] .dx'); await p.waitForTimeout(100);
  if (await p.evaluate(() => document.getElementById('dlg-choice').open)) await p.click('#ch-acts button[value="discard"]');
  await p.click('#doctabs .dtab[aria-selected="true"] .dx'); await p.waitForTimeout(100);
  if (await p.evaluate(() => document.getElementById('dlg-choice').open)) await p.click('#ch-acts button[value="discard"]');
  await p.click('#tab-library'); await p.click('#libgrid .thumb[title="presets/example.stickform.json"]'); await p.click('#libdel'); await p.click('#cf-ok'); await p.waitForTimeout(200);
  await p.click('#settings'); await p.click('#st-starters'); await p.click('#dlg-settings [data-close]'); await p.waitForTimeout(300);
  { const L = Object.keys(await listFake(p, 'presets')), st = L.filter(n => /^(example|handstand|high-kick|leaning|legs-one-stroke|lying|squat-front|squat-side|upside-down-short|upside-down)\.stickform\.json$/.test(n));
    C.ok(st.length === 9 && st.includes('example.stickform.json') && !st.includes('squat-side.stickform.json'), 'Restore starter poses writes the missing starters into presets/ (not one you kept under another name: "custom pose 1" is the side squat)', JSON.stringify(st)); }
  await p.click('#tab-pose'); await ev(() => window.stickform.loadPose(window.stickform.BUILTIN[0]));
  // import a character: asks, then copies into models/
  await p.click('#tab-pose');
  const vrm = path.join(MODELS, 'VRM1_Constraint_Twist_Sample.vrm');
  if (existsSync(vrm)) {
    await p.setInputFiles('#rigfile', vrm);
    await p.waitForSelector('#dlg-confirm[open]', { timeout: 15000 }).catch(() => {});
    C.ok(await p.isVisible('#dlg-confirm'), 'importing a character asks to keep a copy');
    await p.click('#cf-ok'); await p.waitForTimeout(500);
    C.ok('VRM1_Constraint_Twist_Sample.vrm' in await listFake(p, 'models'), 'the copy goes into models/');
    await p.click('#rigbtn'); await p.click('#rigpop .mi >> text=Mannequin');
  } else C.skip('importing a character keeps a copy in models/', 'models/VRM1_Constraint_Twist_Sample.vrm is missing');
  // import an object: asks, then copies into objects/; listed in + Add; a scene with it opens again from there
  {
    const tmp = mkdtempSync(path.join(os.tmpdir(), 'sf-obj-')), f = path.join(tmp, 'crate.obj');
    writeFileSync(f, 'v -0.3 0 -0.3\nv 0.3 0 -0.3\nv 0.3 0.6 -0.3\nv -0.3 0.6 -0.3\nv -0.3 0 0.3\nv 0.3 0 0.3\nv 0.3 0.6 0.3\nv -0.3 0.6 0.3\nf 1 4 3 2\nf 5 6 7 8\nf 1 2 6 5\nf 2 3 7 6\nf 3 4 8 7\nf 5 8 4 1\n');
    await p.setInputFiles('#objfile', f);
    await p.waitForSelector('#dlg-confirm[open]', { timeout: 15000 }).catch(() => {});
    C.ok(await p.isVisible('#dlg-confirm') && await ev(() => window.stickform.props.length) === 1, 'importing an object adds it and asks to keep a copy');
    await p.click('#cf-ok'); await p.waitForTimeout(400);
    C.ok('crate.obj' in await listFake(p, 'objects'), 'the copy goes into objects/');
    await p.click('#pt-o');
    C.ok(await p.locator('#othumbs .thumb[data-obj="crate.obj"]').count() === 1 && !(await p.locator('#othumbs .thumb[data-obj="crate.obj"] .src').count()), 'the Objects tab lists the file in objects/ (saved)');
    await p.click('#pt-p');
    const sf = await ev(() => window.stickform.saveScene());
    await ev(() => { window.stickform.deleteProp(window.stickform.props[0]); });
    await ev(async f => { await window.stickform.loadScene(f); }, sf);
    C.ok(await ev(() => window.stickform.props.length === 1 && window.stickform.props[0].file === 'crate.obj'), 'a scene with an object opens it again from objects/');
    await ev(() => { const s = window.stickform; while (s.props.length) s.deleteProp(s.props[0]); });
    rmSync(tmp, { recursive: true, force: true });
  }
  // ask where to save: uses the browser save dialog (stubbed here)
  await p.evaluate(() => { window.__saved = []; window.showSaveFilePicker = async o => ({ async createWritable() { return { async write(d) { window.__saved.push([o.suggestedName, d.size]); }, async close() {} }; } }); });
  await p.click('#settings'); await p.click('#st-ask'); await p.keyboard.press('Escape');
  await p.keyboard.press('Control+Enter'); await p.waitForTimeout(900);
  const asked = await p.evaluate(() => window.__saved);
  const rl2 = Object.keys(await listFake(p, 'renders')).filter(n => n.endsWith('.png'));
  C.ok(asked.length === 1 && asked[0][0].endsWith('.png') && rl2.length === 1, 'with "Ask where to save" on, the render goes through the save dialog instead', JSON.stringify(asked));
  await p.click('#settings'); await p.click('#st-ask'); await p.keyboard.press('Escape');
  await p.click('#tab-renders'); await p.waitForTimeout(300);
  await p.click('#rgrid .rcard'); await p.click('#rdel');
  C.ok(await p.isVisible('#dlg-confirm'), 'deleting a render asks first');
  await p.click('#cf-ok'); await p.waitForTimeout(300);
  C.ok(!Object.keys(await listFake(p, 'renders')).some(n => n.endsWith('.png')) && await p.locator('#rgrid .rcard').count() === 0, 'confirmed delete removes the file from renders/');
  C.ok(errors.length === 0, 'no errors in the browser console', errors.slice(0, 5).join(' | '));
  await ctx.close();
}


/** "Start Stickform": the local server, in a scratch copy of the project folder. */
export async function serverTests(browser, C) {
  C.section('Start Stickform (local server)');
  const root = mkdtempSync(path.join(os.tmpdir(), 'stickform-'));
  copyFileSync(APP, path.join(root, 'stickform.html'));
  mkdirSync(path.join(root, 'presets')); mkdirSync(path.join(root, 'models'));
  writeFileSync(path.join(root, 'presets', 'custom pose 1.json'), starterText('squat-side'));
  const xbot = path.join(MODELS, 'Xbot.glb'); if (existsSync(xbot)) copyFileSync(xbot, path.join(root, 'models', 'Xbot.glb'));
  const srv = fork(path.join(SOURCE, 'server', 'stickform-server.mjs'), ['--no-open', '--port', '0', '--root', root], { stdio: ['ignore', 'ignore', 'inherit', 'ipc'] });
  const port = await new Promise((res, rej) => { srv.once('message', m => res(m.port)); srv.once('exit', c => rej(new Error('server exited ' + c))); setTimeout(() => rej(new Error('server did not start')), 10000); });
  const base = `http://127.0.0.1:${port}`;
  try {
    C.ok(existsSync(path.join(root, 'renders')) && existsSync(path.join(root, 'objects')), 'it creates presets/, models/, renders/ and objects/ if missing');
    // safety: only this computer's pages, only the three folders
    const st = async (u, o = {}) => (await fetch(base + u, o)).status;
    C.eq(await st('/api/file/presets/x.json', { method: 'PUT', body: 'x' }), 403, 'changes without the Stickform header are refused (no cross-site writes)');
    const H = { 'X-Stickform': '1' };
    C.eq(await st('/api/file/presets/..%2F..%2Fx.txt', { method: 'PUT', headers: H, body: 'x' }), 400, 'file names cannot leave the folder');
    C.eq(await st('/api/list/source', { headers: H }), 400, 'only presets, models, renders and objects are reachable');
    C.eq(await st('/api/file/objects/box.obj', { method: 'PUT', headers: H, body: 'v 0 0 0' }), 200, 'objects/ can be written');
    const hostCode = await new Promise(res => http.get({ host: '127.0.0.1', port, path: '/api/info', headers: { ...H, Host: `evil.example:${port}` } }, r => { r.resume(); res(r.statusCode); }).on('error', () => res(0)));
    C.eq(hostCode, 403, 'other host names are refused (no DNS rebinding)');
    const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } }), p = await ctx.newPage(), errors = [];
    p.on('pageerror', e => errors.push(e.message));
    p.on('console', m => { if (m.type() === 'error' && !/fonts\.g|Failed to load resource|ERR_/.test(m.text())) errors.push(m.text()); });
    await p.goto(base + '/'); await p.waitForFunction(() => !!window.stickform); await p.waitForTimeout(600);
    C.ok((await p.textContent('#projtext')).trim() === path.basename(root) && await p.evaluate(() => !!window.stickform.project.server), 'opened through the server, the folder is connected with no picking');
    const th = await p.locator('#thumbs .thumb .tlab').allTextContents();
    C.eq(th[0], 'custom pose 1', 'poses in presets/ show in the thumbnails');
    if (existsSync(xbot)) {
      await p.click('#rigbtn'); await p.click('#rigpop .mi >> text=Xbot');
      await p.waitForFunction(() => document.getElementById('rigname').textContent === 'Xbot', null, { timeout: 15000 }).catch(() => {});
      C.eq(await p.textContent('#rigname'), 'Xbot', 'characters in models/ load from the menu');
      await p.click('#rigbtn'); await p.click('#rigpop .mi >> text=Mannequin');
    } else C.skip('characters in models/ load from the menu (server)', 'models/Xbot.glb is missing');
    await p.click('#thumbs .thumb:nth-child(1)'); await p.keyboard.press('Control+Shift+s'); await p.fill('#tx-in', 'Server pose'); await p.click('#tx-ok'); await p.waitForTimeout(400);
    const pf = path.join(root, 'presets', 'server-pose.stickform.json');
    C.ok(existsSync(pf) && JSON.parse(readFileSync(pf, 'utf8')).skeleton, 'Save pose writes the file into presets/ on disk');
    await p.keyboard.press('Control+Enter'); await p.waitForTimeout(1000);
    const rs = readdirSync(path.join(root, 'renders')).filter(n => n.endsWith('.png'));
    C.ok(rs.length === 1, 'Render PNG writes into renders/ on disk', JSON.stringify(rs));
    await p.click('#tab-renders'); await p.waitForTimeout(400);
    C.ok(await p.locator('#rgrid .rcard').count() === 1 && await p.evaluate(() => { const i = document.querySelector('#rgrid img'); return !!i && i.complete && i.naturalWidth > 0; }), 'the Renders tab shows it');
    writeFileSync(path.join(root, 'renders', 'taken.png'), readFileSync(path.join(root, 'renders', rs[0])));
    C.eq(await st(`/api/rename/renders/${encodeURIComponent(rs[0])}`, { method: 'POST', headers: H, body: JSON.stringify({ to: '../x.png' }) }), 400, 'rename cannot move a file out of its folder');
    C.eq(await st(`/api/rename/renders/${encodeURIComponent(rs[0])}`, { method: 'POST', headers: H, body: JSON.stringify({ to: 'taken.png' }) }), 409, 'rename never replaces another file');
    C.eq(await st(`/api/rename/renders/${encodeURIComponent(rs[0])}`, { method: 'POST', body: JSON.stringify({ to: 'y.png' }) }), 403, 'rename needs the Stickform header');
    await p.click('#tab-pose'); await p.click('#tab-renders'); await p.waitForTimeout(400);
    await p.click(`#rgrid .rcard[data-name="${rs[0]}"]`); await p.click('#rren'); await p.fill('#tx-in', 'final'); await p.click('#tx-ok'); await p.waitForTimeout(400);
    C.ok(existsSync(path.join(root, 'renders', 'final.png')) && !existsSync(path.join(root, 'renders', rs[0])), 'Rename renames the file on disk');
    await p.dblclick('#rgrid .rcard[data-name="final.png"]'); await p.waitForTimeout(400);
    C.ok(await p.evaluate(() => document.getElementById('dlg-preview').open && document.getElementById('pv-img').naturalWidth > 0), 'the preview loads the image from the folder');
    await p.click('#pv-del'); await p.click('#cf-ok'); await p.waitForTimeout(400);
    C.ok(!existsSync(path.join(root, 'renders', 'final.png')) && existsSync(path.join(root, 'renders', 'taken.png')), 'Delete in the preview deletes that file on disk, nothing else');
    await p.keyboard.press('Escape');
    await p.click('#tab-library'); await p.click('#libtabs button[data-lib="a"]'); await p.waitForTimeout(200);
    await p.click('#libgrid .thumb:has-text("server-pose")'); await p.click('#libdel'); await p.click('#cf-ok'); await p.waitForTimeout(300);
    C.ok(!existsSync(pf), 'deleting from the Library removes the file');
    C.ok(errors.length === 0, 'no errors in the browser console', errors.slice(0, 3).join(' | '));
    await ctx.close();
  } finally { srv.kill(); rmSync(root, { recursive: true, force: true }); }
}
