import * as fs from "node:fs/promises";
import { chmod, mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test, vi } from "vitest";
import { run } from "../../main.ts";
import * as roots from "../publish/root.ts";
import { discover } from "../server-client.ts";
import { publishCommand } from "./publish.ts";

vi.mock("node:fs/promises", async (original) => ({
  ...(await original<typeof import("node:fs/promises")>()),
}));
vi.mock("../server-client.ts", () => ({
  discover: vi.fn(async () => {
    throw new Error("server discovery reached");
  }),
}));
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
vi.mock("../publish/collect.ts", () => ({ collectChanges: async () => [] }));

test("an unchanged listed diff or invalid source starts no server, even without instance state", async () => {
  const dir = await mkdtemp(join(tmpdir(), "emend-startup-"));
  const root = join(dir, "repo");
  const state = join(dir, "state");
  const manifest = join(root, "manifest.json");
  const io = { stdout: vi.fn(), stderr: vi.fn(), env: { EMEND_HOME: state } };
  const common = {
    version: 1,
    title: "Synthetic",
    topics: [],
    writeup: { overview: "", tldr: "", decisions: null, topics: {} },
  };
  try {
    await mkdir(join(root, ".git"), { recursive: true });
    vi.mocked(discover).mockClear();
    await writeFile(
      manifest,
      JSON.stringify({
        ...common,
        base: "a".repeat(40),
        head: "worktree",
        files: [{ path: "unchanged.ts", role: "diff" }],
      }),
    );
    await expect(
      publishCommand(state, join(dir, "config", "emend"), ["--manifest", manifest], io, root),
    ).rejects.toThrow("not changed in");
    await writeFile(manifest, JSON.stringify({ ...common, files: [{ path: "missing.md", role: "doc" }] }));
    await expect(
      publishCommand(state, join(dir, "config", "emend"), ["--manifest", manifest, "--key", "plan"], io, root),
    ).rejects.toThrow();
    expect(discover).not.toHaveBeenCalled();
    await writeFile(join(root, "plan.md"), "# Valid");
    await writeFile(manifest, JSON.stringify({ ...common, files: [{ path: "plan.md", role: "doc" }] }));
    await expect(
      publishCommand(state, join(dir, "config", "emend"), ["--manifest", manifest, "--key", "plan"], io, root),
    ).rejects.toThrow("server discovery reached");
    expect(discover).toHaveBeenCalledOnce();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test.each([".git/config", "alias/config"])("manifest read %s cannot expose Git metadata", async (path) => {
  const dir = await mkdtemp(join(tmpdir(), "emend-manifest-git-"));
  const root = join(dir, "repo");
  const state = join(dir, "state");
  try {
    await mkdir(join(root, ".git"), { recursive: true });
    await writeFile(join(root, ".git/config"), "synthetic metadata");
    await symlink(".git", join(root, "alias"));
    vi.mocked(discover).mockClear();
    await expect(
      publishCommand(
        state,
        join(dir, "config", "emend"),
        ["--manifest", join(root, path), "--key", "docs"],
        {
          stdout: vi.fn(),
          stderr: vi.fn(),
          env: { EMEND_HOME: state },
        },
        root,
      ),
    ).rejects.toThrow("refusing to read inside the git folder:");
    expect(discover).not.toHaveBeenCalled();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test.skipIf(!process.getuid).each<{
  location: "inside" | "outside" | "no repository" | "symlinked folder";
  mode: number;
  folderMode: number;
  foreign: boolean;
  refused: boolean;
  folderCheck?: "foreign owner" | "lstat failure" | "symlink";
}>([
  { location: "outside", mode: 0o664, folderMode: 0o700, foreign: false, refused: false },
  { location: "symlinked folder", mode: 0o664, folderMode: 0o700, foreign: false, refused: false },
  { location: "outside", mode: 0o664, folderMode: 0o770, foreign: false, refused: true },
  { location: "outside", mode: 0o646, folderMode: 0o700, foreign: false, refused: true },
  { location: "outside", mode: 0o600, folderMode: 0o700, foreign: true, refused: true },
  { location: "outside", mode: 0o600, folderMode: 0o755, foreign: false, refused: false },
  { location: "inside", mode: 0o622, folderMode: 0o755, foreign: false, refused: false },
  { location: "no repository", mode: 0o666, folderMode: 0o700, foreign: false, refused: true },
  { location: "outside", mode: 0o664, folderMode: 0o700, foreign: false, refused: true, folderCheck: "foreign owner" },
  { location: "outside", mode: 0o664, folderMode: 0o700, foreign: false, refused: true, folderCheck: "lstat failure" },
  { location: "outside", mode: 0o664, folderMode: 0o700, foreign: false, refused: true, folderCheck: "symlink" },
])(
  "manifest permissions: $location, mode $mode, folder mode $folderMode, foreign owner $foreign, check $folderCheck",
  async ({ location, mode, folderMode, foreign, refused, folderCheck }) => {
    const dir = await realpath(await mkdtemp(join(tmpdir(), "emend-manifest-permissions-")));
    const root = join(dir, "repo");
    const home = join(dir, "home");
    const state = join(dir, "state");
    const folder = location === "inside" ? root : join(dir, "review");
    const alias = join(dir, "alias");
    const manifest = join(location === "symlinked folder" ? alias : folder, "review.json");
    try {
      if (location !== "no repository") await mkdir(join(root, ".git"), { recursive: true });
      await mkdir(folder, { recursive: true });
      await chmod(folder, folderMode);
      if (location === "symlinked folder") await symlink(folder, alias);
      await mkdir(home);
      await writeFile(
        manifest,
        JSON.stringify({
          version: 1,
          title: "Synthetic permissions review",
          topics: [],
          files: [],
          writeup: { overview: "", tldr: "", decisions: null, topics: {} },
        }),
      );
      await chmod(manifest, mode);
      vi.spyOn(process, "cwd").mockReturnValue(location === "no repository" ? dir : root);
      // Keep the no-repository case independent of repositories above the temporary folder.
      if (location === "no repository") vi.spyOn(roots, "worktreeRoot").mockResolvedValueOnce(null);
      if (foreign) vi.spyOn(process, "getuid").mockReturnValue((process.getuid?.() ?? 0) + 1);
      if (folderCheck) {
        const folderLink = join(dir, "folder-link");
        if (folderCheck === "symlink") await symlink(folder, folderLink);
        const original = fs.lstat;
        vi.spyOn(fs, "lstat").mockImplementation((async (path, options) => {
          if (path !== folder) return original(path, options);
          if (folderCheck === "lstat failure") throw new Error("synthetic folder lstat failure");
          const info = await original(folderCheck === "symlink" ? folderLink : path);
          if (folderCheck === "symlink") {
            expect(info.isSymbolicLink()).toBe(true);
            // Isolate the directory check: the owner and permission bits must otherwise pass.
            info.mode = (info.mode & ~0o777) | 0o700;
          } else info.uid += 1;
          return info;
        }) as typeof fs.lstat);
      }
      vi.mocked(discover).mockClear();
      const stdout = vi.fn();
      const stderr = vi.fn();
      expect(
        await run(["publish", "--manifest", manifest], {
          env: { HOME: home, EMEND_HOME: state },
          stdout,
          stderr,
        }),
      ).toBe(1);
      expect(stdout).not.toHaveBeenCalled();
      expect(stderr.mock.calls).toEqual([
        [
          refused
            ? `emend: the manifest ${manifest} can be changed by other users; write it in a private folder\n`
            : "emend: pass --review or --key\n",
        ],
      ]);
      expect(discover).not.toHaveBeenCalled();
    } finally {
      vi.restoreAllMocks();
      await rm(dir, { recursive: true, force: true });
    }
  },
);
