import assert from "node:assert/strict";
import { chmodSync, mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import { delimiter, join, relative } from "node:path";
import { test } from "node:test";
import { assertEmendEnv, emendProgram, readApproval } from "./approval.ts";
import { type Repo, resolveRepo } from "./repo.ts";
import {
  approvedReview,
  fakeCalls,
  gitIn,
  installFake,
  installFakeEmend,
  makeFixture,
  makeTestEnv,
  runWt,
  type TestEnv,
} from "./test-support.ts";

const sha = "a".repeat(40);
const branch = "feat-a";
const approved = approvedReview(branch, sha);
const stale = { ...approved, newest: { revision: 2, head: "b".repeat(40) } };
const published = { ...approved, state: "open", approved: null };
const otherBranch = { ...approved, branch: "feat-b" };

function scenario(fn: (env: TestEnv, repo: Repo) => void): void {
  const env = makeTestEnv({ ports: false });
  try {
    const mainRoot = join(env.root, "repo");
    mkdirSync(mainRoot);
    fn(env, {
      mainRoot,
      commonDir: join(mainRoot, ".git"),
      worktreesDir: join(mainRoot, ".claude/worktrees"),
      callerTop: mainRoot,
      callerBranch: branch,
    });
  } finally {
    env.cleanup();
  }
}

test("approval checks every item and accepts a current approval on this branch", () =>
  scenario((env, repo) => {
    installFakeEmend(env, sha, [otherBranch, published, stale, approved]);
    assert.deepEqual(readApproval(repo, branch, sha), { ok: true, reviewId: approved.id, revision: 1 });
    assert.deepEqual(fakeCalls(env, "emend"), [["ls", "--json", "--head", sha]]);
  }));

test("approval reports the first applicable reason", () =>
  scenario((env, repo) => {
    for (const [items, reason] of [
      [[otherBranch, published, stale], "a newer revision was published after the approval"],
      [[otherBranch, published], "published, not approved"],
      [[{ ...approved, state: "settled" }], "published, not approved"],
      [[otherBranch, { ...approved, branch: null }], "the review of this commit names another branch"],
      [[{ ...approved, approved: null, newest: null }], "no review of this commit"],
      [[], "no review of this commit"],
    ] as const) {
      installFakeEmend(env, sha, [...items]);
      assert.deepEqual(readApproval(repo, branch, sha), { ok: false, reason });
    }
  }));

test("approval rejects malformed JSON and a malformed row even after a valid approval", () =>
  scenario((env, repo) => {
    const badLists = ["non-JSON", "null", "[]", '{"items":{}}', JSON.stringify({ items: Array(1001).fill(approved) })];
    for (const invalid of [
      null,
      [],
      { ...approved, id: "review" },
      { ...approved, branch: 3 },
      { ...approved, state: null },
      { ...approved, newest: undefined },
      { ...approved, approved: undefined },
      { ...approved, newest: { revision: 0, head: sha } },
      { ...approved, approved: { revision: 1.5, head: sha } },
      { ...approved, approved: { revision: 1, head: 3 } },
    ])
      badLists.push(JSON.stringify({ items: [approved, invalid] }));
    for (const stdout of badLists) {
      installFake(env, "emend", [{ stdout }]);
      assert.throws(() => readApproval(repo, branch, sha), {
        code: 69,
        message: "emend returned a review list bin/wt cannot read.",
      });
    }
  }));

test("approval validates the SHA first, then requires an installed executable", () =>
  scenario((env, repo) => {
    const lookup = () => readApproval(repo, branch, sha);
    assert.throws(() => readApproval(repo, branch, "short"), { code: 2, message: "Invalid commit id." });
    const missing = "emend is not on PATH. Install emend, or set EMEND_BIN to its absolute path.";
    assert.throws(lookup, { code: 69, message: missing });
    installFake(env, "emend", [{ code: 127 }]);
    assert.throws(lookup, { code: 69, message: missing });
    process.env.EMEND_BIN = "emend";
    assert.throws(lookup, { code: 2, message: "EMEND_BIN must be an absolute path." });
    process.env.EMEND_BIN = join(env.fakeBin, "emend");
    const invalid = "EMEND_BIN does not name an executable file.";
    assert.throws(lookup, { code: 69, message: invalid });
    chmodSync(process.env.EMEND_BIN, 0o600);
    assert.throws(lookup, { code: 69, message: invalid });
    process.env.EMEND_BIN = env.fakeBin;
    assert.throws(lookup, { code: 69, message: invalid });
  }));

test("approval maps old emend, timeout and other failures to dependency errors", () =>
  scenario((env, repo) => {
    const lookup = () => readApproval(repo, branch, sha);
    installFake(env, "emend", [{ code: 2, stderr: "Usage: emend ls [--json].\n" }]);
    for (const source of ["on PATH", "in EMEND_BIN"]) {
      if (source === "in EMEND_BIN") process.env.EMEND_BIN = join(env.fakeBin, "emend");
      assert.throws(lookup, {
        code: 69,
        message: `The emend ${source} is too old to report approvals; it needs 0.8.0 or later. Update it, or set EMEND_BIN.`,
      });
    }
    installFake(env, "emend", [{ code: 124 }]);
    assert.throws(lookup, { code: 69, message: "emend did not answer within 30 seconds." });
    installFake(env, "emend", [{ code: 1, stderr: `\x1b[31mfailed\x07\t${"x".repeat(210)}\nsecond line\n` }]);
    assert.throws(lookup, { code: 69, message: `emend ls failed: failed ${"x".repeat(193)}` });
    installFake(env, "emend", [{ code: 1, stderr: `Authorization: Bearer ${"x".repeat(20)}\nsecond line\n` }]);
    assert.throws(lookup, { code: 69, message: "emend ls failed: [line withheld: secret shape]" });
  }));

test("approval runs the selected shim by its invoked name from HOME and honors EMEND_BIN", () =>
  scenario((env, repo) => {
    const shim = join(env.fakeBin, "shim");
    writeFileSync(
      shim,
      '#!/bin/sh\n[ "$0" = "$HOME/emend" ] && [ "$PWD" = "$HOME" ] || exit 1\nprintf \'%s\\n\' \'{"items":[]}\'\n',
      { mode: 0o755 },
    );
    const selected = join(env.home, "emend");
    symlinkSync(shim, selected);
    installFakeEmend(env, sha, [approved]);
    process.env.PATH = ["", relative(process.cwd(), env.fakeBin), env.home, env.fakeBin].join(delimiter);
    assert.equal(emendProgram(repo), selected);
    assert.deepEqual(readApproval(repo, branch, sha), { ok: false, reason: "no review of this commit" });
    process.env.EMEND_BIN = selected;
    process.env.PATH = env.fakeBin;
    assert.deepEqual(readApproval(repo, branch, sha), { ok: false, reason: "no review of this commit" });
    assert.deepEqual(fakeCalls(env, "emend"), []);
  }));

test("approval refuses executables in the repository, including through a symlink on PATH", () =>
  scenario((env, repo) => {
    const executable = join(repo.mainRoot, "emend");
    writeFileSync(executable, "#!/bin/sh\nexit 7\n", { mode: 0o755 });
    symlinkSync(executable, join(env.fakeBin, "emend"));
    for (const override of ["", executable]) {
      process.env.EMEND_BIN = override;
      assert.throws(() => readApproval(repo, branch, sha), {
        code: 69,
        message:
          "The emend program lies inside this repository. bin/wt reads approvals only through an installed emend.",
      });
    }
  }));

function folderRefusal(name: string) {
  return {
    code: 69,
    message: `emend's ${name} folder lies inside this repository. bin/wt reads approvals only from your own emend state.`,
  };
}

test("approval rejects the effective folders in the repository or under a symlink to it", () =>
  scenario((env, repo) => {
    installFakeEmend(env, sha, [approved]);
    const alias = join(env.root, "alias");
    symlinkSync(repo.mainRoot, alias);
    for (const [name, folder] of [
      ["EMEND_HOME", "state"],
      ["XDG_CONFIG_HOME", "config"],
      ["XDG_DATA_HOME", "state"],
      ["HOME", "home"],
    ] as const) {
      if (name === "XDG_DATA_HOME" && process.platform === "darwin") continue;
      for (const path of [repo.mainRoot, join(repo.worktreesDir, branch, ".wt/home"), alias, join(alias, "new")]) {
        process.env[name] = path;
        assert.throws(() => readApproval(repo, branch, sha), folderRefusal(folder));
      }
      process.env[name] = `${repo.mainRoot}-other`;
      assert.doesNotThrow(() => assertEmendEnv(repo));
      delete process.env[name];
    }
    assert.deepEqual(fakeCalls(env, "emend"), []);
  }));

test("approval checks the emend child of each XDG folder and honors the state override", () =>
  scenario((env, repo) => {
    const xdg = join(env.root, "xdg");
    mkdirSync(xdg);
    symlinkSync(repo.mainRoot, join(xdg, "emend"));
    process.env.XDG_CONFIG_HOME = xdg;
    assert.throws(() => assertEmendEnv(repo), folderRefusal("config"));
    delete process.env.XDG_CONFIG_HOME;
    process.env.XDG_DATA_HOME = xdg;
    if (process.platform === "darwin") assert.doesNotThrow(() => assertEmendEnv(repo));
    else assert.throws(() => assertEmendEnv(repo), folderRefusal("state"));
    process.env.EMEND_HOME = join(env.home, "state");
    assert.doesNotThrow(() => assertEmendEnv(repo));
    process.env.EMEND_HOME = "relative";
    assert.throws(() => assertEmendEnv(repo), { code: 69, message: "EMEND_HOME must be an absolute path." });
  }));

test("approval checks the home defaults when XDG settings are missing or relative", () =>
  scenario((env, repo) => {
    const config = join(env.home, ".config");
    mkdirSync(config);
    symlinkSync(repo.mainRoot, join(config, "emend"));
    assert.throws(() => assertEmendEnv(repo), folderRefusal("config"));
    process.env.XDG_CONFIG_HOME = "relative";
    assert.throws(() => assertEmendEnv(repo), folderRefusal("config"));
    process.env.XDG_CONFIG_HOME = env.root;
    const data =
      process.platform === "darwin"
        ? join(env.home, "Library", "Application Support")
        : join(env.home, ".local", "share");
    mkdirSync(data, { recursive: true });
    symlinkSync(repo.mainRoot, join(data, "emend"));
    assert.throws(() => assertEmendEnv(repo), folderRefusal("state"));
    process.env.XDG_DATA_HOME = "relative";
    assert.throws(() => assertEmendEnv(repo), folderRefusal("state"));
  }));

test("approval command checks HEAD or an explicit head in a linked worktree", async () => {
  const env = makeTestEnv({ ports: false });
  try {
    const { main } = makeFixture(env, { withBin: true });
    const wt = join(resolveRepo(main).worktreesDir, branch);
    gitIn(main, "worktree", "add", "-q", "-b", branch, wt);
    const launcher = join(main, "bin/wt");
    const head = gitIn(wt, "rev-parse", "HEAD");
    const item = approvedReview(branch, head);
    installFakeEmend(env, head, [item]);
    assert.deepEqual(await runWt(launcher, ["approval"], { cwd: wt }), {
      code: 0,
      stdout: `approved ${head} review ${item.id} revision 1\n`,
      stderr: "",
    });
    installFakeEmend(env, sha, []);
    assert.deepEqual(await runWt(launcher, ["approval", "--head", sha], { cwd: wt }), {
      code: 1,
      stdout: "not approved: no review of this commit\n",
      stderr: "",
    });
    assert.deepEqual(await runWt(launcher, ["approval"], { cwd: main }), {
      code: 2,
      stdout: "",
      stderr: "Run this from inside a linked worktree.\n",
    });
    assert.deepEqual(fakeCalls(env, "emend"), [["ls", "--json", "--head", sha]]);
  } finally {
    env.cleanup();
  }
});
