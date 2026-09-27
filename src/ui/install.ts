/**
 * The menu's "Install app" button. Chrome fires `beforeinstallprompt` once the page is
 * installable (manifest, icons and service worker all check out); we hold on to it and show the
 * button, so installing doesn't depend on finding it in Chrome's ⋮ menu. Already installed, or a
 * browser that never fires the event (Firefox, iOS Safari): no button.
 */

interface InstallPromptEvent extends Event {
  prompt(): Promise<void>;
  userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }>;
}

let deferred: InstallPromptEvent | null = null;
const listeners = new Set<(available: boolean) => void>();

const notify = (): void => listeners.forEach((listener) => listener(installAvailable()));

/** Running as the installed app (home-screen icon), not in a browser tab. */
export const isInstalled = (): boolean =>
  window.matchMedia?.('(display-mode: standalone)').matches === true ||
  (navigator as unknown as { standalone?: boolean }).standalone === true;

export const installAvailable = (): boolean => deferred !== null && !isInstalled();

/** Call with the current availability now and whenever it changes. */
export function onInstallAvailability(listener: (available: boolean) => void): void {
  listeners.add(listener);
  listener(installAvailable());
}

/** Show Chrome's install dialog. The event can only be used once, so the button goes after. */
export async function promptInstall(): Promise<void> {
  const event = deferred;
  if (!event) return;
  deferred = null;
  notify();
  await event.prompt();
  await event.userChoice.catch(() => undefined);
}

if (typeof window !== 'undefined') {
  window.addEventListener('beforeinstallprompt', (event) => {
    // Keep Chrome's own mini-infobar out of the way; the menu button offers it instead.
    event.preventDefault();
    deferred = event as InstallPromptEvent;
    notify();
  });
  window.addEventListener('appinstalled', () => {
    deferred = null;
    notify();
  });
}
