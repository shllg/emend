import { RevisionView } from "@emend/contract";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { writeups } from "../../db/schema.ts";
import { mailboxFixture } from "../mailbox/test-support.ts";
import { WorkTimeout } from "../publish/executor.ts";
import { executeWork, type Work } from "../publish/work.ts";
import {
  COMMENT_HTML_BYTES,
  COMMENT_SOURCE_CHARS,
  clearCommentHtmlCache,
  closeCommentRenderer,
  commentHtml,
  commentTiming,
} from "./comment-html.ts";

const owner = "owner-a";
let f: Awaited<ReturnType<typeof mailboxFixture>>;
beforeEach(async () => {
  // Real renders are bounded by the test timeout. Only timer specs use shorter limits, with fake timers.
  Object.assign(commentTiming, { renderMs: 60_000, failedMs: 10 * 60 * 1000, deadlineMs: 60_000, maxQueue: 64 });
  clearCommentHtmlCache();
  f = await mailboxFixture();
  const blob = await f.deps.blobs.put(f.ownerId, Buffer.from(JSON.stringify({ sections: [] })), "application/json");
  await f.db.query((q) =>
    q.insert(writeups).values({ ownerId: f.ownerId, revisionId: f.revisionId, sourceBlob: blob, renderedBlob: blob }),
  );
});
afterEach(async () => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  await f.cleanup();
});

const view = async () =>
  RevisionView.parse(await (await f.request(`/reviews/${f.reviewId}/revisions/1`, "GET")).json());
const spy = () => {
  const calls: Work[] = [];
  f.deps.publishExecutor = async (work) => {
    calls.push(work);
    return executeWork(work);
  };
  return calls;
};

test("a user comment and an agent reply come back with sanitized html beside the raw body", async () => {
  const thread = await f.thread("A **bold** user comment with `code`");
  await f.send();
  const reply = await f.request(
    `/comments/${thread.commentId}/reply`,
    "POST",
    { outcome: "explained", body: "- one\n- two\n\n<script>alert(1)</script>\n\n[x](javascript:alert(1))" },
    "agent",
  );
  expect(reply.status).toBe(201);
  const comments = (await view()).threads[0]?.comments ?? [];
  expect(comments[0]).toMatchObject({ body: "A **bold** user comment with `code`" });
  expect(comments[0]?.html).toBe("<p>A <strong>bold</strong> user comment with <code>code</code></p>");
  expect(comments[1]?.body).toContain("<script>");
  expect(comments[1]?.html).toContain("<li>one</li>");
  expect(comments[1]?.html).not.toMatch(/<script|javascript:/);
});

test("#123 links only when the revision has a repoUrl", async () => {
  await f.thread("Fixes #123");
  expect((await view()).threads[0]?.comments[0]?.html).not.toContain("<a ");
  clearCommentHtmlCache();
  const blob = await f.deps.blobs.put(
    f.ownerId,
    Buffer.from(JSON.stringify({ sections: [], repoUrl: "https://github.com/owner/name" })),
    "application/json",
  );
  await f.db.query((q) => q.update(writeups).set({ renderedBlob: blob }));
  expect((await view()).threads[0]?.comments[0]?.html).toContain('href="https://github.com/owner/name/issues/123"');
});

test("a repeated body is rendered once and served from the cache, also on the next read", async () => {
  const calls = spy();
  const thread = await f.thread("Same words");
  await f.comment(thread.threadId, "Same words");
  await f.comment(thread.threadId, "Other words");
  const first = await view();
  expect(first.threads[0]?.comments.map((c) => c.html)).toEqual([
    "<p>Same words</p>",
    "<p>Same words</p>",
    "<p>Other words</p>",
  ]);
  const renders = calls.filter((work) => work.kind === "comment-md");
  expect(renders.map((work) => (work.kind === "comment-md" ? work.bodies : []))).toEqual([
    ["Same words"],
    ["Other words"],
  ]);
  await view();
  expect(calls.filter((work) => work.kind === "comment-md")).toHaveLength(2);
});

test("a comment that times out is plain text, is not retried, and does not blank the others", async () => {
  const calls: string[] = [];
  f.deps.publishExecutor = async (work) => {
    if (work.kind !== "comment-md") return executeWork(work);
    calls.push(work.bodies.join());
    // The worker's own timeout, as the executor reports it, while the other renders keep the full limit.
    if (work.bodies.some((body) => body.includes("hang"))) throw new WorkTimeout();
    return executeWork(work);
  };
  const thread = await f.thread("first **ok**");
  await f.comment(thread.threadId, "hang forever");
  await f.comment(thread.threadId, "last **ok**");
  const html = async () => (await view()).threads[0]?.comments.map((c) => c.html);
  expect(await html()).toEqual(["<p>first <strong>ok</strong></p>", null, "<p>last <strong>ok</strong></p>"]);
  expect(calls).toHaveLength(3);
  expect(await html()).toEqual(["<p>first <strong>ok</strong></p>", null, "<p>last <strong>ok</strong></p>"]);
  expect(calls).toHaveLength(3);
});

test("an executor that never answers is cut off at the limit and marked failed", async () => {
  vi.useFakeTimers();
  commentTiming.renderMs = 30;
  let calls = 0;
  const deps = {
    publishExecutor: async () => {
      calls += 1;
      return new Promise<never>(() => {});
    },
  };
  const read = commentHtml(deps, owner, ["hang"], undefined);
  await vi.advanceTimersByTimeAsync(commentTiming.renderMs + 500);
  expect(await read).toEqual([null]);
  expect(await commentHtml(deps, owner, ["hang"], undefined)).toEqual([null]);
  expect(calls).toBe(1);
});

test("a failed comment is tried again after the failure expires", async () => {
  vi.useFakeTimers({ toFake: ["Date"] });
  try {
    vi.setSystemTime(new Date("2030-01-01T00:00:00Z"));
    let attempts = 0;
    const deps = {
      publishExecutor: async (work: Work) => {
        attempts += 1;
        if (attempts === 1) throw new Error("Worker failed");
        return executeWork(work);
      },
    };
    expect(await commentHtml(deps, owner, ["again"], undefined)).toEqual([null]);
    vi.setSystemTime(new Date("2030-01-01T00:09:59Z"));
    expect(await commentHtml(deps, owner, ["again"], undefined)).toEqual([null]);
    expect(attempts).toBe(1);
    vi.setSystemTime(new Date("2030-01-01T00:10:01Z"));
    expect(await commentHtml(deps, owner, ["again"], undefined)).toEqual(["<p>again</p>"]);
    expect(attempts).toBe(2);
  } finally {
    vi.useRealTimers();
  }
});

test("closing the renderer during a render does not mark the comment failed, and queued jobs start no worker", async () => {
  let release: () => void = () => {};
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const started: string[] = [];
  const running = Promise.withResolvers<void>();
  const deps = {
    publishExecutor: async (work: Work) => {
      if (work.kind === "comment-md") started.push(work.bodies.join());
      running.resolve();
      await gate;
      throw new Error("Worker failed");
    },
  };
  const read = commentHtml(deps, owner, ["running", "queued"], undefined);
  await running.promise;
  expect(started).toEqual(["running"]);
  await closeCommentRenderer();
  release();
  expect(await read).toEqual([null, null]);
  expect(started).toEqual(["running"]);
  // Neither comment is marked failed: both render on the next read.
  const fresh = { publishExecutor: async (work: Work) => executeWork(work) };
  expect(await commentHtml(fresh, owner, ["running", "queued"], undefined)).toEqual([
    "<p>running</p>",
    "<p>queued</p>",
  ]);
});

test("two concurrent reads of one comment run one job", async () => {
  let jobs = 0;
  let release: () => void = () => {};
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const deps = {
    publishExecutor: async (work: Work) => {
      jobs += 1;
      await gate;
      return executeWork(work);
    },
  };
  const a = commentHtml(deps, owner, ["shared"], undefined);
  const b = commentHtml(deps, owner, ["shared"], undefined);
  release();
  expect(await Promise.all([a, b])).toEqual([["<p>shared</p>"], ["<p>shared</p>"]]);
  expect(jobs).toBe(1);
});

test("comment jobs run one at a time", async () => {
  let running = 0;
  let most = 0;
  const deps = {
    publishExecutor: async (work: Work) => {
      running += 1;
      most = Math.max(most, running);
      try {
        return await executeWork(work);
      } finally {
        running -= 1;
      }
    },
  };
  await Promise.all([
    commentHtml(deps, owner, ["one", "two"], undefined),
    commentHtml(deps, owner, ["three", "four"], undefined),
  ]);
  expect(most).toBe(1);
});

test("the cache counts two bytes per character, so wide HTML evicts sooner", async () => {
  // 3M characters is 3 MB as ASCII but 6 MB as UTF-16: three of them pass 16 MiB only when counted twice.
  let jobs = 0;
  const deps = {
    publishExecutor: async (work: Work) => {
      jobs += 1;
      return {
        kind: "comment-md" as const,
        html: work.kind === "comment-md" ? work.bodies.map(() => "x".repeat(3_000_000)) : [],
      };
    },
  };
  for (const body of ["w1", "w2", "w3"]) await commentHtml(deps, owner, [body], undefined);
  expect(jobs).toBe(3);
  await commentHtml(deps, owner, ["w3"], undefined);
  expect(jobs).toBe(3);
  await commentHtml(deps, owner, ["w1"], undefined);
  expect(jobs).toBe(4);
});

test("a worker failure leaves html null and the response succeeds", async () => {
  f.deps.publishExecutor = async (work) => {
    if (work.kind !== "comment-md") return executeWork(work);
    throw new Error("Worker failed");
  };
  await f.thread("Plain **words**");
  const comment = (await view()).threads[0]?.comments[0];
  expect(comment).toMatchObject({ body: "Plain **words**", html: null });
});

test("one comment that fails to render is null while the others render", async () => {
  f.deps.publishExecutor = async (work) => {
    if (work.kind !== "comment-md") return executeWork(work);
    return { kind: "comment-md", html: work.bodies.map((body) => (body.includes("bad") ? null : `<p>${body}</p>`)) };
  };
  const thread = await f.thread("good one");
  await f.comment(thread.threadId, "bad one");
  expect((await view()).threads[0]?.comments.map((c) => c.html)).toEqual(["<p>good one</p>", null]);
});

test("the HTML budget nulls a comment past it, and the source budget stops rendering new bodies", async () => {
  // The subject is the budget accounting, not Markdown: plain paragraphs stand in for the renderer,
  // and the 256 Ki expansion test below keeps the real one.
  const paragraphs = async (work: Work) =>
    work.kind === "comment-md"
      ? ({ kind: "comment-md", html: work.bodies.map((body) => `<p>${body}</p>`) } as const)
      : executeWork(work);
  // Six cached 200000-character bodies together pass the 1 MiB HTML budget; the sixth is null.
  const bodies6 = Array.from({ length: 6 }, (_, index) => `${index}${"x".repeat(200_000)}`);
  for (const body of bodies6) await commentHtml({ publishExecutor: paragraphs }, owner, [body], undefined);
  const out = await commentHtml({ publishExecutor: paragraphs }, owner, [...bodies6, "small"], undefined);
  expect(out.slice(0, 5).every((html) => typeof html === "string")).toBe(true);
  expect(out[5]).toBeNull();
  expect(out[6]).toBeNull();
  expect(out.slice(0, 5).join("").length).toBeLessThanOrEqual(COMMENT_HTML_BYTES);
  clearCommentHtmlCache();
  const calls: Work[] = [];
  // The first body stays under the 256 Ki HTML cap; the second no longer fits the source budget.
  const bodies = ["a".repeat(COMMENT_SOURCE_CHARS - 10), "b".repeat(20)];
  const result = await commentHtml(
    {
      publishExecutor: async (work) => {
        calls.push(work);
        return paragraphs(work);
      },
    },
    owner,
    bodies,
    undefined,
  );
  expect(result[0]).toBe(`<p>${bodies[0]}</p>`);
  expect(result[1]).toBeNull();
  expect(calls).toHaveLength(1);
});

test("the cache keeps at most 2000 entries, dropping the oldest", async () => {
  const calls: Work[] = [];
  const deps = {
    publishExecutor: async (work: Work) => {
      calls.push(work);
      return executeWork(work);
    },
  };
  commentTiming.maxQueue = 1000;
  const many = Array.from({ length: 2001 }, (_, index) => `c${index}`);
  for (let start = 0; start < many.length; start += 500)
    await commentHtml(deps, owner, many.slice(start, start + 500), undefined);
  calls.length = 0;
  await commentHtml(deps, owner, ["c2000"], undefined);
  expect(calls).toHaveLength(0);
  await commentHtml(deps, owner, ["c0"], undefined);
  expect(calls).toHaveLength(1);
});

test("a body that expands past 256 Ki of HTML is null, marked failed and not rendered again", async () => {
  // 5000 inline links are 110000 characters, within the source budget, and about 450000 characters of HTML.
  const body = "[a](https://x.test/a) ".repeat(5000);
  expect(body.length).toBeLessThan(COMMENT_SOURCE_CHARS);
  let renders = 0;
  const deps = {
    publishExecutor: async (work: Work) => {
      if (work.kind === "comment-md") renders += 1;
      return executeWork(work);
    },
  };
  expect(await commentHtml(deps, owner, [body, "fine"], undefined)).toEqual([null, "<p>fine</p>"]);
  expect(await commentHtml(deps, owner, [body], undefined)).toEqual([null]);
  expect(renders).toBe(2);
  const links = "[x](https://example.test/a) ".repeat(700);
  expect((await commentHtml(deps, owner, [links], undefined))[0]).toContain("<a ");
});

test("a body whose references would expand past 32 Ki of URL text fails in the worker", async () => {
  // Under 21000 characters, but the 10000-character URL would be encoded 2500 times.
  const body = `[a]: https://x.test/${"€".repeat(10_000)}\n\n${"[a] ".repeat(2500)}`;
  expect(await executeWork({ kind: "comment-md", bodies: [body, "fine"] })).toEqual({
    kind: "comment-md",
    html: [null, "<p>fine</p>"],
  });
  const fine = `[a]: https://x.test/${"p".repeat(200)}\n\n${"[a] ".repeat(50)}`;
  const out = await executeWork({ kind: "comment-md", bodies: [fine] });
  expect(out.kind === "comment-md" && out.html[0]).toContain("<a ");
});

test("a read returns at its deadline while a job hangs, and a later read gets the finished HTML", async () => {
  vi.useFakeTimers();
  Object.assign(commentTiming, { deadlineMs: 40, renderMs: 2000 });
  const gate = Promise.withResolvers<void>();
  const deps = {
    publishExecutor: vi.fn(async (work: Work) => {
      await gate.promise;
      return executeWork(work);
    }),
  };
  const read = commentHtml(deps, owner, ["slow one"], undefined);
  const settled = vi.fn();
  void read.then(settled);
  await vi.advanceTimersByTimeAsync(39);
  expect(settled).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(1);
  expect(await read).toEqual([null]);
  // This read joins the actual pending job and settles only after it has populated the cache.
  const finished = commentHtml(deps, owner, ["slow one"], undefined);
  gate.resolve();
  expect(await finished).toEqual(["<p>slow one</p>"]);
  expect(deps.publishExecutor).toHaveBeenCalledOnce();
  const later = { publishExecutor: vi.fn(async () => Promise.reject(new Error("must come from the cache"))) };
  expect(await commentHtml(later, owner, ["slow one"], undefined)).toEqual(["<p>slow one</p>"]);
  expect(later.publishExecutor).not.toHaveBeenCalled();
});

test("a full queue gives null without queueing and without marking the comment failed", async () => {
  commentTiming.maxQueue = 1;
  let release: () => void = () => {};
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const deps = {
    publishExecutor: async (work: Work) => {
      await gate;
      return executeWork(work);
    },
  };
  // "first" runs, "second" is the one job waiting behind it, "third" finds the queue full.
  const read = commentHtml(deps, owner, ["first", "second", "third"], undefined);
  release();
  expect(await read).toEqual(["<p>first</p>", "<p>second</p>", null]);
  expect(await commentHtml(deps, owner, ["first", "second", "third"], undefined)).toEqual([
    "<p>first</p>",
    "<p>second</p>",
    "<p>third</p>",
  ]);
});

test("the cache is per owner: the same body for another owner is rendered again", async () => {
  let renders = 0;
  const deps = {
    publishExecutor: async (work: Work) => {
      renders += 1;
      return executeWork(work);
    },
  };
  await commentHtml(deps, "owner-a", ["same"], undefined);
  await commentHtml(deps, "owner-a", ["same"], undefined);
  expect(renders).toBe(1);
  await commentHtml(deps, "owner-b", ["same"], undefined);
  expect(renders).toBe(2);
});

test("hand-offs keep the raw Markdown body and carry no html; another owner's thread has none", async () => {
  await f.thread("**raw** body");
  await f.send();
  const delivery = await f.take();
  expect(delivery.kind).toBe("go");
  if (delivery.kind !== "go") throw new Error("Expected a Go delivery");
  expect(delivery.comments[0]?.body).toBe("**raw** body");
  expect(JSON.stringify(delivery)).not.toContain('"html"');
  const foreign = await f.request(`/reviews/${f.reviewId}/revisions/1`, "GET", undefined, "foreign");
  expect(foreign.status).toBe(404);
});
