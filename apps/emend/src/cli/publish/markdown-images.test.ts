import { mkdir, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { PublishManifest } from "@emend/contract";
import { expect, test, vi } from "vitest";
import * as executors from "../../server/publish/executor.ts";
import { executeWork } from "../../server/publish/work.ts";
import { directFixture } from "../direct-test-support.ts";
import { publishContext, resolvePublish } from "./resolve.ts";
import { shortcutManifest } from "./shortcut.ts";

vi.mock("../../server/publish/executor.ts", async (original) => ({
  ...(await original<typeof import("../../server/publish/executor.ts")>()),
}));

async function fixture(mode: "shortcut" | "manifest", sources: Record<string, string>) {
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
      .filter((path) => path.endsWith(".md"))
      .map((path) => ({ path, role: "doc" })),
    writeup: { overview: "", tldr: "", decisions: null, topics: {} },
  };
  const shortcut =
    mode === "shortcut"
      ? await shortcutManifest({ paths: ["."], title: "Synthetic" }, f.stateDir, f.configDir, f.source, context)
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
    expect(f.warnings).toEqual(["emend: skipped bad.md: Markdown image discovery failed or timed out\n"]);
    expect(factory).toHaveBeenCalledOnce();
    expect(close).toHaveBeenCalledOnce();
  },
  15000,
);

test.each(["shortcut", "manifest"] as const)("%s treats image discovery timeouts as a per-doc skip", async (mode) => {
  const f = await fixture(mode, {
    "bad.md": "![Bad](bad.png)",
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
  expect(result.request.files.find((file) => file.path === "bad.md")?.assets).toEqual([]);
  expect(result.request.files.find((file) => file.path === "good.md")?.assets).toEqual(["good.png"]);
  expect(f.warnings).toEqual(["emend: skipped bad.md: Markdown image discovery failed or timed out\n"]);
  expect(close).toHaveBeenCalledOnce();
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
    expect(f.warnings).toEqual(["emend: skipped shots%2Fa.png: not a local visible path\n"]);
  },
);

test.each(["shortcut", "manifest"] as const)("%s skips secret-looking Markdown image names", async (mode) => {
  const f = await fixture(mode, { "plan.md": "![](shots/api-key.png)", "shots/api-key.png": "synthetic image" });
  const result = await f.publish();
  expect(result.request.files.filter((file) => file.role === "asset")).toEqual([]);
  expect(f.warnings).toEqual(["emend: skipped shots/api-key.png: may hold a secret\n"]);
});

test.each(["shortcut", "manifest"] as const)(
  "%s skips an image alias whose target has a secret-looking filename",
  async (mode) => {
    const f = await fixture(mode, { "plan.md": "![](shot.png)", "shots/api-key.png": "synthetic image" });
    await symlink("shots/api-key.png", join(f.source, "shot.png"));
    const result = await f.publish();
    expect(result.request.files.filter((file) => file.role === "asset")).toEqual([]);
    expect(f.warnings).toEqual(["emend: skipped shot.png: may hold a secret\n"]);
  },
);
