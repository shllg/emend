import assert from "node:assert/strict";
import {
  appendFileSync,
  chmodSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { PORT_MAX, PORT_MIN, readRegistry, withRegistry } from "./registry.ts";
import { gitTry, type Repo, resolveRepo } from "./repo.ts";
import {
  branchPrRules,
  commitFile,
  type Fixture,
  fakeCalls,
  fakeGithubOrigin,
  gitIn,
  installFake,
  issueRules,
  listenOn,
  makeFixture,
  makeTestEnv,
  readyIssue,
  runWt,
  setFakeRules,
  type TestEnv,
  testPortRange,
} from "./test-support.ts";
import { WtError } from "./validate.ts";
import {
  cleanup,
  formatGc,
  formatList,
  gc,
  list,
  safetyGuard,
  setBeforeWorktreeAddHookForTests,
  setup,
  terminal,
  writeWtFiles,
} from "./worktree.ts";

const NO_BUSY = new Set<number>();
/** The port range every in-process test runs in (makeTestEnv moves it away from the real 3637 to 3656). */
const { min: P0, max: P9 } = testPortRange();
const P1 = P0 + 1;

/** A fresh test environment and fixture per test, always removed afterwards. */
async function scenario(
  o: { withBin?: boolean },
  fn: (ctx: { env: TestEnv; fx: Fixture; repo: Repo }) => void | Promise<void>,
): Promise<void> {
  const env = makeTestEnv();
  try {
    const fx = makeFixture(env, o);
    await fn({ env, fx, repo: resolveRepo(fx.main) });
  } finally {
    env.cleanup();
  }
}

function newWorktree(repo: Repo, branch: string) {
  return setup(repo, { branch, busy: NO_BUSY });
}

function expectCode(fn: () => unknown, code: number): void {
  assert.throws(fn, (e: unknown) => e instanceof WtError && e.code === code, `expected exit ${code}`);
}

test("setup creates worktree, port and EMEND_HOME", () =>
  scenario({}, ({ repo, fx }) => {
    const r = newWorktree(repo, "feat-a");
    assert.equal(r.path, join(fx.main, ".claude", "worktrees", "feat-a"));
    assert.equal(r.port, P0);
    assert.equal(gitIn(r.path, "symbolic-ref", "--short", "HEAD"), "feat-a");
    assert.equal(gitIn(r.path, "rev-parse", "HEAD"), gitIn(fx.main, "rev-parse", "origin/main"));
  }));

test("setup, metadata, list and cleanup accept both task branch forms and preserve explicit names", () =>
  scenario({}, ({ repo, fx, env }) => {
    for (const branch of ["014-some-task", "emend-task-014-some-task"]) {
      const wt = setup(repo, { branch });
      assert.equal(wt.branch, branch);
      const info = JSON.parse(readFileSync(join(wt.path, ".wt/worktree.json"), "utf8"));
      assert.equal(info.task, "014");
      assert.equal(info.issue, undefined);
      assert.equal(readRegistry(repo).worktrees[branch]?.task, "014");
      assert.equal(list(repo).find((r) => r.branch === branch)?.task, "014");
      assert.match(formatList(list(repo)), /014-some-task\s+014\s/);
      cleanup(repo, { target: branch, discard: false, closeWorkspace: false });
      assert.equal(existsSync(wt.path), false);
      assert.equal(readRegistry(repo).worktrees[branch], undefined);
      assert.equal(gitIn(fx.main, "branch", "--list", branch), "");
    }
    fakeGithubOrigin(env, fx);
    installFake(env, "gh", issueRules([readyIssue(14)]));
    const issueBranch = setup(repo, { branch: "emend-14-an-issue", issue: 14 });
    assert.equal(readRegistry(repo).worktrees[issueBranch.branch]?.task, null);
  }));

test("setup writes .wt/worktree.json and private directories", () =>
  scenario({}, ({ repo }) => {
    const r = newWorktree(repo, "feat-a");
    const info = JSON.parse(readFileSync(join(r.path, ".wt", "worktree.json"), "utf8"));
    assert.deepEqual(info, {
      branch: "feat-a",
      port: P0,
      emendHome: join(r.path, ".wt", "home"),
      task: null,
      mode: "github",
    });
    assert.equal(r.emendHome, join(r.path, ".wt", "home"));
    for (const dir of [".wt", ".wt/home"]) {
      assert.equal(statSync(join(r.path, dir)).mode & 0o777, 0o700, dir);
    }
    assert.equal(gitIn(r.path, "status", "--porcelain", "--untracked-files=all"), "", ".wt must not show as untracked");
    const entry = readRegistry(repo).worktrees["feat-a"];
    assert.equal(entry?.path, r.path);
    assert.equal(entry?.port, P0);
  }));

test("setup does not set an upstream for a new branch", () =>
  scenario({}, ({ repo }) => {
    const r = newWorktree(repo, "feat-a");
    assert.throws(() => gitIn(r.path, "rev-parse", "--abbrev-ref", "feat-a@{upstream}"));
  }));

test("setup maps slashes to double dashes", () =>
  scenario({}, ({ repo, fx }) => {
    const r = newWorktree(repo, "fix/inbox");
    assert.equal(r.path, join(fx.main, ".claude", "worktrees", "fix--inbox"));
    assert.ok(existsSync(r.path));
    const reg = readRegistry(repo);
    assert.deepEqual(Object.keys(reg.worktrees), ["fix/inbox"]);
    assert.equal(gitIn(r.path, "symbolic-ref", "--short", "HEAD"), "fix/inbox");
  }));

test("setup checks out an origin-only branch", () =>
  scenario({}, ({ repo, fx }) => {
    const sha = commitFile(fx.main, "only.txt", "x\n");
    gitIn(fx.main, "push", "--quiet", "origin", "HEAD:refs/heads/only-origin");
    assert.equal(gitIn(fx.main, "branch", "--list", "only-origin"), "");
    const r = newWorktree(repo, "only-origin");
    assert.equal(gitIn(r.path, "rev-parse", "HEAD"), sha);
    assert.equal(gitIn(r.path, "rev-parse", "--abbrev-ref", "only-origin@{upstream}"), "origin/only-origin");
  }));

test("setup checks out an existing local branch", () =>
  scenario({}, ({ repo, fx }) => {
    gitIn(fx.main, "branch", "local-one");
    const r = newWorktree(repo, "local-one");
    assert.equal(gitIn(r.path, "symbolic-ref", "--short", "HEAD"), "local-one");
  }));

test("setup refusals", () =>
  scenario({}, ({ repo, fx }) => {
    expectCode(() => newWorktree(repo, "main"), 2);
    expectCode(() => setup(repo, { branch: "feat-b", from: "no-such-ref", busy: NO_BUSY }), 2);
    expectCode(() => setup(repo, { branch: "feat-c", task: "7", busy: NO_BUSY }), 2);

    newWorktree(repo, "feat-a");
    expectCode(() => newWorktree(repo, "feat-a"), 3);

    // a checked-out branch the registry does not know
    const elsewhere = join(fx.env.root, "elsewhere");
    gitIn(fx.main, "worktree", "add", "--quiet", "-b", "other", elsewhere);
    expectCode(() => newWorktree(repo, "other"), 3);

    // an existing directory
    mkdirSync(join(repo.worktreesDir, "taken"), { recursive: true });
    expectCode(() => newWorktree(repo, "taken"), 3);

    // --from with a branch that exists
    gitIn(fx.main, "branch", "has-ref");
    expectCode(() => setup(repo, { branch: "has-ref", from: "origin/main", busy: NO_BUSY }), 2);

    // all ports registered
    withRegistry(repo, (r) => {
      for (let p = P0; p <= P9; p++) {
        r.worktrees[`fill-${p}`] = { path: "/nowhere", port: p, task: null, mode: "github", createdAt: "t" };
      }
    });
    expectCode(() => newWorktree(repo, "feat-z"), 69);
    assert.equal(gitIn(fx.main, "branch", "--list", "feat-z"), "", "nothing was created");
    assert.equal(existsSync(join(repo.worktreesDir, "feat-z")), false);
  }));

test("setup skips a port with a listener", () =>
  scenario({}, async ({ repo }) => {
    const server = await listenOn(P0); // a failure here fails the test: the range is the test's own
    try {
      const r = setup(repo, { branch: "feat-a", busy: new Set([P0]) });
      assert.equal(r.port, P1);
    } finally {
      await server.close();
    }
  }));

test("local hooksPath refuses", () =>
  scenario({ withBin: true }, async ({ fx }) => {
    const wt = join(fx.main, "bin", "wt");
    const ok = await runWt(wt, ["list"], { cwd: fx.main });
    assert.equal(ok.code, 0, ok.stderr);
    gitIn(fx.main, "config", "--local", "core.hooksPath", "x");
    const refused = await runWt(wt, ["list"], { cwd: fx.main });
    assert.equal(refused.code, 69);
    assert.match(refused.stderr, /core\.hooksPath/);
  }));

test("a worktree's own copy works from that worktree", () =>
  scenario({ withBin: true }, async ({ repo }) => {
    const r = newWorktree(repo, "feat-m");
    assert.ok(existsSync(join(r.path, "bin", "wt")), "the worktree carries its own copy");
    const out = await runWt(join(r.path, "bin", "wt"), ["list"], { cwd: r.path });
    assert.equal(out.code, 0, out.stderr);
    assert.match(out.stdout, /feat-m/);
  }));

test("the main copy works from a worktree it manages", () =>
  scenario({ withBin: true }, async ({ fx, repo }) => {
    const r = newWorktree(repo, "feat-n");
    const out = await runWt(join(fx.main, "bin", "wt"), ["list"], { cwd: r.path });
    assert.equal(out.code, 0, out.stderr);
    assert.match(out.stdout, /feat-n/);
  }));

test("unknown subcommands exit 2 and are not echoed", () =>
  scenario({ withBin: true }, async ({ fx }) => {
    const out = await runWt(join(fx.main, "bin", "wt"), ["frobnicate-secret"], { cwd: fx.main });
    assert.equal(out.code, 2);
    assert.equal(out.stderr.includes("frobnicate-secret"), false);
    const help = await runWt(join(fx.main, "bin", "wt"), ["help"], { cwd: fx.main });
    assert.equal(help.code, 0);
    assert.match(help.stdout, /setup/);
  }));

test("no herdr: setup, list, cleanup still work", () =>
  scenario({ withBin: true }, async ({ fx }) => {
    const wt = join(fx.main, "bin", "wt");
    const s = await runWt(wt, ["setup", "nh-branch"], { cwd: fx.main });
    assert.equal(s.code, 0, s.stderr);
    assert.match(s.stdout, /pnpm install --frozen-lockfile/);
    // the child keeps the real range; a listener of the owner's may move the port inside it
    const port = Number(/port: (\d+)/.exec(s.stdout)?.[1]);
    assert.ok(port >= PORT_MIN && port <= PORT_MAX, `port ${port} is outside ${PORT_MIN}-${PORT_MAX}`);
    const l = await runWt(wt, ["list"], { cwd: fx.main });
    assert.equal(l.code, 0, l.stderr);
    assert.match(l.stdout, /nh-branch/);
    const j = await runWt(wt, ["list", "--json"], { cwd: fx.main });
    assert.equal(JSON.parse(j.stdout)[0].branch, "nh-branch");
    const c = await runWt(wt, ["cleanup", "nh-branch"], { cwd: fx.main });
    assert.equal(c.code, 0, c.stderr);
    assert.equal(existsSync(join(fx.main, ".claude", "worktrees", "nh-branch")), false);
  }));

test("a refused option is not echoed", () =>
  scenario({ withBin: true }, async ({ fx }) => {
    const out = await runWt(join(fx.main, "bin", "wt"), ["list", "--repo", "evil/secret"], { cwd: fx.main });
    assert.equal(out.code, 2);
    assert.equal(out.stderr.includes("evil/secret"), false);
  }));

test("list reports ahead, behind, dirty, PR and agent", () =>
  scenario({}, ({ repo, fx, env }) => {
    const r = newWorktree(repo, "feat-a");
    commitFile(r.path, "a.txt", "a\n");
    commitFile(fx.main, "m.txt", "m\n");
    gitIn(fx.main, "push", "--quiet", "origin", "main");
    gitIn(fx.main, "fetch", "--quiet", "origin");
    writeFileSync(join(r.path, "dirty.txt"), "x");
    fakeGithubOrigin(env, fx);
    installFake(env, "gh", branchPrRules([{ number: 5, state: "OPEN", headRefName: "feat-a" }], "feat-a"));
    installFake(env, "herdr", [
      {
        match: ["agent", "list"],
        stdout: JSON.stringify({ result: { agents: [{ name: "c", status: "working", cwd: r.path }] } }),
      },
    ]);
    const [row] = list(repo);
    assert.equal(row?.branch, "feat-a");
    assert.equal(row?.ahead, 1);
    assert.equal(row?.behind, 1);
    assert.equal(row?.dirty, true);
    assert.deepEqual(row?.pr, { number: 5, state: "OPEN" });
    assert.equal(row?.agent, "working");
  }));

// ---------------------------------------------------------------------------------------------
// Safety guard

function guard(repo: Repo, branch: string) {
  return safetyGuard(repo, branch);
}

test("guard: each failure is named", () =>
  scenario({}, async ({ repo, fx, env }) => {
    // not registered
    assert.deepEqual(guard(repo, "nope"), { ok: false, failed: "not-registered" });

    // a clean worktree at origin/main passes
    const clean = newWorktree(repo, "g-clean");
    assert.deepEqual(guard(repo, "g-clean"), { ok: true });

    // not-clean: an untracked file
    writeFileSync(join(clean.path, "stray.txt"), "x");
    assert.deepEqual(guard(repo, "g-clean"), { ok: false, failed: "not-clean" });

    // branch-mismatch: detached HEAD
    const detached = newWorktree(repo, "g-detached");
    gitIn(detached.path, "checkout", "--quiet", "--detach");
    assert.deepEqual(guard(repo, "g-detached"), { ok: false, failed: "branch-mismatch" });

    // unmerged: a commit that is neither in origin/main nor in a merged PR
    const unmerged = newWorktree(repo, "g-unmerged");
    commitFile(unmerged.path, "u.txt", "u\n");
    assert.deepEqual(guard(repo, "g-unmerged"), { ok: false, failed: "unmerged" });

    // operation-in-progress
    const busyOp = newWorktree(repo, "g-op");
    const gitDir = gitIn(busyOp.path, "rev-parse", "--path-format=absolute", "--git-dir");
    writeFileSync(join(gitDir, "MERGE_HEAD"), `${gitIn(busyOp.path, "rev-parse", "HEAD")}\n`);
    assert.deepEqual(guard(repo, "g-op"), { ok: false, failed: "operation-in-progress" });

    // nested-worktree
    const outer = newWorktree(repo, "g-outer");
    writeFileSync(join(repo.commonDir, "info", "exclude"), "nested\n", { flag: "a" });
    gitIn(fx.main, "worktree", "add", "--quiet", "-b", "g-inner", join(outer.path, "nested"));
    assert.deepEqual(guard(repo, "g-outer"), { ok: false, failed: "nested-worktree" });

    // port-listening
    const listening = newWorktree(repo, "g-port");
    const server = await listenOn(listening.port); // a failure here means the port is taken on this machine
    try {
      assert.deepEqual(guard(repo, "g-port"), { ok: false, failed: "port-listening" });
    } finally {
      await server.close();
    }
    assert.deepEqual(guard(repo, "g-port"), { ok: true });

    // agent-active, and idle or done agents pass
    const agentTree = newWorktree(repo, "g-agent");
    const agents = (status: string) => ({
      match: ["agent", "list"],
      stdout: JSON.stringify({ result: { agents: [{ name: "c", status, cwd: join(agentTree.path, "sub") }] } }),
    });
    installFake(env, "herdr", [agents("working")]);
    assert.deepEqual(guard(repo, "g-agent"), { ok: false, failed: "agent-active" });
    setFakeRules(env, "herdr", [agents("idle")]);
    assert.deepEqual(guard(repo, "g-agent"), { ok: true });
    setFakeRules(env, "herdr", [agents("done")]);
    assert.deepEqual(guard(repo, "g-agent"), { ok: true });
  }));

test("guard: squash-merged branch passes through the PR head", () =>
  scenario({}, ({ repo, fx, env }) => {
    const r = newWorktree(repo, "feat-sq");
    const head = commitFile(r.path, "sq.txt", "sq\n");
    gitIn(r.path, "push", "--quiet", "origin", `${head}:refs/pull/7/head`);
    fakeGithubOrigin(env, fx);
    installFake(
      env,
      "gh",
      branchPrRules([{ number: 7, state: "MERGED", headRefName: "feat-sq", headRefOid: head }], "feat-sq"),
    );
    // HEAD is not in origin/main, so only the PR head can clear it
    assert.throws(() => gitIn(fx.main, "merge-base", "--is-ancestor", head, "origin/main"));
    assert.deepEqual(guard(repo, "feat-sq"), { ok: true });
    assert.equal(gitIn(fx.main, "for-each-ref", "refs/wt-pr"), "", "the temporary ref is removed");

    // an open PR does not clear it; a PR head that differs does not either
    installFake(
      env,
      "gh",
      branchPrRules([{ number: 7, state: "OPEN", headRefName: "feat-sq", headRefOid: head }], "feat-sq"),
    );
    assert.deepEqual(guard(repo, "feat-sq"), { ok: false, failed: "unmerged" });
    installFake(
      env,
      "gh",
      branchPrRules([{ number: 7, state: "MERGED", headRefName: "feat-sq", headRefOid: "a".repeat(40) }], "feat-sq"),
    );
    assert.deepEqual(guard(repo, "feat-sq"), { ok: false, failed: "unmerged" });
  }));

test("guard: a branch landed on local main passes when the trees match", () =>
  scenario({}, ({ repo, fx }) => {
    const r = newWorktree(repo, "feat-landed");
    commitFile(r.path, "l.txt", "l\n");
    assert.deepEqual(guard(repo, "feat-landed"), { ok: false, failed: "unmerged" });
    // land by hand: main gets one commit with the branch's tree
    gitIn(fx.main, "merge", "--quiet", "--squash", "feat-landed");
    gitIn(fx.main, "commit", "--quiet", "-m", "land feat-landed");
    const landed = gitIn(fx.main, "rev-parse", "HEAD");
    withRegistry(repo, (reg) => {
      (reg.worktrees["feat-landed"] as { landedAs?: string }).landedAs = landed;
    });
    assert.deepEqual(guard(repo, "feat-landed"), { ok: true });
  }));

// ---------------------------------------------------------------------------------------------
// Cleanup

test("cleanup removes and frees", () =>
  scenario({}, ({ repo, fx }) => {
    const r = newWorktree(repo, "feat-a");
    cleanup(repo, { target: "feat-a", closeWorkspace: false, discard: false });
    assert.equal(existsSync(r.path), false);
    assert.deepEqual(Object.keys(readRegistry(repo).worktrees), []);
    assert.equal(gitIn(fx.main, "branch", "--list", "feat-a"), "");
    assert.equal(gitIn(fx.main, "worktree", "list", "--porcelain").includes("feat-a"), false);
    assert.equal(newWorktree(repo, "feat-b").port, P0, "the port is reusable");
  }));

test("cleanup takes a path and a slashed branch", () =>
  scenario({}, ({ repo, fx }) => {
    const r = newWorktree(repo, "fix/inbox");
    cleanup(repo, { target: r.path, closeWorkspace: false, discard: false });
    assert.equal(existsSync(r.path), false);
    assert.deepEqual(Object.keys(readRegistry(repo).worktrees), []);
    const r2 = newWorktree(repo, "fix/other");
    cleanup(repo, { target: "fix/other", closeWorkspace: false, discard: false });
    assert.equal(existsSync(r2.path), false);
    assert.equal(gitIn(fx.main, "branch", "--list", "fix/*"), "");
    expectCode(() => cleanup(repo, { target: "unknown", closeWorkspace: false, discard: false }), 2);
  }));

test("cleanup refuses and removes nothing when the guard fails", () =>
  scenario({}, ({ repo, fx }) => {
    const r = newWorktree(repo, "feat-a");
    writeFileSync(join(r.path, "stray.txt"), "x");
    assert.throws(
      () => cleanup(repo, { target: "feat-a", closeWorkspace: false, discard: false }),
      (e: unknown) => e instanceof WtError && e.code === 1 && /not-clean/.test(e.message),
    );
    assert.ok(existsSync(r.path));
    assert.ok(readRegistry(repo).worktrees["feat-a"]);
    assert.notEqual(gitIn(fx.main, "branch", "--list", "feat-a"), "");
  }));

test("cleanup of a registry entry whose directory is gone drops the entry and keeps the branch", () =>
  scenario({}, ({ repo, fx }) => {
    const r = newWorktree(repo, "feat-a");
    gitIn(fx.main, "worktree", "remove", "--force", r.path);
    cleanup(repo, { target: "feat-a", closeWorkspace: false, discard: false });
    assert.deepEqual(Object.keys(readRegistry(repo).worktrees), []);
    assert.notEqual(gitIn(fx.main, "branch", "--list", "feat-a"), "");
  }));

test("cleanup --discard needs a terminal, the typed name, and keeps the agent and listener checks", () =>
  scenario({}, async ({ repo, env }) => {
    const realIsTTY = terminal.isTTY;
    const realRead = terminal.readLine;
    try {
      const r = newWorktree(repo, "feat-d");
      commitFile(r.path, "unmerged.txt", "u\n");
      writeFileSync(join(r.path, "dirty.txt"), "x");

      // no terminal
      expectCode(() => cleanup(repo, { target: "feat-d", closeWorkspace: false, discard: true }), 2);
      assert.ok(existsSync(r.path));

      // a terminal, the wrong name
      terminal.isTTY = () => true;
      terminal.readLine = () => "something-else";
      expectCode(() => cleanup(repo, { target: "feat-d", closeWorkspace: false, discard: true }), 1);
      assert.ok(existsSync(r.path));

      // an active agent still blocks
      terminal.readLine = () => "feat-d";
      installFake(env, "herdr", [
        {
          match: ["agent", "list"],
          stdout: JSON.stringify({ result: { agents: [{ name: "c", status: "working", cwd: r.path }] } }),
        },
      ]);
      expectCode(() => cleanup(repo, { target: "feat-d", closeWorkspace: false, discard: true }), 1);
      assert.ok(existsSync(r.path));
      setFakeRules(env, "herdr", []);

      // a live listener still blocks
      const server = await listenOn(r.port); // inside the test's own port range
      try {
        expectCode(() => cleanup(repo, { target: "feat-d", closeWorkspace: false, discard: true }), 1);
        assert.ok(existsSync(r.path));
      } finally {
        await server.close();
      }

      // confirmed: dirty and unmerged work goes
      cleanup(repo, { target: "feat-d", closeWorkspace: false, discard: true });
      assert.equal(existsSync(r.path), false);
      assert.deepEqual(Object.keys(readRegistry(repo).worktrees), []);
    } finally {
      terminal.isTTY = realIsTTY;
      terminal.readLine = realRead;
    }
  }));

test("from a linked worktree, cleanup targets only its own worktree", () =>
  scenario({}, ({ repo }) => {
    const mine = newWorktree(repo, "own-wt");
    const other = newWorktree(repo, "other-wt");
    const fromMine = resolveRepo(mine.path);
    assert.throws(
      () => cleanup(fromMine, { target: "other-wt", closeWorkspace: false, discard: false }),
      (e: unknown) =>
        e instanceof WtError &&
        e.code === 2 &&
        e.message ===
          "From a worktree, bin/wt cleans up only its own worktree; run it from the main checkout for others.",
    );
    expectCode(() => cleanup(fromMine, { target: other.path, closeWorkspace: false, discard: false }), 2);
    assert.ok(existsSync(other.path), "nothing was removed");
    // from the main checkout any worktree can be targeted
    cleanup(repo, { target: "other-wt", closeWorkspace: false, discard: false });
    assert.equal(existsSync(other.path), false);
    // its own worktree is allowed (the usual guard still applies)
    cleanup(fromMine, { target: "own-wt", closeWorkspace: false, discard: false });
    assert.equal(existsSync(mine.path), false);
  }));

test("from a linked worktree, setup creates only new branches", () =>
  scenario({}, ({ repo, fx }) => {
    const mine = newWorktree(repo, "own-wt");
    gitIn(fx.main, "branch", "existing-local");
    commitFile(fx.main, "o.txt", "x\n");
    gitIn(fx.main, "push", "--quiet", "origin", "HEAD:refs/heads/existing-origin");
    const fromMine = resolveRepo(mine.path);
    expectCode(() => setup(fromMine, { branch: "existing-local", busy: NO_BUSY }), 2);
    expectCode(() => setup(fromMine, { branch: "existing-origin", busy: NO_BUSY }), 2);
    assert.equal(existsSync(join(repo.worktreesDir, "existing-origin")), false);
    assert.equal(existsSync(join(repo.worktreesDir, "existing-local")), false);
    // a new branch still works, and so does an existing one from the main checkout
    assert.equal(setup(fromMine, { branch: "brand-new", busy: NO_BUSY }).branch, "brand-new");
    assert.equal(setup(repo, { branch: "existing-local", busy: NO_BUSY }).branch, "existing-local");
  }));

test("the removed run subcommand is unknown and help does not list it", () =>
  scenario({ withBin: true }, async ({ fx }) => {
    const wt = join(fx.main, "bin", "wt");
    const bad = await runWt(wt, ["run", "list"], { cwd: fx.main });
    assert.equal(bad.code, 2);
    const help = await runWt(wt, ["help"], { cwd: fx.main });
    assert.doesNotMatch(help.stdout, /run view/);
    assert.match(help.stdout, /--brief-file/);
    assert.match(help.stdout, /issues \[--json\]/);
    assert.match(help.stdout, /spawn --issue <n>/);
  }));

test("list and gc output carry no control character from outside", () => {
  const rows = [
    {
      branch: "a\u0085b",
      path: "/p",
      task: null,
      port: 1,
      mode: "github" as const,
      ahead: null,
      behind: null,
      dirty: null,
      pr: { number: 1, state: "OP\u009bEN\u001b" },
      agent: "wor\u0085k",
      missing: false,
    },
  ];
  assert.doesNotMatch(formatList(rows), /[^\P{Cc}\n]/u);
  const report = { items: [{ kind: "merged-branch" as const, name: "x\u0085y\u009b", state: "found" as const }] };
  assert.doesNotMatch(formatGc(report, false), /[^\P{Cc}\n]/u);
});

// ---------------------------------------------------------------------------------------------
// Tracked .wt, symlinks and machine-local files

const SHA40 = "1234567890123456789012345678901234567890";

test("setup refuses a ref that tracks a .wt entry, for an existing branch and for --from", () =>
  scenario({}, ({ repo, fx }) => {
    gitIn(fx.main, "checkout", "--quiet", "-b", "has-wt");
    mkdirSync(join(fx.main, ".wt"), { recursive: true });
    writeFileSync(join(fx.main, ".wt", "worktree.json"), "{}\n");
    gitIn(fx.main, "add", "-f", "--", ".wt/worktree.json");
    gitIn(fx.main, "commit", "--quiet", "-m", "track .wt");
    gitIn(fx.main, "checkout", "--quiet", "main");
    expectCode(() => setup(repo, { branch: "has-wt", busy: NO_BUSY }), 2);
    expectCode(() => setup(repo, { branch: "fresh", from: "has-wt", busy: NO_BUSY }), 2);
    assert.equal(existsSync(join(repo.worktreesDir, "has-wt")), false);
    assert.equal(existsSync(join(repo.worktreesDir, "fresh")), false);
  }));

test("setup --from refuses a ref that holds a gitlink", () =>
  scenario({}, ({ repo, fx }) => {
    gitIn(fx.main, "checkout", "--quiet", "-b", "has-link2");
    gitIn(fx.main, "update-index", "--add", "--cacheinfo", `160000,${SHA40},sub`);
    gitIn(fx.main, "commit", "--quiet", "-m", "gitlink");
    gitIn(fx.main, "checkout", "--quiet", "main");
    expectCode(() => setup(repo, { branch: "fresh2", from: "has-link2", busy: NO_BUSY }), 1);
    assert.equal(existsSync(join(repo.worktreesDir, "fresh2")), false);
  }));

test("writeWtFiles refuses a symlinked .wt and writes nothing through it", () =>
  scenario({}, ({ env }) => {
    const dir = join(env.root, "wt-dir");
    const target = join(env.root, "elsewhere");
    mkdirSync(dir);
    mkdirSync(target);
    symlinkSync(target, join(dir, ".wt"));
    const entry = { path: dir, port: P0, task: null, mode: "github" as const, createdAt: "x" };
    assert.throws(() => writeWtFiles(entry, "b"));
    assert.deepEqual(readdirSync(target), []);
    // a symlinked file inside a real .wt is refused as well
    const dir2 = join(env.root, "wt-dir2");
    mkdirSync(join(dir2, ".wt"), { recursive: true });
    const victim = join(env.root, "victim.json");
    writeFileSync(victim, "keep\n");
    symlinkSync(victim, join(dir2, ".wt", "worktree.json"));
    assert.throws(() => writeWtFiles({ ...entry, path: dir2 }, "b"));
    assert.equal(readFileSync(victim, "utf8"), "keep\n");
  }));

function stageLocal(main: string, rel: string, text: string, mode: number): void {
  mkdirSync(join(main, rel, ".."), { recursive: true });
  writeFileSync(join(main, rel), text);
  chmodSync(join(main, rel), mode);
}

/** Writes main's .worktreeinclude and ignores `ignored` in main's .gitignore (neither is committed). */
function listInclude(main: string, patterns: string[], ignored: string[]): void {
  writeFileSync(join(main, ".worktreeinclude"), `# comment\n${patterns.join("\n")}\n`);
  appendFileSync(join(main, ".gitignore"), `${ignored.join("\n")}\n`);
}

/** Runs setup with stderr captured. */
function setupCapturing(repo: Repo, branch: string): { result: ReturnType<typeof setup>; stderr: string } {
  const lines: string[] = [];
  const write = process.stderr.write.bind(process.stderr);
  process.stderr.write = ((c: string | Uint8Array) => {
    lines.push(String(c));
    return true;
  }) as typeof process.stderr.write;
  try {
    return { result: setup(repo, { branch, busy: NO_BUSY }), stderr: lines.join("") };
  } finally {
    process.stderr.write = write;
  }
}

test("setup copies the ignored files .worktreeinclude lists and keeps their mode", () =>
  scenario({}, ({ repo, fx }) => {
    stageLocal(fx.main, ".mcp.json", '{"a":1}\n', 0o600);
    stageLocal(fx.main, ".claude/settings.local.json", "{}\n", 0o640);
    stageLocal(fx.main, "other.txt", "not listed\n", 0o644);
    listInclude(
      fx.main,
      [".mcp.json", ".claude/settings.local.json"],
      [".mcp.json", ".claude/settings.local.json", "other.txt"],
    );
    const { result: r, stderr } = setupCapturing(repo, "feat-local");
    assert.equal(stderr, "");
    assert.equal(readFileSync(join(r.path, ".mcp.json"), "utf8"), '{"a":1}\n');
    assert.equal(statSync(join(r.path, ".mcp.json")).mode & 0o777, 0o600);
    assert.equal(readFileSync(join(r.path, ".claude", "settings.local.json"), "utf8"), "{}\n");
    assert.equal(statSync(join(r.path, ".claude", "settings.local.json")).mode & 0o777, 0o640);
    assert.equal(existsSync(join(r.path, "other.txt")), false, "an unlisted file is not copied");
  }));

test("a missing .worktreeinclude copies nothing and setup succeeds", () =>
  scenario({}, ({ repo, fx }) => {
    stageLocal(fx.main, ".mcp.json", "{}\n", 0o600);
    appendFileSync(join(fx.main, ".gitignore"), ".mcp.json\n");
    const { result: r, stderr } = setupCapturing(repo, "feat-none");
    assert.equal(stderr, "");
    assert.equal(existsSync(join(r.path, ".mcp.json")), false);
  }));

test("a listed file that is untracked but not ignored, or tracked, is not copied", () =>
  scenario({}, ({ repo, fx }) => {
    stageLocal(fx.main, "plain.json", "x\n", 0o644);
    commitFile(fx.main, "tracked.json", "tracked\n");
    writeFileSync(join(fx.main, "tracked.json"), "edited in main\n");
    listInclude(fx.main, ["plain.json", "tracked.json"], ["tracked.json"]);
    const { result: r } = setupCapturing(repo, "feat-plain");
    assert.equal(existsSync(join(r.path, "plain.json")), false, "untracked but not ignored");
    assert.equal(readFileSync(join(r.path, "tracked.json"), "utf8"), "tracked\n", "tracked: checked out, not copied");
  }));

test("a symlinked source and a file behind a symlinked folder are skipped", () =>
  scenario({}, ({ repo, fx, env }) => {
    const outside = join(env.root, "outside");
    mkdirSync(outside);
    writeFileSync(join(outside, "secret.json"), "SECRET\n");
    symlinkSync(join(outside, "secret.json"), join(fx.main, ".mcp.json"));
    symlinkSync(outside, join(fx.main, "linked"));
    listInclude(fx.main, [".mcp.json", "linked", "linked/secret.json"], [".mcp.json", "linked"]);
    const { result: r, stderr } = setupCapturing(repo, "feat-links");
    assert.equal(existsSync(join(r.path, ".mcp.json")), false);
    assert.equal(existsSync(join(r.path, "linked")), false);
    assert.match(stderr, /Skipped \.mcp\.json: the main checkout's file is a symlink/);
    assert.equal(stderr.includes("SECRET"), false);
  }));

test("an existing target is kept with its content", () =>
  scenario({}, ({ repo, fx }) => {
    gitIn(fx.main, "checkout", "--quiet", "-b", "has-local");
    commitFile(fx.main, "local.json", "tracked\n");
    gitIn(fx.main, "checkout", "--quiet", "main");
    stageLocal(fx.main, "local.json", "from-main\n", 0o644);
    listInclude(fx.main, ["local.json"], ["local.json"]);
    const { result: r, stderr } = setupCapturing(repo, "has-local");
    assert.equal(readFileSync(join(r.path, "local.json"), "utf8"), "tracked\n");
    assert.match(stderr, /Skipped local\.json: the worktree already has it/);
  }));

test("a .wt pattern copies nothing", () =>
  scenario({}, ({ repo, fx }) => {
    stageLocal(fx.main, ".wt/review.json", "approval\n", 0o600);
    listInclude(fx.main, [".wt/", ".wt/review.json"], []);
    const { result: r, stderr } = setupCapturing(repo, "feat-wt");
    assert.equal(existsSync(join(r.path, ".wt", "review.json")), false);
    assert.match(stderr, /Skipped \.wt\/review\.json: \.wt is not copied/);
  }));

// ---------------------------------------------------------------------------------------------
// Local main as the start point

test("a new worktree starts at local main when local main is ahead of origin/main", () =>
  scenario({}, ({ repo, fx }) => {
    const ahead = commitFile(fx.main, "ahead.txt", "a\n");
    const r = newWorktree(repo, "feat-local-main");
    assert.equal(gitIn(r.path, "rev-parse", "HEAD"), ahead);
    assert.notEqual(gitIn(fx.main, "rev-parse", "origin/main"), ahead);
    assert.equal(existsSync(join(r.path, "ahead.txt")), true);
    // --from origin/main still wins
    const o = setup(repo, { branch: "feat-origin-main", from: "origin/main", busy: NO_BUSY });
    assert.equal(gitIn(o.path, "rev-parse", "HEAD"), gitIn(fx.main, "rev-parse", "origin/main"));
  }));

test("the guard passes for an untouched worktree started from a local main that is ahead", () =>
  scenario({}, ({ repo, fx }) => {
    commitFile(fx.main, "ahead.txt", "a\n");
    const r = newWorktree(repo, "feat-untouched");
    assert.deepEqual(safetyGuard(repo, "feat-untouched"), { ok: true });
    commitFile(r.path, "own.txt", "own\n");
    assert.deepEqual(safetyGuard(repo, "feat-untouched"), { ok: false, failed: "unmerged" });
  }));

test("list counts against local main for a local-mode entry and origin/main for a github-mode entry", () =>
  scenario({}, ({ repo, fx }) => {
    commitFile(fx.main, "ahead.txt", "a\n");
    setup(repo, { branch: "feat-gh", from: "origin/main", busy: NO_BUSY });
    setup(repo, { branch: "feat-loc", from: "origin/main", mode: "local", busy: NO_BUSY });
    const rows = new Map(list(repo).map((row) => [row.branch, row]));
    assert.equal(rows.get("feat-gh")?.behind, 0, "github mode: origin/main");
    assert.equal(rows.get("feat-loc")?.behind, 1, "local mode: local main is one commit further");
  }));

test("setup checks the commit it resolved: a local branch that moves before the add is refused", () =>
  scenario({}, ({ repo, fx }) => {
    gitIn(fx.main, "branch", "moving");
    setBeforeWorktreeAddHookForTests(() => {
      setBeforeWorktreeAddHookForTests(null);
      gitIn(fx.main, "branch", "-f", "moving", commitFile(fx.main, "later.txt", "later\n"));
    });
    try {
      expectCode(() => setup(repo, { branch: "moving", busy: NO_BUSY }), 1);
    } finally {
      setBeforeWorktreeAddHookForTests(null);
    }
    assert.equal(existsSync(join(repo.worktreesDir, "moving")), false);
    assert.deepEqual(Object.keys(readRegistry(repo).worktrees), []);
  }));

test("an origin-only branch keeps its upstream when it is created from the resolved commit", () =>
  scenario({}, ({ repo, fx }) => {
    commitFile(fx.main, "o.txt", "x\n");
    gitIn(fx.main, "push", "--quiet", "origin", "HEAD:refs/heads/only-origin");
    gitIn(fx.main, "fetch", "--quiet", "origin");
    const r = newWorktree(repo, "only-origin");
    assert.equal(gitIn(r.path, "rev-parse", "--abbrev-ref", "only-origin@{upstream}"), "origin/only-origin");
    assert.equal(gitIn(r.path, "rev-parse", "HEAD"), gitIn(fx.main, "rev-parse", "origin/only-origin"));
  }));

test("an anchored pattern copies the root file and not one in a subfolder", () =>
  scenario({}, ({ repo, fx }) => {
    stageLocal(fx.main, "local.json", "root\n", 0o644);
    stageLocal(fx.main, "sub/local.json", "sub\n", 0o644);
    listInclude(fx.main, ["/local.json"], ["local.json"]);
    const { result: r } = setupCapturing(repo, "feat-anchored");
    assert.equal(readFileSync(join(r.path, "local.json"), "utf8"), "root\n");
    assert.equal(existsSync(join(r.path, "sub", "local.json")), false);
  }));

// ---------------------------------------------------------------------------------------------
// Names that start with a dash never reach git or gh as options

/** A worktree whose registry key and branch are `name`, a name bin/wt would refuse. */
function dashWorktree(repo: Repo, fx: Fixture, name: string, extraCommit: boolean) {
  const w = newWorktree(repo, "plain-one");
  gitIn(fx.main, "update-ref", `refs/heads/${name}`, gitIn(w.path, "rev-parse", "HEAD"));
  gitIn(w.path, "symbolic-ref", "HEAD", `refs/heads/${name}`);
  if (extraCommit) commitFile(w.path, "own.txt", "own\n");
  withRegistry(repo, (r) => {
    const entry = r.worktrees["plain-one"];
    if (entry) r.worktrees[name] = entry;
    delete r.worktrees["plain-one"];
  });
  return w;
}

test("list and the guard never pass a dash-named registry branch to gh", () =>
  scenario({}, ({ repo, fx, env }) => {
    installFake(env, "gh", [{ stdout: '{"number":1,"state":"OPEN"}' }]);
    dashWorktree(repo, fx, "--web", true);
    list(repo);
    assert.deepEqual(safetyGuard(repo, "--web"), { ok: false, failed: "unmerged" });
    assert.deepEqual(
      fakeCalls(env, "gh").filter((c) => c.some((a) => a.startsWith("-") && a !== "--json")),
      [],
    );
  }));

test("cleanup removes the worktree of a dash-named branch but never gives the name to git branch -D", () =>
  scenario({}, ({ repo, fx }) => {
    const w = dashWorktree(repo, fx, "--output=x", false);
    cleanup(repo, { target: "--output=x", closeWorkspace: false, discard: false });
    assert.equal(existsSync(w.path), false);
    assert.equal(gitTry(repo, ["rev-parse", "--verify", "--quiet", "refs/heads/--output=x"]).code, 0, "the ref stays");
    assert.equal(existsSync(join(fx.main, "x")), false);
  }));

test("gc reports a merged branch with a dash name and never deletes it", () =>
  scenario({}, ({ repo, fx }) => {
    gitIn(fx.main, "update-ref", "refs/heads/-f", gitIn(fx.main, "rev-parse", "origin/main"));
    gitIn(fx.main, "update-ref", "refs/heads/--output=x", gitIn(fx.main, "rev-parse", "origin/main"));
    const report = gc(repo, true);
    for (const name of ["-f", "--output=x"]) {
      const item = report.items.find((i) => i.kind === "merged-branch" && i.name === name);
      assert.equal(item?.state, "kept", name);
      assert.equal(item?.why, "invalid-name", name);
      assert.equal(gitTry(repo, ["rev-parse", "--verify", "--quiet", `refs/heads/${name}`]).code, 0, name);
    }
    assert.equal(existsSync(join(fx.main, "x")), false);
  }));
