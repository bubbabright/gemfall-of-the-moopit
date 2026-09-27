import Phaser from 'phaser';
import '@fontsource/fredoka/latin-700.css';
import '@fontsource/cinzel-decorative/latin-700.css';
import '@fontsource/cinzel/latin-400.css';
import '@fontsource/cinzel/latin-700.css';
import '@fontsource/nunito/latin-400.css';
import '@fontsource/nunito/latin-700.css';
import '@fontsource/nunito/latin-800.css';
import { RENDER_HEIGHT, RENDER_WIDTH, planRelayout } from './layout';
import { BUILD_LABEL } from './version';
// Listen for Chrome's install offer from the start; it can come before the menu exists.
import './ui/install';
import BootScene from './scenes/BootScene';
import MenuScene from './scenes/MenuScene';
import GameScene from './scenes/GameScene';

/**
 * GEMFALL — an original Bejeweled-like match-3 game.
 * Transparent canvas: the page CSS supplies the gradient world behind the board.
 */
const game = new Phaser.Game({
  type: Phaser.AUTO,
  parent: 'game',
  // Rendered at the phone's pixel density; each scene's camera zooms back to 720 logical px
  // (see useRenderZoom in src/layout.ts).
  width: RENDER_WIDTH,
  height: RENDER_HEIGHT,
  transparent: true,
  scale: {
    mode: Phaser.Scale.FIT,
    autoCenter: Phaser.Scale.CENTER_BOTH,
  },
  render: {
    antialias: true,
    roundPixels: false,
    powerPreference: 'high-performance',
  },
  scene: [BootScene, MenuScene, GameScene],
});

declare const __SERVICE_WORKER__: boolean;

// Installable app: the service worker (dist/sw.js, built from src/sw.template.js) saves the
// game's files so it opens offline. Built game only, and not on this PC's own previews
// (localhost) unless the URL asks with ?sw, so a local preview never serves a saved old build;
// `npm run pwa` uses ?sw. Browsers only allow it on https or localhost, so a plain-http LAN
// preview skips it too.
const localPreview = ['localhost', '127.0.0.1'].includes(location.hostname);
const wantServiceWorker = !localPreview || new URLSearchParams(location.search).has('sw');
if (__SERVICE_WORKER__ && wantServiceWorker && 'serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('./sw.js').catch((err: unknown) => {
      console.warn('service worker not registered:', err);
    });
  });
}

// Debug handle: lets devtools (and the headless playtest) inspect or step the loop,
// and read which build is running.
const debug = window as unknown as {
  gemfall?: Phaser.Game;
  gemfallVersion?: string;
  gemfallPhaser?: string;
};
debug.gemfall = game;
debug.gemfallVersion = BUILD_LABEL;
// Phaser is bundled, not global, so expose its version for diagnostics.
debug.gemfallPhaser = Phaser.VERSION;
// window.gemfallLayout (the logical size scenes lay out in) is published by src/layout.ts.

/**
 * Turning the phone.
 *
 * Phaser's own orientation handler measures the page before the browser has laid it out for
 * the new orientation, then treats the next (correct) measurement as "no change", so the canvas
 * stays sized for the previous orientation. Once the page has settled we measure again
 * ourselves and refresh.
 *
 * If the phone went between portrait and landscape, the active scene is also rebuilt in the new
 * layout (HUD and buttons move beside the board in landscape). The game scene carries the run
 * over; if gems are still falling it waits for them first.
 */
let settleTimer = 0;
function onViewportChange(): void {
  window.clearTimeout(settleTimer);
  settleTimer = window.setTimeout(settle, 200);
}

function settle(): void {
  if (planRelayout()) rebuildActiveScene();
  game.scale.getParentBounds();
  game.scale.refresh();
}

function rebuildActiveScene(): void {
  const gameScene = game.scene.getScene('game') as GameScene | null;
  if (gameScene?.sys.isActive()) {
    if (!gameScene.relayout()) {
      window.setTimeout(rebuildActiveScene, 250);
    }
    return;
  }
  const menu = game.scene.getScene('menu');
  if (menu?.sys.isActive()) menu.scene.restart();
  // Boot scene: the next scene to start picks the new layout up by itself.
}

window.addEventListener('resize', onViewportChange);
screen.orientation?.addEventListener('change', onViewportChange);
