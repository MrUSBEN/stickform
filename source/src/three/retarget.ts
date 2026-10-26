// Retargeting: pose a Rig from the stick-figure joints. Only directions come from the sketch; the character's own
// bone lengths are kept. Each bone gets a world rotation that carries a rest-pose frame onto a target frame:
//  - hips and chest: frame from the spine direction and the hip or shoulder line (so torso twist carries over)
//  - neck: shortest turn toward the head; head: frame from the neck direction and the facing tick
//  - arms and legs: frame from the bone direction and the bend plane (elbow and knee "poke" direction), so the
//    hinge bends the right way; a straight limb uses default poles (elbows back, knees forward)
// Hands and feet keep their rest rotation relative to the forearm or shin.
import * as THREE from 'three';
import { Rig, Slot, resetToRest, lowestBoneY } from './rig';
import { Joints, V3 } from '../sketch/lifter';

const v = (a: V3) => new THREE.Vector3(a[0], a[1], a[2]);

/** Rotation whose matrix columns are (a, b orthogonalized to a, a x b). */
function basis(a: THREE.Vector3, b: THREE.Vector3): THREE.Quaternion {
  const x = a.clone().normalize();
  const y = b.clone().sub(x.clone().multiplyScalar(b.dot(x))).normalize();
  const z = new THREE.Vector3().crossVectors(x, y);
  return new THREE.Quaternion().setFromRotationMatrix(new THREE.Matrix4().makeBasis(x, y, z));
}
/** World rotation that carries frame (a0, b0) onto frame (a1, b1). */
const carry = (a0: THREE.Vector3, b0: THREE.Vector3, a1: THREE.Vector3, b1: THREE.Vector3) =>
  basis(a1, b1).multiply(basis(a0, b0).invert());

function setWorld(bone: THREE.Object3D, qWorld: THREE.Quaternion): void {
  const pq = new THREE.Quaternion();
  if (bone.parent) bone.parent.getWorldQuaternion(pq);
  bone.quaternion.copy(pq.invert().multiply(qWorld));
  bone.updateMatrixWorld(true);
}
const worldQ = (o: THREE.Object3D) => o.getWorldQuaternion(new THREE.Quaternion());
const worldP = (o: THREE.Object3D) => o.getWorldPosition(new THREE.Vector3());
/** Orthogonal part of `p` against unit `d`, or null when it is too small to trust. */
function perp(p: THREE.Vector3, d: THREE.Vector3, min = 1e-3): THREE.Vector3 | null {
  const r = p.clone().sub(d.clone().multiplyScalar(p.dot(d)));
  return r.length() > min ? r.normalize() : null;
}

export interface RetargetOptions { ground: boolean }

export function applyPose(rig: Rig, J: Joints, opt: RetargetOptions = { ground: true }): void {
  resetToRest(rig);
  const b = rig.bones;
  const has = (...s: Slot[]) => s.every(k => !!b[k]);
  if (!has('hips', 'leftUpperArm', 'rightUpperArm', 'leftUpperLeg', 'rightUpperLeg')) return;
  // Rest-pose positions and rotations (world), captured before anything moves.
  const P0: Partial<Record<Slot, THREE.Vector3>> = {}, Q0: Partial<Record<Slot, THREE.Quaternion>> = {};
  for (const [k, o] of Object.entries(b) as [Slot, THREE.Object3D][]) { P0[k] = worldP(o); Q0[k] = worldQ(o); }
  const restFwd = new THREE.Vector3(0, 0, 1); // normalize() turned the character to face +z
  const restUp = (b.neck ? P0.neck! : P0.head!).clone().sub(P0.hips!).normalize();

  // ---- target torso frame from the sketch ----
  const up = v(J.N).sub(v(J.P)).normalize();
  const fw = v(J.fw);
  const anatRight = new THREE.Vector3().crossVectors(fw, up).normalize(); // the character's own right
  // Each lifter side (L/R tag) is matched to the character's side by where its joint sits.
  const shSide = v(J.shL).sub(v(J.N)).dot(anatRight) > 0 ? 'L' : 'R'; // which tag side is the character's right
  const hpSide = v(J.hpL).sub(v(J.P)).dot(anatRight) > 0 ? 'L' : 'R';
  const sh = { right: v(shSide === 'L' ? J.shL : J.shR), left: v(shSide === 'L' ? J.shR : J.shL) };
  const hp = { right: v(hpSide === 'L' ? J.hpL : J.hpR), left: v(hpSide === 'L' ? J.hpR : J.hpL) };
  const chestRight = perp(sh.right.clone().sub(sh.left), up) || anatRight;
  const hipRight = perp(hp.right.clone().sub(hp.left), up) || anatRight;
  const restChestRight = perp(P0.rightUpperArm!.clone().sub(P0.leftUpperArm!), restUp)!;
  const restHipRight = perp(P0.rightUpperLeg!.clone().sub(P0.leftUpperLeg!), restUp)!;

  // Spine chain: the hips take the lower-back segment, the rig's spine bones share the three drawn segments, and each
  // bone's twist blends from the hip line to the shoulder line.
  const seg = [v(J.S1).sub(v(J.P)), v(J.S2).sub(v(J.S1)), v(J.N).sub(v(J.S2))].map(s => s.normalize());
  const frame = (dir: THREE.Vector3, t: number) => {
    const right = perp(hipRight.clone().lerp(chestRight, t), dir) || perp(anatRight, dir) || anatRight;
    return carry(restUp, restHipRight.clone().lerp(restChestRight, t).normalize(), dir, right);
  };
  setWorld(b.hips!, frame(seg[0], 0).multiply(Q0.hips!));
  const chain = (['spine', 'chest', 'upperChest'] as Slot[]).filter(k => b[k]);
  const pick: THREE.Vector3[] = chain.length >= 3 ? seg
    : chain.length === 2 ? [seg[0].clone().add(seg[1]).normalize(), seg[2]]
    : [seg[1].clone().add(seg[2]).normalize()];
  chain.forEach((k, i) => setWorld(b[k]!, frame(pick[i], (i + 1) / chain.length).multiply(Q0[k]!)));

  // ---- neck and head ----
  const headDir = v(J.H).sub(v(J.N)).normalize();
  if (b.neck && b.head) {
    const cur = worldP(b.head).sub(worldP(b.neck)).normalize();
    const turn = new THREE.Quaternion().setFromUnitVectors(cur, headDir);
    setWorld(b.neck, turn.multiply(worldQ(b.neck)));
  }
  if (b.head) {
    const restHeadUp = b.neck ? P0.head!.clone().sub(P0.neck!).normalize() : restUp;
    // The head turns to the facing and also nods toward it (looking up or down), up to 70 degrees from the neck.
    const face = v(J.f).normalize();
    const level = perp(face, headDir) || perp(fw, headDir) || perp(new THREE.Vector3(0, 0, 1), headDir)!;
    const lim = THREE.MathUtils.degToRad(70);
    const e = Math.max(-lim, Math.min(lim, Math.asin(Math.max(-1, Math.min(1, face.dot(headDir))))));
    const tgtFwd = level.clone().multiplyScalar(Math.cos(e)).addScaledVector(headDir, Math.sin(e));
    const tgtUp = headDir.clone().multiplyScalar(Math.cos(e)).addScaledVector(level, -Math.sin(e));
    setWorld(b.head, carry(restHeadUp, perp(restFwd, restHeadUp)!, tgtUp, tgtFwd).multiply(Q0.head!));
  }

  // ---- arms and legs ----
  const chestFwd = new THREE.Vector3().crossVectors(seg[2], chestRight).normalize(); // up x right = forward
  const hipFwd = new THREE.Vector3().crossVectors(seg[0], hipRight).normalize();
  const elbowL = shSide === 'L' ? J.aL1 : J.aR1, wristL = shSide === 'L' ? J.aL2 : J.aR2; // character's right arm
  const elbowO = shSide === 'L' ? J.aR1 : J.aL1, wristO = shSide === 'L' ? J.aR2 : J.aL2;
  const kneeR = hpSide === 'L' ? J.lL1 : J.lR1, ankleR = hpSide === 'L' ? J.lL2 : J.lR2;
  const kneeO = hpSide === 'L' ? J.lR1 : J.lL1, ankleO = hpSide === 'L' ? J.lR2 : J.lL2;
  const limb = (upper: Slot, lower: Slot, end: Slot, S: THREE.Vector3, E: V3, W: V3, restPole: THREE.Vector3, pole: THREE.Vector3) => {
    if (!b[upper] || !b[lower]) return;
    const e = v(E), w = v(W);
    const d1 = e.clone().sub(S).normalize(), d2 = w.clone().sub(e).normalize();
    // Rest directions from the character's own joints.
    const r1 = P0[lower]!.clone().sub(P0[upper]!).normalize();
    const r2 = (P0[end] ? P0[end]!.clone().sub(P0[lower]!) : r1.clone()).normalize();
    // Bend plane: where the elbow or knee pokes out from the line shoulder-to-wrist. Straight limb: default pole.
    const poke = perp(e.clone().sub(S.clone().add(w).multiplyScalar(0.5)), d1, 0.02 * e.distanceTo(S)) || perp(pole, d1) || perp(up, d1)!;
    const n = new THREE.Vector3().crossVectors(d1, poke).normalize();
    const rp = perp(restPole, r1) || perp(new THREE.Vector3(0, 1, 0), r1)!;
    const n0 = new THREE.Vector3().crossVectors(r1, rp).normalize();
    setWorld(b[upper]!, carry(r1, n0, d1, n).multiply(Q0[upper]!));
    setWorld(b[lower]!, carry(r2, n0, d2, n).multiply(Q0[lower]!));
  };
  const back = chestFwd.clone().negate();
  limb('rightUpperArm', 'rightLowerArm', 'rightHand', sh.right, elbowL, wristL, restFwd.clone().negate(), back);
  limb('leftUpperArm', 'leftLowerArm', 'leftHand', sh.left, elbowO, wristO, restFwd.clone().negate(), back);
  limb('rightUpperLeg', 'rightLowerLeg', 'rightFoot', hp.right, kneeR, ankleR, restFwd, hipFwd);
  limb('leftUpperLeg', 'leftLowerLeg', 'leftFoot', hp.left, kneeO, ankleO, restFwd, hipFwd);

  // ---- keep the feet on the ground ----
  if (opt.ground) {
    rig.root.updateMatrixWorld(true);
    rig.root.position.y += rig.restMinY - lowestBoneY(rig);
    rig.root.updateMatrixWorld(true);
  }
}
