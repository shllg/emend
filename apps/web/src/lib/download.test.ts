import type { RevisionView } from "@emend/contract";
import { expect, test } from "vitest";
import { downloadBaseLabel, downloadDocChoices } from "./download.ts";

const revision: RevisionView = {
  seq: 1,
  base: null,
  head: null,
  main: null,
  writeupEmpty: false,
  topics: [],
  writeup: { sections: [] },
  threads: [],
  changedBlocks: [],
  docs: [
    { path: "z.md", kind: "markdown", blocks: [], title: "The plan" },
    { path: "a.html", kind: "html", contentUrl: "/content/key/a.html" },
    { path: "missing.md", kind: "markdown", blocks: [] },
    { path: "asset.md", kind: "markdown", blocks: [] },
  ],
  files: ["a.html", "z.md", "asset.md"].map((path, index) => ({
    id: `11111111-1111-4111-8111-${String(index).padStart(12, "0")}`,
    path,
    role: path === "asset.md" ? "asset" : "doc",
    order: index,
    oldPath: null,
    status: null,
    topic: null,
    mediaType: "text/html",
    flag: null,
    hasOld: false,
    hasNew: true,
  })),
};

test("choices follow doc order, map file ids, preserve titles and omit docs without a doc row", () => {
  expect(downloadDocChoices(revision)).toEqual([
    { id: revision.files[1]?.id, path: "z.md", label: "The plan", title: "The plan", description: "z.md" },
    { id: revision.files[0]?.id, path: "a.html", label: "a.html", title: undefined },
  ]);
  expect(downloadBaseLabel(revision)).toBe("The writeup");
});

test.each([
  ["a.html", "a.html", "z.md"],
  [null, "The plan", "a.html"],
  ["absent.md", "The plan", "a.html"],
] as const)("pub main %s determines the base label and excluded doc", (main, label, choice) => {
  const pub = { ...revision, writeupEmpty: true, main };
  expect(downloadBaseLabel(pub)).toBe(label);
  expect(downloadDocChoices(pub).map((doc) => doc.path)).toEqual([choice]);
});

test("an empty writeup with a diff base remains the base file, and a docless pub falls back to it", () => {
  const code = { ...revision, writeupEmpty: true, base: "a".repeat(40) };
  expect(downloadBaseLabel(code)).toBe("The writeup");
  expect(downloadDocChoices(code)).toEqual(downloadDocChoices(revision));
  const pub = { ...revision, writeupEmpty: true, docs: [] };
  expect(downloadBaseLabel(pub)).toBe("The writeup");
  expect(downloadDocChoices(pub)).toEqual([]);
});

const dualView: RevisionView = {
  ...revision,
  docs: [
    { kind: "markdown", path: "plan.md", title: "The plan", blocks: [] },
    { kind: "source", path: "plan.md", title: "Plan source", language: "md", lines: [] },
  ],
  files: [false, true].map((source, index) => ({
    id: `22222222-2222-4222-8222-${String(index).padStart(12, "0")}`,
    path: "plan.md",
    role: "doc",
    order: index,
    oldPath: null,
    status: null,
    topic: null,
    mediaType: source ? "text/plain" : "text/markdown",
    flag: null,
    hasOld: false,
    hasNew: true,
    ...(source ? { view: "source" as const } : {}),
  })),
};

test("rendered and source choices at one path map to distinct doc file ids", () => {
  const choices = downloadDocChoices(dualView);
  expect(choices.map((doc) => doc.id)).toEqual(dualView.files.map((file) => file.id));
  expect(choices.map((doc) => doc.description)).toEqual(["plan.md", "plan.md · source"]);
  expect(downloadDocChoices({ ...dualView, files: dualView.files.slice(0, 1) }).map((doc) => doc.id)).toEqual([
    dualView.files[0]?.id,
  ]);
});

test.each([null, "plan.md"])("a pub excludes exactly its first doc view in file order for main %s", (main) => {
  for (const sourceFirst of [false, true]) {
    const pub = {
      ...dualView,
      writeupEmpty: true,
      main,
      docs: sourceFirst ? [...dualView.docs].reverse() : dualView.docs,
      files: sourceFirst ? [...dualView.files].reverse() : dualView.files,
    };
    expect(downloadBaseLabel(pub)).toBe(sourceFirst ? "Plan source" : "The plan");
    expect(downloadDocChoices(pub).map((doc) => doc.id)).toEqual([pub.files[1]?.id]);
  }
});
