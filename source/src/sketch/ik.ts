// IK for dragging: move a point on any bone and the body follows as a free chain. Works on bone directions in
// figure space (the stick-figure lengths, pelvis at the origin) and returns the new directions plus how far the whole
// body has to move (R, figure units) for the grabbed point to land on the target.
//  - Limbs bend first (two-bone solve, keeping the bend plane); an arm out of reach then bends the spine (each spine
//    bone at most a limited angle), and whatever is left moves the whole body. A leg out of reach moves the body.
//  - Free legs hang like a chain when the body moves: the feet first stay where they were (the knees unbend), and
//    once a leg is straight its foot trails along, the leg pointing back along the pull.
//  - Spine, neck and shoulder line: the bones below the grabbed point bend (limited), then the body moves.
//  - Hip line: moves the whole body. Facing: points the face at the target.
//  - Pinned parts keep their directions; a pinned arm or leg also keeps its hand or foot where it was in the world,
//    bending to stay there, and the body only moves as far as every pinned limb can still reach.
import { V3, BoneKey, Joints, RIG } from './lifter';
import { Dirs, Part, PART_OF, build, rotateBone, setBone, dot, cross, len, unit } from './pose3d';

const sub = (a: V3, b: V3): V3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const add = (a: V3, b: V3): V3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const mul = (a: V3, k: number): V3 => [a[0] * k, a[1] * k, a[2] * k];
const lerp = (a: V3, b: V3, t: number): V3 => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
const angleOf = (a: V3, b: V3) => Math.acos(Math.max(-1, Math.min(1, dot(unit(a), unit(b)))));
const clone = (d: Dirs): Dirs => JSON.parse(JSON.stringify(d));

export type Limb = 'armL' | 'armR' | 'legL' | 'legR';
export const LIMBS: Limb[] = ['armL', 'armR', 'legL', 'legR'];
const LIMB_J: Record<Limb, [keyof Joints, keyof Joints, keyof Joints]> = {
  armL: ['shL', 'aL1', 'aL2'], armR: ['shR', 'aR1', 'aR2'], legL: ['hpL', 'lL1', 'lL2'], legR: ['hpR', 'lR1', 'lR2'],
};
const LIMB_LEN = (p: Limb): [number, number] => p.startsWith('arm') ? [RIG.ua, RIG.fa] : [RIG.th, RIG.shin];

/** Two-bone solve: from root S with lengths L1, L2 toward T, the middle joint on the side of `pole` (a direction,
 *  for example the current elbow offset). `fallback` is used when the pole lies along the reach. */
export function twoBone(S: V3, L1: number, L2: number, T: V3, pole: V3, fallback: V3): { d1: V3; d2: V3; end: V3; reached: boolean } {
  const to = sub(T, S), want = len(to);
  const dir = want > 1e-9 ? mul(to, 1 / want) : unit(fallback);
  const d = Math.max(Math.abs(L1 - L2) + 1e-4, Math.min((L1 + L2) * 0.9995, want));
  const a1 = (L1 * L1 - L2 * L2 + d * d) / (2 * d), h = Math.sqrt(Math.max(0, L1 * L1 - a1 * a1));
  let pl = sub(pole, mul(dir, dot(pole, dir)));
  if (len(pl) < 1e-4 * (len(pole) || 1)) pl = sub(fallback, mul(dir, dot(fallback, dir)));
  if (len(pl) < 1e-9) pl = sub([0, 1, 0], mul(dir, dir[1]));
  pl = unit(pl);
  const mid = add(add(S, mul(dir, a1)), mul(pl, h)), end = add(S, mul(dir, d));
  return { d1: unit(sub(mid, S)), d2: unit(sub(end, mid)), end, reached: want <= (L1 + L2) * 0.9995 + 1e-9 };
}

/** The grabbed point on a bone (t along it) in figure space. */
export function pointOn(J: Joints, bone: BoneKey, t: number): V3 {
  switch (bone) {
    case 'face': return add(J.H, mul(J.f, RIG.hr * 1.4 * t));
    case 'sh': return lerp(J.shL, J.shR, t);
    case 'hip': return lerp(J.hpL, J.hpR, t);
    case 'spine0': return lerp(J.P, J.S1, t);
    case 'spine1': return lerp(J.S1, J.S2, t);
    case 'spine2': return lerp(J.S2, J.N, t);
    case 'neck': return lerp(J.N, J.H, t);
    default: {
      const p = PART_OF[bone] as Limb, [a, b, c] = LIMB_J[p];
      return bone.endsWith('1') ? lerp(J[a] as V3, J[b] as V3, t) : lerp(J[b] as V3, J[c] as V3, t);
    }
  }
}

/** Bend a limb so the point at `t` along its lower bone (or `upper`: its upper bone) heads for T. */
function aimLimb(d: Dirs, p: Limb, T: V3, upper: boolean, t: number): void {
  const J = build(d), [ja, jb] = LIMB_J[p], S = J[ja] as V3, M = J[jb] as V3, [L1, L2] = LIMB_LEN(p);
  const k1 = `${p}1` as BoneKey, k2 = `${p}2` as BoneKey;
  if (upper) { const v = sub(T, S); if (len(v) > 1e-9) setBone(d, k1, unit(v)); return; }
  const fb = p.startsWith('arm') ? mul(d.fw, -1) : d.fw; // default elbows back, knees forward
  const r = twoBone(S, L1, L2 * Math.max(0.05, t), T, sub(M, S), fb);
  d[k1] = r.d1; d[k2] = r.d2;
}

export interface IKResult { d: Dirs; R: V3; reached: boolean }
/** Drag the point `t` along `bone` of the pose `d0` to figure-space point T. */
export function ikDrag(d0: Dirs, bone: BoneKey, t: number, T: V3, pinned: Set<Part> = new Set(), opt: { spineMax?: number } = {}): IKResult {
  const d = clone(d0), J0 = build(d0);
  const part = PART_OF[bone];
  const eff = () => pointOn(build(d), bone, t);
  if (bone === 'face') { // the facing just points at the target
    const v = sub(T, J0.H); if (len(v) > 1e-9) d.face = unit(v);
    return { d, R: [0, 0, 0], reached: true };
  }
  const limb = (['armL', 'armR', 'legL', 'legR'] as string[]).includes(part) ? part as Limb : null;
  const upper = !!limb && bone.endsWith('1');
  const solveLimb = () => { if (limb) aimLimb(d, limb, T, upper, t); };
  // The bones that bend (top first) before the body moves, with how far each may turn from where it started.
  const lim = (opt.spineMax ?? 24) * Math.PI / 180;
  let chain: [BoneKey, number][] = [];
  const spineFrom = (top: BoneKey, k = lim): [BoneKey, number][] => {
    const s: BoneKey[] = ['spine2', 'spine1', 'spine0'];
    return s.slice(s.indexOf(top)).map(b => [b, k] as [BoneKey, number]);
  };
  if (limb && limb.startsWith('arm')) chain = spineFrom('spine2');
  else if (bone === 'spine0' || bone === 'spine1' || bone === 'spine2') chain = spineFrom(bone, lim * 1.6);
  else if (bone === 'neck') chain = [['neck', 70 * Math.PI / 180], ...spineFrom('spine2')];
  else if (bone === 'sh') chain = spineFrom('spine2', lim * 1.4);
  chain = chain.filter(([b]) => !pinned.has(PART_OF[b]));
  solveLimb();
  // Bend the chain (cyclic coordinate descent with limits), re-aiming the limb after each step.
  if (chain.length && len(sub(T, eff())) > 1e-4) {
    for (let it = 0; it < 6; it++) {
      for (const [b, maxA] of chain) {
        const J = build(d);
        const root = b === 'neck' ? J.N : b === 'spine2' ? J.S2 : b === 'spine1' ? J.S1 : J.P;
        const v1 = sub(eff(), root), v2 = sub(T, root);
        if (len(v1) < 1e-6 || len(v2) < 1e-6) continue;
        const ax = cross(v1, v2), a = angleOf(v1, v2);
        if (len(ax) < 1e-9 || a < 1e-5) continue;
        rotateBone(d, b, unit(ax), a, pinned);
        // keep within the limit (turn back toward where it started, children too)
        const dev = angleOf(d[b], d0[b]);
        if (dev > maxA) { const bx = cross(d[b], d0[b]); if (len(bx) > 1e-9) rotateBone(d, b, unit(bx), dev - maxA, pinned); }
        solveLimb();
      }
      if (len(sub(T, eff())) < 1e-4) break;
    }
  }
  // Whatever is left moves the whole body.
  let R = sub(T, eff());
  if (bone === 'hip') R = sub(T, pointOn(J0, bone, t));
  // Pinned limbs keep their hands and feet in the world: they bend to stay, and limit how far the body goes.
  const anchors = LIMBS.filter(p => p !== limb && pinned.has(p)).map(p => ({ p, end: J0[LIMB_J[p][2]] as V3 }));
  const reachable = (s: number) => {
    const J = build(d);
    return anchors.every(({ p, end }) => { const [L1, L2] = LIMB_LEN(p); return len(sub(sub(end, mul(R, s)), J[LIMB_J[p][0]] as V3)) <= (L1 + L2) * 0.999; });
  };
  if (anchors.length && len(R) > 1e-6 && !reachable(1)) {
    let lo = 0, hi = 1;
    if (!reachable(0)) lo = 0; // already out of reach before moving: do not move at all
    else { for (let i = 0; i < 18; i++) { const m = (lo + hi) / 2; if (reachable(m)) lo = m; else hi = m; } }
    R = mul(R, lo);
  }
  // free legs (not dragged, not pinned): the foot stays while the leg can reach, then the straight leg trails along
  if (len(R) > 1e-6) for (const p of LIMBS) {
    if (!p.startsWith('leg') || p === limb || pinned.has(p)) continue;
    const J = build(d), [ja, jb, jc] = LIMB_J[p], [L1, L2] = LIMB_LEN(p);
    const r = twoBone(J[ja] as V3, L1, L2, sub(J0[jc] as V3, R), sub(J[jb] as V3, J[ja] as V3), d.fw);
    d[`${p}1` as BoneKey] = r.d1; d[`${p}2` as BoneKey] = r.d2;
  }
  for (const { p, end } of anchors) {
    const J = build(d), [ja, jb] = LIMB_J[p], [L1, L2] = LIMB_LEN(p);
    const fb = p.startsWith('arm') ? mul(d.fw, -1) : d.fw;
    const r = twoBone(J[ja] as V3, L1, L2, sub(end, R), sub(J[jb] as V3, J[ja] as V3), fb);
    d[`${p}1` as BoneKey] = r.d1; d[`${p}2` as BoneKey] = r.d2;
  }
  const reached = len(sub(T, add(eff(), R))) < 1e-3;
  return { d, R: R.map(v => +v.toFixed(6)) as V3, reached };
}
