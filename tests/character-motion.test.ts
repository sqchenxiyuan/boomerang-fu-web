import { describe, expect, it } from 'vitest';
import { RULES } from '../src/core/config';
import { BODY_HEIGHT, sampleCharacterPose } from '../src/rendering/character-motion';
import { makeActor } from '../src/simulation/state';
import type { Actor } from '../src/core/types';

const actor = (patch: Partial<Actor> = {}): Actor => ({
  ...makeActor(0, 'bot', -1),
  armed: true,
  heldDiscs: 1,
  ...patch,
});

describe('procedural character motion', () => {
  it('is a pure function of state and time', () => {
    const a = sampleCharacterPose(actor({ velocity: { x: 0, y: 6 } }), 1.234);
    const b = sampleCharacterPose(actor({ velocity: { x: 0, y: 6 } }), 1.234);
    expect(a).toEqual(b);
  });
  it('hops, leans and counter-swings the floating hands while running', () => {
    const idle = sampleCharacterPose(actor(), 0.5);
    const frames = Array.from({ length: 40 }, (_, i) =>
      sampleCharacterPose(actor({ velocity: { x: 0, y: 7 } }), i / 60),
    );
    expect(Math.max(...frames.map((f) => f.body.y))).toBeGreaterThan(BODY_HEIGHT + 0.12);
    expect(frames[10].body.pitch).toBeGreaterThan(0.2);
    // Hands swing in opposite directions along the facing axis.
    const swings = frames.map((f) => f.hands[0].z * f.hands[1].z);
    expect(Math.min(...swings)).toBeLessThan(0);
    expect(Math.abs(idle.hands[1].z - 0.06)).toBeLessThan(0.01);
  });
  it('draws the weapon hand far back when charging and snaps through on release', () => {
    const charged = sampleCharacterPose(actor({ charge: RULES.chargeTime }), 0.3);
    expect(charged.hands[1].z).toBeLessThan(-0.5);
    expect(charged.body.yaw).toBeGreaterThan(0.5);
    const follow = sampleCharacterPose(actor({ charge: 0 }), 0.3, { throwAge: 0.08 });
    expect(follow.hands[1].z).toBeGreaterThan(0.4);
  });
  it('stretches into a dash and wobbles while stunned', () => {
    const dash = sampleCharacterPose(actor({ dashTime: 0.15, velocity: { x: 0, y: 20 } }), 0.2);
    expect(dash.body.sz).toBeGreaterThan(1.2);
    expect(dash.hands[0].z).toBeLessThan(-0.4);
    const rolls = [0.1, 0.25, 0.4].map(
      (t) => sampleCharacterPose(actor({ stun: 0.5 }), t).body.roll,
    );
    expect(Math.max(...rolls) - Math.min(...rolls)).toBeGreaterThan(0.2);
  });
  it('holds still while frozen', () => {
    const a = sampleCharacterPose(actor({ frozenTime: 3 }), 0.1);
    const b = sampleCharacterPose(actor({ frozenTime: 3 }), 0.7);
    expect(a.body).toEqual(b.body);
    expect(a.hands).toEqual(b.hands);
  });
});
