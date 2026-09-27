import Phaser from 'phaser';
import { GEM_COLORS, GEM_SHAPES, TEX_SIZE, type GemShape } from '../config';
import type { Special } from '../core/types';

/**
 * Procedural gem art. Frame keys match the sprite-sheet contract in spec §7
 * (`gem_<colour>`, `special_line_<colour>`, `special_bomb_<colour>`, `special_hyper`) so real
 * art can later replace these textures with no code change.
 *
 * Every colour also has a distinct silhouette, so colour is never the only signal.
 */

const CENTER = TEX_SIZE / 2;
const RADIUS = TEX_SIZE * 0.4;

/** amount > 0 lightens toward white, amount < 0 darkens toward black. */
function shade(color: number, amount: number): number {
  const c = Phaser.Display.Color.IntegerToColor(color);
  const target = amount >= 0 ? 255 : 0;
  const t = Math.abs(amount);
  const mix = (v: number): number => Math.round(v + (target - v) * t);
  return Phaser.Display.Color.GetColor(mix(c.red), mix(c.green), mix(c.blue));
}

const polygon = (
  cx: number,
  cy: number,
  radius: number,
  sides: number,
  rotation = -Math.PI / 2,
): Phaser.Math.Vector2[] =>
  Array.from({ length: sides }, (_, i) => {
    const angle = rotation + (i * Math.PI * 2) / sides;
    return new Phaser.Math.Vector2(cx + Math.cos(angle) * radius, cy + Math.sin(angle) * radius);
  });

const starPoints = (
  cx: number,
  cy: number,
  outer: number,
  inner: number,
  points = 4,
  rotation = -Math.PI / 2,
): Phaser.Math.Vector2[] =>
  Array.from({ length: points * 2 }, (_, i) => {
    const angle = rotation + (i * Math.PI) / points;
    const radius = i % 2 === 0 ? outer : inner;
    return new Phaser.Math.Vector2(cx + Math.cos(angle) * radius, cy + Math.sin(angle) * radius);
  });

function fillShape(
  g: Phaser.GameObjects.Graphics,
  shape: GemShape,
  cx: number,
  cy: number,
  radius: number,
): void {
  switch (shape) {
    case 'square':
      g.fillRoundedRect(cx - radius, cy - radius, radius * 2, radius * 2, radius * 0.36);
      break;
    case 'circle':
      g.fillCircle(cx, cy, radius);
      break;
    case 'diamond':
      g.fillPoints(polygon(cx, cy, radius * 1.08, 4), true);
      break;
    case 'hexagon':
      g.fillPoints(polygon(cx, cy, radius, 6), true);
      break;
    case 'pentagon':
      g.fillPoints(polygon(cx, cy, radius, 5, Math.PI / 2), true);
      break;
    case 'octagon':
      g.fillPoints(polygon(cx, cy, radius, 8, Math.PI / 8), true);
      break;
    case 'star':
      g.fillPoints(starPoints(cx, cy, radius * 1.05, radius * 0.42, 4), true);
      break;
  }
}

function strokeShape(
  g: Phaser.GameObjects.Graphics,
  shape: GemShape,
  cx: number,
  cy: number,
  radius: number,
  width: number,
): void {
  switch (shape) {
    case 'square':
      g.lineStyle(width, 0xffffff, 0.5);
      g.strokeRoundedRect(cx - radius, cy - radius, radius * 2, radius * 2, radius * 0.36);
      break;
    case 'circle':
      g.lineStyle(width, 0xffffff, 0.5);
      g.strokeCircle(cx, cy, radius);
      break;
    case 'diamond':
      g.lineStyle(width, 0xffffff, 0.5);
      g.strokePoints(polygon(cx, cy, radius * 1.08, 4), true);
      break;
    case 'hexagon':
      g.lineStyle(width, 0xffffff, 0.5);
      g.strokePoints(polygon(cx, cy, radius, 6), true);
      break;
    case 'pentagon':
      g.lineStyle(width, 0xffffff, 0.5);
      g.strokePoints(polygon(cx, cy, radius, 5, Math.PI / 2), true);
      break;
    case 'octagon':
      g.lineStyle(width, 0xffffff, 0.5);
      g.strokePoints(polygon(cx, cy, radius, 8, Math.PI / 8), true);
      break;
    case 'star':
      g.lineStyle(width, 0xffffff, 0.5);
      g.strokePoints(starPoints(cx, cy, radius * 1.05, radius * 0.42, 4), true);
      break;
  }
}

/** The shared gem body: dark rim → saturated body → inner facets → specular highlight. */
function drawGemBody(g: Phaser.GameObjects.Graphics, color: number, shape: GemShape): void {
  g.fillStyle(shade(color, -0.5), 1);
  fillShape(g, shape, CENTER, CENTER, RADIUS);

  g.fillStyle(color, 1);
  fillShape(g, shape, CENTER, CENTER, RADIUS * 0.88);

  g.fillStyle(shade(color, 0.38), 0.6);
  fillShape(g, shape, CENTER, CENTER - RADIUS * 0.07, RADIUS * 0.62);

  g.fillStyle(shade(color, 0.72), 0.55);
  fillShape(g, shape, CENTER, CENTER - RADIUS * 0.14, RADIUS * 0.34);

  // Soft bottom shading keeps it reading as a solid object.
  g.fillStyle(shade(color, -0.65), 0.26);
  g.fillEllipse(CENTER, CENTER + RADIUS * 0.5, RADIUS * 1.0, RADIUS * 0.34);

  // Specular highlight.
  g.fillStyle(0xffffff, 0.5);
  g.fillEllipse(CENTER - RADIUS * 0.3, CENTER - RADIUS * 0.38, RADIUS * 0.52, RADIUS * 0.3);
  g.fillStyle(0xffffff, 0.85);
  g.fillEllipse(CENTER - RADIUS * 0.34, CENTER - RADIUS * 0.42, RADIUS * 0.2, RADIUS * 0.11);

  strokeShape(g, shape, CENTER, CENTER, RADIUS * 0.88, TEX_SIZE * 0.022);
}

function drawSparkle(g: Phaser.GameObjects.Graphics, x: number, y: number, size: number): void {
  g.fillStyle(0xffffff, 0.95);
  g.fillPoints(starPoints(x, y, size, size * 0.22, 4), true);
}

function drawLineBlaster(g: Phaser.GameObjects.Graphics, color: number, shape: GemShape): void {
  drawGemBody(g, color, shape);

  const barH = TEX_SIZE * 0.1;
  const barW = RADIUS * 2.5;
  g.fillStyle(shade(color, 0.85), 0.55);
  g.fillRoundedRect(CENTER - barW / 2, CENTER - barH * 1.5, barW, barH * 3, barH);
  g.fillStyle(0xffffff, 0.92);
  g.fillRoundedRect(CENTER - barW / 2, CENTER - barH / 2, barW, barH, barH * 0.5);

  // Arrow tips so the clearing direction is obvious.
  g.fillStyle(0xffffff, 0.95);
  g.fillTriangle(CENTER - barW / 2 - barH * 0.7, CENTER, CENTER - barW / 2, CENTER - barH * 0.9, CENTER - barW / 2, CENTER + barH * 0.9);
  g.fillTriangle(CENTER + barW / 2 + barH * 0.7, CENTER, CENTER + barW / 2, CENTER - barH * 0.9, CENTER + barW / 2, CENTER + barH * 0.9);
}

function drawBomb(g: Phaser.GameObjects.Graphics, color: number, shape: GemShape): void {
  drawGemBody(g, color, shape);

  const ringR = RADIUS * 0.72;
  g.lineStyle(TEX_SIZE * 0.05, shade(color, -0.7), 0.85);
  g.strokeCircle(CENTER, CENTER, ringR);
  g.lineStyle(TEX_SIZE * 0.025, 0xffffff, 0.6);
  g.strokeCircle(CENTER, CENTER, ringR * 0.78);

  g.fillStyle(0xffffff, 0.85);
  g.fillCircle(CENTER, CENTER, RADIUS * 0.2);

  // Studs around the ring.
  for (let i = 0; i < 8; i++) {
    const a = (i * Math.PI) / 4;
    g.fillStyle(0xffffff, 0.75);
    g.fillCircle(CENTER + Math.cos(a) * ringR, CENTER + Math.sin(a) * ringR, TEX_SIZE * 0.028);
  }
}

function drawHypercube(g: Phaser.GameObjects.Graphics): void {
  const wedges = 6;
  const outer = RADIUS * 1.06;

  // Prismatic wedge fan.
  for (let i = 0; i < wedges; i++) {
    const a0 = (i / wedges) * Math.PI * 2 - Math.PI / 2;
    const a1 = ((i + 1) / wedges) * Math.PI * 2 - Math.PI / 2;
    const color = GEM_COLORS[i % GEM_COLORS.length];
    g.fillStyle(color, 1);
    g.fillPoints(
      [
        new Phaser.Math.Vector2(CENTER, CENTER),
        new Phaser.Math.Vector2(CENTER + Math.cos(a0) * outer, CENTER + Math.sin(a0) * outer),
        new Phaser.Math.Vector2(
          CENTER + Math.cos((a0 + a1) / 2) * outer * 1.04,
          CENTER + Math.sin((a0 + a1) / 2) * outer * 1.04,
        ),
        new Phaser.Math.Vector2(CENTER + Math.cos(a1) * outer, CENTER + Math.sin(a1) * outer),
      ],
      true,
    );
  }

  g.fillStyle(0x0b0718, 0.32);
  g.fillCircle(CENTER, CENTER, outer * 0.62);
  g.fillStyle(0xffffff, 0.9);
  g.fillCircle(CENTER, CENTER, outer * 0.34);
  g.fillStyle(0xffffff, 1);
  g.fillPoints(starPoints(CENTER, CENTER, outer * 0.72, outer * 0.16, 4), true);

  g.lineStyle(TEX_SIZE * 0.035, 0xffffff, 0.75);
  g.strokeCircle(CENTER, CENTER, outer);

  drawSparkle(g, CENTER + outer * 0.72, CENTER - outer * 0.72, TEX_SIZE * 0.07);
}

// ── Public API ────────────────────────────────────────────────────────────────

export const gemTextureKey = (type: number, special: Special): string => {
  switch (special) {
    case 'hyper':
      return 'special_hyper';
    case 'lineH':
    case 'lineV':
      return `special_line_${type}`;
    case 'bomb':
      return `special_bomb_${type}`;
    default:
      return `gem_${type}`;
  }
};

/** Textures shared by all gems, plus the utility sprites the scenes use. */
export function generateUtilityTextures(scene: Phaser.Scene): void {
  const g = scene.make.graphics({ x: 0, y: 0 }, false);


  // Empty board slot.
  g.clear();
  g.fillStyle(0x0a0820, 0.55);
  g.fillRoundedRect(0, 0, TEX_SIZE, TEX_SIZE, TEX_SIZE * 0.2);
  g.lineStyle(TEX_SIZE * 0.012, 0xffffff, 0.05);
  g.strokeRoundedRect(TEX_SIZE * 0.01, TEX_SIZE * 0.01, TEX_SIZE * 0.98, TEX_SIZE * 0.98, TEX_SIZE * 0.2);
  g.generateTexture('slot', TEX_SIZE, TEX_SIZE);

  // Selection / focus ring.
  g.clear();
  g.lineStyle(TEX_SIZE * 0.055, 0xffffff, 0.95);
  g.strokeRoundedRect(TEX_SIZE * 0.06, TEX_SIZE * 0.06, TEX_SIZE * 0.88, TEX_SIZE * 0.88, TEX_SIZE * 0.24);
  g.lineStyle(TEX_SIZE * 0.11, 0xffffff, 0.22);
  g.strokeRoundedRect(TEX_SIZE * 0.03, TEX_SIZE * 0.03, TEX_SIZE * 0.94, TEX_SIZE * 0.94, TEX_SIZE * 0.26);
  g.generateTexture('ring', TEX_SIZE, TEX_SIZE);

  // Hint ring (softer green tint).
  g.clear();
  g.lineStyle(TEX_SIZE * 0.05, 0xa7f3d0, 0.9);
  g.strokeRoundedRect(TEX_SIZE * 0.07, TEX_SIZE * 0.07, TEX_SIZE * 0.86, TEX_SIZE * 0.86, TEX_SIZE * 0.24);
  g.generateTexture('ring_hint', TEX_SIZE, TEX_SIZE);

  // Particle spark: soft radial dot.
  const spark = TEX_SIZE / 4;
  g.clear();
  for (let i = 6; i >= 1; i--) {
    g.fillStyle(0xffffff, 0.12 * (7 - i) * 0.6);
    g.fillCircle(spark / 2, spark / 2, (spark / 2) * (i / 6));
  }
  g.generateTexture('spark', spark, spark);

  // Board glow behind the panel.
  g.clear();
  for (let i = 12; i >= 1; i--) {
    g.fillStyle(0x818cf8, 0.022);
    g.fillRoundedRect(0, 0, TEX_SIZE, TEX_SIZE, TEX_SIZE * 0.3);
    g.fillStyle(0x000000, 0);
  }
  g.generateTexture('board_glow', TEX_SIZE, TEX_SIZE);

  g.destroy();
}

export function generateGemTextures(scene: Phaser.Scene): void {
  const g = scene.make.graphics({ x: 0, y: 0 }, false);

  GEM_COLORS.forEach((color, type) => {
    const shape = GEM_SHAPES[type % GEM_SHAPES.length];

    g.clear();
    drawGemBody(g, color, shape);
    drawSparkle(g, CENTER + RADIUS * 0.62, CENTER - RADIUS * 0.66, TEX_SIZE * 0.075);
    g.generateTexture(`gem_${type}`, TEX_SIZE, TEX_SIZE);

    g.clear();
    drawLineBlaster(g, color, shape);
    g.generateTexture(`special_line_${type}`, TEX_SIZE, TEX_SIZE);

    g.clear();
    drawBomb(g, color, shape);
    g.generateTexture(`special_bomb_${type}`, TEX_SIZE, TEX_SIZE);
  });

  g.clear();
  drawHypercube(g);
  g.generateTexture('special_hyper', TEX_SIZE, TEX_SIZE);

  g.destroy();
}
