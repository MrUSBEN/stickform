// Auto-tagging: turn untagged strokes into a stick figure (head, facing tick, spine, crossbars, arms, legs) from
// how the strokes connect. Ported from Milestone 2; see the project doc for the reasoning behind each rule.
import { Pt, dist, plen, dpoly, isLoop, isClosed, hbox, inPoly, cornerNear, neckFirst } from './geom';
import type { Depth } from './lifter';

export type Tag = 'spine' | 'armL' | 'armR' | 'legL' | 'legR' | 'head' | 'face' | 'sh' | 'hip';

export interface Stroke {
  id: number;
  pts: Pt[];
  tag: Tag | null;
  /** Set by the user (manual brush or retag): never changed by the tagger. */
  lock: boolean;
  /** Automatic V-split: this half came from stroke `splitOf`; `whole` keeps the original points on the first half. */
  splitOf?: number;
  whole?: Pt[];
  /** Regenerated from the 3D pose: points are exact joints, root first. */
  ordered?: boolean;
}

export const TAGS: { tag: Tag; label: string; color: string; hint: string }[] = [
  { tag: 'spine', label: 'Spine', color: '#9a9a9a', hint: 'One line down the torso, top to bottom.' },
  { tag: 'armL', label: 'Arm left', color: '#e8743b', hint: 'One stroke from the shoulder out to the hand.' },
  { tag: 'armR', label: 'Arm right', color: '#d9a21b', hint: 'Same as the left arm, on the right of the screen.' },
  { tag: 'legL', label: 'Leg left', color: '#2e9e6b', hint: 'One stroke from the hip down to the foot.' },
  { tag: 'legR', label: 'Leg right', color: '#2b8fc4', hint: 'Same as the left leg, on the right of the screen.' },
  { tag: 'head', label: 'Head', color: '#a05cd6', hint: 'Draw a circle.' },
  { tag: 'face', label: 'Facing tick', color: '#d6457a', hint: 'From the head centre outward. Reaching the rim means looking sideways; shorter means toward or away from you.' },
  { tag: 'sh', label: 'Shoulders', color: '#7a7ad9', hint: 'Optional crossbar. A shorter bar means the shoulders are twisted.' },
  { tag: 'hip', label: 'Hips', color: '#5aa0a0', hint: 'Optional crossbar for hip twist.' },
];
export const COLOR = Object.fromEntries(TAGS.map(t => [t.tag, t.color])) as Record<Tag, string>;
export const LABEL = Object.fromEntries(TAGS.map(t => [t.tag, t.label])) as Record<Tag, string>;

export type Flips = Partial<Record<'armL' | 'armR' | 'legL' | 'legR' | 'sh' | 'hip' | 'head', boolean>>;

export class Sketch {
  strokes: Stroke[] = [];
  nid = 1;
  flips: Flips = {};
  away = false;
  snap = 0.04;
  lastSpine: number | null = null;
  /** Depth of edited bones, fixed page scale and torso forward (see lifter). */
  depth: Depth = { z: {} };

  /** One points array per tag, for the lifter. */
  /** Tags whose stroke was regenerated from the pose. */
  ordered(): Partial<Record<Tag, boolean>> {
    const o: Partial<Record<Tag, boolean>> = {};
    for (const s of this.strokes) if (s.tag && s.ordered) o[s.tag] = true;
    return o;
  }

  byTag(): Partial<Record<Tag, Pt[]>> {
    const o: Partial<Record<Tag, Pt[]>> = {};
    for (const s of this.strokes) if (s.tag) o[s.tag] = s.pts;
    return o;
  }

  add(pts: Pt[], tag: Tag | null): void {
    if (tag) {
      this.strokes = this.strokes.filter(s => s.tag !== tag);
      this.strokes.push({ id: this.nid++, pts, tag, lock: true });
    } else this.strokes.push({ id: this.nid++, pts, tag: null, lock: false });
    this.classify();
  }

  /** Retag a stroke (locks it). Taking a tag another stroke holds swaps the two. null = ignore the stroke. */
  retag(id: number, tag: Tag | null): void {
    const s = this.strokes.find(o => o.id === id);
    if (!s) return;
    if (tag) {
      const other = this.strokes.find(o => o !== s && o.tag === tag);
      if (other) { other.tag = s.tag; other.lock = true; }
    }
    s.tag = tag; s.lock = true;
    this.classify();
  }

  remove(id: number): void { this.strokes = this.strokes.filter(o => o.id !== id); this.classify(); }

  classify(): void {
    let S = this.strokes;
    // Undo earlier automatic V-splits (both halves still auto); they are recomputed below against the current spine.
    for (const b of S.filter(s => s.splitOf && !s.lock)) {
      const a = S.find(s => s.id === b.splitOf);
      if (a && !a.lock && a.whole) { a.pts = a.whole; delete a.whole; S.splice(S.indexOf(b), 1); }
    }
    const lock = S.filter(s => s.lock);
    // Touch distances shrink for small figures (a compact squat would otherwise have every stroke touching every
    // other one). 0.6 of the canvas width is a typical full-height figure. Never grows: big drawings keep the reach.
    const all = S.flatMap(s => s.pts);
    const fsz = all.length ? Math.max(Math.max(...all.map(q => q.x)) - Math.min(...all.map(q => q.x)),
      Math.max(...all.map(q => q.y)) - Math.min(...all.map(q => q.y))) : 0.6;
    const fs = Math.max(0.35, Math.min(1, fsz / 0.6)), SN = this.snap * fs;
    const taken = new Set(lock.map(s => s.tag).filter(Boolean));
    S.forEach(s => { if (!s.lock) s.tag = null; });
    let pool = S.filter(s => !s.lock);
    const free = (t: Tag) => !taken.has(t);
    const use = (s: Stroke, t: Tag) => { s.tag = t; taken.add(t); };
    const rm = (s: Stroke) => { pool = pool.filter(x => x !== s); };
    const ends = (s: Stroke): [Pt, Pt] => [s.pts[0], s.pts[s.pts.length - 1]];

    // Head: the smallest closed loop (a V of two legs can also close up, but is bigger).
    let hc: Pt | null = null, rad = 0, hpts: Pt[] | null = null;
    const lh = lock.find(s => s.tag === 'head');
    if (lh) { hpts = lh.pts; ({ c: hc, r: rad } = hbox(hpts)); }
    else if (free('head')) {
      const loops = pool.filter(s => isLoop(s.pts)).sort((p, q) => plen(p.pts) - plen(q.pts));
      if (loops[0]) { const s = loops[0]; use(s, 'head'); rm(s); hpts = s.pts; ({ c: hc, r: rad } = hbox(hpts)); }
    }
    // Facing tick: a short stroke starting inside the head (a short arm at the neck sits on the rim, outside).
    if (hc && hpts && free('face')) {
      const h = hpts, c0 = hc;
      const inner = (s: Stroke) => Math.min(...ends(s).map(e => (inPoly(e, h) ? 0 : dist(e, c0) / rad)));
      const c = pool.filter(s => plen(s.pts) < 2.5 * rad && inner(s) < 0.8).sort((p, q) => inner(p) - inner(q));
      if (c[0]) { use(c[0], 'face'); rm(c[0]); }
    }
    // Spine: the stroke with junctions at BOTH ends (arms and head at the neck, legs and hips at the pelvis).
    let sp = lock.find(s => s.tag === 'spine') || null;
    if (!sp && free('spine')) {
      const reach = SN * 2.5;
      // A junction = another stroke's END lands here (the head loop counts anywhere along it; a sharp corner in
      // the middle of a stroke counts too, as two limbs drawn in one V stroke). A stroke passing near the middle
      // does not count, so a hand resting on the torso does not make an arm look like a spine.
      const near = (s: Stroke, e: Pt, r: number) => S.filter(o => o !== s && (o.tag === 'head'
        ? dpoly(e, o.pts)[0] < r
        : Math.min(...ends(o).map(q => dist(e, q))) < r || cornerNear(o.pts, e, r) >= 0));
      // Strokes touching BOTH ends (a short hip bar between two legs) give no credit; reach shrinks for short
      // strokes; being upright is only a light preference so lying and kicking poses still find the torso.
      const score = (s: Stroke) => {
        const [a, b] = ends(s), L = plen(s.pts), c = dist(a, b) || 1e-9, r = Math.min(reach, 0.4 * L);
        const A = near(s, a, r), B = near(s, b, r);
        const nA = A.filter(o => !B.includes(o)).length, nB = B.filter(o => !A.includes(o)).length;
        let v = (1 + nA) * (1 + nB) * Math.sqrt(L) * (0.75 + 0.25 * Math.abs(a.y - b.y) / c);
        if (hc && Math.min(dist(a, hc), dist(b, hc)) < 3 * rad) v *= 1.5;
        if (s.id === this.lastSpine) v *= 1.5; // stickiness: the guess does not jump while half drawn
        return v;
      };
      const cand = pool.filter(s => plen(s.pts) > 0.06 && !isClosed(s.pts)).sort((p, q) => score(q) - score(p));
      if (cand[0]) { sp = cand[0]; use(sp, 'spine'); rm(sp); }
    }
    this.lastSpine = sp ? sp.id : null;
    if (!sp) return;
    const sps = neckFirst(sp.pts, hc), sp0 = sps[0], sp1 = sps[sps.length - 1], sl = plen(sps) || 1e-9;
    // Split a stroke with a sharp corner at the neck or pelvis into two limbs (both legs or arms in one stroke).
    for (const o of [...pool]) {
      for (const e of [sp0, sp1]) {
        const i = cornerNear(o.pts, e, SN * 2.5);
        if (i < 0) continue;
        const b: Stroke = { id: this.nid++, pts: o.pts.slice(i), tag: null, lock: false, splitOf: o.id };
        o.whole = o.whole || o.pts; o.pts = o.pts.slice(0, i + 1);
        S.splice(S.indexOf(o) + 1, 0, b); pool.push(b);
        break;
      }
    }
    const side = (p: Pt) => (sp1.x - sp0.x) * (p.y - sp0.y) - (sp1.y - sp0.y) * (p.x - sp0.x);
    const vlen = Math.hypot(sp1.x - sp0.x, sp1.y - sp0.y) || 1e-9;
    // Crossbars: short strokes crossing the spine with both ends clearly off it, more across than along.
    const bars: { s: Stroke; t: number; L: number }[] = [];
    for (const s of pool) {
      const [a, b] = ends(s), L = plen(s.pts);
      if (L > 0.9 * sl || side(a) * side(b) >= 0) continue;
      if (Math.min(Math.abs(side(a)), Math.abs(side(b))) / vlen < 0.25 * dist(a, b)) continue;
      const [d, t] = dpoly({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 }, sps);
      if (d > 0.06 * fs) continue;
      const ux = b.x - a.x, uy = b.y - a.y, vx = sp1.x - sp0.x, vy = sp1.y - sp0.y;
      if (Math.abs(ux * vx + uy * vy) / ((Math.hypot(ux, uy) * Math.hypot(vx, vy)) || 1) > 0.75) continue;
      bars.push({ s, t, L });
    }
    for (const [tag, ok] of [['sh', (t: number) => t < 0.5], ['hip', (t: number) => t >= 0.5]] as const) {
      if (!free(tag)) continue;
      const c = bars.filter(b => ok(b.t) && pool.includes(b.s)).sort((p, q) => q.L - p.L)[0];
      if (c) { use(c.s, tag); rm(c.s); }
    }
    const shS = S.find(s => s.tag === 'sh'), hipS = S.find(s => s.tag === 'hip');
    // Limbs: whatever touches the spine (upper part arms, lower part legs) or a crossbar end.
    const reach = SN * 2.5;
    const att: { s: Stroke; d: number; kind: 'arm' | 'leg'; e: Pt }[] = [];
    for (const s of pool) {
      let best: { d: number; kind: 'arm' | 'leg'; e: Pt } | null = null;
      for (const e of ends(s)) {
        const [d, t] = dpoly(e, sps);
        if (!best || d < best.d) best = { d, kind: t < 0.45 ? 'arm' : 'leg', e };
        if (shS) for (const q of ends(shS)) { const dd = dist(e, q); if (dd < best.d) best = { d: dd, kind: 'arm', e }; }
        if (hipS) for (const q of ends(hipS)) { const dd = dist(e, q); if (dd < best.d) best = { d: dd, kind: 'leg', e }; }
      }
      if (best && best.d <= reach) att.push({ s, ...best });
    }
    // Left and right are the figure's own sides measured across the spine, so they rotate with the body.
    const key = (a: { s: Stroke; e: Pt }) => -side(a.e === a.s.pts[0] ? a.s.pts[a.s.pts.length - 1] : a.s.pts[0]) / vlen;
    const assign = (kind: 'arm' | 'leg', L: Tag, R: Tag) => {
      const list = att.filter(a => a.kind === kind).sort((p, q) => key(p) - key(q));
      if (!list.length) return;
      const scr = this.away ? [R, L] : [L, R], fr = scr.map(t => (free(t) ? t : null));
      if (fr[0] && fr[1]) {
        if (list.length === 1) use(list[0].s, (key(list[0]) < 0 ? fr[0] : fr[1]) as Tag);
        else { use(list[0].s, fr[0]); use(list[list.length - 1].s, fr[1]); }
      } else if (fr[0]) use(list[0].s, fr[0]);
      else if (fr[1]) use(list[list.length - 1].s, fr[1]);
    };
    assign('arm', 'armL', 'armR');
    assign('leg', 'legL', 'legR');
    this.strokes = S;
  }
}
