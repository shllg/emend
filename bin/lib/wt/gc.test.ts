import assert from "node:assert/strict";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { readRegistry, registryPath, setAfterLockHookForTests, withRegistry } from "./registry.ts";
import { type Repo, resolveRepo } from "./repo.ts";
import { type Fixture, gitIn, makeFixture, makeTestEnv, type TestEnv } from "./test-support.ts";
import { WtError } from "./validate.ts";
import { cleanup, formatGc, gc, setBeforeBranchDeleteHookForTests, setup } from "./worktree.ts";

async function scenario(fn: (ctx: { env: TestEnv; fx: Fixture; repo: Repo }) => void | Promise<void>): Promise<void> {
  const env = makeTestEnv();
  try {
    const fx = makeFixture(env);
    await fn({ env, fx, repo: resolveRepo(fx.main) });
  } finally {
    setBeforeBranchDeleteHookForTests(null);
    setAfterLockHookForTests(null);
    env.cleanup();
  }
}

const find = (items: ReturnType<typeof gc>["items"], kind: string, name: string) =>
  items.find((i) => i.kind === kind && i.name === name);

test("gc report and prune", () =>
  scenario(({ repo, fx }) => {
    // an entry whose directory is gone
    const gone = setup(repo, { branch: "gone-b", busy: new Set() });
    gitIn(fx.main, "worktree", "remove", "--force", gone.path);
    // directories without a registry entry: a clean worktree, a dirty one, a locked one
    const wtDir = join(fx.main, ".claude", "worktrees");
    gitIn(fx.main, "worktree", "add", "--quiet", "-b", "orphan-clean", join(wtDir, "orphan-clean"), "origin/main");
    gitIn(fx.main, "worktree", "add", "--quiet", "-b", "orphan-dirty", join(wtDir, "orphan-dirty"), "origin/main");
    writeFileSync(join(wtDir, "orphan-dirty", "scratch.txt"), "x\n");
    gitIn(fx.main, "worktree", "add", "--quiet", "-b", "orphan-locked", join(wtDir, "orphan-locked"), "origin/main");
    gitIn(fx.main, "worktree", "lock", join(wtDir, "orphan-locked"));
    // Claude Code's own worktree is ignored
    gitIn(fx.main, "worktree", "add", "--quiet", "-b", "worktree-own", join(wtDir, "own"), "origin/main");
    // a plain empty directory
    mkdirSync(join(wtDir, "empty-dir"));
    // an old reservation without a branch, and a fresh one
    withRegistry(repo, (r) => {
      r.reservations["050"] = {
        branch: "050-old-thing",
        slug: "old-thing",
        reservedAt: new Date(Date.now() - 48 * 3600_000).toISOString(),
      };
      r.reservations["051"] = { branch: "051-new-thing", slug: "new-thing", reservedAt: new Date().toISOString() };
    });
    // a branch merged into origin/main
    gitIn(fx.main, "branch", "merged-b");

    const report = gc(repo, false);
    assert.equal(find(report.items, "missing-directory", "gone-b")?.state, "found");
    assert.equal(find(report.items, "orphan-directory", "orphan-clean")?.state, "unregistered");
    assert.equal(find(report.items, "orphan-directory", "orphan-locked")?.state, "locked");
    assert.equal(find(report.items, "orphan-directory", "own"), undefined);
    assert.equal(find(report.items, "stale-reservation", "050")?.state, "found");
    assert.equal(find(report.items, "stale-reservation", "051"), undefined);
    assert.equal(find(report.items, "merged-branch", "merged-b")?.state, "found");
    assert.equal(find(report.items, "merged-branch", "main"), undefined);
    assert.ok(existsSync(join(wtDir, "orphan-clean")), "a report removes nothing");
    assert.match(formatGc(report, false), /gc --prune/);

    const pruned = gc(repo, true);
    assert.equal(find(pruned.items, "missing-directory", "gone-b")?.state, "removed");
    // a directory without a registry entry is never removed, whatever it holds
    for (const name of ["orphan-clean", "orphan-dirty", "empty-dir"]) {
      const item = find(pruned.items, "orphan-directory", name);
      assert.equal(item?.state, "unregistered", name);
      assert.match(item?.why ?? "", /remove it by hand/);
    }
    assert.equal(find(pruned.items, "orphan-directory", "orphan-locked")?.state, "locked");
    assert.match(formatGc(pruned, true), /never removed by gc/);
    assert.equal(find(pruned.items, "stale-reservation", "050")?.state, "removed");
    assert.equal(find(pruned.items, "merged-branch", "merged-b")?.state, "removed");

    for (const name of ["orphan-clean", "orphan-dirty", "orphan-locked", "own", "empty-dir"]) {
      assert.ok(existsSync(join(wtDir, name)), `${name} stays`);
    }
    assert.ok(existsSync(join(wtDir, "orphan-dirty", "scratch.txt")), "a dirty worktree is kept");
    const reg = readRegistry(repo);
    assert.deepEqual(Object.keys(reg.worktrees), []);
    assert.deepEqual(Object.keys(reg.reservations), ["051"]);
    assert.equal(gitIn(fx.main, "branch", "--list", "merged-b"), "");
    assert.notEqual(gitIn(fx.main, "branch", "--list", "orphan-dirty"), "");
  }));

test("gc keeps a branch that has a registered worktree or a reservation", () =>
  scenario(({ repo, fx }) => {
    setup(repo, { branch: "in-use", busy: new Set() });
    gitIn(fx.main, "branch", "reserved-b");
    withRegistry(repo, (r) => {
      r.reservations["060"] = { branch: "reserved-b", slug: "reserved-b", reservedAt: new Date().toISOString() };
    });
    const pruned = gc(repo, true);
    assert.deepEqual(pruned.items, []);
    assert.notEqual(gitIn(fx.main, "branch", "--list", "in-use"), "");
    assert.notEqual(gitIn(fx.main, "branch", "--list", "reserved-b"), "");
  }));

test("gc handles legacy and prefixed task reservations and branches", () =>
  scenario(({ repo, fx }) => {
    const old = "2020-01-01T00:00:00Z";
    for (const branch of ["014-old-task", "emend-015-new-task", "emend-16-issue-work"])
      gitIn(fx.main, "branch", branch);
    withRegistry(repo, (r) => {
      r.reservations["014"] = { branch: "014-old-task", slug: "old-task", reservedAt: old };
      r.reservations["015"] = { branch: "emend-015-new-task", slug: "new-task", reservedAt: old };
      r.reservations["016"] = { branch: "emend-016-missing-task", slug: "missing-task", reservedAt: old };
    });
    const report = gc(repo, true);
    assert.equal(find(report.items, "stale-reservation", "016")?.state, "removed");
    assert.equal(find(report.items, "merged-branch", "emend-16-issue-work")?.state, "removed");
    assert.deepEqual(Object.keys(readRegistry(repo).reservations), ["014", "015"]);
    for (const branch of ["014-old-task", "emend-015-new-task"])
      assert.notEqual(gitIn(fx.main, "branch", "--list", branch), "");
  }));

test("gc --prune keeps a merged branch that a concurrent setup claimed after the scan", () =>
  scenario(({ repo, fx }) => {
    for (const b of ["late-registered", "late-reserved", "late-checked-out", "plain-merged"]) {
      gitIn(fx.main, "branch", b);
    }
    setBeforeBranchDeleteHookForTests((b) => {
      // what a setup or spawn that starts between gc's scan and its delete would do
      if (b === "late-registered") {
        withRegistry(repo, (r) => {
          r.worktrees[b] = { path: join(repo.worktreesDir, b), port: 1, task: null, mode: "github", createdAt: "t" };
        });
      } else if (b === "late-reserved") {
        withRegistry(repo, (r) => {
          r.reservations["070"] = { branch: b, slug: "late-reserved", reservedAt: new Date().toISOString() };
        });
      } else if (b === "late-checked-out") {
        gitIn(fx.main, "worktree", "add", "--quiet", join(fx.env.root, "late-co"), b);
      }
    });
    const pruned = gc(repo, true);
    for (const name of ["late-registered", "late-reserved", "late-checked-out"]) {
      const item = find(pruned.items, "merged-branch", name);
      assert.equal(item?.state, "kept", name);
      assert.equal(item?.why, "in-use", name);
      assert.notEqual(gitIn(fx.main, "branch", "--list", name), "", `${name} survives`);
    }
    assert.equal(find(pruned.items, "merged-branch", "plain-merged")?.state, "removed");
    assert.equal(gitIn(fx.main, "branch", "--list", "plain-merged"), "");
  }));

test("cleanup says to run gc --prune when the registry update fails after the removal", () =>
  scenario(({ repo }) => {
    const r = setup(repo, { branch: "reg-fail", busy: new Set() });
    // the first locked registry access after the guard is the update after `git worktree remove`
    setAfterLockHookForTests(() => {
      setAfterLockHookForTests(null);
      writeFileSync(registryPath(repo), "{ not json");
    });
    assert.throws(
      () => cleanup(repo, { target: "reg-fail", closeWorkspace: false, discard: false }),
      (e: unknown) =>
        e instanceof WtError &&
        e.code === 1 &&
        e.message === `The worktree was removed; run ${join(repo.mainRoot, "bin", "wt")} gc --prune.`,
    );
    assert.equal(existsSync(r.path), false, "the worktree was removed");
  }));
