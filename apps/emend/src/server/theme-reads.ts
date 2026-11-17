import type { ThemeEntry, ThemeList } from "@emend/contract";
import { listThemes, readTheme } from "../state/themes.ts";

type ReadSlot<Value> = { queued?: { promise: Promise<Value>; start: () => void } };

const lists = new Map<string | undefined, ReadSlot<ThemeList>>();
const files = new Map<string, ReadSlot<ThemeEntry | null>>();

/** Later callers share one queued read, so none receives a read started before it arrived. */
function shareRead<Key, Value>(reads: Map<Key, ReadSlot<Value>>, key: Key, read: () => Promise<Value>): Promise<Value> {
  const start = () => {
    const running: ReadSlot<Value> = {};
    reads.set(key, running);
    return read().finally(() => {
      if (running.queued) running.queued.start();
      else reads.delete(key);
    });
  };
  const running = reads.get(key);
  if (!running) return start();
  if (!running.queued) {
    const queued = Promise.withResolvers<Value>();
    running.queued = {
      promise: queued.promise,
      start: () => {
        void start().then(queued.resolve, queued.reject);
      },
    };
  }
  return running.queued.promise;
}

export function listThemesForRequest(themesDir?: string): Promise<ThemeList> {
  return shareRead(lists, themesDir, () => listThemes(themesDir));
}

export function readThemeForRequest(themesDir: string | undefined, name: string): Promise<ThemeEntry | null> {
  return shareRead(files, JSON.stringify([themesDir, name]), () => readTheme(themesDir, name));
}
