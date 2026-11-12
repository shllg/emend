import type { PublishFile } from "@emend/contract";
import { yieldToLoop } from "../pacing.ts";
import { checkPublishSignal, PublishAborted } from "./lifecycle.ts";
import type { Executor } from "./work.ts";

export const DIFF_COUNT_BUDGET_MS = 10000;
export const DIFF_COUNT_FIRST_NULL_TTL_MS = 60_000;
export const DIFF_COUNT_NULL_TTL_MS = 15 * 60 * 1000;
type Counts = { additions: number; deletions: number } | null;
export type DiffCountBudget = { limitMs: number; spentMs: number };
export const createDiffCountBudget = (limitMs = DIFF_COUNT_BUDGET_MS): DiffCountBudget => ({ limitMs, spentMs: 0 });

const MEMO_ENTRIES = 20000;
type MemoEntry = { counts: NonNullable<Counts> } | { counts: null; expiresAt: number; strikes: number };
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
  // Reuse every outcome within this call, including failures that must be retried by later calls.
  const outcomes = new Map<string, Counts>();
  let visited = 0;
  for (const file of files) {
    if (++visited % 100 === 0) await yieldToLoop("publish-counts");
    checkPublishSignal(signal);
    if (file.role !== "diff" || file.flag) continue;
    const key = `${file.oldBlob}:${file.newBlob}`;
    const outcome = outcomes.get(key);
    if (outcome !== undefined) {
      counted.set(file.path, outcome);
      continue;
    }
    let cache = memo.get(ownerId);
    if (!cache) {
      cache = new Map<string, MemoEntry>();
      memo.set(ownerId, cache);
    }
    const entry = cache.get(key);
    // Expired nulls miss the cache but retain their strike history for the retry.
    let counts = entry?.counts === null && now() >= entry.expiresAt ? undefined : entry?.counts;
    if (counts === undefined) {
      if (budget.spentMs >= budget.limitMs) {
        outcomes.set(key, null);
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
      const previous = cache.get(key);
      if (returned && (counts !== null || !previous?.counts)) {
        if (!cache.has(key) && cache.size >= MEMO_ENTRIES) {
          const oldest = cache.keys().next().value;
          if (oldest !== undefined) cache.delete(oldest);
        }
        if (counts === null) {
          const strikes = (previous?.counts === null ? previous.strikes : 0) + 1;
          const ttl = strikes === 1 ? DIFF_COUNT_FIRST_NULL_TTL_MS : DIFF_COUNT_NULL_TTL_MS;
          cache.set(key, { counts, strikes, expiresAt: now() + ttl });
        } else cache.set(key, { counts });
      }
    }
    outcomes.set(key, counts);
    counted.set(file.path, counts);
  }
  checkPublishSignal(signal);
  return counted;
}
