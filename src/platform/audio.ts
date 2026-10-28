import type { GameEvent } from '../core/types';

/** Small synthesized SFX bank; no network requests or original audio assets. */
export class AudioEngine {
  private context: AudioContext | null = null;
  private master: GainNode | null = null;
  muted = false;
  private recent = new Map<string, number>();

  unlock(): void {
    if (!this.context) {
      this.context = new AudioContext();
      this.master = this.context.createGain();
      this.master.gain.value = this.muted ? 0 : 0.22;
      this.master.connect(this.context.destination);
    }
    void this.context.resume();
  }

  toggle(): boolean {
    this.muted = !this.muted;
    if (this.master && this.context)
      this.master.gain.setTargetAtTime(this.muted ? 0 : 0.22, this.context.currentTime, 0.03);
    return this.muted;
  }

  destroy(): void {
    this.recent.clear();
    this.master?.disconnect();
    if (this.context) void this.context.close().catch(() => {});
    this.context = null;
    this.master = null;
  }

  private tone(
    start: number,
    end: number,
    duration: number,
    type: OscillatorType = 'sine',
    delay = 0,
    gain = 0.35,
  ): void {
    if (!this.context || !this.master || this.muted) return;
    const now = this.context.currentTime + delay;
    const oscillator = this.context.createOscillator(),
      envelope = this.context.createGain();
    oscillator.type = type;
    oscillator.frequency.setValueAtTime(start, now);
    oscillator.frequency.exponentialRampToValueAtTime(Math.max(20, end), now + duration);
    envelope.gain.setValueAtTime(0.001, now);
    envelope.gain.exponentialRampToValueAtTime(gain, now + 0.007);
    envelope.gain.exponentialRampToValueAtTime(0.001, now + duration);
    oscillator.connect(envelope);
    envelope.connect(this.master);
    oscillator.start(now);
    oscillator.stop(now + duration + 0.01);
    oscillator.onended = () => {
      oscillator.disconnect();
      envelope.disconnect();
    };
  }

  play(events: GameEvent[]): void {
    if (!this.context) return;
    for (const event of events) {
      const now = this.context.currentTime;
      if (now - (this.recent.get(event.type) ?? -1) < 0.05) continue;
      this.recent.set(event.type, now);
      switch (event.type) {
        case 'throw':
          this.tone(520, 170, 0.15, 'triangle');
          break;
        case 'dash':
          this.tone(180, 65, 0.12, 'triangle', 0, 0.2);
          break;
        case 'slash':
          this.tone(300, 70, 0.1, 'sawtooth', 0, 0.1);
          break;
        case 'deflect':
          this.tone(1100, 540, 0.2, 'triangle');
          this.tone(1500, 800, 0.12, 'sine', 0.03, 0.12);
          break;
        case 'bounce':
          this.tone(330, 160, 0.07, 'triangle', 0, 0.17);
          break;
        case 'catch':
          this.tone(520, 760, 0.07, 'sine', 0, 0.15);
          break;
        case 'shield':
          this.tone(850, 120, 0.25, 'triangle');
          break;
        case 'crate':
          this.tone(120, 50, 0.13, 'square', 0, 0.13);
          break;
        case 'death':
          this.tone(240, 48, 0.32, 'triangle', 0, 0.5);
          break;
        case 'explosion':
          this.tone(90, 22, 0.38, 'sawtooth', 0, 0.4);
          break;
        case 'pickup':
          [440, 554, 660].forEach((f, i) => this.tone(f, f, 0.16, 'sine', i * 0.07));
          break;
        case 'teleport':
          this.tone(320, 960, 0.18, 'sine', 0, 0.18);
          this.tone(960, 640, 0.12, 'triangle', 0.1, 0.1);
          break;
        case 'countdown':
          this.tone(660, 660, 0.08, 'sine', 0, 0.15);
          break;
        case 'win':
          [523, 659, 784, 1046].forEach((f, i) => this.tone(f, f, 0.35, 'triangle', i * 0.13));
          break;
      }
    }
  }
}
