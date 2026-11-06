import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  BRANCH_PREFIX,
  branchName,
  commitSha,
  issueFromBranch,
  issueNumber,
  oneLine,
  parseFlags,
  prNumber,
  refName,
  slug,
  TASK_BRANCH_PREFIX,
  taskFromBranch,
  taskNumber,
  textArg,
  WtError,
} from "./validate.ts";

function refuses(fn: () => unknown, input: string): void {
  assert.throws(fn, (e: unknown) => {
    assert.ok(e instanceof WtError);
    assert.equal(e.code, 2);
    // Inputs shorter than 3 characters could appear in a fixed message by chance.
    if (input.length >= 3) assert.equal(e.message.includes(input), false, "the message must not echo the input");
    return true;
  });
}

test("validators refuse without echoing", () => {
  for (const bad of [
    "main",
    "a b",
    "$X",
    "-x",
    "a..b",
    "a//b",
    "a/",
    ".a",
    "a/.b",
    "x.lock",
    "A",
    "",
    "a".repeat(64),
  ]) {
    refuses(() => branchName(bad), bad || "<empty>");
  }
  for (const bad of ["a", "a-b-c-d-e-f", "A-b", "a_b", "-a-b"]) refuses(() => slug(bad), bad);
  for (const bad of ["0", "01", "12345678", "1a", "-1"]) refuses(() => prNumber(bad), bad);
  for (const bad of ["abc", "g".repeat(40), "A".repeat(40), "a".repeat(39)]) refuses(() => commitSha(bad), bad);
  for (const bad of ["000", "099", "12", "1234", "abc"]) refuses(() => taskNumber(bad), bad);
  for (const bad of ["-x", "a..b", "a b", "$X"]) refuses(() => refName(bad), bad);
});

test("validators accept the documented forms", () => {
  assert.equal(branchName("feat-a"), "feat-a");
  assert.equal(branchName("fix/inbox"), "fix/inbox");
  assert.equal(branchName("013-parallel-work"), "013-parallel-work");
  assert.equal(slug("parallel-work"), "parallel-work");
  assert.equal(prNumber("1234567"), 1234567);
  assert.equal(commitSha("a".repeat(40)), "a".repeat(40));
  assert.equal(taskNumber("001"), "001");
  assert.equal(taskNumber("098"), "098");
  assert.equal(refName("origin/main"), "origin/main");
});

test("task branch parsing accepts the task namespace and legacy prefixes without confusing issue numbers", () => {
  assert.equal(BRANCH_PREFIX, "emend-");
  assert.equal(TASK_BRANCH_PREFIX, "emend-task-");
  for (const prefix of ["", BRANCH_PREFIX, TASK_BRANCH_PREFIX]) {
    for (const n of ["001", "014", "098"]) assert.equal(taskFromBranch(`${prefix}${n}-some-task`), n);
  }
  for (const branch of [
    "emend-14-some-issue",
    "emend-100-some-issue",
    "emend-099-some-issue",
    "emend-000-no-task",
    "other-014-task",
    "emend-014-",
    "emend-014-x/y",
  ])
    assert.equal(taskFromBranch(branch), null);
  assert.equal(issueNumber("42"), 42);
  for (const s of ["0", "042", "1.2", "-1", "1x", ""]) refuses(() => issueNumber(s), s || "<empty>");
});

test("parseFlags handles the three flag forms and refuses the rest, naming the option but not the value", () => {
  const spec = { json: "boolean", from: "string", body: "string", brief: "string", title: "string" } as const;
  const ok = parseFlags(["--json", "--from", "origin/x", "br"], spec, 1);
  assert.deepEqual(ok.flags, { json: true, from: "origin/x" });
  assert.deepEqual(ok.positionals, ["br"]);
  assert.equal(parseFlags(["--from=a"], spec).flags.from, "a");
  refuses(() => parseFlags(["--repo", "x/y"], spec), "x/y");
  refuses(() => parseFlags(["--from"], spec), "x/y");
  refuses(() => parseFlags(["--from", "-x"], spec), "-xyz");
  refuses(() => parseFlags(["--json", "--json"], spec), "x/y");
  refuses(() => parseFlags(["--json=1"], spec), "x/y");
  refuses(() => parseFlags(["-j"], spec), "-j");
  refuses(() => parseFlags(["a", "b"], spec, 1), "b");
  const named = (args: string[]): string => {
    try {
      parseFlags(args, spec);
    } catch (e) {
      return (e as Error).message;
    }
    return "";
  };
  assert.match(named(["--repo", "x"]), /--repo/);
  assert.match(named(["--from"]), /--from/);
  assert.match(named(["--from", "-x"]), /--from/);
  assert.match(named(["--json", "--json"]), /--json/);
});

test("free-text flags take a value that starts with a dash verbatim", () => {
  const spec = { body: "string", brief: "string", title: "string", subject: "string", from: "string" } as const;
  assert.equal(parseFlags(["--body", "- a\n- b"], spec).flags.body, "- a\n- b");
  const brief = "---\nid: 012\ntitle: x\n---\n";
  assert.equal(parseFlags(["--brief", brief], spec).flags.brief, brief);
  assert.equal(parseFlags(["--title", "-x"], spec).flags.title, "-x");
  assert.equal(parseFlags(["--subject", "--odd"], spec).flags.subject, "--odd");
  refuses(() => parseFlags(["--from", "---"], spec), "xyz");
});

test("oneLine accepts one printable line of 1 to 72 characters and refuses control characters", () => {
  assert.equal(oneLine("feat: a\n", "subject"), "feat: a");
  for (const bad of ["", "a\nb", "a\u001bb", "a\tb", "a\u007fb", "x".repeat(73)]) {
    assert.throws(
      () => oneLine(bad, "subject"),
      (e: unknown) => e instanceof WtError && e.code === 2,
    );
  }
});

test("textArg returns text, reads a file, and refuses bad combinations", () => {
  const dir = mkdtempSync(join(tmpdir(), "wt-textarg-"));
  try {
    const file = join(dir, "t.md");
    writeFileSync(file, "from file\n");
    assert.equal(textArg("inline", undefined, "body", true), "inline");
    assert.equal(textArg("", undefined, "body", true), "");
    assert.equal(textArg(undefined, file, "body", true), "from file\n");
    assert.equal(textArg(undefined, undefined, "body", false), null);
    assert.throws(
      () => textArg(undefined, undefined, "body", true),
      (e: unknown) => e instanceof WtError && e.code === 2,
    );
    assert.throws(
      () => textArg("a", file, "body", false),
      (e: unknown) => e instanceof WtError && e.code === 2,
    );
    const link = join(dir, "link.md");
    symlinkSync(file, link);
    assert.throws(() => textArg(undefined, link, "body", true), WtError);
    for (const bad of [join(dir, "missing.md"), dir]) {
      assert.throws(
        () => textArg(undefined, bad, "body", true),
        (e: unknown) => e instanceof WtError && e.code === 2,
      );
    }
    mkdirSync(join(dir, "d"));
    const big = join(dir, "big.md");
    writeFileSync(big, Buffer.alloc(1024 * 1024 + 1, 97));
    assert.throws(
      () => textArg(undefined, big, "body", true),
      (e: unknown) => e instanceof WtError && e.code === 2,
    );
    const ok = join(dir, "ok.md");
    writeFileSync(ok, Buffer.alloc(1024 * 1024, 97));
    assert.equal(textArg(undefined, ok, "body", true)?.length, 1024 * 1024);
    const bin = join(dir, "bin.md");
    writeFileSync(bin, Buffer.from([0xff, 0xfe]));
    assert.throws(
      () => textArg(undefined, bin, "body", true),
      (e: unknown) => e instanceof WtError && e.code === 2,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("issue branch parsing treats an unrepresentable number as no inferred issue", () => {
  for (const digits of ["99999999999999999999", "9007199254740992"]) {
    assert.equal(issueFromBranch(`emend-${digits}-x`), null);
    refuses(() => issueNumber(digits), digits);
  }
  assert.equal(issueFromBranch("emend-42-x"), 42);
  assert.equal(issueFromBranch("emend-9007199254740991-x"), Number.MAX_SAFE_INTEGER);
  assert.equal(issueFromBranch("emend-042-x"), null);
  assert.equal(issueFromBranch("emend-task-042-x"), null);
});
