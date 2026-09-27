import Phaser from 'phaser';

/**
 * The lettered-gem GEMFALL logo, shared by the menu title and the mode cards. The same shapes
 * and colours are drawn in CSS for the boot splash in index.html, so the splash and the menu
 * read as one screen settling into place. Keep the two in step.
 */

export type LogoShape = 'diamond' | 'hex' | 'shield' | 'kite' | 'octagon' | 'marquise';

/** Outline of each shape as fractions of its box, clockwise from the top. */
const OUTLINES: Record<LogoShape, [number, number][]> = {
  diamond: [[0.5, 0], [1, 0.36], [0.76, 1], [0.24, 1], [0, 0.36]],
  hex: [[0.25, 0], [0.75, 0], [1, 0.5], [0.75, 1], [0.25, 1], [0, 0.5]],
  shield: [[0.1, 0], [0.9, 0], [1, 0.57], [0.5, 1], [0, 0.57]],
  kite: [[0.5, 0], [1, 0.38], [0.8, 1], [0.2, 1], [0, 0.38]],
  octagon: [[0.29, 0], [0.71, 0], [1, 0.29], [1, 0.71], [0.71, 1], [0.29, 1], [0, 0.71], [0, 0.29]],
  marquise: [[0.5, 0], [1, 0.5], [0.5, 1], [0, 0.5]],
};

export interface LogoGem {
  shape: LogoShape;
  top: string;
  base: string;
}

export const LOGO_GEMS = {
  ruby: { shape: 'diamond', top: '#ff6688', base: '#ee0033' },
  sapphire: { shape: 'hex', top: '#5599ff', base: '#1155ff' },
  emerald: { shape: 'shield', top: '#44ee77', base: '#11bb44' },
  amethyst: { shape: 'kite', top: '#cc77ff', base: '#9911ff' },
  topaz: { shape: 'octagon', top: '#ffcc44', base: '#ffaa00' },
  aquamarine: { shape: 'marquise', top: '#55eeff', base: '#00ccff' },
  citrine: { shape: 'diamond', top: '#ff8866', base: '#ff4400' },
} satisfies Record<string, LogoGem>;

/** G-E-M-F-A-L-L, each letter with its gem and colour. */
export const LOGO_LETTERS: { letter: string; gem: LogoGem; color: string }[] = [
  { letter: 'G', gem: LOGO_GEMS.emerald, color: '#22ee66' },
  { letter: 'E', gem: LOGO_GEMS.ruby, color: '#ff3366' },
  { letter: 'M', gem: LOGO_GEMS.sapphire, color: '#3377ff' },
  { letter: 'F', gem: LOGO_GEMS.topaz, color: '#ffbb11' },
  { letter: 'A', gem: LOGO_GEMS.amethyst, color: '#bb44ff' },
  { letter: 'L', gem: LOGO_GEMS.aquamarine, color: '#11ddff' },
  { letter: 'L', gem: LOGO_GEMS.citrine, color: '#ff5511' },
];

/** The logo's display faces, bundled through @fontsource (see main.ts). */
export const LOGO_FONT = '"Cinzel Decorative", Georgia, serif';
export const LOGO_SUB_FONT = 'Cinzel, Georgia, serif';

/**
 * A logo gem as a texture, `size` px square, with the splash's diagonal highlight-to-shade
 * gradient. Drawn on a canvas so it looks the same on the WebGL and Canvas renderers.
 * Returns the texture key; repeat calls reuse the texture.
 */
export function logoGemTexture(scene: Phaser.Scene, gem: LogoGem, size: number): string {
  const key = `logo_${gem.shape}_${gem.base.slice(1)}_${size}`;
  if (scene.textures.exists(key)) return key;

  const texture = scene.textures.createCanvas(key, size, size);
  if (!texture) return key;
  const ctx = texture.getContext();

  // CSS "140deg": from the top left towards the bottom right, slightly steeper than 45°.
  const angle = ((140 - 90) * Math.PI) / 180;
  const half = size / 2;
  const reach = half * (Math.abs(Math.cos(angle)) + Math.abs(Math.sin(angle)));
  const dx = Math.cos(angle) * reach;
  const dy = Math.sin(angle) * reach;
  const gradient = ctx.createLinearGradient(half - dx, half - dy, half + dx, half + dy);
  gradient.addColorStop(0, 'rgba(255,255,255,0.32)');
  gradient.addColorStop(0.22, gem.top);
  gradient.addColorStop(0.62, gem.base);
  gradient.addColorStop(1, 'rgba(0,0,0,0.22)');

  ctx.beginPath();
  OUTLINES[gem.shape].forEach(([x, y], i) => {
    if (i === 0) ctx.moveTo(x * size, y * size);
    else ctx.lineTo(x * size, y * size);
  });
  ctx.closePath();
  // The last stop is translucent black; paint the gem's own base first so the shade darkens
  // it instead of letting the background through.
  ctx.fillStyle = gem.base;
  ctx.fill();
  ctx.fillStyle = gradient;
  ctx.fill();

  texture.refresh();
  return key;
}
