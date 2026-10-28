/** A trusted JS controller: observes detached state, returns controls, never edits game state. */
export function createDuelController() {
  return ({ state, actorId, tick }) => {
    const actor = state.actors.find((item) => item.id === actorId);
    if (!actor?.alive) return {};
    const enemy = state.actors
      .filter((item) => item.alive && item.id !== actorId)
      .sort(
        (a, b) =>
          Math.hypot(a.position.x - actor.position.x, a.position.y - actor.position.y) -
          Math.hypot(b.position.x - actor.position.x, b.position.y - actor.position.y),
      )[0];
    if (!enemy) return {};
    const dx = enemy.position.x - actor.position.x;
    const dy = enemy.position.y - actor.position.y;
    const distance = Math.hypot(dx, dy) || 1;
    const aim = { x: dx / distance, y: dy / distance };
    const charging = actor.armed && tick % 140 < 48 && distance > 2.5;
    return {
      move:
        charging || distance > 6
          ? aim
          : distance < 2.3
            ? { x: -aim.x, y: -aim.y }
            : { x: -aim.y, y: aim.x },
      attack: distance < 2 && tick % 50 === 0,
      throw: actor.armed ? charging : true,
      dash: distance < 1.7 && tick % 90 === 0,
    };
  };
}
