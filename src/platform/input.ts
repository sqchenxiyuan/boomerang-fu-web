import { clampLength, v } from '../core/math';
import { idleCommand } from '../core/types';
import type { Command } from '../core/types';

type Bindings = {
  up: string;
  down: string;
  left: string;
  right: string;
  dash: string[];
  attack: string[];
  throw: string[];
};
const BINDINGS: Bindings[] = [
  {
    up: 'KeyW',
    down: 'KeyS',
    left: 'KeyA',
    right: 'KeyD',
    dash: ['KeyL', 'Space'],
    attack: ['KeyJ'],
    throw: ['KeyK'],
  },
  {
    up: 'ArrowUp',
    down: 'ArrowDown',
    left: 'ArrowLeft',
    right: 'ArrowRight',
    dash: ['Slash', 'Numpad3'],
    attack: ['Comma', 'Numpad1'],
    throw: ['Period', 'Numpad2'],
  },
];
const GAME_KEYS = new Set(
  BINDINGS.flatMap((b) => [b.up, b.down, b.left, b.right, ...b.dash, ...b.attack, ...b.throw]),
);

export class Input {
  private held = new Set<string>();
  private pressed = new Set<string>();
  private released = new Set<string>();
  private padPrevious = new Map<number, boolean[]>();
  private padSystemPrevious = new Map<number, boolean>();
  private padBlocked = new Map<number, Set<number>>();
  private blocked = new Set<string>();
  private enabled = false;
  onPause = (): void => {};
  onSound = (): void => {};

  constructor(private readonly target?: HTMLElement) {
    window.addEventListener('keydown', this.keyDown);
    window.addEventListener('keyup', this.keyUp);
    window.addEventListener('blur', this.clear);
  }

  private keyDown = (event: KeyboardEvent): void => {
    if (this.target && !this.target.contains(document.activeElement)) return;
    if (
      event.target instanceof HTMLInputElement ||
      event.target instanceof HTMLSelectElement ||
      event.target instanceof HTMLTextAreaElement
    )
      return;
    if (event.code === 'Escape' && !event.repeat) {
      event.preventDefault();
      this.onPause();
      return;
    }
    if (event.code === 'KeyM' && !event.repeat) {
      this.onSound();
      return;
    }
    if (this.enabled && GAME_KEYS.has(event.code)) event.preventDefault();
    if (!this.enabled || (this.blocked.has(event.code) && event.repeat)) return;
    this.blocked.delete(event.code);
    if (!this.held.has(event.code)) this.pressed.add(event.code);
    this.held.add(event.code);
  };
  private keyUp = (event: KeyboardEvent): void => {
    this.blocked.delete(event.code);
    if (this.held.has(event.code)) this.released.add(event.code);
    this.held.delete(event.code);
  };

  clear = (): void => {
    // Releasing a key held before a pause must not create a throw on resume.
    for (const key of this.held) this.blocked.add(key);
    this.held.clear();
    this.pressed.clear();
    this.released.clear();
    this.padPrevious.clear();
    for (const pad of Array.from(navigator.getGamepads?.() ?? []))
      if (pad)
        this.padBlocked.set(
          pad.index,
          new Set(pad.buttons.flatMap((button, index) => (button.pressed ? [index] : []))),
        );
  };

  setEnabled(enabled: boolean): void {
    if (this.enabled !== enabled) this.clear();
    this.enabled = enabled;
  }

  pollSystemButtons(): void {
    if (this.target && !this.target.contains(document.activeElement)) return;
    let toggle = false;
    for (const pad of Array.from(navigator.getGamepads?.() ?? [])) {
      if (!pad?.connected) continue;
      const pressed = pad.buttons[9]?.pressed ?? false;
      if (pressed && !this.padSystemPrevious.get(pad.index)) toggle = true;
      this.padSystemPrevious.set(pad.index, pressed);
    }
    if (toggle) this.onPause();
  }

  read(playerCount: number): Map<number, Command> {
    if (this.target && !this.target.contains(document.activeElement)) {
      this.clear();
      return new Map(Array.from({ length: playerCount }, (_, index) => [index, idleCommand()]));
    }
    const commands = new Map<number, Command>();
    const pads = Array.from(navigator.getGamepads?.() ?? []).filter(
      (p): p is Gamepad => p !== null && p.connected,
    );
    for (let i = 0; i < playerCount; i++) {
      const command = idleCommand(),
        binding = BINDINGS[i];
      if (!this.enabled || !binding) {
        commands.set(i, command);
        continue;
      }
      command.move = v(
        Number(this.held.has(binding.right)) - Number(this.held.has(binding.left)),
        Number(this.held.has(binding.down)) - Number(this.held.has(binding.up)),
      );
      command.dash = binding.dash.some((k) => this.pressed.has(k));
      command.attack = binding.attack.some((k) => this.pressed.has(k));
      command.throwHeld = binding.throw.some((k) => this.held.has(k));
      command.throwReleased = binding.throw.some((k) => this.released.has(k));
      const pad = pads[i];
      if (pad) {
        const blocked = this.padBlocked.get(pad.index);
        const buttons = pad.buttons.map((b, index) => {
            if (!b.pressed) blocked?.delete(index);
            return b.pressed && !blocked?.has(index);
          }),
          previous = this.padPrevious.get(pad.index) ?? buttons;
        if (Math.hypot(pad.axes[0] ?? 0, pad.axes[1] ?? 0) > 0.22)
          command.move = v(pad.axes[0], pad.axes[1]);
        if (buttons[12] || buttons[13] || buttons[14] || buttons[15])
          command.move = v(
            Number(buttons[15]) - Number(buttons[14]),
            Number(buttons[13]) - Number(buttons[12]),
          );
        command.dash ||= !!buttons[0] && !previous[0];
        command.attack ||= !!buttons[2] && !previous[2];
        command.throwHeld ||= !!buttons[1] || !!buttons[5];
        command.throwReleased ||= (!!previous[1] || !!previous[5]) && !buttons[1] && !buttons[5];
        this.padPrevious.set(pad.index, buttons);
      }
      command.move = clampLength(command.move, 1);
      commands.set(i, command);
    }
    this.pressed.clear();
    this.released.clear();
    return commands;
  }

  dispose(): void {
    window.removeEventListener('keydown', this.keyDown);
    window.removeEventListener('keyup', this.keyUp);
    window.removeEventListener('blur', this.clear);
  }
}
