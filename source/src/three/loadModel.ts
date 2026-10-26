// Load a GLB/VRM character and map its bones to the standard slots.
// VRM files declare their humanoid bones (VRM 0.x "VRM" or VRM 1.0 "VRMC_vrm" extension), so they map exactly.
// Other files are matched by bone name (Mixamo, VRoid, Blender .L/.R, Unreal-style and similar); anything missed
// can be fixed by hand in the remap panel.
import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { Rig, Slot, SLOTS, captureRest, faceForward } from './rig';

export async function loadModel(buf: ArrayBuffer, fileName: string): Promise<Rig> {
  const loader = new GLTFLoader();
  const gltf: any = await new Promise((res, rej) => loader.parse(buf, '', res, rej));
  const scene: THREE.Object3D = gltf.scene || gltf.scenes?.[0];
  const root = new THREE.Group();
  root.name = fileName;
  root.add(scene);
  let bones: Partial<Record<Slot, THREE.Object3D>> = {};
  const vrm = await vrmBones(gltf);
  if (vrm) bones = vrm;
  const allBones: THREE.Object3D[] = [];
  scene.traverse(o => {
    if ((o as THREE.Bone).isBone) allBones.push(o);
    const m = o as THREE.SkinnedMesh;
    if (m.isMesh) { m.frustumCulled = false; m.castShadow = true; m.receiveShadow = true; }
  });
  if (!allBones.length) scene.traverse(o => { if (o !== scene && !(o as THREE.Mesh).isMesh) allBones.push(o); });
  if (!vrm) bones = mapByName(allBones);
  const rig: Rig = { name: fileName, root, bones, restLocal: new Map(), restMinY: 0, allBones, kind: 'model' };
  normalize(rig);
  return rig;
}

/** Scale to about 1.75 m, stand the feet on y = 0, centre the hips over the origin, face +z, store the rest pose. */
export function normalize(rig: Rig): void {
  const root = rig.root;
  root.rotation.set(0, 0, 0); root.position.set(0, 0, 0); root.scale.setScalar(1);
  root.updateMatrixWorld(true);
  const box = new THREE.Box3().setFromObject(root, true);
  const h = box.max.y - box.min.y;
  if (h > 1e-6 && isFinite(h)) root.scale.setScalar(1.75 / h);
  root.updateMatrixWorld(true);
  if (rig.bones.hips && rig.bones.head && rig.bones.leftUpperArm && rig.bones.rightUpperArm) faceForward(rig);
  const b2 = new THREE.Box3().setFromObject(root, true);
  const hips = rig.bones.hips ? rig.bones.hips.getWorldPosition(new THREE.Vector3()) : b2.getCenter(new THREE.Vector3());
  root.position.set(-hips.x, -b2.min.y, -hips.z);
  root.updateMatrixWorld(true);
  captureRest(rig);
}

async function vrmBones(gltf: any): Promise<Partial<Record<Slot, THREE.Object3D>> | null> {
  const ext = gltf.parser?.json?.extensions || {};
  let pairs: [string, number][] = [];
  if (ext.VRMC_vrm?.humanoid?.humanBones) {
    pairs = Object.entries(ext.VRMC_vrm.humanoid.humanBones).map(([k, v]: [string, any]) => [k, v.node]);
  } else if (ext.VRM?.humanoid?.humanBones) {
    pairs = ext.VRM.humanoid.humanBones.map((b: any) => [b.bone, b.node]);
  } else return null;
  const nodes: THREE.Object3D[] = await gltf.parser.getDependencies('node');
  const out: Partial<Record<Slot, THREE.Object3D>> = {};
  for (const [k, i] of pairs) if ((SLOTS as readonly string[]).includes(k) && nodes[i]) out[k as Slot] = nodes[i];
  return out;
}

// ---- name matching ----------------------------------------------------------------------------------------
const NOISE = new Set(['mixamorig', 'mixamo', 'j', 'bip', 'bip01', 'bip001', 'def', 'org', 'mch', 'bone', 'b', 'c', 'cc', 'base', 'jnt', 'joint', 'sk', 'armature', 'ik', 'fk', 'jbip']);
/** Lower-case word tokens of a bone name: splits camelCase, separators and digits-from-letters. */
export function tokens(name: string): string[] {
  return name.replace(/([a-z])([A-Z])/g, '$1 $2').replace(/([A-Za-z])(\d)/g, '$1 $2')
    .toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
}
function sideOf(t: string[]): 'left' | 'right' | null {
  if (t.includes('left') || t.includes('l') || t.includes('lf')) return 'left';
  if (t.includes('right') || t.includes('r') || t.includes('rt')) return 'right';
  return null;
}
const PAT: Record<string, string[]> = {
  hips: ['hips', 'hip', 'pelvis'],
  spine: ['spine', 'spine 0', 'spine 01', 'abdomen', 'waist', 'spine 1 lower'],
  chest: ['spine 1', 'chest', 'spine 02'],
  upperChest: ['spine 2', 'upper chest', 'spine 03', 'upperchest'],
  neck: ['neck', 'neck 1', 'neck 01'],
  head: ['head'],
  Shoulder: ['shoulder', 'clavicle', 'collar', 'collarbone'],
  UpperArm: ['arm', 'upper arm', 'up arm', 'upperarm', 'humerus'],
  LowerArm: ['fore arm', 'forearm', 'lower arm', 'lowerarm', 'lo arm', 'elbow'],
  Hand: ['hand', 'wrist'],
  UpperLeg: ['up leg', 'upleg', 'upper leg', 'upperleg', 'thigh', 'femur'],
  LowerLeg: ['leg', 'lower leg', 'lowerleg', 'calf', 'shin', 'knee'],
  Foot: ['foot', 'ankle'],
  Toes: ['toe base', 'toebase', 'toe', 'toes', 'ball'],
};
export function mapByName(all: THREE.Object3D[]): Partial<Record<Slot, THREE.Object3D>> {
  const out: Partial<Record<Slot, THREE.Object3D>> = {};
  for (const o of all) {
    const t = tokens(o.name);
    const side = sideOf(t);
    const base = t.filter(x => !NOISE.has(x) && !['left', 'right', 'l', 'r', 'lf', 'rt'].includes(x)).join(' ');
    if (!base) continue;
    for (const [key, list] of Object.entries(PAT)) {
      if (!list.includes(base)) continue;
      const centre = key[0] === key[0].toLowerCase();
      if (centre && side) continue;
      if (!centre && !side) continue;
      const slot = (centre ? key : side + key) as Slot;
      if (!out[slot]) out[slot] = o; // first match in traversal order = closest to the root
      break;
    }
  }
  return out;
}
