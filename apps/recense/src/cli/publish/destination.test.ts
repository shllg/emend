import {
  AGENT_NOTE_QUOTES_FEATURE,
  DIFF_IMAGES_FEATURE,
  type PublishFile,
  type PublishRequest,
} from "@recense/contract";
import { expect, test } from "vitest";
import { CliError } from "../http.ts";
import { publishForDestination } from "./destination.ts";

test("legacy destinations receive text, docs and assets even when images share their hashes", () => {
  const only = "a".repeat(64);
  const asset = "b".repeat(64);
  const old = "c".repeat(64);
  const next = "d".repeat(64);
  const doc = "e".repeat(64);
  const file: PublishFile = {
    path: "art.png",
    role: "diff",
    status: "modified",
    flag: "binary",
    oldPath: null,
    oldBlob: null,
    newBlob: null,
    image: { old: { blob: only }, new: { blob: asset } },
  };
  const request: PublishRequest = {
    reviewKey: "a".repeat(64),
    repo: null,
    branch: null,
    title: "Synthetic",
    base: null,
    head: null,
    topics: [],
    writeup: { overview: "", tldr: "", decisions: null, topics: {} },
    files: [
      file,
      {
        ...file,
        path: "art.svg",
        flag: null,
        oldBlob: old,
        newBlob: next,
        image: { old: { blob: old }, new: { blob: next } },
      },
      { ...file, path: "copy.png", image: { old: { blob: doc }, new: { blob: only } } },
      { path: "plan.md", role: "doc", flag: null, oldPath: null, oldBlob: null, newBlob: doc },
      { path: "photo.png", role: "asset", flag: null, oldPath: null, oldBlob: null, newBlob: asset },
    ],
  };
  const blobs = new Map(
    [only, asset, old, next, doc].map((hash) => [hash, { size: 0, read: async () => Buffer.alloc(0) }]),
  );
  const legacy = publishForDestination(request, blobs, []);
  expect(legacy.request.files).toEqual(request.files.map(({ image: _image, ...rest }) => rest));
  expect([...legacy.blobs.keys()]).toEqual([asset, old, next, doc]);
  const current = publishForDestination(request, blobs, [DIFF_IMAGES_FEATURE]);
  expect(current.request.files[0]?.image).toEqual(file.image);
  expect(current.blobs.has(only)).toBe(true);
});

test("note quotes require destination support and retain the original request when supported", () => {
  const request: PublishRequest = {
    reviewKey: "a".repeat(64),
    repo: null,
    branch: null,
    title: "Synthetic",
    base: null,
    head: null,
    topics: [],
    writeup: { overview: "", tldr: "", decisions: null, topics: {} },
    files: [
      {
        path: "src/quoted\u202eline.ts",
        role: "diff",
        flag: null,
        oldPath: null,
        oldBlob: null,
        newBlob: "b".repeat(64),
        notes: [
          { side: "new", start: 1, end: 1, summary: "First" },
          { side: "new", quote: "next", start: 2, end: 2, summary: "Next" },
        ],
      },
    ],
  };
  const blobs = new Map();
  const legacy = () => publishForDestination(request, blobs, [DIFF_IMAGES_FEATURE]);
  expect(legacy).toThrow(CliError);
  expect(legacy).toThrow(
    "Agent note 1 in src/quoted\\u{202e}line.ts: the recense server needs an update to place note quotes.",
  );
  const supported = publishForDestination(request, blobs, [AGENT_NOTE_QUOTES_FEATURE]);
  expect(supported.request).toBe(request);
  expect(supported.blobs).toBe(blobs);
});
