// The project was called Tilework before Home Quarters: browsers saved preferences, avatar, consent,
// name, zoom and status note under "tilework.*". Copy them once to "hq.*" so an upgrade keeps them.
export interface KeyValueStorage {
  readonly length: number;
  key(i: number): string | null;
  getItem(k: string): string | null;
  setItem(k: string, v: string): void;
  removeItem(k: string): void;
}

const LEGACY = "tilework.";
const CURRENT = "hq.";

/** Moves every legacy key to its new name (an existing new value wins) and removes the legacy key. */
export function migrateStorage(s: KeyValueStorage): void {
  try {
    const legacy: string[] = [];
    for (let i = 0; i < s.length; i++) {
      const k = s.key(i);
      if (k?.startsWith(LEGACY)) legacy.push(k);
    }
    for (const k of legacy) {
      const v = s.getItem(k);
      const to = CURRENT + k.slice(LEGACY.length);
      if (v !== null && s.getItem(to) === null) s.setItem(to, v);
      s.removeItem(k);
    }
  } catch {
    // storage unavailable (private window, blocked site data): nothing to keep
  }
}
