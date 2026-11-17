import { readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import { themeFileName } from "../state/themes.ts";
import type { ReviewEvents } from "./events.ts";

export interface ThemeWatcherOptions {
  intervalMs?: number;
  clock?: Pick<typeof globalThis, "setInterval" | "clearInterval">;
}

async function fingerprint(dir: string): Promise<string> {
  let files: string[];
  try {
    files = await readdir(dir);
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ENOENT" ? "missing" : "unreadable";
  }
  const entries: unknown[] = [];
  for (const name of files.filter(themeFileName).sort()) {
    try {
      const info = await stat(join(dir, name), { bigint: true });
      entries.push([name, ...[info.size, info.mtimeNs, info.ctimeNs, info.ino].map(String)]);
    } catch {
      entries.push([name, "unreadable"]);
    }
  }
  return JSON.stringify(entries);
}

/** Poll metadata only while a browser stream is open. Each active period gets a fresh baseline. */
export function watchThemes(
  themesDir: string | undefined,
  events: ReviewEvents,
  { intervalMs = 2000, clock = globalThis }: ThemeWatcherOptions = {},
): () => void {
  if (!themesDir) return () => {};
  let timer: ReturnType<typeof setInterval> | undefined;
  let baseline: string | undefined;
  let generation = 0;
  let reading = false;
  let stopped = false;
  const tick = async () => {
    if (stopped || reading || events.streamCount === 0) return;
    reading = true;
    const current = generation;
    try {
      const next = await fingerprint(themesDir);
      if (stopped || current !== generation || events.streamCount === 0) return;
      const changed = baseline !== undefined && next !== baseline;
      baseline = next;
      if (changed) events.broadcast({ type: "themes" });
    } finally {
      reading = false;
    }
  };
  const update = () => {
    if (events.streamCount > 0 && !timer) {
      timer = clock.setInterval(tick, intervalMs);
      timer.unref();
    } else if (events.streamCount === 0) {
      if (timer) clock.clearInterval(timer);
      timer = undefined;
      baseline = undefined;
      generation++;
    }
  };
  const unsubscribe = events.onStreamCountChange(update);
  update();
  return () => {
    stopped = true;
    unsubscribe();
    if (timer) clock.clearInterval(timer);
  };
}
