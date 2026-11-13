import type { Target } from "@emend/contract";
import { expect, test, vi } from "vitest";
import * as payload from "./payload.ts";
import { mailboxFixture } from "./test-support.ts";

test.each<Target>([
  { kind: "review" },
  { kind: "topic", slug: "synthetic" },
  { kind: "topic", slug: "synthetic", part: "title", quote: "s", prefix: "", suffix: "" },
  { kind: "file", path: "文.md" },
  { kind: "lines", path: "a.ts", side: "new", start: 1, end: 1, lines: ["\\".repeat(65536)], before: [], after: [] },
  { kind: "source-lines", path: "a.ts", start: 1, end: 1, lines: ["\\".repeat(65536)], before: [], after: [] },
  { kind: "writeup-span", blockId: "overview-00000000", quote: "needle", prefix: "", suffix: "" },
  { kind: "doc-span", path: "文.md", blockId: "doc-00000000", quote: "needle", prefix: "", suffix: "" },
  { kind: "html-span", path: "a.html", quote: "needle", prefix: "", suffix: "" },
])("breaker: target reserve preserves every body byte for $kind", (target) => {
  for (const body of ["", "plain", '界🙂\n\t"\\', "\ud800"]) {
    expect(payload.commentTargetReserve(target) + payload.jsonBytes(body) - 2).toBe(
      payload.commentReserve(target, body),
    );
    expect(payload.commentReserve(target, body) - payload.commentReserve(target, "")).toBe(payload.jsonBytes(body) - 2);
  }
});

test("a topic quote reserves the longer part name and largest offsets after a move", () => {
  const target: Target = { kind: "topic", slug: "synthetic", part: "title", quote: "s", prefix: "", suffix: "" };
  const id = "00000000-0000-4000-8000-000000000000";
  const body = "A comment";
  const comment = {
    id,
    threadId: id,
    target,
    body,
    history: [],
    historyTrimmed: true,
    placement: {
      status: "placed",
      location: {
        kind: "topic",
        slug: target.slug,
        part: "summary",
        start: Number.MAX_SAFE_INTEGER - 1,
        end: Number.MAX_SAFE_INTEGER,
      },
    },
  };
  expect(payload.commentReserve(target, body)).toBeGreaterThanOrEqual(payload.jsonBytes(comment) + 1);
});

test("breaker: Send reserves each thread target once and resets for the next Send", async () => {
  const f = await mailboxFixture();
  try {
    const first = await f.thread("First");
    const second = await f.thread("Second");
    await f.comment(first.threadId, "Again");
    await f.comment(second.threadId, "界\n");
    const reserve = vi.spyOn(payload, "commentTargetReserve");
    await f.send();
    expect(reserve).toHaveBeenCalledTimes(2);
    await f.comment(first.threadId, "Next Send");
    await f.send();
    expect(reserve).toHaveBeenCalledTimes(3);
  } finally {
    vi.restoreAllMocks();
    await f.cleanup();
  }
});
