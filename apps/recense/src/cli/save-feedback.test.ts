import { randomUUID } from "node:crypto";
import * as fs from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LEASE_SECONDS, type WaitResult } from "@recense/contract";
import { expect, onTestFinished, test, vi } from "vitest";
import { run } from "../main.ts";
import { createToken } from "../server/auth/tokens.ts";
import { mailboxFixture } from "../server/mailbox/test-support.ts";
import { writeSecretFile } from "../state/files.ts";
import { confirmWarning } from "./commands/wait.ts";
import { commandFixture } from "./test-support.ts";

vi.mock("node:fs/promises", async (original) => ({ ...(await original<typeof import("node:fs/promises")>()) }));

const reviewId = randomUUID();
const approve: WaitResult = { kind: "approve", reviewId, deliveryId: randomUUID(), revision: 1 };
const go: WaitResult = {
  kind: "go",
  reviewId,
  deliveryId: randomUUID(),
  revision: 1,
  sentOn: 1,
  mode: "fix-clear",
  modeLabel: "Fix what's clear, ask about the rest",
  instructions: ["Explain the synthetic change."],
  comments: [],
  approvalSetAside: false,
};
const pending: WaitResult = { kind: "pending", reviewId, waitedSeconds: 0 };

async function fixture() {
  const f = await commandFixture();
  const folder = await fs.mkdtemp(join(tmpdir(), "recense-results-"));
  onTestFinished(() => fs.rm(folder, { recursive: true, force: true }));
  let confirms = 0;
  let now = 0;
  vi.spyOn(performance, "now").mockImplementation(() => now);
  f.setResponse(async (url) => {
    if (String(url).endsWith("/take")) return Response.json(approve);
    confirms++;
    return new Response(null, { status: 204 });
  });
  return {
    ...f,
    folder,
    confirms: () => confirms,
    advance: () => {
      now += 1000;
    },
  };
}

test.each(["wait", "feedback"])("%s saves go, approve and pending before stdout, then confirms", async (command) => {
  for (const result of [go, approve, pending]) {
    const f = await fixture();
    let printed = false;
    let confirmed = false;
    f.setResponse(async (url) => {
      if (String(url).endsWith("/take")) {
        f.advance();
        return Response.json(result);
      }
      expect(printed).toBe(true);
      confirmed = true;
      return new Response(null, { status: 204 });
    });
    f.io.stdoutAsync = async (line) => {
      const names = await fs.readdir(f.folder);
      expect(names).toHaveLength(1);
      const name = names[0] ?? "";
      expect(name).toMatch(/^wait-\d{8}T\d{9}Z\.json$/);
      expect(await fs.readFile(join(f.folder, name), "utf8")).toBe(line);
      expect((await fs.stat(join(f.folder, name))).mode & 0o777).toBe(0o600);
      expect(confirmed).toBe(false);
      f.stdout.push(line);
      printed = true;
    };
    const options = command === "wait" ? ["--timeout", "1"] : [];
    expect(await run([command, reviewId, ...options, "--save", f.folder], f.io)).toBe(0);
    const hint = `recense: answer each comment with recense reply <comment> --status <outcome> --body <text>, then publish changes with recense publish <path>... --review ${reviewId}\n`;
    expect(f.stderr).toEqual(command === "feedback" && result.kind === "go" ? [hint] : []);
    expect(f.stdout).toHaveLength(1);
    expect(JSON.parse(f.stdout[0] ?? "").kind).toBe(result.kind);
    expect(confirmed).toBe(result.kind !== "pending");
  }
});

test.each([true, false])("wait accepts both option orders (save first: %s)", async (saveFirst) => {
  const f = await fixture();
  const args = saveFirst ? ["--save", f.folder, "--timeout", "1"] : ["--timeout", "1", "--save", f.folder];
  expect(await run(["wait", reviewId, ...args], f.io)).toBe(0);
  expect(f.confirms()).toBe(1);
});

test("colliding timestamps advance a millisecond without replacing files or symlinks", async () => {
  const f = await fixture();
  vi.spyOn(Date, "now").mockReturnValue(Date.parse("2026-11-01T14:30:05.123Z"));
  const old = join(f.folder, "wait-20261101T143005123Z.json");
  const alias = join(f.folder, "wait-20261101T143005124Z.json");
  await fs.writeFile(old, "synthetic earlier result", { mode: 0o600 });
  await fs.symlink(old, alias);
  expect(await run(["feedback", reviewId, "--save", f.folder], f.io)).toBe(0);
  expect(await fs.readFile(old, "utf8")).toBe("synthetic earlier result");
  expect((await fs.lstat(alias)).isSymbolicLink()).toBe(true);
  expect(await fs.readFile(join(f.folder, "wait-20261101T143005125Z.json"), "utf8")).toBe(f.stdout[0]);
  expect(await fs.readdir(f.folder)).toHaveLength(3);
});

test.each(["missing", "file", "symlink", "symlink-slash", "group", "other", "owner"])(
  "a %s save folder is refused before taking feedback",
  async (kind) => {
    const f = await fixture();
    let folder = join(f.dir, "invalid");
    if (kind === "file") await fs.writeFile(folder, "synthetic");
    if (kind.startsWith("symlink")) {
      await fs.symlink(f.folder, folder);
      if (kind === "symlink-slash") folder += "/";
    }
    if (["group", "other", "owner"].includes(kind)) {
      folder = f.folder;
      if (kind === "owner") vi.spyOn(process, "getuid").mockReturnValue((process.getuid?.() ?? 0) + 1);
      else await fs.chmod(folder, kind === "group" ? 0o710 : 0o701);
    }
    expect(await run(["feedback", reviewId, "--save", folder], f.io)).toBe(1);
    expect(f.fetcher).not.toHaveBeenCalled();
    expect(f.stdout).toEqual([]);
    expect(f.stderr).toHaveLength(1);
    expect(f.stderr[0]).toMatch(/^recense: Cannot save feedback in [^\n]+: [^\n]+\.\n$/);
    expect(await fs.readdir(f.folder)).toEqual([]);
  },
);

test("a folder containing a newline still produces one error line", async () => {
  const f = await fixture();
  expect(await run(["feedback", reviewId, "--save", join(f.dir, "missing\nfolder")], f.io)).toBe(1);
  expect(f.stderr[0]).toContain("missing\\u{a}folder");
  expect(f.stderr[0]?.split("\n")).toHaveLength(2);
});

test.each(["open", "write", "file-sync", "link", "directory-sync", "unlink"])(
  "%s failure removes partial and final files and never prints or confirms",
  async (stage) => {
    const f = await fixture();
    const failure = Object.assign(new Error("synthetic save failure"), { code: "EIO" });
    const open = fs.open;
    vi.spyOn(fs, "open").mockImplementation(async (...args) => {
      const partial = String(args[0]).endsWith(".partial");
      if (partial && stage === "open") throw failure;
      const file = await open(...args);
      if (partial && stage === "write") vi.spyOn(file, "writeFile").mockRejectedValueOnce(failure);
      if ((partial && stage === "file-sync") || (String(args[0]) === f.folder && stage === "directory-sync"))
        vi.spyOn(file, "sync").mockRejectedValueOnce(failure);
      return file;
    });
    if (stage === "link") vi.spyOn(fs, "link").mockRejectedValueOnce(failure);
    if (stage === "unlink") vi.spyOn(fs, "unlink").mockRejectedValueOnce(failure);
    expect(await run(["feedback", reviewId, "--save", f.folder], f.io)).toBe(1);
    expect(f.stdout).toEqual([]);
    expect(f.confirms()).toBe(0);
    expect(f.stderr).toEqual([`recense: Could not save feedback in ${f.folder}.\n`]);
    expect(await fs.readdir(f.folder)).toEqual([]);
  },
);

test("a save failure offers the unconfirmed hand-off again after its lease", async () => {
  const f = await fixture();
  const mailbox = await mailboxFixture();
  onTestFinished(() => mailbox.cleanup());
  const token = await createToken(mailbox.db, mailbox.ownerId, "agent", { instanceId: mailbox.instanceId });
  writeSecretFile(join(f.dir, "agent.token"), token.secret);
  await mailbox.thread();
  await mailbox.send();
  f.setResponse(async (url, init) =>
    mailbox.app.request(String(url), {
      ...init,
      headers: { ...init?.headers, Host: "127.0.0.1:3636" },
    }),
  );
  vi.spyOn(fs, "link").mockRejectedValueOnce(Object.assign(new Error("synthetic"), { code: "EIO" }));
  expect(await run(["feedback", mailbox.reviewId, "--save", f.folder], f.io)).toBe(1);
  expect(f.stdout).toEqual([]);
  expect(await fs.readdir(f.folder)).toEqual([]);
  expect((await mailbox.take()).kind).toBe("pending");
  mailbox.advance(LEASE_SECONDS * 1000 + 1);
  expect(await run(["feedback", mailbox.reviewId, "--save", f.folder], f.io)).toBe(0);
  expect(JSON.parse(f.stdout[0] ?? "").kind).toBe("go");
  expect((await mailbox.take()).kind).toBe("pending");
});

test.each(["SIGINT", "SIGTERM"] as const)(
  "%s during saving cleans up and skips stdout and confirmation",
  async (signal) => {
    const f = await fixture();
    const open = fs.open;
    vi.spyOn(fs, "open").mockImplementation(async (...args) => {
      const file = await open(...args);
      if (String(args[0]) === f.folder) {
        const sync = file.sync.bind(file);
        vi.spyOn(file, "sync").mockImplementationOnce(async () => {
          process.emit(signal);
          await sync();
        });
      }
      return file;
    });
    expect(await run(["wait", reviewId, "--save", f.folder], f.io)).toBe(signal === "SIGINT" ? 130 : 143);
    expect(f.confirms()).toBe(0);
    expect(f.stdout).toEqual([]);
    expect(f.stderr).toEqual([]);
    expect(await fs.readdir(f.folder)).toEqual([]);
  },
);

test("a stdout failure removes the saved file and leaves feedback unconfirmed", async () => {
  const f = await fixture();
  f.io.stdoutAsync = async () => {
    throw new Error("EPIPE");
  };
  expect(await run(["feedback", reviewId, "--save", f.folder], f.io)).toBe(1);
  expect(f.confirms()).toBe(0);
  expect(f.stdout).toEqual([]);
  expect(f.stderr).toEqual(["recense: Could not write to stdout.\n"]);
  expect(await fs.readdir(f.folder)).toEqual([]);
});

test("a signal during stdout preserves the complete save and skips confirmation", async () => {
  const f = await fixture();
  const writing = Promise.withResolvers<void>();
  const flush = Promise.withResolvers<void>();
  f.io.stdoutAsync = async (line) => {
    f.stdout.push(line);
    writing.resolve();
    await flush.promise;
  };
  const waiting = run(["feedback", reviewId, "--save", f.folder], f.io);
  await writing.promise;
  process.emit("SIGTERM");
  try {
    expect(await waiting).toBe(143);
    expect(f.confirms()).toBe(0);
    const names = await fs.readdir(f.folder);
    expect(names).toHaveLength(1);
    expect(await fs.readFile(join(f.folder, names[0] ?? ""), "utf8")).toBe(f.stdout[0]);
  } finally {
    flush.resolve();
  }
});

test.each([
  ["wait", approve],
  ["feedback", approve],
  ["wait", { ...pending, waitedSeconds: 1 }],
  ["feedback", pending],
] as const)(
  "%s keeps %j when the folder changes during stdout, warning only for a delivery",
  async (command, result) => {
    const f = await fixture();
    let confirms = 0;
    f.setResponse(async (url) => {
      if (String(url).endsWith("/take")) {
        f.advance();
        return Response.json(result);
      }
      confirms++;
      return new Response(null, { status: 204 });
    });
    const moved = `${f.folder}-moved`;
    onTestFinished(() => fs.rm(moved, { recursive: true, force: true }));
    f.io.stdoutAsync = async (line) => {
      f.stdout.push(line);
      await fs.rename(f.folder, moved);
      await fs.mkdir(f.folder, { mode: 0o700 });
    };
    const options = command === "wait" ? ["--timeout", "1"] : [];
    expect(await run([command, reviewId, ...options, "--save", f.folder], f.io)).toBe(0);
    expect(f.stdout).toEqual([`${JSON.stringify(result)}\n`]);
    expect(f.stderr).toEqual(result.kind === "pending" ? [] : [confirmWarning]);
    expect(confirms).toBe(0);
    const names = await fs.readdir(moved);
    expect(names).toHaveLength(1);
    expect(await fs.readFile(join(moved, names[0] ?? ""), "utf8")).toBe(f.stdout[0]);
    expect(await fs.readdir(f.folder)).toEqual([]);
  },
);

test.each(["wait", "feedback"])("%s rejects invalid save options before contact", async (command) => {
  const f = await fixture();
  for (const args of [
    ["--save"],
    ["--save", ""],
    ["--save", "bad\0folder"],
    ["--save", f.folder, "--save", f.folder],
    ["--save", "--timeout", "1"],
    ["--save", f.folder, "extra"],
    ["--unknown", f.folder],
    ["--timeout", ""],
    ["--timeout", "1\0"],
    ["--timeout", "1", "--timeout", "1"],
  ]) {
    f.stderr.length = 0;
    expect(await run([command, reviewId, ...args], f.io)).toBe(2);
    expect(f.stdout).toEqual([]);
    expect(f.stderr).toHaveLength(1);
    expect(f.fetcher).not.toHaveBeenCalled();
  }
});

test.each(["state", "child", "alias"])("save refuses the %s state folder before taking", async (kind) => {
  const f = await fixture();
  let folder = f.dir;
  if (kind === "child") {
    folder = join(f.dir, "child");
    await fs.mkdir(folder, { mode: 0o700 });
  }
  if (kind === "alias") {
    const alias = join(f.folder, "state-parent");
    await fs.symlink(f.dir, alias);
    await fs.mkdir(join(f.dir, "child"), { mode: 0o700 });
    folder = join(alias, "child");
  }
  expect(await run(["feedback", reviewId, "--save", folder], f.io)).toBe(2);
  expect(f.stdout).toEqual([]);
  expect(f.fetcher).not.toHaveBeenCalled();
  expect(f.stderr).toEqual(["recense: --save cannot point into recense's state folder.\n"]);
});

test("save uses its normalized folder for every file operation", async () => {
  const f = await fixture();
  const publicFolder = join(f.folder, "public");
  const privateFolder = join(f.folder, "private");
  await fs.mkdir(join(publicFolder, "child"), { recursive: true });
  await fs.chmod(publicFolder, 0o777);
  await fs.mkdir(privateFolder, { mode: 0o700 });
  await fs.symlink(join(publicFolder, "child"), join(privateFolder, "link"));
  expect(await run(["feedback", reviewId, "--save", `${privateFolder}/link/..`], f.io)).toBe(0);
  const names = (await fs.readdir(privateFolder)).filter((name) => name !== "link");
  expect(names).toHaveLength(1);
  expect(names[0]).toMatch(/^wait-.*\.json$/);
  expect(await fs.readFile(join(privateFolder, names[0] ?? ""), "utf8")).toBe(f.stdout[0]);
  expect(await fs.readdir(publicFolder)).toEqual(["child"]);
  expect(f.confirms()).toBe(1);
  expect(f.stderr).toEqual([]);
});

test("state-folder refusal rejects a parent-symlink swap before realpath", async () => {
  const f = await fixture();
  const outside = join(f.folder, "outside");
  await fs.mkdir(outside, { mode: 0o700 });
  await fs.mkdir(join(outside, "child"), { mode: 0o700 });
  await fs.mkdir(join(f.dir, "child"), { mode: 0o700 });
  const alias = join(f.folder, "parent");
  await fs.symlink(f.dir, alias);
  const folder = join(alias, "child");
  const realpath = fs.realpath;
  vi.spyOn(fs, "realpath").mockImplementation(async (path, ...args) => {
    if (String(path) === folder) {
      await fs.unlink(alias);
      await fs.symlink(outside, alias);
    }
    return realpath(path, ...args);
  });
  expect(await run(["feedback", reviewId, "--save", folder], f.io)).toBe(1);
  expect(f.stdout).toEqual([]);
  expect(f.stderr).toEqual([
    "recense: The save folder changed while recense was writing to it; nothing was confirmed.\n",
  ]);
  expect(f.fetcher).not.toHaveBeenCalled();
  expect(await fs.readdir(join(outside, "child"))).toEqual([]);
});

test.each(["folder", "symlink"])(
  "a %s swapped in after temporary open is neither confirmed nor cleaned up",
  async (kind) => {
    const f = await fixture();
    const moved = `${f.folder}-moved`;
    const replacement = `${f.folder}-replacement`;
    onTestFinished(async () => {
      await fs.rm(moved, { recursive: true, force: true });
      await fs.rm(replacement, { recursive: true, force: true });
    });
    const open = fs.open;
    let planted: string | undefined;
    vi.spyOn(fs, "open").mockImplementation(async (...args) => {
      const file = await open(...args);
      if (String(args[0]).endsWith(".partial")) {
        await fs.rename(f.folder, moved);
        if (kind === "folder") await fs.mkdir(f.folder, { mode: 0o700 });
        else {
          await fs.mkdir(replacement, { mode: 0o700 });
          await fs.symlink(replacement, f.folder);
        }
        planted = String(args[0]);
        await fs.writeFile(planted, "synthetic replacement");
      }
      return file;
    });
    const unlink = vi.spyOn(fs, "unlink");
    expect(await run(["feedback", reviewId, "--save", f.folder], f.io)).toBe(1);
    expect(f.stderr).toEqual([
      "recense: The save folder changed while recense was writing to it; nothing was confirmed.\n",
    ]);
    expect(f.stdout).toEqual([]);
    expect(f.confirms()).toBe(0);
    expect(await fs.readFile(planted ?? "", "utf8")).toBe("synthetic replacement");
    expect(unlink).not.toHaveBeenCalled();
  },
);

test("a replacement saved inode fails verification and survives cleanup", async () => {
  const f = await fixture();
  const link = fs.link;
  let planted = "";
  vi.spyOn(fs, "link").mockImplementationOnce(async (...args) => {
    await link(...args);
    planted = String(args[1]);
    await fs.unlink(planted);
    await fs.writeFile(planted, "synthetic replacement");
  });
  expect(await run(["feedback", reviewId, "--save", f.folder], f.io)).toBe(1);
  expect(f.stderr).toEqual([
    "recense: The save folder changed while recense was writing to it; nothing was confirmed.\n",
  ]);
  expect(f.stdout).toEqual([]);
  expect(f.confirms()).toBe(0);
  expect(await fs.readFile(planted, "utf8")).toBe("synthetic replacement");
});

test.each(["save", "stdout"])("a cleanup failure preserves the original %s error", async (stage) => {
  const f = await fixture();
  const unlink = fs.unlink;
  vi.spyOn(fs, "unlink").mockImplementation(async (path) => {
    if (stage === "stdout" && String(path).endsWith(".partial")) return unlink(path);
    throw Object.assign(new Error("synthetic cleanup"), { code: "EACCES" });
  });
  if (stage === "save") vi.spyOn(fs, "link").mockRejectedValueOnce(new Error("synthetic link failure"));
  else
    f.io.stdoutAsync = async () => {
      throw new Error("synthetic stdout failure");
    };
  expect(await run(["feedback", reviewId, "--save", f.folder], f.io)).toBe(1);
  expect(f.stdout).toEqual([]);
  expect(f.confirms()).toBe(0);
  expect(f.stderr).toEqual([
    stage === "save" ? `recense: Could not save feedback in ${f.folder}.\n` : "recense: Could not write to stdout.\n",
  ]);
});
