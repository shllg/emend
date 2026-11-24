import { type HtmlCodeColour, htmlCodeCandidate } from "@recense/core";
import type { AppDeps } from "../app.ts";
import { workerExecutor } from "../publish/executor.ts";
import type { Executor } from "../publish/work.ts";

const CACHE_ENTRIES = 64;
const CACHE_BYTES = 16 * 1048576;
const FAILED_ENTRIES = 2000;

export const codeColourTiming = { renderMs: 5000, failedMs: 10 * 60 * 1000, deadlineMs: 3000, maxQueue: 16 };

const cache = new Map<string, { colours: HtmlCodeColour[]; bytes: number }>();
let cacheBytes = 0;
const failed = new Map<string, number>();
const pending = new Map<string, Promise<HtmlCodeColour[] | null>>();
let tail: Promise<unknown> = Promise.resolve();
let unfinished = 0;
let generation = 0;
let shared: ReturnType<typeof workerExecutor> | undefined;

export function clearCodeColourCache() {
  generation += 1;
  cache.clear();
  cacheBytes = 0;
  failed.clear();
  pending.clear();
}

/** Stops the shared worker. The next render starts a new one. */
export async function closeCodeColourRenderer() {
  generation += 1;
  pending.clear();
  const current = shared;
  shared = undefined;
  await current?.close();
}

function remember(key: string, colours: HtmlCodeColour[]) {
  const bytes = colours.reduce((total, colour) => total + colour.markup.length * 2, 0);
  if (bytes > CACHE_BYTES) return;
  const old = cache.get(key);
  if (old) {
    cacheBytes -= old.bytes;
    cache.delete(key);
  }
  cache.set(key, { colours, bytes });
  cacheBytes += bytes;
  for (const [oldest, entry] of cache) {
    if (cache.size <= CACHE_ENTRIES && cacheBytes <= CACHE_BYTES) break;
    cache.delete(oldest);
    cacheBytes -= entry.bytes;
  }
}

function forget(key: string) {
  failed.delete(key);
  failed.set(key, Date.now() + codeColourTiming.failedMs);
  for (const oldest of failed.keys()) {
    if (failed.size <= FAILED_ENTRIES) break;
    failed.delete(oldest);
  }
}

function hasFailed(key: string) {
  const until = failed.get(key);
  if (until === undefined) return false;
  if (until > Date.now()) return true;
  failed.delete(key);
  return false;
}

function enqueue<T>(job: () => Promise<T>): Promise<T> {
  const next = tail.then(job, job);
  tail = next.catch(() => undefined);
  return next;
}

async function renderOne(run: Executor, page: string): Promise<HtmlCodeColour[] | null> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    // The worker has its own timeout; this also bounds an executor that never answers.
    const result = await Promise.race([
      run({ kind: "code-colours", page }),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error("Code colour render timed out")), codeColourTiming.renderMs + 500);
      }),
    ]);
    return result.kind === "code-colours" ? result.colours : null;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

function start(deps: Pick<AppDeps, "publishExecutor">, key: string, page: string) {
  // A full queue skips this read without marking the key failed.
  if (unfinished > codeColourTiming.maxQueue) return Promise.resolve(null);
  unfinished += 1;
  const queuedIn = generation;
  const job: Promise<HtmlCodeColour[] | null> = enqueue(async () => {
    if (queuedIn !== generation) return null;
    if (!deps.publishExecutor && !shared)
      shared = workerExecutor({ render: codeColourTiming.renderMs, place: codeColourTiming.renderMs });
    const run = deps.publishExecutor ?? shared;
    if (!run) return null;
    const colours = await renderOne(run, page);
    // Closing or clearing invalidates pending cache writes and failures.
    if (queuedIn !== generation) return colours;
    if (colours === null) forget(key);
    else remember(key, colours);
    return colours;
  }).finally(() => {
    unfinished -= 1;
    if (pending.get(key) === job) pending.delete(key);
  });
  pending.set(key, job);
  return job;
}

/** A read can return plain code while its worker job continues to fill the cache. Never throws. */
export async function codeColours(
  deps: Pick<AppDeps, "publishExecutor">,
  key: string,
  page: string,
): Promise<HtmlCodeColour[]> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    if (!htmlCodeCandidate(page)) return [];
    const hit = cache.get(key);
    if (hit) {
      cache.delete(key);
      cache.set(key, hit);
      return hit.colours;
    }
    if (hasFailed(key)) return [];
    const job = pending.get(key) ?? start(deps, key, page);
    const deadline = new Promise<null>((resolve) => {
      timer = setTimeout(() => resolve(null), codeColourTiming.deadlineMs);
    });
    return (await Promise.race([job, deadline])) ?? [];
  } catch {
    return [];
  } finally {
    clearTimeout(timer);
  }
}
