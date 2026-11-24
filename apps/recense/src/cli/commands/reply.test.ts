import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { chmod, mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { promisify } from "node:util";
import { expect, onTestFinished, test, vi } from "vitest";
import { run } from "../../main.ts";
import { commandFixture } from "../test-support.ts";
import { readReplyBody } from "./reply.ts";

async function fixture() {
  const f = await commandFixture();
  const folder = await mkdtemp(join(tmpdir(), "recense-reply-"));
  onTestFinished(() => rm(folder, { recursive: true, force: true }));
  return { ...f, folder };
}

const commentId = randomUUID();
test.each(["file", "stdin"])("the %s byte reader accepts exactly 80000 bytes and refuses 80001", async (source) => {
  const f = await fixture();
  const path = join(f.folder, "boundary.txt");
  for (const size of [80000, 80001]) {
    const body = "x".repeat(size);
    await writeFile(path, body);
    f.io.stdin = Readable.from([Buffer.from(body)]);
    const result = readReplyBody(source === "file" ? path : "-", f.io, f.dir);
    if (size === 80000) await expect(result).resolves.toBe(body);
    else await expect(result).rejects.toThrow("at most 80000 bytes");
  }
});

test.each(["symlink", "fifo"])(
  "reply refuses a %s without following it or waiting for a writer",
  async (kind) => {
    const f = await fixture();
    const path = join(f.folder, "body.md");
    if (kind === "symlink") {
      await writeFile(join(f.folder, "target"), "Synthetic body");
      await symlink(join(f.folder, "target"), path);
    } else await promisify(execFile)("mkfifo", [path], { env: { PATH: process.env.PATH, LC_ALL: "C" } });
    expect(await run(["reply", commentId, "--status", "held", "--body-file", path], f.io)).toBe(1);
    expect(f.stdout).toEqual([]);
    expect(f.stderr).toHaveLength(1);
    expect(f.fetcher).not.toHaveBeenCalled();
  },
  1000,
);
test.each(["body", "file", "stdin"])("reply reads %s, validates and prints only ReplyCreated", async (source) => {
  const f = await fixture();
  const body = "Synthetic reply\nwith a second line.";
  const created = { commentId: randomUUID(), threadId: randomUUID(), state: "answered" };
  const file = join(f.folder, "reply.txt");
  await writeFile(file, body);
  f.io.stdin = Readable.from([Buffer.from(body)]);
  f.setResponse(async (url, init) => {
    expect(String(url)).toMatch(new RegExp(`/comments/${commentId}/reply$`));
    expect(JSON.parse(String(init?.body))).toEqual({ outcome: "explained", body });
    return Response.json(created, { status: 201 });
  });
  const args = source === "body" ? ["--body", body] : ["--body-file", source === "stdin" ? "-" : file];
  expect(await run(["reply", commentId, "--status", "explained", ...args], f.io)).toBe(0);
  expect(f.stdout).toEqual([`${JSON.stringify(created)}\n`]);
  expect(f.stderr).toEqual([]);
});

test("reply preserves UTF-8 text including a BOM and accepts the character limit", async () => {
  const f = await fixture();
  const body = `\ufeff${"界".repeat(19999)}`;
  const path = join(f.folder, "reply.txt");
  await writeFile(path, body);
  f.setResponse(async (_url, init) => {
    expect(JSON.parse(String(init?.body))).toEqual({ outcome: "held", body });
    return Response.json({ commentId: randomUUID(), threadId: randomUUID(), state: "answered" });
  });
  expect(await run(["reply", commentId, "--status", "held", "--body-file", path], f.io)).toBe(0);
});

test.each([
  [],
  ["bad", "--status", "fixed", "--body", "ok"],
  [commentId, "--body", "ok"],
  [commentId, "--status", "bogus", "--body", "ok"],
  [commentId, "--status", "fixed"],
  [commentId, "--status", "held", "--body", "x", "--body-file", "-"],
  [commentId, "--status", "held", "--body", "x", "--body", "y"],
  [commentId, "--status", "held", "--body", " "],
  [commentId, "--status", "held", "--body", "x".repeat(20001)],
  [commentId, "--status", "held", "--body", "\ud800"],
])("invalid reply arguments fail before any HTTP request", async (...args) => {
  const f = await fixture();
  expect(await run(["reply", ...args], f.io)).toBe(2);
  expect(f.stdout).toEqual([]);
  expect(f.stderr).toHaveLength(1);
  expect(f.fetcher).not.toHaveBeenCalled();
});

test.each(["huge-file", "huge-stdin", "directory", "missing"])(
  "reply refuses %s without logging content or sending a request",
  async (kind) => {
    const f = await fixture();
    let path = join(f.folder, "body.txt");
    if (kind === "huge-file") await writeFile(path, "s".repeat(80001));
    if (kind === "directory") path = f.folder;
    let reads = 0;
    f.io.stdin = Readable.from(
      (async function* () {
        for (let i = 0; i < 100; i++) {
          reads++;
          yield Buffer.alloc(80001, "s");
        }
      })(),
      { highWaterMark: 1 },
    );
    const code = await run(
      ["reply", commentId, "--status", "held", "--body-file", kind === "huge-stdin" ? "-" : path],
      f.io,
    );
    expect(code).toBe(1);
    expect(f.stdout).toEqual([]);
    expect(f.stderr).toHaveLength(1);
    expect(f.stderr.join("")).not.toContain("ssss");
    expect(f.fetcher).not.toHaveBeenCalled();
    expect(reads).toBeLessThanOrEqual(2);
  },
);

test.each([".md", ".MD", ".txt", ".TXT"])("reply accepts a private owned %s file", async (extension) => {
  const f = await fixture();
  const path = join(f.folder, `reply${extension}`);
  await writeFile(path, "Synthetic reply");
  await expect(readReplyBody(path, f.io, f.dir)).resolves.toBe("Synthetic reply");
});

test.each(["extension", "folder-mode", "folder-link", "file-owner", "directory"])(
  "reply refuses a body file with invalid %s before contact",
  async (kind) => {
    const f = await fixture();
    const folder = join(f.folder, "private");
    await mkdir(folder, { mode: 0o700 });
    let path = join(folder, kind === "extension" ? "synthetic.data" : "reply.md");
    if (kind === "directory") await mkdir(path);
    else await writeFile(path, "Synthetic body");
    if (kind === "folder-mode") await chmod(folder, 0o750);
    if (kind === "folder-link") {
      const alias = join(f.folder, "alias");
      await symlink(folder, alias);
      path = join(alias, "reply.md");
    }
    if (kind === "file-owner") {
      const uid = process.getuid?.() ?? 0;
      // Folder validation uses the real uid; the file ownership check sees a foreign owner.
      vi.spyOn(process, "getuid")
        .mockReturnValueOnce(uid)
        .mockReturnValue(uid + 1);
    }
    expect(await run(["reply", commentId, "--status", "held", "--body-file", path], f.io)).toBe(1);
    expect(f.stderr).toEqual([
      "recense: --body-file must be a .md or .txt file in a private folder you own (mode 0700).\n",
    ]);
    expect(f.stdout).toEqual([]);
    expect(f.fetcher).not.toHaveBeenCalled();
  },
);

test.each([false, true])("reply normalizes symlink/.. before reading (private file exists: %s)", async (exists) => {
  const f = await fixture();
  const publicFolder = join(f.folder, "public");
  const privateFolder = join(f.folder, "private");
  await mkdir(join(publicFolder, "child"), { recursive: true });
  await chmod(publicFolder, 0o777);
  await mkdir(privateFolder, { mode: 0o700 });
  await writeFile(join(publicFolder, "reply.md"), "Synthetic public reply that must never be sent");
  await symlink(join(publicFolder, "child"), join(privateFolder, "link"));
  const body = "Synthetic private reply";
  if (exists) await writeFile(join(privateFolder, "reply.md"), body);
  const created = { commentId, threadId: randomUUID(), state: "answered" };
  f.setResponse(async (_url, init) => {
    expect(JSON.parse(String(init?.body))).toEqual({ outcome: "explained", body });
    return Response.json(created, { status: 201 });
  });
  const path = `${privateFolder}/link/../reply.md`;
  expect(await run(["reply", commentId, "--status", "explained", "--body-file", path], f.io)).toBe(exists ? 0 : 1);
  if (exists) {
    expect(f.stdout).toEqual([`${JSON.stringify(created)}\n`]);
    expect(f.stderr).toEqual([]);
  } else {
    expect(f.stdout).toEqual([]);
    expect(f.stderr).toEqual([
      "recense: --body-file must be a .md or .txt file in a private folder you own (mode 0700).\n",
    ]);
    expect(f.fetcher).not.toHaveBeenCalled();
  }
});

test.each(["state", "child", "alias"])("reply refuses a body file in the %s state folder", async (kind) => {
  const f = await fixture();
  let folder = f.dir;
  if (kind !== "state") {
    folder = join(f.dir, "child");
    await mkdir(folder, { mode: 0o700 });
  }
  await writeFile(join(folder, "reply.md"), "Synthetic state content");
  if (kind === "alias") {
    await symlink(f.dir, join(f.folder, "state-parent"));
    folder = join(f.folder, "state-parent", "child");
  }
  expect(await run(["reply", commentId, "--status", "held", "--body-file", join(folder, "reply.md")], f.io)).toBe(1);
  expect(f.stdout).toEqual([]);
  expect(f.stderr).toEqual([
    "recense: --body-file must be a .md or .txt file in a private folder you own (mode 0700).\n",
  ]);
  expect(f.fetcher).not.toHaveBeenCalled();
});
