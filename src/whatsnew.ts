/**
 * What's new, per version: shown once to returning players the first time a new version opens
 * (src/ui/whatsnew.ts). Newest first. Write for family and friends, like CHANGELOG.md, and keep
 * it short: a handful of lines a player reads before tapping PLAY. Add an entry whenever
 * `version` in package.json goes up.
 */
export interface Release {
  version: string;
  notes: readonly string[];
}

export const RELEASES: readonly Release[] = [
  {
    version: '0.3.0',
    notes: [
      'A new opening screen and menu, with gems falling behind the logo.',
      'Install GEMFALL on your home screen: it opens full screen and plays with no signal.',
      'Speaker in the top corner mutes everything; the gear opens settings, with sound effects and music each on or off.',
      'Quiet background music, made by the game itself.',
      'Endless: every level up earns you an extra shuffle.',
      'Each mode and difficulty keeps its own unfinished game, so points never carry between games.',
      'Brighter, bigger text, made for phones with true black screens.',
    ],
  },
];

/** Compare dotted versions numerically: negative if a is older than b. */
export function compareVersions(a: string, b: string): number {
  const pa = a.split('.').map(Number);
  const pb = b.split('.').map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] || 0) - (pb[i] || 0);
    if (d) return d;
  }
  return 0;
}

/**
 * The notes a player should see, coming from `seen` (null: played before this note existed)
 * to `current`. Releases after `seen` up to and including `current`; from null, just `current`.
 */
export function notesSince(seen: string | null, current: string): Release[] {
  return RELEASES.filter(
    (r) =>
      compareVersions(r.version, current) <= 0 &&
      (seen === null ? compareVersions(r.version, current) === 0 : compareVersions(r.version, seen) > 0),
  );
}
