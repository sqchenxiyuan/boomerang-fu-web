import { RULES } from '../core/config';
import { Random } from '../core/math';
import type { Difficulty, GameState } from '../core/types';
import { BotController } from '../simulation/ai';
import { DECISION_TICKS, type AgentAction } from './contract';

/*
 * Built-in opponents. The strategies are ordinary sandboxed `decide` programs
 * that read only the observation. Native bots are the web game's own AI wrapped
 * into the same six-frame action contract; they read the full simulation state.
 */
interface StrategyTuning {
  name: string;
  /** Distance below which an armed bot with a clear shot backs off. */
  spacing: number;
  /** Decision blocks to hold a charge before releasing. */
  chargeBlocks: number;
  /** Below this distance, release after a single held block. */
  tapRange: number;
  /** Seconds of opponent movement to lead a throw. */
  lead: number;
  /** Time horizon and miss distance for treating a disc as incoming. */
  horizon: number;
  danger: number;
  dodge: boolean;
}

function strategySource(t: StrategyTuning): string {
  return `// ${t.name} · Boomerang Garden agent contract (arkena.game.v1 compatible).
// decide runs every 6 fixed frames at 60 Hz; units are game-world units, Y up.
function decide(o, memory) {
  const me = o.self, foe = o.opponent;
  const dx = foe.x - me.x, dy = foe.y - me.y, d = Math.hypot(dx, dy) || 1;
  const lx = dx + (foe.vx || 0) * ${t.lead}, ly = dy + (foe.vy || 0) * ${t.lead}, ll = Math.hypot(lx, ly) || 1;
  const aim = { x: lx / ll, y: ly / ll };
  const clear = o.arena.lineOfSight;
  let move = { x: dx / d, y: dy / d };
  const wp = o.arena.path && o.arena.path[0];
  if (wp && (!clear || me.discs === 0)) {
    const wx = wp.x - me.x, wy = wp.y - me.y, wl = Math.hypot(wx, wy) || 1;
    move = { x: wx / wl, y: wy / wl };
  } else if (me.discs > 0 && clear && d < ${t.spacing}) move = { x: -dy / d, y: dx / d };
  let threat = null, soon = Infinity;
  for (const p of o.projectiles) {
    if (p.owner === me.id || p.grounded) continue;
    const rx = p.x - me.x, ry = p.y - me.y, vx = p.vx - (me.vx || 0), vy = p.vy - (me.vy || 0);
    const t = -(rx * vx + ry * vy) / (vx * vx + vy * vy || 1);
    if (t > 0 && t < ${t.horizon} && Math.hypot(rx + vx * t, ry + vy * t) < ${t.danger} && t < soon) { soon = t; threat = p; }
  }
  if (threat && ${t.dodge}) {
    const s = Math.hypot(threat.vx, threat.vy) || 1;
    const side = threat.vx * (me.y - threat.y) - threat.vy * (me.x - threat.x) > 0 ? 1 : -1;
    move = { x: (-threat.vy / s) * side, y: (threat.vx / s) * side };
  }
  const b = o.arena.boundary;
  if (b && (b.shrinking || me.inBounds === false)) {
    const bx = b.center.x - me.x, by = b.center.y - me.y, bl = Math.hypot(bx, by) || 1;
    move = { x: bx / bl, y: by / bl };
  }
  let best = null, score = -Infinity;
  for (const r of o.arena.rays) {
    if (!r.safe || r.clearance < 1) continue;
    const s = r.x * move.x + r.y * move.y + Math.min(r.clearance, 3) * 0.25;
    if (s > score) { score = s; best = r; }
  }
  move = best ? { x: best.x, y: best.y } : { x: 0, y: 0 };
  // A throw flies along the last movement, so steer toward the target while charging.
  let hold = false;
  if (me.discs > 0 && clear && d < 24 && !(threat && soon < 0.35)) {
    memory.charge = (memory.charge || 0) + 1;
    // Up close a quick tap beats a long wind-up; charge only at range.
    hold = memory.charge <= (d < ${t.tapRange} ? 1 : ${t.chargeBlocks});
    if (!hold) memory.charge = 0;
    move = aim;
  } else memory.charge = 0;
  return {
    action: {
      moveX: move.x, moveY: move.y, aimX: aim.x, aimY: aim.y,
      throw: hold,
      dash: !!threat && ${t.dodge} && soon < 0.3 && me.canDash,
      melee: d < 4.2,
    },
    memory,
  };
}
`;
}

export const STARTER_STRATEGY = strategySource({
  name: 'Starter',
  spacing: 6,
  chargeBlocks: 4,
  tapRange: 0,
  lead: 0,
  horizon: 0.5,
  danger: 2,
  dodge: false,
});
export const HOUSE_STRATEGY = strategySource({
  name: 'House',
  spacing: 8,
  chargeBlocks: 3,
  tapRange: 9,
  lead: 0.2,
  horizon: 0.6,
  danger: 2.6,
  dodge: true,
});
export const BUILTIN_STRATEGIES: Record<string, string> = {
  starter: STARTER_STRATEGY,
  house: HOUSE_STRATEGY,
};

const DIFFICULTIES: Difficulty[] = ['easy', 'normal', 'hard', 'impossible'];
export const isDifficulty = (value: string): value is Difficulty =>
  (DIFFICULTIES as string[]).includes(value);

/** The web bot AI, deciding at the agent cadence and emitting agent actions. */
export class NativeBot {
  #controller = new BotController();
  #random: Random;
  #round = 0;
  constructor(
    readonly difficulty: Difficulty,
    seed: number,
    readonly player: number,
  ) {
    this.#random = new Random((seed ^ Math.imul(player + 1, 0x9e3779b9)) >>> 0);
  }
  decide(state: GameState): AgentAction {
    if (state.round !== this.#round) {
      this.#controller.reset();
      this.#round = state.round;
    }
    const actor = state.actors[this.player];
    if (state.phase !== 'playing' || !actor.alive)
      return { moveX: 0, moveY: 0, aimX: 0, aimY: 0, throw: false, dash: false, melee: false };
    const view: GameState = {
      ...state,
      options: { ...state.options, difficulty: this.difficulty },
    };
    const command = this.#controller.command(view, actor, this.#random, RULES.dt * DECISION_TICKS);
    return {
      moveX: command.move.x,
      moveY: -command.move.y,
      aimX: 0,
      aimY: 0,
      throw: command.throwHeld,
      dash: command.dash,
      melee: command.attack,
    };
  }
}
