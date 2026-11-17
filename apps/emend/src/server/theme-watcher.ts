import { stat } from "node:fs/promises";
import { join } from "node:path";
import { listThemeFolders } from "../state/themes.ts";
import type { ReviewEvents } from "./events.ts";

export interface ThemeWatcherOptions {
  intervalMs?: number;
  baselineWaitMs?: number;
  clock?: Pick<typeof globalThis, "setInterval" | "clearInterval" | "setTimeout" | "clearTimeout">;
}

async function fingerprint(dir: string): Promise<string> {
  const { folders, status } = await listThemeFolders(dir);
  if (status !== "listed") return status;
  const entries: unknown[] = [];
  for (const name of folders) {
    try {
      const info = await stat(join(dir, name, "theme.json"), { bigint: true });
      entries.push([name, ...[info.size, info.mtimeNs, info.ctimeNs, info.ino].map(String)]);
    } catch (error) {
      entries.push([name, (error as NodeJS.ErrnoException).code === "ENOENT" ? "missing" : "unreadable"]);
    }
  }
  return JSON.stringify(entries);
}

/** Poll from server start, keeping one baseline across browser stream opens and closes. */
export async function watchThemes(
  themesDir: string | undefined,
  events: ReviewEvents,
  { intervalMs = 2000, baselineWaitMs = 1000, clock = globalThis }: ThemeWatcherOptions = {},
): Promise<() => void> {
  if (!themesDir) return () => {};
  let baseline: string | undefined;
  let lateBaseline = false;
  let reading = false;
  let stopped = false;
  const tick = async () => {
    if (stopped || reading) return;
    reading = true;
    try {
      const next = await fingerprint(themesDir);
      if (stopped) return;
      const changed = baseline === undefined ? lateBaseline : next !== baseline;
      baseline = next;
      if (changed) events.broadcast({ type: "themes" });
    } finally {
      reading = false;
    }
  };
  let waitTimer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      tick(),
      new Promise<void>((resolve) => {
        waitTimer = clock.setTimeout(() => {
          lateBaseline = true;
          resolve();
        }, baselineWaitMs);
        waitTimer.unref();
      }),
    ]);
  } finally {
    clock.clearTimeout(waitTimer);
  }
  const timer = clock.setInterval(tick, intervalMs);
  timer.unref();
  return () => {
    stopped = true;
    clock.clearInterval(timer);
  };
}
