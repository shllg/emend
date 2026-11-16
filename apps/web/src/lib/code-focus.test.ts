import { type FileView, OTHER_TOPIC, type TopicMeta } from "@emend/contract";
import { expect, test } from "vitest";
import { resolveCodeFocus, sameCodeFocus } from "./code-focus.ts";

const file: FileView = {
  id: "11111111-1111-4111-8111-111111111111",
  path: "seed.txt",
  oldPath: null,
  role: "diff",
  topic: "seed",
  order: 0,
  status: "modified",
  mediaType: "text/plain",
  flag: "binary",
  hasOld: false,
  hasNew: false,
};
const topic: TopicMeta = { slug: "seed", title: "Plant a seed", summary: "Grow", importance: 1 };

test("focus resolves only diff files and nonempty topics in the current revision", () => {
  const revision = { files: [file], topics: [topic] };
  expect(resolveCodeFocus(revision, { kind: "topic", slug: "seed" })).toEqual({ title: "Plant a seed" });
  expect(resolveCodeFocus(revision, { kind: "file", id: file.id })).toEqual({ title: "seed.txt" });
  expect(resolveCodeFocus({ ...revision, files: [] }, { kind: "topic", slug: "seed" })).toBeUndefined();
  expect(resolveCodeFocus(revision, { kind: "topic", slug: "missing" })).toBeUndefined();
  expect(resolveCodeFocus(revision, { kind: "file", id: "missing" })).toBeUndefined();
  expect(
    resolveCodeFocus({ ...revision, files: [{ ...file, role: "doc" }] }, { kind: "file", id: file.id }),
  ).toBeUndefined();
  expect(resolveCodeFocus(revision)).toBeUndefined();
});

test.each([null, "missing", OTHER_TOPIC.slug])("Other contains files assigned to %s", (slug) => {
  const revision = { topics: [topic], files: [{ ...file, topic: slug }] };
  expect(resolveCodeFocus(revision, { kind: "topic", slug: OTHER_TOPIC.slug })).toEqual({ title: OTHER_TOPIC.title });
  expect(resolveCodeFocus(revision, { kind: "topic", slug: "seed" })).toBeUndefined();
});

test("focus equality compares target identity and handles closed panels", () => {
  expect(sameCodeFocus()).toBe(true);
  expect(sameCodeFocus({ kind: "topic", slug: "seed" })).toBe(false);
  expect(sameCodeFocus(undefined, { kind: "file", id: "seed" })).toBe(false);
  expect(sameCodeFocus({ kind: "topic", slug: "seed" }, { kind: "file", id: "seed" })).toBe(false);
  expect(sameCodeFocus({ kind: "topic", slug: "seed" }, { kind: "topic", slug: "seed" })).toBe(true);
  expect(sameCodeFocus({ kind: "file", id: "seed" }, { kind: "file", id: "seed" })).toBe(true);
  expect(sameCodeFocus({ kind: "file", id: "seed" }, { kind: "file", id: "water" })).toBe(false);
});
