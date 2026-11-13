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
    { id: revision.files[1]?.id, path: "z.md", label: "The plan", title: "The plan" },
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
