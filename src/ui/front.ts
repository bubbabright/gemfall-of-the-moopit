import {
  DIFFICULTIES,
  DIFFICULTY_ORDER,
  MODES,
  MODE_ORDER,
  type Difficulty,
  type Mode,
} from '../config';
import { getHighScore, loadSavedRun, loadSettings, saveSettings } from '../core/storage';
import { MOOPIT_TAPS, MOOPIT_TAP_WINDOW_MS, voiceFor } from '../messages';
import { BUILD_TIME, CODENAME, REPO_URL, VERSION_LABEL } from '../version';
import { haptics } from '../haptics';
import { sfx } from '../audio/sfx';
import { openSettings } from './settings';
import { showCorners } from './corners';
import { onInstallAvailability, promptInstall } from './install';

/**
 * The front screen: the boot splash, then the menu, as one HTML page over the game canvas
 * (#front in index.html). Built in HTML rather than Phaser so it can match the Figma splash
 * design exactly and keep the splash's logo and falling gems in place while the menu appears.
 *
 * States, as classes on #front:
 *   splash   logo and falling gems only; set in index.html, so it shows before any script
 *   menu     the controls have faded in and the logo has glided up to make room
 *   hidden   a run is on, and the canvas underneath shows; `gone` once the fade has finished
 *
 * MenuScene calls `show()` and gets the run the player picked back through `onStart`.
 */

export interface RunChoice {
  mode: Mode;
  difficulty: Difficulty;
  resume?: boolean;
}

/** Each mode card's gem and colour, from the splash design. */
/**
 * Each mode card's gem and colour, from the splash design. `label` is the lighter tint its
 * name takes when selected: at least 4.5:1 on black, where the gem colour itself may not be.
 */
const MODE_LOOK: Record<Mode, { shape: string; top: string; base: string; color: string; label: string; desc: string }> = {
  endless: { shape: 'kite', top: '#cc77ff', base: '#9911ff', color: '#9922ff', label: '#c48bff', desc: 'Chase the high score' },
  timed: { shape: 'octagon', top: '#ffcc44', base: '#ffaa00', color: '#ffaa00', label: '#ffc95c', desc: MODES.timed.sub },
  moves: { shape: 'hex', top: '#5599ff', base: '#1155ff', color: '#1155ff', label: '#7fa2ff', desc: MODES.moves.sub },
};

const FADE_MS = 400;

const root = (): HTMLElement | null => document.getElementById('front');

let built = false;
let mode: Mode = 'endless';
let difficulty: Difficulty = 'normal';
let onStart: (run: RunChoice) => void = () => {};
let moopit = false;
let titleTaps = 0;
let lastTitleTapAt = 0;
let goneTimer = 0;

const els = {} as {
  modes: Map<Mode, HTMLButtonElement>;
  difficulties: Map<Difficulty, HTMLButtonElement>;
  play: HTMLButtonElement;
  resumeSlot: HTMLElement;
  best: HTMLElement;
  tag: HTMLElement;
};

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className: string,
  children: (Node | string)[] = [],
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className) node.className = className;
  node.append(...children);
  return node;
}

function gemIcon(shape: string, top: string, base: string): HTMLElement {
  const gem = el('i', `gem ${shape}`);
  gem.style.setProperty('--top', top);
  gem.style.setProperty('--base', base);
  return el('span', 'icon', [gem]);
}

/** Button that plays the click sound and unlocks audio before doing its job. */
function button(className: string, children: (Node | string)[], action: () => void): HTMLButtonElement {
  const b = el('button', className, children);
  b.type = 'button';
  b.addEventListener('click', () => {
    sfx.unlock();
    sfx.click();
    action();
  });
  return b;
}

/**
 * The build stamp (BUILD_LABEL's text) in pieces that never break inside, so on a narrow phone
 * the time drops to its own line whole instead of leaving "EDT" alone on one.
 */
function stampParts(): (Node | string)[] {
  const head = [VERSION_LABEL, CODENAME && `"${CODENAME}"`].filter(Boolean).join(' · ');
  return [el('span', 'nowrap', [head]), ' · ', el('span', 'nowrap', [BUILD_TIME])];
}

/** The repo link under the version line. Opens in the browser; the menu itself loads nothing. */
function repoLink(): HTMLAnchorElement {
  const a = el('a', 'repo', [REPO_URL.replace('https://', '')]);
  a.href = REPO_URL;
  a.target = '_blank';
  a.rel = 'noopener noreferrer';
  return a;
}

function build(ui: HTMLElement): void {
  els.modes = new Map();
  els.difficulties = new Map();

  const modes = el('div', 'modes');
  for (const m of MODE_ORDER) {
    const look = MODE_LOOK[m];
    const card = button(
      'mode',
      [gemIcon(look.shape, look.top, look.base), el('span', 'label', [MODES[m].label]), el('span', 'desc', [look.desc])],
      () => select(m, difficulty),
    );
    card.dataset.mode = m;
    card.style.setProperty('--c', look.color);
    card.style.setProperty('--l', look.label);
    els.modes.set(m, card);
    modes.append(card);
  }

  const chips = el('div', 'chips difficulty');
  for (const d of DIFFICULTY_ORDER) {
    const chip = button('chip', [DIFFICULTIES[d].label], () => select(mode, d));
    chip.dataset.difficulty = d;
    chip.title = DIFFICULTIES[d].sub;
    els.difficulties.set(d, chip);
    chips.append(chip);
  }

  els.play = button('play', [el('span', '', ['Play Now'])], () => start({ mode, difficulty }));
  els.resumeSlot = el('div', 'resume-slot');
  els.best = el('p', 'best');
  // Shown only while Chrome says the game can be installed (src/ui/install.ts).
  const install = button('chip install', ['Install app'], () => void promptInstall());
  onInstallAvailability((available) => {
    install.hidden = !available;
  });

  const parts = [
    el('div', 'divider'),
    modes,
    chips,
    els.play,
    els.resumeSlot,
    els.best,
    install,
    el('p', 'foot', [...stampParts(), el('br', ''), repoLink()]),
  ];
  // Stagger for the fade-in (see .ui > * in index.html).
  parts.forEach((part, i) => part.style.setProperty('--n', String(i)));
  ui.append(...parts);

  els.tag = document.getElementById('front-tag') as HTMLElement;
  wireMoopitTitle(document.getElementById('front-logo') as HTMLElement);

  // Enter plays, like tapping PLAY NOW (Tab moves between the buttons).
  document.addEventListener('keydown', (event) => {
    const front = root();
    if (event.key !== 'Enter' || !front?.classList.contains('menu')) return;
    if (document.activeElement instanceof HTMLButtonElement) return;
    event.preventDefault();
    els.play.click();
  });
  built = true;
}

function select(m: Mode, d: Difficulty): void {
  mode = m;
  difficulty = d;
  for (const [key, card] of els.modes) card.setAttribute('aria-pressed', String(key === m));
  for (const [key, chip] of els.difficulties) chip.setAttribute('aria-pressed', String(key === d));
  const best = getHighScore(m, d);
  els.best.textContent = best
    ? `Best · ${MODES[m].label} · ${DIFFICULTIES[d].label} — ${best.score.toLocaleString()}`
    : `No score yet · ${MODES[m].label} · ${DIFFICULTIES[d].label}`;
  showResume();
}

/**
 * RESUME only for the selected mode and difficulty: each keeps its own unfinished run, so
 * switching cards never offers (or carries over the points of) another game.
 */
function showResume(): void {
  els.resumeSlot.replaceChildren();
  const saved = loadSavedRun(mode, difficulty);
  if (!saved) return;
  const run = { mode: saved.mode, difficulty: saved.difficulty, resume: true };
  els.resumeSlot.append(
    button(
      'resume',
      [el('b', '', ['Resume run']), el('small', '', [`${saved.score.toLocaleString()} pts so far`])],
      () => start(run),
    ),
  );
}

function refresh(): void {
  const settings = loadSettings();
  sfx.configure(settings);
  haptics.enabled = settings.haptics;
  moopit = settings.moopit;
  showTagline();
  select(mode, difficulty);
}

function start(run: RunChoice): void {
  hide();
  onStart(run);
}

/**
 * Show the menu. From the splash, the logo glides up from where it was while the controls
 * fade in under it; from a finished run, the whole screen fades back in.
 */
function show(startRun: (run: RunChoice) => void): void {
  const front = root();
  const ui = document.getElementById('front-ui');
  if (!front || !ui) return;
  onStart = startRun;
  if (!built) build(ui);
  refresh();

  window.clearTimeout(goneTimer);
  if (front.classList.contains('menu') && !front.classList.contains('hidden')) return;
  if (front.classList.contains('gone')) {
    // Back from a run: put it back in the layout first, so the fade-in actually plays.
    front.classList.remove('gone');
    void front.offsetHeight;
  }

  const fromSplash = front.classList.contains('splash');
  const wrap = front.querySelector<HTMLElement>('.logo-wrap');
  const before = wrap?.getBoundingClientRect().top ?? 0;

  front.classList.remove('splash', 'slow', 'hidden', 'settled');
  front.classList.add('menu');
  // Speaker top left, gear (settings) top right; see src/ui/corners.ts.
  showCorners(() => openSettings(refresh));

  if (fromSplash && wrap && !loadSettings().reducedMotion) {
    // FLIP: start the logo where the splash had it, then let it glide to its menu spot.
    const after = wrap.getBoundingClientRect().top;
    wrap.style.transition = 'none';
    wrap.style.transform = `translateY(${before - after}px)`;
    void wrap.offsetHeight;
    wrap.style.transition = 'transform 700ms cubic-bezier(0.22, 1, 0.36, 1)';
    wrap.style.transform = '';
  }
  // Once the entrance has played, drop the staggered animations so re-renders don't replay them.
  window.setTimeout(() => front.classList.add('settled'), 1400);
  els.play.focus({ preventScroll: true });
}

/** Fade the front screen out so the game shows; skip straight past the menu on a deep link. */
function hide(): void {
  const front = root();
  if (!front) return;
  front.classList.remove('splash', 'slow');
  front.classList.add('hidden');
  window.clearTimeout(goneTimer);
  // display: none once faded, so the falling gems stop animating during a run.
  goneTimer = window.setTimeout(() => front.classList.add('gone'), FADE_MS);
}

// ── Private voice ─────────────────────────────────────────────────────────────

function showTagline(): void {
  els.tag.textContent = voiceFor(moopit).menuTagline;
  els.tag.classList.toggle('moopit', moopit);
}

/**
 * The way into the private voice: seven taps on the logo, close together, nothing on screen
 * saying so. Each tap squashes the logo a little; the count forgets itself if the taps are too
 * far apart. The logo never changes; only the tagline under it does.
 */
function wireMoopitTitle(logo: HTMLElement): void {
  logo.addEventListener('pointerdown', () => {
    if (!root()?.classList.contains('menu')) return;
    const now = performance.now();
    titleTaps = now - lastTitleTapAt > MOOPIT_TAP_WINDOW_MS ? 1 : titleTaps + 1;
    lastTitleTapAt = now;
    sfx.unlock();
    sfx.click();
    logo.classList.remove('tap');
    void logo.offsetWidth;
    logo.classList.add('tap');
    if (titleTaps < MOOPIT_TAPS) return;
    titleTaps = 0;
    setMoopit(!moopit);
  });
}

function setMoopit(on: boolean): void {
  moopit = on;
  const settings = loadSettings();
  settings.moopit = on;
  saveSettings(settings);
  showTagline();
  haptics.confirm();
  sfx.newBest();
  if (!settings.reducedMotion) {
    const flash = root()?.querySelector('.flash');
    flash?.classList.remove('on');
    void (flash as HTMLElement | undefined)?.offsetWidth;
    flash?.classList.add('on');
  }
}

export const front = { show, hide };

/** Test tools read the current picks here. */
(window as unknown as { gemfallMenu?: object }).gemfallMenu = {
  get mode() {
    return mode;
  },
  get difficulty() {
    return difficulty;
  },
};
