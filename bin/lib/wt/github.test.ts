import assert from "node:assert/strict";
import { chmodSync, mkdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import {
  commands,
  markerTerminal,
  prCreate,
  prEdit,
  prMerge,
  push,
  pushArgs,
  pushDiagnostic,
  requireCheckedPush,
} from "./github.ts";
import { type Repo, resolveRepo } from "./repo.ts";
import {
  branchPrPage,
  commitFile,
  type FakeRule,
  type Fixture,
  fakeCalls,
  fakeGithubOrigin,
  gitIn,
  installFake,
  issueRules,
  makeFixture,
  makeTestEnv,
  readyIssue,
  runWt,
  type TestEnv,
} from "./test-support.ts";
import { WtError } from "./validate.ts";
import { setup } from "./worktree.ts";

const SHA = "a".repeat(40);
const OTHER_SHA = "b".repeat(40);
const MERGE_SHA = "c".repeat(40);
const BRANCH = "feat-a";
const CREATED_URL = "https://github.com/owner/repo/pull/7";

interface Ctx {
  env: TestEnv;
  fx: Fixture;
  repo: Repo;
}

/** A fixture whose main checkout stands on branch `feat-a`. */
async function scenario(
  fn: (ctx: Ctx) => void | Promise<void>,
  o: { withBin?: boolean; branch?: string | null } = {},
): Promise<void> {
  const env = makeTestEnv();
  try {
    const fx = makeFixture(env, { withBin: o.withBin });
    fakeGithubOrigin(env, fx);
    if (o.branch !== null) gitIn(fx.main, "checkout", "--quiet", "-b", o.branch ?? BRANCH);
    await fn({ env, fx, repo: resolveRepo(fx.main) });
  } finally {
    env.cleanup();
  }
}

/** The owner confirmation seam is available only to tests in this process. */
function withMarkerTerminal<T>(input: boolean, error: boolean, answer: string, fn: (prompts: string[]) => T): T {
  const saved = { ...markerTerminal };
  const prompts: string[] = [];
  Object.assign(markerTerminal, {
    stdinTTY: () => input,
    available: () => true,
    stderrTTY: () => error,
    readLine: (prompt: string) => {
      prompts.push(prompt);
      return answer;
    },
  });
  try {
    return fn(prompts);
  } finally {
    Object.assign(markerTerminal, saved);
  }
}

function expectCode(fn: () => unknown, code: number): void {
  assert.throws(
    (() => fn()) as () => void,
    (e: unknown) => e instanceof WtError && e.code === code,
    `expected exit ${code}`,
  );
}

/** After installFake: also records what gh reads from stdin when it is called with `--body-file -`. */
function captureBodies(env: TestEnv): string {
  const file = join(env.fakeBin, "gh");
  const log = join(env.fakeBin, ".gh.bodies.log");
  writeFileSync(log, "");
  const src = readFileSync(file, "utf8");
  const nl = src.indexOf("\n");
  const snippet = `const __fs = require("node:fs");
{
  const a = process.argv.slice(2);
  const i = a.indexOf("--body-file");
  if (i !== -1 && a[i + 1] === "-") {
    __fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify(__fs.readFileSync(0, "utf8")) + "\\n");
  }
}
`;
  writeFileSync(file, `${src.slice(0, nl + 1)}${snippet}${src.slice(nl + 1)}`);
  chmodSync(file, 0o755);
  return log;
}

function capturedBodies(log: string): string[] {
  return readFileSync(log, "utf8")
    .split("\n")
    .filter((l) => l !== "")
    .map((l) => JSON.parse(l) as string);
}

const NO_PR: FakeRule = {
  match: ["api", "graphql", `head=${BRANCH}`],
  stdout: branchPrPage([]),
};

function prJson(extra: Record<string, unknown> = {}): string {
  return JSON.stringify({
    number: 7,
    state: "OPEN",
    headRefName: BRANCH,
    title: "Fix pane",
    body: "Review description",
    isCrossRepository: false,
    ...extra,
  });
}

function branchPrJson(extra: Record<string, unknown> = {}, nameWithOwner = "owner/repo"): string {
  return branchPrPage([JSON.parse(prJson(extra))], nameWithOwner);
}

function mergeCalls(env: TestEnv): string[][] {
  return fakeCalls(env, "gh").filter((a) => a[0] === "pr" && a[1] === "merge");
}

// ---------------------------------------------------------------------------------------------
// Titles and subjects

test("titles must be one line of 1 to 72 characters", () =>
  scenario((ctx) => {
    installFake(ctx.env, "gh", [NO_PR]);
    for (const title of ["", "\n", "two\nlines", "x".repeat(73), "tab\there", "nul\u0000x"]) {
      expectCode(() => prCreate(ctx.repo, { title, body: "body", draft: false }), 2);
    }
    assert.deepEqual(fakeCalls(ctx.env, "gh"), []);
  }));

// ---------------------------------------------------------------------------------------------
//
// push

test("R6.6: post-push comparison distinguishes a different commit from unavailable confirmation", () => {
  assert.doesNotThrow(() => requireCheckedPush(SHA, { code: 0, stdout: SHA, stderr: "" }));
  assert.throws(
    () => requireCheckedPush(SHA, { code: 0, stdout: OTHER_SHA, stderr: "" }),
    (error: unknown) =>
      error instanceof WtError &&
      error.code === 1 &&
      error.message === "origin received a commit other than the checked one. Check the branch on GitHub.",
  );
  for (const received of [
    { code: 0, stdout: "", stderr: "" },
    { code: 0, stdout: "malformed", stderr: "" },
    { code: 1, stdout: "", stderr: "synthetic git error" },
    { code: 1, stdout: SHA, stderr: "synthetic git error" },
  ]) {
    assert.throws(
      () => requireCheckedPush(SHA, received),
      (error: unknown) =>
        error instanceof WtError &&
        error.code === 1 &&
        error.message === "Could not confirm what origin received. Check the branch on GitHub.",
    );
  }
});

test("R6.6: a single-branch clone confirms its push through the named remote", () =>
  scenario(({ fx, env }) => {
    const clone = join(env.root, "single-branch");
    gitIn(env.root, "clone", "--quiet", "--single-branch", "--branch", "main", fx.origin, clone);
    writeFileSync(join(clone, ".private-terms"), "unused-synthetic-term");
    gitIn(clone, "checkout", "--quiet", "-b", BRANCH);
    const head = commitFile(clone, "public.txt", "public\n", "public file");
    const refspec = "+refs/heads/main:refs/remotes/origin/main";
    assert.equal(gitIn(clone, "config", "--get-all", "remote.origin.fetch"), refspec);
    push(resolveRepo(clone), clone, { forceWithLease: false });
    assert.equal(gitIn(fx.origin, "rev-parse", `refs/heads/${BRANCH}`), head);
    assert.equal(gitIn(clone, "config", "--get-all", "remote.origin.fetch"), refspec);
    assert.equal(gitIn(clone, "for-each-ref", "--format=%(objectname)", `refs/remotes/origin/${BRANCH}`), "");
  }));

test("R8.3: a piped owner flag refuses without pushing new markers", () =>
  scenario(
    async ({ fx }) => {
      const marker = ["check-public:", " allow"].join("");
      const mail = ["person", "mail.fixture"].join("@");
      const head = commitFile(fx.main, "draft.txt", `${mail} // ${marker}\npublic // ${marker}\n`, "new markers");
      const wt = join(fx.main, "bin", "wt");
      const refused = await runWt(wt, ["push"], { cwd: fx.main });
      assert.equal(refused.code, 1);
      assert.equal(
        refused.stderr,
        `note: new check-public allow marker at draft.txt:1 in commit ${head.slice(0, 12)}\nnote: new check-public allow marker at draft.txt:2 in commit ${head.slice(0, 12)}\nOnly the owner may push new allow markers. Nothing was pushed.\n`,
      );
      assert.ok(!refused.stderr.includes(mail));
      assert.equal(gitIn(fx.origin, "for-each-ref", `refs/heads/${BRANCH}`), "");
      const result = await runWt(wt, ["push", "--accept-new-markers"], { cwd: fx.main });
      assert.equal(result.code, 1);
      assert.equal(result.stderr, "--accept-new-markers needs an interactive terminal: the owner runs it there.\n");
      assert.equal(gitIn(fx.origin, "for-each-ref", `refs/heads/${BRANCH}`), "");
    },
    { withBin: true },
  ));

test("push sets upstream; lease pins the expected remote tip", () =>
  scenario((ctx) => {
    commitFile(ctx.fx.main, "a.txt", "a\n");
    const plain = pushArgs(BRANCH, false);
    const leased = pushArgs(BRANCH, true, OTHER_SHA);
    for (const flag of ["--force-with-lease", "--force-if-includes"]) {
      assert.ok(!plain.includes(flag), flag);
      assert.ok(!leased.includes(flag), flag);
    }
    assert.ok(leased.includes(`--force-with-lease=refs/heads/${BRANCH}:${OTHER_SHA}`));
    assert.deepEqual(plain.slice(0, 2), ["push", "-u"]);
    assert.ok(plain.includes("origin"));
    push(ctx.repo, ctx.fx.main, { forceWithLease: false });
    assert.equal(gitIn(ctx.fx.origin, "rev-parse", BRANCH), gitIn(ctx.fx.main, "rev-parse", "HEAD"));
    assert.equal(gitIn(ctx.fx.main, "rev-parse", "--abbrev-ref", `${BRANCH}@{upstream}`), `origin/${BRANCH}`);
    assert.equal(
      gitIn(ctx.fx.main, "rev-parse", `refs/remotes/origin/${BRANCH}`),
      gitIn(ctx.fx.main, "rev-parse", "HEAD"),
    );
    // Rewrite the commit and push with the lease.
    gitIn(ctx.fx.main, "commit", "--quiet", "--amend", "-m", "rewritten");
    expectCode(() => push(ctx.repo, ctx.fx.main, { forceWithLease: false }), 1);
    push(ctx.repo, ctx.fx.main, { forceWithLease: true });
    assert.equal(gitIn(ctx.fx.origin, "rev-parse", BRANCH), gitIn(ctx.fx.main, "rev-parse", "HEAD"));
  }));

test("R7.A: a marker already on origin main passes even when that tree is absent locally", () =>
  scenario(({ fx, env, repo }) => {
    const marker = `public // ${["check-public:", " allow"].join("")}\n`;
    const other = join(env.root, "owner");
    gitIn(env.root, "clone", "--quiet", fx.origin, other);
    commitFile(other, "draft.txt", marker, "owner marker");
    gitIn(other, "push", "--quiet", "origin", "main");
    const head = commitFile(fx.main, "draft.txt", marker, "same marker");
    push(repo, fx.main, { forceWithLease: false });
    assert.equal(gitIn(fx.origin, "rev-parse", BRANCH), head);
    commitFile(fx.main, "other.txt", marker, "different file");
    assert.throws(() => push(repo, fx.main, { forceWithLease: false }), /Only the owner may push/);
    assert.equal(gitIn(fx.origin, "rev-parse", BRANCH), head);
  }));

test("R7.A: a marker on the remote branch survives a clean rebase and lease push", () =>
  scenario(
    async ({ fx, env }) => {
      const marker = `public // ${["check-public:", " allow"].join("")}\n`;
      commitFile(fx.main, "draft.txt", marker, "owner marker");
      const wt = join(fx.main, "bin", "wt");
      withMarkerTerminal(true, true, "1", () =>
        push(resolveRepo(fx.main), fx.main, { forceWithLease: false, acceptNewMarkers: true }),
      );
      const other = join(env.root, "owner");
      gitIn(env.root, "clone", "--quiet", fx.origin, other);
      commitFile(other, "main.txt", "public", "advance main");
      gitIn(other, "push", "--quiet", "origin", "main");
      gitIn(fx.main, "fetch", "--quiet", "origin");
      gitIn(fx.main, "rebase", "origin/main");
      const rebased = gitIn(fx.main, "rev-parse", "HEAD");
      const result = await runWt(wt, ["push", "--force-with-lease"], { cwd: fx.main });
      assert.equal(result.code, 0, result.stderr);
      assert.equal(result.stderr, "");
      assert.equal(gitIn(fx.origin, "rev-parse", BRANCH), rebased);
    },
    { withBin: true },
  ));

test("R7.F: PR merge checks the joined commit message before any GitHub call", () =>
  scenario(({ fx, repo, env }) => {
    writeFileSync(join(fx.main, ".private-terms"), "alice example");
    installFake(env, "gh", [{ stdout: "unexpected call" }]);
    assert.throws(
      () => prMerge(repo, { pr: "7", matchHead: SHA, subject: "alice", body: "example" }),
      (error: unknown) => error instanceof WtError && error.message === "message:1:1: private term (file line 1)",
    );
    assert.deepEqual(fakeCalls(env, "gh"), []);
  }));

test("R7.H: PR edit and merge check a different remote head name before side effects", () =>
  scenario(({ fx, repo, env }) => {
    writeFileSync(join(fx.main, ".private-terms"), "alice example");
    const realGit = realpathSync(join(env.fakeBin, "git"));
    rmSync(join(env.fakeBin, "git"));
    installFake(env, "git", [
      { match: ["remote", "get-url", "origin"], stdout: "https://github.com/owner/repo.git" },
      { code: 128, stderr: "unexpected git call" },
    ]);
    for (const action of ["edit", "merge"]) {
      installFake(env, "gh", [
        {
          match: ["pr", "view", "7"],
          stdout: prJson({ baseRefName: "main", headRefName: "alice-example", headRefOid: SHA }),
        },
        { stdout: "unexpected side effect" },
      ]);
      assert.throws(
        () =>
          action === "edit"
            ? prEdit(repo, { pr: "7", title: "public" })
            : prMerge(repo, { pr: "7", matchHead: SHA, subject: "public", body: "public" }),
        (error: unknown) => error instanceof WtError && error.message === "branch:1:1: private term (file line 1)",
      );
      assert.equal(fakeCalls(env, "gh").length, 1);
      assert.deepEqual(fakeCalls(env, "gh")[0]?.slice(0, 3), ["pr", "view", "7"]);
      assert.ok(fakeCalls(env, "git").every((args) => args.slice(-3).join(" ") === "remote get-url origin"));
    }
    rmSync(join(env.fakeBin, "git"));
    symlinkSync(realGit, join(env.fakeBin, "git"));
    assert.equal(gitIn(fx.main, "for-each-ref", "refs/wt-pr-merge/"), "");
  }));

test("R7.G: push preserves the pre-push guard reason after the fixed failure message", () =>
  scenario(({ fx, repo }) => {
    commitFile(fx.main, "public.txt", "public", "public file");
    const hook = join(fx.main, ".git", "hooks", "pre-push");
    for (const [reason, code] of [
      ["synthetic owner guard refusal", 1],
      ["network is unreachable", 69],
    ] as const) {
      writeFileSync(hook, `#!/bin/sh\nprintf '%s\\n' '${reason}' >&2\nexit 1\n`);
      chmodSync(hook, 0o755);
      assert.throws(
        () => push(repo, fx.main, { forceWithLease: false }),
        (error: unknown) =>
          error instanceof WtError &&
          error.code === code &&
          error.message.startsWith("git push failed: could not publish the checked commit.\n") &&
          error.message.includes(reason),
      );
    }
    assert.equal(gitIn(fx.origin, "for-each-ref", `refs/heads/${BRANCH}`), "");
  }));

for (const failure of ["reflog", "merge-base"]) {
  test(`R7.G: lease ${failure} failures are git errors`, () =>
    scenario(({ fx, repo, env }) => {
      rmSync(join(env.fakeBin, "git"));
      installFake(env, "git", [
        { match: ["symbolic-ref"], stdout: `refs/heads/${BRANCH}\n` },
        { match: ["rev-parse"], stdout: `${SHA}\n` },
        { match: ["remote", "get-url"], stdout: "synthetic-origin\n" },
        { match: ["ls-remote"], stdout: `${OTHER_SHA}\trefs/heads/${BRANCH}\n` },
        { match: ["cat-file"], stdout: `${OTHER_SHA} commit\n` },
        { match: ["rev-list"], stdout: "" },
        { match: ["config", "--show-scope", "--get-all"], code: 1 },
        { match: ["config"], stdout: "" },
        { match: [failure], stderr: "synthetic git failure\n", code: 128 },
        { match: ["reflog"], stdout: `${SHA}\n` },
      ]);
      assert.throws(
        () => push(repo, fx.main, { forceWithLease: true }),
        (error: unknown) =>
          error instanceof WtError && error.message === `git ${failure} failed: synthetic git failure`,
      );
      assert.ok(fakeCalls(env, "git").every((args) => !args.includes("push")));
    }));
}

test("a: bin/wt push sets the tracking ref and upstream", () =>
  scenario(
    async ({ fx }) => {
      const head = commitFile(fx.main, "public.txt", "public", "public file");
      const result = await runWt(join(fx.main, "bin", "wt"), ["push"], { cwd: fx.main });
      assert.equal(result.code, 0, result.stderr);
      assert.equal(gitIn(fx.main, "rev-parse", `refs/remotes/origin/${BRANCH}`), head);
      assert.equal(gitIn(fx.main, "rev-parse", "--abbrev-ref", `${BRANCH}@{upstream}`), `origin/${BRANCH}`);
      assert.equal(gitIn(fx.origin, "rev-parse", `refs/heads/${BRANCH}`), head);
    },
    { withBin: true },
  ));

test("normal and lease pushes give the hook origin and a local branch ref", () =>
  scenario((ctx) => {
    const old = commitFile(ctx.fx.main, "a.txt", "a\n");
    const hook = join(ctx.fx.main, ".git", "hooks", "pre-push");
    mkdirSync(join(ctx.fx.main, ".git", "hooks"), { recursive: true });
    writeFileSync(
      hook,
      "#!/bin/sh\nprintf '%s\\n' \"$1\" > ../pre-push-remote\nwhile IFS= read -r line; do\n  printf '%s\\n' \"$line\"\ndone > ../pre-push-input\n",
    );
    chmodSync(hook, 0o755);

    push(ctx.repo, ctx.fx.main, { forceWithLease: false });
    assert.equal(readFileSync(join(ctx.env.root, "pre-push-remote"), "utf8"), "origin\n");
    assert.equal(
      readFileSync(join(ctx.env.root, "pre-push-input"), "utf8"),
      `refs/heads/${BRANCH} ${old} refs/heads/${BRANCH} ${"0".repeat(40)}\n`,
    );
    gitIn(ctx.fx.main, "commit", "--quiet", "--amend", "-m", "rewritten");
    const amended = gitIn(ctx.fx.main, "rev-parse", "HEAD");
    push(ctx.repo, ctx.fx.main, { forceWithLease: true });
    assert.equal(readFileSync(join(ctx.env.root, "pre-push-remote"), "utf8"), "origin\n");
    assert.equal(
      readFileSync(join(ctx.env.root, "pre-push-input"), "utf8"),
      `refs/heads/${BRANCH} ${amended} refs/heads/${BRANCH} ${old}\n`,
    );
    assert.equal(gitIn(ctx.fx.origin, "rev-parse", BRANCH), amended);
  }));

test("normal and lease pushes refuse a branch that moved after HEAD was resolved", () =>
  scenario((ctx) => {
    const pushed = commitFile(ctx.fx.main, "a.txt", "a\n");
    push(ctx.repo, ctx.fx.main, { forceWithLease: false });
    gitIn(ctx.fx.main, "commit", "--quiet", "--amend", "-m", "rewritten");

    for (const forceWithLease of [false, true]) {
      assert.throws(
        () =>
          push(ctx.repo, ctx.fx.main, {
            forceWithLease,
            beforePush: () => commitFile(ctx.fx.main, "late.txt", `late ${forceWithLease}\n`),
          }),
        (e: unknown) =>
          e instanceof WtError &&
          e.code === 1 &&
          e.message === "The branch moved after HEAD was resolved. Nothing was pushed.",
      );
    }
    assert.equal(gitIn(ctx.fx.origin, "rev-parse", BRANCH), pushed);
  }));

test("a lease push refuses a branch ref that holds a tag object", () =>
  scenario((ctx) => {
    const pushed = commitFile(ctx.fx.main, "a.txt", "a\n");
    push(ctx.repo, ctx.fx.main, { forceWithLease: false });
    gitIn(ctx.fx.main, "commit", "--quiet", "--amend", "-m", "rewritten");
    gitIn(ctx.fx.main, "tag", "-a", "-m", "t", "t1", "HEAD");
    const tagId = gitIn(ctx.fx.main, "rev-parse", "t1");

    assert.throws(
      () =>
        push(ctx.repo, ctx.fx.main, {
          forceWithLease: true,
          beforePush: () => {
            const refs = join(ctx.fx.main, ".git", "refs", "heads");
            mkdirSync(refs, { recursive: true });
            writeFileSync(join(refs, BRANCH), `${tagId}\n`);
          },
        }),
      (e: unknown) => e instanceof WtError && e.code === 1 && /branch moved/.test(e.message),
    );
    assert.equal(gitIn(ctx.fx.origin, "rev-parse", BRANCH), pushed);
  }));

test("a lease push still refuses a remote change that was fetched but never integrated", () =>
  scenario((ctx) => {
    commitFile(ctx.fx.main, "a.txt", "a\n");
    push(ctx.repo, ctx.fx.main, { forceWithLease: false });
    const other = join(ctx.env.root, "other");
    gitIn(ctx.env.root, "clone", "--quiet", ctx.fx.origin, other);
    gitIn(other, "checkout", "--quiet", BRANCH);
    const remote = commitFile(other, "remote.txt", "remote\n");
    gitIn(other, "push", "--quiet", "origin", BRANCH);
    gitIn(ctx.fx.main, "fetch", "--quiet", "origin");
    gitIn(ctx.fx.main, "commit", "--quiet", "--amend", "-m", "rewritten");

    expectCode(() => push(ctx.repo, ctx.fx.main, { forceWithLease: true }), 1);
    assert.equal(gitIn(ctx.fx.origin, "rev-parse", BRANCH), remote);
  }));

test("a rejected push reports a plain error under a colored git config", () =>
  scenario((ctx) => {
    for (const key of ["color.ui", "color.push", "color.transport", "color.advice"]) {
      gitIn(ctx.fx.main, "config", key, "always");
    }
    commitFile(ctx.fx.main, "a.txt", "a\n");
    push(ctx.repo, ctx.fx.main, { forceWithLease: false });
    gitIn(ctx.fx.main, "commit", "--quiet", "--amend", "-m", "rewritten");

    assert.throws(
      () => push(ctx.repo, ctx.fx.main, { forceWithLease: false }),
      (e: unknown) => {
        assert.ok(e instanceof WtError);
        assert.equal(e.code, 1);
        assert.ok(e.message.startsWith("git push failed: "));
        assert.ok(!e.message.includes("\x1b"), "push failure must not contain ANSI escape codes");
        assert.ok(e.message.slice("git push failed: ".length).trim().length > 0);
        return true;
      },
    );
  }));

test("push refuses main and a detached HEAD with exit 2", () =>
  scenario(
    (ctx) => {
      expectCode(() => push(ctx.repo, ctx.fx.main, { forceWithLease: false }), 2);
      gitIn(ctx.fx.main, "checkout", "--quiet", "--detach");
      expectCode(() => push(resolveRepo(ctx.fx.main), ctx.fx.main, { forceWithLease: true }), 2);
      assert.throws(() => gitIn(ctx.fx.origin, "rev-parse", "--verify", "--quiet", "refs/heads/feat-a"));
    },
    { branch: null },
  ));

test("push uses the full refspec: a tag with the branch's name is no obstacle and no tag follows", () =>
  scenario((ctx) => {
    commitFile(ctx.fx.main, "a.txt", "a\n");
    gitIn(ctx.fx.main, "tag", BRANCH);
    gitIn(ctx.fx.main, "tag", "-a", "-m", "release", "v1");
    gitIn(ctx.fx.main, "config", "push.followTags", "true");
    push(ctx.repo, ctx.fx.main, { forceWithLease: false });
    assert.equal(
      gitIn(ctx.fx.origin, "rev-parse", `refs/heads/${BRANCH}`),
      gitIn(ctx.fx.main, "rev-parse", "refs/heads/feat-a"),
    );
    assert.equal(gitIn(ctx.fx.origin, "for-each-ref", "refs/tags/"), "", "no tag was pushed");
  }));

test("push refuses a HEAD that is not under refs/heads with exit 2", () =>
  scenario(
    (ctx) => {
      gitIn(ctx.fx.main, "symbolic-ref", "HEAD", "refs/remotes/origin/main");
      expectCode(() => push(resolveRepo(ctx.fx.main), ctx.fx.main, { forceWithLease: false }), 2);
      assert.equal(gitIn(ctx.fx.origin, "for-each-ref", "refs/heads/feat-a"), "");
    },
    { branch: null },
  ));

test("push sends exactly the commit it resolved, even when a commit lands during the push", () =>
  scenario((ctx) => {
    const checked = commitFile(ctx.fx.main, "a.txt", "a\n");
    const hook = join(ctx.fx.main, ".git", "hooks", "pre-push");
    mkdirSync(join(ctx.fx.main, ".git", "hooks"), { recursive: true });
    writeFileSync(
      hook,
      "#!/bin/sh\nunset GIT_DIR GIT_INDEX_FILE\necho late > late.txt\ngit add late.txt\ngit commit --quiet -m late\n",
    );
    chmodSync(hook, 0o755);
    push(ctx.repo, ctx.fx.main, { forceWithLease: false });
    assert.notEqual(gitIn(ctx.fx.main, "rev-parse", "HEAD"), checked, "a later commit exists locally");
    assert.equal(gitIn(ctx.fx.origin, "rev-parse", `refs/heads/${BRANCH}`), checked);
  }));

test("a lease push sends exactly the commit it resolved, even when a commit lands during the push", () =>
  scenario((ctx) => {
    commitFile(ctx.fx.main, "a.txt", "a\n");
    push(ctx.repo, ctx.fx.main, { forceWithLease: false });
    gitIn(ctx.fx.main, "commit", "--quiet", "--amend", "-m", "rewritten");
    const amended = gitIn(ctx.fx.main, "rev-parse", "HEAD");
    const hook = join(ctx.fx.main, ".git", "hooks", "pre-push");
    mkdirSync(join(ctx.fx.main, ".git", "hooks"), { recursive: true });
    writeFileSync(
      hook,
      "#!/bin/sh\nunset GIT_DIR GIT_INDEX_FILE\necho late > late.txt\ngit add late.txt\ngit commit --quiet -m late\n",
    );
    chmodSync(hook, 0o755);

    push(ctx.repo, ctx.fx.main, { forceWithLease: true });
    assert.notEqual(gitIn(ctx.fx.main, "rev-parse", "HEAD"), amended, "a later commit exists locally");
    assert.equal(gitIn(ctx.fx.origin, "rev-parse", `refs/heads/${BRANCH}`), amended);
  }));

test("push argv always names origin and the full local branch ref", () => {
  const spec = `refs/heads/${BRANCH}:refs/heads/${BRANCH}`;
  assert.deepEqual(pushArgs(BRANCH, false), ["push", "-u", "--no-follow-tags", "--", "origin", spec]);
  assert.deepEqual(pushArgs(BRANCH, true), [
    "push",
    "-u",
    "--no-follow-tags",
    `--force-with-lease=refs/heads/${BRANCH}:`,
    "--",
    "origin",
    spec,
  ]);
});

// ---------------------------------------------------------------------------------------------
// Pull request lookup

test("an all-digit branch is refused before gh is asked", () =>
  scenario(
    (ctx) => {
      installFake(ctx.env, "gh", [{ stdout: prJson() }]);
      expectCode(() => prCreate(ctx.repo, { title: "T", body: "B", draft: false }), 2);
      assert.deepEqual(fakeCalls(ctx.env, "gh"), []);
    },
    { branch: "123" },
  ));

function closingRule(nodes: unknown[] = [], more = false): FakeRule {
  return {
    match: ["api", "graphql"],
    queryIncludes: "closingIssuesReferences(first: 20)",
    graphqlRepository: "owner/repo",
    stdout: JSON.stringify({
      data: {
        repository: {
          nameWithOwner: "owner/repo",
          mergeQueue: null,
          pullRequest: {
            body: "Description",
            createdAt: "2026-01-01T00:00:00Z",
            lastEditedAt: null,
            closingIssuesReferences: { nodes, pageInfo: { hasNextPage: more } },
          },
        },
      },
    }),
  };
}

function createRules(stdout: string, branch = BRANCH): FakeRule[] {
  return [
    { match: ["api", "graphql", `head=${branch}`], stdout: branchPrPage([]), times: 1 },
    { match: ["api", "graphql", `head=${branch}`], stdout: branchPrJson({ headRefName: branch }), times: 1 },
    { match: ["pr", "create"], stdout },
    closingRule(),
  ];
}

// ---------------------------------------------------------------------------------------------
// pr create

test("pr create passes head, base, title and the body on stdin", () =>
  scenario((ctx) => {
    installFake(ctx.env, "gh", createRules(`${CREATED_URL}\n`));
    const bodies = captureBodies(ctx.env);
    const out = prCreate(ctx.repo, { title: "Add the thing\n", body: "## Summary\n\nDoes it.\n", draft: true });
    assert.equal(out.trim(), CREATED_URL);
    const create = fakeCalls(ctx.env, "gh").find((a) => a[1] === "create") as string[];
    assert.deepEqual(create, [
      "pr",
      "create",
      "--head",
      BRANCH,
      "--base",
      "main",
      "--title=Add the thing",
      "--draft",
      "--body-file",
      "-",
      "--repo",
      "github.com/owner/repo",
    ]);
    assert.deepEqual(capturedBodies(bodies), ["## Summary\n\nDoes it.\n"]);
  }));

test("pr create without --draft passes no --draft", () =>
  scenario((ctx) => {
    installFake(ctx.env, "gh", createRules(`${CREATED_URL}\n`));
    prCreate(ctx.repo, { title: "T", body: "B", draft: false });
    const create = fakeCalls(ctx.env, "gh").find((a) => a[1] === "create") as string[];
    assert.ok(!create.includes("--draft"));
  }));

test("issue PRs require the exact issue and one of GitHub's closing keywords", () =>
  scenario(({ env, fx, repo }) => {
    const branch = "emend-42-fix-pane";
    gitIn(fx.main, "checkout", "--quiet", "-b", branch);
    repo.callerBranch = branch;
    mkdirSync(join(fx.main, ".wt"));
    writeFileSync(join(fx.main, ".wt/worktree.json"), JSON.stringify({ issue: 42, task: null }));
    installFake(env, "gh", createRules(`${CREATED_URL}\n`, branch));
    for (const body of [
      "",
      "References #42",
      "Closes #4",
      "Closes #420",
      "Closes #42abc",
      "Discloses #42",
      "Closes #0042",
    ]) {
      assert.throws(
        () => prCreate(repo, { title: "T", body, draft: false }),
        (e: unknown) => {
          assert.ok(e instanceof WtError);
          assert.equal(e.code, 2);
          assert.equal(e.message, 'The PR body must close issue #42: add "Closes #42".');
          return true;
        },
      );
    }
    assert.deepEqual(fakeCalls(env, "gh"), []);
    for (const keyword of ["close", "closes", "closed", "fix", "fixes", "fixed", "resolve", "resolves", "resolved"]) {
      installFake(env, "gh", createRules(`${CREATED_URL}\n`, branch));
      assert.equal(
        prCreate(repo, { title: "T", body: `Summary.\n\n${keyword.toUpperCase()} #42.\n`, draft: false }).trim(),
        CREATED_URL,
      );
    }
    installFake(env, "gh", createRules(`${CREATED_URL}\n`, branch));
    assert.equal(prCreate(repo, { title: "T", body: "_Closes #42_", draft: false }).trim(), CREATED_URL);
    assert.equal(fakeCalls(env, "gh").filter((c) => c[1] === "create").length, 1);
  }));

test("pr create checks the body file against its own linked worktree's issue", () =>
  scenario(
    async ({ env, fx, repo }) => {
      installFake(env, "gh", issueRules([readyIssue(42)]));
      const wt = setup(repo, { branch: "emend-42-fix-pane", issue: 42 });
      installFake(env, "gh", createRules(`${CREATED_URL}\n`, "emend-42-fix-pane"));
      // Conflicting main-checkout metadata must not win.
      mkdirSync(join(fx.main, ".wt"));
      writeFileSync(join(fx.main, ".wt/worktree.json"), JSON.stringify({ issue: 99 }));
      const body = join(wt.path, "body.md");
      writeFileSync(body, "Closes #99\n");
      const run = () =>
        runWt(join(fx.main, "bin/wt"), ["pr", "create", "--title", "Fix pane", "--body-file", body], { cwd: wt.path });
      const bad = await run();
      assert.equal(bad.code, 2, bad.stderr);
      assert.match(bad.stderr, /The PR body must close issue #42/);
      assert.deepEqual(fakeCalls(env, "gh"), []);
      writeFileSync(body, "Fixes #42\n");
      const good = await run();
      assert.equal(good.code, 0, good.stderr);
      assert.equal(good.stdout, `${CREATED_URL}\n`);
    },
    { withBin: true },
  ));

test("invalid worktree issue metadata cannot bypass the PR body guard", () =>
  scenario(({ fx, repo, env }) => {
    repo.callerBranch = "emend-42-fix-pane";
    mkdirSync(join(fx.main, ".wt"));
    installFake(env, "gh", [NO_PR]);
    for (const text of ["{", "null", JSON.stringify({ issue: "42" }), JSON.stringify({ issue: -42 })]) {
      writeFileSync(join(fx.main, ".wt/worktree.json"), text);
      expectCode(() => prCreate(repo, { title: "T", body: "B", draft: false }), 2);
    }
    assert.deepEqual(fakeCalls(env, "gh"), []);
  }));

test("pr create refuses when an open PR exists (3) and fails with 1 when gh fails", () =>
  scenario((ctx) => {
    installFake(ctx.env, "gh", [{ match: ["api", "graphql", `head=${BRANCH}`], stdout: branchPrJson() }]);
    expectCode(() => prCreate(ctx.repo, { title: "T", body: "B", draft: false }), 3);
    assert.equal(fakeCalls(ctx.env, "gh").filter((a) => a[1] === "create").length, 0);

    installFake(ctx.env, "gh", [NO_PR, { match: ["pr", "create"], stderr: "boom\n", code: 1 }]);
    expectCode(() => prCreate(ctx.repo, { title: "T", body: "B", draft: false }), 1);
  }));

test("pr create reads --body-file and refuses both body flags or none (end to end)", () =>
  scenario(
    async (ctx) => {
      installFake(ctx.env, "gh", createRules(`${CREATED_URL}\n`));
      const bodies = captureBodies(ctx.env);
      const bodyFile = join(ctx.env.root, "body.md");
      writeFileSync(bodyFile, "from a file\n");
      const wt = join(ctx.fx.main, "bin", "wt");
      const ok = await runWt(wt, ["pr", "create", "--title", "T", "--body-file", bodyFile], { cwd: ctx.fx.main });
      assert.equal(ok.code, 0, ok.stderr);
      assert.deepEqual(capturedBodies(bodies), ["from a file\n"]);
      const both = await runWt(wt, ["pr", "create", "--title", "T", "--body", "x", "--body-file", bodyFile], {
        cwd: ctx.fx.main,
      });
      assert.equal(both.code, 2);
      const none = await runWt(wt, ["pr", "create", "--title", "T"], { cwd: ctx.fx.main });
      assert.equal(none.code, 2);
      const oldFlag = await runWt(wt, ["pr", "view"], { cwd: ctx.fx.main });
      assert.equal(oldFlag.code, 2, "pr view is no longer a wt command");
    },
    { withBin: true },
  ));

// ---------------------------------------------------------------------------------------------
// pr edit

test("pr edit changes the title and sends the body on stdin", () =>
  scenario((ctx) => {
    installFake(ctx.env, "gh", [
      { match: ["api", "graphql", `head=${BRANCH}`], stdout: branchPrJson() },
      { match: ["pr", "edit"], stdout: "https://example.invalid/pr/7\n" },
      closingRule(),
    ]);
    const bodies = captureBodies(ctx.env);
    prEdit(ctx.repo, { title: "New title", body: "New body" });
    const edit = fakeCalls(ctx.env, "gh").find((a) => a[1] === "edit") as string[];
    assert.deepEqual(edit, [
      "pr",
      "edit",
      "7",
      "--title=New title",
      "--body-file",
      "-",
      "--repo",
      "github.com/owner/repo",
    ]);
    assert.deepEqual(capturedBodies(bodies), ["New body"]);
    expectCode(() => prEdit(ctx.repo, {}), 2);
    expectCode(() => prEdit(ctx.repo, { title: "two\nlines" }), 2);
  }));

test("pr edit --pr from a linked worktree requires its own open same-repo PR into main", () =>
  scenario(
    (ctx) => {
      const wt = setup(ctx.repo, { branch: "feat-b", busy: new Set<number>() }).path;
      const repo = resolveRepo(wt);
      const viewArgs = [
        "pr",
        "view",
        "7",
        "--json",
        "number,state,headRefName,isCrossRepository,baseRefName,title,body",
      ];
      const edit: FakeRule = { match: ["pr", "edit", "7"], stdout: "ok\n" };
      installFake(ctx.env, "gh", [
        { match: viewArgs, stdout: prJson({ baseRefName: "main", headRefName: "feat-b" }) },
        edit,
        closingRule(),
      ]);
      prEdit(repo, { pr: "7", title: "T" });
      assert.equal(fakeCalls(ctx.env, "gh").filter((a) => a[1] === "edit").length, 1);

      for (const extra of [
        { baseRefName: "release" },
        { state: "CLOSED" },
        { isCrossRepository: true },
        { headRefName: BRANCH },
        { headRefName: null },
        { headRefName: undefined },
      ]) {
        installFake(ctx.env, "gh", [
          { match: viewArgs, stdout: prJson({ baseRefName: "main", headRefName: "feat-b", ...extra }) },
          edit,
        ]);
        expectCode(() => prEdit(repo, { pr: "7", title: "T" }), 1);
        assert.equal(fakeCalls(ctx.env, "gh").filter((a) => a[1] === "edit").length, 0);
      }
      expectCode(() => prEdit(repo, { pr: "07", title: "T" }), 2);
    },
    { branch: null },
  ));

// ---------------------------------------------------------------------------------------------
// merge

const MERGE_VIEW_ARGS = [
  "pr",
  "view",
  "7",
  "--json",
  "number,baseRefName,headRefName,isCrossRepository,state,headRefOid,title,body",
];
const READ_BACK_ARGS = ["pr", "view", "7", "--json", "state,mergeCommit,headRefOid"];
const mergedState = () => JSON.stringify({ state: "MERGED", mergeCommit: { oid: MERGE_SHA }, headRefOid: headSha });

function mergeRules(view: Record<string, unknown>, rest: FakeRule[] = []): FakeRule[] {
  return [
    {
      match: MERGE_VIEW_ARGS,
      stdout: JSON.stringify({
        number: 7,
        baseRefName: "main",
        headRefName: BRANCH,
        isCrossRepository: false,
        state: "OPEN",
        headRefOid: headSha,
        title: "Fix pane",
        body: "Review description",
        ...view,
      }),
    },
    ...rest,
    closingRule(),
  ];
}

/** The head of the PR under test: a real commit that origin serves as refs/pull/7/head. */
let headSha = SHA;

/** Makes a commit on top of HEAD without moving HEAD and publishes it as refs/pull/7/head. */
function publishHead(ctx: Ctx): void {
  headSha = gitIn(ctx.fx.main, "commit-tree", "HEAD^{tree}", "-p", "HEAD", "-m", "pr head");
  gitIn(ctx.fx.main, "push", "--quiet", "--force", "origin", `${headSha}:refs/pull/7/head`);
}

/** A scenario whose HEAD already has a published PR head. */
function mscenario(fn: (ctx: Ctx) => void | Promise<void>, o: { branch?: string | null } = {}): Promise<void> {
  return scenario((ctx) => {
    publishHead(ctx);
    return fn(ctx);
  }, o);
}

const MERGE_ARGS = {
  pr: "7",
  get matchHead() {
    return headSha;
  },
  subject: "Add the thing",
  body: "Squash body",
};

test("e: pr merge scans the reviewed head tree even when origin already has its private file", () =>
  scenario((ctx) => {
    writeFileSync(join(ctx.fx.main, ".private-terms"), "alice example");
    commitFile(ctx.fx.main, "draft.txt", "alice-example", "draft");
    publishHead(ctx);
    gitIn(ctx.fx.main, "reset", "--hard", "main");
    installFake(ctx.env, "gh", mergeOkRules());
    assert.throws(
      () => prMerge(ctx.repo, MERGE_ARGS),
      (error: unknown) => error instanceof WtError && error.message === "draft.txt:1: private term (file line 1)",
    );
    assert.equal(mergeCalls(ctx.env).length, 0);
    assert.equal(gitIn(ctx.fx.main, "for-each-ref", "refs/wt-pr-merge/"), "");
  }));

test("e: pr merge scans the merge-base difference and permits a removed draft", () =>
  scenario((ctx) => {
    writeFileSync(join(ctx.fx.main, ".private-terms"), "alice example");
    commitFile(ctx.fx.main, "draft.txt", "alice-example", "draft");
    gitIn(ctx.fx.main, "rm", "draft.txt");
    gitIn(ctx.fx.main, "commit", "--quiet", "-m", "remove draft");
    publishHead(ctx);
    installFake(ctx.env, "gh", mergeOkRules());
    assert.equal(prMerge(ctx.repo, MERGE_ARGS), `MERGED ${MERGE_SHA}`);
    assert.equal(mergeCalls(ctx.env).length, 1);
  }));

test("e: pr merge refuses a head unavailable locally with a clear message", () =>
  scenario((ctx) => {
    installFake(ctx.env, "gh", mergeRules({ headRefOid: SHA }));
    assert.throws(
      () => prMerge(ctx.repo, { ...MERGE_ARGS, matchHead: SHA }),
      (error: unknown) =>
        error instanceof WtError &&
        error.message === "The reviewed head commit is not available locally. Nothing was merged.",
    );
    assert.equal(mergeCalls(ctx.env).length, 0);
    assert.equal(gitIn(ctx.fx.main, "for-each-ref", "refs/wt-pr-merge/"), "");
  }));

test("pr merge refusals never reach gh pr merge", () =>
  scenario((ctx) => {
    const cases: Array<[Record<string, unknown>, number]> = [
      [{ isCrossRepository: true }, 1],
      [{ baseRefName: "release" }, 1],
      [{ state: "CLOSED" }, 1],
      [{ state: "MERGED" }, 1],
      [{ headRefOid: OTHER_SHA }, 1],
    ];
    for (const [view, code] of cases) {
      installFake(ctx.env, "gh", mergeRules(view, [{ match: ["pr", "merge"], stdout: "merged\n" }]));
      expectCode(() => prMerge(ctx.repo, MERGE_ARGS), code);
      assert.equal(mergeCalls(ctx.env).length, 0, JSON.stringify(view));
    }
    installFake(ctx.env, "gh", mergeRules({}, [{ match: ["pr", "merge"] }]));
    expectCode(() => prMerge(ctx.repo, { ...MERGE_ARGS, matchHead: "abc" }), 2);
    expectCode(() => prMerge(ctx.repo, { ...MERGE_ARGS, pr: "07" }), 2);
    expectCode(() => prMerge(ctx.repo, { ...MERGE_ARGS, subject: "two\nlines" }), 2);
    expectCode(() => prMerge(ctx.repo, { ...MERGE_ARGS, subject: "" }), 2);
    assert.equal(mergeCalls(ctx.env).length, 0);
  }));

test("pr merge happy path squashes with the reviewed head", () =>
  mscenario((ctx) => {
    installFake(
      ctx.env,
      "gh",
      mergeRules({}, [
        { match: ["pr", "merge", "7"], stdout: "merged\n" },
        { match: READ_BACK_ARGS, stdout: mergedState() },
      ]),
    );
    const bodies = captureBodies(ctx.env);
    assert.equal(prMerge(ctx.repo, MERGE_ARGS), `MERGED ${MERGE_SHA}`);
    const [call] = mergeCalls(ctx.env) as string[][];
    assert.deepEqual(call, [
      "pr",
      "merge",
      "7",
      "--squash",
      "--match-head-commit",
      headSha,
      "--subject=Add the thing",
      "--body-file",
      "-",
      "--repo",
      "github.com/owner/repo",
    ]);
    assert.deepEqual(capturedBodies(bodies), ["Squash body"]);
  }));

function remoteHas(ctx: Ctx): boolean {
  return gitIn(ctx.fx.origin, "for-each-ref", `refs/heads/${BRANCH}`) !== "";
}

test("pr merge deletes the remote head branch after MERGED and never the local one", () =>
  mscenario((ctx) => {
    gitIn(ctx.fx.main, "push", "--quiet", "origin", `${headSha}:refs/heads/${BRANCH}`);
    assert.ok(remoteHas(ctx));
    installFake(
      ctx.env,
      "gh",
      mergeRules({}, [
        { match: ["pr", "merge", "7"], stdout: "merged\n" },
        { match: READ_BACK_ARGS, stdout: mergedState() },
      ]),
    );
    const local = gitIn(ctx.fx.main, "rev-parse", `refs/heads/${BRANCH}`);
    assert.equal(prMerge(ctx.repo, MERGE_ARGS), `MERGED ${MERGE_SHA}`);
    assert.equal(remoteHas(ctx), false, "the remote branch is gone");
    assert.equal(gitIn(ctx.fx.main, "rev-parse", `refs/heads/${BRANCH}`), local, "the local branch is untouched");
  }));

test("pr merge keeps the remote branch when it moved after the merged head", () =>
  mscenario((ctx) => {
    commitFile(ctx.fx.main, "a.txt", "a\n");
    gitIn(ctx.fx.main, "push", "--quiet", "origin", BRANCH);
    installFake(
      ctx.env,
      "gh",
      mergeRules({}, [
        { match: ["pr", "merge", "7"], stdout: "merged\n" },
        { match: READ_BACK_ARGS, stdout: mergedState() },
      ]),
    );
    const lines: string[] = [];
    const write = process.stderr.write;
    process.stderr.write = ((chunk: string | Uint8Array) => {
      lines.push(String(chunk));
      return true;
    }) as typeof process.stderr.write;
    try {
      assert.equal(prMerge(ctx.repo, MERGE_ARGS), `MERGED ${MERGE_SHA}`);
    } finally {
      process.stderr.write = write;
    }
    assert.equal(lines.filter((l) => l.startsWith("remote branch kept: ")).length, 1);
    assert.ok(remoteHas(ctx), "a branch that moved is kept");
  }));

test("pr merge keeps the remote branch on QUEUED", () =>
  mscenario((ctx) => {
    commitFile(ctx.fx.main, "a.txt", "a\n");
    gitIn(ctx.fx.main, "push", "--quiet", "origin", BRANCH);
    installFake(
      ctx.env,
      "gh",
      mergeRules({}, [
        { match: ["pr", "merge", "7"], stdout: "queued\n" },
        { match: READ_BACK_ARGS, stdout: JSON.stringify({ state: "OPEN", mergeCommit: null }) },
      ]),
    );
    assert.throws(() => prMerge(ctx.repo, MERGE_ARGS), /eventual queued merge is not checked/);
    assert.ok(remoteHas(ctx));
  }));

test("pr merge still reports MERGED when the remote branch cannot be deleted", () =>
  mscenario((ctx) => {
    // Origin refuses deletes, so the cleanup fails while the merge stands.
    commitFile(ctx.fx.main, "a.txt", "a\n");
    gitIn(ctx.fx.main, "push", "--quiet", "origin", BRANCH);
    gitIn(ctx.fx.origin, "config", "receive.denyDeletes", "true");
    installFake(
      ctx.env,
      "gh",
      mergeRules({}, [
        { match: ["pr", "merge", "7"], stdout: "merged\n" },
        { match: READ_BACK_ARGS, stdout: mergedState() },
      ]),
    );
    const lines: string[] = [];
    const write = process.stderr.write;
    process.stderr.write = ((chunk: string | Uint8Array) => {
      lines.push(String(chunk));
      return true;
    }) as typeof process.stderr.write;
    try {
      assert.equal(prMerge(ctx.repo, MERGE_ARGS), `MERGED ${MERGE_SHA}`);
    } finally {
      process.stderr.write = write;
    }
    assert.equal(lines.filter((l) => l.startsWith("remote branch kept: ")).length, 1);
    assert.ok(remoteHas(ctx));
  }));

test("pr merge reports a plain deletion failure under a colored git config", () =>
  mscenario((ctx) => {
    for (const key of ["color.ui", "color.push", "color.transport", "color.advice"]) {
      gitIn(ctx.fx.main, "config", key, "always");
    }
    gitIn(ctx.fx.main, "push", "--quiet", "origin", `${headSha}:refs/heads/${BRANCH}`);
    gitIn(ctx.fx.origin, "config", "receive.denyDeletes", "true");
    installFake(
      ctx.env,
      "gh",
      mergeRules({}, [
        { match: ["pr", "merge", "7"], stdout: "merged\n" },
        { match: READ_BACK_ARGS, stdout: mergedState() },
      ]),
    );
    const lines: string[] = [];
    const write = process.stderr.write;
    process.stderr.write = ((chunk: string | Uint8Array) => {
      lines.push(String(chunk));
      return true;
    }) as typeof process.stderr.write;
    try {
      assert.equal(prMerge(ctx.repo, MERGE_ARGS), `MERGED ${MERGE_SHA}`);
    } finally {
      process.stderr.write = write;
    }
    const kept = lines.filter((l) => l.startsWith("remote branch kept: "));
    assert.equal(kept.length, 1);
    const message = kept[0] as string;
    assert.ok(!message.includes("\x1b"), "deletion failure must not contain ANSI escape codes");
    assert.match(message, /failed to push|deletion prohibited|denying/);
    assert.ok(remoteHas(ctx));
  }));

test("pr merge --pr works from a matching linked worktree", () =>
  mscenario(
    (ctx) => {
      const wt = setup(ctx.repo, { branch: "feat-b", busy: new Set<number>() }).path;
      installFake(
        ctx.env,
        "gh",
        mergeRules({ headRefName: "feat-b" }, [
          { match: ["pr", "merge", "7"], stdout: "merged\n" },
          { match: READ_BACK_ARGS, stdout: mergedState() },
        ]),
      );
      assert.equal(prMerge(resolveRepo(wt), MERGE_ARGS), `MERGED ${MERGE_SHA}`);
      assert.equal(mergeCalls(ctx.env).length, 1);
    },
    { branch: null },
  ));

test("pr merge defaults to the caller's PR and prints QUEUED for a queued merge", () =>
  mscenario((ctx) => {
    installFake(ctx.env, "gh", [
      { match: ["api", "graphql", `head=${BRANCH}`], stdout: branchPrJson() },
      ...mergeRules({}, [
        { match: ["pr", "merge", "7"], stdout: "queued\n" },
        { match: READ_BACK_ARGS, stdout: JSON.stringify({ state: "OPEN", mergeCommit: null }) },
      ]),
    ]);
    assert.throws(() => prMerge(ctx.repo, { ...MERGE_ARGS, pr: undefined }), /eventual queued merge is not checked/);
  }));

test("pr merge warns with MERGED when gh failed after merging", (t) =>
  mscenario((ctx) => {
    installFake(
      ctx.env,
      "gh",
      mergeRules({}, [
        { match: ["pr", "merge", "7"], stderr: "failed to delete local branch\n", code: 1 },
        { match: READ_BACK_ARGS, stdout: mergedState() },
      ]),
    );
    const stdout: string[] = [];
    t.mock.method(process.stdout, "write", (chunk: string | Uint8Array) => {
      stdout.push(String(chunk));
      return true;
    });
    assert.throws(() => prMerge(ctx.repo, MERGE_ARGS), /merged head is not the approved one/);
    assert.deepEqual(stdout, [`MERGED ${MERGE_SHA}\n`]);
  }));

test("pr merge says the merge may have happened when the read-back fails", () =>
  mscenario((ctx) => {
    installFake(
      ctx.env,
      "gh",
      mergeRules({}, [
        { match: ["pr", "merge", "7"], stdout: "merged\n" },
        { match: READ_BACK_ARGS, stderr: "HTTP 502\n", code: 1 },
      ]),
    );
    assert.throws(
      () => prMerge(ctx.repo, MERGE_ARGS),
      (e: unknown) => e instanceof WtError && e.code === 1 && /may have happened/.test(e.message),
    );
    assert.equal(mergeCalls(ctx.env).length, 1);
  }));

test("pr merge fails when gh failed and the PR is still open", () =>
  mscenario((ctx) => {
    installFake(
      ctx.env,
      "gh",
      mergeRules({}, [
        { match: ["pr", "merge", "7"], stderr: "not mergeable\n", code: 1 },
        { match: READ_BACK_ARGS, stdout: JSON.stringify({ state: "OPEN", mergeCommit: null }) },
      ]),
    );
    expectCode(() => prMerge(ctx.repo, MERGE_ARGS), 1);
  }));

// ---------------------------------------------------------------------------------------------
// unpushed local main

function branchOnLocalMain(ctx: Ctx): Repo {
  commitFile(ctx.fx.main, "m.txt", "m\n");
  gitIn(ctx.fx.main, "checkout", "--quiet", "-b", BRANCH);
  return resolveRepo(ctx.fx.main);
}

function mergeOkRules(): FakeRule[] {
  return mergeRules({ headRefOid: headSha }, [
    { match: ["pr", "merge", "7"], stdout: "merged\n" },
    { match: READ_BACK_ARGS, stdout: mergedState() },
  ]);
}

test("pr create and pr merge refuse a branch built on unpushed local main, and proceed once main is pushed", () =>
  scenario(
    (ctx) => {
      const repo = branchOnLocalMain(ctx);
      publishHead(ctx);
      installFake(ctx.env, "gh", [...createRules(`${CREATED_URL}\n`), ...mergeOkRules()]);
      for (const [fn, word] of [
        [() => prCreate(repo, { title: "T", body: "B", draft: false }), "created"],
        [() => prMerge(repo, MERGE_ARGS), "merged"],
      ] as const) {
        assert.throws(
          fn,
          (e: unknown) =>
            e instanceof WtError &&
            e.code === 1 &&
            e.message.includes("holds commits of local main that origin/main lacks") &&
            e.message.endsWith(`Nothing was ${word}.`),
        );
      }
      assert.equal(fakeCalls(ctx.env, "gh").filter((a) => a[1] === "create" || a[1] === "merge").length, 0);
      assert.equal(gitIn(ctx.fx.origin, "rev-parse", "main") === gitIn(ctx.fx.main, "rev-parse", "main"), false);

      gitIn(ctx.fx.main, "push", "--quiet", "origin", "main");
      installFake(ctx.env, "gh", [...createRules(`${CREATED_URL}\n`), ...mergeOkRules()]);
      assert.equal(prCreate(repo, { title: "T", body: "B", draft: false }).trim(), CREATED_URL);
      assert.equal(prMerge(repo, MERGE_ARGS), `MERGED ${MERGE_SHA}`);
    },
    { branch: null },
  ));

test("a branch started from origin/main is fine while local main is ahead", () =>
  scenario(
    (ctx) => {
      commitFile(ctx.fx.main, "m.txt", "m\n");
      gitIn(ctx.fx.main, "checkout", "--quiet", "-b", BRANCH, "origin/main");
      const repo = resolveRepo(ctx.fx.main);
      publishHead(ctx);
      installFake(ctx.env, "gh", [...createRules(`${CREATED_URL}\n`), ...mergeOkRules()]);
      assert.equal(prCreate(repo, { title: "T", body: "B", draft: false }).trim(), CREATED_URL);
      assert.equal(prMerge(repo, MERGE_ARGS), `MERGED ${MERGE_SHA}`);
    },
    { branch: null },
  ));

// ---------------------------------------------------------------------------------------------
// gh failures

test("gh unauthenticated exits 69", () =>
  scenario((ctx) => {
    installFake(ctx.env, "gh", [
      { stderr: "You are not logged in to any GitHub hosts. Run gh auth login to authenticate.\n", code: 4 },
    ]);
    expectCode(() => prCreate(ctx.repo, { title: "T", body: "B", draft: false }), 69);
  }));

test("gh missing exits 69", () =>
  scenario((ctx) => {
    // No fake gh installed: the PATH holds only git, sh, ssh-keygen and node.
    expectCode(() => prCreate(ctx.repo, { title: "T", body: "B", draft: false }), 69);
  }));

test("the command table has only repo, fetch, push and pr", () => {
  assert.deepEqual(Object.keys(commands).sort(), ["fetch", "pr", "push", "repo"]);
});

// Synthetic fixtures are assembled so the source passes the repository's own hygiene checks.
const PRIVATE_FIXTURE_HOST = ["fixture-host", "ts", "net"].join(".");
const ATTRIBUTION_FIXTURE = ["Co-Auth", "ored-By: Test"].join("");

test("push refuses private committed file contents even with a clean replacement in the working tree", () =>
  scenario((ctx) => {
    commitFile(ctx.fx.main, "draft.md", `public\n${PRIVATE_FIXTURE_HOST}\n`);
    writeFileSync(join(ctx.fx.main, "draft.md"), "public\n");
    for (const forceWithLease of [false, true]) {
      assert.throws(
        () => push(ctx.repo, ctx.fx.main, { forceWithLease }),
        (error: unknown) =>
          error instanceof WtError && error.code === 1 && error.message === "draft.md:2: tailnet host name",
      );
    }
    assert.equal(gitIn(ctx.fx.origin, "for-each-ref", "refs/heads/feat-a"), "");
  }));

test("push refuses attribution in a commit message before any push", () =>
  scenario((ctx) => {
    const head = commitFile(ctx.fx.main, "draft.md", "public\n", `update\n\n${ATTRIBUTION_FIXTURE}`);
    assert.throws(
      () => push(ctx.repo, ctx.fx.main, { forceWithLease: false }),
      (error: unknown) =>
        error instanceof WtError &&
        error.code === 1 &&
        error.message === `commit ${head.slice(0, 7)} message:3:1: attribution`,
    );
    assert.equal(gitIn(ctx.fx.origin, "for-each-ref", "refs/heads/feat-a"), "");
  }));

test("PR create, edit and merge refuse each title or body before even looking up a PR", () =>
  scenario((ctx) => {
    installFake(ctx.env, "gh", [{ stdout: "unexpected call" }]);
    for (const value of [PRIVATE_FIXTURE_HOST, ATTRIBUTION_FIXTURE]) {
      const calls = [
        () => prCreate(ctx.repo, { title: value, body: "public", draft: false }),
        () => prCreate(ctx.repo, { title: "public", body: value, draft: false }),
        () => prEdit(ctx.repo, { title: value }),
        () => prEdit(ctx.repo, { body: value }),
        () => prMerge(ctx.repo, { matchHead: SHA, subject: value, body: "public" }),
        () => prMerge(ctx.repo, { matchHead: SHA, subject: "public", body: value }),
      ];
      for (const call of calls) {
        assert.throws(call, (error: unknown) => {
          assert.ok(error instanceof WtError);
          assert.equal(error.code, 1);
          assert.match(error.message, /^(title|body|message):[13]:1: (tailnet host name|attribution)$/);
          assert.ok(!error.message.includes(value));
          return true;
        });
      }
    }
    assert.deepEqual(fakeCalls(ctx.env, "gh"), []);
  }));

test("PR commands refuse body files through the launcher without invoking gh", () =>
  scenario(
    async (ctx) => {
      installFake(ctx.env, "gh", [{ stdout: "unexpected call" }]);
      const file = join(ctx.env.root, "body.md");
      writeFileSync(file, PRIVATE_FIXTURE_HOST);
      for (const args of [
        ["pr", "create", "--title", "public", "--body-file", file],
        ["pr", "edit", "--body-file", file],
        ["pr", "merge", "--match-head", SHA, "--subject", "public", "--body-file", file],
      ]) {
        const result = await runWt(join(ctx.fx.main, "bin", "wt"), args, { cwd: ctx.fx.main });
        assert.equal(result.code, 1);
        assert.match(result.stderr, /(?:body|message):[13]:1: tailnet host name/);
        assert.ok(!result.stderr.includes(PRIVATE_FIXTURE_HOST));
        assert.equal(result.stdout, "");
      }
      assert.deepEqual(fakeCalls(ctx.env, "gh"), []);
    },
    { withBin: true },
  ));

test("push launcher checks the worktree's commit and main checkout's private list", () =>
  scenario(
    async (ctx) => {
      const linked = join(ctx.env.root, "linked");
      gitIn(ctx.fx.main, "worktree", "add", "--quiet", "-b", "linked", linked);
      writeFileSync(join(ctx.fx.main, ".private-terms"), "fixture-private-term\n");
      const head = commitFile(linked, "draft.md", "public", "fixture-private-term");
      const result = await runWt(join(ctx.fx.main, "bin", "wt"), ["push"], { cwd: linked });
      assert.equal(result.code, 1);
      assert.equal(result.stderr, `commit ${head.slice(0, 7)} message:1:1: private term (file line 1)\n`);
      assert.equal(gitIn(ctx.fx.origin, "for-each-ref", "refs/heads/linked"), "");
    },
    { withBin: true },
  ));

test("i: PR launcher ignores environment allowed phrases and accepts file allowed phrases", () =>
  scenario(
    async (ctx) => {
      installFake(ctx.env, "gh", [
        { match: ["api", "graphql", `head=${BRANCH}`], stdout: branchPrJson() },
        { match: ["pr", "edit"], stdout: "updated\n" },
        closingRule(),
      ]);
      const env = { EMEND_PRIVATE_TERMS: "fixturecorp\n!fixturecorp/public-tool" };
      const wt = join(ctx.fx.main, "bin", "wt");
      const bad = await runWt(wt, ["pr", "edit", "--title", "fixturecorp"], { cwd: ctx.fx.main, env });
      assert.equal(bad.code, 1);
      const note = "check:public: allowed phrases in EMEND_PRIVATE_TERMS are ignored\n";
      assert.equal(bad.stderr, `${note}title:1:1: private term (env line 1)\n`);
      assert.deepEqual(fakeCalls(ctx.env, "gh"), []);
      const ignored = await runWt(wt, ["pr", "edit", "--title", "fixturecorp/public-tool"], { cwd: ctx.fx.main, env });
      assert.equal(ignored.code, 1);
      assert.equal(ignored.stderr, `${note}title:1:1: private term (env line 1)\n`);
      assert.deepEqual(fakeCalls(ctx.env, "gh"), []);
      writeFileSync(join(ctx.fx.main, ".private-terms"), "unused-synthetic-term\n!fixturecorp/public-tool\n");
      const good = await runWt(wt, ["pr", "edit", "--title", "fixturecorp/public-tool"], { cwd: ctx.fx.main, env });
      assert.equal(good.code, 0);
      assert.equal(good.stdout, "updated\n");
    },
    { withBin: true },
  ));

for (const branch of ["fixturecorp-feature", PRIVATE_FIXTURE_HOST]) {
  test("regression: branch checks precede every network call", () =>
    scenario(
      (ctx) => {
        writeFileSync(join(ctx.fx.main, ".private-terms"), "fixturecorp");
        installFake(ctx.env, "gh", [{ stdout: "unexpected call" }]);
        rmSync(join(ctx.env.fakeBin, "git"));
        installFake(ctx.env, "git", [
          { match: ["symbolic-ref"], stdout: `refs/heads/${branch}\n` },
          { match: ["rev-parse"], stdout: `${SHA}\n` },
        ]);
        for (const call of [
          () => push(ctx.repo, ctx.fx.main, { forceWithLease: false }),
          () => push(ctx.repo, ctx.fx.main, { forceWithLease: true }),
          () => prCreate(ctx.repo, { title: "public", body: "public", draft: false }),
          () => prEdit(ctx.repo, { title: "public" }),
          () => prEdit(ctx.repo, { pr: "7", body: "public" }),
          () => prMerge(ctx.repo, { matchHead: SHA, subject: "public", body: "public" }),
          () => prMerge(ctx.repo, { pr: "7", matchHead: SHA, subject: "public", body: "public" }),
        ]) {
          assert.throws(
            call,
            (error: unknown) => error instanceof WtError && /private term|tailnet host name/.test(error.message),
          );
        }
        assert.deepEqual(fakeCalls(ctx.env, "gh"), []);
        assert.deepEqual(
          fakeCalls(ctx.env, "git").filter((args) => args.some((arg) => ["push", "fetch", "ls-remote"].includes(arg))),
          [],
        );
      },
      { branch },
    ));
}

test("regression: missing terms fail closed before network calls", () =>
  scenario((ctx) => {
    rmSync(join(ctx.fx.main, ".private-terms"), { force: true });
    installFake(ctx.env, "gh", [{ stdout: "unexpected call" }]);
    rmSync(join(ctx.env.fakeBin, "git"));
    installFake(ctx.env, "git", [
      { match: ["symbolic-ref"], stdout: `refs/heads/${BRANCH}\n` },
      { match: ["rev-parse"], stdout: `${SHA}\n` },
    ]);
    for (const call of [
      () => push(ctx.repo, ctx.fx.main, { forceWithLease: false }),
      () => prCreate(ctx.repo, { title: "public", body: "public", draft: false }),
      () => prEdit(ctx.repo, { title: "public" }),
      () => prMerge(ctx.repo, { matchHead: SHA, subject: "public", body: "public" }),
    ])
      assert.throws(
        call,
        (error: unknown) =>
          error instanceof WtError && error.message.startsWith("check:public: private terms list required;"),
      );
    assert.deepEqual(fakeCalls(ctx.env, "gh"), []);
    assert.deepEqual(
      fakeCalls(ctx.env, "git").filter((args) => args.some((arg) => ["push", "fetch", "ls-remote"].includes(arg))),
      [],
    );
  }));

test("regression: PR and merge text cannot use file exemptions", () =>
  scenario((ctx) => {
    installFake(ctx.env, "gh", [{ stdout: "unexpected call" }]);
    const body = `${PRIVATE_FIXTURE_HOST} ${["check-public:", " allow"].join("")}`;
    for (const call of [
      () => prCreate(ctx.repo, { title: "public", body, draft: false }),
      () => prEdit(ctx.repo, { body }),
      () => prMerge(ctx.repo, { matchHead: SHA, subject: "public", body }),
    ])
      assert.throws(call, (error: unknown) => error instanceof WtError && /tailnet host name/.test(error.message));
    assert.deepEqual(fakeCalls(ctx.env, "gh"), []);
  }));

test("9: force push names a local branch and pins the lease to an object id", () => {
  const args = pushArgs(BRANCH, true, OTHER_SHA);
  assert.ok(args.includes(`refs/heads/${BRANCH}:refs/heads/${BRANCH}`));
  assert.ok(args.includes(`--force-with-lease=refs/heads/${BRANCH}:${OTHER_SHA}`));
  assert.ok(args.includes("origin"));
});

test("8: a different push URL is refused before sending", () =>
  scenario(({ fx, repo, env }) => {
    writeFileSync(join(fx.main, ".private-terms"), "fixturecorp");
    commitFile(fx.main, "draft.txt", "fixturecorp", "public");
    gitIn(fx.main, "push", "--quiet", "origin", "HEAD:main");
    const destination = join(env.root, "destination.git");
    gitIn(env.root, "init", "--quiet", "--bare", destination);
    gitIn(fx.main, "remote", "set-url", "--push", "origin", destination);
    assert.throws(
      () => push(repo, fx.main, { forceWithLease: false }),
      (error: unknown) => error instanceof WtError && error.code === 69,
    );
    assert.equal(gitIn(destination, "for-each-ref"), "");
  }));

test("8: unreadable push destination exits 69 without sending or disclosing git errors", () =>
  scenario(({ fx, repo, env }) => {
    gitIn(fx.main, "remote", "set-url", "--push", "origin", join(env.root, "missing-fixturecorp"));
    assert.throws(
      () => push(repo, fx.main, { forceWithLease: false }),
      (error: unknown) =>
        error instanceof WtError &&
        error.code === 69 &&
        error.message === "check:public: could not read destination refs",
    );
    assert.equal(gitIn(fx.origin, "for-each-ref", `refs/heads/${BRANCH}`), "");
  }));

test("8: changing only the push URL after the check refuses the push", () =>
  scenario(({ fx, repo, env }) => {
    commitFile(fx.main, "draft.txt", "public", "public");
    const other = join(env.root, "other.git");
    gitIn(env.root, "init", "--quiet", "--bare", other);
    expectCode(
      () =>
        push(repo, fx.main, {
          forceWithLease: false,
          beforePush: () => gitIn(fx.main, "remote", "set-url", "--push", "origin", other),
        }),
      69,
    );
    assert.equal(gitIn(fx.origin, "for-each-ref", `refs/heads/${BRANCH}`), "");
    assert.equal(gitIn(other, "for-each-ref"), "");
  }));

test("A: normal and lease pushes refuse an origin URL changed after the check", () =>
  scenario(({ fx, repo, env }) => {
    commitFile(fx.main, "draft.txt", "public", "public");
    const other = join(env.root, "other.git");
    gitIn(env.root, "init", "--quiet", "--bare", other);
    for (const forceWithLease of [false, true]) {
      gitIn(fx.main, "remote", "set-url", "origin", fx.origin);
      assert.throws(
        () =>
          push(repo, fx.main, {
            forceWithLease,
            beforePush: () => gitIn(fx.main, "remote", "set-url", "origin", other),
          }),
        (error: unknown) =>
          error instanceof WtError &&
          error.code === 1 &&
          error.message === "origin changed after the check. Nothing was pushed.",
      );
      assert.equal(gitIn(fx.origin, "for-each-ref", `refs/heads/${BRANCH}`), "");
      assert.equal(gitIn(other, "for-each-ref"), "");
    }
  }));

test("9: force push refuses a destination tip changed after advertisement", () =>
  scenario(({ fx, repo }) => {
    const first = commitFile(fx.main, "draft.txt", "public", "public");
    push(repo, fx.main, { forceWithLease: false });
    const second = commitFile(fx.main, "draft.txt", "another public change", "public");
    gitIn(fx.main, "push", "--quiet", "origin", `${second}:refs/heads/side`);
    gitIn(fx.main, "reset", "--hard", first);
    gitIn(fx.main, "commit", "--quiet", "--amend", "-m", "rewritten");
    expectCode(
      () =>
        push(repo, fx.main, {
          forceWithLease: true,
          beforePush: () => gitIn(fx.origin, "update-ref", `refs/heads/${BRANCH}`, second),
        }),
      1,
    );
    assert.equal(gitIn(fx.origin, "rev-parse", BRANCH), second);
  }));

test("R8.3: owner approval requires both TTYs and an exact marker count", (t) =>
  scenario(({ fx, repo }) => {
    const marker = ["check-public:", " allow"].join("");
    const head = commitFile(fx.main, "draft.txt", `first // ${marker}\nsecond // ${marker}\n`, "new markers");
    for (const [input, error] of [
      [false, true],
      [true, false],
      [false, false],
    ]) {
      withMarkerTerminal(input ?? false, error ?? false, "2", (prompts) => {
        assert.throws(
          () => push(repo, fx.main, { forceWithLease: false, acceptNewMarkers: true }),
          (e: unknown) =>
            e instanceof WtError &&
            e.code === 1 &&
            e.message === "--accept-new-markers needs an interactive terminal: the owner runs it there.",
        );
        assert.deepEqual(prompts, []);
      });
      assert.equal(gitIn(fx.origin, "for-each-ref", `refs/heads/${BRANCH}`), "");
    }
    for (const answer of ["", "yes", "1", "02"]) {
      withMarkerTerminal(true, true, answer, (prompts) => {
        assert.throws(
          () => push(repo, fx.main, { forceWithLease: false, acceptNewMarkers: true }),
          (e: unknown) =>
            e instanceof WtError && e.message === "The new allow marker count was not confirmed. Nothing was pushed.",
        );
        assert.deepEqual(prompts, [
          "Only the owner may approve new allow markers. Type the number of new allow marker notes printed above to push: ",
        ]);
      });
      assert.equal(gitIn(fx.origin, "for-each-ref", `refs/heads/${BRANCH}`), "");
    }
    const stderr: string[] = [];
    const output = t.mock.method(process.stderr, "write", (chunk: string | Uint8Array) => {
      stderr.push(String(chunk));
      return true;
    });
    try {
      withMarkerTerminal(true, true, "2", (prompts) => {
        push(repo, fx.main, { forceWithLease: false, acceptNewMarkers: true });
        assert.equal(prompts.length, 1);
      });
    } finally {
      output.mock.restore();
    }
    assert.equal(
      stderr.join(""),
      `note: new check-public allow marker at draft.txt:1 in commit ${head.slice(0, 12)}\nnote: new check-public allow marker at draft.txt:2 in commit ${head.slice(0, 12)}\n`,
    );
    assert.equal(gitIn(fx.origin, "rev-parse", BRANCH), head);
  }));

for (const scope of ["--local", "--worktree"]) {
  for (const key of ["user.name", "user.email"]) {
    test(`R8.4: push refuses ${scope} ${key} without exposing its value`, () =>
      scenario(({ fx, repo }) => {
        commitFile(fx.main, "public.txt", "public", "public file");
        gitIn(fx.main, "config", "extensions.worktreeConfig", "true");
        gitIn(fx.main, "config", scope, key, "synthetic-identity");
        for (const forceWithLease of [false, true])
          assert.throws(
            () => push(repo, fx.main, { forceWithLease }),
            (e: unknown) =>
              e instanceof WtError &&
              e.message ===
                `a git identity with ${scope.slice(2)} scope is set; bin/wt checks only global and system identities.`,
          );
        assert.equal(gitIn(fx.origin, "for-each-ref", `refs/heads/${BRANCH}`), "");
      }));
  }
}

test("R10.F: HOME global identity works while a malformed system override is stripped", () =>
  scenario(({ fx, repo, env }) => {
    const head = commitFile(fx.main, "public.txt", "public", "public file");
    const system = join(env.root, "system.gitconfig");
    writeFileSync(system, "[malformed synthetic config\n");

    process.env.GIT_CONFIG_SYSTEM = system;
    try {
      push(repo, fx.main, { forceWithLease: false });
      assert.equal(gitIn(fx.origin, "rev-parse", BRANCH), head);
    } finally {
      delete process.env.GIT_CONFIG_SYSTEM;
    }
  }));

test("R8.6: push diagnostics strip terminal escapes and controls and cap both dimensions", () => {
  assert.equal(pushDiagnostic("\x1b[31mguard\x1b[0m\r\0\x07\b\x7f\x85\n\treason\n"), "guard\n\treason");
  assert.equal(
    pushDiagnostic("\x1b]0;synthetic-title\x07guard\x1b]8;;https://example.com\x1b\\reason\x1b]8;;\x1b\\"),
    "guardreason",
  );
  assert.equal(pushDiagnostic(Array.from({ length: 30 }, (_, i) => `line ${i}`).join("\n")).split("\n").length, 20);
  assert.equal(pushDiagnostic("x".repeat(3000)), "x".repeat(2000));
});

test("R8.6: a failed push prints only the bounded sanitized guard diagnostic", () =>
  scenario(({ fx, repo }) => {
    commitFile(fx.main, "public.txt", "public", "public file");
    const hook = join(fx.main, ".git", "hooks", "pre-push");
    const diagnostic = `\x1b[31mguard\x1b[0m\r\x07\n${"x".repeat(2100)}`;
    writeFileSync(
      hook,
      `#!${process.execPath}\nprocess.stderr.write(${JSON.stringify(diagnostic)}); process.exit(1);\n`,
    );
    chmodSync(hook, 0o755);
    assert.throws(
      () => push(repo, fx.main, { forceWithLease: false }),
      (e: unknown) =>
        e instanceof WtError &&
        e.message === `git push failed: could not publish the checked commit.\n${pushDiagnostic(diagnostic)}`,
    );
    assert.equal(gitIn(fx.origin, "for-each-ref", `refs/heads/${BRANCH}`), "");
  }));

test("R9.1: the owner flag refuses if both descriptors are TTYs but no controlling terminal exists", () =>
  scenario(({ fx, repo }) => {
    withMarkerTerminal(true, true, "0", (prompts) => {
      markerTerminal.available = () => false;
      assert.throws(
        () => push(repo, fx.main, { forceWithLease: false, acceptNewMarkers: true }),
        (error: unknown) =>
          error instanceof WtError &&
          error.message === "--accept-new-markers needs an interactive terminal: the owner runs it there.",
      );
      assert.deepEqual(prompts, []);
      assert.equal(gitIn(fx.origin, "for-each-ref", `refs/heads/${BRANCH}`), "");
    });
  }));

test("R9.6: GitHub errors with private text are withheld", () =>
  scenario(({ fx, repo, env }) => {
    writeFileSync(join(fx.main, ".private-terms"), "alice example");
    installFake(env, "gh", [{ code: 1, stderr: "alice-example\u202e\n" }]);
    assert.throws(
      () => prEdit(repo, { pr: "7", title: "public" }),
      (error: unknown) =>
        error instanceof WtError && error.message === "gh pr view failed: [line withheld: private term (file line 1)]",
    );
  }));

for (const failure of ["reflog", "merge-base"]) {
  test(`R10.E: local lease ${failure} diagnostics preserve text after removing controls`, () =>
    scenario(({ fx, repo, env }) => {
      writeFileSync(join(fx.main, ".private-terms"), "alice example");
      rmSync(join(env.fakeBin, "git"));
      installFake(env, "git", [
        { match: ["symbolic-ref"], stdout: `refs/heads/${BRANCH}\n` },
        { match: ["rev-parse"], stdout: `${SHA}\n` },
        { match: ["remote", "get-url"], stdout: "synthetic-origin\n" },
        { match: ["ls-remote"], stdout: `${OTHER_SHA}\trefs/heads/${BRANCH}\n` },
        { match: ["cat-file"], stdout: `${OTHER_SHA} commit\n` },
        { match: ["rev-list"], stdout: "" },
        { match: ["config", "--show-scope", "--get-all"], code: 1 },
        { match: ["config"], stdout: "" },
        { match: [failure], code: 128, stderr: "alice-example\u202e\n" },
        { match: ["reflog"], stdout: `${SHA}\n` },
      ]);
      assert.throws(
        () => push(repo, fx.main, { forceWithLease: true }),
        (error: unknown) => error instanceof WtError && error.message === `git ${failure} failed: alice-example`,
      );
      assert.ok(fakeCalls(env, "git").every((args) => !args.includes("push")));
    }));
}

test("R9.6: a failed push withholds a private pre-push hook diagnostic", () =>
  scenario(({ fx, repo }) => {
    writeFileSync(join(fx.main, ".private-terms"), "alice example");
    commitFile(fx.main, "public.txt", "public", "public file");
    const hook = join(fx.main, ".git", "hooks", "pre-push");
    writeFileSync(hook, `#!${process.execPath}\nprocess.stderr.write("alice-example\\n"); process.exit(1);\n`);
    chmodSync(hook, 0o755);
    assert.throws(
      () => push(repo, fx.main, { forceWithLease: false }),
      (error: unknown) =>
        error instanceof WtError &&
        error.message.startsWith(
          "git push failed: could not publish the checked commit.\n[line withheld: private term (file line 1)]\n",
        ),
    );
    assert.equal(gitIn(fx.origin, "for-each-ref", `refs/heads/${BRANCH}`), "");
  }));

test("R9.6: remote deletion errors redact private text before reporting a kept branch", (t) =>
  mscenario((ctx) => {
    gitIn(ctx.fx.main, "push", "--quiet", "origin", `${headSha}:refs/heads/${BRANCH}`);
    writeFileSync(join(ctx.fx.main, ".private-terms"), "alice example");
    // The transport's error names its destination, so give that destination a synthetic private basename.
    const url = join(ctx.env.root, "alice-example");
    symlinkSync(ctx.fx.origin, url);
    gitIn(ctx.fx.main, "remote", "set-url", "origin", url);
    // Keep the GitHub identity while the transport still reports the private-named alias.
    fakeGithubOrigin(ctx.env, { ...ctx.fx, origin: url });
    gitIn(ctx.fx.origin, "config", "receive.denyDeletes", "true");
    installFake(
      ctx.env,
      "gh",
      mergeRules({}, [
        { match: ["pr", "merge", "7"], stdout: "merged\n" },
        { match: READ_BACK_ARGS, stdout: mergedState() },
      ]),
    );
    const lines: string[] = [];
    t.mock.method(process.stderr, "write", (chunk: string | Uint8Array) => {
      lines.push(String(chunk));
      return true;
    });
    assert.equal(prMerge(ctx.repo, MERGE_ARGS), `MERGED ${MERGE_SHA}`);
    assert.deepEqual(
      lines.filter((line) => line.startsWith("remote branch kept:")),
      ["remote branch kept: [line withheld: private term (file line 1)]\n"],
    );
    assert.ok(remoteHas(ctx));
  }));

test("R10.A: refusal and owner confirmation identify both commits at the same marker location", (t) =>
  scenario(({ fx, repo }) => {
    const marker = ["check-public:", " allow"].join("");
    const mail = ["person", "mail.fixture"].join("@");
    const first = commitFile(fx.main, "notes.txt", `${mail} // ${marker}\n`, "first marker");
    const second = commitFile(fx.main, "notes.txt", `synthetic fixture line // ${marker}\n`, "replace marker");
    const notes = [second, first]
      .map((sha) => `note: new check-public allow marker at notes.txt:1 in commit ${sha.slice(0, 12)}\n`)
      .join("");
    const output: string[] = [];
    t.mock.method(process.stderr, "write", (chunk: string | Uint8Array) => {
      output.push(String(chunk));
      return true;
    });
    assert.throws(
      () => push(repo, fx.main, { forceWithLease: false }),
      (error: unknown) =>
        error instanceof WtError && error.message === "Only the owner may push new allow markers. Nothing was pushed.",
    );
    assert.equal(output.join(""), notes);
    assert.equal(gitIn(fx.origin, "for-each-ref", `refs/heads/${BRANCH}`), "");
    output.length = 0;
    withMarkerTerminal(true, true, "2", (prompts) => {
      push(repo, fx.main, { forceWithLease: false, acceptNewMarkers: true });
      assert.deepEqual(prompts, [
        "Only the owner may approve new allow markers. Type the number of new allow marker notes printed above to push: ",
      ]);
    });
    assert.equal(output.join(""), notes);
    assert.equal(gitIn(fx.origin, "rev-parse", BRANCH), second);
  }));

test("pr create and edit guard registered issue branches and refuse mismatched issue metadata", () =>
  scenario(
    ({ env, fx, repo }) => {
      const branch = "emend-42-fix-pane";
      mkdirSync(join(fx.main, ".wt"));
      writeFileSync(join(fx.main, ".wt/worktree.json"), JSON.stringify({ issue: 42 }));
      for (const body of [
        "Missing",
        "Closes #42\n<!-- Closes #9 -->",
        "Closes #42\n```\nCloses #9\n```",
        "Closes #42\nFixes: #99",
        "Closes #42\nCloses https://github.com/owner/repo/issues/99",
      ]) {
        installFake(env, "gh", [
          { match: ["api", "graphql", `head=${branch}`], stdout: branchPrJson({ headRefName: branch }) },
        ]);
        expectCode(() => prCreate(repo, { title: "T", body, draft: false }), 2);
        expectCode(() => prEdit(repo, { body }), 2);
        assert.ok(!fakeCalls(env, "gh").some((c) => c[1] === "create" || c[1] === "edit"));
      }
      installFake(env, "gh", [
        { match: ["api", "graphql", `head=${branch}`], stdout: branchPrJson({ headRefName: branch }) },
        { match: ["pr", "edit"], stdout: "edited" },
        closingRule(),
      ]);
      assert.equal(prEdit(repo, { body: "Resolves: #42" }), "edited");
      writeFileSync(join(fx.main, ".wt/worktree.json"), JSON.stringify({ issue: 99 }));
      expectCode(() => prCreate(repo, { title: "T", body: "Closes #42", draft: false }), 2);
      expectCode(() => prEdit(repo, { body: "Closes #42" }), 2);
    },
    { branch: "emend-42-fix-pane" },
  ));

test("issue branch closing guards recognize Markdown emphasis and ignore word fragments", () =>
  scenario(
    ({ env, fx, repo }) => {
      const branch = "emend-42-fix-pane";
      mkdirSync(join(fx.main, ".wt"));
      writeFileSync(join(fx.main, ".wt/worktree.json"), JSON.stringify({ issue: 42 }));
      gitIn(fx.main, "remote", "set-url", "origin", "https://github.com/current/project.git");
      installFake(env, "gh", [
        {
          match: ["api", "graphql", `head=${branch}`],
          stdout: branchPrJson({ headRefName: branch }, "current/project"),
        },
      ]);
      for (const reference of [
        "_Fixes #9_",
        "__Closes owner/repo#9__",
        "*Fixes #9*",
        "~~Fixes #9~~",
        "**Resolves https://github.com/other/repo/issues/9**",
      ]) {
        const body = `Closes #42\n${reference}`;
        for (const action of [() => prCreate(repo, { title: "T", body, draft: false }), () => prEdit(repo, { body })]) {
          assert.throws(
            action,
            (e: unknown) =>
              e instanceof WtError &&
              e.code === 2 &&
              e.message === "The PR text must not close an issue other than #42.",
            reference,
          );
        }
      }
      assert.ok(!fakeCalls(env, "gh").some((c) => c[1] === "create" || c[1] === "edit"));
      gitIn(fx.main, "remote", "set-url", "origin", fx.origin);
      for (const body of ["_Closes #42_", "Closes #42\nprefixes #9", "Closes #42\nsuffix#9"]) {
        installFake(env, "gh", createRules(CREATED_URL, branch));
        assert.equal(prCreate(repo, { title: "T", body, draft: false }), CREATED_URL, body);
        installFake(env, "gh", [
          { match: ["api", "graphql", `head=${branch}`], stdout: branchPrJson({ headRefName: branch }) },
          { match: ["pr", "edit"], stdout: "edited" },
          closingRule(),
        ]);
        assert.equal(prEdit(repo, { body }), "edited", body);
      }
    },
    { branch: "emend-42-fix-pane" },
  ));

test("pr merge accepts a subject file and strips one final newline", () =>
  mscenario(async (ctx) => {
    installFake(
      ctx.env,
      "gh",
      mergeRules({}, [
        { match: ["pr", "merge", "7"], stdout: "merged\n" },
        { match: READ_BACK_ARGS, stdout: mergedState() },
      ]),
    );
    const subject = join(ctx.env.root, "subject.txt");
    const body = join(ctx.env.root, "body.md");
    writeFileSync(subject, "fix: reviewed change\r\n");
    writeFileSync(body, "Body\n");
    await commands.pr?.({
      repo: ctx.repo,
      args: ["merge", "--pr", "7", "--match-head", headSha, "--subject-file", subject, "--body-file", body],
    });
    assert.ok(mergeCalls(ctx.env)[0]?.includes("--subject=fix: reviewed change"));
  }));

for (const state of ["open", "merged"] as const) {
  test(`pr number --branch from main prints only a ${state} number or a one-line refusal`, () =>
    scenario(
      async ({ env, fx }) => {
        const wt = join(fx.main, "bin/wt");
        const args = ["pr", "number", "--branch", BRANCH, "--state", state];
        const pr = { number: 7, state: state.toUpperCase(), headRefName: BRANCH };
        const rule = (nodes: Record<string, unknown>[]) => ({
          match: ["api", "graphql", `head=${BRANCH}`],
          stdout: branchPrPage(nodes),
        });
        installFake(env, "gh", [
          rule([
            { ...pr, number: 8, headRefName: `${BRANCH}-prefix` },
            { ...pr, number: 9, isCrossRepository: true },
            { ...pr, number: 10, author: { login: "other" } },
            pr,
          ]),
        ]);
        assert.deepEqual(await runWt(wt, args, { cwd: fx.main }), { code: 0, stdout: "7\n", stderr: "" });
        installFake(env, "gh", [rule([])]);
        assert.deepEqual(await runWt(wt, args, { cwd: fx.main }), {
          code: 1,
          stdout: "",
          stderr: `No ${state} pull request for this branch.\n`,
        });
        installFake(env, "gh", [rule([pr, { ...pr, number: 11 }])]);
        assert.deepEqual(await runWt(wt, args, { cwd: fx.main }), {
          code: 1,
          stdout: "",
          stderr: `More than one ${state} pull request matches this branch.\n`,
        });
      },
      { withBin: true, branch: null },
    ));
}

for (const failure of ["foreign issue", "failed read"] as const) {
  test(`merge launcher preserves stdout and exits 1 after a post-merge ${failure}`, () =>
    scenario(
      async (ctx) => {
        publishHead(ctx);
        const post = closingRule([{ number: 57, repository: { nameWithOwner: "owner/repo" } }]);
        if (failure === "failed read") Object.assign(post, { code: 1, stdout: "", stderr: "synthetic read failure" });
        installFake(
          ctx.env,
          "gh",
          mergeRules({}, [
            { ...closingRule(), times: 1 },
            post,
            { match: ["pr", "merge", "7"], stdout: "merged\n" },
            { match: READ_BACK_ARGS, stdout: mergedState() },
          ]),
        );
        const result = await runWt(
          join(ctx.fx.main, "bin/wt"),
          ["pr", "merge", "--pr", "7", "--match-head", headSha, "--subject", "Fix pane", "--body", "Description"],
          { cwd: ctx.fx.main },
        );
        assert.equal(result.code, 1);
        assert.equal(result.stdout, `MERGED ${MERGE_SHA}\n`);
        assert.match(result.stderr, /Warning:/);
        if (failure === "foreign issue") {
          assert.match(result.stderr, /owner\/repo#57/);
          assert.match(result.stderr, /Check and reopen/);
        } else assert.match(result.stderr, /post-merge closing check could not run/);
        assert.equal(
          fakeCalls(ctx.env, "gh").filter((args) => args.some((a) => a.includes("closingIssuesReferences"))).length,
          2,
        );
      },
      { withBin: true },
    ));
}
