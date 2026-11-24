import { mkdir, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { PublishManifest } from "@recense/contract";
import { expect, test, vi } from "vitest";
import * as executors from "../../server/publish/executor.ts";
import { executeWork } from "../../server/publish/work.ts";
import { directFixture } from "../direct-test-support.ts";
import { publishContext, resolvePublish } from "./resolve.ts";
import { shortcutManifest } from "./shortcut.ts";

vi.mock("../../server/publish/executor.ts", async (original) => ({
  ...(await original<typeof import("../../server/publish/executor.ts")>()),
}));

async function fixture(mode: "shortcut" | "manifest", sources: Record<string, string>, paths = ["."]) {
  const f = await directFixture();
  for (const [path, text] of Object.entries(sources)) {
    await mkdir(join(f.source, path, ".."), { recursive: true });
    await writeFile(join(f.source, path), text);
  }
  const context = await publishContext(f.source, f.stateDir);
  const manifest: PublishManifest = {
    version: 1,
    title: "Synthetic",
    topics: [],
    files: Object.keys(sources)
      .filter((path) => /\.(md|html)$/.test(path))
      .map((path) => ({ path, role: "doc" })),
    writeup: { overview: "", tldr: "", decisions: null, topics: {} },
  };
  const shortcut =
    mode === "shortcut"
      ? await shortcutManifest({ paths, title: "Synthetic" }, f.stateDir, f.configDir, f.source, context)
      : undefined;
  const warnings: string[] = [];
  const publish = () =>
    resolvePublish(
      shortcut?.manifest ?? manifest,
      { ...shortcut, manifest: undefined, key: "synthetic" },
      f.stateDir,
      f.configDir,
      "instance",
      f.source,
      (line) => warnings.push(line),
      context,
    );
  return { ...f, publish, warnings };
}

test.each(["shortcut", "manifest"] as const)(
  "%s does not create a worker executor for Markdown docs without image syntax",
  async (mode) => {
    const f = await fixture(
      mode,
      {
        "plan.md": "# Plan\n\nPlain text and [a link](x.png).",
        "details.md": "<p>More text</p>\n\n[ref]: x.png",
      },
      ["plan.md", "details.md"],
    );
    const factory = vi.spyOn(executors, "workerExecutor");
    const result = await f.publish();
    expect(factory).not.toHaveBeenCalled();
    expect(result.request.files.map((file) => file.path).sort()).toEqual(["details.md", "plan.md"]);
    expect(result.request.files.every((file) => file.role === "doc" && !file.assets?.length)).toBe(true);
    expect(f.warnings).toEqual([]);
  },
);

test.each(["shortcut", "manifest"] as const)(
  "%s discovers and publishes inline, reference, uppercase HTML and legacy HTML images",
  async (mode) => {
    const docs = {
      "inline.md": "![a](x.png)",
      "reference.md": "![a][ref]\n\n[ref]: x.png",
      "html.md": '<IMG src="x.png">',
      "legacy-html.md": '<image src="x.png">',
    };
    const f = await fixture(mode, { ...docs, "x.png": "synthetic image" }, Object.keys(docs));
    const real = executors.workerExecutor();
    const close = vi.spyOn(real, "close");
    const execute = Object.assign(vi.fn(real), { close });
    const factory = vi.spyOn(executors, "workerExecutor").mockReturnValue(execute);
    const result = await f.publish();
    expect(factory).toHaveBeenCalledOnce();
    expect(execute).toHaveBeenCalledTimes(Object.keys(docs).length);
    for (const [path, text] of Object.entries(docs)) {
      expect(execute).toHaveBeenCalledWith({ kind: "doc-images", bytes: new TextEncoder().encode(text).buffer });
      expect(result.request.files.find((file) => file.path === path)?.assets).toEqual(["x.png"]);
    }
    const assets = result.request.files.filter((file) => file.role === "asset");
    expect(assets).toMatchObject([{ path: "x.png" }]);
    expect(await result.blobs.get(assets[0]?.newBlob ?? "")?.read()).toEqual(Buffer.from("synthetic image"));
    expect(close).toHaveBeenCalledOnce();
    expect(f.warnings).toEqual([]);
  },
);

test.each(["shortcut", "manifest"] as const)(
  "%s isolates a failing image discovery and continues with the next doc",
  async (mode) => {
    const f = await fixture(mode, {
      "bad.md": `${">".repeat(15000)} x\n\n![Bad](bad.png)`,
      "good.md": "![Good](good.png)",
      "bad.png": "synthetic bad image",
      "good.png": "synthetic good image",
    });
    const real = executors.workerExecutor();
    const close = vi.spyOn(real, "close");
    const execute = Object.assign(vi.fn(real), { close });
    const factory = vi.spyOn(executors, "workerExecutor").mockReturnValue(execute);
    const result = await f.publish();
    expect(result.request.files.find((file) => file.path === "bad.md")?.assets).toEqual([]);
    expect(result.request.files.find((file) => file.path === "good.md")?.assets).toEqual(["good.png"]);
    expect(result.request.files.filter((file) => file.role === "asset").map((file) => file.path)).toEqual(["good.png"]);
    expect(f.warnings).toEqual(["recense: bad.md: published without images: image discovery failed or timed out\n"]);
    expect(factory).toHaveBeenCalledOnce();
    expect(close).toHaveBeenCalledOnce();
  },
  15000,
);

test.each(["shortcut", "manifest"] as const)("%s publishes after image discovery times out", async (mode) => {
  const f = await fixture(mode, {
    "bad\ufe0f.md": "![Bad](bad.png)",
    "good.md": "![Good](good.png)",
    "bad.png": "synthetic bad image",
    "good.png": "synthetic good image",
  });
  const close = vi.fn(async () => {});
  const execute = Object.assign(
    vi.fn(async (work: Parameters<typeof executeWork>[0]) => {
      if (work.kind === "doc-images" && new TextDecoder().decode(work.bytes).includes("Bad"))
        throw new executors.WorkTimeout("untrusted error text");
      return executeWork(work);
    }),
    { close },
  );
  vi.spyOn(executors, "workerExecutor").mockReturnValue(execute);
  const result = await f.publish();
  expect(result.request.files.find((file) => file.path === "bad\ufe0f.md")?.assets).toEqual([]);
  expect(result.request.files.find((file) => file.path === "good.md")?.assets).toEqual(["good.png"]);
  expect(f.warnings).toEqual([
    "recense: bad\\u{fe0f}.md: published without images: image discovery failed or timed out\n",
  ]);
  expect(close).toHaveBeenCalledOnce();
});

test.each([
  ["shortcut", true],
  ["shortcut", false],
  ["manifest", true],
  ["manifest", false],
] as const)("%s keeps a shared secret-named asset for HTML only (HTML first: %s)", async (mode, htmlFirst) => {
  const docs = htmlFirst ? ["page.html", "plan.md"] : ["plan.md", "z-page.html"];
  const page = htmlFirst ? "page.html" : "z-page.html";
  const f = await fixture(
    mode,
    {
      ...Object.fromEntries(
        docs.map((path) => [path, path.endsWith(".html") ? '<img src="shot.png">' : "![](shot.png)"]),
      ),
      "api-key.png": "synthetic shared image",
    },
    docs,
  );
  await symlink("api-key.png", join(f.source, "shot.png"));
  const result = await f.publish();
  expect(result.request.files.find((file) => file.path === page)?.assets).toEqual(["shot.png"]);
  expect(result.request.files.find((file) => file.path === "plan.md")?.assets).toEqual([]);
  const assets = result.request.files.filter((file) => file.role === "asset");
  expect(assets).toMatchObject([{ path: "shot.png", parent: page }]);
  expect(await result.blobs.get(assets[0]?.newBlob ?? "")?.read()).toEqual(Buffer.from("synthetic shared image"));
  expect(f.warnings).toEqual(["recense: skipped shot.png: may hold a secret\n"]);
});

test.each(["shortcut", "manifest"] as const)("%s warns once when image discovery reaches its cap", async (mode) => {
  const f = await fixture(mode, {
    "plan\ufe0f.md": `![First](first.png) ![Large](${"é".repeat(180000)}.png) ![Later](later.png)`,
    "first.png": "synthetic first image",
    "later.png": "synthetic later image",
  });
  const result = await f.publish();
  expect(result.request.files.find((file) => file.path === "plan\ufe0f.md")?.assets).toEqual(["first.png"]);
  expect(result.request.files.filter((file) => file.role === "asset").map((file) => file.path)).toEqual(["first.png"]);
  expect(f.warnings).toEqual(["recense: plan\\u{fe0f}.md: some images left out: too many image references\n"]);
});

test.each(["shortcut", "manifest"] as const)(
  "%s refuses encoded separators but accepts a leading dot slash",
  async (mode) => {
    const f = await fixture(mode, {
      "plan.md": "![Bad](shots%2Fa.png) ![Good](./shots/b.png)",
      "shots/a.png": "synthetic rejected image",
      "shots/b.png": "synthetic accepted image",
    });
    const result = await f.publish();
    expect(result.request.files.filter((file) => file.role === "asset").map((file) => file.path)).toEqual([
      "shots/b.png",
    ]);
    expect(f.warnings).toEqual(["recense: skipped shots%2Fa.png: not a local visible path\n"]);
  },
);

test.each(["shortcut", "manifest"] as const)("%s skips secret-looking Markdown image names", async (mode) => {
  const f = await fixture(mode, { "plan.md": "![](shots/api-key.png)", "shots/api-key.png": "synthetic image" }, [
    "plan.md",
  ]);
  const result = await f.publish();
  expect(result.request.files.filter((file) => file.role === "asset")).toEqual([]);
  expect(f.warnings).toEqual(["recense: skipped shots/api-key.png: may hold a secret\n"]);
});

test.each(["shortcut", "manifest"] as const)(
  "%s skips an image alias whose target has a secret-looking filename",
  async (mode) => {
    const f = await fixture(mode, { "plan.md": "![](shot.png)", "shots/api-key.png": "synthetic image" });
    await symlink("shots/api-key.png", join(f.source, "shot.png"));
    const result = await f.publish();
    expect(result.request.files.filter((file) => file.role === "asset")).toEqual([]);
    expect(f.warnings).toEqual(["recense: skipped shot.png: may hold a secret\n"]);
  },
);
