import { BotDriver } from '../src/sdk/control';
import type { GameState } from '../src/core/types';
import type { Game } from '../src/simulation/game';

const drivers = new WeakMap<Game, { state: GameState; driver: BotDriver }>();

/** Test adapter only: Game remains a simulation, and this supplies controller decisions. */
export function driveBotGame(game: Game): void {
  let entry = drivers.get(game);
  if (!entry || entry.state !== game.state) {
    entry = { state: game.state, driver: new BotDriver(game.state.options.seed) };
    drivers.set(game, entry);
  }
  const commands = new Map();
  const eventStart = game.state.events.length;
  if (game.state.phase === 'playing' && game.state.hitStop <= 0)
    for (const actor of game.state.actors)
      if (actor.controller === 'bot')
        commands.set(actor.id, entry.driver.command(game.state, actor));
  game.step(commands);
  entry.driver.observe(game.state.events.slice(eventStart));
}
