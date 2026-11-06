import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { branchChoices, cleanupPicker, menu, PREVIEW, setupWizard } from "./interactive.ts";
import { type Repo, resolveRepo } from "./repo.ts";
import {
  type Fixture,
  fakeCalls,
  gitIn,
  installFake,
  makeFixture,
  makeTestEnv,
  runWt,
  type TestEnv,
} from "./test-support.ts";
import { setup, terminal } from "./worktree.ts";

function runShell(cwd: string, command: string): number | null {
  return spawnSync("sh", ["-c", command], { cwd, encoding: "utf8" }).status;
}

async function scenario(
  o: { tty?: boolean; withBin?: boolean },
  fn: (ctx: { env: TestEnv; fx: Fixture; repo: Repo }) => void | Promise<void>,
): Promise<void> {
  const env = makeTestEnv();
  const savedTty = terminal.isTTY;
  terminal.isTTY = () => o.tty !== false;
  try {
    const fx = makeFixture(env, { withBin: o.withBin });
    await fn({ env, fx, repo: resolveRepo(fx.main) });
  } finally {
    terminal.isTTY = savedTty;
    env.cleanup();
  }
}

test("wizard: typed name that matches nothing creates", () =>
  scenario({}, ({ env, repo }) => {
    installFake(env, "fzf", [
      { stdout: "feat-x\n", code: 1, times: 1 },
      { stdout: "origin/main\n", code: 0, times: 1 },
    ]);
    assert.deepEqual(setupWizard(repo), { branch: "feat-x", from: "origin/main" });
    const calls = fakeCalls(env, "fzf");
    assert.equal(calls.length, 2);
    assert.ok(calls[0]?.includes("--print-query"));
    assert.ok(!calls[1]?.includes("--print-query"));
  }));

test("wizard: pick wins over query", () =>
  scenario({}, ({ env, repo }) => {
    installFake(env, "fzf", [{ stdout: "fe\norigin/feat-y\n", code: 0 }]);
    assert.deepEqual(setupWizard(repo), { branch: "feat-y" });
    assert.equal(fakeCalls(env, "fzf").length, 1, "no source prompt");
  }));

test("wizard: cancel, empty query and a cancelled source return null", () =>
  scenario({}, ({ env, repo }) => {
    installFake(env, "fzf", [{ code: 130 }]);
    assert.equal(setupWizard(repo), null);
    installFake(env, "fzf", [{ stdout: "\n", code: 1 }]);
    assert.equal(setupWizard(repo), null);
    installFake(env, "fzf", [{ stdout: "feat-x\n", code: 1, times: 1 }, { code: 130 }]);
    assert.equal(setupWizard(repo), null);
  }));

test("wizard offers branches but not main or the caller's branch", () =>
  scenario({}, ({ repo, fx }) => {
    gitIn(fx.main, "branch", "local-one");
    gitIn(fx.main, "push", "--quiet", "origin", "main:refs/heads/remote-only", "main:refs/heads/local-one");
    gitIn(fx.main, "fetch", "--quiet", "origin");
    setup(repo, { branch: "other-w", busy: new Set() });
    assert.deepEqual(branchChoices(repo, false).sort(), ["local-one", "origin/remote-only", "other-w"]);
    const withMain = branchChoices(repo, true);
    assert.ok(withMain.includes("main"));
    assert.ok(!withMain.includes("origin/main"), "an origin branch with a local twin is listed once");
  }));

test("interactive choices preserve task names and existing numeric remote branches", () =>
  scenario({}, ({ env, repo, fx }) => {
    for (const branch of ["014-old-task", "emend-task-015-new-task"]) {
      const wt = setup(repo, { branch });
      assert.ok(branchChoices(repo, false).includes(branch));
      installFake(env, "fzf", [{ stdout: `\n${branch}\n` }]);
      assert.deepEqual(setupWizard(repo), { branch });
      installFake(env, "fzf", [{ stdout: `${branch}\t${wt.path}\n` }]);
      assert.equal(cleanupPicker(repo), branch);
    }
    // Older numeric task branches remain discoverable even though setup cannot create them without --issue.
    gitIn(fx.main, "update-ref", "refs/remotes/origin/emend-016-origin-task", "HEAD");
    assert.ok(branchChoices(repo, false).includes("origin/emend-016-origin-task"));
  }));

test("no TTY or no fzf: wizard, picker and menu return null without calling fzf", () =>
  scenario({ tty: false }, ({ env, repo }) => {
    installFake(env, "fzf", [{ stdout: "x\n", code: 0 }]);
    assert.equal(setupWizard(repo), null);
    assert.equal(cleanupPicker(repo), null);
    assert.equal(menu(repo), null);
    assert.equal(fakeCalls(env, "fzf").length, 0);
  }));

test("fzf missing: nothing runs", () =>
  scenario({}, ({ repo }) => {
    assert.equal(setupWizard(repo), null);
    assert.equal(menu(repo), null);
  }));

test("cleanup picker returns the picked registered branch", () =>
  scenario({}, ({ env, repo }) => {
    const w = setup(repo, { branch: "feat-a", busy: new Set() });
    installFake(env, "fzf", [{ stdout: `feat-a\t${w.path}\n`, code: 0 }]);
    assert.equal(cleanupPicker(repo), "feat-a");
    installFake(env, "fzf", [{ stdout: "not-registered\t/x\n", code: 0 }]);
    assert.equal(cleanupPicker(repo), null);
  }));

test("menu returns the picked action", () =>
  scenario({}, ({ env, repo }) => {
    installFake(env, "fzf", [{ stdout: "issues\tshow the ready issue queue\n", code: 0 }]);
    assert.equal(menu(repo), "issues");
    installFake(env, "fzf", [{ stdout: "tasks\tshow the task queue\n", code: 0 }]);
    assert.equal(menu(repo), "tasks");
    installFake(env, "fzf", [{ stdout: "rm -rf\n", code: 0 }]);
    assert.equal(menu(repo), null);
    installFake(env, "fzf", [{ code: 130 }]);
    assert.equal(menu(repo), null);
  }));

test("no TTY: bin/wt without arguments lists and never calls fzf", () =>
  scenario({ withBin: true }, async ({ env, fx }) => {
    installFake(env, "fzf", [{ stdout: "setup\n", code: 0 }]);
    const r = await runWt(`${fx.main}/bin/wt`, [], { cwd: fx.main });
    assert.equal(r.code, 0, r.stderr);
    assert.match(r.stdout, /No worktrees\./);
    assert.equal(fakeCalls(env, "fzf").length, 0);
  }));

test("a branch named with a leading dash is not offered and cannot reach the preview's git call", () =>
  scenario({}, ({ repo, fx, env }) => {
    for (const name of ["--output=x", "-f"]) {
      gitIn(fx.main, "update-ref", `refs/heads/${name}`, "HEAD");
      gitIn(fx.main, "update-ref", `refs/remotes/origin/${name}`, "HEAD");
    }
    gitIn(fx.main, "branch", "fine-one");
    const choices = branchChoices(repo, true);
    assert.deepEqual(
      choices.filter((c) => c.includes("-f") || c.includes("--output")),
      [],
    );
    assert.ok(choices.includes("fine-one") && choices.includes("main"));
    // Control: without --end-of-options the same command writes the file, so this test would catch a regression.
    runShell(fx.main, PREVIEW.replace(" --end-of-options", "").replace("{}", "'--output=x'"));
    assert.equal(existsSync(join(fx.main, "x")), true, "the control wrote a file");
    rmSync(join(fx.main, "x"));
    // Even if such a name did reach the preview, --end-of-options makes git read it as a revision.
    for (const name of ["--output=x", "-f"]) runShell(fx.main, PREVIEW.replace("{}", `'${name}'`));
    assert.equal(existsSync(join(fx.main, "x")), false, "no file was written");
    assert.equal(existsSync(join(env.root, "x")), false);
  }));
