import assert from "node:assert/strict";
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
