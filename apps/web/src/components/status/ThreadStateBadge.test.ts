import type { ThreadView } from "@emend/contract";
import { expect, test } from "vitest";
import { formatThreadCounts, threadCounts } from "./ThreadStateBadge.tsx";

const target = { kind: "file", path: "example.ts" } as const;
const base: ThreadView = {
  id: "11111111-1111-4111-8111-111111111111",
  target,
  createdOn: 1,
  state: "open",
  placement: { status: "placed", location: target },
  comments: [{ id: "comment", author: "user", body: "A comment", sent: true, sentOn: 1 }],
};
const unsent: ThreadView["comments"] = [
  { id: "first", author: "user", body: "First comment", sent: false, sentOn: null },
  { id: "second", author: "user", body: "Second comment", sent: false, sentOn: null },
];

test.each<{ name: string; thread: ThreadView; unsent: number; open: number }>([
  { name: "multiple unsent user comments", thread: { ...base, comments: unsent }, unsent: 1, open: 1 },
  { name: "sent", thread: { ...base, state: "sent" }, unsent: 0, open: 1 },
  { name: "answered", thread: { ...base, state: "answered" }, unsent: 0, open: 1 },
  { name: "open", thread: base, unsent: 0, open: 1 },
  { name: "resolved", thread: { ...base, state: "resolved" }, unsent: 0, open: 0 },
  {
    name: "agent-only comment",
    thread: {
      ...base,
      state: "resolved",
      comments: [{ id: "agent", author: "agent", body: "An answer", sent: false, sentOn: null }],
    },
    unsent: 0,
    open: 0,
  },
  {
    name: "resolved with an unsent user comment",
    thread: { ...base, state: "resolved", comments: unsent },
    unsent: 1,
    open: 1,
  },
  {
    name: "unplaced with an unsent user comment",
    thread: { ...base, placement: { status: "unplaced", reason: "file-gone" }, comments: unsent },
    unsent: 0,
    open: 1,
  },
  {
    name: "unplaced and resolved with an unsent user comment",
    thread: { ...base, state: "resolved", placement: { status: "unplaced", reason: "file-gone" }, comments: unsent },
    unsent: 0,
    open: 1,
  },
])("counts a thread with $name", ({ thread, unsent, open }) => {
  expect(threadCounts([thread])).toEqual({ unsent, open, all: 1 });
});

test("totals threads and formats their visible count and description", () => {
  const counts = threadCounts([
    { ...base, comments: unsent },
    { ...base, comments: unsent },
    ...(["sent", "answered", "open", "resolved", "resolved", "resolved", "resolved"] as const).map((state) => ({
      ...base,
      state,
    })),
  ]);
  expect(counts).toEqual({ unsent: 2, open: 5, all: 9 });
  expect(formatThreadCounts(counts)).toEqual({
    text: "2 / 5 / 9",
    description: "2 unsent, 5 not resolved, 9 threads in all",
  });
});

test("formats empty and singular thread counts", () => {
  expect(threadCounts([])).toEqual({ unsent: 0, open: 0, all: 0 });
  expect(formatThreadCounts(threadCounts([]))).toEqual({
    text: "0 / 0 / 0",
    description: "0 unsent, 0 not resolved, 0 threads in all",
  });
  expect(formatThreadCounts(threadCounts([base]))).toEqual({
    text: "0 / 1 / 1",
    description: "0 unsent, 1 not resolved, 1 thread in all",
  });
});
