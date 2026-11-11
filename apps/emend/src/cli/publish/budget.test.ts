import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test, vi } from "vitest";
import { resolvePublish } from "./resolve.ts";

vi.mock("@emend/contract", async (original) => {
  const contract = await original<typeof import("@emend/contract")>();
  return {
    ...contract,
    LIMITS: {
      ...contract.LIMITS,
      revisionBytes: Buffer.byteLength(JSON.stringify({ overview: "", tldr: "", decisions: null, topics: {} })) + 10,
    },
  };
});
vi.mock("../git.ts", async (original) => ({
  ...(await original<typeof import("../git.ts")>()),
  createGitSession: () => async (cwd: string, call: string[]) =>
    Buffer.from(
      call[0] === "config"
        ? "https://example.test/synthetic.git"
        : call[1] === "--abbrev-ref"
          ? "main"
          : call[1] === "--git-common-dir"
            ? join(cwd, ".git")
            : cwd,
    ),
}));
vi.mock("./collect.ts", () => ({
  collectChanges: async () =>
    ["low", "high", "other", "same"].map((path) => ({
      path,
      oldPath: null,
      status: "added",
    })),
}));
vi.mock("./sides.ts", () => ({
  readSide: async (_root: string, _head: string, change: { path: string }, side: string) =>
    side === "old" ? null : { bytes: Buffer.from(change.path === "same" ? "highhigh" : change.path.repeat(2)) },
}));

test("topic importance allocates unique bytes before Other changes without retaining content", async () => {
  const dir = await mkdtemp(join(tmpdir(), "emend-budget-"));
  const root = join(dir, "repo");
  try {
    await mkdir(join(root, ".git"), { recursive: true });
    const result = await resolvePublish(
      {
        version: 1,
        title: "Synthetic",
        base: "a".repeat(40),
        head: "b".repeat(40),
        topics: [
          { slug: "low", title: "Low", importance: 90, summary: "" },
          { slug: "high", title: "High", importance: 1, summary: "" },
        ],
        files: [
          { path: "low", role: "diff", topic: "low" },
          { path: "high", role: "diff", topic: "high" },
          { path: "same", role: "diff", topic: "high" },
        ],
        writeup: { overview: "", tldr: "", decisions: null, topics: {} },
      },
      { manifest: "synthetic" },
      join(dir, "state"),
      join(dir, "config", "emend"),
      "instance",
      root,
      () => {},
    );
    expect(result.request.files.map((f) => [f.path, f.flag])).toEqual([
      ["high", null],
      ["same", null],
      ["low", "oversized"],
      ["other", "oversized"],
    ]);
    expect(result.blobs.size).toBe(1);
    const source = [...result.blobs.values()][0];
    expect(source).toMatchObject({ size: 8, read: expect.any(Function) });
    expect(Buffer.isBuffer(source)).toBe(false);
    expect((await source?.read())?.toString()).toBe("highhigh");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
test("docs alone over the revision budget have the fixed error", async () => {
  const dir = await mkdtemp(join(tmpdir(), "emend-doc-budget-"));
  const root = join(dir, "repo");
  try {
    await mkdir(join(root, ".git"), { recursive: true });
    await writeFile(join(root, "plan.md"), "elevenbytes");
    await expect(
      resolvePublish(
        {
          version: 1,
          title: "Synthetic",
          topics: [],
          files: [{ path: "plan.md", role: "doc" }],
          writeup: { overview: "", tldr: "", decisions: null, topics: {} },
        },
        { manifest: "synthetic", key: "plan" },
        join(dir, "state"),
        join(dir, "config", "emend"),
        "instance",
        root,
        () => {},
      ),
    ).rejects.toThrow("the docs pass the revision size limit");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
