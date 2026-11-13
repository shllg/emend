import { LIMITS, type RevisionView } from "@emend/contract";
import { expect, test } from "vitest";
import apiDocs from "../../../../docs/api.md?raw";
import { downloadBaseIsHtml, downloadBaseLabel, downloadDocChoices, downloadHasComments } from "./download.ts";

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
    { id: revision.files[1]?.id, path: "z.md", label: "The plan", title: "The plan", source: false },
    { id: revision.files[0]?.id, path: "a.html", label: "a.html", title: undefined, source: false },
  ]);
  expect(downloadBaseLabel(revision)).toBeNull();
});

test.each([
  ["a.html", { path: "a.html" }, "z.md"],
  [null, { title: "The plan", path: "z.md" }, "a.html"],
  ["absent.md", { title: "The plan", path: "z.md" }, "a.html"],
] as const)("pub main %s determines the base label and excluded doc", (main, label, choice) => {
  const pub = { ...revision, writeupEmpty: true, main };
  expect(downloadBaseLabel(pub)).toEqual(label);
  expect(downloadDocChoices(pub).map((doc) => doc.path)).toEqual([choice]);
});

test("an empty writeup with a diff base remains the base file, and a docless pub falls back to it", () => {
  const code = { ...revision, writeupEmpty: true, base: "a".repeat(40) };
  expect(downloadBaseLabel(code)).toBeNull();
  expect(downloadDocChoices(code)).toEqual(downloadDocChoices(revision));
  const pub = { ...revision, writeupEmpty: true, docs: [] };
  expect(downloadBaseLabel(pub)).toBeNull();
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
  expect(choices.map((doc) => ({ path: doc.path, source: doc.source }))).toEqual([
    { path: "plan.md", source: false },
    { path: "plan.md", source: true },
  ]);
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
    expect(downloadBaseLabel(pub)).toEqual({ title: sourceFirst ? "Plan source" : "The plan", path: "plan.md" });
    expect(downloadDocChoices(pub).map((doc) => doc.id)).toEqual([pub.files[1]?.id]);
  }
});

const withComments = (...comments: { author: "user" | "agent"; sent: boolean }[]): RevisionView => ({
  ...revision,
  threads: [
    {
      id: "33333333-3333-4333-8333-333333333333",
      target: { kind: "review" },
      state: "open",
      createdOn: 1,
      placement: { status: "placed", location: { kind: "review" } },
      comments: comments.map((comment, index) => ({
        id: `44444444-4444-4444-8444-${String(index).padStart(12, "0")}`,
        body: "Synthetic",
        sentOn: null,
        ...comment,
      })),
    },
  ],
});

test("comments are offered only for a sent reviewer comment or an agent reply", () => {
  expect(downloadHasComments(revision)).toBe(false);
  expect(downloadHasComments(withComments({ author: "user", sent: false }))).toBe(false);
  expect(downloadHasComments(withComments({ author: "user", sent: true }))).toBe(true);
  expect(downloadHasComments(withComments({ author: "user", sent: false }, { author: "agent", sent: false }))).toBe(
    true,
  );
});

test("the API limits table documents both shared download budgets", () => {
  const row = apiDocs.split("\n").find((line) => line.startsWith("| `downloadInlineBytes` |"));
  expect(row).toContain(`${LIMITS.downloadInlineBytes} bytes (128 MiB)`);
  expect(row).toContain("emitted built-in content per download");
  expect(row).toContain("the same read budget for stored assets and selected doc bodies");
  expect(row).toContain("both shared by all files of a ZIP");
});

test("HTML base detection follows the pub main and first-doc rules, including source views", () => {
  expect(downloadBaseIsHtml(revision)).toBe(false);
  const pub = { ...revision, writeupEmpty: true };
  expect(downloadBaseIsHtml(pub)).toBe(false);
  expect(downloadBaseIsHtml({ ...pub, main: "a.html" })).toBe(true);
  const [markdown, html] = revision.docs;
  if (!markdown || !html) throw new Error("Missing fixture docs");
  const htmlFirst = { ...pub, docs: [html, markdown] };
  expect(downloadBaseIsHtml(htmlFirst)).toBe(true);
  expect(downloadBaseIsHtml({ ...htmlFirst, main: "missing.html" })).toBe(true);
  expect(downloadBaseIsHtml({ ...htmlFirst, main: "z.md" })).toBe(false);
  expect(downloadBaseIsHtml({ ...htmlFirst, base: "a".repeat(40) })).toBe(false);
  expect(downloadBaseIsHtml({ ...pub, docs: [] })).toBe(false);
  const source: RevisionView["docs"][number] = { kind: "source", path: "a.html", language: "html", lines: [] };
  expect(downloadBaseIsHtml({ ...pub, main: "a.html", docs: [source, html] })).toBe(false);
  expect(downloadBaseIsHtml({ ...pub, main: "a.html", docs: [html, source] })).toBe(true);
});
