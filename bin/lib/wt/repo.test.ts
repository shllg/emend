import assert from "node:assert/strict";
import childProcess from "node:child_process";
import fs, {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { join } from "node:path";
import { test } from "node:test";
import { push } from "./github.ts";
import { land, rebase, restack, syncMain } from "./history.ts";
import { gitRuntime, run, runBytes } from "./proc.ts";
import {
  assertNoGitlinks,
  assertNoGitlinksInRef,
  fetchOrigin,
  GIT_BASE,
  git,
  gitBytes,
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
  // These Git and registry fixtures never start listeners.
  const env = makeTestEnv({ ports: false });
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
      installFake(env, "git", [
        { match: ["--version"], stdout: "git version 2.44.0\n" },
        { code: 128, stderr: `${text}\u202e\n` },
      ]);
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

test("G14: git global options cannot route remote or unknown command errors through local diagnostics", (t) => {
  t.mock.method(gitRuntime, "supportsNoLazyFetch", () => true);
  const repo = { mainRoot: "/synthetic-unused", commonDir: "/synthetic-unused/.git" } as Repo;
  const token = ["gh", "p_", "Ab01".repeat(9)].join("");
  const child = t.mock.method(childProcess, "spawnSync", () => ({ status: 128, stdout: "", stderr: token }));
  const reader = t.mock.method(fs, "readFileSync", () => {
    throw Object.assign(new Error("missing fixture"), { code: "ENOENT" });
  });
  syncBuiltinESMExports();
  try {
    for (const args of [
      ["-c", "color.ui=false", "fetch"],
      ["-C", repo.mainRoot, "fetch"],
      [`--git-dir=${repo.commonDir}`, "fetch"],
      ["--no-pager", "fetch"],
      ["--work-tree", repo.mainRoot, "fetch"],
      ["--config-env=color.ui=UNUSED", "fetch"],
      ["pull"],
      ["clone"],
      ["synthetic-alias"],
      ["--future-option", "status"],
    ])
      assert.throws(
        () => git(repo, args),
        (error: unknown) =>
          error instanceof WtError && !error.message.includes(token) && error.message.includes("withheld"),
      );
    assert.throws(
      () => git(repo, ["--no-pager", "-c", "color.ui=false", "status"]),
      (error: unknown) => error instanceof WtError && error.message === `git status failed: ${token}`,
    );
  } finally {
    reader.mock.restore();
    child.mock.restore();
    syncBuiltinESMExports();
  }
});

test("R2.4: local Git calls disable lazy fetch and remote calls remove the setting", (t) => {
  const repo = { mainRoot: "/synthetic-unused" } as Repo;
  const previous = process.env.GIT_NO_LAZY_FETCH;
  const child = t.mock.method(childProcess, "spawnSync", (..._args: unknown[]) => ({
    status: 0,
    stdout: Buffer.alloc(0),
    stderr: Buffer.alloc(0),
  }));
  syncBuiltinESMExports();
  try {
    for (const inherited of [undefined, "0", "1"]) {
      if (inherited === undefined) delete process.env.GIT_NO_LAZY_FETCH;
      else process.env.GIT_NO_LAZY_FETCH = inherited;
      for (const execute of [git, gitTry, gitBytes]) {
        for (const [args, expected] of [
          [["show", "HEAD"], "1"],
          [["cat-file", "-t", "HEAD"], "1"],
          [["checkout", "fixture"], undefined],
          [["switch", "fixture"], undefined],
          [["-c", "color.ui=false", "--no-pager", "show", "HEAD"], "1"],
          [["fetch", "origin"], undefined],
          [["push", "origin"], undefined],
          [["ls-remote", "origin"], undefined],
          [["fixture-alias"], undefined],
        ] as const) {
          execute(repo, [...args]);
          const options = child.mock.calls.at(-1)?.arguments[2] as { env: NodeJS.ProcessEnv };
          assert.equal(options.env.GIT_NO_LAZY_FETCH, expected);
          assert.equal(process.env.GIT_NO_LAZY_FETCH, inherited);
        }
      }
    }
  } finally {
    if (previous === undefined) delete process.env.GIT_NO_LAZY_FETCH;
    else process.env.GIT_NO_LAZY_FETCH = previous;
    child.mock.restore();
    syncBuiltinESMExports();
  }
});

test("R3.9: missing -C values fail closed and equals-form git-dir preserves local classification", (t) => {
  t.mock.method(gitRuntime, "supportsNoLazyFetch", () => true);
  const repo = { mainRoot: "/synthetic-unused", commonDir: "/synthetic-unused/.git" } as Repo;
  const token = ["gh", "p_", "Ab01".repeat(9)].join("");
  const child = t.mock.method(childProcess, "spawnSync", () => ({ status: 128, stdout: "", stderr: token }));
  const reader = t.mock.method(fs, "readFileSync", () => {
    throw Object.assign(new Error("absent"), { code: "ENOENT" });
  });
  syncBuiltinESMExports();
  try {
    assert.throws(() => git(repo, ["-C"]), /git command failed: \[line withheld: secret shape\]/);
    assert.throws(
      () => git(repo, [`--git-dir=${repo.commonDir}`, "fetch"]),
      /git fetch failed: \[line withheld: secret shape\]/,
    );
    assert.throws(
      () => git(repo, [`--git-dir=${repo.commonDir}`, "status"]),
      (error: unknown) => error instanceof WtError && error.message === `git status failed: ${token}`,
    );
  } finally {
    child.mock.restore();
    reader.mock.restore();
    syncBuiltinESMExports();
  }
});

for (const supported of [true, false])
  for (const failure of [
    "diff-tree",
    "apply",
    "rebase",
    "merge",
    "fetch-local",
    "commit-tree",
    "reflog",
    "merge-base",
  ]) {
    test(`R3.3/R4.11: ${failure} diagnostics use protected Git command sequences (lazy-fetch pin ${supported})`, (t) => {
      t.mock.method(gitRuntime, "supportsNoLazyFetch", () => supported);
      const repo = { mainRoot: "/synthetic-unused", commonDir: "/synthetic-unused/.git" } as Repo;
      const old = "a".repeat(40),
        target = "b".repeat(40);
      const token = ["gh", "p_", "Ab01".repeat(9)].join("");
      const calls: { command: string; env: NodeJS.ProcessEnv; args: string[] }[] = [];
      const child = t.mock.method(
        childProcess,
        "spawnSync",
        (_cmd: string, args: string[], options: { env: NodeJS.ProcessEnv; encoding?: string }) => {
          const command = args.find((arg) =>
            [
              "config",
              "symbolic-ref",
              "rev-parse",
              "ls-files",
              "ls-tree",
              "status",
              "merge-base",
              "diff-tree",
              "reset",
              "diff",
              "apply",
              "update-ref",
              "rebase",
              "fetch",
              "worktree",
              "merge",
              "commit-tree",
              "reflog",
              "remote",
              "ls-remote",
              "cat-file",
              "rev-list",
              "push",
            ].includes(arg),
          );
          assert.ok(command, `unexpected command: ${args.join(" ")}`);
          assert.notEqual(command, "push", "the mocked sequence must stop before any push");
          if (options.encoding) calls.push({ command, env: options.env, args });
          let status = 0,
            stdout = "",
            stderr = "";
          if (command === failure || (failure === "fetch-local" && command === "fetch" && args.includes("."))) {
            status = 128;
            stderr = token;
          } else if (command === "symbolic-ref")
            stdout = args.includes("--short") ? "emend-fixture" : "refs/heads/emend-fixture";
          else if (command === "config") status = 1;
          else if (command === "rev-parse") {
            const ref = args.at(-1) ?? "";
            if (ref.startsWith("refs/wt-backup/")) status = 1;
            else if (ref === "--git-dir") stdout = repo.commonDir;
            else stdout = ref.includes("main") || ref === `${target}^{tree}` ? target : old;
          } else if (command === "merge-base") {
            if (args.includes("--is-ancestor")) status = failure === "commit-tree" ? 0 : 1;
            else stdout = target;
          } else if (command === "diff") status = 1;
          else if (command === "diff-tree") stdout = failure === "commit-tree" ? "" : "synthetic patch";
          else if (command === "worktree")
            stdout = failure === "fetch-local" ? "" : `worktree ${repo.mainRoot}\nbranch refs/heads/main\n`;
          else if (command === "remote") stdout = "synthetic-origin";
          else if (command === "ls-remote") stdout = `${target}\trefs/heads/emend-fixture\n`;
          else if (command === "cat-file") stdout = `${target} commit\n`;
          else if (command === "reflog") stdout = old;
          const encode = (text: string) => (options.encoding === "utf8" ? text : Buffer.from(text));
          return { status, stdout: encode(stdout), stderr: encode(stderr) };
        },
      );
      const reader = t.mock.method(fs, "readFileSync", () => Buffer.from("fixture concealed phrase\n"));
      const exists = t.mock.method(fs, "existsSync", () => false);
      syncBuiltinESMExports();
      try {
        if (failure === "merge" || failure === "fetch-local") {
          const result = syncMain(repo);
          assert.equal(result.result, "refused");
          assert.equal(result.reason, "[line withheld: secret shape]");
        } else {
          const action =
            failure === "reflog" || failure === "merge-base"
              ? () => push(repo, repo.mainRoot, { forceWithLease: true })
              : failure === "commit-tree"
                ? () => land(repo, repo.mainRoot, "public fixture", "", old)
                : failure === "rebase"
                  ? () => rebase(repo, repo.mainRoot, "main")
                  : () => restack(repo, repo.mainRoot, "main");
          assert.throws(
            action,
            (error: unknown) =>
              error instanceof WtError &&
              error.message.includes(supported && failure !== "rebase" ? token : "[line withheld: secret shape]"),
          );
        }
        assert.ok(calls.some((call) => call.command === (failure === "fetch-local" ? "fetch" : failure)));
        for (const call of calls)
          assert.equal(
            call.env.GIT_NO_LAZY_FETCH,
            ["fetch", "rebase", "merge", "reset", "worktree"].includes(call.command) ? undefined : "1",
            call.command,
          );
      } finally {
        child.mock.restore();
        reader.mock.restore();
        exists.mock.restore();
        syncBuiltinESMExports();
      }
    });
  }

test("R4.1: every process helper strips forced terminal output without changing the parent", (t) => {
  const previous = process.env.GH_FORCE_TTY;
  process.env.GH_FORCE_TTY = "80";
  const child = t.mock.method(childProcess, "spawnSync", (...args: unknown[]) => {
    const options = args[2] as { env: NodeJS.ProcessEnv; encoding: string };
    assert.equal(options.env.GH_FORCE_TTY, undefined);
    return { status: 0, stdout: options.encoding === "buffer" ? Buffer.alloc(0) : "", stderr: "" };
  });
  syncBuiltinESMExports();
  try {
    for (const execute of [run, runBytes]) execute("gh", ["--version"], { cwd: "/" });
    assert.equal(process.env.GH_FORCE_TTY, "80");
  } finally {
    child.mock.restore();
    syncBuiltinESMExports();
    if (previous === undefined) delete process.env.GH_FORCE_TTY;
    else process.env.GH_FORCE_TTY = previous;
  }
});

test("final A: process helpers retain main sanitation and lazy-fetch controls", (t) => {
  const parent = {
    GH_HOST: "example.invalid",
    GH_FORCE_TTY: "80",
    GIT_DIR: "/synthetic/other",
    GIT_NO_LAZY_FETCH: "0",
  };
  t.mock.property(process, "env", parent);
  const child = t.mock.method(childProcess, "spawnSync", (...args: unknown[]) => {
    const options = args[2] as { env: NodeJS.ProcessEnv; encoding: string };
    return { status: 0, stdout: options.encoding === "buffer" ? Buffer.alloc(0) : "", stderr: "" };
  });
  syncBuiltinESMExports();
  try {
    for (const execute of [run, runBytes])
      for (const command of ["git", "gh", "synthetic-editor"])
        for (const gitNoLazyFetch of [true, false, undefined]) {
          execute(command, ["--version"], { cwd: "/synthetic", gitNoLazyFetch });
          const options = child.mock.calls.at(-1)!.arguments[2] as { env: NodeJS.ProcessEnv };
          assert.equal(options.env.GH_HOST, undefined);
          assert.equal(
            options.env.GIT_NO_LAZY_FETCH,
            gitNoLazyFetch === true ? "1" : gitNoLazyFetch === false ? undefined : "0",
          );
          assert.equal(options.env.GIT_DIR, command === "synthetic-editor" ? parent.GIT_DIR : undefined);
          assert.equal(options.env.GH_FORCE_TTY, command === "synthetic-editor" ? "80" : undefined);
        }
    assert.deepEqual(parent, {
      GH_HOST: "example.invalid",
      GH_FORCE_TTY: "80",
      GIT_DIR: "/synthetic/other",
      GIT_NO_LAZY_FETCH: "0",
    });
  } finally {
    child.mock.restore();
    syncBuiltinESMExports();
  }
});

test("R4.11: Git version is probed for every failure and unknown versions fail closed", async (t) => {
  for (const [version, expected] of [
    ["git version 2.43.9", false],
    ["git version 2.44.0", true],
    ["git version 3.0.0", true],
    ["unknown", false],
  ] as const) {
    const module = await import(new URL(`./proc.ts?fixture=${encodeURIComponent(version)}`, import.meta.url).href);
    const child = t.mock.method(childProcess, "spawnSync", (_cmd: string, args: string[]) => {
      assert.deepEqual(args, ["--version"]);
      return { status: 0, stdout: version, stderr: "" };
    });
    syncBuiltinESMExports();
    try {
      assert.equal(module.gitRuntime.supportsNoLazyFetch("/synthetic-unused"), expected);
      assert.equal(module.gitRuntime.supportsNoLazyFetch("/synthetic-unused"), expected);
      assert.equal(child.mock.callCount(), 2);
    } finally {
      child.mock.restore();
      syncBuiltinESMExports();
    }
  }
});

test("R4.11: ordinary local Git errors are filtered on old Git", (t) => {
  t.mock.method(gitRuntime, "supportsNoLazyFetch", () => false);
  const token = ["gh", "p_", "Ab01".repeat(9)].join("");
  const child = t.mock.method(childProcess, "spawnSync", () => ({ status: 128, stdout: "", stderr: token }));
  const reader = t.mock.method(fs, "readFileSync", () => Buffer.from("fixturephrase\n"));
  syncBuiltinESMExports();
  try {
    assert.throws(
      () => git({ mainRoot: "/synthetic-unused" } as Repo, ["status"]),
      /git status failed: \[line withheld: secret shape\]/,
    );
  } finally {
    child.mock.restore();
    reader.mock.restore();
    syncBuiltinESMExports();
  }
});

for (const first of ["modern", "old", "unanswered", "garbled"]) {
  test(`R4b: Git capabilities and local diagnostics follow PATH with ${first} queried first`, (t) => {
    const previousPath = process.env.PATH;
    const versions = [
      { name: "modern", status: 0, stdout: "git version 2.44.0", trusted: true },
      { name: "old", status: 0, stdout: "git version 2.43.0", trusted: false },
      { name: "unanswered", status: 1, stdout: "", trusted: false },
      { name: "garbled", status: 0, stdout: "unrecognized version", trusted: false },
    ].map((version) => ({ ...version, path: `/synthetic-unused/${first}/${version.name}` }));
    const versionCalls = new Map<string, number>();
    const repo = { mainRoot: "/synthetic-unused" } as Repo;
    const child = t.mock.method(
      childProcess,
      "spawnSync",
      (cmd: string, args: string[], options: { env: NodeJS.ProcessEnv }) => {
        assert.equal(cmd, "git");
        const version = versions.find((candidate) => candidate.path === options.env.PATH);
        assert.ok(version, "the spawned Git must use the selected PATH");
        if (args.includes("--version")) {
          versionCalls.set(version.name, (versionCalls.get(version.name) ?? 0) + 1);
          return { status: version.status, stdout: version.stdout, stderr: "" };
        }
        assert.ok(args.includes("status"));
        return { status: 128, stdout: "", stderr: "fixturephrase\u202e\n" };
      },
    );
    const reader = t.mock.method(fs, "readFileSync", () => Buffer.from("fixturephrase\n"));
    syncBuiltinESMExports();
    try {
      const order = [
        ...versions.filter((version) => version.name === first),
        ...versions.filter((version) => version.name !== first),
        ...versions.toReversed(),
        ...versions,
      ];
      for (const version of order) {
        process.env.PATH = version.path;
        const diagnostic = version.trusted ? "fixturephrase" : "[line withheld: private term (file line 1)]";
        assert.throws(
          () => git(repo, ["status"]),
          (error: unknown) => error instanceof WtError && error.message === `git status failed: ${diagnostic}`,
          version.name,
        );
      }
      assert.deepEqual(versionCalls, new Map(versions.map((version) => [version.name, 3])));
    } finally {
      if (previousPath === undefined) delete process.env.PATH;
      else process.env.PATH = previousPath;
      child.mock.restore();
      reader.mock.restore();
      syncBuiltinESMExports();
    }
  });
}

test("R5.11: replacing Git under the same PATH rechecks its version in the failed command's context", (t) =>
  scenario({}, ({ fx, repo, env }) => {
    const top = setup(repo, { branch: "version-fixture", busy: new Set() }).path;
    writeFileSync(join(fx.main, ".private-terms"), "fixturephrase\n");
    rmSync(join(env.fakeBin, "git"));
    const execute = childProcess.spawnSync;
    const contexts: { cwd: unknown; env: unknown }[] = [];
    const child = t.mock.method(
      childProcess,
      "spawnSync",
      (cmd: string, args: string[], options: childProcess.SpawnSyncOptions) => {
        contexts.push({ cwd: options.cwd, env: options.env });
        return execute(cmd, args, options);
      },
    );
    syncBuiltinESMExports();
    try {
      const originalPath = process.env.PATH;
      for (const [version, code, trusted] of [
        ["git version 2.44.0", 0, true],
        ["git version 2.43.0", 0, false],
        ["garbled", 0, false],
        ["git version 3.0.0", 0, true],
        ["", 1, false],
        ["git version 2.44.0", 1, false],
      ] as const) {
        installFake(env, "git", [
          { match: ["--version"], stdout: version, code },
          { match: ["status"], code: 128, stderr: "fixturephrase\n" },
        ]);
        const diagnostic = trusted ? "fixturephrase" : "[line withheld: private term (file line 1)]";
        assert.throws(
          () => git(repo, ["status"], { cwd: top }),
          (error: unknown) => error instanceof WtError && error.message === `git status failed: ${diagnostic}`,
        );
        assert.equal(process.env.PATH, originalPath);
        assert.deepEqual(contexts.at(-1), contexts.at(-2));
        assert.equal(contexts.at(-1)?.cwd, top);
        assert.equal(fakeCalls(env, "git").filter((args) => args.includes("--version")).length, 1);
      }
    } finally {
      child.mock.restore();
      syncBuiltinESMExports();
    }
  }));

test("R6.4: blob-reading commands run unpinned and filter diagnostics even on modern Git", (t) => {
  const previous = process.env.GIT_NO_LAZY_FETCH;
  process.env.GIT_NO_LAZY_FETCH = "1";
  const version = t.mock.method(gitRuntime, "supportsNoLazyFetch", () => true);
  const token = ["gh", "p_", "Ab01".repeat(9)].join("");
  const repo = { mainRoot: "/synthetic-unused" } as Repo;
  const child = t.mock.method(
    childProcess,
    "spawnSync",
    (_cmd: string, _args: string[], options: { env: NodeJS.ProcessEnv; encoding: string }) => {
      assert.equal(options.env.GIT_NO_LAZY_FETCH, undefined);
      return {
        status: 128,
        stdout: options.encoding === "buffer" ? Buffer.alloc(0) : "",
        stderr: options.encoding === "buffer" ? Buffer.from(token) : token,
      };
    },
  );
  const reader = t.mock.method(fs, "readFileSync", () => Buffer.from("fixturephrase\n"));
  syncBuiltinESMExports();
  try {
    for (const command of ["worktree", "checkout", "switch", "reset", "restore", "rebase", "merge", "cherry-pick"]) {
      assert.equal(gitTry(repo, [command]).code, 128);
      assert.equal(gitBytes(repo, [command]).code, 128);
      assert.throws(
        () => git(repo, [command]),
        (error: unknown) =>
          error instanceof WtError && error.message === `git ${command} failed: [line withheld: secret shape]`,
      );
    }
    assert.equal(version.mock.callCount(), 0);
  } finally {
    if (previous === undefined) delete process.env.GIT_NO_LAZY_FETCH;
    else process.env.GIT_NO_LAZY_FETCH = previous;
    child.mock.restore();
    reader.mock.restore();
    syncBuiltinESMExports();
  }
});
