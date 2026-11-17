import { describe, expect, it } from 'vitest';
import { RULES } from '../src/core/config';
import { idleCommand, type Actor } from '../src/core/types';
import { Game } from '../src/simulation/game';
import { defaultOptions, makeActor } from '../src/simulation/state';
import { BODY_HEIGHT, sampleCharacterPose } from '../src/rendering/character-motion';
import {
  CLIP_TIMING,
  IDLE_SPEED,
  advanceAnimation,
  clipTime,
  createAnimation,
  selectClip,
  updateMoveSpeed,
  type CharacterAnimation,
} from '../src/rendering/character-animation';
import * as THREE from 'three';
import { BODY_OFFSET, CAMERA_TILT, lerpAngle } from '../src/rendering/characters';

const actor = (patch: Partial<Actor> = {}): Actor => ({
  ...makeActor(0, 'bot', -1),
  armed: true,
  heldDiscs: 1,
  ...patch,
});
const walkingAt = (time: number): CharacterAnimation => ({
  ...createAnimation(),
  clip: 'walk',
  time,
  moveSpeed: 1,
});

/** A real actor after walking for a second in the simulation. */
function walkingActor(): Actor {
  const game = new Game({ ...defaultOptions(), mode: 'local', bots: 0, mapId: 'courtyard' });
  game.state.phase = 'playing';
  for (let i = 0; i < 60; i++)
    game.step(new Map([[0, { ...idleCommand(), move: { x: 1, y: 0 } }]]));
  return game.state.actors[0];
}

describe('clip playback (reference move_speed_parameter and set_clip)', () => {
  it('derives the walk speed from the pre-drag velocity like the reference', () => {
    const walker = walkingActor();
    const animation = createAnimation();
    updateMoveSpeed(animation, walker, RULES.dt);
    // Steady walk: (v + walk·dt)/11 with walk 200 and drag 11 ≈ 1.65.
    expect(animation.moveSpeed).toBeGreaterThan(1.55);
    expect(animation.moveSpeed).toBeLessThan(1.75);
    const crawl = actor({ velocity: { x: 0.5, y: 0 } });
    updateMoveSpeed(animation, crawl, RULES.dt);
    expect(animation.moveSpeed).toBe(0);
  });

  it('holds the parameter while dashing, stunned or frozen', () => {
    const animation = { ...createAnimation(), moveSpeed: 1.4 };
    for (const patch of [{ dashTime: 0.1 }, { stun: 0.3 }, { frozenTime: 1 }])
      updateMoveSpeed(animation, actor({ ...patch, velocity: { x: 0, y: 0 } }), RULES.dt);
    expect(animation.moveSpeed).toBe(1.4);
  });

  it('chooses clips in the reference order of precedence', () => {
    expect(selectClip(actor(), 0)).toBe('idle');
    expect(selectClip(actor(), 1)).toBe('walk');
    expect(selectClip(actor({ heldDiscs: 2 }), 1)).toBe('walk-two');
    expect(selectClip(actor({ armed: false }), 1)).toBe('walk-zero');
    expect(selectClip(actor({ frozenTime: 1 }), 1)).toBe('frozen');
    expect(selectClip(actor({ stun: 0.4, frozenTime: 1 }), 1)).toBe('stunned');
    expect(
      selectClip(actor({ stun: 0.4, fall: { kind: 'water', elapsed: 0, duration: 1 } }), 1),
    ).toBe('fall');
  });

  it('restarts a clip only when it changes, then plays at its own speed', () => {
    const animation = createAnimation();
    const idle = actor();
    advanceAnimation(animation, idle, 0.5);
    expect(animation.clip).toBe('idle');
    expect(animation.time).toBeCloseTo(0.5 * IDLE_SPEED, 9);
    const walker = walkingActor();
    advanceAnimation(animation, walker, 0.1);
    // Weapons are not granted yet in this setup, so it is the empty-handed walk.
    expect(animation.clip).toBe('walk-zero');
    // set_clip zeroes the time, then the same frame's advance() plays it on.
    expect(animation.time).toBeCloseTo(0.1 * animation.moveSpeed, 9);
    advanceAnimation(animation, walker, 0.1);
    expect(animation.time).toBeCloseTo(0.2 * animation.moveSpeed, 9);
    animation.time = CLIP_TIMING.walk.duration * 3 + 0.1;
    expect(clipTime(animation)).toBeCloseTo(0.1, 9);
  });

  it('keeps the walk phase continuous when the speed jitters (no twitching)', () => {
    // The old pose used time × speed: a 1% speed change at t = 30 s jumped the stride.
    const walker = walkingActor();
    const animation = { ...createAnimation(), clip: 'walk' as const, moveSpeed: 1.6, time: 0 };
    let previous = sampleCharacterPose(walker, animation);
    let worst = 0;
    for (let frame = 0; frame < 600; frame++) {
      const jitter = {
        ...walker,
        velocity: { x: walker.velocity.x * (1 + Math.sin(frame) * 0.04), y: 0 },
      };
      advanceAnimation(animation, jitter, 1 / 60);
      const pose = sampleCharacterPose(jitter, animation);
      worst = Math.max(
        worst,
        Math.abs(pose.body.y - previous.body.y),
        Math.abs(pose.hands[0].z - previous.hands[0].z),
        Math.abs(pose.feet[1].z - previous.feet[1].z),
      );
      previous = pose;
    }
    // A full-speed walk loop of 0.65 s at ×1.6 moves a hand at most ~0.2 units per frame.
    expect(worst).toBeLessThan(0.25);
  });
});

describe('procedural poses', () => {
  it('is a pure function of state and clip time', () => {
    const a = sampleCharacterPose(actor(), walkingAt(0.2));
    const b = sampleCharacterPose(actor(), walkingAt(0.2));
    expect(a).toEqual(b);
  });

  it('hops twice per walk loop and counter-swings the floating hands', () => {
    const idle = sampleCharacterPose(actor(), createAnimation());
    const frames = Array.from({ length: 40 }, (_, i) =>
      sampleCharacterPose(actor(), walkingAt((i / 40) * CLIP_TIMING.walk.duration)),
    );
    expect(Math.max(...frames.map((f) => f.body.y))).toBeGreaterThan(BODY_HEIGHT + 0.12);
    expect(frames[10].body.pitch).toBeGreaterThan(0.2);
    const swings = frames.map((f) => f.hands[0].z * f.hands[1].z);
    expect(Math.min(...swings)).toBeLessThan(0);
    expect(Math.abs(idle.hands[1].z - 0.06)).toBeLessThan(0.01);
    // Two footfalls per loop: the body touches down twice.
    const lows = frames.filter((f) => f.body.y < BODY_HEIGHT + 0.01).length;
    expect(lows).toBeGreaterThanOrEqual(2);
  });

  it('draws the weapon hand far back when charging and snaps through on release', () => {
    const charged = sampleCharacterPose(actor({ charge: RULES.chargeTime }), createAnimation());
    expect(charged.hands[1].z).toBeLessThan(-0.5);
    expect(charged.body.yaw).toBeGreaterThan(0.5);
    const follow = sampleCharacterPose(actor({ charge: 0 }), createAnimation(), {
      throwAge: 0.08,
    });
    expect(follow.hands[1].z).toBeGreaterThan(0.4);
  });

  it('stretches into a dash and wobbles while stunned', () => {
    const dash = sampleCharacterPose(
      actor({ dashTime: 0.15, velocity: { x: 0, y: 20 } }),
      walkingAt(0.1),
    );
    expect(dash.body.sz).toBeGreaterThan(1.2);
    expect(dash.hands[0].z).toBeLessThan(-0.4);
    const rolls = [0.1, 0.25, 0.4].map(
      (clock) =>
        sampleCharacterPose(actor({ stun: 0.5 }), { clip: 'stunned', time: clock, clock }).body
          .roll,
    );
    expect(Math.max(...rolls) - Math.min(...rolls)).toBeGreaterThan(0.2);
  });

  it('holds still while frozen', () => {
    const a = sampleCharacterPose(actor({ frozenTime: 3 }), {
      clip: 'frozen',
      time: 0,
      clock: 0.1,
    });
    const b = sampleCharacterPose(actor({ frozenTime: 3 }), {
      clip: 'frozen',
      time: 0,
      clock: 0.7,
    });
    expect(a.body).toEqual(b.body);
    expect(a.hands).toEqual(b.hands);
  });
});

describe('display interpolation', () => {
  it('turns the short way round like lerp_angle', () => {
    expect(lerpAngle(3, -3, 0.5)).toBeCloseTo(Math.PI, 2);
    expect(lerpAngle(0.2, 0.6, 0.5)).toBeCloseTo(0.4, 9);
    expect(lerpAngle(-3, 3, 1)).toBeCloseTo(-3 + (6 - 2 * Math.PI), 9);
  });
});

describe('reference character tilt', () => {
  it('leans the model back so its front faces the camera (south, above)', () => {
    // A model facing the camera has its front along +z (south).
    const lean = new THREE.Quaternion().setFromEuler(new THREE.Euler(CAMERA_TILT, 0, 0));
    const top = new THREE.Vector3(0, 1, 0).applyQuaternion(lean);
    const front = new THREE.Vector3(0, 0, 1).applyQuaternion(lean);
    expect(top.z).toBeLessThan(-0.4); // head goes north, away from the lens
    expect(front.y).toBeGreaterThan(0.4); // the face tips up toward the elevated camera
    expect(BODY_OFFSET).toBeCloseTo(0.16, 9); // and the body sits toward the camera
  });
});
