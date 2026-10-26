// Objects in the scene: primitive shapes and imported meshes (GLB, GLTF, OBJ), and the Look of anything with its own
// materials (Original, Tint, Solid). Every object is a group whose origin is the bottom centre of its shape, so
// y = 0 stands it on the floor; turns pivot about the middle of the shape and scaling keeps its bottom where it is.
import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';

export type PrimKind = 'box' | 'sphere' | 'cylinder' | 'cone' | 'plane' | 'capsule' | 'torus' | 'wedge' | 'stairs' | 'seat';
export type PropKind = PrimKind | 'mesh';
export type Look = 'original' | 'tint' | 'solid';
type V3 = [number, number, number];

/** The shapes in the + Add menu, in order, with a word on what each is for. */
export const PRIMS: { kind: PrimKind; name: string; note: string }[] = [
  { kind: 'box', name: 'Box', note: '50 cm cube' },
  { kind: 'seat', name: 'Seat block', note: 'chair height, 45 cm' },
  { kind: 'sphere', name: 'Sphere', note: '50 cm ball' },
  { kind: 'cylinder', name: 'Cylinder', note: 'post, stool, barrel' },
  { kind: 'cone', name: 'Cone', note: '' },
  { kind: 'capsule', name: 'Capsule', note: 'a stand-in body or pillar' },
  { kind: 'torus', name: 'Torus', note: 'ring, tyre' },
  { kind: 'wedge', name: 'Wedge', note: 'ramp, slope' },
  { kind: 'stairs', name: 'Stairs', note: 'four steps' },
  { kind: 'plane', name: 'Plane', note: '2 × 2 m floor or wall' },
];
export const PROP_NAME: Record<PropKind, string> = { ...Object.fromEntries(PRIMS.map(p => [p.kind, p.name])) as Record<PrimKind, string>, mesh: 'Object' };

/** A wedge (ramp): a box cut along its diagonal, high side at the back (−z), slope toward the front. */
function wedgeGeometry(w: number, h: number, d: number): THREE.BufferGeometry {
  const x = w / 2, z = d / 2;
  const v = [[-x, 0, -z], [x, 0, -z], [x, 0, z], [-x, 0, z], [-x, h, -z], [x, h, -z]];
  // counter-clockwise seen from outside: bottom, back, slope, left, right
  const f = [[0, 1, 2], [0, 2, 3], [0, 4, 5], [0, 5, 1], [3, 2, 5], [3, 5, 4], [0, 3, 4], [1, 5, 2]];
  const pos: number[] = [];
  for (const t of f) for (const i of t) pos.push(...v[i]);
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.computeVertexNormals();
  return g;
}
/** Stairs: steps rising toward the back (−z). */
function stairsGeometry(w: number, h: number, d: number, n: number): THREE.BufferGeometry {
  const parts: THREE.BufferGeometry[] = [];
  for (let i = 0; i < n; i++) {
    const sh = h * (i + 1) / n, sd = d / n;
    const b = new THREE.BoxGeometry(w, sh, sd);
    b.translate(0, sh / 2, d / 2 - sd * (i + 0.5));
    parts.push(b.toNonIndexed());
  }
  const pos: number[] = [], nor: number[] = [];
  for (const p of parts) { pos.push(...(p.getAttribute('position').array as Float32Array)); nor.push(...(p.getAttribute('normal').array as Float32Array)); p.dispose(); }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('normal', new THREE.Float32BufferAttribute(nor, 3));
  return g;
}

/** A shape's geometry, standing on y = 0, centred over the origin. */
function primGeometry(k: PrimKind): THREE.BufferGeometry {
  let g: THREE.BufferGeometry;
  switch (k) {
    case 'box': g = new THREE.BoxGeometry(0.5, 0.5, 0.5); g.translate(0, 0.25, 0); break;
    case 'seat': g = new THREE.BoxGeometry(0.45, 0.45, 0.45); g.translate(0, 0.225, 0); break;
    case 'sphere': g = new THREE.SphereGeometry(0.25, 40, 24); g.translate(0, 0.25, 0); break;
    case 'cylinder': g = new THREE.CylinderGeometry(0.2, 0.2, 0.8, 40); g.translate(0, 0.4, 0); break;
    case 'cone': g = new THREE.ConeGeometry(0.25, 0.7, 40); g.translate(0, 0.35, 0); break;
    case 'capsule': g = new THREE.CapsuleGeometry(0.15, 0.6, 8, 24); g.translate(0, 0.45, 0); break;
    case 'torus': g = new THREE.TorusGeometry(0.3, 0.08, 20, 56); g.rotateX(-Math.PI / 2); g.translate(0, 0.08, 0); break;
    case 'wedge': g = wedgeGeometry(1, 0.5, 1); break;
    case 'stairs': g = stairsGeometry(1, 0.8, 1, 4); break;
    case 'plane': g = new THREE.BoxGeometry(2, 0.01, 2); g.translate(0, 0.005, 0); break;
  }
  return g;
}

/** Plain material for shapes (and the Solid look): muted, soft, not shiny. */
export function solidMaterial(color: string): THREE.MeshStandardMaterial {
  return new THREE.MeshStandardMaterial({ color: new THREE.Color(color), roughness: 0.78, metalness: 0 });
}

/** A new primitive: a group holding one mesh, its origin at the bottom centre. */
export function makePrimitive(kind: PrimKind, color: string): THREE.Group {
  const root = new THREE.Group(); root.name = PROP_NAME[kind];
  const m = new THREE.Mesh(primGeometry(kind), solidMaterial(color));
  m.castShadow = true; m.receiveShadow = true; m.userData.prim = true;
  root.add(m);
  if (kind === 'plane') root.userData.noFrame = true; // a floor would make the camera presets frame a lot of nothing
  return root;
}

// ---------------------------------------------------------------- importing
/** A very small OBJ reader: v, vt, vn and f (any polygon, negative indices); groups and materials are ignored. */
export function parseOBJ(text: string): THREE.BufferGeometry {
  const V: number[][] = [], T: number[][] = [], N: number[][] = [];
  const pos: number[] = [], uv: number[] = [], nor: number[] = [];
  let hasN = true, hasT = true;
  const idx = (s: string, n: number) => { const i = parseInt(s, 10); return i < 0 ? n + i : i - 1; };
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim(); if (!line || line[0] === '#') continue;
    const p = line.split(/\s+/), k = p[0];
    if (k === 'v') V.push([+p[1], +p[2], +p[3]]);
    else if (k === 'vt') T.push([+p[1], +p[2]]);
    else if (k === 'vn') N.push([+p[1], +p[2], +p[3]]);
    else if (k === 'f') {
      const c = p.slice(1).map(w => w.split('/'));
      for (let i = 1; i + 1 < c.length; i++) for (const w of [c[0], c[i], c[i + 1]]) {
        const v = V[idx(w[0], V.length)]; if (!v) throw new Error('the OBJ file points at a vertex it does not have');
        pos.push(v[0], v[1], v[2]);
        const t = w[1] ? T[idx(w[1], T.length)] : undefined; if (t) uv.push(t[0], t[1]); else hasT = false;
        const n = w[2] ? N[idx(w[2], N.length)] : undefined; if (n) nor.push(n[0], n[1], n[2]); else hasN = false;
      }
    }
  }
  if (!pos.length) throw new Error('no faces found in the OBJ file');
  if (!pos.every(isFinite)) throw new Error('the OBJ file has numbers that cannot be read');
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  if (hasT && uv.length === pos.length / 3 * 2) g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  if (hasN && nor.length === pos.length) g.setAttribute('normal', new THREE.Float32BufferAttribute(nor, 3)); else g.computeVertexNormals();
  return g;
}

/** Read an object file (GLB, self-contained GLTF or OBJ) into a group standing on y = 0, centred over the origin, in
 *  the file's own units (metres). `fit` is a suggested scale when the file's units look wrong (cm or km). */
export async function loadObjectFile(buf: ArrayBuffer, name: string): Promise<{ root: THREE.Group; fit: number }> {
  const ext = name.toLowerCase().slice(name.lastIndexOf('.'));
  let inner: THREE.Object3D;
  if (ext === '.obj') {
    const m = new THREE.Mesh(parseOBJ(new TextDecoder().decode(buf)), new THREE.MeshStandardMaterial({ color: 0xc4c1ba, roughness: 0.8, metalness: 0, side: THREE.DoubleSide })); // OBJ faces can point either way
    inner = m;
  } else if (ext === '.glb' || ext === '.gltf' || ext === '.vrm') {
    const gltf: any = await new Promise((res, rej) => new GLTFLoader().parse(buf, '', res, rej));
    inner = gltf.scene || gltf.scenes?.[0];
    if (!inner) throw new Error('the file has no scene');
  } else throw new Error('use a GLB, GLTF or OBJ file');
  inner.traverse(o => { const m = o as THREE.Mesh; if (m.isMesh) { m.castShadow = true; m.receiveShadow = true; m.frustumCulled = false; } });
  const root = new THREE.Group(); root.name = name;
  root.add(inner);
  root.updateMatrixWorld(true);
  const box = new THREE.Box3().setFromObject(root, true);
  if (box.isEmpty()) throw new Error('the file has nothing to show');
  const c = box.getCenter(new THREE.Vector3());
  inner.position.sub(new THREE.Vector3(c.x, box.min.y, c.z));
  root.updateMatrixWorld(true);
  const size = box.getSize(new THREE.Vector3()), big = Math.max(size.x, size.y, size.z);
  const fit = big > 30 ? 1.5 / big : big < 0.03 ? 0.5 / big : 1;
  return { root, fit: +fit.toPrecision(3) };
}

/** The middle of an object's shape in its own (unscaled) space: turns pivot about it. */
export function centreOf(root: THREE.Object3D): THREE.Vector3 {
  const keep = [root.position.clone(), root.quaternion.clone(), root.scale.clone()];
  root.position.set(0, 0, 0); root.quaternion.identity(); root.scale.set(1, 1, 1); root.updateMatrixWorld(true);
  const box = new THREE.Box3().setFromObject(root, true), c = box.isEmpty() ? new THREE.Vector3() : box.getCenter(new THREE.Vector3());
  root.position.copy(keep[0] as THREE.Vector3); root.quaternion.copy(keep[1] as THREE.Quaternion); root.scale.copy(keep[2] as THREE.Vector3); root.updateMatrixWorld(true);
  return c;
}
/** Put an object where its numbers say: `p` is its bottom centre (when not turned), `q` turns it about the middle of
 *  its shape, `s` scales it from its bottom. */
export function placeObject(root: THREE.Object3D, c: THREE.Vector3, p: V3, q: [number, number, number, number], s: V3): void {
  const S = new THREE.Vector3(...s), Q = new THREE.Quaternion(...q).normalize();
  const cS = c.clone().multiply(S); // the middle after scaling from the bottom
  root.quaternion.copy(Q); root.scale.copy(S);
  root.position.set(p[0], p[1], p[2]).add(cS).sub(cS.clone().applyQuaternion(Q));
  root.updateMatrixWorld(true);
}

// ---------------------------------------------------------------- Look: Original, Tint, Solid
// Tint keeps the texture's light and dark (so folds and faces still read) but colours it in the item's colour; Solid
// is one plain colour, softly shaded. Both keep the texture's transparency, so hair cards and lashes stay cut out.
const looked = new WeakMap<THREE.Mesh, { orig: THREE.Material | THREE.Material[]; key: string }>();
function lookMaterial(src: THREE.Material, mode: 'tint' | 'solid', color: string): THREE.Material {
  const o = src as THREE.MeshStandardMaterial;
  const m = new THREE.MeshStandardMaterial({ color: new THREE.Color(color), roughness: mode === 'solid' ? 0.78 : 0.7, metalness: 0,
    side: o.side, transparent: o.transparent, opacity: o.opacity ?? 1, alphaTest: o.alphaTest || 0, depthWrite: o.depthWrite });
  const map = (o as { map?: THREE.Texture | null }).map || null;
  if (o.normalMap && mode === 'tint') { m.normalMap = o.normalMap; m.normalScale = o.normalScale?.clone?.() ?? new THREE.Vector2(1, 1); }
  if (map) {
    m.map = map;
    m.onBeforeCompile = sh => {
      sh.fragmentShader = sh.fragmentShader.replace('#include <map_fragment>', mode === 'tint'
        ? `#ifdef USE_MAP
  vec4 texel = texture2D( map, vMapUv );
  float lum = dot( texel.rgb, vec3( 0.299, 0.587, 0.114 ) );
  diffuseColor.rgb *= 0.42 + 0.78 * lum;
  diffuseColor.a *= texel.a;
#endif`
        : `#ifdef USE_MAP
  diffuseColor.a *= texture2D( map, vMapUv ).a;
#endif`);
    };
    m.customProgramCacheKey = () => 'stickform-look-' + mode;
  }
  m.userData.look = mode;
  return m;
}
/** Give every mesh under `root` a look (`color` for Tint and Solid). Original puts the file's materials back. */
export function applyLook(root: THREE.Object3D, mode: Look, color: string): void {
  root.traverse(o => {
    const mesh = o as THREE.Mesh;
    if (!mesh.isMesh || mesh.userData.prim) return;
    let st = looked.get(mesh);
    if (!st) { if (mode === 'original') return; st = { orig: mesh.material, key: 'original' }; looked.set(mesh, st); }
    const key = mode === 'original' ? 'original' : `${mode}:${color}`;
    if (st.key === key) return;
    const old = mesh.material;
    if (st.key !== 'original') (Array.isArray(old) ? old : [old]).forEach(m => m.dispose());
    mesh.material = mode === 'original' ? st.orig : Array.isArray(st.orig) ? st.orig.map(m => lookMaterial(m, mode, color)) : lookMaterial(st.orig, mode, color);
    st.key = key;
  });
}
/** Colour of a primitive (its one material). */
export function tintPrimitive(root: THREE.Object3D, color: string): void {
  root.traverse(o => { const m = o as THREE.Mesh; if (m.isMesh && m.userData.prim) (m.material as THREE.MeshStandardMaterial).color.set(color); });
}
