import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test, vi } from "vitest";
import { run } from "../../main.ts";
import { publishDirect } from "../direct/index.ts";
import { CliApiError, errorLine } from "../http.ts";
import { resolvePublish } from "./resolve.ts";

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
vi.mock("./collect.ts", () => ({ collectChanges: async () => [{ path: "a.ts", oldPath: null, status: "added" }] }));
vi.mock("./sides.ts", () => ({
  readSide: async (_root: string, _head: string, _change: unknown, side: string) =>
    side === "old" ? null : { bytes: Buffer.from("new\n") },
}));

test("the CLI carries manifest notes into resolved and re-keyed publish requests", async () => {
  const dir = await mkdtemp(join(tmpdir(), "emend-notes-"));
  const root = join(dir, "repo");
  try {
    await mkdir(join(root, ".git"), { recursive: true });
    const notes = [{ side: "new" as const, start: 1, end: 1, summary: "A boundary.", ref: "A" }];
    const result = await resolvePublish(
      {
        version: 1,
        title: "Synthetic",
        base: "a".repeat(40),
        head: "worktree",
        topics: [],
        files: [{ path: "a.ts", role: "diff", notes }],
        writeup: { overview: "", tldr: "", decisions: null, topics: {} },
      },
      { manifest: "synthetic" },
      join(dir, "state"),
      join(dir, "config", "emend"),
      "instance",
      root,
      () => {},
    );
    expect(result.request.files[0]?.notes).toEqual(notes);
    expect(result.forInstance("another").files[0]?.notes).toEqual(notes);
    await expect(
      publishDirect(join(dir, "state"), {
        ...result,
        forInstance: (id) => ({
          ...result.forInstance(id),
          files: result.request.files.map((file) => ({
            ...file,
            notes: file.notes?.map((note) => ({ ...note, end: 2 })),
          })),
        }),
      }),
    ).rejects.toMatchObject({
      code: "invalid_request",
      serverMessage: expect.stringContaining("Agent note 0 in a.ts"),
    });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
test("publish diagnostics preserve note context without terminal control characters", () => {
  const line = errorLine(new CliApiError("invalid_request", "Agent note 0 in a.ts: invalid\n\u001b[31m"), "publish");
  expect(line).toContain("Agent note 0 in a.ts");
  expect(line.trim()).not.toContain("\n");
  expect(line).not.toContain("\u001b");
});

test("a refused note exits 1 with one stderr line and no stdout", async () => {
  const dir = await mkdtemp(join(tmpdir(), "emend-note-stderr-"));
  const root = join(dir, "repo");
  const cwd = vi.spyOn(process, "cwd").mockReturnValue(root);
  try {
    await mkdir(join(root, ".git"), { recursive: true });
    const manifest = join(root, "manifest.json");
    await writeFile(
      manifest,
      JSON.stringify({
        version: 1,
        title: "Synthetic",
        base: "a".repeat(40),
        head: "worktree",
        topics: [],
        files: [{ path: "a.ts", role: "diff", notes: [{ side: "new", start: 2, end: 2, summary: "Past the end." }] }],
        writeup: { overview: "", tldr: "", decisions: null, topics: {} },
      }),
    );
    const stdout = vi.fn(),
      stderr = vi.fn();
    expect(
      await run(["publish", "--manifest", manifest], {
        stdout,
        stderr,
        env: { EMEND_HOME: join(dir, "state") },
      }),
    ).toBe(1);
    expect(stdout).not.toHaveBeenCalled();
    expect(stderr.mock.calls).toEqual([
      ["emend: invalid_request: Agent note 0 in a.ts: the range must exist on a stored, unflagged file side.\n"],
    ]);
  } finally {
    cwd.mockRestore();
    await rm(dir, { recursive: true, force: true });
  }
});
