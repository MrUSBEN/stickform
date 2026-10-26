// Posing: everything that changes the pose after the first drawing, in every view.
//  - Edit pen guides (front sketch, extra sketch views, 3D viewports) make drafts. A draft is applied to the pose at
//    once (the drawing is rewritten from the 3D pose, so it always stays joined up); Apply keeps it, Discard rolls it
//    back. Drafts end by themselves when anything else changes the pose.
//  - Pins: a pinned part ignores guides, nudges and match tools, and stays put when its parent moves.
//  - Bone selection (select tool, any view): arrow-key nudges, Copy to other side, Parallel to, Square to.
//  - Extra sketch views (front, back, sides, top): the pose drawn flat from that side, editable like the sketch.
import * as THREE from 'three';
import { Pt } from '../sketch/geom';
import { Joints, V3, BoneKey, FRAME, RIG } from '../sketch/lifter';
import { Sketch, COLOR, Tag } from '../sketch/tagger';
import { SketchCanvas, View2D, attachPanZoom, paperBackground, panKey, FIT_MIN } from '../sketch/canvas';
import { Viewport3D } from '../three/view';
import { Rig, Slot } from '../three/rig';
import { Draft, GuideView, Basis, solvePart, EDIT_COLOR } from '../sketch/edits';
import {
  Part, PARTS, PART_BONES, PART_NAME, BONE_NAME, PART_OF, PART_TAG, BONE_LEN, BONE_JOINTS, PART_ORDER, PAIR, VIEWS, ViewId,
  Dirs, dirsOf, build, setBone, setPart, rotateBone, mirroredDirs, regenerate, angles, nudge, dot, unit, len, cross,
} from '../sketch/pose3d';
import { ikDrag, twoBone, pointOn, Limb, LIMBS } from '../sketch/ik';

export interface PosingContext {
  sketch: Sketch;
  canvas: SketchCanvas;
  outVP: Viewport3D;
  orbitVP: Viewport3D;
  rig(): Rig;
  J(): Joints | null;
  update(): void;
  markDirty(): void;
  toast(msg: string, warn?: boolean): void;
  /** The other visible characters: joints in this character's figure space (spine = 1, pelvis at 0). */
  others?(): Other[];
  /** The others as drawn, for the front sketch (no rescaling, no snapping: where they were drawn). */
  othersFront?(): FrontOther[];
  /** Every visible character in world space (metres), for Scene mode sketch views. */
  world?(): WorldFig[];
  /** Make another character the active one. */
  activate?(id: number): void;
  /** 3D: the nearest character surface under a pixel (world point). `all` includes the active character. */
  hit3D?(vp: Viewport3D, p: { x: number; y: number }, all?: boolean, objs?: boolean): { point: THREE.Vector3; id: number; obj?: boolean } | null;
  /** Move a character by a world offset; `first` starts a drag (one undo step per drag). */
  moveBy?(id: number, d: V3, first: boolean): void;
  /** Attach: where a world point sits on a character's body (the bone, how far along, the offset), for a lasting
   *  contact. `skip` leaves out the reaching limb when the point is on this character. Null: not possible (a
   *  message was shown). */
  anchorAt?(id: number, point: THREE.Vector3, skip: Part | null, obj?: boolean): Omit<Contact, 'part'> | null;
  /** Every contact in the scene with where it holds and where the hand or foot is (for the markers). */
  contactMarks?(): ContactMark[];
  /** A character's name (contacts name who they hold). */
  nameOf?(id: number, obj?: boolean): string;
  /** Pose the active character's model from the current drawing and place, without drawing anything. */
  poseNow?(): void;
  /** Settings › keep feet on the ground. */
  ground?(): boolean;
  /** The active character's id. */
  activeId?(): number;
  /** The selected object (primitive or imported mesh), for its 3D gizmo: the middle of its shape (world), its place
   *  and whether it is locked. Null: no object selected. */
  obj?(): { centre: THREE.Vector3; p: V3; q: [number, number, number, number]; locked: boolean; name: string } | null;
  /** Move or turn the selected object (`first` starts a drag: one undo step per drag). */
  objSet?(p: V3, q: [number, number, number, number], first: boolean): void;
  /** 3D: the object under a pixel, when nothing nearer (a character) is in front of it; its id. */
  objAt?(vp: Viewport3D, px: { x: number; y: number }): number | null;
  /** Select an object (null: none). */
  objSelect?(id: number | null): void;
  /** Attach to… for the selected object: waiting for a click on a character (3D). */
  objPicking?(): boolean;
  /** That click: true when it was taken. */
  objPick?(vp: Viewport3D, px: { x: number; y: number }): void;
  /** Signs on objects in 3D: a padlock on locked ones, a link on held ones (world point above them). */
  objMarks?(): { top: THREE.Vector3; locked: boolean; held: 'ok' | 'paused' | null }[];
}
/** A lasting contact: the hand or foot of `part` holds a point on character `to` (-1: this character itself), on its
 *  bone `bone`, `t` along it, offset by `off` (metres: along the bone, toward its front, to its side). */
export interface Contact { part: Limb; to: number; bone: SegKey; t: number; off: [number, number, number];
  /** Held spot on an object instead (its id; `to` is -2): `off` is the spot in the object's own space. */
  obj?: number;
  /** follow (default): the hand follows while in reach; stick: never lets go, the other character is pulled along. */
  mode?: 'follow' | 'stick' }
export type SegKey = Exclude<BoneKey, 'face'>;
/** A contact as drawn: world points of the held spot (T) and the hand or foot (E); `f` are the same in the active
 *  character's figure space. ok = touching, far = out of reach (the limb stretches toward it), paused = the holder
 *  is locked or the limb pinned. */
export interface ContactMark { holder: number; part: Limb; state: 'ok' | 'far' | 'paused'; T: V3; E: V3; Tf: V3; Ef: V3; active: boolean }
export interface Other { id: number; J: Joints; color: string; name: string }
/** Another character in the front sketch, as drawn: its strokes (page units, where they show), its stick figure in
 *  its own figure space with `pg` to the page, `w` to the world, and its page offset. */
export interface FrontOther { id: number; name: string; color: string; strokes: Pt[][]; J: Joints | null; pg(X: V3): Pt; w(X: V3): THREE.Vector3 | null; off: [number, number] }
export interface WorldFig { id: number; J: Joints; color: string; active: boolean; name: string }

type P2 = { x: number; y: number };
const sub = (a: V3, b: V3): V3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
/** Tie order when several parts are about equally near: small parts at junctions first. */
const PRIORITY: Part[] = ['face', 'armL', 'armR', 'legL', 'legR', 'neck', 'spine', 'sh', 'hip'];

function dPoly(p: P2, poly: P2[]): number {
  if (poly.length === 1) return Math.hypot(p.x - poly[0].x, p.y - poly[0].y);
  let m = Infinity;
  for (let i = 1; i < poly.length; i++) {
    const a = poly[i - 1], b = poly[i], dx = b.x - a.x, dy = b.y - a.y, l2 = dx * dx + dy * dy || 1e-12;
    const t = Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / l2));
    m = Math.min(m, Math.hypot(p.x - a.x - t * dx, p.y - a.y - t * dy));
  }
  return m;
}

/** One way of looking at the figure: where its parts are on screen and how screen points turn into a guide. */
interface Adapter {
  id: GuideView;
  /** Parts and bones as polylines in this view's screen space. */
  parts(): Partial<Record<Part, P2[]>>;
  bones(): Partial<Record<BoneKey, P2[]>>;
  /** Pick reach in screen units for a click and for the start of a guide. */
  reach: number;
  /** 3D: the character's floor marker (a click on it selects the whole character). */
  rootAt?: P2;
  /** Distance to the camera per part (3D: the nearer of overlapping parts wins). */
  depth?(): Partial<Record<Part, number>>;
  /** Guide points (screen space) to solver input for a part. */
  solveInput(part: Part, pts: P2[]): { pts: Pt[]; basis: Basis; lengths: number[]; root: Pt } | null;
  /** How to store the guide for display. */
  record(part: Part, pts: P2[]): Draft['guide'];
  /** Another character under a point (select click activates it). */
  ghostAt?(p: P2): number | null;
  /** The world point a reaching hand or foot should touch, for a click at p (null: nothing there). */
  worldAt?(p: P2, part: Part): { point: THREE.Vector3; id: number; obj?: boolean } | null;
  /** IK drags: a pointer move from p0 to p as a move in the character's figure space, for a point on a bone. */
  figDelta?(p0: P2, p: P2, bone: BoneKey, t: number): V3 | null;
}

/** Which side of the model a stick limb is on (the stick's L and R are the figure's own sides). */
function charSide(J: Joints, tag: 'L' | 'R', arm: boolean): 'left' | 'right' {
  const up = unit(sub(J.N, J.P)), right = unit(cross(J.fw, up));
  const root = arm ? (tag === 'L' ? J.shL : J.shR) : (tag === 'L' ? J.hpL : J.hpR);
  return dot(sub(root, arm ? J.N : J.P), right) > 0 ? 'right' : 'left';
}
const qTurn = (q: [number, number, number, number], v: V3): V3 => new THREE.Vector3(...v).applyQuaternion(new THREE.Quaternion(...q)).toArray() as V3;
/** A character's parts and bones on its posed model (world points), `q` its turn. */
export function modelPoints(J: Joints, rig: Rig, q: [number, number, number, number]): { parts: Partial<Record<Part, THREE.Vector3[]>>; bones: Partial<Record<BoneKey, THREE.Vector3[]>> } | null {
  const B = rig.bones, W = (s: Slot) => B[s] ? B[s]!.getWorldPosition(new THREE.Vector3()) : null;
  const hips = W('hips'), neck = W('neck') || W('head'), head = W('head');
  if (!hips || !neck || !head) return null;
  const chain = [hips, ...(['spine', 'chest', 'upperChest'] as Slot[]).map(W).filter((x): x is THREE.Vector3 => !!x), neck];
  // Spine chain resampled into the stick figure's three segments.
  const L: number[] = [0]; for (let i = 1; i < chain.length; i++) L.push(L[i - 1] + chain[i].distanceTo(chain[i - 1]));
  const at = (t: number) => { const h = t * L[L.length - 1]; for (let i = 1; i < chain.length; i++) if (h <= L[i] || i === chain.length - 1) { const k = (h - L[i - 1]) / ((L[i] - L[i - 1]) || 1); return chain[i - 1].clone().lerp(chain[i], Math.min(1, k)); } return neck.clone(); };
  const sp = [0, 1 / 3, 2 / 3, 1].map(at);
  const bones: Partial<Record<BoneKey, THREE.Vector3[]>> = { spine0: [sp[0], sp[1]], spine1: [sp[1], sp[2]], spine2: [sp[2], sp[3]], neck: [neck, head] };
  const f = new THREE.Vector3(...qTurn(q, J.f)), hr = neck.distanceTo(head) * 0.75;
  bones.face = [head, head.clone().addScaledVector(f, hr * 1.4)];
  const lua = W('leftUpperArm'), rua = W('rightUpperArm'), lul = W('leftUpperLeg'), rul = W('rightUpperLeg');
  if (lua && rua) bones.sh = [lua, rua];
  if (lul && rul) bones.hip = [lul, rul];
  for (const [t, arm] of [['L', true], ['R', true], ['L', false], ['R', false]] as const) {
    const side = charSide(J, t, arm);
    const names = (arm ? ['UpperArm', 'LowerArm', 'Hand'] : ['UpperLeg', 'LowerLeg', 'Foot']).map(n => W((side + n) as Slot));
    if (names.some(x => !x)) continue;
    const key = (arm ? 'arm' : 'leg') + t;
    bones[`${key}1` as BoneKey] = [names[0]!, names[1]!]; bones[`${key}2` as BoneKey] = [names[1]!, names[2]!];
  }
  const parts: Partial<Record<Part, THREE.Vector3[]>> = {};
  for (const p of PARTS) {
    const bs = PART_BONES[p].map(b => bones[b]);
    if (bs.some(x => !x)) continue;
    parts[p] = bs.length === 1 ? bs[0]! : [bs[0]![0], ...bs.map(x => x![1])];
  }
  return { parts, bones };
}
/** The directions (figure space) that bend a limb so its hand or foot lands on a world point, using the model's own
 *  limb lengths and keeping the current bend plane (default elbows back, knees forward). */
export function limbDirsTo(J: Joints, rig: Rig, q: [number, number, number, number], part: Part, tgt: THREE.Vector3, sc: V3 = [1, 1, 1]): { dirs: [V3, V3]; reached: boolean } | null {
  const pp = modelPoints(J, rig, q)?.parts[part];
  if (!pp || pp.length < 3) return null;
  const [S, E] = pp, W = pp[2];
  const v = (x: THREE.Vector3): V3 => [x.x, x.y, x.z];
  const fwW = qTurn(q, J.fw), fb: V3 = part.startsWith('arm') ? [-fwW[0], -fwW[1], -fwW[2]] : fwW;
  const r = twoBone(v(S), S.distanceTo(E), E.distanceTo(W), v(tgt), sub(v(E), v(S)), fb);
  const qi: [number, number, number, number] = [-q[0], -q[1], -q[2], q[3]];
  const m = Math.cbrt(Math.abs(sc[0] * sc[1] * sc[2])) || 1, un = (v: V3): V3 => unit([v[0] * m / sc[0], v[1] * m / sc[1], v[2] * m / sc[2]]); // a stretched character
  return { dirs: [un(qTurn(qi, r.d1)), un(qTurn(qi, r.d2))], reached: r.reached };
}

export function createPosing(ctx: PosingContext) {
  const { sketch, canvas } = ctx;
  let drafts: (Draft & { before: string })[] = [];
  let pins = new Set<Part>();
  /** The whole character is locked: no part can change and it cannot be moved or turned (pins for everything,
   *  plus the placement). Groundwork for several characters in one scene. */
  let locked = false;
  const isPinned = (p: Part) => locked || pins.has(p);
  let target: Part | null = null;      // part picked by clicking with the edit pen
  let sel: BoneKey | null = null;      // selected bone (select tool, any view)
  let hover: { view: GuideView; part?: Part; bone?: BoneKey } | null = null;
  let match: 'parallel' | 'square' | null = null;
  let scope: 'bone' | 'part' = 'part';
  let inDraftOp = false;
  let lastNudge = 0, nudgeHist = -1;
  /** The bone the current run of nudges turns (a run is one undo step). */
  let nudgeBone: BoneKey | null = null;
  /** The part changed most recently (edit pen, nudge, gizmo): Copy to other side uses it when nothing is selected. */
  let lastPart: Part | null = null;
  /** Where the character stands and how it is turned (3D only; the sketch views show the pose itself). */
  type Quat = [number, number, number, number];
  let place: { p: V3; q: Quat; s: V3 } = { p: [0, 0, 0], q: [0, 0, 0, 1], s: [1, 1, 1] };
  /** The shape of the scale without its size: uniform scale changes nothing in figure space (lengths come from the
   *  model), a stretched character turns directions a little. */
  const aniso = (): V3 => { const sc = place.s, m = Math.cbrt(Math.abs(sc[0] * sc[1] * sc[2])) || 1; return [sc[0] / m, sc[1] / m, sc[2] / m]; };
  /** The character itself is selected (select tool): its gizmo moves and turns it. */
  let rootSel = false;
  /** The other characters drawn faintly (onion skin) in the sketch and the sketch views. */
  let ghostsOn = true;
  /** Reach to…: the limb waiting for a click on the point its hand or foot should touch. */
  let reaching: Part | null = null;
  /** Reach to… also attaches this time (Keep attached, or Shift R). */
  let reachAttach = false;
  /** Keep attached (Pose card): Reach to… leaves a lasting contact. */
  let attachOn = false;
  /** The mode new contacts get (the last one chosen). */
  let attachMode: 'follow' | 'stick' = 'follow';
  /** This character's lasting contacts (Attach): hands and feet that follow a point on a body. */
  let contacts: Contact[] = [];
  /** An IK drag is running (select tool: dragging a bone). */
  let ikOn = false;
  /** Reach to…: the point under the pointer that the hand or foot would go to (world), shown in every view. */
  let reachHover: V3 | null = null;
  /** Rotation numbers typed for a bone stay as typed while the bone still points that way. */
  const eulerCache = new Map<BoneKey, { dir: V3; e: V3 }>();
  /** End positions set for a bone stay shown as set while the bone stays where that left it (`actual`, null while
   *  the change is being made); `off` marks them when the real end could not get there. */
  const endCache = new Map<BoneKey, { target: V3; actual: V3 | null }>();
  const turnBy = (q: Quat, v: V3): V3 => new THREE.Vector3(...v).applyQuaternion(new THREE.Quaternion(...q)).toArray() as V3;
  /** World direction to the character's own space, and back. */
  const toFig = (v: V3): V3 => { const r = turnBy([-place.q[0], -place.q[1], -place.q[2], place.q[3]], v), a = aniso(); return [r[0] / a[0], r[1] / a[1], r[2] / a[2]]; };
  const toWorld = (v: V3): V3 => { const a = aniso(); return turnBy(place.q, [v[0] * a[0], v[1] * a[1], v[2] * a[2]]); };
  /** A world rotation axis in the character's own space (axes transform the other way round under a stretch). */
  const toFigAxis = (v: V3): V3 => { const r = turnBy([-place.q[0], -place.q[1], -place.q[2], place.q[3]], v), a = aniso(); return unit([r[0] * a[0], r[1] * a[1], r[2] * a[2]]); };
  const listeners: (() => void)[] = [];
  const changed = () => listeners.forEach(f => f());

  // ------------------------------------------------------------ state, undo, baking
  const sketchState = () => JSON.stringify({ s: sketch.strokes, n: sketch.nid, f: sketch.flips, a: sketch.away, d: sketch.depth });
  const restoreSketch = (j: string) => {
    const o = JSON.parse(j);
    sketch.strokes = o.s; sketch.nid = Math.max(sketch.nid, o.n); sketch.flips = o.f || {}; sketch.away = !!o.a; sketch.depth = o.d || { z: {} };
    sketch.classify();
  };
  canvas.ext = {
    save: () => ({ drafts: drafts.map(d => ({ ...d })), pins: [...pins], place: JSON.parse(JSON.stringify(place)), locked, contacts: JSON.parse(JSON.stringify(contacts)) }),
    load: v => {
      const o = (v || {}) as { drafts?: typeof drafts; pins?: Part[]; place?: typeof place; locked?: boolean; contacts?: Contact[] };
      drafts = (o.drafts || []).map(d => ({ ...d })); pins = new Set(o.pins || []); locked = !!o.locked;
      contacts = JSON.parse(JSON.stringify(o.contacts || []));
      place = o.place ? { s: [1, 1, 1], ...JSON.parse(JSON.stringify(o.place)) } : { p: [0, 0, 0], q: [0, 0, 0, 1], s: [1, 1, 1] };
      if (sel && !ctx.J()) sel = null;
    },
  };
  canvas.fitAuto = () => frameFront();
  canvas.hoverAlways = () => !!reaching;
  canvas.noStrokePick = () => !!reaching || !!match;
  canvas.blocked = () => { if (!locked) return false; lockedNotice(); return true; };
  // Anything else that changes the drawing ends the draft session: the drafts are kept as they are.
  canvas.beforeChange = () => { if (!inDraftOp && drafts.length) { drafts = []; } };

  /** Rewrite the drawing from a changed pose. `mutate` edits the bone directions of the current pose. */
  function bake(mutate: (d: Dirs) => void): boolean {
    const J0 = ctx.J(), F = J0 && FRAME.get(J0);
    if (!J0 || !F) return false;
    const d = dirsOf(J0);
    mutate(d);
    const Jn = build(d);
    const { strokes, depth } = regenerate(Jn, F);
    const keep = sketch.strokes.filter(s => !s.tag); // ignored strokes stay as they are
    sketch.strokes = [...keep, ...strokes.map(s => ({ id: sketch.nid++, pts: s.pts, tag: s.tag, lock: true, ordered: true }))];
    sketch.depth = depth; sketch.flips = {};
    sketch.lastSpine = null;
    sketch.classify();
    canvas.selected = null;
    return true;
  }
  /** Is the drawing already regenerated (clean and joined)? */
  const regenerated = () => sketch.strokes.some(s => s.ordered);

  function addDraft(part: Part, dirs: V3[], guide: Draft['guide']): void {
    if (!ctx.J()) return;
    inDraftOp = true;
    canvas.snapshot();
    detachEdited([part]);
    const i = drafts.findIndex(d => d.part === part);
    if (i >= 0) { // redraw: go back to before that draft, replay the later ones, then add the new one
      const later = drafts.slice(i + 1);
      restoreSketch(drafts[i].before);
      drafts = drafts.slice(0, i);
      for (const d of later) { d.before = sketchState(); bake(x => setPart(x, d.part, d.dirs, pins)); drafts.push(d); }
    }
    const before = sketchState();
    bake(x => setPart(x, part, dirs, pins));
    drafts.push({ part, dirs, guide, before });
    lastPart = part;
    inDraftOp = false;
    ctx.markDirty(); ctx.update();
  }
  function discard(part: Part): void {
    const i = drafts.findIndex(d => d.part === part);
    if (i < 0) return;
    inDraftOp = true;
    canvas.snapshot();
    const later = drafts.slice(i + 1);
    restoreSketch(drafts[i].before);
    drafts = drafts.slice(0, i);
    for (const d of later) { d.before = sketchState(); bake(x => setPart(x, d.part, d.dirs, pins)); drafts.push(d); }
    inDraftOp = false;
    ctx.markDirty(); ctx.update();
  }
  function apply(part?: Part): void {
    if (!drafts.length) return;
    inDraftOp = true; canvas.snapshot(); inDraftOp = false;
    drafts = part ? drafts.filter(d => d.part !== part) : [];
    ctx.update();
  }
  /** A pose change that is not a draft (nudge, match tools, pin): ends drafts, bakes at once, one undo step. */
  function change(mutate: (d: Dirs) => void, coalesce = false, edits: Part[] = []): void {
    if (!ctx.J()) return;
    // a run of nudges on one bone is one undo step: nothing else changed since the last one, at most 10 s apart
    // (timed from the end of the last one: redrawing can be slow)
    const now = performance.now();
    if (!coalesce || now - lastNudge > 10000 || nudgeBone !== sel || canvas.exportHistory().u.length !== nudgeHist) canvas.snapshot(); // also ends drafts
    detachEdited(edits);
    nudgeBone = coalesce ? sel : null;
    bake(mutate);
    ctx.markDirty(); ctx.update();
    lastNudge = coalesce ? performance.now() : 0; nudgeHist = canvas.exportHistory().u.length;
  }

  // ------------------------------------------------------------ contacts (Attach)
  const HAND: Record<Limb, string> = { armL: 'Left hand', armR: 'Right hand', legL: 'Left foot', legR: 'Right foot' };
  const whoOf = (c: Contact) => c.obj != null ? ctx.nameOf?.(c.obj, true) || 'an object' : c.to === -1 ? 'itself' : ctx.nameOf?.(c.to) || 'another character';
  /** Editing a limb by hand frees it: its contact goes (call after the undo snapshot). */
  function detachEdited(parts: Part[]): void {
    const gone = contacts.filter(c => parts.includes(c.part));
    if (!gone.length) return;
    contacts = contacts.filter(c => !parts.includes(c.part));
    ctx.toast(gone.length === 1 ? `${HAND[gone[0].part]} detached from ${whoOf(gone[0])} (you edited it).` : `${gone.length} contacts detached (you edited those limbs).`);
  }
  /** Detach one hand or foot (Pose card): one undo step. */
  function detach(part: Part): void {
    const c = contacts.find(x => x.part === part); if (!c) return;
    canvas.snapshot();
    contacts = contacts.filter(x => x !== c);
    ctx.markDirty(); ctx.update();
    ctx.toast(`${HAND[c.part]} detached from ${whoOf(c)}. It stays where it is.`);
  }
  /** Change where a contact holds (Pose card numbers): one undo step. */
  function setContact(part: Part, v: { t?: number; off?: [number, number, number]; mode?: 'follow' | 'stick' }): void {
    const c = contacts.find(x => x.part === part); if (!c) return;
    const t = v.t === undefined ? c.t : Math.max(0, Math.min(1, v.t)), off = v.off || c.off, mode = v.mode || c.mode || 'follow';
    if (Math.abs(t - c.t) < 1e-9 && off.every((x, i) => Math.abs(x - c.off[i]) < 1e-9) && mode === (c.mode || 'follow')) return;
    canvas.snapshot();
    contacts = contacts.map(x => x === c ? { ...c, t, off: off.map(n => +n.toFixed(4)) as [number, number, number], ...(mode === 'stick' ? { mode } : { mode: undefined }) } : x);
    contacts = JSON.parse(JSON.stringify(contacts));
    ctx.markDirty(); ctx.update();
  }

  // ------------------------------------------------------------ pins
  function togglePin(part: Part): void {
    if (!ctx.J()) return;
    if (locked) { lockedNotice(); return; }
    canvas.snapshot();
    if (pins.has(part)) pins.delete(part);
    else { pins.add(part); if (!regenerated()) bake(() => {}); } // pinning freezes the drawing into clean strokes
    ctx.markDirty(); ctx.update();
  }
  const lockedNotice = () => ctx.toast('The character is locked. Unlock it (Pose card, or Shift K) to change it.', true);
  const pinnedNotice = (p: Part) => locked ? lockedNotice() : ctx.toast(`${PART_NAME[p]} is pinned. Unpin it to change it.`, true);
  /** Lock or unlock the whole character (one undo step). */
  function toggleLock(on = !locked): void {
    if (on === locked) return;
    canvas.snapshot(); // also ends drafts
    locked = on;
    if (on) { target = null; match = null; }
    ctx.markDirty(); ctx.update();
    ctx.toast(on ? 'Character locked: its pose and place are fixed.' : 'Character unlocked.');
  }

  // ------------------------------------------------------------ picking
  /** Parts a point could mean, best first. `guide` (the start of a guide) breaks ties between overlapping parts:
   *  the part whose current direction matches the way the guide sets off wins (spine up, legs down at the pelvis). */
  function rankParts(a: Adapter, p: P2, reach: number, guide?: P2[]): Part[] {
    const polys = a.parts(), dep = a.depth?.() || {};
    const c = PARTS.filter(k => polys[k]?.length).map(k => ({ k, d: dPoly(p, polys[k]!) })).filter(o => o.d < reach).sort((x, y) => x.d - y.d);
    if (!c.length) return [];
    const tieCut = c[0].d * 1.3 + reach * 0.12;
    let gd: P2 | null = null;
    if (guide && guide.length > 2) {
      let L = 0, i = 1; const tot = guide.reduce((s2, q, j) => j ? s2 + Math.hypot(q.x - guide[j - 1].x, q.y - guide[j - 1].y) : 0, 0);
      for (; i < guide.length; i++) { L += Math.hypot(guide[i].x - guide[i - 1].x, guide[i].y - guide[i - 1].y); if (L > tot * 0.3) break; }
      const e = guide[Math.min(i, guide.length - 1)], l = Math.hypot(e.x - guide[0].x, e.y - guide[0].y);
      if (l > 1e-9) gd = { x: (e.x - guide[0].x) / l, y: (e.y - guide[0].y) / l };
    }
    const align = (k: Part) => {
      if (!gd) return 0;
      const poly = polys[k]!; if (poly.length < 2) return 0;
      // Direction of the part away from the end the guide starts at.
      const s0 = Math.hypot(poly[0].x - p.x, poly[0].y - p.y) <= Math.hypot(poly[poly.length - 1].x - p.x, poly[poly.length - 1].y - p.y);
      const a0 = s0 ? poly[0] : poly[poly.length - 1], a1 = s0 ? poly[1] : poly[poly.length - 2];
      const l = Math.hypot(a1.x - a0.x, a1.y - a0.y); if (l < 1e-9) return 0;
      return ((a1.x - a0.x) * gd.x + (a1.y - a0.y) * gd.y) / l;
    };
    const near = (x: Part, y: Part) => dep[x] !== undefined && dep[y] !== undefined && Math.abs(dep[x]! - dep[y]!) > 0.05 ? dep[x]! - dep[y]! : 0;
    const pelvis = (x: Part, y: Part) => (x === 'spine' && y.startsWith('leg')) || (y === 'spine' && x.startsWith('leg'));
    const al = (x: Part, y: Part) => { if (!pelvis(x, y)) return 0; const d = align(y) - align(x); return Math.abs(d) > 0.6 ? d : 0; };
    const tie = c.filter(o => o.d <= tieCut), rest = c.filter(o => o.d > tieCut);
    tie.sort((x, y) => (pins.has(x.k) ? 1 : 0) - (pins.has(y.k) ? 1 : 0) || near(x.k, y.k) || al(x.k, y.k)
      || PRIORITY.indexOf(x.k) - PRIORITY.indexOf(y.k) || x.d - y.d);
    return [...tie, ...rest].map(o => o.k);
  }
  function pickPart(a: Adapter, p: P2, reach: number, guide?: P2[]): Part | null { return rankParts(a, p, reach, guide)[0] ?? null; }
  function pickBone(a: Adapter, p: P2, reach: number): BoneKey | null {
    const polys = a.bones();
    let best: BoneKey | null = null, bd = reach;
    for (const [k, poly] of Object.entries(polys) as [BoneKey, P2[]][]) { const d = dPoly(p, poly); if (d < bd) { bd = d; best = k; } }
    return best;
  }

  // ------------------------------------------------------------ the three kinds of view
  const jointsOf = (J: Joints) => J;
  /** Bone and part polylines from figure-space joints, mapped to a screen. */
  function figurePolys(J: Joints, map: (X: V3) => P2) {
    const bones: Partial<Record<BoneKey, P2[]>> = {};
    for (const [k, [a, b]] of Object.entries(BONE_JOINTS) as [BoneKey, [keyof Joints, keyof Joints]][]) bones[k] = [map(J[a] as V3), map(J[b] as V3)];
    bones.sh = [map(J.shL), map(J.shR)]; bones.hip = [map(J.hpL), map(J.hpR)];
    bones.face = [map(J.H), map([J.H[0] + J.f[0] * RIG.hr * 1.4, J.H[1] + J.f[1] * RIG.hr * 1.4, J.H[2] + J.f[2] * RIG.hr * 1.4])];
    const parts: Partial<Record<Part, P2[]>> = {};
    for (const p of PARTS) {
      const bs = PART_BONES[p].map(b => bones[b]!);
      parts[p] = bs.length === 1 ? bs[0] : [bs[0][0], ...bs.map(x => x[1])];
    }
    // The neck stops at the head's rim so a guide started inside the head goes to the facing.
    const n = parts.neck!, h = parts.face![0];
    const nl = Math.hypot(h.x - n[0].x, h.y - n[0].y), cut = Math.max(0, 1 - (RIG.hr / RIG.nk) * 0.8);
    if (nl > 0) parts.neck = [n[0], { x: n[0].x + (h.x - n[0].x) * cut, y: n[0].y + (h.y - n[0].y) * cut }];
    return { bones, parts };
  }

  /** Front sketch: page coordinates. View coordinates are figure x, y. */
  function frontAdapter(): Adapter | null {
    const J = ctx.J(), F = J && FRAME.get(J);
    if (!J || !F) return null;
    const toPage = (X: V3): P2 => ({ x: F.o.x + X[0] / F.s, y: F.o.y - X[1] / F.s });
    const fig = (p: P2): Pt => ({ x: (p.x - F.o.x) * F.s, y: -(p.y - F.o.y) * F.s });
    const polys = figurePolys(jointsOf(J), toPage);
    return {
      id: 'front', reach: 0.06,
      parts: () => polys.parts, bones: () => polys.bones,
      solveInput: (part, pts) => ({ pts: pts.map(fig), basis: VIEWS.front, lengths: lengthsStick(part), root: rootStick(J, part, VIEWS.front) }),
      record: (_p, pts) => ({ view: 'front', pts: pts.map(fig).map(q => [+q.x.toFixed(4), +q.y.toFixed(4)] as [number, number]) }),
      ghostAt: p => frontGhostAt(p, 0.04),
      worldAt: (p, part) => frontReach(J, toPage, p, part, 0.06),
      figDelta: (p0, p) => [(p.x - p0.x) * F.s, -(p.y - p0.y) * F.s, 0],
    };
  }
  const lengthsStick = (part: Part) => PART_BONES[part].map(b => b === 'sh' || b === 'hip' ? 2 * BONE_LEN[b] : BONE_LEN[b]);
  function rootStick(J: Joints, part: Part, b: Basis): Pt {
    const r: V3 = part === 'spine' || part === 'hip' ? J.P : part === 'neck' || part === 'sh' ? J.N : part === 'face' ? J.H
      : part === 'armL' ? J.shL : part === 'armR' ? J.shR : part === 'legL' ? J.hpL : J.hpR;
    return { x: dot(r, b.right), y: dot(r, b.up) };
  }

  /** Extra sketch views: an orthographic view of the figure, `map` from figure space to the tile's pixels. */
  function tileAdapter(view: ViewId, size: { w: number; h: number }, v?: View2D): Adapter | null {
    const J = ctx.J();
    if (!J) return null;
    const m = tileMap(view, size, v), b = VIEWS[view];
    const polys = figurePolys(J, m.toPx);
    return {
      id: view, reach: 26,
      parts: () => polys.parts, bones: () => polys.bones,
      solveInput: (part, pts) => ({ pts: pts.map(m.toView), basis: b, lengths: lengthsStick(part), root: rootStick(J, part, b) }),
      record: (_p, pts) => ({ view, pts: pts.map(m.toView).map(q => [+q.x.toFixed(4), +q.y.toFixed(4)] as [number, number]) }),
      ghostAt: p => ghostNear(m.toPx, p, 18),
      worldAt: (p, part) => reachPoint(J, m.toPx, p, part, 26),
      figDelta: (p0, p) => { const dx = (p.x - p0.x) / m.k, dy = -(p.y - p0.y) / m.k; return [b.right[0] * dx + b.up[0] * dy, b.right[1] * dx + b.up[1] * dy, b.right[2] * dx + b.up[2] * dy]; },
    };
  }
  // ------------------------------------------------------------ other characters (onion skin), reaching
  /** Bone segments of a figure as 3D pairs (figure units), for picking points on it. */
  function segs(J: Joints, skip?: Part): [V3, V3][] {
    const out: [V3, V3][] = [[J.P, J.S1], [J.S1, J.S2], [J.S2, J.N], [J.N, J.H], [J.shL, J.shR], [J.hpL, J.hpR]];
    const limbs: [Part, V3, V3, V3][] = [['armL', J.shL, J.aL1, J.aL2], ['armR', J.shR, J.aR1, J.aR2], ['legL', J.hpL, J.lL1, J.lL2], ['legR', J.hpR, J.lR1, J.lR2]];
    for (const [p, a, b, c] of limbs) if (p !== skip) out.push([a, b], [b, c]);
    return out;
  }
  /** Nearest point on a set of 3D segments to a screen point: [3D point, pixel distance]. */
  function nearestOn(list: [V3, V3][], map: (X: V3) => P2, p: P2): [V3, number] | null {
    let best: [V3, number] | null = null;
    for (const [A, B] of list) {
      const a = map(A), b = map(B), dx = b.x - a.x, dy = b.y - a.y, l2 = dx * dx + dy * dy || 1e-12;
      const t = Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / l2));
      const d = Math.hypot(p.x - a.x - t * dx, p.y - a.y - t * dy);
      if (!best || d < best[1]) best = [[A[0] + (B[0] - A[0]) * t, A[1] + (B[1] - A[1]) * t, A[2] + (B[2] - A[2]) * t], d];
    }
    return best;
  }
  function ghostNear(map: (X: V3) => P2, p: P2, reach: number): number | null {
    if (!ghostsOn) return null;
    let best: { id: number; d: number } | null = null;
    for (const o of ctx.others?.() || []) {
      const n = nearestOn(segs(o.J), map, p);
      const hd = Math.hypot(map(o.J.H).x - p.x, map(o.J.H).y - p.y);
      const d = Math.min(n ? n[1] : Infinity, hd);
      if (d < reach && (!best || d < best.d)) best = { id: o.id, d };
    }
    return best?.id ?? null;
  }
  /** Front sketch: the other character drawn under a page point (its strokes or its stick figure). */
  function frontGhostAt(p: P2, reach: number): number | null {
    if (!ghostsOn) return null;
    let best: { id: number; d: number } | null = null;
    for (const o of ctx.othersFront?.() || []) {
      let d = Infinity;
      for (const st of o.strokes) d = Math.min(d, dPoly(p, st));
      if (o.J) { const n = nearestOn(segs(o.J), o.pg, p); if (n) d = Math.min(d, n[1]); }
      if (d < reach && (!best || d < best.d)) best = { id: o.id, d };
    }
    return best?.id ?? null;
  }
  /** Front sketch, Reach to…: the nearest point on another character as drawn (or on this one), as a world point. */
  function frontReach(J: Joints, toPage: (X: V3) => P2, p: P2, part: Part, reach: number): { point: THREE.Vector3; id: number } | null {
    let best: { X: V3; d: number; o: FrontOther | null } | null = null;
    for (const o of ctx.othersFront?.() || []) {
      if (!o.J) continue;
      const n = nearestOn(segs(o.J), o.pg, p); if (n && (!best || n[1] < best.d)) best = { X: n[0], d: n[1], o };
    }
    const own = nearestOn(segs(J, part), toPage, p); if (own && (!best || own[1] < best.d)) best = { X: own[0], d: own[1], o: null };
    if (!best || best.d >= reach) return null;
    const w = best.o ? best.o.w(best.X) : figToWorld(best.X);
    return w ? { point: w, id: best.o ? best.o.id : ctx.activeId?.() ?? -1 } : null;
  }
  /** Front sketch: the others as drawn, faint, in their colours, with their names. */
  function drawFrontGhosts(x: CanvasRenderingContext2D, P: (q: Pt) => P2): void {
    if (!ghostsOn) return;
    for (const o of ctx.othersFront?.() || []) {
      x.save(); x.globalAlpha = 0.38; x.strokeStyle = o.color; x.fillStyle = o.color; x.lineWidth = 3; x.lineCap = 'round'; x.lineJoin = 'round';
      for (const st of o.strokes) { x.beginPath(); st.forEach((q, i) => { const c = P(q); if (i) x.lineTo(c.x, c.y); else x.moveTo(c.x, c.y); }); x.stroke(); }
      const pts = o.strokes.flat(); if (pts.length) {
        const top = o.J ? o.pg([o.J.H[0], o.J.H[1] + RIG.hr, o.J.H[2]]) : pts.reduce((m, q) => (q.y < m.y ? q : m), pts[0]);
        const c = P(top);
        x.globalAlpha = 0.6; x.font = '600 11px Inter, system-ui, sans-serif'; x.textAlign = 'center'; x.fillText(o.name, c.x, c.y - 8);
      }
      x.restore();
    }
  }
  /** This character's figure space to world (the same mapping as the stick overlay in 3D). */
  function figToWorld(X: V3): THREE.Vector3 | null {
    const B = ctx.rig().bones, hb = B.hips, nb = B.neck || B.head;
    if (!hb || !nb) return null;
    const hips = hb.getWorldPosition(new THREE.Vector3()), k = hips.distanceTo(nb.getWorldPosition(new THREE.Vector3()));
    const w = toWorld(X);
    return new THREE.Vector3(w[0] * k, w[1] * k, w[2] * k).add(hips);
  }
  /** World point to this character's figure space (the inverse of figToWorld). */
  function worldToFig(W: V3): V3 | null {
    const B = ctx.rig().bones, hb = B.hips, nb = B.neck || B.head;
    if (!hb || !nb) return null;
    const hips = hb.getWorldPosition(new THREE.Vector3()), k = hips.distanceTo(nb.getWorldPosition(new THREE.Vector3())) || 1;
    const d = new THREE.Vector3(...W).sub(hips).divideScalar(k);
    return toFig([d.x, d.y, d.z]);
  }
  /** A click in a flat view while reaching: the nearest point on another character (or on this one, not on the
   *  reaching limb itself), as a world point. */
  function reachPoint(J: Joints, map: (X: V3) => P2, p: P2, part: Part, reach: number): { point: THREE.Vector3; id: number } | null {
    let best: [V3, number] | null = null, id = ctx.activeId?.() ?? -1;
    for (const o of ctx.others?.() || []) { const n = nearestOn(segs(o.J), map, p); if (n && (!best || n[1] < best[1])) { best = n; id = o.id; } }
    const own = nearestOn(segs(J, part), map, p); if (own && (!best || own[1] < best[1])) { best = own; id = ctx.activeId?.() ?? -1; }
    const w = best && best[1] < reach ? figToWorld(best[0]) : null;
    return w ? { point: w, id } : null;
  }
  /** Box around figures (joints plus the head) under a map. */
  function boxOf(figs: Joints[], map: (X: V3) => P2, headR: (J: Joints) => number): { x0: number; y0: number; x1: number; y1: number } | null {
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const G of figs) {
      for (const [k, v] of Object.entries(G)) { if (!Array.isArray(v) || k === 'f' || k === 'fw') continue; const q = map(v as V3); x0 = Math.min(x0, q.x); x1 = Math.max(x1, q.x); y0 = Math.min(y0, q.y); y1 = Math.max(y1, q.y); }
      const c = map(G.H), r = headR(G); x0 = Math.min(x0, c.x - r); x1 = Math.max(x1, c.x + r); y0 = Math.min(y0, c.y - r); y1 = Math.max(y1, c.y + r);
    }
    return isFinite(x0) ? { x0, y0, x1, y1 } : null;
  }
  /** The figures a 2D view should frame: everyone shown (undefined: Reset), the active one (null), or one character. */
  function framed(id: number | null | undefined): Joints[] {
    const J = ctx.J(); if (!J) return [];
    const os = ctx.others?.() || [];
    if (id === undefined) return [J, ...(ghostsOn ? os.map(o => o.J) : [])];
    const o = id === null ? null : os.find(x => x.id === id);
    return o ? [o.J] : [J];
  }
  /** Front sketch: Reset frames everyone (keeps the usual view when they all fit); Focus frames one character. The
   *  framing is redone when the paper changes size, until the user pans or zooms. */
  function frameFront(id?: number | null): void {
    canvas.fitAuto = () => frameFront(id);
    const J = ctx.J(), F = J && FRAME.get(J);
    const fos = ghostsOn ? ctx.othersFront?.() || [] : [];
    const ghostPts = id === undefined ? fos.flatMap(o => o.strokes.flat()) : id === null ? [] : (fos.find(o => o.id === id)?.strokes.flat() || []);
    if (id !== undefined && id !== null && ghostPts.length) { // focus another character: its drawing
      const xs = ghostPts.map(q => q.x), ys = ghostPts.map(q => q.y), m = 0.02;
      canvas.fitBox({ x0: Math.min(...xs) - m, y0: Math.min(...ys) - m, x1: Math.max(...xs) + m, y1: Math.max(...ys) + m }, 3, false, framePad()); return;
    }
    if (!J || !F) {
      const pts = [...sketch.strokes.flatMap(st => st.pts), ...ghostPts];
      if (!pts.length) { canvas.view = { z: 1, x: 0, y: 0 }; canvas.draw(); return; }
      const xs = pts.map(q => q.x), ys = pts.map(q => q.y);
      canvas.fitBox({ x0: Math.min(...xs), y0: Math.min(...ys), x1: Math.max(...xs), y1: Math.max(...ys) }, 1, true, framePad()); return;
    }
    const toPage = (X: V3): P2 => ({ x: F.o.x + X[0] / F.s, y: F.o.y - X[1] / F.s });
    let b = boxOf([J], toPage, () => RIG.hr / F.s);
    if (!b) return;
    for (const q of ghostPts) b = { x0: Math.min(b.x0, q.x), y0: Math.min(b.y0, q.y), x1: Math.max(b.x1, q.x), y1: Math.max(b.y1, q.y) };
    // the active character as drawn (rough strokes can reach past its joints)
    if (id === undefined || id === null) for (const st of sketch.strokes) for (const q of st.pts) b = { x0: Math.min(b.x0, q.x), y0: Math.min(b.y0, q.y), x1: Math.max(b.x1, q.x), y1: Math.max(b.y1, q.y) };
    const m = 0.02;
    canvas.fitBox({ x0: b.x0 - m, y0: b.y0 - m, x1: b.x1 + m, y1: b.y1 + m }, id === undefined ? 1 : 3, id === undefined, framePad());
  }
  /** Room around a framed figure in the sketch: labels to the right, names above, the status and Snap pills below. */
  function framePad(): { l: number; r: number; t: number; b: number } {
    const cv = document.getElementById('sk'), r = cv?.getBoundingClientRect();
    let bottom = 24;
    if (r) for (const e of document.querySelectorAll<HTMLElement>('#status, .snapbox')) {
      const q = e.getBoundingClientRect(); if (q.height && q.top > r.top + r.height / 2) bottom = Math.max(bottom, r.bottom - q.top + 10);
    }
    return { l: 28, r: canvas.showLabels ? 72 : 28, t: 30, b: bottom };
  }
  function drawGhosts(x: CanvasRenderingContext2D, map: (X: V3) => P2, k: number): void {
    if (!ghostsOn) return;
    for (const o of ctx.others?.() || []) {
      const G = o.J, line = (pts: P2[]) => { x.beginPath(); pts.forEach((q, i) => i ? x.lineTo(q.x, q.y) : x.moveTo(q.x, q.y)); x.stroke(); };
      x.save(); x.globalAlpha = 0.38; x.strokeStyle = o.color; x.fillStyle = o.color; x.lineWidth = 3; x.lineCap = 'round'; x.lineJoin = 'round';
      for (const [a, b] of segs(G)) line([map(a), map(b)]);
      const c = map(G.H), r = RIG.hr * k;
      x.beginPath(); x.arc(c.x, c.y, Math.max(3, r), 0, Math.PI * 2); x.stroke();
      const fp = map([G.H[0] + G.f[0] * RIG.hr, G.H[1] + G.f[1] * RIG.hr, G.H[2] + G.f[2] * RIG.hr]); line([c, fp]);
      x.globalAlpha = 0.6; x.font = '600 11px Inter, system-ui, sans-serif'; x.textAlign = 'center';
      x.fillText(o.name, c.x, c.y - Math.max(3, r) - 6);
      x.restore();
    }
  }
  function tileMap(view: ViewId, size: { w: number; h: number }, v: View2D = { z: 1, x: 0, y: 0 }) {
    const b = VIEWS[view], k = Math.min(size.w, size.h) / 4.6 * v.z;
    const cx = size.w / 2 * v.z + v.x, cy = (view === 'top' ? size.h / 2 : size.h * 0.47) * v.z + v.y;
    return {
      k,
      toPx: (X: V3): P2 => ({ x: cx + dot(X, b.right) * k, y: cy - dot(X, b.up) * k }),
      toView: (p: P2): Pt => ({ x: (p.x - cx) / k, y: -(p.y - cy) / k }),
      fromView: (q: Pt): P2 => ({ x: cx + q.x * k, y: cy - q.y * k }),
    };
  }

  /** 3D viewports: screen pixels; guides go onto the plane through the part's root that faces the camera. */
  const charPoints = (J: Joints) => modelPoints(J, ctx.rig(), place.q);
  function viewportAdapter(vp: Viewport3D): Adapter | null {
    const J = ctx.J(); if (!J) return null;
    const cp = charPoints(J); if (!cp) return null;
    const proj = (a: THREE.Vector3[]) => a.map(q => vp.project(q));
    const parts: Partial<Record<Part, P2[]>> = {}, bones: Partial<Record<BoneKey, P2[]>> = {};
    for (const [k, v] of Object.entries(cp.parts)) parts[k as Part] = proj(v!);
    for (const [k, v] of Object.entries(cp.bones)) bones[k as BoneKey] = proj(v!);
    const rootW = (part: Part): THREE.Vector3 => {
      const pp = cp.parts[part]!;
      return part === 'sh' || part === 'hip' ? pp[0].clone().lerp(pp[1], 0.5) : pp[0].clone();
    };
    const hipsW = ctx.rig().bones.hips?.getWorldPosition(new THREE.Vector3());
    return {
      id: '3d', reach: 30, rootAt: hipsW ? vp.project(new THREE.Vector3(hipsW.x, 0, hipsW.z)) : undefined,
      parts: () => parts, bones: () => bones,
      depth: () => Object.fromEntries(Object.entries(cp.parts).map(([k, v]) => [k, v![Math.min(1, v!.length - 1)].distanceTo(vp.camera.position)])),
      solveInput: (part, pts) => {
        const root = rootW(part), cam = vp.camera.position;
        const toward = cam.clone().sub(root).normalize();
        const camUp = new THREE.Vector3(0, 1, 0).applyQuaternion(vp.camera.quaternion);
        const right = new THREE.Vector3().crossVectors(camUp, toward).normalize(), up = new THREE.Vector3().crossVectors(toward, right);
        const world = pts.map(q => vp.toPlane(q.x, q.y, root)).filter((q): q is THREE.Vector3 => !!q);
        if (world.length < 2) return null;
        const pp = cp.parts[part]!, bl = PART_BONES[part].map((_, i) => pp[i].distanceTo(pp[i + 1] || pp[i]));
        const lengths = part === 'spine' ? [0, 1, 2].map(() => (bl[0] + bl[1] + bl[2]) / 3)
          : part === 'face' ? [pp[0].distanceTo(pp[1]) / 1.4] : bl;
        return {
          pts: world.map(w => ({ x: w.clone().sub(root).dot(right), y: w.clone().sub(root).dot(up) })),
          basis: { right: toFig(right.toArray() as V3), up: toFig(up.toArray() as V3), toward: toFig(toward.toArray() as V3) },
          lengths, root: { x: 0, y: 0 },
        };
      },
      record: (part, pts) => {
        const root = rootW(part);
        return { view: '3d', pts: pts.map(q => vp.toPlane(q.x, q.y, root)).filter((q): q is THREE.Vector3 => !!q).map(w => w.sub(root).toArray().map((x: number) => +x.toFixed(4)) as V3) };
      },
      ghostAt: p => ctx.hit3D?.(vp, p)?.id ?? null,
      worldAt: p => ctx.hit3D?.(vp, p, true, true) ?? null,
      figDelta: (p0, p, bone, t) => {
        const pb = cp.bones[bone]; if (!pb) return null;
        const W0 = pb[0].clone().lerp(pb[1], t), a0 = vp.toPlane(p0.x, p0.y, W0), a1 = vp.toPlane(p.x, p.y, W0);
        if (!a0 || !a1) return null;
        const hb = ctx.rig().bones.hips, nb = ctx.rig().bones.neck || ctx.rig().bones.head; if (!hb || !nb) return null;
        const k = hb.getWorldPosition(new THREE.Vector3()).distanceTo(nb.getWorldPosition(new THREE.Vector3())) || 1;
        const dw = a1.sub(a0).divideScalar(k);
        return toFig([dw.x, dw.y, dw.z]);
      },
    };
  }

  // ------------------------------------------------------------ a guide or a click in any view
  let shift = false;
  addEventListener('keydown', e => { if (e.key === 'Shift') shift = true; });
  addEventListener('keyup', e => { if (e.key === 'Shift') shift = false; });
  addEventListener('blur', () => { shift = false; });

  /** Finished guide (or click) with the edit pen. */
  function onGuide(a: Adapter | null, pts: P2[], click: boolean): void {
    const J = ctx.J();
    if (!a || !J) { ctx.toast('Draw the figure first, then reshape it with the edit pen.', true); return; }
    if (reaching) { finishReach(a, pts[pts.length - 1]); return; }
    if (match) { finishMatch(a, pts[0]); return; }
    if (click) {
      target = pickPart(a, pts[0], a.reach);
      if (target) ctx.toast(`Editing ${PART_NAME[target]}: draw its new shape.`);
      changed(); ctx.update(); return;
    }
    const all = target ? [target] : rankParts(a, pts[0], a.reach * 2.5, pts);
    // Pinned parts sort last among equally near ones, so a pinned part first means the guide was clearly on it.
    if (all[0] && isPinned(all[0])) { pinnedNotice(all[0]); return; }
    const ranked = all.filter(k => !isPinned(k)).slice(0, 4), part = ranked[0];
    if (!part) { ctx.toast('Start the guide on a part (or click a part first to pick it).', true); return; }
    alt = ranked.length > 1 ? { a, pts, ranked, i: 0, snap: shift } : null;
    draftFrom(a, part, pts, shift);
  }
  /** The last guide and the other parts it could have meant (Tab cycles through them). */
  let alt: { a: Adapter; pts: P2[]; ranked: Part[]; i: number; snap: boolean } | null = null;
  function draftFrom(a: Adapter, part: Part, pts: P2[], snap: boolean): void {
    const J = ctx.J(); if (!J) return;
    const inp = a.solveInput(part, pts);
    if (!inp) return;
    const d = dirsOf(J);
    const dirs = solvePart({ part, ...inp, cur: PART_BONES[part].map(b => d[b]), fw: d.fw, snap });
    addDraft(part, dirs, a.record(part, pts));
  }
  /** Tab: the last guide was meant for another part. */
  function retarget(): boolean {
    if (!alt || !drafts.length || drafts[drafts.length - 1].part !== alt.ranked[alt.i]) return false;
    const cur = alt.ranked[alt.i], next = (alt.i + 1) % alt.ranked.length;
    const keep = alt;
    discard(cur);
    alt = keep; alt.i = next;
    draftFrom(alt.a, alt.ranked[next], alt.pts, alt.snap);
    ctx.toast(`Guide moved to ${PART_NAME[alt.ranked[next]]}.`);
    return true;
  }
  const altNext = () => alt && drafts.length && drafts[drafts.length - 1].part === alt.ranked[alt.i] ? alt.ranked[(alt.i + 1) % alt.ranked.length] : null;
  /** Click with the select tool (or while waiting for a match target). */
  function onSelectClick(a: Adapter | null, p: P2): boolean {
    if (!a) return false;
    if (reaching) { finishReach(a, p); return true; }
    if (match) { finishMatch(a, p); return true; }
    if (a.rootAt && Math.hypot(p.x - a.rootAt.x, p.y - a.rootAt.y) < 13) { rootSel = true; sel = null; changed(); ctx.update(); return true; }
    sel = pickBone(a, p, a.reach); if (sel) rootSel = false;
    if (!sel) {
      rootSel = false;
      const g = canvas.tool === 'select' ? a.ghostAt?.(p) : null;
      if (g != null && ctx.activate) { changed(); ctx.activate(g); return true; }
    }
    changed(); ctx.update();
    return sel !== null;
  }
  function onHover(a: Adapter | null, p: P2 | null): void {
    if (reaching) { // where the hand or foot would land
      const w = a && p ? a.worldAt?.(p, reaching)?.point ?? null : null;
      const nw: V3 | null = w ? [w.x, w.y, w.z] : null;
      if (JSON.stringify(nw) !== JSON.stringify(reachHover)) { reachHover = nw; changed(); }
      return;
    }
    let h: typeof hover = null;
    if (a && p) {
      if (match || canvas.tool === 'select') { const b = pickBone(a, p, a.reach); if (b) h = { view: a.id, bone: b }; }
      else { const part = target ?? pickPart(a, p, a.reach * 2.5); if (part) h = { view: a.id, part }; }
    }
    if (JSON.stringify(h) !== JSON.stringify(hover)) { hover = h; changed(); }
  }

  // ------------------------------------------------------------ precision tools
  const selPart = (): Part | null => sel ? PART_OF[sel] : target ?? (lastPart && ctx.J() ? lastPart : null);
  function nudgeSel(dh: number, de: number): boolean {
    if (!sel || !ctx.J()) return false;
    const part = PART_OF[sel];
    if (isPinned(part)) { pinnedNotice(part); return true; }
    lastPart = part;
    change(d => setBone(d, sel!, nudge(d[sel!], dh, de), pins), true, [part]);
    return true;
  }
  function copyToOther(): void {
    const part = selPart();
    const pair = part && PAIR[part];
    if (!part || !pair) { ctx.toast('Select an arm or a leg first.', true); return; }
    if (isPinned(pair)) { pinnedNotice(pair); return; }
    change(d => setPart(d, pair, mirroredDirs(d, part), pins), false, [pair]);
    ctx.toast(`${PART_NAME[pair]} now mirrors ${PART_NAME[part].toLowerCase()}.`);
  }
  /** Reach to…: the selected arm or leg bends so its hand or foot touches the next point clicked (on another
   *  character, or on this one), in any view. A one-off snap: nothing keeps them together afterwards. */
  function startReach(attach?: boolean): void {
    const part = sel ? PART_OF[sel] : target ?? lastPart;
    if (!part || !/^(arm|leg)/.test(part)) { ctx.toast('Select an arm or a leg first (V, then click it).', true); return; }
    if (isPinned(part)) { pinnedNotice(part); return; }
    const want = attach ?? attachOn;
    reaching = reaching === part && reachAttach === want ? null : part; match = null; reachAttach = want;
    if (reaching) canvas.selected = null; // the stroke pop-up would cover the target
    changed(); ctx.update();
  }
  function finishReach(a: Adapter, p: P2): void {
    const part = reaching!; reaching = null; reachHover = null;
    const hit = a.worldAt?.(p, part) ?? null;
    if (!hit) { ctx.toast('Nothing there to reach: click on a character (or an object, in 3D).', true); changed(); ctx.update(); return; }
    const tgt = hit.point, attach = reachAttach;
    // Work out the hold first (it can be refused, e.g. a loop), then one undo step for the reach and the contact.
    const anchor = attach ? ctx.anchorAt?.(hit.id, tgt, part, hit.obj) ?? null : null;
    if (attach && !anchor) { changed(); ctx.update(); return; }
    canvas.snapshot();
    const had = contacts.find(c => c.part === part);
    contacts = contacts.filter(c => c.part !== part); // reaching again replaces (or ends) the old hold
    const r = limbTo(part, tgt, false);
    if (!r) { changed(); ctx.update(); return; }
    const what = part.startsWith('arm') ? 'hand' : 'foot';
    if (anchor) {
      contacts.push({ part: part as Limb, ...anchor, ...(attachMode === 'stick' ? { mode: 'stick' as const } : {}) });
      ctx.markDirty(); ctx.update();
      const c = contacts[contacts.length - 1];
      ctx.toast(`${HAND[c.part]} attached to ${c.to === -1 && c.obj == null ? 'this character' : whoOf(c)}${r.reached ? '' : ' (out of reach: it stretches toward it)'}. It follows from now on; Detach in the Pose card.`, !r.reached);
      return;
    }
    ctx.toast((had ? `${HAND[had.part]} detached. ` : '') + (r.reached ? `The ${what} reaches the point.` : `Too far for the ${what}: the limb stretches toward it.`), !r.reached);
  }
  // ------------------------------------------------------------ precision: numbers for the selected bone, reset pose
  /** The selected bone in numbers: heading and elevation (degrees, the character's own space) and where its end is
   *  (metres, world). */
  function boneInfo(): { heading: number; elevation: number; rot: V3; end: V3; real: V3; off: boolean; limbEnd: boolean } | null {
    const J = ctx.J(); if (!J || !sel) return null;
    const dir = dirsOf(J)[sel], a = angles(dir), cp = charPoints(J), b = cp?.bones[sel];
    if (!b) return null;
    const real = b[1].toArray().map(v => +v.toFixed(4)) as V3, c = endCache.get(sel);
    const kept = !!c && (c.actual === null || len(sub(c.actual, real)) < 1e-4);
    return { heading: a.heading, elevation: a.elevation, rot: boneEuler(sel, dir), end: kept ? c!.target : real, real, off: kept && len(sub(c!.target, real)) > 0.01, limbEnd: /^(arm|leg)[LR]2$/.test(sel) };
  }
  /** A bone's direction in its idle stance (Reset pose): rotation numbers are measured from there (0 0 0 = idle). */
  const idleDir = (b: BoneKey): V3 => IDLE[PART_OF[b]][PART_BONES[PART_OF[b]].indexOf(b)] || [0, 1, 0];
  /** Rotation X, Y, Z (degrees, the character's own space, XYZ order) that turns the idle direction to `dir`.
   *  Numbers typed in are kept as typed while the bone still points that way. */
  function boneEuler(b: BoneKey, dir: V3): V3 {
    const c = eulerCache.get(b);
    if (c && len(sub(c.dir, dir)) < 1e-3) return c.e; // (the drawing's read-back differs by a hair)
    const q = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(...unit(idleDir(b))), new THREE.Vector3(...unit(dir)));
    const e = new THREE.Euler().setFromQuaternion(q, 'XYZ'), d = (r: number) => +(r * 180 / Math.PI).toFixed(2) || 0;
    return [d(e.x), d(e.y), d(e.z)];
  }
  /** Turn the selected bone to rotation X, Y, Z (degrees) from its idle direction. Children turn with it. */
  function setBoneEuler(rx: number, ry: number, rz: number): void {
    if (!sel || !ctx.J()) return;
    const part = PART_OF[sel]; if (isPinned(part)) { pinnedNotice(part); ctx.update(); return; }
    const r = Math.PI / 180, q = new THREE.Quaternion().setFromEuler(new THREE.Euler(rx * r, ry * r, rz * r, 'XYZ'));
    const dir = unit(new THREE.Vector3(...idleDir(sel)).applyQuaternion(q).toArray() as V3);
    const b = sel; lastPart = part;
    // remember the typed numbers first: the change redraws the Pose card, which must show them, not a recomputed turn
    eulerCache.set(b, { dir, e: [rx, ry, rz] });
    change(d => setBone(d, b, dir, pins), false, [part]);
    eulerCache.set(b, { dir: dirsOf(ctx.J()!)[b], e: [rx, ry, rz] });
  }
  /** Point the selected bone by heading and elevation (degrees). Children turn with it. One undo step. */
  function setBoneAngles(heading: number, elevation: number): void {
    if (!sel || !ctx.J()) return;
    const part = PART_OF[sel]; if (isPinned(part)) { pinnedNotice(part); ctx.update(); return; }
    const r = Math.PI / 180, el = Math.max(-90, Math.min(90, elevation)) * r, hd = heading * r;
    const dir: V3 = [Math.sin(hd) * Math.cos(el), Math.sin(el), Math.cos(hd) * Math.cos(el)];
    lastPart = part;
    change(d => setBone(d, sel!, dir, pins), false, [part]);
  }
  /** Bend a two-bone limb so its end lands on a world point (keeps the current bend plane). */
  function limbTo(part: Part, tgt: THREE.Vector3, step = true, edit = false): { reached: boolean } | null {
    const r = limbSolve(part, tgt, step, edit);
    if (!r) return null;
    // Keeping the feet on the ground can lift or lower the whole body after the limb moves: aim again for the
    // difference (same undo step) until the end really sits on the point.
    const miss = () => { const pp = ctx.J() && charPoints(ctx.J()!)?.parts[part]; return pp ? tgt.clone().sub(pp[pp.length - 1]) : null; };
    let aim = tgt.clone();
    for (let i = 0; i < 6; i++) {
      const off = miss(); if (!off || off.length() < 0.002) break;
      aim = aim.add(off); limbSolve(part, aim, false);
    }
    const off = miss();
    return { reached: !!off && off.length() < 0.01 };
  }
  function limbSolve(part: Part, tgt: THREE.Vector3, step: boolean, edit = false): { reached: boolean } | null {
    const J = ctx.J(); if (!J) return null;
    const r = limbDirsTo(J, ctx.rig(), place.q, part, tgt, place.s); if (!r) return null;
    lastPart = part;
    if (step) change(x => setPart(x, part, r.dirs, pins), false, edit ? [part] : []);
    else { bake(x => setPart(x, part, r.dirs, pins)); ctx.markDirty(); ctx.update(); }
    return { reached: r.reached };
  }
  /** Move the selected bone's end to a world point: a forearm or shin bends the whole limb to reach it; any other
   *  bone turns to point at it (its length stays). */
  function setBoneEnd(p: V3, quiet = false): void {
    const J = ctx.J(); if (!sel || !J) return;
    const part = PART_OF[sel]; if (isPinned(part)) { pinnedNotice(part); ctx.update(); return; }
    const tgt = new THREE.Vector3(...p), bone = sel;
    endCache.set(bone, { target: [...p] as V3, actual: null }); // the redraw during the change shows what was set
    const keep = () => { const e = charPoints(ctx.J()!)?.bones[bone]?.[1]; if (e) endCache.set(bone, { target: [...p] as V3, actual: [+e.x.toFixed(4), +e.y.toFixed(4), +e.z.toFixed(4)] }); };
    if (/^(arm|leg)[LR]2$/.test(bone)) {
      const r = limbTo(part, tgt, true, true);
      keep(); changed();
      if (r && !r.reached && !quiet) ctx.toast(`Out of reach: the ${part.startsWith('arm') ? 'arm' : 'leg'} stretches toward it.`, true);
      return;
    }
    const b = charPoints(J)?.bones[bone]; if (!b) return;
    const w = tgt.clone().sub(b[0]); if (w.length() < 1e-6) return;
    const dir = unit(toFig(w.normalize().toArray() as V3));
    lastPart = part;
    change(d => setBone(d, bone, dir, pins), false, [part]);
    keep(); changed();
  }
  /** The idle A-pose: spine and neck straight up, facing forward, shoulders and hips level, arms out about 30
   *  degrees with a soft elbow, legs straight down with a soft knee (so the bend planes are clean: no twist). */
  const IDLE: Record<Part, V3[]> = {
    spine: [[0, 1, 0], [0, 1, 0], [0, 1, 0]], neck: [[0, 1, 0]], face: [[0, 0, 1]], sh: [[1, 0, 0]], hip: [[1, 0, 0]],
    // A-pose: arms about 30 degrees out from the body, a soft elbow bending forward
    armL: [unit([-0.5, -0.865, -0.03]), unit([-0.42, -0.89, 0.16])], armR: [unit([0.5, -0.865, -0.03]), unit([0.42, -0.89, 0.16])],
    legL: [unit([-0.03, -0.995, 0.07]), unit([0, -0.997, -0.07])], legR: [unit([0.03, -0.995, 0.07]), unit([0, -0.997, -0.07])],
  };
  /** Reset the whole pose (or one part) to idle. Pinned parts stay; a locked character refuses. One undo step. */
  function resetPose(only?: Part, quiet = false): void {
    if (!ctx.J()) { ctx.toast('Draw the figure first (or pick a preset).', true); return; }
    if (locked) { lockedNotice(); return; }
    if (only && isPinned(only)) { pinnedNotice(only); return; }
    change(d => {
      for (const p of only ? [only] : PART_ORDER) if (!pins.has(p)) setPart(d, p, IDLE[p], pins);
      if (!only && !pins.has('spine')) d.fw = [0, 0, 1];
    }, false, only ? [only] : []);
    if (!quiet) ctx.toast(only ? `${PART_NAME[only]} back to idle.` : pins.size ? 'Pose back to idle (pinned parts stay).' : 'Pose back to idle.');
  }
  function startMatch(kind: 'parallel' | 'square'): void {
    if (!sel) { ctx.toast('Select a bone first (select tool, click it in any view).', true); return; }
    if (isPinned(PART_OF[sel])) { pinnedNotice(PART_OF[sel]); return; }
    match = match === kind ? null : kind;
    changed(); ctx.update();
  }
  function finishMatch(a: Adapter, p: P2): void {
    const kind = match; match = null;
    const tb = pickBone(a, p, a.reach * 1.5);
    if (!tb || !sel || !kind) { ctx.toast('No part there: match cancelled.', true); changed(); ctx.update(); return; }
    const s = sel, sp = PART_OF[s], tp = PART_OF[tb];
    change(d => {
      const t = unit(d[tb]);
      const fit = (v: V3): V3 => {
        if (kind === 'parallel') return t;
        const r: V3 = [v[0] - t[0] * dot(v, t), v[1] - t[1] * dot(v, t), v[2] - t[2] * dot(v, t)];
        return len(r) > 1e-6 ? unit(r) : unit(cross(t, Math.abs(t[1]) < 0.9 ? [0, 1, 0] : [1, 0, 0]));
      };
      if (scope === 'part' && PART_BONES[sp].length > 1) {
        // Parallel limb to limb: copy both bones. Otherwise each bone of the part relates to the target bone.
        if (kind === 'parallel' && PART_BONES[tp].length === PART_BONES[sp].length && tp !== sp) setPart(d, sp, PART_BONES[tp].map(b => d[b]), pins);
        else setPart(d, sp, PART_BONES[sp].map(b => fit(d[b])), pins);
      } else setBone(d, s, fit(d[s]), pins);
    }, false, [sp]);
    ctx.toast(`${scope === 'part' ? PART_NAME[sp] : BONE_NAME[s]} ${kind === 'parallel' ? 'parallel to' : 'square to'} ${BONE_NAME[tb].toLowerCase()}.`);
  }

  // ------------------------------------------------------------ drawing helpers for every view
  const tagOfPart = (p: Part): Tag => PART_TAG[p];
  /** Highlights and guides on a 2D view. `toPx` maps figure space; `guideToPx` maps stored guide points. */
  function decorate2D(x: CanvasRenderingContext2D, view: GuideView, polys: { parts: Partial<Record<Part, P2[]>>; bones: Partial<Record<BoneKey, P2[]>> },
                      guideToPx: ((q: [number, number]) => P2) | null): void {
    const line = (pts: P2[]) => { x.beginPath(); pts.forEach((q, i) => i ? x.lineTo(q.x, q.y) : x.moveTo(q.x, q.y)); x.stroke(); };
    x.lineCap = 'round'; x.lineJoin = 'round';
    const halo = (pts: P2[] | undefined, color: string, w: number, a: number) => { if (!pts) return; x.strokeStyle = color; x.globalAlpha = a; x.lineWidth = w; line(pts); x.globalAlpha = 1; };
    /** Hover: a soft glow with a light core, so it reads on the paper and on dark or busy models alike. */
    const glow = (pts: P2[] | undefined, color: string, w: number) => {
      if (!pts) return;
      x.save(); x.shadowColor = color; x.shadowBlur = 12; x.strokeStyle = color; x.globalAlpha = 0.34; x.lineWidth = w; line(pts); x.restore();
      x.save(); x.strokeStyle = color; x.globalAlpha = 0.55; x.lineWidth = 4.6; line(pts);
      x.strokeStyle = '#e4ecff'; x.globalAlpha = 0.95; x.lineWidth = 1.8; line(pts); x.restore();
    };
    if (target && canvas.tool === 'edit') halo(polys.parts[target], '#5b8cff', 16, 0.2);
    if (hover && hover.view === view) {
      if (hover.part) glow(polys.parts[hover.part], '#5b8cff', 12);
      if (hover.bone) glow(polys.bones[hover.bone], match ? EDIT_COLOR : '#5b8cff', 12);
    }
    if (sel) halo(polys.bones[sel], '#5b8cff', 12, 0.32);
    for (const d of drafts) {
      halo(polys.parts[d.part], EDIT_COLOR, 7, 0.22);
      if (guideToPx && d.guide.view === view) {
        const g = (d.guide.pts as [number, number][]).map(guideToPx);
        x.globalAlpha = 0.9; x.strokeStyle = EDIT_COLOR; x.lineWidth = 2.4; x.setLineDash([6, 4]); line(g); x.setLineDash([]); x.globalAlpha = 1;
      }
    }
    const padlock = (px: number, py: number, k = 1) => {
      x.fillStyle = '#5a5953'; x.strokeStyle = '#5a5953'; x.lineWidth = 1.6 * k;
      x.fillRect(px, py, 9 * k, 7 * k); x.beginPath(); x.arc(px + 4.5 * k, py, 3 * k, Math.PI, 0); x.stroke();
    };
    for (const c of contacts) { // attached limbs: a faint halo and a link at the hand or foot
      const pts = polys.parts[c.part]; if (!pts) continue;
      const st = ctx.contactMarks?.().find(m => m.active && m.part === c.part)?.state ?? 'ok';
      halo(pts, MARK_COLOR[st], 9, 0.2);
      const t = pts[pts.length - 1]; drawLink(x, { x: t.x + 10, y: t.y + 10 }, MARK_COLOR[st]);
    }
    if (!locked) for (const p of pins) {
      const pts = polys.parts[p]; if (!pts) continue;
      const t = pts[pts.length - 1]; padlock(t.x + 6, t.y - 2);
    }
    else { // the whole character is locked: one larger padlock above the figure
      let top: P2 | null = null;
      for (const pts of Object.values(polys.parts)) for (const q of pts || []) if (!top || q.y < top.y) top = q;
      if (top) { x.save(); x.globalAlpha = 0.85; x.fillStyle = 'rgba(244,242,236,.9)'; x.beginPath(); x.arc(top.x, top.y - 24, 13, 0, Math.PI * 2); x.fill(); padlock(top.x - 6.75, top.y - 25, 1.5); x.restore(); }
    }
  }

  // Front sketch: picks, guides and highlights. Strokes already show the pose (the drawing is regenerated).
  canvas.onEdit = (pts, click) => onGuide(frontAdapter(), pts.map(q => ({ x: q.x, y: q.y })), click);
  canvas.onPick = p => onSelectClick(frontAdapter(), p);
  canvas.onHover = p => onHover(p ? frontAdapter() : null, p);
  canvas.underlay = (x, P) => drawFrontGhosts(x, P);
  canvas.decorate = (x, P) => {
    const J = ctx.J(), F = J && FRAME.get(J);
    if (!J || !F) return;
    const toPage = (X: V3) => P({ x: F.o.x + X[0] / F.s, y: F.o.y - X[1] / F.s });
    decorate2D(x, 'front', figurePolys(J, toPage), q => P({ x: F.o.x + q[0] / F.s, y: F.o.y - q[1] / F.s }));
    drawMarks(x, { fig: toPage });
    const g = gizmoOn() && frontGizmo(); if (g) drawGizmo(x, g);
  };

  // ------------------------------------------------------------ 3D viewports: guides, picks, hover, ink
  const inks: [Viewport3D, HTMLCanvasElement][] = [];
  const live = new Map<Viewport3D, P2[] | null>();
  function paintInk(vp: Viewport3D, ink: HTMLCanvasElement): void {
    const dpr = devicePixelRatio || 1, r = ink.getBoundingClientRect();
    if (!r.width) return;
    ink.width = Math.round(r.width * dpr); ink.height = Math.round(r.height * dpr);
    const x = ink.getContext('2d')!; x.setTransform(dpr, 0, 0, dpr, 0, 0); x.clearRect(0, 0, r.width, r.height);
    const J = ctx.J();
    const a = J && (canvas.tool === 'edit' || canvas.tool === 'select' || sel || drafts.length || match || contacts.length || reaching) ? viewportAdapter(vp) : null;
    if (a && J) {
      const cp = charPoints(J);
      decorate2D(x, '3d', { parts: a.parts(), bones: a.bones() }, null);
      if (a.rootAt && canvas.tool === 'select' && !match) { // the character's floor marker
        const m = a.rootAt, r = rootSel ? 9 : 7;
        x.save(); x.globalAlpha = rootSel ? 1 : 0.8; x.fillStyle = locked ? '#9a9da5' : rootSel ? '#5b8cff' : '#f4f2ec'; x.strokeStyle = '#4a4f5a'; x.lineWidth = 2;
        x.beginPath(); x.moveTo(m.x, m.y - r); x.lineTo(m.x + r, m.y); x.lineTo(m.x, m.y + r); x.lineTo(m.x - r, m.y); x.closePath(); x.fill(); x.stroke(); x.restore();
      }
      for (const d of drafts) {
        if (d.guide.view !== '3d' || !cp?.parts[d.part]) continue;
        const pp = cp.parts[d.part]!, root = d.part === 'sh' || d.part === 'hip' ? pp[0].clone().lerp(pp[1], 0.5) : pp[0];
        const g = (d.guide.pts as V3[]).map(q => vp.project(new THREE.Vector3(...q).add(root)));
        dashed(x, g);
      }
    }
    drawMarks(x, { world: X => vp.project(new THREE.Vector3(...X)) });
    for (const m of ctx.objMarks?.() || []) { // objects: padlock when locked, link when held
      const c = vp.project(m.top); let dx = 0;
      if (m.locked) { x.save(); x.globalAlpha = 0.85; x.fillStyle = 'rgba(244,242,236,.9)'; x.beginPath(); x.arc(c.x, c.y - 14, 11, 0, Math.PI * 2); x.fill();
        x.fillStyle = '#5a5953'; x.strokeStyle = '#5a5953'; x.lineWidth = 2; x.fillRect(c.x - 5.6, c.y - 15, 11.2, 8.4); x.beginPath(); x.arc(c.x, c.y - 15, 3.6, Math.PI, 0); x.stroke(); x.restore(); dx = 24; }
      if (m.held) drawLink(x, { x: c.x + dx, y: c.y - 14 }, MARK_COLOR[m.held]);
    }
    const l = live.get(vp);
    if (l && l.length > 1) dashed(x, l);
    const g = gizmoOn() ? vpGizmo(vp) : objOn() ? objGizmo(vp) : null; if (g) drawGizmo(x, g);
  }
  function dashed(x: CanvasRenderingContext2D, pts: P2[]): void {
    const line = () => { x.beginPath(); pts.forEach((p, i) => i ? x.lineTo(p.x, p.y) : x.moveTo(p.x, p.y)); x.stroke(); };
    x.lineCap = 'round'; x.lineJoin = 'round';
    x.globalAlpha = 0.7; x.strokeStyle = '#f4f2ec'; x.lineWidth = 5; x.setLineDash([]); line();
    x.globalAlpha = 1; x.strokeStyle = EDIT_COLOR; x.lineWidth = 2.6; x.setLineDash([6, 4]); line(); x.setLineDash([]);
  }
  // ------------------------------------------------------------ contact markers (every view)
  const MARK_COLOR = { ok: '#5f8f72', far: EDIT_COLOR, paused: '#8a8d94' } as const;
  /** A held spot: a small ring (green: touching, red dashed line to the hand: out of reach, grey dashed: paused). */
  function drawMark(x: CanvasRenderingContext2D, T: P2, E: P2, state: ContactMark['state'], strong: boolean): void {
    x.save(); x.lineCap = 'round';
    const c = MARK_COLOR[state];
    if (state !== 'ok' && Math.hypot(T.x - E.x, T.y - E.y) > 4) {
      x.globalAlpha = 0.85; x.strokeStyle = c; x.lineWidth = 1.6; x.setLineDash([4, 3]);
      x.beginPath(); x.moveTo(E.x, E.y); x.lineTo(T.x, T.y); x.stroke(); x.setLineDash([]);
    }
    x.globalAlpha = strong ? 0.95 : 0.6;
    x.fillStyle = 'rgba(244,242,236,.85)'; x.beginPath(); x.arc(T.x, T.y, 7.5, 0, 7); x.fill();
    x.strokeStyle = c; x.lineWidth = 2; if (state === 'paused') x.setLineDash([3, 2.5]);
    x.beginPath(); x.arc(T.x, T.y, 5.2, 0, 7); x.stroke(); x.setLineDash([]);
    x.fillStyle = c; x.beginPath(); x.arc(T.x, T.y, 1.9, 0, 7); x.fill();
    x.restore();
  }
  /** A small chain link: the sign of an attached hand or foot (like the padlock for pins). */
  function drawLink(x: CanvasRenderingContext2D, c: P2, color: string, alpha = 0.9): void {
    x.save(); x.globalAlpha = alpha; x.strokeStyle = color; x.lineWidth = 1.8; x.setLineDash([]);
    x.fillStyle = 'rgba(244,242,236,.85)'; x.beginPath(); x.arc(c.x, c.y, 7.5, 0, 7); x.fill();
    for (const s of [-1, 1]) {
      x.save(); x.translate(c.x + s * 2, c.y - s * 2); x.rotate(-Math.PI / 4);
      x.beginPath(); x.ellipse(0, 0, 3.6, 2.1, 0, 0, Math.PI * 2); x.stroke(); x.restore();
    }
    x.restore();
  }
  /** Markers in a view: `fig` maps the active character's figure space, `world` maps world points (3D, Scene). */
  function drawMarks(x: CanvasRenderingContext2D, map: { fig?: (X: V3) => P2; world?: (X: V3) => P2 }): void {
    for (const m of ctx.contactMarks?.() || []) {
      if (map.world) drawMark(x, map.world(m.T), map.world(m.E), m.state, m.active);
      else if (map.fig && (m.active || ghostsOn)) drawMark(x, map.fig(m.Tf), map.fig(m.Ef), m.state, m.active);
      // the other characters' attached hands and feet carry the link too (the active one's are drawn on its limbs)
      if (!m.active) { const E = map.world ? map.world(m.E) : map.fig && ghostsOn ? map.fig(m.Ef) : null; if (E) drawLink(x, { x: E.x + 9, y: E.y - 9 }, MARK_COLOR[m.state], 0.7); }
    }
    // Reach to…: where the hand or foot would go, and a dashed line from it
    const J = ctx.J();
    if (reaching && reachHover && J) {
      const endJ = { armL: J.aL2, armR: J.aR2, legL: J.lL2, legR: J.lR2 }[reaching as Limb];
      let T: P2 | null = null, E: P2 | null = null;
      if (map.world) { T = map.world(reachHover); const ew = endJ && figToWorld(endJ); if (ew) E = map.world([ew.x, ew.y, ew.z]); }
      else if (map.fig) { const f = worldToFig(reachHover); if (f) T = map.fig(f); if (endJ) E = map.fig(endJ); }
      if (T) {
        const c = '#5b8cff';
        x.save(); x.lineCap = 'round';
        if (E) { x.globalAlpha = 0.75; x.strokeStyle = c; x.lineWidth = 1.6; x.setLineDash([5, 4]); x.beginPath(); x.moveTo(E.x, E.y); x.lineTo(T.x, T.y); x.stroke(); x.setLineDash([]); }
        x.globalAlpha = 1; x.fillStyle = 'rgba(244,242,236,.7)'; x.beginPath(); x.arc(T.x, T.y, 10, 0, 7); x.fill();
        x.strokeStyle = c; x.lineWidth = 2; x.beginPath(); x.arc(T.x, T.y, 8, 0, 7); x.stroke();
        x.beginPath(); for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) { x.moveTo(T.x + dx * 4, T.y + dy * 4); x.lineTo(T.x + dx * 12, T.y + dy * 12); } x.stroke();
        x.fillStyle = c; x.beginPath(); x.arc(T.x, T.y, 2, 0, 7); x.fill();
        if (reachAttach) drawLink(x, { x: T.x + 15, y: T.y - 15 }, c, 0.95);
        x.restore();
      }
    }
  }
  /** Select tool in 3D: a press on an object selects it, dragging it slides it over the floor (it keeps its height;
   *  the Y arrow, the numbers or the Up and Down keys lift it). A click on empty space lets go of the object. */
  function objEvents(vp: Viewport3D, local: (e: PointerEvent) => P2): void {
    const host = vp.canvas.parentElement!;
    host.addEventListener('pointerdown', e => {
      if (e.button === 0 && !panKey.space && ctx.objPicking?.() && e.target === vp.canvas) { // Attach to…: this click picks the character
        e.stopPropagation(); e.preventDefault(); ctx.objPick?.(vp, local(e)); return;
      }
      if (e.button !== 0 || panKey.space || e.defaultPrevented || canvas.tool !== 'select' || match || reaching) return;
      if (e.target !== vp.canvas) return;
      const p0 = local(e), id = ctx.objAt?.(vp, p0) ?? null;
      if (id == null) {
        if (!ctx.obj?.()) return;
        const sx = e.clientX, sy = e.clientY; // a click (not an orbit) on nothing lets go
        const up = (ev: PointerEvent) => { removeEventListener('pointerup', up); if (Math.hypot(ev.clientX - sx, ev.clientY - sy) < 5 && !pickBone(viewportAdapter(vp) || { bones: () => ({}) } as unknown as Adapter, p0, 30)) ctx.objSelect?.(null); };
        addEventListener('pointerup', up);
        return;
      }
      e.stopPropagation(); e.preventDefault();
      ctx.objSelect?.(id); sel = null; rootSel = false;
      const o = ctx.obj?.(); if (!o) return;
      const g = objGizmo(vp); if (!g) return;
      if (o.locked) { changed(); return; }
      // the centre square's drag, from the point that was pressed
      dragRoot(g, { kind: 'plate' }, p0, local, vp.canvas, 'obj');
    }, true);
  }
  function attachViewport(vp: Viewport3D, ink: HTMLCanvasElement): void {
    inks.push([vp, ink]);
    vp.controls.addEventListener('change', () => paintInk(vp, ink));
    const local = (e: PointerEvent) => { const r = vp.canvas.getBoundingClientRect(); return { x: e.clientX - r.left, y: e.clientY - r.top }; };
    let down: P2 | null = null;
    gizmoEvents(vp.canvas.parentElement!, vp.canvas, () => gizmoOn() ? vpGizmo(vp) : objOn() ? objGizmo(vp) : null, 'vp:' + inks.length);
    ikEvents(vp.canvas.parentElement!, local, () => viewportAdapter(vp), true, p => (ctx.objAt?.(vp, p) ?? null) !== null);
    objEvents(vp, local);
    vp.canvas.addEventListener('pointerdown', e => {
      if (e.button !== 0) return;
      if (canvas.tool === 'edit' && !reaching) { vp.canvas.setPointerCapture(e.pointerId); live.set(vp, [local(e)]); }
      else down = local(e);
    });
    vp.canvas.addEventListener('pointermove', e => {
      const l = live.get(vp);
      if (l) { l.push(local(e)); paintInk(vp, ink); return; }
      if (e.buttons === 0) onHover(viewportAdapter(vp), local(e));
    });
    vp.canvas.addEventListener('pointerleave', () => onHover(null, null));
    vp.canvas.addEventListener('pointerup', e => {
      const l = live.get(vp); live.set(vp, null);
      if (l) {
        let L = 0; for (let i = 1; i < l.length; i++) L += Math.hypot(l[i].x - l[i - 1].x, l[i].y - l[i - 1].y);
        onGuide(viewportAdapter(vp), L < 8 ? [l[0]] : l, L < 8);
        paintInk(vp, ink); return;
      }
      // Select tool (or a pending match): a click without a drag picks a bone; a drag was an orbit.
      const p = local(e);
      if (down && Math.hypot(p.x - down.x, p.y - down.y) < 5 && (canvas.tool === 'select' || match || reaching)) onSelectClick(viewportAdapter(vp), p);
      down = null;
    });
    vp.canvas.addEventListener('pointercancel', () => { live.set(vp, null); down = null; paintInk(vp, ink); });
  }
  attachViewport(ctx.outVP, document.getElementById('ink3') as HTMLCanvasElement);
  attachViewport(ctx.orbitVP, document.getElementById('ink3o') as HTMLCanvasElement);
  const paintInks = () => inks.forEach(([vp, ink]) => paintInk(vp, ink));

  // ------------------------------------------------------------ extra sketch views
  interface Tile { cv: HTMLCanvasElement; view: ViewId; live: P2[] | null; draw(): void; v: View2D; mode: 'char' | 'scene'; sm?: SceneMap;
    /** Reset (everyone) or Focus (an id; null = the active one), redone on resize until the user pans or zooms. */
    auto: { id: number | null | undefined } | null; size: string; refit?: () => void }
  /** Scene mode: every character in world space (metres), fitted into the tile. */
  interface SceneMap { k: number; toPx(X: V3): P2; figs: WorldFig[] }
  function sceneMap(view: ViewId, size: { w: number; h: number }, v: View2D, figs: WorldFig[]): SceneMap {
    const b = VIEWS[view];
    let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
    for (const f of figs) for (const q of Object.values(f.J) as V3[]) {
      if (!Array.isArray(q)) continue;
      const u = dot(q, b.right), w = dot(q, b.up); x0 = Math.min(x0, u); x1 = Math.max(x1, u); y0 = Math.min(y0, w); y1 = Math.max(y1, w);
    }
    if (!isFinite(x0)) { x0 = -1; x1 = 1; y0 = 0; y1 = 2; }
    if (view !== 'top') { y0 = Math.min(y0, 0); }
    const pad = 0.35, wx = Math.max(1.2, x1 - x0 + pad * 2), wy = Math.max(1.2, y1 - y0 + pad * 2);
    const k = Math.min(size.w / wx, size.h / wy) * v.z, cxw = (x0 + x1) / 2, cyw = (y0 + y1) / 2;
    const cx = size.w / 2 * v.z + v.x, cy = size.h / 2 * v.z + v.y;
    return { k, figs, toPx: (X: V3) => ({ x: cx + (dot(X, b.right) - cxw) * k, y: cy - (dot(X, b.up) - cyw) * k }) };
  }
  function drawSceneTile(t: Tile, x: CanvasRenderingContext2D, r: DOMRect): void {
    const figs = ctx.world?.() || [];
    const sm = t.sm && sDrag ? t.sm : sceneMap(t.view, { w: r.width, h: r.height }, t.v, figs); // frozen while dragging
    sm.figs = figs; t.sm = sm;
    const line = (pts: P2[]) => { x.beginPath(); pts.forEach((q, i) => i ? x.lineTo(q.x, q.y) : x.moveTo(q.x, q.y)); x.stroke(); };
    if (t.view !== 'top') { const y = sm.toPx([0, 0, 0]).y; x.strokeStyle = '#a9a69c'; x.globalAlpha = 0.6; x.lineWidth = 1; line([{ x: 8, y }, { x: r.width - 8, y }]); x.globalAlpha = 1; }
    x.lineCap = 'round'; x.lineJoin = 'round';
    for (const f of [...figs].sort((a, b) => Number(a.active) - Number(b.active))) {
      const G = f.J;
      x.globalAlpha = f.active ? 1 : 0.7; x.strokeStyle = f.color; x.lineWidth = f.active ? 3.2 : 2.6;
      for (const [a, b] of segs(G)) line([sm.toPx(a), sm.toPx(b)]);
      const hl = Math.hypot(G.H[0] - G.N[0], G.H[1] - G.N[1], G.H[2] - G.N[2]) * 0.8, c = sm.toPx(G.H);
      x.beginPath(); x.arc(c.x, c.y, Math.max(3, hl * sm.k * 0.75), 0, Math.PI * 2); x.stroke();
      line([c, sm.toPx([G.H[0] + G.f[0] * hl, G.H[1] + G.f[1] * hl, G.H[2] + G.f[2] * hl])]);
      // the handle: drag it to move this character (the floor point under the hips in the top view)
      const m = sm.toPx(t.view === 'top' ? G.P : G.P);
      x.globalAlpha = 1; x.fillStyle = f.active ? '#5b8cff' : '#f4f2ec'; x.strokeStyle = '#4a4f5a'; x.lineWidth = 2;
      x.beginPath(); x.moveTo(m.x, m.y - 8); x.lineTo(m.x + 8, m.y); x.lineTo(m.x, m.y + 8); x.lineTo(m.x - 8, m.y); x.closePath(); x.fill(); x.stroke();
      x.fillStyle = '#3d3f46'; x.font = '600 11px Inter, system-ui, sans-serif'; x.textAlign = 'center';
      if (t.view === 'top') x.fillText(f.name, m.x, m.y + 22); else x.fillText(f.name, c.x, c.y - Math.max(3, hl * sm.k * 0.75) - 6);
    }
    x.globalAlpha = 1;
    drawMarks(x, { world: sm.toPx });
    x.fillStyle = '#5a5953'; x.font = '11px Inter, system-ui, sans-serif'; x.textAlign = 'left';
    x.fillText('Scene: drag a ◆ to move a character', 10, r.height - 10);
  }
  /** Scene mode: the character under a point (its handle first, then its body). */
  function sceneHit(t: Tile, p: P2): number | null {
    const sm = t.sm; if (!sm) return null;
    let best: { id: number; d: number } | null = null;
    for (const f of sm.figs) {
      const m = sm.toPx(f.J.P), dm = Math.hypot(m.x - p.x, m.y - p.y) - 6;
      const n = nearestOn(segs(f.J), sm.toPx, p), d = Math.min(dm, n ? n[1] + 4 : Infinity);
      if (d < 16 && (!best || d < best.d)) best = { id: f.id, d };
    }
    return best?.id ?? null;
  }
  let sDrag: { id: number } | null = null;
  const tiles: Tile[] = [];
  function attachTile(cv: HTMLCanvasElement, initial: ViewId) {
    const t: Tile = { cv, view: initial, live: null, draw: () => drawTile(t), v: { z: 1, x: 0, y: 0 }, mode: 'char', auto: { id: undefined }, size: '' };
    tiles.push(t);
    const local = (e: PointerEvent) => { const r = cv.getBoundingClientRect(); return { x: e.clientX - r.left, y: e.clientY - r.top }; };
    const size = () => { const r = cv.getBoundingClientRect(); return { w: r.width, h: r.height }; };
    gizmoEvents(cv.parentElement!, cv, () => gizmoOn() ? tileGizmo(t.view, size(), t.v) : null, 'tile:' + tiles.length);
    ikEvents(cv.parentElement!, local, () => t.mode === 'char' ? tileAdapter(t.view, size(), t.v) : null, false);
    attachPanZoom(cv, () => t.v, () => { t.auto = null; t.draw(); });
    cv.addEventListener('pointerdown', e => {
      if (e.button !== 0) return;
      cv.setPointerCapture(e.pointerId);
      const p = local(e);
      if (t.mode === 'scene') { // arrange: drag a character; a click on another one makes it active
        const id = sceneHit(t, p); if (id == null || !t.sm) return;
        const b = VIEWS[t.view], k = t.sm.k; let last = p, first = true, moved = false;
        sDrag = { id };
        const mv = (ev: PointerEvent) => {
          const q = local(ev), dx = (q.x - last.x) / k, dy = -(q.y - last.y) / k; last = q;
          if (!moved && Math.hypot(q.x - p.x, q.y - p.y) < 3) return;
          moved = true;
          ctx.moveBy?.(id, [b.right[0] * dx + b.up[0] * dy, b.right[1] * dx + b.up[1] * dy, b.right[2] * dx + b.up[2] * dy], first); first = false;
        };
        const up = () => {
          cv.removeEventListener('pointermove', mv); cv.removeEventListener('pointerup', up); cv.removeEventListener('pointercancel', up);
          sDrag = null;
          if (!moved && ctx.activate) ctx.activate(id); else t.draw();
        };
        cv.addEventListener('pointermove', mv); cv.addEventListener('pointerup', up); cv.addEventListener('pointercancel', up);
        return;
      }
      if (canvas.tool === 'select' || match || reaching) { onSelectClick(tileAdapter(t.view, size(), t.v), p); return; }
      if (canvas.tool === 'erase') { ctx.toast('Erase works on the front sketch. Use the edit pen here.', true); return; }
      t.live = [p];
    });
    cv.addEventListener('pointermove', e => {
      if (t.live) { t.live.push(local(e)); t.draw(); return; }
      if (e.buttons === 0 && t.mode === 'scene') { cv.style.cursor = sceneHit(t, local(e)) != null ? 'move' : ''; return; }
      if (e.buttons === 0) onHover(tileAdapter(t.view, size(), t.v), local(e));
    });
    cv.addEventListener('pointerleave', () => onHover(null, null));
    cv.addEventListener('pointerup', () => {
      const l = t.live; t.live = null;
      if (!l) return;
      let L = 0; for (let i = 1; i < l.length; i++) L += Math.hypot(l[i].x - l[i - 1].x, l[i].y - l[i - 1].y);
      onGuide(tileAdapter(t.view, size(), t.v), L < 6 ? [l[0]] : l, L < 6);
      t.draw();
    });
    cv.addEventListener('pointercancel', () => { t.live = null; t.draw(); });
    /** Reset (id undefined): frame everyone, the usual view if they fit. Focus (an id, or null for the active one). */
    const frame = (id?: number | null) => {
      t.auto = { id };
      const { w, h } = size(); if (!w || !h) return;
      t.size = `${Math.round(w)}x${Math.round(h)}`;
      t.v = { z: 1, x: 0, y: 0 };
      const pad = 30;
      if (t.mode === 'scene') {
        if (id === undefined) { t.draw(); return; } // the scene view always fits everyone
        const sm = sceneMap(t.view, { w, h }, t.v, ctx.world?.() || []);
        const f = sm.figs.find(x => id === null ? x.active : x.id === id); if (!f) { t.draw(); return; }
        const b = boxOf([f.J], sm.toPx, G => Math.hypot(G.H[0] - G.N[0], G.H[1] - G.N[1], G.H[2] - G.N[2]) * 0.6 * sm.k);
        if (b) fitTile(b, w, h, pad, 4);
        t.draw(); return;
      }
      const m = tileMap(t.view, { w, h });
      const b = boxOf(framed(id), m.toPx, () => RIG.hr * m.k);
      if (!b) { t.draw(); return; }
      if (id === undefined && b.x0 >= pad && b.y0 >= pad && b.x1 <= w - pad && b.y1 <= h - pad) { t.draw(); return; }
      fitTile(b, w, h, pad, id === undefined ? 1 : 3);
      t.draw();
    };
    t.refit = () => { if (t.auto) frame(t.auto.id); };
    // a box measured at zoom 1 (no pan) -> zoom and pan that fit it
    const fitTile = (b: { x0: number; y0: number; x1: number; y1: number }, w: number, h: number, pad: number, maxZ: number) => {
      // names are drawn above the heads and centred on them: a little extra room up and to the sides
      const W = Math.max(20, w - 2 * pad - 40), H = Math.max(20, h - 2 * pad - 16);
      const z = Math.max(FIT_MIN, Math.min(maxZ, W / Math.max(1, b.x1 - b.x0), H / Math.max(1, b.y1 - b.y0)));
      t.v = { z, x: w / 2 - (b.x0 + b.x1) / 2 * z, y: h / 2 + 8 - (b.y0 + b.y1) / 2 * z };
    };
    return { setView: v => { t.view = v; t.draw(); }, draw: () => t.draw(), view: () => t.view, resetView: () => frame(undefined), focus: (id: number | null) => frame(id), zoom: () => t.v.z,
      setMode: (m: 'char' | 'scene') => { t.mode = m; t.v = { z: 1, x: 0, y: 0 }; t.auto = { id: undefined }; t.size = ''; cv.style.cursor = ''; t.draw(); }, mode: () => t.mode,
      /** Scene mode: a figure's pelvis handle in page pixels (tests). */
      handle: (id: number) => { const r = cv.getBoundingClientRect(), f = t.sm?.figs.find(x => x.id === id); if (!f || !t.sm) return null; const q = t.sm.toPx(f.J.P); return { x: r.left + q.x, y: r.top + q.y }; } };
  }
  function drawTile(t: Tile): void {
    const cv = t.cv, dpr = devicePixelRatio || 1, r = cv.getBoundingClientRect();
    if (!r.width || !r.height) return;
    const sz = `${Math.round(r.width)}x${Math.round(r.height)}`;
    if (sz !== t.size && t.mode === 'char' && t.auto && t.refit && ctx.J()) { t.refit(); return; } // re-frame after a resize
    t.size = sz;
    cv.width = Math.round(r.width * dpr); cv.height = Math.round(r.height * dpr);
    const x = cv.getContext('2d')!; x.setTransform(dpr, 0, 0, dpr, 0, 0); x.clearRect(0, 0, r.width, r.height);
    if (t.mode === 'scene') { paperBackground(cv.parentElement, t.v); drawSceneTile(t, x, r); return; }
    const J = ctx.J();
    if (!J) {
      x.fillStyle = '#5a5953'; x.font = '12px Inter, system-ui, sans-serif'; x.textAlign = 'center';
      x.fillText('Draw the figure in the front sketch first', r.width / 2, r.height / 2); return;
    }
    const m = tileMap(t.view, { w: r.width, h: r.height }, t.v);
    paperBackground(cv.parentElement, t.v);
    const polys = figurePolys(J, m.toPx);
    // A faint floor line under the lowest foot (not in the top view).
    if (t.view !== 'top') {
      const y = Math.max(...[J.lL2, J.lR2].map(q => m.toPx(q).y));
      x.strokeStyle = '#d6d2c6'; x.lineWidth = 1; x.beginPath(); x.moveTo(12, y + 4); x.lineTo(r.width - 12, y + 4); x.stroke();
    }
    drawGhosts(x, m.toPx, m.k);
    decorate2D(x, t.view, polys, q => m.fromView({ x: q[0], y: q[1] }));
    // The figure: far parts first and fainter, so the side nearer the viewer reads on top.
    const toward = VIEWS[t.view].toward;
    const items: { pts: P2[]; tag: Tag; depth: number }[] = [];
    for (const p of PARTS) {
      if (p === 'face') continue;
      const pts = polys.parts[p]; if (!pts) continue;
      const bones = PART_BONES[p];
      const mid = bones.reduce((acc, b) => { const [a, c] = b === 'sh' ? ['shL', 'shR'] : b === 'hip' ? ['hpL', 'hpR'] : BONE_JOINTS[b as Exclude<BoneKey, 'face'>]; return acc + dot(J[a as keyof Joints] as V3, toward) + dot(J[c as keyof Joints] as V3, toward); }, 0) / (2 * bones.length);
      items.push({ pts: p === 'neck' ? [m.toPx(J.N), m.toPx(J.H)] : pts, tag: tagOfPart(p), depth: mid });
    }
    const dmin = Math.min(...items.map(i => i.depth)), dmax = Math.max(...items.map(i => i.depth));
    items.sort((a, b) => a.depth - b.depth);
    x.lineCap = 'round'; x.lineJoin = 'round';
    for (const it of items) {
      x.globalAlpha = dmax - dmin > 0.05 ? 0.45 + 0.55 * (it.depth - dmin) / (dmax - dmin) : 1;
      x.strokeStyle = it.tag === 'head' ? COLOR.spine : COLOR[it.tag]; x.lineWidth = 3.2;
      x.beginPath(); it.pts.forEach((q, i) => i ? x.lineTo(q.x, q.y) : x.moveTo(q.x, q.y)); x.stroke();
      if (it.pts.length === 3) { x.fillStyle = COLOR[it.tag]; x.beginPath(); x.arc(it.pts[1].x, it.pts[1].y, 3.5, 0, 7); x.fill(); }
    }
    x.globalAlpha = 1;
    // Head: circle plus the facing tick, as in the sketch.
    const c = m.toPx(J.H), rad = RIG.hr * m.k;
    x.strokeStyle = COLOR.head; x.lineWidth = 3.2; x.beginPath(); x.arc(c.x, c.y, rad, 0, Math.PI * 2); x.stroke();
    const fp = { x: dot(J.f, VIEWS[t.view].right), y: dot(J.f, VIEWS[t.view].up) };
    x.strokeStyle = COLOR.face; x.beginPath(); x.moveTo(c.x, c.y); x.lineTo(c.x + fp.x * rad, c.y - fp.y * rad); x.stroke();
    drawMarks(x, { fig: m.toPx });
    { const g = gizmoOn() && !rootSel && tileGizmo(t.view, { w: r.width, h: r.height }, t.v); if (g) drawGizmo(x, g); }
    if (t.live && t.live.length > 1) {
      x.strokeStyle = EDIT_COLOR; x.lineWidth = 2.6; x.setLineDash([6, 4]);
      x.beginPath(); t.live.forEach((q, i) => i ? x.lineTo(q.x, q.y) : x.moveTo(q.x, q.y)); x.stroke(); x.setLineDash([]);
    }
  }
  const drawTiles = () => tiles.forEach(t => t.draw());


  // ------------------------------------------------------------ rotate gizmo (select tool, selected bone, every view)
  // Rings around the bone's root turn it about an axis (in 3D: the world X, Y and Z; in a flat view: the axis that
  // points out of the screen). The ball at the bone's end drags the end around in the view's plane. One undo per drag.
  const AXIS_COLOR: Record<'x' | 'y' | 'z', string> = { x: '#c26a5e', y: '#7aa06a', z: '#6a86c2' };
  const AXES: Record<'x' | 'y' | 'z', V3> = { x: [1, 0, 0], y: [0, 1, 0], z: [0, 0, 1] };
  interface Gizmo {
    kind: 'bone' | 'root';
    /** Every bone as a pixel polyline, so a click right on another bone still selects it. */
    bones(): Partial<Record<BoneKey, P2[]>>;
    /** Points in this view's space (figure units for flat views, world for 3D) to pixels on its canvas. */
    toPx(X: V3): P2;
    /** Pixel to the vector from the root to that point, in the plane through the root that faces the viewer. */
    plane(p: P2): V3 | null;
    /** World direction to the character's own space (3D views; the character may be turned). */
    fig?(v: V3): V3;
    /** 3D: the picking ray through a pixel (moving the character on the floor). */
    ray?(p: P2): THREE.Ray;
    root: V3; end: V3; ringR: number; toward: V3; cam?: V3;
    /** An object's gizmo (not the character's): its own lock, and its own place to change. */
    obj?: boolean; locked?: boolean;
    rings: { axis: V3; name: 'x' | 'y' | 'z' }[];
    arrows?: { axis: V3; name: 'x' | 'y' | 'z' }[];
  }
  type Axis = 'x' | 'y' | 'z';
  type Grab = { kind: 'ball' } | { kind: 'plate' } | { kind: 'arrow'; name: Axis; axis: V3 } | { kind: 'ring'; name: Axis; axis: V3; th: number; d: number };
  let gHover: { id: string; grab: Grab['kind']; name?: string } | null = null;
  let gDrag: { id: string; name?: string } | null = null;
  const gizmoOn = () => !!((sel || rootSel) && canvas.tool === 'select' && !match && !reaching && ctx.J());
  const v3add = (a: V3, b: V3, k = 1): V3 => [a[0] + b[0] * k, a[1] + b[1] * k, a[2] + b[2] * k];
  function boneEnds2D(J: Joints, b: BoneKey): [V3, V3] {
    if (b === 'face') return [J.H, v3add(J.H, J.f, RIG.hr * 1.4)];
    const [a, c] = BONE_JOINTS[b];
    return [J[a] as V3, J[c] as V3];
  }
  function finishGizmo(g: Omit<Gizmo, 'ringR'>, right: V3, size?: number): Gizmo {
    const L = size ?? (len(sub(g.end, g.root)) || 1);
    const a = g.toPx(g.root), c = g.toPx(v3add(g.root, right, L));
    const pxPerUnit = Math.hypot(c.x - a.x, c.y - a.y) / L || 1;
    const px = size ? Math.max(44, Math.min(110, L * pxPerUnit)) : Math.max(30, Math.min(84, L * 0.62 * pxPerUnit));
    return { ...g, ringR: px / pxPerUnit };
  }
  function flatGizmo(view: ViewId, toPx: (X: V3) => P2, toView: (p: P2) => Pt): Gizmo | null {
    const J = ctx.J(); if (!J || !sel) return null;
    const b = VIEWS[view], [root, end] = boneEnds2D(J, sel);
    const tw = b.toward, name = (['x', 'y', 'z'] as const).reduce((m, k, i) => Math.abs(tw[i]) > Math.abs(tw[['x', 'y', 'z'].indexOf(m)]) ? k : m, 'x' as Axis);
    return finishGizmo({
      kind: 'bone', bones: () => figurePolys(J, toPx).bones, toPx, root, end, toward: tw, rings: [{ axis: tw, name }],
      plane: p => { const q = toView(p); return v3add(v3add([0, 0, 0], b.right, q.x - dot(root, b.right)), b.up, q.y - dot(root, b.up)); },
    }, b.right);
  }
  function frontGizmo(): Gizmo | null {
    const J = ctx.J(), F = J && FRAME.get(J); if (!F) return null;
    const o = canvas.toPx({ x: 0, y: 0 }), s1 = canvas.toPx({ x: 1, y: 0 }).x - o.x;
    return flatGizmo('front', X => canvas.toPx({ x: F.o.x + X[0] / F.s, y: F.o.y - X[1] / F.s }),
      p => { const q = { x: (p.x - o.x) / s1, y: (p.y - o.y) / s1 }; return { x: (q.x - F.o.x) * F.s, y: -(q.y - F.o.y) * F.s }; });
  }
  function tileGizmo(view: ViewId, size: { w: number; h: number }, v?: View2D): Gizmo | null {
    const m = tileMap(view, size, v);
    return flatGizmo(view, m.toPx, m.toView);
  }
  function vpRay(vp: Viewport3D, p: P2): THREE.Ray {
    const r = vp.canvas.getBoundingClientRect(), rc = new THREE.Raycaster();
    rc.setFromCamera(new THREE.Vector2(p.x / r.width * 2 - 1, -(p.y / r.height) * 2 + 1), vp.camera);
    return rc.ray;
  }
  function vpGizmo(vp: Viewport3D): Gizmo | null {
    const J = ctx.J(); if (!J) return null;
    const cam = vp.camera.position.toArray() as V3;
    const camRight = new THREE.Vector3(1, 0, 0).applyQuaternion(vp.camera.quaternion).toArray() as V3;
    const base = { toPx: (X: V3) => vp.project(new THREE.Vector3(...X)), cam, fig: toFig, ray: (p: P2) => vpRay(vp, p),
      bones: () => viewportAdapter(vp)?.bones() || {}, rings: (['x', 'y', 'z'] as const).map(name => ({ axis: AXES[name], name })) };
    if (rootSel) { // the whole character: rings turn it about the hips, arrows and the centre move it
      const hips = ctx.rig().bones.hips; if (!hips) return null;
      const rootW = hips.getWorldPosition(new THREE.Vector3()), root = rootW.toArray() as V3;
      return finishGizmo({ ...base, kind: 'root', root, end: root, toward: unit(sub(cam, root)), arrows: base.rings,
        plane: p => { const w = vp.toPlane(p.x, p.y, rootW); return w ? sub(w.toArray() as V3, root) : null; } }, camRight, 0.42);
    }
    if (!sel) return null;
    const cp = charPoints(J); const pb = cp?.bones[sel]; if (!pb) return null;
    const rootW = sel === 'sh' || sel === 'hip' ? pb[0].clone().lerp(pb[1], 0.5) : pb[0].clone();
    const root = rootW.toArray() as V3, end = pb[1].toArray() as V3;
    return finishGizmo({ ...base, kind: 'bone', root, end, toward: unit(sub(cam, root)),
      plane: p => { const w = vp.toPlane(p.x, p.y, rootW); return w ? sub(w.toArray() as V3, root) : null; } }, camRight);
  }
  /** The selected object's gizmo in a 3D view: rings turn it about its middle, arrows move it along an axis, the
   *  centre square slides it over the floor (it keeps its height). */
  function objGizmo(vp: Viewport3D): Gizmo | null {
    const o = ctx.obj?.(); if (!o) return null;
    const cam = vp.camera.position.toArray() as V3, root = o.centre.toArray() as V3;
    const camRight = new THREE.Vector3(1, 0, 0).applyQuaternion(vp.camera.quaternion).toArray() as V3;
    const rings = (['x', 'y', 'z'] as const).map(name => ({ axis: AXES[name], name }));
    return finishGizmo({ kind: 'root', obj: true, locked: o.locked, toPx: (X: V3) => vp.project(new THREE.Vector3(...X)), cam, ray: (p: P2) => vpRay(vp, p),
      bones: () => ({}), rings, arrows: rings, root, end: root, toward: unit(sub(cam, root)),
      plane: p => { const w = vp.toPlane(p.x, p.y, o.centre); return w ? sub(w.toArray() as V3, root) : null; } }, camRight, 0.42);
  }
  const objOn = () => !!(ctx.obj?.() && canvas.tool === 'select' && !match && !reaching && !sel && !rootSel && !ctx.objPicking?.());
  function ringBasis(axis: V3): [V3, V3] {
    const u = unit(cross(axis, Math.abs(axis[1]) < 0.9 ? [0, 1, 0] : [1, 0, 0])), v = cross(axis, u);
    return [u, v];
  }
  const ringAt = (g: Gizmo, axis: V3, th: number): V3 => { const [u, v] = ringBasis(axis); return v3add(v3add(g.root, u, g.ringR * Math.cos(th)), v, g.ringR * Math.sin(th)); };
  const arrowLen = (g: Gizmo) => g.ringR * 1.55;
  const RING_N = 72;
  function hitGizmo(g: Gizmo, p: P2): Grab | null {
    const c = g.toPx(g.root);
    if (g.kind === 'bone') { const e = g.toPx(g.end); if (Math.hypot(p.x - e.x, p.y - e.y) < 11) return { kind: 'ball' }; }
    else {
      if (Math.hypot(p.x - c.x, p.y - c.y) < 11) return { kind: 'plate' };
      let ba: Grab | null = null, bd = 8;
      for (const a of g.arrows || []) {
        const t = g.toPx(v3add(g.root, a.axis, arrowLen(g))), s0 = { x: c.x + (t.x - c.x) * 0.2, y: c.y + (t.y - c.y) * 0.2 };
        if (Math.hypot(t.x - c.x, t.y - c.y) < 14) continue; // pointing at the camera: use the other handles
        const d = dPoly(p, [s0, t]); if (d < bd) { bd = d; ba = { kind: 'arrow', name: a.name, axis: a.axis }; }
      }
      if (ba) return ba;
    }
    let best: Grab | null = null, bd = 7;
    for (const r of g.rings) for (let i = 0; i < RING_N; i++) {
      const th = i / RING_N * Math.PI * 2, q = g.toPx(ringAt(g, r.axis, th)), d = Math.hypot(p.x - q.x, p.y - q.y);
      if (d < bd) { bd = d; best = { kind: 'ring', name: r.name, axis: r.axis, th, d }; }
    }
    // A ring crossing another bone: a click nearer that bone's line selects the bone instead.
    if (best && best.kind === 'ring' && g.kind === 'bone') {
      const ring = best;
      for (const [k, poly] of Object.entries(g.bones()) as [BoneKey, P2[]][]) if (k !== sel && dPoly(p, poly) < Math.min(6, ring.d + 0.5)) return null;
    }
    return best;
  }
  function drawGizmo(x: CanvasRenderingContext2D, g: Gizmo): void {
    x.save(); x.setLineDash([]); x.lineCap = 'round'; x.lineJoin = 'round';
    if (g.obj ? g.locked : locked) x.globalAlpha = 0.35; // locked: the handles are shown faded and do nothing
    const rc = g.toPx(g.root), dr = g.cam ? len(sub(g.cam, g.root)) : 0;
    for (const r of g.rings) {
      const hot = (gDrag?.name === 'ring' + r.name) || (gHover?.grab === 'ring' && gHover.name === r.name);
      x.strokeStyle = AXIS_COLOR[r.name]; x.lineWidth = hot ? 3.4 : 2.2;
      for (let i = 0; i < RING_N; i++) {
        const A = ringAt(g, r.axis, i / RING_N * Math.PI * 2), B = ringAt(g, r.axis, (i + 1) / RING_N * Math.PI * 2);
        const back = g.cam ? len(sub(g.cam, A)) > dr + g.ringR * 0.05 : false;
        x.globalAlpha = back ? 0.3 : hot ? 1 : 0.85;
        const a = g.toPx(A), b = g.toPx(B); x.beginPath(); x.moveTo(a.x, a.y); x.lineTo(b.x, b.y); x.stroke();
      }
    }
    x.globalAlpha = 1;
    if (g.kind === 'root') {
      for (const a of g.arrows || []) {
        const t = g.toPx(v3add(g.root, a.axis, arrowLen(g))), dx = t.x - rc.x, dy = t.y - rc.y, l = Math.hypot(dx, dy);
        if (l < 14) continue;
        const hot = gDrag?.name === 'arrow' + a.name || (gHover?.grab === 'arrow' && gHover.name === a.name), ux = dx / l, uy = dy / l;
        x.strokeStyle = AXIS_COLOR[a.name]; x.fillStyle = AXIS_COLOR[a.name]; x.lineWidth = hot ? 4 : 2.8;
        x.beginPath(); x.moveTo(rc.x + ux * 12, rc.y + uy * 12); x.lineTo(t.x - ux * 8, t.y - uy * 8); x.stroke();
        const s = hot ? 9 : 7.5;
        x.beginPath(); x.moveTo(t.x + ux * 4, t.y + uy * 4); x.lineTo(t.x - ux * s - uy * s * 0.6, t.y - uy * s + ux * s * 0.6); x.lineTo(t.x - ux * s + uy * s * 0.6, t.y - uy * s - ux * s * 0.6); x.closePath(); x.fill();
      }
      const hotP = gDrag?.name === 'plate' || gHover?.grab === 'plate';
      x.fillStyle = hotP ? '#5b8cff' : '#f4f2ec'; x.strokeStyle = '#4a4f5a'; x.lineWidth = 2;
      x.beginPath(); x.rect(rc.x - 7, rc.y - 7, 14, 14); x.fill(); x.stroke();
    } else {
      x.fillStyle = '#4a4f5a'; x.beginPath(); x.arc(rc.x, rc.y, 2.6, 0, 7); x.fill();
      const e = g.toPx(g.end), hotB = gDrag?.name === 'ball' || gHover?.grab === 'ball';
      x.fillStyle = hotB ? '#5b8cff' : '#f4f2ec'; x.strokeStyle = '#4a4f5a'; x.lineWidth = 2;
      x.beginPath(); x.arc(e.x, e.y, hotB ? 7.5 : 6.5, 0, 7); x.fill(); x.stroke();
    }
    x.restore();
  }
  /** Pointer handling for one view's gizmo. Listens on the view's container in the capture phase so a grab on a
   *  handle never reaches the drawing, picking or camera code underneath. */
  function gizmoEvents(host: HTMLElement, cv: HTMLElement, get: () => Gizmo | null, id: string): void {
    const local = (e: PointerEvent) => { const r = cv.getBoundingClientRect(); return { x: e.clientX - r.left, y: e.clientY - r.top }; };
    host.addEventListener('pointermove', e => {
      if (gDrag || e.buttons) return;
      const g = get(), h = g ? hitGizmo(g, local(e)) : null;
      const nh = h ? { id, grab: h.kind, name: h.kind === 'ring' || h.kind === 'arrow' ? h.name : undefined } : (gHover?.id === id ? null : gHover);
      cv.style.cursor = h ? (h.kind === 'plate' || h.kind === 'arrow' ? 'move' : 'grab') : '';
      if (JSON.stringify(nh) !== JSON.stringify(gHover)) { gHover = nh; changed(); }
    }, true);
    host.addEventListener('pointerdown', e => {
      if (e.button !== 0 || panKey.space || ctx.objPicking?.()) return;
      const g = get(); if (!g) return;
      const p0 = local(e), h = hitGizmo(g, p0); if (!h) return;
      e.stopPropagation(); e.preventDefault();
      if (g.obj) { if (g.locked) { ctx.toast(`${ctx.obj?.()?.name || 'This object'} is locked. Unlock it to move it.`, true); return; } dragRoot(g, h, p0, local, cv, id); return; }
      if (g.kind === 'root') { if (locked) { lockedNotice(); return; } dragRoot(g, h, p0, local, cv, id); return; }
      if (!sel) return;
      const part = PART_OF[sel];
      if (isPinned(part)) { pinnedNotice(part); return; }
      const J = ctx.J(); if (!J) return;
      const d0 = dirsOf(J), bone = sel, fig = g.fig || ((v: V3) => v); let first = true, last = p0, angle = 0, th = h.kind === 'ring' ? h.th : 0;
      gDrag = { id, name: h.kind === 'ring' ? 'ring' + h.name : 'ball' }; cv.style.cursor = 'grabbing';
      const move = (ev: PointerEvent) => {
        const p = local(ev), dirs: Dirs = JSON.parse(JSON.stringify(d0));
        if (h.kind === 'ring') {
          const dth = ringStep(g, h.axis, th, p, last); th += dth; angle += dth; last = p;
          const turn = ev.shiftKey ? Math.round(angle / (Math.PI / 12)) * (Math.PI / 12) : angle; // Shift: 15° steps
          if (Math.abs(turn) < 1e-6 && first) return;
          rotateBone(dirs, bone, g.fig ? toFigAxis(h.axis) : h.axis, turn, pins);
        } else {
          const mw = g.plane(p); if (!mw) return;
          const m = fig(mw), tw = fig(g.toward);
          const L = len(sub(g.end, g.root)) || 1, ml = len(m); if (ml < 1e-9) return;
          const l = Math.min(1, ml / L), z0 = dot(d0[bone], tw), dz = (z0 < 0 ? -1 : 1) * Math.sqrt(Math.max(0, 1 - l * l));
          setBone(dirs, bone, unit(v3add([m[0] / ml * l, m[1] / ml * l, m[2] / ml * l], tw, dz)), pins);
        }
        if (first) { canvas.snapshot(); detachEdited([part]); first = false; lastPart = part; } // one undo step for the whole drag (also ends drafts)
        bake(x => Object.assign(x, dirs));
        ctx.markDirty(); ctx.update();
      };
      endDrag(cv, move);
    }, true);
  }
  /** Angle change along a ring for a pointer move, linearised at the current point of the ring. */
  function ringStep(g: Gizmo, axis: V3, th: number, p: P2, last: P2): number {
    const eps = 0.02, a = g.toPx(ringAt(g, axis, th - eps)), b = g.toPx(ringAt(g, axis, th + eps));
    const t = { x: (b.x - a.x) / (2 * eps), y: (b.y - a.y) / (2 * eps) }, t2 = Math.max(t.x * t.x + t.y * t.y, 15 * 15);
    return ((p.x - last.x) * t.x + (p.y - last.y) * t.y) / t2;
  }
  function endDrag(cv: HTMLElement, move: (e: PointerEvent) => void): void {
    const up = () => {
      removeEventListener('pointermove', move); removeEventListener('pointerup', up); removeEventListener('pointercancel', up);
      gDrag = null; cv.style.cursor = ''; lastNudge = 0; changed();
    };
    addEventListener('pointermove', move); addEventListener('pointerup', up); addEventListener('pointercancel', up);
  }
  /** Dragging the character's gizmo: rings turn it about the hips, arrows move it along an axis, the centre square
   *  slides it over the floor. Shift: 15° and 5 cm steps. One undo per drag. */
  function dragRoot(g: Gizmo, h: Grab, p0: P2, local: (e: PointerEvent) => P2, cv: HTMLElement, id: string): void {
    const ob = g.obj ? ctx.obj?.() : null;
    if (g.obj && !ob) return;
    const P0 = [...(ob ? ob.p : place.p)] as V3, Q0 = new THREE.Quaternion(...(ob ? ob.q : place.q));
    let first = true, last = p0, angle = 0, th = h.kind === 'ring' ? h.th : 0, along = 0;
    const floorY = g.root[1], floor = new THREE.Plane(new THREE.Vector3(0, 1, 0), -floorY);
    const hit0 = g.ray?.(p0).intersectPlane(floor, new THREE.Vector3()) || null;
    const snap = (v: number, on: boolean) => on ? Math.round(v / 0.05) * 0.05 : v;
    gDrag = { id, name: h.kind === 'ring' || h.kind === 'arrow' ? h.kind + h.name : 'plate' }; cv.style.cursor = 'grabbing';
    const move = (ev: PointerEvent) => {
      const p = local(ev);
      let np: V3 = [...P0], nq: Quat = [Q0.x, Q0.y, Q0.z, Q0.w];
      if (h.kind === 'ring') {
        const dth = ringStep(g, h.axis, th, p, last); th += dth; angle += dth; last = p;
        const turn = ev.shiftKey ? Math.round(angle / (Math.PI / 12)) * (Math.PI / 12) : angle;
        const Q = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(...h.axis), turn).multiply(Q0).normalize();
        nq = [Q.x, Q.y, Q.z, Q.w];
      } else if (h.kind === 'arrow') {
        const c = g.toPx(g.root), t = g.toPx(v3add(g.root, h.axis, 1)), ax = { x: t.x - c.x, y: t.y - c.y }, a2 = Math.max(ax.x * ax.x + ax.y * ax.y, 1e-6);
        along += ((p.x - last.x) * ax.x + (p.y - last.y) * ax.y) / a2; last = p;
        const i = { x: 0, y: 1, z: 2 }[h.name];
        np[i] = snap(P0[i] + along, ev.shiftKey);
      } else {
        const hit = g.ray?.(p).intersectPlane(floor, new THREE.Vector3());
        if (!hit || !hit0) return;
        np = [snap(P0[0] + hit.x - hit0.x, ev.shiftKey), P0[1], snap(P0[2] + hit.z - hit0.z, ev.shiftKey)];
      }
      if (ob) { ctx.objSet?.(np.map(v => +v.toFixed(4)) as V3, nq, first); first = false; return; }
      if (first) { canvas.snapshot(); first = false; }
      place = { ...place, p: np.map(v => +v.toFixed(4)) as V3, q: nq };
      ctx.markDirty(); ctx.update();
    };
    endDrag(cv, move);
  }
  // The front sketch's handles: the paper holds the sketch canvas.
  { const sk = document.getElementById('sk'); if (sk?.parentElement) gizmoEvents(sk.parentElement, sk, () => gizmoOn() ? frontGizmo() : null, 'front'); }
  { // the front sketch's IK drags work in page units
    const sk = document.getElementById('sk');
    if (sk?.parentElement) ikEvents(sk.parentElement, e => {
      const r = sk.getBoundingClientRect(), o = canvas.toPx({ x: 0, y: 0 }), s1 = (canvas.toPx({ x: 1, y: 0 }).x - o.x) || 1;
      return { x: (e.clientX - r.left - o.x) / s1, y: (e.clientY - r.top - o.y) / s1 };
    }, () => frontAdapter(), false);
  }

  // ------------------------------------------------------------ IK drags (select tool: drag a bone, the body follows)
  // A press on a bone selects it (its gizmo shows: the end ball still turns only that bone); dragging the bone itself
  // moves the grabbed point and the body follows as a free chain (sketch/ik.ts). Only pins hold anything in place:
  // a pinned arm or leg keeps its hand or foot where it is. One undo step per drag.
  interface IKState { a: Adapter; bone: BoneKey; t: number; part: Part; d0: Dirs; E0: V3; place0: { p: V3; q: Quat; s: V3 }; hips0: THREE.Vector3 | null; p0: P2; first: boolean;
    /** Pinned arms and legs: where their hands and feet are in the world (they stay there). */
    anchors: { part: Part; at: THREE.Vector3 }[] }
  function ikEvents(host: HTMLElement, local: (e: PointerEvent) => P2, adapter: () => Adapter | null, threeD: boolean, objHit?: (p: P2) => boolean): void {
    host.addEventListener('pointerdown', e => {
      if (e.button !== 0 || panKey.space || e.defaultPrevented || ctx.objPicking?.()) return; // a gizmo handle took it (or Attach to… waits)
      if (canvas.tool !== 'select' || match || reaching || !ctx.J()) return;
      const a = adapter(); if (!a) return;
      const p0 = local(e);
      if (a.rootAt && Math.hypot(p0.x - a.rootAt.x, p0.y - a.rootAt.y) < 13) return; // the floor marker selects the character
      if (objHit?.(p0)) return; // an object in front: the press is for it
      const bone = pickBone(a, p0, a.reach); if (!bone) return;
      if (threeD) { e.stopPropagation(); e.preventDefault(); onSelectClick(a, p0); } // a press on a bone never orbits
      const poly = a.bones()[bone]!, A = poly[0], B = poly[poly.length - 1], dx = B.x - A.x, dy = B.y - A.y;
      let t = Math.max(0, Math.min(1, ((p0.x - A.x) * dx + (p0.y - A.y) * dy) / (dx * dx + dy * dy || 1e-12)));
      // 3D bars run from the model's left to its right; the stick's run from its own left (they can differ)
      if (threeD && (bone === 'sh' || bone === 'hip') && charSide(ctx.J()!, 'L', bone === 'sh') === 'right') t = 1 - t;
      let st: IKState | null = null, started = false, px0 = { x: e.clientX, y: e.clientY };
      const move = (ev: PointerEvent) => {
        if (!started) {
          if (Math.hypot(ev.clientX - px0.x, ev.clientY - px0.y) < 4) return;
          started = true; st = beginIK(a, bone, t, p0);
          if (!st) { end(); return; }
        }
        if (st) dragIK(st, local(ev));
      };
      const end = () => {
        removeEventListener('pointermove', move); removeEventListener('pointerup', end); removeEventListener('pointercancel', end);
        if (started) { ikOn = false; lastNudge = 0; changed(); ctx.update(); }
      };
      addEventListener('pointermove', move); addEventListener('pointerup', end); addEventListener('pointercancel', end);
    }, true);
  }
  function beginIK(a: Adapter, bone: BoneKey, t: number, p0: P2): IKState | null {
    const J = ctx.J(); if (!J) return null;
    if (locked) { lockedNotice(); return null; }
    const part = PART_OF[bone];
    if (pins.has(part)) { pinnedNotice(part); return null; }
    const d0 = dirsOf(J), cp = charPoints(J);
    const anchors = LIMBS.filter(l => l !== part && pins.has(l)).flatMap(l => { const pp = cp?.parts[l]; return pp && pp[2] ? [{ part: l as Part, at: pp[2].clone() }] : []; });
    return { a, bone, t, part, d0, E0: pointOn(build(d0), bone, t), place0: JSON.parse(JSON.stringify(place)), hips0: ctx.rig().bones.hips?.getWorldPosition(new THREE.Vector3()) ?? null, p0, first: true, anchors };
  }
  function dragIK(st: IKState, p: P2): void {
    const D = st.a.figDelta?.(st.p0, p, st.bone, st.t); if (!D) return;
    const T: V3 = [st.E0[0] + D[0], st.E0[1] + D[1], st.E0[2] + D[2]];
    const res = ikDrag(st.d0, st.bone, st.t, T, pins);
    if (st.first) { canvas.snapshot(); detachEdited([st.part]); st.first = false; lastPart = st.part; ikOn = true; }
    bake(x => Object.assign(x, res.d));
    // the body's move: figure units to metres (the spine's length on the model), turned like the character
    const hb = ctx.rig().bones.hips, nb = ctx.rig().bones.neck || ctx.rig().bones.head;
    const k = hb && nb ? hb.getWorldPosition(new THREE.Vector3()).distanceTo(nb.getWorldPosition(new THREE.Vector3())) || 1 : 1;
    const Rw = toWorld(res.R).map(v => v * k) as V3, moving = len(res.R) > 1e-6;
    place = { ...st.place0, p: [st.place0.p[0] + Rw[0], st.place0.p[1] + Rw[1], st.place0.p[2] + Rw[2]] };
    if ((moving || st.anchors.length) && st.hips0 && ctx.poseNow && hb) {
      // Keeping the feet on the ground can raise or lower the body as the pose changes: put the hips where the move
      // says (never below the floor). Pinned hands and feet then bend back onto their spots on the model itself
      // (its proportions differ a little from the stick figure's).
      for (let i = 0; i < (st.anchors.length ? 4 : 2); i++) {
        if (moving) {
          ctx.poseNow();
          const h = hb.getWorldPosition(new THREE.Vector3()), want = st.hips0.clone().add(new THREE.Vector3(...Rw));
          place.p = [place.p[0] + want.x - h.x, place.p[1] + want.y - h.y, place.p[2] + want.z - h.z];
          // nothing pinned: never push the body below the floor (pinned hands and feet hold it themselves)
          if (ctx.ground?.() && !st.anchors.length) place.p[1] = Math.max(place.p[1], Math.min(0, st.place0.p[1]));
        }
        ctx.poseNow();
        for (const an of st.anchors) {
          const Jn = ctx.J(); if (!Jn) break;
          const r = limbDirsTo(Jn, ctx.rig(), place.q, an.part, an.at, place.s); if (!r) continue;
          bake(x => setPart(x, an.part, r.dirs, pins)); ctx.poseNow();
        }
      }
    }
    place = { ...place, p: place.p.map(v => +v.toFixed(4)) as V3 };
    ctx.markDirty(); ctx.update();
  }
  /** Handle positions in page pixels for one view (tests): 'front', 'output', 'orbit' or a tile canvas. */
  function gizmoHandles(which: 'front' | 'output' | 'orbit' | HTMLCanvasElement): { root: P2; ball: P2; rings: Record<string, P2[]>; arrows: Record<string, P2> } | null {
    let g: Gizmo | null = null, cv: HTMLElement | null = null;
    if (which === 'front') { g = frontGizmo(); cv = document.getElementById('sk'); }
    else if (which === 'output' || which === 'orbit') { const vp = which === 'output' ? ctx.outVP : ctx.orbitVP; g = objOn() ? objGizmo(vp) : vpGizmo(vp); cv = vp.canvas; }
    else { const t = tiles.find(t => t.cv === which); if (t) { const r = t.cv.getBoundingClientRect(); g = tileGizmo(t.view, { w: r.width, h: r.height }, t.v); cv = t.cv; } }
    if (!g || !cv) return null;
    const r = cv.getBoundingClientRect(), C = (q: P2) => ({ x: r.left + q.x, y: r.top + q.y }), G = g;
    return { root: C(G.toPx(G.root)), ball: C(G.toPx(G.end)), rings: Object.fromEntries(G.rings.map(o => [o.name, Array.from({ length: 24 }, (_, i) => C(G.toPx(ringAt(G, o.axis, i / 24 * Math.PI * 2))))])),
      arrows: Object.fromEntries((G.arrows || []).map(a => [a.name, C(G.toPx(v3add(G.root, a.axis, arrowLen(G) * 0.8)))])) };
  }

  // ------------------------------------------------------------ mirror and lifecycle
  /** M (mirror drawing) also mirrors drafts' parts, depth and pins; called after the strokes were mirrored. */
  function mirrorState(): void {
    const sw = (p: Part): Part => (PAIR[p] || p);
    const z = sketch.depth.z, nz: typeof z = {};
    for (const [k, v] of Object.entries(z) as [BoneKey, number][]) {
      const nk = (k.replace(/^(arm|leg)L/, '$1#').replace(/^(arm|leg)R/, '$1L').replace('#', 'R')) as BoneKey;
      nz[nk] = k === 'sh' || k === 'hip' ? -v : v;
    }
    sketch.depth.z = nz;
    if (sketch.depth.fw) sketch.depth.fw = [-sketch.depth.fw[0], sketch.depth.fw[1], sketch.depth.fw[2]];
    for (const s of sketch.strokes) if (s.ordered && (s.tag === 'sh' || s.tag === 'hip')) s.pts = [...s.pts].reverse();
    pins = new Set([...pins].map(sw));
    const swB = (b: SegKey): SegKey => b.replace(/^(arm|leg)L/, '$1#').replace(/^(arm|leg)R/, '$1L').replace('#', 'R') as SegKey;
    contacts = contacts.map(c => ({ ...c, part: sw(c.part) as Limb, ...(c.to === -1 && c.obj == null ? { bone: swB(c.bone), off: [c.off[0], c.off[1], -c.off[2]] as [number, number, number] } : {}) }));
    drafts = []; target = null; sel = null; lastPart = lastPart && (PAIR[lastPart] || lastPart);
  }
  function reset(): void { drafts = []; target = null; sel = null; match = null; hover = null; lastPart = null; rootSel = false; reaching = null; }
  function loadFrom(d: { drafts?: unknown; pins?: string[]; place?: { p?: number[]; q?: number[]; s?: number[] }; locked?: boolean; contacts?: Contact[] }): void {
    reset();
    contacts = cleanContacts(d.contacts);
    const ok = (a: unknown, n: number) => Array.isArray(a) && a.length === n && a.every(x => typeof x === 'number' && isFinite(x));
    place = { p: ok(d.place?.p, 3) ? d.place!.p as V3 : [0, 0, 0], q: ok(d.place?.q, 4) ? d.place!.q as Quat : [0, 0, 0, 1], s: okScale(d.place?.s) };
    pins = new Set((d.pins || []).filter((p): p is Part => (PARTS as string[]).includes(p)));
    locked = d.locked === true;
  }

  return {
    get drafts() { return drafts; }, get pins() { return pins; }, get sel() { return sel; }, set sel(b: BoneKey | null) { sel = b; if (b) rootSel = false; },
    get target() { return target; }, set target(p: Part | null) { target = p; },
    get match() { return match; }, set match(m: 'parallel' | 'square' | null) { match = m; },
    get scope() { return scope; }, set scope(s: 'bone' | 'part') { scope = s; },
    get hover() { return hover; },
    onChange: (f: () => void) => listeners.push(f),
    copyPart: selPart,
    get rootSel() { return rootSel; }, set rootSel(v: boolean) { rootSel = v; if (v) sel = null; changed(); },
    get place() { return place; },
    /** Set the character's place (numbers in the Pose card): one undo step. */
    setPlace(p: V3, q: Quat, sc: V3 = place.s): void {
      if (locked) { lockedNotice(); ctx.update(); return; }
      sc = okScale(sc);
      const same = p.every((v, i) => Math.abs(v - place.p[i]) < 1e-9) && Math.abs(Math.abs(q[0] * place.q[0] + q[1] * place.q[1] + q[2] * place.q[2] + q[3] * place.q[3]) - 1) < 1e-9
        && sc.every((v, i) => Math.abs(v - place.s[i]) < 1e-9);
      if (same) return; // Enter then leaving the field: one undo step, not two
      canvas.snapshot(); place = { p, q, s: sc }; ctx.markDirty(); ctx.update(); },
    get locked() { return locked; }, toggleLock, lockedNotice, isPinned,
    /** Move without an undo step of its own (Scene view drags take one snapshot per drag). */
    movePlace(p: V3): void { place = { ...place, p }; },
    placed: () => place.p.some(v => Math.abs(v) > 1e-6) || Math.abs(place.q[3]) < 1 - 1e-9 || place.s.some(v => Math.abs(v - 1) > 1e-9),
    placeFile: () => {
      const e = new THREE.Euler().setFromQuaternion(new THREE.Quaternion(...place.q), 'YXZ'), deg = (r: number) => +(r * 180 / Math.PI).toFixed(2);
      return { p: place.p.map(v => +v.toFixed(4)), q: place.q.map(v => +v.toFixed(6)), turn: [deg(e.x), deg(e.y), deg(e.z)], ...(place.s.some(v => Math.abs(v - 1) > 1e-9) ? { s: place.s.map(v => +v.toFixed(4)) } : {}) };
    },
    apply, discard, togglePin, retarget, altNext, nudgeSel, copyToOther, startMatch, startReach, mirrorState, reset, loadFrom, bake: (m: (d: Dirs) => void) => change(m),
    boneInfo, setBoneAngles, setBoneEuler, setBoneEnd, resetPose,
    get reaching() { return reaching; }, cancelReach: () => { reaching = null; reachHover = null; changed(); },
    get reachHover() { return reachHover; },
    get contacts() { return contacts; }, set contacts(v: Contact[]) { contacts = v; },
    get attachOn() { return attachOn; }, set attachOn(v: boolean) { attachOn = v; changed(); },
    get attachMode() { return attachMode; }, set attachMode(v: 'follow' | 'stick') { attachMode = v; },
    /** Move the character without an undo step (contacts pulling it along). */
    setPlaceQuiet(p: V3): void { place = { ...place, p }; },
    get reachAttach() { return reachAttach; }, get ikOn() { return ikOn; },
    detach, setContact,
    /** Rewrite the drawing from changed bone directions with no undo step of its own (contacts following). */
    rebake: (m: (d: Dirs) => void) => bake(m),
    get ghosts() { return ghostsOn; }, set ghosts(v: boolean) { ghostsOn = v; changed(); },
    /** Front sketch: Reset (no id) frames everyone; an id (null = the active character) focuses one. */
    frameFront,
    attachTile, drawTiles, paintInks, regenerated, angles, gizmoHandles,
    lastDraft: () => drafts[drafts.length - 1]?.part ?? null,
    PART_ORDER,
  };
}
export type Posing = ReturnType<typeof createPosing>;
/** A scale read from a file or a box: three finite numbers, none of them (almost) zero; else 1, 1, 1. */
export function okScale(v: unknown): V3 {
  if (!Array.isArray(v) || v.length !== 3 || !v.every(x => typeof x === 'number' && isFinite(x))) return [1, 1, 1];
  return v.map(x => (Math.abs(x) < 1e-3 ? (x < 0 ? -1e-3 : 1e-3) : x)) as V3;
}
/** Contacts read from a file or a snapshot, keeping only well-formed ones. */
export function cleanContacts(v: unknown): Contact[] {
  if (!Array.isArray(v)) return [];
  const segs: string[] = ['spine0', 'spine1', 'spine2', 'neck', 'sh', 'hip', 'armL1', 'armL2', 'armR1', 'armR2', 'legL1', 'legL2', 'legR1', 'legR2'];
  const out: Contact[] = [];
  for (const c of v as Partial<Contact>[]) {
    if (!c || !(LIMBS as string[]).includes(c.part as string) || !segs.includes(c.bone as string) || typeof c.to !== 'number' || !isFinite(c.to)) continue;
    const obj = typeof c.obj === 'number' && isFinite(c.obj) ? c.obj : null;
    if ((c.to === -2) !== (obj !== null)) continue; // an object spot has both, a body spot neither
    const off = Array.isArray(c.off) && c.off.length === 3 && c.off.every(x => typeof x === 'number' && isFinite(x)) ? c.off as [number, number, number] : [0, 0, 0] as [number, number, number];
    if (out.some(o => o.part === c.part)) continue;
    out.push({ part: c.part as Limb, to: c.to, bone: c.bone as SegKey, t: typeof c.t === 'number' && isFinite(c.t) ? Math.max(0, Math.min(1, c.t)) : 0.5, off, ...(c.mode === 'stick' ? { mode: 'stick' as const } : {}), ...(obj !== null ? { obj } : {}) });
  }
  return out;
}
