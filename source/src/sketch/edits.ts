// Edit pen: reshape any part (spine, neck, facing, shoulder and hip lines, arms, legs) by drawing a guide over it in
// any view: the front sketch, a side, back or top sketch view, or a 3D viewport. The guide is cut into one segment per
// bone (limbs at their bend, the spine in thirds). A segment fixes its bone's direction on screen; how short it is
// drawn against the bone's length says how far the bone points toward or away from the viewer, the same rule the
// sketch lifter uses. Which way (toward or away) is taken from the current pose. Bone lengths never change.
//
// A guide makes a draft; applying it bakes it into the pose (and rewrites the drawing). Drafts store absolute
// directions; applying a parent carries its children (see pose3d).
import { Pt, dist, bend } from './geom';
import { V3, alongArc } from './lifter';
import { Part, PART_BONES, snapDir, unit, dot, len } from './pose3d';

/** Muted red for edit guides: readable on the paper and the grey stage, not a tag colour. */
export const EDIT_COLOR = '#b5534a';

export type GuideView = 'front' | 'back' | 'left' | 'right' | 'top' | '3d';
export interface Draft {
  part: Part;
  /** Unit directions of the part's bones, figure space, root first. */
  dirs: V3[];
  /** The guide as drawn, for display: view coordinates (y up) for sketch views, or 3D points relative to the part's
   *  root on the character (metres). */
  guide: { view: Exclude<GuideView, '3d'>; pts: [number, number][] } | { view: '3d'; pts: V3[] };
}

/** A view plane: screen right, screen up and toward the viewer, in figure space. */
export interface Basis { right: V3; up: V3; toward: V3 }

/** A bone drawn at this share of its length or more counts as flat (matches the lifter). */
export const FLAT = 0.85;

/** One bone from its on-screen segment (`seg`, in the view plane, same units as `L`). */
export function solveBone(seg: V3, L: number, w: V3, cur: V3, fallback: 1 | -1, flat = FLAT): V3 {
  const wn = unit(w);
  const inPlane: V3 = [seg[0] - wn[0] * dot(seg, wn), seg[1] - wn[1] * dot(seg, wn), seg[2] - wn[2] * dot(seg, wn)];
  const l = len(inPlane);
  if (l < 1e-9) return unit(cur);
  const q = Math.min(1, l / (flat * L));
  const cz = dot(unit(cur), wn), sign = Math.abs(cz) > 0.05 ? Math.sign(cz) : fallback;
  const k = q / l, z = sign * Math.sqrt(Math.max(0, 1 - q * q));
  return unit([inPlane[0] * k + wn[0] * z, inPlane[1] * k + wn[1] * z, inPlane[2] * k + wn[2] * z]);
}

/** Split a guide into bone segments: limbs at their bend (the lifter's own rule), the spine in thirds of its length,
 *  single bones end to end. */
export function splitGuide(part: Part, pts: Pt[]): Pt[] {
  const n = PART_BONES[part].length;
  if (n === 2) return [pts[0], bend(pts), pts[pts.length - 1]];
  if (n === 3) return alongArc(pts, [0, 1 / 3, 2 / 3, 1]);
  return [pts[0], pts[pts.length - 1]];
}

export interface SolveInput {
  part: Part;
  /** Guide points in view coordinates (x right, y up), any unit. */
  pts: Pt[];
  basis: Basis;
  /** Each bone's length in the same unit (for the facing: the head radius; for shoulder and hip lines: full width). */
  lengths: number[];
  /** The part's root in view coordinates: the guide is read from the end nearer to it. Shoulder and hip lines and the
   *  facing ignore it. */
  root: Pt;
  /** Current directions of the part's bones (decide toward or away; keep the shoulder and hip line's sides). */
  cur: V3[];
  /** Torso forward, for the toward-or-away default of spine, neck and facing. */
  fw: V3;
  /** Snap each bone to the 15 degree grid. */
  snap?: boolean;
}

export function solvePart(o: SolveInput): V3[] {
  const { part, basis: b } = o;
  let pts = o.pts;
  const isBar = part === 'sh' || part === 'hip';
  if (!isBar && dist(pts[0], o.root) > dist(pts[pts.length - 1], o.root)) pts = [...pts].reverse();
  const cut = splitGuide(part, pts);
  const to3 = (a: Pt, c: Pt): V3 => { const dx = c.x - a.x, dy = c.y - a.y; return [b.right[0] * dx + b.up[0] * dy, b.right[1] * dx + b.up[1] * dy, b.right[2] * dx + b.up[2] * dy]; };
  const fwSign = (Math.sign(dot(o.fw, b.toward)) || 1) as 1 | -1;
  const out: V3[] = [];
  for (let i = 0; i < cut.length - 1; i++) {
    const seg = to3(cut[i], cut[i + 1]);
    let fallback: 1 | -1 = fwSign;
    if (part.startsWith('arm')) fallback = ((i === 0 ? -1 : 1) * fwSign) as 1 | -1;     // upper arm away, forearm toward
    else if (part.startsWith('leg')) fallback = ((i === 0 ? 1 : -1) * fwSign) as 1 | -1; // thigh toward, shin away
    else if (isBar) fallback = (Math.sign(dot(o.cur[0], b.toward)) || 1) as 1 | -1;
    let d = solveBone(seg, o.lengths[i], b.toward, o.cur[i], fallback, part === 'face' ? 1 : FLAT);
    if (isBar && dot(d, o.cur[0]) < 0) d = [-d[0], -d[1], -d[2]]; // a line has no direction: keep its sides
    out.push(o.snap ? snapDir(d) : d);
  }
  return out;
}
