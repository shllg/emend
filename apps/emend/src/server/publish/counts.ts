import type { PublishFile } from "@emend/contract";
import { yieldToLoop } from "../pacing.ts";
import { checkPublishSignal, PublishAborted } from "./lifecycle.ts";
import type { Executor } from "./work.ts";

export const DIFF_COUNT_BUDGET_MS = 20000;
type Counts = { additions: number; deletions: number } | null;

export async function countDiffFiles(
  files: PublishFile[],
  read: (sha: string) => Promise<ArrayBuffer>,
  execute: Executor,
  signal?: AbortSignal,
  budgetMs = DIFF_COUNT_BUDGET_MS,
  now = () => performance.now(),
): Promise<Map<string, Counts>> {
  const counted = new Map<string, Counts>();
  const cache = new Map<string, Counts>();
  let spent = 0;
  let visited = 0;
  for (const file of files) {
    if (++visited % 100 === 0) await yieldToLoop("publish-counts");
    checkPublishSignal(signal);
    if (file.role !== "diff" || file.flag) continue;
    if (spent >= budgetMs) {
      counted.set(file.path, null);
      continue;
    }
    const key = `${file.oldBlob}:${file.newBlob}`;
    let counts = cache.get(key);
    if (counts === undefined) {
      const start = now();
      const old = file.oldBlob === null ? null : await read(file.oldBlob);
      const next = file.newBlob === null ? null : await read(file.newBlob);
      checkPublishSignal(signal);
      try {
        const result = await execute({ kind: "diff-counts", old, next });
        if (result.kind !== "diff-counts") throw new Error("wrong result");
        counts = result.counts;
      } catch (error) {
        checkPublishSignal(signal);
        if (error instanceof PublishAborted || (error instanceof Error && error.name === "AbortError")) throw error;
        counts = null;
      } finally {
        spent += now() - start;
      }
      checkPublishSignal(signal);
      cache.set(key, counts);
    }
    counted.set(file.path, counts);
  }
  checkPublishSignal(signal);
  return counted;
}
