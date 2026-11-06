import { expect, it } from "vitest";
import { PublishManifest, PublishRequest, RevisionView, Target } from "./index.ts";

const writeup = { overview: "", tldr: "", decisions: null, topics: {} };
const manifest = { version: 1, title: "Source", topics: [], writeup };
const file = { path: "a.md", role: "doc", oldPath: null, oldBlob: null, newBlob: "a".repeat(64), flag: null };
const request = {
  reviewKey: "b".repeat(64),
  repo: null,
  branch: null,
  base: null,
  head: null,
  title: "Source",
  topics: [],
  writeup,
};
it("keeps rendered and source views in separate namespaces", () => {
  const files = [file, { ...file, view: "source" }];
  expect(PublishManifest.parse({ ...manifest, files }).files[1]).toHaveProperty("view", "source");
  expect(PublishRequest.parse({ ...request, files }).files[1]).toHaveProperty("view", "source");
  expect(PublishRequest.safeParse({ ...request, files: [files[1], files[1]] }).success).toBe(false);
});
it("refuses invalid view roles, rendered text and source HTML assets", () => {
  for (const entry of [
    { path: "a.ts", role: "doc", view: "rendered" },
    { path: "a.md", role: "diff", view: "source" },
  ])
    expect(PublishManifest.safeParse({ ...manifest, files: [entry] }).success).toBe(false);
  expect(
    PublishRequest.safeParse({ ...request, files: [{ ...file, path: "a.html", view: "source", assets: [] }] }).success,
  ).toBe(false);
  expect(
    PublishRequest.safeParse({
      ...request,
      files: [
        { ...file, path: "a.png", view: "source" },
        { ...file, path: "a.png", role: "asset" },
      ],
    }).success,
  ).toBe(false);
});
it("validates source line ranges and strict token colors", () => {
  const target = {
    kind: "source-lines",
    path: "a.ts",
    start: 1,
    end: 1,
    lines: ["const a = 1"],
    before: [],
    after: [],
  };
  expect(Target.safeParse(target).success).toBe(true);
  expect(Target.safeParse({ ...target, end: 2 }).success).toBe(false);
  const doc = {
    path: "a.ts",
    kind: "source",
    language: "ts",
    lines: [[{ text: "const", light: "#aBc", dark: "#123456" }]],
  };
  expect(RevisionView.shape.docs.safeParse([doc]).success).toBe(true);
  expect(
    RevisionView.shape.docs.safeParse([{ ...doc, lines: [[{ text: "x", light: "red;display:none" }]] }]).success,
  ).toBe(false);
});
