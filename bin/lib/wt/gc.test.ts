import assert from "node:assert/strict";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import {
  addFinding,
  approveFindings,
  claimFindings,
  findingsDir,
  releaseFindings,
  releaseOrphanedClaim,
  showFinding,
} from "./findings.ts";
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

function claim(repo: Repo, branch: string, worktree: string): string {
  const { id } = addFinding(repo, {
    title: "Keep the selected line",
    detail: "Refreshing loses the selected line.",
    path: "README.md",
    line: 1,
    kind: "bug",
    rule: branch,
    severity: "low",
    size: "small",
    source: { kind: "groom", pass: "first" },
  });
  approveFindings(repo, [id], "P1");
  claimFindings(repo, [id], { branch, worktree });
  return id;
}

test("gc reports orphaned claims and releases them only with --prune", () =>
  scenario(({ repo, fx }) => {
    const gone = claim(repo, "gone-worker", join(fx.env.root, "gone"));
    const live = claim(repo, "live-worker", fx.main);
    const approval = showFinding(repo, gone).approval;
    const report = gc(repo, false);
    assert.deepEqual(report.items, [{ kind: "orphaned-claim", name: gone, state: "found" }]);
    assert.match(formatGc(report, false), /gc --prune to remove or release/);
    assert.equal(showFinding(repo, gone).state, "claimed");
    const pruned = gc(repo, true);
    assert.deepEqual(pruned.items, [{ kind: "orphaned-claim", name: gone, state: "released" }]);
    const released = showFinding(repo, gone);
    assert.equal(released.state, "open");
    assert.deepEqual(released.approval, approval);
    assert.equal(Object.hasOwn(released, "claim"), false);
    assert.equal(showFinding(repo, live).state, "claimed");
  }));

test("gc keeps a locked worktree's claim when its directory is missing", () =>
  scenario(({ repo, fx }) => {
    const branch = "locked-worker";
    const wt = setup(repo, { branch, busy: new Set() });
    const id = claim(repo, branch, wt.path);
    gitIn(fx.main, "worktree", "lock", wt.path);
    rmSync(wt.path, { recursive: true });
    const before = showFinding(repo, id);
    for (const prune of [false, true]) {
      assert.equal(find(gc(repo, prune).items, "orphaned-claim", id)?.state, "locked");
      assert.deepEqual(showFinding(repo, id), before);
    }
  }));

test("gc keeps a claim when the worktree is locked after the scan", () =>
  scenario(({ repo, fx }) => {
    const branch = "returning-worker";
    const worktree = join(fx.env.root, branch);
    gitIn(fx.main, "worktree", "add", "--quiet", "-b", branch, worktree, "main");
    const gitDir = gitIn(worktree, "rev-parse", "--absolute-git-dir");
    const id = claim(repo, branch, worktree);
    rmSync(worktree, { recursive: true });
    const before = showFinding(repo, id);
    const pruned = gc(repo, true, (repo, id, seen, isLocked) => {
      writeFileSync(join(gitDir, "locked"), "temporarily unmounted\n");
      return releaseOrphanedClaim(repo, id, seen, isLocked);
    });
    assert.deepEqual(pruned.items, [{ kind: "orphaned-claim", name: id, state: "locked" }]);
    assert.deepEqual(showFinding(repo, id), before);
  }));

test("gc keeps a claim that changed after the scan", () =>
  scenario(({ repo, fx }) => {
    const id = claim(repo, "first-worker", join(fx.env.root, "gone"));
    const pruned = gc(repo, true, (repo, id, seen, isLocked) => {
      releaseFindings(repo, [id]);
      claimFindings(repo, [id], { branch: "next-worker", worktree: fx.main });
      return releaseOrphanedClaim(repo, id, seen, isLocked);
    });
    assert.deepEqual(pruned.items, [{ kind: "orphaned-claim", name: id, state: "kept", why: "claim changed" }]);
    assert.equal(showFinding(repo, id).claim?.branch, "next-worker");
  }));

test("gc reports other items when finding storage is unreadable", () =>
  scenario(({ repo, fx }) => {
    gitIn(fx.main, "branch", "merged-worker");
    const dir = findingsDir(repo);
    mkdirSync(dirname(dir), { recursive: true });
    writeFileSync(dir, "not a directory");
    const pruned = gc(repo, true);
    assert.equal(find(pruned.items, "merged-branch", "merged-worker")?.state, "removed");
    assert.match(formatGc(pruned, true), /^Finding claims were not checked: Finding storage/m);
  }));

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
    // a branch merged into origin/main
    gitIn(fx.main, "branch", "merged-b");

    const report = gc(repo, false);
    assert.equal(find(report.items, "missing-directory", "gone-b")?.state, "found");
    assert.equal(find(report.items, "orphan-directory", "orphan-clean")?.state, "unregistered");
    assert.equal(find(report.items, "orphan-directory", "orphan-locked")?.state, "locked");
    assert.equal(find(report.items, "orphan-directory", "own"), undefined);
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
    assert.equal(find(pruned.items, "merged-branch", "merged-b")?.state, "removed");

    for (const name of ["orphan-clean", "orphan-dirty", "orphan-locked", "own", "empty-dir"]) {
      assert.ok(existsSync(join(wtDir, name)), `${name} stays`);
    }
    assert.ok(existsSync(join(wtDir, "orphan-dirty", "scratch.txt")), "a dirty worktree is kept");
    const reg = readRegistry(repo);
    assert.deepEqual(Object.keys(reg.worktrees), []);
    assert.equal(gitIn(fx.main, "branch", "--list", "merged-b"), "");
    assert.notEqual(gitIn(fx.main, "branch", "--list", "orphan-dirty"), "");
  }));

test("gc keeps a branch that has a registered worktree", () =>
  scenario(({ repo, fx }) => {
    setup(repo, { branch: "in-use", busy: new Set() });
    const pruned = gc(repo, true);
    assert.deepEqual(pruned.items, []);
    assert.notEqual(gitIn(fx.main, "branch", "--list", "in-use"), "");
  }));

test("gc ignores the legacy keys an older registry still carries", () =>
  scenario(({ repo, fx }) => {
    gitIn(fx.main, "branch", "legacy-b");
    const old = "2020-01-01T00:00:00Z";
    mkdirSync(dirname(registryPath(repo)), { recursive: true });
    writeFileSync(
      registryPath(repo),
      JSON.stringify({
        version: 1,
        worktrees: {},
        reservations: { "050": { branch: "050-old-thing", slug: "old-thing", reservedAt: old } },
      }),
    );
    const report = gc(repo, true);
    assert.deepEqual(
      report.items.map((i) => [i.kind, i.name]),
      [["merged-branch", "legacy-b"]],
    );
    assert.equal(gitIn(fx.main, "branch", "--list", "legacy-b"), "");
  }));

test("gc --prune keeps a merged branch that a concurrent setup claimed after the scan", () =>
  scenario(({ repo, fx }) => {
    for (const b of ["late-registered", "late-checked-out", "plain-merged"]) {
      gitIn(fx.main, "branch", b);
    }
    setBeforeBranchDeleteHookForTests((b) => {
      // what a setup or spawn that starts between gc's scan and its delete would do
      if (b === "late-registered") {
        withRegistry(repo, (r) => {
          r.worktrees[b] = { path: join(repo.worktreesDir, b), port: 1, mode: "github", createdAt: "t" };
        });
      } else if (b === "late-checked-out") {
        gitIn(fx.main, "worktree", "add", "--quiet", join(fx.env.root, "late-co"), b);
      }
    });
    const pruned = gc(repo, true);
    for (const name of ["late-registered", "late-checked-out"]) {
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
