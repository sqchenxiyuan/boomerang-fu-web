import * as THREE from 'three';
import { POWERUPS } from '../core/config';
import { introPose, transitionPresentation } from '../core/presentation';
import { lerpV } from '../core/math';
import type { GameEvent, GameState, Pickup } from '../core/types';
import { createArenaView } from './arena-view';
import type { ArenaView } from './arena-view';
import { createCharacter, updateCharacter } from './characters';
import type { CharacterView } from './characters';
import { Effects } from './effects';
import { BoundaryView } from './boundary-view';
import { box, cylinder, makeBoomerang, material, place, shadow } from './palette';
import { mergeStaticMeshes } from './batches';
import { WeaponsView, discEffectColor } from './weapons-view';
import { PowersView } from './powers-view';

function cloneCharacter(source: CharacterView): CharacterView {
  const root = source.root.clone(true);
  const lookup = new Map<THREE.Object3D, THREE.Object3D>();
  const link = (a: THREE.Object3D, b: THREE.Object3D): void => {
    lookup.set(a, b);
    a.children.forEach((child, i) => link(child, b.children[i]));
  };
  link(source.root, root);
  const copy = <T extends THREE.Object3D>(object: T): T => lookup.get(object) as T;
  return {
    ...source,
    root,
    body: copy(source.body),
    leftArm: copy(source.leftArm),
    rightArm: copy(source.rightArm),
    feet: source.feet.map(copy),
    weapon: copy(source.weapon),
    shield: copy(source.shield),
    hands: source.hands?.map(copy),
    limbs: source.limbs?.map(copy),
    aim: copy(source.aim),
    ring: copy(source.ring),
    label: copy(source.label),
    shadow: copy(source.shadow),
    leftWeapon: source.leftWeapon && copy(source.leftWeapon),
    disguise: source.disguise && copy(source.disguise),
    iceBlock: source.iceBlock && copy(source.iceBlock),
    death: {
      root: copy(source.death.root),
      stump: copy(source.death.stump),
      piece: copy(source.death.piece),
      squash: copy(source.death.squash),
    },
  };
}

function buildArena(state: GameState): ArenaView {
  const arena = createArenaView(state.arena);
  const animated = new Set<THREE.Object3D>([
    arena.water,
    ...arena.flags,
    ...arena.portals.values(),
    ...arena.obstacles.values(),
  ]);
  mergeStaticMeshes(arena.root, animated);
  for (const obstacle of arena.obstacles.values()) mergeStaticMeshes(obstacle);
  return arena;
}

function disposeVisual(root: THREE.Object3D): void {
  root.traverse((object) => {
    if (object instanceof THREE.Mesh) {
      object.geometry.dispose();
      const materials = Array.isArray(object.material) ? object.material : [object.material];
      for (const mat of materials) if (!mat.userData.shared) mat.dispose();
    }
    if (object instanceof THREE.Sprite) {
      object.material.map?.dispose();
      object.material.dispose();
    }
    if (object instanceof THREE.Line) {
      object.geometry.dispose();
      const materials = Array.isArray(object.material) ? object.material : [object.material];
      for (const mat of materials) if (!mat.userData.shared) mat.dispose();
    }
  });
}

function createPickup(pickup: Pickup): THREE.Group {
  const group = new THREE.Group(),
    color = POWERUPS[pickup.kind].color;
  const book = new THREE.Group();
  place(box(0.69, 0.12, 0.83, color), 0, 0.7, 0, book);
  place(box(0.59, 0.15, 0.73, '#fff1cb'), 0.025, 0.79, 0, book);
  place(box(0.69, 0.065, 0.83, color), 0, 0.9, 0, book);
  const icon = cylinder(
    0.14,
    0.14,
    0.025,
    '#fef6db',
    pickup.kind === 'shield' ? 5 : pickup.kind === 'haste' ? 3 : 8,
  );
  place(icon, 0, 0.95, 0, book);
  group.add(book, shadow(0.5, 0.12));
  const ring = new THREE.Mesh(
    new THREE.RingGeometry(0.4, 0.47, 28),
    new THREE.MeshBasicMaterial({
      color,
      transparent: true,
      opacity: 0.8,
      side: THREE.DoubleSide,
      depthWrite: false,
    }),
  );
  ring.rotation.x = -Math.PI / 2;
  ring.position.y = 0.05;
  group.add(ring);
  group.position.set(pickup.position.x, 0, pickup.position.y);
  return group;
}

export class GameRenderer {
  readonly canvas: HTMLCanvasElement;
  readonly renderer: THREE.WebGLRenderer;
  private scene = new THREE.Scene();
  private camera = new THREE.PerspectiveCamera(31, 1, 0.1, 180);
  private arena: ArenaView;
  private characters = new Map<number, CharacterView>();
  private decoys = new Map<number, CharacterView>();
  private discs = new Map<number, THREE.Group>();
  private discPool: THREE.Group[] = [];
  private pickups = new Map<number, THREE.Group>();
  private effects = new Effects();
  private weapons = new WeaponsView();
  private powers = new PowersView();
  private boundary = new BoundaryView();
  private resizeObserver: ResizeObserver;
  private width = 1;
  private height = 1;
  private cameraTarget = new THREE.Vector3(0, 0, 0);
  private arenaSource: string;
  private previousTime = 0;

  constructor(container: HTMLElement, state: GameState) {
    this.renderer = new THREE.WebGLRenderer({
      antialias: true,
      alpha: false,
      powerPreference: 'high-performance',
    });
    this.canvas = this.renderer.domElement;
    this.canvas.className = 'game-canvas';
    this.canvas.setAttribute('aria-label', '回旋花园三维竞技场');
    this.canvas.tabIndex = 0;
    container.appendChild(this.canvas);
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 1.75));
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.12;
    this.scene.background = new THREE.Color('#a7c8bb');
    this.scene.fog = new THREE.Fog('#a7c8bb', 60, 105);
    this.scene.add(new THREE.HemisphereLight('#fff8df', '#769f96', 1.9));
    const sun = new THREE.DirectionalLight('#fff0ca', 2.7);
    sun.position.set(-12, 22, 8);
    sun.castShadow = true;
    sun.shadow.mapSize.set(2048, 2048);
    Object.assign(sun.shadow.camera, {
      left: -21,
      right: 21,
      top: 17,
      bottom: -17,
      near: 0.1,
      far: 70,
    });
    sun.shadow.normalBias = 0.04;
    sun.shadow.bias = -0.0003;
    sun.shadow.radius = 3;
    this.scene.add(sun);
    this.arena = buildArena(state);
    this.arenaSource = '';
    this.scene.add(
      this.arena.root,
      this.effects.root,
      this.weapons.root,
      this.powers.root,
      this.boundary.root,
    );
    this.reset(state);
    this.arenaSource = `${state.arena.id ?? 'courtyard'}:${state.round}`;
    this.resizeObserver = new ResizeObserver(() =>
      this.resize(container.clientWidth, container.clientHeight),
    );
    this.resizeObserver.observe(container);
    this.resize(container.clientWidth, container.clientHeight);
  }

  reset(state: GameState): void {
    this.arenaSource = '';
    // Decoys borrow their owner's GPU assets; only the owner disposes them.
    for (const view of this.decoys.values()) this.scene.remove(view.root);
    this.decoys.clear();
    for (const view of this.characters.values()) {
      this.scene.remove(view.root);
      disposeVisual(view.root);
    }
    this.characters.clear();
    for (const actor of state.actors) {
      const view = createCharacter(actor);
      this.characters.set(actor.id, view);
      this.scene.add(view.root);
    }
    for (const group of this.discs.values()) this.releaseDisc(group);
    for (const group of this.pickups.values()) {
      this.scene.remove(group);
      disposeVisual(group);
    }
    this.discs.clear();
    this.pickups.clear();
    this.effects.clear();
    this.weapons.clear();
    this.powers.clear();
    this.boundary.reset();
    this.previousTime = state.time;
  }

  private resize(width: number, height: number): void {
    this.width = Math.max(1, width);
    this.height = Math.max(1, height);
    this.renderer.setSize(this.width, this.height);
    this.camera.aspect = this.width / this.height;
    this.camera.updateProjectionMatrix();
  }

  events(events: GameEvent[]): void {
    for (const event of events) {
      this.effects.emit(event);
      this.weapons.observe(event);
    }
  }

  private releaseDisc(group: THREE.Group): void {
    group.visible = false;
    if (this.discPool.length < 32) this.discPool.push(group);
    else {
      this.scene.remove(group);
      disposeVisual(group);
    }
  }

  draw(state: GameState, alpha: number, elapsed: number, dt: number, menu: boolean): void {
    const simulationTime = menu ? elapsed : state.time;
    const arenaKey = `${state.arena.id ?? 'courtyard'}:${state.round}`;
    if (this.arenaSource !== arenaKey) {
      this.scene.remove(this.arena.root);
      disposeVisual(this.arena.root);
      this.arena = buildArena(state);
      this.scene.add(this.arena.root);
      this.arenaSource = arenaKey;
      this.effects.clear();
      this.weapons.clear();
      this.powers.clear();
      this.boundary.reset();
    }
    const presentation = transitionPresentation(state);
    const entranceOrder = [...state.actors].sort((a, b) => b.score - a.score || a.id - b.id);
    for (const actor of state.actors) {
      const view = this.characters.get(actor.id);
      if (view) {
        updateCharacter(
          view,
          menu ? { ...actor, facing: { x: -0.15, y: 1 } } : actor,
          alpha,
          simulationTime,
        );
        const pose =
          !menu && state.phase === 'countdown'
            ? introPose(
                state.phaseTime,
                entranceOrder.findIndex((a) => a.id === actor.id),
                state.actors.length,
              )
            : { visible: true, height: 0, scale: 1, squash: 1, landing: 0 };
        view.root.visible = pose.visible;
        view.root.position.y = pose.height;
        view.root.scale.set(
          pose.scale / Math.sqrt(pose.squash),
          pose.scale * pose.squash,
          pose.scale / Math.sqrt(pose.squash),
        );
        view.ring.scale.setScalar(1 + pose.landing * 0.45);
      }
    }
    const liveDecoys = new Set<number>();
    for (const decoy of state.decoys) {
      if (!decoy.alive) continue;
      const owner = state.actors.find((actor) => actor.id === decoy.ownerId);
      const source = this.characters.get(decoy.ownerId);
      if (!owner || !source) continue;
      liveDecoys.add(decoy.id);
      let view = this.decoys.get(decoy.id);
      if (!view) {
        view = cloneCharacter(source);
        this.decoys.set(decoy.id, view);
        this.scene.add(view.root);
      }
      updateCharacter(
        view,
        {
          ...owner,
          position: decoy.position,
          previous: decoy.previous,
          velocity: decoy.velocity,
          facing: decoy.facing,
          powers: decoy.powers,
          alive: true,
          dashTime: decoy.dashTime,
          death: undefined,
          fall: undefined,
          outOfBounds: undefined,
          disguised: false,
          frozenTime: 0,
          burnTime: 0,
          reverseTime: 0,
          charge: 0,
          attackTime: 0,
          attackSerial: 0,
          lungeRecovery: 0,
          controlling: false,
          shield: false,
          invulnerable: 0,
          heldDiscs: 1,
          armed: true,
        },
        alpha,
        simulationTime,
      );
      view.root.visible = true;
      view.label.visible = false;
      view.ring.visible = false;
      view.root.scale.setScalar(1);
    }
    for (const [id, view] of this.decoys)
      if (!liveDecoys.has(id)) {
        this.scene.remove(view.root);
        this.decoys.delete(id);
      }
    for (const obstacle of state.arena.obstacles) {
      const object = this.arena.obstacles.get(obstacle.id);
      if (object) object.visible = !obstacle.broken;
    }
    for (const disc of state.discs) {
      let object = this.discs.get(disc.id);
      if (!object) {
        object = this.discPool.pop();
        if (!object) {
          object = new THREE.Group();
          object.add(makeBoomerang(), shadow(0.4, 0.13));
        }
        object.visible = true;
        this.scene.add(object);
        this.discs.set(disc.id, object);
      }
      const color = discEffectColor(disc);
      if (object.userData.color !== color) {
        (object.children[0].children[0] as THREE.Mesh).material = material(color);
        object.userData.color = color;
      }
      object.scale.setScalar(disc.mini ? 0.62 : 1);
      const position = lerpV(disc.previous, disc.position, alpha);
      object.position.set(position.x, 0, position.y);
      object.children[0].position.y = disc.state === 'dropped' ? 0.12 : 0.78;
      object.children[0].rotation.y = disc.state === 'dropped' ? 0 : simulationTime * 28;
      object.children[0].rotation.z =
        disc.state === 'dropped' ? 0.1 : Math.sin(simulationTime * 10) * 0.12;
      object.children[0].scale.setScalar(
        disc.explosive ? 1 + Math.sin(simulationTime * 30) * (1 - disc.fuse / 1.5) * 0.15 : 1,
      );
    }
    const liveDiscs = new Set(state.discs.map((d) => d.id));
    for (const [id, object] of this.discs)
      if (!liveDiscs.has(id)) {
        this.releaseDisc(object);
        this.discs.delete(id);
      }
    for (const pickup of state.pickups) {
      let object = this.pickups.get(pickup.id);
      if (!object) {
        object = createPickup(pickup);
        this.pickups.set(pickup.id, object);
        this.scene.add(object);
      }
      object.children[0].position.y = Math.sin(simulationTime * 2.7 + pickup.id) * 0.12;
      object.children[0].rotation.y = simulationTime * 0.8;
      object.scale.setScalar(Math.min(1, pickup.age * 3));
    }
    const livePickups = new Set(state.pickups.map((p) => p.id));
    for (const [id, object] of this.pickups)
      if (!livePickups.has(id)) {
        this.scene.remove(object);
        disposeVisual(object);
        this.pickups.delete(id);
      }
    for (let i = 0; i < this.arena.flags.length; i++)
      this.arena.flags[i].rotation.y = Math.sin(simulationTime * 1.5 + i) * 0.15;
    for (const [id, group] of this.arena.portals) {
      group.children[0].rotation.z = simulationTime * 0.7 + id.length;
      group.children[0].scale.setScalar(1 + Math.sin(simulationTime * 3) * 0.045);
    }
    (this.arena.water.material as THREE.MeshStandardMaterial).roughness =
      0.28 + Math.sin(simulationTime * 0.5) * 0.04;
    this.boundary.update(state, menu);
    this.effects.update(
      menu ? dt : Math.max(0, Math.min(0.1, state.time - this.previousTime)),
      state,
    );
    this.weapons.update(state, alpha);
    this.powers.update(state);
    this.previousTime = state.time;

    // A narrow perspective lens keeps the tabletop look while preserving depth.
    const aspect = this.width / this.height;
    const scale = Math.max(1, 1.65 / aspect) * (menu ? 1 : presentation.cameraScale);
    const menuOffset = menu && aspect > 1.4 ? -2.1 : 0;
    this.cameraTarget.x += (menuOffset - this.cameraTarget.x) * Math.min(1, dt * 3);
    this.camera.position.set(this.cameraTarget.x, 26 * scale, 27 * scale);
    if (this.effects.shake > 0) {
      this.camera.position.x += Math.sin(simulationTime * 87) * this.effects.shake;
      this.camera.position.z += Math.cos(simulationTime * 71) * this.effects.shake;
    }
    this.camera.lookAt(this.cameraTarget.x, 0, 0);
    this.renderer.render(this.scene, this.camera);
  }

  stats(): { calls: number; triangles: number; geometries: number; textures: number } {
    return {
      calls: this.renderer.info.render.calls,
      triangles: this.renderer.info.render.triangles,
      geometries: this.renderer.info.memory.geometries,
      textures: this.renderer.info.memory.textures,
    };
  }

  dispose(): void {
    this.resizeObserver.disconnect();
    this.effects.dispose();
    this.weapons.dispose();
    this.powers.dispose();
    for (const view of this.decoys.values()) this.scene.remove(view.root);
    this.decoys.clear();
    this.boundary.dispose();
    disposeVisual(this.scene);
    this.renderer.dispose();
    this.canvas.remove();
  }
}
