// 2D geometry helpers for sketch strokes. Points are fractions of the sketch canvas WIDTH (x and y both divided
// by width), so a drawing survives resizing. y grows downward, as on screen.

export interface Pt { x: number; y: number }

export const dist = (a: Pt, b: Pt): number => Math.hypot(a.x - b.x, a.y - b.y);

export function plen(p: Pt[]): number {
  let L = 0;
  for (let i = 1; i < p.length; i++) L += dist(p[i - 1], p[i]);
  return L;
}

/** Point halfway along the stroke by arc length. */
export function arcMid(p: Pt[]): Pt {
  const seg: number[] = [];
  let L = 0;
  for (let i = 1; i < p.length; i++) { const d = dist(p[i - 1], p[i]); seg.push(d); L += d; }
  let h = L / 2;
  for (let i = 0; i < seg.length; i++) {
    if (h <= seg[i]) {
      const t = seg[i] ? h / seg[i] : 0;
      return { x: p[i].x + (p[i + 1].x - p[i].x) * t, y: p[i].y + (p[i + 1].y - p[i].y) * t };
    }
    h -= seg[i];
  }
  return p[p.length - 1];
}

/** Distance from p to segment ab, and the clamped position t along it. */
export function dseg(p: Pt, a: Pt, b: Pt): [number, number] {
  const dx = b.x - a.x, dy = b.y - a.y, l2 = dx * dx + dy * dy;
  let t = l2 ? ((p.x - a.x) * dx + (p.y - a.y) * dy) / l2 : 0;
  t = Math.max(0, Math.min(1, t));
  return [Math.hypot(p.x - a.x - t * dx, p.y - a.y - t * dy), t];
}

/** Distance from a point to a polyline, plus the position along it (0 to 1 by arc length). */
export function dpoly(p: Pt, poly: Pt[]): [number, number] {
  let best: [number, number] = [1e9, 0], acc = 0;
  const tot = plen(poly) || 1;
  for (let i = 1; i < poly.length; i++) {
    const [d, t] = dseg(p, poly[i - 1], poly[i]);
    const sl = dist(poly[i - 1], poly[i]);
    if (d < best[0]) best = [d, (acc + t * sl) / tot];
    acc += sl;
  }
  return best;
}

/** Bend point (elbow or knee): the point farthest from the chord; the arc midpoint when the stroke is nearly
 *  straight (under 8% of the chord). */
export function bend(p: Pt[]): Pt {
  const a = p[0], b = p[p.length - 1], c = dist(a, b);
  if (c < 1e-6) return arcMid(p);
  let m = 0, mp: Pt | null = null;
  for (const q of p) { const d = dseg(q, a, b)[0]; if (d > m) { m = d; mp = q; } }
  return m < 0.08 * c || !mp ? arcMid(p) : mp;
}

/** A roughly round closed loop: a head candidate. Tall or wide ovals (up to 1:3) still count. */
export function isLoop(p: Pt[]): boolean {
  const L = plen(p);
  if (L < 0.08 || dist(p[0], p[p.length - 1]) > 0.25 * L) return false;
  const xs = p.map(q => q.x), ys = p.map(q => q.y);
  const w = Math.max(...xs) - Math.min(...xs), h = Math.max(...ys) - Math.min(...ys);
  return w > 0.03 && h > 0.03 && w / h > 0.33 && w / h < 3;
}

export const isClosed = (p: Pt[]): boolean => { const L = plen(p); return L > 0.08 && dist(p[0], p[p.length - 1]) < 0.25 * L; };

/** Head centre and radius from the loop's bounding box, so slow or retraced parts of the stroke do not pull it. */
export function hbox(p: Pt[]): { c: Pt; r: number } {
  const xs = p.map(q => q.x), ys = p.map(q => q.y);
  const x0 = Math.min(...xs), x1 = Math.max(...xs), y0 = Math.min(...ys), y1 = Math.max(...ys);
  return { c: { x: (x0 + x1) / 2, y: (y0 + y1) / 2 }, r: ((x1 - x0) + (y1 - y0)) / 4 || 1e-9 };
}

export function inPoly(p: Pt, poly: Pt[]): boolean {
  let inside = false;
  for (let a = 0, b = poly.length - 1; a < poly.length; b = a++) {
    const A = poly[a], B = poly[b];
    if ((A.y > p.y) !== (B.y > p.y) && p.x < (B.x - A.x) * (p.y - A.y) / (B.y - A.y) + A.x) inside = !inside;
  }
  return inside;
}

/** Index of a sharp corner (over 45 degrees) in the middle of stroke p within `reach` of point e, or -1. */
export function cornerNear(p: Pt[], e: Pt, reach: number): number {
  const cum = [0];
  for (let i = 1; i < p.length; i++) cum.push(cum[i - 1] + dist(p[i - 1], p[i]));
  const L = cum[cum.length - 1];
  if (L < 0.1) return -1;
  let best = -1, bd = reach;
  const margin = Math.max(0.05, 0.15 * L);
  for (let i = 1; i < p.length - 1; i++) {
    if (cum[i] < margin || L - cum[i] < margin) continue;
    const d = dist(p[i], e);
    if (d < bd) { bd = d; best = i; }
  }
  if (best < 0) return -1;
  let a = best, b = best;
  while (a > 0 && cum[best] - cum[a] < 0.03) a--;
  while (b < p.length - 1 && cum[b] - cum[best] < 0.03) b++;
  const ux = p[best].x - p[a].x, uy = p[best].y - p[a].y, vx = p[b].x - p[best].x, vy = p[b].y - p[best].y;
  const c = (ux * vx + uy * vy) / ((Math.hypot(ux, uy) * Math.hypot(vx, vy)) || 1);
  return Math.acos(Math.max(-1, Math.min(1, c))) > Math.PI / 4 ? best : -1;
}

/** The spine with the neck first: the end nearest the head, or the upper end when there is no head. */
export function neckFirst(p: Pt[], hc: Pt | null): Pt[] {
  const a = p[0], b = p[p.length - 1];
  const flip = hc ? dist(a, hc) > dist(b, hc) : a.y > b.y;
  return flip ? [...p].reverse() : p;
}
