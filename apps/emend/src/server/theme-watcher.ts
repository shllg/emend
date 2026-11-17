import { stat } from "node:fs/promises";
import { join } from "node:path";
import { listThemeFiles } from "../state/themes.ts";
import type { ReviewEvents } from "./events.ts";

export interface ThemeWatcherOptions {
  intervalMs?: number;
  clock?: Pick<typeof globalThis, "setInterval" | "clearInterval">;
}

async function fingerprint(dir: string): Promise<string> {
  const { files, status } = await listThemeFiles(dir);
  if (status !== "listed") return status;
  const entries: unknown[] = [];
  for (const name of files) {
    try {
      const info = await stat(join(dir, name), { bigint: true });
      entries.push([name, ...[info.size, info.mtimeNs, info.ctimeNs, info.ino].map(String)]);
    } catch {
      entries.push([name, "unreadable"]);
    }
  }
  return JSON.stringify(entries);
}

/** Poll from server start, keeping one baseline across browser stream opens and closes. */
export function watchThemes(
  themesDir: string | undefined,
  events: ReviewEvents,
  { intervalMs = 2000, clock = globalThis }: ThemeWatcherOptions = {},
): () => void {
  if (!themesDir) return () => {};
  let baseline: string | undefined;
  let reading = false;
  let stopped = false;
  const tick = async () => {
    if (stopped || reading) return;
    reading = true;
    try {
      const next = await fingerprint(themesDir);
      if (stopped) return;
      const changed = baseline !== undefined && next !== baseline;
      baseline = next;
      if (changed) events.broadcast({ type: "themes" });
    } finally {
      reading = false;
    }
  };
  const timer = clock.setInterval(tick, intervalMs);
  timer.unref();
  return () => {
    stopped = true;
    clock.clearInterval(timer);
  };
}
