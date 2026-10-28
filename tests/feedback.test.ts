import { describe, expect, it } from 'vitest';
import { boundaryNotice, boundaryWarning, eliminationLabel } from '../src/core/feedback';
import { createState } from '../src/simulation/state';

describe('elimination and boundary feedback', () => {
  it('waits for the initial grace interval and hides warnings immediately on return or death', () => {
    const actor = createState().actors[0];
    actor.outOfBounds = { duration: 3.75, remaining: 3.1 };
    expect(boundaryWarning(actor).visible).toBe(false);
    actor.outOfBounds.remaining = 2.9;
    expect(boundaryWarning(actor).visible).toBe(true);
    expect(boundaryWarning(actor).seconds).toBe(2.9);
    for (let remaining = 0; remaining < 3.75; remaining += 0.05) {
      actor.outOfBounds.remaining = remaining;
      expect(boundaryWarning(actor).pulse).toBeGreaterThanOrEqual(0);
      expect(boundaryWarning(actor).pulse).toBeLessThanOrEqual(1);
    }
    actor.alive = false;
    expect(boundaryWarning(actor).visible).toBe(false);
    actor.alive = true;
    actor.outOfBounds = undefined;
    expect(boundaryWarning(actor).visible).toBe(false);
  });

  it('only promises fall rescue while the window, cooldown and single rescue allow it', () => {
    const actor = createState().actors[0];
    actor.fall = { kind: 'water', elapsed: 0.2, duration: 0.66 };
    actor.dashCooldown = 0;
    expect(eliminationLabel(actor)).toContain('冲刺自救');
    actor.fallsSaved = 1;
    expect(eliminationLabel(actor)).toBe('正在下落');
    actor.fallsSaved = 0;
    actor.fall.elapsed = 0.4;
    expect(eliminationLabel(actor)).toBe('正在下落');
    actor.fall.elapsed = 0.1;
    actor.dashCooldown = 0.5;
    expect(eliminationLabel(actor)).toBe('正在下落');
  });

  it('prioritizes returning over shrink notices and clears notices during the next entrance', () => {
    const state = createState();
    state.phase = 'playing';
    state.boundary.phase = 'shrinking';
    expect(boundaryNotice(state)).toContain('决胜缩圈');
    state.actors[0].outOfBounds = { duration: 3, remaining: 2 };
    expect(boundaryNotice(state)).toContain('界外倒计时');
    state.phase = 'countdown';
    expect(boundaryNotice(state)).toBe('');
  });
});
