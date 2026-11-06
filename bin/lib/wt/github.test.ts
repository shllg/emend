import assert from "node:assert/strict";
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { commands, prCreate, prEdit, prMerge, push, pushArgs } from "./github.ts";
import { type Repo, resolveRepo } from "./repo.ts";
import {
  commitFile,
  type FakeRule,
  type Fixture,
  fakeCalls,
  gitIn,
  installFake,
  makeFixture,
  makeTestEnv,
  runWt,
  type TestEnv,
} from "./test-support.ts";
import { WtError } from "./validate.ts";
import { setup } from "./worktree.ts";

const SHA = "a".repeat(40);
const OTHER_SHA = "b".repeat(40);
const MERGE_SHA = "c".repeat(40);
const BRANCH = "feat-a";

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
    if (o.branch !== null) gitIn(fx.main, "checkout", "--quiet", "-b", o.branch ?? BRANCH);
    await fn({ env, fx, repo: resolveRepo(fx.main) });
  } finally {
    env.cleanup();
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
  match: ["pr", "view", BRANCH],
  stderr: `no pull requests found for branch "${BRANCH}"\n`,
  code: 1,
};

function prJson(extra: Record<string, unknown> = {}): string {
  return JSON.stringify({
    number: 7,
    state: "OPEN",
    headRefName: BRANCH,
    isCrossRepository: false,
    ...extra,
  });
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

test("push sets upstream; lease adds force-if-includes", () =>
  scenario((ctx) => {
    commitFile(ctx.fx.main, "a.txt", "a\n");
    const plain = pushArgs(SHA, BRANCH, false);
    const leased = pushArgs(SHA, BRANCH, true);
    for (const flag of ["--force-with-lease", "--force-if-includes"]) {
      assert.ok(!plain.includes(flag), flag);
      assert.ok(leased.includes(flag), flag);
    }
    assert.deepEqual(plain.slice(0, 2), ["push", "-u"]);
    assert.ok(plain.includes("origin"));
    push(ctx.repo, ctx.fx.main, { forceWithLease: false });
    assert.equal(gitIn(ctx.fx.origin, "rev-parse", BRANCH), gitIn(ctx.fx.main, "rev-parse", "HEAD"));
    assert.equal(gitIn(ctx.fx.main, "rev-parse", "--abbrev-ref", `${BRANCH}@{upstream}`), `origin/${BRANCH}`);
    // Rewrite the commit and push with the lease.
    gitIn(ctx.fx.main, "commit", "--quiet", "--amend", "-m", "rewritten");
    expectCode(() => push(ctx.repo, ctx.fx.main, { forceWithLease: false }), 1);
    push(ctx.repo, ctx.fx.main, { forceWithLease: true });
    assert.equal(gitIn(ctx.fx.origin, "rev-parse", BRANCH), gitIn(ctx.fx.main, "rev-parse", "HEAD"));
  }));

test("a lease push names the local branch as its source", () =>
  scenario((ctx) => {
    const old = commitFile(ctx.fx.main, "a.txt", "a\n");
    push(ctx.repo, ctx.fx.main, { forceWithLease: false });
    gitIn(ctx.fx.main, "commit", "--quiet", "--amend", "-m", "rewritten");
    const amended = gitIn(ctx.fx.main, "rev-parse", "HEAD");
    const hook = join(ctx.fx.main, ".git", "hooks", "pre-push");
    mkdirSync(join(ctx.fx.main, ".git", "hooks"), { recursive: true });
    writeFileSync(
      hook,
      "#!/bin/sh\nwhile IFS= read -r line; do\n  printf '%s\\n' \"$line\"\ndone >> ../pre-push-input\n",
    );
    chmodSync(hook, 0o755);

    push(ctx.repo, ctx.fx.main, { forceWithLease: true });
    assert.equal(
      readFileSync(join(ctx.env.root, "pre-push-input"), "utf8"),
      `refs/heads/${BRANCH} ${amended} refs/heads/${BRANCH} ${old}\n`,
    );
    assert.equal(gitIn(ctx.fx.origin, "rev-parse", BRANCH), amended);
  }));

test("a lease push refuses a branch that moved after HEAD was resolved", () =>
  scenario((ctx) => {
    const pushed = commitFile(ctx.fx.main, "a.txt", "a\n");
    push(ctx.repo, ctx.fx.main, { forceWithLease: false });
    gitIn(ctx.fx.main, "commit", "--quiet", "--amend", "-m", "rewritten");

    assert.throws(
      () =>
        push(ctx.repo, ctx.fx.main, {
          forceWithLease: true,
          beforePush: () => commitFile(ctx.fx.main, "late.txt", "late\n"),
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

test("push argv sends the checked sha; a lease push names the local branch", () => {
  const sha = "d".repeat(40);
  const spec = `${sha}:refs/heads/${BRANCH}`;
  assert.deepEqual(pushArgs(sha, BRANCH, false), ["push", "-u", "--no-follow-tags", "origin", spec]);
  assert.deepEqual(pushArgs(sha, BRANCH, true), [
    "push",
    "-u",
    "--no-follow-tags",
    "--force-with-lease",
    "--force-if-includes",
    "origin",
    `refs/heads/${BRANCH}:refs/heads/${BRANCH}`,
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

// ---------------------------------------------------------------------------------------------
// pr create

test("pr create passes head, base, title and the body on stdin", () =>
  scenario((ctx) => {
    installFake(ctx.env, "gh", [NO_PR, { match: ["pr", "create"], stdout: "https://example.invalid/pr/9\n" }]);
    const bodies = captureBodies(ctx.env);
    const out = prCreate(ctx.repo, { title: "Add the thing\n", body: "## Summary\n\nDoes it.\n", draft: true });
    assert.equal(out.trim(), "https://example.invalid/pr/9");
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
    ]);
    assert.deepEqual(capturedBodies(bodies), ["## Summary\n\nDoes it.\n"]);
  }));

test("pr create without --draft passes no --draft", () =>
  scenario((ctx) => {
    installFake(ctx.env, "gh", [NO_PR, { match: ["pr", "create"], stdout: "u\n" }]);
    prCreate(ctx.repo, { title: "T", body: "B", draft: false });
    const create = fakeCalls(ctx.env, "gh").find((a) => a[1] === "create") as string[];
    assert.ok(!create.includes("--draft"));
  }));

test("pr create refuses when an open PR exists (3) and fails with 1 when gh fails", () =>
  scenario((ctx) => {
    installFake(ctx.env, "gh", [{ match: ["pr", "view", BRANCH], stdout: prJson() }]);
    expectCode(() => prCreate(ctx.repo, { title: "T", body: "B", draft: false }), 3);
    assert.equal(fakeCalls(ctx.env, "gh").filter((a) => a[1] === "create").length, 0);

    installFake(ctx.env, "gh", [NO_PR, { match: ["pr", "create"], stderr: "boom\n", code: 1 }]);
    expectCode(() => prCreate(ctx.repo, { title: "T", body: "B", draft: false }), 1);
  }));

test("pr create reads --body-file and refuses both body flags or none (end to end)", () =>
  scenario(
    async (ctx) => {
      installFake(ctx.env, "gh", [NO_PR, { match: ["pr", "create"], stdout: "https://example.invalid/pr/9\n" }]);
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
      { match: ["pr", "view", BRANCH], stdout: prJson() },
      { match: ["pr", "edit"], stdout: "https://example.invalid/pr/7\n" },
    ]);
    const bodies = captureBodies(ctx.env);
    prEdit(ctx.repo, { title: "New title", body: "New body" });
    const edit = fakeCalls(ctx.env, "gh").find((a) => a[1] === "edit") as string[];
    assert.deepEqual(edit, ["pr", "edit", "7", "--title=New title", "--body-file", "-"]);
    assert.deepEqual(capturedBodies(bodies), ["New body"]);
    expectCode(() => prEdit(ctx.repo, {}), 2);
    expectCode(() => prEdit(ctx.repo, { title: "two\nlines" }), 2);
  }));

test("pr edit --pr works from a linked worktree, for an open same-repo PR into main only", () =>
  scenario(
    (ctx) => {
      const wt = setup(ctx.repo, { branch: "feat-b", busy: new Set<number>() }).path;
      const repo = resolveRepo(wt);
      const viewArgs = ["pr", "view", "7", "--json", "number,state,headRefName,isCrossRepository,baseRefName"];
      const edit: FakeRule = { match: ["pr", "edit", "7"], stdout: "ok\n" };
      installFake(ctx.env, "gh", [{ match: viewArgs, stdout: prJson({ baseRefName: "main" }) }, edit]);
      prEdit(repo, { pr: "7", title: "T" });
      assert.equal(fakeCalls(ctx.env, "gh").filter((a) => a[1] === "edit").length, 1);

      for (const extra of [{ baseRefName: "release" }, { state: "CLOSED" }, { isCrossRepository: true }]) {
        installFake(ctx.env, "gh", [{ match: viewArgs, stdout: prJson({ baseRefName: "main", ...extra }) }, edit]);
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
  "number,baseRefName,headRefName,isCrossRepository,state,headRefOid",
];
const READ_BACK_ARGS = ["pr", "view", "7", "--json", "state,mergeCommit"];
const MERGED_STATE = JSON.stringify({ state: "MERGED", mergeCommit: { oid: MERGE_SHA } });

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
        ...view,
      }),
    },
    ...rest,
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
        { match: READ_BACK_ARGS, stdout: MERGED_STATE },
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
        { match: READ_BACK_ARGS, stdout: MERGED_STATE },
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
        { match: READ_BACK_ARGS, stdout: MERGED_STATE },
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
    assert.equal(prMerge(ctx.repo, MERGE_ARGS), "QUEUED");
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
        { match: READ_BACK_ARGS, stdout: MERGED_STATE },
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
        { match: READ_BACK_ARGS, stdout: MERGED_STATE },
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

test("pr merge --pr works from a linked worktree", () =>
  mscenario(
    (ctx) => {
      const wt = setup(ctx.repo, { branch: "feat-b", busy: new Set<number>() }).path;
      installFake(
        ctx.env,
        "gh",
        mergeRules({}, [
          { match: ["pr", "merge", "7"], stdout: "merged\n" },
          { match: READ_BACK_ARGS, stdout: MERGED_STATE },
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
      { match: ["pr", "view", BRANCH], stdout: prJson() },
      ...mergeRules({}, [
        { match: ["pr", "merge", "7"], stdout: "queued\n" },
        { match: READ_BACK_ARGS, stdout: JSON.stringify({ state: "OPEN", mergeCommit: null }) },
      ]),
    ]);
    assert.equal(prMerge(ctx.repo, { ...MERGE_ARGS, pr: undefined }), "QUEUED");
  }));

test("pr merge reports MERGED when gh failed only after merging", () =>
  mscenario((ctx) => {
    installFake(
      ctx.env,
      "gh",
      mergeRules({}, [
        { match: ["pr", "merge", "7"], stderr: "failed to delete local branch\n", code: 1 },
        { match: READ_BACK_ARGS, stdout: MERGED_STATE },
      ]),
    );
    assert.equal(prMerge(ctx.repo, MERGE_ARGS), `MERGED ${MERGE_SHA}`);
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
    { match: READ_BACK_ARGS, stdout: MERGED_STATE },
  ]);
}

test("pr create and pr merge refuse a branch built on unpushed local main, and proceed once main is pushed", () =>
  scenario(
    (ctx) => {
      const repo = branchOnLocalMain(ctx);
      publishHead(ctx);
      installFake(ctx.env, "gh", [NO_PR, { match: ["pr", "create"], stdout: "u\n" }, ...mergeOkRules()]);
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
      installFake(ctx.env, "gh", [NO_PR, { match: ["pr", "create"], stdout: "u\n" }, ...mergeOkRules()]);
      assert.equal(prCreate(repo, { title: "T", body: "B", draft: false }).trim(), "u");
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
      installFake(ctx.env, "gh", [NO_PR, { match: ["pr", "create"], stdout: "u\n" }, ...mergeOkRules()]);
      assert.equal(prCreate(repo, { title: "T", body: "B", draft: false }).trim(), "u");
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

test("the command table has only fetch, push and pr", () => {
  assert.deepEqual(Object.keys(commands).sort(), ["fetch", "pr", "push"]);
});
