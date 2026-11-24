import { createHash } from "node:crypto";
import type { AppDeps } from "../app.ts";
import { workerExecutor } from "../publish/executor.ts";
import type { Executor } from "../publish/work.ts";

/** At most this much rendered HTML in one response, and this much Markdown the cache does not hold. */
export const COMMENT_HTML_BYTES = 1048576;
export const COMMENT_SOURCE_CHARS = 262144;
const CACHE_ENTRIES = 2000;
const CACHE_BYTES = 16 * 1048576;
const FAILED_ENTRIES = 2000;

/**
 * One comment gets `renderMs` once it runs; a comment that fails or runs over stays plain text for `failedMs`.
 * One read waits `deadlineMs` in all, and at most `maxQueue` jobs wait for the worker. Tests lower them.
 */
export const commentTiming = { renderMs: 2000, failedMs: 10 * 60 * 1000, deadlineMs: 2500, maxQueue: 64 };

const encoder = new TextEncoder();
// Keyed by owner, repoUrl and body, so a hit never tells one owner that another wrote the same words.
// A string costs two bytes per character, because V8 keeps non-Latin-1 text as UTF-16.
const cache = new Map<string, { html: string; bytes: number }>();
let cacheBytes = 0;
// Key to the time its failure expires. A bad comment is not retried on every read.
const failed = new Map<string, number>();
// Concurrent reads of one comment wait on one render.
const pending = new Map<string, Promise<string | null>>();
let tail: Promise<unknown> = Promise.resolve();
// Jobs queued or running. The cache, the queue and the worker belong to the process and are shared by
// every server in it.
let unfinished = 0;
// Close and clear bump this; a job from an older generation gives null and leaves no trace.
let generation = 0;
let shared: ReturnType<typeof workerExecutor> | undefined;

export function clearCommentHtmlCache() {
  generation += 1;
  cache.clear();
  cacheBytes = 0;
  failed.clear();
  pending.clear();
}

/** Stops the worker that renders comments. The next render starts a new one. Called when the server closes. */
export async function closeCommentRenderer() {
  generation += 1;
  pending.clear();
  const current = shared;
  shared = undefined;
  await current?.close();
}

const keyOf = (ownerId: string, body: string, repoUrl: string | undefined) =>
  createHash("sha256")
    .update(`${ownerId}\n${repoUrl ?? ""}\n${body}`)
    .digest("hex");

function remember(key: string, html: string) {
  const bytes = html.length * 2;
  if (bytes > CACHE_BYTES) return;
  const old = cache.get(key);
  if (old) {
    cacheBytes -= old.bytes;
    cache.delete(key);
  }
  cache.set(key, { html, bytes });
  cacheBytes += bytes;
  // Map order is use order: the oldest entry goes first.
  for (const [oldest, entry] of cache) {
    if (cache.size <= CACHE_ENTRIES && cacheBytes <= CACHE_BYTES) break;
    cache.delete(oldest);
    cacheBytes -= entry.bytes;
  }
}

function forget(key: string) {
  failed.delete(key);
  failed.set(key, Date.now() + commentTiming.failedMs);
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

/** Jobs run one at a time. */
function enqueue<T>(job: () => Promise<T>): Promise<T> {
  const next = tail.then(job, job);
  tail = next.catch(() => undefined);
  return next;
}

async function renderOne(run: Executor, body: string, repoUrl: string | undefined): Promise<string | null> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    // The worker enforces its own limit; this one also covers an executor that never answers.
    const result = await Promise.race([
      run({ kind: "comment-md", bodies: [body], repoUrl }),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error("Comment render timed out")), commentTiming.renderMs + 500);
      }),
    ]);
    const html = result.kind === "comment-md" ? result.html[0] : undefined;
    return typeof html === "string" ? html : null;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

function start(deps: Pick<AppDeps, "publishExecutor">, key: string, body: string, repoUrl: string | undefined) {
  // `maxQueue` is the number of jobs waiting behind the one that runs. A full queue gives plain text for
  // now; the comment is not marked failed and renders on a later read.
  if (unfinished > commentTiming.maxQueue) return Promise.resolve(null);
  unfinished += 1;
  const queuedIn = generation;
  const job: Promise<string | null> = enqueue(async () => {
    // A close or clear since this job was queued ends it at once, without a new worker.
    if (queuedIn !== generation) return null;
    if (!deps.publishExecutor && !shared)
      shared = workerExecutor({ render: commentTiming.renderMs, place: commentTiming.renderMs });
    const run = deps.publishExecutor ?? shared;
    if (!run) return null;
    const html = await renderOne(run, body, repoUrl);
    // A job that ends after a close or clear is neither cached nor marked failed: the close caused its result.
    if (queuedIn !== generation) return html;
    if (html === null) forget(key);
    else remember(key, html);
    return html;
  }).finally(() => {
    unfinished -= 1;
    if (pending.get(key) === job) pending.delete(key);
  });
  pending.set(key, job);
  return job;
}

/**
 * Sanitized HTML for each comment body, in order, or null where there is none: the budget is spent,
 * or that comment failed to render. Never throws, so a comment problem cannot fail the revision read.
 */
export async function commentHtml(
  deps: Pick<AppDeps, "publishExecutor">,
  ownerId: string,
  bodies: string[],
  repoUrl: string | undefined,
): Promise<(string | null)[]> {
  const keys = bodies.map((body) => keyOf(ownerId, body, repoUrl));
  const found = new Map<string, Promise<string | null> | string>();
  let sourceChars = 0;
  bodies.forEach((body, index) => {
    const key = keys[index] ?? "";
    if (found.has(key)) return;
    const hit = cache.get(key);
    if (hit) {
      // Re-insert to mark it as recently used.
      cache.delete(key);
      cache.set(key, hit);
      found.set(key, hit.html);
      return;
    }
    const inFlight = pending.get(key);
    if (inFlight) {
      found.set(key, inFlight);
    } else if (!hasFailed(key) && sourceChars + body.length <= COMMENT_SOURCE_CHARS) {
      sourceChars += body.length;
      found.set(key, start(deps, key, body, repoUrl));
    }
  });
  // One deadline for the whole read. Jobs that miss it keep running and fill the cache for the next read.
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<null>((resolve) => {
    timer = setTimeout(() => resolve(null), commentTiming.deadlineMs);
  });
  const settled = new Map<string, string | null>();
  try {
    for (const [key, value] of found) settled.set(key, await Promise.race([value, deadline]));
  } finally {
    clearTimeout(timer);
  }
  let total = 0;
  let over = false;
  return keys.map((key) => {
    const html = settled.get(key);
    if (over || typeof html !== "string") return null;
    total += encoder.encode(html).byteLength;
    if (total <= COMMENT_HTML_BYTES) return html;
    over = true;
    return null;
  });
}
