import * as THREE from 'three';
import { POWERUPS, RULES } from '../core/config';
import { introPose, transitionPresentation } from '../core/presentation';
import { lerpV } from '../core/math';
import type { Arena, GameEvent, GameState, Pickup } from '../core/types';
import { createArenaView } from './arena-view';
import type { ArenaView } from './arena-view';
import { flashOriginalGate, mergeOriginalStatics, updateOriginalArena } from './original-arena';
import {
  arenaCameraDistance,
  arenaCameraFootprint,
  arenaCameraFrame,
  ORIGINAL_CAMERA_UP,
  ORIGINAL_CAMERA_BACK,
} from './arena-camera';
import type { ArenaCameraFrame } from './arena-camera';
import { CameraRig } from './camera-rig';
import { createCharacter, updateCharacter } from './characters';
import { THROW_FOLLOW } from './character-motion';
import type { CharacterView } from './characters';
import { voxelizeMesh, voxelizeStatic, voxelizeTree } from './voxelize';
import { pixelOverlayGeometry, setSurfacePixel, setSurfaceTime } from './surfaces';
import type { PortalFx } from './portal-visuals';

export type VisualStyle = 'standard' | 'pixel';
/** Voxel edge in world units: scenery, and small props (hands, discs, pickups). */
const ARENA_VOXEL = 0.1;
const PART_VOXEL = 0.05;
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
    lean: source.lean && copy(source.lean),
    // A decoy plays its own clips and turns on its own.
    animation: undefined,
    turn: undefined,
    body: copy(source.body),
    rig: source.rig && copy(source.rig),
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

function buildArena(state: GameState, pixel = false, aspect = 16 / 9): ArenaView {
  const arena = createArenaView(state.arena);
  if (state.arena.floors) {
    mergeOriginalStatics(arena, state.arena);
    if (pixel) pixelateArena(arena, state.arena, aspect);
    return arena;
  }
  const animated = new Set<THREE.Object3D>([
    arena.water,
    ...arena.flags,
    ...arena.portals.values(),
    ...arena.obstacles.values(),
    ...arena.floors.values(),
    ...arena.mechanisms.values(),
  ]);
  mergeStaticMeshes(arena.root, animated);
  for (const obstacle of arena.obstacles.values()) mergeStaticMeshes(obstacle);
  if (pixel) pixelateArena(arena, state.arena, aspect);
  return arena;
}

/**
 * Pixel style: immutable scenery becomes one world-aligned voxel mesh, every
 * movable floor, wall, gate and switch is voxelised in place (so mechanisms,
 * tints and visibility keep working), plants share one voxel bush. Ground and
 * water patterns snap to the voxel grid through `setSurfacePixel`.
 */
function pixelateArena(view: ArenaView, arena: Arena, aspect: number): void {
  const bounds = arenaCameraFootprint(arena, Math.max(16 / 9, aspect));
  // Full detail over the play area; the wider surroundings use coarser cubes.
  const frame = arenaCameraFrame(arena);
  const centre = arena.floors ? frame.center : { x: 0, y: 0 },
    half = arena.floors ? frame.half : { x: arena.halfWidth, y: arena.halfHeight };
  const detail = new THREE.Box3(
    new THREE.Vector3(centre.x - half.x - 2.5, -2, centre.y - half.y - 2.5),
    new THREE.Vector3(centre.x + half.x + 2.5, 8, centre.y + half.y + 2.5),
  );
  const exclude = new Set<THREE.Object3D>([view.water]);
  if (view.plants) {
    voxelizeMesh(view.plants.mesh, ARENA_VOXEL);
    exclude.add(view.plants.mesh);
  }
  if (arena.floors) {
    const fixed = view.root.getObjectByName('original-static-batches');
    if (fixed) {
      voxelizeStatic(fixed, ARENA_VOXEL, new Set(), { bounds, detail });
      exclude.add(fixed);
    }
  } else {
    const animated = [
      ...view.flags,
      ...view.portals.values(),
      ...view.obstacles.values(),
      ...view.floors.values(),
      ...view.mechanisms.values(),
    ];
    voxelizeStatic(view.root, ARENA_VOXEL, new Set([...exclude, ...animated]), {
      bounds,
      detail,
    });
  }
  voxelizeTree(view.root, ARENA_VOXEL, (object) => exclude.has(object));
  // Flat overlays (ice) become whole cells of the same grid, so their outline steps too.
  const overlays: THREE.Mesh[] = [];
  view.root.traverse((object) => {
    if (object instanceof THREE.Mesh && object.userData.pixelOverlay) overlays.push(object);
  });
  for (const mesh of overlays) {
    const geometry = pixelOverlayGeometry(mesh, ARENA_VOXEL);
    if (!geometry) continue;
    mesh.geometry.dispose();
    mesh.geometry = geometry;
  }
  // Round portal pads: eight-sided rings, like the effect rings.
  for (const group of view.portals.values()) {
    const ring = group.children[0];
    if (group.userData.gate || !(ring instanceof THREE.Mesh)) continue;
    const { innerRadius, outerRadius } = (ring.geometry as THREE.RingGeometry).parameters;
    ring.geometry.dispose();
    ring.geometry = new THREE.RingGeometry(innerRadius, outerRadius, 8);
  }
}

function disposeVisual(root: THREE.Object3D): void {
  root.traverse((object) => {
    if (object instanceof THREE.Mesh) {
      // Shared geometries (boomerang, cached voxel parts) outlive any one view.
      if (!object.geometry.userData.shared) object.geometry.dispose();
      const materials = Array.isArray(object.material) ? object.material : [object.material];
      for (const mat of materials) if (!mat.userData.shared) mat.dispose();
      if (object instanceof THREE.InstancedMesh) object.dispose();
    }
    if (object instanceof THREE.Sprite) {
      object.material.map?.dispose();
      object.material.dispose();
    }
    if (object instanceof THREE.Line || object instanceof THREE.Points) {
      object.geometry.dispose();
      const materials = Array.isArray(object.material) ? object.material : [object.material];
      for (const mat of materials) if (!mat.userData.shared) mat.dispose();
    }
  });
}

function createPickup(pickup: Pickup, pixel = false): THREE.Group {
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
  group.add(book, shadow(0.5, 0.12, pixel ? 8 : 24));
  const ring = new THREE.Mesh(
    new THREE.RingGeometry(0.4, 0.47, pixel ? 8 : 28),
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
  if (pixel) voxelizeTree(group, PART_VOXEL);
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
  /** Godot Camera3D framing: follow the live players, discs and safe area during play. */
  readonly cameraRig = new CameraRig();
  /** false keeps the whole arena framed (the pre-rig behaviour). */
  dynamicCamera = true;
  private followBlend = 0;
  private resizeObserver: ResizeObserver;
  private width = 1;
  private height = 1;
  private cameraTarget = new THREE.Vector3(0, 0, 0);
  private cameraFrame: ArenaCameraFrame;
  private sun: THREE.DirectionalLight;
  private arenaSource: string;
  private previousTime = 0;

  constructor(
    container: HTMLElement,
    state: GameState,
    options: { preserveDrawingBuffer?: boolean } = {},
  ) {
    this.renderer = new THREE.WebGLRenderer({
      antialias: true,
      alpha: false,
      powerPreference: 'high-performance',
      // An embedding page that copies the canvas outside our frame (MUNDI's
      // video recorder draws it into a 2D canvas on its own rAF) needs the
      // last frame kept; otherwise it reads an empty, black buffer.
      preserveDrawingBuffer: options.preserveDrawingBuffer ?? false,
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
    // Surface patterns are module-wide; a new renderer starts in the smooth style.
    setSurfacePixel(0);
    this.scene.background = new THREE.Color('#a7c8bb');
    this.scene.fog = new THREE.Fog('#a7c8bb', 60, 105);
    this.scene.add(new THREE.HemisphereLight('#fff8df', '#769f96', 1.9));
    const sun = (this.sun = new THREE.DirectionalLight('#fff0ca', 2.7));
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
    this.scene.add(sun, sun.target);
    this.arena = buildArena(state);
    this.cameraFrame = arenaCameraFrame(state.arena);
    if (state.arena.floors)
      this.cameraTarget.set(this.cameraFrame.center.x, 0, this.cameraFrame.center.y);
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
    this.cameraRig.reset();
    // Decoys borrow their owner's GPU assets; only the owner disposes them.
    for (const view of this.decoys.values()) this.scene.remove(view.root);
    this.decoys.clear();
    this.buildCharacters(state);
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

  private buildCharacters(state: GameState): void {
    for (const view of this.decoys.values()) this.scene.remove(view.root);
    this.decoys.clear();
    for (const view of this.characters.values()) {
      this.scene.remove(view.root);
      disposeVisual(view.root);
    }
    this.characters.clear();
    for (const actor of state.actors) {
      const view = createCharacter(actor);
      // Hands, feet, held boomerangs and death props; the agent body is already blocks.
      if (this.pixel) {
        voxelizeTree(view.root, PART_VOXEL);
        // The blob shadow is not a voxel model; give it eight sides like the rings.
        view.shadow.geometry.dispose();
        view.shadow.geometry = new THREE.CircleGeometry(0.66, 8);
      }
      this.characters.set(actor.id, view);
      this.scene.add(view.root);
    }
    this.rebuildCharacters = false;
  }

  private resize(width: number, height: number): void {
    this.width = Math.max(1, width);
    this.height = Math.max(1, height);
    this.renderer.setSize(this.width, this.height);
    this.camera.aspect = this.width / this.height;
    this.camera.updateProjectionMatrix();
  }

  /** A discontinuous replay seek clears transient effects without rebuilding same-round GPU assets. */
  seek(state: GameState): void {
    this.effects.clear();
    this.weapons.clear();
    this.powers.clear();
    this.boundary.reset();
    for (const gate of this.arena.portals.values()) gate.userData.flashUntil = 0;
    this.previousTime = state.time;
  }

  events(events: GameEvent[]): void {
    this.cameraRig.observe(events);
    for (const event of events) {
      this.effects.emit(event);
      this.weapons.observe(event);
      if (event.type === 'teleport') {
        flashOriginalGate(this.arena, event.position, this.previousTime);
        if (event.destination) flashOriginalGate(this.arena, event.destination, this.previousTime);
      }
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

  /**
   * @param dt real seconds since the previous frame (0 while paused)
   * @param rate simulation playback speed (0.25–8×), so clips follow game time
   */
  draw(
    state: GameState,
    alpha: number,
    elapsed: number,
    dt: number,
    menu: boolean,
    rate = 1,
  ): void {
    const simulationTime = menu ? elapsed : state.time;
    // A freeze frame holds the whole world: the reference stops its accumulator,
    // so nothing interpolates and clips do not advance.
    const frozen = !menu && state.hitStop > 0;
    if (frozen) alpha = 1;
    const frame = {
      delta: menu ? dt : frozen ? 0 : dt * rate * (state.clock?.timeScale ?? 1),
      tick: simulationTime,
      tickDt: RULES.dt * (state.clock?.timeScale ?? 1),
    };
    const arenaKey = `${state.arena.id ?? 'courtyard'}:${state.round}`;
    if (this.arenaSource !== arenaKey) {
      this.scene.remove(this.arena.root);
      disposeVisual(this.arena.root);
      this.arena = buildArena(state, this.pixel, this.width / this.height);
      this.cameraFrame = arenaCameraFrame(state.arena);
      this.cameraTarget.set(this.cameraFrame.center.x, 0, this.cameraFrame.center.y);
      this.scene.add(this.arena.root);
      this.arenaSource = arenaKey;
      this.effects.clear();
      this.weapons.clear();
      this.powers.clear();
      this.boundary.reset();
    }
    if (this.rebuildCharacters) this.buildCharacters(state);
    const presentation = transitionPresentation(state);
    if (state.arena.floors) updateOriginalArena(this.arena, state.arena, simulationTime, alpha);
    const entranceOrder = [...state.actors].sort((a, b) => b.score - a.score || a.id - b.id);
    // Throw follow-through is derived from the newest owned disc, so seeks agree.
    const throwAge = new Map<number, number>();
    for (const disc of state.discs)
      if (!disc.dead && !disc.mini && disc.ownerId >= 0 && disc.age < THROW_FOLLOW)
        throwAge.set(disc.ownerId, Math.min(throwAge.get(disc.ownerId) ?? Infinity, disc.age));
    for (const actor of state.actors) {
      const view = this.characters.get(actor.id);
      if (view) {
        updateCharacter(
          view,
          menu ? { ...actor, facing: { x: -0.15, y: 1 } } : actor,
          alpha,
          simulationTime,
          frame,
          { throwAge: throwAge.get(actor.id) ?? null },
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
        frame,
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
      if (object && !state.arena.floors) object.visible = !obstacle.broken && !obstacle.disabled;
    }
    for (const disc of state.discs) {
      let object = this.discs.get(disc.id);
      if (!object) {
        object = this.discPool.pop();
        if (!object) {
          object = new THREE.Group();
          object.add(makeBoomerang(), shadow(0.4, 0.13, this.pixel ? 8 : 24));
          if (this.pixel) voxelizeTree(object, PART_VOXEL);
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
        object = createPickup(pickup, this.pixel);
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
      if (group.userData.gate) continue;
      group.children[0].rotation.z = simulationTime * 0.7 + id.length;
      group.children[0].scale.setScalar(1 + Math.sin(simulationTime * 3) * 0.045);
      const fx = group.userData.portalFx as PortalFx | undefined;
      if (fx)
        fx.flash.value = Math.max(
          0,
          (Number(group.userData.flashUntil ?? 0) - simulationTime) / 0.5,
        );
    }
    setSurfaceTime(simulationTime);
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
    const original = state.arena.floors !== undefined;
    const distance = original
      ? arenaCameraDistance(this.cameraFrame, aspect)
      : Math.hypot(26, 27) * Math.max(1, 1.65 / aspect);
    const cameraUp = state.arena.floors ? ORIGINAL_CAMERA_UP : 26,
      cameraBack = state.arena.floors ? ORIGINAL_CAMERA_BACK : 27;
    // The rig frames a fraction of the full-arena view around its focus; fully
    // zoomed out it matches the fixed framing exactly.
    const follow = !menu && this.dynamicCamera;
    if (follow)
      this.cameraRig.update(state, {
        dt: dt * rate,
        scaledDt: frame.delta,
        frozen,
        aspect,
        alpha,
      });
    const zoom = follow ? this.cameraRig.ratio : 1;
    const scale =
      ((distance * zoom) / Math.hypot(cameraUp, cameraBack)) *
      (menu ? 1 : presentation.cameraScale);
    const fog = this.scene.fog as THREE.Fog;
    fog.near = original ? distance + 20 : 60;
    fog.far = original ? distance + 80 : 105;
    const menuOffset = menu && aspect > 1.4 ? -2.1 : 0;
    const center = original ? this.cameraFrame.center : { x: 0, y: 0 };
    if (follow) {
      // The rig already eases its focus (rate 5). Only blend for 0.5 s after the
      // fixed/menu framing hands over, then lock on so no second lag is added.
      this.followBlend = Math.min(1, this.followBlend + dt * 2);
      const k = this.followBlend < 1 ? Math.min(1, dt * 6) : 1;
      this.cameraTarget.x += (this.cameraRig.focus.x - this.cameraTarget.x) * k;
      this.cameraTarget.z += (this.cameraRig.focus.y - this.cameraTarget.z) * k;
    } else {
      this.followBlend = 0;
      this.cameraTarget.x += (center.x + menuOffset - this.cameraTarget.x) * Math.min(1, dt * 3);
      this.cameraTarget.z += (center.y - this.cameraTarget.z) * Math.min(1, dt * 3);
    }
    this.camera.position.set(
      this.cameraTarget.x,
      cameraUp * scale,
      this.cameraTarget.z + cameraBack * scale,
    );
    const far = Math.max(180, distance * 2);
    if (this.camera.far !== far) {
      this.camera.far = far;
      this.camera.updateProjectionMatrix();
    }
    const shadowSpan = original
      ? Math.max(this.cameraFrame.half.x, this.cameraFrame.half.y) * 1.5 + 4
      : 21;
    const shadowTop = original ? shadowSpan : 17;
    if (this.sun.shadow.camera.right !== shadowSpan || this.sun.shadow.camera.top !== shadowTop) {
      Object.assign(this.sun.shadow.camera, {
        left: -shadowSpan,
        right: shadowSpan,
        top: shadowTop,
        bottom: -shadowTop,
        far: original ? Math.max(70, shadowSpan * 4) : 70,
      });
      this.sun.shadow.camera.updateProjectionMatrix();
    }
    this.sun.position.set(
      center.x - 12,
      original ? Math.max(22, shadowSpan * 1.2) : 22,
      center.y + 8,
    );
    this.sun.target.position.set(center.x, 0, center.y);
    if (this.effects.shake > 0) {
      this.camera.position.x += Math.sin(simulationTime * 87) * this.effects.shake;
      this.camera.position.z += Math.cos(simulationTime * 71) * this.effects.shake;
    }
    this.camera.lookAt(this.cameraTarget.x, 0, this.cameraTarget.z);
    this.renderer.render(this.scene, this.camera);
  }

  private pixel = false;
  private rebuildCharacters = false;
  /** Rebuild every character model on the next frame (after agent looks change). */
  refreshAgents(): void {
    this.rebuildCharacters = true;
  }
  get visualStyle(): VisualStyle {
    return this.pixel ? 'pixel' : 'standard';
  }
  /** Pixel art swaps every model for its voxel version; the frame stays full resolution. */
  setVisualStyle(style: VisualStyle): void {
    const pixel = style === 'pixel';
    if (pixel === this.pixel) return;
    this.pixel = pixel;
    setSurfacePixel(pixel ? ARENA_VOXEL : 0);
    // Hard shadow edges suit the block look.
    this.renderer.shadowMap.type = pixel ? THREE.BasicShadowMap : THREE.PCFSoftShadowMap;
    this.renderer.shadowMap.needsUpdate = true;
    this.effects.setPixel(pixel);
    this.weapons.setPixel(pixel);
    this.powers.setPixel(pixel);
    // Rebuild every model with the new style on the next frame.
    this.arenaSource = '';
    this.rebuildCharacters = true;
    for (const group of [...this.discs.values(), ...this.discPool, ...this.pickups.values()]) {
      this.scene.remove(group);
      disposeVisual(group);
    }
    this.discs.clear();
    this.discPool = [];
    this.pickups.clear();
    this.scene.traverse((object) => {
      if (object instanceof THREE.Mesh)
        for (const mat of Array.isArray(object.material) ? object.material : [object.material])
          mat.needsUpdate = true;
    });
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
