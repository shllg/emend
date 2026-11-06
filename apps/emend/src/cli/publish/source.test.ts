import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { PublishResponse, RevisionView } from "@emend/contract";
import { expect, it, vi } from "vitest";
import { run } from "../../main.ts";
import { directFixture } from "../direct-test-support.ts";
import { publishContext, resolvePublish } from "./resolve.ts";
import { shortcutManifest } from "./shortcut.ts";

it.each([
  ["config.yaml", [], "source"],
  ["notes.md", [], "markdown"],
  ["notes.md", ["--source"], "source"],
] as const)("shortcut %s %j chooses %s", async (path, flags, kind) => {
  const f = await directFixture();
  await writeFile(join(f.source, path), "# Raw *text*\n");
  vi.spyOn(process, "cwd").mockReturnValue(f.source);
  const out = f.output();
  expect(await run(["publish", path, ...flags, "--json"], out.io), out.stderr.join("")).toBe(0);
  const result = PublishResponse.parse(JSON.parse(out.stdout.join("")));
  const reviewer = await f.reviewer();
  const view = RevisionView.parse(await (await reviewer.request(`/reviews/${result.reviewId}/revisions/1`)).json());
  expect(view.docs[0]?.kind).toBe(kind);
  if (kind === "source") expect(view.docs[0]?.title).toBe(path);
});
it.each([new Uint8Array([255]), new Uint8Array([97, 0])])("explicit binary is one refusal line", async (bytes) => {
  const f = await directFixture();
  await writeFile(join(f.source, "binary.txt"), bytes);
  vi.spyOn(process, "cwd").mockReturnValue(f.source);
  const out = f.output();
  expect(await run(["publish", "binary.txt"], out.io)).toBe(1);
  expect(out.stdout).toEqual([]);
  expect(out.stderr).toEqual(["emend: not a text file: binary.txt\n"]);
});
it("walks text and skips known binary and NUL files with one warning each", async () => {
  const f = await directFixture();
  await rm(f.manifest);
  await mkdir(join(f.source, "bundle"));
  for (const [path, text] of [
    ["config.yaml", "value: true"],
    ["readme.txt", "text"],
    ["image.png", "synthetic"],
    ["nul.txt", "x\0y"],
  ])
    await writeFile(join(f.source, "bundle", path as string), text as string);
  vi.spyOn(process, "cwd").mockReturnValue(f.source);
  const out = f.output();
  expect(await run(["publish", "bundle", "--json"], out.io), out.stderr.join("")).toBe(0);
  const result = PublishResponse.parse(JSON.parse(out.stdout.join("")));
  const reviewer = await f.reviewer();
  const view = RevisionView.parse(await (await reviewer.request(`/reviews/${result.reviewId}/revisions/1`)).json());
  expect(view.docs.map((doc) => [doc.path, doc.kind])).toEqual([
    ["config.yaml", "source"],
    ["readme.txt", "source"],
  ]);
  expect(out.stderr.filter((line) => line.includes("image.png"))).toHaveLength(1);
  expect(out.stderr.filter((line) => line.includes("nul.txt"))).toHaveLength(1);
});

it("source aliases match exact extensions, case-insensitively, including extensionless files", async () => {
  const f = await directFixture();
  for (const path of ["other.TS", "other.tsx", "LICENSE", "LICENSE.txt"]) await writeFile(join(f.source, path), "text");
  const manifest = {
    version: 1 as const,
    title: "Aliases",
    topics: [],
    writeup: { overview: "", tldr: "", decisions: null, topics: {} },
  };
  const resolve = (path: string, source: string) =>
    resolvePublish(
      { ...manifest, files: [{ path, source, role: "doc" }] },
      { key: "aliases" },
      f.stateDir,
      null,
      f.source,
      () => {},
    );
  expect((await resolve("code.ts", "other.TS")).request.files[0]?.view).toBe("source");
  expect((await resolve("README", "LICENSE")).request.files[0]?.view).toBe("source");
  await expect(resolve("code.ts", "other.tsx")).rejects.toThrow("same extension");
  await expect(resolve("README", "LICENSE.txt")).rejects.toThrow("same extension");
});

it("a walked CSS or JS asset is also a source doc; source HTML pulls no assets", async () => {
  const f = await directFixture();
  await mkdir(join(f.source, "bundle"));
  await writeFile(
    join(f.source, "bundle/index.html"),
    '<link rel="stylesheet" href="style.css"><script src="script.js"></script>',
  );
  await writeFile(join(f.source, "bundle/style.css"), "body { color: red; }");
  await writeFile(join(f.source, "bundle/script.js"), "const n = 1;");
  const context = await publishContext(f.source, f.stateDir);
  for (const source of [false, true]) {
    const shortcut = await shortcutManifest({ paths: ["bundle"], source }, f.stateDir, f.source, context);
    const resolved = await resolvePublish(
      shortcut.manifest,
      { key: "assets", docFolders: shortcut.docFolders },
      f.stateDir,
      null,
      f.source,
      () => {},
      context,
    );
    expect(resolved.request.files.filter((file) => file.role === "doc").map((file) => [file.path, file.view])).toEqual([
      ["index.html", source ? "source" : undefined],
      ["script.js", "source"],
      ["style.css", "source"],
    ]);
    expect(
      resolved.request.files
        .filter((file) => file.role === "asset")
        .map((file) => file.path)
        .sort(),
    ).toEqual(source ? [] : ["script.js", "style.css"]);
  }
});

it.each([
  ["--manifest", "review.json", "--source"],
  ["--source", "--manifest", "review.json"],
])("refuses source with a manifest before reading it: %j", async (...args) => {
  const fixture = await directFixture();
  const { stdout, stderr, io } = fixture.output();
  expect(await run(["publish", ...args], io)).toBe(1);
  expect(stdout).toEqual([]);
  expect(stderr).toHaveLength(1);
  expect(stderr[0]).toMatch(/^emend: usage: emend publish .*\n$/);
  expect(stderr[0]?.split("or emend publish --manifest")[1]).not.toContain("--source");
});

it("manifest non-text refusals name the escaped source, or the path when source is absent", async () => {
  const f = await directFixture();
  const source = "input\u202e.txt";
  await writeFile(join(f.source, source), Buffer.from([0]));
  const manifest = {
    version: 1 as const,
    title: "Synthetic source",
    topics: [],
    writeup: { overview: "", tldr: "", decisions: null, topics: {} },
  };
  for (const file of [
    { path: "alias.txt", source, role: "doc" as const },
    { path: source, role: "doc" as const },
  ]) {
    await expect(
      resolvePublish({ ...manifest, files: [file] }, { key: "source" }, f.stateDir, null, f.source, () => {}),
    ).rejects.toThrow("not a text file: input\\u{202e}.txt");
  }
});
