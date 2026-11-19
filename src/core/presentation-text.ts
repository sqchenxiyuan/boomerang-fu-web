import { text } from './i18n';
import type { PresentationState, TransitionPresentation } from './presentation';

/**
 * The round banner's label and subtitle in the current locale.
 *
 * `transitionPresentation` stays locale-free because the simulation imports
 * its module for timings: keeping copy out of it keeps the headless runtime
 * byte-identical whatever the display language.
 */
export function presentationText(
  state: PresentationState,
  presentation: TransitionPresentation,
): { label: string; subtitle: string } {
  const copy = text();
  switch (presentation.stage) {
    case 'reveal':
    case 'spawn':
    case 'ready':
      return { label: presentation.label ? copy.ready : '', subtitle: copy.round(state.round) };
    case 'go':
      return { label: copy.go, subtitle: '' };
    case 'result':
    case 'close':
    case 'score':
      return state.winnerId === null
        ? { label: copy.draw, subtitle: copy.drawDetail }
        : { label: copy.roundWinner(state.winnerId + 1), subtitle: copy.roundWinnerDetail };
    default:
      return { label: presentation.label, subtitle: presentation.subtitle };
  }
}
