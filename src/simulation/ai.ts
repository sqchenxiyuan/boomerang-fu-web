import { lineOfSight, safePosition, segmentCircle } from '../core/collision';
import { RULES } from '../core/config';
import { add, distance, dot, length, mul, normalize, rotate, sub, v } from '../core/math';
import type { Random, Vec2 } from '../core/math';
import { idleCommand } from '../core/types';
import type { Actor, Command, GameState } from '../core/types';
import { advancePath, findFloorEscape, findPath, threatenedFloor } from './navigation';
import type { NavigationWaypoint } from './navigation';
import { clampToBoundary, isInBoundary } from './boundary';
import { canRescueFall } from './hazards';
import {
  DASH_REACH,
  HIT_DISTANCE,
  WALK_SPEED,
  discThreats,
  pathClearance,
  escapeDirections,
  safeLanding,
  type DiscThreat,
} from './ai-threats';
import { heldDiscs } from './inventory';
import { meleePolygon, circleTouchesPolygon } from './combat';
import { NATIVE } from '../core/config';

/**
 * Evasion skill per difficulty: perception delay for a new threat, the chance a
 * bot answers it at all, how often it bats a disc away instead of moving, and
 * how often it side-steps an opponent who is aiming at it.
 */
const DODGE: Record<string, { reaction: number; skill: number; parry: number; strafe: number }> = {
  easy: { reaction: 0.4, skill: 0.35, parry: 0.15, strafe: 0.2 },
  normal: { reaction: 0.22, skill: 0.72, parry: 0.35, strafe: 0.55 },
  hard: { reaction: 0.12, skill: 0.9, parry: 0.6, strafe: 0.8 },
  impossible: { reaction: 0.05, skill: 1, parry: 0.8, strafe: 1 },
};

/** Web planning interval per difficulty; Impossible follows the reference's fastest band. */
const THINK: Record<string, number> = { easy: 0.35, normal: 0.2, hard: 0.1, impossible: 0.07 };
/** PlayerAI.SetDifficulty reaction times (seconds): delay before reacting to a new threat. */
const REACTION: Record<string, readonly number[]> = {
  easy: [0.6, 0.7, 0.85],
  normal: [0.41, 0.52, 0.63],
  hard: [0.1, 0.25, 0.35],
  impossible: [0.07, 0.13, 0.2],
};
/** Web adaptation: how often a bot uses its one mid-air dash rescue. */
const RESCUE: Record<string, number> = { easy: 0.4, normal: 0.75, hard: 0.95, impossible: 1 };

interface Brain {
  rescueRoll?: number;
  /** First sighting and skill roll per threatening disc id. */
  seen?: Record<number, { at: number; roll: number }>;
  evadeUntil?: number;
  evadeMove?: Vec2;
  meleeRoll?: { attacker: number; serial: number; roll: number; at: number };
  /** Opponents seen aiming at this bot, and since when: their release is anticipated. */
  watch?: Record<number, number>;
  aimRoll?: { attacker: number; roll: number; at: number };
  /** Simulation time at which the current incoming disc may be answered. */
  reactAt?: number;
  thinkIn: number;
  move: Vec2;
  chargeFor: number;
  attackIn: number;
  path: NavigationWaypoint[];
  goal: Vec2;
  pathAge: number;
  strafe: number;
  portalEscapeIn: number;
  floorEscapeIn: number;
  floorEscape?: Vec2 | null;
  escapingFloor: boolean;
}

export class BotController {
  private brains = new Map<number, Brain>();
  reset(): void {
    this.brains.clear();
  }
  resetActor(id: number): void {
    this.brains.delete(id);
  }

  command(state: GameState, actor: Actor, random: Random, dt: number): Command {
    let brain = this.brains.get(actor.id);
    if (!brain) {
      brain = {
        thinkIn: 0,
        move: v(),
        chargeFor: -1,
        attackIn: 0.4,
        path: [],
        goal: v(100, 100),
        pathAge: 0,
        strafe: random.next() > 0.5 ? 1 : -1,
        portalEscapeIn: (actor.portalCooldown ?? 0) > 0 ? 0.65 : 0,
        floorEscapeIn: 0,
        escapingFloor: false,
      };
      this.brains.set(actor.id, brain);
    }
    const command = idleCommand();
    if (!actor.alive) return command;
    // A fresh fall gets one roll; a successful bot dashes back toward solid ground.
    if (actor.fall) {
      brain.rescueRoll ??= random.next();
      if (
        brain.rescueRoll < (RESCUE[state.options.difficulty] ?? 0.75) &&
        canRescueFall(actor) &&
        actor.dashCooldown <= 0
      ) {
        const back =
          length(actor.velocity) > 0.05
            ? mul(normalize(actor.velocity), -1)
            : mul(actor.facing, -1);
        const escape = findFloorEscape(state.arena, actor.position, back);
        command.move = escape ? normalize(sub(escape, actor.position)) : back;
        command.dash = true;
      }
      return command;
    }
    brain.rescueRoll = undefined;
    const evasion = this.evade(state, actor, brain, random);
    if (evasion) return evasion;
    if ((actor.frozenTime ?? 0) > 0) {
      command.attack = (actor.freezeChipCooldown ?? 0) <= dt;
      return command;
    }
    if (threatenedFloor(state.arena, actor.position)) {
      brain.floorEscapeIn -= dt;
      if (!brain.escapingFloor || brain.floorEscapeIn <= 0) {
        brain.floorEscape = findFloorEscape(
          state.arena,
          actor.position,
          length(actor.velocity) > 0.1 ? actor.velocity : actor.facing,
        );
        // Failed searches also have a finite reaction interval; a corner must
        // not trigger an exhaustive new escape search on all 60 ticks.
        brain.floorEscapeIn = 0.2;
      }
      brain.escapingFloor = true;
      if (brain.floorEscape) {
        command.move = normalize(sub(brain.floorEscape, actor.position));
        brain.chargeFor = -1;
        return command;
      }
    } else brain.escapingFloor = false;
    if (brain.portalEscapeIn > 0) {
      brain.portalEscapeIn -= dt;
      const exit = [...(state.arena.portals ?? [])].sort(
        (a, b) => distance(a.position, actor.position) - distance(b.position, actor.position),
      )[0];
      if (exit) {
        command.move = { ...exit.direction };
        return command;
      }
    }
    const decoyTargets = state.decoys
      .filter((decoy) => decoy.alive && decoy.ownerId !== actor.id)
      .map((decoy) => ({
        ...state.actors.find((candidate) => candidate.id === decoy.ownerId)!,
        position: decoy.position,
        previous: decoy.previous,
        velocity: decoy.velocity,
        id: -decoy.id - 1,
        disguised: false,
        attackTime: 0,
      }));
    const enemy = [...state.actors, ...decoyTargets]
      .filter(
        (a) =>
          a.alive &&
          a.id !== actor.id &&
          (!a.disguised || distance(a.position, actor.position) < 1.4),
      )
      .sort(
        (a, b) => distance(actor.position, a.position) - distance(actor.position, b.position),
      )[0];
    if (!enemy) {
      if (!isInBoundary(state.boundary, actor.position, RULES.playerRadius)) {
        const path = findPath(state.arena, actor.position, state.boundary.center);
        if (path.length) command.move = normalize(sub(path[0], actor.position));
      } else {
        // A concealed opponent does not remain a perfect-information target.
        brain.pathAge += dt;
        if (brain.path.length === 0 || brain.pathAge > 2) {
          const goal = random.pick([...state.arena.pickupSpawns, v()]);
          brain.path = findPath(state.arena, actor.position, goal);
          brain.pathAge = 0;
        }
        advancePath(brain.path, actor.position);
        if (brain.path.length) command.move = normalize(sub(brain.path[0], actor.position));
      }
      return command;
    }
    const escapingBoundary =
      state.boundary.phase !== 'idle' && !isInBoundary(state.boundary, actor.position, 1.2);
    brain.thinkIn -= dt;
    brain.attackIn -= dt;
    brain.pathAge += dt;
    const delta = sub(enemy.position, actor.position),
      d = length(delta),
      towards = normalize(delta);
    const sight = lineOfSight(state.arena, actor.position, enemy.position);
    const reaction = THINK[state.options.difficulty] ?? THINK.normal;

    if (brain.thinkIn <= 0) {
      brain.thinkIn = reaction;
      let goal = { ...enemy.position };
      const pickup = [...state.pickups]
        .filter(
          (p) =>
            p.kind !== 'reverse' &&
            !actor.powers.includes(p.kind) &&
            distance(actor.position, p.position) < d + 2,
        )
        .sort(
          (a, b) => distance(actor.position, a.position) - distance(actor.position, b.position),
        )[0];
      if (pickup && d > 3) goal = pickup.position;
      else if (
        d < 3.2 &&
        (actor.attackCooldown > 0.1 || enemy.attackTime > 0.03 || brain.attackIn > 0.25)
      )
        goal = add(actor.position, mul(rotate(towards, brain.strafe * 0.65), -3));
      else if (d < 5 && !actor.armed)
        goal = add(actor.position, mul(rotate(towards, brain.strafe * 0.55), -3));
      else if (sight && d > 3.2 && d < 8.5 && actor.armed)
        goal = add(actor.position, mul(rotate(towards, brain.strafe * 1.1), 1.5));
      // Retreat goals stay inside the boundary even before it shrinks: leaving it kills.
      if (state.boundary.phase === 'idle')
        goal = clampToBoundary(state.boundary, goal, RULES.playerRadius + 0.8);
      if (state.boundary.phase !== 'idle') {
        if (escapingBoundary) goal = { ...state.boundary.center };
        goal = clampToBoundary(state.boundary, goal, RULES.playerRadius + 0.2);
        // A random original target can overlap water or a wall. Pick a traversable
        // navigation goal inside the rectangle without changing the shrink target.
        if (!safePosition(state.arena, goal, RULES.playerRadius + 0.13)) {
          let nearest = Infinity;
          const desiredGoal = { ...goal };
          for (
            let x = Math.ceil(state.boundary.center.x - state.boundary.halfSize.x);
            x < state.boundary.center.x + state.boundary.halfSize.x;
            x++
          )
            for (
              let y = Math.ceil(state.boundary.center.y - state.boundary.halfSize.y);
              y < state.boundary.center.y + state.boundary.halfSize.y;
              y++
            ) {
              const candidate = v(x, y),
                d = distance(candidate, desiredGoal);
              if (
                d < nearest &&
                isInBoundary(state.boundary, candidate, RULES.playerRadius + 0.13) &&
                safePosition(state.arena, candidate, RULES.playerRadius + 0.13)
              ) {
                nearest = d;
                goal = candidate;
              }
            }
        }
      }
      if (distance(goal, brain.goal) > 1.5 || brain.pathAge > 0.65 || brain.path.length === 0) {
        brain.goal = { ...goal };
        brain.path = findPath(state.arena, actor.position, goal);
        brain.pathAge = 0;
      }
      advancePath(brain.path, actor.position);
      brain.move = brain.path.length ? normalize(sub(brain.path[0], actor.position)) : towards;
      if (
        !escapingBoundary &&
        brain.attackIn <= 0 &&
        actor.attackCooldown <= 0 &&
        d < 2.1 &&
        sight
      ) {
        brain.move = towards;
        command.attack = true;
        // Movement is locked for 0.5 s after a lunge. Leave time to actually retreat
        // before recommitting, otherwise two bots remain in a perpetual clash loop.
        brain.attackIn = RULES.attackCooldown + random.range(0.5, 1.1);
      }
      if (
        !escapingBoundary &&
        actor.armed &&
        actor.attackCooldown <= 0 &&
        sight &&
        d >= 2.2 &&
        d < 12 &&
        brain.chargeFor < 0
      )
        brain.chargeFor =
          random.range(0.12, 0.6) + (state.options.difficulty === 'easy' ? 0.15 : 0);
      // React to approaching hostile discs, with a finite decision interval.
      const danger = state.discs.find(
        (disc) =>
          disc.state !== 'dropped' &&
          disc.damageOwnerId !== actor.id &&
          segmentCircle(disc.position, mul(disc.velocity, 0.3), actor.position, 1),
      );
      if (!danger) brain.reactAt = undefined;
      else
        brain.reactAt ??=
          state.time + random.pick([...(REACTION[state.options.difficulty] ?? REACTION.normal)]);
      if (danger && state.time >= (brain.reactAt ?? 0)) {
        const perpendicular = normalize(v(-danger.velocity.y, danger.velocity.x));
        const candidates = [perpendicular, mul(perpendicular, -1)];
        const dodge = candidates.find(
          (dir) =>
            isInBoundary(state.boundary, add(actor.position, mul(dir, 3.1)), RULES.playerRadius) &&
            safePosition(state.arena, add(actor.position, mul(dir, 3.1)), RULES.playerRadius + 0.2),
        );
        if (dodge && actor.dashCooldown <= 0) {
          brain.move = dodge;
          command.dash = true;
          brain.chargeFor = -1;
        } else if (actor.armed && actor.attackCooldown <= 0) {
          brain.move = normalize(sub(danger.position, actor.position));
          command.attack = true;
        }
      }
      const hazard = state.zones.find(
        (zone) => distance(zone.position, actor.position) < zone.radius + 1.2,
      );
      if (hazard || (actor.burnTime ?? 0) > 0) {
        const away = hazard ? normalize(sub(actor.position, hazard.position)) : brain.move;
        const directions = [away, rotate(away, Math.PI / 2), rotate(away, -Math.PI / 2)];
        const escape = directions.find(
          (direction) =>
            length(direction) > 0.1 &&
            safePosition(state.arena, add(actor.position, mul(direction, 4)), RULES.playerRadius) &&
            isInBoundary(
              state.boundary,
              add(actor.position, mul(direction, 4)),
              RULES.playerRadius,
            ),
        );
        if (escape) {
          brain.move = escape;
          brain.chargeFor = -1;
          command.dash = actor.dashCooldown <= 0;
        }
      }
      if (
        state.roundTime > 6 &&
        d > 9 &&
        random.next() < 0.08 &&
        safePosition(
          state.arena,
          add(actor.position, mul(brain.move, 3.1)),
          RULES.playerRadius + 0.3,
        )
      )
        command.dash = true;
    }
    command.move = brain.move;
    if (escapingBoundary) brain.chargeFor = -1;
    if (brain.chargeFor >= 0 && actor.armed && !command.dash && !command.attack) {
      brain.chargeFor -= dt;
      // Small leading aim via the same direction input used by humans.
      const predicted = add(enemy.position, mul(enemy.velocity, (d / RULES.discSpeed) * 0.65));
      command.move = normalize(sub(predicted, actor.position));
      if (brain.chargeFor <= 0) {
        command.throwReleased = true;
        brain.chargeFor = -1;
      } else command.throwHeld = true;
    }
    if (!actor.armed && !escapingBoundary) {
      brain.chargeFor = -1;
      const disc = state.discs.find((p) => p.ownerId === actor.id);
      command.throwHeld = !!disc && !disc.explosive && (disc.state === 'dropped' || disc.age > 0.9);
      if (disc?.powers?.includes('controlled') && disc.age > 0.2 && sight) {
        command.throwHeld = true;
        command.move = normalize(sub(enemy.position, disc.position));
      }
      if (
        actor.powers.includes('teleport') &&
        disc &&
        d < 3 &&
        distance(actor.position, disc.position) > 4 &&
        safePosition(state.arena, disc.position, RULES.playerRadius) &&
        isInBoundary(state.boundary, disc.position, RULES.playerRadius)
      )
        command.dash = true;
    }
    // Do not keep dashing toward a stale target around a corner.
    if (
      command.dash &&
      !(
        actor.powers.includes('teleport') &&
        state.discs.some(
          (disc) =>
            disc.ownerId === actor.id &&
            !disc.dead &&
            safePosition(state.arena, disc.position, RULES.playerRadius),
        )
      ) &&
      (dot(command.move, command.move) < 0.1 ||
        !isInBoundary(
          state.boundary,
          add(actor.position, mul(normalize(command.move), 3.1)),
          RULES.playerRadius,
        ) ||
        !safePosition(
          state.arena,
          add(actor.position, mul(normalize(command.move), 3.1)),
          RULES.playerRadius,
        ))
    )
      command.dash = false;
    return command;
  }

  /** Answers incoming discs, swings and aimed shots before ordinary planning. */
  private evade(state: GameState, actor: Actor, brain: Brain, random: Random): Command | null {
    if ((actor.frozenTime ?? 0) > 0 || actor.stun > 0) return null;
    const profile = DODGE[state.options.difficulty] ?? DODGE.normal;
    const now = state.time;
    const command = idleCommand();
    const canDash = actor.dashCooldown <= 0 && actor.lungeRecovery <= 0 && !actor.fall;
    const canSwing =
      heldDiscs(actor) > 0 && (actor.attacksLeft ?? 1) > 0 && !actor.aiming && !actor.fall;
    // Watching an opponent charge at us lets the bot react to the release at once.
    const watch = (brain.watch ??= {});
    for (const enemy of state.actors) {
      if (enemy.id === actor.id) continue;
      const toMe = sub(actor.position, enemy.position);
      const aiming =
        enemy.alive &&
        enemy.charge > 0.1 &&
        length(toMe) < 14 &&
        dot(normalize(toMe), enemy.facing) > 0.9 &&
        lineOfSight(state.arena, enemy.position, actor.position);
      if (aiming) watch[enemy.id] ??= now;
      else if (enemy.charge <= 0 && (watch[enemy.id] ?? now) < now - 0.6) delete watch[enemy.id];
    }
    const threats = discThreats(state, actor);
    const seen = (brain.seen ??= {});
    const live = new Set(threats.map((threat) => threat.disc.id));
    for (const id of Object.keys(seen)) if (!live.has(Number(id))) delete seen[Number(id)];
    for (const threat of threats) {
      const watched = watch[threat.disc.ownerId];
      const anticipated =
        watched !== undefined && now - watched >= profile.reaction && threat.disc.age < 0.25;
      const entry = (seen[threat.disc.id] ??= {
        at: anticipated ? now - profile.reaction : now,
        roll: random.next(),
      });
      if (now - entry.at < profile.reaction || entry.roll > profile.skill) continue;
      const answer = this.answerDisc(state, actor, threat, entry.roll / profile.skill, profile, {
        canDash,
        canSwing,
      });
      if (answer) return answer;
    }
    // Burning: only distance travelled puts the fire out, so run (and dash) clear of flames.
    if ((actor.burnTime ?? 0) > 0) {
      const heading =
        brain.evadeMove && (brain.evadeUntil ?? 0) > now - 0.5
          ? brain.evadeMove
          : length(actor.velocity) > 0.5
            ? normalize(actor.velocity)
            : actor.facing;
      const flames = (point: Vec2): number =>
        state.zones.filter(
          (zone) => zone.kind === 'fire' && distance(zone.position, point) < zone.radius + 0.5,
        ).length;
      let best: { dir: Vec2; score: number } | null = null;
      for (let i = 0; i < 12; i++) {
        const dir = rotate(heading, (i * Math.PI) / 6);
        const probe = add(actor.position, mul(dir, 2.2));
        if (!safeLanding(state, probe)) continue;
        const score =
          dot(dir, heading) -
          flames(probe) * 0.6 -
          flames(add(actor.position, mul(dir, 1.1))) * 0.6;
        if (!best || score > best.score) best = { dir, score };
      }
      if (best) {
        brain.evadeMove = best.dir;
        brain.evadeUntil = now + 0.3;
        command.move = best.dir;
        // Only dash when the whole dash lands on safe ground, not just the walking probe.
        command.dash =
          canDash &&
          safeLanding(state, add(actor.position, mul(best.dir, DASH_REACH))) &&
          random.next() < profile.skill;
        return command;
      }
    }
    // Keep stepping out of a predicted line for a moment, without jitter.
    if ((brain.evadeUntil ?? 0) > now && brain.evadeMove) {
      command.move = brain.evadeMove;
      return command;
    }
    // A swing already coming at us: block with a counter-swing, or dash clear.
    for (const enemy of state.actors) {
      if (enemy.id === actor.id || !enemy.alive || !(enemy.attackTime > 0 && enemy.attackArmed))
        continue;
      if (!circleTouchesPolygon(actor.position, NATIVE.damageRadius + 0.35, meleePolygon(enemy)))
        continue;
      if (brain.meleeRoll?.attacker !== enemy.id || brain.meleeRoll.serial !== enemy.attackSerial)
        brain.meleeRoll = {
          attacker: enemy.id,
          serial: enemy.attackSerial,
          roll: random.next(),
          at: now,
        };
      const roll = brain.meleeRoll.roll;
      if (now - brain.meleeRoll.at < profile.reaction * 0.5 || roll > profile.skill) continue;
      const toward = normalize(sub(enemy.position, actor.position));
      if (canSwing && roll < profile.parry) {
        command.attack = true;
        command.move = toward;
        return command;
      }
      if (canDash) {
        const away = this.safestDash(state, actor, mul(toward, -1), []);
        if (away) {
          command.dash = true;
          command.move = away;
          return command;
        }
      }
    }
    // An opponent lining up a charged throw: strafe across the line of fire.
    for (const enemy of state.actors) {
      if (enemy.id === actor.id || !enemy.alive || enemy.charge < 0.25) continue;
      const toMe = sub(actor.position, enemy.position);
      if (length(toMe) > 13 || dot(normalize(toMe), enemy.facing) < 0.96) continue;
      if (!lineOfSight(state.arena, enemy.position, actor.position)) continue;
      if (brain.aimRoll?.attacker !== enemy.id || now - brain.aimRoll.at > 0.8)
        brain.aimRoll = { attacker: enemy.id, roll: random.next(), at: now };
      if (brain.aimRoll.roll > profile.strafe || now - brain.aimRoll.at < profile.reaction)
        continue;
      const side = normalize(v(-toMe.y, toMe.x));
      const choice = [side, mul(side, -1)].find((dir) =>
        safeLanding(state, add(actor.position, mul(dir, 1.6))),
      );
      if (!choice) continue;
      brain.evadeMove = choice;
      brain.evadeUntil = now + 0.35;
      command.move = choice;
      return command;
    }
    return null;
  }

  private answerDisc(
    state: GameState,
    actor: Actor,
    threat: DiscThreat,
    luck: number,
    profile: { parry: number },
    can: { canDash: boolean; canSwing: boolean },
  ): Command | null {
    const command = idleCommand();
    const t = threat.time;
    const toDisc = normalize(sub(threat.disc.position, actor.position));
    // Bat it away when it arrives inside the 0.2 s swing; never a charged one (stun).
    if (can.canSwing && !threat.charged && t >= 0.02 && t <= 0.22 && luck < profile.parry) {
      command.attack = true;
      command.move = toDisc;
      return command;
    }
    // Imminent: dash. The dash itself is invulnerable, so only the landing matters.
    if (can.canDash && t <= 0.42) {
      const dir = this.safestDash(state, actor, threat.heading, [threat]);
      if (dir) {
        command.dash = true;
        command.move = dir;
        return command;
      }
    }
    // Time to walk out of the line.
    if (t > 0.16) {
      let best: { dir: Vec2; score: number } | null = null;
      for (const dir of escapeDirections(threat.heading)) {
        const probe = add(actor.position, mul(dir, Math.min(1.6, WALK_SPEED * t)));
        if (!safeLanding(state, probe)) continue;
        const score = pathClearance(state, threat.disc, (s) =>
          add(actor.position, mul(dir, WALK_SPEED * 0.75 * Math.max(0, s - 0.03))),
        );
        if (!best || score > best.score) best = { dir, score };
      }
      if (best && best.score > threat.miss + 0.05) {
        const brain = this.brains.get(actor.id)!;
        brain.evadeMove = best.dir;
        brain.evadeUntil = state.time + Math.min(0.4, t + 0.1);
        command.move = best.dir;
        return command;
      }
    }
    if (can.canDash) {
      const dir = this.safestDash(state, actor, threat.heading, [threat], true);
      if (dir) {
        command.dash = true;
        command.move = dir;
        return command;
      }
    }
    return null;
  }

  /** The dash direction whose path stays clear of the given discs and lands safely. */
  private safestDash(
    state: GameState,
    actor: Actor,
    heading: Vec2,
    threats: readonly DiscThreat[],
    desperate = false,
  ): Vec2 | null {
    let best: { dir: Vec2; score: number } | null = null;
    for (const dir of escapeDirections(heading)) {
      const end = add(actor.position, mul(dir, DASH_REACH * 0.85));
      const mid = add(actor.position, mul(dir, DASH_REACH * 0.45));
      if (!safeLanding(state, end) || !safeLanding(state, mid, 0)) continue;
      // Position along the dash: most of the reach within its 0.2 s, then a short slide.
      const at = (s: number): Vec2 =>
        add(
          actor.position,
          mul(dir, DASH_REACH * Math.min(1, (s / 0.22) * 0.8 + Math.max(0, s - 0.22))),
        );
      let score = 10;
      for (const threat of threats)
        score = Math.min(score, pathClearance(state, threat.disc, at, NATIVE.actor.dashDuration));
      if (!best || score > best.score) best = { dir, score };
    }
    if (!best) return null;
    return desperate || best.score > HIT_DISTANCE + 0.15 ? best.dir : null;
  }
}
