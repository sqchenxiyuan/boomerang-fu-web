import * as THREE from 'three';
import { ROSTER, RULES } from '../core/config';
import { lerpV } from '../core/math';
import type { Actor } from '../core/types';
import { box, cylinder, makeBoomerang, material, mesh, place, shadow, sphere } from './palette';
import { createDeathModel, type DeathModel } from './death-models';
import { sampleDeathPose, sampleFallPose } from './death-visuals';
import { boundaryWarning } from '../core/feedback';
import { meleeAge, sampleMeleePose } from './melee-pose';
import { actorIdentity, type ActorIdentity } from '../agents/registry';
import { lookPalette } from '../agents/look';
import { createAgentBody } from './agent-model';
import { sampleCharacterPose, type MotionContext } from './character-motion';
import { OVERLAY_LAYER } from './pixel-pass';

export interface CharacterView {
  root: THREE.Group;
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
  sprite.layers.set(OVERLAY_LAYER);
  return sprite;
}

export function createCharacter(
  actor: Actor,
  identity: ActorIdentity = actorIdentity(actor.id),
): CharacterView {
  const profile = ROSTER[actor.id];
  // A custom agent (presentation only) replaces the fruit body, face and colours.
  const look = identity.look,
    agentColors = look ? lookPalette(look.hue) : null;
  const root = new THREE.Group(),
    body = new THREE.Group(),
    rig = new THREE.Group();
  const groundShadow = shadow(0.66);
  root.add(body, rig, groundShadow);
  body.position.y = 0.72;
  if (look) {
    body.add(createAgentBody(look));
  } else if (profile.kind === 'melon') {
    const shape = new THREE.Shape();
    shape.moveTo(-0.7, -0.27);
    shape.lineTo(0, 0.92);
    shape.lineTo(0.7, -0.27);
    shape.quadraticCurveTo(0, -0.8, -0.7, -0.27);
    const rind = mesh(
      new THREE.ExtrudeGeometry(shape, {
        depth: 0.44,
        bevelEnabled: true,
        bevelSegments: 1,
        bevelSize: 0.07,
        bevelThickness: 0.05,
      }),
      '#418f65',
    );
    rind.position.z = -0.22;
    body.add(rind);
    const faceShape = new THREE.Shape();
    faceShape.moveTo(-0.56, -0.21);
    faceShape.lineTo(0, 0.76);
    faceShape.lineTo(0.56, -0.21);
    faceShape.quadraticCurveTo(0, -0.62, -0.56, -0.21);
    const flesh = mesh(new THREE.ShapeGeometry(faceShape), '#ef8078');
    flesh.position.z = 0.279;
    body.add(flesh);
    const backFlesh = mesh(new THREE.ShapeGeometry(faceShape), '#e97f78');
    backFlesh.rotation.y = Math.PI;
    backFlesh.position.z = -0.28;
    body.add(backFlesh);
    const rindLine = new THREE.Mesh(
      new THREE.TorusGeometry(0.59, 0.04, 4, 18, Math.PI * 0.72),
      material('#deedb8'),
    );
    rindLine.rotation.z = Math.PI * 1.14;
    rindLine.position.set(0, 0.05, 0.289);
    body.add(rindLine);
    for (const [x, y] of [
      [0, 0.5],
      [-0.28, 0.09],
      [0.28, 0.09],
      [-0.25, -0.27],
      [0.25, -0.27],
    ]) {
      const seed = sphere(0.036, '#563d35');
      seed.scale.y = 1.7;
      place(seed, x, y, 0.296, body);
    }
    for (const [x, y] of [
      [0, 0.5],
      [-0.22, 0.07],
      [0.22, 0.07],
      [-0.2, -0.27],
      [0.2, -0.27],
    ]) {
      const seed = sphere(0.036, '#563d35');
      seed.scale.y = 1.7;
      place(seed, x, y, -0.296, body);
    }
  } else if (profile.kind === 'eggplant') {
    const egg = sphere(0.63, '#8b66b2', 2);
    egg.scale.set(0.8, 1.25, 0.77);
    body.add(egg);
    const cap = sphere(0.31, '#5b9a65', 0);
    cap.scale.set(1.2, 0.4, 1.2);
    place(cap, 0, 0.68, 0, body);
    const stem = cylinder(0.07, 0.12, 0.38, '#497955', 6);
    stem.rotation.z = -0.3;
    place(stem, 0.05, 0.87, 0, body);
    for (let i = 0; i < 5; i++) {
      const leaf = mesh(new THREE.ConeGeometry(0.13, 0.45, 3), '#6ca069');
      leaf.rotation.z = Math.PI * 0.8;
      leaf.rotation.y = (i * Math.PI * 2) / 5;
      place(leaf, Math.sin(i * 1.25) * 0.21, 0.57, Math.cos(i * 1.25) * 0.21, body);
    }
  } else if (profile.kind === 'orange') {
    body.add(sphere(0.62, '#f3af4b', 2));
    const stem = cylinder(0.055, 0.08, 0.22, '#7c7643', 5);
    place(stem, 0, 0.64, 0, body);
    const leaf = sphere(0.22, '#5c9861', 0);
    leaf.scale.set(1.7, 0.25, 0.7);
    leaf.rotation.z = 0.4;
    place(leaf, 0.2, 0.65, 0, body);
  } else {
    body.add(box(0.88, 1.16, 0.64, '#e9f0df'));
    place(box(0.9, 0.4, 0.66, '#83bbd4'), 0, -0.32, 0, body);
    const roof = cylinder(0, 0.64, 0.38, '#a7cfe0', 4);
    roof.rotation.y = Math.PI / 4;
    roof.scale.z = 0.72;
    place(roof, 0, 0.75, 0, body);
    const emblem = sphere(0.12, '#569fbc');
    emblem.scale.z = 0.1;
    place(emblem, 0, -0.28, 0.34, body);
  }
  const faceZ =
    profile.kind === 'melon'
      ? 0.31
      : profile.kind === 'milk'
        ? 0.34
        : profile.kind === 'eggplant'
          ? 0.49
          : 0.59;
  for (const x of look ? [] : [-0.18, 0.18]) {
    const eye = sphere(0.07, '#203e37', 1);
    eye.scale.set(0.8, 1.25, 0.5);
    place(eye, x, 0.13, faceZ, body);
    place(sphere(0.018, '#fff7dd'), x + 0.015, 0.16, faceZ + 0.035, body);
    const blush = sphere(0.08, profile.kind === 'eggplant' ? '#c795bf' : '#e8a390');
    blush.scale.set(1.2, 0.5, 0.1);
    place(blush, x * 1.7, 0.015, faceZ - 0.01, body);
  }
  if (!look) {
    const smile = new THREE.Mesh(
      new THREE.TorusGeometry(0.075, 0.014, 4, 12, Math.PI),
      material('#34443a'),
    );
    smile.rotation.z = Math.PI;
    place(smile, 0, 0.025, faceZ + 0.015, body);
  }
  const arms: THREE.Group[] = [],
    hands: THREE.Group[] = [],
    limbs: THREE.Mesh[] = [];
  for (const side of [-1, 1]) {
    // Floating hands: no connecting limb is drawn; the hand hovers in the rig frame.
    const arm = new THREE.Group();
    place(arm, 0, 0, 0, rig);
    const limb = cylinder(0.075, 0.075, 1, agentColors?.dark ?? '#344e3c', 6);
    limb.visible = false;
    arm.add(limb);
    const hand = new THREE.Group();
    place(hand, side * 0.64, 0.6, 0.06, arm);
    const palm = sphere(0.15, agentColors?.light ?? '#fff0ca');
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
    const shoe = sphere(0.18, agentColors?.dark ?? '#314b3c');
    shoe.scale.set(0.85, 0.6, 1.25);
    foot.add(shoe);
    feet.push(foot);
  }
  const weapon = makeBoomerang();
  weapon.scale.setScalar(0.62);
  weapon.rotation.z = 0.4;
  place(weapon, 0.06, -0.025, 0.08, hands[1]);
  const leftWeapon = makeBoomerang();
  leftWeapon.scale.setScalar(0.62);
  leftWeapon.rotation.z = -0.4;
  place(leftWeapon, -0.06, -0.025, 0.08, hands[0]);
  leftWeapon.visible = false;
  const disguise = new THREE.Group();
  place(box(1.1, 0.95, 0.95, '#b58a52'), 0, 0.48, 0, disguise);
  for (const x of [-0.38, 0.38]) place(box(0.1, 1, 1.02, '#d9b273'), x, 0.48, 0, disguise);
  place(box(1.15, 0.12, 1.02, '#dfba7a'), 0, 0.93, 0, disguise);
  disguise.visible = false;
  root.add(disguise);
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
  root.add(iceBlock);
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
  root.add(shield);
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

export function updateCharacter(
  view: CharacterView,
  actor: Actor,
  alpha: number,
  time: number,
  motion: MotionContext = {},
): void {
  const pos = lerpV(actor.previous, actor.position, alpha);
  view.root.position.set(pos.x, 0, pos.y);
  const facing = Math.atan2(actor.facing.x, actor.facing.y);
  const pose = sampleCharacterPose(actor, time, motion, alpha);
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
    view.weapon.visible = false;
    if (view.leftWeapon) view.leftWeapon.visible = false;
    view.label.visible = false;
    view.aim.visible = false;
  }
}
