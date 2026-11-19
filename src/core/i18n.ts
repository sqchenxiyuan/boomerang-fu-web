/*
 * Player-facing copy in Chinese and English. The game defaults to Chinese;
 * an embedding page picks English with `?lang=en` (see docs/mundi-embed.md).
 * Presentation only: nothing here reaches the simulation or its runtime.
 *
 * Each locale is one object of the same shape, so a missing translation is a
 * type error rather than a blank label.
 */

export type Locale = 'zh' | 'en';

const zh = {
  round: (round: number) => `第 ${round} 回合`,
  ready: '准备',
  go: '开始',
  draw: '平局',
  roundWinner: (player: number) => `P${player} 赢下回合`,
  drawDetail: '同时出局，不计分',
  roundWinnerDetail: '最后站着的人 +1 分',
  matchWinner: (name: string) => `${name}获胜！`,
  paused: '已暂停',
  boundaryOutside: '界外倒计时 · 沿箭头返回安全区',
  boundaryShrinking: '决胜缩圈 · 前往箭头指向的场地',
  boundarySettled: '决胜时刻 · 留在边界内',
  returnIn: (seconds: string) => `返回 ${seconds}s`,
  fallingSave: '下落中 · 冲刺自救',
  falling: '正在下落',
  outFire: '火焰出局',
  outTelefrag: '被传送撞击',
  outCrush: '被机关挤压',
  outSliced: '被切片',
  outExplosion: '爆炸出局',
  outWater: '落水出局',
  outCliff: '坠落出局',
  outBoundary: '界外出局',
  out: '已出局',
  loading: '正在载入游戏…',
  gameLabel: 'Boomerang Fu 对局画面',
  arenaLabel: '回旋花园三维竞技场',
  audioBusy: '已有音频录制正在进行',
  audioCancelled: '声音准备已取消',
  audioUnavailable: '游戏声音未就绪，无法录制有声视频',
  endingPaused: '收尾录制已暂停，请重新生成完整视频',
};

export type Messages = typeof zh;

const en: Messages = {
  round: (round) => `Round ${round}`,
  ready: 'Ready',
  go: 'Go!',
  draw: 'Draw',
  roundWinner: (player) => `P${player} wins the round`,
  drawDetail: 'Both out, no points',
  roundWinnerDetail: 'Last one standing +1',
  matchWinner: (name) => `${name} wins!`,
  paused: 'Paused',
  boundaryOutside: 'Out of bounds · follow the arrows back',
  boundaryShrinking: 'Sudden death · head where the arrows point',
  boundarySettled: 'Sudden death · stay inside the boundary',
  returnIn: (seconds) => `Back in ${seconds}s`,
  fallingSave: 'Falling · dash to recover',
  falling: 'Falling',
  outFire: 'Burned out',
  outTelefrag: 'Telefragged',
  outCrush: 'Crushed',
  outSliced: 'Sliced',
  outExplosion: 'Blown up',
  outWater: 'Fell in the water',
  outCliff: 'Fell off',
  outBoundary: 'Out of bounds',
  out: 'Out',
  loading: 'Loading game…',
  gameLabel: 'Boomerang Fu match',
  arenaLabel: 'Boomerang Garden 3D arena',
  audioBusy: 'An audio recording is already in progress',
  audioCancelled: 'Sound preparation was cancelled',
  audioUnavailable: 'Game sound is not ready; cannot record a video with sound',
  endingPaused: 'The ending recording was paused; please generate the full video again',
};

const MESSAGES: Record<Locale, Messages> = { zh, en };

let current: Locale = 'zh';

export function setLocale(locale: Locale): void {
  current = locale;
}

export function getLocale(): Locale {
  return current;
}

/** The copy for the current locale. */
export function text(): Messages {
  return MESSAGES[current];
}

/** `en`, `en-US`, `zh-CN`… → a supported locale; anything else → the fallback. */
export function parseLocale(value: string | null | undefined, fallback: Locale = 'zh'): Locale {
  const tag = (value ?? '').trim().toLowerCase();
  if (tag === 'en' || tag.startsWith('en-')) return 'en';
  if (tag === 'zh' || tag.startsWith('zh-')) return 'zh';
  return fallback;
}

/** BCP 47 tag for `<html lang>`. */
export const htmlLang = (locale: Locale): string => (locale === 'en' ? 'en' : 'zh-CN');
