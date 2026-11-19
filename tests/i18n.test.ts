import { afterEach, describe, expect, it } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { getLocale, parseLocale, setLocale, text } from '../src/core/i18n';
import { transitionPresentation, type PresentationState } from '../src/core/presentation';
import { presentationText } from '../src/core/presentation-text';
import { boundaryNotice, eliminationLabel } from '../src/core/feedback';
import { Game } from '../src/simulation/game';
import { defaultOptions } from '../src/simulation/state';
import { DISPLAY_LOCALES, displaySettings } from '../src/mundi/host';

const CJK = /[㐀-鿿！-～]/;
const sample = (value: unknown): string =>
  typeof value === 'function'
    ? String((value as (...args: unknown[]) => string)(7, 'Ann'))
    : String(value);

afterEach(() => setLocale('zh'));

describe('display language', () => {
  it('has every message in both languages, and English without Chinese', () => {
    setLocale('zh');
    const zh = text();
    setLocale('en');
    const en = text();
    expect(Object.keys(en).sort()).toEqual(Object.keys(zh).sort());
    for (const key of Object.keys(zh) as (keyof typeof zh)[]) {
      expect(typeof en[key]).toBe(typeof zh[key]);
      const english = sample(en[key]);
      expect(english.length, key).toBeGreaterThan(0);
      expect(CJK.test(english), `${key}: ${english}`).toBe(false);
    }
    expect(en.round(3)).toBe('Round 3');
    expect(en.matchWinner('Ann')).toBe('Ann wins!');
  });

  it('defaults to Chinese and reads common language tags', () => {
    expect(getLocale()).toBe('zh');
    expect(text().round(2)).toBe('第 2 回合');
    expect(parseLocale('en')).toBe('en');
    expect(parseLocale('en-US')).toBe('en');
    expect(parseLocale('zh-CN')).toBe('zh');
    expect(parseLocale('fr')).toBe('zh');
    expect(parseLocale(undefined, 'en')).toBe('en');
  });

  it('localises the round banner at every stage without touching the presentation timings', () => {
    const base: PresentationState = {
      phase: 'countdown',
      phaseTime: 99,
      round: 4,
      winnerId: null,
      actors: [
        { id: 0, score: 1 },
        { id: 1, score: 2 },
      ],
    };
    const states: PresentationState[] = [
      base,
      { ...base, phase: 'playing', phaseTime: 0.1 },
      { ...base, phase: 'roundEnd', phaseTime: 0.2, winnerId: 1 },
      { ...base, phase: 'roundEnd', phaseTime: 0.2, winnerId: null },
    ];
    const zh = states.map((state) => presentationText(state, transitionPresentation(state)));
    setLocale('en');
    const en = states.map((state) => presentationText(state, transitionPresentation(state)));
    expect(zh).toEqual([
      { label: '准备', subtitle: '第 4 回合' },
      { label: '开始', subtitle: '' },
      { label: 'P2 赢下回合', subtitle: '最后站着的人 +1 分' },
      { label: '平局', subtitle: '同时出局，不计分' },
    ]);
    expect(en).toEqual([
      { label: 'Ready', subtitle: 'Round 4' },
      { label: 'Go!', subtitle: '' },
      { label: 'P2 wins the round', subtitle: 'Last one standing +1' },
      { label: 'Draw', subtitle: 'Both out, no points' },
    ]);
    // The locale-free source keeps its own copy, so the simulation never depends on it.
    expect(transitionPresentation(states[0]).label).toBe('准备');
  });

  it('localises boundary notices and elimination labels', () => {
    const game = new Game(defaultOptions());
    game.state.phase = 'playing';
    game.state.boundary.phase = 'shrinking';
    expect(boundaryNotice(game.state)).toBe('决胜缩圈 · 前往箭头指向的场地');
    const actor = game.state.actors[0];
    actor.alive = false;
    actor.death = { ...(actor.death ?? {}), cause: 'fire' } as typeof actor.death;
    expect(eliminationLabel(actor)).toBe('火焰出局');
    setLocale('en');
    expect(boundaryNotice(game.state)).toBe('Sudden death · head where the arrows point');
    expect(eliminationLabel(actor)).toBe('Burned out');
  });

  it('lets the platform choose the language through display settings', () => {
    expect(DISPLAY_LOCALES).toEqual(['zh', 'en']);
    expect(displaySettings({ locale: 'en' })).toEqual({ locale: 'en' });
    // Unknown keys are ignored so newer platforms can send more settings.
    expect(displaySettings({ theme: 'dark' })).toEqual({});
    expect(displaySettings(undefined)).toEqual({});
    expect(() => displaySettings({ locale: 'fr' })).toThrow(/locale/);
  });

  it('keeps hard-coded Chinese out of the MUNDI embed source', () => {
    const dir = new URL('../src/mundi/', import.meta.url);
    for (const file of readdirSync(dir).filter((name) => name.endsWith('.ts'))) {
      const code = readFileSync(new URL(file, dir), 'utf8')
        .split('\n')
        .filter((line) => !/^\s*(\/\/|\*|\/\*)/.test(line));
      const hits = code.filter((line) => CJK.test(line));
      expect(hits, file).toEqual([]);
    }
  });
});
