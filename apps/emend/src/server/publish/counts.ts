import type { PublishFile } from "@emend/contract";
import { yieldToLoop } from "../pacing.ts";
import { checkPublishSignal, PublishAborted } from "./lifecycle.ts";
import type { Executor } from "./work.ts";

export const DIFF_COUNT_BUDGET_MS = 20000;
export const DIFF_COUNT_NULL_TTL_MS = 15 * 60 * 1000;
type Counts = { additions: number; deletions: number } | null;
export type DiffCountBudget = { limitMs: number; spentMs: number };
export const createDiffCountBudget = (limitMs = DIFF_COUNT_BUDGET_MS): DiffCountBudget => ({ limitMs, spentMs: 0 });

const MEMO_ENTRIES = 20000;
type MemoEntry = { counts: NonNullable<Counts> } | { counts: null; expiresAt: number };
// Each owner retains bounded counts independently, never blob contents.
const memo = new Map<string, Map<string, MemoEntry>>();

export async function countDiffFiles(
  ownerId: string,
  files: PublishFile[],
  read: (sha: string) => Promise<ArrayBuffer>,
  execute: Executor,
  signal?: AbortSignal,
  budget = createDiffCountBudget(),
  now = () => performance.now(),
): Promise<Map<string, Counts>> {
  const counted = new Map<string, Counts>();
  let visited = 0;
  for (const file of files) {
    if (++visited % 100 === 0) await yieldToLoop("publish-counts");
    checkPublishSignal(signal);
    if (file.role !== "diff" || file.flag) continue;
    let cache = memo.get(ownerId);
    if (!cache) {
      cache = new Map<string, MemoEntry>();
      memo.set(ownerId, cache);
    }
    const key = `${file.oldBlob}:${file.newBlob}`;
    let entry = cache.get(key);
    if (entry?.counts === null && now() >= entry.expiresAt) {
      cache.delete(key);
      entry = undefined;
    }
    let counts = entry?.counts;
    if (counts === undefined) {
      if (budget.spentMs >= budget.limitMs) {
        counted.set(file.path, null);
        continue;
      }
      const start = now();
      const old = file.oldBlob === null ? null : await read(file.oldBlob);
      const next = file.newBlob === null ? null : await read(file.newBlob);
      checkPublishSignal(signal);
      let returned = false;
      try {
        const result = await execute({ kind: "diff-counts", old, next });
        if (result.kind !== "diff-counts") throw new Error("wrong result");
        counts = result.counts;
        returned = true;
      } catch (error) {
        checkPublishSignal(signal);
        if (error instanceof PublishAborted || (error instanceof Error && error.name === "AbortError")) throw error;
        counts = null;
      } finally {
        budget.spentMs += now() - start;
      }
      checkPublishSignal(signal);
      // A late timeout must not downgrade another call's successful result.
      if (returned && (counts !== null || !cache.get(key)?.counts)) {
        if (!cache.has(key) && cache.size >= MEMO_ENTRIES) {
          const oldest = cache.keys().next().value;
          if (oldest !== undefined) cache.delete(oldest);
        }
        cache.set(key, counts === null ? { counts, expiresAt: now() + DIFF_COUNT_NULL_TTL_MS } : { counts });
      }
    }
    counted.set(file.path, counts);
  }
  checkPublishSignal(signal);
  return counted;
}
