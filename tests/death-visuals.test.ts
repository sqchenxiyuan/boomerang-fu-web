import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import type { DeathState } from '../src/core/types';
import { createState, makeActor } from '../src/simulation/state';
import {
  sampleDeathParticles,
  sampleDeathPose,
  sampleDeathRings,
  sampleDeathSplats,
  sampleFallPose,
} from '../src/rendering/death-visuals';
import { Effects } from '../src/rendering/effects';
import { createDeathModel } from '../src/rendering/death-models';
import { updateCharacter, type CharacterView } from '../src/rendering/characters';

const death = (variant: DeathState['variant'] = 'slice'): DeathState => ({
  cause:
    variant === 'slice'
      ? 'weapon'
      : variant === 'squash'
        ? 'explosion'
        : variant === 'burst'
          ? 'boundary'
          : 'fall',
  variant,
  time: 10,
  position: { x: 2, y: 1 },
  direction: { x: 1, y: 0 },
  seed: 12345,
});
const samples = (record: DeathState, time: number) => ({
  pose: sampleDeathPose(record, time),
  particles: sampleDeathParticles(record, time),
  rings: sampleDeathRings(record, time),
  splats: sampleDeathSplats(record, time),
});
function visuals(root: THREE.Object3D) {
  const output: unknown[] = [];
  root.traverse((o) => {
    if (o instanceof THREE.InstancedMesh && o.visible) {
      const matrix = new THREE.Matrix4(),
        color = new THREE.Color();
      for (let i = 0; i < o.count; i++) {
        o.getMatrixAt(i, matrix);
        o.getColorAt(i, color);
        output.push({
          matrix: matrix.toArray(),
          color: color.getHex(),
          opacity: o.geometry.getAttribute('instanceAlpha').getX(i),
          type: o.geometry.type,
        });
      }
      return;
    }
    if (o instanceof THREE.Mesh && o.visible)
      output.push({
        position: o.position.toArray(),
        scale: o.scale.toArray(),
        rotation: o.rotation.toArray(),
        color: o.material.color?.getHex(),
        opacity: o.material.opacity,
        type: o.geometry.type,
      });
  });
  return output;
}

describe('snapshot-driven death presentation', () => {
  it('reconstructs every cause after pause, backward seek, and a fresh mount without mutation', () => {
    for (const variant of ['slice', 'squash', 'water', 'cliff', 'burst'] as const) {
      const record = death(variant),
        before = structuredClone(record);
      const a = samples(record, 10.41);
      samples(record, 30);
      samples(record, 10.01);
      expect(samples(record, 10.41)).toEqual(a);
      expect(record).toEqual(before);
    }
  });

  it('launches a persistent slice away from the hit and keeps the stump after its faceplant', () => {
    const record = death();
    const pose = sampleDeathPose(record, 10.2);
    expect(pose.piece.x).toBeGreaterThan(0);
    expect(pose.piece.z).toBe(0);
    const reversed = sampleDeathPose({ ...record, direction: { x: -7, y: 0 } }, 10.2);
    expect(reversed.piece.x).toBeCloseTo(-pose.piece.x);
    expect(reversed.piece.y).toEqual(pose.piece.y);
    const resting = sampleDeathPose(record, 40);
    expect(resting.baseVisible && resting.pieceVisible).toBe(true);
    expect(resting.piece.y).toBeCloseTo(0.27);
    expect(resting.baseTilt).toBeGreaterThan(1.4);
    expect(resting).toEqual(sampleDeathPose(record, 50));
    for (let t = 10; t < 13; t += 1 / 120)
      expect(sampleDeathPose(record, t).piece.y).toBeGreaterThanOrEqual(0.26999);
  });

  it('distinguishes flattened explosion bodies, water bubbles, cliff clouds, and boundary disappearance', () => {
    const squash = sampleDeathPose(death('squash'), 10);
    expect(squash.baseVisible).toBe(true);
    expect(squash.pieceVisible).toBe(false);
    expect(squash.baseScale.y).toBeLessThan(0.3);
    for (const variant of ['water', 'cliff', 'burst'] as const) {
      const pose = sampleDeathPose(death(variant), 10);
      expect(pose.baseVisible || pose.pieceVisible).toBe(false);
      expect(sampleDeathSplats(death(variant), 10.4)).toEqual([]);
    }
    expect(sampleDeathParticles(death('water'), 10.55).some((p) => p.kind === 'bubble')).toBe(true);
    expect(sampleDeathParticles(death('cliff'), 10.2).every((p) => p.kind === 'cloud')).toBe(true);
    expect(sampleDeathRings(death('burst'), 10.3)).toEqual([]);
    expect(sampleDeathRings(death('water'), 10.3).length).toBeGreaterThan(0);
    expect(sampleDeathParticles(death('water'), 13)).toEqual([]);
  });

  it('keeps randomized droplets stable per seed with bounded opacity and finite transforms', () => {
    expect(sampleDeathParticles(death(), 10.2)).not.toEqual(
      sampleDeathParticles({ ...death(), seed: 2 }, 10.2),
    );
    for (const variant of ['slice', 'squash', 'water', 'cliff', 'burst'] as const)
      for (let i = 0; i < 180; i++)
        for (const p of sampleDeathParticles(death(variant), 10 + i / 60)) {
          expect(p.opacity).toBeGreaterThanOrEqual(0);
          expect(p.opacity).toBeLessThanOrEqual(1);
          expect(p.radius).toBeGreaterThanOrEqual(0);
          expect([p.x, p.y, p.z, p.radius, p.opacity].every(Number.isFinite)).toBe(true);
        }
  });

  it('rebuilds the same effects at late attachment and ignores duplicate one-shot death events', () => {
    const state = createState();
    state.actors[0].alive = false;
    state.actors[0].death = death('water');
    const running = new Effects(),
      late = new Effects();
    for (let i = 0; i < 30; i++) {
      state.time = 10 + i / 60;
      running.syncDeaths(state);
    }
    state.time = 10.55;
    running.syncDeaths(state);
    late.syncDeaths(structuredClone(state));
    expect(visuals(late.root)).toEqual(visuals(running.root));
    const before = visuals(late.root);
    late.emit({ type: 'death', actorId: 0, position: death().position, cause: 'fall' });
    late.syncDeaths(state);
    late.update(0);
    expect(visuals(late.root)).toEqual(before);
    expect(visuals(late.root).length).toBeLessThan(40);
    running.clear();
    late.clear();
  });

  it('cleans up removed deaths without disposing another renderer resources', () => {
    const state = createState();
    state.time = 10.4;
    state.actors[0].alive = false;
    state.actors[0].death = death();
    const first = new Effects(),
      second = new Effects();
    first.syncDeaths(state);
    second.syncDeaths(state);
    let released = 0,
      otherReleased = 0;
    first.root.traverse((o) => {
      if (o instanceof THREE.Mesh) o.geometry.addEventListener('dispose', () => released++);
    });
    second.root.traverse((o) => {
      if (o instanceof THREE.Mesh) o.geometry.addEventListener('dispose', () => otherReleased++);
    });
    const before = visuals(second.root);
    first.clear();
    expect(first.stats().particles).toBe(0);
    expect(released).toBe(0);
    first.dispose();
    expect(released).toBeGreaterThan(0);
    expect(otherReleased).toBe(0);
    expect(visuals(second.root)).toEqual(before);
    state.actors[0].alive = true;
    state.actors[0].death = undefined;
    second.syncDeaths(state);
    expect(second.stats().particles + second.stats().rings + second.stats().splats).toBe(0);
    expect(otherReleased).toBe(0);
    first.dispose();
    second.dispose();
    expect(otherReleased).toBeGreaterThan(0);
  });

  it('samples falling from authoritative elapsed time and restores an actor after rescue', () => {
    const water = sampleFallPose({ kind: 'water', elapsed: 0.66, duration: 0.66 });
    const cliff = sampleFallPose({ kind: 'cliff', elapsed: 0.74, duration: 0.74 });
    expect(water.height).toBeCloseTo(-0.9);
    expect(cliff.height).toBeCloseTo(-5);
    expect(sampleFallPose({ kind: 'cliff', elapsed: 0.25, duration: 0.74 }).height).toBeCloseTo(0);
    const actor = makeActor(0, 'human', 0);
    const view = fakeView();
    actor.fall = { kind: 'water', elapsed: 0.4, duration: 0.66 };
    updateCharacter(view, actor, 1, 10);
    const fallenHeight = view.body.position.y;
    actor.fall = undefined;
    updateCharacter(view, actor, 1, 10);
    expect(view.body.position.y).toBeGreaterThan(fallenHeight);
    expect(actor.alive).toBe(true);
    expect(view.body.visible).toBe(true);
    expect(view.death.root.visible).toBe(false);
  });

  it('never re-shows a removed corpse because old invulnerability is still set', () => {
    const actor = makeActor(0, 'human', 0);
    const view = fakeView();
    actor.alive = false;
    actor.invulnerable = 1;
    actor.outOfBounds = { remaining: 0, duration: 3 };
    actor.death = death('burst');
    updateCharacter(view, actor, 1, 30);
    expect(view.body.visible).toBe(false);
    expect(view.death.stump.visible).toBe(false);
    expect(view.death.piece.visible).toBe(false);
    expect(view.shadow.visible).toBe(false);
    actor.alive = true;
    actor.death = undefined;
    actor.outOfBounds = undefined;
    updateCharacter(view, actor, 1, 30);
    expect(view.body.visible).toBe(true);
    expect(view.death.root.visible).toBe(false);
  });
});

function fakeView(): CharacterView {
  const actor = makeActor(0, 'human', 0);
  return {
    root: new THREE.Group(),
    body: new THREE.Group(),
    leftArm: new THREE.Group(),
    rightArm: new THREE.Group(),
    feet: [new THREE.Group(), new THREE.Group()],
    weapon: new THREE.Group(),
    shield: new THREE.Mesh(),
    aim: new THREE.Group(),
    ring: new THREE.Mesh(),
    label: new THREE.Sprite(),
    shadow: new THREE.Mesh(),
    death: createDeathModel(actor),
  };
}
