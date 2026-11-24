import type { RevisionView } from "@recense/contract";
import { expect, test } from "vitest";
import { openingView } from "./opening-view.ts";

const empty: RevisionView = {
  seq: 1,
  base: null,
  head: null,
  main: null,
  writeupEmpty: true,
  topics: [],
  files: [],
  writeup: { sections: [] },
  docs: [],
  threads: [],
  changedBlocks: [],
};
const docs: RevisionView["docs"] = [
  { path: "z-plan.md", kind: "markdown", blocks: [] },
  { path: "a-plan.html", kind: "html", contentUrl: "/content/key/a-plan.html" },
];
const files: RevisionView["files"] = [
  {
    id: "11111111-1111-4111-8111-111111111111",
    path: "code.ts",
    oldPath: null,
    role: "diff",
    status: "modified",
    topic: null,
    order: 0,
    mediaType: "text/plain",
    flag: "binary",
    hasOld: false,
    hasNew: false,
  },
];

test.each<{ name: string; change: Partial<RevisionView>; view: ReturnType<typeof openingView> }>([
  { name: "explicit empty writeup", change: { main: "writeup", docs, files }, view: { tab: "writeup" } },
  { name: "main doc", change: { main: "a-plan.html", docs }, view: { tab: "docs", doc: "a-plan.html" } },
  {
    name: "main doc beats text",
    change: { main: "a-plan.html", docs, writeupEmpty: false },
    view: { tab: "docs", doc: "a-plan.html" },
  },
  { name: "writeup text", change: { writeupEmpty: false, docs, files }, view: { tab: "writeup" } },
  { name: "docs before diff in manifest order", change: { docs, files }, view: { tab: "docs", doc: "z-plan.md" } },
  { name: "diff only", change: { files }, view: { tab: "diff" } },
  { name: "nothing", change: {}, view: { tab: "writeup" } },
  {
    name: "non-diff file is not a diff",
    change: { files: files.map((file) => ({ ...file, role: "asset" })) },
    view: { tab: "writeup" },
  },
  {
    name: "missing main doc falls back",
    change: { main: "missing.md", docs, files },
    view: { tab: "docs", doc: "z-plan.md" },
  },
])("opening view: $name", ({ change, view }) => {
  expect(openingView({ ...empty, ...change })).toEqual(view);
});
