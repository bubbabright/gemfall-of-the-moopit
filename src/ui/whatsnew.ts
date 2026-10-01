import { hasPlayedBefore, loadSeenVersion, saveSeenVersion } from '../core/storage';
import { APP_VERSION, CHANGELOG_URL } from '../version';
import { notesSince } from '../whatsnew';
import { sfx } from '../audio/sfx';

/**
 * The What's new sheet: the first time a new version opens for someone who has played before,
 * the menu shows what changed (src/whatsnew.ts). Once closed it stays closed until the next
 * version. A brand-new player gets nothing: everything is new to them.
 */

let panel: HTMLElement | null = null;

function el<K extends keyof HTMLElementTagNameMap>(tag: K, className = '', children: (Node | string)[] = []) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  node.append(...children);
  return node;
}

/** Show the note if this player hasn't seen this version's yet. Returns whether it showed. */
export function maybeShowWhatsNew(): boolean {
  const seen = loadSeenVersion();
  if (seen === APP_VERSION) return false;
  const releases = hasPlayedBefore() ? notesSince(seen, APP_VERSION) : [];
  saveSeenVersion(APP_VERSION);
  if (!releases.length) return false;

  panel?.remove();
  const root = el('div');
  root.id = 'whatsnew';

  const close = (): void => {
    root.remove();
    panel = null;
    document.removeEventListener('keydown', onKey);
  };
  const onKey = (event: KeyboardEvent): void => {
    if (event.key === 'Escape' || event.key === 'Enter') {
      event.preventDefault();
      event.stopPropagation();
      close();
    }
  };

  const done = el('button', 'done', ['Got it']);
  done.type = 'button';
  done.addEventListener('click', () => {
    sfx.unlock();
    sfx.click();
    close();
  });

  const more = el('a', 'more', ['Every change, in the changelog']);
  more.href = CHANGELOG_URL;
  more.target = '_blank';
  more.rel = 'noopener noreferrer';

  const sheet = el('section', 'sheet', [
    el('h2', '', ["What's new"]),
    ...releases.flatMap((r) => [
      el('p', 'ver', [`Version ${r.version}`]),
      el('ul', '', r.notes.map((n) => el('li', '', [n]))),
    ]),
    more,
    done,
  ]);
  sheet.setAttribute('role', 'dialog');
  sheet.setAttribute('aria-modal', 'true');
  sheet.setAttribute('aria-label', "What's new");
  root.append(sheet);
  root.addEventListener('click', (event) => {
    if (event.target === root) close();
  });
  document.addEventListener('keydown', onKey, true);
  document.body.append(root);
  panel = root;
  done.focus({ preventScroll: true });
  return true;
}

export const whatsNewOpen = (): boolean => panel !== null;
