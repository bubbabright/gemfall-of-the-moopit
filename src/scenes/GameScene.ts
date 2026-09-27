import Phaser from 'phaser';
import {
  DIFFICULTIES,
  FONT,
  MESSAGE_FONT,
  GEM_COLORS,
  MODES,
  MODE_RULES,
  SCORE,
  SWIPE_THRESHOLD,
  TEX_SIZE,
  TIMING,
  type Difficulty,
  type DifficultySpec,
  type Mode,
} from '../config';
import {
  applyGravity,
  areNeighbours,
  createGrid,
  findGroups,
  findValidMoves,
  inBounds,
  parseKey,
  posKey,
  refill,
  serializeGrid,
  shuffleGrid,
  swapCells,
} from '../core/board';
import { expandDetonations, planSpecials, type Detonation } from '../core/specials';
import { levelTarget, multiplierTier, stepScore } from '../core/score';
import {
  clearSavedRun,
  loadSavedRun,
  loadSettings,
  saveRun,
  saveSettings,
  submitHighScore,
  type Settings,
} from '../core/storage';
import { MOOPIT_ACCENT, pick, voiceFor, type Voice } from '../messages';
import { gemTextureKey } from '../gfx/gems';
import { sfx } from '../audio/sfx';
import { haptics } from '../haptics';
import { Pill, tweenPromise } from '../ui/pill';
import { wakeLock } from '../wakeLock';
import type { Cell, Grid, Move, Pos } from '../core/types';
import {
  BOARD_AREA_H,
  BOARD_PAD,
  BOARD_TOP,
  GAME_HEIGHT,
  LAYOUT,
  TILE,
  WORLD_WIDTH,
  useRenderZoom,
  type HudSpot,
} from '../layout';

// These follow the current layout (src/layout.ts), which changes when the phone turns, so they
// are read when used rather than fixed when the module loads.
/** Board centre: where the combo popup and the level banner land. */
const comboY = (): number => BOARD_TOP + BOARD_AREA_H / 2;
/** The personal voice's word under the combo number, just below it. */
const comboNoteY = (): number => comboY() + 54;
/** Toast line, clear of the combo flourish above it and still over the board. */
const toastY = (): number => comboY() + 108;
/** Scale that shows a TEX_SIZE gem texture at the current tile size. */
const baseScale = (): number => TILE / TEX_SIZE;
const D = { slots: 1, gems: 5, ring: 8, fx: 12, hud: 20, overlay: 60 };

const TIER_COLORS = ['#ffffff', '#a7f3d0', '#fde68a', '#fca5a5', '#f0abfc'];

export interface GameSceneData {
  mode?: Mode;
  difficulty?: Difficulty;
  resume?: boolean;
  /**
   * Set when the scene restarts itself because the phone turned (see `relayout`): the exact
   * shuffle count and pause state to carry over, which the saved run doesn't hold precisely.
   */
  carry?: { shufflesLeft: number; paused: boolean };
}

export default class GameScene extends Phaser.Scene {
  private mode: Mode = 'endless';
  private difficulty: Difficulty = 'normal';
  private spec: DifficultySpec = DIFFICULTIES.normal;

  private grid: Grid = [];
  private spriteOf = new Map<Cell, Phaser.GameObjects.Sprite>();
  private posOf = new Map<Cell, Pos>();

  private boardX = 0;
  private boardY = 0;
  private boardW = 0;
  private boardH = 0;

  private score = 0;
  private level = 1;
  private levelScore = 0;
  private movesLeft = Number.POSITIVE_INFINITY;
  private timeLeftMs = Number.POSITIVE_INFINITY;
  private shufflesLeft = Number.POSITIVE_INFINITY;

  private busy = false;
  private paused = false;
  private over = false;
  private cascadeDepth = 0;
  private lastMoveAt = 0;

  private selected: Pos | null = null;
  private keyboardCursor: Pos = { row: 0, col: 0 };
  private keyboardActive = false;
  private dragFrom: Pos | null = null;
  private dragStart = { x: 0, y: 0 };

  private settings!: Settings;
  private reduceMotion = false;
  /** Which wording this run speaks: the default, or the private voice from the menu. */
  private moopit = false;
  private ready = false;
  private hasInteracted = false;
  private fadeRect: Phaser.GameObjects.Rectangle | null = null;

  private hintTimer: Phaser.Time.TimerEvent | null = null;
  private clock: Phaser.Time.TimerEvent | null = null;
  private rand: () => number = Math.random;

  private ring!: Phaser.GameObjects.Image;
  private hintRingA!: Phaser.GameObjects.Image;
  private hintRingB!: Phaser.GameObjects.Image;
  private cursorRing!: Phaser.GameObjects.Image;

  private scoreText!: Phaser.GameObjects.Text;
  private statLabel!: Phaser.GameObjects.Text;
  private statText!: Phaser.GameObjects.Text;
  private levelText!: Phaser.GameObjects.Text;
  private targetText!: Phaser.GameObjects.Text;
  private progress!: Phaser.GameObjects.Graphics;
  private comboText!: Phaser.GameObjects.Text;
  /** Word under the combo number. Blank in the default voice — see `src/messages.ts`. */
  private comboNote!: Phaser.GameObjects.Text;
  private toastText!: Phaser.GameObjects.Text;
  /** Rounded bubble behind the toast so it reads as a message, not text lost among the gems. */
  private toastBubble!: Phaser.GameObjects.Graphics;
  /** Holds bubble + text; this is what the toast tweens move and fade. */
  private toastBox!: Phaser.GameObjects.Container;
  private mutePill!: Pill;
  private pausePill!: Pill;
  /** Bottom control pills, keyed by role. Exposed so the playtest can audit their layout. */
  readonly hudPills = new Map<string, Pill>();
  private overlay: Phaser.GameObjects.Container | null = null;

  constructor() {
    super('game');
  }

  init(data: GameSceneData): void {
    this.mode = data.mode ?? 'endless';
    this.difficulty = data.difficulty ?? 'normal';
    this.spec = DIFFICULTIES[this.difficulty];
    this.resumeRequested = Boolean(data.resume);
    this.carry = data.carry ?? null;
  }

  private resumeRequested = false;
  private carry: GameSceneData['carry'] | null = null;

  /**
   * The phone turned: rebuild in the new layout without losing the run. The run is saved and
   * the scene restarts from it, keeping shuffles and pause exactly. Returns false when now is
   * not a safe moment (gems still moving); the caller tries again shortly. After game over there
   * is no run to carry, so the new layout waits until the player leaves this screen.
   */
  relayout(): boolean {
    if (this.over) return true;
    if (!this.ready || this.busy) return false;
    this.persistRun();
    this.scene.restart({
      mode: this.mode,
      difficulty: this.difficulty,
      resume: true,
      carry: { shufflesLeft: this.shufflesLeft, paused: this.paused },
    } satisfies GameSceneData);
    return true;
  }

  private get voice(): Voice {
    return voiceFor(this.moopit);
  }

  create(): void {
    useRenderZoom(this);
    this.resetInstanceState();
    this.settings = loadSettings();
    this.reduceMotion = this.settings.reducedMotion;
    this.moopit = this.settings.moopit;
    sfx.muted = this.settings.muted;
    haptics.enabled = this.settings.haptics;

    const saved = this.resumeRequested ? loadSavedRun() : null;

    this.grid = saved
      ? saved.grid
      : createGrid(this.spec.cols, this.spec.rows, this.spec.types, this.rand);

    this.boardW = this.spec.cols * TILE;
    this.boardH = this.spec.rows * TILE;
    this.boardX = Math.round((WORLD_WIDTH - this.boardW) / 2);
    this.boardY = Math.round(BOARD_TOP + (BOARD_AREA_H - this.boardH) / 2);

    this.movesLeft =
      this.mode === 'moves' ? MODES[this.mode].moves : Number.POSITIVE_INFINITY;
    this.timeLeftMs = this.mode === 'timed' ? MODES[this.mode].timeMs : Number.POSITIVE_INFINITY;
    this.shufflesLeft = this.mode === 'endless' ? MODE_RULES.endlessShuffles : Number.POSITIVE_INFINITY;

    if (saved) {
      this.score = saved.score;
      this.level = saved.level;
      this.levelScore = saved.levelScore;
      this.movesLeft = saved.movesLeft >= 0 ? saved.movesLeft : Number.POSITIVE_INFINITY;
      this.timeLeftMs = saved.timeLeftMs >= 0 ? saved.timeLeftMs : Number.POSITIVE_INFINITY;
      this.shufflesLeft =
        this.mode === 'endless' ? Math.max(1, MODE_RULES.endlessShuffles - saved.shuffles) : Number.POSITIVE_INFINITY;
      if (this.carry) this.shufflesLeft = this.carry.shufflesLeft;
    }

    this.drawBoard();
    this.buildSprites();
    this.buildHud();
    this.setupInput();
    this.setupKeyboard();
    this.setupLifecycle();

    this.keyboardCursor = { row: Math.floor(this.spec.rows / 2), col: Math.floor(this.spec.cols / 2) };
    this.updateHud();
    this.startClock();
    this.scheduleAutoHint();

    this.playIntroFade();
    this.ready = true;
    // Rebuilt after the phone turned while paused: stay paused.
    if (this.carry?.paused) this.togglePause(true);
    wakeLock.hold(!this.paused);

    if (this.mode === 'endless' && !saved) {
      this.showToast(this.voice.toast.endlessStart(MODE_RULES.endlessShuffles), '#c7d2fe');
    }
  }

  /**
   * Fade-in via a rectangle we own rather than a camera effect, so pausing (which freezes
   * tweens) can never leave the board stuck behind a black screen.
   */
  private playIntroFade(): void {
    if (this.reduceMotion) return;

    const fade = this.add
      .rectangle(WORLD_WIDTH / 2, GAME_HEIGHT / 2, WORLD_WIDTH, GAME_HEIGHT, 0x080418, 1)
      .setDepth(D.overlay - 5);
    this.fadeRect = fade;

    this.tweens.add({
      targets: fade,
      alpha: 0,
      duration: 280,
      ease: 'Quad.easeOut',
      onComplete: () => {
        fade.destroy();
        if (this.fadeRect === fade) this.fadeRect = null;
      },
    });
  }

  private clearIntroFade(): void {
    this.tweens.killTweensOf(this.fadeRect as Phaser.GameObjects.Rectangle);
    this.fadeRect?.destroy();
    this.fadeRect = null;
  }

  private resetInstanceState(): void {
    this.spriteOf = new Map();
    this.posOf = new Map();
    this.score = 0;
    this.level = 1;
    this.levelScore = 0;
    this.busy = false;
    this.paused = false;
    this.over = false;
    this.cascadeDepth = 0;
    this.selected = null;
    this.dragFrom = null;
    this.keyboardActive = false;
    this.hintTimer = null;
    this.clock = null;
    this.overlay = null;
    this.fadeRect = null;
    this.ready = false;
    this.hasInteracted = false;
    this.lastMoveAt = performance.now();
  }

  // ── Rendering the board ──────────────────────────────────────────────────────

  private cellCenter(pos: Pos): { x: number; y: number } {
    return {
      x: this.boardX + pos.col * TILE + TILE / 2,
      y: this.boardY + pos.row * TILE + TILE / 2,
    };
  }

  private drawBoard(): void {
    const g = this.add.graphics();
    g.setDepth(0);

    const px = this.boardX - BOARD_PAD;
    const py = this.boardY - BOARD_PAD;
    const pw = this.boardW + BOARD_PAD * 2;
    const ph = this.boardH + BOARD_PAD * 2;

    // Outer glow.
    for (let i = 5; i >= 1; i--) {
      g.fillStyle(0x818cf8, 0.02);
      g.fillRoundedRect(px - i * 6, py - i * 6, pw + i * 12, ph + i * 12, 30 + i * 6);
    }

    // Panel.
    g.fillStyle(0x140f33, 0.94);
    g.fillRoundedRect(px, py, pw, ph, 28);
    g.fillStyle(0xffffff, 0.035);
    g.fillRoundedRect(px + 3, py + 3, pw - 6, ph * 0.42, { tl: 26, tr: 26, bl: 0, br: 0 });
    g.lineStyle(2, 0xffffff, 0.09);
    g.strokeRoundedRect(px, py, pw, ph, 28);
    g.lineStyle(1, 0xa5b4fc, 0.16);
    g.strokeRoundedRect(px + 5, py + 5, pw - 10, ph - 10, 24);

    // Slots.
    for (let row = 0; row < this.spec.rows; row++) {
      for (let col = 0; col < this.spec.cols; col++) {
        const { x, y } = this.cellCenter({ row, col });
        this.add
          .image(x, y, 'slot')
          .setDisplaySize(TILE - 4, TILE - 4)
          .setDepth(D.slots)
          .setAlpha(0.75);
      }
    }
  }

  private buildSprites(): void {
    for (const sprite of this.spriteOf.values()) sprite.destroy();
    this.spriteOf.clear();

    for (let row = 0; row < this.spec.rows; row++) {
      for (let col = 0; col < this.spec.cols; col++) {
        const cell = this.grid[row][col];
        if (cell) this.createSprite(cell, { row, col }, 0, false);
      }
    }
    this.rebuildPosIndex();
  }

  private createSprite(
    cell: Cell,
    pos: Pos,
    rowsAbove = 0,
    popIn = false,
  ): Phaser.GameObjects.Sprite {
    const { x, y } = this.cellCenter(pos);
    const sprite = this.add
      .sprite(x, y - rowsAbove * TILE, gemTextureKey(cell.type, cell.special))
      .setScale(baseScale())
      .setDepth(D.gems);

    if (cell.special === 'lineV') sprite.setAngle(90);

    this.spriteOf.set(cell, sprite);

    if (popIn && !this.reduceMotion) {
      sprite.setScale(baseScale() * 1.7).setAlpha(0.15);
      // Held on the sprite so a movement tween can find and finish it. Keying it off
      // the sprite also means it disappears with the sprite — no teardown bookkeeping.
      sprite.setData('popTween',
        this.tweens.add({
          targets: sprite,
          scale: baseScale(),
          alpha: 1,
          duration: TIMING.popMs,
          ease: 'Back.easeOut',
          onComplete: () => sprite.setData('popTween', null),
        }),
      );
    } else if (popIn) {
      sprite.setScale(baseScale()).setAlpha(1);
    }

    return sprite;
  }

  private rebuildPosIndex(): void {
    this.posOf.clear();
    for (let row = 0; row < this.grid.length; row++) {
      for (let col = 0; col < this.grid[row].length; col++) {
        const cell = this.grid[row][col];
        if (cell) this.posOf.set(cell, { row, col });
      }
    }
  }

  /** Tween every sprite to its cell's current board position. */
  private async syncPositions(
    perTileMs = TIMING.fallMsPerTile,
    minMs = TIMING.fallMinMs,
    isSwap = false,
  ): Promise<void> {
    this.rebuildPosIndex();
    const work: Promise<void>[] = [];
    const landed: Phaser.GameObjects.Sprite[] = [];

    for (const [cell, sprite] of this.spriteOf) {
      const pos = this.posOf.get(cell);
      if (!pos) continue;
      const { x, y } = this.cellCenter(pos);
      if (Math.abs(sprite.x - x) < 0.5 && Math.abs(sprite.y - y) < 0.5) continue;

      // A freshly spawned power gem may still be mid pop-in, which starts it at
      // alpha 0.15 and scale 1.7. Killing that tween to move the gem would freeze it
      // oversized and see-through, so finish it first, then take over.
      const pop = sprite.getData('popTween') as Phaser.Tweens.Tween | null | undefined;
      if (pop) {
        pop.stop();
        sprite.setData('popTween', null);
        sprite.setScale(baseScale()).setAlpha(1);
      }

      this.tweens.killTweensOf(sprite);
      const distanceTiles = Math.max(Math.abs(sprite.x - x), Math.abs(sprite.y - y)) / TILE;
      const duration = this.reduceMotion
        ? 0
        : isSwap
          ? TIMING.swapMs
          : Math.max(minMs, distanceTiles * perTileMs);

      if (duration <= 0) {
        sprite.setPosition(x, y);
        continue;
      }

      work.push(
        tweenPromise(this, {
          targets: sprite,
          x,
          y,
          duration,
          // Gravity accelerates; a swap is smooth in both directions.
          ease: isSwap ? 'Sine.easeInOut' : 'Cubic.easeIn',
        }),
      );
      if (!isSwap) landed.push(sprite);
    }

    await Promise.all(work);

    // A short squash on landing is what makes pieces read as falling into place
    // instead of sliding or snapping to their cell.
    if (!isSwap && !this.reduceMotion && landed.length > 0) {
      await Promise.all(
        landed.map((sprite) =>
          tweenPromise(this, {
            targets: sprite,
            scaleY: baseScale() * 0.82,
            duration: TIMING.settleMs * 0.42,
            yoyo: true,
            ease: 'Quad.easeOut',
          }),
        ),
      );
    }
  }

  private burst(pos: Pos, type: number, count: number): void {
    if (this.reduceMotion) return;
    const { x, y } = this.cellCenter(pos);
    const tint = type >= 0 ? GEM_COLORS[type % GEM_COLORS.length] : 0xffffff;

    const emitter = this.add.particles(x, y, 'spark', {
      speed: { min: 130, max: 430 },
      lifespan: { min: 340, max: 780 },
      scale: { start: 0.72, end: 0 },
      alpha: { start: 0.95, end: 0 },
      blendMode: 'ADD',
      // Sparks arc downward, which reads as debris rather than a puff of smoke.
      gravityY: 260,
      tint,
      emitting: false,
    });
    emitter.setDepth(D.fx);
    emitter.explode(count, x, y);
    this.time.delayedCall(900, () => emitter.destroy());
  }

  // ── HUD ──────────────────────────────────────────────────────────────────────

  private buildHud(): void {
    // create() runs again on restart, so drop the previous run's pills before rebuilding.
    this.hudPills.clear();

    const g = this.add.graphics().setDepth(D.hud);

    // Header plaque: a strip across the top in portrait, a column left of the board in landscape.
    const plaqueHud = LAYOUT.hud;
    g.fillStyle(0x140f33, 0.72);
    g.fillRoundedRect(plaqueHud.plaque.x, plaqueHud.plaque.y, plaqueHud.plaque.w, plaqueHud.plaque.h, 24);
    g.lineStyle(1.5, 0xffffff, 0.07);
    g.strokeRoundedRect(plaqueHud.plaque.x, plaqueHud.plaque.y, plaqueHud.plaque.w, plaqueHud.plaque.h, 24);

    const place = (spot: HudSpot, text: Phaser.GameObjects.Text): Phaser.GameObjects.Text =>
      text.setPosition(spot.x, spot.y).setOrigin(spot.originX, 0).setDepth(D.hud);

    place(
      plaqueHud.scoreLabel,
      this.add.text(0, 0, 'SCORE', { fontFamily: FONT, fontSize: '15px', color: '#8e8ac4' }),
    ).setLetterSpacing(3);

    this.scoreText = place(
      plaqueHud.score,
      this.add.text(0, 0, '0', { fontFamily: FONT, fontSize: '44px', fontStyle: 'bold', color: '#ffffff' }),
    );
    this.scoreText.setShadow(0, 3, 'rgba(10,4,32,0.7)', 8, true, true);

    this.statLabel = place(
      plaqueHud.statLabel,
      this.add.text(0, 0, 'STAT', { fontFamily: FONT, fontSize: '15px', color: '#8e8ac4' }),
    ).setLetterSpacing(3);

    this.statText = place(
      plaqueHud.stat,
      this.add.text(0, 0, '', { fontFamily: FONT, fontSize: '44px', fontStyle: 'bold', color: '#f0abfc' }),
    );

    this.levelText = place(
      plaqueHud.level,
      this.add.text(0, 0, 'LEVEL 1', { fontFamily: FONT, fontSize: '15px', color: '#a7f3d0' }),
    ).setLetterSpacing(2);

    this.targetText = place(
      plaqueHud.target,
      this.add.text(0, 0, '', { fontFamily: FONT, fontSize: '15px', color: '#8e8ac4' }),
    );

    this.progress = this.add.graphics().setDepth(D.hud);

    // Combo + toast flourish over the board.
    this.comboText = this.add
      .text(WORLD_WIDTH / 2, comboY(), '', {
        fontFamily: FONT,
        fontSize: '54px',
        fontStyle: 'bold',
        color: '#ffffff',
      })
      .setOrigin(0.5)
      .setDepth(D.fx)
      .setAlpha(0)
      .setBlendMode(Phaser.BlendModes.ADD);

    // The message lines use the rounded display face with a thick dark outline, so they pop
    // off the gems instead of reading as a flat caption.
    this.comboNote = this.add
      .text(WORLD_WIDTH / 2, comboNoteY(), '', {
        fontFamily: MESSAGE_FONT,
        fontSize: '38px',
        fontStyle: 'bold',
        color: MOOPIT_ACCENT,
        stroke: '#140c2e',
        strokeThickness: 8,
      })
      .setOrigin(0.5)
      .setDepth(D.fx)
      .setAlpha(0);
    this.comboNote.setShadow(0, 4, 'rgba(6,2,20,0.9)', 10, true, true);

    this.toastText = this.add
      .text(0, 0, '', {
        fontFamily: MESSAGE_FONT,
        fontSize: '34px',
        fontStyle: 'bold',
        color: '#fde68a',
        align: 'center',
        stroke: '#140c2e',
        strokeThickness: 6,
        // A long line wraps instead of running off the edges of the board.
        wordWrap: { width: 600, useAdvancedWrap: true },
      })
      .setOrigin(0.5);
    this.toastText.setShadow(0, 3, 'rgba(6,2,20,0.85)', 8, true, true);
    this.toastBubble = this.add.graphics();
    this.toastBox = this.add
      .container(WORLD_WIDTH / 2, toastY(), [this.toastBubble, this.toastText])
      .setDepth(D.fx)
      .setAlpha(0);

    // Selection / hint rings.
    this.ring = this.add
      .image(0, 0, 'ring')
      .setDisplaySize(TILE, TILE)
      .setDepth(D.ring)
      .setVisible(false);
    this.hintRingA = this.add
      .image(0, 0, 'ring_hint')
      .setDisplaySize(TILE, TILE)
      .setDepth(D.ring)
      .setVisible(false);
    this.hintRingB = this.add
      .image(0, 0, 'ring_hint')
      .setDisplaySize(TILE, TILE)
      .setDepth(D.ring)
      .setVisible(false);
    this.cursorRing = this.add
      .image(0, 0, 'ring')
      .setDisplaySize(TILE - 6, TILE - 6)
      .setDepth(D.ring)
      .setAlpha(0.85)
      .setVisible(false);

    // Controls: a row along the bottom in portrait, a column right of the board in landscape.
    // Positions come from src/layout.ts, which spaces them so they cannot overlap.
    const controls = LAYOUT.controls;
    const [hintAt, pauseAt, soundAt, menuAt] = controls.centres;
    const w = controls.w;

    const hud = (name: string, x: number, pill: Pill): void => {
      this.hudPills.set(name, pill);
    };

    const hintPill = new Pill(this, {
      x: hintAt.x,
      y: hintAt.y,
      w,
      h: controls.h,
      label: 'HINT',
      variant: 'ghost',
      fontSize: controls.font,
      radius: 16,
      onClick: () => this.showHint(false),
    });
    hud('hint', hintPill.x, hintPill);
    this.pausePill = new Pill(this, {
      x: pauseAt.x,
      y: pauseAt.y,
      w,
      h: controls.h,
      label: 'PAUSE',
      variant: 'ghost',
      fontSize: controls.font,
      radius: 16,
      onClick: () => this.togglePause(),
    });
    hud('pause', this.pausePill.x, this.pausePill);
    this.mutePill = new Pill(this, {
      x: soundAt.x,
      y: soundAt.y,
      w,
      h: controls.h,
      label: this.settings.muted ? 'MUTED' : 'SOUND',
      variant: 'ghost',
      fontSize: controls.font,
      radius: 16,
      onClick: () => this.toggleMute(),
    });
    hud('sound', this.mutePill.x, this.mutePill);
    const menuPill = new Pill(this, {
      x: menuAt.x,
      y: menuAt.y,
      w,
      h: controls.h,
      label: 'MENU',
      variant: 'ghost',
      fontSize: controls.font,
      radius: 16,
      onClick: () => this.leaveToMenu(),
    });
    hud('menu', menuPill.x, menuPill);
  }

  private updateHud(): void {
    this.scoreText.setText(this.score.toLocaleString());

    if (this.mode === 'moves') {
      this.statLabel.setText('MOVES');
      this.statText.setText(String(Math.max(0, this.movesLeft)));
      this.statText.setColor(this.movesLeft <= 5 ? '#fca5a5' : '#f0abfc');
    } else if (this.mode === 'timed') {
      this.statLabel.setText('TIME');
      const seconds = Math.max(0, Math.ceil(this.timeLeftMs / 1000));
      const mm = Math.floor(seconds / 60);
      const ss = String(seconds % 60).padStart(2, '0');
      this.statText.setText(`${mm}:${ss}`);
      this.statText.setColor(seconds <= 10 ? '#fca5a5' : '#f0abfc');
    } else {
      this.statLabel.setText('SHUFFLES');
      this.statText.setText(
        this.shufflesLeft === Number.POSITIVE_INFINITY ? '∞' : String(Math.max(0, this.shufflesLeft)),
      );
      this.statText.setColor(this.shufflesLeft <= 1 ? '#fca5a5' : '#f0abfc');
    }

    const target = levelTarget(this.level);
    const ratio = Phaser.Math.Clamp(this.levelScore / target, 0, 1);

    this.levelText.setText(`LEVEL ${this.level}`);
    this.targetText.setText(`${Math.min(this.levelScore, target).toLocaleString()} / ${target.toLocaleString()}`);

    const { x, y, w } = LAYOUT.hud.bar;
    const h = 12;
    this.progress.clear();
    this.progress.fillStyle(0x0b0824, 0.85);
    this.progress.fillRoundedRect(x, y, w, h, h / 2);
    if (ratio > 0) {
      this.progress.fillStyle(0x7c6dfb, 1);
      this.progress.fillRoundedRect(x, y, Math.max(h, w * ratio), h, h / 2);
      this.progress.fillStyle(0xffffff, 0.32);
      this.progress.fillRoundedRect(x + 2, y + 2, Math.max(h * 0.5, w * ratio - 4), h * 0.4, h * 0.2);
    }
    this.progress.lineStyle(1, 0xffffff, 0.1);
    this.progress.strokeRoundedRect(x, y, w, h, h / 2);
  }

  private showToast(message: string, color = '#fde68a'): void {
    this.toastText.setText(message).setColor(color);
    this.drawToastBubble(color);

    this.tweens.killTweensOf(this.toastBox);
    // Pop in with a little overshoot, sit still long enough to read, then drift up and out.
    this.toastBox.setY(toastY()).setAlpha(0).setScale(this.reduceMotion ? 1 : 0.55);
    this.tweens.add({
      targets: this.toastBox,
      alpha: 1,
      scale: 1,
      duration: this.reduceMotion ? 0 : 320,
      ease: 'Back.easeOut',
    });
    this.tweens.add({
      targets: this.toastBox,
      alpha: 0,
      y: toastY() - 28,
      delay: (this.reduceMotion ? 0 : 320) + this.settings.messageHoldMs,
      duration: this.reduceMotion ? 0 : 420,
      ease: 'Sine.easeIn',
    });
  }

  /** Dark rounded bubble sized to the current toast text, rimmed in the toast's own colour. */
  private drawToastBubble(color: string): void {
    const rim = Phaser.Display.Color.HexStringToColor(color).color;
    const w = this.toastText.width + 44;
    const h = this.toastText.height + 20;
    const r = Math.min(h / 2, 30);
    const g = this.toastBubble;
    g.clear();
    // Soft outer glow, then the body, then a crisp rim.
    g.lineStyle(10, rim, 0.14);
    g.strokeRoundedRect(-w / 2 - 4, -h / 2 - 4, w + 8, h + 8, r + 4);
    g.fillStyle(0x140c2e, 0.82);
    g.fillRoundedRect(-w / 2, -h / 2, w, h, r);
    g.lineStyle(2.5, rim, 0.9);
    g.strokeRoundedRect(-w / 2, -h / 2, w, h, r);
  }

  private showCombo(multiplier: number, gemsCleared: number): void {
    if (multiplier < 1.5) return;
    const tier = multiplierTier(multiplier);
    // The default voice says nothing here; the personal voice adds a few words under the
    // number. Kay reads these on a big chain, so they are reassurance rather than hype.
    const note = pick(this.voice.comboTiers[tier] ?? [], '');

    this.tweens.killTweensOf([this.comboText, this.comboNote]);

    // Place both explicitly rather than resetting them in an `onComplete`: a combo that
    // lands mid-fade used to inherit whatever half-finished position the last one left.
    this.comboText
      .setText(`×${multiplier.toFixed(1)}`)
      .setColor(TIER_COLORS[tier])
      .setAlpha(1)
      .setScale(1.5)
      .setY(comboY());
    this.comboNote
      .setText(note)
      .setAlpha(note ? 1 : 0)
      .setScale(1.35)
      .setY(comboNoteY());

    this.tweens.add({
      targets: [this.comboText, this.comboNote],
      scale: 1,
      duration: this.reduceMotion ? 0 : 220,
      ease: 'Back.easeOut',
    });

    // The number keeps its snappy fade: it sits over the middle of the board, and the gems
    // underneath are what the player is reading. The word is smaller and sits lower, so it
    // can stay up — the little message is the whole point of the personal voice.
    const fadeMs = this.reduceMotion ? 0 : 320;
    this.tweens.add({
      targets: this.comboText,
      alpha: 0,
      y: comboY() - 40,
      delay: this.reduceMotion ? 0 : TIMING.comboFadeMs,
      duration: fadeMs,
    });
    this.tweens.add({
      targets: this.comboNote,
      alpha: 0,
      y: comboNoteY() - 40,
      delay: this.reduceMotion ? 0 : note ? this.settings.messageHoldMs : TIMING.comboFadeMs,
      duration: fadeMs,
    });
  }

  // ── Input ────────────────────────────────────────────────────────────────────

  private cellAt(x: number, y: number): Pos | null {
    const col = Math.floor((x - this.boardX) / TILE);
    const row = Math.floor((y - this.boardY) / TILE);
    const pos = { row, col };
    return inBounds(this.grid, pos) ? pos : null;
  }

  private setupInput(): void {
    this.input.on('pointerdown', (pointer: Phaser.Input.Pointer) => {
      sfx.unlock();
      this.hasInteracted = true;
      if (this.busy || this.over || this.paused) return;

      const pos = this.cellAt(pointer.worldX, pointer.worldY);
      if (!pos) return;

      this.clearHint();
      this.keyboardActive = false;
      this.cursorRing.setVisible(false);

      this.dragFrom = pos;
      this.dragStart = { x: pointer.worldX, y: pointer.worldY };

      if (this.selected) {
        if (this.selected.row === pos.row && this.selected.col === pos.col) {
          this.selected = null;
          this.refreshSelection();
          return;
        }
        if (areNeighbours(this.selected, pos)) {
          const from = this.selected;
          this.selected = null;
          this.refreshSelection();
          void this.runMove(from, pos);
          return;
        }
      }

      this.selected = pos;
      this.refreshSelection();
    });

    this.input.on('pointermove', (pointer: Phaser.Input.Pointer) => {
      if (this.busy || this.over || this.paused) return;
      if (!pointer.isDown || !this.dragFrom) return;

      const dx = pointer.worldX - this.dragStart.x;
      const dy = pointer.worldY - this.dragStart.y;
      if (Math.hypot(dx, dy) < TILE * SWIPE_THRESHOLD) return;

      const direction =
        Math.abs(dx) > Math.abs(dy)
          ? { row: 0, col: Math.sign(dx) }
          : { row: Math.sign(dy), col: 0 };

      const from = this.dragFrom;
      const target = { row: from.row + direction.row, col: from.col + direction.col };
      if (inBounds(this.grid, target)) {
        this.selected = null;
        this.refreshSelection();
        void this.runMove(from, target);
      }
      this.dragFrom = null;
    });

    this.input.on('pointerup', () => {
      this.dragFrom = null;
    });
  }

  private setupKeyboard(): void {
    const keyboard = this.input.keyboard;
    if (!keyboard) return;

    const handler = (event: KeyboardEvent): void => {
      const key = event.key.toLowerCase();
      sfx.unlock();
      this.hasInteracted = true;

      if (key === 'm') {
        this.toggleMute();
        return;
      }
      if (key === 'p' || key === 'escape') {
        this.togglePause();
        return;
      }
      if (this.over || this.paused) return;

      if (key === 'h' || key === ' ') {
        event.preventDefault();
        this.showHint(false);
        return;
      }
      if (key === 'r') {
        this.restart();
        return;
      }

      const moves: Record<string, Pos> = {
        arrowleft: { row: 0, col: -1 },
        arrowright: { row: 0, col: 1 },
        arrowup: { row: -1, col: 0 },
        arrowdown: { row: 1, col: 0 },
      };

      if (moves[key] && !this.busy) {
        event.preventDefault();
        const delta = moves[key];
        this.keyboardActive = true;
        this.selected = null;
        this.refreshSelection();
        this.keyboardCursor = {
          row: Phaser.Math.Clamp(this.keyboardCursor.row + delta.row, 0, this.spec.rows - 1),
          col: Phaser.Math.Clamp(this.keyboardCursor.col + delta.col, 0, this.spec.cols - 1),
        };
        this.refreshKeyboardCursor();
        return;
      }

      if (key === 'enter' && !this.busy && this.keyboardActive) {
        event.preventDefault();
        const cursor = this.keyboardCursor;
        if (this.selected && areNeighbours(this.selected, cursor)) {
          const from = this.selected;
          this.selected = null;
          this.refreshSelection();
          void this.runMove(from, cursor);
        } else {
          this.selected = cursor;
          this.refreshSelection();
        }
      }
    };

    keyboard.on('keydown', handler);
    this.events.once('shutdown', () => keyboard.off('keydown', handler));
    this.events.once('destroy', () => keyboard.off('keydown', handler));
  }

  private setupLifecycle(): void {
    const onHide = (): void => {
      // Only auto-pause a run the player has actually started; otherwise an unfocused
      // window (or a headless/screenshot load) would open the game already paused.
      if (this.ready && this.hasInteracted && !this.paused && !this.over) this.togglePause(true);
    };
    const onVisibility = (): void => {
      if (document.hidden) onHide();
    };

    window.addEventListener('blur', onHide);
    document.addEventListener('visibilitychange', onVisibility);
    this.events.once('shutdown', () => {
      wakeLock.hold(false);
      window.removeEventListener('blur', onHide);
      document.removeEventListener('visibilitychange', onVisibility);
    });
  }

  private refreshSelection(): void {
    if (!this.selected) {
      this.ring.setVisible(false);
      return;
    }
    const { x, y } = this.cellCenter(this.selected);
    this.ring.setPosition(x, y).setVisible(true);
    this.tweens.killTweensOf(this.ring);
    if (this.reduceMotion) {
      this.ring.setScale(this.ring.scaleX, this.ring.scaleY);
      this.ring.setDisplaySize(TILE, TILE);
      return;
    }
    this.ring.setDisplaySize(TILE * 1.05, TILE * 1.05);
    this.tweens.add({
      targets: this.ring,
      displayWidth: TILE * 0.9,
      displayHeight: TILE * 0.9,
      duration: 520,
      yoyo: true,
      repeat: -1,
      ease: 'Sine.easeInOut',
    });
  }

  private refreshKeyboardCursor(): void {
    if (!this.keyboardActive) return;
    const { x, y } = this.cellCenter(this.keyboardCursor);
    this.cursorRing.setPosition(x, y).setVisible(true);
  }

  // ── Move flow ────────────────────────────────────────────────────────────────

  private wouldMatch(a: Pos, b: Pos): boolean {
    swapCells(this.grid, a, b);
    const matched = findGroups(this.grid).length > 0;
    swapCells(this.grid, a, b);
    return matched;
  }

  private async runMove(a: Pos, b: Pos): Promise<void> {
    if (this.busy || this.over || this.paused) return;

    const cellA = this.grid[a.row][a.col];
    const cellB = this.grid[b.row][b.col];
    if (!cellA || !cellB) return;

    const hyperInvolved = cellA.special === 'hyper' || cellB.special === 'hyper';

    if (!hyperInvolved && !this.wouldMatch(a, b)) {
      await this.rejectSwap(a, b);
      return;
    }

    this.busy = true;
    this.clearHint();
    this.lastMoveAt = performance.now();

    swapCells(this.grid, a, b);
    sfx.swap();
    this.rebuildPosIndex();
    await this.syncPositions(0, 0, true);

    // A hypercube swap clears every gem sharing the other gem's colour.
    let pendingHyper: { specialPos: Pos; cleared: Set<string> } | null = null;
    if (hyperInvolved) {
      const bothHyper = cellA.special === 'hyper' && cellB.special === 'hyper';
      const specialPos: Pos = cellA.special === 'hyper' ? b : a;
      const otherPos: Pos = cellA.special === 'hyper' ? a : b;
      const otherType = this.grid[otherPos.row][otherPos.col]?.type ?? -1;

      const cleared = new Set<string>([posKey(a), posKey(b)]);
      if (bothHyper) {
        for (let row = 0; row < this.spec.rows; row++) {
          for (let col = 0; col < this.spec.cols; col++) cleared.add(posKey({ row, col }));
        }
      } else if (otherType >= 0) {
        for (let row = 0; row < this.spec.rows; row++) {
          for (let col = 0; col < this.spec.cols; col++) {
            if (this.grid[row][col]?.type === otherType) cleared.add(posKey({ row, col }));
          }
        }
      }
      pendingHyper = { specialPos, cleared };
      sfx.hyper();
    }

    this.consumeMove();
    await this.resolveLoop(b, pendingHyper);
    this.busy = false;
    await this.afterSettle();
  }

  private async rejectSwap(a: Pos, b: Pos): Promise<void> {
    this.busy = true;
    sfx.invalid();
    this.showToast(pick(this.voice.toast.noMatch, ''), '#fca5a5');

    swapCells(this.grid, a, b);
    this.rebuildPosIndex();
    await this.syncPositions(0, 0, true);

    const spriteA = this.spriteOf.get(this.grid[a.row][a.col] as Cell);
    const spriteB = this.spriteOf.get(this.grid[b.row][b.col] as Cell);
    [spriteA, spriteB].forEach((sprite) => {
      if (!sprite) return;
      this.tweens.add({
        targets: sprite,
        x: sprite.x + Phaser.Math.Between(-4, 4),
        duration: 45,
        yoyo: true,
        repeat: 3,
      });
    });

    await new Promise((resolve) => this.time.delayedCall(TIMING.rejectMs, resolve));

    swapCells(this.grid, a, b);
    this.rebuildPosIndex();
    await this.syncPositions(0, 0, true);
    this.busy = false;
    this.scheduleAutoHint();
  }

  private consumeMove(): void {
    if (this.mode === 'moves') {
      this.movesLeft -= 1;
      this.updateHud();
    }
  }

  private addScore(amount: number): void {
    this.score += amount;
    this.levelScore += amount;
    this.updateHud();
  }

  /** The cascade engine: keeps resolving until the board is quiet. */
  private async resolveLoop(
    origin: Pos | null,
    pendingHyper: { specialPos: Pos; cleared: Set<string> } | null,
  ): Promise<void> {
    let depth = 0;
    let hyper = pendingHyper;

    for (let guard = 0; guard < 60; guard++) {
      let groups = findGroups(this.grid);
      let cleared: Set<string>;
      let detonations: Detonation[] = [];

      if (hyper) {
        // Consume the hypercube's flag so the generic expansion does not re-trigger it.
        const specialCell = this.grid[hyper.specialPos.row][hyper.specialPos.col];
        if (specialCell) specialCell.special = 'none';

        const expanded = expandDetonations(this.grid, hyper.cleared);
        cleared = expanded.cleared;
        detonations = expanded.detonations;
        detonations.push({
          pos: hyper.specialPos,
          special: 'hyper',
          type: -1,
          cells: [...hyper.cleared].map(parseKey),
        });
        groups = [];
        hyper = null;
      } else {
        if (groups.length === 0) break;
        const base = new Set<string>();
        for (const group of groups) for (const cell of group.cells) base.add(posKey(cell));
        const expanded = expandDetonations(this.grid, base);
        cleared = expanded.cleared;
        detonations = expanded.detonations;
      }

      depth += 1;
      this.cascadeDepth = depth;

      const spawns = groups.length > 0 ? planSpecials(groups, origin) : [];
      const lines = detonations.filter((d) => d.special === 'lineH' || d.special === 'lineV').length;
      const bombs = detonations.filter((d) => d.special === 'bomb').length;
      const hypers = detonations.filter((d) => d.special === 'hyper').length;

      const result = stepScore({
        gemsCleared: cleared.size,
        cascadeDepth: depth,
        lines,
        bombs,
        hypers,
        secondsSinceLastMove: (performance.now() - this.lastMoveAt) / 1000,
        useSpeedBonus: this.mode !== 'timed',
      });

      this.addScore(result.total);
      this.showCombo(result.multiplier, cleared.size);
      this.showFloatingPoints(cleared, result.total, result.multiplier);

      sfx.match(depth);
      if (hypers > 0) sfx.hyper();
      if (bombs > 0) sfx.bomb();
      if (lines > 0) sfx.line();

      const clearedPositions = [...cleared].map(parseKey);
      for (const pos of clearedPositions) {
        const cell = this.grid[pos.row]?.[pos.col];
        this.burst(pos, cell ? cell.type : -1, 8 + Math.min(10, depth * 2));
      }
      if (!this.reduceMotion && clearedPositions.length > 4) this.cameras.main.shake(140, 0.0035);

      // A power gem going off is a bigger bang than a plain match, so it buzzes harder.
      // The pulse itself is fired inside animateClear, on the frame the gems burst.
      await this.animateClear(clearedPositions, depth, lines + bombs + hypers > 0);

      // Created power gems replace the cells they spawned in.
      for (const spawn of spawns) {
        const cell: Cell = { type: spawn.type, special: spawn.special };
        this.grid[spawn.pos.row][spawn.pos.col] = cell;
        this.createSprite(cell, spawn.pos, 0, true);
      }

      const falls = applyGravity(this.grid);
      if (falls.length > 0) await this.syncPositions(TIMING.fallMsPerTile, TIMING.fallMinMs);

      const spawnsNew = refill(this.grid, this.spec.types, this.rand);
      if (spawnsNew.length > 0) {
        for (const spawn of spawnsNew) {
          const cell = this.grid[spawn.row][spawn.col];
          if (cell) this.createSprite(cell, { row: spawn.row, col: spawn.col }, spawn.rowsAbove, false);
        }
        await this.syncPositions(TIMING.fallMsPerTile, TIMING.fallMinMs);
      }

      this.rebuildPosIndex();
    }

    this.cascadeDepth = 0;
  }

  /**
   * Blow a matched group apart.
   *
   * Three beats, so a clear reads as a hit rather than a blink: the gems inhale
   * (squash inward), flash white, then burst outward and vanish. Deeper cascades
   * run the same animation faster so a long chain stays snappy.
   */
  private async animateClear(cells: Pos[], depth = 1, heavy = false): Promise<void> {
    const total = Math.max(
      TIMING.clearMinMs,
      TIMING.clearMs * Math.pow(TIMING.cascadeRamp, Math.max(0, depth - 1)),
    );
    const inhaleMs = total * 0.18;
    const explodeMs = total - inhaleMs;
    const work: Promise<void>[] = [];

    // Buzz on the burst beat, and put it in the same callback that flashes the gem white
    // rather than on a timer of its own: `onStart` fires once the inhale delay has expired,
    // which is the frame the gems let go, so the buzz and the flash cannot drift apart.
    // One pulse per step — a step is a match or a detonation, never both.
    let buzzed = false;
    const buzz = (): void => {
      if (buzzed) return;
      buzzed = true;
      haptics.explosion(depth, heavy);
    };

    for (const pos of cells) {
      const cell = this.grid[pos.row]?.[pos.col];
      if (!cell) continue;
      const sprite = this.spriteOf.get(cell);
      if (!sprite) continue;

      if (this.reduceMotion) {
        sprite.setAlpha(0);
        continue;
      }

      this.tweens.killTweensOf(sprite);

      // 1. Inhale — pull inward, winding up.
      work.push(
        tweenPromise(this, {
          targets: sprite,
          scale: baseScale() * 0.78,
          duration: inhaleMs,
          ease: 'Quad.easeIn',
        }),
      );

      // 2. Flash white as it lets go, so the burst has a bright frame.
      // 3. Explode outward while fading out; both finish together.
      work.push(
        tweenPromise(this, {
          targets: sprite,
          alpha: 0,
          duration: explodeMs,
          delay: inhaleMs,
          ease: 'Quad.easeIn',
          // tweenPromise owns onComplete, so hook the flash on start instead.
          onStart: () => {
            sprite.setTint(0xffffff).setTintMode(Phaser.TintModes.FILL);
            buzz();
          },
        }),
      );
      work.push(
        tweenPromise(this, {
          targets: sprite,
          scale: baseScale() * 1.9,
          duration: explodeMs,
          delay: inhaleMs,
          ease: 'Back.easeOut',
        }),
      );
    }

    // Nothing animated (reduced motion, or no sprites left to flash): buzz straight away.
    if (work.length === 0) buzz();

    await Promise.all(work);

    for (const pos of cells) {
      const cell = this.grid[pos.row]?.[pos.col];
      if (!cell) continue;
      this.spriteOf.get(cell)?.destroy();
      this.spriteOf.delete(cell);
      this.grid[pos.row][pos.col] = null;
    }
    this.rebuildPosIndex();
  }

  private showFloatingPoints(cleared: Set<string>, amount: number, multiplier: number): void {
    if (this.reduceMotion) return;

    let sumX = 0;
    let sumY = 0;
    for (const key of cleared) {
      const pos = parseKey(key);
      const { x, y } = this.cellCenter(pos);
      sumX += x;
      sumY += y;
    }
    const cx = sumX / cleared.size;
    const cy = sumY / cleared.size;

    const label = this.add
      .text(cx, cy, `+${amount.toLocaleString()}`, {
        fontFamily: FONT,
        fontSize: '30px',
        fontStyle: 'bold',
        color: TIER_COLORS[multiplierTier(multiplier)],
      })
      .setOrigin(0.5)
      .setDepth(D.fx);
    label.setShadow(0, 3, 'rgba(6,2,20,0.8)', 6, true, true);

    this.tweens.add({
      targets: label,
      y: cy - 54,
      alpha: { from: 1, to: 0 },
      scale: { from: 1.15, to: 0.9 },
      duration: 760,
      ease: 'Sine.easeOut',
      onComplete: () => label.destroy(),
    });
  }

  // ── Post-move bookkeeping ────────────────────────────────────────────────────

  private async afterSettle(): Promise<void> {
    this.cascadeDepth = 0;
    this.checkLevelUp();
    this.updateHud();

    if (this.mode === 'moves' && this.movesLeft <= 0) {
      await this.endRun('Out of moves');
      return;
    }
    if (this.mode === 'timed' && this.timeLeftMs <= 0) {
      await this.endRun("Time's up");
      return;
    }

    if (findValidMoves(this.grid, 1).length === 0) {
      await this.handleDeadlock();
      if (this.over) return;
    }

    this.persistRun();
    this.scheduleAutoHint();
  }

  private checkLevelUp(): void {
    let leveled = false;
    let target = levelTarget(this.level);
    while (this.levelScore >= target) {
      this.levelScore -= target;
      this.level += 1;
      leveled = true;
      target = levelTarget(this.level);
    }
    if (leveled) {
      sfx.levelUp();
      this.showBanner(this.voice.level.title(this.level), pick(this.voice.level.notes, '') || null);
    }
  }

  private showBanner(text: string, note: string | null = null): void {
    const banner = this.add
      .text(WORLD_WIDTH / 2, comboY(), text, {
        fontFamily: FONT,
        fontSize: '64px',
        fontStyle: 'bold',
        color: '#ffffff',
      })
      .setOrigin(0.5)
      .setDepth(D.fx)
      .setAlpha(0);
    banner.setShadow(0, 6, 'rgba(124,109,251,0.9)', 18, true, true);

    this.tweens.add({
      targets: banner,
      alpha: 1,
      scale: { from: 0.6, to: 1 },
      duration: this.reduceMotion ? 0 : 260,
      ease: 'Back.easeOut',
      yoyo: true,
      // The player's message time, reduced motion or not: that setting is about movement,
      // not about how long there is to read.
      hold: this.settings.messageHoldMs,
      onComplete: () => banner.destroy(),
    });

    if (note) this.showBannerNote(note);
  }

  /**
   * The personal voice's line above a level banner. Sits above the big LEVEL text, where
   * nothing else lives, and fades out with it. Indigo, because it is her colour.
   */
  private showBannerNote(note: string): void {
    const line = this.add
      .text(WORLD_WIDTH / 2, comboY() - 72, note, {
        fontFamily: MESSAGE_FONT,
        fontSize: '38px',
        fontStyle: 'bold',
        color: MOOPIT_ACCENT,
        stroke: '#140c2e',
        strokeThickness: 8,
      })
      .setOrigin(0.5)
      .setDepth(D.fx)
      .setAlpha(0);
    line.setShadow(0, 4, 'rgba(10,4,32,0.7)', 10, true, true);

    this.tweens.add({
      targets: line,
      alpha: 1,
      duration: this.reduceMotion ? 0 : 260,
      yoyo: true,
      // The player's message time, reduced motion or not: that setting is about movement,
      // not about how long there is to read.
      hold: this.settings.messageHoldMs,
      onComplete: () => line.destroy(),
    });
  }

  private async handleDeadlock(): Promise<void> {
    if (this.over) return;

    if (this.shufflesLeft <= 0) {
      await this.endRun('Out of shuffles');
      return;
    }

    this.busy = true;
    this.showToast(pick(this.voice.toast.shuffling, ''), '#fde68a');
    sfx.shuffle();

    if (this.shufflesLeft !== Number.POSITIVE_INFINITY) {
      this.shufflesLeft -= 1;
      this.updateHud();
    }

    const sprites = [...this.spriteOf.values()];
    if (!this.reduceMotion) {
      await Promise.all(
        sprites.map((sprite) =>
          tweenPromise(this, {
            targets: sprite,
            alpha: 0.2,
            scale: baseScale() * 0.7,
            duration: 160,
            ease: 'Quad.easeIn',
          }),
        ),
      );
    }

    const shuffled = shuffleGrid(this.grid, this.rand);
    if (!shuffled) {
      // Last resort: a brand-new board. Score and level are preserved.
      this.grid = createGrid(this.spec.cols, this.spec.rows, this.spec.types, this.rand);
      for (const sprite of this.spriteOf.values()) sprite.destroy();
      this.spriteOf.clear();
      this.buildSprites();
    } else {
      this.rebuildPosIndex();
      await this.syncPositions(0, 0, true);
    }

    if (!this.reduceMotion) {
      await Promise.all(
        [...this.spriteOf.values()].map((sprite) =>
          tweenPromise(this, {
            targets: sprite,
            alpha: 1,
            scale: baseScale(),
            duration: 220,
            ease: 'Back.easeOut',
          }),
        ),
      );
    }

    this.busy = false;
    this.persistRun();
    this.scheduleAutoHint();
  }

  // ── Hints ────────────────────────────────────────────────────────────────────

  private scheduleAutoHint(): void {
    this.hintTimer?.remove();
    if (this.over) return;

    this.hintTimer = this.time.delayedCall(this.spec.hintDelayMs, () => {
      if (this.busy || this.over || this.paused || this.selected || this.dragFrom) {
        this.scheduleAutoHint();
        return;
      }
      this.showHint(true);
    });
  }

  private showHint(auto: boolean): void {
    if (this.busy || this.over || this.paused) return;

    const moves = findValidMoves(this.grid, 1);
    if (moves.length === 0) {
      this.showToast(this.voice.toast.noMoves, '#fca5a5');
      void this.handleDeadlock();
      return;
    }

    const move: Move = moves[0];
    for (const [pos, ring] of [
      [move.a, this.hintRingA] as const,
      [move.b, this.hintRingB] as const,
    ]) {
      const { x, y } = this.cellCenter(pos);
      ring.setPosition(x, y).setVisible(true).setAlpha(1);
      this.tweens.killTweensOf(ring);
      this.tweens.add({
        targets: ring,
        alpha: { from: 1, to: 0.25 },
        duration: TIMING.hintPulseMs / 2,
        yoyo: true,
        repeat: this.reduceMotion ? 2 : 4,
        onComplete: () => ring.setVisible(false),
      });
    }

    if (auto) this.showToast(pick(this.voice.toast.hint, ''), '#a7f3d0');
    this.scheduleAutoHint();
  }

  private clearHint(): void {
    this.tweens.killTweensOf(this.hintRingA);
    this.tweens.killTweensOf(this.hintRingB);
    this.hintRingA.setVisible(false);
    this.hintRingB.setVisible(false);
  }

  // ── Pause / overlays ─────────────────────────────────────────────────────────

  private togglePause(force?: boolean): void {
    if (this.over) return;
    const next = force ?? !this.paused;
    if (next === this.paused) return;

    this.paused = next;
    wakeLock.hold(!this.paused);

    if (this.paused) {
      this.clearIntroFade();
      this.tweens.pauseAll();
      this.time.paused = true;
      this.pausePill.setLabel('RESUME');
      this.buildOverlay({
        title: this.voice.paused.title,
        lines: [
          `${MODES[this.mode].label} · ${DIFFICULTIES[this.difficulty].label}`,
          `Score ${this.score.toLocaleString()} · Level ${this.level}`,
          ...this.voice.paused.extra,
        ],
        buttons: [
          {
            label: 'RESUME',
            variant: 'primary',
            onClick: () => this.togglePause(false),
          },
          {
            label: 'RESTART',
            variant: 'ghost',
            onClick: () => this.restart(),
          },
          {
            label: this.settings.muted ? 'SOUND OFF' : 'SOUND ON',
            variant: 'ghost',
            onClick: () => this.toggleMute(),
          },
        ],
      });
    } else {
      this.time.paused = false;
      this.tweens.resumeAll();
      this.pausePill.setLabel('PAUSE');
      this.hideOverlay();
      this.scheduleAutoHint();
    }
  }

  private buildOverlay(config: {
    title: string;
    lines: string[];
    buttons: { label: string; variant: 'primary' | 'ghost' | 'accent'; onClick: () => void }[];
  }): void {
    this.hideOverlay();

    const container = this.add.container(0, 0).setDepth(D.overlay);

    const scrim = this.add
      .rectangle(WORLD_WIDTH / 2, GAME_HEIGHT / 2, WORLD_WIDTH, GAME_HEIGHT, 0x05030f, 0.78)
      .setInteractive();
    container.add(scrim);

    const panelW = 520;
    const panelH = 200 + config.lines.length * 30 + config.buttons.length * 78;
    const panelY = GAME_HEIGHT / 2;

    const panel = this.add.graphics();
    panel.fillStyle(0x1b1440, 0.99);
    panel.fillRoundedRect(WORLD_WIDTH / 2 - panelW / 2, panelY - panelH / 2, panelW, panelH, 30);
    panel.fillStyle(0xffffff, 0.05);
    panel.fillRoundedRect(WORLD_WIDTH / 2 - panelW / 2 + 4, panelY - panelH / 2 + 4, panelW - 8, panelH * 0.35, {
      tl: 26,
      tr: 26,
      bl: 0,
      br: 0,
    });
    panel.lineStyle(2, 0xffffff, 0.12);
    panel.strokeRoundedRect(WORLD_WIDTH / 2 - panelW / 2, panelY - panelH / 2, panelW, panelH, 30);
    container.add(panel);

    const title = this.add
      .text(WORLD_WIDTH / 2, panelY - panelH / 2 + 62, config.title, {
        fontFamily: FONT,
        fontSize: '48px',
        fontStyle: 'bold',
        color: '#ffffff',
      })
      .setOrigin(0.5);
    title.setShadow(0, 5, 'rgba(124,109,251,0.85)', 14, true, true);
    container.add(title);

    config.lines.forEach((line, i) => {
      const text = this.add
        .text(WORLD_WIDTH / 2, panelY - panelH / 2 + 118 + i * 30, line, {
          fontFamily: FONT,
          fontSize: '21px',
          color: '#c9c6f5',
        })
        .setOrigin(0.5);
      container.add(text);
    });

    let buttonY = panelY - panelH / 2 + 176 + config.lines.length * 30;
    for (const button of config.buttons) {
      const pill = new Pill(this, {
        x: WORLD_WIDTH / 2,
        y: buttonY,
        w: 380,
        h: 66,
        label: button.label,
        variant: button.variant,
        fontSize: 22,
        onClick: button.onClick,
      });
      container.add(pill);
      buttonY += 78;
    }

    // Never rely on a tween for visibility: while paused, all tweens are frozen.
    if (this.paused || this.reduceMotion) container.setAlpha(1);
    else {
      container.setAlpha(0);
      this.tweens.add({ targets: container, alpha: 1, duration: 180 });
    }
    this.overlay = container;
  }

  private hideOverlay(): void {
    this.overlay?.destroy(true);
    this.overlay = null;
  }

  // ── Lifecycle / ending ───────────────────────────────────────────────────────

  private startClock(): void {
    if (this.mode !== 'timed') return;

    this.clock = this.time.addEvent({
      delay: 100,
      loop: true,
      callback: () => {
        if (this.paused || this.over) return;
        this.timeLeftMs -= 100;
        this.updateHud();
        if (this.timeLeftMs <= 0) {
          this.timeLeftMs = 0;
          void this.endRun("Time's up");
        }
      },
    });
  }

  private async endRun(reason: string): Promise<void> {
    if (this.over) return;
    this.over = true;
    wakeLock.hold(false);
    this.busy = true;
    this.clearHint();
    this.hintTimer?.remove();
    this.clock?.remove();

    const isBest = submitHighScore(this.mode, this.difficulty, this.score, this.level);
    clearSavedRun();

    sfx.gameOver();
    if (isBest) this.time.delayedCall(700, () => sfx.newBest());

    if (!this.reduceMotion) {
      this.cameras.main.shake(240, 0.006);
      const flash = this.add
        .rectangle(WORLD_WIDTH / 2, GAME_HEIGHT / 2, WORLD_WIDTH, GAME_HEIGHT, 0x000000, 0.55)
        .setDepth(D.overlay - 1);
      this.tweens.add({ targets: flash, alpha: 0, duration: 500, onComplete: () => flash.destroy() });
    }

    this.buildOverlay({
      title: this.voice.gameOver.title,
      lines: [
        reason,
        `SCORE  ${this.score.toLocaleString()}`,
        isBest ? this.voice.gameOver.best : `BEST  ${this.bestScore().toLocaleString()}`,
        `LEVEL ${this.level} · ${MODES[this.mode].label} · ${DIFFICULTIES[this.difficulty].label}`,
        ...this.voice.gameOver.extra,
      ],
      buttons: [
        { label: 'PLAY AGAIN', variant: 'primary', onClick: () => this.restart() },
        { label: 'CHANGE SETUP', variant: 'ghost', onClick: () => this.leaveToMenu() },
      ],
    });
  }

  private bestScore(): number {
    try {
      const all = JSON.parse(window.localStorage.getItem('bejeweled.highscores.v1') ?? '{}') as Record<
        string,
        { score: number }
      >;
      return all[`${this.mode}:${this.difficulty}`]?.score ?? this.score;
    } catch {
      return this.score;
    }
  }

  private persistRun(): void {
    if (this.over) return;
    saveRun({
      mode: this.mode,
      difficulty: this.difficulty,
      grid: serializeGrid(this.grid),
      score: this.score,
      level: this.level,
      levelScore: this.levelScore,
      movesLeft: Number.isFinite(this.movesLeft) ? this.movesLeft : -1,
      timeLeftMs: Number.isFinite(this.timeLeftMs) ? this.timeLeftMs : -1,
      shuffles: this.shufflesLeft === Number.POSITIVE_INFINITY ? 0 : Math.max(0, MODE_RULES.endlessShuffles - this.shufflesLeft),
    });
  }

  private restart(): void {
    this.hideOverlay();
    this.tweens.resumeAll();
    this.scene.restart({ mode: this.mode, difficulty: this.difficulty });
  }

  private leaveToMenu(): void {
    if (!this.over) this.persistRun();
    this.hideOverlay();
    this.tweens.resumeAll();
    this.time.paused = false;
    this.scene.start('menu');
  }

  private toggleMute(): void {
    this.settings.muted = !this.settings.muted;
    saveSettings(this.settings);
    sfx.muted = this.settings.muted;
    this.mutePill.setLabel(this.settings.muted ? 'MUTED' : 'SOUND');
    if (!this.settings.muted) {
      sfx.unlock();
      sfx.click();
    }
  }
}
