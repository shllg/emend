import assert from "node:assert/strict";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { changeDigest, commands, conflictLines, land, rebase, restack, syncMain } from "./history.ts";
import { readRegistry } from "./registry.ts";
import { type Repo, resolveRepo } from "./repo.ts";
import { commitFile, type Fixture, gitIn, makeFixture, makeTestEnv, type TestEnv } from "./test-support.ts";
import { WtError } from "./validate.ts";
import { setup } from "./worktree.ts";

const SHA = "a".repeat(40);

async function scenario(fn: (ctx: { env: TestEnv; fx: Fixture; repo: Repo }) => void | Promise<void>): Promise<void> {
  const env = makeTestEnv();
  try {
    const fx = makeFixture(env);
    await fn({ env, fx, repo: resolveRepo(fx.main) });
  } finally {
    env.cleanup();
  }
}

function expectCode(fn: () => unknown, code: number): void {
  assert.throws(fn, (e: unknown) => e instanceof WtError && e.code === code, `expected exit ${code}`);
}

function worktree(repo: Repo, branch: string): string {
  return setup(repo, { branch, busy: new Set<number>() }).path;
}

/** Adds a commit to origin's main from a separate clone, so the main checkout stays untouched. */
function advanceOrigin(env: TestEnv, fx: Fixture, rel: string, content: string): string {
  const other = join(env.root, "other");
  if (!existsSync(other)) gitIn(env.root, "clone", "--quiet", fx.origin, other);
  gitIn(other, "pull", "--quiet", "--ff-only", "origin", "main");
  const sha = commitFile(other, rel, content);
  gitIn(other, "push", "--quiet", "origin", "main");
  return sha;
}

function numbered(n: number): string {
  return Array.from({ length: n }, (_, i) => `line ${i + 1}\n`).join("");
}

function assertSigned(cwd: string, range: string): void {
  const commits = gitIn(cwd, "rev-list", range).split("\n").filter(Boolean);
  assert.ok(commits.length > 0, "range has commits");
  for (const c of commits) gitIn(cwd, "verify-commit", c);
}

function idle(cwd: string): void {
  const gitDir = gitIn(cwd, "rev-parse", "--path-format=absolute", "--git-dir");
  for (const name of ["REBASE_HEAD", "rebase-merge", "rebase-apply", "MERGE_HEAD", "CHERRY_PICK_HEAD"]) {
    assert.equal(existsSync(join(gitDir, name)), false, name);
  }
}

test("clean rebase re-signs and keeps the digest", () =>
  scenario(({ env, fx, repo }) => {
    const wt = worktree(repo, "feat-a");
    commitFile(wt, "a.txt", "a\n");
    commitFile(wt, "b.txt", "b\n");
    const wtRepo = resolveRepo(wt);
    const before = changeDigest(wtRepo, "origin/main", "HEAD");
    const oldTip = gitIn(wt, "rev-parse", "HEAD");
    const tip = advanceOrigin(env, fx, "unrelated.txt", "u\n");

    const r = rebase(wtRepo, wt, "origin/main");
    assert.equal(r.result, "rebased");
    assert.deepEqual(r.conflicts, []);
    assert.equal(r.backups.length, 1);
    assert.match(r.backups[0] as string, /^refs\/wt-backup\/feat-a\/\d{8}T\d{6}Z/);
    assert.equal(gitIn(wt, "rev-parse", r.backups[0] as string), oldTip);
    assert.equal(gitIn(wt, "merge-base", "origin/main", "HEAD"), tip);
    assertSigned(wt, "origin/main..HEAD");
    assert.equal(changeDigest(wtRepo, "origin/main", "HEAD"), before);
    const again = rebase(wtRepo, wt, "origin/main");
    assert.deepEqual(again, { result: "up-to-date", conflicts: [], backups: [] });
    idle(wt);
  }));

test("context-only shift keeps the digest; a content change does not", () =>
  scenario(({ env, fx, repo }) => {
    commitFile(fx.main, "f.txt", numbered(12));
    gitIn(fx.main, "push", "--quiet", "origin", "main");
    const wt = worktree(repo, "feat-a");
    const wtRepo = resolveRepo(wt);
    commitFile(wt, "f.txt", numbered(12).replace("line 8\n", "line eight\n"));
    const before = changeDigest(wtRepo, "origin/main", "HEAD");

    advanceOrigin(env, fx, "f.txt", `new top 1\nnew top 2\n${numbered(12)}`);
    assert.equal(rebase(wtRepo, wt, "origin/main").result, "rebased");
    assert.equal(changeDigest(wtRepo, "origin/main", "HEAD"), before);

    const text = readFileSync(join(wt, "f.txt"), "utf8").replace("line 3\n", "line three\n");
    commitFile(wt, "f.txt", text);
    assert.notEqual(changeDigest(wtRepo, "origin/main", "HEAD"), before);
  }));

test("conflict restacks with no operation in progress", () =>
  scenario(({ env, fx, repo }) => {
    commitFile(fx.main, "c.txt", "one\n");
    gitIn(fx.main, "push", "--quiet", "origin", "main");
    const wt = worktree(repo, "feat-a");
    const wtRepo = resolveRepo(wt);
    commitFile(wt, "c.txt", "branch\n");
    commitFile(wt, "extra.txt", "extra\n");
    const oldTip = gitIn(wt, "rev-parse", "HEAD");
    advanceOrigin(env, fx, "c.txt", "main\n");

    const r = rebase(wtRepo, wt, "origin/main");
    assert.equal(r.result, "restacked");
    assert.deepEqual(r.conflicts, ["c.txt"]);
    idle(wt);
    gitIn(wt, "diff", "--cached", "--quiet");
    assert.equal(gitIn(wt, "rev-parse", "HEAD"), gitIn(wt, "rev-parse", "origin/main"));
    assert.match(readFileSync(join(wt, "c.txt"), "utf8"), /<<<<<<</);
    assert.equal(readFileSync(join(wt, "extra.txt"), "utf8"), "extra\n");
    const backups = gitIn(wt, "for-each-ref", "--format=%(refname) %(objectname)", "refs/wt-backup/feat-a/");
    assert.match(backups, new RegExp(`^refs/wt-backup/feat-a/\\d{8}T\\d{6}Z ${oldTip}$`));
  }));

test("a restack writes nothing through a symlinked restack folder", () =>
  scenario(({ env, fx, repo }) => {
    commitFile(fx.main, "c.txt", "one\n");
    gitIn(fx.main, "push", "--quiet", "origin", "main");
    const wt = worktree(repo, "feat-a");
    commitFile(wt, "c.txt", "branch\n");
    advanceOrigin(env, fx, "c.txt", "main\n");
    const elsewhere = join(env.root, "elsewhere");
    mkdirSync(elsewhere);
    const dir = join(fx.main, ".git", "emend-wt");
    rmSync(dir, { recursive: true, force: true });
    symlinkSync(elsewhere, dir);

    assert.deepEqual(restack(resolveRepo(wt), wt, "origin/main").conflicts, ["c.txt"]);
    assert.equal(gitIn(wt, "rev-parse", "HEAD"), gitIn(wt, "rev-parse", "origin/main"));
    assert.deepEqual(readdirSync(elsewhere), []);
    idle(wt);
  }));

test("a restack ignores a planted file at the old patch path", () =>
  scenario(({ env, fx, repo }) => {
    const wt = worktree(repo, "feat-a");
    commitFile(wt, "a.txt", "a\n");
    advanceOrigin(env, fx, "other.txt", "other\n");
    const dir = join(fx.main, ".git", "emend-wt");
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const target = join(env.root, "kept.txt");
    writeFileSync(target, "keep\n");
    symlinkSync(target, join(dir, `restack-${process.pid}.patch`));

    assert.deepEqual(restack(resolveRepo(wt), wt, "origin/main").conflicts, []);
    assert.equal(readFileSync(target, "utf8"), "keep\n");
    idle(wt);
  }));

test("a restack keeps non-UTF-8 text and binary files byte for byte", () =>
  scenario(({ env, fx, repo }) => {
    writeFileSync(join(fx.main, "latin1.txt"), Buffer.from("caf\xe9\nna\xefve\n", "latin1"));
    gitIn(fx.main, "add", "latin1.txt");
    gitIn(fx.main, "commit", "--quiet", "-m", "add latin1 text");
    gitIn(fx.main, "push", "--quiet", "origin", "main");
    const wt = worktree(repo, "feat-a");
    const latin1 = Buffer.from("caf\xe9 changed\nna\xefve\n", "latin1");
    const binary = Buffer.from([0, 1, 2, 255, 254, 0, 10, 13, 200]);
    writeFileSync(join(wt, "latin1.txt"), latin1);
    writeFileSync(join(wt, "blob.bin"), binary);
    gitIn(wt, "add", "latin1.txt", "blob.bin");
    gitIn(wt, "commit", "--quiet", "-m", "change text and add binary");
    advanceOrigin(env, fx, "other.txt", "other\n");

    assert.deepEqual(restack(resolveRepo(wt), wt, "origin/main").conflicts, []);
    assert.ok(readFileSync(join(wt, "latin1.txt")).equals(latin1));
    assert.ok(readFileSync(join(wt, "blob.bin")).equals(binary));
    idle(wt);
  }));

test("a failed apply after HEAD moved names the backup and restores the branch", () =>
  scenario(({ env, fx, repo }) => {
    commitFile(fx.main, "c.txt", "base\n");
    gitIn(fx.main, "push", "--quiet", "origin", "main");
    const wt = worktree(repo, "feat-a");
    gitIn(wt, "rm", "c.txt");
    gitIn(wt, "commit", "--quiet", "-m", "delete c");
    const oldTip = gitIn(wt, "rev-parse", "HEAD");
    advanceOrigin(env, fx, "c.txt", "main changed\n");

    assert.throws(
      () => restack(resolveRepo(wt), wt, "origin/main"),
      (e: unknown) =>
        e instanceof WtError &&
        e.code === 1 &&
        /could not be replayed/.test(e.message) &&
        /backup: refs\/wt-backup\/feat-a\//.test(e.message),
    );
    assert.equal(gitIn(wt, "rev-parse", "HEAD"), oldTip);
    idle(wt);
  }));

test("a restack that cannot read the change leaves the branch unchanged", () =>
  scenario(({ env, fx, repo }) => {
    commitFile(fx.main, "shared.txt", "a unique base blob for this replay\n");
    gitIn(fx.main, "push", "--quiet", "origin", "main");
    const oid = gitIn(fx.main, "rev-parse", "HEAD:shared.txt");
    const wt = worktree(repo, "feat-a");
    const oldTip = commitFile(wt, "shared.txt", "branch content\n");
    rmSync(join(fx.main, ".git", "objects", oid.slice(0, 2), oid.slice(2)));
    advanceOrigin(env, fx, "other.txt", "other\n");

    assert.throws(
      () => restack(resolveRepo(wt), wt, "origin/main"),
      (e: unknown) =>
        e instanceof WtError && e.code === 1 && /could not be read/.test(e.message) && /backup: /.test(e.message),
    );
    assert.equal(gitIn(wt, "rev-parse", "HEAD"), oldTip);
    assert.equal(readFileSync(join(wt, "shared.txt"), "utf8"), "branch content\n");
    idle(wt);
  }));

test("a conflict restacks under a colored git config", () =>
  scenario(({ env, fx, repo }) => {
    commitFile(fx.main, "c.txt", "one\n");
    gitIn(fx.main, "push", "--quiet", "origin", "main");
    const wt = worktree(repo, "feat-a");
    const wtRepo = resolveRepo(wt);
    commitFile(wt, "c.txt", "branch\n");
    commitFile(wt, "extra.txt", "extra\n");
    advanceOrigin(env, fx, "c.txt", "main\n");
    gitIn(fx.main, "config", "color.ui", "always");
    gitIn(fx.main, "config", "color.diff", "always");

    const r = rebase(wtRepo, wt, "origin/main");
    assert.equal(r.result, "restacked");
    assert.deepEqual(r.conflicts, ["c.txt"]);
    assert.match(readFileSync(join(wt, "c.txt"), "utf8"), /<<<<<<</);
    assert.equal(readFileSync(join(wt, "extra.txt"), "utf8"), "extra\n");
    assert.equal(gitIn(wt, "rev-parse", "HEAD"), gitIn(wt, "rev-parse", "origin/main"));
    gitIn(wt, "diff", "--cached", "--quiet");
    idle(wt);
  }));

test("restack directly reports conflicts under a colored git config", () =>
  scenario(({ env, fx, repo }) => {
    commitFile(fx.main, "c.txt", "one\n");
    gitIn(fx.main, "push", "--quiet", "origin", "main");
    const wt = worktree(repo, "feat-a");
    commitFile(wt, "c.txt", "branch\n");
    advanceOrigin(env, fx, "c.txt", "main\n");
    gitIn(fx.main, "config", "color.ui", "always");
    gitIn(fx.main, "config", "color.diff", "always");

    assert.deepEqual(restack(resolveRepo(wt), wt, "origin/main").conflicts, ["c.txt"]);
    idle(wt);
  }));

test("a restack ignores a zero diff context in the git config", () =>
  scenario(({ env, fx, repo }) => {
    const base = numbered(12);
    commitFile(fx.main, "f.txt", base);
    gitIn(fx.main, "push", "--quiet", "origin", "main");
    const wt = worktree(repo, "feat-a");
    commitFile(wt, "f.txt", base.replace("line 10\n", "branch\n"));
    const main = base.replace("line 2\n", "main\n");
    advanceOrigin(env, fx, "f.txt", main);
    gitIn(fx.main, "config", "diff.context", "0");

    assert.deepEqual(restack(resolveRepo(wt), wt, "origin/main").conflicts, []);
    assert.equal(readFileSync(join(wt, "f.txt"), "utf8"), main.replace("line 10\n", "branch\n"));
    idle(wt);
  }));

test("a restack keeps nested paths under diff.noprefix", () =>
  scenario(({ env, fx, repo }) => {
    const wt = worktree(repo, "feat-a");
    commitFile(wt, "docs/deep/n.md", "nested\n");
    advanceOrigin(env, fx, "other.txt", "other\n");
    gitIn(fx.main, "config", "diff.noprefix", "true");

    assert.deepEqual(restack(resolveRepo(wt), wt, "origin/main").conflicts, []);
    assert.equal(readFileSync(join(wt, "docs/deep/n.md"), "utf8"), "nested\n");
    assert.equal(existsSync(join(wt, "deep/n.md")), false);
    idle(wt);
  }));

test("a restack keeps a rename under diff.renames=false", () =>
  scenario(({ env, fx, repo }) => {
    const base = numbered(12);
    commitFile(fx.main, "a.txt", base);
    gitIn(fx.main, "push", "--quiet", "origin", "main");
    const wt = worktree(repo, "feat-a");
    gitIn(wt, "mv", "a.txt", "b.txt");
    gitIn(wt, "commit", "--quiet", "-m", "rename a to b");
    const main = base.replace("line 6\n", "main\n");
    advanceOrigin(env, fx, "a.txt", main);
    gitIn(fx.main, "config", "diff.renames", "false");

    assert.deepEqual(restack(resolveRepo(wt), wt, "origin/main").conflicts, []);
    assert.equal(existsSync(join(wt, "a.txt")), false);
    assert.equal(readFileSync(join(wt, "b.txt"), "utf8"), main);
    idle(wt);
  }));

test("a restack keeps edited renames under diff.renameLimit=1", () =>
  scenario(({ env, fx, repo }) => {
    const one = numbered(30);
    const two = numbered(30).replaceAll("line", "other");
    commitFile(fx.main, "src/one.txt", one);
    commitFile(fx.main, "src/two.txt", two);
    gitIn(fx.main, "push", "--quiet", "origin", "main");
    const wt = worktree(repo, "feat-a");
    gitIn(wt, "mv", "src/one.txt", "lib-a.txt");
    gitIn(wt, "mv", "src/two.txt", "lib-b.txt");
    commitFile(wt, "lib-a.txt", one.replace("line 20\n", "branch one\n"));
    const branchTwo = two.replace("other 20\n", "branch two\n");
    commitFile(wt, "lib-b.txt", branchTwo);
    const main = one.replace("line 6\n", "main\n");
    advanceOrigin(env, fx, "src/one.txt", main);
    gitIn(fx.main, "config", "diff.renameLimit", "1");

    assert.deepEqual(restack(resolveRepo(wt), wt, "origin/main").conflicts, []);
    assert.equal(existsSync(join(wt, "src/one.txt")), false);
    assert.equal(readFileSync(join(wt, "lib-a.txt"), "utf8"), main.replace("line 20\n", "branch one\n"));
    assert.equal(readFileSync(join(wt, "lib-b.txt"), "utf8"), branchTwo);
    idle(wt);
  }));

test("a restack ignores a missing diff.orderFile", () =>
  scenario(({ env, fx, repo }) => {
    const wt = worktree(repo, "feat-a");
    commitFile(wt, "a.txt", "a\n");
    advanceOrigin(env, fx, "other.txt", "other\n");
    gitIn(fx.main, "config", "diff.orderFile", "missing-order.txt");

    assert.deepEqual(restack(resolveRepo(wt), wt, "origin/main").conflicts, []);
    assert.equal(readFileSync(join(wt, "a.txt"), "utf8"), "a\n");
    idle(wt);
  }));

test("a restack refuses a deletion against an upstream re-indent under apply.ignoreWhitespace", () =>
  scenario(({ env, fx, repo }) => {
    commitFile(fx.main, "p.txt", "  one\n  two\n");
    gitIn(fx.main, "push", "--quiet", "origin", "main");
    const wt = worktree(repo, "feat-a");
    gitIn(wt, "rm", "p.txt");
    gitIn(wt, "commit", "--quiet", "-m", "delete p");
    const oldTip = gitIn(wt, "rev-parse", "HEAD");
    const main = "    one\n    two\n";
    advanceOrigin(env, fx, "p.txt", main);
    gitIn(fx.main, "config", "apply.ignoreWhitespace", "change");

    assert.throws(
      () => restack(resolveRepo(wt), wt, "origin/main"),
      (e: unknown) => e instanceof WtError && e.code === 1 && /could not be replayed/.test(e.message),
    );
    assert.equal(gitIn(wt, "rev-parse", "HEAD"), oldTip);
    assert.equal(existsSync(join(wt, "p.txt")), false);
    assert.equal(gitIn(wt, "show", "origin/main:p.txt"), main.trimEnd());
    idle(wt);
  }));

test("a rebase keeps a conflict under rebase.backend=apply and apply.ignoreWhitespace", () =>
  scenario(({ env, fx, repo }) => {
    commitFile(fx.main, "p.txt", "  one\n  two\n");
    gitIn(fx.main, "push", "--quiet", "origin", "main");
    const wt = worktree(repo, "feat-a");
    const wtRepo = resolveRepo(wt);
    gitIn(wt, "rm", "p.txt");
    gitIn(wt, "commit", "--quiet", "-m", "delete p");
    const oldTip = gitIn(wt, "rev-parse", "HEAD");
    advanceOrigin(env, fx, "p.txt", "    one\n    two\n");
    gitIn(fx.main, "config", "rebase.backend", "apply");
    gitIn(fx.main, "config", "apply.ignoreWhitespace", "change");

    assert.throws(
      () => rebase(wtRepo, wt, "origin/main"),
      (e: unknown) => e instanceof WtError && e.code === 1 && /could not be replayed/.test(e.message),
    );
    assert.equal(gitIn(wt, "rev-parse", "HEAD"), oldTip);
    idle(wt);
  }));

test("a restack and the digest ignore GIT_DIFF_OPTS", () =>
  scenario(({ env, fx, repo }) => {
    const base = numbered(12);
    commitFile(fx.main, "f.txt", base);
    gitIn(fx.main, "push", "--quiet", "origin", "main");
    const wt = worktree(repo, "feat-a");
    commitFile(wt, "f.txt", base.replace("line 10\n", "branch\n"));
    const main = base.replace("line 2\n", "main\n");
    advanceOrigin(env, fx, "f.txt", main);
    const wtRepo = resolveRepo(wt);
    const before = changeDigest(wtRepo, "origin/main", "HEAD");

    try {
      process.env.GIT_DIFF_OPTS = "--unified=0";
      assert.equal(changeDigest(wtRepo, "origin/main", "HEAD"), before);
      assert.deepEqual(restack(wtRepo, wt, "origin/main").conflicts, []);
      assert.equal(readFileSync(join(wt, "f.txt"), "utf8"), main.replace("line 10\n", "branch\n"));
      idle(wt);
    } finally {
      delete process.env.GIT_DIFF_OPTS;
    }
  }));

test("restack works directly and reports no conflicts for a clean replay", () =>
  scenario(({ env, fx, repo }) => {
    const wt = worktree(repo, "feat-a");
    commitFile(wt, "a.txt", "a\n");
    advanceOrigin(env, fx, "other.txt", "o\n");
    const r = restack(resolveRepo(wt), wt, "origin/main");
    assert.deepEqual(r.conflicts, []);
    assert.equal(r.backups.length, 1);
    assert.equal(readFileSync(join(wt, "a.txt"), "utf8"), "a\n");
    gitIn(wt, "diff", "--cached", "--quiet");
    idle(wt);
  }));

test("dirty tree refuses every history change", () =>
  scenario(({ fx, repo }) => {
    const wt = worktree(repo, "feat-a");
    commitFile(wt, "a.txt", "a\n");
    const wtRepo = resolveRepo(wt);
    writeFileSync(join(wt, "scratch.txt"), "x\n");
    const head = gitIn(wt, "rev-parse", "HEAD");
    const main = gitIn(fx.main, "rev-parse", "main");
    expectCode(() => rebase(wtRepo, wt, "origin/main"), 1);
    expectCode(() => restack(wtRepo, wt, "origin/main"), 1);
    expectCode(() => land(wtRepo, wt, "feat: a", "", head), 1);
    assert.equal(gitIn(wt, "rev-parse", "HEAD"), head);
    assert.equal(gitIn(fx.main, "rev-parse", "main"), main);
    assert.equal(gitIn(wt, "for-each-ref", "refs/wt-backup/"), "");
  }));

test("history changes refuse main", () =>
  scenario(({ repo, fx }) => {
    expectCode(() => rebase(repo, fx.main, "origin/main"), 1);
    expectCode(() => land(repo, fx.main, "feat: a", "", SHA), 1);
  }));

test("sync-main fast-forwards around unrelated dirty work", () =>
  scenario(({ env, fx, repo }) => {
    commitFile(fx.main, "b.txt", "b1\n");
    gitIn(fx.main, "push", "--quiet", "origin", "main");
    const tip = advanceOrigin(env, fx, "b.txt", "b2\n");
    writeFileSync(join(fx.main, "README.md"), "dirty\n");

    assert.deepEqual(syncMain(repo), { result: "fast-forwarded" });
    assert.equal(gitIn(fx.main, "rev-parse", "main"), tip);
    assert.equal(readFileSync(join(fx.main, "README.md"), "utf8"), "dirty\n");
    assert.equal(readFileSync(join(fx.main, "b.txt"), "utf8"), "b2\n");
    assert.deepEqual(syncMain(repo), { result: "up-to-date" });
  }));

test("sync-main refuses overlapping dirty work", () =>
  scenario(({ env, fx, repo }) => {
    commitFile(fx.main, "b.txt", "b1\n");
    gitIn(fx.main, "push", "--quiet", "origin", "main");
    const before = gitIn(fx.main, "rev-parse", "main");
    advanceOrigin(env, fx, "b.txt", "b2\n");
    writeFileSync(join(fx.main, "b.txt"), "mine\n");

    const r = syncMain(repo);
    assert.equal(r.result, "refused");
    assert.ok(r.reason && r.reason.length > 0);
    assert.equal(gitIn(fx.main, "rev-parse", "main"), before);
    assert.equal(readFileSync(join(fx.main, "b.txt"), "utf8"), "mine\n");
  }));

test("sync-main when main is not checked out", () =>
  scenario(({ env, fx, repo }) => {
    gitIn(fx.main, "checkout", "--quiet", "-b", "side");
    writeFileSync(join(fx.main, "README.md"), "dirty\n");
    const tip = advanceOrigin(env, fx, "new.txt", "n\n");

    assert.deepEqual(syncMain(repo), { result: "fast-forwarded" });
    assert.equal(gitIn(fx.main, "rev-parse", "refs/heads/main"), tip);
    assert.equal(gitIn(fx.main, "symbolic-ref", "--short", "HEAD"), "side");
    assert.equal(existsSync(join(fx.main, "new.txt")), false);
    assert.equal(readFileSync(join(fx.main, "README.md"), "utf8"), "dirty\n");
  }));

test("land makes one signed commit on main", () =>
  scenario(({ fx, repo }) => {
    const wt = worktree(repo, "feat-a");
    commitFile(wt, "a.txt", "a\n");
    commitFile(wt, "b.txt", "b\n");
    commitFile(wt, "a.txt", "a2\n");
    const wtRepo = resolveRepo(wt);
    const oldMain = gitIn(fx.main, "rev-parse", "main");
    const originMain = gitIn(fx.origin, "rev-parse", "main");

    const { commit, backups } = land(wtRepo, wt, "feat: add a and b", "Body line.", gitIn(wt, "rev-parse", "HEAD"));
    assert.equal(backups.length, 2);
    assert.match(backups[0] as string, /^refs\/wt-backup\/feat-a\//);
    assert.match(backups[1] as string, /^refs\/wt-backup\/main\//);
    assert.equal(gitIn(fx.main, "rev-parse", "main"), commit);
    assert.equal(gitIn(fx.main, "rev-list", "--count", `${oldMain}..main`), "1");
    assert.equal(gitIn(fx.main, "rev-parse", `${commit}^`), oldMain);
    assert.equal(gitIn(fx.main, "rev-parse", `${commit}^{tree}`), gitIn(wt, "rev-parse", "HEAD^{tree}"));
    gitIn(fx.main, "verify-commit", commit);
    assert.equal(gitIn(fx.main, "log", "-1", "--format=%s", commit), "feat: add a and b");
    assert.equal(gitIn(fx.main, "log", "-1", "--format=%b", commit).trim(), "Body line.");
    assert.equal(readRegistry(repo).worktrees["feat-a"]?.landedAs, commit);
    assert.equal(gitIn(fx.origin, "rev-parse", "main"), originMain, "nothing was pushed");
    assert.equal(readFileSync(join(fx.main, "a.txt"), "utf8"), "a2\n", "the main checkout follows");
  }));

test("land refuses a branch behind main", () =>
  scenario(({ fx, repo }) => {
    const wt = worktree(repo, "feat-a");
    commitFile(wt, "a.txt", "a\n");
    commitFile(fx.main, "m.txt", "m\n");
    const main = gitIn(fx.main, "rev-parse", "main");
    expectCode(() => land(resolveRepo(wt), wt, "feat: a", "", gitIn(wt, "rev-parse", "HEAD")), 1);
    assert.equal(gitIn(fx.main, "rev-parse", "main"), main);
    assert.equal(readRegistry(repo).worktrees["feat-a"]?.landedAs, undefined);
  }));

test("land refuses when the main checkout has overlapping uncommitted work", () =>
  scenario(({ fx, repo }) => {
    const wt = worktree(repo, "feat-a");
    commitFile(wt, "README.md", "from branch\n");
    writeFileSync(join(fx.main, "README.md"), "mine\n");
    const main = gitIn(fx.main, "rev-parse", "main");
    assert.throws(
      () => land(resolveRepo(wt), wt, "feat: a", "", gitIn(wt, "rev-parse", "HEAD")),
      (e: unknown) =>
        e instanceof WtError &&
        e.code === 1 &&
        /main did not move/.test(e.message) &&
        /unlanded commit/.test(e.message) &&
        /backup: refs\/wt-backup\/feat-a\/\S+ refs\/wt-backup\/main\//.test(e.message),
    );
    assert.equal(gitIn(fx.main, "rev-parse", "main"), main);
    assert.equal(readFileSync(join(fx.main, "README.md"), "utf8"), "mine\n");
    // landedAs was recorded before main was asked to move, and it is not on main.
    const recorded = readRegistry(repo).worktrees["feat-a"]?.landedAs;
    assert.match(recorded ?? "", /^[0-9a-f]{40}$/);
    assert.throws(() => gitIn(fx.main, "merge-base", "--is-ancestor", recorded as string, "main"));
  }));

test("land refuses a bad subject and an empty change", () =>
  scenario(({ repo }) => {
    const wt = worktree(repo, "feat-a");
    const wtRepo = resolveRepo(wt);
    expectCode(() => land(wtRepo, wt, "feat: a", "", gitIn(wt, "rev-parse", "HEAD")), 1);
    const head = commitFile(wt, "a.txt", "a\n");
    expectCode(() => land(wtRepo, wt, "two\nlines", "", head), 2);
    expectCode(() => land(wtRepo, wt, "x".repeat(73), "", head), 2);
    expectCode(() => land(wtRepo, wt, "feat:\u001b[31m a", "", head), 2);
    expectCode(() => land(wtRepo, wt, "", "", head), 2);
  }));

test("rebase, restack and land refuse a gitlink before touching anything", () =>
  scenario(({ fx, repo }) => {
    const wt = worktree(repo, "feat-a");
    const head = commitFile(wt, "a.txt", "a\n");
    gitIn(wt, "update-index", "--add", "--cacheinfo", `160000,${head},sub`);
    gitIn(wt, "commit", "--quiet", "-m", "add a gitlink");
    const tip = gitIn(wt, "rev-parse", "HEAD");
    const wtRepo = resolveRepo(wt);
    const main = gitIn(fx.main, "rev-parse", "main");
    for (const fn of [
      () => rebase(wtRepo, wt, "main"),
      () => restack(wtRepo, wt, "main"),
      () => land(wtRepo, wt, "feat: a", "", tip),
    ]) {
      assert.throws(fn, (e: unknown) => e instanceof WtError && e.code === 1 && /gitlink/.test(e.message));
    }
    assert.equal(gitIn(wt, "rev-parse", "HEAD"), tip);
    assert.equal(gitIn(fx.main, "rev-parse", "main"), main);
    assert.equal(gitIn(wt, "for-each-ref", "refs/wt-backup/"), "");
  }));

test("land lands a change to former trusted paths without any prompt", () =>
  scenario(({ fx, repo }) => {
    const wt = worktree(repo, "feat-a");
    commitFile(wt, "bin/x", "x\n");
    const tip = commitFile(wt, ".claude/skills/y/SKILL.md", "y\n");
    const { commit } = land(resolveRepo(wt), wt, "feat: a", "", tip);
    assert.equal(gitIn(fx.main, "rev-parse", "main"), commit);
  }));

test("digest: the same edit in an identical block of another function changes it", () =>
  scenario(({ fx, repo }) => {
    const block = (name: string) => `function ${name}() {\n  x1\n  x2\n  x3\n  dup\n  y1\n  y2\n  y3\n}\n\n`;
    const base = block("alpha") + block("beta");
    commitFile(fx.main, "f.js", base);
    gitIn(fx.main, "push", "--quiet", "origin", "main");
    const wt = worktree(repo, "feat-a");
    const wtRepo = resolveRepo(wt);
    const digestOf = (name: string): string => {
      gitIn(wt, "reset", "--hard", "--quiet", "origin/main");
      const edited = base.replace(
        `function ${name}() {\n  x1\n  x2\n  x3\n  dup`,
        `function ${name}() {\n  x1\n  x2\n  x3\n  changed`,
      );
      commitFile(wt, "f.js", edited);
      return changeDigest(wtRepo, "origin/main", "HEAD");
    };
    assert.notEqual(digestOf("alpha"), digestOf("beta"));
  }));

test("digest --head hashes the given commit, not the local HEAD", () =>
  scenario(async ({ repo }) => {
    const wt = worktree(repo, "feat-a");
    const wtRepo = resolveRepo(wt);
    const first = commitFile(wt, "a.txt", "a\n");
    const atFirst = changeDigest(wtRepo, "origin/main", "HEAD");
    commitFile(wt, "b.txt", "b\n");
    assert.notEqual(changeDigest(wtRepo, "origin/main", "HEAD"), atFirst);
    const out = await capture(() => commands.digest?.({ repo: wtRepo, args: ["--head", first] }));
    assert.equal(out, `${atFirst}\n`);
    const dflt = await capture(() => commands.digest?.({ repo: wtRepo, args: [] }));
    assert.equal(dflt, `${changeDigest(wtRepo, "origin/main", "HEAD")}\n`);
    expectCode(() => commands.digest?.({ repo: wtRepo, args: ["--head", "-x"] }), 2);
  }));

test("digest: a gitlink change never leaves the digest equal", () =>
  scenario(({ fx, repo }) => {
    const wt = worktree(repo, "feat-a");
    const wtRepo = resolveRepo(wt);
    const first = commitFile(wt, "a.txt", "a\n");
    const second = commitFile(wt, "b.txt", "b\n");
    const digestWith = (sha: string): string => {
      gitIn(wt, "reset", "--hard", "--quiet", "origin/main");
      gitIn(wt, "update-index", "--add", "--cacheinfo", `160000,${sha},sub`);
      gitIn(wt, "commit", "--quiet", "-m", "add a gitlink");
      return changeDigest(wtRepo, "origin/main", "HEAD");
    };
    const withFirst = digestWith(first);
    const withSecond = digestWith(second);
    gitIn(wt, "reset", "--hard", "--quiet", "origin/main");
    const empty = changeDigest(wtRepo, "origin/main", "HEAD");
    assert.notEqual(withFirst, withSecond, "another gitlink commit changes the digest");
    assert.notEqual(withFirst, empty, "a gitlink is part of the change");
    assert.ok(fx.main);
  }));

test("digest: a pure shift keeps it; the same change at another place or in another file changes it", () =>
  scenario(({ fx, repo }) => {
    const lines = Array.from({ length: 30 }, (_, i) => `line ${i + 1}\n`);
    lines[7] = "dup\n";
    lines[19] = "dup\n";
    const base = lines.join("");
    commitFile(fx.main, "f.txt", base);
    commitFile(fx.main, "g.txt", base);
    gitIn(fx.main, "push", "--quiet", "origin", "main");
    const wt = worktree(repo, "feat-a");
    const wtRepo = resolveRepo(wt);
    const edit = (file: string, index: number) => {
      const copy = [...lines];
      copy[index] = "changed\n";
      commitFile(wt, file, copy.join(""));
      return changeDigest(wtRepo, "origin/main", "HEAD");
    };
    const first = edit("f.txt", 7);
    gitIn(wt, "reset", "--hard", "--quiet", "origin/main");
    const elsewhere = edit("f.txt", 19);
    gitIn(wt, "reset", "--hard", "--quiet", "origin/main");
    const otherFile = edit("g.txt", 7);
    gitIn(wt, "reset", "--hard", "--quiet", "origin/main");
    const again = edit("f.txt", 7);
    assert.equal(again, first, "the same change gives the same digest");
    assert.notEqual(elsewhere, first, "the same +/- lines at another place");
    assert.notEqual(otherFile, first, "the same change in another file");
  }));

test("land lands only the approved head and refuses any other HEAD", () =>
  scenario(({ fx, repo }) => {
    const wt = worktree(repo, "feat-a");
    const approved = commitFile(wt, "a.txt", "a\n");
    commitFile(wt, "sneaky.txt", "later\n");
    const wtRepo = resolveRepo(wt);
    const main = gitIn(fx.main, "rev-parse", "main");
    assert.throws(
      () => land(wtRepo, wt, "feat: a", "", approved),
      (e: unknown) => e instanceof WtError && e.code === 1 && e.message === "HEAD is not the approved head commit.",
    );
    expectCode(() => land(wtRepo, wt, "feat: a", "", "abc"), 2);
    expectCode(() => land(wtRepo, wt, "feat: a", "", SHA), 1);
    assert.equal(gitIn(fx.main, "rev-parse", "main"), main);
    assert.equal(gitIn(wt, "for-each-ref", "refs/wt-backup/"), "");
    assert.equal(readRegistry(repo).worktrees["feat-a"]?.landedAs, undefined);
    // With the right head, the landed tree is that commit's tree.
    const { commit } = land(wtRepo, wt, "feat: a", "", gitIn(wt, "rev-parse", "HEAD"));
    assert.equal(gitIn(fx.main, "rev-parse", `${commit}^{tree}`), gitIn(wt, "rev-parse", "HEAD^{tree}"));
  }));

test("a rebase that fails for another reason than a conflict leaves the branch alone", () =>
  scenario(({ env, fx, repo }) => {
    const wt = worktree(repo, "feat-a");
    commitFile(wt, "a.txt", "a\n");
    commitFile(wt, "b.txt", "b\n");
    advanceOrigin(env, fx, "unrelated.txt", "u\n");
    const wtRepo = resolveRepo(wt);
    const oldTip = gitIn(wt, "rev-parse", "HEAD");
    gitIn(wt, "config", "user.signingkey", join(env.root, "no-such-key"));

    assert.throws(
      () => rebase(wtRepo, wt, "origin/main"),
      (e: unknown) =>
        e instanceof WtError &&
        e.code === 1 &&
        /^The rebase failed: /.test(e.message) &&
        /backup: refs\/wt-backup\/feat-a\/\d{8}T\d{6}Z/.test(e.message),
    );
    assert.equal(gitIn(wt, "rev-parse", "HEAD"), oldTip, "the branch tip is unchanged");
    assert.equal(gitIn(wt, "symbolic-ref", "--short", "HEAD"), "feat-a");
    assert.equal(gitIn(wt, "status", "--porcelain", "--untracked-files=all"), "", "no restacked change in the tree");
    assert.equal(readFileSync(join(wt, "a.txt"), "utf8"), "a\n");
    idle(wt);
    const backups = gitIn(wt, "for-each-ref", "--format=%(objectname)", "refs/wt-backup/feat-a/").split("\n");
    assert.deepEqual(backups, [oldTip]);
  }));

test("a failed signature in land names the backups and changes nothing", () =>
  scenario(({ env, fx, repo }) => {
    const wt = worktree(repo, "feat-a");
    const head = commitFile(wt, "a.txt", "a\n");
    gitIn(wt, "config", "user.signingkey", join(env.root, "no-such-key"));
    const main = gitIn(fx.main, "rev-parse", "main");
    assert.throws(
      () => land(resolveRepo(wt), wt, "feat: a", "", head),
      (e: unknown) => e instanceof WtError && e.code === 1 && /backup: refs\/wt-backup\/feat-a\//.test(e.message),
    );
    assert.equal(gitIn(fx.main, "rev-parse", "main"), main);
    assert.equal(readRegistry(repo).worktrees["feat-a"]?.landedAs, undefined);
  }));

// ---------------------------------------------------------------------------------------------
// Command output

async function capture(fn: () => unknown): Promise<string> {
  const original = process.stdout.write;
  let out = "";
  process.stdout.write = ((chunk: string | Uint8Array) => {
    if (typeof chunk === "string") out += chunk;
    return true;
  }) as typeof process.stdout.write;
  try {
    await fn();
  } finally {
    process.stdout.write = original;
  }
  return out;
}

test("rebase prints the result word first, then the backup, then conflicts", () =>
  scenario(async ({ env, fx, repo }) => {
    commitFile(fx.main, "c.txt", "one\n");
    gitIn(fx.main, "push", "--quiet", "origin", "main");
    const wt = worktree(repo, "feat-a");
    const wtRepo = resolveRepo(wt);
    commitFile(wt, "c.txt", "branch\n");
    advanceOrigin(env, fx, "c.txt", "main\n");

    const lines = (await capture(() => commands.rebase?.({ repo: wtRepo, args: [] }))).split("\n");
    assert.equal(lines[0], "restacked");
    assert.match(lines[1] as string, /^backup: refs\/wt-backup\/feat-a\/\d{8}T\d{6}Z$/);
    assert.equal(lines[2], "conflict: c.txt");
    assert.equal(lines[3], "");

    // New branches start from local main, so bring it level with origin first.
    gitIn(fx.main, "pull", "--quiet", "--ff-only", "origin", "main");
    const fresh = worktree(repo, "feat-b");
    const clean = await capture(() => commands.rebase?.({ repo: resolveRepo(fresh), args: [] }));
    assert.equal(clean, "up-to-date\n");
  }));

test("restack prints its backup before the conflicts", () =>
  scenario(async ({ env, fx, repo }) => {
    const wt = worktree(repo, "feat-a");
    commitFile(wt, "a.txt", "a\n");
    advanceOrigin(env, fx, "o.txt", "o\n");
    const out = await capture(() => commands.restack?.({ repo: resolveRepo(wt), args: [] }));
    assert.match(out, /^restacked\nbackup: refs\/wt-backup\/feat-a\/\d{8}T\d{6}Z\n$/);
  }));

test("land prints its backups, then landed <sha> as the last line", () =>
  scenario(async ({ env, fx, repo }) => {
    const wt = worktree(repo, "feat-a");
    const head = commitFile(wt, "a.txt", "a\n");
    const bodyFile = join(env.root, "body.md");
    writeFileSync(bodyFile, "Body.\n");
    const wtRepo = resolveRepo(wt);

    assert.throws(
      () => commands.land?.({ repo: wtRepo, args: ["--subject", "feat: a", "--body-file", bodyFile] }),
      (e: unknown) => e instanceof WtError && e.code === 2,
    );
    assert.throws(
      () =>
        commands.land?.({
          repo: wtRepo,
          args: ["--match-head", "abc", "--subject", "feat: a", "--body-file", bodyFile],
        }),
      (e: unknown) => e instanceof WtError && e.code === 2,
    );
    const text = await capture(() =>
      commands.land?.({
        repo: wtRepo,
        args: ["--match-head", head, "--subject", "feat: a", "--body-file", bodyFile],
      }),
    );
    const lines = text.trimEnd().split("\n");
    assert.equal(lines.length, 3);
    assert.match(lines[0] as string, /^backup: refs\/wt-backup\/feat-a\//);
    assert.match(lines[1] as string, /^backup: refs\/wt-backup\/main\//);
    assert.equal(lines[2], `landed ${gitIn(fx.main, "rev-parse", "main")}`);
  }));

test("conflict lines replace C0, DEL and C1 control characters", () => {
  const text = conflictLines(["a\u0085b\u009bc\u0007d\u007fe\u0080f\u009fg.txt", "plain é.txt"]);
  assert.equal(text, "conflict: a?b?c?d?e?f?g.txt\nconflict: plain é.txt\n");
});
