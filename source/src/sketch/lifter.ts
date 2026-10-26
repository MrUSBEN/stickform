// Geometric lifter: tagged strokes -> 3D joint positions of a stick figure. Units: the spine (pelvis to neck, along
// its curve) is 1. Axes: x to screen right, y up, z toward the front viewer. Ported from Milestone 2, extended with:
//  - a spine chain of three segments (lower back, mid back, chest) that follows the drawn curve
//  - a depth table: once a part has been edited, its bones' depth (z of the unit direction) is stored and replaces
//    the guess from foreshortening; the drawing keeps the on-screen direction
//  - "ordered" strokes (regenerated from the 3D pose): their points are exact joints, root first
//  - a fixed page scale once the drawing has been regenerated, so it never drifts
import { Pt, dist, bend, hbox, neckFirst } from './geom';
import { Tag, Flips } from './tagger';

export type V3 = [number, number, number];
export interface Joints {
  P: V3; S1: V3; S2: V3; N: V3; H: V3; // pelvis, spine joints (lower, upper), neck, head centre
  shL: V3; shR: V3; hpL: V3; hpR: V3; // shoulder and hip joints, by tag side
  aL1: V3; aL2: V3; aR1: V3; aR2: V3; // elbows and wrists
  lL1: V3; lL2: V3; lR1: V3; lR2: V3; // knees and ankles
  f: V3;  // head facing (unit)
  fw: V3; // torso forward (unit)
}

/** Every bone the figure has, by key. `face` is the facing direction (no length). */
export const BONES = ['spine0', 'spine1', 'spine2', 'neck', 'face', 'sh', 'hip', 'armL1', 'armL2', 'armR1', 'armR2', 'legL1', 'legL2', 'legR1', 'legR2'] as const;
export type BoneKey = typeof BONES[number];

/** Depth of edited parts, the fixed page scale once the drawing was regenerated, and the torso's forward. */
export interface Depth { z: Partial<Record<BoneKey, number>>; fw?: V3; scale?: number }

export interface LiftOptions { depth?: Depth; ordered?: Partial<Record<Tag, boolean>> }

/** Where each lifted figure sits on the sketch page: the pelvis point and the scale (spine units per page unit).
 *  Page point = o + (x / s, -y / s). Kept beside the joints so the joints stay plain data. */
export const FRAME = new WeakMap<Joints, { o: Pt; s: number; neck: Pt }>();

/** Rig proportions of the stick figure (spine = 1). `hr` is the drawn head radius used when regenerating. */
export const RIG = { spine: 1, ua: 0.55, fa: 0.5, th: 0.8, shin: 0.75, hs: 0.25, hh: 0.15, nk: 0.32, hr: 0.17 };
export const SEG = RIG.spine / 3;

const add = (p: V3, q: V3): V3 => [p[0] + q[0], p[1] + q[1], p[2] + q[2]];
const mul = (p: V3, k: number): V3 => [p[0] * k, p[1] * k, p[2] * k];
const dot = (a: V3, b: V3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a: V3, b: V3): V3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const norm = (a: V3): V3 => { const l = Math.hypot(...a) || 1e-9; return [a[0] / l, a[1] / l, a[2] / l]; };

/** Points at fractions of a polyline's arc length. */
export function alongArc(p: Pt[], ts: number[]): Pt[] {
  const seg: number[] = []; let L = 0;
  for (let i = 1; i < p.length; i++) { const d = dist(p[i - 1], p[i]); seg.push(d); L += d; }
  return ts.map(t => {
    let h = t * L;
    for (let i = 0; i < seg.length; i++) {
      if (h <= seg[i] || i === seg.length - 1) { const k = seg[i] ? Math.min(1, h / seg[i]) : 0; return { x: p[i].x + (p[i + 1].x - p[i].x) * k, y: p[i].y + (p[i + 1].y - p[i].y) * k }; }
      h -= seg[i];
    }
    return p[p.length - 1];
  });
}
const arcLen = (p: Pt[]) => { let L = 0; for (let i = 1; i < p.length; i++) L += dist(p[i - 1], p[i]); return L; };

export function lift(st: Partial<Record<Tag, Pt[]>>, flips: Flips, away: boolean, opt: LiftOptions = {}): Joints | null {
  const R = RIG, Z = opt.depth?.z || {}, ord = opt.ordered || {};
  const sp = st.spine;
  if (!sp) return null;
  // Spine from pelvis to neck. Regenerated spines are already in that order.
  const ns = ord.spine ? [...sp].reverse() : neckFirst(sp, st.head ? hbox(st.head).c : null);
  const top = ns[0], bot = ns[ns.length - 1]; // neck, pelvis
  const pf = [...ns].reverse();
  const sl = arcLen(pf);
  if (dist(top, bot) < 0.03 && sl < 0.03) return null;
  // Global scale from the whole drawing: the median of rig length over drawn length across the spine and every drawn
  // limb, so ordinary stick-figure proportions come out flat. Fixed once the drawing has been regenerated.
  let s = opt.depth?.scale || 0;
  if (!s) {
    const samples = [R.spine / Math.max(sl, 1e-6)];
    for (const [t, rig] of [['armL', R.ua + R.fa], ['armR', R.ua + R.fa], ['legL', R.th + R.shin], ['legR', R.th + R.shin]] as const) {
      const p = st[t];
      if (!p) continue;
      const m = bend(p), dl = dist(p[0], m) + dist(m, p[p.length - 1]);
      if (dl > 1e-3) samples.push(rig / dl);
    }
    samples.sort((x, y) => x - y);
    const mid = samples.length >> 1;
    s = samples.length % 2 ? samples[mid] : (samples[mid - 1] + samples[mid]) / 2;
  }
  const d2 = (p: Pt, q: Pt): V3 => { const dx = q.x - p.x, dy = q.y - p.y, l = Math.hypot(dx, dy) || 1e-9; return [dx / l, -dy / l, l * s]; };
  /** Unit direction from an on-screen segment: flat by default, with the stored depth when the bone was edited. */
  const dirOf = (a: Pt, b: Pt, key: BoneKey, flat: (dx: number, dy: number, l: number) => V3): V3 => {
    const [dx, dy, l] = d2(a, b), z = Z[key];
    if (z === undefined) return flat(dx, dy, l);
    const c = Math.sqrt(Math.max(0, 1 - z * z));
    return [dx * c, dy * c, z];
  };

  // ---- spine chain: three segments following the drawn curve (flat unless edited)
  const sp4 = ord.spine && pf.length === 4 ? pf : alongArc(pf, [0, 1 / 3, 2 / 3, 1]);
  const segDir = (i: 0 | 1 | 2) => dirOf(sp4[i], sp4[i + 1], `spine${i}` as BoneKey, (dx, dy) => [dx, dy, 0]);
  const P: V3 = [0, 0, 0];
  const S1 = add(P, mul(segDir(0), SEG)), S2 = add(S1, mul(segDir(1), SEG)), N = add(S2, mul(segDir(2), SEG));
  const u = norm([N[0], N[1], N[2]]); // overall up (pelvis to neck)

  // ---- head and facing first: the facing tick also decides which way the torso faces when no crossbar is drawn
  const fz0 = (away ? -1 : 1) * (flips.head ? -1 : 1);
  let H = add(N, mul(norm(segDir(2)), R.nk)), f: V3 = [0, 0, fz0], hasTick = false;
  const hd = st.head;
  if (hd) {
    const { c, r: rad } = hbox(hd);
    H = add(N, mul(dirOf(top, c, 'neck', (dx, dy) => [dx, dy, 0]), R.nk));
    const ft = st.face;
    if (ft) {
      let far = ft[0];
      for (const p of ft) if (dist(p, c) > dist(far, c)) far = p;
      const tx = far.x - c.x, ty = -(far.y - c.y), tl = Math.hypot(tx, ty) || 1e-9, r = Math.min(1, tl / rad);
      const z = Z.face;
      if (z !== undefined) { const k = Math.sqrt(Math.max(0, 1 - z * z)); f = tl > 1e-6 ? [tx / tl * k, ty / tl * k, z] : [0, 0, Math.sign(z) || 1]; }
      else f = [tx / tl * r, ty / tl * r, Math.sqrt(1 - r * r) * fz0];
      hasTick = true;
    }
  }
  // ---- torso forward: toward the viewer (or away). With a tick, the body turns with the head, less than it: not
  // at all up to a 20 degree head turn, fully from 60 degrees, so a profile head gives a profile body.
  let fw: V3 = [0, 0, away ? -1 : 1];
  if (opt.depth?.fw) fw = norm(opt.depth.fw);
  else if (hasTick) {
    const k = dot(f, u), g: V3 = [f[0] - k * u[0], f[1] - k * u[1], f[2] - k * u[2]];
    if (Math.hypot(...g) > 0.3) {
      const gn = norm(g), z0 = fw, th = Math.acos(Math.max(-1, Math.min(1, dot(gn, z0))));
      const w: V3 = [gn[0] - dot(gn, z0) * z0[0], gn[1] - dot(gn, z0) * z0[1], gn[2] - dot(gn, z0) * z0[2]];
      if (Math.hypot(...w) > 1e-6) {
        const wn = norm(w), ph = th * Math.max(0, Math.min(1, (th - Math.PI / 9) / (Math.PI * 2 / 9)));
        fw = norm([z0[0] * Math.cos(ph) + wn[0] * Math.sin(ph), z0[1] * Math.cos(ph) + wn[1] * Math.sin(ph), z0[2] * Math.cos(ph) + wn[2] * Math.sin(ph)]);
      }
    }
  }
  // ---- shoulder and hip bars default to up x forward. A drawn bar keeps its drawn direction (turned to agree with
  // that default unless regenerated), with depth from how short it is drawn (Flip inverts) or from the depth table.
  const bar = (t: 'sh' | 'hip', half: number, up: V3): V3 => {
    const pp = norm(cross(up, fw));
    const c = st[t];
    if (!c) return pp;
    let [dx, dy, l] = d2(c[0], c[c.length - 1]);
    if (!ord[t] && dx * pp[0] + dy * pp[1] < 0) { dx = -dx; dy = -dy; }
    const z = Z[t];
    if (z !== undefined) { const k = Math.sqrt(Math.max(0, 1 - z * z)); return [dx * k, dy * k, z]; }
    const r = Math.min(1, l / (2 * half)), zs = (Math.abs(pp[2]) > 0.1 && pp[2] < 0 ? -1 : 1) * (flips[t] ? -1 : 1);
    return [dx * r, dy * r, Math.sqrt(1 - r * r) * zs];
  };
  // A raw tick only says left/right and toward/away: whatever part of it runs along the neck is a drawing habit, not
  // a nod (ticks are often drawn straight out of the chin). Exact facings (edit pen, gizmo, nudges; stored in the
  // depth table) keep their tilt, so the head can look up and down.
  if (Z.face === undefined) {
    const nd = norm([H[0] - N[0], H[1] - N[1], H[2] - N[2]]), k = dot(f, nd);
    const g: V3 = [f[0] - k * nd[0], f[1] - k * nd[1], f[2] - k * nd[2]];
    const kf = dot(fw, nd), gf: V3 = [fw[0] - kf * nd[0], fw[1] - kf * nd[1], fw[2] - kf * nd[2]];
    f = Math.hypot(...g) > 1e-3 ? norm(g) : Math.hypot(...gf) > 1e-3 ? norm(gf) : f;
  }
  const vs = bar('sh', R.hs, norm(segDir(2))), vh = bar('hip', R.hh, norm(segDir(0)));
  const J = { P, S1, S2, N, H, f, fw,
    shL: add(N, mul(vs, -R.hs)), shR: add(N, mul(vs, R.hs)), hpL: add(P, mul(vh, -R.hh)), hpR: add(P, mul(vh, R.hh)) } as Joints;
  // Default depth signs assume knees point forward; a figure facing away flips them.
  const fz = fw[2] < -0.2 ? -1 : 1;
  const limb = (t: 'armL' | 'armR' | 'legL' | 'legR', root: V3, rootPx: Pt, L1: number, L2: number, sg: [number, number]): [V3, V3] => {
    const p0 = st[t];
    if (!p0) return [add(root, [0, -L1, 0]), add(root, [0, -L1 - L2, 0])]; // missing limb hangs down
    const p = ord[t] || dist(p0[0], rootPx) <= dist(p0[p0.length - 1], rootPx) ? p0 : [...p0].reverse();
    const m = ord[t] && p.length === 3 ? p[1] : bend(p), fl = (flips[t] ? -1 : 1) * fz;
    // A bone drawn at 85% or more of its rig length counts as flat; shorter ones get depth (smoothly).
    const bone = (a: Pt, b: Pt, L: number, g: number, key: BoneKey): V3 => mul(dirOf(a, b, key, (dx, dy, l) => {
      const q = Math.min(1, l / (0.85 * L));
      return [dx * q, dy * q, g * fl * Math.sqrt(Math.max(0, 1 - q * q))];
    }), L);
    const b1 = bone(p[0], m, L1, sg[0], `${t}1` as BoneKey), b2 = bone(m, p[p.length - 1], L2, sg[1], `${t}2` as BoneKey);
    return [add(root, b1), add(add(root, b1), b2)];
  };
  [J.aL1, J.aL2] = limb('armL', J.shL, top, R.ua, R.fa, [-1, 1]);
  [J.aR1, J.aR2] = limb('armR', J.shR, top, R.ua, R.fa, [-1, 1]);
  [J.lL1, J.lL2] = limb('legL', J.hpL, bot, R.th, R.shin, [1, -1]);
  [J.lR1, J.lR2] = limb('legR', J.hpR, bot, R.th, R.shin, [1, -1]);
  FRAME.set(J, { o: bot, s, neck: top });
  return J;
}
