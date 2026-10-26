// The sketch viewport's drawing surface: pen (auto-tag), select, erase stroke, tag brush and edit pen, with undo
// and redo.
// Points are stored as fractions of a "page" (width 1, height 1.15, the M2/M3 canvas shape) centred in the paper,
// so a drawing keeps its size and place when the viewport is resized.
import { Pt, plen, dpoly, arcMid, bend } from './geom';
import { Sketch, Tag, COLOR, LABEL } from './tagger';

export type Tool = 'pen' | 'select' | 'erase' | 'brush' | 'edit';
export const PAGE_ASPECT = 1.15;
/** Darker label colours that read on the paper. */
export const INK: Record<Tag, string> = {
  spine: '#6b6a66', armL: '#b4531a', armR: '#8f5a0c', legL: '#237a53', legR: '#1f6f9c',
  head: '#7d3fb0', face: '#b02e5f', sh: '#5555b8', hip: '#3d7a7a',
};
const ACC = '#5b8cff', ERASE = '#c4402f', UNTAGGED = '#b9b5aa', WET = '#2b2a27';

interface Snap { s: Sketch['strokes']; n: number; f: Sketch['flips']; a: boolean; d?: Sketch['depth']; x?: unknown }
/** The edit pen's guide colour (muted red, dashed). */
export const EDIT_INK = '#b5534a';

export class SketchCanvas {
  tool: Tool = 'pen';
  brush: Tag = 'armL';
  selected: number | null = null;
  showLabels = true;
  private drawing: { tag: Tag | null; pts: Pt[] } | null = null;
  private erasing = false;
  private hover: number | null = null;
  private undoStack: string[] = [];
  private redoStack: string[] = [];
  /** Page placement in CSS px: origin and scale (px per page unit). */
  page = { x: 0, y: 0, s: 1 };
  /** Zoom and pan on top of the fitted page: screen = fitted × z + (x, y). Wheel zooms at the pointer; right, middle
   *  or Space + left drag pans. */
  view = { z: 1, x: 0, y: 0 };
  /** Called when the view changes (zoom or pan). */
  onView: () => void = () => {};
  /** Edit pen: a finished guide (page points), or a click (one point) that picks a limb. */
  onEdit: (pts: Pt[], click: boolean) => void = () => {};
  /** Drawing under the strokes (the other characters, faint). */
  underlay: (x: CanvasRenderingContext2D, P: (q: Pt) => { x: number; y: number }) => void = () => {};
  /** Extra drawing on top of the strokes (edit guides, edited limbs). */
  decorate: (x: CanvasRenderingContext2D, P: (q: Pt) => { x: number; y: number }) => void = () => {};
  /** Select-tool click: also picks a bone (returns whether it did). */
  onPick: (p: Pt) => boolean = () => false;
  /** Pointer position for hover highlights (null when it leaves). */
  onHover: (p: Pt | null) => void = () => {};
  /** Called before every change to the drawing (ends an edit-pen draft session). */
  beforeChange: () => void = () => {};
  /** The last Reset or Focus, kept until the user pans or zooms: it is redone whenever the paper changes size, so
   *  the framing survives viewport resizes. */
  fitAuto: (() => void) | null = null;
  private lastSize = '';
  /** Returns true (after telling the user) when the drawing must not change, e.g. the character is locked. */
  blocked: () => boolean = () => false;
  /** Hover reports with any tool (e.g. while Reach to… waits for a click). */
  hoverAlways: () => boolean = () => false;
  /** Clicks that should not select a stroke (they answer Reach to… or a pending pick). */
  noStrokePick: () => boolean = () => false;
  /** A batch of changes (dragging a number) takes one undo step: only its first snapshot counts. */
  private batch: { taken: boolean } | null = null;
  beginBatch(): void { this.batch = { taken: false }; }
  endBatch(): void { this.batch = null; }
  /** A finished pen stroke can go somewhere else (a new figure, another character): true = taken care of. */
  route: (pts: Pt[]) => boolean = () => false;
  /** Strokes that belong to no character yet (a new figure taking shape), drawn faintly with the drawing. */
  pendingDraw: (x: CanvasRenderingContext2D, P: (q: Pt) => { x: number; y: number }) => void = () => {};
  /** Erase reaching nothing of the character's own: try those strokes (true = one was erased). */
  eraseExtra: (p: Pt, reach: number) => boolean = () => false;
  /** Other state that undo and redo should cover (the edits). */
  ext: { save(): unknown; load(v: unknown): void } | null = null;

  constructor(private cv: HTMLCanvasElement, public sketch: Sketch,
              private onChange: () => void, private onSelect: () => void) {
    attachPanZoom(cv, () => this.view, () => { this.fitAuto = null; this.draw(); this.onView(); });
    cv.addEventListener('pointerdown', e => {
      if (e.button !== 0 || panKey.space) return;
      cv.setPointerCapture(e.pointerId);
      const p = this.pt(e);
      if (this.tool === 'erase') { if (this.blocked()) return; this.erasing = true; this.eraseAt(p, true); return; }
      if (this.tool === 'select') { this.pick(p); return; }
      this.drawing = { tag: this.tool === 'brush' ? this.brush : null, pts: [p] };
      if (this.tool === 'edit') this.drawing.tag = null;
    });
    cv.addEventListener('pointermove', e => {
      const p = this.pt(e);
      if (this.erasing) { this.eraseAt(p, false); return; }
      if (this.drawing) { this.drawing.pts.push(p); this.draw(); return; }
      if (this.tool === 'erase' || this.tool === 'select') {
        const h = this.nearest(p, 0.03);
        if (h !== this.hover) { this.hover = h; this.draw(); }
      }
      if (this.tool === 'edit' || this.tool === 'select' || this.hoverAlways()) this.onHover(p);
    });
    cv.addEventListener('pointerleave', () => { this.onHover(null); if (this.hover !== null) { this.hover = null; this.draw(); } });
    cv.addEventListener('pointerup', () => { this.erasing = false; this.finish(); });
    cv.addEventListener('pointercancel', () => { this.erasing = false; this.drawing = null; this.draw(); });
  }

  private pt(e: PointerEvent): Pt {
    const r = this.cv.getBoundingClientRect();
    return { x: (e.clientX - r.left - this.page.x) / this.page.s, y: (e.clientY - r.top - this.page.y) / this.page.s };
  }
  /** Zoom and pan so a box in page units fills the paper (with a margin). `maxZ` caps the zoom; with `keepHome`
   *  the default view stays when the box already fits in it. */
  fitBox(b: { x0: number; y0: number; x1: number; y1: number }, maxZ = 8, keepHome = false, pad = { l: 24, r: 24, t: 24, b: 24 }): void {
    const r = this.cv.getBoundingClientRect();
    if (!r.width || !r.height) return;
    this.lastSize = `${Math.round(r.width)}x${Math.round(r.height)}`;
    const m = 16, s = Math.max(40, Math.min(r.width - 2 * m, (r.height - 2 * m) / PAGE_ASPECT));
    const bx = (r.width - s) / 2, by = (r.height - s * PAGE_ASPECT) / 2; // the page at zoom 1, no pan
    const X0 = bx + b.x0 * s, X1 = bx + b.x1 * s, Y0 = by + b.y0 * s, Y1 = by + b.y1 * s;
    const W = Math.max(20, r.width - pad.l - pad.r), H = Math.max(20, r.height - pad.t - pad.b);
    // Reset keeps the usual view whenever the figures fit in it (labels and pills may overlap them, as they always have)
    if (keepHome && X0 >= 8 && Y0 >= 8 && X1 <= r.width - 8 && Y1 <= r.height - 8) { this.view = { z: 1, x: 0, y: 0 }; this.draw(); this.onView(); return; }
    const z = Math.max(FIT_MIN, Math.min(maxZ, W / Math.max(1, X1 - X0), H / Math.max(1, Y1 - Y0)));
    this.view = { z, x: pad.l + W / 2 - (X0 + X1) / 2 * z, y: pad.t + H / 2 - (Y0 + Y1) / 2 * z };
    this.draw(); this.onView();
  }
  /** Page point to CSS px inside the canvas. */
  toPx(p: Pt): { x: number; y: number } { return { x: this.page.x + p.x * this.page.s, y: this.page.y + p.y * this.page.s }; }

  private nearest(p: Pt, reach: number): number | null {
    let best: number | null = null, bd = reach;
    for (const s of this.sketch.strokes) { const [dd] = dpoly(p, s.pts); if (dd < bd) { bd = dd; best = s.id; } }
    return best;
  }
  private pick(p: Pt): void {
    const skip = this.noStrokePick(); // e.g. a click that answers Reach to…: it should not select a stroke
    this.onPick(p);
    this.selected = skip ? null : this.nearest(p, 0.03);
    this.draw();
    this.onSelect();
  }
  private eraseAt(p: Pt, first: boolean): void {
    const id = this.nearest(p, first ? 0.03 : 0.018);
    if (id === null) { if (this.eraseExtra(p, first ? 0.03 : 0.018)) this.onChange(); return; }
    this.snapshot();
    const s = this.sketch.strokes.find(o => o.id === id);
    // An automatic V-split half belongs to one drawn stroke: erase both halves.
    const ids = new Set([id]);
    if (s?.splitOf) ids.add(s.splitOf);
    for (const o of this.sketch.strokes) if (o.splitOf === id) ids.add(o.id);
    this.sketch.strokes = this.sketch.strokes.filter(o => !ids.has(o.id));
    this.sketch.classify();
    if (this.selected !== null && ids.has(this.selected)) { this.selected = null; this.onSelect(); }
    this.hover = null;
    this.onChange();
  }

  private finish(): void {
    const d = this.drawing;
    this.drawing = null;
    if (!d) return;
    if (this.tool === 'edit') { const click = d.pts.length < 2 || plen(d.pts) < 0.012; this.onEdit(click ? [d.pts[0]] : d.pts, click); this.draw(); return; }
    if (d.pts.length < 2 || plen(d.pts) < 0.012) { this.pick(d.pts[0]); return; } // a click selects
    if (this.tool === 'pen' && !d.tag && this.route(d.pts)) { this.selected = null; this.onSelect(); this.draw(); return; }
    if (this.blocked()) { this.draw(); return; }
    this.snapshot();
    this.sketch.add(d.pts, d.tag);
    this.selected = null;
    this.onSelect();
    this.onChange();
  }

  private state(): string { const k = this.sketch; return JSON.stringify({ s: k.strokes, n: k.nid, f: k.flips, a: k.away, d: k.depth, x: this.ext?.save() } as Snap); }
  private restore(h: string): void {
    const o = JSON.parse(h) as Snap, k = this.sketch;
    k.strokes = o.s; k.nid = Math.max(k.nid, o.n); k.flips = o.f || {}; k.away = !!o.a; k.depth = o.d || { z: {} };
    this.ext?.load(o.x);
    k.classify();
    this.selected = null;
    this.onSelect();
    this.onChange();
  }
  /** Call before any change to the drawing, flips or facing. */
  snapshot(): void {
    if (this.batch) { if (this.batch.taken) return; this.batch.taken = true; }
    this.beforeChange();
    this.undoStack.push(this.state());
    if (this.undoStack.length > 200) this.undoStack.shift();
    this.redoStack = [];
  }
  /** Each open tab keeps its own history. */
  exportHistory(): { u: string[]; r: string[] } { return { u: this.undoStack, r: this.redoStack }; }
  importHistory(h: { u: string[]; r: string[] } | null): void { this.undoStack = h ? h.u : []; this.redoStack = h ? h.r : []; }
  clearHistory(): void { this.undoStack = []; this.redoStack = []; }
  get canUndo(): boolean { return this.undoStack.length > 0; }
  get canRedo(): boolean { return this.redoStack.length > 0; }
  undo(): boolean { const h = this.undoStack.pop(); if (!h) return false; this.redoStack.push(this.state()); this.restore(h); return true; }
  redo(): boolean { const h = this.redoStack.pop(); if (!h) return false; this.undoStack.push(this.state()); this.restore(h); return true; }

  /** Bounding box of a stroke in CSS px. */
  strokeBox(id: number): { x0: number; y0: number; x1: number; y1: number } | null {
    const s = this.sketch.strokes.find(o => o.id === id);
    if (!s) return null;
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const q of s.pts) { const p = this.toPx(q); x0 = Math.min(x0, p.x); y0 = Math.min(y0, p.y); x1 = Math.max(x1, p.x); y1 = Math.max(y1, p.y); }
    return { x0, y0, x1, y1 };
  }

  draw(): void {
    const cv = this.cv, d = devicePixelRatio || 1, r = cv.getBoundingClientRect();
    if (!r.width || !r.height) return;
    const sz = `${Math.round(r.width)}x${Math.round(r.height)}`;
    if (sz !== this.lastSize) { this.lastSize = sz; if (this.fitAuto) { this.fitAuto(); return; } }
    cv.width = Math.round(r.width * d); cv.height = Math.round(r.height * d);
    // Fit the page into the paper with a margin.
    const m = 16, s = Math.max(40, Math.min(r.width - 2 * m, (r.height - 2 * m) / PAGE_ASPECT));
    const v = this.view;
    this.page = { x: (r.width - s) / 2 * v.z + v.x, y: (r.height - s * PAGE_ASPECT) / 2 * v.z + v.y, s: s * v.z };
    paperBackground(cv.parentElement, v);
    const x = cv.getContext('2d')!;
    x.setTransform(d, 0, 0, d, 0, 0);
    x.clearRect(0, 0, r.width, r.height);
    x.lineCap = 'round'; x.lineJoin = 'round';
    const P = (q: Pt) => this.toPx(q);
    const path = (p: Pt[]) => { x.beginPath(); p.forEach((q, i) => { const o = P(q); if (i) x.lineTo(o.x, o.y); else x.moveTo(o.x, o.y); }); x.stroke(); };
    const all: [Tag | null, Pt[], number][] = this.sketch.strokes.map(st => [st.tag, st.pts, st.id]);
    const clean = new Set(this.sketch.strokes.filter(st => st.ordered).map(st => st.id)); // redrawn from the pose: no labels
    this.underlay(x, P);
    this.pendingDraw(x, P);
    // Halos under everything.
    for (const [, p, id] of all) {
      if (id === this.selected) { x.strokeStyle = ACC; x.globalAlpha = 0.22; x.lineWidth = 14; path(p); x.globalAlpha = 1; }
      else if (id === this.hover && this.tool === 'erase') { x.strokeStyle = ERASE; x.globalAlpha = 0.25; x.lineWidth = 10; path(p); x.globalAlpha = 1; }
      else if (id === this.hover && this.tool === 'select') { x.strokeStyle = ACC; x.globalAlpha = 0.12; x.lineWidth = 12; path(p); x.globalAlpha = 1; }
    }
    for (const [t, p, id] of all) {
      const erasing = id === this.hover && this.tool === 'erase';
      x.strokeStyle = erasing ? ERASE : t ? COLOR[t] : UNTAGGED;
      x.lineWidth = 3.2; x.setLineDash(t ? [] : [5, 5]); path(p); x.setLineDash([]);
      x.globalAlpha = 1;
      if (!t || !this.showLabels || clean.has(id) || this.view.z < 0.5) continue; // zoomed far out: labels would pile up
      if (t === 'face') continue; // sits inside the head; its colour says enough
      if (/^(arm|leg)/.test(t) && p.length > 2) { const b = P(bend(p)); x.fillStyle = COLOR[t]; x.beginPath(); x.arc(b.x, b.y, 3.5, 0, 7); x.fill(); }
      const mm = P(arcMid(p));
      x.font = '600 11px Inter, system-ui, sans-serif'; x.fillStyle = INK[t];
      x.fillText(LABEL[t].replace('Arm left', 'arm L').replace('Arm right', 'arm R').replace('Leg left', 'leg L').replace('Leg right', 'leg R').replace('Facing tick', 'facing').toLowerCase(), mm.x + 8, mm.y - 7);
    }
    this.decorate(x, P);
    if (this.drawing && this.tool === 'edit') {
      x.strokeStyle = EDIT_INK; x.lineWidth = 2.6; x.setLineDash([6, 4]); path(this.drawing.pts); x.setLineDash([]);
    } else if (this.drawing) {
      x.strokeStyle = this.drawing.tag ? COLOR[this.drawing.tag] : WET;
      x.globalAlpha = this.drawing.tag ? 1 : 0.55; x.lineWidth = 3.2; path(this.drawing.pts); x.globalAlpha = 1;
    }
  }
}

/** Space held: left-drag pans in every 2D view. */
export const panKey = { space: false };
addEventListener('keydown', e => { if (e.code === 'Space' && !(e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement || e.target instanceof HTMLSelectElement)) { if (!document.querySelector('dialog[open]')) e.preventDefault(); if (!panKey.space) { panKey.space = true; document.body.classList.add('panning'); } } });
addEventListener('keyup', e => { if (e.code === 'Space') { panKey.space = false; document.body.classList.remove('panning'); } });
addEventListener('blur', () => { panKey.space = false; document.body.classList.remove('panning'); });

export interface View2D { z: number; x: number; y: number }
export const ZOOM_MIN = 0.05, ZOOM_MAX = 8;
/** Fitting (Reset, Focus) may zoom out further still, so even very spread-out scenes fit. */
export const FIT_MIN = 0.01;
/** Zoom about a point (CSS px in the element): the point under the pointer stays put. */
export function zoomAt(v: View2D, px: number, py: number, factor: number): void {
  const z = Math.max(ZOOM_MIN, Math.min(ZOOM_MAX, v.z * factor)), k = z / v.z;
  v.x = px - (px - v.x) * k; v.y = py - (py - v.y) * k; v.z = z;
}
/** The paper's dot grid follows the zoom and pan. */
export function paperBackground(el: HTMLElement | null, v: View2D): void {
  if (!el) return;
  const g = 20 * v.z;
  el.style.backgroundSize = `${g}px ${g}px`;
  el.style.backgroundPosition = `${v.x}px ${v.y}px`;
}
/** Wheel zoom at the pointer, pan with the right or middle button or Space + left drag. */
export function attachPanZoom(el: HTMLElement, view: () => View2D, changed: () => void): void {
  el.addEventListener('wheel', e => {
    e.preventDefault();
    const r = el.getBoundingClientRect(), d = e.deltaMode === 1 ? e.deltaY * 16 : e.deltaY;
    zoomAt(view(), e.clientX - r.left, e.clientY - r.top, Math.exp(-d * (e.ctrlKey ? 0.01 : 0.0015)));
    changed();
  }, { passive: false });
  el.addEventListener('contextmenu', e => e.preventDefault());
  el.addEventListener('pointerdown', e => {
    if (!(e.button === 1 || e.button === 2 || (e.button === 0 && panKey.space))) return;
    e.preventDefault(); e.stopImmediatePropagation();
    el.setPointerCapture(e.pointerId);
    let lx = e.clientX, ly = e.clientY;
    document.body.classList.add('panning-active');
    const move = (ev: PointerEvent) => { const v = view(); v.x += ev.clientX - lx; v.y += ev.clientY - ly; lx = ev.clientX; ly = ev.clientY; changed(); };
    const up = () => { el.removeEventListener('pointermove', move); el.removeEventListener('pointerup', up); el.removeEventListener('pointercancel', up); document.body.classList.remove('panning-active'); };
    el.addEventListener('pointermove', move); el.addEventListener('pointerup', up); el.addEventListener('pointercancel', up);
  });
}
