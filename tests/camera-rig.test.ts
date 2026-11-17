import { describe, expect, it } from 'vitest';
import { RULES } from '../src/core/config';
import { v } from '../src/core/math';
import type { GameState } from '../src/core/types';
import { CAMERA_RIG, CameraRig } from '../src/rendering/camera-rig';
import { Game } from '../src/simulation/game';
import { defaultOptions } from '../src/simulation/state';

const ASPECT = 16 / 9;
/** A 43 × 43 Unity level (LevelEnclosed) is 17.2 × 17.2 Web units. */
function arenaState(players = 2): GameState {
  const game = new Game({ ...defaultOptions(), mode: 'local', bots: players - 1 });
  const state = game.state;
  state.phase = 'playing';
  state.roundTime = 5;
  state.time = 5;
  state.arena.boundary = { center: v(0, 0), half: v(8.6, 8.6), angle: 0, allowOutside: false };
  state.discs = [];
  state.decoys = [];
  state.boundary.phase = 'idle';
  return state;
}
function place(state: GameState, points: [number, number][]): void {
  state.actors.forEach((actor, i) => {
    actor.alive = i < points.length;
    if (i < points.length) actor.position = actor.previous = v(...points[i]);
  });
}
function run(rig: CameraRig, state: GameState, seconds: number, dt = RULES.dt): void {
  for (let t = 0; t < seconds; t += dt) {
    state.time += dt;
    state.roundTime += dt;
    rig.update(state, { dt, scaledDt: dt, frozen: false, aspect: ASPECT, alpha: 1 });
  }
}

describe('Godot camera rig port', () => {
  it('matches the reference maximum zoom for a 43 × 43 level (× 0.4 Web units)', () => {
    const rig = new CameraRig();
    rig.initialize(arenaState().arena, ASPECT);
    const tangent = Math.tan((8 * Math.PI) / 180);
    const reference = Math.max((((43 + 15) / ASPECT) * 0.5) / tangent, ((43 + 15) * 0.5) / tangent);
    expect(reference).toBeCloseTo(206.35, 1);
    expect(rig.maximumZoom).toBeCloseTo(reference * 0.4, 6);
    expect(rig.ratio).toBe(1);
  });

  it('skips the level padding on rotated levels, like Camera3D.Reset', () => {
    const state = arenaState();
    state.arena.boundary = {
      center: v(0, 0),
      half: v(8.6, 8.6),
      angle: Math.PI / 4,
      allowOutside: false,
    };
    const rig = new CameraRig();
    rig.initialize(state.arena, ASPECT);
    const aabb = 2 * 8.6 * Math.SQRT2;
    expect(rig.maximumZoom).toBeCloseTo(rig.zoomFromBox(aabb, aabb), 6);
  });

  it('zooms in on players standing together and centres on them', () => {
    const state = arenaState();
    place(state, [
      [4, 3],
      [5.5, 3],
    ]);
    const rig = new CameraRig();
    run(rig, state, 6);
    expect(rig.ratio).toBeLessThan(0.6);
    expect(rig.focus.x).toBeCloseTo(4.75, 1);
    expect(rig.focus.y).toBeCloseTo(3, 1);
  });

  it('stays fully zoomed out when players are at opposite corners', () => {
    const state = arenaState();
    place(state, [
      [-8, -8],
      [8, 8],
    ]);
    const rig = new CameraRig();
    run(rig, state, 6);
    expect(rig.ratio).toBeCloseTo(1, 3);
    expect(Math.hypot(rig.focus.x, rig.focus.y)).toBeLessThan(0.05);
  });

  it('never zooms closer than the reference minimum', () => {
    const state = arenaState();
    place(state, [
      [0, 0],
      [0.2, 0],
    ]);
    const rig = new CameraRig();
    run(rig, state, 10);
    expect(rig.currentZoom).toBeGreaterThanOrEqual(CAMERA_RIG.minimumZoom - 1e-6);
  });

  it('zooms in slowly (rate 2) and out quickly (rate 6)', () => {
    const state = arenaState();
    place(state, [
      [-8, -8],
      [8, 8],
    ]);
    const rig = new CameraRig();
    run(rig, state, 4);
    // Converge together, then measure one frame of zoom-in.
    state.actors[0].position = state.actors[0].previous = v(0, 0);
    state.actors[1].position = state.actors[1].previous = v(1, 0);
    run(rig, state, 1.5);
    const before = rig.currentZoom;
    run(rig, state, RULES.dt);
    const inStep = (before - rig.currentZoom) / (before - rig.targetZoom);
    expect(inStep).toBeCloseTo(2 * RULES.dt, 2);
    run(rig, state, 4);
    state.actors[1].position = state.actors[1].previous = v(8, 8);
    run(rig, state, RULES.dt);
    const from = rig.currentZoom;
    run(rig, state, RULES.dt);
    expect((rig.currentZoom - from) / (rig.targetZoom - from)).toBeCloseTo(6 * RULES.dt, 2);
  });

  it('removes a dead player over 1.5 s while others remain', () => {
    const state = arenaState(3);
    place(state, [
      [-6, 0],
      [0, 0],
      [6, 0],
    ]);
    const rig = new CameraRig();
    run(rig, state, 2);
    state.actors[2].alive = false;
    run(rig, state, 1);
    expect(rig.trackedIds).toContain('player_2');
    run(rig, state, 0.6);
    expect(rig.trackedIds).not.toContain('player_2');
  });

  it('keeps the last victim framed with the winner (zoom-in-on-kill)', () => {
    const state = arenaState(2);
    place(state, [
      [-3, 0],
      [3, 0],
    ]);
    const rig = new CameraRig();
    run(rig, state, 2);
    state.actors[1].alive = false;
    run(rig, state, 3);
    expect(rig.trackedIds).toEqual(expect.arrayContaining(['player_0', 'player_1']));
  });

  it('frames the shrinking safe area', () => {
    const state = arenaState();
    place(state, [
      [0, 0],
      [1, 0],
    ]);
    const rig = new CameraRig();
    run(rig, state, 5);
    const tight = rig.ratio;
    state.boundary.phase = 'shrinking';
    state.boundary.center = v(0, 0);
    state.boundary.halfSize = v(7, 7);
    run(rig, state, 3);
    expect(rig.ratio).toBeGreaterThan(tight + 0.2);
  });

  it('tracks thrown discs at 0.66 influence and explosive discs at 1', () => {
    const state = arenaState();
    place(state, [
      [0, 0],
      [1, 0],
    ]);
    const rig = new CameraRig();
    run(rig, state, 1);
    const disc = (id: number, explosive: boolean) =>
      ({
        id,
        ownerId: 0,
        damageOwnerId: 0,
        position: v(6, 0),
        previous: v(6, 0),
        velocity: v(10, 0),
        state: 'outbound',
        movement: 'throwing',
        age: 0,
        stateTime: 0,
        charge: 0,
        curve: 0,
        bounces: 0,
        explosive,
        fuse: 0,
        grace: 0,
        lastDeflector: -1,
        dead: false,
      }) as GameState['discs'][number];
    state.discs = [disc(1, false), disc(2, true)];
    run(rig, state, RULES.dt);
    expect(rig.influenceOf('disc_1')).toBeCloseTo(0.66);
    expect(rig.influenceOf('disc_2')).toBe(1);
    state.discs = [];
    run(rig, state, 2);
    expect(rig.trackedIds.some((id) => id.startsWith('disc_'))).toBe(false);
  });

  it('snaps to the settled framing after a replay seek', () => {
    const state = arenaState();
    place(state, [
      [4, 3],
      [5.5, 3],
    ]);
    const rig = new CameraRig();
    run(rig, state, 6);
    const settled = { ratio: rig.ratio, x: rig.focus.x };
    const fresh = new CameraRig();
    // Jump into the middle of a round: no easing from the level centre.
    fresh.update(state, { dt: 0, scaledDt: 0, frozen: false, aspect: ASPECT, alpha: 1 });
    expect(fresh.ratio).toBeCloseTo(settled.ratio, 2);
    expect(fresh.focus.x).toBeCloseTo(settled.x, 1);
  });

  it('eases in from the level centre at the start of a round', () => {
    const state = arenaState();
    state.roundTime = 0;
    place(state, [
      [4, 3],
      [5.5, 3],
    ]);
    const rig = new CameraRig();
    rig.update(state, {
      dt: RULES.dt,
      scaledDt: RULES.dt,
      frozen: false,
      aspect: ASPECT,
      alpha: 1,
    });
    // One frame of the rate-2 zoom-in: still near the full view, not snapped to the target.
    expect(rig.ratio).toBeGreaterThan(0.95);
    expect(Math.hypot(rig.focus.x, rig.focus.y)).toBeLessThan(0.2);
  });
});
