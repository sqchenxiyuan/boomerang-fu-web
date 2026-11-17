/**
 * Scripted showcase scenarios for dev/fx.html. Each one drives the real
 * simulation with per-tick commands, so what the gallery shows is exactly what
 * a match produces. tests/fx-scenarios.test.ts checks every scenario really
 * emits the event it claims to demonstrate.
 */
import { RULES } from '../core/config';
import { v } from '../core/math';
import type { Vec2 } from '../core/math';
import { introDuration, ROUND_END_DURATION } from '../core/presentation';
import { idleCommand } from '../core/types';
import type { Command, GameEvent, GameState, MatchOptions, PowerupKind } from '../core/types';
import { Game } from '../simulation/game';
import { setHeldDiscs } from '../simulation/inventory';
import { grantPowerup } from '../simulation/powerups';
import { defaultOptions } from '../simulation/state';

export type FxGroup = '移动' | '投掷' | '近战' | '击败' | '道具' | '流程';
export interface FxScenario {
  id: string;
  group: FxGroup;
  title: string;
  description: string;
  /** Simulated seconds before the scenario restarts. */
  duration: number;
  players?: number;
  options?: Partial<MatchOptions>;
  /** Leave the round in its entrance phase instead of jumping to play. */
  keepIntro?: boolean;
  setup?: (state: GameState) => void;
  /** Commands for one fixed step; `t` is simulated seconds since the start. */
  script?: (t: number, state: GameState) => Record<number, Partial<Command>>;
  /** The event this scenario exists to show (checked by the test suite). */
  expect: (event: GameEvent) => boolean;
  expectLabel: string;
  /** Nearest Godot/original behaviour, for side-by-side evaluation. */
  godot?: string;
}

const RIGHT = v(1, 0),
  LEFT = v(-1, 0),
  UP = v(0, -1),
  DOWN = v(0, 1);
/** One fixed step: `at(t, 0.5)` is true on exactly one tick. */
const at = (t: number, time: number): boolean => t >= time && t < time + RULES.dt - 1e-9;
const between = (t: number, from: number, to: number): boolean => t >= from && t < to;
/**
 * Tap throw (no charge) at `time`, or hold for `hold` seconds then release.
 * The stick is held toward `dir` meanwhile: with no stick input the throw keeps
 * the last movement direction (intendedDirection), not the facing.
 */
function throwAt(t: number, time: number, hold: number, dir: Vec2): Partial<Command> {
  if (between(t, time, time + hold + RULES.dt)) return { throwHeld: true, move: dir };
  if (at(t, time + hold + RULES.dt)) return { throwReleased: true, move: dir };
  return {};
}
function place(state: GameState, index: number, position: Vec2, facing: Vec2): void {
  const actor = state.actors[index];
  actor.position = { ...position };
  actor.previous = { ...position };
  actor.facing = { ...facing };
}
function give(state: GameState, index: number, ...powers: PowerupKind[]): void {
  for (const power of powers) grantPowerup(state, state.actors[index], power);
}
const near = (state: GameState, index: number, radius: number): boolean =>
  state.discs.some(
    (disc) =>
      !disc.dead &&
      disc.ownerId !== index &&
      Math.hypot(
        disc.position.x - state.actors[index].position.x,
        disc.position.y - state.actors[index].position.y,
      ) < radius,
  );

export const FX_SCENARIOS: FxScenario[] = [
  {
    id: 'walk',
    group: '移动',
    title: '走动',
    description: '1P 走正方形，2P 来回横移；看起步加速、转向和停下后的滑行。',
    duration: 4.4,
    setup: (s) => {
      place(s, 0, v(-4, -2), RIGHT);
      place(s, 1, v(3, 2), LEFT);
    },
    script: (t) => ({
      0: { move: t < 1 ? RIGHT : t < 2 ? DOWN : t < 3 ? LEFT : t < 4 ? UP : v() },
      1: { move: t % 2 < 1 ? LEFT : RIGHT },
    }),
    expect: () => true,
    expectLabel: '无事件（纯动作）',
    godot: 'event:/combat/footstep 由跑步动画关键帧触发；Web 没有脚步声。',
  },
  {
    id: 'dash',
    group: '移动',
    title: '冲刺 / 冲刺撞人',
    description: '1P 向右冲刺后折返；2P 冲刺撞向 1P，被撞方会被推开并眩晕 0.4 秒。',
    duration: 3,
    setup: (s) => {
      place(s, 0, v(-4, 0), RIGHT);
      place(s, 1, v(4, 0), LEFT);
    },
    script: (t) => ({
      0: { move: t < 1 ? RIGHT : LEFT, dash: at(t, 0.1) || at(t, 1.1) },
      1: { move: between(t, 1.6, 2.2) ? LEFT : v(), dash: at(t, 1.6) },
    }),
    expect: (e) => e.type === 'dash',
    expectLabel: 'dash',
    godot: 'event:/combat/dash、dash_end；撞人为 dash_slam（Godot 未接入）。',
  },
  {
    id: 'throw-catch',
    group: '投掷',
    title: '投掷与接回',
    description: '1P 轻点投掷，飞镖飞出、回旋、被接住。',
    duration: 3,
    setup: (s) => {
      place(s, 0, v(-6, 0), RIGHT);
      place(s, 1, v(6, 5), LEFT);
    },
    script: (t) => ({ 0: { ...throwAt(t, 0.2, 0, RIGHT), aim: RIGHT } }),
    expect: (e) => e.type === 'catch',
    expectLabel: 'throw → catch',
    godot: 'event:/combat/throw（aimPower 参数）、event:/combat/catch。',
  },
  {
    id: 'charged-throw',
    group: '投掷',
    title: '满蓄力投掷',
    description: '1P 按住 1 秒蓄满再松开：速度上限提高、追踪半径变大。',
    duration: 3.8,
    setup: (s) => {
      place(s, 0, v(-7, 0), RIGHT);
      place(s, 1, v(6, 6), LEFT);
    },
    script: (t) => ({ 0: { ...throwAt(t, 0.2, 1.05, RIGHT), aim: RIGHT } }),
    expect: (e) => e.type === 'throw' && (e.value ?? 0) >= 0.99,
    expectLabel: 'throw（value = 1）',
    godot: 'event:/combat/throw 的 aimPower = 1；蓄力过程音为 combat/charge（仅开源皮肤）。',
  },
  {
    id: 'melee-kill',
    group: '击败',
    title: '近战击杀（切开）',
    description: '1P 贴近 2P 挥砍：命中停顿、切开死亡和击杀慢动作。',
    duration: 3,
    setup: (s) => {
      place(s, 0, v(-2, 0), RIGHT);
      place(s, 1, v(-0.5, 0), LEFT);
    },
    script: (t) => ({ 0: { attack: at(t, 0.3), aim: RIGHT } }),
    expect: (e) => e.type === 'death' && e.variant === 'slice',
    expectLabel: 'slash → death（slice）',
    godot: 'event:/combat/melee + event:/death/sliced（角色专属 sliced_coffee 等）。',
  },
  {
    id: 'disc-kill',
    group: '击败',
    title: '飞镖击杀',
    description: '1P 投镖命中 2P。',
    duration: 3,
    setup: (s) => {
      place(s, 0, v(-3, 0), RIGHT);
      place(s, 1, v(1.5, 0), LEFT);
    },
    script: (t) => ({ 0: { ...throwAt(t, 0.2, 0, RIGHT), aim: RIGHT } }),
    expect: (e) => e.type === 'death',
    expectLabel: 'throw → death',
    godot: 'event:/death/sliced',
  },
  {
    id: 'clash',
    group: '近战',
    title: '对砍（挥砍互挡）',
    description: '两人面对面同一帧挥砍：双方攻击中止、击退并眩晕，冻结 0.2 秒。',
    duration: 2.4,
    setup: (s) => {
      place(s, 0, v(-0.75, 0), RIGHT);
      place(s, 1, v(0.75, 0), LEFT);
    },
    script: (t) => ({
      0: { attack: at(t, 0.3), aim: RIGHT },
      1: { attack: at(t, 0.3), aim: LEFT },
    }),
    expect: (e) => e.type === 'deflect' && e.feedback === 'clash',
    expectLabel: 'deflect（clash）',
    godot: 'event:/combat/block_melee，镜头震动 0.5 秒。',
  },
  {
    id: 'parry',
    group: '近战',
    title: '弹镖（挥砍弹开来镖）',
    description: '1P 投镖，2P 在飞镖到达前挥砍把它弹开：冻结 0.25 秒。',
    duration: 3,
    setup: (s) => {
      place(s, 0, v(-3, 0), RIGHT);
      place(s, 1, v(1.5, 0), LEFT);
    },
    script: (t, s) => {
      const swing = near(s, 1, 1.7) && !s.actors[1].attackTime;
      return { 0: { ...throwAt(t, 0.2, 0, RIGHT), aim: RIGHT }, 1: { attack: swing, aim: LEFT } };
    },
    expect: (e) => e.type === 'deflect' && e.feedback === 'parry',
    expectLabel: 'deflect（parry）',
    godot: 'event:/combat/block_disc；满蓄力弹反额外慢动作和 sting。',
  },
  {
    id: 'charged-parry',
    group: '近战',
    title: '弹回满蓄力飞镖',
    description: '同上，但来镖是满蓄力的：弹反时附加慢动作。',
    duration: 3.6,
    setup: (s) => {
      place(s, 0, v(-7, 0), RIGHT);
      place(s, 1, v(3, 0), LEFT);
    },
    script: (t, s) => {
      const swing = near(s, 1, 3.2) && !s.actors[1].attackTime;
      return {
        0: { ...throwAt(t, 0.2, 1.05, RIGHT), aim: RIGHT },
        1: { attack: swing, aim: LEFT },
      };
    },
    expect: (e) => e.type === 'deflect' && e.feedback === 'parry',
    expectLabel: 'deflect（parry）',
    godot: 'event:/combat/block_disc + 慢动作。',
  },
  {
    id: 'disarm',
    group: '近战',
    title: '空手缴械',
    description: '1P 先把镖往上扔掉，再空手挥向 2P：2P 被击退、眩晕并掉镖。',
    duration: 3,
    setup: (s) => {
      place(s, 0, v(-1.6, 0), UP);
      place(s, 1, v(-0.2, 0), LEFT);
    },
    script: (t) => ({
      0: { ...throwAt(t, 0.1, 0, UP), aim: t < 0.3 ? UP : RIGHT, attack: at(t, 0.45) },
    }),
    expect: (e) => e.type === 'deflect' && e.feedback === 'disarm',
    expectLabel: 'deflect（disarm）',
    godot: 'event:/combat/disarm（出手）+ event:/combat/disarm_hit（命中）。',
  },
  {
    id: 'disc-clash',
    group: '投掷',
    title: '两镖对撞',
    description: '两人同时对投，飞镖在中间相撞弹开，附带慢动作。',
    duration: 2.6,
    setup: (s) => {
      place(s, 0, v(-2.5, 0), RIGHT);
      place(s, 1, v(2.5, 0), LEFT);
    },
    script: (t) => ({
      0: { ...throwAt(t, 0.2, 0, RIGHT), aim: RIGHT },
      1: { ...throwAt(t, 0.2, 0, LEFT), aim: LEFT },
    }),
    expect: (e) => e.type === 'clash',
    expectLabel: 'clash',
    godot: 'event:/environment/disc_rico_disc（velocity 参数）。',
  },
  {
    id: 'water',
    group: '击败',
    title: '落水',
    description: '1P 冲出场地边缘掉进水里。',
    duration: 3,
    setup: (s) => {
      // Legacy maps treat leaving the bounds as a cliff; a water hazard makes it a splash.
      s.arena.hazard = 'water';
      place(s, 0, v(10.5, 0), RIGHT);
    },
    script: (t) => ({ 0: { move: t > 0.2 ? RIGHT : v(), dash: at(t, 0.3) } }),
    expect: (e) => e.type === 'death' && e.variant === 'water',
    expectLabel: 'death（water）',
    godot: 'event:/death/splash_medium（落水粒子触发）。',
  },
  {
    id: 'cliff',
    group: '击败',
    title: '坠崖',
    description: '同一动作，场地外是悬崖：角色坠落消失。',
    duration: 3,
    setup: (s) => {
      s.arena.hazard = 'cliff';
      place(s, 0, v(10.5, 0), RIGHT);
    },
    script: (t) => ({ 0: { move: t > 0.2 ? RIGHT : v(), dash: at(t, 0.3) } }),
    expect: (e) => e.type === 'death' && e.variant === 'cliff',
    expectLabel: 'death（cliff）',
    godot: '原版坠崖没有专门的死亡音；Web 用下行音阶。',
  },
  {
    id: 'double-kill',
    group: '击败',
    title: '双杀',
    description: '满蓄力飞镖连续穿过两名对手，触发连杀提示。',
    duration: 3.8,
    players: 3,
    setup: (s) => {
      place(s, 0, v(-7, 0), RIGHT);
      place(s, 1, v(-1, 0), LEFT);
      place(s, 2, v(2.5, 0), LEFT);
    },
    script: (t) => ({ 0: { ...throwAt(t, 0.2, 1.05, RIGHT), aim: RIGHT } }),
    expect: (e) => e.type === 'streak',
    expectLabel: 'streak（value = 2）',
    godot: 'event:/ui/doublekill + event:/ui/show_alert；三杀冻结 0.2 秒。',
  },
  {
    id: 'explosion',
    group: '道具',
    title: '爆炸镖',
    description: '1P 持爆炸镖投出，引信到期后爆炸，波及范围内的对手。',
    duration: 4,
    setup: (s) => {
      place(s, 0, v(-4, 0), RIGHT);
      place(s, 1, v(1, 0), LEFT);
      give(s, 0, 'explosive');
    },
    script: (t) => ({ 0: { ...throwAt(t, 0.2, 0, RIGHT), aim: RIGHT } }),
    expect: (e) => e.type === 'explosion',
    expectLabel: 'explosion',
    godot: 'event:/powerups/explosion（fire/ice/mini 变体）+ grenade_blink 引信闪烁。',
  },
  {
    id: 'shield',
    group: '道具',
    title: '护盾挡镖',
    description: '2P 有护盾，1P 的飞镖命中后护盾破碎、2P 被击退。',
    duration: 3,
    setup: (s) => {
      place(s, 0, v(-3, 0), RIGHT);
      place(s, 1, v(1.5, 0), LEFT);
      give(s, 1, 'shield');
    },
    script: (t) => ({ 0: { ...throwAt(t, 0.2, 0, RIGHT), aim: RIGHT } }),
    expect: (e) => e.type === 'shield',
    expectLabel: 'shield',
    godot: 'event:/powerups/shield_on（获得）/ shield_off（破碎）。',
  },
  {
    id: 'ice',
    group: '道具',
    title: '冰冻镖',
    description: '1P 的冰镖从 2P 身前飞过、沿途留下冰面；2P 踩上冰面减速，停留 0.5 秒后被冻住。',
    duration: 4,
    setup: (s) => {
      place(s, 0, v(-4, 0), RIGHT);
      place(s, 1, v(0, 2.2), UP);
      give(s, 0, 'ice');
    },
    script: (t) => ({
      0: { ...throwAt(t, 0.2, 0, RIGHT), aim: RIGHT },
      1: { move: between(t, 0.9, 1.3) ? UP : v() },
    }),
    expect: (e) => e.type === 'freeze',
    expectLabel: 'freeze',
    godot: 'event:/powerups/ice_freeze / unfreeze；冻住后被打碎为 death/shatter。',
  },
  {
    id: 'fire',
    group: '道具',
    title: '火焰镖',
    description: '1P 持火镖投出，沿途留下火焰并点燃 2P。',
    duration: 3.5,
    setup: (s) => {
      place(s, 0, v(-3, 0), RIGHT);
      place(s, 1, v(1.5, 0), LEFT);
      give(s, 0, 'fire');
    },
    script: (t) => ({ 0: { ...throwAt(t, 0.2, 0, RIGHT), aim: RIGHT } }),
    expect: (e) => e.type === 'burn',
    expectLabel: 'burn',
    godot: 'event:/combat/fire_ignite、fire_loop；烧死为 death/burnt。',
  },
  {
    id: 'teleport',
    group: '道具',
    title: '传送镖',
    description: '1P 投出传送镖后按冲刺，瞬移到飞镖位置。',
    duration: 3,
    setup: (s) => {
      place(s, 0, v(-6, 2), RIGHT);
      place(s, 1, v(5, -5), LEFT);
      give(s, 0, 'teleport');
    },
    script: (t) => ({ 0: { ...throwAt(t, 0.2, 0, RIGHT), aim: RIGHT, dash: at(t, 0.7) } }),
    expect: (e) => e.type === 'teleport',
    expectLabel: 'teleport',
    godot: 'event:/powerups/teleport。',
  },
  {
    id: 'split',
    group: '道具',
    title: '分裂镖',
    description: '1P 持分裂镖投出，飞行中分裂成多枚小镖。',
    duration: 3.5,
    setup: (s) => {
      place(s, 0, v(-6, 0), RIGHT);
      place(s, 1, v(6, 6), LEFT);
      give(s, 0, 'multi');
    },
    script: (t) => ({ 0: { ...throwAt(t, 0.2, 0, RIGHT), aim: RIGHT } }),
    expect: (e) => e.type === 'split',
    expectLabel: 'split',
    godot: 'event:/powerups/multidisc_burst（原版有，Godot 未接入）。',
  },
  {
    id: 'decoy',
    group: '道具',
    title: '替身',
    description: '1P 持替身道具冲刺，原地留下一个替身吸引攻击。',
    duration: 3,
    setup: (s) => {
      place(s, 0, v(-3, 0), RIGHT);
      place(s, 1, v(5, 4), LEFT);
      give(s, 0, 'decoy');
    },
    script: (t) => ({ 0: { move: between(t, 0.3, 0.8) ? DOWN : v(), dash: at(t, 0.3) } }),
    expect: (e) => e.type === 'decoy',
    expectLabel: 'decoy',
    godot: 'event:/powerups/decoy_spawn / decoy_die。',
  },
  {
    id: 'disguise',
    group: '道具',
    title: '伪装',
    description: '1P 持伪装道具静止片刻，自动变成场景物件；移动后解除。',
    duration: 4,
    setup: (s) => {
      place(s, 0, v(-2, 0), RIGHT);
      place(s, 1, v(5, 4), LEFT);
      give(s, 0, 'disguise');
    },
    script: (t) => ({ 0: { move: between(t, 3, 3.5) ? RIGHT : v() } }),
    expect: (e) => e.type === 'disguise',
    expectLabel: 'disguise',
    godot: '原版伪装没有单独音效。',
  },
  {
    id: 'entrance',
    group: '流程',
    title: '回合入场（落地）',
    description:
      '回合开始：圆形幕布展开，角色依次跳入落地，准备 / 开始。Web 没有跳跃动作，入场落地是最接近的。',
    duration: introDuration(2) + 1.5,
    keepIntro: true,
    expect: (e) => e.type === 'countdown',
    expectLabel: 'countdown',
    godot: 'event:/combat/spawnin_whoosh、spawnin_land；ui/roundtitle_ready / roundtitle_go。',
  },
  {
    id: 'round-win',
    group: '流程',
    title: '击杀 → 回合结束 → 胜利',
    description: '目标分 1：1P 击杀 2P 后进入回合结算和整场胜利。',
    duration: 2 + ROUND_END_DURATION + 2,
    options: { scoreGoal: 1 },
    setup: (s) => {
      place(s, 0, v(-2, 0), RIGHT);
      place(s, 1, v(-0.5, 0), LEFT);
    },
    script: (t) => ({ 0: { attack: at(t, 0.3), aim: RIGHT } }),
    expect: (e) => e.type === 'win',
    expectLabel: 'win',
    godot: 'event:/ui/circlewipe_victory + event:/music/sting_victory。',
  },
];

/** A fresh match on the bare courtyard with every actor scripted (no bots, no pickups). */
export function createScenarioGame(scenario: FxScenario): Game {
  const players = scenario.players ?? 2;
  const game = new Game({
    ...defaultOptions(),
    mode: 'local',
    bots: players - 2,
    mapId: 'courtyard',
    mapRotation: 'fixed',
    powerupPool: [],
    suddenDeathTime: 1e6,
    ...scenario.options,
  });
  const state = game.state;
  state.arena.obstacles = [];
  state.arena.pits = [];
  state.pickups = [];
  state.pickupTimer = 1e9;
  if (!scenario.keepIntro) {
    state.phase = 'playing';
    state.phaseTime = 0;
    state.weaponsGranted = true;
    // heldDiscs, not just `armed`: grantPowerup reconciles against the held count.
    for (const actor of state.actors) setHeldDiscs(actor, 1);
  }
  scenario.setup?.(state);
  return game;
}

/** Advance one fixed step with the scenario's commands; returns the events it produced. */
export function stepScenario(game: Game, scenario: FxScenario, t: number): GameEvent[] {
  const partial = scenario.script?.(t, game.state) ?? {};
  const commands = new Map<number, Command>();
  for (const actor of game.state.actors)
    commands.set(actor.id, { ...idleCommand(), ...(partial[actor.id] ?? {}) });
  game.step(commands);
  return game.drainEvents();
}
