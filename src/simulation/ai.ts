import { lineOfSight, safePosition, segmentCircle } from '../core/collision';
import { RULES } from '../core/config';
import { add, distance, dot, length, mul, normalize, rotate, sub, v } from '../core/math';
import type { Random, Vec2 } from '../core/math';
import { idleCommand } from '../core/types';
import type { Actor, Command, GameState } from '../core/types';
import { advancePath, findPath } from './navigation';
import type { NavigationWaypoint } from './navigation';
import { clampToBoundary, isInBoundary } from './boundary';

interface Brain {
  thinkIn: number;
  move: Vec2;
  chargeFor: number;
  attackIn: number;
  path: NavigationWaypoint[];
  goal: Vec2;
  pathAge: number;
  strafe: number;
  portalEscapeIn: number;
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
      };
      this.brains.set(actor.id, brain);
    }
    const command = idleCommand();
    if (!actor.alive) return command;
    if ((actor.frozenTime ?? 0) > 0) {
      command.attack = (actor.freezeChipCooldown ?? 0) <= dt;
      return command;
    }
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
    const reaction =
      state.options.difficulty === 'easy' ? 0.35 : state.options.difficulty === 'hard' ? 0.1 : 0.2;

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
      if (danger) {
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
}
