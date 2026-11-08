import assert from "node:assert/strict";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { formatIssues, issueSlug, issueSnapshot, issueSnapshotText, pickIssue, scanIssues } from "./issues.ts";
import { readRegistry, registryPath, setAfterLockHookForTests, withRegistry } from "./registry.ts";
import { type Repo, resolveRepo } from "./repo.ts";
import {
  type Fixture,
  fakeCalls,
  fakeGithubOrigin,
  gitIn,
  installFake,
  issueEvent,
  issuePage,
  issueRules,
  makeFixture,
  makeTestEnv,
  prPage,
  readyIssue,
  runWt,
  type TestEnv,
} from "./test-support.ts";
import { BRANCH_PREFIX, branchName, WtError } from "./validate.ts";
import { setup } from "./worktree.ts";

async function scenario(fn: (ctx: { env: TestEnv; fx: Fixture; repo: Repo }) => void | Promise<void>): Promise<void> {
  const env = makeTestEnv({ ports: false });
  try {
    const fx = makeFixture(env, { withBin: true });
    fakeGithubOrigin(env, fx);
    await fn({ env, fx, repo: resolveRepo(fx.main) });
  } finally {
    env.cleanup();
  }
}

const labeled = (actor: string | null, label = "ready") => issueEvent(actor, "LabeledEvent", undefined, label);
const timeline = (...events: ReturnType<typeof labeled>[]) => ({ nodes: events, pageInfo: { hasPreviousPage: false } });
const labels = (...names: string[]) => ({
  nodes: ["ready", ...names].map((name) => ({ name })),
  pageInfo: { hasNextPage: false },
});
const blockedBy = (...numbers: number[]) => ({
  nodes: numbers.map((number) => ({ number, state: "OPEN" })),
  pageInfo: { hasNextPage: false },
});

test("issues trust only the latest ready event, then blockers, then taken branches", () =>
  scenario(({ env, fx, repo }) => {
    gitIn(fx.main, "branch", "emend-1-taken");
    gitIn(fx.main, "branch", "emend-2-taken");
    installFake(
      env,
      "gh",
      issueRules([
        readyIssue(1, {
          timelineItems: timeline(labeled("owner"), labeled("outsider"), labeled("owner", "bug")),
          blockedBy: blockedBy(90),
        }),
        readyIssue(2, { blockedBy: blockedBy(90, 91) }),
        readyIssue(3, { timelineItems: timeline(labeled("outsider"), labeled("OWNER")) }),
        readyIssue(4, { timelineItems: timeline(labeled(null)) }),
        readyIssue(5, { timelineItems: timeline() }),
        readyIssue(6, { blockedBy: { nodes: [{ number: 90, state: "CLOSED" }], pageInfo: { hasNextPage: false } } }),
      ]),
    );
    const rows = scanIssues(repo);
    assert.deepEqual(
      rows.map((r) => r.status),
      ["untrusted", "blocked", "pickable", "untrusted", "untrusted", "pickable"],
    );
    assert.match(rows[0]?.reason ?? "", /owner/);
    assert.equal(rows[1]?.reason, "blocked by #90, #91");
    assert.deepEqual(rows[1]?.blockedBy, [
      { number: 90, state: "OPEN" },
      { number: 91, state: "OPEN" },
    ]);
    assert.equal(rows[2]?.reason, null);
    assert.equal(rows[2]?.branch, null);
  }));

test("issues detect local, registered, live origin, and PR heads with an exact issue prefix", () =>
  scenario(({ env, fx, repo }) => {
    gitIn(fx.main, "branch", "emend-7-local");
    gitIn(fx.origin, "branch", "emend-9-remote", "main");
    withRegistry(repo, (r) => {
      r.worktrees["emend-8-registered"] = {
        path: join(repo.worktreesDir, "missing"),
        port: 1,
        task: null,
        issue: 8,
        mode: "github",
        createdAt: "t",
      };
    });
    for (const name of [
      "emend-011-task",
      "011-legacy-task",
      "emend-110-different",
      "other-emend-11-project",
      "emend-11",
    ])
      gitIn(fx.main, "branch", name);
    const prs = Array.from({ length: 31 }, (_, i) => ({
      number: i + 1,
      headRefName: i === 30 ? "emend-10-pr" : `other-${i}`,
    }));
    installFake(
      env,
      "gh",
      issueRules(
        [7, 8, 9, 10, 11].map((n) => readyIssue(n)),
        prs,
      ),
    );
    const rows = scanIssues(repo);
    assert.deepEqual(
      rows.map((r) => r.status),
      ["taken", "taken", "taken", "taken", "pickable"],
    );
    assert.deepEqual(
      rows.map((r) => r.branch),
      ["emend-7-local", "emend-8-registered", "emend-9-remote", "emend-10-pr", null],
    );
    for (const [i, why] of ["local branch", "registered worktree", "origin branch", "open PR #31"].entries())
      assert.ok(rows[i]?.reason?.includes(why));
    assert.throws(() => gitIn(fx.main, "rev-parse", "--verify", "origin/emend-9-remote"));
    const calls = fakeCalls(env, "gh");
    assert.equal(calls.length, 2);
    assert.ok(calls.some((c) => c.some((a) => a.includes("closingIssuesReferences"))));
  }));

test("issues order bugs first, then priority, age and number and tidy terminal titles", () =>
  scenario(async ({ env, fx, repo }) => {
    const old = "2025-01-01T00:00:00Z";
    installFake(
      env,
      "gh",
      issueRules([
        readyIssue(8, { labels: labels("P2"), createdAt: old }),
        readyIssue(7, { labels: labels("improvement") }),
        readyIssue(6, { labels: labels("feature", "P1"), createdAt: old }),
        readyIssue(5, { labels: labels("feature", "P0") }),
        readyIssue(4, { labels: labels("bug", "P2"), title: "Bad\u001b title\u0085\u2028here" }),
        readyIssue(3, { labels: labels("bug", "P1"), createdAt: old }),
        readyIssue(2, { labels: labels("bug"), createdAt: old }),
        readyIssue(1, { labels: labels("bug", "P0") }),
      ]),
    );
    const rows = scanIssues(repo);
    assert.deepEqual(
      rows.map((r) => r.number),
      [1, 2, 3, 4, 5, 6, 7, 8],
    );
    assert.equal(rows[6]?.kind, "improvement");
    assert.equal(rows[7]?.kind, "-");
    assert.equal(rows[6]?.priority, "P1");
    const out = await runWt(join(fx.main, "bin/wt"), ["issues"], { cwd: fx.main });
    assert.equal(out.code, 0, out.stderr);
    assert.equal(out.stdout, `${formatIssues(rows)}\n`);
    assert.match(out.stdout, /^#1 {2}bug {2}P0 {2}pickable {2}Fix the review pane/m);
    assert.doesNotMatch(out.stdout, /[^\P{Cc}\n]|[\p{Zl}\p{Zp}]/u);
    const json = await runWt(join(fx.main, "bin/wt"), ["issues", "--json"], { cwd: fx.main });
    assert.equal(json.code, 0, json.stderr);
    assert.deepEqual(
      JSON.parse(json.stdout),
      rows.map((row) =>
        row.status === "untrusted" ? { number: row.number, status: row.status, reason: row.reason, title: null } : row,
      ),
    );
    assert.deepEqual(
      Object.keys(rows[0] ?? {}).sort(),
      ["number", "title", "url", "kind", "priority", "status", "reason", "blockedBy", "branch"].sort(),
    );
  }));

test("issues page past 100 with raw string variables, never a query per issue", () =>
  scenario(({ env, repo }) => {
    const cursor = "@synthetic-not-a-file";
    installFake(env, "gh", [
      {
        match: ["api", "graphql"],
        queryIncludes: "issues(states:",
        times: 1,
        stdout: issuePage(
          Array.from({ length: 100 }, (_, i) => readyIssue(i + 1)),
          cursor,
        ),
      },
      { match: ["api", "graphql", `cursor=${cursor}`], stdout: issuePage([readyIssue(101)]) },
      { match: ["api", "graphql"], queryIncludes: "pullRequests(states:", stdout: prPage([]) },
    ]);
    assert.equal(scanIssues(repo).length, 101);
    const calls = fakeCalls(env, "gh").filter((c) => c.some((a) => a.includes("issues(states:")));
    assert.equal(calls.length, 2);
    const query = calls[0]?.find((c) => c.startsWith("query=")) ?? "";
    assert.equal(
      calls[1]?.find((c) => c.startsWith("query=")),
      query,
    );
    assert.ok(!query.includes(cursor));
    for (const pattern of [
      /owner \{ login \}/,
      /states: \[OPEN\]/,
      /labels: \["ready"\]/,
      /blockedBy\(first: 100\)/,
      /timelineItems\(itemTypes: \[LABELED_EVENT, UNLABELED_EVENT, RENAMED_TITLE_EVENT\], last: 50\)/,
    ])
      assert.match(query, pattern);
    for (const call of calls)
      for (const variable of ["owner=owner", "name=repo", ...call.filter((arg) => arg.startsWith("cursor="))])
        assert.equal(call[call.indexOf(variable) - 1], "-f");
  }));

test("pickIssue shares the queue preflight and distinguishes missing, blocked, untrusted and taken", () =>
  scenario(({ env, fx, repo }) => {
    gitIn(fx.main, "branch", "emend-3-some-slug");
    installFake(
      env,
      "gh",
      issueRules([
        readyIssue(1, { blockedBy: blockedBy(9) }),
        readyIssue(2, { timelineItems: timeline(labeled("outsider")) }),
        readyIssue(3),
        readyIssue(4),
      ]),
    );
    for (const [n, code, reason] of [
      [1, 2, "blocked by #9"],
      [2, 2, "untrusted"],
      [3, 3, "taken"],
      [5, 2, "not open and ready"],
    ] as const) {
      assert.throws(
        () => pickIssue(repo, n),
        (e: unknown) => e instanceof WtError && e.code === code && e.message.includes(reason),
      );
    }
    assert.equal(pickIssue(repo, 4).status, "pickable");
  }));

test("queue failures return 69 with one line, including missing gh and failed fetch", () =>
  scenario(async ({ env, fx }) => {
    const run = () => runWt(join(fx.main, "bin/wt"), ["issues"], { cwd: fx.main });
    const check = (r: Awaited<ReturnType<typeof run>>) => {
      assert.equal(r.code, 69, r.stderr);
      assert.equal(r.stdout, "");
      assert.equal(r.stderr.trimEnd().split("\n").length, 1);
    };
    check(await run());
    for (const rule of [
      { stderr: "error connecting to api.github.com\nnetwork down\n", code: 1 },
      { stderr: "HTTP 502\nsecond line\u001b\n", code: 1 },
      { code: 124 },
      { stdout: "not json" },
      { stdout: JSON.stringify({ errors: [{ message: "failed" }] }) },
    ]) {
      installFake(env, "gh", [rule]);
      check(await run());
    }
    installFake(env, "gh", [
      { match: ["api", "graphql"], queryIncludes: "pullRequests(states:", stderr: "network is unreachable", code: 1 },
      ...issueRules([readyIssue(1)]),
    ]);
    check(await run());
    installFake(env, "gh", issueRules([readyIssue(1)]));
    rmSync(fx.origin, { recursive: true, force: true });
    check(await run());
  }));

test("partial dependency data cannot release work, and empty queues remain valid", () =>
  scenario(async ({ env, fx, repo }) => {
    for (const extra of [
      { blockedBy: null },
      { blockedBy: { nodes: [], pageInfo: { hasNextPage: true } } },
      { blockedBy: { nodes: [{ number: 2, state: "UNKNOWN" }] } },
      { labels: { nodes: [], pageInfo: { hasNextPage: true } } },
      { timelineItems: null },
    ]) {
      installFake(env, "gh", issueRules([readyIssue(1, extra)]));
      assert.throws(
        () => scanIssues(repo),
        (e: unknown) => e instanceof WtError && e.code === 69,
      );
    }
    installFake(env, "gh", issueRules([]));
    assert.deepEqual(scanIssues(repo), []);
    const out = await runWt(join(fx.main, "bin/wt"), ["issues", "--json"], { cwd: fx.main });
    assert.equal(out.code, 0);
    assert.deepEqual(JSON.parse(out.stdout), []);
  }));

test("issue slugs use up to five ASCII words and fit the branch limit", () => {
  assert.equal(issueSlug("Fix: THE review pane now please", 7), "fix-the-review-pane-now");
  assert.equal(issueSlug("你好 🎉", 7), "issue");
  assert.equal(issueSlug("Crash", 7), "crash");
  for (const title of [
    "Fix bug",
    "a".repeat(300),
    `${"a".repeat(300)} ${"b".repeat(300)}`,
    "many somewhat longer words for testing the maximum",
  ]) {
    const slug = issueSlug(title, 1234567);
    const branch = `${BRANCH_PREFIX}1234567-${slug}`;
    assert.equal(branchName(branch), branch);
    assert.match(slug, /^[a-z0-9]+(?:-[a-z0-9]+){0,4}$/);
    if (title.includes(" ")) assert.ok(slug.includes("-"));
  }
});

test("repository mismatch refuses the queue and spawn without creating a claim", () =>
  scenario(async ({ env, fx, repo }) => {
    const page = JSON.parse(issuePage([readyIssue(42)]));
    page.data.repository.nameWithOwner = "outsider/repo";
    installFake(env, "gh", [{ stdout: JSON.stringify(page) }]);
    for (const args of [["issues"], ["spawn", "--issue", "42"]]) {
      const out = await runWt(join(fx.main, "bin/wt"), args, { cwd: fx.main, env: { HERDR_ENV: "1" } });
      assert.equal(out.code, 2, out.stderr);
      assert.match(out.stderr, /Repository mismatch/);
    }
    assert.deepEqual(readRegistry(repo).worktrees, {});
    assert.equal(existsSync(repo.worktreesDir), false);
    assert.deepEqual(fakeCalls(env, "herdr"), []);
  }));

test("deleted remote tracking refs do not claim work; unfetched heads do", () =>
  scenario(({ env, fx, repo }) => {
    gitIn(fx.origin, "branch", "emend-42-deleted", "main");
    gitIn(fx.main, "fetch", "--quiet", "origin");
    gitIn(fx.origin, "branch", "-D", "emend-42-deleted");
    gitIn(fx.main, "config", "remote.origin.fetch", "+refs/heads/main:refs/remotes/origin/main");
    gitIn(fx.origin, "branch", "emend-43-unfetched", "main");
    installFake(env, "gh", issueRules([readyIssue(42), readyIssue(43)]));
    assert.deepEqual(
      scanIssues(repo).map((r) => r.status),
      ["pickable", "taken"],
    );
    assert.ok(gitIn(fx.main, "rev-parse", "origin/emend-42-deleted"));
    assert.throws(() => gitIn(fx.main, "rev-parse", "--verify", "origin/emend-43-unfetched"));
  }));

test("cross-repository PRs are skipped, while same-repository closing references claim work", () =>
  scenario(({ env, repo }) => {
    const refs = (number: number, nameWithOwner = "owner/repo") => ({
      nodes: [{ number, repository: { nameWithOwner } }],
      pageInfo: { hasNextPage: false },
    });
    installFake(
      env,
      "gh",
      issueRules(
        [readyIssue(42), readyIssue(43), readyIssue(44)],
        [
          { number: 1, headRefName: "emend-42-fork", isCrossRepository: true, closingIssuesReferences: refs(42) },
          { number: 2, headRefName: "fix-without-issue-prefix", closingIssuesReferences: refs(43) },
          { number: 3, headRefName: "another-repo-reference", closingIssuesReferences: refs(44, "other/repo") },
        ],
      ),
    );
    const rows = scanIssues(repo);
    assert.deepEqual(
      rows.map((r) => r.status),
      ["pickable", "taken", "pickable"],
    );
    assert.match(rows[1]?.reason ?? "", /open PR #2/);
  }));

test("PR pagination and incomplete closing references fail closed", () =>
  scenario(({ env, repo }) => {
    installFake(env, "gh", [
      { queryIncludes: "pullRequests(states:", times: 1, stdout: prPage([], "more") },
      {
        queryIncludes: "pullRequests(states:",
        match: ["cursor=more"],
        stdout: prPage([{ number: 1, headRefName: "emend-42-later-page" }]),
      },
      ...issueRules([readyIssue(42)]),
    ]);
    assert.equal(scanIssues(repo)[0]?.status, "taken");
    installFake(
      env,
      "gh",
      issueRules(
        [readyIssue(42)],
        [
          {
            number: 1,
            headRefName: "anything",
            closingIssuesReferences: { nodes: [], pageInfo: { hasNextPage: true } },
          },
        ],
      ),
    );
    assert.throws(
      () => scanIssues(repo),
      (e: unknown) => e instanceof WtError && e.code === 69,
    );
  }));

test("JSON output tidies titles and claimed branch names", () =>
  scenario(async ({ env, fx }) => {
    installFake(
      env,
      "gh",
      issueRules(
        [readyIssue(42, { title: "Fix\u202e title\u200b" })],
        [{ number: 1, headRefName: "emend-42-\u202epr\u200b" }],
      ),
    );
    const out = await runWt(join(fx.main, "bin/wt"), ["issues", "--json"], { cwd: fx.main });
    assert.equal(out.code, 0, out.stderr);
    const [row] = JSON.parse(out.stdout);
    assert.equal(row.title, null);
    assert.equal(row.branch, undefined);
    assert.doesNotMatch(out.stdout, /\p{Cf}/u);
  }));

test("issue check accepts only its own claims and unchanged approved content", () =>
  scenario(async ({ env, fx, repo }) => {
    const original = readyIssue(42);
    installFake(env, "gh", issueRules([original]));
    const picked = pickIssue(repo, 42);
    const snapshot = issueSnapshot(picked);
    const wt = setup(repo, { branch: "emend-42-check", issue: 42 });
    assert.equal(readFileSync(join(wt.path, ".wt/issue.md"), "utf8"), issueSnapshotText(picked));
    const createdSnapshot = JSON.parse(readFileSync(join(wt.path, ".wt/issue.json"), "utf8"));
    assert.deepEqual(createdSnapshot, { ...snapshot, fetchedAt: createdSnapshot.fetchedAt });
    assert.ok(Number.isFinite(Date.parse(createdSnapshot.fetchedAt)));
    writeFileSync(join(wt.path, ".wt/issue.json"), JSON.stringify(snapshot));
    writeFileSync(join(wt.path, ".wt/issue.md"), issueSnapshotText(picked));
    gitIn(fx.origin, "branch", wt.branch, "main");
    const ownPr = {
      number: 1,
      headRefName: wt.branch,
      closingIssuesReferences: {
        nodes: [{ number: 42, repository: { nameWithOwner: "owner/repo" } }],
        pageInfo: { hasNextPage: false },
      },
    };
    const run = () => runWt(join(fx.main, "bin/wt"), ["issue", "check"], { cwd: wt.path });
    const fail = async (reason: RegExp, code = 1) => {
      const out = await run();
      assert.equal(out.code, code, out.stderr);
      assert.equal(out.stdout, "");
      assert.match(out.stderr, reason);
      assert.equal(out.stderr.trimEnd().split("\n").length, 1);
    };
    installFake(env, "gh", issueRules([original], [ownPr]));
    assert.deepEqual(await run(), { code: 0, stdout: "ok #42\n", stderr: "" });
    // Rendering changes alone do not change the approved raw title/body comparison.
    installFake(env, "gh", issueRules([{ ...original, bodyText: "Rendering changed" }], [ownPr]));
    assert.equal((await run()).code, 0);
    installFake(env, "gh", issueRules([original], [ownPr]));
    // The snapshot and branch alone do not register this worktree to an issue.
    const metadata = readFileSync(join(wt.path, ".wt/worktree.json"));
    rmSync(join(wt.path, ".wt/worktree.json"));
    await fail(/Worktree issue does not match the branch/);
    writeFileSync(join(wt.path, ".wt/worktree.json"), metadata);
    for (const [extra, reason] of [
      [{ state: "CLOSED" }, /not open and ready/],
      [{ labels: { nodes: [], pageInfo: { hasNextPage: false } } }, /not open and ready/],
      [{ timelineItems: { nodes: [issueEvent("outsider")], pageInfo: { hasPreviousPage: false } } }, /untrusted/],
      [{ blockedBy: { nodes: [{ number: 9, state: "OPEN" }], pageInfo: { hasNextPage: false } } }, /blocked/],
      [{ title: "Owner changes title" }, /title differs/],
      [{ body: "Owner changes body" }, /body differs/],
    ] as const) {
      installFake(env, "gh", issueRules([readyIssue(42, extra)], [ownPr]));
      await fail(reason);
    }
    installFake(env, "gh", issueRules([], [ownPr]));
    await fail(/not open and ready/);
    installFake(env, "gh", [{ code: 1, stderr: "network is unreachable" }]);
    await fail(/GitHub/, 69);
    installFake(env, "gh", issueRules([original], [ownPr, { number: 2, headRefName: "emend-42-other" }]));
    await fail(/taken/);
    installFake(env, "gh", issueRules([original], [ownPr, { ...ownPr, number: 2, headRefName: "closing-elsewhere" }]));
    await fail(/taken/);
    installFake(env, "gh", issueRules([original], [ownPr]));
    gitIn(fx.main, "branch", "emend-42-other-local");
    await fail(/taken/);
    gitIn(fx.main, "branch", "-D", "emend-42-other-local");
    gitIn(fx.origin, "branch", "emend-42-other-remote", "main");
    await fail(/taken/);
    gitIn(fx.origin, "branch", "-D", "emend-42-other-remote");
    withRegistry(repo, (r) => {
      r.worktrees["emend-another-name"] = {
        path: join(repo.worktreesDir, "other"),
        port: 2,
        task: null,
        issue: 42,
        mode: "github",
        createdAt: "t",
      };
    });
    await fail(/taken/);
  }));

for (const claim of ["registry", "local", "remote"] as const) {
  test(`setup rechecks a concurrent ${claim} claim for any slug under its lock`, () =>
    scenario(({ fx, repo, env }) => {
      installFake(env, "gh", issueRules([readyIssue(42)]));
      setAfterLockHookForTests(() => {
        if (claim === "registry") {
          const r = readRegistry(repo);
          r.worktrees["emend-different-name"] = {
            path: join(repo.worktreesDir, "other"),
            port: 1,
            task: null,
            issue: 42,
            mode: "github",
            createdAt: "t",
          };
          writeFileSync(registryPath(repo), JSON.stringify(r));
        } else gitIn(claim === "local" ? fx.main : fx.origin, "branch", "emend-42-concurrent", "main");
      });
      try {
        assert.throws(
          () => setup(repo, { branch: "emend-42-new-title", issue: 42 }),
          (e: unknown) => e instanceof WtError && e.code === 3 && /taken/.test(e.message),
        );
        assert.equal(existsSync(join(repo.worktreesDir, "emend-42-new-title")), false);
        assert.equal(readRegistry(repo).worktrees["emend-42-new-title"], undefined);
      } finally {
        setAfterLockHookForTests(null);
      }
    }));
}

test("setup --issue ignores oversized branch claims and writes spawn's exact approved snapshot", () =>
  scenario(async ({ env, fx, repo }) => {
    gitIn(fx.main, "branch", "emend-99999999999999999999-x");
    gitIn(fx.origin, "branch", "emend-99999999999999999998-x", "main");
    installFake(env, "gh", issueRules([readyIssue(42)]));
    const approved = pickIssue(repo, 42);
    const out = await runWt(join(fx.main, "bin/wt"), ["setup", "emend-42-snapshot", "--issue", "42"], { cwd: fx.main });
    assert.equal(out.code, 0, out.stderr);
    const top = join(repo.worktreesDir, "emend-42-snapshot");
    assert.equal(readFileSync(join(top, ".wt/issue.md"), "utf8"), issueSnapshotText(approved));
    const saved = JSON.parse(readFileSync(join(top, ".wt/issue.json"), "utf8"));
    assert.deepEqual(saved, { ...issueSnapshot(approved), fetchedAt: saved.fetchedAt });
    assert.ok(Number.isFinite(Date.parse(saved.fetchedAt)));
    const checked = await runWt(join(fx.main, "bin/wt"), ["issue", "check"], { cwd: top });
    assert.deepEqual(checked, { code: 0, stdout: "ok #42\n", stderr: "" });
  }));
