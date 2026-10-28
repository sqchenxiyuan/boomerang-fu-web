import { describe, expect, it } from 'vitest';
import { createSession } from '../src/sdk/session';
import { meleeAge, sampleMeleePose } from '../src/rendering/melee-pose';
import { MeleeTrail } from '../src/rendering/melee-trail';
import { RULES } from '../src/core/config';

function match() {
  const session = createSession({ mode: 'local', bots: 0, seed: 41 });
  session.start();
  for (const a of session.getState().actors) session.useScript(a.id, () => ({}));
  session.step(260);
  return { session, input: session.acquire(0), actor: () => session.getState().actors[0] };
}

describe('melee presentation follows simulation clocks', () => {
  it('keeps the recovery continuous after the active hit window and then returns to idle', () => {
    const { session, input, actor } = match();
    input.submit({ attack: true }, 1);
    session.step();
    expect(meleeAge(actor())).toBe(0);
    session.step(11);
    const before = meleeAge(actor())!;
    session.step();
    expect(actor().attackTime).toBe(0);
    expect(meleeAge(actor())! - before).toBeCloseTo(RULES.dt);
    expect(sampleMeleePose(meleeAge(actor())!, true).weight).toBeGreaterThan(0.9);
    session.step(12);
    expect(meleeAge(actor())).toBeNull();
    session.destroy();
  });
  it('does not mistake a later throw cooldown for another melee animation', () => {
    const { session, input, actor } = match();
    input.submit({ attack: true }, 1);
    session.step(42);
    input.submit({ throw: true }, 10);
    session.step();
    input.submit({ throw: false }, 1);
    session.step();
    expect(actor().attackSerial).toBe(1);
    expect(actor().attackCooldown).toBeGreaterThan(0);
    expect(meleeAge(actor())).toBeNull();
    session.destroy();
  });
  it('interpolates substeps, freezes on pause, and cancels pose for incapacitated actors', () => {
    const { session, input, actor } = match();
    input.submit({ attack: true }, 1);
    session.step(5);
    const state = actor();
    expect(meleeAge(state, 1)! - meleeAge(state, 0)!).toBeCloseTo(RULES.dt);
    session.pause();
    session.step(60);
    expect(meleeAge(actor())).toBe(meleeAge(state));
    expect(meleeAge({ ...state, alive: false })).toBeNull();
    expect(meleeAge({ ...state, frozenTime: 1 })).toBeNull();
    expect(meleeAge({ ...state, disguised: true })).toBeNull();
    session.destroy();
  });
  it('bounds four simultaneous ribbon trails and reuses buffers across repeated attacks', () => {
    const trail = new MeleeTrail();
    const geometry = trail.mesh.geometry,
      positions = geometry.getAttribute('position');
    let maxVertices = 0;
    for (let frame = 0; frame < 200; frame++) {
      trail.begin();
      for (let i = 0; i < 4; i++) trail.add(0, 0, (i * Math.PI) / 2, (frame % 24) / 60);
      trail.end();
      const count = geometry.drawRange.count;
      maxVertices = Math.max(maxVertices, count);
      expect(count).toBeLessThanOrEqual(positions.count);
      for (let i = 0; i < count; i++) {
        expect(Math.hypot(positions.getX(i), positions.getZ(i))).toBeLessThanOrEqual(
          RULES.attackRange + 1e-6,
        );
        expect(Number.isFinite(positions.getY(i))).toBe(true);
      }
      expect(trail.mesh.geometry).toBe(geometry);
      expect(geometry.getAttribute('position')).toBe(positions);
    }
    expect(maxVertices).toBeGreaterThan(0);
    trail.clear();
    expect(geometry.drawRange.count).toBe(0);
    trail.dispose();
  });
});
