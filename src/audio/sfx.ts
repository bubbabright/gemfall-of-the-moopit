/**
 * Procedural WebAudio SFX engine (interview decision #10) — no audio files, no licensing,
 * no network fetch. Everything is synthesised on demand.
 */

interface ToneOptions {
  freq: number;
  dur: number;
  type?: OscillatorType;
  gain?: number;
  /** Optional frequency glide target. */
  sweepTo?: number;
  delay?: number;
  detune?: number;
}

/**
 * Background music, made in code like the effects: a slow four-chord loop (Am9, Fmaj7, Cmaj7,
 * G6) with a soft pad, a low root and a quiet plucked arpeggio. Original, no samples.
 * Each chord is [bass, pad notes…] in Hz.
 */
const CHORDS: number[][] = [
  [110.0, 220.0, 261.63, 329.63, 493.88], // Am9
  [87.31, 174.61, 220.0, 261.63, 329.63], // Fmaj7
  [130.81, 196.0, 246.94, 329.63, 392.0], // Cmaj7
  [98.0, 196.0, 246.94, 293.66, 329.63], // G6
];
/** Which pad note each eighth of a bar plucks, an octave up. */
const ARP = [0, 2, 1, 3, 2, 1, 3, 2];
const EIGHTH = 60 / 84 / 2; // 84 bpm
const BAR = EIGHTH * 8;

class Sfx {
  private ctx: AudioContext | null = null;
  private master: GainNode | null = null;
  private musicBus: GainNode | null = null;
  /** Everything silent (the speaker in the corner). */
  muted = false;
  /** Sound effects on (a switch in settings). */
  effects = true;
  /** Background music on (a switch in settings). */
  music = true;
  private musicTimer = 0;
  private nextEighth = 0;
  private eighthIndex = 0;

  /** Must be called from a user gesture before any sound can play. */
  unlock(): void {
    const ctx = this.ensure();
    if (ctx && ctx.state === 'suspended') void ctx.resume().then(() => this.syncMusic());
    else this.syncMusic();
  }

  /** Apply the sound settings: the corner mute plus the effects and music switches. */
  configure(settings: { muted: boolean; effects: boolean; music: boolean }): void {
    this.muted = settings.muted;
    this.effects = settings.effects;
    this.music = settings.music;
    this.syncMusic();
  }

  // ── Music ───────────────────────────────────────────────────────────────────

  /** Start or stop the loop to match the settings, whether the page is visible, and audio. */
  syncMusic(): void {
    const want = this.music && !this.muted && typeof document !== 'undefined' && !document.hidden;
    const ctx = this.ctx;
    if (!want || !ctx || ctx.state !== 'running') {
      this.stopMusic();
      return;
    }
    if (this.musicTimer) return;
    if (!this.musicBus) {
      this.musicBus = ctx.createGain();
      this.musicBus.connect(ctx.destination);
    }
    // Fade in rather than start at full level mid-phrase.
    this.musicBus.gain.cancelScheduledValues(ctx.currentTime);
    this.musicBus.gain.setValueAtTime(0.0001, ctx.currentTime);
    this.musicBus.gain.exponentialRampToValueAtTime(0.16, ctx.currentTime + 1.5);
    this.nextEighth = ctx.currentTime + 0.1;
    this.musicTimer = window.setInterval(() => this.scheduleMusic(), 120);
    this.scheduleMusic();
  }

  private stopMusic(): void {
    if (!this.musicTimer) return;
    window.clearInterval(this.musicTimer);
    this.musicTimer = 0;
    const ctx = this.ctx;
    if (ctx && this.musicBus) {
      this.musicBus.gain.cancelScheduledValues(ctx.currentTime);
      this.musicBus.gain.setTargetAtTime(0.0001, ctx.currentTime, 0.15);
    }
  }

  /** Book the next half-second of notes ahead of time, so timer jitter never shows. */
  private scheduleMusic(): void {
    const ctx = this.ctx;
    if (!ctx || !this.musicBus) return;
    while (this.nextEighth < ctx.currentTime + 0.5) {
      const at = this.nextEighth;
      const step = this.eighthIndex % 8;
      const chord = CHORDS[Math.floor(this.eighthIndex / 8) % CHORDS.length];
      if (step === 0) {
        chord.slice(1).forEach((freq, i) => this.voice(freq, at, BAR * 1.05, 'sine', 0.05, 900, i * 4 - 6));
        this.voice(chord[0], at, BAR * 0.9, 'sine', 0.12, 400);
      }
      this.voice(chord[1 + ARP[step]] * 2, at, EIGHTH * 2.2, 'triangle', 0.035, 2400, 0, true);
      this.nextEighth += EIGHTH;
      this.eighthIndex += 1;
    }
  }

  private voice(
    freq: number,
    at: number,
    dur: number,
    type: OscillatorType,
    peak: number,
    cutoff: number,
    detune = 0,
    pluck = false,
  ): void {
    const ctx = this.ctx;
    if (!ctx || !this.musicBus) return;
    const osc = ctx.createOscillator();
    const filter = ctx.createBiquadFilter();
    const env = ctx.createGain();
    osc.type = type;
    osc.frequency.value = freq;
    osc.detune.value = detune;
    filter.type = 'lowpass';
    filter.frequency.value = cutoff;
    // Pads swell in and out; plucks strike and decay.
    const attack = pluck ? 0.01 : Math.min(0.9, dur * 0.3);
    env.gain.setValueAtTime(0.0001, at);
    env.gain.exponentialRampToValueAtTime(peak, at + attack);
    env.gain.exponentialRampToValueAtTime(0.0001, at + dur);
    osc.connect(filter);
    filter.connect(env);
    env.connect(this.musicBus);
    osc.start(at);
    osc.stop(at + dur + 0.05);
  }

  private ensure(): AudioContext | null {
    if (this.ctx) return this.ctx;
    try {
      const Ctor =
        window.AudioContext ??
        (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
      if (!Ctor) return null;
      this.ctx = new Ctor();
      this.master = this.ctx.createGain();
      this.master.gain.value = 0.34;
      this.master.connect(this.ctx.destination);
      return this.ctx;
    } catch {
      return null;
    }
  }

  private tone(opts: ToneOptions): void {
    if (this.muted || !this.effects) return;
    const ctx = this.ensure();
    if (!ctx || !this.master) return;

    const start = ctx.currentTime + (opts.delay ?? 0);
    const dur = opts.dur;
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();

    osc.type = opts.type ?? 'sine';
    osc.frequency.setValueAtTime(opts.freq, start);
    if (opts.sweepTo !== undefined) osc.frequency.exponentialRampToValueAtTime(Math.max(1, opts.sweepTo), start + dur);
    if (opts.detune) osc.detune.value = opts.detune;

    const peak = opts.gain ?? 0.5;
    gain.gain.setValueAtTime(0.0001, start);
    gain.gain.exponentialRampToValueAtTime(peak, start + Math.min(0.02, dur * 0.25));
    gain.gain.exponentialRampToValueAtTime(0.0001, start + dur);

    osc.connect(gain);
    gain.connect(this.master);
    osc.start(start);
    osc.stop(start + dur + 0.03);
  }

  private noise(dur: number, gain: number, filterFrom: number, filterTo: number, delay = 0): void {
    if (this.muted || !this.effects) return;
    const ctx = this.ensure();
    if (!ctx || !this.master) return;

    const start = ctx.currentTime + delay;
    const frames = Math.max(1, Math.floor(ctx.sampleRate * dur));
    const buffer = ctx.createBuffer(1, frames, ctx.sampleRate);
    const data = buffer.getChannelData(0);
    for (let i = 0; i < frames; i++) data[i] = (Math.random() * 2 - 1) * (1 - i / frames);

    const src = ctx.createBufferSource();
    src.buffer = buffer;

    const filter = ctx.createBiquadFilter();
    filter.type = 'bandpass';
    filter.frequency.setValueAtTime(filterFrom, start);
    filter.frequency.exponentialRampToValueAtTime(Math.max(40, filterTo), start + dur);

    const env = ctx.createGain();
    env.gain.setValueAtTime(gain, start);
    env.gain.exponentialRampToValueAtTime(0.0001, start + dur);

    src.connect(filter);
    filter.connect(env);
    env.connect(this.master);
    src.start(start);
    src.stop(start + dur + 0.02);
  }

  // ── Events ──────────────────────────────────────────────────────────────────

  click(): void {
    this.tone({ freq: 620, dur: 0.07, type: 'triangle', gain: 0.28 });
  }

  swap(): void {
    this.tone({ freq: 520, dur: 0.09, type: 'triangle', gain: 0.3, sweepTo: 760 });
  }

  invalid(): void {
    this.tone({ freq: 190, dur: 0.16, type: 'square', gain: 0.16, sweepTo: 120 });
    this.tone({ freq: 196, dur: 0.16, type: 'square', gain: 0.12, delay: 0.02 });
  }

  /**
   * Cascade-depth aware: each step climbs a couple of semitones and hits a little
   * harder. A filtered noise burst supplies the explosion transient, so a clear
   * sounds like something breaking rather than a single blip.
   */
  match(depth: number): void {
    const step = Math.min(depth, 8);
    const base = 523.25 * Math.pow(2, (step * 2) / 12);
    const punch = Math.min(0.12, step * 0.014);

    // Transient: bandpass noise sweeping down = the "crack" of the burst.
    this.noise(0.26, 0.18 + punch, 2800, 260);
    // Body: the pitched part glides down as the gems fly apart.
    this.tone({ freq: base, dur: 0.2, type: 'triangle', gain: 0.34, sweepTo: base * 0.62 });
    this.tone({ freq: base * 2, dur: 0.12, type: 'sine', gain: 0.16, delay: 0.02 });
    // Weight: a short low thump gives the pop some body.
    this.tone({ freq: 110, dur: 0.22, type: 'sine', gain: 0.13 + punch * 0.5, sweepTo: 50 });
  }

  line(): void {
    this.tone({ freq: 900, dur: 0.22, type: 'sawtooth', gain: 0.16, sweepTo: 2100 });
    this.noise(0.22, 0.16, 1800, 5000);
  }

  bomb(): void {
    this.noise(0.36, 0.28, 1400, 90);
    this.tone({ freq: 220, dur: 0.34, type: 'square', gain: 0.16, sweepTo: 60 });
  }

  hyper(): void {
    [523.25, 659.25, 783.99, 1046.5].forEach((freq, i) =>
      this.tone({ freq, dur: 0.34, type: 'sine', gain: 0.2, delay: i * 0.045 }),
    );
    this.noise(0.4, 0.12, 3000, 700);
  }

  shuffle(): void {
    for (let i = 0; i < 5; i++) {
      this.tone({ freq: 300 + i * 90, dur: 0.08, type: 'triangle', gain: 0.2, delay: i * 0.05 });
    }
  }

  levelUp(): void {
    [523.25, 659.25, 880, 1174.66].forEach((freq, i) =>
      this.tone({ freq, dur: 0.24, type: 'triangle', gain: 0.26, delay: i * 0.08 }),
    );
  }

  gameOver(): void {
    [440, 349.23, 261.63].forEach((freq, i) =>
      this.tone({ freq, dur: 0.4, type: 'triangle', gain: 0.26, delay: i * 0.16 }),
    );
  }

  newBest(): void {
    [784, 988, 1319, 1568].forEach((freq, i) =>
      this.tone({ freq, dur: 0.3, type: 'sine', gain: 0.24, delay: i * 0.09 }),
    );
  }
}

export const sfx = new Sfx();

// No music while the game is in the background (saves battery, and it's polite).
if (typeof document !== 'undefined') {
  document.addEventListener('visibilitychange', () => sfx.syncMusic());
}
