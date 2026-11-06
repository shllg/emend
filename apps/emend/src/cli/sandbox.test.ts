import { randomUUID } from "node:crypto";
import * as syncFs from "node:fs";
import * as fs from "node:fs/promises";
import { join } from "node:path";
import { expect, test, vi } from "vitest";
import * as replies from "../db/repo/replies.ts";
import { run } from "../main.ts";
import * as stateFiles from "../state/files.ts";
import { StateFolderWriteError, stateAccessError, stateFileError } from "../state/files.ts";
import { directFixture } from "./direct-test-support.ts";
import { errorLine, hubFailure, sandboxHint } from "./http.ts";
import { resolvePublish } from "./publish/resolve.ts";
import { commandFixture } from "./test-support.ts";

vi.mock("node:fs", async (original) => ({ ...(await original<typeof import("node:fs")>()) }));

vi.mock("node:fs/promises", async (original) => ({ ...(await original<typeof import("node:fs/promises")>()) }));

test("the state-folder diagnostic always carries the exact sandbox hint on one line", () => {
  expect(new StateFolderWriteError("/synthetic/state").message).toBe(
    "emend cannot write its state folder /synthetic/state.",
  );
  expect(errorLine(new StateFolderWriteError("/synthetic/state"), "feedback")).toBe(
    "emend cannot write its state folder /synthetic/state. If an agent sandbox runs emend, let emend run outside it: https://github.com/shllg/emend/blob/release/docs/setup/troubleshooting.md#an-agents-sandbox-blocks-emend\n",
  );
  expect(errorLine(new StateFolderWriteError("/synthetic/state\nfolder"), "feedback")).toBe(
    `emend cannot write its state folder /synthetic/state\\u{a}folder. ${sandboxHint}\n`,
  );
});

test("known descriptor paths are attached only to errno errors without a path", () => {
  const path = "/synthetic/state/emend.db";
  for (const error of [Object.freeze(new Error("synthetic")), Object.assign(new Error("synthetic"), { code: 1 })]) {
    expect(stateFileError(path, error)).toBe(error);
    expect(error).not.toHaveProperty("path");
  }
  const errno = Object.assign(new Error("synthetic"), { code: "EPERM" });
  expect(stateFileError(path, errno)).toBe(errno);
  expect(stateAccessError("/synthetic/state", errno)).toEqual(new StateFolderWriteError("/synthetic/state"));
  const other = Object.assign(new Error("synthetic"), { code: "EPERM", path: "/synthetic/other" });
  expect(stateFileError(path, other)).toBe(other);
  expect(other.path).toBe("/synthetic/other");
});

test.each(["EACCES", "EPERM", "EROFS"])("state %s errors retain the hint through nested causes", (code) => {
  const stateDir = "/synthetic/state";
  const cause = Object.assign(new Error("synthetic"), { code, path: join(stateDir, "emend.db") });
  expect(stateAccessError(stateDir, new Error("query failed", { cause }))).toEqual(new StateFolderWriteError(stateDir));
  const unrelated = Object.assign(new Error("synthetic"), { code, path: "/synthetic/state-other/doc.md" });
  expect(stateAccessError(stateDir, unrelated)).toBe(unrelated);
});

test.skipIf(process.getuid?.() === 0).each([0o500, 0o700])(
  "hub failure probes a mode-%s state folder and cleans up",
  async (mode) => {
    const f = await commandFixture();
    const before = await fs.readdir(f.dir);
    await fs.chmod(f.dir, mode);
    try {
      const error = hubFailure(
        "https://hub.example",
        new Error("synthetic", { cause: { code: "ECONNREFUSED" } }),
        undefined,
        f.dir,
      );
      expect(errorLine(error, "feedback")).toBe(
        `emend: cannot reach the hub at https://hub.example: connection refused. Nothing was changed.${mode === 0o500 ? ` ${sandboxHint}` : ""}\n`,
      );
      expect(await fs.readdir(f.dir)).toEqual(before);
    } finally {
      await fs.chmod(f.dir, 0o700);
    }
  },
);

test.skipIf(process.getuid?.() === 0).each(["probe", "request"])(
  "a hub %s failure reports a blocked state folder through the CLI",
  async (stage) => {
    const f = await commandFixture();
    await fs.writeFile(
      join(f.dir, "attach.json"),
      JSON.stringify({ hubUrl: "https://hub.example", hubId: randomUUID(), hubName: "Synthetic" }),
    );
    await fs.writeFile(join(f.dir, "hub.token"), `em_${"b".repeat(43)}`, { mode: 0o600 });
    vi.stubGlobal("fetch", async (url: string | URL) => {
      if (stage === "request" && String(url).endsWith("/capabilities"))
        return Response.json({ api: 1, version: "0.1.0", features: [] });
      throw new Error("synthetic", { cause: { code: "ECONNREFUSED" } });
    });
    const before = await fs.readdir(f.dir);
    await fs.chmod(f.dir, 0o500);
    try {
      expect(await run(["feedback", randomUUID()], f.io)).toBe(1);
      expect(f.stdout).toEqual([]);
      expect(f.stderr).toEqual([
        `emend: cannot reach the hub at https://hub.example: connection refused. Nothing was changed. ${sandboxHint}\n`,
      ]);
      expect(await fs.readdir(f.dir)).toEqual(before);
    } finally {
      await fs.chmod(f.dir, 0o700);
    }
  },
);

test.skipIf(process.getuid?.() === 0).each(["wait", "feedback", "reply", "publish"])(
  "%s reports an unreadable state folder without taking feedback",
  async (command) => {
    const f = await directFixture();
    const out = f.output();
    await fs.chmod(f.stateDir, 0o000);
    try {
      const args =
        command === "publish"
          ? ["--manifest", f.manifest, "--key", "synthetic"]
          : command === "reply"
            ? [randomUUID(), "--status", "explained", "--body", "Synthetic"]
            : [randomUUID()];
      expect(await run([command, ...args], out.io)).toBe(1);
      expect(out.stdout).toEqual([]);
      expect(out.stderr).toEqual([errorLine(new StateFolderWriteError(f.stateDir), "feedback")]);
    } finally {
      await fs.chmod(f.stateDir, 0o700);
    }
  },
);

test.skipIf(process.getuid?.() === 0).each(["config.json", "attach.json", "server.json", "server-url.json"])(
  "a denied %s read on the direct path reports the state folder",
  async (name) => {
    const f = await directFixture();
    const out = f.output();
    vi.spyOn(process, "cwd").mockReturnValue(f.source);
    const path = join(f.stateDir, name);
    if (name !== "config.json") await fs.writeFile(path, "{}");
    await fs.chmod(path, 0o000);
    expect(await run(["publish", "--manifest", f.manifest, "--key", "synthetic"], out.io)).toBe(1);
    expect(out.stdout).toEqual([]);
    expect(out.stderr).toEqual([errorLine(new StateFolderWriteError(f.stateDir), "feedback")]);
  },
);

test("a denied state write during a direct reply retains the state diagnostic", async () => {
  const f = await directFixture();
  await f.publish();
  const out = f.output();
  vi.spyOn(replies, "replyToComment").mockRejectedValueOnce(
    new Error("query failed", {
      cause: Object.assign(new Error("synthetic"), { code: "EROFS", path: join(f.stateDir, "emend.db") }),
    }),
  );
  expect(await run(["reply", randomUUID(), "--status", "explained", "--body", "Synthetic"], out.io)).toBe(1);
  expect(out.stdout).toEqual([]);
  expect(out.stderr).toEqual([errorLine(new StateFolderWriteError(f.stateDir), "feedback")]);
});

test("a missing state folder produces no hub sandbox hint", async () => {
  const f = await commandFixture();
  const error = hubFailure("https://hub.example", undefined, undefined, join(f.dir, "absent"));
  expect(errorLine(error, "feedback")).toBe(
    "emend: cannot reach the hub at https://hub.example: connection failed. Nothing was changed.\n",
  );
});

test.each(["EIO", "ENOSPC", "ENOENT"])("a %s probe failure produces no sandbox hint", async (code) => {
  const f = await commandFixture();
  vi.spyOn(syncFs, "openSync").mockImplementationOnce(() => {
    throw Object.assign(new Error("synthetic"), { code });
  });
  expect(errorLine(hubFailure("https://hub.example", undefined, undefined, f.dir), "feedback")).not.toContain(
    "agent sandbox",
  );
});

test.each(["attach", "detach", "pair", "devices", "service", "skills", "config", "serve", "open", "mcp"])(
  "%s state and hub errors do not carry a sandbox hint",
  async (command) => {
    const f = await commandFixture();
    const probe = vi.spyOn(stateFiles, "stateFolderWritable");
    expect(errorLine(new StateFolderWriteError("/synthetic/state"), command)).toBe(
      "emend cannot write its state folder /synthetic/state.\n",
    );
    expect(errorLine(hubFailure("https://hub.example", undefined, undefined, f.dir), command)).not.toContain(
      "agent sandbox",
    );
    expect(probe).not.toHaveBeenCalled();
  },
);

test.skipIf(process.getuid?.() === 0)(
  "attach reports a denied state folder without suggesting an exemption",
  async () => {
    const f = await commandFixture();
    await fs.chmod(f.dir, 0o500);
    try {
      expect(await run(["attach", `https://hub.example/pair#emp_${"a".repeat(43)}`], f.io)).toBe(1);
      expect(f.stderr).toEqual([`emend cannot write its state folder ${f.dir}.\n`]);
      expect(f.stdout).toEqual([]);
      expect(f.fetcher).not.toHaveBeenCalled();
    } finally {
      await fs.chmod(f.dir, 0o700);
    }
  },
);

test("feedback retains the database path when fchmod fails without error.path", async () => {
  const f = await directFixture();
  const out = f.output();
  vi.spyOn(syncFs, "fchmodSync").mockImplementationOnce(() => {
    throw Object.assign(new Error("synthetic"), { code: "EPERM" });
  });
  expect(await run(["feedback", randomUUID()], out.io)).toBe(1);
  expect(out.stdout).toEqual([]);
  expect(out.stderr).toEqual([errorLine(new StateFolderWriteError(f.stateDir), "feedback")]);
  const unrelated = Object.assign(new Error("synthetic unrelated"), { code: "EPERM" });
  expect(stateAccessError(f.stateDir, unrelated)).toBe(unrelated);
});

test.each([
  ["plan.md", "source.markdown", true],
  ["plan.MARKDOWN", "source.MD", true],
  ["plan.html", "source.htm", true],
  ["plan.HTM", "source.HTML", true],
  ["plan.md", "source.html", false],
  ["plan.html", "source.md", false],
  ["plan.md", "synthetic.data", false],
  ["plan.html", "synthetic", false],
])("publish source %s <- %s requires matching doc extensions", async (path, source, allowed) => {
  const f = await directFixture();
  vi.spyOn(process, "cwd").mockReturnValue(f.source);
  const manifest = JSON.parse(await fs.readFile(f.manifest, "utf8"));
  manifest.files = [{ path, source, role: "doc" }];
  await fs.writeFile(f.manifest, JSON.stringify(manifest));
  await fs.writeFile(join(f.source, source), "Synthetic doc");
  const out = f.output();
  expect(await run(["publish", "--manifest", f.manifest, "--key", "synthetic"], out.io)).toBe(allowed ? 0 : 1);
  if (!allowed) {
    expect(out.stdout).toEqual([]);
    expect(out.stderr).toEqual(["emend: doc source must end in .md, .markdown, .html or .htm, like its path.\n"]);
  }
});

test.each(["capabilities", "registration"])(
  "attach never probes state after a %s connection failure",
  async (stage) => {
    const f = await directFixture();
    const out = f.output();
    const probe = vi.spyOn(stateFiles, "stateFolderWritable");
    vi.stubGlobal("fetch", async (url: string | URL) => {
      if (stage === "registration" && String(url).endsWith("/capabilities"))
        return Response.json({ api: 1, version: "0.1.0", features: ["attach"] });
      throw new Error("synthetic", { cause: { code: "ECONNREFUSED" } });
    });
    expect(await run(["attach", `https://hub.example/pair#emp_${"a".repeat(43)}`], out.io)).toBe(1);
    expect(out.stdout).toEqual([]);
    expect(out.stderr).toEqual([
      "emend: cannot reach the hub at https://hub.example: connection refused. Nothing was changed.\n",
    ]);
    expect(probe).not.toHaveBeenCalled();
  },
);

test.each([false, true])("publish rejects a doc alias to a non-doc file (explicit source: %s)", async (source) => {
  const f = await directFixture();
  await fs.mkdir(join(f.source, ".git"));
  await fs.writeFile(join(f.source, ".synthetic-data"), "Synthetic non-document content");
  await fs.symlink(".synthetic-data", join(f.source, "notes.md"));
  const manifest = JSON.parse(await fs.readFile(f.manifest, "utf8"));
  manifest.files = [{ path: source ? "plan.md" : "notes.md", role: "doc", ...(source ? { source: "notes.md" } : {}) }];
  await expect(
    resolvePublish(manifest, { manifest: f.manifest, key: "synthetic" }, f.stateDir, null, f.source, () => {}, {
      root: f.source,
      worktree: f.source,
      gitDirs: [join(f.source, ".git")],
      git: vi.fn(),
    }),
  ).rejects.toThrow("doc source must end in .md, .markdown, .html or .htm, like its path.");
});

test("doc upload rereads recheck the real extension while allowing dot folders", async () => {
  const f = await directFixture();
  await fs.mkdir(join(f.source, ".git"));
  await fs.mkdir(join(f.source, ".plans"));
  await fs.writeFile(join(f.source, ".plans", "plan.md"), "Synthetic plan in a dot folder");
  await fs.writeFile(join(f.source, ".synthetic-data"), "Synthetic non-document content");
  const alias = join(f.source, "notes.md");
  await fs.symlink(".plans/plan.md", alias);
  const manifest = JSON.parse(await fs.readFile(f.manifest, "utf8"));
  manifest.files = [{ path: "notes.md", role: "doc" }];
  const result = await resolvePublish(
    manifest,
    { manifest: f.manifest, key: "synthetic" },
    f.stateDir,
    null,
    f.source,
    () => {},
    { root: f.source, worktree: f.source, gitDirs: [join(f.source, ".git")], git: vi.fn() },
  );
  const blob = [...result.blobs.values()][0];
  expect((await blob?.read())?.toString()).toBe("Synthetic plan in a dot folder");
  await fs.unlink(alias);
  await fs.symlink(".synthetic-data", alias);
  await expect(blob?.read()).rejects.toThrow("doc source must end in .md, .markdown, .html or .htm, like its path.");
});
