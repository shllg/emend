import assert from "node:assert/strict";
import childProcess, { type SpawnSyncOptions } from "node:child_process";
import { syncBuiltinESMExports } from "node:module";
import { test } from "node:test";
import { run, runBytes } from "./proc.ts";

test("run returns output and exit code without a shell", () => {
  const r = run(process.execPath, ["-e", "process.stdout.write(process.argv[1]); process.exit(3)", "$HOME;x"], {
    cwd: "/",
  });
  assert.equal(r.code, 3);
  assert.equal(r.stdout, "$HOME;x");
});

test("runBytes returns exact bytes and passes Buffer input unchanged", () => {
  const input = Buffer.from([0x00, 0xff, 0xe9, 0x0a, 0x80]);
  const r = runBytes(process.execPath, ["-e", "process.stdin.pipe(process.stdout)"], { cwd: "/", input });
  assert.equal(r.code, 0);
  assert.ok(r.stdout.equals(input));
});

test("run passes input, keeps the caller's environment and fixes prompts and pagers", () => {
  process.env.WT_TEST_KEEP = "kept";
  try {
    const r = run(
      process.execPath,
      [
        "-e",
        "const e = process.env; process.stdout.write([e.WT_TEST_KEEP, e.GIT_TERMINAL_PROMPT, e.GH_PROMPT_DISABLED, e.GH_NO_UPDATE_NOTIFIER, e.GH_PAGER, e.GIT_PAGER, e.PAGER, e.LC_ALL, require('fs').readFileSync(0, 'utf8')].join(':'))",
      ],
      { cwd: "/", input: "in" },
    );
    assert.equal(r.stdout, "kept:0:1:1:cat:cat:cat:C.UTF-8:in");
  } finally {
    delete process.env.WT_TEST_KEEP;
  }
});

test("run does not pass GIT_DIFF_OPTS to the child", () => {
  const previous = process.env.GIT_DIFF_OPTS;
  try {
    process.env.GIT_DIFF_OPTS = "--unified=0";
    const r = run(process.execPath, ["-e", 'process.stdout.write(process.env.GIT_DIFF_OPTS ?? "unset")'], {
      cwd: "/",
    });
    assert.equal(r.code, 0);
    assert.equal(r.stdout, "unset");
  } finally {
    if (previous === undefined) delete process.env.GIT_DIFF_OPTS;
    else process.env.GIT_DIFF_OPTS = previous;
  }
});

test("run reports a missing program as 127 and a timeout as 124", () => {
  assert.equal(run("wt-no-such-program", [], { cwd: "/" }).code, 127);
  const slow = run(process.execPath, ["-e", "setTimeout(() => {}, 5000)"], { cwd: "/", timeoutMs: 200 });
  assert.equal(slow.code, 124);
});

test("regression: every process helper strips the private terms environment", (t) => {
  const parent = { EMEND_PRIVATE_TERMS: "fixturecorp" };
  t.mock.property(process, "env", parent);
  const spy = t.mock.method(childProcess, "spawnSync", (...args: unknown[]) => {
    const options = args[2] as { env: NodeJS.ProcessEnv; encoding: string };
    assert.equal(Object.hasOwn(options.env, "EMEND_PRIVATE_TERMS"), false);
    assert.equal(options.env.GIT_TERMINAL_PROMPT, "0");
    return { status: 0, stdout: options.encoding === "buffer" ? Buffer.alloc(0) : "", stderr: "" };
  });
  syncBuiltinESMExports();
  try {
    for (const execute of [run, runBytes]) {
      const result = execute("fixture-command", [], { cwd: "/" });
      assert.equal(result.code, 0);
    }
    assert.equal(spy.mock.callCount(), 2);
    assert.deepEqual(parent, { EMEND_PRIVATE_TERMS: "fixturecorp" });
  } finally {
    spy.mock.restore();
    syncBuiltinESMExports();
  }
});

test("R9.3: every process helper removes Git config override variables", (t) => {
  const values = {
    GIT_CONFIG_COUNT: "1",
    GIT_CONFIG_KEY_0: "user.name",
    GIT_CONFIG_VALUE_0: "Synthetic User",
    GIT_CONFIG_PARAMETERS: "'user.name=Synthetic User'",
    GIT_CONFIG_GLOBAL: "/nonexistent",
    GIT_CONFIG_SYSTEM: "/nonexistent",
    GIT_CONFIG_NOSYSTEM: "1",
  };
  const previous = { ...process.env };
  Object.assign(process.env, values);
  const spy = t.mock.method(childProcess, "spawnSync", (...args: unknown[]) => {
    const options = args[2] as { env: NodeJS.ProcessEnv; encoding: string };
    for (const key of Object.keys(values)) assert.equal(Object.hasOwn(options.env, key), false);
    return { status: 0, stdout: options.encoding === "buffer" ? Buffer.alloc(0) : "", stderr: "" };
  });
  syncBuiltinESMExports();
  try {
    for (const execute of [run, runBytes]) assert.equal(execute("git", [], { cwd: "/" }).code, 0);
    assert.equal(spy.mock.callCount(), 2);
  } finally {
    spy.mock.restore();
    syncBuiltinESMExports();
    for (const key of Object.keys(values)) {
      if (previous[key] === undefined) delete process.env[key];
      else process.env[key] = previous[key];
    }
  }
});

for (const execute of [run, runBytes]) {
  test(`${execute.name} strips GH_REPO from the child without changing the parent`, () => {
    const previous = process.env.GH_REPO;
    try {
      process.env.GH_REPO = "synthetic/wrong-repository";
      const result = execute(process.execPath, ["-e", 'process.stdout.write(process.env.GH_REPO ?? "unset")'], {
        cwd: "/",
      });
      assert.equal(result.code, 0);
      assert.equal(result.stdout.toString(), "unset");
      assert.equal(process.env.GH_REPO, "synthetic/wrong-repository");
    } finally {
      if (previous === undefined) delete process.env.GH_REPO;
      else process.env.GH_REPO = previous;
    }
  });
}

for (const execute of [run, runBytes]) {
  for (const command of ["gh", "git"]) {
    test(`${execute.name} gives ${command} a plain-output environment`, (t) => {
      const parent = {
        GH_FORCE_TTY: "120",
        CLICOLOR_FORCE: "1",
        FORCE_COLOR: "3",
        NO_COLOR: "0",
        CLICOLOR: "1",
        GH_NO_UPDATE_NOTIFIER: "0",
        GH_REPO: "synthetic/wrong-repository",
        GH_HOST: "example.invalid",
        EMEND_PRIVATE_TERMS: "fixturecorp",
        GIT_CONFIG_PARAMETERS: "'user.name=Synthetic User'",
        GIT_DIFF_OPTS: "--unified=0",
      };
      const original = { ...parent };
      t.mock.property(process, "env", parent);
      const spy = t.mock.method(
        childProcess,
        "spawnSync",
        (receivedCommand: string, args: string[], options: SpawnSyncOptions) => {
          assert.equal(receivedCommand, command);
          assert.deepEqual(args, ["--version"]);
          assert.ok(options.env);
          for (const key of [
            "GH_FORCE_TTY",
            "CLICOLOR_FORCE",
            "FORCE_COLOR",
            "GH_REPO",
            "GH_HOST",
            "EMEND_PRIVATE_TERMS",
            "GIT_CONFIG_PARAMETERS",
            "GIT_DIFF_OPTS",
          ])
            assert.equal(Object.hasOwn(options.env, key), false, `${key} must not reach ${command}`);
          assert.equal(options.env.NO_COLOR, "1");
          assert.equal(options.env.CLICOLOR, "0");
          assert.equal(options.env.GH_NO_UPDATE_NOTIFIER, "1");
          return { status: 0, stdout: options.encoding === "buffer" ? Buffer.alloc(0) : "", stderr: "" };
        },
      );
      syncBuiltinESMExports();
      try {
        assert.equal(execute(command, ["--version"], { cwd: "/" }).code, 0);
        assert.equal(spy.mock.callCount(), 1);
        assert.deepEqual(parent, original);
      } finally {
        spy.mock.restore();
        syncBuiltinESMExports();
      }
    });
  }
}
