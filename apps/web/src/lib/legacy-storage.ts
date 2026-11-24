const MOVES: [legacy: string, current: string][] = [
  ["emend.", "recense."],
  ["emend:", "recense:"],
];

/**
 * Copies every `emend.*` and `emend:*` entry to its `recense` name, once per key, when the new key is missing.
 * The old keys stay: a tab still on the old build reads and writes them, and a copy never overwrites a newer
 * value. Storage that cannot be reached, read or written is left as it is, and the app starts with defaults.
 */
export function moveLegacyStorage(storage?: Storage): void {
  try {
    const target = storage ?? localStorage;
    const legacy: string[] = [];
    for (let index = 0; index < target.length; index++) {
      const key = target.key(index);
      if (key && MOVES.some(([old]) => key.startsWith(old))) legacy.push(key);
    }
    for (const key of legacy) {
      const [old, current] = MOVES.find(([prefix]) => key.startsWith(prefix)) ?? [];
      if (old === undefined || current === undefined) continue;
      const next = current + key.slice(old.length);
      const value = target.getItem(key);
      if (value !== null && target.getItem(next) === null) target.setItem(next, value);
    }
  } catch {
    // Blocked, denied or full storage keeps what it has.
  }
}
