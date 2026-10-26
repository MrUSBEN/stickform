// The figure as bones: unit directions per bone (figure space: x right, y up, z toward the front viewer), rebuilt into
// joint positions with the stick-figure lengths. Edits rotate a bone and carry its children with it (an arm follows
// the chest, the head follows the neck) unless a child is pinned. `regenerate` turns any pose back into a clean,
// connected front drawing plus a depth table, which the lifter reads back exactly.
import { Pt } from './geom';
import { Joints, V3, RIG, SEG, BoneKey, BONES, Depth } from './lifter';
import { Tag } from './tagger';

export type Part = 'spine' | 'neck' | 'face' | 'sh' | 'hip' | 'armL' | 'armR' | 'legL' | 'legR';
export const PARTS: Part[] = ['spine', 'neck', 'face', 'sh', 'hip', 'armL', 'armR', 'legL', 'legR'];
export const PART_BONES: Record<Part, BoneKey[]> = {
  spine: ['spine0', 'spine1', 'spine2'], neck: ['neck'], face: ['face'], sh: ['sh'], hip: ['hip'],
  armL: ['armL1', 'armL2'], armR: ['armR1', 'armR2'], legL: ['legL1', 'legL2'], legR: ['legR1', 'legR2'],
};
export const PART_NAME: Record<Part, string> = {
  spine: 'Spine', neck: 'Neck', face: 'Facing', sh: 'Shoulders', hip: 'Hips', armL: 'Arm left', armR: 'Arm right', legL: 'Leg left', legR: 'Leg right',
};
export const BONE_NAME: Record<BoneKey, string> = {
  spine0: 'Lower back', spine1: 'Mid back', spine2: 'Chest', neck: 'Neck', face: 'Facing', sh: 'Shoulder line', hip: 'Hip line',
  armL1: 'Upper arm left', armL2: 'Forearm left', armR1: 'Upper arm right', armR2: 'Forearm right',
  legL1: 'Thigh left', legL2: 'Shin left', legR1: 'Thigh right', legR2: 'Shin right',
};
export const PART_OF: Record<BoneKey, Part> = Object.fromEntries(PARTS.flatMap(p => PART_BONES[p].map(b => [b, p]))) as Record<BoneKey, Part>;
/** The sketch tag that draws each part. */
export const PART_TAG: Record<Part, Tag> = { spine: 'spine', neck: 'head', face: 'face', sh: 'sh', hip: 'hip', armL: 'armL', armR: 'armR', legL: 'legL', legR: 'legR' };
export const BONE_LEN: Record<BoneKey, number> = {
  spine0: SEG, spine1: SEG, spine2: SEG, neck: RIG.nk, face: RIG.hr, sh: RIG.hs, hip: RIG.hh,
  armL1: RIG.ua, armL2: RIG.fa, armR1: RIG.ua, armR2: RIG.fa, legL1: RIG.th, legL2: RIG.shin, legR1: RIG.th, legR2: RIG.shin,
};
/** The joints each bone runs between (face: from the head centre along the facing). */
export const BONE_JOINTS: Record<Exclude<BoneKey, 'face'>, [keyof Joints, keyof Joints]> = {
  spine0: ['P', 'S1'], spine1: ['S1', 'S2'], spine2: ['S2', 'N'], neck: ['N', 'H'], sh: ['N', 'shR'], hip: ['P', 'hpR'],
  armL1: ['shL', 'aL1'], armL2: ['aL1', 'aL2'], armR1: ['shR', 'aR1'], armR2: ['aR1', 'aR2'],
  legL1: ['hpL', 'lL1'], legL2: ['lL1', 'lL2'], legR1: ['hpR', 'lR1'], legR2: ['lR1', 'lR2'],
};
/** Bones that move with each bone. */
const CHILDREN: Record<BoneKey, BoneKey[]> = {
  spine0: ['spine1'], spine1: ['spine2'], spine2: ['neck', 'sh'], neck: ['face'], face: [], sh: ['armL1', 'armR1'], hip: ['legL1', 'legR1'],
  armL1: ['armL2'], armL2: [], armR1: ['armR2'], armR2: [], legL1: ['legL2'], legL2: [], legR1: ['legR2'], legR2: [],
};
/** Order in which parts are applied (parents first). */
export const PART_ORDER: Part[] = ['hip', 'spine', 'sh', 'neck', 'face', 'armL', 'armR', 'legL', 'legR'];

export type Dirs = Record<BoneKey, V3> & { fw: V3 };

const sub = (a: V3, b: V3): V3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const add = (a: V3, b: V3): V3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const mul = (a: V3, k: number): V3 => [a[0] * k, a[1] * k, a[2] * k];
export const dot = (a: V3, b: V3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
export const cross = (a: V3, b: V3): V3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
export const len = (a: V3) => Math.hypot(a[0], a[1], a[2]);
export const unit = (a: V3): V3 => { const l = len(a) || 1e-12; return [a[0] / l, a[1] / l, a[2] / l]; };

export function dirsOf(J: Joints): Dirs {
  const d = { fw: unit(J.fw), face: unit(J.f) } as Dirs;
  for (const [k, [a, b]] of Object.entries(BONE_JOINTS) as [BoneKey, [keyof Joints, keyof Joints]][]) d[k] = unit(sub(J[b] as V3, J[a] as V3));
  return d;
}

export function build(d: Dirs): Joints {
  const P: V3 = [0, 0, 0];
  const S1 = add(P, mul(d.spine0, SEG)), S2 = add(S1, mul(d.spine1, SEG)), N = add(S2, mul(d.spine2, SEG));
  const shR = add(N, mul(d.sh, RIG.hs)), shL = add(N, mul(d.sh, -RIG.hs)), hpR = add(P, mul(d.hip, RIG.hh)), hpL = add(P, mul(d.hip, -RIG.hh));
  const aL1 = add(shL, mul(d.armL1, RIG.ua)), aR1 = add(shR, mul(d.armR1, RIG.ua));
  const lL1 = add(hpL, mul(d.legL1, RIG.th)), lR1 = add(hpR, mul(d.legR1, RIG.th));
  return {
    P, S1, S2, N, H: add(N, mul(d.neck, RIG.nk)), shL, shR, hpL, hpR,
    aL1, aL2: add(aL1, mul(d.armL2, RIG.fa)), aR1, aR2: add(aR1, mul(d.armR2, RIG.fa)),
    lL1, lL2: add(lL1, mul(d.legL2, RIG.shin)), lR1, lR2: add(lR1, mul(d.legR2, RIG.shin)),
    f: unit(d.face), fw: unit(d.fw),
  };
}

/** Rotate v about unit axis k by angle a (Rodrigues). */
function rot(v: V3, k: V3, a: number): V3 {
  const c = Math.cos(a), s = Math.sin(a), kv = cross(k, v), kd = dot(k, v);
  return [v[0] * c + kv[0] * s + k[0] * kd * (1 - c), v[1] * c + kv[1] * s + k[1] * kd * (1 - c), v[2] * c + kv[2] * s + k[2] * kd * (1 - c)];
}
/** Axis and angle of the shortest rotation from a to b (unit vectors). */
function arc(a: V3, b: V3): [V3, number] | null {
  const c = Math.max(-1, Math.min(1, dot(a, b)));
  if (c > 1 - 1e-12) return null;
  let k = cross(a, b);
  if (len(k) < 1e-9) { k = cross(a, Math.abs(a[0]) < 0.9 ? [1, 0, 0] : [0, 1, 0]); }
  return [unit(k), Math.acos(c)];
}

/** Set one bone's direction, carrying every child bone (and the torso forward, for the pelvis) with it. */
export function setBone(d: Dirs, key: BoneKey, dir: V3, pinned: Set<Part> = new Set()): void {
  const r = arc(unit(d[key]), unit(dir));
  d[key] = unit(dir);
  if (!r) return;
  const [k, a] = r;
  const carry = (b: BoneKey) => {
    for (const c of CHILDREN[b]) {
      if (pinned.has(PART_OF[c])) continue;
      d[c] = unit(rot(d[c], k, a));
      carry(c);
    }
  };
  carry(key);
  if (key === 'hip' || key === 'spine0') d.fw = unit(rot(d.fw, k, a));
}

/** Turn one bone about an axis, turning every child bone (and the torso forward, for the pelvis) the same way.
 *  Unlike setBone this keeps the twist: turning an upper arm about its own length swings the forearm round. */
export function rotateBone(d: Dirs, key: BoneKey, axis: V3, angle: number, pinned: Set<Part> = new Set()): void {
  const k = unit(axis);
  d[key] = unit(rot(d[key], k, angle));
  const carry = (b: BoneKey) => {
    for (const c of CHILDREN[b]) {
      if (pinned.has(PART_OF[c])) continue;
      d[c] = unit(rot(d[c], k, angle));
      carry(c);
    }
  };
  carry(key);
  if (key === 'hip' || key === 'spine0') d.fw = unit(rot(d.fw, k, angle));
}

/** Set every bone of a part, root first, so the part's own lower bones end exactly as given. */
export function setPart(d: Dirs, part: Part, dirs: V3[], pinned: Set<Part> = new Set()): void {
  PART_BONES[part].forEach((b, i) => { if (dirs[i]) setBone(d, b, dirs[i], pinned); });
}

/** The body's right axis for mirroring a part: the shoulder line for arms (and neck, face), the hip line for legs. */
function sideAxis(d: Dirs, part: Part): V3 {
  const isLeg = part.startsWith('leg') || part === 'hip';
  const up = unit(isLeg ? d.spine0 : d.spine2), line = isLeg ? d.hip : d.sh;
  const r = sub(line, mul(up, dot(line, up)));
  return len(r) > 1e-6 ? unit(r) : unit(cross(d.fw, up));
}
export const PAIR: Partial<Record<Part, Part>> = { armL: 'armR', armR: 'armL', legL: 'legR', legR: 'legL' };
/** The pair's directions that mirror a limb across the body's middle. */
export function mirroredDirs(d: Dirs, part: Part): V3[] {
  const n = sideAxis(d, part);
  return PART_BONES[part].map(b => { const v = d[b]; return unit(sub(v, mul(n, 2 * dot(v, n)))); });
}

/** Snap a direction to the 15 degree grid of heading (around the vertical) and elevation (from horizontal). */
export function snapDir(v: V3, step = 15): V3 {
  const u = unit(v), r = Math.PI / 180;
  let el = Math.asin(Math.max(-1, Math.min(1, u[1]))) / r;
  el = Math.round(el / step) * step;
  if (Math.abs(el) >= 90) return [0, Math.sign(el), 0];
  let hd = Math.atan2(u[0], u[2]) / r;
  hd = Math.round(hd / step) * step;
  const c = Math.cos(el * r);
  return [Math.sin(hd * r) * c, Math.sin(el * r), Math.cos(hd * r) * c];
}
/** Heading (degrees, 0 = toward the front viewer, positive toward the figure's screen right) and elevation. */
export function angles(v: V3): { heading: number; elevation: number } {
  const u = unit(v);
  return { heading: Math.atan2(u[0], u[2]) * 180 / Math.PI, elevation: Math.asin(Math.max(-1, Math.min(1, u[1]))) * 180 / Math.PI };
}
/** Turn a direction by heading and elevation steps (degrees). */
export function nudge(v: V3, dHeading: number, dElevation: number): V3 {
  const { heading, elevation } = angles(v), r = Math.PI / 180;
  const el = Math.max(-89.9, Math.min(89.9, elevation + dElevation)) * r, hd = (heading + dHeading) * r;
  // Straight up or down: keep a usable heading.
  return [Math.sin(hd) * Math.cos(el), Math.sin(el), Math.cos(hd) * Math.cos(el)];
}

export interface RegenStroke { tag: Tag; pts: Pt[] }
/** A clean front drawing of the pose, joined at its joints, and the depth table that makes the lifter read it back
 *  exactly. `frame` places the figure on the page (pelvis point, spine units per page unit). */
export function regenerate(J: Joints, frame: { o: Pt; s: number }): { strokes: RegenStroke[]; depth: Depth } {
  const { o, s } = frame;
  const P = (X: V3): Pt => ({ x: +(o.x + X[0] / s).toFixed(5), y: +(o.y - X[1] / s).toFixed(5) });
  const d = dirsOf(J), strokes: RegenStroke[] = [];
  const rad = RIG.hr / s, c = P(J.H);
  const circle: Pt[] = [];
  for (let i = 0; i <= 24; i++) { const a = i / 24 * Math.PI * 2; circle.push({ x: c.x + rad * Math.cos(a), y: c.y + rad * Math.sin(a) }); }
  strokes.push({ tag: 'head', pts: circle });
  const m = Math.hypot(d.face[0], d.face[1]);
  const fdir = m > 1e-6 ? [d.face[0] / m, d.face[1] / m] : [0, -1];
  const tl = Math.max(0.03, m) * rad;
  strokes.push({ tag: 'face', pts: [c, { x: c.x + fdir[0] * tl, y: c.y - fdir[1] * tl }] });
  strokes.push({ tag: 'spine', pts: [J.P, J.S1, J.S2, J.N].map(P) });
  strokes.push({ tag: 'sh', pts: [J.shL, J.shR].map(P) });
  strokes.push({ tag: 'hip', pts: [J.hpL, J.hpR].map(P) });
  strokes.push({ tag: 'armL', pts: [J.shL, J.aL1, J.aL2].map(P) });
  strokes.push({ tag: 'armR', pts: [J.shR, J.aR1, J.aR2].map(P) });
  strokes.push({ tag: 'legL', pts: [J.hpL, J.lL1, J.lL2].map(P) });
  strokes.push({ tag: 'legR', pts: [J.hpR, J.lR1, J.lR2].map(P) });
  const z: Depth['z'] = {};
  for (const b of BONES) z[b] = +d[b][2].toFixed(6);
  return { strokes, depth: { z, fw: d.fw.map(x => +x.toFixed(6)) as V3, scale: s } };
}

/** Project a figure-space point to view coordinates (x right, y up) for a view basis. */
export function toView(X: V3, right: V3, up: V3): { x: number; y: number } { return { x: dot(X, right), y: dot(X, up) }; }

export const VIEWS = {
  front: { right: [1, 0, 0] as V3, up: [0, 1, 0] as V3, toward: [0, 0, 1] as V3, name: 'Front' },
  back: { right: [-1, 0, 0] as V3, up: [0, 1, 0] as V3, toward: [0, 0, -1] as V3, name: 'Back' },
  left: { right: [0, 0, 1] as V3, up: [0, 1, 0] as V3, toward: [-1, 0, 0] as V3, name: 'Left side' },
  right: { right: [0, 0, -1] as V3, up: [0, 1, 0] as V3, toward: [1, 0, 0] as V3, name: 'Right side' },
  top: { right: [1, 0, 0] as V3, up: [0, 0, -1] as V3, toward: [0, 1, 0] as V3, name: 'Top' },
} as const;
export type ViewId = keyof typeof VIEWS;
