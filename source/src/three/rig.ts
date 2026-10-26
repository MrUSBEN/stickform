// A posable humanoid: a container object plus a map from standard slot names (VRM humanoid names) to bones.
// Both the built-in mannequin and loaded GLB/VRM characters are Rigs, so one retargeting routine poses both.
import * as THREE from 'three';

export const SLOTS = [
  'hips', 'spine', 'chest', 'upperChest', 'neck', 'head',
  'leftShoulder', 'leftUpperArm', 'leftLowerArm', 'leftHand',
  'rightShoulder', 'rightUpperArm', 'rightLowerArm', 'rightHand',
  'leftUpperLeg', 'leftLowerLeg', 'leftFoot', 'leftToes',
  'rightUpperLeg', 'rightLowerLeg', 'rightFoot', 'rightToes',
] as const;
export type Slot = typeof SLOTS[number];

/** Slots retargeting cannot do without. */
export const REQUIRED: Slot[] = ['hips', 'head', 'leftUpperArm', 'leftLowerArm', 'rightUpperArm', 'rightLowerArm',
  'leftUpperLeg', 'leftLowerLeg', 'rightUpperLeg', 'rightLowerLeg'];

export interface Rig {
  name: string;
  /** Container added to the scene. Its rotation makes the character face +z; its y offset grounds the feet. */
  root: THREE.Group;
  bones: Partial<Record<Slot, THREE.Object3D>>;
  /** Every bone's local rotation in the rest pose, captured once so posing always starts from rest. */
  restLocal: Map<THREE.Object3D, THREE.Quaternion>;
  /** Lowest bone point in the rest pose, for keeping the feet on the ground. */
  restMinY: number;
  /** All bone-like nodes, for the manual remap list. */
  allBones: THREE.Object3D[];
  kind: 'mannequin' | 'model';
}

/** Store the rest pose. Call after the bone map is final and the rig is in its rest pose. */
export function captureRest(rig: Rig): void {
  rig.restLocal = new Map();
  rig.root.traverse(o => { rig.restLocal.set(o, o.quaternion.clone()); });
  rig.root.updateMatrixWorld(true);
  rig.restMinY = lowestBoneY(rig);
}

export function resetToRest(rig: Rig): void {
  for (const [o, q] of rig.restLocal) o.quaternion.copy(q);
  rig.root.position.y = 0;
  rig.root.updateMatrixWorld(true);
}

const tmp = new THREE.Vector3();
export function lowestBoneY(rig: Rig): number {
  let m = Infinity;
  for (const b of Object.values(rig.bones)) if (b) { b.getWorldPosition(tmp); m = Math.min(m, tmp.y); }
  return m;
}

/** Turn the container so the character faces +z (toward the default camera). The forward direction comes from
 *  the rest pose: up (hips to head) crossed with the character's own right (left arm to right arm). */
export function faceForward(rig: Rig): void {
  const b = rig.bones;
  rig.root.updateMatrixWorld(true);
  const p = (s: Slot) => b[s]!.getWorldPosition(new THREE.Vector3());
  if (!b.hips || !b.head || !b.leftUpperArm || !b.rightUpperArm) return;
  const up = p('head').sub(p('hips')).normalize();
  const right = p('rightUpperArm').sub(p('leftUpperArm')).normalize();
  const fwd = new THREE.Vector3().crossVectors(up, right);
  if (fwd.z < 0) { rig.root.rotation.y += Math.PI; rig.root.updateMatrixWorld(true); }
}
