// Logic checks: tagger, lifter, pose files and retargeting, compared against saved baselines.
// These are exact numbers, so any change to how a drawing is read or a character is posed shows up here.
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { BASE, PRESETS, MODEL_FILES, openApp, loadModel, readJSON, writeJSON } from './lib.mjs';

const JOINT_TOL = 1e-3;   // stick-figure joints, in spine lengths
const BONE_TOL = 0.01;    // character bone positions, in metres

function maxDiff(a, b) {
  let m = 0;
  for (const k of Object.keys(b)) {
    if (!a || !(k in a)) return Infinity;
    for (let i = 0; i < b[k].length; i++) m = Math.max(m, Math.abs(a[k][i] - b[k][i]));
  }
  return m;
}

export async function logicTests(browser, C, update) {
  const { page, ctx, errors } = await openApp(browser);

  // ---- tagger and lifter on every built-in preset
  C.section('Tagging and depth (built-in presets)');
  const now = await page.evaluate(() => {
    const { BUILTIN, internals: { Sketch, lift, fromFile } } = window.stickform;
    const r4 = v => Math.round(v * 1e4) / 1e4;
    const read = d => {
      const k = new Sketch(); fromFile(k, d);
      const J = lift(k.byTag(), k.flips, k.away);
      return { tags: k.strokes.map(s => s.tag), joints: J ? Object.fromEntries(Object.entries(J).map(([n, v]) => [n, v.map(r4)])) : null };
    };
    const out = {};
    for (const d of BUILTIN) {
      const base = read(d);
      // Same drawing, different stroke orders: the reading must not depend on the order strokes were drawn.
      const n = d.strokes.length, orders = {
        reversed: [...d.strokes].reverse(),
        rotated: d.strokes.map((_, i) => d.strokes[(i + 1) % n]),
        halves: d.strokes.map((_, i) => d.strokes[(i + Math.floor(n / 2)) % n]),
        interleaved: [...d.strokes.filter((_, i) => i % 2), ...d.strokes.filter((_, i) => !(i % 2))],
      };
      const orderJoints = Object.fromEntries(Object.entries(orders).map(([k, st]) => [k, read({ ...d, strokes: st }).joints]));
      // Variants that no preset uses on its own: faces away, and each depth flip.
      const variants = { away: read({ ...d, away: !d.away }).joints };
      for (const f of ['armL', 'armR', 'legL', 'legR', 'sh', 'hip', 'head']) variants['flip-' + f] = read({ ...d, flips: { ...d.flips, [f]: !(d.flips || {})[f] } }).joints;
      out[d.name] = { ...base, orderJoints, variants };
    }
    return out;
  });
  const fileBase = path.join(BASE, 'logic.json');
  const saved = update ? null : readJSON(fileBase);
  if (!update && !saved) C.ok(true, 'no logic baseline yet: created one from this run');
  if (update || !saved) writeJSON(fileBase, Object.fromEntries(Object.entries(now).map(([k, v]) => [k, { tags: v.tags, joints: v.joints, variants: v.variants }])));
  for (const [name, v] of Object.entries(now)) {
    C.ok(v.joints, `${name}: poses (has a spine and joints)`, 'lifter returned nothing');
    if (saved?.[name]) {
      C.eq(v.tags, saved[name].tags, `${name}: tags match baseline`);
      const d = maxDiff(v.joints, saved[name].joints);
      C.ok(d <= JOINT_TOL, `${name}: joints match baseline`, `largest joint difference ${d.toFixed(4)} (allowed ${JOINT_TOL})`);
    } else if (!update && saved) C.ok(false, `${name}: has a baseline`, 'no baseline saved for this preset; run npm run test:update if it is new');
    if (saved?.[name]?.variants) {
      let worst = 0, which = '';
      for (const [k, j] of Object.entries(v.variants)) { const d = maxDiff(j, saved[name].variants[k]); if (d > worst) { worst = d; which = k; } }
      C.ok(worst <= JOINT_TOL, `${name}: faces-away and flip variants match baseline`, `${which} differs by ${worst.toFixed(4)}`);
      C.ok(maxDiff(v.variants.away, v.joints) > 0.01, `${name}: faces away changes the pose`, 'faces away had no effect');
    }
    for (const [k, j] of Object.entries(v.orderJoints)) {
      const d = maxDiff(j, v.joints);
      C.ok(d <= JOINT_TOL, `${name}: same result when strokes are drawn in ${k} order`, `largest joint difference ${d.toFixed(4)}`);
    }
  }

  // ---- preset files in the project folder
  C.section('Preset files (presets folder)');
  const files = readdirSync(PRESETS).filter(f => f.endsWith('.stickform.json'));
  if (!files.length) C.skip('preset files load and survive a save', 'presets/ is empty (your own poses go there; the ten starter poses are tested separately)');
  else C.ok(true, `presets folder has poses (${files.length} files)`);
  for (const f of files) {
    const d = JSON.parse(readFileSync(path.join(PRESETS, f), 'utf8'));
    if (d.format === 'stickform-scene') { C.ok(Array.isArray(d.characters) && d.characters.length > 0, `${f}: a scene with characters`); continue; }
    const r = await page.evaluate(d => {
      const { BUILTIN, internals: { Sketch, lift, fromFile, toFile } } = window.stickform;
      const k = new Sketch(); fromFile(k, d);
      const J = lift(k.byTag(), k.flips, k.away);
      // Save and reopen: the pose must survive a round trip through the file format.
      const k2 = new Sketch(); fromFile(k2, JSON.parse(JSON.stringify(toFile(k, d.name))));
      const J2 = lift(k2.byTag(), k2.flips, k2.away);
      let rt = 0;
      if (J && J2) for (const n of Object.keys(J)) for (let i = 0; i < 3; i++) rt = Math.max(rt, Math.abs(J[n][i] - J2[n][i]));
      const b = BUILTIN.find(x => x.name === d.name);
      return { poses: !!J, rt, same: !!b && JSON.stringify(b) === JSON.stringify(d) };
    }, d);
    C.ok(r.poses, `${f}: poses`);
    C.ok(r.rt <= 1e-3, `${f}: survives save and reopen`, `joint difference after round trip ${r.rt.toFixed(4)}`);
    // presets/ is yours: every file just has to load and survive a save (the starters may have been edited).
  }

  // ---- retargeting on every character
  C.section('Posing characters (bone positions)');
  const rigBase = path.join(BASE, 'retarget.json');
  const savedRig = update ? null : readJSON(rigBase);
  const rigNow = {};
  const rigs = ['mannequin'];
  for (const m of MODEL_FILES) if (await loadModel(page, m)) rigs.push(m); else C.skip(`${m}: bone positions after posing`, `models/${m} is missing`);
  for (let ri = 0; ri < rigs.length; ri++) {
    const name = rigs[ri];
    rigNow[name] = await page.evaluate(ri => {
      const s = window.stickform;
      s.setRig(s.rigs[ri]);
      const BONES = ['hips', 'head', 'leftLowerArm', 'leftHand', 'rightLowerArm', 'rightHand', 'leftLowerLeg', 'leftFoot', 'rightLowerLeg', 'rightFoot'];
      const out = {};
      for (const d of s.BUILTIN) {
        s.loadPose(d);
        const r = s.rig; r.root.updateMatrixWorld(true);
        out[d.name] = Object.fromEntries(BONES.filter(b => r.bones[b]).map(b => {
          const e = r.bones[b].matrixWorld.elements;
          return [b, [e[12], e[13], e[14]].map(v => Math.round(v * 1000) / 1000)];
        }));
      }
      return out;
    }, ri);
    for (const [preset, bones] of Object.entries(rigNow[name])) {
      const ys = Object.values(bones).map(v => v[1]);
      C.ok(Math.min(...ys) > -0.15, `${name} · ${preset}: stays above the floor`, `lowest bone at y=${Math.min(...ys)}`);
      if (savedRig?.[name]?.[preset]) {
        const d = maxDiff(bones, savedRig[name][preset]);
        C.ok(d <= BONE_TOL, `${name} · ${preset}: matches baseline`, `largest bone difference ${d.toFixed(3)} m (allowed ${BONE_TOL})`);
      } else if (!update && savedRig) C.ok(false, `${name} · ${preset}: has a baseline`, 'no baseline; run npm run test:update');
    }
  }
  if (!update && !savedRig) C.ok(true, 'no character baseline yet: created one from this run');
  if (update || !savedRig) writeJSON(rigBase, rigNow);

  C.section('Pose core and edit solver');
  const ed = await page.evaluate(() => {
    const { BUILTIN, internals: { Sketch, lift, fromFile, FRAME, regenerate, dirsOf, build, solvePart, VIEWS } } = window.stickform;
    const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]], len = a => Math.hypot(...a), dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
    const unit = a => { const l = len(a); return a.map(x => x / l); };
    const maxJ = (A, B) => { let m = 0; for (const n of Object.keys(A)) for (let i = 0; i < 3; i++) m = Math.max(m, Math.abs(A[n][i] - B[n][i])); return m; };
    const liftOf = k => lift(k.byTag(), k.flips, k.away, { depth: k.depth, ordered: k.ordered() });
    const fromRegen = (J, away) => {
      const g = regenerate(J, FRAME.get(J)), k = new Sketch();
      k.strokes = g.strokes.map((x, i) => ({ id: i + 1, pts: x.pts, tag: x.tag, lock: true, ordered: true })); k.depth = g.depth; k.away = away; k.classify();
      return liftOf(k);
    };
    const res = { roundTrip: 0, editTrip: 0, trace: [], planar: 0, count: 0, flat: null, snap: 0, carry: 0, tags: '' };
    const LIMBS = ['armL', 'armR', 'legL', 'legR'], ROOT = { armL: 'shL', armR: 'shR', legL: 'hpL', legR: 'hpR' };
    for (const d of BUILTIN) {
      const k = new Sketch(); fromFile(k, d);
      const J = liftOf(k);
      // 1. A pose turned back into a clean drawing reads back as the same pose.
      res.roundTrip = Math.max(res.roundTrip, maxJ(J, fromRegen(J, k.away)));
      // 2. Tracing a limb's own sketch stroke with the edit pen gives back the same limb.
      const F = FRAME.get(J), D = dirsOf(J);
      for (const l of LIMBS) {
        const st = k.strokes.find(s => s.tag === l); if (!st) continue;
        const pts = st.pts.map(q => ({ x: (q.x - F.o.x) * F.s, y: -(q.y - F.o.y) * F.s }));
        // The lifter reads raw arm strokes from the end nearer the neck, legs from the pelvis.
        const base = l.startsWith('arm') ? { x: (F.neck.x - F.o.x) * F.s, y: -(F.neck.y - F.o.y) * F.s } : { x: 0, y: 0 };
        const bones = [l + '1', l + '2'];
        const dirs = solvePart({ part: l, pts, basis: VIEWS.front, lengths: l.startsWith('arm') ? [0.55, 0.5] : [0.8, 0.75], root: base, cur: bones.map(b => D[b]), fw: D.fw });
        res.trace.push([d.name, l, Math.max(len(sub(dirs[0], D[bones[0]])), len(sub(dirs[1], D[bones[1]])))]);
      }
      // 3. Guides from three 3D-like views: bones point along the drawn segments as seen from the view.
      for (const view of [[1, 0, 0], [0.6, 0.3, 0.74], [0, 1, 0.05]]) {
        const w = unit(view), r = unit([w[2], 0, -w[0]].some(x => x) ? [w[2], 0, -w[0]] : [1, 0, 0]);
        const up = [w[1] * r[2] - w[2] * r[1], w[2] * r[0] - w[0] * r[2], w[0] * r[1] - w[1] * r[0]];
        const pts = [{ x: 0, y: 0 }, { x: 0.12, y: -0.05 }, { x: 0.25, y: -0.1 }, { x: 0.3, y: 0.05 }, { x: 0.33, y: 0.2 }];
        const out = solvePart({ part: 'armL', pts, basis: { right: r, up, toward: w }, lengths: [0.3, 0.28], root: { x: 0, y: 0 }, cur: [D.armL1, D.armL2], fw: D.fw });
        const seg = (a, b) => [r[0] * (b.x - a.x) + up[0] * (b.y - a.y), r[1] * (b.x - a.x) + up[1] * (b.y - a.y), r[2] * (b.x - a.x) + up[2] * (b.y - a.y)];
        const inPlane = (dv, s) => { const p = sub(dv, w.map(x => x * dot(dv, w))); return dot(p, s) / (len(p) * len(s) || 1); };
        res.planar = Math.max(res.planar, 1 - inPlane(out[0], seg(pts[0], pts[2])), 1 - inPlane(out[1], seg(pts[2], pts[4])));
        res.count++;
      }
    }
    const k = new Sketch(); fromFile(k, BUILTIN[0]); const J = liftOf(k), D = dirsOf(J);
    // 4. A segment drawn at full length lies flat; a short one tilts toward or away.
    const one = (x2) => solvePart({ part: 'armL', pts: [{ x: 0, y: 0 }, { x: x2, y: 0 }, { x: x2, y: -0.3 }], basis: VIEWS.front, lengths: [0.3, 0.3], root: { x: 0, y: 0 }, cur: [D.armL1, D.armL2], fw: D.fw })[0];
    res.flat = [Math.abs(one(0.3)[2]), Math.abs(one(0.1)[2])];
    // 5. Snapped guides land on the 15 degree grid.
    const sn = solvePart({ part: 'legL', pts: [{ x: 0, y: 0 }, { x: 0.42, y: 0.04 }, { x: 0.8, y: -0.03 }, { x: 0.82, y: -0.75 }], basis: VIEWS.right, lengths: [0.8, 0.75], root: { x: 0, y: 0 }, cur: [D.legL1, D.legL2], fw: D.fw, snap: true });
    res.snap = Math.max(...sn.flatMap(v => [Math.abs(Math.asin(v[1]) * 180 / Math.PI % 15), Math.abs(Math.atan2(v[0], v[2]) * 180 / Math.PI % 15)]).map(x => Math.min(x, 15 - x)));
    // 6. Bending the chest carries the arms and head (their angle to the chest is kept); a pinned arm stays put.
    const { setBone, setPart, mirroredDirs } = window.stickform.internals;
    const c = Math.cos(Math.PI / 6), s = Math.sin(Math.PI / 6);
    const d2 = dirsOf(J), before = [dot(d2.spine2, d2.armL1), dot(d2.spine2, d2.neck), dot(d2.spine2, d2.face)];
    const v = d2.spine2, nv = [v[0], v[1] * c - v[2] * s, v[1] * s + v[2] * c];
    setBone(d2, 'spine2', nv);
    res.carry = Math.max(Math.abs(dot(d2.spine2, d2.armL1) - before[0]), Math.abs(dot(d2.spine2, d2.neck) - before[1]), Math.abs(dot(d2.spine2, d2.face) - before[2]));
    const d3 = dirsOf(J), a0 = d3.armL1.slice(); setBone(d3, 'spine2', nv, new Set(['armL'])); res.pin = len(sub(d3.armL1, a0));
    // 7. Copy to other side on the standing pose mirrors the leg across the body's middle.
    const d4 = dirsOf(J); setPart(d4, 'legR', mirroredDirs(d4, 'legL'));
    res.mirror = Math.abs(d4.legR1[0] + d4.legL1[0]) + Math.abs(d4.legR1[1] - d4.legL1[1]) + Math.abs(d4.legR2[0] + d4.legL2[0]);
    // 7b. Turning an upper arm about its own length (gizmo ring) swings the forearm round and keeps the elbow angle.
    const { rotateBone } = window.stickform.internals;
    const d5 = dirsOf(J); d5.armL2 = [d5.armL1[1], -d5.armL1[0], 0].map(x => x / Math.hypot(d5.armL1[0], d5.armL1[1])); // bent elbow
    const u0 = d5.armL1.slice(), f0 = d5.armL2.slice(); rotateBone(d5, 'armL1', u0, Math.PI / 2);
    res.twist = [len(sub(d5.armL1, u0)), dot(d5.armL2, f0), Math.abs(dot(d5.armL1, d5.armL2) - dot(u0, f0))];
    // 8. An edited pose survives the round trip too.
    const Jb = build(d2); FRAME.set(Jb, FRAME.get(J)); res.editTrip = maxJ(Jb, fromRegen(Jb, false));
    res.tags = fromRegen(J, false) ? 'ok' : 'none';
    return res;
  });
  C.ok(ed.roundTrip < 1e-3, 'every preset turned into a clean drawing reads back as the same pose', `largest joint difference ${ed.roundTrip}`);
  C.ok(ed.editTrip < 1e-3, 'an edited pose survives the round trip too', `largest joint difference ${ed.editTrip}`);
  const bad = ed.trace.filter(r => r[2] > 0.02);
  C.ok(bad.length === 0, `tracing a limb's own stroke with the edit pen gives back the same limb (${ed.trace.length} limbs)`, bad.slice(0, 4).map(r => `${r[0]} ${r[1]}: ${r[2].toFixed(3)}`).join('; '));
  C.ok(ed.planar < 1e-3, `guides from any view: bones point along the drawn segments as seen (${ed.count} cases)`, `worst misalignment ${ed.planar.toFixed(4)}`);
  C.ok(ed.flat[0] < 1e-3 && ed.flat[1] > 0.8, 'full-length segment lies flat, short segment tilts in depth', JSON.stringify(ed.flat));
  C.ok(ed.snap < 1e-6, 'Shift-snapped guides land on the 15° grid', `off by ${ed.snap}°`);
  C.ok(ed.carry < 1e-9, 'bending the chest carries the arms, neck and facing with it', `angle change ${ed.carry}`);
  C.ok(ed.pin < 1e-12, 'a pinned arm stays put when the chest bends', `moved ${ed.pin}`);
  C.ok(ed.twist[0] < 1e-9 && Math.abs(ed.twist[1]) < 1e-6 && ed.twist[2] < 1e-9, 'turning an upper arm about its length swings the forearm a quarter turn, elbow angle kept', JSON.stringify(ed.twist));
  C.ok(ed.mirror < 1e-6, 'Copy to other side mirrors a limb across the body', `asymmetry ${ed.mirror}`);

  C.section('IK drag solver');
  const ik = await page.evaluate(() => {
    const { BUILTIN, internals: { Sketch, lift, fromFile, dirsOf, build, ikDrag } } = window.stickform;
    const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]], add = (a, b) => [a[0] + b[0], a[1] + b[1], a[2] + b[2]], len = a => Math.hypot(...a);
    const ang = (a, b) => Math.acos(Math.max(-1, Math.min(1, (a[0] * b[0] + a[1] * b[1] + a[2] * b[2]) / (len(a) * len(b))))) * 180 / Math.PI;
    const k = new Sketch(); fromFile(k, BUILTIN[0]);
    const J = lift(k.byTag(), k.flips, k.away, { depth: k.depth, ordered: k.ordered() }), d0 = dirsOf(J);
    const lens = Jx => [len(sub(Jx.aR1, Jx.shR)), len(sub(Jx.aR2, Jx.aR1)), len(sub(Jx.lL1, Jx.hpL)), len(sub(Jx.lL2, Jx.lL1))];
    const L0 = lens(J), out = {};
    // a hand within reach: only the arm bends, the body stays
    { const T = add(J.aR2, [0.15, 0.35, 0.2]), r = ikDrag(d0, 'armR2', 1, T), Jn = build(r.d);
      out.near = { miss: len(sub(Jn.aR2, T)), R: len(r.R), spine: ang(r.d.spine2, d0.spine2), legs: ang(r.d.legL1, d0.legL1), lens: Math.max(...lens(Jn).map((v, i) => Math.abs(v - L0[i]))) }; }
    // far out of reach: the arm straightens, the spine bends (within its limit), the body moves the rest
    { const T = add(J.aR2, [2.5, 1.2, 0]), r = ikDrag(d0, 'armR2', 1, T), Jn = build(r.d);
      out.far = { miss: len(sub(add(Jn.aR2, r.R), T)), R: len(r.R), spine: Math.max(ang(r.d.spine0, d0.spine0), ang(r.d.spine1, d0.spine1), ang(r.d.spine2, d0.spine2)), reached: r.reached }; }
    // a leg out of reach moves the body straight away (the spine stays)
    { const T = add(J.lL2, [3, 0.2, 0.4]), r = ikDrag(d0, 'legL2', 1, T), Jn = build(r.d);
      out.leg = { miss: len(sub(add(Jn.lL2, r.R), T)), R: len(r.R), spine: ang(r.d.spine2, d0.spine2) }; }
    // the hip line moves the whole body; the free legs keep their feet while they reach (knees bend)
    { const D = [0.1, -0.2, 0.05], r = ikDrag(d0, 'hip', 0.5, add(build(d0).P, D)), Jn = build(r.d);
      out.hip = { dR: len(sub(r.R, D)), same: Math.max(...['spine0', 'armL1'].map(b => ang(r.d[b], d0[b]))), feet: Math.max(len(sub(add(Jn.lL2, r.R), J.lL2)), len(sub(add(Jn.lR2, r.R), J.lR2))) }; }
    // pulled far up: the free legs hang straight, trailing toward where the feet were
    { const D = [0.6, 2.5, 0], r = ikDrag(d0, 'hip', 0.5, add(build(d0).P, D)), Jn = build(r.d);
      const st = ang(r.d.legL1, r.d.legL2), to = sub(J.lL2, add(Jn.hpL, r.R)), aim = ang(r.d.legL1, to);
      out.hang = { straight: st, aim }; }
    // pinned legs: hips go down, the feet stay where they were (knees bend); too far up, the body only goes as far as the legs reach
    { const pins = new Set(['legL', 'legR']), D = [0, -0.35, 0.05], r = ikDrag(d0, 'hip', 0.5, add(J.P, D), pins), Jn = build(r.d);
      out.pinned = { feet: Math.max(len(sub(add(Jn.lL2, r.R), J.lL2)), len(sub(add(Jn.lR2, r.R), J.lR2))), R: len(sub(r.R, D)), knee: ang(r.d.legL1, r.d.legL2) };
      const u = ikDrag(d0, 'hip', 0.5, add(J.P, [0, 1.5, 0]), pins);
      out.pinnedUp = { R: u.R[1], reached: u.reached }; }
    // a grabbed spine point bends the spine; the facing points at the target
    { const r = ikDrag(d0, 'spine2', 1, add(J.N, [0, -0.2, 0.3])), Jn = build(r.d); out.chest = { miss: len(sub(add(Jn.N, r.R), add(J.N, [0, -0.2, 0.3]))), bent: ang(r.d.spine2, d0.spine2) };
      const f = ikDrag(d0, 'face', 1, add(J.H, [1, 0, 0])); out.face = f.d.face[0]; }
    return out;
  });
  C.ok(ik.near.miss < 1e-3 && ik.near.R < 1e-9 && ik.near.spine < 1e-6 && ik.near.legs < 1e-6 && ik.near.lens < 1e-9, 'IK: a hand dragged within reach lands on the point; only the arm bends, lengths kept', JSON.stringify(ik.near));
  C.ok(ik.far.miss < 1e-3 && ik.far.R > 0.5 && ik.far.spine > 5 && ik.far.spine <= 24.01, 'IK: dragged far, the spine bends (24° at most per bone) and the whole body follows', JSON.stringify(ik.far));
  C.ok(ik.leg.miss < 1e-3 && ik.leg.R > 1 && ik.leg.spine < 1e-6, 'IK: a foot dragged far pulls the body along (no spine bend)', JSON.stringify(ik.leg));
  C.ok(ik.hip.dR < 1e-6 && ik.hip.same < 1e-6 && ik.hip.feet < 1e-3, 'IK: the hip line moves the body; the free legs keep their feet while they reach (knees bend)', JSON.stringify(ik.hip));
  C.ok(ik.hang.straight < 5 && ik.hang.aim < 3, 'IK: pulled out of the legs\' reach, they hang straight and trail along the pull', JSON.stringify(ik.hang));
  C.ok(ik.pinned.feet < 1e-3 && ik.pinned.R < 1e-6 && ik.pinned.knee > 20, 'IK: with pinned legs the hips go down and the feet stay put (knees bend)', JSON.stringify(ik.pinned));
  C.ok(ik.pinnedUp.R < 0.4 && !ik.pinnedUp.reached, 'IK: pinned legs limit how far up the body can go', JSON.stringify(ik.pinnedUp));
  C.ok(ik.chest.bent > 5 && ik.chest.miss < 1e-3, 'IK: dragging the chest bends the spine', JSON.stringify(ik.chest));
  C.ok(ik.face > 0.99, 'IK: dragging the facing points the face at the target', String(ik.face));

  C.section('Logic page errors');
  C.ok(errors.length === 0, 'no errors in the browser console', errors.slice(0, 5).join(' | '));
  await ctx.close();
}
