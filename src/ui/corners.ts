import { loadSettings, saveSettings } from '../core/storage';
import { sfx } from '../audio/sfx';
import { GEAR_SVG } from './settings';

/**
 * The two corner buttons, on the menu and in a game: the speaker top left (one tap mutes
 * everything; a red slash shows it's muted) and the gear top right (settings). HTML over the
 * canvas, hidden during the splash. Whichever screen is showing tells the gear what to do.
 */

const SPEAKER_SVG = `<svg viewBox="0 0 24 24" width="24" height="24" aria-hidden="true">
  <path fill="currentColor" d="M3 9.5v5h4l5 4.5V5L7 9.5H3z"/>
  <path class="waves" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" d="M15.5 8.8a4.5 4.5 0 0 1 0 6.4M18.2 6.1a8.3 8.3 0 0 1 0 11.8"/>
  <path class="slash" fill="none" stroke="#ff3b4e" stroke-width="2.6" stroke-linecap="round" d="M4 4l16 16"/>
</svg>`;

let bar: HTMLElement | null = null;
let speaker: HTMLButtonElement;
let gearAction: () => void = () => {};

function build(): HTMLElement {
  const root = document.createElement('div');
  root.id = 'corners';

  speaker = document.createElement('button');
  speaker.type = 'button';
  speaker.className = 'corner speaker';
  speaker.innerHTML = SPEAKER_SVG;
  speaker.addEventListener('click', () => {
    toggleMute();
    speaker.blur();
  });

  const gear = document.createElement('button');
  gear.type = 'button';
  gear.className = 'corner gear';
  gear.innerHTML = GEAR_SVG;
  gear.setAttribute('aria-label', 'Settings');
  gear.addEventListener('click', () => {
    sfx.unlock();
    sfx.click();
    gear.blur();
    gearAction();
  });

  root.append(speaker, gear);
  document.body.append(root);
  return root;
}

/** Show the corners, with the gear doing what the current screen needs. */
export function showCorners(onGear: () => void): void {
  bar ??= build();
  gearAction = onGear;
  bar.hidden = false;
  refreshSpeaker();
}

/** Redraw the speaker from the saved settings (after anything changed them). */
export function refreshSpeaker(): void {
  if (!bar) return;
  const muted = loadSettings().muted;
  speaker.classList.toggle('muted', muted);
  speaker.setAttribute('aria-pressed', String(muted));
  speaker.setAttribute('aria-label', muted ? 'Sound off, tap to turn on' : 'Sound on, tap to mute');
}

/** Mute or unmute everything; the corner speaker and the M key in a game both use this. */
export function toggleMute(): boolean {
  const settings = loadSettings();
  settings.muted = !settings.muted;
  saveSettings(settings);
  sfx.configure(settings);
  if (!settings.muted) {
    sfx.unlock();
    sfx.click();
  }
  refreshSpeaker();
  return settings.muted;
}
