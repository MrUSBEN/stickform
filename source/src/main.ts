// Stickform, Studio layout: sketch a stick figure, pose a rigged character, render a PNG blockout.
import * as THREE from 'three';
import { Sketch, LABEL, COLOR, Tag } from './sketch/tagger';
import { lift, Joints, FRAME } from './sketch/lifter';
import { EDIT_COLOR, solvePart } from './sketch/edits';
import { BoneKey } from './sketch/lifter';
import { dpoly, isLoop, inPoly } from './sketch/geom';
import { Part, PART_NAME, BONE_NAME, PART_OF, PART_BONES, PAIR, BONE_JOINTS, VIEWS, ViewId, dirsOf, build, regenerate, angles, setBone, setPart, mirroredDirs, rotateBone } from './sketch/pose3d';
import { createPosing, modelPoints, limbDirsTo, cleanContacts, okScale } from './ui/posing';
import { helpHTML, HelpState } from './ui/help';
import { ikDrag, pointOn } from './sketch/ik';
import { Project, saveAs, dataUrlToBlob } from './io/project';
import { SketchCanvas, Tool, PAGE_ASPECT } from './sketch/canvas';
import { Stage, Output, Viewport3D, Background, CamPreset } from './three/view';
import { Rig, SLOTS, REQUIRED, resetToRest } from './three/rig';
import { makeMannequin, tintMannequin } from './three/mannequin';
import { loadModel, normalize } from './three/loadModel';
import { captureRest } from './three/rig';
import type { Other, WorldFig, Contact, ContactMark, SegKey, FrontOther } from './ui/posing';
import { applyPose } from './three/retarget';
import { PRIMS, PROP_NAME, PrimKind, PropKind, Look, makePrimitive, loadObjectFile, centreOf, placeObject, applyLook, tintPrimitive } from './three/props';
import { BUILTIN, STARTERS, seedBrowserStarters, PoseFile, SceneFile, SceneObject, isScene, sceneThumb, toFile, fromFile, userPresets, setUserPresets, download, jsonBlob, slug, readFile } from './io/pose';

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const el = <K extends keyof HTMLElementTagNameMap>(tag: K, props: Partial<HTMLElementTagNameMap[K]> & { cls?: string } = {}, ...kids: (Node | string)[]) => {
  const e = document.createElement(tag);
  const { cls, ...rest } = props;
  if (cls) e.className = cls;
  Object.assign(e, rest);
  e.append(...kids);
  return e;
};
const store = {
  get<T>(k: string, d: T): T { try { const v = localStorage.getItem(k); return v ? JSON.parse(v) as T : d; } catch { return d; } },
  set(k: string, v: unknown): void { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* storage unavailable: settings last for this visit */ } },
};

/** Retag order and number keys, as in the design: 1 arm L … 9 hips. */
const ORDER: Tag[] = ['armL', 'armR', 'spine', 'legL', 'legR', 'head', 'face', 'sh', 'hip'];
const SHORT: Record<Tag, string> = { armL: 'Arm L', armR: 'Arm R', spine: 'Spine', legL: 'Leg L', legR: 'Leg R', head: 'Head', face: 'Facing', sh: 'Shoulders', hip: 'Hips' };
const MIRROR: Partial<Record<Tag, Tag>> = { armL: 'armR', armR: 'armL', legL: 'legR', legR: 'legL' };

// ---------------------------------------------------------------- state
const sketch = new Sketch();
const stage = new Stage();
const out = new Output();
const rigs: Rig[] = [makeMannequin()];
let rig = rigs[0];
let J: Joints | null = null;   // the posed figure
let ground = true;
let poseName = 'Untitled';
let dirty = false;
let currentPreset: string | null = null; // name of the preset the drawing started from
let currentFile: string | null = null;   // preset file in the project folder this pose came from or was saved as
let fileKind: 'pose' | 'scene' | null = null; // what that file holds: a single pose or a scene
const project = new Project();
let askSave = store.get('stickform.askSave', false);
stage.setRig(rig);

// ---------------------------------------------------------------- scene: several characters
// Each character has its own drawing, depth, pins, lock and place, a model, a colour and an eye (visible). The
// active one lives in the sketch and the posing state; the others are stored as ActorData and posed in 3D from it.
type V3n = [number, number, number];
interface ActorData {
  strokes: Sketch['strokes']; nid: number; flips: Sketch['flips']; away: boolean; snap: number; depth: Sketch['depth'];
  pins: Part[]; place: { p: V3n; q: [number, number, number, number]; s?: V3n }; locked: boolean;
  /** Lasting contacts (Attach): `to` is another character's id, or -1 for this one. */
  contacts?: Contact[];
}
interface Actor {
  id: number; name: string; rig: Rig; tint: string; visible: boolean;
  /** How its model shows: its own textures, coloured in its tint, or plain tint (mannequins are always plain). */
  look: Look;
  /** Stored pose while not active (null for the active character). */
  data: ActorData | null;
  group: THREE.Group; J: Joints | null;
  /** What its 3D pose was made from (skip re-posing when unchanged). */
  posed: unknown[] | null;
  /** Models this character has worn (undo can swap back). */
  rigs: Rig[];
  /** Where its drawing sits on the shared page: page offset `d` while it stands at place `p` (moving it in 3D
   *  shifts its faint figure by the same amount). Null: worked out from where it stands when first needed. */
  reg?: { p: V3n; d: [number, number] } | null;
  /** The preset its pose came from (Save its pose offers to update that file). */
  poseSrc?: { src: 'folder' | 'browser'; key: string; name: string } | null;
}
/** Muted body colours for mannequins (and each character's colour in the sketch and lists). */
const TINTS: { name: string; c: string }[] = [
  { name: 'Stone', c: '#c9c6bf' }, { name: 'Sage', c: '#a9b79e' }, { name: 'Dusty blue', c: '#9fafc3' }, { name: 'Clay', c: '#c7a796' },
  { name: 'Lavender', c: '#b2a7c3' }, { name: 'Sand', c: '#cdbe98' }, { name: 'Teal grey', c: '#96b3af' }, { name: 'Rose', c: '#c3a1ab' },
];
const actorCache = new Map<number, Actor>(); // every character ever made this visit (undo can bring one back)
let nextActorId = 1;
const actors: Actor[] = [];
// Objects (shapes, imported meshes): see "objects" below.
const props: Prop[] = [];
const propCache = new Map<number, Prop>(); // every object made this visit (undo can bring one back)
let nextPropId = 1;
let selProp: Prop | null = null;
/** Imported object files, to make copies (duplicate, undo, another tab) without asking for the file again. */
const objBuf = new Map<string, ArrayBuffer>();
/** Scene-wide: every model and object in its plain colour (Solid), whatever its own look says. */
let allSolid = false;
/** Strokes drawn away from the character being edited: a new figure taking shape. Once they make a head and a
 *  spine they become a new character, standing where they were drawn (see "new figures" below). Page units. */
interface Pend { id: number; pts: { x: number; y: number }[] }
let pending: Pend[] = [];
let nextPend = 1;
/** The drawing's anchor: one page-to-world mapping for the whole scene, taken from the first character with a
 *  figure (its pelvis on the page = its hips in 3D; metres per page unit from its drawing). New figures are placed
 *  through it (left/right and up/down as drawn), and the front sketch shows the others where they were drawn. */
interface PageMap { px: number; py: number; wx: number; wy: number; wz: number; m: number }
let pageMap: PageMap | null = null;
/** Settings: drawing a new figure away from the others adds a character for it. */
let autoSplit = store.get('stickform.autoSplit', true);
const modelBuf = new Map<string, ArrayBuffer>(); // model files, to give a second character its own copy
/** Each model copy belongs to one character for good, so undo can never put one copy on two characters. */
const owner = new Map<Rig, Actor>();
function makeActor(name: string, r: Rig, tint: string, group: THREE.Group = new THREE.Group()): Actor {
  const a: Actor = { id: nextActorId++, name, rig: r, tint, visible: true, look: 'original', data: null, group, J: null, posed: null, rigs: [r] };
  if (r.root.parent !== group) { r.root.parent?.remove(r.root); group.add(r.root); }
  if (r.kind === 'mannequin') tintMannequin(r, tint);
  owner.set(r, a);
  actorCache.set(a.id, a);
  return a;
}
let active: Actor = makeActor('Character 1', rig, TINTS[0].c, stage.place);
actors.push(active);
/** Camera presets with several characters: frame all of them (or the active one), and turn with the active one. */
let camFrame: 'all' | 'active' = 'all', camAim = false;
/** An open tab: a pose (one character) or a scene, with everything it needs to come back exactly as it was. The tab
 *  on screen keeps its live state in the globals (sketch, posing, actors, poseName, …); the others keep it here. */
interface Doc {
  id: number; name: string; file: string | null; kind: 'pose' | 'scene' | null; dirty: boolean; preset: string | null;
  actors: Actor[]; activeId: number; hist: { u: string[]; r: string[] } | null; camFrame: 'all' | 'active'; camAim: boolean; w: number; h: number;
  /** Its objects, the scene-wide Solid switch, strokes of figures not finished yet. */
  props?: unknown[]; solid?: boolean; pend?: unknown[]; page?: unknown;
}
let nextDocId = 1;
const docs: Doc[] = [];
let curDoc: Doc | null = null;

const outVP = new Viewport3D($<HTMLCanvasElement>('v3'), stage, out, 'output');
const orbitVP = new Viewport3D($<HTMLCanvasElement>('v3o'), stage, out, 'orbit', outVP);
let lastPreset: CamPreset = 'q';
outVP.onUserMove = () => { if (out.preset !== 'free') { lastPreset = out.preset; out.preset = 'free'; refreshCams(); } };
outVP.controls.addEventListener('change', () => { if (orbitVP.visible) orbitVP.render(); });

const canvas = new SketchCanvas($<HTMLCanvasElement>('sk'), sketch, () => { markDirty(); update(); }, () => refreshSelection());
const posing = createPosing({ sketch, canvas, outVP, orbitVP, rig: () => rig, J: () => J, update: () => update(), markDirty: () => markDirty(), toast: (m, w) => toast(m, w),
  others: () => others(), othersFront: () => othersFront(), world: () => worldFigs(), activate: id => activate(id), hit3D: (vp, p, all, objs) => hit3D(vp, p, all, objs), moveBy: (id, d, first) => moveBy(id, d, first),
  anchorAt: (id, pt, skip, obj) => obj ? objAnchorAt(id, pt, skip) : anchorAt(id, pt, skip), contactMarks: () => marks,
  nameOf: (id, obj) => obj ? props.find(o => o.id === id)?.name || 'a deleted object' : actors.find(a => a.id === id)?.name || 'a deleted character',
  objPicking: () => !!objAttaching, objPick: (vp, px) => pickHolder(vp, px), objMarks: () => objMarks(),
  poseNow: () => poseActive(), ground: () => ground, activeId: () => active.id,
  obj: () => selProp && { centre: selProp.group.localToWorld(selProp.c.clone()), p: selProp.p, q: selProp.q, locked: selProp.locked, name: selProp.name },
  objSet: (p, q, first) => { if (selProp) setProp(selProp, { p, q }, !first); },
  objAt: (vp, px) => propAt(vp, px)?.id ?? null,
  objSelect: id => selectProp(props.find(o => o.id === id) || null) });
// One undo history for the whole scene: every undo step also stores the other characters.
{ const pe = canvas.ext!; canvas.ext = { save: () => ({ ...(pe.save() as object), scene: sceneSave() }), load: v => { pe.load(v); sceneLoad((v as { scene?: SceneSnap } | null)?.scene); } }; }

const clone = <T,>(v: T): T => JSON.parse(JSON.stringify(v));
const shade = (hex: string, k: number) => '#' + [1, 3, 5].map(i => Math.max(0, Math.min(255, Math.round(parseInt(hex.slice(i, i + 2), 16) * k))).toString(16).padStart(2, '0')).join('');
/** Ink colour for a character in 2D views: its colour, darkened so it reads on the paper. */
const inkOf = (a: Actor) => shade(a.tint, 0.62);
function captureLive(): ActorData {
  return { strokes: clone(sketch.strokes), nid: sketch.nid, flips: { ...sketch.flips }, away: sketch.away, snap: sketch.snap, depth: clone(sketch.depth),
    pins: [...posing.pins], place: clone(posing.place) as ActorData['place'], locked: posing.locked, contacts: clone(posing.contacts) };
}
function loadLive(d: ActorData): void {
  sketch.strokes = clone(d.strokes); sketch.nid = Math.max(sketch.nid, d.nid); sketch.flips = { ...d.flips }; sketch.away = d.away; sketch.snap = d.snap;
  sketch.depth = clone(d.depth); sketch.lastSpine = null; sketch.classify();
  posing.loadFrom({ pins: d.pins, place: d.place, locked: d.locked, contacts: d.contacts || [] });
  canvas.selected = null; syncSnap();
}
function sketchOf(d: ActorData): Sketch {
  const k = new Sketch(); k.strokes = clone(d.strokes); k.nid = d.nid; k.flips = { ...d.flips }; k.away = d.away; k.snap = d.snap; k.depth = clone(d.depth); k.classify();
  return k;
}
function poseToData(f: PoseFile): ActorData {
  const k = new Sketch(); fromFile(k, f);
  const ok = (a: unknown, n: number) => Array.isArray(a) && a.length === n && a.every(x => typeof x === 'number' && isFinite(x));
  return { strokes: k.strokes, nid: k.nid, flips: k.flips, away: k.away, snap: k.snap, depth: k.depth,
    pins: (f.pins || []).filter((p): p is Part => p in PART_BONES), locked: f.locked === true, contacts: cleanContacts(f.attach),
    place: { p: ok(f.place?.p, 3) ? f.place!.p as V3n : [0, 0, 0], q: ok(f.place?.q, 4) ? f.place!.q as [number, number, number, number] : [0, 0, 0, 1], s: okScale(f.place?.s) } };
}
function placeFileOf(pl: ActorData['place']): NonNullable<PoseFile['place']> {
  const e = new THREE.Euler().setFromQuaternion(new THREE.Quaternion(...pl.q), 'YXZ'), deg = (r: number) => +(r * 180 / Math.PI).toFixed(2);
  const sc = okScale(pl.s);
  return { p: pl.p.map(v => +v.toFixed(4)), q: pl.q.map(v => +v.toFixed(6)), turn: [deg(e.x), deg(e.y), deg(e.z)], ...(sc.some(v => Math.abs(v - 1) > 1e-9) ? { s: sc.map(v => +v.toFixed(4)) } : {}) };
}
function dataToPose(d: ActorData, name: string): PoseFile {
  const placed = d.place.p.some(v => Math.abs(v) > 1e-6) || Math.abs(d.place.q[3]) < 1 - 1e-9 || okScale(d.place.s).some(v => Math.abs(v - 1) > 1e-9);
  const self = (d.contacts || []).filter(c => c.to === -1 && c.obj == null); // contacts with others only make sense in a scene file
  return toFile(sketchOf(d), name, { ...(d.pins.length ? { pins: [...d.pins] } : {}), ...(d.locked ? { locked: true } : {}), ...(placed ? { place: placeFileOf(d.place) } : {}), ...(self.length ? { attach: clone(self) } : {}) });
}
/** Switch which character the sketch, the tools and the Pose card work on. */
function activate(t: Actor | number): void {
  const a = typeof t === 'number' ? actors.find(x => x.id === t) : t;
  if (!a || a === active) return;
  selProp = null;
  posing.reset();
  active.data = captureLive(); active.posed = [active.data, ground, active.rig];
  loadLive(a.data!); a.data = null;
  active = a; rig = a.rig; stage.setActive(a.group, a.rig);
  closePop(); refreshRig(); update(); fillCharacters();
}
/** Pose the other characters in 3D from their stored poses (only when something changed). */
function poseOthers(): void {
  for (const a of actors) {
    a.group.visible = a.visible;
    if (a === active) { a.J = J; continue; }
    poseOne(a);
  }
}
function poseOne(a: Actor): void {
  const d = a.data!;
  if (a.posed && a.posed[0] === d && a.posed[1] === ground && a.posed[2] === a.rig) return;
  const k = sketchOf(d), Jx = lift(k.byTag(), k.flips, k.away, { depth: k.depth, ordered: k.ordered() });
  stage.resetPlacement(a.group);
  if (Jx) applyPose(a.rig, Jx, { ground }); else resetToRest(a.rig);
  a.rig.root.updateMatrixWorld(true);
  stage.applyPlacement(d.place.p, d.place.q, ground, a.group, a.rig, okScale(d.place.s));
  a.J = Jx; a.posed = [d, ground, a.rig];
}
/** Pose the active character from the drawing and its place (no drawing or rendering). */
function poseActive(): void {
  J = lift(sketch.byTag(), sketch.flips, sketch.away, { depth: sketch.depth, ordered: sketch.ordered() });
  stage.resetPlacement();
  if (J) applyPose(rig, J, { ground }); else resetToRest(rig);
  rig.root.updateMatrixWorld(true);
  stage.applyPlacement(posing.place.p, posing.place.q, ground, stage.place, rig, posing.place.s);
  active.J = J;
}

// ---------------------------------------------------------------- contacts (Attach): hands and feet that follow
/** The two joints of each bone a contact can hold (bars from the left end). */
const SEG_J: Record<SegKey, [keyof Joints, keyof Joints]> = {
  spine0: ['P', 'S1'], spine1: ['S1', 'S2'], spine2: ['S2', 'N'], neck: ['N', 'H'], sh: ['shL', 'shR'], hip: ['hpL', 'hpR'],
  armL1: ['shL', 'aL1'], armL2: ['aL1', 'aL2'], armR1: ['shR', 'aR1'], armR2: ['aR1', 'aR2'],
  legL1: ['hpL', 'lL1'], legL2: ['lL1', 'lL2'], legR1: ['hpR', 'lR1'], legR2: ['lR1', 'lR2'],
};
const V = (v: V3n) => new THREE.Vector3(v[0], v[1], v[2]);
/** A bone's frame on a posed body (world): along the bone, toward the character's front, to its side. */
function segFrame(W: Joints, b: SegKey): { A: THREE.Vector3; B: THREE.Vector3; u: THREE.Vector3; v: THREE.Vector3; w: THREE.Vector3 } {
  const [ja, jb] = SEG_J[b], A = V(W[ja] as V3n), B = V(W[jb] as V3n);
  const u = B.clone().sub(A); if (u.length() < 1e-9) u.set(0, 1, 0); u.normalize();
  let r = V(W.fw); let v = r.clone().addScaledVector(u, -r.dot(u));
  if (v.length() < 0.05) { r = new THREE.Vector3(0, 1, 0); v = r.clone().addScaledVector(u, -r.dot(u)); }
  if (v.length() < 1e-6) v = new THREE.Vector3(1, 0, 0).addScaledVector(u, -u.x);
  v.normalize();
  return { A, B, u, v, w: new THREE.Vector3().crossVectors(u, v) };
}
const contactsOf = (a: Actor): Contact[] => a === active ? posing.contacts : a.data?.contacts || [];
const qOf = (a: Actor) => a === active ? posing.place.q : a.data!.place.q;
const sOf = (a: Actor): V3n => a === active ? posing.place.s : okScale(a.data!.place.s);
const pinsOf = (a: Actor) => a === active ? posing.pins : new Set(a.data!.pins);
/** Where a contact holds, in the world (null: that character is gone). */
function contactPoint(c: Contact, holder: Actor): THREE.Vector3 | null {
  if (c.obj != null) { const o = props.find(x => x.id === c.obj); return o ? o.group.localToWorld(new THREE.Vector3(...c.off)) : null; }
  const t = c.to === -1 ? holder : actors.find(a => a.id === c.to);
  const W = t && worldJoints(t); if (!W) return null;
  const f = segFrame(W, c.bone);
  return f.A.clone().lerp(f.B, c.t).addScaledVector(f.u, c.off[0]).addScaledVector(f.v, c.off[1]).addScaledVector(f.w, c.off[2]);
}
function limbEndW(a: Actor, part: Part): THREE.Vector3 | null {
  const Jx = a === active ? J : a.J; if (!Jx) return null;
  return modelPoints(Jx, a.rig, qOf(a))?.parts[part]?.[2]?.clone() ?? null;
}
/** Rewrite a stored (not active) character's drawing from changed bone directions. */
function rebakeData(d: ActorData, mutate: (x: ReturnType<typeof dirsOf>) => void): ActorData | null {
  const k = sketchOf(d), Jx = lift(k.byTag(), k.flips, k.away, { depth: k.depth, ordered: k.ordered() }), F = Jx && FRAME.get(Jx);
  if (!Jx || !F) return null;
  const dd = dirsOf(Jx); mutate(dd);
  const { strokes, depth } = regenerate(build(dd), F);
  const keep = k.strokes.filter(st => !st.tag);
  let nid = k.nid;
  return { ...d, strokes: [...keep, ...strokes.map(st => ({ id: nid++, pts: st.pts, tag: st.tag, lock: true, ordered: true }))], nid, depth, flips: {} };
}
/** Bend one character's limb so its hand or foot lands on a world point, then pose it again. */
function setLimbTo(a: Actor, part: Part, aim: THREE.Vector3): boolean {
  const Jx = a === active ? J : a.J; if (!Jx) return false;
  const r = limbDirsTo(Jx, a.rig, qOf(a), part, aim, sOf(a)); if (!r) return false;
  const pins = pinsOf(a);
  if (a === active) { posing.rebake(d => setPart(d, part, r.dirs, pins)); poseActive(); }
  else { const nd = rebakeData(a.data!, d => setPart(d, part, r.dirs, pins)); if (!nd) return false; a.data = nd; poseOne(a); }
  return true;
}
let marks: ContactMark[] = [];
let solving = false;
/** The character being changed right now (it leads; Stick contacts pull the other one). Null: the active one. */
let leaderId: number | null = null;
/** Stick: pull a character by IK so the point `t` along `bone` moves by a world offset (its own chain: the limb or
 *  spine bends, then the whole body follows; its pins hold). No undo step of its own. */
function pullActor(a: Actor, bone: BoneKey, t: number, deltaW: THREE.Vector3): boolean {
  const Jx = a === active ? J : a.J, F = figFrame(a); if (!Jx || !F) return false;
  const dF = F.toF(deltaW);
  const d0 = dirsOf(Jx), P0 = pointOn(build(d0), bone, t);
  const res = ikDrag(d0, bone, t, [P0[0] + dF.x, P0[1] + dF.y, P0[2] + dF.z], pinsOf(a));
  const Rw = F.toW(new THREE.Vector3(...res.R));
  if (a === active) {
    posing.rebake(d => Object.assign(d, res.d));
    const p = posing.place.p; posing.setPlaceQuiet([+(p[0] + Rw.x).toFixed(4), +(p[1] + Rw.y).toFixed(4), +(p[2] + Rw.z).toFixed(4)]);
    poseActive();
  } else {
    const nd = rebakeData(a.data!, d => Object.assign(d, res.d)); if (!nd) return false;
    const p = nd.place.p; a.data = { ...nd, place: { ...nd.place, p: [+(p[0] + Rw.x).toFixed(4), +(p[1] + Rw.y).toFixed(4), +(p[2] + Rw.z).toFixed(4)] } };
    poseOne(a);
  }
  return true;
}
/** Keep every contact touching: after any change, each attached hand or foot bends to its spot again (a few passes,
 *  so chains settle). Locked holders and pinned limbs pause. Part of whatever change caused it (same undo step). */
function solveContacts(): void {
  if (solving) return;
  if (!actors.some(a => contactsOf(a).length)) { marks = []; return; }
  solving = true;
  const res = new Map<string, { h: Actor; c: Contact; state: ContactMark['state']; T: THREE.Vector3; E: THREE.Vector3 }>();
  try {
    const pulls = new Map<string, number>();
    for (let pass = 0; pass < 6; pass++) {
      let moved = false;
      for (const h of actors) {
        for (const c of [...contactsOf(h)]) {
          const key = `${h.id}:${c.part}`;
          let T = contactPoint(c, h), E = limbEndW(h, c.part);
          if (!T || !E) { res.delete(key); continue; }
          if (isLocked(h) || pinsOf(h).has(c.part)) { res.set(key, { h, c, state: 'paused', T, E }); continue; }
          if (E.distanceTo(T) > 0.002) {
            const E0 = E.clone();
            let aim = T.clone(), last = Infinity;
            for (let i = 0; i < 6; i++) {
              if (!setLimbTo(h, c.part, aim)) break;
              const T2 = contactPoint(c, h), E2 = limbEndW(h, c.part); if (!T2 || !E2) break;
              T = T2; E = E2;
              const off = T.clone().sub(E), l = off.length();
              if (l < 0.002 || (i > 0 && l >= last - 1e-5)) break;
              last = l; aim = aim.add(off);
            }
            if (E.distanceTo(E0) > 5e-4) moved = true;
          }
          // Stick: out of reach, the one that is not being changed is pulled along by its own IK chain
          if (c.mode === 'stick' && c.to !== -1 && E.distanceTo(T) >= 0.01 && (pulls.get(key) || 0) < 3) {
            const held = actors.find(a => a.id === c.to), lead = leaderId ?? active.id;
            const pullHeld = h.id === lead && !!held && !isLocked(held);
            const pullHolder = !pullHeld && !isLocked(h);
            let done = false;
            if (pullHolder) done = pullActor(h, `${c.part}2` as BoneKey, 1, T.clone().sub(E));
            else if (pullHeld && held) done = pullActor(held, c.bone, c.t, E.clone().sub(T));
            if (done) {
              pulls.set(key, (pulls.get(key) || 0) + 1); moved = true;
              if (pullHolder) { // and bend onto the spot again
                const T2 = contactPoint(c, h); if (T2) { setLimbTo(h, c.part, T2); T = T2; }
              } else { const T2 = contactPoint(c, h); if (T2) T = T2; }
              const E2 = limbEndW(h, c.part); if (E2) E = E2;
            }
          }
          res.set(key, { h, c, state: E.distanceTo(T) < 0.01 ? 'ok' : 'far', T, E });
        }
      }
      if (!moved) break;
    }
  } finally { solving = false; }
  // markers, in world space and in the active character's figure space
  const A = J && figFrame(active);
  const toFig = (v: THREE.Vector3): V3n => A ? A.toF(v.clone().sub(A.hips)).toArray() as V3n : [0, 0, 0];
  marks = [...res.values()].filter(r => r.h.visible || r.h === active).map(r => ({ holder: r.h.id, part: r.c.part, state: r.state, T: r.T.toArray() as V3n, E: r.E.toArray() as V3n,
    Tf: toFig(r.T), Ef: toFig(r.E), active: r.h === active }));
}
/** Attach: the bone, place along it and offset of a world point on a character (`skip`: the reaching limb, when
 *  the point is on the character doing the reaching). Refuses loops (two limbs holding each other). */
function anchorAt(id: number, P: THREE.Vector3, skip: Part | null): Omit<Contact, 'part'> | null {
  const a = actors.find(x => x.id === id); const W = a && worldJoints(a);
  if (!a || !W) { toast('Nothing there to hold on to.', true); return null; }
  let excl: THREE.Vector3[] | null = null;
  if (a === active && skip && J) excl = modelPoints(J, rig, posing.place.q)?.parts[skip] || null;
  const near = (x: THREE.Vector3, y: THREE.Vector3) => x.distanceTo(y) < 1e-4;
  let best: { b: SegKey; t: number; C: THREE.Vector3; d: number } | null = null;
  for (const b of Object.keys(SEG_J) as SegKey[]) {
    const [ja, jb] = SEG_J[b], A0 = V(W[ja] as V3n), B0 = V(W[jb] as V3n);
    if (excl && excl.some((q, i) => i < excl!.length - 1 && ((near(q, A0) && near(excl![i + 1], B0)) || (near(q, B0) && near(excl![i + 1], A0))))) continue;
    const ab = B0.clone().sub(A0), l2 = ab.lengthSq() || 1e-12, t = Math.max(0, Math.min(1, P.clone().sub(A0).dot(ab) / l2));
    const C = A0.clone().addScaledVector(ab, t), d = C.distanceTo(P);
    if (!best || d < best.d) best = { b, t, C, d };
  }
  if (!best) return null;
  const f = segFrame(W, best.b), o = P.clone().sub(best.C);
  { // fold the part along the bone into t
    const L = f.B.distanceTo(f.A) || 1, t2 = Math.max(0, Math.min(1, best.t + o.dot(f.u) / L));
    o.addScaledVector(f.u, -(t2 - best.t) * L); best.t = t2;
  }
  const part = skip as Contact['part'] | null;
  const to = a === active ? -1 : a.id;
  // a loop: the held limb (directly or through others) already holds this one
  const limbOf = (b: SegKey) => (/^(arm|leg)[LR]/.exec(b)?.[0] ?? null) as Contact['part'] | null;
  if (part) {
    const seen = new Set<string>();
    let cur: { actor: Actor; limb: Contact['part'] | null } = { actor: a, limb: limbOf(best.b) };
    while (cur.limb) {
      const k = `${cur.actor.id}:${cur.limb}`; if (seen.has(k)) break; seen.add(k);
      if (cur.actor === active && cur.limb === part) {
        toast(`That would make a loop: the limb there already holds this ${part.startsWith('arm') ? 'arm' : 'leg'}. Detach one of them first.`, true);
        return null;
      }
      const next = contactsOf(cur.actor).find(c => c.part === cur.limb); if (!next) break;
      const na = next.to === -1 ? cur.actor : actors.find(x => x.id === next.to); if (!na) break;
      cur = { actor: na, limb: limbOf(next.bone) };
    }
  }
  return { to, bone: best.b, t: +best.t.toFixed(4), off: [+o.dot(f.u).toFixed(4), +o.dot(f.v).toFixed(4), +o.dot(f.w).toFixed(4)] };
}
/** A character's figure frame in the world: hips, metres per spine length, turn. */
interface FigFrame { hips: THREE.Vector3; k: number; Q: THREE.Quaternion;
  /** Figure-space offset to a world offset (metres) and back; `dir` maps directions (no length). */
  toW(v: THREE.Vector3): THREE.Vector3; toF(w: THREE.Vector3): THREE.Vector3; dirW(v: THREE.Vector3): THREE.Vector3; dirF(w: THREE.Vector3): THREE.Vector3 }
function figFrame(a: Actor): FigFrame | null {
  const B = a.rig.bones, hb = B.hips, nb = B.neck || B.head;
  if (!hb || !nb) return null;
  const hips = hb.getWorldPosition(new THREE.Vector3());
  const k = hips.distanceTo(nb.getWorldPosition(new THREE.Vector3())) || 1, Q = a.group.quaternion.clone(), Qi = Q.clone().invert();
  // a stretched character: the shape of its scale (uniform scale is already in k)
  const sc = a.group.scale, m = Math.cbrt(Math.abs(sc.x * sc.y * sc.z)) || 1, A = new THREE.Vector3(sc.x / m, sc.y / m, sc.z / m);
  return { hips, k, Q,
    toW: v => v.clone().multiplyScalar(k).multiply(A).applyQuaternion(Q),
    toF: w => w.clone().applyQuaternion(Qi).divide(A).divideScalar(k),
    dirW: v => v.clone().multiply(A).applyQuaternion(Q).normalize(),
    dirF: w => w.clone().applyQuaternion(Qi).divide(A).normalize() };
}
function mapJoints(Jx: Joints, pt: (v: V3n) => V3n, dir: (v: V3n) => V3n): Joints {
  const o: Record<string, V3n> = {};
  for (const [k, v] of Object.entries(Jx)) if (Array.isArray(v)) o[k] = k === 'f' || k === 'fw' ? dir(v as V3n) : pt(v as V3n);
  return o as unknown as Joints;
}
/** A character's joints in the world, read from its posed model (so the faint figures, Scene views and Reach to…
 *  sit exactly on the body), with the facing from its stick figure. */
function worldJoints(a: Actor): Joints | null {
  const F = figFrame(a), Jx = a === active ? J : a.J;
  if (!F || !Jx) return null;
  const B = a.rig.bones, W = (sl: keyof Rig['bones']) => B[sl] ? B[sl]!.getWorldPosition(new THREE.Vector3()) : null;
  const dir = (v: V3n) => F.dirW(new THREE.Vector3(...v)).toArray() as V3n;
  const stick = mapJoints(Jx, v => F.toW(new THREE.Vector3(...v)).add(F.hips).toArray() as V3n, dir);
  const hips = W('hips'), neck = W('neck') || W('head'), head = W('head');
  const need = ['leftUpperArm', 'leftLowerArm', 'leftHand', 'rightUpperArm', 'rightLowerArm', 'rightHand', 'leftUpperLeg', 'leftLowerLeg', 'leftFoot', 'rightUpperLeg', 'rightLowerLeg', 'rightFoot'] as const;
  if (!hips || !neck || !head || need.some(n => !B[n])) return stick;
  const chain = [hips, ...(['spine', 'chest', 'upperChest'] as const).map(W).filter((x): x is THREE.Vector3 => !!x), neck];
  const L: number[] = [0]; for (let i = 1; i < chain.length; i++) L.push(L[i - 1] + chain[i].distanceTo(chain[i - 1]));
  const at = (t: number) => { const h = t * L[L.length - 1]; for (let i = 1; i < chain.length; i++) if (h <= L[i] || i === chain.length - 1) { const k = (h - L[i - 1]) / ((L[i] - L[i - 1]) || 1); return chain[i - 1].clone().lerp(chain[i], Math.min(1, k)); } return neck.clone(); };
  const up = head.clone().sub(neck); const hd = up.length() || 0.1;
  const v = (x: THREE.Vector3 | null) => x!.toArray() as V3n;
  // stick L/R are the figure's own sides; for drawing and reaching only the shape matters, so the model's sides are used as they are
  return { ...stick, P: v(hips), S1: v(at(1 / 3)), S2: v(at(2 / 3)), N: v(neck), H: v(head.clone().addScaledVector(up.normalize(), hd * 0.55)),
    shL: v(W('leftUpperArm')), aL1: v(W('leftLowerArm')), aL2: v(W('leftHand')), shR: v(W('rightUpperArm')), aR1: v(W('rightLowerArm')), aR2: v(W('rightHand')),
    hpL: v(W('leftUpperLeg')), lL1: v(W('leftLowerLeg')), lL2: v(W('leftFoot')), hpR: v(W('rightUpperLeg')), lR1: v(W('rightLowerLeg')), lR2: v(W('rightFoot')) } as Joints;
}
/** The other visible characters in the active character's figure space (onion skin in the sketch views). */
function others(): Other[] {
  const A = J && figFrame(active); if (!A) return [];
  const out: Other[] = [];
  for (const a of actors) {
    if (a === active || !a.visible) continue;
    const W = worldJoints(a); if (!W) continue;
    out.push({ id: a.id, name: a.name, color: inkOf(a), J: mapJoints(W, v => A.toF(new THREE.Vector3(...v).sub(A.hips)).toArray() as V3n,
      v => A.dirF(new THREE.Vector3(...v)).toArray() as V3n) });
  }
  return out;
}
function worldFigs(): WorldFig[] {
  const out: WorldFig[] = [];
  for (const a of actors) { if (!a.visible && a !== active) continue; const W = worldJoints(a); if (W) out.push({ id: a.id, name: a.name, color: inkOf(a), active: a === active, J: W }); }
  return out;
}
/** 3D: the character surface under a pixel (others only, unless `all`). */
function hit3D(vp: Viewport3D, p: { x: number; y: number }, all = false, objs = false): { point: THREE.Vector3; id: number; obj?: boolean } | null {
  const rc = new THREE.Raycaster();
  rc.setFromCamera(new THREE.Vector2(p.x / vp.size.w * 2 - 1, -(p.y / vp.size.h) * 2 + 1), vp.camera);
  let best: { point: THREE.Vector3; id: number; d: number; obj?: boolean } | null = null;
  for (const a of actors) {
    if (!a.visible || (!all && a === active)) continue;
    const h = rc.intersectObject(a.group, true)[0];
    if (h && (!best || h.distance < best.d)) best = { point: h.point.clone(), id: a.id, d: h.distance };
  }
  if (objs) for (const o of props) { // objects too (Reach to… onto a table, a box, a ball)
    if (!o.visible) continue;
    const h = rc.intersectObject(o.group, true)[0];
    if (h && (!best || h.distance < best.d)) best = { point: h.point.clone(), id: o.id, d: h.distance, obj: true };
  }
  return best && { point: best.point, id: best.id, ...(best.obj ? { obj: true } : {}) };
}
/** Scene views: move a character over the floor (or up) by a world offset; one undo step per drag. */
function moveBy(id: number, d: V3n, first: boolean): void {
  const a = actors.find(x => x.id === id); if (!a) return;
  const locked = a === active ? posing.locked : a.data!.locked;
  if (locked) { if (first) toast(`${a.name} is locked. Unlock it to move it.`, true); return; }
  if (first) canvas.snapshot();
  const pl = a === active ? posing.place : a.data!.place;
  const np = pl.p.map((v, i) => +(v + d[i]).toFixed(4)) as V3n;
  if (a === active) posing.movePlace(np); else a.data = { ...a.data!, place: { ...pl, p: np } };
  markDirty(); leaderId = id; try { update(); } finally { leaderId = null; }
}
interface SceneSnap { active: number; list: { id: number; name: string; tint: string; visible: boolean; look?: Look; rig: string; data: ActorData | null; reg?: Actor['reg'] }[];
  props?: PropSnap[]; sel?: number | null; solid?: boolean; pend?: Pend[]; page?: PageMap | null }
function sceneSave(): SceneSnap {
  return { active: active.id, list: actors.map(a => ({ id: a.id, name: a.name, tint: a.tint, visible: a.visible, look: a.look, rig: a.rig.name, data: a === active ? null : a.data, reg: a.reg ? clone(a.reg) : null })),
    props: props.map(propSnap), sel: selProp?.id ?? null, solid: allSolid, pend: clone(pending), page: pageMap ? { ...pageMap } : null };
}
function wear(a: Actor, r: Rig): void {
  if (a.rig === r) return;
  a.rig.root.parent?.remove(a.rig.root);
  a.group.add(r.root); a.rig = r; a.posed = null; owner.set(r, a);
  if (!a.rigs.includes(r)) a.rigs.push(r);
  if (r.kind === 'mannequin') tintMannequin(r, a.tint);
  if (a === active) { rig = r; stage.setActive(a.group, r); }
}
function sceneLoad(s: SceneSnap | undefined): void {
  if (!s) return;
  const list: Actor[] = [];
  for (const e of s.list) {
    const a = actorCache.get(e.id); if (!a) continue;
    a.name = e.name; a.tint = e.tint; a.visible = e.visible; a.data = e.data; a.look = e.look || 'original'; a.reg = e.reg ? clone(e.reg) : null;
    if (a.rig.name !== e.rig) { const r = a.rigs.find(x => x.name === e.rig); if (r) wear(a, r); }
    if (a.rig.kind === 'mannequin') tintMannequin(a.rig, a.tint);
    list.push(a);
  }
  if (!list.length) return;
  for (const a of actors) if (!list.includes(a)) stage.removeGroup(a.group);
  actors.length = 0; actors.push(...list);
  for (const a of list) stage.addGroup(a.group);
  const act = list.find(a => a.id === s.active) || list[0];
  act.data = null; active = act; rig = act.rig; stage.setActive(act.group, act.rig);
  // objects
  const pl: Prop[] = [];
  for (const e of s.props || []) { const o = propCache.get(e.id); if (!o) continue; Object.assign(o, { ...e, p: [...e.p], q: [...e.q], s: [...e.s], hold: e.hold ? clone(e.hold) : null }); pl.push(o); }
  for (const o of props) if (!pl.includes(o)) stage.removeProp(o.group);
  props.length = 0; props.push(...pl);
  allSolid = !!s.solid;
  for (const o of pl) { stage.addProp(o.group); showProp(o); }
  selProp = pl.find(o => o.id === s.sel) || null;
  pending = clone(s.pend || []);
  pageMap = s.page ? { ...s.page } : null;
  refreshRig(); fillCharacters();
}

/** Tag of a stroke to the part it draws. */
const TAG_PART: Record<Tag, Part> = { spine: 'spine', head: 'neck', face: 'face', sh: 'sh', hip: 'hip', armL: 'armL', armR: 'armR', legL: 'legL', legR: 'legR' };

// ---------------------------------------------------------------- pipeline
function update(): void {
  poseActive();
  poseOthers();
  for (const a of actors) showLook(a);
  followHolds();
  solveContacts();
  followHolds();
  stage.setOverlay(J);
  stage.frameMode = actors.length > 1 ? camFrame : 'all';
  stage.aimYaw = actors.length > 1 && camAim ? new THREE.Euler().setFromQuaternion(new THREE.Quaternion(...posing.place.q), 'YXZ').y : 0;
  if (out.preset !== 'free' && !posing.ikOn) outVP.applyPreset(out.preset); // a drag keeps the framing until it ends
  renderAll();
  canvas.draw();
  posing.drawTiles();
  refreshStatus(); refreshSelection(); refreshFlips(); refreshPoseCard(); refreshHistory();
  ($('away') as HTMLElement).setAttribute('aria-pressed', String(sketch.away));
}
function renderAll(): void { placeFrame(); outVP.render(); orbitVP.render(); posing.paintInks(); }
function markDirty(): void { dirty = true; refreshName(); }

// ---------------------------------------------------------------- toast and text prompt
let toastT = 0;
function toast(msg: string, warn = false): void {
  const t = $('toast'); t.textContent = msg; t.className = 'toast' + (warn ? ' warn' : ''); t.hidden = false;
  clearTimeout(toastT); toastT = window.setTimeout(() => { t.hidden = true; }, 3200);
}
function askConfirm(title: string, text: string, okLabel: string): Promise<boolean> {
  const d = $<HTMLDialogElement>('dlg-confirm');
  $('cf-h').textContent = title; $('cf-p').textContent = text; $('cf-ok').textContent = okLabel;
  d.returnValue = ''; d.showModal();
  return new Promise(res => d.addEventListener('close', () => res(d.returnValue === 'ok'), { once: true }));
}
function askText(title: string, value: string, okLabel = 'Save', note = ''): Promise<string | null> {
  const d = $<HTMLDialogElement>('dlg-text'), inp = $<HTMLInputElement>('tx-in');
  $('tx-h').textContent = title; $('tx-ok').textContent = okLabel; inp.value = value;
  $('tx-note').textContent = note; $('tx-note').hidden = !note;
  d.returnValue = '';
  // Enter in the box confirms (a plain Enter would submit the form through its first button, Cancel)
  inp.onkeydown = e => { if (e.key === 'Enter' && !e.isComposing) { e.preventDefault(); d.close('ok'); } };
  d.showModal(); inp.select();
  return new Promise(res => d.addEventListener('close', () => res(d.returnValue === 'ok' && inp.value.trim() ? inp.value.trim() : null), { once: true }));
}
/** A question with several answers (buttons right to left: the last one is the main one). Esc gives null. */
function askChoice(title: string, text: string, buttons: { label: string; value: string; pri?: boolean; danger?: boolean }[]): Promise<string | null> {
  const d = $<HTMLDialogElement>('dlg-choice'), acts = $('ch-acts');
  $('ch-h').textContent = title; $('ch-p').textContent = text; acts.innerHTML = '';
  for (const b of buttons) { const e = el('button', { cls: 'btn' + (b.pri ? ' pri' : '') + (b.danger ? ' danger' : ''), textContent: b.label, value: b.value }); acts.append(e); }
  d.returnValue = ''; d.showModal();
  (acts.querySelector('.pri') as HTMLElement | null)?.focus();
  return new Promise(res => d.addEventListener('close', () => res(d.returnValue || null), { once: true }));
}
document.querySelectorAll<HTMLButtonElement>('[data-close]').forEach(b => { b.onclick = () => (b.closest('dialog') as HTMLDialogElement).close(); });

// ---------------------------------------------------------------- popovers
let openPop: { pop: HTMLElement; btn?: HTMLElement } | null = null;
function closePop(): void {
  if (!openPop) return;
  openPop.pop.hidden = true; openPop.btn?.setAttribute('aria-expanded', 'false'); openPop = null;
}
function togglePop(pop: HTMLElement, btn?: HTMLElement): boolean {
  const was = openPop?.pop === pop;
  closePop();
  if (was) return false;
  pop.hidden = false; btn?.setAttribute('aria-expanded', 'true'); openPop = { pop, btn };
  (pop.querySelector('button:not(:disabled)') as HTMLElement | null)?.focus({ preventScroll: true });
  return true;
}
document.addEventListener('pointerdown', e => {
  if (!openPop) return;
  const t = e.target as Node;
  if (openPop.pop.contains(t) || openPop.btn?.contains(t)) return;
  closePop();
}, true);

// ---------------------------------------------------------------- header
function refreshName(): void {
  renderTabs();
  document.title = `${poseName}${dirty ? ' · edited' : ''} · Stickform`;
}
/** Rename the open pose or scene (click its tab's name). */
function startRename(): void {
  const inp = $<HTMLInputElement>('pnameinput'), tab = document.querySelector<HTMLElement>('#doctabs .dtab[aria-selected="true"]');
  const bar = inp.parentElement!.getBoundingClientRect(), tr = tab?.getBoundingClientRect();
  inp.style.left = Math.max(4, Math.min(bar.width - 244, (tr ? tr.left - bar.left : 12))) + 'px';
  inp.hidden = false; inp.value = poseName; inp.select(); inp.focus();
  const done = (keep: boolean) => {
    inp.onblur = null; inp.onkeydown = null;
    if (keep && inp.value.trim() && inp.value.trim() !== poseName) { poseName = inp.value.trim(); markDirty(); }
    inp.hidden = true; refreshName();
  };
  inp.onblur = () => done(true);
  inp.onkeydown = e => { if (e.key === 'Enter') done(true); else if (e.key === 'Escape') done(false); };
}
function refreshHistory(): void { $<HTMLButtonElement>('undo').disabled = !canvas.canUndo; $<HTMLButtonElement>('redo').disabled = !canvas.canRedo; }
$('undo').onclick = () => { canvas.undo(); };
$('redo').onclick = () => { canvas.redo(); };
function poseFile(name = poseName): PoseFile {
  const self = posing.contacts.filter(c => c.to === -1 && c.obj == null); // contacts with others only make sense in a scene file
  return toFile(sketch, name, { output: { w: out.w, h: out.h }, ...(posing.pins.size ? { pins: [...posing.pins] } : {}), ...(posing.locked ? { locked: true } : {}), ...(posing.placed() ? { place: posing.placeFile() } : {}), ...(self.length ? { attach: clone(self) } : {}) });
}
/** Shipped preset files (the built-ins, also in presets/): not listed again under Mine. */
/** The pose file plus the 3D skeleton (joints and bone directions) for anyone reading the file outside the app. */
function withSkeleton(f: PoseFile): PoseFile {
  if (!J) return f;
  const r = (v: number[]) => v.map(x => +x.toFixed(5)), d = dirsOf(J);
  return { ...f, skeleton: { units: 'spine length = 1; x right, y up, z toward the front viewer; pelvis at 0',
    joints: Object.fromEntries(Object.entries(J).map(([k, v]) => [k, r(v as number[])])), bones: Object.fromEntries(Object.entries(d).map(([k, v]) => [k, r(v)])) } };
}
/** What a preset file holds, for the replace question. */
async function describePreset(file: string): Promise<string> {
  try {
    const f = (await project.list('presets', ['.json'])).find(x => x.name === file);
    const d = f && JSON.parse(await (await f.read()).text());
    if (isScene(d)) return `a scene with ${d.characters.length} characters (“${d.name}”)`;
    if (d?.format === 'stickform-pose') return `a pose (“${d.name}”)`;
  } catch { /* unreadable */ }
  return 'a file';
}
/** Write a pose or scene file into presets/ (or the save dialog, or a download). Never replaces another file
 *  without saying what it holds; declining asks for another name instead of giving up. Returns the file name. */
async function writePreset(name: string, make: (name: string) => PoseFile | SceneFile, kind: 'pose' | 'scene', sameFile: string | null, intoFile: string | null = null): Promise<{ name: string; file: string } | null> {
  for (;;) {
    const file = intoFile || slug(name) + '.stickform.json', blob = jsonBlob(make(name));
    intoFile = null; // only the first try (a new name gets its own file)
    if (askSave) {
      const ok = await saveAs(file, blob, { description: kind === 'scene' ? 'Stickform scene' : 'Stickform pose', accept: { 'application/json': ['.json'] } });
      if (ok === false) return null;
      if (ok === null) download(file, blob);
      toast(`Saved ${file}`); return { name, file };
    }
    if (project.connected) {
      if (file !== sameFile && await project.exists('presets', file)) {
        const what = await describePreset(file);
        if (!(await askConfirm(`Replace ${what.startsWith('a scene') ? 'that scene' : 'that pose'}?`, `presets/${file} is ${what}. Replace it with this ${kind}? Choose Cancel to pick another name.`, 'Replace'))) {
          const n = await askText(`Save ${kind} as`, name + ' 2', 'Save'); if (!n) { toast('Not saved.'); return null; }
          name = n; continue;
        }
      }
      try { await project.write('presets', file, blob); } catch (e) { toast('Could not save: ' + (e as Error).message, true); return null; }
      toast(`Saved to presets/${file}`); void refreshFolderPresets();
      return { name, file };
    }
    download(file, blob);
    toast(project.supported ? `Downloaded ${file}. Connect your project folder to save straight into presets/.` : `Downloaded ${file}. Open Stickform with “Start Stickform” to save straight into presets/.`);
    return { name, file };
  }
}
let askOverwrite = store.get('stickform.askOverwrite', true);
/** Overwriting an existing file: ask (unless switched off in Settings). 'new' = save under another name instead. */
async function confirmOverwrite(file: string, what: string): Promise<'yes' | 'new' | null> {
  if (!askOverwrite) return 'yes';
  const r = await askChoice('Overwrite?', `${what} replaces presets/${file}. You can save it under another name instead.`,
    [{ label: 'Cancel', value: 'cancel' }, { label: 'Save as new…', value: 'new' }, { label: 'Overwrite', value: 'yes', pri: true }]);
  return r === 'yes' ? 'yes' : r === 'new' ? 'new' : null;
}
/** Save the open document: a pose (one character) or a scene. Ctrl S; asNew = Save as (Ctrl Shift S). */
async function savePose(asNew = false): Promise<boolean> {
  if (!sketch.strokes.length && !isSceneNow()) { toast('Draw something first.', true); return false; }
  const kind: 'pose' | 'scene' = isSceneNow() ? 'scene' : 'pose';
  let name = poseName;
  // Not opened from a file, but named like something in the library: ask, so it is not mistaken for that one.
  const builtin = !currentFile && libItems().some(it => (it.scene?.name || it.d.name) === name);
  // The open file holds the other kind (a pose that grew into a scene, or a scene down to one character):
  // the new kind gets its own file, so the old one is never overwritten by surprise.
  const switched = !!currentFile && fileKind !== null && fileKind !== kind;
  if (asNew || name === 'Untitled' || name === 'Untitled scene' || (builtin && !currentFile) || switched) {
    const note = switched ? (kind === 'scene'
      ? `This started as the pose ${currentFile}. With ${actors.length > 1 ? `${actors.length} characters` : `${props.length} object${props.length > 1 ? 's' : ''}`} it is saved as a scene, in its own file.`
      : `The scene is down to one character, so this saves a pose file. The scene file ${currentFile} stays as it is.`) : '';
    const guess = switched ? (kind === 'scene' ? `${name} scene` : (/^Character \d+$/.test(active.name) ? `${name} pose` : active.name))
      : name === 'Untitled' || name === 'Untitled scene' ? `My ${kind}` : builtin ? `${name} 2` : name;
    const n = await askText(asNew ? `Save ${kind} as` : `Name this ${kind}`, asNew ? `${name} 2` : guess, 'Save', note);
    if (!n) return false; name = n;
  }
  // Same document, same name: back into the file it came from (whatever that file is called), after asking.
  const into = currentFile && !switched && !asNew && name === poseName && project.connected && !askSave ? currentFile : null;
  if (into && await project.exists('presets', into)) {
    const ok = await confirmOverwrite(into, `Saving this ${kind}`);
    if (!ok) return false;
    if (ok === 'new') return savePose(true);
  }
  const res = await writePreset(name, nm => kind === 'scene' ? sceneFile(nm) : withSkeleton(poseFile(nm)), kind, switched ? null : currentFile, into);
  if (!res) return false;
  if (project.connected && !askSave) { currentFile = res.file; fileKind = kind; }
  if (kind === 'pose' && project.connected && !askSave) active.poseSrc = { src: 'folder', key: res.file, name: res.name };
  poseName = res.name; dirty = false; refreshName();
  return true;
}
/** Save one character's pose on its own (from a scene), leaving the scene file alone. If its pose came from a
 *  preset in presets/, that file is offered (with the overwrite question); asNew always asks for a name. */
async function saveCharacterPose(a: Actor, asNew = false): Promise<boolean> {
  const make = (nm: string) => a === active ? withSkeleton(poseFile(nm)) : dataToPose(a.data!, nm);
  const src = a.poseSrc;
  if (!asNew && src?.src === 'folder' && project.connected && !askSave && await project.exists('presets', src.key)) {
    const ok = await confirmOverwrite(src.key, `Saving ${a.name}’s pose`);
    if (!ok) return false;
    if (ok === 'new') return saveCharacterPose(a, true);
    const res = await writePreset(src.name, make, 'pose', src.key, src.key);
    return !!res;
  }
  const n = await askText(`Save ${a.name}’s pose as`, src ? `${src.name}${asNew ? ' 2' : ''}` : /^Character \d+$/.test(a.name) ? `${poseName} ${a.name}` : a.name, 'Save',
    `Only ${a.name}’s pose goes into this pose file; the scene is not changed.`);
  if (!n) return false;
  const res = await writePreset(n, make, 'pose', null);
  if (res && project.connected && !askSave) a.poseSrc = { src: 'folder', key: res.file, name: res.name };
  return !!res;
}
/** The Save button: the open document (pose or scene). The arrow next to it lists every way to save. */
$('savepose').onclick = () => void savePose();
function fillSaveMenu(): void {
  const p = $('savepop'); p.innerHTML = '';
  const scene = isSceneNow();
  const item = (label: string, sub: string, key: string, f: () => void, disabled = false, title = '') => {
    const b = el('button', { cls: 'mi', disabled, title }, el('span', { cls: 'chk' }), el('span', {}, label, el('span', { cls: 'sub2', textContent: sub })), ...(key ? [el('kbd', { textContent: key })] : []));
    b.setAttribute('role', 'menuitem'); b.onclick = () => { closePop(); f(); }; p.append(b);
  };
  const file = currentFile && fileKind === (scene ? 'scene' : 'pose') ? `presets/${currentFile}` : 'asks for a name';
  item('Save scene', scene ? `${actors.length} character${actors.length > 1 ? 's' : ''}${props.length ? `, ${props.length} object${props.length > 1 ? 's' : ''}` : ''} · ${file}` : 'Add a character or an object to make a scene', scene ? 'Ctrl S' : '', () => void savePose(), !scene,
    scene ? '' : 'A scene has two or more characters, or objects');
  if (scene) item('Save scene as…', 'a copy under a new name', 'Ctrl ⇧ S', () => void savePose(true));
  p.append(el('div', { cls: 'sep2' }));
  const a = active, src = a.poseSrc;
  if (!scene) {
    item('Save pose', file, 'Ctrl S', () => void savePose());
    item('Save pose as…', 'a variation under a new name', 'Ctrl ⇧ S', () => void savePose(true));
  } else {
    item(`Save ${a.name}’s pose`, src?.src === 'folder' ? `into presets/${src.key} (where it came from)` : 'asks for a name', '', () => void saveCharacterPose(a));
    item(`Save ${a.name}’s pose as…`, 'a variation under a new name', '', () => void saveCharacterPose(a, true));
  }
}
$('savemenu').onclick = () => {
  fillSaveMenu();
  const b = $('savemenu').getBoundingClientRect(), p = $('savepop');
  if (togglePop(p, $('savemenu'))) { p.style.left = Math.max(8, b.right - 300) + 'px'; p.style.top = (b.bottom + 6) + 'px'; }
};

// ---------------------------------------------------------------- workspace tabs
type WS = 'pose' | 'library' | 'renders';
function showWS(w: WS): void {
  for (const k of ['pose', 'library', 'renders'] as WS[]) {
    $('ws-' + k).hidden = k !== w;
    $('tab-' + k).setAttribute('aria-selected', String(k === w));
  }
  closePop();
  if (w === 'pose') requestAnimationFrame(resizeAll);
  if (w === 'library') fillLibrary();
  if (w === 'renders') void fillRenders();
}
$('tab-pose').onclick = () => showWS('pose');
$('tab-library').onclick = () => showWS('library');
$('tab-renders').onclick = () => showWS('renders');
$('tolib').onclick = e => { e.preventDefault(); showWS('library'); };

// ---------------------------------------------------------------- viewports: move, resize, add, remove, maximise
type Kind = 'sketch' | 'view1' | 'view2' | 'view3' | 'output' | 'orbit';
const KINDS: Kind[] = ['sketch', 'view1', 'view2', 'view3', 'output', 'orbit'];
const VIEW_KINDS: Kind[] = ['view1', 'view2', 'view3'];
const VP: Record<Kind, HTMLElement> = { sketch: $('vp-sketch'), view1: $('vp-view1'), view2: $('vp-view2'), view3: $('vp-view3'), output: $('vp-output'), orbit: $('vp-orbit') };
const VPNAME: Record<'sketch' | 'output' | 'orbit', string> = { sketch: 'Sketch · front (drawing)', output: '3D · output camera', orbit: '3D · orbit (free work view)' };
// The layout is columns side by side, each a stack of viewports (rows). Sketch views tile as a grid.
interface Layout { cols: Kind[][]; colW: number[]; rowW: Record<string, number>; views: Record<string, ViewId> }
const LKEY = 'stickform.layout.v3';
const DEFAULT_LAYOUT: Layout = { cols: [['sketch'], ['output']], colW: [1, 1], rowW: {}, views: { view1: 'right', view2: 'top', view3: 'back' } };
function validLayout(l: Layout | null): l is Layout {
  if (!l || !Array.isArray(l.cols) || !l.cols.length || !Array.isArray(l.colW) || l.colW.length !== l.cols.length || !l.views || !l.rowW) return false;
  const all = l.cols.flat();
  return l.cols.every(c => Array.isArray(c) && c.length > 0) && all.every(k => KINDS.includes(k)) && new Set(all).size === all.length;
}
let layout: Layout = store.get(LKEY, DEFAULT_LAYOUT);
if (!validLayout(layout)) layout = structuredClone(DEFAULT_LAYOUT);
const saveLayout = () => store.set(LKEY, layout);
const shown = (): Kind[] => layout.cols.flat();
const colOf = (k: Kind) => layout.cols.findIndex(c => c.includes(k));
const SKETCHY = (k: Kind) => k === 'sketch' || VIEW_KINDS.includes(k);
// Extra sketch views: each tile draws the pose from one side and takes edit-pen guides.
const tileApi = Object.fromEntries(VIEW_KINDS.map(k => {
  const cv = VP[k].querySelector('canvas') as HTMLCanvasElement, selEl = VP[k].querySelector('select') as HTMLSelectElement;
  const modeEl = VP[k].querySelector('select.vmode') as HTMLSelectElement;
  const api = posing.attachTile(cv, layout.views[k] || 'right');
  selEl.value = api.view();
  selEl.onchange = () => { layout.views[k] = selEl.value as ViewId; api.setView(selEl.value as ViewId); saveLayout(); };
  // Character: the active character in its own space (draw and edit). Scene: everyone where they stand (arrange).
  modeEl.value = 'char';
  modeEl.onchange = () => { api.setMode(modeEl.value as 'char' | 'scene'); helpVP = k; refreshHelp(); };
  return [k, { ...api, sel: selEl, modeSel: modeEl }];
})) as Record<string, ReturnType<typeof posing.attachTile> & { sel: HTMLSelectElement; modeSel: HTMLSelectElement }>;
let maxed: Kind | null = null;
let pointerVP: Kind = 'sketch', draftVP: Kind | null = null, draftCount = 0;
/** The help box: on or off (the button in every title bar), and the view it shows in (the one being worked in). */
let helpOn = store.get('stickform.help', true), helpVP: Kind = 'sketch', helpHtml = '';

const ICON = {
  add: '<svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><rect x="3" y="4" width="18" height="16" rx="2"/><path d="M12 9v6M9 12h6"/></svg>',
  max: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M15 3h6v6M9 21H3v-6M21 3l-7 7M3 21l7-7"/></svg>',
  min: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 14h6v6M20 10h-6V4M14 10l7-7M3 21l7-7"/></svg>',
  close: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><path d="M6 6l12 12M18 6 6 18"/></svg>',
  lock: '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="5" y="11" width="14" height="10" rx="2"/><path d="M8 11V7a4 4 0 0 1 8 0v4"/></svg>',
  unlock: '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="5" y="11" width="14" height="10" rx="2"/><path d="M8 11V7a4 4 0 0 1 7.5-2"/></svg>',
  help: '<svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><circle cx="12" cy="12" r="9"/><path d="M12 7.5v5.5"/><circle cx="12" cy="16.6" r=".6" fill="currentColor"/></svg>',
  reset: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5"/><circle cx="12" cy="12" r="2.5"/></svg>',
  check: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m5 12 5 5 9-10"/></svg>',
};
for (const k of Object.keys(VP) as Kind[]) {
  const bar = VP[k].querySelector('.vpbar')!;
  const rv = el('button', { cls: 'ib', title: k === 'output' ? 'Reset view (back to the last camera preset)' : k === 'orbit' ? 'Reset view (fit to character)' : 'Reset view (zoom and pan)', innerHTML: ICON.reset });
  rv.setAttribute('aria-label', 'Reset view'); rv.onclick = () => resetView(k);
  const add = el('button', { cls: 'ib', title: 'Add viewport', innerHTML: ICON.add });
  add.setAttribute('aria-label', 'Add viewport'); add.setAttribute('aria-haspopup', 'menu');
  const mx = el('button', { cls: 'ib', title: 'Maximise', innerHTML: ICON.max }); mx.setAttribute('aria-label', 'Maximise viewport');
  const cl = el('button', { cls: 'ib', title: 'Close viewport', innerHTML: ICON.close }); cl.setAttribute('aria-label', 'Close viewport');
  add.onclick = () => addMenu(VP[k], add);
  mx.onclick = () => { maxed = maxed === k ? null : k; applyLayout(); };
  cl.onclick = () => {
    if (shown().length <= 1) { toast('Keep at least one viewport open.', true); return; }
    removeFromLayout(k); if (maxed === k) maxed = null; applyLayout();
  };
  const hb = el('button', { cls: 'ib helpbtn', title: 'Help for the active tool (shown in the view you work in)', innerHTML: ICON.help });
  hb.setAttribute('aria-label', 'Help'); hb.setAttribute('aria-pressed', 'true');
  hb.onclick = () => { helpOn = !(helpOn && helpVP === k); helpVP = k; store.set('stickform.help', helpOn); refreshHelp(); };
  bar.append(hb, rv, add, mx, cl);
  (bar as HTMLElement).dataset.k = k;
  const grip = bar.querySelector('.grip') as HTMLElement;
  grip.addEventListener('pointerdown', e => startMove(e, k));
}
const addPop = el('div', { cls: 'pop' }); addPop.setAttribute('role', 'menu'); addPop.hidden = true; addPop.style.width = '270px';
document.body.append(addPop);
/** Take a viewport out of the layout (its column closes when empty). */
function resetView(k: Kind): void {
  if (k === 'sketch') posing.frameFront();
  else if (k === 'output') { out.preset = out.preset === 'free' ? lastPreset : out.preset; refreshCams(); outVP.applyPreset(out.preset); renderAll(); }
  else if (k === 'orbit') { orbitVP.fit(undefined, 'all'); renderAll(); }
  else tileApi[k].resetView();
}
function removeFromLayout(k: Kind): void {
  const c = colOf(k); if (c < 0) return;
  layout.cols[c] = layout.cols[c].filter(x => x !== k);
  if (!layout.cols[c].length) { layout.cols.splice(c, 1); layout.colW.splice(c, 1); }
}
/** Sketch viewports in columns of their own, in grid reading order (left to right, then down). */
function sketchRegion(): { at: number; idx: number[]; items: Kind[]; w: number } {
  const idx = layout.cols.map((c, i) => c.every(SKETCHY) ? i : -1).filter(i => i >= 0);
  const items: Kind[] = [];
  for (let r = 0; r < 2 + Math.max(0, ...idx.map(i => layout.cols[i].length)); r++) for (const i of idx) if (layout.cols[i][r]) items.push(layout.cols[i][r]);
  return { at: idx.length ? idx[0] : 0, idx, items, w: idx.reduce((t, i) => t + layout.colW[i], 0) || 1 };
}
/** Lay the sketch viewports out as a grid: 1, 2 side by side, 3 or 4 as 2 × 2. */
function tileSketches(extra?: Kind): void {
  const R = sketchRegion(), items = extra ? [...R.items, extra] : R.items;
  for (const i of [...R.idx].reverse()) { layout.cols.splice(i, 1); layout.colW.splice(i, 1); }
  const n = items.length, cols: Kind[][] = n <= 1 ? [items] : n === 2 ? [[items[0]], [items[1]]] : [[items[0], items[2]], [items[1], ...(items[3] ? [items[3]] : [])]];
  const at = Math.min(R.idx.length ? R.at : 0, layout.cols.length);
  layout.cols.splice(at, 0, ...cols); layout.colW.splice(at, 0, ...cols.map(() => R.w / cols.length));
  for (const k of items) layout.rowW[k] = 1;
}
function addViewport(k: Kind, from: Kind): void {
  if (shown().includes(k)) return;
  if (SKETCHY(k) && (layout.cols[colOf(from)] || []).every(SKETCHY)) tileSketches(k);
  else if (SKETCHY(k) && !sketchRegion().idx.length) { layout.cols.unshift([k]); layout.colW.unshift(1); layout.rowW[k] = 1; }
  else if (SKETCHY(k)) tileSketches(k);
  else { const c = colOf(from) + 1; layout.cols.splice(c, 0, [k]); layout.colW.splice(c, 0, 1); layout.rowW[k] = 1; }
}
const LAYOUTS: { name: string; note: string; make: () => Layout }[] = [
  { name: 'Sketch + 3D', note: 'default', make: () => ({ ...structuredClone(DEFAULT_LAYOUT), views: layout.views }) },
  { name: 'Sketch and side + 3D', note: '', make: () => ({ cols: [['sketch'], ['view1'], ['output']], colW: [1, 1, 1.4], rowW: {}, views: { ...layout.views, view1: 'right' } }) },
  { name: '2 × 2 sketch views + 3D', note: '', make: () => ({ cols: [['sketch', 'view2'], ['view1', 'view3'], ['output']], colW: [1, 1, 1.6], rowW: {}, views: { view1: 'right', view2: 'top', view3: 'back' } }) },
  { name: '2 × 2 sketch views + two 3D', note: '', make: () => ({ cols: [['sketch', 'view2'], ['view1', 'view3'], ['output', 'orbit']], colW: [1, 1, 1.6], rowW: {}, views: { view1: 'right', view2: 'top', view3: 'back' } }) },
];
function useLayout(l: Layout): void {
  layout = l; maxed = null;
  for (const k of VIEW_KINDS) { const v = layout.views[k] || 'right'; tileApi[k].setView(v); tileApi[k].sel.value = v; }
  applyLayout();
}
function addMenu(vp: HTMLElement, btn: HTMLElement): void {
  addPop.innerHTML = '';
  addPop.append(el('div', { cls: 'ttl', textContent: 'Add viewport' }));
  const from = vp.dataset.kind as Kind;
  const open = (k: Kind) => { closePop(); addViewport(k, from); maxed = null; applyLayout(); };
  const item = (label: string, note: string, disabled: boolean, fn: () => void) => {
    const b = el('button', { cls: 'mi', disabled }, el('span', { textContent: label }), el('span', { cls: 'k', textContent: note }));
    b.setAttribute('role', 'menuitem'); b.onclick = fn; addPop.append(b);
  };
  addPop.append(el('div', { cls: 'ttl', textContent: 'Sketch views' }));
  const free = VIEW_KINDS.find(k => !shown().includes(k));
  for (const v of ['right', 'left', 'back', 'top', 'front'] as ViewId[]) {
    item(VIEWS[v].name, free ? '' : 'max 3', !free, () => {
      if (!free) return;
      layout.views[free] = v; tileApi[free].setView(v); tileApi[free].sel.value = v; open(free);
    });
  }
  const main = shown().includes('sketch');
  item(VPNAME.sketch, main ? 'open' : '', main, () => open('sketch'));
  addPop.append(el('hr'));
  addPop.append(el('div', { cls: 'ttl', textContent: '3D' }));
  for (const k of ['output', 'orbit'] as const) { const on = shown().includes(k); item(VPNAME[k], on ? 'open' : '', on, () => open(k)); }
  addPop.append(el('hr'));
  addPop.append(el('div', { cls: 'ttl', textContent: 'Layouts' }));
  for (const L of LAYOUTS) item(L.name, L.note, false, () => { closePop(); useLayout(L.make()); });
  const r = btn.getBoundingClientRect();
  addPop.style.position = 'fixed'; addPop.style.left = Math.max(8, Math.min(innerWidth - 286, r.right - 270)) + 'px';
  addPop.style.top = r.bottom + 4 + 'px'; addPop.style.maxHeight = (innerHeight - r.bottom - 16) + 'px'; addPop.style.overflowY = 'auto';
  togglePop(addPop, btn);
}
function splitter(dir: 'v' | 'h', onDown: (e: PointerEvent, s: HTMLElement) => void): HTMLElement {
  const s = el('div', { cls: dir === 'v' ? 'split' : 'hsplit', title: 'Drag to resize' }, el('span'));
  s.setAttribute('role', 'separator'); s.setAttribute('aria-orientation', dir === 'v' ? 'vertical' : 'horizontal');
  s.addEventListener('pointerdown', e => onDown(e, s));
  return s;
}
function applyLayout(): void {
  const row = $('vprow');
  for (const k of KINDS) row.append(VP[k]); // park every viewport, then rebuild the columns
  row.querySelectorAll(':scope > .split, :scope > .vcol').forEach(x => x.remove());
  const on = new Set(shown());
  for (const k of KINDS) { VP[k].hidden = !on.has(k); VP[k].classList.toggle('max', maxed === k); }
  row.classList.toggle('maxed', !!maxed);
  layout.cols.forEach((col, i) => {
    const c = el('div', { cls: 'vcol' }); c.style.flexGrow = String(layout.colW[i] || 1);
    col.forEach((k, j) => {
      VP[k].style.flexGrow = String(layout.rowW[k] || 1); c.append(VP[k]);
      if (j < col.length - 1) c.append(splitter('h', (e, s) => startResize(e, s, 'h', VP[k], VP[col[j + 1]], () => [layout.rowW[k] || 1, layout.rowW[col[j + 1]] || 1], (a, b) => { layout.rowW[k] = a; layout.rowW[col[j + 1]] = b; })));
    });
    row.append(c);
    if (i < layout.cols.length - 1) row.append(splitter('v', (e, s) => startResize(e, s, 'v', c, c.nextElementSibling!.nextElementSibling as HTMLElement, () => [layout.colW[i] || 1, layout.colW[i + 1] || 1], (a, b) => { layout.colW[i] = a; layout.colW[i + 1] = b; })));
  });
  for (const k of Object.keys(VP) as Kind[]) {
    const mx = VP[k].querySelector('.vpbar .ib[aria-label^="Maximise"], .vpbar .ib[aria-label^="Restore"]') as HTMLElement;
    mx.innerHTML = maxed === k ? ICON.min : ICON.max;
    mx.setAttribute('aria-label', maxed === k ? 'Restore viewport' : 'Maximise viewport'); mx.title = maxed === k ? 'Restore' : 'Maximise';
  }
  saveLayout();
  requestAnimationFrame(resizeAll);
}
function startResize(e: PointerEvent, s: HTMLElement, dir: 'v' | 'h', A: HTMLElement, B: HTMLElement, get: () => [number, number], set: (a: number, b: number) => void): void {
  e.preventDefault(); s.setPointerCapture(e.pointerId); s.classList.add('active'); document.body.classList.add(dir === 'v' ? 'resizing' : 'resizing-h');
  const size = (x: HTMLElement) => dir === 'v' ? x.getBoundingClientRect().width : x.getBoundingClientRect().height;
  const wa = size(A), wb = size(B), p0 = dir === 'v' ? e.clientX : e.clientY;
  const [ga, gb] = get(), total = ga + gb, MIN = dir === 'v' ? 240 : 150;
  const move = (ev: PointerEvent) => {
    const d = Math.max(MIN - wa, Math.min(wb - MIN, (dir === 'v' ? ev.clientX : ev.clientY) - p0));
    const na = (wa + d) / (wa + wb) * total;
    set(na, total - na); A.style.flexGrow = String(na); B.style.flexGrow = String(total - na);
    resizeAll();
  };
  const up = () => { s.removeEventListener('pointermove', move); s.classList.remove('active'); document.body.classList.remove('resizing', 'resizing-h'); saveLayout(); };
  s.addEventListener('pointermove', move);
  s.addEventListener('pointerup', up, { once: true }); s.addEventListener('pointercancel', up, { once: true });
}
type Zone = 'left' | 'right' | 'top' | 'bottom' | 'center';
const ZONES: Zone[] = ['left', 'right', 'top', 'bottom', 'center'];
/** Where a dragged viewport lands on another: near an edge docks it on that side, the middle swaps the two. */
function dropZone(r: DOMRect, x: number, y: number): Zone {
  const fx = (x - r.left) / r.width, fy = (y - r.top) / r.height;
  const d: [Zone, number][] = [['left', fx], ['right', 1 - fx], ['top', fy], ['bottom', 1 - fy]];
  d.sort((a, b) => a[1] - b[1]);
  return d[0][1] < 0.3 ? d[0][0] : 'center';
}
function dockViewport(k: Kind, t: Kind, z: Zone): void {
  if (k === t) return;
  if (z === 'center') { // swap
    const [ck, ct] = [colOf(k), colOf(t)], [ik, it] = [layout.cols[ck].indexOf(k), layout.cols[ct].indexOf(t)];
    layout.cols[ck][ik] = t; layout.cols[ct][it] = k;
    [layout.rowW[k], layout.rowW[t]] = [layout.rowW[t] || 1, layout.rowW[k] || 1];
    return;
  }
  removeFromLayout(k);
  const c = colOf(t);
  if (z === 'left' || z === 'right') {
    const w = (layout.colW[c] || 1) / 2; layout.colW[c] = w;
    const at = c + (z === 'right' ? 1 : 0);
    layout.cols.splice(at, 0, [k]); layout.colW.splice(at, 0, w); layout.rowW[k] = 1;
  } else {
    const w = (layout.rowW[t] || 1) / 2; layout.rowW[t] = w; layout.rowW[k] = w;
    layout.cols[c].splice(layout.cols[c].indexOf(t) + (z === 'bottom' ? 1 : 0), 0, k);
  }
}
function startMove(e: PointerEvent, k: Kind): void {
  if (e.button !== 0 || maxed) return;
  const grip = e.currentTarget as HTMLElement;
  e.preventDefault(); grip.setPointerCapture(e.pointerId);
  let target: { k: Kind; z: Zone } | null = null, moved = false;
  const clear = () => Object.values(VP).forEach(v => v.classList.remove(...ZONES.map(z => 'drop-' + z)));
  const move = (ev: PointerEvent) => {
    if (!moved) { moved = true; VP[k].classList.add('dragging'); document.body.classList.add('moving'); }
    clear(); target = null;
    for (const o of shown()) {
      if (o === k) continue;
      const r = VP[o].getBoundingClientRect();
      if (ev.clientX >= r.left && ev.clientX <= r.right && ev.clientY >= r.top && ev.clientY <= r.bottom) {
        const z = dropZone(r, ev.clientX, ev.clientY);
        target = { k: o, z }; VP[o].classList.add('drop-' + z);
      }
    }
  };
  const up = () => {
    grip.removeEventListener('pointermove', move);
    clear(); VP[k].classList.remove('dragging'); document.body.classList.remove('moving');
    if (target) { const t = target as { k: Kind; z: Zone }; dockViewport(k, t.k, t.z); applyLayout(); }
  };
  grip.addEventListener('pointermove', move);
  grip.addEventListener('pointerup', up, { once: true }); grip.addEventListener('pointercancel', up, { once: true });
}
function resizeAll(): void {
  if (!$('editbar').hidden) refreshDrafts();
  refreshHelp();
  canvas.draw();
  outVP.resize(); orbitVP.resize(); posing.drawTiles();
  if (out.preset !== 'free') outVP.applyPreset(out.preset);
  renderAll();
  refreshSelection();
}
for (const v of Object.values(VP)) new ResizeObserver(() => resizeAll()).observe(v);

// ---------------------------------------------------------------- sketch tools
function setTool(t: Tool): void {
  canvas.tool = t;
  document.querySelectorAll<HTMLElement>('.rail [data-tool]').forEach(b => b.setAttribute('aria-pressed', String(b.dataset.tool === t)));
  $('paper').className = 'paper t-' + t;
  outVP.setEditMode(t === 'edit'); orbitVP.setEditMode(t === 'edit');
  document.querySelectorAll('.stage3d').forEach(s => s.classList.toggle('editing', t === 'edit'));
  if (t !== 'edit') posing.target = null;
  if (t !== 'select') posing.sel = null;
  for (const k of VIEW_KINDS) VP[k].querySelector('.paper')!.className = 'paper t-' + (t === 'select' ? 'select' : 'edit');
  renderAll(); posing.drawTiles(); refreshPoseCard(); refreshStatus();
  if (t !== 'brush' && openPop?.pop === $('brushpop')) closePop();
  canvas.draw();
}
document.querySelectorAll<HTMLElement>('.rail [data-tool]').forEach(b => {
  b.onclick = () => {
    const t = b.dataset.tool as Tool;
    if (t === 'brush') { setTool('brush'); fillBrush(); togglePop($('brushpop'), b); return; }
    setTool(t);
  };
});
function fillBrush(): void {
  const p = $('brushpop'); p.innerHTML = '';
  p.append(el('div', { cls: 'ttl', textContent: 'Paint as' }));
  ORDER.forEach((t, i) => {
    const b = el('button', { cls: 'mi' }, el('span', { cls: 'dot' }), el('span', { textContent: LABEL[t] }), el('span', { cls: 'k', textContent: String(i + 1) }));
    (b.firstChild as HTMLElement).style.background = COLOR[t];
    b.setAttribute('role', 'menuitemradio'); b.setAttribute('aria-checked', String(canvas.brush === t));
    b.onclick = () => { canvas.brush = t; $('brushdot').style.background = COLOR[t]; closePop(); };
    p.append(b);
  });
  p.append(el('div', { cls: 'note', textContent: 'Each brush stroke replaces the stroke that held that tag.' }));
}
$('brushdot').style.background = COLOR[canvas.brush];

function mirror(): void {
  if (!sketch.strokes.length || lockedBlock()) return;
  canvas.snapshot();
  let x0 = Infinity, x1 = -Infinity;
  for (const s of sketch.strokes) for (const q of s.pts) { x0 = Math.min(x0, q.x); x1 = Math.max(x1, q.x); }
  const c = x0 + x1;
  for (const s of sketch.strokes) {
    s.pts = s.pts.map(q => ({ x: c - q.x, y: q.y }));
    if (s.whole) s.whole = s.whole.map(q => ({ x: c - q.x, y: q.y }));
    if (s.lock && s.tag && MIRROR[s.tag]) s.tag = MIRROR[s.tag]!;
  }
  const f = sketch.flips;
  sketch.flips = { ...f, armL: f.armR, armR: f.armL, legL: f.legR, legR: f.legL };
  posing.mirrorState();
  sketch.classify();
  markDirty(); update();
}
$('mirror').onclick = mirror;
function toggleAway(): void { if (lockedBlock()) return; canvas.snapshot(); sketch.away = !sketch.away; sketch.classify(); markDirty(); update(); }
$('away').onclick = toggleAway;
$('clear').onclick = () => {
  if (!sketch.strokes.length && pending.length) { canvas.snapshot(); pending = []; markDirty(); update(); toast('Unfinished figure cleared. Undo brings it back.'); return; }
  if (!sketch.strokes.length || lockedBlock()) return;
  canvas.snapshot();
  pending = []; active.reg = null; if (actors.length === 1) pageMap = null;
  sketch.strokes = []; sketch.flips = {}; sketch.away = false; sketch.lastSpine = null; canvas.selected = null;
  sketch.depth = { z: {} }; posing.reset();
  currentPreset = null; fillThumbs(); markDirty(); update();
  toast('Sketch cleared. Undo brings it back.');
};

// ---------------------------------------------------------------- new figures become new characters
// With the pen, a stroke away from the character being edited (and from the other characters' faint figures) starts
// a new figure. Its strokes wait, drawn faintly, until they make a head and a spine: then they become a new character
// (a mannequin) standing where it was drawn, beside the others, at normal size (size never comes from the drawing;
// Scale in the Pose card sets it). That character is then the one being edited, so its arms and legs land on it.
// A stroke on another character's faint figure goes to that character.
type P2n = { x: number; y: number };
/** Is a stroke touching a drawing: within `r` of its lines, or starting inside one of its loops (a facing tick)? */
function touches(pts: P2n[], lines: P2n[][], r: number): boolean {
  for (const l of lines) {
    if (l.length === 1) { if (pts.some(q => Math.hypot(q.x - l[0].x, q.y - l[0].y) < r)) return true; continue; }
    for (const q of pts) if (dpoly(q, l)[0] < r) return true;
    if (isLoop(l) && (inPoly(pts[0], l) || inPoly(pts[pts.length - 1], l))) return true;
  }
  return false;
}
const extent = (lines: P2n[][]) => { const all = lines.flat(); if (!all.length) return 0; const xs = all.map(q => q.x), ys = all.map(q => q.y); return Math.max(Math.max(...xs) - Math.min(...xs), Math.max(...ys) - Math.min(...ys)); };
/** How close counts as touching for a drawing of this size (the tagger's own reach, a little more). */
const touchReach = (lines: P2n[][]) => Math.max(0.05, 2.5 * sketch.snap * Math.max(0.35, Math.min(1, extent(lines) / 0.6)) * 1.25);
/** The other characters' faint figures in the front sketch, as page polylines (their strokes, joints, head). */
function ghostLines(): { id: number; lines: P2n[][] }[] {
  return othersFront().map(o => ({ id: o.id, lines: [...o.strokes, ...(o.J ? [...Object.values(BONE_JOINTS).map(([a, b]) => [o.pg(o.J![a] as V3n), o.pg(o.J![b] as V3n)]), [o.pg(o.J.H as V3n)]] : [])] }));
}
/** Pending strokes in groups that touch each other (one group per figure taking shape). */
function pendGroups(): Pend[][] {
  const groups: Pend[][] = [];
  for (const s of pending) {
    const hit = groups.filter(g => touches(s.pts, g.map(x => x.pts), touchReach(g.map(x => x.pts))) || g.some(x => touches(x.pts, [s.pts], touchReach([s.pts, ...g.map(y => y.pts)]))));
    const merged = [s, ...hit.flat()];
    for (const h of hit) groups.splice(groups.indexOf(h), 1);
    groups.push(merged);
  }
  return groups;
}
/** The page anchor (made from the character being edited the first time it is needed). */
function anchor(): PageMap | null {
  if (pageMap) return pageMap;
  const F = J && FRAME.get(J), A = figFrame(active); if (!F || !A) return null;
  pageMap = { px: F.o.x, py: F.o.y, wx: A.hips.x, wy: A.hips.y, wz: A.hips.z, m: A.k * F.s };
  return pageMap;
}
const placeOfA = (a: Actor) => a === active ? posing.place : a.data!.place;
/** Where a character's drawing sits on the shared page right now (its own page offset plus how far it has been
 *  moved in 3D since). */
function pageOff(a: Actor): [number, number] | null {
  const M = anchor(); if (!M) return null;
  if (!a.reg) {
    const Jx = a === active ? J : a.J, F = Jx && FRAME.get(Jx), A = figFrame(a); if (!F || !A) return null;
    a.reg = { p: [...placeOfA(a).p] as V3n, d: [M.px + (A.hips.x - M.wx) / M.m - F.o.x, M.py - (A.hips.y - M.wy) / M.m - F.o.y] };
  }
  const p = placeOfA(a).p;
  return [a.reg.d[0] + (p[0] - a.reg.p[0]) / M.m, a.reg.d[1] - (p[1] - a.reg.p[1]) / M.m];
}
/** The other characters as drawn, in the front sketch: their own strokes where they were drawn (shifted only when
 *  they were moved in 3D), their stick figures for picking and Reach to…, and the way back to the world. */
function othersFront(): FrontOther[] {
  if (!actors.some(b => b !== active && b.visible)) return [];
  const da = pageOff(active) ?? [0, 0], out: FrontOther[] = [];
  for (const b of actors) {
    if (b === active || !b.visible) continue;
    const db = pageOff(b), Fb = b.J && FRAME.get(b.J), FB = figFrame(b);
    if (!db || !Fb) continue;
    const off: [number, number] = [db[0] - da[0], db[1] - da[1]];
    const pg = (X: V3n): P2n => ({ x: Fb.o.x + off[0] + X[0] / Fb.s, y: Fb.o.y + off[1] - X[1] / Fb.s });
    out.push({ id: b.id, name: b.name, color: inkOf(b), off, J: b.J, pg,
      strokes: (b.data?.strokes || []).map(st => st.pts.map(q => ({ x: q.x + off[0], y: q.y + off[1] }))),
      w: X => FB ? FB.toW(new THREE.Vector3(...X)).add(FB.hips) : null });
  }
  return out;
}
/** The pen tool's finished stroke: the active character's, another character's, or part of a new figure. */
function routeStroke(pts: P2n[]): boolean {
  if (!autoSplit) return false;
  const mine = sketch.strokes.map(s => s.pts);
  if (mine.length && touches(pts, mine, touchReach(mine))) return false; // on this character's drawing
  const groups = pendGroups();
  const joins = groups.find(g => touches(pts, g.map(x => x.pts), touchReach(g.map(x => x.pts))));
  if (!joins) {
    // on another character's faint figure: it goes to that one
    const g = ghostLines().find(o => touches(pts, o.lines, touchReach(o.lines)));
    const b = g && actors.find(a => a.id === g.id), fo = g && othersFront().find(o => o.id === g.id);
    const map = fo ? (q: P2n) => ({ x: q.x - fo.off[0], y: q.y - fo.off[1] }) : null;
    if (b && map) {
      if (b.data?.locked) { toast(`${b.name} is locked. Unlock it to draw on it.`, true); return true; }
      canvas.snapshot(); activate(b);
      sketch.add(pts.map(map), null);
      markDirty(); update(); toast(`Drawn on ${b.name}.`);
      return true;
    }
    if (!mine.length) return false; // nothing drawn yet: this is the figure being edited
  }
  canvas.snapshot();
  pending.push({ id: nextPend++, pts });
  const grp = pendGroups().find(g => g.some(x => x.pts === pts))!;
  if (!promote(grp)) { markDirty(); canvas.draw(); refreshStatus(); refreshHelp(); }
  return true;
}
/** A figure taking shape becomes a character once it has a head and a spine. */
function promote(grp: Pend[]): boolean {
  const k = new Sketch(); k.snap = sketch.snap;
  for (const s of grp) k.strokes.push({ id: k.nid++, pts: s.pts, tag: null, lock: false });
  k.classify();
  const t = k.byTag(); if (!t.head || !t.spine) return false;
  const Jn = lift(t, {}, false, { depth: k.depth, ordered: {} }), Fn = Jn && FRAME.get(Jn);
  if (!Jn || !Fn) return false;
  pending = pending.filter(x => !grp.includes(x));
  const q: Quat = [0, 0, 0, 1]; // facing the front, as drawn
  const da = pageOff(active), M = anchor();
  const data: ActorData = { strokes: k.strokes, nid: k.nid, flips: {}, away: false, snap: sketch.snap, depth: k.depth, pins: [], locked: false, contacts: [],
    place: { p: [0, 0, 0], q, s: [1, 1, 1] } };
  const a = makeActor(freeName(), makeMannequin(), freeTint());
  a.data = data; actors.push(a); stage.addGroup(a.group);
  poseOne(a);
  // where it was drawn, through the scene's page anchor: left/right and up/down as drawn (in the air if drawn
  // above, lower if drawn below), at normal size; its drawing stays exactly where it is on the page
  const h0 = a.rig.bones.hips?.getWorldPosition(new THREE.Vector3()) ?? new THREE.Vector3();
  let target: THREE.Vector3;
  const off = da ?? [0, 0];
  if (M) target = new THREE.Vector3(M.wx + (Fn.o.x + off[0] - M.px) * M.m, M.wy - (Fn.o.y + off[1] - M.py) * M.m, rig.bones.hips?.getWorldPosition(new THREE.Vector3()).z ?? M.wz);
  else { // the character being edited has no figure yet: the new one becomes the anchor where the first one stands
    const hx = rig.bones.hips?.getWorldPosition(new THREE.Vector3()) ?? new THREE.Vector3();
    target = new THREE.Vector3(hx.x + 0.7, h0.y, hx.z);
  }
  data.place.p = [+(target.x - h0.x).toFixed(4), +(target.y - h0.y).toFixed(4), +(target.z - h0.z).toFixed(4)];
  a.reg = { p: [...data.place.p] as V3n, d: [off[0], off[1]] };
  a.posed = null;
  activate(a);
  markDirty(); update();
  toast(`${a.name} added for the new figure, standing where you drew it (Ctrl Z undoes it).`);
  return true;
}
canvas.route = pts => routeStroke(pts);
canvas.pendingDraw = (x, P) => {
  if (!pending.length) return;
  x.save(); x.lineCap = 'round'; x.lineJoin = 'round'; x.strokeStyle = '#8f8b80'; x.globalAlpha = 0.85; x.lineWidth = 2.6; x.setLineDash([4, 4]);
  for (const s of pending) { x.beginPath(); s.pts.forEach((q, i) => { const o = P(q); if (i) x.lineTo(o.x, o.y); else x.moveTo(o.x, o.y); }); x.stroke(); }
  x.setLineDash([]); x.globalAlpha = 0.8; x.fillStyle = '#6b6a66'; x.font = '600 11px Inter, system-ui, sans-serif';
  for (const g of pendGroups()) {
    const all = g.flatMap(s => s.pts), top = all.reduce((m, q) => (q.y < m.y ? q : m), all[0]), o = P(top);
    x.textAlign = 'center'; x.fillText('new figure: add a head and a spine', o.x, o.y - 12);
  }
  x.restore();
};
canvas.eraseExtra = (p, reach) => {
  let best: Pend | null = null, bd = reach;
  for (const s of pending) { const d = dpoly(p, s.pts)[0]; if (d < bd) { bd = d; best = s; } }
  if (!best) return false;
  canvas.snapshot(); pending = pending.filter(s => s !== best); markDirty();
  return true;
};
$('st-split').onclick = () => { autoSplit = !autoSplit; setSwitch('st-split', autoSplit); store.set('stickform.autoSplit', autoSplit); };
$<HTMLInputElement>('snap').oninput = e => {
  const v = +(e.target as HTMLInputElement).value;
  sketch.snap = v / 100; $('snapv').textContent = String(v);
  sketch.classify(); update();
};
function syncSnap(): void { const v = Math.round(sketch.snap * 200) / 2; $<HTMLInputElement>('snap').value = String(v); $('snapv').textContent = String(v); }

// ---------------------------------------------------------------- status line
function refreshStatus(): void {
  const st = $('status'); st.innerHTML = '';
  const n = sketch.strokes.length, un = sketch.strokes.filter(s => !s.tag);
  const dot = (c: string) => { const d = el('span', { cls: 'dot' }); d.style.background = c; return d; };
  if (posing.match && J) { st.append(dot(EDIT_COLOR), `Click the part to make it ${posing.match === 'parallel' ? 'parallel' : 'square'} to (Esc cancels)`); return; }
  if (posing.reaching && J) { st.append(dot(EDIT_COLOR), `Click where the ${posing.reaching.startsWith('arm') ? 'hand' : 'foot'} should ${posing.reachAttach ? 'hold on' : 'go'} (Esc cancels)`); return; }
  if (actors.length > 1) st.append(dot(active.tint), `${active.name} · `);
  if (canvas.tool === 'edit' && J) {
    const h = posing.target ?? posing.hover?.part;
    st.append(dot(EDIT_COLOR), h ? `Edit pen · ${PART_NAME[h]}${posing.target ? ' (picked)' : ''}: draw its new shape · Shift snaps` : 'Edit pen: start a guide on any part, here, in a side view or in 3D');
    return;
  }
  if (!n) { st.append(dot('#b9b5aa'), 'Draw a head, then the spine'); return; }
  if (!J) { st.append(dot('#d9a21b'), `${n} stroke${n > 1 ? 's' : ''} · needs a spine to pose`); return; }
  if (un.length) {
    const b = el('button', { textContent: 'Show' });
    b.onclick = () => { setTool('select'); canvas.selected = un[0].id; canvas.draw(); refreshSelection(); };
    st.append(dot('#d9a21b'), `${n} strokes · ${un.length} untagged`, b);
    return;
  }
  st.append(dot('#2e9e6b'), `${n} stroke${n > 1 ? 's' : ''} · all tagged`);
}

// ---------------------------------------------------------------- selection pill and retag
function selectedStroke() { return sketch.strokes.find(s => s.id === canvas.selected) || null; }
function refreshSelection(): void {
  const s = selectedStroke(), pill = $('pill');
  if (!s) {
    if (canvas.selected !== null) canvas.selected = null;
    pill.hidden = true; if (openPop?.pop === $('retagpop')) closePop();
    return;
  }
  pill.hidden = false;
  $('pilldot').style.background = s.tag ? COLOR[s.tag] : '#b9b5aa';
  $('pillname').textContent = s.tag ? LABEL[s.tag] : 'Ignored';
  $('pillhow').textContent = s.lock ? 'set' : 'auto';
  $('pillhow').title = s.lock ? 'Tag set by you' : 'Tag guessed from the drawing';
  $<HTMLButtonElement>('pillswap').disabled = !(s.tag && MIRROR[s.tag]);
  placePill();
}
function placePill(): void {
  const s = selectedStroke(); if (!s) return;
  const box = canvas.strokeBox(s.id)!, pill = $('pill'), paper = $('paper');
  const pw = pill.offsetWidth, ph = pill.offsetHeight, W = paper.clientWidth, H = paper.clientHeight;
  let left = (box.x0 + box.x1) / 2 - pw / 2, top = box.y1 + 12;
  if (top + ph > H - 56) top = box.y0 - ph - 12;
  left = Math.max(8, Math.min(W - pw - 8, left)); top = Math.max(8, Math.min(H - ph - 8, top));
  pill.style.left = left + 'px'; pill.style.top = top + 'px';
  const pop = $('retagpop');
  if (!pop.hidden) {
    const popH = pop.offsetHeight, popW = pop.offsetWidth;
    let pt = top + ph + 6; if (pt + popH > H - 8) pt = top - popH - 6;
    pop.style.left = Math.max(8, Math.min(W - popW - 8, left)) + 'px'; pop.style.top = Math.max(8, pt) + 'px';
  }
}
/** The whole character is locked: say so and refuse the change. */
function lockedBlock(): boolean { if (!posing.locked) return false; posing.lockedNotice(); return true; }
function pinnedStroke(s: { tag: Tag | null } | null): boolean {
  if (s && lockedBlock()) return true;
  const p = s?.tag ? TAG_PART[s.tag] : null;
  if (p && posing.pins.has(p)) { toast(`${PART_NAME[p]} is pinned. Unpin it to change it.`, true); return true; }
  return false;
}
function retagSelected(t: Tag | null): void {
  const s = selectedStroke(); if (!s || pinnedStroke(s)) return;
  canvas.snapshot(); sketch.retag(s.id, t); closePop(); markDirty(); update();
}
function fillRetag(): void {
  const s = selectedStroke(), p = $('retagpop'); p.innerHTML = '';
  ORDER.forEach((t, i) => {
    const b = el('button', { cls: 'rt' }, el('span', { cls: 'dot' }), el('span', { textContent: SHORT[t] }), el('span', { cls: 'k', textContent: String(i + 1) }));
    (b.firstChild as HTMLElement).style.cssText = `width:10px;height:10px;border-radius:50%;flex:0 0 auto;background:${COLOR[t]}`;
    b.setAttribute('role', 'menuitemradio'); b.setAttribute('aria-checked', String(s?.tag === t));
    if (s?.tag === t) b.style.borderColor = COLOR[t];
    b.onclick = () => retagSelected(t);
    p.append(b);
  });
  const ign = el('button', { cls: 'ign', innerHTML: 'Ignore this stroke <kbd style="margin-left:6px">0</kbd>' });
  ign.onclick = () => retagSelected(null);
  p.append(ign);
}
$('pillretag').onclick = () => { fillRetag(); if (togglePop($('retagpop'), $('pillretag'))) placePill(); };
$('pillswap').onclick = () => { const s = selectedStroke(); if (s?.tag && MIRROR[s.tag]) retagSelected(MIRROR[s.tag]!); };
$('pilldel').onclick = () => deleteSelected();
function deleteSelected(): void {
  const s = selectedStroke(); if (!s || pinnedStroke(s)) return;
  canvas.snapshot(); sketch.remove(s.id); canvas.selected = null; closePop(); markDirty(); update();
}

// ---------------------------------------------------------------- per-limb depth slot (interim flips)
const FLIPS: [keyof Sketch['flips'], string, Tag][] = [['armL', 'Arm L', 'armL'], ['armR', 'Arm R', 'armR'], ['legL', 'Leg L', 'legL'], ['legR', 'Leg R', 'legR'], ['sh', 'Shoulders', 'sh'], ['hip', 'Hips', 'hip'], ['head', 'Head', 'head']];
function refreshFlips(): void {
  const f = $('flips'); f.innerHTML = '';
  for (const [k, l, t] of FLIPS) {
    const d = el('span', { cls: 'dot' }); d.style.background = COLOR[t];
    const b = el('button', { title: `Flip ${l.toLowerCase()} toward or away from you` }, d, 'Flip ' + l);
    b.setAttribute('aria-pressed', String(!!sketch.flips[k]));
    b.onclick = () => {
      const part: Part = k === 'head' ? 'face' : k as Part, bones = PART_BONES[part];
      if (lockedBlock()) return;
      if (posing.pins.has(part)) { toast(`${PART_NAME[part]} is pinned. Unpin it to change it.`, true); return; }
      canvas.snapshot();
      if (bones.some(bk => sketch.depth.z[bk] !== undefined)) for (const bk of bones) { const z = sketch.depth.z[bk]; if (z !== undefined) sketch.depth.z[bk] = -z; }
      else sketch.flips[k] = !sketch.flips[k];
      markDirty(); update();
    };
    f.append(b);
  }
}

// ---------------------------------------------------------------- 3D viewport: camera, overlay, frame
function refreshCams(): void {
  document.querySelectorAll<HTMLElement>('#cams button').forEach(b => b.setAttribute('aria-pressed', String(b.dataset.cam === out.preset)));
  VP.output.querySelector('.vpsub')!.textContent = out.preset === 'free' ? 'Output camera · free' : 'Output camera';
}
document.querySelectorAll<HTMLElement>('#cams button').forEach(b => {
  b.onclick = () => { out.preset = b.dataset.cam as CamPreset; if (out.preset !== 'free') lastPreset = out.preset; refreshCams(); if (out.preset !== 'free') outVP.applyPreset(out.preset); renderAll(); };
});
$('overlay').onclick = () => { stage.showOverlay = !stage.showOverlay; $('overlay').setAttribute('aria-pressed', String(stage.showOverlay)); renderAll(); };
function placeFrame(): void {
  const f = outVP.frame(), fr = $('frame');
  Object.assign(fr.style, { left: f.x + 'px', top: f.y + 'px', width: f.w + 'px', height: f.h + 'px' });
}
$('orbitfit').onclick = () => { orbitVP.fit(); orbitVP.render(); };

// ---------------------------------------------------------------- output settings
const SIZES: Record<string, [number, number][]> = {
  '1:1': [[1024, 1024], [1536, 1536], [2048, 2048]],
  '2:3': [[832, 1248], [1024, 1536], [1344, 2016]],
  '3:2': [[1248, 832], [1536, 1024], [2016, 1344]],
  '9:16': [[864, 1536], [1152, 2048]],
  '16:9': [[1536, 864], [1920, 1080], [2048, 1152]],
};
/** Custom sizes: any width and height in this range (pixels). */
const OUT_MIN = 64, OUT_MAX = 4096;
const BGS: { id: Background; name: string; fill: string }[] = [
  { id: 'white', name: 'White', fill: '#ffffff' }, { id: 'grey', name: 'Grey', fill: '#b8b8b8' },
  { id: 'dark', name: 'Dark', fill: '#2a2a2a' }, { id: 'transparent', name: 'Transparent', fill: 'repeating-conic-gradient(#9a9da5 0 25%, #e8e8ea 0 50%) 50% / 10px 10px' },
];
const aspectOf = (w: number, h: number) => Object.keys(SIZES).find(k => { const [a, b] = k.split(':').map(Number); return Math.abs(w / h - a / b) < 0.005; }) || null;
function setOutputSize(w: number, h: number): void { out.w = w; out.h = h; refreshOutput(); if (out.preset !== 'free') outVP.applyPreset(out.preset); renderAll(); }
function refreshOutput(): void {
  const asp = aspectOf(out.w, out.h);
  const chips = $('aspects'); chips.innerHTML = '';
  for (const k of Object.keys(SIZES)) {
    const b = el('button', { textContent: k }); b.setAttribute('aria-pressed', String(asp === k));
    b.onclick = () => { const [w, h] = SIZES[k][0]; setOutputSize(w, h); };
    chips.append(b);
  }
  const sel = $<HTMLSelectElement>('osize'); sel.innerHTML = '';
  const list = asp ? [...SIZES[asp]] : [];
  if (!list.some(([w, h]) => w === out.w && h === out.h)) list.unshift([out.w, out.h]);
  for (const [w, h] of list) sel.append(el('option', { value: `${w}x${h}`, textContent: `${w} × ${h}` }));
  sel.value = `${out.w}x${out.h}`;
  if (document.activeElement !== $('ow')) $<HTMLInputElement>('ow').value = String(out.w);
  if (document.activeElement !== $('oh')) $<HTMLInputElement>('oh').value = String(out.h);
  const sw = $('bgs'); sw.innerHTML = '';
  for (const b of BGS) {
    const e = el('button', { title: b.name }); e.style.background = b.fill;
    e.setAttribute('aria-label', b.name); e.setAttribute('aria-pressed', String(out.background === b.id));
    e.onclick = () => { out.background = b.id; refreshOutput(); renderAll(); };
    sw.append(e);
  }
  $('oshadow').setAttribute('aria-checked', String(out.shadow));
  const bg = BGS.find(b => b.id === out.background)!;
  const s = $('summary'); s.innerHTML = '';
  const swatch = el('span', { cls: 'sw' }); swatch.style.background = bg.fill;
  s.append(el('span', { cls: 'mono', textContent: `${out.w} × ${out.h}` }), el('span', { cls: 'vs' }),
    (() => { const x = el('span', {}, swatch, bg.name); x.style.cssText = 'display:flex;align-items:center;gap:6px'; return x; })(), el('span', { cls: 'vs' }),
    el('span', { textContent: out.shadow ? 'Shadow' : 'No shadow' }));
}
$<HTMLSelectElement>('osize').onchange = e => { const [w, h] = (e.target as HTMLSelectElement).value.split('x').map(Number); setOutputSize(w, h); };
// Custom size: type a width and height (Enter or leaving the box applies it).
function applyCustomSize(): void {
  const w = Math.round(Number($<HTMLInputElement>('ow').value)), h = Math.round(Number($<HTMLInputElement>('oh').value));
  if (!isFinite(w) || !isFinite(h) || w < OUT_MIN || h < OUT_MIN || w > OUT_MAX || h > OUT_MAX) {
    toast(`Width and height must be ${OUT_MIN} to ${OUT_MAX} pixels.`, true); refreshOutput(); return;
  }
  if (w !== out.w || h !== out.h) setOutputSize(w, h);
}
for (const id of ['ow', 'oh']) {
  const i = $<HTMLInputElement>(id);
  i.addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); applyCustomSize(); i.select(); } if (e.key === 'Escape') { refreshOutput(); i.blur(); } e.stopPropagation(); });
  i.addEventListener('change', applyCustomSize);
}
$('oswap').onclick = () => setOutputSize(out.h, out.w);
$('oshadow').onclick = () => { out.shadow = !out.shadow; refreshOutput(); renderAll(); };
$('summary').onclick = () => {
  const c = $('outcard'); c.scrollIntoView({ block: 'nearest' }); c.classList.remove('flash'); void c.offsetWidth; c.classList.add('flash');
  (c.querySelector('button[aria-pressed="true"]') as HTMLElement | null)?.focus();
};

// ---------------------------------------------------------------- render
interface RenderItem { url: string; name: string; rig: string; w: number; h: number; bg: string; at: Date }
const renders: RenderItem[] = [];
async function renderPNG(): Promise<void> {
  if (!J) { toast('Draw a figure with a spine first.', true); return; }
  if (out.preset !== 'free') outVP.applyPreset(out.preset);
  const url = outVP.renderPNG();
  const t = new Date(), p2 = (n: number) => String(n).padStart(2, '0');
  const stamp = `${t.getFullYear()}${p2(t.getMonth() + 1)}${p2(t.getDate())}-${p2(t.getHours())}${p2(t.getMinutes())}${p2(t.getSeconds())}`;
  const shown = actors.filter(a => a.visible).length;
  const base = `stickform-${slug(poseName)}-${shown > 1 ? shown + '-characters' : slug(rig.name.replace(/\.(glb|gltf|vrm)$/i, ''))}-${stamp}`;
  // Two renders in the same second get -2, -3, … so neither replaces the other.
  let name = base + '.png';
  for (let i = 2; renders.some(r => r.name === name) || (project.connected && !askSave && await project.exists('renders', name)); i++) name = `${base}-${i}.png`;
  const blob = dataUrlToBlob(url);
  if (askSave) {
    const ok = await saveAs(name, blob, { description: 'PNG image', accept: { 'image/png': ['.png'] } });
    if (ok === false) { toast('Render not saved.'); return; }
    if (ok === null) download(name, url);
    toast(`Saved ${name}`);
  } else if (project.connected) {
    try { await project.write('renders', name, blob); toast(`Saved to renders/${name}`); }
    catch (e) { download(name, url); toast(`Could not write to renders/ (${(e as Error).message}); downloaded instead.`, true); }
  } else { download(name, url); toast(`Rendered ${name}`); }
  renders.unshift({ url, name, rig: shown > 1 ? `${shown} characters` : rig.name, w: out.w, h: out.h, bg: BGS.find(b => b.id === out.background)!.name, at: t });
  $('tab-renders').textContent = `Renders · ${renders.length}`;
  if (!$('ws-renders').hidden) void fillRenders();
}
$('render').onclick = () => void renderPNG();
let renderUrls: string[] = [];
/** One card in the Renders tab: a file in renders/ (folder) or a render from this session (no folder). */
type RCard = { url: string; name: string; title: string; meta: string; size?: number; src: 'folder' | 'session' };
let rcards: RCard[] = [];
let rsel: string | null = null;
const rTitle = (name: string) => { const m = name.match(/^stickform-(.+)-(\d{8})-(\d{6})(?:-\d+)?\.png$/i); return m ? m[1] : name.replace(/\.png$/i, ''); };
async function fillRenders(): Promise<void> {
  const g = $('rgrid');
  renderUrls.forEach(u => URL.revokeObjectURL(u)); renderUrls = [];
  if (project.connected) {
    const files = (await project.list('renders', ['.png'])).slice(0, 300);
    rcards = await Promise.all(files.map(async f => {
      let u = f.url; if (!u) { u = URL.createObjectURL(await f.read()); renderUrls.push(u); }
      return { url: u, name: f.name, title: rTitle(f.name), meta: `${new Date(f.lastModified).toLocaleString()} · ${(f.size / 1024).toFixed(0)} KB`, size: f.size, src: 'folder' as const }; }));
    $('rnote').textContent = `In renders/ of your project folder (${project.name}). Newest first. Click to select, double-click to preview.`;
  } else {
    rcards = renders.map(r => ({ url: r.url, name: r.name, title: rTitle(r.name), meta: `${r.w} × ${r.h} · ${r.bg} · ${r.at.toLocaleTimeString()}`, src: 'session' as const }));
    $('rnote').textContent = 'This session. Each PNG was also saved to your downloads (rename and delete change this list only). Connect your project folder to keep renders in renders/.';
  }
  if (rsel && !rcards.some(c => c.name === rsel)) rsel = null;
  g.innerHTML = '';
  $('rempty').hidden = rcards.length > 0; $<HTMLButtonElement>('rclear').disabled = !renders.length; $('rclear').hidden = project.connected;
  for (const r of rcards) {
    const card = el('button', { cls: 'rcard', title: r.name },
      el('div', { cls: 'img' }, el('img', { src: r.url, alt: `Render ${r.name}` })),
      el('div', { cls: 'meta' }, el('b', { textContent: r.title }), el('span', { textContent: r.meta })));
    card.dataset.name = r.name;
    card.setAttribute('aria-current', String(r.name === rsel));
    card.onclick = () => selectRender(r.name);
    card.ondblclick = () => openPreview(r.name);
    g.append(card);
  }
  refreshRenderActions();
  if (pvName && $<HTMLDialogElement>('dlg-preview').open) showPreview(rcards.some(c => c.name === pvName) ? pvName : null);
}
function selectRender(name: string | null): void {
  rsel = name;
  document.querySelectorAll<HTMLElement>('#rgrid .rcard').forEach(c => c.setAttribute('aria-current', String(c.dataset.name === name)));
  refreshRenderActions();
}
function refreshRenderActions(): void {
  for (const id of ['rprev', 'rren', 'rdel', 'rdl']) $<HTMLButtonElement>(id).disabled = !rsel;
}
/** Rename a render (asks for the new name). Returns the new file name, or null. */
async function renameRender(name: string): Promise<string | null> {
  const c = rcards.find(x => x.name === name); if (!c) return null;
  const n = (await askText('Rename render', name.replace(/\.png$/i, ''), 'Rename'))?.trim();
  if (!n) return null;
  if (/[\\/:*?"<>|\x00-\x1f]/.test(n) || n.startsWith('.')) { toast('A file name cannot contain \\ / : * ? " < > | or start with a dot.', true); return null; }
  const to = n.replace(/\.png$/i, '') + '.png';
  if (to === name) return null;
  if (rcards.some(x => x.name.toLowerCase() === to.toLowerCase() && x.name !== name)) { toast(`A render called ${to} already exists.`, true); return null; }
  if (c.src === 'folder') {
    try { await project.rename('renders', name, to); } catch (e) { toast((e as Error).message, true); return null; }
    toast(`Renamed to renders/${to}`);
  } else {
    const r = renders.find(x => x.name === name); if (r) r.name = to;
    toast(`Renamed to ${to} (in this list; downloads you already have keep their old name).`);
  }
  if (rsel === name) rsel = to;
  if (pvName === name) pvName = to;
  await fillRenders();
  return to;
}
/** Delete a render (asks first). Returns whether it was deleted. */
async function deleteRender(name: string): Promise<boolean> {
  const c = rcards.find(x => x.name === name); if (!c) return false;
  if (c.src === 'folder') {
    if (!(await askConfirm('Delete this render?', `renders/${name} will be deleted from your project folder.`, 'Delete'))) return false;
    try { await project.remove('renders', name); } catch (e) { toast((e as Error).message, true); return false; }
    toast(`Deleted renders/${name}`);
  } else {
    if (!(await askConfirm('Remove this render?', `${name} will be removed from this list. A copy you already downloaded stays in your downloads.`, 'Remove'))) return false;
    const i = renders.findIndex(x => x.name === name); if (i >= 0) renders.splice(i, 1);
    $('tab-renders').textContent = renders.length ? `Renders · ${renders.length}` : 'Renders';
    toast(`Removed ${name}`);
  }
  const i = rcards.findIndex(x => x.name === name), next = rcards[i + 1] || rcards[i - 1];
  if (rsel === name) rsel = next ? next.name : null;
  if (pvName === name) pvName = next ? next.name : null;
  await fillRenders();
  return true;
}
$('rprev').onclick = () => { if (rsel) openPreview(rsel); };
$('rren').onclick = () => { if (rsel) void renameRender(rsel); };
$('rdel').onclick = () => { if (rsel) void deleteRender(rsel); };
$('rdl').onclick = () => { const c = rcards.find(x => x.name === rsel); if (c) download(c.name, c.url); };
$('rclear').onclick = () => { renders.length = 0; rsel = null; $('tab-renders').textContent = 'Renders'; void fillRenders(); };
// Full-screen preview: the whole window (and browser full screen on request), arrows step through the renders.
let pvName: string | null = null, pvActual = false;
function openPreview(name: string): void {
  pvActual = false; selectRender(name);
  const d = $<HTMLDialogElement>('dlg-preview');
  if (!d.open) d.showModal();
  showPreview(name);
  $('pv-close').focus();
}
function showPreview(name: string | null): void {
  const d = $<HTMLDialogElement>('dlg-preview');
  const i = rcards.findIndex(c => c.name === name);
  if (i < 0) { pvName = null; if (d.open) d.close(); return; }
  const c = rcards[i]; pvName = c.name;
  const img = $<HTMLImageElement>('pv-img');
  $('pv-name').textContent = c.name;
  const meta = () => `${img.naturalWidth && img.src === new URL(c.url, location.href).href ? `${img.naturalWidth} × ${img.naturalHeight} px · ` : ''}${c.meta.replace(/^\d+ × \d+ · /, '')} · ${i + 1} of ${rcards.length}`;
  img.onload = () => { $('pv-meta').textContent = meta(); };
  if (img.getAttribute('src') !== c.url) img.src = c.url;
  img.alt = `Render ${c.name}`;
  $('pv-meta').textContent = meta();
  $<HTMLButtonElement>('pvprev').disabled = i === 0; $<HTMLButtonElement>('pvnext').disabled = i === rcards.length - 1;
  $('pv-stage').classList.toggle('actual', pvActual);
  $('pv-zoom').setAttribute('aria-pressed', String(pvActual)); $('pv-zoom').textContent = pvActual ? 'Fit to window' : 'Actual size';
  selectRender(c.name);
}
function stepPreview(k: number): void {
  const i = rcards.findIndex(c => c.name === pvName), n = rcards[i + k];
  if (n) showPreview(n.name);
}
const pvZoom = () => { pvActual = !pvActual; showPreview(pvName); };
$('pv-img').onclick = pvZoom;
$('pv-zoom').onclick = pvZoom;
$('pvprev').onclick = () => stepPreview(-1);
$('pvnext').onclick = () => stepPreview(1);
$('pv-close').onclick = () => $<HTMLDialogElement>('dlg-preview').close();
$('pv-dl').onclick = () => { const c = rcards.find(x => x.name === pvName); if (c) download(c.name, c.url); };
$('pv-ren').onclick = () => { if (pvName) void renameRender(pvName); };
$('pv-del').onclick = () => { if (pvName) void deleteRender(pvName); };
const pvFull = () => {
  const d = $('dlg-preview');
  if (document.fullscreenElement) void document.exitFullscreen?.();
  else void d.requestFullscreen?.().catch(() => toast('Full screen is not available here.', true));
};
$('pv-full').onclick = pvFull;
document.addEventListener('fullscreenchange', () => { $('pv-full').textContent = document.fullscreenElement ? 'Exit full screen' : 'Full screen'; });
$('dlg-preview').addEventListener('close', () => { pvName = null; if (document.fullscreenElement) void document.exitFullscreen?.(); });
$('dlg-preview').addEventListener('keydown', e => {
  if (document.querySelector('dialog[open]:not(#dlg-preview)')) return; // a rename or delete question is open on top
  const k = e.key;
  if (k === 'ArrowLeft') { e.preventDefault(); stepPreview(-1); }
  else if (k === 'ArrowRight') { e.preventDefault(); stepPreview(1); }
  else if (k === 'Home') { e.preventDefault(); if (rcards[0]) showPreview(rcards[0].name); }
  else if (k === 'End') { e.preventDefault(); if (rcards.length) showPreview(rcards[rcards.length - 1].name); }
  else if (k === 'z' || k === 'Z') pvZoom();
  else if (k === 'f' || k === 'F') pvFull();
  else if (k === 'F2') { e.preventDefault(); if (pvName) void renameRender(pvName); }
  else if (k === 'Delete') { e.preventDefault(); if (pvName) void deleteRender(pvName); }
});
// Keys on the Renders tab: arrows move the selection, Enter previews, F2 renames, Delete deletes.
addEventListener('keydown', e => {
  if ($('ws-renders').hidden || document.querySelector('dialog[open]') || (e.target as HTMLElement).closest('input, textarea, select')) return;
  if (e.ctrlKey || e.metaKey || e.altKey) return;
  const i = rcards.findIndex(c => c.name === rsel);
  if (e.key === 'Enter' && rsel) { e.preventDefault(); openPreview(rsel); }
  else if (e.key === 'F2' && rsel) { e.preventDefault(); void renameRender(rsel); }
  else if ((e.key === 'Delete' || e.key === 'Backspace') && rsel) { e.preventDefault(); void deleteRender(rsel); }
  else if ((e.key === 'ArrowRight' || e.key === 'ArrowLeft') && rcards.length) {
    e.preventDefault();
    const n = rcards[Math.max(0, Math.min(rcards.length - 1, i < 0 ? 0 : i + (e.key === 'ArrowRight' ? 1 : -1)))];
    selectRender(n.name); document.querySelector<HTMLElement>(`#rgrid .rcard[data-name="${CSS.escape(n.name)}"]`)?.focus();
  }
});

// ---------------------------------------------------------------- the Characters card (scene)
const EYE = '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12z"/><circle cx="12" cy="12" r="3"/></svg>';
const EYE_OFF = '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 3l18 18M10.6 5.1A9.8 9.8 0 0 1 12 5c6.5 0 10 7 10 7a17 17 0 0 1-3.2 4.1M6.6 6.6A17 17 0 0 0 2 12s3.5 7 10 7a9.7 9.7 0 0 0 5.4-1.6"/></svg>';
const isLocked = (a: Actor) => a === active ? posing.locked : !!a.data?.locked;
const FOCUS = '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 8V5a1 1 0 0 1 1-1h3M16 4h3a1 1 0 0 1 1 1v3M20 16v3a1 1 0 0 1-1 1h-3M8 20H5a1 1 0 0 1-1-1v-3"/><circle cx="12" cy="12" r="3"/></svg>';
const MORE = '<svg width="15" height="15" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><circle cx="5" cy="12" r="1.8"/><circle cx="12" cy="12" r="1.8"/><circle cx="19" cy="12" r="1.8"/></svg>';
const PERSON = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="5" r="2.6"/><path d="M12 8v7M12 15l-4 6M12 15l4 6M6 11h12"/></svg>';
/** The Scene card: a list of everything in the scene (characters today; primitives and props later). */
function fillCharacters(): void {
  const box = $('chars'); if (!box) return;
  box.innerHTML = '';
  $('h-chars-n').textContent = String(actors.length + props.length);
  for (const a of actors) {
    const row = el('div', { cls: 'crow', role: 'listitem' } as Partial<HTMLDivElement>);
    row.dataset.id = String(a.id); row.dataset.kind = 'character';
    row.setAttribute('aria-current', String(a === active && !selProp));
    const dot = el('button', { cls: 'cdot', title: 'Character · colour', innerHTML: PERSON });
    dot.style.background = a.tint; dot.setAttribute('aria-label', `Colour of ${a.name}`); dot.setAttribute('aria-haspopup', 'menu');
    dot.onclick = e => { e.stopPropagation(); openTints(a, dot); };
    const nm = el('button', { cls: 'cname', title: a === active ? 'Selected (being edited) · double-click to rename' : 'Click to select and edit · double-click to rename' },
      el('b', { textContent: a.name }), el('span', { textContent: rigLabel(a.rig) + (a.visible ? '' : ' · hidden') + (contactsOf(a).length ? ` · ${contactsOf(a).length} attached` : '') }));
    nm.onclick = () => { if (selProp) { selProp = null; if (a === active) { update(); fillCharacters(); } } activate(a); };
    const fo = el('button', { cls: 'ci', innerHTML: FOCUS, title: 'Focus: frame it in every view (F for the selected one)' });
    fo.setAttribute('aria-label', `Focus ${a.name}`);
    fo.onclick = e => { e.stopPropagation(); focusItem(a); };
    const eye = el('button', { cls: 'ci', innerHTML: a.visible ? EYE : EYE_OFF, title: a.visible ? 'Hide (not in 3D or the render)' : 'Show' });
    eye.setAttribute('aria-label', `${a.visible ? 'Hide' : 'Show'} ${a.name}`); eye.setAttribute('aria-pressed', String(!a.visible));
    eye.onclick = e => { e.stopPropagation(); canvas.snapshot(); a.visible = !a.visible; markDirty(); update(); fillCharacters(); };
    const lk = el('button', { cls: 'ci', innerHTML: isLocked(a) ? ICON.lock : ICON.unlock, title: isLocked(a) ? 'Locked: click to unlock' : 'Lock (no pose changes, no moving)' });
    lk.setAttribute('aria-label', `${isLocked(a) ? 'Unlock' : 'Lock'} ${a.name}`); lk.setAttribute('aria-pressed', String(isLocked(a)));
    lk.onclick = e => {
      e.stopPropagation();
      if (a === active) { posing.toggleLock(); fillCharacters(); return; }
      canvas.snapshot(); a.data = { ...a.data!, locked: !a.data!.locked }; markDirty(); update(); fillCharacters();
    };
    const more = el('button', { cls: 'ci', innerHTML: MORE, title: 'More: rename, save its pose, duplicate, delete' });
    more.setAttribute('aria-label', `More for ${a.name}`); more.setAttribute('aria-haspopup', 'menu');
    more.onclick = e => { e.stopPropagation(); openItemMenu(a, more); };
    row.append(dot, nm, fo, eye, lk, more);
    box.append(row);
  }
  for (const o of props) box.append(propRow(o));
  refreshLookCard();
  $('dupname').textContent = `Copy of ${active.name}`;
  $('camopts').hidden = actors.length < 2;
  document.querySelectorAll<HTMLElement>('#camframe button').forEach(b => b.setAttribute('aria-pressed', String(b.dataset.frame === camFrame)));
  $('camaim').setAttribute('aria-checked', String(camAim));
  { const want = isSceneNow() ? 'Save scene' : 'Save pose';
    $('savelabel').textContent = want; $('savepose').title = `${want} (Ctrl S; Ctrl Shift S: save as). The arrow has every way to save.`; }
  renderTabs();
}
/** Place a popover under a button inside the Scene card. */
function popAt(p: HTMLElement, btn: HTMLElement, w: number): void {
  const r = btn.getBoundingClientRect(), host = $('charcard').getBoundingClientRect();
  togglePop(p, btn);
  p.style.right = ''; p.style.left = Math.max(8, Math.min(host.width - w - 8, r.right - host.left - w)) + 'px'; p.style.top = (r.bottom - host.top + 6) + 'px';
}
function openItemMenu(a: Actor, btn: HTMLElement): void {
  const p = $('itempop'); p.innerHTML = '';
  p.append(el('div', { cls: 'ttl', textContent: a.name }));
  const item = (label: string, f: () => void, danger = false, disabled = false) => {
    const b = el('button', { cls: 'mi' + (danger ? ' danger' : ''), disabled }, el('span', { cls: 'chk' }), el('span', { textContent: label }));
    b.setAttribute('role', 'menuitem'); b.onclick = () => { closePop(); f(); }; p.append(b);
  };
  item('Focus', () => focusItem(a));
  item('Rename…', () => void renameCharacter(a));
  item('Open its pose on its own', () => void openCharacterInTab(a));
  item('Save its pose…', () => void saveCharacterPose(a));
  item('Duplicate', () => { if (a !== active) activate(a); addCharacter(true); });
  item('Delete', () => deleteCharacter(a), true, actors.length < 2);
  popAt(p, btn, 220);
}
/** Frame one item in every view: the sketch and sketch views (its faint figure, or itself), the 3D views (the
 *  output camera turns to Free; its Reset view goes back to the camera preset). */
function focusItem(a: Actor = active): void {
  const id = a === active ? null : a.id;
  if (!a.visible && a !== active) toast(`${a.name} is hidden: showing where it is anyway.`);
  posing.frameFront(id);
  for (const k of VIEW_KINDS) if (!VP[k].hidden) tileApi[k].focus(id);
  const sp = stage.sphereOf(a.group);
  if (sp) {
    orbitVP.fitSphere(sp); orbitVP.render();
    if (out.preset !== 'free') { lastPreset = out.preset; out.preset = 'free'; refreshCams(); }
    outVP.fitSphere(sp); renderAll();
  }
}
function openTints(a: Actor, btn: HTMLElement): void {
  const p = $('tintpop'); p.innerHTML = '';
  p.append(el('div', { cls: 'ttl', textContent: a.rig.kind === 'mannequin' ? 'Mannequin colour' : 'Colour in the sketch and lists' }));
  const g = el('div', { cls: 'tints' });
  for (const t of TINTS) {
    const b = el('button', { title: t.name }); b.style.background = t.c; b.setAttribute('aria-label', t.name); b.setAttribute('aria-pressed', String(a.tint === t.c));
    b.onclick = () => { closePop(); setTint(a, t.c); };
    g.append(b);
  }
  const lab = el('label', { title: 'Custom colour' }), inp = el('input') as HTMLInputElement;
  inp.type = 'color'; inp.value = a.tint; inp.setAttribute('aria-label', 'Custom colour');
  inp.onchange = () => { closePop(); setTint(a, inp.value); };
  lab.append(inp); g.append(lab);
  p.append(g);
  if (a.rig.kind !== 'mannequin') p.append(el('div', { cls: 'note', textContent: 'Marks this character in the sketch views; the model shows it with Look › Tint or Solid (Pose card, Character).' }));
  popAt(p, btn, 236);
}
function setTint(a: Actor, c: string): void {
  canvas.snapshot(); a.tint = c;
  if (a.rig.kind === 'mannequin') tintMannequin(a.rig, c);
  markDirty(); update(); fillCharacters();
}
async function renameCharacter(a: Actor): Promise<void> {
  const n = (await askText('Rename character', a.name, 'Rename'))?.trim();
  if (!n || n === a.name) return;
  canvas.snapshot(); a.name = n; markDirty(); fillCharacters(); posing.drawTiles(); canvas.draw();
}
function freeName(): string { for (let i = 1; ; i++) if (!actors.some(a => a.name === `Character ${i}`)) return `Character ${i}`; }
function freeTint(): string { return randomTint(); }
/** A random muted colour, as unlike every colour already in the scene as possible (and unlike `not`). */
function randomTint(not?: string): string {
  const used = [...actors.map(a => a.tint), ...props.map(o => o.tint), ...(not ? [not] : [])].map(h => new THREE.Color(h));
  const lab = (c: THREE.Color) => { const h = { h: 0, s: 0, l: 0 }; c.getHSL(h); return [Math.cos(h.h * 2 * Math.PI) * h.s * 2, Math.sin(h.h * 2 * Math.PI) * h.s * 2, h.l * 1.5]; };
  let best = '#c9c6bf', bd = -1;
  for (let i = 0; i < 40; i++) {
    const c = new THREE.Color().setHSL(Math.random(), 0.2 + Math.random() * 0.2, 0.56 + Math.random() * 0.16), L = lab(c);
    const d = used.length ? Math.min(...used.map(u => { const M = lab(u); return Math.hypot(L[0] - M[0], L[1] - M[1], L[2] - M[2]); })) : 1;
    if (d > bd) { bd = d; best = '#' + c.getHexString(); }
  }
  return best;
}
/** A new character beside the others: a mannequin in the standing pose, or a copy of the active one. */
function addCharacter(copy = false): Actor {
  canvas.snapshot();
  const base = copy ? captureLive() : poseToData(BUILTIN[0]);
  // stand it to the right of everyone else
  let maxX = -Infinity;
  for (const a of actors) { const W = worldJoints(a); if (W) for (const v of Object.values(W)) if (Array.isArray(v)) maxX = Math.max(maxX, (v as number[])[0]); }
  const x0 = isFinite(maxX) ? maxX + 0.55 : 0.8;
  const data: ActorData = { ...base, locked: false, contacts: (base.contacts || []).filter(c => c.to === -1 && c.obj == null), place: { p: [+x0.toFixed(3), copy ? base.place.p[1] : 0, copy ? base.place.p[2] : 0], q: copy ? base.place.q : [0, 0, 0, 1] } };
  const a = makeActor(copy ? `${active.name} copy` : freeName(), makeMannequin(), freeTint());
  a.data = data;
  actors.push(a); stage.addGroup(a.group);
  const model = active.rig;
  activate(a);
  if (copy && model.kind === 'model') void setRig(model, a);
  markDirty();
  toast(`${a.name} added${copy ? '' : ' (standing; draw or pick a preset)'}. Click a character's name, or click it in a view with V, to edit it.`);
  return a;
}
function deleteCharacter(a: Actor): void {
  if (actors.length < 2) { toast('A scene needs at least one character.', true); return; }
  canvas.snapshot();
  if (a === active) activate(actors[actors.indexOf(a) + 1] || actors[actors.indexOf(a) - 1]);
  actors.splice(actors.indexOf(a), 1); stage.removeGroup(a.group);
  // whoever held on to it lets go (undo brings both back)
  let freed = 0;
  for (const o of actors) {
    const list = contactsOf(o), keep = list.filter(c => c.to !== a.id); freed += list.length - keep.length;
    if (keep.length === list.length) continue;
    if (o === active) posing.contacts = keep; else o.data = { ...o.data!, contacts: keep };
  }
  void freed;
  for (const o of props) if (o.hold?.to === a.id) o.hold = null; // objects it held stay where they are
  markDirty(); update(); fillCharacters();
  toast(`Deleted ${a.name}. Undo brings it back.`);
}
// ---------------------------------------------------------------- objects: primitives and imported meshes
// Shapes and props in the scene, listed in the Scene card under the characters. Each has a place (bottom centre,
// turn about its middle, scale from its bottom), a colour, a look (imported meshes), an eye and a lock. Undo,
// tabs and scene files carry them like characters.
type Quat = [number, number, number, number];
interface Prop {
  id: number; name: string; kind: PropKind; file: string | null; tint: string; visible: boolean; locked: boolean; look: Look;
  p: V3n; q: Quat; s: V3n; group: THREE.Group; c: THREE.Vector3;
  /** Its normal size (1, or what an imported file was scaled to on the way in): Reset goes back to it. */
  base: number;
  /** Held by a character: it follows that bone (`t` along it), keeping `rel`, its place in the bone's frame
   *  (a 4 × 4 matrix, column-major). */
  hold?: Hold | null;
}
interface Hold { to: number; bone: SegKey; t: number; rel: number[] }
interface PropSnap { id: number; name: string; tint: string; visible: boolean; locked: boolean; look: Look; p: V3n; q: Quat; s: V3n; hold?: Hold | null }
const isSceneNow = () => actors.length > 1 || props.length > 0;
const propSnap = (o: Prop): PropSnap => ({ id: o.id, name: o.name, tint: o.tint, visible: o.visible, locked: o.locked, look: o.look, p: [...o.p] as V3n, q: [...o.q] as Quat, s: [...o.s] as V3n, hold: o.hold ? clone(o.hold) : null });
function makeProp(kind: PropKind, root: THREE.Group, name: string, tint: string, file: string | null = null): Prop {
  const o: Prop = { id: nextPropId++, name, kind, file, tint, visible: true, locked: false, look: kind === 'mesh' ? 'original' : 'solid',
    p: [0, 0, 0], q: [0, 0, 0, 1], s: [1, 1, 1], group: root, c: centreOf(root), base: 1 };
  root.userData.propId = o.id;
  propCache.set(o.id, o);
  return o;
}
/** Put an object where its numbers say and give it its colour and look. */
function showProp(o: Prop): void {
  placeObject(o.group, o.c, o.p, o.q, o.s);
  o.group.visible = o.visible;
  if (o.kind === 'mesh') applyLook(o.group, allSolid ? 'solid' : o.look, o.tint); else tintPrimitive(o.group, o.tint);
}
/** A character's look (models only; mannequins are always their colour). */
function showLook(a: Actor): void {
  if (a.rig.kind === 'model') applyLook(a.rig.root, allSolid ? 'solid' : a.look, a.tint);
}
function freeObjName(base: string): string { for (let i = 1; ; i++) if (!props.some(o => o.name === `${base} ${i}`)) return `${base} ${i}`; }
function freeObjTint(): string { return randomTint(); }
/** A spot on the floor beside the active character (to its right, a little in front), for a new object. */
function besideActive(width: number, depth = width): V3n {
  const h = rig.bones.hips?.getWorldPosition(new THREE.Vector3()) ?? new THREE.Vector3();
  const Q = new THREE.Quaternion(...posing.place.q), side = new THREE.Vector3(-1, 0, 0).applyQuaternion(Q); side.y = 0;
  if (side.lengthSq() < 1e-6) side.set(-1, 0, 0); side.normalize();
  // step further out until it is clear of the other objects (floor planes don't count)
  const boxes = [...props.filter(o => o.visible && !o.group.userData.noFrame).map(o => o.group), ...actors.filter(a => a.visible).map(a => a.group)]
    .map(g => new THREE.Box3().setFromObject(g, true)).filter(b => !b.isEmpty());
  const at = h.clone().addScaledVector(side, 0.55 + width / 2);
  for (let i = 0; i < 40; i++) {
    const me = new THREE.Box3(new THREE.Vector3(at.x - width / 2 - 0.05, -1, at.z - depth / 2 - 0.05), new THREE.Vector3(at.x + width / 2 + 0.05, 99, at.z + depth / 2 + 0.05));
    if (!boxes.some(b => b.intersectsBox(me))) break;
    at.addScaledVector(side, 0.15);
  }
  return [+at.x.toFixed(3), 0, +at.z.toFixed(3)];
}
function addPropToScene(o: Prop, select = true): void {
  props.push(o); stage.addProp(o.group); showProp(o);
  if (select) selectProp(o);
  markDirty(); update(); fillCharacters();
}
/** + Add › a shape. */
function addPrimitive(kind: PrimKind, at?: V3n): Prop {
  canvas.snapshot();
  const tint = freeObjTint(), o = makeProp(kind, makePrimitive(kind, tint), freeObjName(PROP_NAME[kind]), tint);
  const w = new THREE.Box3().setFromObject(o.group, true).getSize(new THREE.Vector3());
  o.p = at ?? (kind === 'plane' ? [0, 0, 0] : besideActive(w.x, w.z));
  addPropToScene(o);
  toast(`${o.name} added. Drag it in 3D to slide it over the floor; the Up and Down keys lift it.`);
  return o;
}
/** An imported object file as a new object (one copy of the file's meshes per object). */
async function addObjectFile(buf: ArrayBuffer, name: string, undoable = true, at?: V3n): Promise<Prop | null> {
  try {
    const { root, fit } = await loadObjectFile(buf, name);
    objBuf.set(name, buf);
    if (undoable) canvas.snapshot();
    const o = makeProp('mesh', root, freeObjName(name.replace(/\.(glb|gltf|obj|vrm)$/i, '')), freeObjTint(), name);
    o.s = [fit, fit, fit]; o.base = fit;
    const w = new THREE.Box3().setFromObject(root, true).getSize(new THREE.Vector3()).multiplyScalar(fit);
    o.p = at ?? besideActive(w.x, w.z);
    addPropToScene(o);
    if (presetTab === 'o') fillObjThumbs(); // a new file shows in the Objects tab at once
    toast(fit !== 1 ? `${o.name} added at scale ${fit} (the file's size looked off; Scale in the Pose card changes it).` : `${o.name} added.`);
    return o;
  } catch (e) { toast(`Could not open ${name}: ${(e as Error).message}`, true); return null; }
}
/** An object file from objects/ (or one already opened this visit). */
async function objectBuffer(name: string): Promise<ArrayBuffer | null> {
  const have = objBuf.get(name); if (have) return have;
  if (!project.connected) return null;
  const f = (await project.list('objects', [name.toLowerCase().slice(name.lastIndexOf('.'))])).find(x => x.name === name);
  if (!f) return null;
  const buf = await (await f.read()).arrayBuffer(); objBuf.set(name, buf); return buf;
}
function duplicateProp(o: Prop): void {
  const make = async (): Promise<THREE.Group | null> => {
    if (o.kind !== 'mesh') return makePrimitive(o.kind, o.tint);
    const buf = o.file ? await objectBuffer(o.file) : null; if (!buf) { toast(`Open ${o.file} again to copy it.`, true); return null; }
    return (await loadObjectFile(buf, o.file!)).root;
  };
  void make().then(root => {
    if (!root) return;
    canvas.snapshot();
    const c = makeProp(o.kind, root, freeObjName(o.name.replace(/ \d+$/, '')), randomTint(), o.file);
    Object.assign(c, { look: o.look, q: [...o.q], s: [...o.s], base: o.base });
    const w = new THREE.Box3().setFromObject(o.group, true).getSize(new THREE.Vector3());
    c.p = [+(o.p[0] + w.x + 0.15).toFixed(3), o.p[1], o.p[2]];
    addPropToScene(c);
    toast(`${c.name} added beside ${o.name}.`);
  });
}
function deleteProp(o: Prop): void {
  canvas.snapshot();
  props.splice(props.indexOf(o), 1); stage.removeProp(o.group);
  if (selProp === o) selProp = null;
  for (const a of actors) { // hands and feet on it let go (undo brings them back)
    const list = contactsOf(a), keep = list.filter(c => c.obj !== o.id);
    if (keep.length === list.length) continue;
    if (a === active) posing.contacts = keep; else a.data = { ...a.data!, contacts: keep };
  }
  markDirty(); update(); fillCharacters();
  toast(`Deleted ${o.name}. Undo brings it back.`);
}
/** Select an object (its gizmo in 3D and its numbers in the Pose card); null lets go. */
function selectProp(o: Prop | null): void {
  if (o === selProp) return;
  selProp = o; objAttaching = null;
  if (o) { posing.sel = null; posing.rootSel = false; if (canvas.tool !== 'select') setTool('select'); }
  update(); fillCharacters();
}
/** Change an object's place, colour or look with one undo step (`quiet`: part of a drag that already took one). */
function setProp(o: Prop, ch: Partial<Pick<Prop, 'p' | 'q' | 's' | 'tint' | 'look' | 'visible' | 'locked' | 'name'>>, quiet = false): void {
  const placeCh = 'p' in ch || 'q' in ch || 's' in ch;
  if (placeCh && o.locked) { toast(`${o.name} is locked. Unlock it to move it.`, true); refreshPoseCard(); return; }
  const same = Object.entries(ch).every(([k, v]) => JSON.stringify((o as unknown as Record<string, unknown>)[k]) === JSON.stringify(v));
  if (same) return;
  if (!quiet) canvas.snapshot();
  Object.assign(o, ch);
  showProp(o);
  if (placeCh && o.hold) rebaseHold(o); // moved by hand while held: it stays held, in its new place
  markDirty(); update();
  if (!placeCh) fillCharacters();
}
/** 3D: the object under a pixel, unless a character is in front of it. */
function propAt(vp: Viewport3D, p: { x: number; y: number }): Prop | null {
  const rc = new THREE.Raycaster();
  rc.setFromCamera(new THREE.Vector2(p.x / vp.size.w * 2 - 1, -(p.y / vp.size.h) * 2 + 1), vp.camera);
  let best: { o: Prop; d: number } | null = null;
  for (const o of props) { if (!o.visible) continue; const h = rc.intersectObject(o.group, true)[0]; if (h && (!best || h.distance < best.d)) best = { o, d: h.distance }; }
  if (!best) return null;
  for (const a of actors) { if (!a.visible) continue; const h = rc.intersectObject(a.group, true)[0]; if (h && h.distance < best.d) return null; }
  return best.o;
}
// ---------------------------------------------------------------- held objects and spots on objects
/** A bone's frame in the world (along it, toward the character's front, to its side), at `t` along it. */
function boneMatrix(a: Actor, bone: SegKey, t: number): THREE.Matrix4 | null {
  const W = worldJoints(a); if (!W) return null;
  const f = segFrame(W, bone);
  return new THREE.Matrix4().makeBasis(f.u, f.v, f.w).setPosition(f.A.clone().lerp(f.B, t));
}
/** Held objects follow their bone (a locked object stays put: paused). */
function followHolds(): void {
  for (const o of props) {
    const h = o.hold; if (!h || o.locked) continue;
    const a = actors.find(x => x.id === h.to); if (!a) continue;
    const Mb = boneMatrix(a, h.bone, h.t); if (!Mb) continue;
    const M = Mb.multiply(new THREE.Matrix4().fromArray(h.rel)), pos = new THREE.Vector3(), q = new THREE.Quaternion(), sc = new THREE.Vector3();
    M.decompose(pos, q, sc);
    const S = new THREE.Vector3(...o.s), cS = o.c.clone().multiply(S), p = pos.clone().sub(cS).add(cS.clone().applyQuaternion(q));
    o.p = [+p.x.toFixed(5), +p.y.toFixed(5), +p.z.toFixed(5)]; o.q = [q.x, q.y, q.z, q.w];
    placeObject(o.group, o.c, o.p, o.q, o.s);
  }
}
/** A held object moved by hand: keep holding it where it is now. */
function rebaseHold(o: Prop): void {
  const h = o.hold!, a = actors.find(x => x.id === h.to); if (!a) return;
  const Mb = boneMatrix(a, h.bone, h.t); if (!Mb) return;
  o.group.updateMatrixWorld(true);
  h.rel = Mb.invert().multiply(o.group.matrixWorld).toArray();
}
/** The limb a bone belongs to (arms and legs), for loop checks. */
const limbOfBone = (b: SegKey) => (/^(arm|leg)[LR]/.exec(b)?.[0] ?? null) as Contact['part'] | null;
/** Attach a hand or foot to a spot on an object (Reach to… with Keep attached, in 3D). */
function objAnchorAt(id: number, P: THREE.Vector3, skip: Part | null): Omit<Contact, 'part'> | null {
  const o = props.find(x => x.id === id); if (!o) { toast('Nothing there to hold on to.', true); return null; }
  if (skip && o.hold && o.hold.to === active.id && limbOfBone(o.hold.bone) === skip) {
    toast(`That would make a loop: ${o.name} is held by this ${skip.startsWith('arm') ? 'hand' : 'foot'}. Detach it first.`, true); return null;
  }
  const L = o.group.worldToLocal(P.clone());
  return { to: -2, obj: o.id, bone: 'spine0', t: 0, off: [+L.x.toFixed(4), +L.y.toFixed(4), +L.z.toFixed(4)] };
}
/** Attach to… for an object: the next click on a character in 3D holds it there. */
let objAttaching: Prop | null = null;
function startHoldPick(): void {
  const o = selProp; if (!o) return;
  if (o.locked) { toast(`${o.name} is locked. Unlock it to attach it.`, true); return; }
  objAttaching = objAttaching ? null : o;
  if (objAttaching) toast(`Click a character in 3D where ${o.name} should go (a hand, the back…). Esc cancels.`);
  refreshPoseCard(); renderAll(); refreshHelp();
}
function pickHolder(vp: Viewport3D, px: { x: number; y: number }): void {
  const o = objAttaching; objAttaching = null;
  const hit = o && hit3D(vp, px, true);
  if (!o || !hit) { if (o) toast('Nothing there: click on a character.', true); refreshPoseCard(); renderAll(); return; }
  const a = actors.find(x => x.id === hit.id)!, W = worldJoints(a);
  if (!W) { refreshPoseCard(); return; }
  let best: { b: SegKey; t: number; d: number } | null = null;
  for (const b of Object.keys(SEG_J) as SegKey[]) {
    const [ja, jb] = SEG_J[b], A0 = V(W[ja] as V3n), B0 = V(W[jb] as V3n), ab = B0.clone().sub(A0);
    const t = Math.max(0, Math.min(1, hit.point.clone().sub(A0).dot(ab) / (ab.lengthSq() || 1e-12))), d = A0.clone().addScaledVector(ab, t).distanceTo(hit.point);
    if (!best || d < best.d) best = { b, t, d };
  }
  if (!best) return;
  const limb = limbOfBone(best.b);
  if (limb && contactsOf(a).some(c => c.part === limb && c.obj === o.id)) {
    toast(`That would make a loop: that ${limb.startsWith('arm') ? 'hand' : 'foot'} holds on to ${o.name}. Detach it first.`, true); refreshPoseCard(); return;
  }
  canvas.snapshot();
  // its middle goes to the clicked spot (its turn stays), then it follows that bone
  const ctr = o.group.localToWorld(o.c.clone()), d = hit.point.clone().sub(ctr);
  o.p = [+(o.p[0] + d.x).toFixed(4), +(o.p[1] + d.y).toFixed(4), +(o.p[2] + d.z).toFixed(4)];
  showProp(o);
  o.hold = { to: a.id, bone: best.b, t: +best.t.toFixed(4), rel: [] };
  rebaseHold(o);
  markDirty(); update(); fillCharacters();
  toast(`${o.name} attached to ${a.name} (${BONE_NAME[best.b].toLowerCase()}): it follows from now on. Move it to adjust the grip; Detach in the Pose card.`);
}
function detachProp(o: Prop): void {
  if (!o.hold) return;
  canvas.snapshot(); o.hold = null; markDirty(); update(); fillCharacters();
  toast(`${o.name} detached. It stays where it is.`);
}
/** Signs on objects in 3D: padlock (locked), link (held; grey when paused because it is locked). */
function objMarks(): { top: THREE.Vector3; locked: boolean; held: 'ok' | 'paused' | null }[] {
  const out: { top: THREE.Vector3; locked: boolean; held: 'ok' | 'paused' | null }[] = [];
  for (const o of props) {
    if (!o.visible || (!o.locked && !o.hold)) continue;
    const b = new THREE.Box3().setFromObject(o.group, true); if (b.isEmpty()) continue;
    out.push({ top: new THREE.Vector3((b.min.x + b.max.x) / 2, b.max.y, (b.min.z + b.max.z) / 2), locked: o.locked, held: o.hold ? (o.locked ? 'paused' : 'ok') : null });
  }
  return out;
}
const SHAPE_ICON = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 3 3 8v8l9 5 9-5V8z"/><path d="m3 8 9 5 9-5M12 13v8"/></svg>';
/** + Add: characters, shapes, object files. */
function fillAddMenu(): void {
  const box = $('addobjs'); box.innerHTML = '';
  box.append(el('hr'), el('div', { cls: 'ttl', textContent: 'Shapes' }));
  const g = el('div', { cls: 'addgrid' });
  for (const pr of PRIMS) {
    const b = el('button', { cls: 'mi', title: pr.note ? `${pr.name}: ${pr.note}` : pr.name, innerHTML: SHAPE_ICON }, el('span', { textContent: pr.name }));
    b.setAttribute('role', 'menuitem'); b.dataset.prim = pr.kind;
    b.onclick = () => { closePop(); addPrimitive(pr.kind); };
    g.append(b);
  }
  box.append(g, el('hr'));
  const f = el('button', { cls: 'mi' }, el('span', { cls: 'chk' }), el('span', {}, 'Object from file… ', el('span', { cls: 'k2', textContent: 'GLB, GLTF, OBJ' })));
  f.setAttribute('role', 'menuitem'); f.id = 'addfile';
  f.onclick = () => { closePop(); $<HTMLInputElement>('objfile').click(); };
  box.append(f, el('div', { cls: 'note', textContent: 'Saved objects are in the Objects tab next to Presets: drag one into a 3D view, or click it.' }));
}
let folderObjects: string[] = [];
let serverWarned = false;
async function refreshFolderObjects(): Promise<void> {
  folderObjects = project.connected ? (await project.list('objects', ['.glb', '.gltf', '.obj'])).map(f => f.name).sort((a, b) => a.localeCompare(b)) : [];
  if (project.connected && !serverWarned && !(await project.check('objects'))) { serverWarned = true; toast(OLD_SERVER, true); }
  if (presetTab === 'o') fillObjThumbs();
  if (!$('ws-library').hidden && libTab === 'o') fillLibrary();
}
const OLD_SERVER = 'The Start Stickform window is from an older version and cannot use objects/: close it and double-click Start Stickform again.';

// ---------------------------------------------------------------- object catalogue: Presets card › Objects, Library › Objects
interface Cat { kind: PropKind; name: string; label: string; saved: boolean }
/** Object files (objects/, and any opened this visit), and with `prims` the shapes too. */
function catalogue(prims: boolean): Cat[] {
  const files = [...new Set([...folderObjects, ...objBuf.keys()])].sort((a, b) => a.localeCompare(b));
  return [...(prims ? PRIMS.map(p => ({ kind: p.kind as PropKind, name: p.kind, label: p.name, saved: true })) : []),
    ...files.map(n => ({ kind: 'mesh' as PropKind, name: n, label: n.replace(/\.(glb|gltf|obj|vrm)$/i, ''), saved: folderObjects.includes(n) }))];
}
/** Little rendered pictures of objects (made once each, one at a time). */
const thumbCache = new Map<string, string | null>();
let thumbR: THREE.WebGLRenderer | null = null, thumbQ: Promise<unknown> = Promise.resolve();
function objThumb(c: Cat): Promise<string | null> {
  const key = c.kind + ':' + c.name;
  if (thumbCache.has(key)) return Promise.resolve(thumbCache.get(key)!);
  const job = thumbQ.then(async () => {
    if (thumbCache.has(key)) return;
    let root: THREE.Object3D;
    try {
      if (c.kind !== 'mesh') root = makePrimitive(c.kind, '#b9b4aa');
      else { const buf = await objectBuffer(c.name); if (!buf) { thumbCache.set(key, null); return; } root = (await loadObjectFile(buf, c.name)).root; }
    } catch { thumbCache.set(key, null); return; }
    if (!thumbR) { thumbR = new THREE.WebGLRenderer({ antialias: true, alpha: true, preserveDrawingBuffer: true }); thumbR.setSize(160, 160, false); thumbR.outputColorSpace = THREE.SRGBColorSpace; }
    const sc = new THREE.Scene();
    sc.add(new THREE.HemisphereLight(0xffffff, 0x8a8478, 1.7));
    const key2 = new THREE.DirectionalLight(0xffffff, 2); key2.position.set(2, 4, 3); sc.add(key2);
    sc.add(root); root.updateMatrixWorld(true);
    const sp = new THREE.Box3().setFromObject(root, true).getBoundingSphere(new THREE.Sphere());
    const cam = new THREE.PerspectiveCamera(30, 1, Math.max(0.001, sp.radius / 100), sp.radius * 100);
    cam.position.copy(sp.center).add(new THREE.Vector3(0.62, 0.45, 1).normalize().multiplyScalar(sp.radius / Math.sin(THREE.MathUtils.degToRad(15)) * 1.05));
    cam.lookAt(sp.center);
    thumbR.setClearColor(0x000000, 0); thumbR.render(sc, cam);
    thumbCache.set(key, thumbR.domElement.toDataURL('image/png'));
    root.traverse(o => { const m = o as THREE.Mesh; if (m.isMesh) m.geometry.dispose(); });
  }).catch(() => { thumbCache.set(key, null); });
  thumbQ = job;
  return job.then(() => thumbCache.get(key) ?? null);
}
/** A tile: a picture, a name; click adds it, drag it into a 3D view to put it there. */
function objTile(c: Cat, onPick: () => void, current = false): HTMLButtonElement {
  const ph = el('span', { cls: 'ph', innerHTML: SHAPE_ICON });
  const b = el('button', { cls: 'thumb', title: c.kind !== 'mesh' ? `${c.label} (shape)` : c.saved ? `objects/${c.name} · drag into a 3D view, or click` : `${c.name}: opened this visit, not saved in objects/` },
    ph, el('span', { cls: 'tlab', textContent: c.label }));
  b.setAttribute('aria-current', String(current));
  b.draggable = true; b.dataset.obj = c.name;
  b.ondragstart = e => { e.dataTransfer?.setData('application/x-stickform-object', JSON.stringify({ kind: c.kind, name: c.name })); if (e.dataTransfer) e.dataTransfer.effectAllowed = 'copy'; };
  b.onclick = onPick;
  if (c.kind === 'mesh' && !c.saved) b.append(el('em', { cls: 'src', textContent: 'not saved' }));
  void objThumb(c).then(u => { if (u) ph.replaceWith(el('img', { src: u, alt: '' })); });
  return b;
}
/** Add a catalogue entry to the scene (at a floor point, else beside the character). */
async function addFromCat(c: Cat, at?: V3n): Promise<void> {
  if (c.kind !== 'mesh') { addPrimitive(c.kind, at); return; }
  const buf = await objectBuffer(c.name);
  if (!buf) { toast(`objects/${c.name} could not be read.`, true); return; }
  await addObjectFile(buf, c.name, true, at);
}
let presetTab: 'p' | 'o' = store.get<'p' | 'o'>('stickform.ptab', 'p');
function fillObjThumbs(): void {
  const g = $('othumbs'); g.innerHTML = '';
  for (const c of catalogue(false)) g.append(objTile(c, () => void addFromCat(c)));
  const imp = el('button', { cls: 'thumb imp', title: 'Import a GLB, GLTF or OBJ file (it offers to keep a copy in objects/)' }, el('span', { cls: 'ph', textContent: '+' }), el('span', { cls: 'tlab', textContent: 'Import…' }));
  imp.id = 'oimport'; imp.onclick = () => $<HTMLInputElement>('objfile').click();
  g.append(imp);
}
function showPresetTab(t: 'p' | 'o'): void {
  presetTab = t; store.set('stickform.ptab', t);
  for (const b of document.querySelectorAll<HTMLElement>('#ptabs button')) { const on = b.dataset.pt === t; b.setAttribute('aria-pressed', String(on)); b.setAttribute('aria-selected', String(on)); }
  $('thumbs').hidden = t !== 'p'; $('othumbs').hidden = t !== 'o';
  if (t === 'o') fillObjThumbs();
}
document.querySelectorAll<HTMLElement>('#ptabs button').forEach(b => { b.onclick = () => showPresetTab(b.dataset.pt as 'p' | 'o'); });
/** Where on the floor a pixel of a 3D view points (null: above the horizon or very far). */
function floorAt(vp: Viewport3D, clientX: number, clientY: number): V3n | null {
  const r = vp.canvas.getBoundingClientRect(), rc = new THREE.Raycaster();
  rc.setFromCamera(new THREE.Vector2((clientX - r.left) / r.width * 2 - 1, -((clientY - r.top) / r.height) * 2 + 1), vp.camera);
  const hit = rc.ray.intersectPlane(new THREE.Plane(new THREE.Vector3(0, 1, 0), 0), new THREE.Vector3());
  return hit && hit.distanceTo(vp.camera.position) < 60 ? [+hit.x.toFixed(3), 0, +hit.z.toFixed(3)] : null;
}
// Drop a tile (or a GLB/GLTF/OBJ file from the computer) into a 3D view: it lands on the floor where dropped.
for (const vp of [outVP, orbitVP]) {
  const host = vp.canvas.parentElement!;
  const ok = (e: DragEvent) => !!e.dataTransfer && (e.dataTransfer.types.includes('application/x-stickform-object') || e.dataTransfer.types.includes('Files'));
  host.addEventListener('dragover', e => { if (!ok(e)) return; e.preventDefault(); e.dataTransfer!.dropEffect = 'copy'; host.classList.add('dropping'); });
  host.addEventListener('dragleave', () => host.classList.remove('dropping'));
  host.addEventListener('drop', e => {
    host.classList.remove('dropping');
    if (!ok(e)) return;
    e.preventDefault();
    const at = floorAt(vp, e.clientX, e.clientY) ?? undefined;
    const t = e.dataTransfer!.getData('application/x-stickform-object');
    if (t) { try { const c = JSON.parse(t) as { kind: PropKind; name: string }; void addFromCat({ ...c, label: c.name, saved: true }, at); } catch { /* not ours */ } return; }
    const f = [...e.dataTransfer!.files].find(x => /\.(glb|gltf|obj)$/i.test(x.name));
    if (f) void importObject(f, at); else if (e.dataTransfer!.files.length) toast('Drop a GLB, GLTF or OBJ file.', true);
  });
}
/** Open an object file from the computer, then offer to keep a copy in objects/. */
async function importObject(f: File, at?: V3n): Promise<void> {
  toast(`Opening ${f.name}…`);
  const buf = await readFile(f, 'buffer') as ArrayBuffer;
  const o = await addObjectFile(buf, f.name, true, at);
  if (!o || !project.connected || await project.exists('objects', f.name).catch(() => false)) return;
  if (!(await askConfirm('Keep this object?', `Save a copy of ${f.name} in the objects folder, so it is in the Objects tab next time (and scenes with it open again)?`, 'Save copy'))) return;
  try { await project.write('objects', f.name, buf); toast(`Saved to objects/${f.name}. It is in the Objects tab next to Presets.`); await refreshFolderObjects(); }
  catch (err) { const m = (err as Error).message; toast(project.server && /folder/i.test(m) ? OLD_SERVER : `Could not save a copy in objects/: ${m}`, true); }
}
$<HTMLInputElement>('objfile').onchange = async e => {
  const input = e.target as HTMLInputElement, f = input.files?.[0];
  input.value = '';
  if (f) await importObject(f);
};
/** Scene card row for an object. */
function propRow(o: Prop): HTMLElement {
  const row = el('div', { cls: 'crow', role: 'listitem' } as Partial<HTMLDivElement>);
  row.dataset.id = String(o.id); row.dataset.kind = 'object';
  row.setAttribute('aria-current', String(o === selProp));
  const dot = el('button', { cls: 'cdot', title: 'Object · colour', innerHTML: SHAPE_ICON });
  dot.style.background = o.tint; dot.setAttribute('aria-label', `Colour of ${o.name}`); dot.setAttribute('aria-haspopup', 'menu');
  dot.onclick = e => { e.stopPropagation(); openPropTints(o, dot); };
  const sub = (o.kind === 'mesh' ? (o.file || 'Object') + (allSolid || o.look === 'original' ? '' : ` · ${o.look}`) : PROP_NAME[o.kind]) + (o.visible ? '' : ' · hidden');
  const nm = el('button', { cls: 'cname', title: 'Click to select · double-click to rename' }, el('b', { textContent: o.name }), el('span', { textContent: sub }));
  nm.onclick = () => selectProp(o);
  const fo = el('button', { cls: 'ci', innerHTML: FOCUS, title: 'Focus: frame it in the 3D views' }); fo.setAttribute('aria-label', `Focus ${o.name}`);
  fo.onclick = e => { e.stopPropagation(); focusProp(o); };
  const eye = el('button', { cls: 'ci', innerHTML: o.visible ? EYE : EYE_OFF, title: o.visible ? 'Hide (not in 3D or the render)' : 'Show' });
  eye.setAttribute('aria-label', `${o.visible ? 'Hide' : 'Show'} ${o.name}`); eye.setAttribute('aria-pressed', String(!o.visible));
  eye.onclick = e => { e.stopPropagation(); setProp(o, { visible: !o.visible }); };
  const lk = el('button', { cls: 'ci', innerHTML: o.locked ? ICON.lock : ICON.unlock, title: o.locked ? 'Locked: click to unlock' : 'Lock (no moving, turning or scaling)' });
  lk.setAttribute('aria-label', `${o.locked ? 'Unlock' : 'Lock'} ${o.name}`); lk.setAttribute('aria-pressed', String(o.locked));
  lk.onclick = e => { e.stopPropagation(); setProp(o, { locked: !o.locked }); refreshPoseCard(); };
  const more = el('button', { cls: 'ci', innerHTML: MORE, title: 'More: rename, duplicate, delete' });
  more.setAttribute('aria-label', `More for ${o.name}`); more.setAttribute('aria-haspopup', 'menu');
  more.onclick = e => { e.stopPropagation(); openPropMenu(o, more); };
  row.append(dot, nm, fo, eye, lk, more);
  return row;
}
function openPropMenu(o: Prop, btn: HTMLElement): void {
  const p = $('itempop'); p.innerHTML = '';
  p.append(el('div', { cls: 'ttl', textContent: o.name }));
  const item = (label: string, f: () => void, danger = false) => {
    const b = el('button', { cls: 'mi' + (danger ? ' danger' : '') }, el('span', { cls: 'chk' }), el('span', { textContent: label }));
    b.setAttribute('role', 'menuitem'); b.onclick = () => { closePop(); f(); }; p.append(b);
  };
  item('Focus', () => focusProp(o));
  item('Rename…', () => void renameProp(o));
  item('Duplicate', () => duplicateProp(o));
  item('Delete', () => deleteProp(o), true);
  popAt(p, btn, 220);
}
function openPropTints(o: Prop, btn: HTMLElement): void {
  const p = $('tintpop'); p.innerHTML = '';
  p.append(el('div', { cls: 'ttl', textContent: o.kind === 'mesh' ? 'Colour (Tint and Solid looks)' : 'Colour' }));
  const g = el('div', { cls: 'tints' });
  for (const t of TINTS) {
    const b = el('button', { title: t.name }); b.style.background = t.c; b.setAttribute('aria-label', t.name); b.setAttribute('aria-pressed', String(o.tint === t.c));
    b.onclick = () => { closePop(); setProp(o, { tint: t.c }); };
    g.append(b);
  }
  const lab = el('label', { title: 'Custom colour' }), inp = el('input') as HTMLInputElement;
  inp.type = 'color'; inp.value = o.tint; inp.setAttribute('aria-label', 'Custom colour');
  inp.onchange = () => { closePop(); setProp(o, { tint: inp.value }); };
  lab.append(inp); g.append(lab);
  p.append(g);
  popAt(p, btn, 236);
}
async function renameProp(o: Prop): Promise<void> {
  const n = (await askText('Rename object', o.name, 'Rename'))?.trim();
  if (n && n !== o.name) setProp(o, { name: n });
}
function focusProp(o: Prop): void {
  const sp = stage.sphereOf(o.group); if (!sp) return;
  if (!o.visible) toast(`${o.name} is hidden: showing where it is anyway.`);
  orbitVP.fitSphere(sp); orbitVP.render();
  if (out.preset !== 'free') { lastPreset = out.preset; out.preset = 'free'; refreshCams(); }
  outVP.fitSphere(sp); renderAll();
}
/** Raise or lower the selected object or character (Up and Down keys): 5 cm, Shift 1 cm. A run of presses (nothing
 *  else changed in between, at most 10 s apart) is one undo step. */
let liftRun = { t: 0, who: '', n: -1 };
function liftSelected(dy: number): boolean {
  const who = selProp ? 'o' + selProp.id : posing.rootSel ? 'a' + active.id : '';
  if (!who) return false;
  const now = performance.now(), fresh = now - liftRun.t > 10000 || liftRun.who !== who || canvas.exportHistory().u.length !== liftRun.n;
  liftRun = { t: now, who, n: -1 };
  if (selProp) {
    if (selProp.locked) { toast(`${selProp.name} is locked. Unlock it to move it.`, true); return true; }
    const p = selProp.p; setProp(selProp, { p: [p[0], +(p[1] + dy).toFixed(4), p[2]] }, !fresh);
  } else {
    if (posing.locked) { posing.lockedNotice(); return true; }
    if (fresh) canvas.snapshot();
    const p = posing.place.p; posing.movePlace([p[0], +(p[1] + dy).toFixed(4), p[2]]); markDirty(); update();
  }
  liftRun.t = performance.now(); liftRun.n = canvas.exportHistory().u.length;
  return true;
}

$('addbtn').onclick = () => { fillAddMenu(); togglePop($('addpop'), $('addbtn')); };
$('addchar').onclick = () => { closePop(); addCharacter(false); };
// Double-click a name to rename (on the list, since the first click already rebuilds the rows).
// Double-click a name to rename. The rows are rebuilt by the first click (it selects the character), so the two
// clicks are matched here, on the list, by character and time, not by the browser's dblclick on one element.
{
  let last: { id: string; t: number } | null = null;
  $('chars').addEventListener('click', e => {
    const t = e.target as HTMLElement, row = t.closest<HTMLElement>('.crow');
    if (!row || !t.closest('.cname')) { last = null; return; }
    const id = row.dataset.id!, now = performance.now();
    const kind = row.dataset.kind || 'character';
    if (last && last.id === kind + id && now - last.t < 450) { last = null;
      if (kind === 'object') { const o = props.find(x => String(x.id) === id); if (o) void renameProp(o); return; }
      const a = actors.find(x => String(x.id) === id); if (a) void renameCharacter(a); return; }
    last = { id: kind + id, t: now };
  });
}
$('dupchar').onclick = () => { closePop(); addCharacter(true); };
document.querySelectorAll<HTMLElement>('#camframe button').forEach(b => { b.onclick = () => { camFrame = b.dataset.frame as 'all' | 'active'; fillCharacters(); update(); }; });
$('camaim').onclick = () => { camAim = !camAim; fillCharacters(); update(); };
$('allsolid').onclick = () => { canvas.snapshot(); allSolid = !allSolid; for (const o of props) showProp(o); markDirty(); update(); fillCharacters(); };

/** Everything in one file: each character's pose plus its model, colour and visibility. */
function sceneFile(name: string): SceneFile {
  return {
    format: 'stickform-scene', version: 1, name, active: actors.indexOf(active), output: { w: out.w, h: out.h },
    camera: { frame: camFrame, aim: camAim },
    characters: actors.map(a => {
      const pose = a === active ? withSkeleton(poseFile(a.name)) : dataToPose(a.data!, a.name);
      // contacts name the other character by its place in this file
      const att = contactsOf(a).map(c => {
        if (c.obj != null) { const j = props.findIndex(o => o.id === c.obj); return j < 0 ? null : { ...clone(c), to: -2, obj: j }; }
        const i = actors.findIndex(x => x.id === c.to); return i < 0 && c.to !== -1 ? null : { ...clone(c), to: c.to === -1 ? -1 : i };
      }).filter((c): c is Contact => !!c);
      if (att.length) pose.attach = att; else delete pose.attach;
      return { name: a.name, model: a.rig.kind === 'mannequin' ? 'mannequin' : a.rig.name, tint: a.tint, visible: a.visible, ...(a.look !== 'original' ? { look: a.look } : {}),
        ...(pageMap && a.reg ? { at: clone(a.reg) } : {}),
        ...(a.poseSrc?.src === 'folder' ? { source: a.poseSrc.key } : {}), pose };
    }),
    ...(props.length ? { objects: props.map((o): SceneObject => ({ name: o.name, kind: o.kind, ...(o.file ? { file: o.file } : {}), tint: o.tint, visible: o.visible,
      ...(o.locked ? { locked: true } : {}), ...(o.kind === 'mesh' && o.look !== 'original' ? { look: o.look } : {}),
      ...(o.hold && actors.some(a => a.id === o.hold!.to) ? { hold: { ...clone(o.hold), to: actors.findIndex(a => a.id === o.hold!.to) } } : {}), place: { ...placeFileOf({ p: o.p, q: o.q, s: o.s }), s: o.s.map(v => +v.toFixed(4)) } })) } : {}),
    ...(allSolid ? { solid: true } : {}),
    ...(pageMap ? { sketch: { ...pageMap } } : {}),
  };
}
/** Open a scene file: replaces every character. Models come from the menu or models/; a missing one becomes a
 *  mannequin (with a note). */
async function loadScene(sf: SceneFile, undoable = true): Promise<void> {
  if (undoable) canvas.snapshot();
  posing.reset();
  const list: Actor[] = [];
  sf.characters.forEach((c, i) => {
    const a = actors[i] ?? makeActor(c.name, makeMannequin(), TINTS[i % TINTS.length].c);
    a.name = c.name || `Character ${i + 1}`; a.tint = /^#[0-9a-f]{6}$/i.test(c.tint || '') ? c.tint! : TINTS[i % TINTS.length].c;
    a.visible = c.visible !== false; a.data = poseToData(c.pose); a.posed = null; a.look = c.look === 'tint' || c.look === 'solid' ? c.look : 'original';
    const sk = (c as { source?: string }).source; a.poseSrc = sk ? { src: 'folder', key: sk, name: c.pose?.name || sk } : null;
    if (a.rig.kind === 'mannequin') tintMannequin(a.rig, a.tint);
    list.push(a);
  });
  // contacts: file indices to character ids
  // (object spots keep the object's place in the file, as -(index + 1), until the objects are made below)
  for (const a of list) if (a.data?.contacts) a.data.contacts = a.data.contacts.flatMap(c => c.obj != null ? [{ ...c, obj: -(c.obj + 1) }] : c.to === -1 ? [c] : list[c.to] && list[c.to] !== a ? [{ ...c, to: list[c.to].id }] : []);
  for (const a of actors) if (!list.includes(a)) stage.removeGroup(a.group);
  actors.length = 0; actors.push(...list);
  for (const a of list) stage.addGroup(a.group);
  const act = list[Math.max(0, Math.min(list.length - 1, sf.active || 0))];
  active = act; rig = act.rig; stage.setActive(act.group, act.rig);
  loadLive(act.data!); act.data = null;
  if (sf.output?.w && sf.output.h) { out.w = sf.output.w; out.h = sf.output.h; refreshOutput(); }
  camFrame = sf.camera?.frame === 'active' ? 'active' : 'all'; camAim = !!sf.camera?.aim;
  // objects: shapes now, imported files once read (below)
  for (const o of props) stage.removeProp(o.group);
  props.length = 0; selProp = null; pending = []; allSolid = sf.solid === true;
  const pm = (sf as { sketch?: PageMap }).sketch;
  pageMap = pm && ['px', 'py', 'wx', 'wy', 'wz', 'm'].every(k => typeof (pm as unknown as Record<string, unknown>)[k] === 'number') && pm.m > 0 ? { ...pm } : null;
  sf.characters.forEach((c, i) => { const r = (c as { at?: Actor['reg'] }).at; if (list[i]) list[i].reg = pageMap && r && Array.isArray(r.p) && Array.isArray(r.d) ? clone(r) : null; });
  const later: [SceneObject, number][] = [], byIdx: (Prop | undefined)[] = [];
  (Array.isArray(sf.objects) ? sf.objects : []).forEach((e, i) => {
    if (!e || typeof e !== 'object') return;
    if (e.kind === 'mesh') { later.push([e, i]); return; }
    if (!PRIMS.some(x => x.kind === e.kind)) return;
    const tint = /^#[0-9a-f]{6}$/i.test(e.tint || '') ? e.tint! : TINTS[i % TINTS.length].c;
    const o = makeProp(e.kind as PrimKind, makePrimitive(e.kind as PrimKind, tint), e.name || PROP_NAME[e.kind as PrimKind], tint);
    readObj(o, e); props.push(o); stage.addProp(o.group); showProp(o); byIdx[i] = o;
  });
  /** Holds and spots on objects, once the objects are there (file indices to ids). */
  const linkObjects = () => {
    (Array.isArray(sf.objects) ? sf.objects : []).forEach((e, i) => {
      const o = byIdx[i], h = (e as { hold?: Hold }).hold;
      if (o && h && Array.isArray(h.rel) && h.rel.length === 16 && list[h.to] && typeof h.bone === "string") o.hold = { to: list[h.to].id, bone: h.bone as SegKey, t: +h.t || 0, rel: h.rel.slice() };
    });
    const fix = (cs: Contact[]) => cs.flatMap(c => c.obj != null && c.obj < 0 ? (byIdx[-c.obj - 1] ? [{ ...c, obj: byIdx[-c.obj - 1]!.id }] : []) : [c]);
    for (const a of list) { if (a === active) posing.contacts = fix(posing.contacts); else if (a.data?.contacts) a.data.contacts = fix(a.data.contacts); }
  };
  if (!later.length) linkObjects();
  poseName = sf.name || 'Untitled'; dirty = false; currentPreset = null;
  canvas.selected = null; closePop();
  refreshName(); refreshRig(); fillThumbs(); fillCharacters(); update();
  // models (after the poses are in, so a slow model load never leaves a half-made scene)
  const missing: string[] = [];
  for (let i = 0; i < list.length; i++) {
    const want = sf.characters[i].model || 'mannequin';
    if (want === 'mannequin') { if (list[i].rig.kind !== 'mannequin') await setRig(rigs[0], list[i]); continue; }
    if (list[i].rig.name === want) continue;
    const t = rigs.find(r => r.name === want) || await folderTemplate(want);
    if (t) await setRig(t, list[i]); else missing.push(want);
  }
  if (missing.length) toast(`Not found: ${[...new Set(missing)].join(', ')}. Mannequins stand in; put the files in models/ or load them from the character menu.`, true);
  const lost: string[] = [];
  for (const [e, i] of later) {
    const buf = e.file ? await objectBuffer(e.file).catch(() => null) : null;
    if (!buf) { lost.push(e.file || e.name); continue; }
    try {
      const { root, fit } = await loadObjectFile(buf, e.file!);
      const tint = /^#[0-9a-f]{6}$/i.test(e.tint || '') ? e.tint! : TINTS[i % TINTS.length].c;
      const o = makeProp('mesh', root, e.name || e.file!, tint, e.file!);
      readObj(o, e); o.base = fit; o.look = e.look === 'tint' || e.look === 'solid' ? e.look : 'original';
      props.splice(Math.min(i, props.length), 0, o); stage.addProp(o.group); showProp(o); byIdx[i] = o;
    } catch { lost.push(e.file!); }
  }
  if (later.length) { linkObjects(); fillCharacters(); update(); }
  if (lost.length) toast(`Objects not found: ${[...new Set(lost)].join(', ')}. Put the files in objects/ (or add them with + Add › Object from file) and open the scene again.`, true);
  dirty = false; refreshName();
}
/** An object's colour, eye, lock and place from a scene file. */
function readObj(o: Prop, e: SceneObject): void {
  const ok = (a: unknown, n: number) => Array.isArray(a) && a.length === n && a.every(x => typeof x === 'number' && isFinite(x));
  o.visible = e.visible !== false; o.locked = e.locked === true;
  o.p = ok(e.place?.p, 3) ? e.place.p.slice() as V3n : [0, 0, 0];
  o.q = ok(e.place?.q, 4) ? e.place.q.slice() as Quat : [0, 0, 0, 1];
  o.s = okScale(e.place?.s);
}

// ---------------------------------------------------------------- characters
const sameModel = (r: Rig) => r.kind === 'mannequin' ? rig.kind === 'mannequin' : r.name === rig.name && rig.kind === 'model';
const rigLabel = (r: Rig) => r.kind === 'mannequin' ? 'Mannequin' : r.name.replace(/\.(glb|gltf|vrm)$/i, '');
const rigKind = (r: Rig) => r.kind === 'mannequin' ? 'Built-in' : (r.name.match(/\.(glb|gltf|vrm)$/i)?.[1] || 'model').toUpperCase();
const missingBones = () => REQUIRED.filter(s => !rig.bones[s]);
function refreshRig(): void {
  $('rigname').textContent = rigLabel(rig); $('rigbtn').title = rigLabel(rig); $('rigbadge').textContent = rigKind(rig);
  $('rigwarn').hidden = !missingBones().length;
}
function fillRigMenu(): void {
  const p = $('rigpop'); p.innerHTML = '';
  p.append(el('div', { cls: 'ttl', textContent: 'Character' }));
  for (const r of rigs) {
    const b = el('button', { cls: 'mi' }, el('span', { cls: 'chk', innerHTML: sameModel(r) ? ICON.check : '' }), el('span', { textContent: rigLabel(r) }), el('span', { cls: 'k', textContent: rigKind(r) }));
    b.setAttribute('role', 'menuitemradio'); b.setAttribute('aria-checked', String(sameModel(r)));
    b.onclick = () => { closePop(); if (!sameModel(r)) { canvas.snapshot(); markDirty(); } void setRig(r); };
    p.append(b);
  }
  const loaded = new Set(rigs.map(r => r.name));
  for (const m of folderModels.filter(n => !loaded.has(n))) {
    const b = el('button', { cls: 'mi' }, el('span', { cls: 'chk' }), el('span', { textContent: m.replace(/\.(glb|gltf|vrm)$/i, '') }), el('span', { cls: 'k', textContent: 'models/' }));
    b.setAttribute('role', 'menuitemradio'); b.setAttribute('aria-checked', 'false');
    b.onclick = () => { closePop(); canvas.snapshot(); markDirty(); void loadFolderModel(m); };
    p.append(b);
  }
  p.append(el('hr'));
  const ld = el('button', { cls: 'mi' }, el('span', { cls: 'chk' }), el('span', { textContent: 'Load GLB or VRM…' }));
  ld.onclick = () => { closePop(); $<HTMLInputElement>('rigfile').click(); };
  const mp = el('button', { cls: 'mi', disabled: rig.kind === 'mannequin' }, el('span', { cls: 'chk' }), el('span', { textContent: 'Bone mapping…' }));
  mp.onclick = () => { closePop(); openMapping(); };
  p.append(ld, mp);
  const miss = missingBones(), n = Object.keys(rig.bones).length;
  p.append(el('div', { cls: 'note' + (miss.length ? ' warn' : ''),
    textContent: rig.kind === 'mannequin' ? 'Built-in mannequin, about 1.75 m.' : miss.length ? `${n} bones mapped. Missing: ${miss.join(', ')}.` : `${n} bones mapped.` }));
}
$('rigbtn').onclick = () => { fillRigMenu(); togglePop($('rigpop'), $('rigbtn')); };
/** Dress the active character in a model from the character menu. Each character gets its own copy: a fresh
 *  mannequin, or the model itself if no one else wears it, else a second copy loaded from the same file. */
function setRig(r: Rig, a: Actor = active): void | Promise<void> {
  const done = (inst: Rig) => {
    wear(a, inst);
    refreshRig(); update(); orbitVP.fit(); orbitVP.render(); fillCharacters();
    if (actors.length === 1) store.set('stickform.character', inst.kind === 'mannequin' ? 'mannequin' : inst.name);
    if (a === active && missingBones().length) { toast(`${rigLabel(inst)}: some bones are not mapped. Open Bone mapping from the character menu.`, true); }
  };
  const mine = (x: Rig) => !owner.has(x) || owner.get(x) === a;
  if (r.kind === 'mannequin') return done(a.rig.kind === 'mannequin' ? a.rig : a.rigs.find(x => x.kind === 'mannequin') || makeMannequin());
  const own = mine(r) ? r : a.rigs.find(x => x.name === r.name);
  if (own) return done(own);
  const buf = modelBuf.get(r.name);
  if (!buf) { toast(`Load ${r.name} again to give this character its own copy.`, true); return; }
  toast(`Loading another ${rigLabel(r)}…`);
  return loadModel(buf, r.name).then(inst => {
    // keep a hand-made bone mapping
    const byName = new Map(inst.allBones.map(b => [b.name, b]));
    for (const [slot, b] of Object.entries(r.bones)) { const m = b && byName.get(b.name); if (m) inst.bones[slot as keyof Rig['bones']] = m; }
    captureRest(inst);
    done(inst);
  }).catch(e => toast(`Could not load ${r.name}: ${(e as Error).message}`, true));
}
$<HTMLInputElement>('rigfile').onchange = async e => {
  const input = e.target as HTMLInputElement, f = input.files?.[0];
  input.value = '';
  if (!f) return;
  toast(`Loading ${f.name}…`);
  try {
    const buf = await readFile(f, 'buffer') as ArrayBuffer;
    const r = await loadModel(buf, f.name);
    modelBuf.set(f.name, buf);
    canvas.snapshot(); markDirty();
    rigs.push(r); await setRig(r); toast(`Loaded ${f.name}.`);
    if (project.connected && !(await project.exists('models', f.name))
        && await askConfirm('Keep this character?', `Save a copy of ${f.name} in the models folder, so it is in the character list next time?`, 'Save copy')) {
      await project.write('models', f.name, buf); toast(`Saved to models/${f.name}`); void refreshFolderModels();
    }
  } catch (err) { toast(`Could not load ${f.name}: ${(err as Error).message}`, true); }
};
let folderModels: string[] = [];
async function refreshFolderModels(): Promise<void> {
  folderModels = project.connected ? (await project.list('models', ['.glb', '.gltf', '.vrm'])).map(f => f.name).sort((a, b) => a.localeCompare(b)) : [];
}
/** A model from models/ as a menu entry (loaded once). */
async function folderTemplate(name: string): Promise<Rig | null> {
  const have = rigs.find(r => r.name === name);
  if (have) return have;
  if (!project.connected) return null;
  const f = (await project.list('models', [name.toLowerCase().slice(name.lastIndexOf('.'))])).find(x => x.name === name);
  if (!f) { toast(`models/${name} is missing.`, true); return null; }
  toast(`Loading ${name}…`);
  try { const buf = await (await f.read()).arrayBuffer(), r = await loadModel(buf, name); modelBuf.set(name, buf); rigs.push(r); toast(`Loaded ${name}.`); return r; }
  catch (err) { toast(`Could not load ${name}: ${(err as Error).message}`, true); return null; }
}
async function loadFolderModel(name: string): Promise<Rig | null> {
  const r = await folderTemplate(name);
  if (r) await setRig(r);
  return r ? active.rig : null;
}
function openMapping(): void {
  const m = $('map'); m.innerHTML = '';
  const miss = missingBones();
  $('mp-status').textContent = `${rigLabel(rig)}: ${Object.keys(rig.bones).length} bones mapped.` + (miss.length ? ` Missing: ${miss.join(', ')}.` : ' Starred slots are required.');
  for (const slot of SLOTS) {
    const l = el('label', { textContent: slot + (REQUIRED.includes(slot) ? ' *' : ''), htmlFor: 'map-' + slot });
    const s = el('select', { id: 'map-' + slot });
    s.append(el('option', { value: '-1', textContent: '(none)' }));
    rig.allBones.forEach((b, i) => s.append(el('option', { value: String(i), textContent: b.name || `(unnamed ${i})` })));
    const cur = rig.bones[slot];
    s.value = String(cur ? rig.allBones.indexOf(cur) : -1);
    s.disabled = rig.kind === 'mannequin';
    s.onchange = () => {
      const i = +s.value;
      resetToRest(rig);
      if (i < 0) delete rig.bones[slot]; else rig.bones[slot] = rig.allBones[i];
      normalize(rig);
      refreshRig(); update();
    };
    m.append(l, s);
  }
  $<HTMLDialogElement>('dlg-map').showModal();
}

// ---------------------------------------------------------------- presets: thumbnails, inspector grid, library
const tagCache = new Map<PoseFile, { pts: { x: number; y: number }[]; tag: Tag | null }[]>();
function thumbSVG(d: PoseFile): SVGSVGElement {
  let strokes = tagCache.get(d);
  if (!strokes) { const k = new Sketch(); fromFile(k, d); strokes = k.strokes.map(s => ({ pts: s.pts, tag: s.tag })); tagCache.set(d, strokes); }
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const s of strokes) for (const q of s.pts) { x0 = Math.min(x0, q.x); y0 = Math.min(y0, q.y); x1 = Math.max(x1, q.x); y1 = Math.max(y1, q.y); }
  const size = Math.max(x1 - x0, y1 - y0, 0.05) * 1.25, cx = (x0 + x1) / 2, cy = (y0 + y1) / 2;
  const NS = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(NS, 'svg');
  svg.setAttribute('viewBox', `${cx - size / 2} ${cy - size / 2} ${size} ${size}`); svg.setAttribute('aria-hidden', 'true');
  for (const s of strokes) {
    const p = document.createElementNS(NS, 'polyline');
    p.setAttribute('points', s.pts.map(q => `${q.x.toFixed(4)},${q.y.toFixed(4)}`).join(' '));
    p.setAttribute('fill', 'none'); p.setAttribute('stroke', s.tag ? COLOR[s.tag] : '#b9b5aa');
    p.setAttribute('stroke-width', String(size * 0.022)); p.setAttribute('stroke-linecap', 'round'); p.setAttribute('stroke-linejoin', 'round');
    svg.append(p);
  }
  return svg;
}
function thumbButton(d: PoseFile, onPick: () => void, current: boolean): HTMLButtonElement {
  const b = el('button', { cls: 'thumb', title: d.name }, thumbSVG(d), el('span', { cls: 'tlab', textContent: d.name }));
  b.setAttribute('aria-current', String(current));
  b.onclick = onPick;
  return b;
}
function fillThumbs(): void {
  const g = $('thumbs'); g.innerHTML = '';
  // Everything in the library (presets/, or this browser without a folder), newest first. The card scrolls.
  for (const it of libItems()) {
    const cur = it.src === 'folder' ? currentFile === it.key : !currentFile && currentPreset === (it.scene?.name || it.d.name);
    const b = thumbButton(it.d, () => void thumbPick(it), cur);
    const op = el('span', { cls: 'topen', title: 'Open on its own, in a new tab', innerHTML: '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M7 17 17 7M8 7h9v9"/></svg>' });
    op.setAttribute('role', 'button'); op.setAttribute('aria-label', `Open ${it.scene?.name || it.d.name} in a new tab`);
    op.onclick = e => { e.stopPropagation(); void openInTab(it); };
    b.append(op);
    if (it.src === 'folder') { (b.querySelector('.tlab') as HTMLElement).textContent = it.key.replace(/(\.stickform)?\.json$/i, ''); b.title = `presets/${it.key}`; }
    else if (it.src === 'browser') b.title = `${it.d.name} (stored in this browser)`;
    if (it.scene) b.append(el('em', { cls: 'src scn', textContent: `${it.scene.characters.length} characters` }));
    g.append(b);
  }
  g.querySelector('[aria-current="true"]')?.scrollIntoView({ block: 'nearest' });
}
let libTab: 'a' | 'p' | 's' | 'o' = 'a';
let libObjSel: Cat | null = null;
interface LibItem { d: PoseFile; src: 'folder' | 'browser'; key: string; scene?: SceneFile }
let libSel: LibItem | null = null;
let folderPresets: { file: string; d: PoseFile; scene?: SceneFile }[] = [];
async function refreshFolderPresets(): Promise<void> {
  folderPresets = [];
  if (project.connected) {
    for (const f of await project.list('presets', ['.json'])) {
      try { const d = JSON.parse(await (await f.read()).text()); if (d?.format === 'stickform-pose' && Array.isArray(d.strokes)) folderPresets.push({ file: f.name, d }); else if (isScene(d)) folderPresets.push({ file: f.name, d: sceneThumb(d), scene: d }); } catch { /* not a pose file */ }
    }
  }
  fillThumbs();
  if (!$('ws-library').hidden) fillLibrary();
}
/** The library: the project folder's presets/ when connected (the source of truth; this browser's own saved poses
 *  are listed too, but not its copy of the starters), else this browser's library, seeded once with the starters. */
function libItems(): LibItem[] {
  if (!project.connected) seedBrowserStarters();
  const browser = (userPresets() as (PoseFile | SceneFile)[]).filter(d => !project.connected || !(d as PoseFile).id)
    .map(d => isScene(d) ? { d: sceneThumb(d), src: 'browser' as const, key: d.name, scene: d } : { d, src: 'browser' as const, key: d.name });
  return [...(project.connected ? folderPresets.map(x => ({ d: x.d, src: 'folder' as const, key: x.file, scene: x.scene })) : []), ...browser];
}
/** Put back missing starter poses: into presets/ (by their file name, unless a file still carries that starter's
 *  id), or into this browser's library. */
async function restoreStarters(): Promise<void> {
  let n = 0;
  if (project.connected) {
    const ids = new Set(folderPresets.map(x => (x.d as PoseFile).id).filter(Boolean));
    for (const d of STARTERS) {
      const file = `${d.id}.stickform.json`;
      if (ids.has(d.id) || await project.exists('presets', file)) continue;
      await project.write('presets', file, jsonBlob(d)); n++;
    }
    await refreshFolderPresets();
  } else {
    const have = userPresets(), names = new Set(have.map(d => d.name)), ids = new Set(have.map(d => d.id).filter(Boolean)), add = STARTERS.filter(d => !names.has(d.name) && !ids.has(d.id));
    n = add.length; const err = setUserPresets([...have, ...add]); if (err) { toast(err, true); return; }
    fillThumbs();
  }
  if (!$('ws-library').hidden) fillLibrary();
  toast(n ? `Restored ${n} starter pose${n > 1 ? 's' : ''}${project.connected ? ' into presets/' : ''}.` : 'All starter poses are already there.');
}
/** A preset onto the canvas. A pose while several characters are in the scene only re-poses the active one: the
 *  scene's name and file stay. Anything else becomes the open document (its file, if it came from presets/). */
function usePreset(it: LibItem): void {
  const intoScene = !it.scene && isSceneNow();
  loadPose(it.scene || it.d, true);
  if (!intoScene) { currentFile = it.src === 'folder' ? it.key : null; fileKind = currentFile ? (it.scene ? 'scene' : 'pose') : null; }
  if (!it.scene) active.poseSrc = { src: it.src, key: it.key, name: it.d.name };
  currentPreset = it.scene?.name || it.d.name;
}
/** A preset thumbnail: in a scene it re-poses the selected character; in a pose tab it opens here, unless this tab
 *  has unsaved changes: then it opens in a new tab, so nothing is lost. */
async function thumbPick(it: LibItem): Promise<void> {
  if (!it.scene && isSceneNow()) { if (lockedBlock()) return; usePreset(it); fillThumbs(); fillCharacters(); return; }
  if (!it.scene && lockedBlock()) return;
  if (dirty) {
    const same = it.src === 'folder' && currentFile === it.key;
    await openInTab(it, same);
    toast(same ? `Opened the saved ${it.scene ? 'scene' : 'pose'} in a new tab; your unsaved changes stay in the other tab.` : 'Opened in a new tab: the other one has unsaved changes.');
    return;
  }
  usePreset(it); fillThumbs();
}
function useItem(it: LibItem): void { void openInTab(it).then(() => showWS('pose')); }
function fillLibrary(): void {
  const all = libItems();
  $('liball').textContent = `All · ${all.length}`;
  $('libposes').textContent = `Poses · ${all.filter(x => !x.scene).length}`;
  $('libobj').textContent = `Objects · ${catalogue(true).length}`;
  document.querySelectorAll<HTMLElement>('#libtabs button').forEach(b => b.setAttribute('aria-pressed', String(b.dataset.lib === libTab)));
  // Objects: the shapes and the object files; the toolbar adds, renames and deletes them
  const objs = libTab === 'o';
  for (const id of ['libsave', 'libopen', 'libexp']) $(id).hidden = objs;
  $('libuse').textContent = objs ? 'Add to scene' : 'Open'; $('libuse').title = objs ? 'Add it to the scene being edited (or drag its tile from the Objects tab into a 3D view)' : 'Open it in its own tab';
  $('libimp').textContent = objs ? 'Import object…' : 'Import presets…';
  if (objs) {
    $('libapply').hidden = true;
    const list = catalogue(true);
    if (libObjSel && !list.some(c => c.kind === libObjSel!.kind && c.name === libObjSel!.name)) libObjSel = null;
    const g = $('libgrid'); g.innerHTML = '';
    for (const c of list) {
      const t = objTile(c, () => { libObjSel = c; fillLibrary(); }, libObjSel?.kind === c.kind && libObjSel.name === c.name);
      t.ondblclick = () => { void addFromCat(c); showWS('pose'); };
      g.append(t);
    }
    $('libempty').hidden = true; $('libstarter').hidden = true;
    $<HTMLButtonElement>('libuse').disabled = !libObjSel;
    const file = !!libObjSel && libObjSel.kind === 'mesh';
    $<HTMLButtonElement>('libren').disabled = !file; $<HTMLButtonElement>('libdel').disabled = !file;
    return;
  }
  const list: LibItem[] = libTab === 'p' ? all.filter(x => !x.scene) : libTab === 's' ? all.filter(x => x.scene) : all;
  $('libscn').textContent = `Scenes · ${all.filter(x => x.scene).length}`;
  if (libSel && !list.some(x => x.src === libSel!.src && x.key === libSel!.key)) libSel = null;
  const g = $('libgrid'); g.innerHTML = '';
  for (const it of list) {
    const b = thumbButton(it.d, () => { libSel = it; fillLibrary(); }, libSel?.key === it.key && libSel.src === it.src);
    const label = it.src === 'folder' ? it.key.replace(/(\.stickform)?\.json$/i, '') : (it.scene?.name || it.d.name);
    (b.querySelector('.tlab') as HTMLElement).textContent = label;
    b.title = it.src === 'folder' ? `presets/${it.key}` : `${label} (stored in this browser)`;
    if (it.src === 'browser' && project.connected) b.append(el('em', { cls: 'src', textContent: 'browser' }));
    if (it.scene) b.append(el('em', { cls: 'src scn', textContent: `${it.scene.characters.length} characters` }));
    b.ondblclick = () => useItem(it);
    g.append(b);
  }
  $('libempty').hidden = list.length > 0;
  $('libempty').textContent = libTab === 's' ? 'No scenes yet. Add a second character and save: it goes in here.'
    : project.connected ? 'presets/ is empty. Draw a pose and press Save pose, or restore the starter poses.' : 'Nothing here yet. Draw a pose and save it, or restore the starter poses.';
  $('libstarter').hidden = list.length > 0 || libTab === 's';
  $<HTMLButtonElement>('libuse').disabled = !libSel;
  $('libapply').hidden = !isSceneNow();
  $<HTMLButtonElement>('libapply').disabled = !libSel || !!libSel.scene;
  $('libapply').textContent = `Apply to ${active.name}`;
  $<HTMLButtonElement>('libdel').disabled = !libSel;
  $<HTMLButtonElement>('libren').disabled = !libSel;
  $('libsave').textContent = isSceneNow() ? 'Save current scene' : 'Save current pose';
  fillThumbs();
}
document.querySelectorAll<HTMLElement>('#libtabs button').forEach(b => { b.onclick = () => { libTab = b.dataset.lib as typeof libTab; libSel = null; libObjSel = null; fillLibrary(); }; });
$('librestore').onclick = () => void restoreStarters();
$('st-starters').onclick = () => void restoreStarters();
$('libuse').onclick = () => {
  if (libTab === 'o') { const c = libObjSel; if (c) { void addFromCat(c); showWS('pose'); } return; }
  if (libSel) useItem(libSel);
};
$('libapply').onclick = () => { const it = libSel; if (!it || it.scene || !isSceneNow() || lockedBlock()) return; usePreset(it); fillCharacters(); showWS('pose'); toast(`${it.d.name} applied to ${active.name}.`); };
$('libsave').onclick = async () => {
  if (project.connected || askSave) { await savePose(true); fillLibrary(); return; }
  // no project folder: keep it in this browser
  if (!sketch.strokes.length) { toast('Draw something first.', true); return; }
  const n = await askText('Save to Library', poseName === 'Untitled' ? 'My pose' : poseName); if (!n) return;
  const up = userPresets().filter(d => d.name !== n); up.unshift(isSceneNow() ? sceneFile(n) as unknown as PoseFile : poseFile(n));
  const err = setUserPresets(up);
  if (err) { toast(err, true); return; }
  poseName = n; refreshName(); libSel = null; fillLibrary();
  toast(`Saved “${n}” in this browser. Connect your project folder to keep poses in presets/.`);
};
/** Rename one of your poses or scenes: the name inside the file and the file name in presets/ (or the entry in
 *  this browser). Built-ins can't be renamed. */
async function renameLibItem(it: LibItem): Promise<void> {
  const what = it.scene ? 'scene' : 'pose', old = it.scene ? it.scene.name : it.d.name;
  const shown = it.src === 'folder' ? it.key.replace(/(\.stickform)?\.json$/i, '') : old;
  const n = (await askText(`Rename ${what}`, it.src === 'folder' && shown !== slug(old) ? shown : old, 'Rename'))?.trim();
  if (!n || n === old) return;
  const data = { ...(it.scene || it.d), name: n } as PoseFile | SceneFile;
  if (it.src === 'folder') {
    const to = slug(n) + '.stickform.json';
    if (to !== it.key && await project.exists('presets', to)) { toast(`presets/${to} already exists. Pick another name.`, true); return; }
    try {
      // read the file as it is now (so nothing written elsewhere is lost), set the name, write, then drop the old file
      const f = (await project.list('presets', ['.json'])).find(x => x.name === it.key);
      const cur = f ? JSON.parse(await (await f.read()).text()) : data;
      await project.write('presets', to, jsonBlob({ ...cur, name: n }));
      if (to !== it.key) await project.remove('presets', it.key);
    } catch (e) { toast((e as Error).message, true); return; }
    if (currentFile === it.key) { currentFile = to; poseName = n; refreshName(); }
    libSel = { ...it, key: to };
    toast(`Renamed to presets/${to}`);
    await refreshFolderPresets(); fillLibrary(); return;
  }
  const up = userPresets() as (PoseFile | SceneFile)[];
  if (up.some(d => d.name === n)) { toast(`“${n}” already exists. Pick another name.`, true); return; }
  const i = up.findIndex(d => d.name === old); if (i < 0) return;
  up[i] = data;
  const err = setUserPresets(up as PoseFile[]);
  if (err) { toast(err, true); return; }
  if (poseName === old && !currentFile) { poseName = n; refreshName(); }
  libSel = { ...it, key: n, d: it.scene ? sceneThumb(data as SceneFile) : data as PoseFile, scene: it.scene ? data as SceneFile : undefined };
  toast(`Renamed to “${n}”.`); fillLibrary();
}
$('libren').onclick = () => { if (libTab === 'o') { if (libObjSel?.kind === 'mesh') void renameObjectFile(libObjSel.name); return; } if (libSel) void renameLibItem(libSel); };
/** Rename an object file (in objects/, or opened this visit): objects in open scenes follow the new name. */
async function renameObjectFile(name: string): Promise<void> {
  const ext = name.slice(name.lastIndexOf('.')), base = name.slice(0, -ext.length);
  const n = (await askText('Rename object file', base, 'Rename'))?.trim();
  if (!n || n === base) return;
  const to = n.replace(/[\\/:*?"<>|]/g, '-') + ext;
  if (catalogue(false).some(c => c.name === to)) { toast(`${to} already exists. Pick another name.`, true); return; }
  if (folderObjects.includes(name)) { try { await project.rename('objects', name, to); } catch (e) { toast((e as Error).message, true); return; } }
  const buf = objBuf.get(name); if (buf) { objBuf.delete(name); objBuf.set(to, buf); }
  for (const k of ['mesh:' + name]) { const u = thumbCache.get(k); thumbCache.delete(k); if (u !== undefined) thumbCache.set('mesh:' + to, u); }
  for (const o of [...props, ...docs.flatMap(d => (d.props || []) as Prop[])]) if (o.file === name) o.file = to;
  libObjSel = { kind: 'mesh', name: to, label: n, saved: folderObjects.includes(name) };
  toast(`Renamed to ${to}.`);
  await refreshFolderObjects(); fillLibrary(); fillCharacters();
}
addEventListener('keydown', e => {
  if ($('ws-library').hidden || document.querySelector('dialog[open]') || (e.target as HTMLElement).closest('input, textarea, select')) return;
  if (e.key === 'F2' && libTab === 'o') { if (libObjSel?.kind === 'mesh') { e.preventDefault(); void renameObjectFile(libObjSel.name); } return; }
  if (e.key === 'F2' && libSel) { e.preventDefault(); void renameLibItem(libSel); }
});
$('libdel').onclick = async () => {
  if (libTab === 'o') {
    const c = libObjSel; if (!c || c.kind !== 'mesh') return;
    const saved = folderObjects.includes(c.name);
    if (!(await askConfirm('Delete this object file?', saved ? `objects/${c.name} will be deleted from your project folder. Objects already in scenes stay until you close them.` : `${c.name} was only opened this visit; it leaves the Objects list.`, 'Delete'))) return;
    if (saved) { try { await project.remove('objects', c.name); } catch (e) { toast((e as Error).message, true); return; } }
    else objBuf.delete(c.name);
    libObjSel = null; toast(saved ? `Deleted objects/${c.name}` : `${c.name} removed from the list.`);
    await refreshFolderObjects(); fillLibrary(); return;
  }
  const it = libSel; if (!it) return;
  if (it.src === 'folder') {
    if (!(await askConfirm(`Delete this ${it.scene ? 'scene' : 'pose'}?`, `presets/${it.key} will be deleted from your project folder.`, 'Delete'))) return;
    try { await project.remove('presets', it.key); } catch (e) { toast((e as Error).message, true); return; }
    if (currentFile === it.key) { currentFile = null; fileKind = null; }
    libSel = null; toast(`Deleted presets/${it.key}`); await refreshFolderPresets(); return;
  }
  if (!(await askConfirm(`Delete this ${it.scene ? 'scene' : 'pose'}?`, `“${it.key}” will be deleted from this browser's library.`, 'Delete'))) return;
  const up = userPresets().filter(d => d.name !== it.key);
  const err = setUserPresets(up);
  if (err) toast(err, true); else { toast(`Deleted “${it.key}”.`); libSel = null; fillLibrary(); }
};
$('libexp').onclick = () => { const all = libItems().map(it => it.scene || it.d); if (!all.length) { toast('The library is empty.', true); return; } download('stickform-library.json', jsonBlob(all)); };
let openMode: 'pose' | 'lib' = 'pose';
$('libopen').onclick = () => { openMode = 'pose'; $<HTMLInputElement>('finput').click(); };
$('libimp').onclick = () => { if (libTab === 'o') { $<HTMLInputElement>('objfile').click(); return; } openMode = 'lib'; $<HTMLInputElement>('finput').click(); };
$<HTMLInputElement>('finput').onchange = async e => {
  const input = e.target as HTMLInputElement, f = input.files?.[0];
  input.value = '';
  if (!f) return;
  try {
    const d = JSON.parse(await readFile(f, 'text') as string);
    if (openMode === 'pose') { const one = Array.isArray(d) ? d[0] : d; if (!isScene(one) && isSceneNow() && lockedBlock()) return; loadPose(one, true); if (isScene(one) || !isSceneNow()) { currentFile = null; fileKind = null; } showWS('pose'); toast(`Opened ${f.name}.`); }
    else {
      const list = (Array.isArray(d) ? d : [d]).filter((x: PoseFile) => x && (x.format === 'stickform-pose' || isScene(x)));
      if (project.connected) {
        for (const x of list) await project.write('presets', slug(x.name) + '.stickform.json', jsonBlob(x));
        await refreshFolderPresets(); fillLibrary(); toast(`Imported ${list.length} pose(s) into presets/.`); return;
      }
      const up = userPresets();
      for (const x of list) { const i = up.findIndex(y => y.name === x.name); if (i >= 0) up[i] = x; else up.push(x); }
      const err = setUserPresets(up);
      if (err) toast('Could not save presets in this browser: ' + err, true); else { fillLibrary(); toast(`Imported ${list.length} preset(s).`); }
    }
  } catch (err) { toast(`Could not open ${f.name}: ${(err as Error).message}`, true); }
};

function loadPose(d: PoseFile | SceneFile, undoable = false): void {
  if (isScene(d)) { void loadScene(d, undoable); return; }
  if (undoable) canvas.snapshot();
  // With several characters a preset changes the pose, not where the character stands.
  // in a scene the character keeps its contacts with the others (they follow the new pose)
  const others = isSceneNow() ? posing.contacts.filter(c => c.to !== -1 || c.obj != null) : [];
  const keep = isSceneNow() && !d.place ? { place: clone(posing.place), locked: posing.locked } : null;
  fromFile(sketch, d);
  active.reg = null; // a new drawing: where it sits on the page is worked out again from where it stands
  if (actors.length === 1) pageMap = null;
  const own = cleanContacts(d.attach).filter(c => c.to === -1 && c.obj == null);
  posing.loadFrom({ ...d, ...(keep || {}), contacts: [...others.filter(c => !own.some(o => o.part === c.part)), ...own] });
  syncSnap();
  if (isSceneNow()) { // in a scene (several characters, or objects) a pose goes onto the active one; the scene keeps its name
    canvas.selected = null; closePop(); markDirty(); update(); fillCharacters(); return;
  }
  if (d.output?.w && d.output.h) { out.w = d.output.w; out.h = d.output.h; refreshOutput(); }
  poseName = d.name || 'Untitled'; dirty = false;
  currentPreset = d.name || null;
  canvas.selected = null; closePop();
  refreshName(); fillThumbs(); update();
}

// ---------------------------------------------------------------- settings
function setSwitch(id: string, on: boolean): void { $(id).setAttribute('aria-checked', String(on)); }
$('settings').onclick = () => { setSwitch('st-split', autoSplit); setSwitch('st-labels', canvas.showLabels); setSwitch('st-ground', ground); setSwitch('st-ask', askSave); setSwitch('st-overwrite', askOverwrite); refreshProjectUI(); $<HTMLDialogElement>('dlg-settings').showModal(); };
$('st-labels').onclick = () => { canvas.showLabels = !canvas.showLabels; setSwitch('st-labels', canvas.showLabels); store.set('stickform.labels', canvas.showLabels); canvas.draw(); };
$('st-ground').onclick = () => { ground = !ground; setSwitch('st-ground', ground); store.set('stickform.ground', ground); update(); };
$('st-map').onclick = () => { $<HTMLDialogElement>('dlg-settings').close(); if (rig.kind === 'mannequin') toast('The built-in mannequin needs no mapping. Load a GLB or VRM first.'); else openMapping(); };
$('st-layout').onclick = () => { useLayout({ ...structuredClone(DEFAULT_LAYOUT), views: layout.views }); toast('Viewport layout reset.'); };
// Appearance: light, dark, or follow the system. The paper and the 3D stage have their own colours (below).
type Theme = 'light' | 'dark' | 'system';
let theme: Theme = store.get<Theme>('stickform.theme', 'system');
function applyTheme(): void {
  if (theme === 'system') delete document.documentElement.dataset.theme; else document.documentElement.dataset.theme = theme;
  document.querySelectorAll<HTMLElement>('#st-theme button').forEach(b => b.setAttribute('aria-pressed', String(b.dataset.theme === theme)));
}
document.querySelectorAll<HTMLElement>('#st-theme button').forEach(b => { b.onclick = () => { theme = b.dataset.theme as Theme; store.set('stickform.theme', theme); applyTheme(); applyVpColors(); }; });
applyTheme();
// Viewport colours: the sketch paper (and sketch views, preset thumbnails) and the 3D stage. Auto follows the theme.
type VpColor = 'auto' | string;
const VP_SWATCH: { name: string; paper: string; stage: string }[] = [
  { name: 'Cream', paper: '#f4f2ec', stage: '#e6e4de' },
  { name: 'Light grey', paper: '#e3e4e6', stage: '#d5d6d9' },
  { name: 'Bluish grey', paper: '#d3d8e0', stage: '#c4cad3' },
  { name: 'Slate', paper: '#b7bec9', stage: '#a9b1bd' },
  { name: 'Warm grey', paper: '#d8d4cc', stage: '#cac5bc' },
];
let vpColors = store.get<{ paper: VpColor; stage: VpColor }>('stickform.vpcolors', { paper: 'auto', stage: 'auto' });
function applyVpColors(): void {
  const root = document.documentElement.style;
  if (vpColors.paper === 'auto') { root.removeProperty('--paper'); root.removeProperty('--paper-dot'); }
  else { root.setProperty('--paper', vpColors.paper); root.setProperty('--paper-dot', shade(vpColors.paper, 0.88)); }
  if (vpColors.stage === 'auto') root.removeProperty('--stage'); else root.setProperty('--stage', vpColors.stage);
  const st = getComputedStyle(document.documentElement).getPropertyValue('--stage').trim() || '#e6e4de';
  stage.setBackground(parseInt(st.replace('#', ''), 16));
  for (const [id, key] of [['st-paper', 'paper'], ['st-stage', 'stage']] as const) {
    const box = $(id); box.innerHTML = '';
    const cur = vpColors[key];
    const auto = el('button', { cls: 'auto', textContent: 'Auto', title: 'Follow the theme' });
    auto.setAttribute('aria-pressed', String(cur === 'auto')); auto.onclick = () => setVpColor(key, 'auto');
    box.append(auto);
    let matched = cur === 'auto';
    for (const sw of VP_SWATCH) {
      const c = sw[key], b = el('button', { title: sw.name });
      b.style.background = c; b.setAttribute('aria-label', `${sw.name} ${key === 'paper' ? 'sketch' : '3D'} background`);
      b.setAttribute('aria-pressed', String(cur === c)); if (cur === c) matched = true;
      b.onclick = () => setVpColor(key, c);
      box.append(b);
    }
    const lab = el('label', { title: 'Custom colour' }), inp = el('input') as HTMLInputElement;
    inp.type = 'color'; inp.value = cur === 'auto' ? (key === 'paper' ? '#d3d8e0' : '#c4cad3') : cur;
    inp.setAttribute('aria-label', `Custom ${key === 'paper' ? 'sketch' : '3D'} background colour`);
    inp.oninput = () => setVpColor(key, inp.value, false);
    inp.onchange = () => setVpColor(key, inp.value);
    lab.setAttribute('aria-pressed', String(!matched));
    if (!matched) lab.style.background = cur;
    lab.append(inp); box.append(lab);
  }
  renderAll();
}
function setVpColor(key: 'paper' | 'stage', c: VpColor, rebuild = true): void {
  vpColors = { ...vpColors, [key]: c }; store.set('stickform.vpcolors', vpColors);
  if (rebuild) applyVpColors();
  else { // while dragging in the colour picker: only recolour
    const root = document.documentElement.style;
    if (key === 'paper') { root.setProperty('--paper', c); root.setProperty('--paper-dot', shade(c, 0.88)); }
    else { root.setProperty('--stage', c); stage.setBackground(parseInt(c.slice(1), 16)); renderAll(); }
  }
}
applyVpColors();
matchMedia('(prefers-color-scheme: dark)').addEventListener?.('change', () => applyVpColors());
$('st-overwrite').onclick = () => { askOverwrite = !askOverwrite; setSwitch('st-overwrite', askOverwrite); store.set('stickform.askOverwrite', askOverwrite); };
$('st-ask').onclick = () => { askSave = !askSave; setSwitch('st-ask', askSave); store.set('stickform.askSave', askSave); };
$('st-proj').onclick = async () => { if (project.pending) await project.reconnect(); else await project.pick(); };
$('st-projoff').onclick = async () => { await project.disconnect(); toast('Project folder disconnected. Saving falls back to downloads.'); };
const START_HINT = 'Double-click “Start Stickform” in the project folder: Stickform then opens in your browser and saves straight into presets/, renders/ and models/ (any browser).';
function refreshProjectUI(): void {
  const b = $('projbtn'), t = $('projtext');
  b.hidden = false;
  b.classList.toggle('warn', !project.connected);
  b.classList.toggle('connected', project.connected);
  t.textContent = project.connected ? project.name : project.pending ? `Allow ${project.name}` : project.supported ? 'Connect folder' : 'Files download';
  b.title = project.server ? `Project folder: ${project.name} (opened with Start Stickform). Poses save to presets/, renders to renders/, characters come from models/.`
    : project.connected ? `Project folder: ${project.name}. Poses save to presets/, renders to renders/, characters come from models/.`
    : project.pending ? `Click to allow access to ${project.name} again (the browser asks once per visit).`
    : project.supported ? 'Pick your Stickform folder so poses, renders and characters are saved there.' : START_HINT;
  $('st-projname').textContent = project.server ? `${project.name}: opened with Start Stickform, files go straight into its folders.`
    : !project.supported ? 'Files download for now. ' + START_HINT
    : project.connected ? project.name : project.pending ? `${project.name} (needs your permission)` : 'Not connected: files download instead. Or use Start Stickform in the project folder.';
  $('st-proj').textContent = project.connected ? 'Change…' : project.pending ? 'Allow' : 'Connect…';
  $('st-proj').hidden = !!project.server || !project.pickable;
  $('st-projoff').hidden = !!project.server || (!project.connected && !project.pending);
}
$('projbtn').onclick = async () => {
  if (project.connected) { $('settings').click(); return; }
  if (!project.supported) { toast(START_HINT); return; }
  if (project.pending) { if (!(await project.reconnect())) toast('Access not allowed.', true); return; }
  if (!(await project.pick())) toast('No folder picked. Pick the Stickform folder (the one with presets, models and renders).', true);
};
project.onChange(async () => {
  refreshProjectUI();
  await Promise.all([refreshFolderPresets(), refreshFolderModels(), refreshFolderObjects()]);
  if (project.connected) {
    const want = store.get<string>('stickform.character', 'mannequin');
    if (want !== 'mannequin' && rig.name !== want && folderModels.includes(want)) await loadFolderModel(want);
  }
  if (!$('ws-renders').hidden) void fillRenders();
});
canvas.showLabels = store.get('stickform.labels', true);
ground = store.get('stickform.ground', true);

// ---------------------------------------------------------------- pose card (inspector), draft bar
const PART_COLOR = (p: Part) => COLOR[p === 'neck' ? 'head' : p];
function refreshPoseCard(): void {
  const selB = posing.sel, part = selB ? PART_OF[selB] : posing.target;
  const info = $('psel'); info.innerHTML = '';
  if (selB && J) {
    const a = angles(dirsOf(J)[selB]);
    const dot = el('span', { cls: 'dot' }); dot.style.background = PART_COLOR(PART_OF[selB]);
    info.append(el('div', { cls: 'pname' }, dot, el('b', { textContent: BONE_NAME[selB] }), el('span', { cls: 'pp', textContent: PART_NAME[PART_OF[selB]] })));
    void a;
  } else if (part) {
    const dot = el('span', { cls: 'dot' }); dot.style.background = PART_COLOR(part);
    info.append(el('div', { cls: 'pname' }, dot, el('b', { textContent: PART_NAME[part] }), el('span', { cls: 'pp', textContent: 'edit pen' })));
  } else if (posing.rootSel) {
    info.append(el('div', { cls: 'pname' }, el('b', { textContent: active.name }), el('span', { cls: 'pp', textContent: 'whole character' })));
  }
  const cp = posing.copyPart(), isLimb = !!(cp && PAIR[cp]);
  $<HTMLButtonElement>('pcopy').disabled = !isLimb;
  $<HTMLButtonElement>('pcopy').textContent = isLimb ? `Copy to ${PART_NAME[PAIR[cp!]!].toLowerCase()}` : 'Copy to other side';
  const cs = $<HTMLButtonElement>('copyside');
  cs.disabled = !isLimb;
  cs.title = isLimb ? `Copy ${PART_NAME[cp!].toLowerCase()} to ${PART_NAME[PAIR[cp!]!].toLowerCase()} (C)` : 'Copy a limb to the other side (C): select an arm or a leg, or edit one first';
  cs.setAttribute('aria-label', cs.title);
  $('preach').setAttribute('aria-pressed', String(!!posing.reaching));
  $<HTMLButtonElement>('preach').disabled = !(cp && /^(arm|leg)/.test(cp));
  // Numbers for the selected bone: rotation (heading, elevation) and where its end is (world metres)
  const bi = posing.boneInfo();
  $('pbone').hidden = !bi;
  if (bi && selB) {
    const vals: Record<string, number> = { 'pb-rx': bi.rot[0], 'pb-ry': bi.rot[1], 'pb-rz': bi.rot[2], 'pb-x': bi.end[0], 'pb-y': bi.end[1], 'pb-z': bi.end[2] };
    // a position the bone could not reach: the numbers are what was set; the real end is in the tooltip
    for (const [k, id] of (['pb-x', 'pb-y', 'pb-z'] as const).entries()) {
      const i = $<HTMLInputElement>(id); i.classList.toggle('off', bi.off);
      i.title = bi.off ? `Out of reach: the end is at ${bi.real[k].toFixed(3)} m` : '';
    }
    // a group being typed in is left alone until it is applied
    const typing = (ids: string[]) => ids.includes((document.activeElement as HTMLElement | null)?.id || '');
    const rotT = typing(['pb-rx', 'pb-ry', 'pb-rz']), endT = typing(['pb-x', 'pb-y', 'pb-z']);
    for (const [id, v] of Object.entries(vals)) {
      const isRot = id.startsWith('pb-r');
      if ((rotT && isRot) || (endT && !isRot)) continue;
      $<HTMLInputElement>(id).value = String(+v.toFixed(isRot ? 1 : 3) || 0);
    }
    const what = /^arm[LR]2$/.test(selB) ? 'hand' : /^leg[LR]2$/.test(selB) ? 'foot' : selB === 'face' ? 'facing tip' : 'bone end';
    $('pb-endlab').innerHTML = `${what[0].toUpperCase() + what.slice(1)} position <span>m</span>`;
    const dis = posing.isPinned(PART_OF[selB]);
    for (const id of ['pb-rx', 'pb-ry', 'pb-rz', 'pb-x', 'pb-y', 'pb-z']) $<HTMLInputElement>(id).disabled = dis;
  }
  $('presetpart').hidden = !part;
  if (part) $('presetpart').textContent = `Reset ${PART_NAME[part].toLowerCase()}`;
  // The whole character: position and turn (Pose card numbers; the gizmo in 3D views)
  $('pmove').setAttribute('aria-pressed', String(posing.rootSel));
  $('pchar').hidden = !posing.rootSel;
  const lk = $<HTMLButtonElement>('plock');
  lk.setAttribute('aria-pressed', String(posing.locked));
  lk.innerHTML = (posing.locked ? ICON.lock + 'Locked' : ICON.unlock + 'Lock');
  lk.title = posing.locked ? 'The whole character is locked: click to unlock (Shift K)' : 'Lock the whole character: no part changes, no moving or turning (Shift K)';
  lk.setAttribute('aria-label', posing.locked ? 'Unlock character' : 'Lock character');
  $('pchar').classList.toggle('locked', posing.locked);
  for (const id of [...placeIds('pc'), 'pc-reset']) $<HTMLInputElement>(id).disabled = posing.locked;
  if (posing.rootSel) fillPlace('pc', posing.place.p, posing.place.q, posing.place.s);
  // An object selected: its own numbers; the character's sections step aside
  const ob = selProp;
  $('posecard').classList.toggle('objmode', !!ob);
  $('pobj').hidden = !ob;
  if (ob) {
    info.innerHTML = '';
    const od = el('span', { cls: 'dot' }); od.style.background = ob.tint;
    info.append(el('div', { cls: 'pname' }, od, el('b', { textContent: ob.name }), el('span', { cls: 'pp', textContent: ob.kind === 'mesh' ? `object · ${ob.file}` : PROP_NAME[ob.kind].toLowerCase() })));
    fillPlace('po', ob.p, ob.q, ob.s);
    for (const id of [...placeIds('po'), 'po-reset']) $<HTMLInputElement>(id).disabled = ob.locked;
    $('pochar').classList.toggle('locked', ob.locked);
    const ol = $<HTMLButtonElement>('po-lock');
    ol.setAttribute('aria-pressed', String(ob.locked)); ol.innerHTML = ob.locked ? ICON.lock + 'Locked' : ICON.unlock + 'Lock';
    ol.title = ob.locked ? 'Locked: click to unlock' : 'Lock: no moving, turning or scaling';
    const h = ob.hold, ha = h && actors.find(a => a.id === h.to);
    $('po-hold').setAttribute('aria-pressed', String(objAttaching === ob));
    $('po-holdtxt').textContent = objAttaching === ob ? 'click a character in 3D…' : ha ? `held by ${ha.name} · ${BONE_NAME[h!.bone].toLowerCase()}${ob.locked ? ' (paused: locked)' : ''}` : '';
    $('po-detach').hidden = !h;
  }
  refreshLookCard();
  const pin = $<HTMLButtonElement>('ppin');
  pin.disabled = !part;
  pin.innerHTML = (part && posing.pins.has(part) ? ICON.unlock + ' Unpin ' : ICON.lock + ' Pin ') + (part ? PART_NAME[part].toLowerCase() : 'part');
  // Drafts
  const dl = $('pdrafts'); dl.innerHTML = '';
  for (const d of posing.drafts) {
    const dot = el('span', { cls: 'dot' }); dot.style.background = PART_COLOR(d.part);
    const ap = el('button', { cls: 'eb', title: 'Apply', innerHTML: ICON.check }); ap.setAttribute('aria-label', `Apply the ${PART_NAME[d.part]} draft`); ap.onclick = () => posing.apply(d.part);
    const ds = el('button', { cls: 'eb', title: 'Discard', innerHTML: ICON.close }); ds.setAttribute('aria-label', `Discard the ${PART_NAME[d.part]} draft`); ds.onclick = () => posing.discard(d.part);
    dl.append(el('div', { cls: 'erow' }, dot, el('span', { cls: 'en', textContent: PART_NAME[d.part] }), el('span', { cls: 'est draft', textContent: 'Draft' }), ap, ds));
  }
  $('pdraftacts').hidden = !posing.drafts.length;
  // Pins
  const pl = $('ppins'); pl.innerHTML = '';
  for (const p of posing.pins) {
    const b = el('button', { cls: 'pinchip', title: 'Unpin', innerHTML: `${ICON.lock}<span>${PART_NAME[p]}</span>${ICON.close}` });
    b.setAttribute('aria-label', `Unpin ${PART_NAME[p]}`); b.onclick = () => posing.togglePin(p);
    pl.append(b);
  }
  pl.hidden = !posing.pins.size;
  refreshContacts();
  refreshDrafts();
  refreshHelp();
}
const HAND: Record<Contact['part'], string> = { armL: 'Left hand', armR: 'Right hand', legL: 'Left foot', legR: 'Right foot' };
const CSTATE: Record<ContactMark['state'], string> = { ok: 'touching', far: "can't reach", paused: 'paused' };
/** Pose card: Keep attached, and the active character's contacts (where each holds, numbers, Detach). */
let contactSig = '';
function refreshContacts(): void {
  $('pattach').setAttribute('aria-checked', String(posing.attachOn));
  const sig = actors.map(a => contactsOf(a).length).join(',');
  if (sig !== contactSig) { contactSig = sig; fillCharacters(); } // the Scene card shows "n attached"
  const box = $('pconts'), list = posing.contacts;
  box.hidden = !list.length;
  if (box.contains(document.activeElement) && document.activeElement?.tagName === 'INPUT') return; // typing: leave the boxes alone
  if (document.body.classList.contains('scrubbing')) return; // dragging one of its numbers
  box.innerHTML = '';
  for (const c of list) {
    const who = c.obj != null ? props.find(o => o.id === c.obj)?.name || '?' : c.to === -1 ? 'itself' : actors.find(a => a.id === c.to)?.name || '?';
    const st = marks.find(m => m.holder === active.id && m.part === c.part)?.state ?? 'ok';
    const dot = el('span', { cls: 'dot' }); dot.style.background = PART_COLOR(c.part);
    const det = el('button', { cls: 'btn sm', textContent: 'Detach', title: 'Let go: the hand or foot stays where it is' });
    det.setAttribute('aria-label', `Detach ${HAND[c.part].toLowerCase()}`); det.onclick = () => posing.detach(c.part);
    const lbl = c.obj != null ? `${who} (object)` : `${who} · ${BONE_NAME[c.bone].toLowerCase()}`;
    const top = el('div', { cls: 'ctop' }, dot, el('span', { cls: 'ctx', textContent: HAND[c.part] }), el('span', { cls: `cst ${st}`, textContent: CSTATE[st] }), det);
    const mode = el('div', { cls: 'seg tiny cmode', role: 'group' } as Partial<HTMLDivElement>);
    mode.setAttribute('aria-label', `${HAND[c.part]}: follow or stick`);
    for (const [m, name, tip] of [['follow', 'Follow', 'Follows the spot while in reach; stretches toward it when too far'], ['stick', 'Stick', 'Never lets go: when too far, the other character is pulled along by its own IK']] as const) {
      const b = el('button', { textContent: name, title: tip }); b.dataset.mode = m;
      b.setAttribute('aria-pressed', String((c.mode || 'follow') === m));
      b.onclick = () => { posing.attachMode = m; store.set('stickform.attachMode', m); posing.setContact(c.part, { mode: m }); };
      mode.append(b);
    }
    const who2 = el('div', { cls: 'ctop' }, el('span', { cls: 'cwho', textContent: '→ ' + lbl, title: '→ ' + lbl }), mode);
    const num = (label: string, val: number, aria: string, _step: string, set: (v: number) => void) => {
      const i = el('input', { type: 'number', step: 'any', value: String(+val.toFixed(1)) }); i.setAttribute('aria-label', aria);
      i.dataset.scrub = label === 'Along' ? '0.5' : '0.1'; i.dataset.apply = 'change';
      i.disabled = posing.locked;
      i.addEventListener('change', () => { const v = Number(i.value); if (isFinite(v)) set(v); });
      i.addEventListener('keydown', e => { if (e.key === 'Enter') i.blur(); });
      return el('label', {}, label, i);
    };
    const grid = el('div', { cls: 'pcgrid' },
      num('Along', c.t * 100, `${HAND[c.part]}: how far along the ${BONE_NAME[c.bone].toLowerCase()}, percent`, '1', v => posing.setContact(c.part, { t: v / 100 })),
      num('Front', c.off[1] * 100, `${HAND[c.part]}: offset toward the front, centimetres`, '0.5', v => posing.setContact(c.part, { off: [c.off[0], v / 100, c.off[2]] })),
      num('Side', c.off[2] * 100, `${HAND[c.part]}: offset to the side, centimetres`, '0.5', v => posing.setContact(c.part, { off: [c.off[0], c.off[1], v / 100] })));
    const row = el('div', { cls: 'pcont' }, top, who2, ...(c.obj != null ? [] : [grid]));
    row.dataset.part = c.part;
    box.append(row);
  }
}
$('pattach').onclick = () => { posing.attachOn = !posing.attachOn; store.set('stickform.attach', posing.attachOn); refreshPoseCard(); toast(posing.attachOn ? 'Keep attached: Reach to… now leaves a lasting contact.' : 'Reach to… snaps once (Shift R still attaches).'); };
posing.onChange(() => { if (selProp && (posing.sel || posing.rootSel)) { selProp = null; fillCharacters(); } canvas.draw(); posing.drawTiles(); posing.paintInks(); refreshPoseCard(); refreshStatus(); });
$('pcopy').onclick = () => posing.copyToOther();
$('preach').onclick = () => posing.startReach();
function toggleGhosts(): void { posing.ghosts = !posing.ghosts; $('ghosts').setAttribute('aria-pressed', String(posing.ghosts)); canvas.draw(); posing.drawTiles(); toast(posing.ghosts ? 'Other characters shown faintly.' : 'Other characters hidden in the sketch views.'); }
$('ghosts').onclick = toggleGhosts;
function toggleMove(on = !posing.rootSel): void { if (on) setTool('select'); posing.rootSel = on; update(); if (on && posing.locked) toast('This character is locked (Shift K unlocks it).', true); }
$('pmove').onclick = () => toggleMove();
$('plock').onclick = () => posing.toggleLock();
// Position, rotation and scale numbers: `pc` the whole character, `po` the selected object.
const placeIds = (pre: string) => ['x', 'y', 'z', 'yaw', 'pitch', 'roll', 'sx', 'sy', 'sz'].map(k => `${pre}-${k}`);
let scaleLink = store.get('stickform.scaleLink', true);
function fillPlace(pre: string, p: V3n, q: Quat, sc: V3n): void {
  const e = new THREE.Euler().setFromQuaternion(new THREE.Quaternion(...q), 'YXZ'), deg = (r: number) => +(r * 180 / Math.PI).toFixed(1);
  const vals: Record<string, number> = { x: +p[0].toFixed(3), y: +p[1].toFixed(3), z: +p[2].toFixed(3), yaw: deg(e.y), pitch: deg(e.x), roll: deg(e.z),
    sx: +sc[0].toFixed(3), sy: +sc[1].toFixed(3), sz: +sc[2].toFixed(3) };
  for (const [k, v] of Object.entries(vals)) { const i = $<HTMLInputElement>(`${pre}-${k}`); if (document.activeElement !== i) i.value = String(v); }
  $(`${pre}-slink`).setAttribute('aria-pressed', String(scaleLink));
}
/** The numbers as a place. With the scale linked, the axis that changed scales all three by the same factor. */
function readPlace(pre: string, oldS: V3n, changed?: string): { p: V3n; q: Quat; s: V3n } {
  const n = (k: string, d = 0) => { const v = Number($<HTMLInputElement>(`${pre}-${k}`).value); return isFinite(v) && $<HTMLInputElement>(`${pre}-${k}`).value.trim() !== '' ? v : d; };
  const r = (d: number) => d * Math.PI / 180;
  const Q = new THREE.Quaternion().setFromEuler(new THREE.Euler(r(n('pitch')), r(n('yaw')), r(n('roll')), 'YXZ'));
  let sc: V3n = [n('sx', oldS[0]), n('sy', oldS[1]), n('sz', oldS[2])];
  const ax = changed ? ['sx', 'sy', 'sz'].indexOf(changed.slice(pre.length + 1)) : -1;
  if (scaleLink && ax >= 0 && Math.abs(oldS[ax]) > 1e-9) { const f = sc[ax] / oldS[ax]; sc = oldS.map((v, i) => i === ax ? sc[ax] : +(v * f).toFixed(4)) as V3n; }
  return { p: [n('x'), n('y'), n('z')], q: [Q.x, Q.y, Q.z, Q.w], s: okScale(sc) };
}
function placeFromInputs(changed?: string): void {
  const pl = readPlace('pc', posing.place.s, changed);
  posing.setPlace(pl.p, pl.q, pl.s);
}
function propFromInputs(changed?: string): void {
  const o = selProp; if (!o) return;
  const pl = readPlace('po', o.s, changed);
  setProp(o, pl, document.body.classList.contains('scrubbing') && scrubTaken);
  scrubTaken = document.body.classList.contains('scrubbing');
}
/** A number drag on an object's boxes takes one undo step (its first change). */
let scrubTaken = false;
for (const id of [...placeIds('pc'), ...placeIds('po')]) {
  const i = $<HTMLInputElement>(id), apply = () => (id.startsWith('po-') ? propFromInputs(id) : placeFromInputs(id));
  i.addEventListener('change', apply);
  i.addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); apply(); i.select(); } if (e.key === 'Escape') { refreshPoseCard(); i.blur(); } e.stopPropagation(); });
}
for (const id of ['pc-slink', 'po-slink']) $(id).onclick = () => { scaleLink = !scaleLink; store.set('stickform.scaleLink', scaleLink); refreshPoseCard();
  toast(scaleLink ? 'Scale linked: one axis scales all three.' : 'Scale unlinked: each axis on its own.'); };
$('pc-reset').onclick = () => posing.setPlace([0, 0, 0], [0, 0, 0, 1], [1, 1, 1]);
$('po-reset').onclick = () => { const o = selProp; if (o) setProp(o, { p: [o.p[0], 0, o.p[2]], q: [0, 0, 0, 1], s: [o.base, o.base, o.base] }); };
$('po-lock').onclick = () => { const o = selProp; if (o) { setProp(o, { locked: !o.locked }); refreshPoseCard(); } };
$('po-dup').onclick = () => { if (selProp) duplicateProp(selProp); };
$('po-del').onclick = () => { if (selProp) deleteProp(selProp); };
/** Look buttons (Original / Tint / Solid). */
// ---------------------------------------------------------------- Colour & look card (the selected object, else the active character)
const SHUFFLE = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M16 3h5v5M4 20 21 3M21 16v5h-5M15 15l6 6M4 4l5 5"/></svg>';
let lookSig = '';
function refreshLookCard(): void {
  const o = selProp, a = active, tint = o ? o.tint : a.tint;
  const has = o ? o.kind === 'mesh' : a.rig.kind === 'model', look = o ? o.look : a.look;
  $('lk-name').textContent = o ? o.name : a.name;
  const sig = [o?.id ?? 'a' + a.id, tint, has, look, allSolid].join('|');
  $('allsolid').setAttribute('aria-checked', String(allSolid));
  if (sig === lookSig) return; lookSig = sig;
  const sw = $('lk-sw'); sw.innerHTML = '';
  const cur = el('span', { cls: 'cur', title: `Its colour: ${tint}` }); cur.style.cssText = `width:44px;height:26px;border-radius:7px;border:1px solid var(--line2);background:${tint}`;
  sw.append(cur);
  for (const t of TINTS) {
    const b = el('button', { title: t.name }); b.style.background = t.c; b.setAttribute('aria-label', t.name); b.setAttribute('aria-pressed', String(tint === t.c));
    b.onclick = () => setColour(t.c); sw.append(b);
  }
  const lab = el('label', { title: 'Any colour' }), inp = el('input') as HTMLInputElement;
  inp.type = 'color'; inp.value = tint; inp.setAttribute('aria-label', 'Any colour'); inp.onchange = () => setColour(inp.value);
  lab.style.background = 'conic-gradient(#c7a796,#cdbe98,#a9b79e,#96b3af,#9fafc3,#b2a7c3,#c3a1ab,#c7a796)'; lab.append(inp); sw.append(lab);
  const sh = el('button', { title: 'A new random colour, unlike the others in the scene', innerHTML: SHUFFLE, id: 'lk-shuffle' }); sh.setAttribute('aria-label', 'Random colour');
  sh.onclick = () => setColour(randomTint(tint)); sw.append(sh);
  $('lk-lookrow').hidden = !has;
  document.querySelectorAll<HTMLButtonElement>('#lk-look button').forEach(b => {
    b.setAttribute('aria-pressed', String((allSolid ? 'solid' : look) === b.dataset.look));
    b.disabled = allSolid && b.dataset.look !== 'solid';
  });
  $('lk-look').title = allSolid ? 'Everything in solid colours is on' : '';
  $('lk-note').textContent = has ? '' : o ? 'Shapes are always their colour.' : 'The mannequin is always its colour. Models (character menu) can also show Tint or Solid.';
}
/** A colour for the selected object (or the active character). */
function setColour(c: string): void {
  if (selProp) setProp(selProp, { tint: c }); else setTint(active, c);
}
document.querySelectorAll<HTMLButtonElement>('#lk-look button').forEach(b => { b.onclick = () => {
  const lk = b.dataset.look as Look;
  if (selProp) { setProp(selProp, { look: lk }); return; }
  if (lk === active.look) return;
  canvas.snapshot(); active.look = lk; markDirty(); update(); fillCharacters();
}; });
$('po-hold').onclick = () => startHoldPick();
$('po-detach').onclick = () => { if (selProp) detachProp(selProp); };
posing.attachMode = store.get<'follow' | 'stick'>('stickform.attachMode', 'follow');
$('copyside').onclick = () => posing.copyToOther();
$('preset').onclick = () => posing.resetPose();
$('presetpart').onclick = () => { const p = posing.sel ? PART_OF[posing.sel] : posing.target; if (p) posing.resetPose(p); };
function boneFromInputs(kind: 'rot' | 'end'): void {
  const n = (id: string) => { const v = Number($<HTMLInputElement>(id).value); return isFinite(v) ? v : 0; };
  if (kind === 'rot') posing.setBoneEuler(n('pb-rx'), n('pb-ry'), n('pb-rz'));
  else posing.setBoneEnd([n('pb-x'), n('pb-y'), n('pb-z')], document.body.classList.contains('scrubbing'));
}
// Each group (rotation; end position) applies as a whole: on Enter, or when focus leaves the group, so typing X, Y
// and Z one after another never moves the bone to a half-typed point.
for (const [kind, ids] of [['rot', ['pb-rx', 'pb-ry', 'pb-rz']], ['end', ['pb-x', 'pb-y', 'pb-z']]] as const) {
  const inputs = ids.map(id => $<HTMLInputElement>(id));
  let before = '';
  const snap = () => inputs.map(i => i.value).join('|');
  const apply = () => { if (snap() !== before) { boneFromInputs(kind); before = snap(); } };
  for (const i of inputs) {
    i.addEventListener('focus', () => { if (!inputs.includes(document.activeElement as HTMLInputElement) || !before) before = snap(); });
    i.addEventListener('focusin', e => { if (!inputs.includes((e as FocusEvent).relatedTarget as HTMLInputElement)) before = snap(); });
    i.addEventListener('focusout', e => { if (!inputs.includes((e as FocusEvent).relatedTarget as HTMLInputElement)) apply(); });
    i.addEventListener('keydown', e => {
      // Ctrl Z / Ctrl Y here are the app's undo and redo (what was typed is dropped)
      if ((e.ctrlKey || e.metaKey) && /^[zy]$/i.test(e.key)) { e.preventDefault(); e.stopPropagation(); before = snap(); refreshPoseCard(); inputs.forEach(x => { x.value = ''; }); before = snap(); i.blur(); if (e.key.toLowerCase() === 'y' || e.shiftKey) canvas.redo(); else canvas.undo(); return; }
      if (e.key === 'Enter') { e.preventDefault(); apply(); i.select(); }
      if (e.key === 'Escape') { before = snap(); i.blur(); refreshPoseCard(); }
      e.stopPropagation();
    });
  }
}
$('ppin').onclick = () => { const p = posing.sel ? PART_OF[posing.sel] : posing.target; if (p) posing.togglePin(p); };

// Drag a number to change it (like Blender): press on a number box and drag left or right; Shift drags finer. A
// press without dragging puts the cursor in the box to type. One undo step per drag.
function applyScrub(i: HTMLInputElement): void {
  const id = i.id;
  if (id.startsWith('pb-r')) boneFromInputs('rot');
  else if (/^pb-[xyz]$/.test(id)) boneFromInputs('end');
  else if (id.startsWith('pc-')) placeFromInputs(id);
  else if (id.startsWith('po-')) propFromInputs(id);
  else if (i.dataset.apply === 'change') i.dispatchEvent(new Event('change'));
}
document.addEventListener('pointerdown', e => {
  const i = e.target as HTMLInputElement;
  if (e.button !== 0 || !(i instanceof HTMLInputElement) || !i.dataset.scrub || i.disabled || document.activeElement === i) return;
  e.preventDefault(); // no focus yet: it may be a drag
  const rate = Number(i.dataset.scrub) || 0.1, dec = rate < 0.05 ? 3 : 1;
  let v = Number(i.value) || 0, lastX = e.clientX, moved = false, travel = 0;
  // the rest of its group stays exactly as it was for the whole drag (only this axis moves)
  const pre = i.id.slice(0, 2);
  const group = i.id.startsWith('pb-r') ? ['pb-rx', 'pb-ry', 'pb-rz'] : /^pb-[xyz]$/.test(i.id) ? ['pb-x', 'pb-y', 'pb-z'] : /^p[co]-[xyz]$/.test(i.id) ? [`${pre}-x`, `${pre}-y`, `${pre}-z`]
    : /^p[co]-(yaw|pitch|roll)$/.test(i.id) ? [`${pre}-pitch`, `${pre}-yaw`, `${pre}-roll`] : /^p[co]-s[xyz]$/.test(i.id) && !scaleLink ? [`${pre}-sx`, `${pre}-sy`, `${pre}-sz`] : [];
  const frozen = group.filter(g => g !== i.id).map(g => [g, $<HTMLInputElement>(g).value] as const);
  const locked = () => document.pointerLockElement === i;
  let skipOne = false;
  const onLock = () => { if (locked()) skipOne = true; };
  document.addEventListener('pointerlockchange', onLock);
  const move = (ev: PointerEvent) => {
    // with the pointer locked (like Blender) the drag is endless: the screen edge does not stop it
    // (a few browsers report one odd jump as the lock starts: skipped; no movement reported while the position
    // changes means the lock is not in effect)
    if (skipOne) { skipOne = false; lastX = ev.clientX; return; }
    let dx = ev.clientX - lastX; lastX = ev.clientX;
    if (locked()) { if (Math.abs(ev.movementX) > 200) return; dx = ev.movementX; } // (ignore a bogus jump)
    if (!moved) {
      travel += dx; if (Math.abs(travel) < 3) return;
      moved = true; canvas.beginBatch(); document.body.classList.add('scrubbing'); i.classList.add('scrubbing');
      if (!(window as unknown as { stickformNoLock?: boolean }).stickformNoLock) {
        try { const r = i.requestPointerLock?.() as unknown as Promise<void> | undefined; r?.catch?.(() => { /* no lock: plain drag */ }); } catch { /* no lock */ }
      }
    }
    v += (moved && travel ? travel : dx) * rate * (ev.shiftKey ? 0.1 : 1); travel = 0;
    i.value = String(+v.toFixed(dec));
    for (const [g, val] of frozen) $<HTMLInputElement>(g).value = val;
    applyScrub(i);
  };
  const up = () => {
    document.removeEventListener('pointermove', move); document.removeEventListener('pointerup', up); document.removeEventListener('pointercancel', up);
    document.removeEventListener('pointerlockchange', onLock);
    scrubTaken = false;
    if (locked()) document.exitPointerLock();
    if (!moved) { i.focus(); i.select(); return; }
    canvas.endBatch(); document.body.classList.remove('scrubbing'); i.classList.remove('scrubbing');
    refreshPoseCard();
  };
  document.addEventListener('pointermove', move); document.addEventListener('pointerup', up); document.addEventListener('pointercancel', up);
}, true);
$('applyall').onclick = () => posing.apply();
$('discardall').onclick = () => { while (posing.drafts.length) posing.discard(posing.drafts[posing.drafts.length - 1].part); };

// ---------------------------------------------------------------- help box (the active tool, explained where you work)
let helpBoxEl: HTMLElement | null = null;
/** The one help box (made on first use, then moved between viewports). */
function helpBoxOf(): HTMLElement {
  if (!helpBoxEl) { helpBoxEl = el('div', { cls: 'helpbox', id: 'helpbox' }); helpBoxEl.setAttribute('role', 'note'); helpBoxEl.setAttribute('aria-label', 'Help'); helpBoxEl.hidden = true; }
  return helpBoxEl;
}
function helpState(k: Kind): HelpState {
  const view = k === 'output' || k === 'orbit' ? '3d' : k === 'sketch' ? 'sketch' : tileApi[k]?.mode() === 'scene' ? 'scene' : 'tile';
  const sb = posing.sel;
  return {
    tool: canvas.tool as HelpState['tool'], view,
    bone: sb && J ? { name: BONE_NAME[sb], part: PART_NAME[PART_OF[sb]].toLowerCase(), limb: /^(arm|leg)/.test(sb), pinned: posing.pins.has(PART_OF[sb]) } : null,
    rootSel: posing.rootSel, reaching: posing.reaching ? { what: posing.reaching.startsWith('arm') ? 'hand' : 'foot', attach: posing.reachAttach } : null,
    drafts: posing.drafts.length, altPart: posing.altNext() ? PART_NAME[posing.altNext()!].toLowerCase() : null,
    target: posing.target ? PART_NAME[posing.target] : null, locked: posing.locked, contacts: posing.contacts.length, characters: actors.length,
    obj: selProp ? { name: selProp.name, locked: selProp.locked, picking: objAttaching === selProp } : null, pending: pending.length > 0,
  };
}
/** Show the help box in the viewport being worked in (top right, below its own controls), sized to its content
 *  but never more than about half the view; it scrolls when longer. Hidden when the view is too small. */
function refreshHelp(): void {
  const helpBox = helpBoxOf();
  for (const b of document.querySelectorAll<HTMLElement>('.vpbar .helpbtn')) {
    const k = (b.closest('.vpbar') as HTMLElement).dataset.k as Kind;
    b.setAttribute('aria-pressed', String(helpOn && helpVP === k));
    b.title = helpOn && helpVP === k ? 'Hide help (it follows the view you work in)' : 'Show help for the active tool here';
  }
  let k = helpVP;
  if (!shown().includes(k) || (maxed && maxed !== k)) k = maxed || (shown().includes(pointerVP) ? pointerVP : shown()[0]);
  if (!helpOn || $('ws-pose').hidden || !k) { helpBox.hidden = true; return; }
  const host = (k === 'output' || k === 'orbit' ? VP[k].querySelector('.stage3d') : VP[k].querySelector('.paper')) as HTMLElement;
  const hr = host.getBoundingClientRect();
  if (hr.width < 200 || hr.height < 150) { helpBox.hidden = true; return; }
  if (helpBox.parentElement !== host) host.append(helpBox);
  const html = helpHTML(helpState(k));
  if (html !== helpHtml || helpBox.dataset.k !== k) { helpHtml = html; helpBox.innerHTML = html; helpBox.dataset.k = k; }
  let top = 8;
  const tr = host.querySelector(':scope > .tr') as HTMLElement | null; // 3D: below the camera buttons
  if (tr) top = tr.getBoundingClientRect().bottom - hr.top + 8;
  const bottomRoom = k === 'sketch' ? 56 : k === 'output' ? 56 : 16; // the status, Snap and output summary pills
  helpBox.style.top = top + 'px'; helpBox.style.right = (tr ? 12 : 8) + 'px';
  helpBox.style.maxWidth = Math.min(276, Math.max(hr.width * 0.6, Math.min(220, hr.width - 16))) + 'px'; // narrow views: more of the width
  helpBox.style.maxHeight = Math.max(80, Math.min(hr.height * (hr.width < 320 ? 0.4 : 0.55), hr.height - top - bottomRoom)) + 'px'; // narrow: shorter, the figure stays clear
  helpBox.hidden = false;
  helpBox.classList.toggle('scrolls', helpBox.scrollHeight > helpBox.clientHeight + 1);
}
// The help follows the view you work in: a press there moves it at once, resting the pointer there moves it soon.
{
  let dwell = 0;
  for (const k of KINDS) {
    const body = VP[k].querySelector('.vpbody') as HTMLElement;
    body.addEventListener('pointerdown', e => {
      const helpBox = helpBoxOf();
      if (helpBox.contains(e.target as Node)) return;
      clearTimeout(dwell);
      if (helpVP !== k) { helpVP = k; refreshHelp(); }
      helpBox.classList.add('busy'); // out of the way while drawing or dragging
      const up = () => { helpBox.classList.remove('busy'); removeEventListener('pointerup', up); removeEventListener('pointercancel', up); };
      addEventListener('pointerup', up); addEventListener('pointercancel', up);
    }, true);
    body.addEventListener('pointerenter', e => {
      clearTimeout(dwell);
      if (e.buttons) return;
      dwell = window.setTimeout(() => { if (helpVP !== k) { helpVP = k; refreshHelp(); } }, 650);
    });
    body.addEventListener('pointerleave', () => clearTimeout(dwell));
    // Clicks always go through the help box to the view; the wheel over it scrolls it (instead of zooming)
    body.addEventListener('wheel', e => {
      const hb = helpBoxOf();
      if (hb.hidden || !hb.classList.contains('scrolls') || !body.contains(hb)) return;
      const r = hb.getBoundingClientRect();
      if (e.clientX < r.left || e.clientX > r.right || e.clientY < r.top || e.clientY > r.bottom) return;
      e.preventDefault(); e.stopPropagation();
      hb.scrollTop += e.deltaY;
    }, { capture: true, passive: false });
  }
}

// Draft stack: a list docked at the left of the viewport where the last guide was drawn, below its own controls.
for (const k of KINDS) VP[k].querySelector('.vpbody')!.addEventListener('pointerdown', () => { pointerVP = k; }, true);
const SVG_OK = '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m5 12 5 5 9-10"/></svg>';
const SVG_X = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" aria-hidden="true"><path d="M6 6l12 12M18 6 6 18"/></svg>';
function placeDrafts(bar: HTMLElement, k: Kind): void {
  const host = (k === 'output' || k === 'orbit' ? VP[k].querySelector('.stage3d') : VP[k].querySelector('.paper')) as HTMLElement;
  if (bar.parentElement !== host) host.append(bar);
  const hr = host.getBoundingClientRect();
  let top = 8;
  const tl = host.querySelector(':scope > .tl') as HTMLElement | null; // 3D: below the character and overlay buttons
  if (tl) { const r = tl.getBoundingClientRect(); top = r.bottom - hr.top + 8; }
  bar.style.left = (tl ? 12 : 8) + 'px'; bar.style.top = top + 'px';
  bar.style.maxHeight = Math.max(90, hr.height - top - 64) + 'px';
}
function refreshDrafts(): void {
  const bar = $('editbar'), ds = posing.drafts;
  if (ds.length > draftCount || !draftVP) draftVP = pointerVP;
  draftCount = ds.length;
  if (!ds.length || $('ws-pose').hidden) { bar.hidden = true; draftVP = null; return; }
  let k = draftVP!;
  if (!shown().includes(k) || (maxed && maxed !== k)) k = maxed || shown()[0];
  bar.innerHTML = '';
  bar.append(el('div', { cls: 'eh' }, el('span', { textContent: ds.length > 1 ? `${ds.length} edits` : 'Edit' }), el('span', { cls: 'tag', textContent: 'Draft' })));
  const nx = posing.altNext(), last = ds[ds.length - 1].part;
  for (const d of ds) {
    const dot = el('span', { cls: 'dot' }); dot.style.background = PART_COLOR(d.part);
    const row = el('div', { cls: 'dr' + (d.part === last ? ' last' : '') }, dot, el('b', { textContent: PART_NAME[d.part] }));
    if (d.part === last && nx) {
      const alt = el('button', { cls: 'alt', id: 'ebalt', title: 'This guide was meant for another part (Tab)', textContent: `Tab: ${PART_NAME[nx]}` });
      alt.onclick = () => posing.retarget(); row.append(alt);
    }
    const ok = el('button', { cls: 'ic ok', title: `Apply ${PART_NAME[d.part]}`, innerHTML: SVG_OK }); ok.setAttribute('aria-label', `Apply ${PART_NAME[d.part]}`);
    const x = el('button', { cls: 'ic', title: `Discard ${PART_NAME[d.part]}`, innerHTML: SVG_X }); x.setAttribute('aria-label', `Discard ${PART_NAME[d.part]}`);
    ok.onclick = () => posing.apply(d.part); x.onclick = () => posing.discard(d.part);
    row.append(ok, x); bar.append(row);
  }
  const ap = el('button', { cls: 'lock', id: 'eblock', innerHTML: `${ds.length > 1 ? 'Apply all' : 'Apply'} <kbd>↵</kbd>` }); ap.onclick = () => posing.apply();
  const dc = el('button', { id: 'ebdiscard', innerHTML: ds.length > 1 ? 'Discard all' : 'Discard <kbd>Esc</kbd>' });
  dc.onclick = () => { if (ds.length > 1) { while (posing.drafts.length) posing.discard(posing.drafts[posing.drafts.length - 1].part); } else posing.discard(last); };
  bar.append(el('div', { cls: 'ef' }, ap, dc));
  bar.hidden = false;
  placeDrafts(bar, k);
}

// ---------------------------------------------------------------- keyboard
addEventListener('keydown', e => {
  const t = e.target as HTMLElement;
  if (t.closest('input, select, textarea') || document.querySelector('dialog[open]')) return;
  const ctrl = e.ctrlKey || e.metaKey, k = e.key.toLowerCase();
  if (ctrl) {
    if (k === 'z' && !e.shiftKey) { e.preventDefault(); canvas.undo(); }
    else if (k === 'y' || (k === 'z' && e.shiftKey)) { e.preventDefault(); canvas.redo(); }
    else if (k === 's') { e.preventDefault(); void savePose(e.shiftKey); }
    else if (k === 'n' && e.altKey) { e.preventDefault(); newTab(); }
    else if (k === 'enter') { e.preventDefault(); void renderPNG(); }
    return;
  }
  if (e.altKey) return;
  if (k === 'tab' && posing.altNext()) { e.preventDefault(); posing.retarget(); return; }
  if (k === 'enter' && !t.closest('button, a') && posing.drafts.length) { e.preventDefault(); posing.apply(); toast('Applied.'); return; }
  if (k === 'escape' && !openPop && posing.match) { posing.match = null; update(); return; }
  if (k === 'escape' && !openPop && posing.reaching) { posing.cancelReach(); update(); return; }
  if (k === 'escape' && !openPop && posing.drafts.length) { posing.discard(posing.lastDraft()!); toast('Draft discarded.'); return; }
  if (k === 'escape' && !openPop && posing.target) { posing.target = null; update(); return; }
  if (k === 'escape' && !openPop && posing.sel && canvas.selected === null) { posing.sel = null; update(); return; }
  if (k === 'escape' && !openPop && posing.rootSel) { toggleMove(false); return; }
  if (k === 'escape' && !openPop && objAttaching) { objAttaching = null; refreshPoseCard(); renderAll(); return; }
  if (k === 'escape' && !openPop && selProp) { selectProp(null); return; }
  // the whole character or an object selected: Up and Down lift it (5 cm, Shift 1 cm)
  if ((selProp || posing.rootSel) && (k === 'arrowup' || k === 'arrowdown') && !$('ws-pose').hidden) {
    e.preventDefault(); liftSelected((k === 'arrowup' ? 1 : -1) * (e.shiftKey ? 0.01 : 0.05)); return;
  }
  if (selProp && (k === 'delete' || k === 'backspace') && canvas.selected === null && !$('ws-pose').hidden) { e.preventDefault(); deleteProp(selProp); return; }
  if (posing.sel && ['arrowleft', 'arrowright', 'arrowup', 'arrowdown'].includes(k) && !$('ws-pose').hidden) {
    e.preventDefault();
    const st = e.shiftKey ? 1 : 5;
    posing.nudgeSel(k === 'arrowleft' ? -st : k === 'arrowright' ? st : 0, k === 'arrowup' ? st : k === 'arrowdown' ? -st : 0);
    return;
  }
  if (k === 'escape') { if (openPop) closePop(); else if (canvas.selected !== null) { canvas.selected = null; canvas.draw(); refreshSelection(); } return; }
  if ($('ws-pose').hidden) { if (k === 'l') showWS('pose'); return; }
  if (t.closest('.pop') && (k === 'enter' || k === ' ')) return;
  const sel = selectedStroke();
  if (sel && /^[0-9]$/.test(k)) { e.preventDefault(); retagSelected(k === '0' ? null : ORDER[+k - 1]); return; }
  if (sel && (k === 'delete' || k === 'backspace')) { e.preventDefault(); deleteSelected(); return; }
  if (sel && k === 's') { $('pillswap').click(); return; }
  if (canvas.tool === 'brush' && /^[1-9]$/.test(k)) { canvas.brush = ORDER[+k - 1]; $('brushdot').style.background = COLOR[canvas.brush]; return; }
  const tools: Record<string, Tool> = { p: 'pen', v: 'select', e: 'erase', b: 'brush', d: 'edit' };
  if (tools[k]) { setTool(tools[k]); return; }
  if (k === 'c') posing.copyToOther();
  else if (k === 'r' && selProp) startHoldPick();
  else if (k === 'r') posing.startReach(e.shiftKey ? true : undefined);
  else if (e.key === '?') { helpOn = !helpOn; store.set('stickform.help', helpOn); refreshHelp(); }
  else if (k === 'o') toggleGhosts();
  else if (k === 'f') { if (selProp) focusProp(selProp); else focusItem(active); }
  else if (k === '[' || k === ']') { if (actors.length > 1) activate(actors[(actors.indexOf(active) + (k === ']' ? 1 : actors.length - 1)) % actors.length]); }
  else if (k === 'g') toggleMove();
  else if (k === 'k' && selProp) { setProp(selProp, { locked: !selProp.locked }); refreshPoseCard(); toast(selProp.locked ? `${selProp.name} locked (K unlocks it).` : `${selProp.name} unlocked.`); }
  else if (k === 'k' && (e.shiftKey || posing.rootSel)) posing.toggleLock();
  else if (k === 'k') { const p = posing.sel ? PART_OF[posing.sel] : posing.target; if (p) posing.togglePin(p); }
  else if (k === 'm') mirror();
  else if (k === 'a') toggleAway();
  else if (k === 'l') showWS('library');
});

// ---------------------------------------------------------------- open tabs (several poses and scenes at once)
const POSE_ICON = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="5" r="2.6"/><path d="M12 8v7M12 15l-4 6M12 15l4 6M6 11h12"/></svg>';
const SCENE_ICON = '<svg width="16" height="14" viewBox="0 0 28 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="9" cy="5" r="2.4"/><path d="M9 8v6M9 14l-3 6M9 14l3 6M4 10h10"/><circle cx="20" cy="5" r="2.4"/><path d="M20 8v6M20 14l-3 6M20 14l3 6M15 10h10"/></svg>';
const docOf = (d: Doc) => d === curDoc
  ? { name: poseName, dirty, n: actors.length, file: currentFile, objs: props.length }
  : { name: d.name, dirty: d.dirty, n: d.actors.length, file: d.file, objs: (d.props || []).length };
function renderTabs(): void {
  const box = $('doctabs'); if (!box) return;
  box.innerHTML = '';
  for (const d of docs) {
    const o = docOf(d), on = d === curDoc, scene = o.n > 1 || o.objs > 0;
    const tab = el('div', { cls: 'dtab' });
    tab.setAttribute('role', 'tab'); tab.setAttribute('aria-selected', String(on)); tab.dataset.id = String(d.id);
    tab.title = `${scene ? `Scene · ${o.n} character${o.n > 1 ? 's' : ''}${o.objs ? ` · ${o.objs} object${o.objs > 1 ? 's' : ''}` : ''}` : 'Pose'}${o.file ? ` · presets/${o.file}` : ' · not saved yet'}${o.dirty ? ' · unsaved changes' : ''}`;
    const nb = el('button', { cls: 'dname', title: on ? 'Rename' : `Switch to ${o.name}` }, el('span', { cls: 'dki', innerHTML: scene ? SCENE_ICON : POSE_ICON }), el('b', { textContent: o.name }));
    if (on) { nb.id = 'pname'; (nb.lastChild as HTMLElement).id = 'pnametext'; }
    nb.onclick = () => { if (on) startRename(); else switchTo(d); };
    const dot = el('span', { cls: 'dot', title: 'Unsaved changes' }); dot.hidden = !o.dirty; if (on) dot.id = 'pedited';
    const x = el('button', { cls: 'dx', title: 'Close', innerHTML: ICON.close });
    x.setAttribute('aria-label', `Close ${o.name}`);
    x.onclick = e => { e.stopPropagation(); void closeTab(d); };
    tab.append(nb, dot, x);
    tab.addEventListener('auxclick', e => { if (e.button === 1) { e.preventDefault(); void closeTab(d); } }); // middle click closes
    box.append(tab);
  }
  box.querySelector('[aria-selected="true"]')?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
}
$('doctabs').addEventListener('wheel', e => { const b = $('doctabs'); if (b.scrollWidth <= b.clientWidth) return; b.scrollLeft += e.deltaY || e.deltaX; e.preventDefault(); }, { passive: false });
/** Keep the tab on screen in its Doc and take its characters off the stage. */
function stashDoc(): void {
  const d = curDoc; if (!d) return;
  posing.reset();
  active.data = captureLive(); active.posed = [active.data, ground, active.rig];
  Object.assign(d, { name: poseName, file: currentFile, kind: fileKind, dirty, preset: currentPreset, actors: [...actors], activeId: active.id,
    hist: canvas.exportHistory(), camFrame, camAim, w: out.w, h: out.h, props: [...props], solid: allSolid, pend: clone(pending), page: pageMap });
  for (const a of actors) stage.removeGroup(a.group);
  for (const o of props) stage.removeProp(o.group);
  props.length = 0; selProp = null; pending = []; pageMap = null;
}
/** Put a Doc on screen. */
function showDoc(d: Doc): void {
  curDoc = d;
  actors.length = 0; actors.push(...d.actors);
  for (const a of actors) stage.addGroup(a.group);
  for (const o of props) stage.removeProp(o.group);
  props.length = 0; props.push(...((d.props || []) as Prop[])); selProp = null; allSolid = !!d.solid; pending = clone((d.pend || []) as Pend[]); pageMap = (d.page as PageMap) || null;
  for (const o of props) { stage.addProp(o.group); showProp(o); }
  const a = actors.find(x => x.id === d.activeId) || actors[0];
  active = a; rig = a.rig; stage.setActive(a.group, a.rig);
  loadLive(a.data!); a.data = null;
  canvas.importHistory(d.hist);
  poseName = d.name; currentFile = d.file; fileKind = d.kind; dirty = d.dirty; currentPreset = d.preset; camFrame = d.camFrame; camAim = d.camAim;
  if (d.w && d.h) { out.w = d.w; out.h = d.h; refreshOutput(); }
  canvas.selected = null; closePop();
  refreshRig(); refreshName(); fillThumbs(); fillCharacters(); update();
  if (!$('ws-library').hidden) fillLibrary();
}
function switchTo(d: Doc): void { if (d === curDoc) return; stashDoc(); showDoc(d); }
/** A new tab with an untitled pose: one mannequin in the idle A-pose. */
function blankDoc(): Doc {
  const d: Doc = { id: nextDocId++, name: 'Untitled', file: null, kind: null, dirty: false, preset: null, actors: [], activeId: 0, hist: null, camFrame: 'all', camAim: false, w: out.w, h: out.h };
  const a = makeActor('Character 1', makeMannequin(), TINTS[0].c);
  a.data = poseToData(BUILTIN[0]); d.actors = [a]; d.activeId = a.id;
  docs.splice(curDoc ? docs.indexOf(curDoc) + 1 : docs.length, 0, d);
  showDoc(d);
  posing.resetPose(undefined, true); // the idle A-pose
  poseName = 'Untitled'; currentFile = null; fileKind = null; dirty = false; currentPreset = null; active.poseSrc = null;
  canvas.clearHistory(); refreshName(); refreshHistory();
  return d;
}
function newTab(): Doc { stashDoc(); return blankDoc(); }
/** The app starts with one untitled tab holding the first character (already on the stage). */
function startDocs(): void {
  const d: Doc = { id: nextDocId++, name: 'Untitled', file: null, kind: null, dirty: false, preset: null, actors: [active], activeId: active.id, hist: null, camFrame: 'all', camAim: false, w: out.w, h: out.h };
  docs.push(d); curDoc = d;
  loadPose(BUILTIN[0]);
  posing.resetPose(undefined, true);
  poseName = 'Untitled'; currentFile = null; fileKind = null; dirty = false; currentPreset = null;
  canvas.clearHistory(); refreshName(); refreshHistory();
}
/** An untitled tab nobody has touched: opening something replaces it instead of adding a tab. */
const pristine = () => !currentFile && !dirty && actors.length === 1 && !props.length && poseName === 'Untitled' && !canvas.canUndo;
/** Open a preset (pose or scene) in its own tab: the tab that already has that file, the untouched untitled tab, or a
 *  new one. */
async function openInTab(it: LibItem, fresh = false): Promise<void> {
  // the tab already holding that file (unless a fresh copy of the saved file is wanted next to unsaved changes)
  const have = !fresh && it.src === 'folder' && docs.find(d => docOf(d).file === it.key);
  if (have) { switchTo(have); return; }
  if (!pristine()) newTab();
  usePreset(it);
  canvas.clearHistory(); dirty = false; refreshName(); refreshHistory();
}
/** ⋯ › Open its pose on its own: that character's pose (as it is now) in a new tab, tied to the preset file it
 *  came from, if any, so saving there updates that preset. */
async function openCharacterInTab(a: Actor): Promise<void> {
  const src = a.poseSrc ?? null, nm = src?.name || a.name;
  const f = a === active ? poseFile(nm) : dataToPose(a.data!, nm);
  const model = a.rig.kind === 'model' ? rigs.find(r => r.name === a.rig.name) || null : null;
  newTab();
  loadPose({ ...f, name: nm, place: undefined });
  poseName = nm; currentFile = src?.src === 'folder' ? src.key : null; fileKind = currentFile ? 'pose' : null; active.poseSrc = src;
  canvas.clearHistory(); dirty = false; refreshName(); refreshHistory();
  if (model) await setRig(model);
}
const isDirty = (d: Doc) => d === curDoc ? dirty : d.dirty;
/** Close a tab; unsaved changes ask first. The last tab closing leaves a fresh untitled one. */
async function closeTab(d: Doc): Promise<boolean> {
  if (isDirty(d)) {
    if (d !== curDoc) switchTo(d);
    const r = await askChoice(`Save changes to “${poseName}”?`, `Closing this ${isSceneNow() ? 'scene' : 'pose'} without saving loses its changes.`,
      [{ label: 'Don’t save', value: 'discard', danger: true }, { label: 'Cancel', value: 'cancel' }, { label: 'Save', value: 'save', pri: true }]);
    if (!r || r === 'cancel') return false;
    if (r === 'save' && !(await savePose())) return false;
  }
  const i = docs.indexOf(d);
  if (d === curDoc) {
    posing.reset();
    for (const a of actors) { stage.removeGroup(a.group); actorCache.delete(a.id); }
    for (const o of props) { stage.removeProp(o.group); propCache.delete(o.id); }
    props.length = 0; selProp = null; pending = []; pageMap = null;
    docs.splice(i, 1); curDoc = null;
    const next = docs[i] || docs[i - 1];
    if (next) showDoc(next); else blankDoc();
  } else {
    for (const a of d.actors) actorCache.delete(a.id);
    for (const o of (d.props || []) as Prop[]) propCache.delete(o.id);
    docs.splice(i, 1); renderTabs();
  }
  return true;
}
$('newtab').onclick = () => newTab();
// Leaving the page with unsaved changes in any tab: the browser asks first.
addEventListener('beforeunload', e => { if (docs.some(isDirty)) { e.preventDefault(); e.returnValue = ''; } });

// ---------------------------------------------------------------- narrow title bars scroll
// When a viewport is too narrow for its title bar, the bar scrolls sideways: the mouse wheel (or a trackpad swipe)
// moves it, and the edges fade where buttons are hidden.
function barFade(b: HTMLElement): void {
  const more = b.scrollWidth - b.clientWidth > 1;
  b.classList.toggle('ovl', more && b.scrollLeft > 1);
  b.classList.toggle('ovr', more && b.scrollLeft < b.scrollWidth - b.clientWidth - 1);
}
document.querySelectorAll<HTMLElement>('.vpbar').forEach(b => {
  b.addEventListener('wheel', e => {
    if (b.scrollWidth - b.clientWidth <= 1 || (e.target as HTMLElement).closest('select')) return;
    const d = Math.abs(e.deltaX) > Math.abs(e.deltaY) ? e.deltaX : e.deltaY;
    b.scrollLeft += (e.deltaMode === 1 ? 16 : 1) * d; e.preventDefault(); barFade(b);
  }, { passive: false });
  b.addEventListener('scroll', () => barFade(b));
  new ResizeObserver(() => barFade(b)).observe(b);
});

// ---------------------------------------------------------------- start
posing.attachOn = store.get('stickform.attach', false);
showPresetTab(presetTab);
setTool('pen');
refreshOutput(); refreshCams(); refreshRig(); refreshName(); fillCharacters();
applyLayout();
startDocs();
orbitVP.fit();
refreshProjectUI();
void project.restore();
// test hooks (used by the automated checks; harmless otherwise)
(window as any).stickform = {
  sketch, stage, out, outVP, orbitVP, canvas, get rig() { return rig; }, get J() { return J; }, loadPose, BUILTIN, update, rigs, renders, PAGE_ASPECT,
  async loadModelBuffer(buf: ArrayBuffer, name: string) { const r = await loadModel(buf, name); modelBuf.set(name, buf); rigs.push(r); await setRig(r); return active.rig; },
  get actors() { return actors; }, get active() { return active; }, get docs() { return docs; }, get curDoc() { return curDoc; }, newTab, switchTo, closeTab, openInTab, get dirty() { return dirty; }, activate, addCharacter, deleteCharacter, others, othersFront, worldFigs, saveScene: () => sceneFile(poseName), loadScene,
  layout: () => layout,
  get marks() { return marks; }, anchorAt, moveBy, refreshHelp,
  get pageMap() { return pageMap; }, startHoldPick, detachProp, randomTint, objMarks, get props() { return props; }, get selProp() { return selProp; }, addPrimitive, addObjectFile, selectProp, setProp, deleteProp, duplicateProp, get pending() { return pending; },
  get allSolid() { return allSolid; }, refreshFolderObjects, get folderObjects() { return folderObjects; },
  setRig, posing, poseFile, get J0() { return J; }, setTool, tileApi, project, refreshFolderPresets, get folderModels() { return folderModels; }, loadFolderModel, internals: { ikDrag, Sketch, lift, fromFile, toFile, FRAME, solvePart, dirsOf, build, regenerate, VIEWS, setBone, setPart, mirroredDirs, rotateBone },
};
