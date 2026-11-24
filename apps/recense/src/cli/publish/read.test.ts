import { chmod, lstat, mkdir, mkdtemp, open, realpath, rename, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test, vi } from "vitest";
import { escapeReference } from "../escape.ts";
import { readRegular } from "./read.ts";
import { hashWorktreeFile } from "./worktree.ts";

test.skipIf(!process.getuid)(
  "the async pre-read check uses fstat on the only opened handle, before reading any bytes",
  async () => {
    const dir = await mkdtemp(join(tmpdir(), "recense-read-check-"));
    try {
      const file = join(dir, "review.json");
      await writeFile(file, "synthetic manifest", { mode: 0o600 });
      const handle = await open(file, "r");
      const read = vi.spyOn(handle, "read");
      const close = vi.spyOn(handle, "close");
      const openFile = vi.fn(async () => {
        // The lstat preflight saw 0600; only fstat can see this change.
        await chmod(file, 0o620);
        return handle;
      });
      const fs = { lstat, open: openFile as typeof open, realpath, stat, platform: process.platform };
      await expect(
        readRegular(file, 100, undefined, fs, [], async (info) => {
          await Promise.resolve();
          expect(info.mode & 0o022).toBe(0o020);
          throw new Error("synthetic permission refusal");
        }),
      ).rejects.toThrow("synthetic permission refusal");
      expect(openFile).toHaveBeenCalledOnce();
      expect(read).not.toHaveBeenCalled();
      expect(close).toHaveBeenCalledOnce();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  },
);

test.each(["darwin", "linux"] as const)("%s refuses a parent swapped during the pre-read check", async (platform) => {
  const dir = await mkdtemp(join(tmpdir(), "recense-read-folder-swap-"));
  try {
    const folder = join(dir, "review");
    const privateFolder = join(dir, "private");
    await mkdir(folder, { mode: 0o770 });
    await chmod(folder, 0o770);
    await mkdir(privateFolder, { mode: 0o700 });
    const file = join(folder, "review.json");
    await writeFile(file, "original manifest");
    await chmod(file, 0o664);
    await writeFile(join(privateFolder, "review.json"), "replacement manifest");
    const handle = await open(file, "r");
    const read = vi.spyOn(handle, "read");
    const close = vi.spyOn(handle, "close");
    const fs = { lstat, open: (async () => handle) as typeof open, realpath, stat, platform };
    await expect(
      readRegular(file, 100, undefined, fs, [], async () => {
        await rename(folder, join(dir, "moved"));
        await symlink(privateFolder, folder);
      }),
    ).rejects.toThrow("file changed while reading");
    expect(read).not.toHaveBeenCalled();
    expect(close).toHaveBeenCalledOnce();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test.each(["darwin", "linux"] as const)("%s refuses a swapped parent restored before realpath", async (platform) => {
  const dir = await mkdtemp(join(tmpdir(), "recense-containment-"));
  try {
    const root = join(dir, "repo");
    await mkdir(root);
    const inside = join(root, "inside.txt");
    const outside = join(dir, "outside.txt");
    await writeFile(inside, "allowed");
    await writeFile(outside, "outside");
    const handle = await open(outside, "r");
    const read = vi.spyOn(handle, "read");
    const fs = {
      platform,
      lstat: (() => lstat(outside)) as unknown as typeof lstat,
      open: (() => Promise.resolve(handle)) as typeof open,
      realpath,
      stat,
    };
    await expect(readRegular(inside, 100, [root], fs)).rejects.toThrow("file changed while reading");
    expect(read).not.toHaveBeenCalled();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test.each([".git", ".GIT. ", "git~1", "GIT~1. ", ".g\u206ait"])(
  "regular reads refuse resolved metadata segment %j before opening",
  async (segment) => {
    const root = await mkdtemp(join(tmpdir(), "recense-read-metadata-"));
    try {
      const folder = join(root, "vendor/lib", segment);
      await mkdir(folder, { recursive: true });
      const file = join(folder, "config");
      await writeFile(file, "synthetic metadata");
      const openFile = vi.fn(open);
      const fs = { lstat, open: openFile, realpath, stat, platform: process.platform };
      await expect(readRegular(file, 100, [root], fs)).rejects.toThrow(
        `refusing to read inside the git folder: ${escapeReference(file)}`,
      );
      expect(openFile).not.toHaveBeenCalled();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  },
);

test.each(["regular read", "worktree hash"])("%s rechecks metadata segments after opening", async (operation) => {
  const root = await mkdtemp(join(tmpdir(), "recense-open-metadata-"));
  try {
    const file = join(root, "safe.md");
    const metadata = join(root, "vendor/lib/.git/config");
    await mkdir(join(root, "vendor/lib/.git"), { recursive: true });
    await writeFile(file, "synthetic doc");
    const info = await lstat(file);
    const handle = await open(file, "r");
    const read = vi.spyOn(handle, "read");
    const fs = {
      lstat,
      open: (async () => {
        await rename(file, metadata);
        await symlink(metadata, file);
        return handle;
      }) as typeof open,
      realpath,
      stat,
      platform: process.platform,
    };
    try {
      await expect(
        operation === "regular read"
          ? readRegular(file, 100, [root], fs)
          : hashWorktreeFile(root, "safe.md", info, "sha1", fs),
      ).rejects.toThrow(`refusing to read inside the git folder: ${metadata}`);
      expect(read).not.toHaveBeenCalled();
    } finally {
      await handle.close();
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
