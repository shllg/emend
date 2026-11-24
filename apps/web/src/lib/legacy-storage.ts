const LEGACY_PREFIX = "emend.";
const PREFIX = "recense.";

/**
 * Moves every `emend.*` entry to its `recense.*` name, once per key: the value is copied when the new
 * key is missing, then the old key goes. Storage that cannot be read or written stays as it is.
 */
export function moveLegacyStorage(storage: Storage = localStorage): void {
  try {
    const legacy: string[] = [];
    for (let index = 0; index < storage.length; index++) {
      const key = storage.key(index);
      if (key?.startsWith(LEGACY_PREFIX)) legacy.push(key);
    }
    for (const key of legacy) {
      const next = PREFIX + key.slice(LEGACY_PREFIX.length);
      const value = storage.getItem(key);
      if (value !== null && storage.getItem(next) === null) storage.setItem(next, value);
      storage.removeItem(key);
    }
  } catch {
    // Denied or full storage keeps the old keys; the app then starts with its defaults.
  }
}
