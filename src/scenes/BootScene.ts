import Phaser from 'phaser';
import { DIFFICULTIES, MODES, type Difficulty, type Mode } from '../config';
import { generateGemTextures, generateUtilityTextures } from '../gfx/gems';
import { front } from '../ui/front';

/** How long the boot splash shows, at least, before the menu (ms since the page started). */
const SPLASH_MS = 1500;

const wait = (ms: number): Promise<void> => new Promise((resolve) => window.setTimeout(resolve, ms));

/** Generates all procedural art, then hands off to the menu (or a deep-linked run). */
export default class BootScene extends Phaser.Scene {
  constructor() {
    super('boot');
  }

  create(): void {
    generateUtilityTextures(this);
    generateGemTextures(this);

    // Canvas text draws with whatever face is ready at the time, so wait for the message font
    // and the logo faces before any scene makes text. Capped, so a slow or failed load falls
    // back to Inter and Georgia.
    const fontsReady = document.fonts
      ? Promise.all([
          document.fonts.load('700 32px Fredoka'),
          document.fonts.load('700 86px "Cinzel Decorative"'),
          document.fonts.load('700 16px Cinzel'),
          document.fonts.load('800 16px Nunito'),
        ])
      : Promise.resolve();
    const cap = wait(2500);
    // The splash is the entry screen: it stays up for at least SPLASH_MS from page load, then
    // the menu grows out of it (src/ui/front.ts).
    const splash = wait(Math.max(0, SPLASH_MS - performance.now()));
    void Promise.all([Promise.race([fontsReady, cap]).catch(() => undefined), splash]).then(() =>
      this.handOff(),
    );
  }

  private handOff(): void {

    // Deep link: index.html?auto=1&mode=timed&difficulty=hard skips the menu.
    const params = new URLSearchParams(window.location.search);
    const mode = params.get('mode') as Mode | null;
    const difficulty = params.get('difficulty') as Difficulty | null;

    if (params.get('auto') === '1' && mode && difficulty && mode in MODES && difficulty in DIFFICULTIES) {
      front.hide();
      this.scene.start('game', { mode, difficulty });
      return;
    }

    this.scene.start('menu');
  }
}
