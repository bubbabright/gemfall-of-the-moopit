import Phaser from 'phaser';
import { useMenuCamera } from '../layout';
import { front } from '../ui/front';

/**
 * The menu itself is HTML over the canvas (src/ui/front.ts, #front in index.html), so it can
 * match the splash design and grow out of the splash. This scene just shows it and starts
 * the run picked there. It stays a scene so the flow is unchanged: boot → menu → game → menu.
 */
export default class MenuScene extends Phaser.Scene {
  constructor() {
    super('menu');
  }

  create(): void {
    // Applies any layout waiting from a phone turn, as every scene does first.
    useMenuCamera(this);
    front.show((run) => this.scene.start('game', run));
  }
}
