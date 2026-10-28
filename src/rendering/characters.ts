import * as THREE from 'three';
import { ROSTER, RULES } from '../core/config';
import { length, lerpV } from '../core/math';
import type { Actor } from '../core/types';
import { box, cylinder, makeBoomerang, material, mesh, place, shadow, sphere } from './palette';
import { createDeathModel, type DeathModel } from './death-models';
import { sampleDeathPose, sampleFallPose } from './death-visuals';
import { boundaryWarning } from '../core/feedback';
import { meleeAge, sampleMeleePose } from './melee-pose';

export interface CharacterView {
  root: THREE.Group;
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
  return sprite;
}

export function createCharacter(actor: Actor): CharacterView {
  const profile = ROSTER[actor.id];
  const root = new THREE.Group(),
    body = new THREE.Group();
  const groundShadow = shadow(0.66);
  root.add(body, groundShadow);
  body.position.y = 0.72;
  if (profile.kind === 'melon') {
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
  for (const x of [-0.18, 0.18]) {
    const eye = sphere(0.07, '#203e37', 1);
    eye.scale.set(0.8, 1.25, 0.5);
    place(eye, x, 0.13, faceZ, body);
    place(sphere(0.018, '#fff7dd'), x + 0.015, 0.16, faceZ + 0.035, body);
    const blush = sphere(0.08, profile.kind === 'eggplant' ? '#c795bf' : '#e8a390');
    blush.scale.set(1.2, 0.5, 0.1);
    place(blush, x * 1.7, 0.015, faceZ - 0.01, body);
  }
  const smile = new THREE.Mesh(
    new THREE.TorusGeometry(0.075, 0.014, 4, 12, Math.PI),
    material('#34443a'),
  );
  smile.rotation.z = Math.PI;
  place(smile, 0, 0.025, faceZ + 0.015, body);
  const arms: THREE.Group[] = [],
    hands: THREE.Group[] = [],
    limbs: THREE.Mesh[] = [];
  for (const side of [-1, 1]) {
    const arm = new THREE.Group();
    place(arm, side * 0.58, -0.08, 0, body);
    const limb = cylinder(0.075, 0.075, 1, '#344e3c', 6);
    arm.add(limb);
    const hand = new THREE.Group();
    hand.add(sphere(0.12, '#fff0ca'));
    arm.add(hand);
    hands.push(hand);
    limbs.push(limb);
    arms.push(arm);
  }
  const feet: THREE.Group[] = [];
  for (const x of [-0.24, 0.24]) {
    const foot = new THREE.Group();
    place(foot, x, 0.16, 0, root);
    const shoe = sphere(0.18, '#314b3c');
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
      color: profile.color,
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
    actor.controller === 'human' ? `${actor.humanIndex + 1}P · ${profile.name}` : profile.name,
    profile.color,
  );
  root.add(label);
  const death = createDeathModel(actor);
  root.add(death.root);
  return {
    root,
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

const armAxis = new THREE.Vector3(0, 1, 0),
  armDirection = new THREE.Vector3();
function poseHand(
  view: CharacterView,
  index: number,
  x: number,
  y: number,
  z: number,
  yaw: number,
): void {
  if (!view.hands || !view.limbs) return;
  const arm = index === 0 ? view.leftArm : view.rightArm;
  const hand = view.hands[index],
    limb = view.limbs[index];
  arm.rotation.set(0, 0, 0);
  hand.position.set(x - arm.position.x, y - arm.position.y, z - arm.position.z);
  hand.rotation.set(0, yaw, 0);
  armDirection.copy(hand.position);
  const reach = armDirection.length();
  limb.position.copy(armDirection).multiplyScalar(0.5);
  limb.scale.set(1, reach, 1);
  limb.quaternion.setFromUnitVectors(armAxis, armDirection.normalize());
}

export function updateCharacter(
  view: CharacterView,
  actor: Actor,
  alpha: number,
  time: number,
): void {
  const pos = lerpV(actor.previous, actor.position, alpha);
  view.root.position.set(pos.x, 0, pos.y);
  const facing = Math.atan2(actor.facing.x, actor.facing.y);
  view.body.rotation.set(0, facing, 0);
  const speed = length(actor.velocity);
  const cycle = time * (actor.powers.includes('haste') ? 20 : 16) + actor.id;
  view.body.position.y = 0.82 + (actor.alive ? Math.sin(cycle) * Math.min(0.06, speed * 0.012) : 0);
  view.body.rotation.z = Math.sin(cycle / 2) * Math.min(0.07, speed * 0.01);
  const age = meleeAge(actor, alpha);
  const melee = age === null ? null : sampleMeleePose(age, actor.attackArmed);
  const squash = actor.dashTime > 0 ? 0.82 : (melee?.stretch ?? 1);
  view.body.scale.set(1 / Math.sqrt(squash), squash, 1 / Math.sqrt(squash));
  const twist = melee?.twist ?? 0;
  view.body.rotation.order = 'YXZ';
  view.body.rotation.y += twist;
  view.body.rotation.x = melee?.lean ?? 0;
  view.body.position.x = actor.facing.x * (melee?.step ?? 0) * 0.3;
  view.body.position.z = actor.facing.y * (melee?.step ?? 0) * 0.3;
  view.body.position.y += melee?.height ?? 0;
  view.feet.forEach((foot, i) => {
    foot.position.y =
      0.16 + Math.max(0, Math.sin(cycle + i * Math.PI)) * Math.min(speed * 0.025, 0.15);
    foot.rotation.y = facing;
    const side = i === 0 ? -1 : 1;
    const stride = (melee?.step ?? 0) * (i === 0 ? 1 : -0.45);
    foot.position.x = side * 0.24 * Math.cos(facing) + stride * actor.facing.x;
    foot.position.z = -side * 0.24 * Math.sin(facing) + stride * actor.facing.y;
  });
  const swing = Math.sin(cycle) * Math.min(speed * 0.025, 0.12);
  let handX = 0.72,
    handY = actor.charge > 0 ? 0.1 : -0.24,
    handZ = actor.charge > 0 ? -0.22 : swing;
  let handYaw = 0;
  if (melee) {
    const w = melee.weight;
    const x = melee.handX * Math.cos(twist) - melee.handZ * Math.sin(twist);
    const z = melee.handX * Math.sin(twist) + melee.handZ * Math.cos(twist);
    handX += (x - handX) * w;
    handY += (melee.handY - handY) * w;
    handZ += (z - handZ) * w;
    handYaw = (melee.angle + Math.PI / 2 - twist) * w;
  }
  poseHand(view, 1, handX, handY, handZ, handYaw);
  poseHand(
    view,
    0,
    -0.72 + (melee?.weight ?? 0) * 0.24,
    -0.24 + (melee?.weight ?? 0) * 0.26,
    -swing + (melee?.weight ?? 0) * 0.34,
    0,
  );
  view.weapon.rotation.z = 0.4 * (1 - (melee?.weight ?? 0));
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
    view.feet.forEach((foot) => {
      foot.position.y += pose.height;
    });
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
