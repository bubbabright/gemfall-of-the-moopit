import Phaser from 'phaser';
import { BOARD_MAX_COLS, GAME_WIDTH } from './config';

/**
 * Screen-dependent layout, worked out from the box the game is drawn into.
 *
 * Portrait (and desktop, and anything squarer): the game world is 720 logical px wide. Its
 * height follows the screen, 900 up to 1600, so a portrait phone is filled top to bottom.
 * HUD on top, board in the middle, buttons along the bottom.
 *
 * Landscape phone: the world is 720 px tall and as wide as the screen's shape. The board sits
 * in the middle, the HUD in a column on the left and the buttons in a column on the right.
 *
 * Values are `export let`, so importers always read the current layout. `src/main.ts` asks for
 * a new layout when the phone turns (see `planRelayout`), and scenes apply it on their next
 * start through `useRenderZoom`.
 */

export type Orientation = 'portrait' | 'landscape';

/** Where one HUD text sits: position plus horizontal origin (0 = left edge, 1 = right edge). */
export interface HudSpot {
  x: number;
  y: number;
  originX: number;
}

export interface HudLayout {
  /** The header plaque behind the HUD. */
  plaque: { x: number; y: number; w: number; h: number };
  scoreLabel: HudSpot;
  score: HudSpot;
  statLabel: HudSpot;
  stat: HudSpot;
  level: HudSpot;
  target: HudSpot;
  /** Level progress bar. */
  bar: { x: number; y: number; w: number };
}

export interface ControlsLayout {
  /** Centre of each button, in order: HINT, PAUSE, SOUND, MENU. */
  centres: { x: number; y: number }[];
  w: number;
  h: number;
  font: number;
}

export interface Layout {
  orientation: Orientation;
  /** Logical world size the game scene lays out in. */
  width: number;
  height: number;
  /** Canvas backing size in device pixels, and the camera zoom that maps logical onto it. */
  renderWidth: number;
  renderHeight: number;
  zoom: number;
  tile: number;
  boardTop: number;
  boardAreaH: number;
  hud: HudLayout;
  controls: ControlsLayout;
  /** The menu keeps a 720-wide column; this is its height and how far its blocks move down. */
  menuHeight: number;
  menuMidShift: number;
  menuFootShift: number;
}

/** Shortest and tallest portrait heights. 900 is the original desktop shape (aspect 0.8). */
const MIN_HEIGHT = 900;
const MAX_HEIGHT = 1600;
/** Landscape: fixed height, and the widest world. */
const LANDSCAPE_HEIGHT = 720;
const MAX_WIDTH = 1600;
/**
 * A landscape screen gets the side-column layout only if it is at least this wide for its
 * height: enough for a 220 px column either side of the board. Squarer screens, and desktops,
 * keep the portrait layout and are pillarboxed.
 */
const MIN_LANDSCAPE_ASPECT = 1.67;
/** Highest render zoom: 2x is sharp on a phone without costing too much fill rate. */
const MAX_ZOOM = 2;

export const BOARD_PAD = 14;
/** Space kept clear between the board area and the controls. */
const BAND_GAP = 29;
/** Header plaque plus the gap under it, measured from the plaque's top edge. */
const HUD_H = 178;
/** Buttons in the game's control row: HINT, PAUSE, MENU. */
const CONTROL_COUNT = 3;

/** The screen's shape, from the box the game is drawn into. */
export function measureParent(): { w: number; h: number } {
  const el = typeof document !== 'undefined' ? document.getElementById('game') : null;
  const box = el?.getBoundingClientRect();
  if (box && box.width > 0 && box.height > 0) return { w: box.width, h: box.height };
  if (typeof window !== 'undefined') return { w: window.innerWidth, h: window.innerHeight };
  return { w: GAME_WIDTH, h: MIN_HEIGHT };
}

/** True on touch-first devices (phones, tablets): only they get the landscape layout. */
function coarsePointer(): boolean {
  return typeof window !== 'undefined' && window.matchMedia?.('(pointer: coarse)').matches === true;
}

function renderSize(width: number, height: number, cssWidth: number) {
  const dpr = typeof window !== 'undefined' ? window.devicePixelRatio || 1 : 1;
  const raw = Phaser.Math.Clamp((cssWidth * dpr) / width, 1, MAX_ZOOM);
  const renderWidth = Math.round(width * raw);
  const zoom = renderWidth / width;
  return { renderWidth, renderHeight: Math.ceil(height * zoom), zoom };
}

function portraitLayout(pw: number, ph: number): Layout {
  const width = GAME_WIDTH;
  const height = Phaser.Math.Clamp(Math.round((width * ph) / pw), MIN_HEIGHT, MAX_HEIGHT);
  const extra = height - MIN_HEIGHT;

  // Bottom control row: taller buttons once there's room, anchored to the bottom edge.
  const controlH = extra >= 200 ? 72 : 58;
  const controlsY = height - 33 - controlH / 2;
  // Three buttons (HINT, PAUSE, MENU); sound and settings are the corner buttons (src/ui/corners.ts).
  const controlW = 196;
  const gap = 14;
  const startX = (width - (controlW * CONTROL_COUNT + gap * (CONTROL_COUNT - 1))) / 2 + controlW / 2;

  // Gem size: 72 on the original shape, growing with a tall screen, capped so an 8-wide board
  // plus its frame still clears both sides of the 720 width.
  const areaBeforeShift = controlsY - controlH / 2 - BAND_GAP - (26 + HUD_H);
  const fitW = Math.floor((width - 2 * BOARD_PAD - 24) / BOARD_MAX_COLS);
  const fitH = Math.floor((areaBeforeShift - 2 * BOARD_PAD) / BOARD_MAX_COLS);
  const tile = Math.max(72, Math.min(fitW, fitH));

  // Leftover height once the bigger board fits. A share of it drops the HUD and board down,
  // so on a tall phone they sit nearer the middle instead of hugging the top.
  const leftover = Math.max(0, areaBeforeShift - (BOARD_MAX_COLS * tile + 2 * BOARD_PAD));
  // Keep the score panel below the corner buttons (48 CSS px, 14 from the top, plus a gap)
  // when there's room: in world px that depends on how far the screen shrinks the world.
  const cssWidth = Math.min(pw, (ph * width) / height);
  const cornerClear = Math.ceil((72 * width) / cssWidth) - 26;
  const hudTop = 26 + Math.min(leftover, Math.max(Math.round(leftover * 0.3), cornerClear));
  const boardTop = hudTop + HUD_H;

  return {
    orientation: 'portrait',
    width,
    height,
    ...renderSize(width, height, cssWidth),
    tile,
    boardTop,
    boardAreaH: controlsY - controlH / 2 - BAND_GAP - boardTop,
    hud: {
      // Labels are 22 world px (12+ CSS px on a phone), so the rows are spaced for that.
      plaque: { x: 40, y: hudTop, w: width - 80, h: 140 },
      scoreLabel: { x: 58, y: hudTop + 12, originX: 0 },
      score: { x: 58, y: hudTop + 38, originX: 0 },
      statLabel: { x: width - 58, y: hudTop + 12, originX: 1 },
      stat: { x: width - 58, y: hudTop + 38, originX: 1 },
      level: { x: 58, y: hudTop + 96, originX: 0 },
      // x is set at runtime, just after the LEVEL label (GameScene.updateHud).
      target: { x: 58, y: hudTop + 96, originX: 0 },
      bar: { x: 58, y: hudTop + 128, w: width - 116 },
    },
    controls: {
      centres: [0, 1, 2].map((i) => ({ x: startX + i * (controlW + gap), y: controlsY })),
      w: controlW,
      h: controlH,
      // At least 21 world px: 12 CSS px once a phone shrinks the 720-wide world to ~411.
      font: extra >= 200 ? 26 : 22,
    },
    menuHeight: height,
    menuMidShift: Math.round(extra / 2),
    menuFootShift: extra,
  };
}

function landscapeLayout(pw: number, ph: number): Layout {
  const height = LANDSCAPE_HEIGHT;
  const width = Math.min(MAX_WIDTH, Math.round((height * pw) / ph));

  // Board fills the height, centred left to right.
  const margin = 26;
  const tile = Math.floor((height - 2 * margin - 2 * BOARD_PAD) / BOARD_MAX_COLS);
  const boardSpan = BOARD_MAX_COLS * tile + 2 * BOARD_PAD;
  const boardLeft = (width - boardSpan) / 2;

  // Side columns: HUD on the left, buttons on the right (right thumb).
  const sideGap = 28;
  const colW = Math.min(360, boardLeft - 2 * sideGap);
  const leftX = boardLeft - sideGap - colW;
  const rightX = boardLeft + boardSpan + sideGap;

  // HUD: score, stat and level stacked down one plaque, centred vertically.
  const plaqueH = 300;
  const py = Math.round((height - plaqueH) / 2);
  const inX = leftX + 20;

  // Buttons: four stacked, centred vertically.
  const controlH = 76;
  const gap = 18;
  const stackH = controlH * CONTROL_COUNT + gap * (CONTROL_COUNT - 1);
  const controlsTop = (height - stackH) / 2 + controlH / 2;

  const cssWidth = Math.min(pw, (ph * width) / height);
  return {
    orientation: 'landscape',
    width,
    height,
    ...renderSize(width, height, cssWidth),
    tile,
    boardTop: margin,
    boardAreaH: height - 2 * margin,
    hud: {
      plaque: { x: leftX, y: py, w: colW, h: plaqueH },
      scoreLabel: { x: inX, y: py + 18, originX: 0 },
      score: { x: inX, y: py + 44, originX: 0 },
      statLabel: { x: inX, y: py + 118, originX: 0 },
      stat: { x: inX, y: py + 144, originX: 0 },
      level: { x: inX, y: py + 228, originX: 0 },
      target: { x: inX, y: py + 228, originX: 0 },
      bar: { x: inX, y: py + 262, w: colW - 40 },
    },
    controls: {
      centres: [0, 1, 2].map((i) => ({ x: rightX + colW / 2, y: controlsTop + i * (controlH + gap) })),
      w: Math.min(colW, 240),
      h: controlH,
      font: 22,
    },
    // The menu keeps its original 720x900 column, fitted into the wide screen by its camera.
    menuHeight: MIN_HEIGHT,
    menuMidShift: 0,
    menuFootShift: 0,
  };
}

/** Works out the layout for a parent box of this size. */
export function computeLayout(pw: number, ph: number): Layout {
  const landscape = coarsePointer() && pw / ph >= MIN_LANDSCAPE_ASPECT;
  return landscape ? landscapeLayout(pw, ph) : portraitLayout(pw, ph);
}

const bootBox = measureParent();
let current = computeLayout(bootBox.w, bootBox.h);
/** A layout waiting to be applied at the next scene start (after the phone turned). */
let pending: Layout | null = null;

export let LAYOUT: Layout = current;
/** Logical world height. */
export let GAME_HEIGHT = current.height;
/** Logical world width: 720 in portrait, wider in landscape. */
export let WORLD_WIDTH = current.width;
export let RENDER_WIDTH = current.renderWidth;
export let RENDER_HEIGHT = current.renderHeight;
export let RENDER_ZOOM = current.zoom;
export let TILE = current.tile;
export let BOARD_TOP = current.boardTop;
export let BOARD_AREA_H = current.boardAreaH;
export let MENU_HEIGHT = current.menuHeight;
export let MENU_MID_SHIFT = current.menuMidShift;
export let MENU_FOOT_SHIFT = current.menuFootShift;

function adopt(next: Layout): void {
  current = next;
  LAYOUT = next;
  GAME_HEIGHT = next.height;
  WORLD_WIDTH = next.width;
  RENDER_WIDTH = next.renderWidth;
  RENDER_HEIGHT = next.renderHeight;
  RENDER_ZOOM = next.zoom;
  TILE = next.tile;
  BOARD_TOP = next.boardTop;
  BOARD_AREA_H = next.boardAreaH;
  MENU_HEIGHT = next.menuHeight;
  MENU_MID_SHIFT = next.menuMidShift;
  MENU_FOOT_SHIFT = next.menuFootShift;
  publishLayout();
}

/** Test tools read this to map game coordinates onto the page. */
export function publishLayout(): void {
  if (typeof window === 'undefined') return;
  (window as unknown as { gemfallLayout?: object }).gemfallLayout = {
    orientation: current.orientation,
    width: current.width,
    height: current.height,
    zoom: current.zoom,
    tile: current.tile,
  };
}

/**
 * Called once the page has settled after a resize. Returns true when the phone has turned
 * between portrait and landscape, in which case the new layout waits until a scene restarts.
 * Any other size change (browser bars sliding in or out) keeps the layout; FIT absorbs it.
 */
export function planRelayout(): boolean {
  const { w, h } = measureParent();
  const next = computeLayout(w, h);
  if (next.orientation === current.orientation) {
    // Turned and turned back before anything restarted: nothing left to apply.
    pending = null;
    return false;
  }
  pending = next;
  return true;
}

/**
 * Applies any waiting layout, points this scene's camera at the logical world and renders
 * text at the zoom, so nothing gets stretched. Call first thing in every scene's create().
 */
export function useRenderZoom(scene: Phaser.Scene): void {
  if (pending) {
    adopt(pending);
    pending = null;
    scene.scale.setGameSize(RENDER_WIDTH, RENDER_HEIGHT);
  }
  scene.cameras.main.setSize(scene.scale.width, scene.scale.height).setOrigin(0, 0).setZoom(RENDER_ZOOM);
  if (RENDER_ZOOM !== 1) {
    const sharpen = (object: Phaser.GameObjects.GameObject): void => {
      if (object instanceof Phaser.GameObjects.Text && object.style.resolution !== RENDER_ZOOM) {
        object.setResolution(RENDER_ZOOM);
      }
    };
    scene.events.on(Phaser.Scenes.Events.ADDED_TO_SCENE, sharpen);
    scene.events.once(Phaser.Scenes.Events.SHUTDOWN, () => {
      scene.events.off(Phaser.Scenes.Events.ADDED_TO_SCENE, sharpen);
    });
  }
}

/**
 * Menu camera: the menu is always a 720-wide column `MENU_HEIGHT` tall. In landscape that
 * column is shrunk to fit the height and centred; in portrait this is the plain render zoom.
 */
export function useMenuCamera(scene: Phaser.Scene): void {
  useRenderZoom(scene);
  if (WORLD_WIDTH === GAME_WIDTH && GAME_HEIGHT === MENU_HEIGHT) return;
  const fit = Math.min(WORLD_WIDTH / GAME_WIDTH, GAME_HEIGHT / MENU_HEIGHT);
  scene.cameras.main
    .setOrigin(0.5, 0.5)
    .setZoom(RENDER_ZOOM * fit)
    .centerOn(GAME_WIDTH / 2, MENU_HEIGHT / 2);
}

publishLayout();
