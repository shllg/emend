import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { type Fixture, fakeGithubOrigin, type TestEnv } from "./test-support.ts";

const GITHUB_ORIGIN = "https://github.com/owner/repo.git\n";
const BYTES = Buffer.from([0x00, 0xff, 0xe9, 0x0a, 0x80]);

/** Exercise the Git wrapper with a synthetic executable, without a repository or transport. */
function scenario(
  fn: (env: TestEnv, fx: Fixture, output: (fetch: string, push?: string, code?: number) => void) => void,
): void {
  const root = mkdtempSync(join(tmpdir(), "wt-origin-wrapper-"));
  const env: TestEnv = {
    root,
    home: root,
    fakeBin: join(root, "bin"),
    realPath: "",
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
  try {
    mkdirSync(env.fakeBin);
    const fx: Fixture = { env, main: root, origin: join(root, "origin.git") };
    const plan = join(root, "output.json");
    const output = (fetch: string, push = fetch, code = 0) =>
      writeFileSync(plan, JSON.stringify({ fetch, push, code }));
    output(`${fx.origin}\n`);
    const executable = join(root, "synthetic-git");
    writeFileSync(
      executable,
      `#!${process.execPath}
const {readFileSync} = require("node:fs");
const args = process.argv.slice(2);
if (args.includes("get-url")) {
  const plan = JSON.parse(readFileSync(${JSON.stringify(plan)}, "utf8"));
  process.stdout.write(args.includes("--push") ? plan.push : plan.fetch);
  if (plan.code) process.stderr.write("synthetic URL failure\\n");
  process.exitCode = plan.code;
} else if (args.includes("ls-remote")) {
  process.stdout.write("${"a".repeat(40)}\\trefs/heads/main\\n");
} else if (args.includes("--stdin") || args.some(arg => arg.startsWith("--batch-check"))) {
  process.stdout.write(readFileSync(0));
} else {
  process.stdout.write(Buffer.from(${JSON.stringify([...BYTES])}));
  process.stderr.write(Buffer.from(${JSON.stringify([...BYTES])}));
  process.exitCode = 17;
}
`,
      { mode: 0o755 },
    );
    symlinkSync(executable, join(env.fakeBin, "git"));
    fakeGithubOrigin(env, fx);
    fn(env, fx, output);
  } finally {
    env.cleanup();
  }
}

test("fakeGithubOrigin keeps fetch and push URL queries consistent for the public gate", () =>
  scenario((env) => {
    for (const options of [[], ["--all"], ["--push"], ["--push", "--all"], ["--all", "--push"]]) {
      const result = spawnSync(join(env.fakeBin, "git"), ["-C", env.root, "remote", "get-url", ...options, "origin"]);
      assert.equal(result.status, 0);
      assert.deepEqual(result.stdout, Buffer.from(GITHUB_ORIGIN));
      assert.equal(result.stderr.length, 0);
    }
  }));

test("fakeGithubOrigin lets the public gate read destination refs", () =>
  scenario((env) => {
    const gate = new URL("../../../scripts/check-public.ts", import.meta.url).href;
    const result = spawnSync(
      process.execPath,
      [
        "--input-type=module",
        "-e",
        `import {readPushDestination} from ${JSON.stringify(gate)};
const destination = readPushDestination(process.cwd());
console.log(JSON.stringify({url: destination.url, refs: [...destination.refs]}));`,
      ],
      { cwd: env.root, env: { PATH: env.fakeBin }, encoding: "utf8" },
    );
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stderr, "");
    assert.deepEqual(JSON.parse(result.stdout), {
      url: GITHUB_ORIGIN.trimEnd(),
      refs: [["refs/heads/main", "a".repeat(40)]],
    });
  }));

test("fakeGithubOrigin preserves changed and multiple URLs and other remotes", () =>
  scenario((env, fx, output) => {
    const git = join(env.fakeBin, "git");
    const changed = `${fx.origin}-changed\n`;
    output(changed);
    assert.equal(spawnSync(git, ["remote", "get-url", "origin"]).stdout.toString(), changed);
    output(`${fx.origin}\n`, changed);
    assert.equal(spawnSync(git, ["remote", "get-url", "--push", "--all", "origin"]).stdout.toString(), changed);
    output(`${fx.origin}\n`, `${fx.origin}\n${changed}`);
    assert.equal(
      spawnSync(git, ["remote", "get-url", "--push", "--all", "origin"]).stdout.toString(),
      `${GITHUB_ORIGIN}${changed}`,
    );
    assert.equal(spawnSync(git, ["remote", "get-url", "other"]).stdout.toString(), `${fx.origin}\n`);
  }));

test("fakeGithubOrigin preserves failed URL queries and their diagnostics", () =>
  scenario((env, fx, output) => {
    output(`${fx.origin}\n`, `${fx.origin}\n`, 23);
    const result = spawnSync(join(env.fakeBin, "git"), ["remote", "get-url", "origin"]);
    assert.equal(result.status, 23);
    assert.equal(result.stdout.toString(), `${fx.origin}\n`);
    assert.equal(result.stderr.toString(), "synthetic URL failure\n");
  }));

for (const args of [
  ["cat-file", "--batch-check=%(objectname) %(objecttype)"],
  ["rev-list", "--stdin"],
]) {
  test(`fakeGithubOrigin forwards stdin unchanged to ${args[0]}`, () =>
    scenario((env) => {
      const input = Buffer.from(`${"a".repeat(40)}\n^${"b".repeat(40)}\n`);
      const result = spawnSync(join(env.fakeBin, "git"), args, { input });
      assert.equal(result.status, 0);
      assert.deepEqual(result.stdout, input);
      assert.equal(result.stderr.length, 0);
    }));
}

test("fakeGithubOrigin preserves binary stdout, stderr and exit status", () =>
  scenario((env) => {
    const result = spawnSync(join(env.fakeBin, "git"), ["cat-file", "blob", "synthetic-object"]);
    assert.equal(result.status, 17);
    assert.deepEqual(result.stdout, BYTES);
    assert.deepEqual(result.stderr, BYTES);
  }));

test("fakeGithubOrigin can be restored after a temporary Git replacement", () =>
  scenario((env) => {
    const git = join(env.fakeBin, "git");
    const original = realpathSync(git);
    rmSync(git);
    writeFileSync(git, "synthetic temporary replacement");
    rmSync(git);
    symlinkSync(original, git);
    const result = spawnSync(git, ["remote", "get-url", "origin"]);
    assert.equal(result.error, undefined);
    assert.equal(result.status, 0);
    assert.equal(result.stdout.toString(), GITHUB_ORIGIN);
  }));
