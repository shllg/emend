import { execFile, execFileSync, spawn } from "node:child_process";
import { createHmac } from "node:crypto";
import { access, mkdir, mkdtemp, open, readdir, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { AGENT_REVIEW_KEY_FEATURE } from "@emend/contract";
import { expect, onTestFinished, test } from "vitest";
import { escapeReference } from "./cli/escape.ts";

const syntheticId = "11111111-1111-4111-8111-111111111111";

async function entryFixture() {
  const directory = await realpath(await mkdtemp(join(tmpdir(), "emend-cli-runtime-")));
  onTestFinished(() => rm(directory, { recursive: true, force: true }));
  const state = join(directory, "state");
  await mkdir(state, { mode: 0o700 });
  const entry = await realpath(fileURLToPath(new URL("./cli.ts", import.meta.url)));
  const env = {
    PATH: [dirname(process.execPath), "/usr/bin", "/bin"].join(delimiter),
    HOME: directory,
    LC_ALL: "C",
    EMEND_HOME: state,
  };
  const invoke = async (cwd: string, args: string[], nodeArgs: string[] = [], timeout?: number) => {
    const stdoutPath = join(directory, "stdout");
    const stderrPath = join(directory, "stderr");
    const stdout = await open(stdoutPath, "w", 0o600);
    const stderr = await open(stderrPath, "w", 0o600);
    try {
      const code = await new Promise<number | null>((resolve, reject) => {
        const child = spawn(process.execPath, [...nodeArgs, entry, ...args], {
          cwd,
          env,
          stdio: ["ignore", stdout.fd, stderr.fd],
          timeout,
        });
        child.once("error", reject);
        child.once("close", resolve);
      });
      return { code, stdout: await readFile(stdoutPath, "utf8"), stderr: await readFile(stderrPath, "utf8") };
    } finally {
      await Promise.all([stdout.close(), stderr.close()]);
    }
  };
  return { directory, state, entry, env, invoke };
}

test.each([
  ["publish", "--manifest", "missing.json", "--key", "synthetic"],
  ["wait", syntheticId],
  ["feedback", syntheticId],
  ["reply", syntheticId, "--status", "explained", "--body", "Synthetic reply"],
  ["mcp"],
  ["stop"],
  ["service", "install"],
  ["update"],
  ["skills", "install"],
])("the real %s entry refuses a runtime inside the repository without touching state", async (...args) => {
  const f = await entryFixture();
  expect(await f.invoke(dirname(dirname(f.entry)), args)).toEqual({
    code: 1,
    stdout: "",
    stderr: `emend: this emend runs from inside the current repository (${escapeReference(f.entry)}); run emend from an install outside the repository.\n`,
  });
  expect(await readdir(f.state)).toEqual([]);
});

test.each([false, true])("a refused entry never loads main.ts (status line %s)", async (statusLine) => {
  const f = await entryFixture();
  const guard = join(f.directory, "guard.mjs");
  await writeFile(
    guard,
    `import { registerHooks } from "node:module";
registerHooks({ resolve(specifier, context, next) {
  if (specifier === "./main.ts") throw new Error("main loaded before refusal");
  return next(specifier, context);
} });\n`,
  );
  const args = statusLine ? ["status", "--line"] : ["stop"];
  expect(await f.invoke(dirname(dirname(f.entry)), args, ["--import", guard])).toEqual({
    code: statusLine ? 0 : 1,
    stdout: "",
    stderr: statusLine
      ? ""
      : `emend: this emend runs from inside the current repository (${escapeReference(f.entry)}); run emend from an install outside the repository.\n`,
  });
  expect(await readdir(f.state)).toEqual([]);
});

test("the real feedback entry allows a working directory outside any repository", async () => {
  const f = await entryFixture();
  const result = await f.invoke(f.directory, ["feedback", syntheticId]);
  expect(result).toEqual({
    code: 1,
    stdout: "",
    stderr: `emend: review ${syntheticId} was deleted or never existed\n`,
  });
});

test.each([false, true])(
  "the real entry fails closed on an invalid repository entry (status line %s)",
  async (statusLine) => {
    const f = await entryFixture();
    const repo = join(f.directory, "repo");
    await mkdir(repo);
    await writeFile(join(repo, ".git"), "not a repository\n");
    expect(await f.invoke(repo, statusLine ? ["status", "--line"] : ["feedback", syntheticId])).toEqual({
      code: statusLine ? 0 : 1,
      stdout: "",
      stderr: statusLine ? "" : "emend: could not check where this emend runs; nothing was changed.\n",
    });
    expect(await readdir(f.state)).toEqual([]);
  },
);

test("the real status line exits silently before a stalled runtime pre-check finishes", async () => {
  const f = await entryFixture();
  const repo = join(f.directory, "repo");
  await mkdir(join(repo, ".git"), { recursive: true });
  await writeFile(join(repo, ".git", "HEAD"), "ref: refs/heads/synthetic-feature\n");
  const guard = join(f.directory, "stalled-precheck.mjs");
  const marker = join(f.directory, "precheck-stalled");
  await writeFile(
    guard,
    `import fs from "node:fs/promises";
import { writeFileSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
const paths = ${JSON.stringify([repo, join(repo, ".git")])};
for (const name of ["lstat", "realpath"]) {
  const original = fs[name];
  fs[name] = async (...args) => {
    if (paths.includes(args[0])) {
      writeFileSync(${JSON.stringify(marker)}, "stalled");
      await new Promise((resolve) => setTimeout(resolve, 6000));
    }
    return original(...args);
  };
}
syncBuiltinESMExports();\n`,
  );
  const started = performance.now();
  const result = await f.invoke(repo, ["status", "--line"], ["--import", guard], 4500);
  const elapsed = performance.now() - started;
  expect(result).toEqual({ code: 0, stdout: "", stderr: "" });
  expect(await readFile(marker, "utf8")).toBe("stalled");
  expect(elapsed).toBeLessThan(4000);
  expect(await readdir(f.state)).toEqual([]);
}, 7000);

test("the real status line exits silently when stdout is already closed", async () => {
  const f = await entryFixture();
  const repo = join(f.directory, "repo");
  await mkdir(repo);
  const git = (...args: string[]) =>
    promisify(execFile)(
      "git",
      [
        "-c",
        "core.hooksPath=/dev/null",
        "-c",
        "commit.gpgSign=false",
        "-c",
        "user.name=Synthetic",
        "-c",
        "user.email=synthetic@example.test",
        ...args,
      ],
      { cwd: repo, env: { ...f.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" } },
    );
  await git("init", "-b", "synthetic-feature");
  await git("commit", "--allow-empty", "-m", "synthetic base");
  const key = Buffer.alloc(32, 3).toString("base64url");
  const requests: string[] = [];
  const server = createServer((request, response) => {
    requests.push(request.url ?? "");
    response.setHeader("Content-Type", "application/json");
    if (request.url === "/api/v1/capabilities") {
      const challenge = request.headers["x-emend-challenge"];
      if (typeof challenge === "string")
        response.setHeader(
          "X-Emend-Proof",
          createHmac("sha256", Buffer.from(key, "base64url")).update(challenge).digest("base64url"),
        );
      response.end(JSON.stringify({ api: 1, version: "0.1.0", features: [AGENT_REVIEW_KEY_FEATURE] }));
    } else if (request.url?.startsWith("/api/v1/agent/reviews?key=")) {
      response.end(
        JSON.stringify({
          items: [
            {
              id: syntheticId,
              title: "Synthetic review",
              branch: "synthetic-feature",
              state: "open",
              turn: "reviewer",
              newest: { revision: 3, head: null },
              approved: null,
              updatedAt: "2026-01-01T00:00:00.000Z",
              url: `http://127.0.0.1:3636/r/${syntheticId}`,
            },
          ],
        }),
      );
    } else {
      response.writeHead(404).end();
    }
  });
  onTestFinished(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("missing fixture server address");
  await Promise.all([
    writeFile(
      join(f.state, "server.json"),
      JSON.stringify({ url: `http://127.0.0.1:${address.port}`, pid: process.pid, key }),
      { mode: 0o600 },
    ),
    writeFile(join(f.state, "instance.json"), JSON.stringify({ id: syntheticId, name: "Synthetic machine" }), {
      mode: 0o600,
    }),
    writeFile(join(f.state, "agent.token"), `em_${"a".repeat(43)}`, { mode: 0o600 }),
  ]);
  // Prove this fixture reaches the write before testing a real closed pipe.
  expect(await f.invoke(repo, ["status", "--line"])).toEqual({
    code: 0,
    stdout: "emend r3 · your turn\n",
    stderr: "",
  });
  const child = spawn(process.execPath, [f.entry, "status", "--line"], {
    cwd: repo,
    env: f.env,
    stdio: ["ignore", "pipe", "pipe"],
    timeout: 5000,
  });
  const stderr: Buffer[] = [];
  child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
  const closed = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (code, signal) => resolve({ code, signal }));
  });
  onTestFinished(async () => {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    await closed;
  });
  child.stdout.destroy();
  expect(await closed).toEqual({ code: 0, signal: null });
  expect(Buffer.concat(stderr).toString()).toBe("");
  expect(requests.filter((url) => url.startsWith("/api/v1/agent/reviews?key="))).toHaveLength(2);
});

test("the CLI prints its version through a symlink without the caller's NODE_OPTIONS preload", async () => {
  const directory = await mkdtemp(join(tmpdir(), "emend-cli-test-"));
  const previous = process.env.NODE_OPTIONS;
  try {
    const marker = join(directory, "preload-ran");
    const preload = join(directory, "preload.cjs");
    await writeFile(preload, `require("node:fs").writeFileSync(${JSON.stringify(marker)}, "ran");\n`);
    process.env.NODE_OPTIONS = `--require ${JSON.stringify(preload)}`;
    const entry = join(directory, "cli.ts");
    await symlink(fileURLToPath(new URL("./cli.ts", import.meta.url)), entry);
    const stdout = execFileSync(process.execPath, [entry, "--version"], {
      encoding: "utf8",
      env: { PATH: directory, HOME: directory, EMEND_HOME: join(directory, "state"), LC_ALL: "C" },
    });
    expect(stdout).toBe("emend 0.1.0\n");
    await expect(access(marker)).rejects.toMatchObject({ code: "ENOENT" });
  } finally {
    if (previous === undefined) delete process.env.NODE_OPTIONS;
    else process.env.NODE_OPTIONS = previous;
    await rm(directory, { recursive: true, force: true });
  }
});

test.each([129, 130, 131, 143])("the real entry exits immediately after interruption %s", async (code) => {
  const f = await entryFixture();
  const guard = join(f.directory, "interrupted.mjs");
  await writeFile(
    guard,
    `import { registerHooks } from "node:module";
registerHooks({ load(url, context, next) {
  if (url.endsWith("/main.ts")) return { format: "module", shortCircuit: true,
    source: "export async function run() { setTimeout(() => process.exit(99), 100); return ${code}; }" };
  return next(url, context);
} });`,
  );
  expect(await f.invoke(f.directory, ["update"], ["--import", guard])).toEqual({ code, stdout: "", stderr: "" });
});

test("the real status line exits after flushing even with a lingering handle", async () => {
  const f = await entryFixture();
  const guard = join(f.directory, "lingering.mjs");
  const source = `export async function run(argv, io) {
  await io.stdoutAsync("emend r3 · your turn\\n");
  setTimeout(() => process.exit(99), 100);
  return 0;
}`;
  await writeFile(
    guard,
    `import { registerHooks } from "node:module";
registerHooks({ load(url, context, next) {
  if (url.endsWith("/main.ts")) return { format: "module", shortCircuit: true,
    source: ${JSON.stringify(source)} };
  return next(url, context);
} });`,
  );
  expect(await f.invoke(f.directory, ["status", "--line"], ["--import", guard])).toEqual({
    code: 0,
    stdout: "emend r3 · your turn\n",
    stderr: "",
  });
});
