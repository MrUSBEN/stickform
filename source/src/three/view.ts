// The 3D side for the Studio layout: one shared stage (scene, lights, ground, stick overlay) and any number of
// viewports onto it. The output viewport looks through the output camera: the dashed frame it shows is exactly the
// rendered PNG. An orbit viewport is a free work view that also shows the output camera as a small gizmo.
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { Rig, lowestBoneY } from './rig';
import { Joints, V3 } from '../sketch/lifter';
import { COLOR, Tag } from '../sketch/tagger';

export type Background = 'white' | 'grey' | 'dark' | 'transparent';
export type CamPreset = 'front' | 'q' | 'side' | 'free';
const BG: Record<Exclude<Background, 'transparent'>, number> = { white: 0xffffff, grey: 0xb8b8b8, dark: 0x2a2a2a };
/** Yaw and pitch (degrees) of the camera presets. */
const PRESET: Record<Exclude<CamPreset, 'free'>, [number, number]> = { front: [0, 4], q: [35, 8], side: [90, 4] };

/** The shared scene. */
export class Stage {
  scene = new THREE.Scene();
  overlay = new THREE.Group();
  /** Where the character stands and how it is turned: holds the rig. Turns pivot about the hips. */
  place = new THREE.Group();
  grid: THREE.GridHelper;
  shadowGround: THREE.Mesh;
  rig: Rig | null = null;
  showOverlay = false;
  /** The 3D viewports' background outside the output frame (Settings › Viewport colours). */
  bg = 0xe6e4de;
  /** Every character's group (the active one is `place`). Hidden characters have `visible = false`. */
  groups: THREE.Group[] = [];
  /** Objects (primitives and imported meshes): framed by the camera presets with everyone (floor planes excepted). */
  props: THREE.Object3D[] = [];
  /** What camera presets frame: every visible character, or only the active one. */
  frameMode: 'all' | 'active' = 'all';
  /** Camera presets turn with the active character (radians about the vertical), 0 = world-fixed. */
  aimYaw = 0;
  constructor() {
    this.scene.add(new THREE.HemisphereLight(0xffffff, 0x8a8478, 1.6));
    const key = new THREE.DirectionalLight(0xffffff, 2.2);
    key.position.set(2.5, 5, 3.5);
    key.castShadow = true;
    key.shadow.mapSize.set(2048, 2048);
    Object.assign(key.shadow.camera, { left: -3, right: 3, top: 3, bottom: -3, near: 0.5, far: 15 });
    key.shadow.bias = -0.0005;
    this.scene.add(key);
    const fill = new THREE.DirectionalLight(0xffffff, 0.6);
    fill.position.set(-3, 2, -2);
    this.scene.add(fill);
    this.shadowGround = new THREE.Mesh(new THREE.CircleGeometry(6, 48), new THREE.ShadowMaterial({ opacity: 0.18 }));
    this.shadowGround.rotation.x = -Math.PI / 2;
    this.shadowGround.receiveShadow = true;
    this.scene.add(this.shadowGround);
    this.grid = this.makeGrid();
    this.scene.add(this.grid);
    this.scene.add(this.overlay);
    this.scene.add(this.place);
    this.groups.push(this.place);
  }
  /** Add another character's group to the scene. */
  addGroup(g: THREE.Group): void { if (!this.groups.includes(g)) { this.groups.push(g); this.scene.add(g); } }
  removeGroup(g: THREE.Group): void { this.groups = this.groups.filter(x => x !== g); this.scene.remove(g); }
  /** Objects (shapes and imported meshes) on the stage. */
  addProp(o: THREE.Object3D): void { if (!this.props.includes(o)) { this.props.push(o); this.scene.add(o); } }
  removeProp(o: THREE.Object3D): void { this.props = this.props.filter(x => x !== o); this.scene.remove(o); }
  /** Make a group (holding `rig`) the active character: posing, overlay and picking act on it. */
  setActive(g: THREE.Group, rig: Rig): void {
    this.addGroup(g); this.place = g;
    if (rig.root.parent !== g) { if (rig.root.parent) rig.root.parent.remove(rig.root); g.add(rig.root); }
    this.rig = rig;
  }
  /** Floor grid lines a little darker than the background, so they read on any viewport colour. */
  private makeGrid(): THREE.GridHelper {
    const c = new THREE.Color(this.bg), major = c.clone().multiplyScalar(0.66), minor = c.clone().multiplyScalar(0.84);
    const g = new THREE.GridHelper(8, 16, major, minor);
    (g.material as THREE.Material).transparent = true;
    (g.material as THREE.Material).opacity = 0.5;
    return g;
  }
  /** Change the 3D viewport background (and the grid to match). */
  setBackground(hex: number): void {
    if (hex === this.bg) return;
    this.bg = hex;
    const old = this.grid, g = this.makeGrid();
    g.visible = old.visible;
    this.scene.remove(old); old.geometry.dispose(); (old.material as THREE.Material).dispose();
    this.grid = g; this.scene.add(g);
  }
  setRig(rig: Rig): void {
    if (this.rig && this.rig.root.parent === this.place) this.place.remove(this.rig.root);
    if (rig.root.parent) rig.root.parent.remove(rig.root);
    this.rig = rig;
    this.place.add(rig.root);
  }
  /** Back to no move, turn or scale (retargeting works in the character's own space). */
  resetPlacement(g: THREE.Group = this.place): void { g.position.set(0, 0, 0); g.quaternion.identity(); g.scale.set(1, 1, 1); g.updateMatrixWorld(true); }
  /** Move, turn and scale the whole character. `s` scales it about the floor under its hips (it keeps standing on
   *  the floor); `q` turns it about the (scaled) hips; with `ground` the feet are put back on the floor after the
   *  turn; then `p` (metres) moves it (so y lifts it off the floor). Call after posing. */
  applyPlacement(p: V3, q: [number, number, number, number], ground: boolean, g: THREE.Group = this.place, rig: Rig | null = this.rig, s: V3 = [1, 1, 1]): void {
    g.position.set(0, 0, 0); g.quaternion.identity(); g.scale.set(1, 1, 1); g.updateMatrixWorld(true);
    if (!rig) return;
    const Q = new THREE.Quaternion(q[0], q[1], q[2], q[3]).normalize();
    const S = new THREE.Vector3(...s.map(v => (isFinite(v) && Math.abs(v) > 1e-4 ? v : 1)) as V3);
    const h = rig.bones.hips ? rig.bones.hips.getWorldPosition(new THREE.Vector3()) : new THREE.Vector3();
    const base = new THREE.Vector3(h.x, rig.restMinY, h.z); // the floor under the hips
    const hS = base.clone().add(h.clone().sub(base).multiply(S)); // the hips after scaling about it
    g.quaternion.copy(Q); g.scale.copy(S);
    g.position.copy(hS).sub(h.clone().multiply(S).applyQuaternion(Q));
    g.updateMatrixWorld(true);
    if (ground && Math.abs(Q.w) < 1 - 1e-9) { g.position.y += rig.restMinY - lowestBoneY(rig); g.updateMatrixWorld(true); }
    g.position.x += p[0]; g.position.y += p[1]; g.position.z += p[2];
    g.updateMatrixWorld(true);
  }
  /** Bounding sphere of one character's group. */
  sphereOf(g: THREE.Group): THREE.Sphere | null { const box = new THREE.Box3().setFromObject(g, true); return box.isEmpty() ? null : box.getBoundingSphere(new THREE.Sphere()); }
  /** Bounding sphere of what the camera presets frame: every visible character, or the active one. */
  sphere(mode: 'all' | 'active' = this.frameMode): THREE.Sphere | null {
    if (!this.rig) return null;
    const box = new THREE.Box3();
    const list: THREE.Object3D[] = mode === 'active' ? [this.place] : [...this.groups.filter(g => g.visible), ...this.props.filter(o => o.visible && !o.userData.noFrame)];
    for (const g of list.length ? list : [this.place]) box.union(new THREE.Box3().setFromObject(g, true));
    return box.isEmpty() ? null : box.getBoundingSphere(new THREE.Sphere());
  }
  /** Draw the stick figure from the sketch over the character, scaled to its spine. */
  setOverlay(J: Joints | null): void {
    this.overlay.clear();
    if (!J || !this.rig) return;
    const b = this.rig.bones;
    if (!b.hips || !(b.neck || b.head)) return;
    const hips = b.hips.getWorldPosition(new THREE.Vector3());
    const neck = (b.neck || b.head)!.getWorldPosition(new THREE.Vector3());
    const S = this.place.scale, Q = this.place.quaternion;
    const k = this.place.worldToLocal(hips.clone()).distanceTo(this.place.worldToLocal(neck.clone())); // unscaled spine
    const P = (a: V3) => new THREE.Vector3(a[0] * k, a[1] * k, a[2] * k).multiply(S).applyQuaternion(Q).add(hips);
    const seg: [keyof Joints, keyof Joints, Tag][] = [['P', 'S1', 'spine'], ['S1', 'S2', 'spine'], ['S2', 'N', 'spine'], ['shL', 'shR', 'sh'], ['hpL', 'hpR', 'hip'], ['N', 'H', 'head'],
      ['shL', 'aL1', 'armL'], ['aL1', 'aL2', 'armL'], ['shR', 'aR1', 'armR'], ['aR1', 'aR2', 'armR'],
      ['hpL', 'lL1', 'legL'], ['lL1', 'lL2', 'legL'], ['hpR', 'lR1', 'legR'], ['lR1', 'lR2', 'legR']];
    const line = (a: THREE.Vector3, c: THREE.Vector3, col: string) => {
      const l = new THREE.Line(new THREE.BufferGeometry().setFromPoints([a, c]),
        new THREE.LineBasicMaterial({ color: col, depthTest: false, transparent: true, opacity: 0.9 }));
      l.renderOrder = 10;
      this.overlay.add(l);
    };
    for (const [a, c, t] of seg) line(P(J[a]), P(J[c]), COLOR[t]);
    line(P(J.H), P([J.H[0] + J.f[0] * 0.45, J.H[1] + J.f[1] * 0.45, J.H[2] + J.f[2] * 0.45]), COLOR.face);
  }
}

/** Output settings, shared by the output viewport and the PNG export. */
export class Output {
  w = 1024; h = 1024;
  background: Background = 'white';
  shadow = true;
  preset: CamPreset = 'q';
  get aspect(): number { return this.w / this.h; }
}

export interface Rect { x: number; y: number; w: number; h: number }

export class Viewport3D {
  renderer: THREE.WebGLRenderer;
  camera = new THREE.PerspectiveCamera(35, 1, 0.05, 100);
  controls: OrbitControls;
  /** Size of the canvas in CSS px at the last resize; kept when the viewport is hidden. */
  size = { w: 600, h: 700 };
  private helper: THREE.CameraHelper | null = null;
  private gizmoCam = new THREE.PerspectiveCamera(35, 1, 0.05, 0.45);
  /** Called when the user starts orbiting (the output viewport switches its preset to Free). */
  onUserMove: () => void = () => {};

  constructor(public canvas: HTMLCanvasElement, private stage: Stage, private out: Output, public kind: 'output' | 'orbit',
              private source?: Viewport3D) {
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true });
    this.renderer.setPixelRatio(Math.min(2, devicePixelRatio || 1));
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFShadowMap;
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.camera.position.set(kind === 'orbit' ? 2.6 : 0.6, 1.3, 6.5);
    this.controls = new OrbitControls(this.camera, canvas);
    this.controls.target.set(0, 0.9, 0);
    this.controls.enableDamping = false;
    this.controls.screenSpacePanning = true;
    this.controls.addEventListener('change', () => this.render());
    this.controls.addEventListener('start', () => this.onUserMove());
    if (kind === 'orbit') {
      this.helper = new THREE.CameraHelper(this.gizmoCam);
      this.helper.visible = false;
      stage.scene.add(this.helper);
    }
  }

  get visible(): boolean { return this.canvas.getBoundingClientRect().width > 0; }

  /** Edit pen mode: the left button draws (handled outside), right-drag orbits, middle-drag pans. */
  setEditMode(on: boolean): void {
    const M = THREE.MOUSE;
    this.controls.mouseButtons = on
      ? { LEFT: null as unknown as THREE.MOUSE, MIDDLE: M.PAN, RIGHT: M.ROTATE }
      : { LEFT: M.ROTATE, MIDDLE: M.DOLLY, RIGHT: M.PAN };
  }

  /** CSS px inside this viewport for a world point. */
  project(p: THREE.Vector3): { x: number; y: number } {
    const v = p.clone().project(this.camera);
    return { x: (v.x + 1) / 2 * this.size.w, y: (1 - v.y) / 2 * this.size.h };
  }

  /** The world point under CSS px (x, y) on the plane through `through` that faces the camera. */
  toPlane(x: number, y: number, through: THREE.Vector3): THREE.Vector3 | null {
    const ndc = new THREE.Vector2(x / this.size.w * 2 - 1, -(y / this.size.h) * 2 + 1);
    const ray = new THREE.Raycaster(); ray.setFromCamera(ndc, this.camera);
    const n = this.camera.getWorldDirection(new THREE.Vector3());
    const plane = new THREE.Plane().setFromNormalAndCoplanarPoint(n, through);
    return ray.ray.intersectPlane(plane, new THREE.Vector3());
  }

  resize(): void {
    const r = this.canvas.getBoundingClientRect();
    if (r.width > 0 && r.height > 0) {
      this.size = { w: r.width, h: r.height };
      this.renderer.setSize(r.width, r.height, false);
      this.camera.aspect = r.width / r.height;
      this.camera.updateProjectionMatrix();
    }
    this.render();
  }

  /** The output frame in CSS px inside this viewport: the largest rectangle of the output aspect that fits with a margin. */
  frame(): Rect {
    const { w, h } = this.size, a = this.out.aspect;
    const mw = w - 72, mh = h - 112; // room for the floating controls at the top and the summary at the bottom
    let fw = Math.max(40, mw), fh = fw / a;
    if (fh > mh) { fh = Math.max(40, mh); fw = fh * a; }
    return { x: (w - fw) / 2, y: (h - fh) / 2 + 6, w: fw, h: fh };
  }

  /** The output camera: this viewport's camera narrowed to the frame. Off-centre frames use a view offset. */
  outputCamera(): THREE.PerspectiveCamera {
    const f = this.frame(), { w, h } = this.size;
    const c = new THREE.PerspectiveCamera(this.camera.fov, this.out.aspect, this.camera.near, this.camera.far);
    c.position.copy(this.camera.position);
    c.quaternion.copy(this.camera.quaternion);
    // Treat the frame as a sub-rectangle of the full view.
    c.aspect = w / h;
    c.setViewOffset(w, h, f.x, f.y, f.w, f.h);
    c.updateProjectionMatrix();
    c.updateMatrixWorld(true);
    return c;
  }

  /** Point the camera from a preset direction and fit the character into the frame. */
  applyPreset(p: CamPreset): void {
    if (p === 'free') return;
    const [yd, pd] = PRESET[p];
    const y = THREE.MathUtils.degToRad(yd) + this.stage.aimYaw, pi = THREE.MathUtils.degToRad(pd);
    const dir = new THREE.Vector3(Math.sin(y) * Math.cos(pi), Math.sin(pi), Math.cos(y) * Math.cos(pi));
    this.fit(dir);
  }

  /** Fit the character into the frame along a viewing direction (from target toward the camera). */
  fit(dir?: THREE.Vector3, mode?: 'all' | 'active'): void {
    const s = this.stage.sphere(mode);
    if (s) this.fitSphere(s, dir);
  }
  /** Fit a sphere (one character, everyone) into this view, along a direction or the current one. */
  fitSphere(s: THREE.Sphere, dir?: THREE.Vector3): void {
    const d0 = dir || this.camera.position.clone().sub(this.controls.target).normalize();
    const f = this.kind === 'output' ? this.frame() : { w: this.size.w, h: this.size.h };
    const vf = Math.atan(Math.tan(THREE.MathUtils.degToRad(this.camera.fov) / 2) * f.h / this.size.h);
    const hf = Math.atan(Math.tan(vf) * f.w / f.h);
    const d = s.radius * (this.kind === 'output' ? 1.08 : 1.3) / Math.sin(Math.min(vf, hf));
    // far scenes: see all the way to the far side (and keep the near plane in proportion)
    this.camera.far = Math.max(100, (d + s.radius * 3) * 1.5); this.camera.near = Math.max(0.05, this.camera.far / 20000);
    this.camera.updateProjectionMatrix();
    this.controls.target.copy(s.center);
    this.camera.position.copy(s.center).addScaledVector(d0, d);
    this.camera.lookAt(s.center);
    this.controls.update();
  }

  render(): void {
    if (!this.visible) return;
    const st = this.stage, r = this.renderer;
    st.overlay.visible = st.showOverlay;
    if (this.helper && this.source) {
      const oc = this.source.outputCamera();
      this.gizmoCam.position.copy(oc.position); this.gizmoCam.quaternion.copy(oc.quaternion);
      this.gizmoCam.fov = THREE.MathUtils.radToDeg(2 * Math.atan(Math.tan(THREE.MathUtils.degToRad(oc.fov) / 2) * this.source.frame().h / this.source.size.h));
      this.gizmoCam.aspect = this.out.aspect;
      this.gizmoCam.updateProjectionMatrix(); this.gizmoCam.updateMatrixWorld(true);
      this.helper.update();
    }
    const helpers = this.stage.scene.children.filter(o => o instanceof THREE.CameraHelper);
    helpers.forEach(o => { o.visible = o === this.helper; });
    // Pass 1: the stage with its grid.
    st.grid.visible = true; st.shadowGround.visible = true;
    st.scene.background = new THREE.Color(st.bg);
    r.setScissorTest(false);
    r.render(st.scene, this.camera);
    if (this.kind === 'output') {
      // Pass 2: inside the frame, the output look (background, shadow, no grid).
      const f = this.frame();
      r.setScissorTest(true);
      r.setScissor(f.x, this.size.h - f.y - f.h, f.w, f.h);
      st.grid.visible = false; st.shadowGround.visible = this.out.shadow;
      st.scene.background = this.out.background === 'transparent' ? new THREE.Color(0xf3f2ee) : new THREE.Color(BG[this.out.background]);
      r.render(st.scene, this.camera);
      r.setScissorTest(false);
    }
    helpers.forEach(o => { o.visible = false; });
    st.grid.visible = true; st.shadowGround.visible = true;
  }

  /** Render the output camera at full size to a PNG data URL (output viewport only). */
  renderPNG(): string {
    const { w, h } = this.out, st = this.stage;
    const c = document.createElement('canvas');
    c.width = w; c.height = h;
    const r = new THREE.WebGLRenderer({ canvas: c, antialias: true, alpha: true, preserveDrawingBuffer: true });
    r.setPixelRatio(1);
    r.setSize(w, h, false);
    r.shadowMap.enabled = true; r.shadowMap.type = THREE.PCFShadowMap;
    r.outputColorSpace = THREE.SRGBColorSpace;
    const cam = this.outputCamera();
    const vis = [st.overlay.visible, st.grid.visible, st.shadowGround.visible];
    st.overlay.visible = false; st.grid.visible = false; st.shadowGround.visible = this.out.shadow;
    const helpers = st.scene.children.filter(o => o instanceof THREE.CameraHelper);
    helpers.forEach(o => { o.visible = false; });
    st.scene.background = this.out.background === 'transparent' ? null : new THREE.Color(BG[this.out.background]);
    r.setClearColor(0x000000, this.out.background === 'transparent' ? 0 : 1);
    r.render(st.scene, cam);
    [st.overlay.visible, st.grid.visible, st.shadowGround.visible] = vis;
    const url = c.toDataURL('image/png');
    r.dispose();
    r.forceContextLoss();
    return url;
  }
}
