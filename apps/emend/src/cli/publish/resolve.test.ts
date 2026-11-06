import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import * as fs from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { LIMITS, PublishManifest } from "@emend/contract";
import { expect, test, vi } from "vitest";
import { resolvePublish } from "./resolve.ts";

const { mkdir, mkdtemp, rm, symlink, truncate, writeFile } = fs;

// Expose configurable exports so the realpath spy can replace the built-in function.
vi.mock("node:fs/promises", async (original) => ({ ...(await original<typeof import("node:fs/promises")>()) }));

vi.mock("../git.ts", async (original) => ({
  ...(await original<typeof import("../git.ts")>()),
  createGitSession: () => async (cwd: string, call: string[]) =>
    Buffer.from(`${call[1] === "--git-common-dir" ? join(cwd, ".git") : cwd}\n`),
}));

const manifest = (source?: string): PublishManifest => ({
  version: 1,
  title: "Synthetic",
  topics: [],
  files: [{ path: "plan.md", role: "doc", title: "Named doc", ...(source ? { source } : {}) }],
  writeup: { overview: "", tldr: "", decisions: null, topics: {} },
});
test("doc sources resolve only inside the worktree or configured real doc roots", async () => {
  const dir = await fs.realpath(await mkdtemp(join(tmpdir(), "emend-docs-")));
  try {
    const root = join(dir, "repo");
    const state = join(dir, "state");
    const docs = join(dir, "docs");
    for (const folder of [root, state, docs]) await mkdir(folder);
    await mkdir(join(root, ".git"));
    await writeFile(join(root, "plan.md"), "local doc");
    await writeFile(join(docs, "plan.md"), "external doc");
    const collect = (source?: string) =>
      resolvePublish(manifest(source), { manifest: "synthetic", key: "plan" }, state, "instance", root, () => {});
    expect((await collect()).request.files[0]?.title).toBe("Named doc");
    expect((await [...(await collect()).blobs.values()][0]?.read())?.toString()).toBe("local doc");
    await writeFile(join(state, "config.json"), JSON.stringify({ openBrowser: true }));
    expect((await [...(await collect()).blobs.values()][0]?.read())?.toString()).toBe("local doc");
    await expect(collect(join(docs, "plan.md"))).rejects.toThrow("outside the allowed doc roots");
    await symlink(join(docs, "plan.md"), join(root, "escape.md"));
    await expect(collect("escape.md")).rejects.toThrow("outside the allowed doc roots");
    await writeFile(join(root, "config.json"), JSON.stringify({ docRoots: [docs] }));
    await expect(collect("escape.md")).rejects.toThrow("outside the allowed doc roots");
    await writeFile(join(state, "config.json"), JSON.stringify({ docRoots: [docs] }));
    expect((await [...(await collect("escape.md")).blobs.values()][0]?.read())?.toString()).toBe("external doc");
    await writeFile(join(state, "config.json"), JSON.stringify({ docRoots: [docs], openBrowser: true }));
    expect((await [...(await collect("escape.md")).blobs.values()][0]?.read())?.toString()).toBe("external doc");
    await writeFile(join(state, "config.json"), JSON.stringify({ docRoots: [docs], openBrowser: "true" }));
    await expect(collect("escape.md")).rejects.toThrow("invalid emend configuration");
    await writeFile(join(state, "config.json"), JSON.stringify({ docRoots: [docs] }));
    await truncate(join(docs, "plan.md"), LIMITS.markdownDocBytes + 1);
    await expect(collect("escape.md")).rejects.toThrow("size limit");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
test("HTML and each asset and their cumulative bytes have pre-read limits", async () => {
  const dir = await mkdtemp(join(tmpdir(), "emend-limits-"));
  const root = join(dir, "repo");
  try {
    await mkdir(join(root, ".git"), { recursive: true });
    const input = { ...manifest(), files: [{ path: "plan.html", role: "doc" as const }] };
    const collect = () =>
      resolvePublish(input, { manifest: "synthetic", key: "plan" }, join(dir, "state"), "instance", root, () => {});
    await writeFile(join(root, "plan.html"), '<img src="a.png">');
    await writeFile(join(root, "a.png"), "");
    await truncate(join(root, "a.png"), LIMITS.assetBytes);
    const single = await collect();
    const asset = single.request.files.find((file) => file.role === "asset");
    expect(single.blobs.get(asset?.newBlob ?? "")?.size).toBe(LIMITS.assetBytes);
    await truncate(join(root, "a.png"), LIMITS.assetBytes + 1);
    await expect(collect()).rejects.toThrow("asset exceeds");
    await truncate(join(root, "a.png"), LIMITS.assetBytes);
    const html = '<img src="a.png"><img src="b.png">';
    await writeFile(join(root, "plan.html"), html);
    await writeFile(join(root, "b.png"), "");
    const remaining = LIMITS.htmlDocWithAssetsBytes - Buffer.byteLength(html) - LIMITS.assetBytes;
    await truncate(join(root, "b.png"), remaining);
    const combined = await collect();
    expect([...combined.blobs.values()].reduce((sum, blob) => sum + blob.size, 0)).toBe(LIMITS.htmlDocWithAssetsBytes);
    await truncate(join(root, "b.png"), remaining + 1);
    await expect(collect()).rejects.toThrow("HTML doc and assets exceed");
    await truncate(join(root, "plan.html"), LIMITS.htmlDocBytes + 1);
    await expect(collect()).rejects.toThrow("size limit");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("HTML docs sharing an asset publish it once under its first parent", async () => {
  const dir = await mkdtemp(join(tmpdir(), "emend-shared-assets-"));
  const root = join(dir, "repo");
  try {
    await mkdir(join(root, ".git"), { recursive: true });
    for (const path of ["one.html", "two.html"])
      await writeFile(join(root, path), '<link href="style.css" rel="stylesheet">');
    await writeFile(join(root, "style.css"), "body { color: black }");
    const result = await resolvePublish(
      {
        ...manifest(),
        files: [
          { path: "one.html", role: "doc" },
          { path: "two.html", role: "doc" },
        ],
      },
      { manifest: "synthetic", key: "plan" },
      join(dir, "state"),
      "instance",
      root,
      () => {},
    );
    expect(result.request.files.filter((f) => f.role === "asset")).toMatchObject([
      { path: "style.css", parent: "one.html" },
    ]);
    expect(result.request.files.filter((f) => f.role === "doc").map((f) => f.assets)).toEqual([
      ["style.css"],
      ["style.css"],
    ]);
    expect(result.blobs.size).toBe(2);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test.each(["data", "first.html"])(
  "HTML doc and assets share the checked first resolution when an alias swaps from %s",
  async (name) => {
    const dir = await mkdtemp(join(tmpdir(), "emend-doc-asset-swap-"));
    const root = join(dir, "repo");
    const realpath = fs.realpath;
    const probe = vi.spyOn(fs, "realpath");
    try {
      await mkdir(join(root, ".git"), { recursive: true });
      await mkdir(join(root, ".private"));
      await writeFile(join(root, ".private", name), '<script src="first.js"></script>');
      await writeFile(join(root, ".private", "first.js"), "Synthetic first doc asset");
      const wrongContent = "Synthetic content from the wrong folder";
      await writeFile(join(root, ".private", "secret.js"), wrongContent);
      await writeFile(join(root, "real.html"), '<script src="secret.js"></script>');
      await writeFile(join(root, "secret.js"), "Synthetic second doc asset");
      const alias = join(root, "notes.html");
      await symlink(`.private/${name}`, alias);
      let resolutions = 0;
      probe.mockImplementation(async (path, ...args) => {
        const actual = await realpath(path, ...args);
        if (String(path) === alias) {
          await rm(alias);
          await symlink(++resolutions % 2 ? "real.html" : `.private/${name}`, alias);
        }
        return actual;
      });
      const publishing = resolvePublish(
        { ...manifest(), files: [{ path: "notes.html", role: "doc" }] },
        { manifest: "synthetic", key: "docs" },
        join(dir, "state"),
        "instance",
        root,
        () => {},
      );
      if (name === "data") {
        await expect(publishing).rejects.toThrow(
          "doc source must end in .md, .markdown, .html or .htm, like its path.",
        );
      } else {
        const result = await publishing;
        expect(result.blobs.has(createHash("sha256").update(wrongContent).digest("hex"))).toBe(false);
        expect(result.request.files.map((file) => file.path)).toEqual(["notes.html", "first.js"]);
        const asset = result.request.files.find((file) => file.role === "asset");
        expect((await result.blobs.get(asset?.newBlob ?? "")?.read())?.toString()).toBe("Synthetic first doc asset");
      }
      expect(resolutions).toBe(1);
    } finally {
      probe.mockRestore();
      await rm(dir, { recursive: true, force: true });
    }
  },
);

test.each([".git/config", ".GIT./config", ".g\u206ait/config", "link/config", "leaf.md"])(
  "doc source %j cannot expose Git metadata",
  async (source) => {
    const dir = await mkdtemp(join(tmpdir(), "emend-doc-git-"));
    const root = join(dir, "repo");
    try {
      await mkdir(join(root, ".git"), { recursive: true });
      await writeFile(join(root, ".git/config"), "synthetic metadata");
      await symlink(".git", join(root, "link"));
      await symlink(".git/config", join(root, "leaf.md"));
      await expect(
        resolvePublish(
          manifest(source),
          { manifest: "synthetic", key: "docs" },
          join(dir, "state"),
          "instance",
          root,
          () => {},
        ),
      ).rejects.toThrow("refusing to read inside the git folder:");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  },
);

test("doc upload rereads recheck aliases for Git metadata", async () => {
  const dir = await mkdtemp(join(tmpdir(), "emend-doc-reread-"));
  const root = join(dir, "repo");
  try {
    await mkdir(join(root, ".git"), { recursive: true });
    await writeFile(join(root, ".git/config"), "synthetic metadata");
    await writeFile(join(root, "safe.md"), "synthetic doc");
    await symlink("safe.md", join(root, "alias.md"));
    const resolved = await resolvePublish(
      manifest("alias.md"),
      { manifest: "synthetic", key: "docs" },
      join(dir, "state"),
      "instance",
      root,
      () => {},
    );
    await rm(join(root, "alias.md"));
    await symlink(".git/config", join(root, "alias.md"));
    await expect([...resolved.blobs.values()][0]?.read()).rejects.toThrow("refusing to read inside the git folder:");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test.each(["nested worktree repo", "docRoot repo"])(
  "doc aliases cannot publish metadata from a %s, including upload rereads",
  async (location) => {
    const dir = await fs.realpath(await mkdtemp(join(tmpdir(), "emend-doc-nested-git-")));
    try {
      const root = join(dir, "repo");
      const state = join(dir, "state");
      const nested = location === "docRoot repo" ? join(dir, "external") : join(root, "vendor/lib");
      await mkdir(join(root, "docs"), { recursive: true });
      await mkdir(state);
      await mkdir(join(root, ".git"));
      await promisify(execFile)("git", ["init", nested], {
        env: {
          PATH: process.env.PATH,
          HOME: root,
          LC_ALL: "C",
          GIT_CONFIG_GLOBAL: "/dev/null",
          GIT_CONFIG_NOSYSTEM: "1",
        },
      });
      await writeFile(join(state, "config.json"), JSON.stringify({ docRoots: [nested] }));
      await writeFile(join(root, "docs/safe.md"), "synthetic doc");
      const alias = join(root, "docs/n.md");
      await symlink("safe.md", alias);
      const collect = () =>
        resolvePublish(
          manifest("docs/n.md"),
          { manifest: "synthetic", key: "docs" },
          state,
          "instance",
          root,
          () => {},
        );
      const resolved = await collect();
      await rm(alias);
      await symlink(location === "docRoot repo" ? join(nested, ".git/config") : "../vendor/lib/.git/config", alias);
      await expect(collect()).rejects.toThrow(`refusing to read inside the git folder: ${nested}/.git/config`);
      await expect([...resolved.blobs.values()][0]?.read()).rejects.toThrow(
        `refusing to read inside the git folder: ${nested}/.git/config`,
      );
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  },
);

test("HTML asset reads and upload rereads refuse a leaf alias into the Git folder", async () => {
  const dir = await mkdtemp(join(tmpdir(), "emend-asset-git-"));
  const root = join(dir, "repo");
  try {
    await mkdir(join(root, ".git"), { recursive: true });
    await writeFile(join(root, ".git/config"), "synthetic metadata");
    await writeFile(join(root, "safe.png"), "synthetic image");
    await symlink("safe.png", join(root, "asset.png"));
    await writeFile(join(root, "plan.html"), '<img src="asset.png">');
    const collect = () =>
      resolvePublish(
        { ...manifest(), files: [{ path: "plan.html", role: "doc" }] },
        { manifest: "synthetic", key: "docs" },
        join(dir, "state"),
        "instance",
        root,
        () => {},
      );
    const result = await collect();
    const hash = result.request.files.find((file) => file.role === "asset")?.newBlob;
    await rm(join(root, "asset.png"));
    await symlink(".git/config", join(root, "asset.png"));
    await expect(result.blobs.get(hash ?? "")?.read()).rejects.toThrow("refusing to read inside the git folder:");
    await expect(collect()).rejects.toThrow("refusing to read inside the git folder:");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("links and a valid manifest repoUrl reach the request; no remote derives none", async () => {
  const dir = await fs.realpath(await mkdtemp(join(tmpdir(), "emend-links-")));
  try {
    const root = join(dir, "repo");
    const state = join(dir, "state");
    for (const folder of [root, state]) await mkdir(folder);
    await mkdir(join(root, ".git"));
    await writeFile(join(root, "plan.md"), "local doc");
    const link = { url: "https://example.test/o/r/pull/7", label: "PR 7", kind: "pr" as const };
    const resolve = (extra: Partial<PublishManifest>) =>
      resolvePublish(
        { ...manifest(), ...extra },
        { manifest: "synthetic", key: "plan" },
        state,
        "instance",
        root,
        () => {},
      );
    const plain = await resolve({});
    expect(plain.request.links).toBeUndefined();
    expect(plain.request.repoUrl).toBeUndefined();
    const given = await resolve({ links: [link], repoUrl: "https://github.com/o/r" });
    expect(given.request.links).toEqual([link]);
    expect(given.request.repoUrl).toBe("https://github.com/o/r");
    expect(given.forInstance("other").repoUrl).toBe("https://github.com/o/r");
    // null opts out, and an invalid string is dropped; neither sends a repoUrl here (no remote to derive).
    expect((await resolve({ repoUrl: null })).request.repoUrl).toBeUndefined();
    const parsed = PublishManifest.parse({ ...manifest(), repoUrl: "http://github.com/o/r" });
    expect((await resolve(parsed)).request.repoUrl).toBeUndefined();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
