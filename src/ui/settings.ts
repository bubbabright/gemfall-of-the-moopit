import { MESSAGE_HOLD_STEPS_MS } from '../config';
import { loadSettings, saveSettings } from '../core/storage';
import { haptics } from '../haptics';
import { sfx } from '../audio/sfx';
import { refreshSpeaker } from './corners';

/**
 * The settings panel, behind the gear on the menu and in a game (issue #3): sound, buzz,
 * a hold-to-test buzz, and how long in-game messages stay up. HTML over everything, so both
 * screens share one panel. Every change is saved and applied at once; whoever opened it gets
 * `onClose` so it can re-read the settings (the game scene keeps its own copy).
 */

const GEAR_PATH =
  'M19.14 12.94a7.07 7.07 0 0 0 0-1.88l2.03-1.58a.5.5 0 0 0 .12-.64l-1.92-3.32a.5.5 0 0 0-.61-.22l-2.39.96a7 7 0 0 0-1.63-.94l-.36-2.54A.5.5 0 0 0 13.9 2.4h-3.84a.5.5 0 0 0-.49.42l-.36 2.54a7 7 0 0 0-1.63.94l-2.39-.96a.5.5 0 0 0-.61.22L2.66 8.84a.5.5 0 0 0 .12.64l2.03 1.58a7.07 7.07 0 0 0 0 1.88l-2.03 1.58a.5.5 0 0 0-.12.64l1.92 3.32a.5.5 0 0 0 .61.22l2.39-.96c.5.39 1.05.7 1.63.94l.36 2.54a.5.5 0 0 0 .49.42h3.84a.5.5 0 0 0 .49-.42l.36-2.54a7 7 0 0 0 1.63-.94l2.39.96a.5.5 0 0 0 .61-.22l1.92-3.32a.5.5 0 0 0-.12-.64zM12 15.5A3.5 3.5 0 1 1 12 8.5a3.5 3.5 0 0 1 0 7z';

/** The gear as inline SVG markup, for the menu's gear button. */
export const GEAR_SVG = `<svg viewBox="0 0 24 24" width="24" height="24" aria-hidden="true"><path fill="currentColor" d="${GEAR_PATH}"/></svg>`;

let panel: HTMLElement | null = null;
let onClose: (() => void) | undefined;
let lastFocus: Element | null = null;

const els = {} as {
  effects: HTMLButtonElement;
  music: HTMLButtonElement;
  mutedNote: HTMLElement;
  buzz: HTMLButtonElement;
  steps: Map<number, HTMLButtonElement>;
  status: HTMLElement;
  done: HTMLButtonElement;
};

function el<K extends keyof HTMLElementTagNameMap>(tag: K, className = '', children: (Node | string)[] = []) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  node.append(...children);
  return node;
}

function tapButton(className: string, children: (Node | string)[], action: () => void): HTMLButtonElement {
  const b = el('button', className, children);
  b.type = 'button';
  b.addEventListener('click', () => {
    sfx.unlock();
    action();
    sfx.click();
  });
  return b;
}

function row(label: string, hint: string, control: HTMLElement): HTMLElement {
  return el('div', 'row', [el('div', 'what', [el('span', 'name', [label]), el('span', 'hint', [hint])]), control]);
}

/** A row whose control takes its own full-width line under the label. */
function stacked(r: HTMLElement): HTMLElement {
  r.classList.add('stack');
  return r;
}

function build(): HTMLElement {
  const root = el('div', '');
  root.id = 'settings';
  root.hidden = true;

  const soundSwitch = (key: 'effects' | 'music'): HTMLButtonElement =>
    tapButton('switch', [el('i')], () => {
      const s = loadSettings();
      s[key] = !s[key];
      saveSettings(s);
      sfx.configure(s);
      render();
    });
  els.effects = soundSwitch('effects');
  els.music = soundSwitch('music');
  els.mutedNote = el('p', 'status muted-note', ['Everything is muted. Tap the speaker, top left, to hear it.']);
  els.buzz = tapButton('switch', [el('i')], () => {
    const s = loadSettings();
    s.haptics = !s.haptics;
    saveSettings(s);
    haptics.enabled = s.haptics;
    // Fire one so the switch demonstrates itself.
    if (s.haptics) haptics.confirm();
    render();
  });

  const test = el('button', 'hold', ['Hold']);
  test.type = 'button';
  wireBuzzTest(test);
  els.status = el('p', 'status');

  els.steps = new Map();
  const steps = el('div', 'steps');
  for (const ms of MESSAGE_HOLD_STEPS_MS) {
    const step = tapButton('step', [`${ms / 1000}s`], () => {
      const s = loadSettings();
      s.messageHoldMs = ms;
      saveSettings(s);
      render();
    });
    els.steps.set(ms, step);
    steps.append(step);
  }

  els.done = tapButton('done', ['Done'], close);
  const sheet = el('section', 'sheet', [
    el('h2', '', ['Settings']),
    row('Sound effects', 'Swaps, explosions, chimes', els.effects),
    row('Music', 'A quiet tune in the background', els.music),
    els.mutedNote,
    row('Buzz', 'Phone vibrates on explosions', els.buzz),
    row('Test buzz', 'Hold to check your phone can buzz', test),
    els.status,
    stacked(row('Messages', 'How long they stay on screen', steps)),
    els.done,
  ]);
  sheet.setAttribute('role', 'dialog');
  sheet.setAttribute('aria-modal', 'true');
  sheet.setAttribute('aria-label', 'Settings');
  root.append(sheet);

  // Tapping outside the sheet, or Escape, closes it.
  root.addEventListener('click', (event) => {
    if (event.target === root) close();
  });
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && panel && !panel.hidden) {
      event.stopPropagation();
      close();
    }
  });

  document.body.append(root);
  return root;
}

function render(): void {
  const s = loadSettings();
  for (const [button, on, name] of [
    [els.effects, s.effects, 'Sound effects'],
    [els.music, s.music, 'Music'],
  ] as const) {
    button.setAttribute('aria-pressed', String(on));
    button.setAttribute('aria-label', `${name} ${on ? 'on' : 'off'}`);
  }
  els.mutedNote.hidden = !s.muted;
  els.buzz.setAttribute('aria-pressed', String(s.haptics));
  els.buzz.setAttribute('aria-label', s.haptics ? 'Buzz on' : 'Buzz off');
  for (const [ms, step] of els.steps) step.setAttribute('aria-pressed', String(ms === s.messageHoldMs));
}

/**
 * Hold to test vibration: while held, 200 ms pulses back to back so the motor runs
 * continuously; letting go (or sliding off) stops it. The line under it shows what the
 * browser answered, so a silent phone can be diagnosed without devtools.
 */
function wireBuzzTest(test: HTMLButtonElement): void {
  const pulseMs = 200;
  let timer = 0;
  const stop = (): void => {
    if (!timer) return;
    window.clearInterval(timer);
    timer = 0;
    haptics.test(0);
  };
  const pulse = (): void => {
    els.status.textContent = haptics.test(pulseMs);
  };
  test.addEventListener('pointerdown', () => {
    stop();
    sfx.unlock();
    pulse();
    timer = window.setInterval(pulse, pulseMs - 20);
  });
  for (const type of ['pointerup', 'pointerleave', 'pointercancel'] as const) test.addEventListener(type, stop);
  window.addEventListener('blur', stop);
}

export function openSettings(closed?: () => void): void {
  panel ??= build();
  onClose = closed;
  lastFocus = document.activeElement;
  els.status.textContent = '';
  render();
  panel.hidden = false;
  els.done.focus({ preventScroll: true });
}

export function closeSettings(): void {
  close();
}

export const settingsOpen = (): boolean => Boolean(panel && !panel.hidden);

function close(): void {
  if (!panel || panel.hidden) return;
  panel.hidden = true;
  refreshSpeaker();
  (lastFocus as HTMLElement | null)?.focus?.({ preventScroll: true });
  const done = onClose;
  onClose = undefined;
  done?.();
}
