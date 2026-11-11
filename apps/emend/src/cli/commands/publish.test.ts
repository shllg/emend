import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, realpath, rm, stat, truncate, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Writable } from "node:stream";
import { promisify } from "node:util";
import { LIMITS, type PublishManifest, PublishRequest } from "@emend/contract";
import { afterEach, expect, onTestFinished, test, vi } from "vitest";
import { run } from "../../main.ts";
import { projectKey } from "../publish/key.ts";
import { commandFixture, provenTestServer } from "../test-support.ts";
import { manifestJsonError, parsePublishArgs, publishCommand, publishTimeoutMs } from "./publish.ts";

afterEach(() => vi.unstubAllGlobals());

test("help lists the project option for both publish forms", async () => {
  const stdout: string[] = [];
  const stderr = vi.fn();
  expect(await run(["--help"], { stdout: (line) => stdout.push(line), stderr, env: {} })).toBe(0);
  const forms = stdout
    .join("")
    .split("\n")
    .filter((line) => line.includes("emend publish"));
  expect(forms).toHaveLength(2);
  expect(forms.every((line) => line.endsWith("[--project NAME]"))).toBe(true);
  expect(stderr).not.toHaveBeenCalled();
});

test.each([["plan.md"], ["--manifest", "review.json"]])("project option works with %j", (...args) => {
  expect(parsePublishArgs([...args, "--project", "  Synthetic project  "]).project).toBe("Synthetic project");
  expect(parsePublishArgs([...args, "--project", "x".repeat(200)]).project).toHaveLength(200);
  for (const name of [
    "",
    "   ",
    "x".repeat(201),
    "bad\u0000name",
    "bad\u001fname",
    "bad\u007fname",
    "\nname",
    "name\t",
  ])
    expect(() => parsePublishArgs([...args, "--project", name])).toThrow("invalid project name");
  expect(() => parsePublishArgs([...args, "--project", "One", "--project", "Two"])).toThrow("duplicate publish option");
  expect(() => parsePublishArgs([...args, "--project"])).toThrow("usage:");
});

test.each([
  ["Unexpected token ] in JSON at position 9", " (line 2, column 8)"],
  ["Expected property name at position 9 (line 2 column 8)", " (line 2, column 8)"],
  ["Unexpected end of JSON input", ""],
  ["Unexpected token ] in JSON at position 99", ""],
  ['Unexpected token, "position 9 (line 2 column 8)" is not valid JSON', ""],
])("manifest JSON diagnostics use only an engine location: %s", (engineMessage, suffix) => {
  expect(manifestJsonError(new SyntaxError(engineMessage), '{\n  "x": ]\n}')).toBe(
    `the manifest is not valid JSON${suffix}`,
  );
});

test.each([
  { endings: "CR-only", text: '{\r "x":1,\r}', position: 10, line: 3, column: 1 },
  { endings: "CRLF", text: '{\r\n "x":1,\r\n}', position: 12, line: 3, column: 1 },
  { endings: "mixed", text: '{\r\n "x":1,\r "y":2,\n  }', position: 21, line: 4, column: 3 },
])("manifest JSON positions count $endings line endings", ({ text, position, line, column }) => {
  expect(manifestJsonError(new SyntaxError(`Unexpected token } in JSON at position ${position}`), text)).toBe(
    `the manifest is not valid JSON (line ${line}, column ${column})`,
  );
});

test("publish with closed stdout exits 1 with one diagnostic", async () => {
  const f = await commandFixture();
  const manifest = join(f.dir, "manifest.json");
  await writeFile(
    manifest,
    JSON.stringify({
      version: 1,
      title: "Synthetic",
      topics: [],
      files: [],
      writeup: { overview: "", tldr: "", decisions: null, topics: {} },
    }),
  );
  await writeFile(join(f.dir, "instance.json"), JSON.stringify({ id: randomUUID() }));
  const reviewId = randomUUID();
  f.setResponse(async () =>
    Response.json({
      reviewId,
      revision: 1,
      placed: 0,
      unplaced: 0,
      unrendered: ["synthetic.md"],
      url: `http://127.0.0.1:3636/r/${reviewId}`,
    }),
  );
  const closed = new Writable({
    write(_chunk, _encoding, callback) {
      callback();
    },
  });
  closed.on("error", () => {});
  closed.destroy();
  f.io.stdoutAsync = (line) =>
    new Promise<void>((resolve, reject) => {
      closed.write(line, (error) => (error ? reject(error) : resolve()));
    });
  expect(await run(["publish", "--manifest", manifest, "--key", "synthetic"], f.io)).toBe(1);
  expect(f.stdout).toEqual([]);
  expect(f.stderr).toEqual(["emend: Could not write to stdout.\n"]);
});
test("publish deadlines include the slot, one render pass and three placement attempts", () => {
  expect(publishTimeoutMs([])).toBe(145000);
  expect(
    publishTimeoutMs([
      { role: "doc", path: "one.md" },
      { role: "doc", path: "two.markdown" },
      { role: "doc", path: "page.html" },
      { role: "diff", path: "source.md" },
    ]),
  ).toBe(165000);
});
test("publish stdout is exactly one JSON line and unchanged docs upload nothing twice", async () => {
  const dir = await realpath(await mkdtemp(join(tmpdir(), "emend-command-")));
  const state = await mkdtemp(join(tmpdir(), "emend-command-state-"));
  try {
    const docs = join(dir, "docs");
    await mkdir(docs);
    await promisify(execFile)("git", ["init", dir], {
      env: {
        PATH: process.env.PATH,
        HOME: dir,
        LC_ALL: "C",
        GIT_CONFIG_GLOBAL: "/dev/null",
        GIT_CONFIG_NOSYSTEM: "1",
      },
    });
    await writeFile(join(state, "agent.token"), `em_${"a".repeat(43)}`, { mode: 0o600 });
    await writeFile(join(state, "instance.json"), JSON.stringify({ id: randomUUID() }));
    await writeFile(join(state, "config.json"), JSON.stringify({ docRoots: [docs] }));
    const input: PublishManifest = {
      version: 1,
      title: "Synthetic",
      topics: [],
      files: [{ path: "plan.md", role: "doc", source: "docs/plan.md" }],
      writeup: { overview: "hi", tldr: "short", decisions: null, topics: {} },
    };
    const path = join(dir, "manifest.json");
    await writeFile(path, JSON.stringify(input));
    await writeFile(join(docs, "plan.md"), "# Plan");
    const proof = provenTestServer(state);
    const blobs = new Set<string>();
    const reviewId = randomUUID();
    let revision = 0;
    let puts = 0;
    vi.stubGlobal("fetch", async (url: string | URL, init?: RequestInit) => {
      const proven = proof(url, init);
      if (proven) return proven;
      if (init?.method === "HEAD") return new Response(null, { status: blobs.has(String(url)) ? 204 : 404 });
      if (init?.method === "PUT") {
        puts++;
        blobs.add(String(url));
        return new Response(null, { status: 204 });
      }
      const request = PublishRequest.parse(JSON.parse(String(init?.body)));
      if (revision === 1)
        expect(request.repo).toEqual({ key: projectKey("Synthetic project"), name: "Synthetic project" });
      return Response.json({
        reviewId,
        revision: ++revision,
        placed: 0,
        unplaced: 0,
        unrendered: revision === 2 ? ["plan.md"] : [],
        url: `http://127.0.0.1:3636/r/${reviewId}`,
      });
    });
    for (let i = 1; i <= 2; i++) {
      const stdout: string[] = [];
      const stderr: string[] = [];
      await publishCommand(
        state,
        ["--manifest", path, "--key", "plan", ...(i === 2 ? ["--project", "Synthetic project"] : [])],
        { stdout: (s) => stdout.push(s), stderr: (s) => stderr.push(s), env: { EMEND_HOME: state } },
        dir,
      );
      expect(stdout).toHaveLength(1);
      expect(stdout[0]?.split("\n")).toHaveLength(2);
      expect(JSON.parse(stdout[0] ?? "")).toMatchObject({ reviewId, revision: i });
      expect(stderr).toEqual([
        ...(i === 2 ? ["emend: could not render plan.md\n"] : []),
        `emend: published revision ${i}: http://127.0.0.1:3636/r/${reviewId}\n`,
      ]);
    }
    expect(puts).toBe(1);
  } finally {
    await rm(state, { recursive: true, force: true });
    await rm(dir, { recursive: true, force: true });
  }
});
test("docs-only without a key, malformed manifests and unknown reviews fail with one stderr line", async () => {
  const dir = await mkdtemp(join(tmpdir(), "emend-command-errors-"));
  try {
    const path = join(dir, "manifest.json");
    await writeFile(
      path,
      JSON.stringify({
        version: 1,
        title: "Synthetic",
        topics: [],
        files: [],
        writeup: { overview: "", tldr: "", decisions: null, topics: {} },
      }),
    );
    const proof = provenTestServer(dir);
    await writeFile(join(dir, "agent.token"), `em_${"a".repeat(43)}`, { mode: 0o600 });
    await writeFile(join(dir, "instance.json"), JSON.stringify({ id: randomUUID() }));
    vi.stubGlobal(
      "fetch",
      async (url: string | URL, init?: RequestInit) =>
        proof(url, init) ??
        Response.json({ error: { code: "unknown_review", message: "untrusted\nmessage" } }, { status: 404 }),
    );
    for (const [args, expected] of [
      [["--manifest", path], "emend: pass --review or --key\n"],
      [["--manifest", path, "--review", randomUUID()], "emend: unknown_review\n"],
      [["--manifest", join(dir, "missing")], `emend: manifest not found: ${join(dir, "missing")}\n`],
    ] as const) {
      const stdout: string[] = [];
      const stderr: string[] = [];
      expect(
        await run(["publish", ...args], {
          stdout: (s) => stdout.push(s),
          stderr: (s) => stderr.push(s),
          env: { EMEND_HOME: dir },
        }),
      ).toBe(1);
      expect(stdout).toEqual([]);
      expect(stderr).toEqual([expected]);
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test.each(["missing", "non-directory parent", "directory", "empty", "truncated", "secret-looking", "oversized"])(
  "a %s manifest fails with one safe diagnostic and creates no review",
  async (kind) => {
    const f = await commandFixture();
    const root = await mkdtemp(join(tmpdir(), "emend-manifest-repo-"));
    onTestFinished(() => rm(root, { recursive: true, force: true }));
    await promisify(execFile)("git", ["-c", "init.templateDir=", "init", root], {
      env: {
        PATH: process.env.PATH,
        HOME: root,
        LC_ALL: "C",
        GIT_CONFIG_GLOBAL: "/dev/null",
        GIT_CONFIG_NOSYSTEM: "1",
      },
    });
    vi.spyOn(process, "cwd").mockReturnValue(root);
    const name = kind === "non-directory parent" ? "plain/review.json" : "review.json";
    const path = join(f.dir, name);
    const secret = `emp_${"a".repeat(43)}`;
    let expected: string;
    if (kind === "missing" || kind === "non-directory parent" || kind === "directory") {
      if (kind === "non-directory parent") await writeFile(join(f.dir, "plain"), "Synthetic file");
      if (kind === "directory") await mkdir(path);
      expected = `emend: manifest not found: ${path}\n`;
    } else if (kind === "oversized") {
      await writeFile(path, "");
      await truncate(path, LIMITS.publishJsonBytes + 1);
      expected = "emend: manifest exceeds its size limit\n";
    } else {
      const content =
        kind === "empty"
          ? ""
          : kind === "truncated"
            ? '{\n  "version": 1,\n  "title": "Synthetic"'
            : `{"title":"${secret}" broken}`;
      await writeFile(path, content);
      expected =
        kind === "empty"
          ? "emend: the manifest is not valid JSON\n"
          : kind === "truncated"
            ? "emend: the manifest is not valid JSON (line 3, column 23)\n"
            : "emend: the manifest is not valid JSON (line 1, column 60)\n";
    }
    expect(await run(["publish", "--manifest", path, "--key", "synthetic"], f.io)).toBe(1);
    expect(f.stdout).toEqual([]);
    expect(f.stderr).toEqual([expected]);
    expect(f.stderr.join("")).not.toContain(secret);
    expect(f.stderr.join("").split("\n")).toHaveLength(2);
    expect(f.fetcher).not.toHaveBeenCalled();
    await expect(stat(join(f.dir, "emend.db"))).rejects.toMatchObject({ code: "ENOENT" });
  },
);

test("a missing manifest escapes the supplied path on one line", async () => {
  const f = await commandFixture();
  const root = await mkdtemp(join(tmpdir(), "emend-manifest-repo-"));
  onTestFinished(() => rm(root, { recursive: true, force: true }));
  await promisify(execFile)("git", ["-c", "init.templateDir=", "init", root], {
    env: {
      PATH: process.env.PATH,
      HOME: root,
      LC_ALL: "C",
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_CONFIG_NOSYSTEM: "1",
    },
  });
  vi.spyOn(process, "cwd").mockReturnValue(root);
  expect(await run(["publish", "--manifest", "missing\u2028.json", "--key", "synthetic"], f.io)).toBe(1);
  expect(f.stdout).toEqual([]);
  expect(f.stderr).toEqual(["emend: manifest not found: missing\\u{2028}.json\n"]);
  expect(f.fetcher).not.toHaveBeenCalled();
  await expect(stat(join(f.dir, "emend.db"))).rejects.toMatchObject({ code: "ENOENT" });
});

test("a 200 with an invalid publish response reports possible publication on one stderr line", async () => {
  const dir = await mkdtemp(join(tmpdir(), "emend-command-answer-"));
  try {
    const path = join(dir, "manifest.json");
    await writeFile(
      path,
      JSON.stringify({
        version: 1,
        title: "Synthetic",
        topics: [],
        files: [],
        writeup: { overview: "", tldr: "", decisions: null, topics: {} },
      }),
    );
    await writeFile(join(dir, "agent.token"), `em_${"a".repeat(43)}`, { mode: 0o600 });
    await writeFile(join(dir, "instance.json"), JSON.stringify({ id: randomUUID() }));
    const proof = provenTestServer(dir);
    vi.stubGlobal(
      "fetch",
      async (url: string | URL, init?: RequestInit) =>
        proof(url, init) ?? Response.json({ revision: "invalid", message: "untrusted\nmessage" }),
    );
    const stdout: string[] = [];
    const stderr: string[] = [];
    expect(
      await run(["publish", "--manifest", path, "--key", "docs"], {
        stdout: (s) => stdout.push(s),
        stderr: (s) => stderr.push(s),
        env: { EMEND_HOME: dir },
      }),
    ).toBe(1);
    expect(stdout).toEqual([]);
    expect(stderr).toEqual(["emend: the server's answer was cut off; the revision may have been published\n"]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
