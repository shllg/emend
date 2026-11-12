import type { PublishFile } from "@emend/contract";
import { yieldToLoop } from "../pacing.ts";
import { checkPublishSignal, PublishAborted } from "./lifecycle.ts";
import type { Executor } from "./work.ts";

export const DIFF_COUNT_BUDGET_MS = 20000;
type Counts = { additions: number; deletions: number } | null;
export type DiffCountBudget = { limitMs: number; spentMs: number };
export const createDiffCountBudget = (limitMs = DIFF_COUNT_BUDGET_MS): DiffCountBudget => ({ limitMs, spentMs: 0 });

const MEMO_ENTRIES = 20000;
// Owners never share results. Retain only bounded counts, never blob contents.
const memo = new Map<string, Counts>();

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
    const key = `${ownerId}:${file.oldBlob}:${file.newBlob}`;
    let counts = memo.get(key);
    if (counts === undefined) {
      if (budget.spentMs >= budget.limitMs) {
        counted.set(file.path, null);
        continue;
      }
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
        budget.spentMs += now() - start;
      }
      checkPublishSignal(signal);
      if (memo.size >= MEMO_ENTRIES) {
        const oldest = memo.keys().next().value;
        if (oldest !== undefined) memo.delete(oldest);
      }
      memo.set(key, counts);
    }
    counted.set(file.path, counts);
  }
  checkPublishSignal(signal);
  return counted;
}
