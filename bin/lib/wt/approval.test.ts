import assert from "node:assert/strict";
import { chmodSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { delimiter, join, relative } from "node:path";
import { test } from "node:test";
import { assertRecenseEnv, readApproval, recenseProgram } from "./approval.ts";
import { type Repo, resolveRepo } from "./repo.ts";
import {
  approvedReview,
  fakeCalls,
  gitIn,
  installFake,
  installFakeRecense,
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
    gitIn(env.root, "init", "--quiet", "repo");
    fn(env, resolveRepo(join(env.root, "repo")));
  } finally {
    env.cleanup();
  }
}

test("approval checks every item and accepts a current approval on this branch", () =>
  scenario((env, repo) => {
    installFakeRecense(env, sha, [otherBranch, published, stale, approved]);
    assert.deepEqual(readApproval(repo, branch, sha), { ok: true, reviewId: approved.id, revision: 1 });
    assert.deepEqual(fakeCalls(env, "recense"), [["ls", "--json", "--head", sha]]);
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
      installFakeRecense(env, sha, [...items]);
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
      installFake(env, "recense", [{ stdout }]);
      assert.throws(() => readApproval(repo, branch, sha), {
        code: 69,
        message: "recense returned a review list bin/wt cannot read.",
      });
    }
  }));

test("approval validates the SHA first, then requires an installed executable", () =>
  scenario((env, repo) => {
    const lookup = () => readApproval(repo, branch, sha);
    assert.throws(() => readApproval(repo, branch, "short"), { code: 2, message: "Invalid commit id." });
    const missing = "recense is not on PATH. Install recense, or set RECENSE_BIN to its absolute path.";
    assert.throws(lookup, { code: 69, message: missing });
    installFake(env, "recense", [{ code: 127 }]);
    assert.throws(lookup, { code: 69, message: missing });
    process.env.RECENSE_BIN = "recense";
    assert.throws(lookup, { code: 2, message: "RECENSE_BIN must be an absolute path." });
    process.env.RECENSE_BIN = join(env.fakeBin, "recense");
    const invalid = "RECENSE_BIN does not name an executable file.";
    assert.throws(lookup, { code: 69, message: invalid });
    chmodSync(process.env.RECENSE_BIN, 0o600);
    assert.throws(lookup, { code: 69, message: invalid });
    process.env.RECENSE_BIN = env.fakeBin;
    assert.throws(lookup, { code: 69, message: invalid });
  }));

test("approval maps old recense, timeout and other failures to dependency errors", () =>
  scenario((env, repo) => {
    const lookup = () => readApproval(repo, branch, sha);
    installFake(env, "recense", [{ code: 2, stderr: "Usage: recense ls [--json].\n" }]);
    for (const source of ["on PATH", "in RECENSE_BIN"]) {
      if (source === "in RECENSE_BIN") process.env.RECENSE_BIN = join(env.fakeBin, "recense");
      assert.throws(lookup, {
        code: 69,
        message: `The recense ${source} is too old to report approvals; it needs 0.8.0 or later. Update it, or set RECENSE_BIN.`,
      });
    }
    installFake(env, "recense", [{ code: 124 }]);
    assert.throws(lookup, { code: 69, message: "recense did not answer within 30 seconds." });
    installFake(env, "recense", [{ code: 1, stderr: `\x1b[31mfailed\x07\t${"x".repeat(210)}\nsecond line\n` }]);
    assert.throws(lookup, { code: 69, message: `recense ls failed: failed ${"x".repeat(193)}` });
    installFake(env, "recense", [{ code: 1, stderr: `Authorization: Bearer ${"x".repeat(20)}\nsecond line\n` }]);
    assert.throws(lookup, { code: 69, message: "recense ls failed: [line withheld: secret shape]" });
  }));

test("approval runs the selected shim by its invoked name from HOME and honors RECENSE_BIN", () =>
  scenario((env, repo) => {
    const shim = join(env.fakeBin, "shim");
    writeFileSync(
      shim,
      '#!/bin/sh\n[ "$0" = "$HOME/recense" ] && [ "$PWD" = "$HOME" ] || exit 1\nprintf \'%s\\n\' \'{"items":[]}\'\n',
      { mode: 0o755 },
    );
    const selected = join(env.home, "recense");
    symlinkSync(shim, selected);
    installFakeRecense(env, sha, [approved]);
    process.env.PATH = ["", relative(process.cwd(), env.fakeBin), env.home, env.fakeBin].join(delimiter);
    assert.equal(recenseProgram([repo.mainRoot]), selected);
    assert.deepEqual(readApproval(repo, branch, sha), { ok: false, reason: "no review of this commit" });
    process.env.RECENSE_BIN = selected;
    process.env.PATH = env.fakeBin;
    assert.deepEqual(readApproval(repo, branch, sha), { ok: false, reason: "no review of this commit" });
    assert.deepEqual(fakeCalls(env, "recense"), []);
  }));

test("approval refuses executables in the repository, including through a symlink on PATH", () =>
  scenario((env, repo) => {
    const executable = join(repo.mainRoot, "recense");
    writeFileSync(executable, "#!/bin/sh\nexit 7\n", { mode: 0o755 });
    symlinkSync(executable, join(env.fakeBin, "recense"));
    for (const override of ["", executable]) {
      process.env.RECENSE_BIN = override;
      assert.throws(() => readApproval(repo, branch, sha), {
        code: 69,
        message:
          "The recense program lies inside this repository. bin/wt reads approvals only through an installed recense.",
      });
    }
  }));

function folderRefusal(name: string) {
  return {
    code: 69,
    message: `recense's ${name} folder lies inside this repository. bin/wt reads approvals only from your own recense state.`,
  };
}

test("approval rejects the effective folders in the repository or under a symlink to it", () =>
  scenario((env, repo) => {
    installFakeRecense(env, sha, [approved]);
    const alias = join(env.root, "alias");
    symlinkSync(repo.mainRoot, alias);
    for (const [name, folder] of [
      ["RECENSE_HOME", "state"],
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
      assert.doesNotThrow(() => assertRecenseEnv([repo.mainRoot]));
      delete process.env[name];
    }
    assert.deepEqual(fakeCalls(env, "recense"), []);
  }));

test("approval checks the recense child of each XDG folder and honors the state override", () =>
  scenario((env, repo) => {
    const xdg = join(env.root, "xdg");
    mkdirSync(xdg);
    symlinkSync(repo.mainRoot, join(xdg, "recense"));
    process.env.XDG_CONFIG_HOME = xdg;
    const check = () => assertRecenseEnv([repo.mainRoot]);
    assert.throws(check, folderRefusal("config"));
    delete process.env.XDG_CONFIG_HOME;
    process.env.XDG_DATA_HOME = xdg;
    if (process.platform === "darwin") assert.doesNotThrow(check);
    else assert.throws(check, folderRefusal("state"));
    process.env.RECENSE_HOME = join(env.home, "state");
    assert.doesNotThrow(check);
    process.env.RECENSE_HOME = "relative";
    assert.throws(check, { code: 69, message: "RECENSE_HOME must be an absolute path." });
  }));

test("approval checks the home defaults when XDG settings are missing or relative", () =>
  scenario((env, repo) => {
    const config = join(env.home, ".config");
    mkdirSync(config);
    symlinkSync(repo.mainRoot, join(config, "recense"));
    const check = () => assertRecenseEnv([repo.mainRoot]);
    assert.throws(check, folderRefusal("config"));
    process.env.XDG_CONFIG_HOME = "relative";
    assert.throws(check, folderRefusal("config"));
    process.env.XDG_CONFIG_HOME = env.root;
    const data =
      process.platform === "darwin"
        ? join(env.home, "Library", "Application Support")
        : join(env.home, ".local", "share");
    mkdirSync(data, { recursive: true });
    symlinkSync(repo.mainRoot, join(data, "recense"));
    assert.throws(check, folderRefusal("state"));
    process.env.XDG_DATA_HOME = "relative";
    assert.throws(check, folderRefusal("state"));
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
    installFakeRecense(env, head, [item]);
    assert.deepEqual(await runWt(launcher, ["approval"], { cwd: wt }), {
      code: 0,
      stdout: `approved ${head} review ${item.id} revision 1\n`,
      stderr: "",
    });
    installFakeRecense(env, sha, []);
    assert.deepEqual(await runWt(launcher, ["approval", "--head", sha], { cwd: wt }), {
      code: 1,
      stdout: "not approved: no review of this commit\n",
      stderr: "",
    });
    assert.deepEqual(await runWt(launcher, ["approval", "--branch", branch, "--head", head], { cwd: wt }), {
      code: 2,
      stdout: "",
      stderr: "--branch is only for the main checkout.\n",
    });
    assert.deepEqual(fakeCalls(env, "recense"), [["ls", "--json", "--head", sha]]);
  } finally {
    env.cleanup();
  }
});

test("approval in the main checkout requires and checks the given branch and head", async () => {
  const env = makeTestEnv({ ports: false });
  try {
    const { main } = makeFixture(env, { withBin: true });
    const query = (...args: string[]) => runWt(join(main, "bin/wt"), ["approval", ...args], { cwd: main });
    for (const args of [[], ["--branch", branch], ["--head", sha]]) {
      assert.deepEqual(await query(...args), {
        code: 2,
        stdout: "",
        stderr: "In the main checkout, run bin/wt approval --branch <name> --head <sha>.\n",
      });
    }
    assert.deepEqual(await query("--branch", "main", "--head", sha), {
      code: 2,
      stdout: "",
      stderr: "Invalid branch name.\n",
    });
    assert.deepEqual(await query("--branch", branch, "--head", "short"), {
      code: 2,
      stdout: "",
      stderr: "Invalid commit id.\n",
    });
    installFakeRecense(env, sha, [approved]);
    assert.deepEqual(await query("--branch", branch, "--head", sha), {
      code: 0,
      stdout: `approved ${sha} review ${approved.id} revision 1\n`,
      stderr: "",
    });
    assert.deepEqual(await query("--branch", "feat-b", "--head", sha), {
      code: 1,
      stdout: "not approved: the review of this commit names another branch\n",
      stderr: "",
    });
  } finally {
    env.cleanup();
  }
});

test("approval refuses programs and state in a linked worktree outside the main checkout", () =>
  scenario((env, repo) => {
    const linked = join(env.root, "linked");
    gitIn(repo.mainRoot, "commit", "--allow-empty", "-qm", "init");
    gitIn(repo.mainRoot, "worktree", "add", "-q", "-b", branch, linked);
    installFakeRecense(env, sha, [approved]);
    const lookup = () => readApproval(repo, branch, sha);
    const executable = join(linked, "recense");
    process.env.RECENSE_BIN = executable;
    writeFileSync(executable, "#!/bin/sh\nexit 7\n", { mode: 0o755 });
    const programRefusal = {
      code: 69,
      message:
        "The recense program lies inside this repository. bin/wt reads approvals only through an installed recense.",
    };
    assert.throws(lookup, programRefusal);
    rmSync(executable);
    symlinkSync(join(env.fakeBin, "recense"), executable);
    assert.throws(lookup, programRefusal);
    delete process.env.RECENSE_BIN;

    const alias = join(env.root, "alias");
    symlinkSync(linked, alias);
    for (const path of [linked, alias]) {
      process.env.RECENSE_HOME = join(path, "new", "state");
      assert.throws(lookup, folderRefusal("state"));
    }
    rmSync(linked, { recursive: true });
    process.env.RECENSE_HOME = join(linked, "state");
    assert.throws(lookup, folderRefusal("state"));
    const parentAlias = join(env.root, "parent-alias");
    symlinkSync(env.root, parentAlias);
    process.env.RECENSE_HOME = join(parentAlias, "linked", "state");
    assert.throws(lookup, folderRefusal("state"));
    assert.deepEqual(fakeCalls(env, "recense"), []);
  }));

test("approval stops before calling recense if it cannot list the worktrees", () =>
  scenario((env, repo) => {
    installFakeRecense(env, sha, [approved]);
    rmSync(join(env.fakeBin, "git"));
    assert.throws(() => readApproval(repo, branch, sha), {
      code: 69,
      message: "Could not determine this repository's worktree paths. bin/wt cannot check the approval.",
    });
    assert.deepEqual(fakeCalls(env, "recense"), []);
  }));
