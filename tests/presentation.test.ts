import { describe, expect, it } from 'vitest';
import {
  HIT_STOP,
  PRESENTATION,
  ROUND_END_DURATION,
  introDuration,
  introPose,
  transitionPresentation,
  type PresentationState,
} from '../src/core/presentation';

const state = (phase: PresentationState['phase'], phaseTime: number): PresentationState => ({
  phase,
  phaseTime,
  round: 3,
  winnerId: 0,
  actors: [
    { id: 0, score: 3 },
    { id: 1, score: 1 },
  ],
});

describe('deterministic round presentation', () => {
  it('reveals each actor before Ready and leaves Go to the authoritative playing phase', () => {
    expect(introDuration(2)).toBeCloseTo(1.9);
    expect(introDuration(4)).toBeCloseTo(2.7);
    expect(introDuration(6)).toBeCloseTo(3.2);
    expect(introPose(0.09, 0, 2).visible).toBe(false);
    expect(introPose(0.11, 0, 2).visible).toBe(true);
    expect(introPose(0.49, 1, 2).visible).toBe(false);
    expect(introPose(0.51, 1, 2).visible).toBe(true);
    expect(transitionPresentation(state('countdown', 0.89)).stage).toBe('spawn');
    expect(transitionPresentation(state('countdown', 0.91)).stage).toBe('ready');
    expect(transitionPresentation(state('countdown', 10)).stage).toBe('ready');
    expect(transitionPresentation(state('playing', 0)).stage).toBe('go');
    expect(transitionPresentation(state('playing', PRESENTATION.go)).stage).toBe('none');
  });

  it('keeps delayed actors hidden, lands without sinking, and settles exactly', () => {
    for (let tick = 0; tick <= 240; tick++) {
      const pose = introPose(tick / 60, 1, 4);
      expect(pose.height).toBeGreaterThanOrEqual(0);
      expect(pose.squash).toBeGreaterThanOrEqual(0.8);
      expect(pose.landing).toBeGreaterThanOrEqual(0);
      expect(pose.landing).toBeLessThanOrEqual(1);
    }
    expect(introPose(4, 3, 4)).toEqual({
      visible: true,
      height: 0,
      scale: 1,
      squash: 1,
      landing: 0,
    });
  });

  it('uses a monotone circle reveal and hides map changes behind full coverage', () => {
    expect(transitionPresentation(state('countdown', 0)).wipeRadius).toBe(0);
    expect(transitionPresentation(state('countdown', 1)).wipeRadius).toBe(1);
    let previous = 0;
    for (let frame = 0; frame <= 60; frame++) {
      const radius = transitionPresentation(state('countdown', frame / 60)).wipeRadius;
      expect(radius).toBeGreaterThanOrEqual(previous);
      expect(radius).toBeLessThanOrEqual(1);
      previous = radius;
    }
    expect(transitionPresentation(state('roundEnd', 1.4)).wipeRadius).toBe(1);
    expect(transitionPresentation(state('roundEnd', 1.7)).stage).toBe('close');
    const score = transitionPresentation(state('roundEnd', 2.4));
    expect(score.wipeRadius).toBe(0);
    expect(score.showScores).toBe(true);
    expect(score.scoreOpacity).toBe(1);
    expect(ROUND_END_DURATION).toBeCloseTo(3.1);
  });

  it('supports pause and backward sampling without mutation or hidden elapsed time', () => {
    const snapshot = state('roundEnd', 1.7);
    const original = structuredClone(snapshot);
    const sampled = transitionPresentation(snapshot);
    transitionPresentation(state('roundEnd', 3));
    transitionPresentation(state('countdown', 0.2));
    expect(transitionPresentation(snapshot)).toEqual(sampled);
    expect(snapshot).toEqual(original);
    expect(transitionPresentation({ ...snapshot, winnerId: null }).label).toBe('平局');
    expect(transitionPresentation(state('menu', 0)).stage).toBe('none');
    expect(HIT_STOP).toEqual({ death: 0.1, deflect: 0.25, shield: 0, meleeClash: 0.2 });
  });

  it('rejects malformed public sampling inputs', () => {
    expect(() => introDuration(0)).toThrow(RangeError);
    expect(() => introDuration(2.5)).toThrow(RangeError);
    expect(() => introPose(0, 2, 2)).toThrow(RangeError);
    expect(() => introPose(Number.NaN, 0, 2)).toThrow(RangeError);
    expect(() => transitionPresentation(state('playing', Infinity))).toThrow(RangeError);
  });
});
