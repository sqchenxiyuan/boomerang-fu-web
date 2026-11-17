import { describe, expect, it } from 'vitest';
import { RULES } from '../src/core/config';
import { idleCommand, type GameEvent } from '../src/core/types';
import { Game } from '../src/simulation/game';
import { defaultOptions } from '../src/simulation/state';
import { Rng, levelTo, loudness, peak } from '../src/platform/sfx/dsp';
import { RECIPES, SOUND_NAMES, type Recipe, type SoundName } from '../src/platform/sfx/recipes';
import { SfxDirector } from '../src/platform/sfx/director';
import type { SfxPlayer } from '../src/platform/sfx/player';

const SR = 32000;
const render = (name: SoundName, seed = 7, variant = 0) =>
  (RECIPES[name] as Recipe).render(SR, new Rng(seed), variant);

describe('generated sound bank', () => {
  it('renders every recipe as finite, click-free audio', () => {
    for (const name of SOUND_NAMES) {
      const recipe: Recipe = RECIPES[name];
      const out = render(name);
      expect(out.length, name).toBeGreaterThan(SR * 0.04);
      expect(out.length, name).toBeLessThan(SR * 4);
      expect(out.every(Number.isFinite), name).toBe(true);
      expect(peak(out), name).toBeLessThanOrEqual(1);
      if (recipe.loop) {
        // A seamless loop: the wrap-around step is no bigger than an ordinary step.
        const steps = Array.from({ length: 200 }, (_, i) => Math.abs(out[i + 1] - out[i]));
        expect(Math.abs(out[0] - out[out.length - 1]), name).toBeLessThan(
          Math.max(...steps) * 3 + 0.02,
        );
      } else {
        expect(Math.abs(out[0]), name).toBeLessThan(0.02);
        expect(Math.abs(out[out.length - 1]), name).toBeLessThan(0.02);
      }
    }
  });

  it('is deterministic per seed and varies between seeds', () => {
    expect(render('parry', 3)).toEqual(render('parry', 3));
    expect(render('parry', 3)).not.toEqual(render('parry', 4));
  });

  it('levels perceived loudness without clipping', () => {
    const quiet = levelTo(render('footstep'), SR, 0.2);
    const loud = levelTo(render('explosion'), SR, 0.2);
    expect(peak(quiet)).toBeLessThanOrEqual(0.98 + 1e-6);
    expect(peak(loud)).toBeLessThanOrEqual(0.98 + 1e-6);
    expect(Math.abs(loudness(loud, SR) - 0.2)).toBeLessThan(0.05);
  });
});

/** Records what the director asks the player to do. */
function fakePlayer() {
  const played: { name: string; pan?: number; rate?: number }[] = [];
  const loops = new Set<string>();
  const player = {
    play: (name: string, options: { pan?: number; rate?: number } = {}) => (
      played.push({ name, ...options }),
      true
    ),
    note: () => {},
    loop: (key: string) => loops.add(key),
    endFrame: () => {},
    silenceLoops: () => loops.clear(),
  } as unknown as SfxPlayer;
  return { player, played, loops };
}

describe('sound director', () => {
  const event = (patch: Partial<GameEvent>): GameEvent => ({
    type: 'throw',
    position: { x: 0, y: 0 },
    actorId: 0,
    ...patch,
  });

  it('maps events by charge, feedback, cause and power', () => {
    const { player, played } = fakePlayer();
    const director = new SfxDirector(player, () => 0);
    director.events([
      event({ type: 'throw', value: 0.1 }),
      event({ type: 'throw', value: 1, actorId: 1 }),
      event({ type: 'deflect', feedback: 'parry', charged: true }),
      event({ type: 'deflect', feedback: 'clash' }),
      event({ type: 'death', variant: 'water' }),
      event({ type: 'death', variant: 'burst', cause: 'fire' }),
      event({ type: 'explosion', value: 4.8, power: 'ice' }),
      event({ type: 'explosion', value: 1.2, power: 'explosive' }),
      event({ type: 'decoy', value: 0 }),
    ]);
    expect(played.map((p) => p.name)).toEqual([
      'throw',
      'throwFull',
      'parryCharged',
      'clash',
      'splashBig',
      'deathBurn',
      'explosionIce',
      'explosionMini',
      'decoyDie',
    ]);
  });

  it('picks the ricochet material from the obstacle that was hit', () => {
    const game = new Game({ ...defaultOptions(), mapId: 'original-bamboo-grove' });
    const bamboo = game.state.arena.obstacles.find((o) => o.material?.toLowerCase() === 'bamboo')!;
    expect(bamboo).toBeDefined();
    const { player, played } = fakePlayer();
    const director = new SfxDirector(player, () => 0);
    director.observe(game.state, 0, true);
    director.events([event({ type: 'bounce', position: { ...bamboo.position }, value: 0.8 })]);
    expect(played.at(-1)?.name).toBe('ricoBamboo');
  });

  it('steps at the walk cadence, with a per-player pitch', () => {
    const game = new Game({ ...defaultOptions(), mode: 'local', bots: 0, mapId: 'courtyard' });
    game.state.phase = 'playing';
    const { player, played } = fakePlayer();
    const director = new SfxDirector(player, () => 0);
    for (let i = 0; i < 120; i++) {
      game.step(new Map([[1, { ...idleCommand(), move: { x: 1, y: 0 } }]]));
      director.observe(game.state, RULES.dt, true);
    }
    const steps = played.filter((p) => p.name === 'footstep');
    // Two seconds of walking at move_speed_parameter ≈ 1.6: about five steps a second.
    expect(steps.length).toBeGreaterThan(7);
    expect(steps.length).toBeLessThan(14);
    expect(steps.every((s) => s.rate === 0.92 + 0.06)).toBe(true);
  });
});
