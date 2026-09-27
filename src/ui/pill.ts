import Phaser from 'phaser';
import { FONT } from '../config';
import { sfx } from '../audio/sfx';

/** Tween as a promise so the move flow can be written top-to-bottom. */
export const tweenPromise = (
  scene: Phaser.Scene,
  config: Phaser.Types.Tweens.TweenBuilderConfig,
): Promise<void> =>
  new Promise((resolve) => {
    scene.tweens.add({ ...config, onComplete: () => resolve() });
  });

export type PillVariant = 'primary' | 'ghost' | 'accent';

export interface PillOptions {
  x: number;
  y: number;
  w: number;
  h: number;
  label: string;
  sub?: string;
  variant?: PillVariant;
  fontSize?: number;
  radius?: number;
  selected?: boolean;
  onClick: () => void;
}

const PALETTE: Record<PillVariant, { fill: number; fill2: number; stroke: number; text: string }> = {
  primary: { fill: 0x5b4bd6, fill2: 0x7c6dfb, stroke: 0xc7d2fe, text: '#ffffff' },
  accent: { fill: 0x9b3fd0, fill2: 0xc65ce8, stroke: 0xf5d0fe, text: '#ffffff' },
  ghost: { fill: 0x1d1745, fill2: 0x272052, stroke: 0x9d9ce0, text: '#dcd9ff' },
};

/**
 * Big, touch-friendly rounded button (a11y decision: "big on screen").
 * Used for every interactive control in the game.
 */
export class Pill extends Phaser.GameObjects.Container {
  private readonly gfx: Phaser.GameObjects.Graphics;
  private readonly labelText: Phaser.GameObjects.Text;
  private readonly subText?: Phaser.GameObjects.Text;
  private readonly opts: Required<Omit<PillOptions, 'sub'>> & { sub?: string };
  private isSelected: boolean;
  private isEnabled = true;
  private isHovering = false;

  constructor(scene: Phaser.Scene, options: PillOptions) {
    super(scene, options.x, options.y);
    this.opts = {
      radius: options.radius ?? Math.min(18, options.h / 3),
      variant: options.variant ?? 'primary',
      fontSize: options.fontSize ?? 22,
      selected: options.selected ?? false,
      ...options,
    } as Required<Omit<PillOptions, 'sub'>> & { sub?: string };

    this.isSelected = this.opts.selected;

    this.gfx = scene.add.graphics();
    this.add(this.gfx);

    const hasSub = Boolean(options.sub);
    this.labelText = scene.add
      .text(0, hasSub ? -options.h * 0.16 : 0, options.label, {
        fontFamily: FONT,
        fontSize: `${this.opts.fontSize}px`,
        fontStyle: 'bold',
        color: PALETTE[this.opts.variant].text,
      })
      .setOrigin(0.5);
    this.add(this.labelText);

    if (hasSub) {
      this.subText = scene.add
        .text(0, options.h * 0.19, options.sub as string, {
          fontFamily: FONT,
          fontSize: `${Math.max(12, Math.round(this.opts.fontSize * 0.58))}px`,
          color: '#c9c6f5',
        })
        .setOrigin(0.5);
      this.add(this.subText);
    }

    this.setSize(options.w, options.h);

    // Phaser adds the Container's displayOrigin (w/2, h/2) to the local point before it tests
    // the hit area (InputManager#pointWithinHitArea), while our artwork is drawn centred on the
    // origin. So the hit rectangle has to be expressed in 0..w / 0..h space; a rect centred on
    // the origin shifts the whole hit area left and up by half a pill, leaving the right half of
    // every button dead. This matches the Rectangle(0, 0, w, h) Phaser builds in
    // setHitAreaFromTexture, and that method needs setSize() to have run first, as it has above.
    this.setInteractive(
      new Phaser.Geom.Rectangle(0, 0, options.w, options.h),
      Phaser.Geom.Rectangle.Contains,
    );
    this.input!.cursor = 'pointer';

    this.on('pointerover', () => {
      this.isHovering = true;
      if (this.isEnabled) scene.tweens.add({ targets: this, scale: 1.035, duration: 110 });
      this.redraw();
    });
    this.on('pointerout', () => {
      this.isHovering = false;
      scene.tweens.add({ targets: this, scale: 1, duration: 110 });
      this.redraw();
    });
    this.on('pointerdown', () => {
      if (!this.isEnabled) return;
      sfx.unlock();
      scene.tweens.add({ targets: this, scale: 0.97, duration: 80, yoyo: true });
    });
    this.on('pointerup', () => {
      if (!this.isEnabled) return;
      sfx.click();
      this.opts.onClick();
    });

    this.redraw();
    scene.add.existing(this);
  }

  setSelected(selected: boolean): this {
    this.isSelected = selected;
    this.redraw();
    return this;
  }

  setEnabled(enabled: boolean): this {
    this.isEnabled = enabled;
    this.setAlpha(enabled ? 1 : 0.45);
    if (enabled) {
      // setInteractive() rebuilds the Input object, so the cursor has to be reapplied.
      this.setInteractive(
        new Phaser.Geom.Rectangle(0, 0, this.opts.w, this.opts.h),
        Phaser.Geom.Rectangle.Contains,
      );
      this.input!.cursor = 'pointer';
    } else {
      this.disableInteractive();
    }
    this.redraw();
    return this;
  }

  setLabel(label: string): this {
    this.labelText.setText(label);
    return this;
  }

  setSubLabel(sub: string): this {
    this.subText?.setText(sub);
    return this;
  }

  private redraw(): void {
    const { w, h, radius, variant } = this.opts;
    const p = PALETTE[variant];
    const g = this.gfx;
    g.clear();

    const bright = this.isHovering && this.isEnabled;

    // Drop shadow.
    g.fillStyle(0x05030f, 0.45);
    g.fillRoundedRect(-w / 2, -h / 2 + 5, w, h, radius);

    // Body: two stacked fills approximate a soft vertical gradient.
    g.fillStyle(p.fill, 1);
    g.fillRoundedRect(-w / 2, -h / 2, w, h, radius);
    g.fillStyle(p.fill2, bright ? 0.85 : 0.6);
    g.fillRoundedRect(-w / 2, -h / 2, w, h * 0.55, { tl: radius, tr: radius, bl: 0, br: 0 });

    // Gloss.
    g.fillStyle(0xffffff, bright ? 0.16 : 0.1);
    g.fillRoundedRect(-w / 2 + 4, -h / 2 + 4, w - 8, h * 0.34, { tl: radius, tr: radius, bl: 0, br: 0 });

    // Stroke, brighter when selected/hovered.
    g.lineStyle(this.isSelected ? 3 : 1.5, p.stroke, this.isSelected ? 0.95 : bright ? 0.6 : 0.28);
    g.strokeRoundedRect(-w / 2, -h / 2, w, h, radius);

    if (this.isSelected) {
      g.lineStyle(6, p.stroke, 0.18);
      g.strokeRoundedRect(-w / 2 - 3, -h / 2 - 3, w + 6, h + 6, radius + 3);
    }
  }
}
