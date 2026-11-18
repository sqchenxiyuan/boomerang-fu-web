import * as THREE from 'three';
import { NATIVE, RULES } from '../core/config';
import { lerpV } from '../core/math';
import type { Actor } from '../core/types';
import { box, cylinder, makeBoomerang, material, place, shadow, sphere } from './palette';
import { createDeathModel, type DeathModel } from './death-models';
import { sampleDeathPose, sampleFallPose } from './death-visuals';
import { boundaryWarning } from '../core/feedback';
import { meleeAge, sampleMeleePose } from './melee-pose';
import { actorIdentity, type ActorIdentity } from '../agents/registry';
import { lookPalette } from '../agents/look';
import { defaultLook } from '../agents/defaults';
import { createAgentBody } from './agent-model';
import { sampleCharacterPose, type MotionContext } from './character-motion';
import { advanceAnimation, createAnimation, type CharacterAnimation } from './character-animation';

/**
 * TiltActorTowardsCamera and BODY_OFFSET from the reference character view. The
 * reference applies Rx(−25°) with +Z up and the camera to the south, so the top
 * leans back (north, away from the lens) and the front turns toward the camera;
 * the body itself shifts 0.4 Unity units south, toward the camera.
 */
export const CAMERA_TILT = (-25 * Math.PI) / 180;
export const BODY_OFFSET = 0.4 * NATIVE.scale;
const TAU = Math.PI * 2;

export interface CharacterView {
  root: THREE.Group;
  /** TiltActorTowardsCamera frame for the body, floating hands, feet and attachments. */
  lean?: THREE.Group;
  /** Clip playback (Godot OriginalCharacterPreview); owned by this view. */
  animation?: CharacterAnimation;
  /** Facing at the previous and current simulated tick, for lerp_angle. */
  turn?: { tick: number; previous: number; current: number };
  /** Facing-only frame for the floating hands and feet (no body squash). */
  rig?: THREE.Group;
  body: THREE.Group;
  leftArm: THREE.Group;
  rightArm: THREE.Group;
  feet: THREE.Group[];
  weapon: THREE.Group;
  shield: THREE.Mesh;
  aim: THREE.Group;
  ring: THREE.Mesh;
  label: THREE.Sprite;
  shadow: THREE.Mesh;
  death: DeathModel;
  leftWeapon?: THREE.Group;
  /** The holder's colour; held boomerangs wear it like the ones they throw. */
  playerColor?: string;
  weaponTint?: string;
  disguise?: THREE.Group;
  iceBlock?: THREE.Mesh;
  hands?: THREE.Group[];
  limbs?: THREE.Mesh[];
}

function makeLabel(text: string, color: string): THREE.Sprite {
  const canvas = document.createElement('canvas');
  canvas.width = 256;
  canvas.height = 80;
  const ctx = canvas.getContext('2d')!;
  ctx.font = '600 28px "Microsoft YaHei", sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillStyle = '#16362e';
  ctx.beginPath();
  ctx.roundRect(18, 8, 220, 60, 28);
  ctx.fill();
  ctx.fillStyle = color;
  ctx.fillText(text, 128, 39);
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  const sprite = new THREE.Sprite(
    new THREE.SpriteMaterial({ map: texture, depthTest: false, transparent: true }),
  );
  sprite.scale.set(1.65, 0.52, 1);
  sprite.position.y = 2.48;
  sprite.renderOrder = 10;
  return sprite;
}

/** Held boomerang size: close to a thrown one (1), so it reads beside the body. */
const HELD_SCALE = 0.9;
/** The colour the held boomerang will fly in (weapons-view discEffectColor). */
export function heldTint(actor: Actor, playerColor: string | undefined): string | undefined {
  const powers = actor.powers ?? [];
  if (powers.includes('ice')) return '#a5ebff';
  if (powers.includes('fire')) return '#ffbd69';
  if (powers.includes('teleport')) return '#c3a4ff';
  if (powers.includes('controlled')) return '#9dfff0';
  if (powers.includes('explosive')) return '#ffc189';
  return playerColor;
}
function tintBoomerang(group: THREE.Group | undefined, color: string): void {
  const body = group?.children[0];
  if (body instanceof THREE.Mesh) body.material = material(color);
}

export function createCharacter(
  actor: Actor,
  identity: ActorIdentity = actorIdentity(actor.id),
): CharacterView {
  // Every fighter is an agent: a custom one from the atelier, else a roster preset.
  const look = identity.look ?? defaultLook(actor.id),
    agentColors = lookPalette(look?.hue ?? identity.color);
  const root = new THREE.Group(),
    body = new THREE.Group(),
    rig = new THREE.Group();
  const groundShadow = shadow(0.66);
  // The reference leans the whole model back 25° so it faces the camera, and
  // offsets it by BODY_OFFSET (0.4 Unity units toward the camera); ground marks stay flat.
  const lean = new THREE.Group();
  lean.rotation.x = CAMERA_TILT;
  lean.position.z = BODY_OFFSET;
  lean.add(body, rig);
  root.add(lean, groundShadow);
  body.position.y = 0.72;
  if (look) body.add(createAgentBody(look));
  else body.add(box(0.8, 1.1, 0.5, identity.color));
  const arms: THREE.Group[] = [],
    hands: THREE.Group[] = [],
    limbs: THREE.Mesh[] = [];
  for (const side of [-1, 1]) {
    // Floating hands: no connecting limb is drawn; the hand hovers in the rig frame.
    const arm = new THREE.Group();
    place(arm, 0, 0, 0, rig);
    const limb = cylinder(0.075, 0.075, 1, agentColors.dark, 6);
    limb.visible = false;
    arm.add(limb);
    const hand = new THREE.Group();
    place(hand, side * 0.64, 0.6, 0.06, arm);
    const palm = sphere(0.15, agentColors.light);
    palm.scale.set(1, 0.92, 1.05);
    hand.add(palm);
    arm.add(hand);
    hands.push(hand);
    limbs.push(limb);
    arms.push(arm);
  }
  const feet: THREE.Group[] = [];
  for (const x of [-0.24, 0.24]) {
    const foot = new THREE.Group();
    place(foot, x, 0.16, 0, rig);
    const shoe = sphere(0.18, agentColors.dark);
    shoe.scale.set(0.85, 0.6, 1.25);
    foot.add(shoe);
    feet.push(foot);
  }
  // Held boomerangs read at a glance: thrown-size, out past the head's
  // silhouette, in the holder's colour (the pale default vanished on grass).
  const playerColor = look?.hue ?? identity.color;
  const weapon = makeBoomerang(playerColor);
  weapon.scale.setScalar(HELD_SCALE);
  weapon.rotation.z = 0.4;
  place(weapon, 0.2, -0.02, 0.12, hands[1]);
  const leftWeapon = makeBoomerang(playerColor);
  leftWeapon.scale.setScalar(HELD_SCALE);
  leftWeapon.rotation.z = -0.4;
  place(leftWeapon, -0.2, -0.02, 0.12, hands[0]);
  leftWeapon.visible = false;
  const disguise = new THREE.Group();
  place(box(1.1, 0.95, 0.95, '#b58a52'), 0, 0.48, 0, disguise);
  for (const x of [-0.38, 0.38]) place(box(0.1, 1, 1.02, '#d9b273'), x, 0.48, 0, disguise);
  place(box(1.15, 0.12, 1.02, '#dfba7a'), 0, 0.93, 0, disguise);
  disguise.visible = false;
  lean.add(disguise);
  const iceBlock = new THREE.Mesh(
    new THREE.IcosahedronGeometry(1.04, 0),
    new THREE.MeshStandardMaterial({
      color: '#b8efff',
      transparent: true,
      opacity: 0.38,
      roughness: 0.24,
      metalness: 0.05,
      depthWrite: false,
    }),
  );
  iceBlock.position.y = 0.78;
  iceBlock.scale.set(0.85, 1.1, 0.85);
  iceBlock.visible = false;
  lean.add(iceBlock);
  const shield = new THREE.Mesh(
    new THREE.IcosahedronGeometry(1.05, 2),
    new THREE.MeshPhysicalMaterial({
      color: '#9bfff1',
      transparent: true,
      opacity: 0.22,
      roughness: 0.1,
      metalness: 0,
      side: THREE.DoubleSide,
      depthWrite: false,
    }),
  );
  shield.position.y = 0.85;
  lean.add(shield);
  const ring = new THREE.Mesh(
    new THREE.RingGeometry(0.64, 0.72, 32),
    new THREE.MeshBasicMaterial({
      color: identity.color,
      transparent: true,
      opacity: 0.9,
      side: THREE.DoubleSide,
      depthWrite: false,
    }),
  );
  ring.rotation.x = -Math.PI / 2;
  ring.position.y = 0.035;
  root.add(ring);
  const aim = new THREE.Group();
  for (let i = 0; i < 7; i++) {
    const dot = new THREE.Mesh(
      new THREE.CircleGeometry(0.045 + i * 0.005, 8),
      new THREE.MeshBasicMaterial({ color: '#fff1b0', transparent: true, opacity: 0.85 }),
    );
    dot.rotation.x = -Math.PI / 2;
    place(dot, 0, 0.045, 0.95 + i * 0.37, aim);
  }
  root.add(aim);
  const label = makeLabel(
    actor.controller === 'human' ? `${actor.humanIndex + 1}P · ${identity.name}` : identity.name,
    identity.color,
  );
  root.add(label);
  const death = createDeathModel(actor, identity);
  root.add(death.root);
  return {
    root,
    lean,
    animation: createAnimation(),
    rig,
    body,
    leftArm: arms[0],
    rightArm: arms[1],
    feet,
    weapon,
    shield,
    aim,
    ring,
    label,
    shadow: groundShadow,
    death,
    leftWeapon,
    playerColor,
    weaponTint: playerColor,
    disguise,
    iceBlock,
    hands,
    limbs,
  };
}

function applyJoint(
  object: THREE.Object3D,
  j: { x: number; y: number; z: number; yaw: number; pitch: number; roll: number; scale: number },
): void {
  object.position.set(j.x, j.y, j.z);
  object.rotation.set(j.pitch, j.yaw, j.roll, 'YXZ');
  object.scale.setScalar(j.scale);
}

export interface CharacterFrame {
  /** Scaled game seconds since the previous rendered frame (0 while paused or frozen). */
  delta: number;
  /** Changes once per simulated tick (the simulation clock). */
  tick: number;
  /** Simulation step length of the latest tick, for move_speed_parameter. */
  tickDt?: number;
}

const yawOf = (actor: Actor): number => Math.atan2(actor.facing.x, actor.facing.y);
/** Godot lerp_angle: the shortest way round. */
export function lerpAngle(from: number, to: number, t: number): number {
  const difference = ((((to - from) % TAU) + TAU * 1.5) % TAU) - Math.PI;
  return from + difference * t;
}

export function updateCharacter(
  view: CharacterView,
  actor: Actor,
  alpha: number,
  time: number,
  frame: CharacterFrame = { delta: 0, tick: time },
  motion: MotionContext = {},
): void {
  // Position and facing both interpolate between the last two simulated ticks.
  const pos = lerpV(actor.previous, actor.position, alpha);
  view.root.position.set(pos.x, 0, pos.y);
  const yaw = yawOf(actor);
  const turn = (view.turn ??= { tick: frame.tick, previous: yaw, current: yaw });
  if (turn.tick !== frame.tick) {
    turn.previous = turn.current;
    turn.tick = frame.tick;
  }
  turn.current = yaw;
  const facing = lerpAngle(turn.previous, turn.current, alpha);
  const animation = (view.animation ??= createAnimation());
  advanceAnimation(animation, actor, frame.delta, frame.tickDt);
  const pose = sampleCharacterPose(actor, animation, motion, alpha);
  const b = pose.body;
  // The body moves in the facing frame; its squash never reaches the hands.
  view.body.position.set(
    b.x * Math.cos(facing) + b.z * Math.sin(facing),
    b.y,
    -b.x * Math.sin(facing) + b.z * Math.cos(facing),
  );
  view.body.rotation.set(b.pitch, facing + b.yaw, b.roll, 'YXZ');
  view.body.scale.set(b.sx, b.sy, b.sz);
  const rig = view.rig;
  if (rig) {
    rig.position.set(0, 0, 0);
    rig.scale.setScalar(1);
    rig.rotation.set(0, facing, 0);
    view.hands?.forEach((hand, i) => applyJoint(hand, pose.hands[i]));
    view.feet.forEach((foot, i) => {
      applyJoint(foot, pose.feet[i]);
      foot.rotation.y = 0;
    });
  }
  const age = meleeAge(actor, alpha);
  const meleeWeight = age === null ? 0 : sampleMeleePose(age, actor.attackArmed).weight;
  view.weapon.rotation.z = 0.4 * (1 - meleeWeight);
  view.weapon.visible = actor.armed && actor.alive;
  const tint = heldTint(actor, view.playerColor);
  if (tint && tint !== view.weaponTint) {
    for (const held of [view.weapon, view.leftWeapon]) tintBoomerang(held, tint);
    view.weaponTint = tint;
  }
  if (view.leftWeapon)
    view.leftWeapon.visible = actor.alive && (actor.heldDiscs ?? (actor.armed ? 1 : 0)) > 1;
  view.shield.visible = actor.shield && actor.alive;
  view.shield.scale.setScalar(1 + Math.sin(time * 4) * 0.025);
  view.aim.visible = actor.charge > 0.1 && actor.alive;
  view.aim.rotation.y = facing;
  view.aim.scale.z = 0.7 + (actor.charge / RULES.chargeTime) * 0.8;
  view.ring.visible = actor.alive;
  view.label.visible = actor.alive;
  view.body.visible = actor.alive;
  view.death.root.visible = !actor.alive && !!actor.death;
  view.shadow.visible = actor.alive && !actor.fall;
  view.feet.forEach((foot) => {
    foot.visible = actor.alive;
  });
  // The floating hands go with the body: a dead fighter (sunk, sliced, burnt)
  // must not leave two spheres behind, e.g. bobbing on the water.
  view.hands?.forEach((hand) => {
    hand.visible = actor.alive;
  });
  if (!actor.alive && actor.death) {
    const pose = sampleDeathPose(actor.death, time);
    const model = view.death;
    model.root.position.set(actor.death.position.x - pos.x, 0, actor.death.position.y - pos.y);
    model.stump.visible = actor.death.variant === 'slice' && pose.baseVisible;
    model.squash.visible = actor.death.variant === 'squash' && pose.baseVisible;
    model.piece.visible = pose.pieceVisible;
    for (const base of [model.stump, model.squash]) {
      base.position.set(0, pose.baseHeight, 0);
      base.rotation.set(pose.baseTilt, facing, 0, 'YXZ');
      base.scale.set(pose.baseScale.x, pose.baseScale.y, pose.baseScale.z);
    }
    model.piece.position.set(pose.piece.x, pose.piece.y, pose.piece.z);
    const spinAxis = new THREE.Vector3(actor.death.direction.y, 0, -actor.death.direction.x);
    if (spinAxis.lengthSq() < 0.00001) spinAxis.set(1, 0, 0);
    model.piece.quaternion.setFromAxisAngle(spinAxis.normalize(), pose.piece.spin);
    model.piece.quaternion.multiply(
      new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), facing),
    );
  }
  if (actor.alive && actor.fall) {
    const pose = sampleFallPose(actor.fall);
    view.body.position.y += pose.height;
    view.body.rotation.z += pose.tilt;
    view.body.scale.multiplyScalar(pose.scale);
    if (view.rig) {
      view.rig.position.y = pose.height;
      view.rig.scale.setScalar(pose.scale);
    }
    view.ring.visible = false;
    view.aim.visible = false;
  }
  if (actor.alive && actor.invulnerable > 0) view.body.visible = Math.floor(time * 24) % 2 === 0;
  const warning = boundaryWarning(actor);
  if (actor.alive && warning.visible) view.body.visible &&= warning.pulse < 0.88;
  if (view.iceBlock) view.iceBlock.visible = actor.alive && (actor.frozenTime ?? 0) > 0;
  if (view.disguise) view.disguise.visible = actor.alive && !!actor.disguised;
  if (actor.alive && actor.disguised) {
    view.body.visible = false;
    view.feet.forEach((foot) => {
      foot.visible = false;
    });
    // Hands too: floating hands beside a crate would give the disguise away.
    view.hands?.forEach((hand) => {
      hand.visible = false;
    });
    view.weapon.visible = false;
    if (view.leftWeapon) view.leftWeapon.visible = false;
    view.label.visible = false;
    view.aim.visible = false;
  }
}
