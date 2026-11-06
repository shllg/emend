import assert from "node:assert/strict";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import {
  assertNoGitlinks,
  assertNoGitlinksInRef,
  fetchOrigin,
  GIT_BASE,
  git,
  gitTry,
  type Repo,
  requireGlobalIdentity,
  resolveRepo,
} from "./repo.ts";
import {
  type Fixture,
  fakeCalls,
  gitIn,
  installFake,
  makeFixture,
  makeTestEnv,
  runLauncher,
  runWt,
  type TestEnv,
} from "./test-support.ts";
import { WtError } from "./validate.ts";
import { safetyGuard, setup } from "./worktree.ts";

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

function expectCode(fn: () => unknown, code: number): void {
  assert.throws(fn, (e: unknown) => e instanceof WtError && e.code === code, `expected exit ${code}`);
}

test("R8.4: global identity works in linked worktrees with the extension unset, false or true", () =>
  scenario({}, ({ fx, repo }) => {
    const linked = setup(repo, { branch: "identity-a", busy: new Set() }).path;
    for (const enabled of [undefined, "false", "true"]) {
      if (enabled !== undefined) gitIn(fx.main, "config", "--local", "extensions.worktreeConfig", enabled);
      for (const top of [fx.main, linked]) {
        for (const key of ["user.name", "user.email"])
          assert.equal(gitTry(repo, ["config", "--local", "--get", key], { cwd: top }).code, 1);
        assert.doesNotThrow(() => requireGlobalIdentity(repo, top));
      }
    }
  }));

test("R9.3: identity scope parsing allows global/system and refuses all other or unreadable scopes", () =>
  scenario({}, ({ fx, repo, env }) => {
    rmSync(join(env.fakeBin, "git"));
    for (const scope of ["system", "global", "local", "worktree", "command", "unexpected"]) {
      installFake(env, "git", [
        { match: ["config", "--includes", "--show-scope", "--get-all"], stdout: `${scope}\tsynthetic identity\n` },
      ]);
      if (["system", "global"].includes(scope)) assert.doesNotThrow(() => requireGlobalIdentity(repo, fx.main));
      else
        assert.throws(
          () => requireGlobalIdentity(repo, fx.main),
          (error: unknown) =>
            error instanceof WtError &&
            error.message ===
              `a git identity with ${scope === "unexpected" ? "unknown" : scope} scope is set; bin/wt checks only global and system identities.`,
        );
      assert.ok(fakeCalls(env, "git").every((args) => args.includes("--includes") && args.includes("--show-scope")));
    }
    installFake(env, "git", [{ code: 128 }]);
    assert.throws(() => requireGlobalIdentity(repo, fx.main), /Could not check the scope/);
    installFake(env, "git", [{ code: 1 }]);
    assert.doesNotThrow(() => requireGlobalIdentity(repo, fx.main));
  }));

for (const conditional of [false, true]) {
  test(`R9.3: local ${conditional ? "includeIf" : "include.path"} identities are refused`, () =>
    scenario({}, ({ fx, repo, env }) => {
      const included = join(env.root, "included.gitconfig");
      writeFileSync(included, "[user]\nname = Synthetic User\nemail = synthetic@example.com\n");
      gitIn(fx.main, "config", "--local", conditional ? `includeIf.gitdir:${fx.main}/.path` : "include.path", included);
      assert.throws(
        () => requireGlobalIdentity(repo, fx.main),
        (error: unknown) =>
          error instanceof WtError &&
          error.message === "a git identity with local scope is set; bin/wt checks only global and system identities.",
      );
    }));
}

test("R9.3: an environment identity triple refuses before any Git call", () =>
  scenario({}, ({ fx, repo, env }) => {
    rmSync(join(env.fakeBin, "git"));
    installFake(env, "git", [{ code: 128 }]);
    process.env.GIT_CONFIG_COUNT = "1";
    process.env.GIT_CONFIG_KEY_0 = "user.name";
    process.env.GIT_CONFIG_VALUE_0 = "Synthetic User";
    try {
      assert.throws(
        () => requireGlobalIdentity(repo, fx.main),
        (error: unknown) =>
          error instanceof WtError &&
          error.message ===
            "a git identity with command scope is set; bin/wt checks only global and system identities.",
      );
      assert.deepEqual(fakeCalls(env, "git"), []);
    } finally {
      delete process.env.GIT_CONFIG_COUNT;
      delete process.env.GIT_CONFIG_KEY_0;
      delete process.env.GIT_CONFIG_VALUE_0;
    }
  }));

const GITLINK_SHA = "1111111111111111111111111111111111111111";

/**
 * A directory `evil` an agent could write: its `.git` file leads to a fake git directory whose `commondir` is
 * the main checkout's `.git`, with an index that holds a gitlink to `evil/nested`, a repository whose clean
 * filter creates `marker`. A `bin/wt` launcher inside `evil` creates `launcherMarker` if anything runs it.
 */
function forge(env: TestEnv, main: string): { evil: string; marker: string; launcherMarker: string } {
  const evil = join(env.root, "evil");
  const fake = join(evil, ".fake-git");
  const nested = join(evil, "nested");
  const marker = join(env.root, "FILTER-RAN");
  const launcherMarker = join(env.root, "LAUNCHER-RAN");
  mkdirSync(nested, { recursive: true });
  mkdirSync(fake, { recursive: true });
  gitIn(nested, "init", "--quiet", "-b", "main");
  gitIn(nested, "config", "filter.m.clean", `echo x > ${marker}; cat`);
  writeFileSync(join(nested, ".gitattributes"), "* filter=m\n");
  writeFileSync(join(nested, "f.txt"), "x\n");

  const idx = join(env.root, "idx");
  mkdirSync(idx);
  gitIn(idx, "init", "--quiet", "-b", "main");
  gitIn(idx, "update-index", "--add", "--cacheinfo", `160000,${GITLINK_SHA},nested`);
  copyFileSync(join(idx, ".git", "index"), join(fake, "index"));

  writeFileSync(join(evil, ".git"), `gitdir: ${fake}\n`);
  writeFileSync(join(fake, "HEAD"), "ref: refs/heads/main\n");
  writeFileSync(join(fake, "commondir"), `${main}/.git\n`);
  mkdirSync(join(evil, "bin"));
  writeFileSync(join(evil, "bin", "wt"), `#!/bin/sh\necho x > ${launcherMarker}\n`);
  chmodSync(join(evil, "bin", "wt"), 0o755);
  return { evil, marker, launcherMarker };
}

test("a forged repository is refused with exit 69 and nothing from it runs", () =>
  scenario({ withBin: true }, async ({ env, fx }) => {
    const { evil, marker, launcherMarker } = forge(env, fx.main);
    expectCode(() => resolveRepo(evil), 69);
    const out = await runWt(join(fx.main, "bin", "wt"), ["list"], { cwd: evil });
    assert.equal(out.code, 69, out.stderr);
    assert.equal(out.stderr.includes(evil), false, "the message does not echo the path");
    assert.equal(existsSync(marker), false, "the clean filter must not run");
    assert.equal(existsSync(launcherMarker), false, "the launcher in the directory must not run");
  }));

test("a worktree is accepted only with the layout git itself writes", () =>
  scenario({}, ({ env, fx, repo }) => {
    const w = setup(repo, { branch: "lay-a", busy: new Set() });
    const ok = resolveRepo(w.path);
    assert.equal(ok.callerTop, w.path);
    assert.equal(ok.callerBranch, "lay-a");

    const gitfile = join(w.path, ".git");
    const original = readFileSync(gitfile, "utf8");
    // another path, extra text, a gitdir with another id
    writeFileSync(gitfile, "gitdir: /nonexistent\n");
    expectCode(() => resolveRepo(w.path), 1); // git itself finds no repository there
    writeFileSync(gitfile, `${original}extra\n`);
    assert.throws(
      () => resolveRepo(w.path),
      (e: unknown) => e instanceof WtError && (e.code === 1 || e.code === 69),
    );
    writeFileSync(gitfile, `gitdir: ${join(fx.main, ".git", "worktrees", "other-id")}\n`);
    expectCode(() => resolveRepo(w.path), 1); // git itself finds no such directory
    writeFileSync(gitfile, original);
    assert.equal(resolveRepo(w.path).callerTop, w.path);

    // the worktree's own gitdir file or commondir file names something else
    const admin = join(fx.main, ".git", "worktrees", "lay-a");
    const gitdirFile = readFileSync(join(admin, "gitdir"), "utf8");
    writeFileSync(join(admin, "gitdir"), `${join(env.root, "elsewhere", ".git")}\n`);
    expectCode(() => resolveRepo(w.path), 69);
    writeFileSync(join(admin, "gitdir"), gitdirFile);
    const other = join(env.root, "other-common");
    mkdirSync(other);
    gitIn(other, "init", "--quiet", "-b", "main");
    writeFileSync(join(admin, "commondir"), `${join(other, ".git")}\n`);
    expectCode(() => resolveRepo(w.path), 69);
    writeFileSync(join(admin, "commondir"), "../..\n");
    assert.equal(resolveRepo(w.path).callerTop, w.path);

    // a symlinked `.git` is not a regular file, even when it leads to the right content
    const moved = join(env.root, "moved-gitfile");
    writeFileSync(moved, original);
    rmSync(gitfile);
    symlinkSync(moved, gitfile);
    expectCode(() => resolveRepo(w.path), 69);
  }));

test("resolveRepo of another repository resolves that repository", () =>
  scenario({}, ({ env, fx }) => {
    const other = join(env.root, "other");
    mkdirSync(other);
    gitIn(other, "init", "--quiet", "-b", "main");
    assert.equal(resolveRepo(other).mainRoot, other);
    assert.equal(resolveRepo(fx.main).callerTop, fx.main);
  }));

test("every git call carries the submodule and monitor settings", () =>
  scenario({}, ({ repo }) => {
    assert.equal(git(repo, ["config", "--get", "core.fsmonitor"]), "false");
    assert.equal(git(repo, ["config", "--get", "submodule.recurse"]), "false");
    assert.equal(git(repo, ["config", "--get", "push.recurseSubmodules"]), "no");
    assert.equal(git(repo, ["config", "--get", "status.submoduleSummary"]), "false");
    assert.equal(git(repo, ["config", "--get", "diff.ignoreSubmodules"]), "all");
    assert.equal(git(repo, ["config", "--get", "diff.submodule"]), "short");
    assert.ok(GIT_BASE.join(" ").includes("-c diff.submodule=short"));
  }));

test("every git call overrides the configured color settings", () =>
  scenario({}, ({ fx, repo }) => {
    gitIn(fx.main, "config", "color.ui", "always");
    gitIn(fx.main, "config", "color.diff", "always");
    assert.equal(git(repo, ["config", "--get", "color.diff"]), "never");
    assert.equal(git(repo, ["config", "--get", "color.ui"]), "never");
  }));

test("assertNoGitlinks refuses a gitlink in the index and in HEAD", () =>
  scenario({}, ({ fx, repo }) => {
    assertNoGitlinks(repo, fx.main);
    gitIn(fx.main, "update-index", "--add", "--cacheinfo", `160000,${GITLINK_SHA},sub`);
    expectCode(() => assertNoGitlinks(repo, fx.main), 1);
    gitIn(fx.main, "commit", "--quiet", "-m", "add a gitlink");
    // take it out of the index again: HEAD still holds it
    gitIn(fx.main, "update-index", "--force-remove", "sub");
    assert.equal(gitIn(fx.main, "ls-files", "--stage").includes("160000"), false);
    expectCode(() => assertNoGitlinks(repo, fx.main), 1);
    assert.throws(
      () => assertNoGitlinks(repo, fx.main),
      (e: unknown) => e instanceof WtError && /gitlink \(submodule\) entry is in HEAD or the index/.test(e.message),
    );
  }));

test("the safety guard names a gitlink before any status runs", () =>
  scenario({}, ({ repo }) => {
    const w = setup(repo, { branch: "g-link", busy: new Set() });
    assert.deepEqual(safetyGuard(repo, "g-link"), { ok: true });
    gitIn(w.path, "update-index", "--add", "--cacheinfo", `160000,${GITLINK_SHA},sub`);
    assert.deepEqual(safetyGuard(repo, "g-link"), { ok: false, failed: "gitlink" });
  }));

test("setup refuses an existing branch that holds a gitlink and creates nothing", () =>
  scenario({}, ({ fx, repo }) => {
    gitIn(fx.main, "checkout", "--quiet", "-b", "has-link");
    gitIn(fx.main, "update-index", "--add", "--cacheinfo", `160000,${GITLINK_SHA},sub`);
    gitIn(fx.main, "commit", "--quiet", "-m", "gitlink");
    gitIn(fx.main, "checkout", "--quiet", "main");
    expectCode(() => assertNoGitlinksInRef(repo, "refs/heads/has-link"), 1);
    expectCode(() => setup(repo, { branch: "has-link", busy: new Set() }), 1);
    assert.equal(existsSync(join(repo.worktreesDir, "has-link")), false);
  }));

// ---------------------------------------------------------------------------------------------
// The launcher

test("the launcher runs main.ts and works through a symlink", () =>
  scenario({ withBin: true }, async ({ env, fx }) => {
    const direct = await runLauncher(join(fx.main, "bin", "wt"), ["list"], { cwd: fx.main });
    assert.equal(direct.code, 0, direct.stderr);
    assert.equal(direct.stdout.trim(), "No worktrees.");
    const linkDir = join(env.root, "links");
    mkdirSync(linkDir);
    symlinkSync(join(fx.main, "bin", "wt"), join(linkDir, "wt"));
    symlinkSync(join(linkDir, "wt"), join(linkDir, "wt2"));
    for (const name of ["wt", "wt2"]) {
      // readlink is not in the test PATH, which holds only the tools the fixtures need
      const r = await runLauncher(join(linkDir, name), ["list"], {
        cwd: fx.main,
        env: { PATH: `${env.fakeBin}:${env.realPath}` },
      });
      assert.equal(r.code, 0, r.stderr);
      assert.equal(r.stdout.trim(), "No worktrees.");
    }
  }));

test("the launcher run in a forged directory exits 69 and runs nothing from it", () =>
  scenario({ withBin: true }, async ({ env, fx }) => {
    const { evil, marker, launcherMarker } = forge(env, fx.main);
    const r = await runLauncher(join(fx.main, "bin", "wt"), ["list"], { cwd: evil });
    assert.equal(r.code, 69, r.stderr);
    assert.equal(existsSync(marker), false);
    assert.equal(existsSync(launcherMarker), false);
  }));

test("R10.E: local git errors stay readable while fetch errors withhold hits", () =>
  scenario({}, ({ fx, repo, env }) => {
    writeFileSync(join(fx.main, ".private-terms"), "alice example");
    rmSync(join(env.fakeBin, "git"));
    for (const [text, label] of [
      ["alice-example", "private term (file line 1)"],
      [["person", "mail.fixture"].join("@"), "email address"],
    ]) {
      installFake(env, "git", [{ code: 128, stderr: `${text}\u202e\n` }]);
      assert.throws(
        () => git(repo, ["status"]),
        (error: unknown) => error instanceof WtError && error.message === `git status failed: ${text}`,
      );
      assert.throws(
        () => fetchOrigin(repo),
        (error: unknown) =>
          error instanceof WtError && error.message === `Could not fetch from origin: [line withheld: ${label}]`,
      );
    }
  }));
