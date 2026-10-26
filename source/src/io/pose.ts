// Pose files and the preset library. Same format as Milestone 2 (stickform-pose v1), so files and presets move
// freely between the two. Unlocked strokes are re-tagged on load.
import { Sketch, Tag } from '../sketch/tagger';
import type { Draft } from '../sketch/edits';
import type { Depth } from '../sketch/lifter';
import BUILTIN_JSON from '../presets.json';

export interface PoseFile {
  format: 'stickform-pose';
  version: 1;
  id?: string;
  name: string;
  strokes: { pts: [number, number][]; tag: Tag | null; lock: boolean; ordered?: boolean }[];
  flips: Sketch['flips'];
  away: boolean;
  snap: number;
  view?: unknown;
  /** Milestone 3 extras (ignored by Milestone 2). */
  output?: { w: number; h: number; cam?: number[] };
  /** Depth of edited bones, fixed page scale, torso forward (from the edit pen on). */
  depth?: Depth;
  /** Unapplied edit-pen drafts. */
  drafts?: Draft[];
  /** Pinned parts. */
  pins?: string[];
  /** The whole character is locked (no part changes, no moving or turning). */
  locked?: boolean;
  /** Where the character stands and how it is turned in 3D: position in metres, rotation as a quaternion [x, y, z, w]
   *  about the hips (applied before keeping the feet on the ground), plus the same turn in degrees for reading. */
  place?: { p: number[]; q: number[]; turn?: number[];
    /** Scale X, Y, Z (from the floor under the hips); left out when 1, 1, 1. Never taken from the drawing. */
    s?: number[] };
  /** Lasting contacts (Attach): the hand or foot of `part` holds character `to` (-1: this one; in a scene file
   *  the index of another character) on bone `bone`, `t` along it, offset `off` in metres (along the bone, toward
   *  that character's front, to its side). */
  attach?: { part: string; to: number; bone: string; t: number; off: number[]; mode?: 'follow' | 'stick' }[];
  /** The 3D skeleton at save time (joints and bone directions), for readers outside the app. */
  skeleton?: { units: string; joints: Record<string, number[]>; bones: Record<string, number[]> };
}

/** The starter poses: a seed, not a separate collection. They are copied into the project folder (presets/) and,
 *  without a folder, into this browser's library, where they can be edited, renamed and deleted like any other pose. */
export const BUILTIN = BUILTIN_JSON as PoseFile[];
export const STARTERS = BUILTIN;
const SEEDED = 'stickform.starters.v1';
/** Without a project folder: put the starter poses into this browser's library once. */
export function seedBrowserStarters(): void {
  try {
    if (localStorage.getItem(SEEDED)) return;
    const have = userPresets(), names = new Set(have.map(d => d.name));
    setUserPresets([...STARTERS.filter(d => !names.has(d.name)), ...have]);
    localStorage.setItem(SEEDED, '1');
  } catch { /* storage unavailable */ }
}
const LSKEY = 'stickform.presets.v1'; // shared with Milestone 2 when both pages share an origin

export function toFile(k: Sketch, name: string, extra?: Partial<PoseFile>): PoseFile {
  return {
    format: 'stickform-pose', version: 1, name: name || 'pose',
    strokes: k.strokes.filter(s => !s.splitOf || s.lock).map(s => ({
      pts: (s.lock ? s.pts : (s.whole || s.pts)).map(q => [+q.x.toFixed(4), +q.y.toFixed(4)] as [number, number]),
      tag: s.lock ? s.tag : null, lock: !!s.lock, ...(s.ordered ? { ordered: true } : {}),
    })),
    flips: { ...k.flips }, away: k.away, snap: k.snap,
    ...(Object.keys(k.depth.z).length || k.depth.scale || k.depth.fw ? { depth: JSON.parse(JSON.stringify(k.depth)) } : {}), ...extra,
  };
}

export function fromFile(k: Sketch, d: PoseFile): void {
  if (!d || d.format !== 'stickform-pose' || !Array.isArray(d.strokes)) throw new Error('Not a Stickform pose file');
  k.strokes = d.strokes.map(st => ({ id: k.nid++, pts: st.pts.map(([x, y]) => ({ x, y })), tag: st.lock ? st.tag : null, lock: !!st.lock, ...(st.ordered ? { ordered: true } : {}) }));
  k.depth = d.depth ? JSON.parse(JSON.stringify(d.depth)) : { z: {} };
  k.flips = { ...(d.flips || {}) };
  k.away = !!d.away;
  k.snap = +d.snap || 0.04;
  k.lastSpine = null;
  k.classify();
}

export function userPresets(): PoseFile[] {
  try { return JSON.parse(localStorage.getItem(LSKEY) || '[]'); } catch { return []; }
}
export function setUserPresets(a: PoseFile[]): string | null {
  try { localStorage.setItem(LSKEY, JSON.stringify(a)); return null; } catch (e) { return (e as Error).message; }
}

export function download(name: string, data: Blob | string): void {
  const a = document.createElement('a');
  a.href = typeof data === 'string' ? data : URL.createObjectURL(data);
  a.download = name;
  document.body.appendChild(a);
  a.click();
  setTimeout(() => { if (typeof data !== 'string') URL.revokeObjectURL(a.href); a.remove(); }, 500);
}
export const jsonBlob = (o: unknown) => new Blob([JSON.stringify(o, null, 1)], { type: 'application/json' });
export const slug = (t: string) => (t || 'pose').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'pose';

export function readFile(f: File, as: 'text' | 'buffer'): Promise<string | ArrayBuffer> {
  return new Promise((res, rej) => {
    const r = new FileReader();
    r.onload = () => res(r.result as string | ArrayBuffer);
    r.onerror = () => rej(r.error);
    if (as === 'text') r.readAsText(f); else r.readAsArrayBuffer(f);
  });
}

/** Several characters in one file (Save pose with more than one character). Each character keeps an ordinary pose
 *  (its own drawing, depth, pins, lock and place), plus which model it wears, its colour and whether it shows. */
export interface SceneFile {
  format: 'stickform-scene';
  version: 1;
  name: string;
  /** Index of the character being edited. */
  active: number;
  output?: { w: number; h: number };
  /** Camera presets: frame every visible character or the active one; turn with the active character. */
  camera?: { frame?: 'all' | 'active'; aim?: boolean };
  characters: { name: string; model: string; tint?: string; visible?: boolean;
    /** Tint or Solid (the model in its colour); left out for the model's own look. */
    look?: 'tint' | 'solid';
    /** Where its drawing sits on the shared page (offset d while standing at place p). */
    at?: { p: number[]; d: number[] };
    pose: PoseFile }[];
  /** The drawing's anchor: page point (px, py) = world (wx, wy, wz), m metres per page unit. */
  sketch?: { px: number; py: number; wx: number; wy: number; wz: number; m: number };
  /** Shapes and imported objects (files in objects/). `place`: bottom centre p (m), turn q about the middle of the
   *  shape [x, y, z, w] (and in degrees for reading), scale s from the bottom. */
  objects?: SceneObject[];
  /** Every model and object shown in its plain colour. */
  solid?: boolean;
}
export interface SceneObject {
  name: string; kind: string; file?: string; tint?: string; visible?: boolean; locked?: boolean; look?: 'tint' | 'solid';
  place: { p: number[]; q: number[]; turn?: number[]; s?: number[] };
  /** Held by a character (its index in the file): follows that bone, `t` along it, keeping `rel` (its place in the
   *  bone's frame, a 4 × 4 matrix, column-major). */
  hold?: { to: number; bone: string; t: number; rel: number[] };
}
export const isScene = (d: unknown): d is SceneFile => !!d && (d as SceneFile).format === 'stickform-scene' && Array.isArray((d as SceneFile).characters) && (d as SceneFile).characters.length > 0;
/** The picture for a scene in the preset grid and the Library: the active character's pose under the scene's name. */
export function sceneThumb(s: SceneFile): PoseFile { const c = s.characters[s.active] || s.characters[0]; return { ...c.pose, name: s.name }; }
