import Phaser from 'phaser';
import {
  DIFFICULTIES,
  DIFFICULTY_ORDER,
  FONT,
  MESSAGE_HOLD_STEPS_MS,
  GAME_WIDTH,
  GEM_COLORS,
  MENU,
  MODES,
  MODE_ORDER,
  TEX_SIZE,
  menuRowCentres,
  type Difficulty,
  type Mode,
} from '../config';
import { loadSavedRun, loadSettings, saveSettings } from '../core/storage';
import {
  MOOPIT_ACCENT,
  MOOPIT_TAPS,
  MOOPIT_TAP_WINDOW_MS,
  voiceFor,
} from '../messages';
import { BUILD_LABEL } from '../version';
import { haptics } from '../haptics';
import { sfx } from '../audio/sfx';
import { Pill } from '../ui/pill';
import { gemTextureKey } from '../gfx/gems';
import { LOGO_FONT, LOGO_GEMS, LOGO_LETTERS, LOGO_SUB_FONT, logoGemTexture } from '../gfx/logo';
import { MENU_FOOT_SHIFT, MENU_HEIGHT, MENU_MID_SHIFT, useMenuCamera } from '../layout';

const BASE_SCALE = 112 / TEX_SIZE;

/** Each mode card's gem and colour, from the splash design. */
const MODE_LOOK: Record<Mode, { gem: (typeof LOGO_GEMS)[keyof typeof LOGO_GEMS]; color: string }> = {
  endless: { gem: LOGO_GEMS.amethyst, color: '#b061ff' },
  timed: { gem: LOGO_GEMS.topaz, color: '#ffb52e' },
  moves: { gem: LOGO_GEMS.sapphire, color: '#5c8dff' },
};

export default class MenuScene extends Phaser.Scene {
  private mode: Mode = 'endless';
  private difficulty: Difficulty = 'normal';
  private modePills = new Map<Mode, Pill>();
  private difficultyPills = new Map<Difficulty, Pill>();
  private bestText!: Phaser.GameObjects.Text;
  private resumePill?: Pill;
  private mutePill!: Pill;
  private taglineText!: Phaser.GameObjects.Text;

  private hapticPill!: Pill;
  /** How long in-game messages stay up; each tap steps through `MESSAGE_HOLD_STEPS_MS`. */
  private msgPill!: Pill;

  /** The private voice, unlocked from the title. See `wireMoopitTitle`. */
  private moopit = false;
  private titleTaps = 0;
  private lastTitleTapAt = 0;

  constructor() {
    super('menu');
  }

  create(): void {
    useMenuCamera(this);
    this.modePills.clear();
    this.difficultyPills.clear();
    this.resumePill = undefined;
    this.titleTaps = 0;

    // Read before drawTitle, which picks its wording from it.
    this.moopit = loadSettings().moopit;

    this.drawBackdrop();
    this.drawTitle();

    // ── Mode picker ────────────────────────────────────────────────────────────
    this.sectionLabel('MODE', 302 + MENU_MID_SHIFT);
    const modeCentres = menuRowCentres(MODE_ORDER.length, GAME_WIDTH);
    MODE_ORDER.forEach((mode, i) => {
      const pill = new Pill(this, {
        x: modeCentres[i],
        y: 372 + MENU_MID_SHIFT,
        w: MENU.pillW,
        h: 112,
        label: MODES[mode].label,
        sub: MODES[mode].sub,
        variant: 'ghost',
        fontSize: 24,
        accent: MODE_LOOK[mode].color,
        icon: logoGemTexture(this, MODE_LOOK[mode].gem, 26),
        onClick: () => this.selectMode(mode),
      });
      this.modePills.set(mode, pill);
    });

    // ── Difficulty picker ─────────────────────────────────────────────────────
    this.sectionLabel('DIFFICULTY', 454 + MENU_MID_SHIFT);
    const difficultyCentres = menuRowCentres(DIFFICULTY_ORDER.length, GAME_WIDTH);
    DIFFICULTY_ORDER.forEach((difficulty, i) => {
      const pill = new Pill(this, {
        x: difficultyCentres[i],
        y: 506 + MENU_MID_SHIFT,
        w: MENU.pillW,
        h: 72,
        label: DIFFICULTIES[difficulty].label,
        sub: DIFFICULTIES[difficulty].sub,
        variant: 'ghost',
        fontSize: 22,
        onClick: () => this.selectDifficulty(difficulty),
      });
      this.difficultyPills.set(difficulty, pill);
    });

    // ── Play ──────────────────────────────────────────────────────────────────
    const play = new Pill(this, {
      x: GAME_WIDTH / 2,
      y: 596 + MENU_MID_SHIFT,
      w: 460,
      h: 84,
      label: 'PLAY NOW',
      variant: 'cta',
      fontSize: 30,
      labelFont: LOGO_SUB_FONT,
      letterSpacing: 8,
      radius: 24,
      onClick: () => {
        sfx.unlock();
        this.scene.start('game', { mode: this.mode, difficulty: this.difficulty });
      },
    });
    this.tweens.add({
      targets: play,
      scaleX: 1.02,
      scaleY: 1.02,
      duration: 1400,
      yoyo: true,
      repeat: -1,
      ease: 'Sine.easeInOut',
    });

    const saved = loadSavedRun();
    if (saved) {
      this.resumePill = new Pill(this, {
        x: GAME_WIDTH / 2,
        y: 684 + MENU_MID_SHIFT,
        w: 460,
        h: 68,
        label: 'RESUME RUN',
        sub: `${MODES[saved.mode].label} · ${DIFFICULTIES[saved.difficulty].label} · ${saved.score.toLocaleString()} pts`,
        variant: 'accent',
        fontSize: 22,
        onClick: () => {
          sfx.unlock();
          this.scene.start('game', {
            mode: saved.mode,
            difficulty: saved.difficulty,
            resume: true,
          });
        },
      });
    }

    this.bestText = this.add
      .text(GAME_WIDTH / 2, 750 + MENU_MID_SHIFT, '', {
        fontFamily: FONT,
        fontSize: '20px',
        color: '#c9c6f5',
      })
      .setOrigin(0.5);

    this.add
      .text(
        GAME_WIDTH / 2,
        792 + MENU_FOOT_SHIFT,
        'Tap two neighbours · or drag · or arrows + Enter',
        { fontFamily: FONT, fontSize: '17px', color: '#8e8ac4' },
      )
      .setOrigin(0.5);

    this.add
      .text(GAME_WIDTH / 2, 820 + MENU_FOOT_SHIFT, 'SPACE · hint      P · pause      M · mute', {
        fontFamily: FONT,
        fontSize: '16px',
        color: '#6f6ba8',
      })
      .setOrigin(0.5);

    // Which build is this? Auto-deploy makes it easy to be staring at a stale
    // bundle, so the version and commit are visible on the menu.
    this.add
      .text(GAME_WIDTH / 2, 856 + MENU_FOOT_SHIFT, BUILD_LABEL, {
        fontFamily: FONT,
        fontSize: '14px',
        color: '#57548a',
      })
      .setOrigin(0.5);

    const settings = loadSettings();
    sfx.muted = settings.muted;
    haptics.enabled = settings.haptics;
    this.mutePill = new Pill(this, {
      x: GAME_WIDTH - 92,
      y: 54,
      w: 130,
      h: 52,
      label: settings.muted ? 'SOUND OFF' : 'SOUND ON',
      variant: 'ghost',
      fontSize: 16,
      radius: 14,
      onClick: () => this.toggleMute(),
    });

    // Sits alongside the sound toggle: two 130px pills with a 14px gap, ending at
    // the same right margin as the sound pill.
    this.hapticPill = new Pill(this, {
      x: GAME_WIDTH - 92 - 130 - 14,
      y: 54,
      w: 130,
      h: 52,
      label: settings.haptics ? 'BUZZ ON' : 'BUZZ OFF',
      variant: 'ghost',
      fontSize: 16,
      radius: 14,
      onClick: () => this.toggleHaptics(),
    });

    this.createBuzzTest();

    // Leftmost of the top row, one more 130px slot left of HOLD TO TEST.
    this.msgPill = new Pill(this, {
      x: GAME_WIDTH - 92 - 3 * (130 + 14),
      y: 54,
      w: 130,
      h: 52,
      label: messageHoldLabel(settings.messageHoldMs),
      variant: 'ghost',
      fontSize: 16,
      radius: 14,
      onClick: () => this.cycleMessageHold(),
    });

    this.selectMode(this.mode);
    this.selectDifficulty(this.difficulty);
  }

  /**
   * Hold-to-test vibration, left of the BUZZ pill. Holding fires 200 ms pulses back to back
   * so the motor runs continuously; releasing (or sliding off) stops it. A line under the
   * version stamp shows what the browser answered, so a silent phone can be diagnosed without devtools.
   */
  private createBuzzTest(): void {
    const status = this.add
      .text(GAME_WIDTH / 2, 880 + MENU_FOOT_SHIFT, '', {
        fontFamily: FONT,
        fontSize: '14px',
        color: '#c9c6f5',
      })
      .setOrigin(0.5);

    const pulseMs = 200;
    let timer: Phaser.Time.TimerEvent | undefined;

    const stop = (): void => {
      if (!timer) return;
      timer.remove();
      timer = undefined;
      haptics.test(0);
    };
    const pulse = (): void => {
      status.setText(haptics.test(pulseMs));
    };

    const testPill = new Pill(this, {
      x: GAME_WIDTH - 92 - 2 * (130 + 14),
      y: 54,
      w: 130,
      h: 52,
      label: 'HOLD TO TEST',
      variant: 'ghost',
      fontSize: 14,
      radius: 14,
      onClick: stop,
    });
    testPill.on('pointerdown', () => {
      stop();
      pulse();
      timer = this.time.addEvent({ delay: pulseMs - 20, loop: true, callback: pulse });
    });
    testPill.on('pointerout', stop);
    this.input.on('pointerup', stop);
    this.events.once('shutdown', () => {
      stop();
      this.input.off('pointerup', stop);
    });
  }

  // ── Backdrop & title ─────────────────────────────────────────────────────────

  private drawBackdrop(): void {
    const g = this.add.graphics();

    // Floating gems give the menu depth without any asset pipeline.
    for (let i = 0; i < 9; i++) {
      const type = i % GEM_COLORS.length;
      const sprite = this.add
        .image(
          Phaser.Math.Between(60, GAME_WIDTH - 60),
          Phaser.Math.Between(60, MENU_HEIGHT - 60),
          gemTextureKey(type, 'none'),
        )
        .setScale(BASE_SCALE * Phaser.Math.FloatBetween(0.5, 1.15))
        .setAlpha(Phaser.Math.FloatBetween(0.05, 0.13))
        .setAngle(Phaser.Math.Between(0, 360));

      this.tweens.add({
        targets: sprite,
        y: sprite.y + Phaser.Math.Between(-70, 70),
        angle: sprite.angle + Phaser.Math.Between(-40, 40),
        duration: Phaser.Math.Between(5000, 11000),
        yoyo: true,
        repeat: -1,
        ease: 'Sine.easeInOut',
      });
    }

    // Faint vignette-ish frame.
    g.fillStyle(0x000000, 0.16);
    g.fillRoundedRect(18, 18, GAME_WIDTH - 36, MENU_HEIGHT - 36, 34);
    g.lineStyle(1, 0xffffff, 0.05);
    g.strokeRoundedRect(18, 18, GAME_WIDTH - 36, MENU_HEIGHT - 36, 34);
  }

  /**
   * The lettered-gem logo from the boot splash: a row of gems, GEMFALL with each letter in its
   * gem's colour, "of the Moopit", then the tagline (the line the private voice changes).
   */
  private drawTitle(): void {
    // Centred on the lettering, so the tap squash and the drift pivot on the word.
    const logo = this.add.container(GAME_WIDTH / 2, 172 + MENU_MID_SHIFT);
    const gemSize = 36;
    const gemGap = 12;
    const rowWidth = LOGO_LETTERS.length * gemSize + (LOGO_LETTERS.length - 1) * gemGap;
    LOGO_LETTERS.forEach(({ gem }, i) => {
      const x = -rowWidth / 2 + gemSize / 2 + i * (gemSize + gemGap);
      const image = this.add.image(x, -68, logoGemTexture(this, gem, gemSize));
      logo.add(image);
      this.tweens.add({
        targets: image,
        scale: 1.2,
        duration: 1300,
        delay: i * 220,
        yoyo: true,
        repeat: -1,
        ease: 'Sine.easeInOut',
      });
    });

    // Letters are separate texts so each can carry its own colour and glow.
    const letters = LOGO_LETTERS.map(({ letter, color }) =>
      this.add
        .text(0, 0, letter, {
          fontFamily: LOGO_FONT,
          fontSize: '86px',
          fontStyle: 'bold',
          color,
        })
        .setOrigin(0, 0.5)
        .setShadow(0, 0, `${color}99`, 16, false, true),
    );
    // Lay the letters out by their advance widths, then pad each canvas: Cinzel Decorative's
    // swashes (the tail of the last L) reach past the advance and would otherwise be clipped.
    const advances = letters.map((t) => t.width);
    const lettersWidth = advances.reduce((sum, w) => sum + w, 0);
    const swash = 80;
    let x = -lettersWidth / 2;
    letters.forEach((text, i) => {
      text.setPadding(swash, 10, swash, 10).setX(x - swash);
      x += advances[i];
    });
    logo.add(letters);

    logo.add(
      this.add
        .text(0, 68, 'OF THE MOOPIT', {
          fontFamily: LOGO_SUB_FONT,
          fontSize: '22px',
          color: '#bea5ff',
        })
        .setOrigin(0.5)
        .setLetterSpacing(9)
        .setAlpha(0.8),
    );

    this.taglineText = this.add
      .text(0, 100, voiceFor(this.moopit).menuTagline, {
        fontFamily: FONT,
        fontSize: '19px',
        color: this.moopit ? MOOPIT_ACCENT : '#a5a2d8',
      })
      .setOrigin(0.5);
    logo.add(this.taglineText);

    // The whole logo drifts gently, like the splash.
    this.tweens.add({ targets: logo, y: logo.y - 9, duration: 1800, yoyo: true, repeat: -1, ease: 'Sine.easeInOut' });

    this.wireMoopitTitle(logo, lettersWidth, 86 + MENU_MID_SHIFT, 222 + MENU_MID_SHIFT);
  }

  /**
   * The way into the private voice: seven taps on the title, close together, and nothing on
   * screen that says they are there. Each tap gets a small squash so a curious player can
   * feel it counting, and the count forgets itself if the taps are too far apart — otherwise
   * a queue of stray taps would eventually fall through the door.
   *
   * The title art never changes — this only decides what the line under it says.
   * The tap target is the gem row and the lettering (from `top` to `bottom` in menu space).
   */
  private wireMoopitTitle(logo: Phaser.GameObjects.Container, width: number, top: number, bottom: number): void {
    const hit = this.add
      .zone(GAME_WIDTH / 2, (top + bottom) / 2, width, bottom - top)
      .setInteractive({ useHandCursor: true });
    hit.on('pointerdown', () => {
      const now = this.time.now;
      this.titleTaps = now - this.lastTitleTapAt > MOOPIT_TAP_WINDOW_MS ? 1 : this.titleTaps + 1;
      this.lastTitleTapAt = now;

      sfx.unlock();
      sfx.click();
      this.tweens.add({
        targets: logo,
        scale: { from: 0.94, to: 1 },
        duration: 90,
        ease: 'Quad.easeOut',
      });

      if (this.titleTaps < MOOPIT_TAPS) return;
      this.titleTaps = 0;
      this.setMoopit(!this.moopit);
    });
  }

  /** Flip the private voice, remember the choice, and make it obvious it landed. */
  private setMoopit(on: boolean): void {
    this.moopit = on;

    const settings = loadSettings();
    settings.moopit = on;
    saveSettings(settings);

    this.taglineText.setText(voiceFor(on).menuTagline).setColor(on ? MOOPIT_ACCENT : '#a5a2d8');

    haptics.confirm();
    sfx.newBest();
    if (!settings.reducedMotion) this.cameras.main.flash(220, 129, 140, 248);
  }

  private sectionLabel(text: string, y: number): void {
    this.add
      .text(64, y, text, {
        fontFamily: FONT,
        fontSize: '17px',
        color: '#8e8ac4',
        letterSpacing: 4,
      })
      .setOrigin(0, 0.5);
  }

  // ── Selection ────────────────────────────────────────────────────────────────

  private selectMode(mode: Mode): void {
    this.mode = mode;
    for (const [key, pill] of this.modePills) pill.setSelected(key === mode);
    this.refreshBest();
  }

  private selectDifficulty(difficulty: Difficulty): void {
    this.difficulty = difficulty;
    for (const [key, pill] of this.difficultyPills) pill.setSelected(key === difficulty);
    this.refreshBest();
  }

  private refreshBest(): void {
    const best = loadSavedRun();
    // Reading through storage keeps the display honest after a run that just ended.
    const scores = (() => {
      try {
        return JSON.parse(window.localStorage.getItem('bejeweled.highscores.v1') ?? '{}') as Record<
          string,
          { score: number }
        >;
      } catch {
        return {};
      }
    })();
    const entry = scores[`${this.mode}:${this.difficulty}`];
    this.bestText.setText(
      entry
        ? `BEST · ${MODES[this.mode].label} · ${DIFFICULTIES[this.difficulty].label} — ${entry.score.toLocaleString()}`
        : `NO SCORE YET · ${MODES[this.mode].label} · ${DIFFICULTIES[this.difficulty].label}`,
    );
    void best;
  }

  private toggleMute(): void {
    const settings = loadSettings();
    settings.muted = !settings.muted;
    saveSettings(settings);
    sfx.muted = settings.muted;
    this.mutePill.setLabel(settings.muted ? 'SOUND OFF' : 'SOUND ON');
    if (!settings.muted) {
      sfx.unlock();
      sfx.click();
    }
  }

  private toggleHaptics(): void {
    const settings = loadSettings();
    settings.haptics = !settings.haptics;
    saveSettings(settings);
    haptics.enabled = settings.haptics;
    this.hapticPill.setLabel(settings.haptics ? 'BUZZ ON' : 'BUZZ OFF');
    // Fire one so the toggle demonstrates itself.
    if (settings.haptics) haptics.confirm();
  }

  private cycleMessageHold(): void {
    const settings = loadSettings();
    const steps: readonly number[] = MESSAGE_HOLD_STEPS_MS;
    // loadSettings guarantees a listed step, so indexOf is never -1 here.
    settings.messageHoldMs = steps[(steps.indexOf(settings.messageHoldMs) + 1) % steps.length];
    saveSettings(settings);
    this.msgPill.setLabel(messageHoldLabel(settings.messageHoldMs));
  }
}

/** "MSG 1.5s", "MSG 3s" — the pill's label for a message time. */
const messageHoldLabel = (ms: number): string => `MSG ${ms / 1000}s`;
