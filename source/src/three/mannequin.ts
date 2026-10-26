// Built-in mannequin: a bone hierarchy in T-pose with rigid capsule and box parts, about 1.75 m tall, facing +z
// (its own left at +x). Proportions match the stick-figure rig (spine 0.5 m pelvis to neck).
import * as THREE from 'three';
import { Rig, Slot, captureRest } from './rig';

type J = { slot: Slot; parent: Slot | null; pos: [number, number, number] };

// World positions of each joint in the rest pose. Right side mirrors the left.
const L = (s: string) => s as Slot;
const JOINTS: J[] = [
  { slot: 'hips', parent: null, pos: [0, 0.95, 0] },
  { slot: 'spine', parent: 'hips', pos: [0, 1.07, 0] },
  { slot: 'chest', parent: 'spine', pos: [0, 1.25, 0] },
  { slot: 'neck', parent: 'chest', pos: [0, 1.45, 0] },
  { slot: 'head', parent: 'neck', pos: [0, 1.55, 0.01] },
  ...(['left', 'right'] as const).flatMap(side => {
    const s = side === 'left' ? 1 : -1;
    return [
      { slot: L(side + 'Shoulder'), parent: 'chest' as Slot, pos: [0.04 * s, 1.41, 0] as [number, number, number] },
      { slot: L(side + 'UpperArm'), parent: L(side + 'Shoulder'), pos: [0.19 * s, 1.41, 0] as [number, number, number] },
      { slot: L(side + 'LowerArm'), parent: L(side + 'UpperArm'), pos: [0.465 * s, 1.41, 0] as [number, number, number] },
      { slot: L(side + 'Hand'), parent: L(side + 'LowerArm'), pos: [0.715 * s, 1.41, 0] as [number, number, number] },
      { slot: L(side + 'UpperLeg'), parent: 'hips' as Slot, pos: [0.095 * s, 0.9, 0] as [number, number, number] },
      { slot: L(side + 'LowerLeg'), parent: L(side + 'UpperLeg'), pos: [0.095 * s, 0.5, 0] as [number, number, number] },
      { slot: L(side + 'Foot'), parent: L(side + 'LowerLeg'), pos: [0.095 * s, 0.09, 0] as [number, number, number] },
      { slot: L(side + 'Toes'), parent: L(side + 'Foot'), pos: [0.095 * s, 0.03, 0.13] as [number, number, number] },
    ];
  }),
];

export function makeMannequin(material?: THREE.Material): Rig {
  const mat = material ?? new THREE.MeshStandardMaterial({ color: 0xc9c6bf, roughness: 0.75, metalness: 0 });
  mat.userData.body = true; // tinted per character (tintMannequin)
  const joint = new THREE.MeshStandardMaterial({ color: 0x9f9a90, roughness: 0.8 });
  const root = new THREE.Group();
  root.name = 'Mannequin';
  const bones: Partial<Record<Slot, THREE.Object3D>> = {};
  const world: Partial<Record<Slot, THREE.Vector3>> = {};
  for (const j of JOINTS) {
    const b = new THREE.Bone();
    b.name = j.slot;
    const w = new THREE.Vector3(...j.pos);
    world[j.slot] = w;
    const pw = j.parent ? world[j.parent]! : new THREE.Vector3();
    b.position.copy(w).sub(pw);
    (j.parent ? bones[j.parent]! : root).add(b);
    bones[j.slot] = b;
  }
  // A rounded limb segment from bone `a` toward world point `to`, attached to bone a.
  const seg = (a: Slot, to: THREE.Vector3, r: number, m: THREE.Material = mat) => {
    const from = world[a]!, d = to.clone().sub(from), len = d.length();
    const g = new THREE.CapsuleGeometry(r, Math.max(0.001, len - r * 0.6), 6, 14);
    const mesh = new THREE.Mesh(g, m);
    mesh.position.copy(d.clone().multiplyScalar(0.5));
    mesh.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), d.clone().normalize());
    bones[a]!.add(mesh);
    return mesh;
  };
  const ball = (a: Slot, r: number) => { const m = new THREE.Mesh(new THREE.SphereGeometry(r, 16, 12), joint); bones[a]!.add(m); };
  // torso: pelvis block, belly, chest
  const box = (a: Slot, size: [number, number, number], off: [number, number, number], round = 0.04) => {
    const m = new THREE.Mesh(roundedBox(size[0], size[1], size[2], round), mat);
    m.position.set(...off);
    bones[a]!.add(m);
  };
  box('hips', [0.3, 0.16, 0.19], [0, -0.02, 0]);
  box('spine', [0.27, 0.17, 0.17], [0, 0.09, 0]);
  box('chest', [0.36, 0.22, 0.21], [0, 0.1, 0]);
  seg('neck', world.head!, 0.045);
  const head = new THREE.Mesh(new THREE.SphereGeometry(0.105, 24, 18), mat);
  head.scale.set(0.9, 1.08, 1);
  head.position.set(0, 0.09, 0.01);
  bones.head!.add(head);
  const nose = new THREE.Mesh(new THREE.ConeGeometry(0.022, 0.05, 10), joint); // shows which way the head faces
  nose.rotation.x = Math.PI / 2;
  nose.position.set(0, 0.08, 0.11);
  bones.head!.add(nose);
  for (const side of ['left', 'right'] as const) {
    const S = (n: string) => (side + n) as Slot;
    seg(S('UpperArm'), world[S('LowerArm')]!, 0.048);
    seg(S('LowerArm'), world[S('Hand')]!, 0.04);
    ball(S('UpperArm'), 0.055); ball(S('LowerArm'), 0.045);
    const hand = new THREE.Mesh(roundedBox(0.09, 0.03, 0.07, 0.012), mat);
    hand.position.set((side === 'left' ? 1 : -1) * 0.055, 0, 0);
    bones[S('Hand')]!.add(hand);
    seg(S('UpperLeg'), world[S('LowerLeg')]!, 0.07);
    seg(S('LowerLeg'), world[S('Foot')]!, 0.055);
    ball(S('UpperLeg'), 0.075); ball(S('LowerLeg'), 0.06);
    const foot = new THREE.Mesh(roundedBox(0.09, 0.07, 0.24, 0.025), mat);
    foot.position.set(0, -0.045, 0.06);
    bones[S('Foot')]!.add(foot);
  }
  root.traverse(o => { if ((o as THREE.Mesh).isMesh) { o.castShadow = true; o.receiveShadow = true; } });
  const rig: Rig = { name: 'Mannequin', root, bones, restLocal: new Map(), restMinY: 0, allBones: Object.values(bones) as THREE.Object3D[], kind: 'mannequin' };
  captureRest(rig);
  return rig;
}

/** A box with rounded edges (capsule-like corners), centred at the origin. */
function roundedBox(w: number, h: number, d: number, r: number): THREE.BufferGeometry {
  const g = new THREE.BoxGeometry(w, h, d, 6, 6, 6);
  const p = g.attributes.position as THREE.BufferAttribute, v = new THREE.Vector3(), inner = new THREE.Vector3();
  const hx = w / 2 - r, hy = h / 2 - r, hz = d / 2 - r;
  for (let i = 0; i < p.count; i++) {
    v.fromBufferAttribute(p, i);
    inner.set(THREE.MathUtils.clamp(v.x, -hx, hx), THREE.MathUtils.clamp(v.y, -hy, hy), THREE.MathUtils.clamp(v.z, -hz, hz));
    const n = v.clone().sub(inner);
    if (n.lengthSq() > 1e-12) v.copy(inner).add(n.normalize().multiplyScalar(r));
    p.setXYZ(i, v.x, v.y, v.z);
  }
  g.computeVertexNormals();
  return g;
}

/** Colour a mannequin's body (joints stay darker grey), so several mannequins in one scene can be told apart. */
export function tintMannequin(rig: Rig, color: string | number): void {
  const seen = new Set<THREE.Material>();
  rig.root.traverse(o => {
    const m = (o as THREE.Mesh).material as THREE.MeshStandardMaterial | undefined;
    if (m && !Array.isArray(m) && m.userData?.body && !seen.has(m)) { seen.add(m); m.color.set(color); }
  });
}
