import { describe, expect, it } from 'vitest';
import { RULES } from '../src/core/config';
import { createScenarioGame, FX_SCENARIOS, stepScenario } from '../src/devtools/fx-scenarios';

describe('dev/fx.html showcase scenarios', () => {
  it('have unique ids', () => {
    expect(new Set(FX_SCENARIOS.map((s) => s.id)).size).toBe(FX_SCENARIOS.length);
  });
  for (const scenario of FX_SCENARIOS)
    it(`${scenario.id}: ${scenario.title} emits ${scenario.expectLabel}`, () => {
      const game = createScenarioGame(scenario);
      const seen: string[] = [];
      let hit = false;
      for (let tick = 0; tick * RULES.dt < scenario.duration; tick++)
        for (const event of stepScenario(game, scenario, tick * RULES.dt)) {
          seen.push(
            `${event.type}${event.feedback ? ':' + event.feedback : ''}${event.variant ? ':' + event.variant : ''}`,
          );
          hit ||= scenario.expect(event);
        }
      expect(hit, `events seen: ${[...new Set(seen)].join(', ') || '(none)'}`).toBe(true);
    });
});
