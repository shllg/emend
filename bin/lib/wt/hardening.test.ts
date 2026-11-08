import assert from "node:assert/strict";
import childProcess, { type SpawnSyncOptions } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { closingGuard, commands, prCreate, prEdit, prForBranch, prMerge } from "./github.ts";
import { scanIssues } from "./issues.ts";
import { run, runBytes } from "./proc.ts";
import { GIT_BASE, gitTry, type Repo, resolveRepo } from "./repo.ts";
import {
  branchPrPage,
  branchPrRules,
  commitFile,
  type FakeRule,
  type Fixture,
  fakeCalls,
  fakeGithubOrigin,
  githubPage,
  gitIn,
  installFake,
  issueRules,
  makeFixture,
  makeTestEnv,
  readyIssue,
  runWt,
  type TestEnv,
} from "./test-support.ts";
import { oneLine, WtError } from "./validate.ts";
import { cleanup, formatList, gc, safetyGuard as guard, list, setup } from "./worktree.ts";

const BRANCH = "feat-a";
const MERGE_SHA = "c".repeat(40);
interface Ctx {
  env: TestEnv;
  fx: Fixture;
  repo: Repo;
}
type Scenario = (ctx: Ctx) => void | Promise<void>;

async function scenario(fn: Scenario, branch: string | null = BRANCH): Promise<void> {
  // Only worktree guards need a reserved port range. GitHub-only cases create no listeners.
  const env = makeTestEnv({ ports: branch === null });
  try {
    const fx = makeFixture(env);
    fakeGithubOrigin(env, fx);
    if (branch !== null) gitIn(fx.main, "checkout", "--quiet", "-b", branch);
    await fn({ env, fx, repo: resolveRepo(fx.main) });
  } finally {
    env.cleanup();
  }
}

const worktreeScenario = (fn: Scenario) => scenario(fn, null);
const newWorktree = (repo: Repo, branch: string) => setup(repo, { branch, busy: new Set<number>() });

function closingScenario(fn: (repo: Repo) => void): void {
  const top = mkdtempSync(join(tmpdir(), "wt-closing-"));
  try {
    mkdirSync(join(top, ".wt"));
    writeFileSync(join(top, ".wt/worktree.json"), JSON.stringify({ issue: 42 }));
    fn({
      mainRoot: top,
      callerTop: top,
      callerBranch: "emend-42-fix-pane",
      commonDir: join(top, ".git"),
      worktreesDir: join(top, ".claude/worktrees"),
    });
  } finally {
    rmSync(top, { recursive: true, force: true });
  }
}

const closingRule = (): FakeRule => ({
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
          closingIssuesReferences: { nodes: [], pageInfo: { hasNextPage: false } },
        },
      },
    },
  }),
});

function createRules(stdout: string): FakeRule[] {
  return [
    { match: ["api", "graphql", `head=${BRANCH}`], stdout: branchPrPage([]), times: 1 },
    {
      match: ["api", "graphql", `head=${BRANCH}`],
      stdout: branchPrPage([{ number: 7, state: "OPEN", headRefName: BRANCH }]),
    },
    { match: ["pr", "create"], stdout },
    closingRule(),
  ];
}

let headSha = "";
function mscenario(fn: Scenario): Promise<void> {
  return scenario((ctx) => {
    headSha = gitIn(ctx.fx.main, "rev-parse", "HEAD");
    gitIn(ctx.fx.main, "push", "--quiet", "origin", `${headSha}:refs/pull/7/head`);
    return fn(ctx);
  });
}
const MERGE_ARGS = {
  pr: "7",
  get matchHead() {
    return headSha;
  },
  subject: "Fix pane",
  body: "Description",
};
function mergeOkRules(): FakeRule[] {
  return [
    {
      match: [
        "pr",
        "view",
        "7",
        "--json",
        "number,baseRefName,headRefName,isCrossRepository,state,headRefOid,title,body",
      ],
      stdout: JSON.stringify({
        number: 7,
        state: "OPEN",
        baseRefName: "main",
        headRefName: BRANCH,
        headRefOid: headSha,
        isCrossRepository: false,
        title: "Fix pane",
        body: "Description",
      }),
    },
    { match: ["pr", "merge", "7"], stdout: "merged\n" },
    {
      match: ["pr", "view", "7", "--json", "state,mergeCommit,headRefOid"],
      stdout: JSON.stringify({ state: "MERGED", mergeCommit: { oid: MERGE_SHA }, headRefOid: headSha }),
    },
    closingRule(),
  ];
}
const remoteHas = (ctx: Ctx) => gitIn(ctx.fx.origin, "for-each-ref", `refs/heads/${BRANCH}`) !== "";

function feedbackFilters() {
  const text = readFileSync(new URL("../../../.claude/skills/e-pr-finalize/SKILL.md", import.meta.url), "utf8");
  const filters = [...text.matchAll(/--argjson bots '\[\]'(?: --arg cutoff '<cutoff>')? '([^']+)'/g)].map(
    (match) => match[1] as string,
  );
  assert.equal(filters.length, 4);
  return {
    cutoff: filters[0] as string,
    threads: filters[1] as string,
    comments: filters[2] as string,
    reviews: filters[3] as string,
  };
}

function jq<T = Record<string, unknown>>(filter: string, data: unknown, variables: Record<string, unknown> = {}): T[] {
  const args = Object.entries({ bots: [], ...variables }).flatMap(([key, value]) =>
    key === "cutoff" ? ["--arg", key, String(value)] : ["--argjson", key, JSON.stringify(value)],
  );
  const result = childProcess.spawnSync("jq", [...args, "-c", filter], {
    input: JSON.stringify(data),
    encoding: "utf8",
  });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line) as T);
}

const jqOptions = { skip: childProcess.spawnSync("jq", ["--version"]).status !== 0 ? "jq is not installed" : false };
type FeedbackItem = Record<string, unknown>;
const feedbackTime = (day: number) => `2026-01-${String(day).padStart(2, "0")}T00:00:00Z`;
const humanItem = (body: string, day: number, association = "OWNER"): FeedbackItem => ({
  author: { __typename: "User", login: association === "NONE" ? "ignored-login" : "owner" },
  authorAssociation: association,
  body,
  createdAt: feedbackTime(day),
  lastEditedAt: null,
});
const botItem = (body: string, day: number, edit: number | null = null): FeedbackItem => ({
  ...humanItem(body, day, "NONE"),
  author: { __typename: "Bot", login: "review-bot" },
  lastEditedAt: edit === null ? null : feedbackTime(edit),
});
const feedbackThread = (
  id: string,
  nodes: FeedbackItem[],
  options: { resolved?: boolean; outdated?: boolean; more?: boolean } = {},
): FeedbackItem => ({
  id,
  isResolved: options.resolved ?? false,
  isOutdated: options.outdated ?? false,
  comments: { nodes, pageInfo: { hasNextPage: options.more ?? false } },
});
const feedbackPage = (key: string, nodes: FeedbackItem[], more = false) => ({
  data: { repository: { pullRequest: { [key]: { nodes, pageInfo: { hasNextPage: more } } } } },
});
type FeedbackSurface = "threads" | "comments" | "reviews";
function feedback(
  surfaces: Partial<Record<FeedbackSurface, FeedbackItem[]>> = {},
  bots = ["review-bot"],
  pages: Partial<Record<FeedbackSurface, unknown[]>> = {},
) {
  const input = {
    threads: pages.threads ?? [feedbackPage("reviewThreads", surfaces.threads ?? [])],
    comments: pages.comments ?? [feedbackPage("comments", surfaces.comments ?? [])],
    reviews: pages.reviews ?? [feedbackPage("reviews", surfaces.reviews ?? [])],
  };
  const filters = feedbackFilters();
  const cutoff = jq<string>(filters.cutoff, null, {
    bots,
    threads: [input.threads],
    comments: [input.comments],
    reviews: [input.reviews],
  })[0];
  assert.equal(typeof cutoff, "string");
  return {
    cutoff,
    threads: jq(filters.threads, input.threads, { bots, cutoff }),
    comments: jq(filters.comments, input.comments, { bots, cutoff }),
    reviews: jq(filters.reviews, input.reviews, { bots, cutoff }),
  };
}

function putItem(
  surfaces: Partial<Record<FeedbackSurface, FeedbackItem[]>>,
  key: FeedbackSurface,
  item: FeedbackItem,
): void {
  const items = surfaces[key] ?? [];
  items.push(key === "threads" ? feedbackThread(`thread-${items.length}`, [item]) : item);
  surfaces[key] = items;
}

test("feedback filters exclude unlisted bots even with owner association", jqOptions, () => {
  const unlisted = { ...botItem("unlisted-content", 1), authorAssociation: "OWNER" };
  const human = humanItem("human finding", 2);
  const surfaces = {
    threads: [feedbackThread("thread", [unlisted, human])],
    comments: [unlisted, human],
    reviews: [unlisted, human],
  };
  const result = feedback(surfaces, []);
  assert.equal(JSON.stringify(result).includes("unlisted-content"), false);
  assert.deepEqual(result.comments[1]?.items, [human]);
  assert.deepEqual(result.reviews[1]?.items, [human]);
  assert.equal(result.threads[1]?.botItemsNotTrusted, 2);
  assert.equal(result.comments[1]?.botItemsNotTrusted, 1);
  assert.equal(result.reviews[1]?.botItemsNotTrusted, 1);
  const listed = feedback(surfaces);
  assert.deepEqual(listed.comments[1]?.items, [unlisted, human]);
  assert.deepEqual(listed.reviews[1]?.items, [unlisted, human]);
});

for (const source of ["threads", "comments", "reviews"] as const) {
  for (const target of ["threads", "comments", "reviews"] as const) {
    test(`one bot cutoff from ${source} applies to ${target} and edited items`, jqOptions, () => {
      for (const bot of [botItem("excluded-bot-content", 3), botItem("excluded-bot-content", 1, 3)]) {
        const surfaces: Partial<Record<FeedbackSurface, FeedbackItem[]>> = {};
        putItem(surfaces, source, humanItem("ignored-content", 2, "NONE"));
        putItem(surfaces, target, bot);
        const result = feedback(surfaces);
        assert.equal(JSON.stringify(result).includes("excluded-bot-content"), false);
        assert.equal(JSON.stringify(result).includes("ignored-content"), false);
      }
      const surfaces: Partial<Record<FeedbackSurface, FeedbackItem[]>> = {};
      putItem(surfaces, source, humanItem("ignored-content", 3, "NONE"));
      putItem(surfaces, target, botItem("earlier-bot-content", 1, 2));
      assert.ok(JSON.stringify(feedback(surfaces)).includes("earlier-bot-content"));
    });
  }
}

test("an uncounted edited bot moves the global cutoff back to its creation", jqOptions, () => {
  const early = botItem("early", 1);
  const result = feedback({
    comments: [humanItem("outsider", 5, "NONE"), humanItem("counted human", 7)],
    threads: [feedbackThread("edited", [botItem("edited tainted bot", 2, 6)])],
    reviews: [early, botItem("tainted by earlier bot", 3, 4)],
  });
  assert.equal(result.cutoff, feedbackTime(2));
  assert.deepEqual(result.reviews[1]?.items, [early]);
  assert.equal(result.comments[1]?.ignored, 1);
});

test("global cutoff includes every page and rejects incomplete outer surfaces", jqOptions, () => {
  const result = feedback({ threads: [feedbackThread("new-thread", [botItem("excluded", 3)])] }, ["review-bot"], {
    comments: [
      feedbackPage("comments", [humanItem("ignored", 1, "NONE")], true),
      feedbackPage("comments", [humanItem("human", 2)]),
    ],
  });
  assert.equal(result.cutoff, feedbackTime(1));
  assert.equal(result.threads.length, 2);
  assert.throws(() => feedback({}, [], { reviews: [feedbackPage("reviews", [], true)] }), /incomplete feedback/);
});

test("outdated unresolved threads retain findings and incomplete pages block readiness", jqOptions, () => {
  const result = feedback({
    threads: [
      feedbackThread("outdated-finding", [humanItem("finding", 1)], { outdated: true }),
      feedbackThread("outdated-incomplete", [humanItem("finding", 1)], { outdated: true, more: true }),
      feedbackThread("active-incomplete", [humanItem("finding", 1)], { more: true }),
      feedbackThread("resolved-incomplete", [humanItem("finding", 1)], { resolved: true, more: true }),
    ],
    comments: [botItem("unknown-history-bot", 1)],
  });
  const rows = new Map(result.threads.slice(2).map((row) => [row.id, row]));
  assert.equal(rows.get("outdated-finding")?.isResolved, false);
  assert.equal(rows.get("outdated-finding")?.isOutdated, true);
  assert.equal(rows.get("outdated-incomplete")?.blocksIncomplete, true);
  assert.equal(rows.get("active-incomplete")?.blocksIncomplete, true);
  assert.equal(rows.get("resolved-incomplete")?.blocksIncomplete, false);
  assert.equal(result.cutoff, "");
  assert.deepEqual(result.comments[1]?.items, []);
});

test("ignored thread nodes leave only counts, without logins, paths, lines or bodies", jqOptions, () => {
  const ignored = { ...humanItem("ignored-body", 1, "NONE"), path: "ignored-path", line: 987654 };
  const human = humanItem("counted", 2);
  const result = feedback({
    threads: [feedbackThread("mixed", [ignored, human]), feedbackThread("ignored-thread", [ignored])],
  });
  assert.equal(result.threads[1]?.ignoredComments, 2);
  assert.equal(result.threads[1]?.ignoredThreads, 1);
  for (const marker of ["ignored-login", "ignored-path", "987654", "ignored-body", "ignored-thread"])
    assert.equal(JSON.stringify(result).includes(marker), false);
  const row = result.threads[2];
  assert.ok(row);
  assert.deepEqual((row.comments as { nodes: FeedbackItem[] }).nodes, [human]);
});

test("unknown feedback times exclude bots rather than assuming an order", jqOptions, () => {
  for (const time of [null, "invalid"]) {
    const result = feedback({
      comments: [{ ...humanItem("ignored", 1, "NONE"), createdAt: time }],
      reviews: [botItem("bot", 2)],
    });
    assert.equal(result.cutoff, "");
    assert.deepEqual(result.reviews[1]?.items, []);
  }
});

test("loop survey reports the unfiltered count even when every PR is filtered out", jqOptions, () => {
  const text = readFileSync(new URL("../../../.claude/loop.md", import.meta.url), "utf8");
  const listing = /`(gh pr list [^`]+)`/u.exec(text)?.[1];
  assert.ok(listing, "loop.md must contain its PR listing command");
  assert.doesNotMatch(listing, /(?:^|\s)--(?:search|author)(?:[=\s]|$)/u);
  const filter = /--jq '([^']+)'/.exec(listing)?.[1] as string;
  const prs = Array.from({ length: 100 }, () => ({ author: { login: "outsider" }, isCrossRepository: false }));
  assert.deepEqual(jq(filter, prs), [{ fetched: 100, items: [] }]);
});

test("branch fixtures project headRefOid only when the query requests it", () =>
  scenario(({ env, repo }) => {
    const head = "a".repeat(40);
    installFake(
      env,
      "gh",
      branchPrRules([{ number: 7, state: "OPEN", headRefName: BRANCH, headRefOid: head }], BRANCH),
    );
    assert.equal(prForBranch(repo, BRANCH)?.data.headRefOid, undefined);
    assert.equal(prForBranch(repo, BRANCH, ["OPEN"], ["headRefOid"])?.data.headRefOid, head);
  }));

test("oneLine refuses every C1 control and Unicode line separator in subjects", () => {
  for (const code of [...Array.from({ length: 32 }, (_, i) => 0x80 + i), 0x2028, 0x2029]) {
    const char = String.fromCodePoint(code);
    for (const text of [`fix: a${char}b`, `fix: a${char}`]) {
      assert.throws(() => oneLine(text, "subject"), WtError, `U+${code.toString(16)}`);
    }
  }
});

test("oneLine refuses bidi and other Unicode format characters", () => {
  for (const code of [
    0xad, 0x61c, 0x200b, 0x200c, 0x200d, 0x200e, 0x200f, 0x202e, 0x2066, 0x2067, 0x2068, 0x2069, 0xfeff, 0xe0001,
  ]) {
    assert.throws(() => oneLine(`fix: a${String.fromCodePoint(code)}b`, "subject"), WtError, `U+${code.toString(16)}`);
  }
});

for (const reference of ["&#32;", "&nbsp;", "&#x20;", "&Tab;", "&NewLine;", "&#133;", "&ensp;", "&emsp;", "&thinsp;"]) {
  test(`closing guard decodes whitespace reference ${reference}`, () =>
    closingScenario((repo) => {
      for (const text of [`Fixes${reference}#57`, `Fixes #${reference}57`, `Closes #42${reference}#57`]) {
        assert.throws(() => closingGuard(repo, "emend-42-fix-pane", `Closes #42\n${text}`), WtError, text);
      }
      assert.doesNotThrow(() => closingGuard(repo, "emend-42-fix-pane", `Closes${reference}#42`));
    }));
}

test("closing guard decodes decimal and hexadecimal references for every Unicode whitespace", () =>
  closingScenario((repo) => {
    const spaces =
      "\t\n\v\f\r \u0085\u00a0\u1680\u2000\u2001\u2002\u2003\u2004\u2005\u2006\u2007\u2008\u2009\u200a\u2028\u2029\u202f\u205f\u3000";
    for (const space of spaces) {
      const code = space.codePointAt(0) as number;
      for (const reference of [`&#${code};`, `&#x${code.toString(16)};`, `&#X0${code.toString(16)};`]) {
        assert.throws(
          () => closingGuard(repo, "emend-42-fix-pane", `Closes #42\nFixes${reference}#57`),
          WtError,
          reference,
        );
        assert.doesNotThrow(() => closingGuard(repo, "emend-42-fix-pane", `Closes${reference}#42`), reference);
      }
    }
    for (const text of [
      "Ordinary &#1114112; text\nCloses #42",
      "Ordinary &#999999999999999999999999; text\nCloses #42",
      "Ordinary &#xD800; text\nCloses #42",
    ]) {
      assert.doesNotThrow(() => closingGuard(repo, "emend-42-fix-pane", text));
    }
  }));

test("PR create pins the origin repository in the gh arguments", () =>
  scenario((ctx) => {
    installFake(ctx.env, "gh", createRules("https://github.com/owner/repo/pull/7"));
    prCreate(ctx.repo, { title: "Fix pane", body: "Description", draft: false });
    const args = fakeCalls(ctx.env, "gh").find((args) => args[1] === "create") as string[];
    assert.ok(args.includes("--repo"));
    assert.equal(args[args.indexOf("--repo") + 1], "github.com/owner/repo");
  }));

test("PR view, edit, merge and read-back pin the origin repository", () =>
  mscenario((ctx) => {
    installFake(ctx.env, "gh", [
      ...mergeOkRules(),
      {
        match: ["pr", "view", "7"],
        stdout: JSON.stringify({
          number: 7,
          state: "OPEN",
          baseRefName: "main",
          headRefName: BRANCH,
          isCrossRepository: false,
          title: "Fix pane",
          body: "Description",
        }),
      },
      { match: ["pr", "edit", "7"], stdout: "edited" },
    ]);
    prEdit(ctx.repo, { pr: "7", title: "Fix pane" });
    prMerge(ctx.repo, MERGE_ARGS);
    const calls = fakeCalls(ctx.env, "gh").filter((args) => args[0] === "pr");
    assert.equal(calls.length, 5);
    for (const args of calls) {
      assert.ok(args.includes("--repo"), args.join(" "));
      assert.equal(args[args.indexOf("--repo") + 1], "github.com/owner/repo");
    }
  }));

test("gitTry forwards a timeout through the hardened git arguments", (t) => {
  const spy = t.mock.method(
    childProcess,
    "spawnSync",
    (_command: string, args: string[], options: SpawnSyncOptions) => {
      assert.equal(_command, "git");
      assert.deepEqual(args, [...GIT_BASE, "ls-remote", "--quiet", "--", "origin", `refs/heads/${BRANCH}`]);
      assert.equal(options.timeout, 5000);
      return {
        status: null,
        error: Object.assign(new Error("synthetic timeout"), { code: "ETIMEDOUT" }),
        stdout: "",
        stderr: "",
      };
    },
  );
  syncBuiltinESMExports();
  try {
    closingScenario((repo) => {
      assert.equal(
        gitTry(repo, ["ls-remote", "--quiet", "--", "origin", `refs/heads/${BRANCH}`], { timeoutMs: 5000 }).code,
        124,
      );
    });
  } finally {
    spy.mock.restore();
    syncBuiltinESMExports();
  }
});

test("remote lookup timeout still attempts the leased delete after merging", (t) =>
  mscenario((ctx) => {
    installFake(ctx.env, "gh", mergeOkRules());
    const original = childProcess.spawnSync;
    let advertised = false;
    let deleted = false;
    const spy = t.mock.method(
      childProcess,
      "spawnSync",
      (command: string, args: string[], options: SpawnSyncOptions) => {
        if (command === "git" && args.includes("ls-remote")) {
          advertised = true;
          assert.equal(options.timeout, 5000);
          return {
            status: null,
            error: Object.assign(new Error("synthetic timeout"), { code: "ETIMEDOUT" }),
            stdout: "",
            stderr: "",
          };
        }
        if (command === "git" && args.includes("--delete")) {
          deleted = true;
          assert.ok(args.includes(`--force-with-lease=refs/heads/${BRANCH}:${headSha}`));
          return { status: 0, stdout: "", stderr: "" };
        }
        return original(command, args, options);
      },
    );
    syncBuiltinESMExports();
    try {
      assert.equal(prMerge(ctx.repo, MERGE_ARGS), `MERGED ${MERGE_SHA}`);
      assert.ok(advertised && deleted);
    } finally {
      spy.mock.restore();
      syncBuiltinESMExports();
    }
  }));

for (const [name, body] of [
  ["keyword prefix", "Closes #42\nFixes\u0085#57"],
  ["reference chain", "Closes #42\u0085#57"],
  ["spaced reference", "Closes #42\nFixes #\u008557"],
  ["anchor spacing", 'Closes #42\nFixes <a\u0085href="#57">issue</a>'],
] as const) {
  test(`closing guard refuses NEL in ${name}`, () =>
    closingScenario((repo) => {
      assert.throws(() => closingGuard(repo, "emend-42-fix-pane", body), WtError);
    }));
}

test("closing guard treats every Unicode White_Space character as a space", () =>
  closingScenario((repo) => {
    const spaces =
      "\t\n\v\f\r \u0085\u00a0\u1680\u2000\u2001\u2002\u2003\u2004\u2005\u2006\u2007\u2008\u2009\u200a\u2028\u2029\u202f\u205f\u3000";
    for (const space of spaces) {
      const label = `U+${space.codePointAt(0)?.toString(16)}`;
      assert.doesNotThrow(() => closingGuard(repo, "emend-42-fix-pane", `Closes${space}#42`), label);
      assert.doesNotThrow(() => closingGuard(repo, "emend-42-fix-pane", `Closes [${space}#42${space}](#42)`), label);
      assert.throws(() => closingGuard(repo, BRANCH, `Fixes${space}#57`), WtError, label);
      assert.throws(() => closingGuard(repo, "emend-42-fix-pane", `Closes #42${space}#57`), WtError, label);
    }
  }));

test("pr create refuses a URL from another repository before confirming its number", () =>
  scenario((ctx) => {
    for (const repository of ["other/repo", "owner/other"]) {
      installFake(ctx.env, "gh", createRules(`https://github.com/${repository}/pull/7`));
      assert.throws(
        () => prCreate(ctx.repo, { title: "Fix pane", body: "Description", draft: false }),
        (error: unknown) => error instanceof WtError && /repository/i.test(error.message),
      );
      assert.equal(fakeCalls(ctx.env, "gh").filter((args) => args.includes(`head=${BRANCH}`)).length, 1);
      assert.ok(!fakeCalls(ctx.env, "gh").some((args) => args.includes("number=7")));
    }
  }));

test("pr create accepts a repository URL with different letter case", () =>
  scenario((ctx) => {
    const url = "https://github.com/Owner/Repo/pull/7";
    installFake(ctx.env, "gh", createRules(url));
    assert.equal(prCreate(ctx.repo, { title: "Fix pane", body: "Description", draft: false }), url);
  }));

test("pr number and direct branch lookup gate names before sending them", () =>
  scenario(({ env, repo }) => {
    const branch = "unused-synthetic-term";
    installFake(env, "gh", [{ stdout: branchPrPage([]) }]);
    for (const call of [
      () => prForBranch(repo, branch),
      () => commands.pr?.({ repo, args: ["number", "--branch", branch] }),
    ]) {
      assert.throws(call, (error: unknown) => error instanceof WtError && /private term/.test(error.message));
    }
    assert.deepEqual(fakeCalls(env, "gh"), []);
  }));

test("pr number refuses a missing terms list before looking up origin", () =>
  scenario(({ env, fx, repo }) => {
    installFake(env, "gh", [{ stdout: branchPrPage([]) }]);
    assert.throws(
      () => commands.pr?.({ repo: { ...repo, mainRoot: fx.origin }, args: ["number", "--branch", BRANCH] }),
      (error: unknown) => error instanceof WtError && /private terms list required/.test(error.message),
    );
    assert.deepEqual(fakeCalls(env, "gh"), []);
  }));

test("pr merge skips remote deletion silently when GitHub already removed the branch", (t) =>
  mscenario((ctx) => {
    installFake(ctx.env, "gh", mergeOkRules());
    assert.equal(remoteHas(ctx), false);
    const git = join(ctx.env.fakeBin, "git");
    const realGit = realpathSync(git);
    rmSync(git);
    installFake(ctx.env, "git", []);
    writeFileSync(
      git,
      `#!${process.execPath}
const fs = require("node:fs");
const { spawnSync } = require("node:child_process");
const args = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(join(ctx.env.fakeBin, ".git.log"))}, JSON.stringify(args) + "\\n");
if (args.includes("--delete")) { process.stderr.write("remote ref deletion refused\\n"); process.exit(1); }
const r = spawnSync(${JSON.stringify(realGit)}, args, { stdio: "inherit" });
process.exit(r.status ?? 1);
`,
    );
    const lines: string[] = [];
    t.mock.method(process.stderr, "write", (chunk: string | Uint8Array) => {
      lines.push(String(chunk));
      return true;
    });
    assert.equal(prMerge(ctx.repo, MERGE_ARGS), `MERGED ${MERGE_SHA}`);
    assert.deepEqual(lines, []);
    const calls = fakeCalls(ctx.env, "git");
    assert.ok(calls.some((args) => args.includes("ls-remote") && args.includes(`refs/heads/${BRANCH}`)));
    assert.ok(!calls.some((args) => args.includes("--delete")));
  }));

test("list selects the local tip PR, then the newest open PR, then the newest number", () =>
  worktreeScenario(({ repo, fx, env }) => {
    const branch = "feat-reused";
    const wt = newWorktree(repo, branch);
    const head = commitFile(wt.path, "change.txt", "current work\n");
    fakeGithubOrigin(env, fx);
    const pr = (number: number, state: string, headRefOid = "a".repeat(40)) => ({
      number,
      state,
      headRefName: branch,
      headRefOid,
    });
    for (const [nodes, expected] of [
      [[pr(30, "CLOSED"), pr(10, "MERGED", head), pr(20, "OPEN")], { number: 10, state: "MERGED" }],
      [[pr(30, "CLOSED"), pr(10, "OPEN"), pr(20, "OPEN")], { number: 20, state: "OPEN" }],
      [[pr(20, "CLOSED"), pr(10, "MERGED")], { number: 20, state: "CLOSED" }],
    ] as const) {
      installFake(env, "gh", branchPrRules([...nodes], branch));
      assert.deepEqual(list(repo)[0]?.pr, expected);
    }
  }));

test("cleanup accepts reused branches only at an exact merged PR head", () =>
  worktreeScenario(({ repo, fx, env }) => {
    const branch = "feat-reused";
    const wt = newWorktree(repo, branch);
    const head = commitFile(wt.path, "change.txt", "current work\n");
    const newer = gitIn(wt.path, "commit-tree", "HEAD^{tree}", "-p", "HEAD", "-m", "later work");
    gitIn(fx.main, "push", "--quiet", "origin", `${head}:refs/pull/7/head`, `${newer}:refs/pull/8/head`);
    fakeGithubOrigin(env, fx);
    const pr = (number: number, headRefOid: string) => ({ number, state: "MERGED", headRefName: branch, headRefOid });
    installFake(env, "gh", branchPrRules([pr(7, head), pr(8, newer)], branch));
    assert.deepEqual(guard(repo, branch), { ok: true });
    installFake(env, "gh", branchPrRules([pr(8, newer)], branch));
    assert.deepEqual(guard(repo, branch), { ok: false, failed: "unmerged" }, "an ancestor is not the merged head");
    installFake(env, "gh", branchPrRules([pr(7, head), pr(8, newer)], branch));
    cleanup(repo, { target: branch, closeWorkspace: false, discard: false });
    assert.equal(existsSync(wt.path), false);
  }));

for (const missing of [false, true]) {
  test(`list skips private PR lookups with one note (${missing ? "missing terms" : "private name"})`, (t) =>
    worktreeScenario(({ repo, fx, env }) => {
      for (const branch of ["unused-synthetic-term", "unused-synthetic-term-next"]) newWorktree(repo, branch);
      fakeGithubOrigin(env, fx);
      installFake(env, "gh", [{ stdout: branchPrPage([]) }]);
      const lines: string[] = [];
      t.mock.method(process.stderr, "write", (chunk: string | Uint8Array) => {
        lines.push(String(chunk));
        return true;
      });
      const target = missing ? { ...repo, mainRoot: fx.origin } : repo;
      const rows = list(target);
      assert.equal(rows.length, 2);
      assert.ok(rows.every((row) => row.pr === "?"));
      assert.match(formatList(rows), /\?/);
      assert.equal(lines.length, 1);
      assert.match(lines[0] ?? "", /PR lookup skipped/);
      assert.ok(!lines[0]?.includes("unused-synthetic-term"));
      assert.deepEqual(fakeCalls(env, "gh"), []);
      assert.doesNotThrow(() => gc(target, false));
    }));
}

test("cleanup refuses a private branch lookup without sending its name", (t) =>
  worktreeScenario(({ repo, fx, env }) => {
    const branch = "unused-synthetic-term";
    const wt = newWorktree(repo, branch);
    const head = commitFile(wt.path, "change.txt", "work\n");
    gitIn(fx.main, "push", "--quiet", "origin", `${head}:refs/pull/7/head`);
    fakeGithubOrigin(env, fx);
    installFake(
      env,
      "gh",
      branchPrRules([{ number: 7, state: "MERGED", headRefName: branch, headRefOid: head }], branch),
    );
    const lines: string[] = [];
    t.mock.method(process.stderr, "write", (chunk: string | Uint8Array) => {
      lines.push(String(chunk));
      return true;
    });
    assert.deepEqual(guard(repo, branch), { ok: false, failed: "unmerged" });
    assert.deepEqual(fakeCalls(env, "gh"), []);
    assert.equal(lines.length, 1);
    assert.match(lines[0] ?? "", /PR lookup skipped/);
  }));

test("repo command prints origin identity and rejects unsupported origins with 69", () =>
  scenario(async ({ fx }) => {
    const command = new URL("./main.ts", import.meta.url).pathname;
    const invoke = () => runWt(process.execPath, [command, "repo"], { cwd: fx.main });
    assert.deepEqual(await invoke(), { code: 0, stdout: "owner/repo\n", stderr: "" });
    gitIn(fx.main, "remote", "set-url", "origin", "https://example.com/other/repo.git");
    assert.equal((await invoke()).code, 69);
    gitIn(fx.main, "remote", "remove", "origin");
    assert.equal((await invoke()).code, 69);
    const help = await runWt(process.execPath, [command, "--help"], { cwd: fx.main });
    assert.match(help.stdout, /repo +.*origin/);
  }));

test("issue and closing queries use literal origin variables and the github.com host", () =>
  scenario(({ env, repo }) => {
    installFake(env, "gh", issueRules([readyIssue(42)]));
    assert.equal(scanIssues(repo)[0]?.number, 42);
    const issueCalls = fakeCalls(env, "gh").filter((args) => args[0] === "api");
    assert.ok(issueCalls.length > 0);
    for (const args of issueCalls) {
      assert.equal(args[args.indexOf("--hostname") + 1], "github.com");
      assert.ok(args.includes("owner=owner") && args.includes("name=repo"));
    }
    installFake(env, "gh", createRules("https://github.com/owner/repo/pull/7"));
    prCreate(repo, { title: "Fix pane", body: "Description", draft: false });
    const prCalls = fakeCalls(env, "gh").filter((args) => args[0] === "api");
    assert.ok(prCalls.length > 0);
    for (const args of prCalls) {
      assert.equal(args[args.indexOf("--hostname") + 1], "github.com");
      assert.ok(args.includes("owner=owner") && args.includes("name=repo"));
    }
  }));

for (const execute of [run, runBytes]) {
  test(`${execute.name} strips GH_HOST without changing the parent`, () => {
    const previous = process.env.GH_HOST;
    try {
      process.env.GH_HOST = "example.com";
      const result = execute(process.execPath, ["-e", 'process.stdout.write(process.env.GH_HOST ?? "unset")'], {
        cwd: "/",
      });
      assert.equal(result.code, 0);
      assert.equal(result.stdout.toString(), "unset");
      assert.equal(process.env.GH_HOST, "example.com");
    } finally {
      if (previous === undefined) delete process.env.GH_HOST;
      else process.env.GH_HOST = previous;
    }
  });
}

test("merge read-back keeps its pinned identity when origin becomes unreadable", (t) =>
  mscenario((ctx) => {
    installFake(ctx.env, "gh", mergeOkRules());
    const original = childProcess.spawnSync;
    let merged = false;
    let originReadsAfterMerge = 0;
    const spy = t.mock.method(
      childProcess,
      "spawnSync",
      (command: string, args: string[], options: SpawnSyncOptions) => {
        if (merged && command === "git" && args.includes("get-url")) {
          originReadsAfterMerge++;
          return { status: 1, stdout: "", stderr: "synthetic origin failure" };
        }
        if (command === "gh" && args[1] === "merge") merged = true;
        if (merged && command === "gh" && args[1] === "view") {
          assert.equal(args[args.indexOf("--repo") + 1], "github.com/owner/repo");
          return { status: 1, stdout: "", stderr: "synthetic read-back failure" };
        }
        return original(command, args, options);
      },
    );
    syncBuiltinESMExports();
    try {
      assert.throws(() => prMerge(ctx.repo, MERGE_ARGS), /merge may have happened/);
      assert.equal(originReadsAfterMerge, 0);
    } finally {
      spy.mock.restore();
      syncBuiltinESMExports();
    }
  }));

for (const multiple of [false, true]) {
  test(`remote delete keeps the branch with ${multiple ? "several push URLs" : "a different push URL"}`, (t) =>
    mscenario((ctx) => {
      gitIn(ctx.fx.main, "push", "--quiet", "origin", BRANCH);
      const other = join(ctx.env.root, "other.git");
      gitIn(ctx.env.root, "clone", "--quiet", "--bare", ctx.fx.origin, other);
      if (multiple) gitIn(ctx.fx.main, "config", "--add", "remote.origin.pushurl", ctx.fx.origin);
      gitIn(ctx.fx.main, "config", "--add", "remote.origin.pushurl", other);
      installFake(ctx.env, "gh", mergeOkRules());
      const lines: string[] = [];
      t.mock.method(process.stderr, "write", (chunk: string | Uint8Array) => {
        lines.push(String(chunk));
        return true;
      });
      assert.equal(prMerge(ctx.repo, MERGE_ARGS), `MERGED ${MERGE_SHA}`);
      assert.ok(remoteHas(ctx));
      assert.ok(gitIn(other, "for-each-ref", `refs/heads/${BRANCH}`));
      assert.equal(lines.length, 1);
      assert.match(lines[0] ?? "", /^remote branch kept: .*push.*fetch/);
    }));
}

for (const body of [
  ...["NonBreakingSpace", "MediumSpace", "hairsp", "numsp", "emsp13", "ThinSpace", "num"].map(
    (name) => `Fixes&${name};#57`,
  ),
  "Fixes&nbsp#57",
  "F&#105;xes #57",
  "Fixes #&#53;&#55;",
  "Fixes&colon; #57",
  "Fixes #42&comma; #57",
]) {
  test(`closing guard refuses encoded closing instruction: ${body}`, () =>
    closingScenario((repo) => {
      assert.throws(() => closingGuard(repo, "emend-42-fix-pane", `Closes #42\n${body}`), WtError);
    }));
}

test("closing references accept numeric and named own-issue text", () =>
  closingScenario((repo) => {
    for (const body of [
      "F&#105;xes #&#52;&#50;",
      "Fixes&#32;#42",
      "Closes&#x20;#42",
      "&#x46;ixes #42",
      "&Copf;loses &num;42",
    ]) {
      assert.doesNotThrow(() => closingGuard(repo, "emend-42-fix-pane", body));
    }
    for (const reference of ["&amp;", "&lt;", "&gt;", "&quot;"]) {
      assert.doesNotThrow(() => closingGuard(repo, "emend-42-fix-pane", `Ordinary ${reference} text\nCloses #42`));
    }
    assert.doesNotThrow(() => closingGuard(repo, BRANCH, "Ordinary &nbsp; text"));
    assert.doesNotThrow(() => closingGuard(repo, "emend-42-fix-pane", "Closes #42\n&Unknown;"));
    assert.doesNotThrow(() => closingGuard(repo, "emend-42-fix-pane", "Closes #42\nFixes &Unknown; #57"));
  }));

for (const body of [
  "Fixed the flaky Q&A test.",
  "Resolves the redirect at https://x.test/a?a=1&b=2",
  "Fixes AT&T parsing",
]) {
  test(`ordinary ampersands remain prose: ${body}`, () =>
    closingScenario((repo) => {
      assert.doesNotThrow(() => closingGuard(repo, BRANCH, body));
      assert.doesNotThrow(() => closingGuard(repo, "emend-42-fix-pane", `Closes #42\n${body}`));
    }));
}

for (const name of ["123", "true", "null"]) {
  test(`GraphQL repository variables stay strings for ${name}`, (t) =>
    scenario(({ env, repo }) => {
      const identity = `owner/${name}`;
      const empty = { nodes: [], pageInfo: { hasNextPage: false } };
      installFake(env, "gh", [
        {
          match: ["api", "graphql"],
          stdout: githubPage(
            { issues: empty, pullRequests: empty, pullRequest: { closingIssuesReferences: empty } },
            identity,
          ),
        },
        {
          match: ["pr", "view"],
          stdout: JSON.stringify({
            number: 7,
            state: "OPEN",
            baseRefName: "main",
            headRefName: BRANCH,
            isCrossRepository: false,
            title: "Fix pane",
            body: "Description",
          }),
        },
        { match: ["pr", "edit"], stdout: "changed" },
      ]);
      const original = childProcess.spawnSync;
      const spy = t.mock.method(
        childProcess,
        "spawnSync",
        (command: string, args: string[], options: SpawnSyncOptions) => {
          if (command === "git" && args.includes("get-url"))
            return { status: 0, stdout: `https://github.com/${identity}.git`, stderr: "" };
          if (command === "gh" && args[0] === "api")
            for (const variable of ["owner=owner", `name=${name}`])
              assert.equal(args[args.indexOf(variable) - 1], "-f");
          return original(command, args, options);
        },
      );
      syncBuiltinESMExports();
      try {
        assert.deepEqual(scanIssues(repo), []);
        assert.equal(prEdit(repo, { pr: "7", title: "Fix pane" }), "changed");
      } finally {
        spy.mock.restore();
        syncBuiltinESMExports();
      }
    }));
}

test("remote deletion keeps the branch when origin changes after merge", (t) =>
  mscenario((ctx) => {
    gitIn(ctx.fx.main, "push", "--quiet", "origin", BRANCH);
    installFake(ctx.env, "gh", mergeOkRules());
    const original = childProcess.spawnSync;
    let merged = false;
    let deleted = false;
    const lines: string[] = [];
    t.mock.method(process.stderr, "write", (chunk: string | Uint8Array) => {
      lines.push(String(chunk));
      return true;
    });
    const spy = t.mock.method(
      childProcess,
      "spawnSync",
      (command: string, args: string[], options: SpawnSyncOptions) => {
        if (command === "gh" && args[1] === "merge") merged = true;
        if (merged && command === "git" && args.includes("get-url"))
          return { status: 0, stdout: "https://github.com/other/repo.git\n", stderr: "" };
        if (command === "git" && args.includes("--delete")) deleted = true;
        return original(command, args, options);
      },
    );
    syncBuiltinESMExports();
    try {
      assert.equal(prMerge(ctx.repo, MERGE_ARGS), `MERGED ${MERGE_SHA}`);
      assert.equal(deleted, false);
      assert.ok(remoteHas(ctx));
      assert.equal(lines.length, 1);
      assert.match(lines[0] ?? "", /remote branch kept: .*repository/);
    } finally {
      spy.mock.restore();
      syncBuiltinESMExports();
    }
  }));

test("oneLine distinguishes invisible formatting from line breaks", () => {
  assert.throws(() => oneLine("fix: a\u202eb", "subject"), {
    message: "The subject must not contain invisible formatting characters.",
  });
  assert.throws(() => oneLine("fix: a\nb", "subject"), { message: "The subject must be a single line." });
});

test("CommonMark own-issue references require a semicolon and bounded digits; HTML still warns", () =>
  closingScenario((repo) => {
    for (const reference of ["&#32", "&#x20", "&#00000032;", "&#x0000020;"]) {
      assert.throws(() => closingGuard(repo, "emend-42-fix-pane", `Closes${reference}#42`), /must close issue/);
      assert.throws(() => closingGuard(repo, "emend-42-fix-pane", `Closes #42\nFixes${reference}#57`), {
        code: 2,
      });
    }
    for (const reference of ["&#0000032;", "&#x000020;"])
      assert.doesNotThrow(() => closingGuard(repo, "emend-42-fix-pane", `Closes${reference}#42`));
    assert.throws(() => closingGuard(repo, BRANCH, `text${"&#769;".repeat(33)}`), /combining marks/);
  }));

for (const reference of ["&NonBreakingSpace;", "&colon;", "&nbsp", "&nbsp;"]) {
  test(`named closing references fail closed: ${reference}`, () =>
    closingScenario((repo) => {
      assert.throws(() => closingGuard(repo, "emend-42-fix-pane", `Closes #42\nFixes${reference}#57`), WtError);
    }));
}

for (const description of [
  "Use &copy; in the footer.",
  "Document `&nbsp;` in the guide.",
  "Closes the guide example.\nUse &copy; beside #57 in its footer.",
  "Closes the guide example.\r\nUse &copy; beside #57 in its footer.",
  "Closes the guide example.\u2028Use &copy; beside #57 in its footer.",
  "Use &copy; before the instruction. Closes #42",
  "Closes #42 and documents &copy; afterward.",
  "```c\nint c = a&b;\n```",
  "Use `x&y;` in the example.",
  "AT&T; Q&A; R&D;",
  "fix(ui): render &copy; in footer (#42)",
  "Fixes escaping of &lt;b&gt; and &hellip; (#7)",
  "Fixes escaping of x&y; (#7)",
  "Fixes x &copy; (#7)",
  "Fixes [plain label](docs) then &copy; (#7)",
  "Use &copy; beside #42.",
  "left&copy;",
  "&copy;9",
  "Closes #42 and documents left&copy; afterward.",
  "Use &copy;9. Closes #42",
  "Fixes &copy; prose",
  "Fixes **[plain label with &copy;]**",
  'Fixes [plain](destination "label &copy;")',
  "a&fix; b&mask;",
]) {
  test(`named references away from closing instructions remain prose: ${description}`, () =>
    closingScenario((repo) => {
      assert.doesNotThrow(() => closingGuard(repo, "emend-42-fix-pane", `Closes #42\n\n${description}`));
    }));
}

for (const text of [
  "&Copf;loses #57",
  "Fixes&colon; #57",
  "Fixes&NonBreakingSpace;#57",
  "Fixes &NonBreakingSpace; #57",
  "Fixes #57&nbsp",
  "Fixes &NonBreakingSpace; owner/repo#57",
  "Fixes &NonBreakingSpace; https://github.com/owner/repo/issues/57",
  "Fixes &NonBreakingSpace; github.com/owner/repo/issues/57",
  "Fixes &NonBreakingSpace; GH-57",
  "Fixes &NonBreakingSpace; #\u200357",
  "Fi**xes** &NonBreakingSpace; #57",
  "F&#105;xes &NonBreakingSpace; #57",
  "Fixes &num;57",
  "Fixes &num;&#53;7",
  "Fixes&num;57",
  "Fixes Owner&sol;Repo#57",
  "Fixes GH&hyphen;57",
  "Fixes https:&sol;&sol;github.com/Owner/Repo/issues/57",
  "Fixes https://github&period;com/Owner/Repo/issues/57",
  "Fixes [see this](https:&sol;&sol;github.com/Owner/Repo/issues/57)",
  "Fixes <https:&sol;&sol;github.com/Owner/Repo/issues/57>",
  "Fixes **&num;57**",
  "&Copf;loses &num;57",
  "Fixes (Owner&sol;Repo#57)",
  "Fixes\n&num;57",
  "Fixes&#10;&num;57",
  "Closes #42 &comma; #57",
  "Fixes&NewLine;&num;57",
  "Fixes &#x23;57",
  "Fixes&nbsp;#57",
  "Fi**xes**&nbsp#57",
  "Fixes&nbsp#&nbsp57",
]) {
  test(`named references at a closing instruction fail closed: ${text}`, (t) => {
    // Qualified operands must reach the closing check, not fail on a missing fixture origin.
    const origin = t.mock.method(childProcess, "spawnSync", (command: string, args: string[]) => {
      assert.equal(command, "git");
      assert.deepEqual(args, [...GIT_BASE, "remote", "get-url", "origin"]);
      return { status: 0, stdout: "https://github.com/owner/repo.git\n", stderr: "" };
    });
    syncBuiltinESMExports();
    try {
      closingScenario((repo) => {
        for (const requireOwn of [false, true]) {
          const body = requireOwn ? `Closes #42\n${text}` : text;
          assert.throws(
            () => closingGuard(repo, "emend-42-fix-pane", body, requireOwn),
            (error: unknown) => error instanceof WtError && error.code === 2,
          );
        }
      });
    } finally {
      origin.mock.restore();
      syncBuiltinESMExports();
    }
  });
}

test("remote deletion explains a non-GitHub push destination without disclosing it", (t) =>
  mscenario((ctx) => {
    gitIn(ctx.fx.main, "push", "--quiet", "origin", BRANCH);
    installFake(ctx.env, "gh", mergeOkRules());
    const original = childProcess.spawnSync;
    let merged = false;
    let deleted = false;
    const lines: string[] = [];
    t.mock.method(process.stderr, "write", (chunk: string | Uint8Array) => {
      lines.push(String(chunk));
      return true;
    });
    const spy = t.mock.method(
      childProcess,
      "spawnSync",
      (command: string, args: string[], options: SpawnSyncOptions) => {
        if (command === "gh" && args[1] === "merge") merged = true;
        if (merged && command === "git" && args.includes("get-url"))
          return { status: 0, stdout: "https://example.com/other/repo.git\n", stderr: "" };
        if (command === "git" && args.includes("--delete")) deleted = true;
        return original(command, args, options);
      },
    );
    syncBuiltinESMExports();
    try {
      assert.equal(prMerge(ctx.repo, MERGE_ARGS), `MERGED ${MERGE_SHA}`);
      assert.equal(deleted, false);
      assert.ok(remoteHas(ctx));
      assert.deepEqual(lines, ["remote branch kept: origin's push destination is not a GitHub repository\n"]);
    } finally {
      spy.mock.restore();
      syncBuiltinESMExports();
    }
  }));

for (const text of [
  "Cl**oses** #57",
  "Closes <span>#57</span>",
  "Closes [#57](https://x.test)",
  "Clos_es_ #57",
  "Closes `#57`",
  "Cl~~oses~~ #57",
  "Cl`oses` #57",
  "Cl[os](https://x.test/a(b))es #57",
  "Cl[os](https://x.test/a\\)b)es #57",
  'Closes <span title="a>b">#57</span>',
  "Cl**oses** &#35;57",
  "Fi[xe][tag]s #57\n\n[tag]: https://example.com",
  "Fi[xe][]s #57\n\n[xe]: https://example.com",
  "Fixes\n[tag]: https://example.com\n#57",
  "Fixes\n  [tag]: https://example.com\n&num;57",
]) {
  test(`third reading removes inline markup: ${text}`, () =>
    closingScenario((repo) => {
      assert.throws(() => closingGuard(repo, "emend-42-fix-pane", `Closes #42\n${text}`), WtError);
    }));
}

for (const length of [32_000, 320_000]) {
  test(`closing scans handle ${length} hashes without retrying each suffix`, (t) =>
    closingScenario((repo) => {
      const hashes = "#".repeat(length);
      const body = `Closes #42\n\n${hashes}`;
      const start = performance.now();
      assert.doesNotThrow(() => closingGuard(repo, "emend-42-fix-pane", body));
      t.diagnostic(`${length} hashes: ${(performance.now() - start).toFixed(2)} ms`);
      for (const attack of [`${body}\nFixes #57`, `Closes #42\n\nFixes ${hashes}57`])
        assert.throws(() => closingGuard(repo, "emend-42-fix-pane", attack), { code: 2 });
    }));
}

for (const text of [
  'Fi<span title="&QUOT;">x</span>es #57',
  "Fi[x](https://example.com/a&lpar;b)es #57",
  "Fi<!-- > -->xes #57",
  "Fi<!-- > --><!-- > -->xes #57",
  "<div>Fixes&#32#57</div>",
  "<div>Fixes&#00000032;#57</div>",
  "<div>Fixes&#x0000020#57</div>",
  "[Fi][xes] #57",
  "[Fi][x&#101;s] #57",
  "[Fi][xes]&nbsp#57",
  "[tag]: Fi**xes** #57",
  "Paragraph\n[tag]: Fi**xes** #57",
  '[tag]: Fi<span title="&QUOT;">x</span>es #57',
  "Fixes `&num;57`",
  "Fixes &lt;tag&gt; #57",
]) {
  test(`cheap markup readings refuse a foreign closing instruction: ${text}`, () =>
    closingScenario((repo) => {
      for (const requireOwn of [true, false])
        assert.throws(
          () => closingGuard(repo, "emend-42-fix-pane", requireOwn ? `Closes #42\n\n${text}` : text, requireOwn),
          (error: unknown) => error instanceof WtError && error.code === 2,
        );
    }));
}

test("cheap markup readings tolerate long unterminated HTML comments", () =>
  closingScenario((repo) => {
    const comments = "<!-- > ".repeat(8_000);
    assert.doesNotThrow(() => closingGuard(repo, "emend-42-fix-pane", `Closes #42\n${comments}`));
    assert.throws(() => closingGuard(repo, "emend-42-fix-pane", `Closes #42\n${comments} Fixes #57`), { code: 2 });
  }));
