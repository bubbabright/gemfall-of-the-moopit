/**
 * Keeps the screen on during a game, so the phone doesn't dim mid-cascade.
 *
 * The game scene says whether it wants the screen held (`wakeLock.hold(true)` while a run is
 * playing, `false` when paused, over or left). The browser drops the lock whenever the game
 * goes to the background, so it is asked for again when the page is visible. Best-effort:
 * browsers without the Screen Wake Lock API, or that refuse it, just dim as normal.
 */

let wanted = false;
let sentinel: WakeLockSentinel | null = null;
let requesting = false;

function sync(): void {
  if (!wanted) {
    sentinel?.release().catch(() => {});
    sentinel = null;
    return;
  }
  if (sentinel || requesting || document.hidden || !('wakeLock' in navigator)) return;

  requesting = true;
  navigator.wakeLock
    .request('screen')
    .then((lock) => {
      if (!wanted) {
        lock.release().catch(() => {});
        return;
      }
      sentinel = lock;
      lock.addEventListener('release', () => {
        if (sentinel === lock) sentinel = null;
      });
    })
    .catch(() => {
      /* refused (low battery, no permission): the screen dims as normal */
    })
    .finally(() => {
      // No retry on refusal: the next hold() or return to the foreground asks again.
      requesting = false;
    });
}

if (typeof document !== 'undefined') document.addEventListener('visibilitychange', sync);

export const wakeLock = {
  /** true while a run is being played; false when paused, over, or back on the menu. */
  hold(on: boolean): void {
    wanted = on;
    sync();
  },
};
