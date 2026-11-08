import assert from "node:assert/strict";
import childProcess from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mock, test } from "node:test";
import { closingGuard, commands as githubCommands, prCreate, prEdit, prMerge } from "./github.ts";
import { spawn, writeIssueSnapshot } from "./herdr.ts";
import { commands as historyCommands } from "./history.ts";
import { checkIssue, commands, evaluateIssue, issueSnapshotText, pickIssue, scanIssues, sha256 } from "./issues.ts";
import { registryPath } from "./registry.ts";
import { GIT_BASE, type Repo } from "./repo.ts";
import { githubPage, issueEvent, prPage, READY_AT, READY_LABEL, readyIssue } from "./test-support.ts";
import { WtError } from "./validate.ts";
import { setup, commands as worktreeCommands } from "./worktree.ts";

type Reply = { status?: number; stdout?: string; stderr?: string };
type Call = { command: string; args: string[]; input?: string };

/** Replace only the subprocess boundary; exercise the real commands, validators and snapshot files. */
async function boundary(
  fn: (ctx: {
    repo: Repo;
    calls: Call[];
    state: {
      issue: Record<string, unknown> | null;
      versions: { editedAt: string; editor: { login: string } }[] | null;
      unavailable: boolean;
      taken: boolean;
      pr: boolean;
      prTitle: string;
      prBody: string;
      prBranch: string;
      mergeView: Record<string, unknown>;
      extraPrs: Record<string, unknown>[];
      closing: Reply | null;
      closingReplies: Reply[];
      merged: boolean;
      label: unknown;
      queue: Record<string, unknown>[] | null;
      branches: string[] | null;
      claimPrs: Parameters<typeof prPage>[0];
      remoteBranches: string[];
      brokenPrPage: boolean;
      staleList: boolean;
      hideCreated: boolean;
      createOutput: string;
      prState: string;
      changeBody: string | null;
      lookupFailure: Reply | null;
    };
  }) => void | Promise<void>,
) {
  const top = mkdtempSync(join(tmpdir(), "wt-issue-boundary-"));
  const repo: Repo = {
    mainRoot: top,
    callerTop: top,
    callerBranch: "emend-42-fix",
    commonDir: join(top, ".git"),
    worktreesDir: join(top, "worktrees"),
  };
  writeFileSync(join(top, ".private-terms"), "unused-synthetic-term\n");
  mkdirSync(join(top, ".wt"));
  writeFileSync(join(top, ".wt/worktree.json"), JSON.stringify({ issue: 42 }));
  const calls: Call[] = [];
  const state = {
    issue: readyIssue(42) as Record<string, unknown> | null,
    versions: null as { editedAt: string; editor: { login: string } }[] | null,
    unavailable: false,
    taken: false,
    pr: true,
    label: READY_LABEL as unknown,
    prTitle: "Fix pane",
    prBody: "Closes #42",
    prBranch: "emend-42-fix",
    mergeView: {} as Record<string, unknown>,
    extraPrs: [] as Record<string, unknown>[],
    closing: null as Reply | null,
    closingReplies: [] as Reply[],
    merged: false,
    queue: null as Record<string, unknown>[] | null,
    branches: null as string[] | null,
    claimPrs: [] as Parameters<typeof prPage>[0],
    remoteBranches: [] as string[],
    brokenPrPage: false,
    staleList: false,
    hideCreated: false,
    createOutput: "https://github.com/Owner/Repo/pull/7\n",
    prState: "OPEN",
    changeBody: null as string | null,
    lookupFailure: null as Reply | null,
  };
  const reply = (command: string, args: string[]): Reply => {
    if (command === "git") {
      if (args.includes("config") && args.includes("--show-scope")) return { stdout: "global\tSynthetic User" };
      if (args.includes("symbolic-ref")) return { stdout: repo.callerBranch ?? "" };
      if (args.includes("HEAD^{commit}")) return { stdout: "a".repeat(40) };
      if (args.includes("merge-base")) return { stdout: "b".repeat(40) };
      if (args.includes("diff-tree"))
        return {
          stdout:
            state.changeBody === null ? "" : `:100644 100644 ${"d".repeat(40)} ${"c".repeat(40)} M\0synthetic.txt\0`,
        };
      if (args.includes("cat-file")) return { stdout: args.includes("-t") ? "commit" : (state.changeBody ?? "") };
      if (args.includes("get-url")) return { stdout: "https://github.com/Owner/Repo.git\n" };
      if (args.includes("for-each-ref"))
        return {
          stdout:
            state.branches?.map((b) => `refs/heads/${b}`).join("\n") ??
            (state.taken ? "refs/heads/emend-42-other\n" : ""),
        };
      if (args.includes("ls-remote"))
        return { stdout: state.remoteBranches.map((branch) => `${"a".repeat(40)}\trefs/heads/${branch}`).join("\n") };
      if (args.includes("fetch")) return {};
      if (args.includes("refs/wt-pr-merge/7")) return { stdout: "a".repeat(40) };
      if (args.includes("rev-parse")) return { status: 1 };
    }
    if (command === "gh") {
      if (state.unavailable) return { status: 1, stderr: "network is unreachable" };
      const query = args.find((arg) => arg.startsWith("query="));
      if (query) {
        const variable = (key: string) => args.find((arg) => arg.startsWith(`${key}=`))?.slice(key.length + 1);
        if (`${variable("owner")}/${variable("name")}`.toLowerCase() !== "owner/repo")
          return { status: 1, stderr: "synthetic repository variable mismatch" };
      }
      if (query?.includes("pullRequest(number:"))
        return state.closingReplies.shift() ?? state.closing ?? { stdout: closingResponse() };
      if (query?.includes("pullRequests(states:")) return { stdout: prPage(state.claimPrs) };
      let issue = state.issue;
      if (issue && state.versions && query) {
        const newest = query.includes("userContentEdits(first: 50)");
        issue = {
          ...issue,
          userContentEdits: {
            nodes: newest ? state.versions.slice(0, 50) : state.versions.slice(-50),
            pageInfo: { [newest ? "hasNextPage" : "hasPreviousPage"]: state.versions.length > 50 },
          },
        };
      }
      if (query?.includes("issues(states:"))
        return {
          stdout: githubPage({
            label: state.label,
            issues: { nodes: state.queue ?? (issue ? [issue] : []), pageInfo: { hasNextPage: false } },
          }),
        };
      if (query?.includes("issue(number:")) return { stdout: githubPage({ issue, label: state.label }) };
      if (args.includes("state,mergeCommit"))
        return {
          stdout: JSON.stringify(
            state.merged
              ? { state: "MERGED", mergeCommit: { oid: "c".repeat(40) } }
              : { state: "OPEN", mergeCommit: null },
          ),
        };
      const ownPr = {
        number: 7,
        state: state.prState,
        baseRefName: "main",
        headRefName: state.prBranch,
        isCrossRepository: false,
        headRefOid: "a".repeat(40),
        title: state.prTitle,
        body: state.prBody,
      };
      const prs: Record<string, unknown>[] = [...state.extraPrs, ...(state.pr ? [ownPr] : [])];
      if (query?.includes("pullRequests(headRefName:")) {
        if (state.lookupFailure) return state.lookupFailure;
        const cursor = args.find((a) => a.startsWith("cursor="))?.slice(7);
        const at = cursor === undefined ? 0 : Number(cursor);
        const next = at + 100;
        return {
          stdout: JSON.stringify({
            data: {
              viewer: { login: "owner" },
              repository: {
                nameWithOwner: "Owner/Repo",
                pullRequests: {
                  nodes: prs.slice(at, next).map((p) => ({ author: { login: "owner" }, ...p })),
                  pageInfo: {
                    hasNextPage: state.brokenPrPage || next < prs.length,
                    endCursor: !state.brokenPrPage && next < prs.length ? String(next) : null,
                  },
                },
              },
            },
          }),
        };
      }
      if (args[1] === "list")
        return {
          stdout: JSON.stringify(
            (state.staleList ? [] : prs)
              .filter(
                (p) => !args.includes("--author") || !p.author || (p.author as { login: string }).login === "owner",
              )
              .slice(0, 100),
          ),
        };
      if (args[1] === "view" && args[2] === state.prBranch && state.extraPrs.length)
        return { stdout: JSON.stringify(state.extraPrs[0]) };
      if (args[1] === "view")
        return state.pr
          ? {
              stdout: JSON.stringify({
                ...ownPr,
                ...(args[2] === "7" ? state.mergeView : {}),
              }),
            }
          : { status: 1, stderr: "no pull requests found" };
      if (args[1] === "create") {
        state.pr = !state.hideCreated;
        return { stdout: state.createOutput };
      }
      if (args[1] === "edit") return { stdout: "changed" };
      if (args[1] === "merge") return {};
    }
    throw new Error(`Unexpected subprocess: ${command} ${args.join(" ")}`);
  };
  const stub = mock.method(
    childProcess,
    "spawnSync",
    (command: string, args: string[], options: { input?: string; encoding?: string }) => {
      calls.push({ command, args, input: options.input });
      const r = reply(command, args);
      const bytes = options.encoding !== "utf8";
      return {
        status: r.status ?? 0,
        stdout: bytes ? Buffer.from(r.stdout ?? "") : (r.stdout ?? ""),
        stderr: bytes ? Buffer.from(r.stderr ?? "") : (r.stderr ?? ""),
      };
    },
  );
  syncBuiltinESMExports();
  try {
    await fn({ repo, calls, state });
  } finally {
    stub.mock.restore();
    syncBuiltinESMExports();
    rmSync(top, { recursive: true, force: true });
  }
}

function exactPrLookup(call: Call): boolean {
  return (
    (call.command === "git" && call.args.slice(-3).join(" ") === "remote get-url origin") ||
    (call.command === "gh" &&
      call.args[0] === "api" &&
      call.args[1] === "graphql" &&
      call.args.some((arg) => arg.startsWith("query=query(") && arg.includes("pullRequests(headRefName:")))
  );
}

function readOnlyPrOrIssue(call: Call): boolean {
  return (
    exactPrLookup(call) ||
    (call.command === "gh" && call.args[1] === "view") ||
    (call.args[0] === "api" &&
      call.args[1] === "graphql" &&
      call.args.some(
        (arg) =>
          arg.startsWith("query=query(") && (arg.includes("issue(number:") || arg.includes("pullRequests(states:")),
      ))
  );
}

function closingResponse(
  nodes: unknown[] = [],
  more = false,
  nameWithOwner = "Owner/Repo",
  fields: Record<string, unknown> = {},
): string {
  return JSON.stringify({
    data: {
      repository: {
        nameWithOwner,
        pullRequest: {
          body: "Description",
          createdAt: "2026-01-01T00:00:00Z",
          lastEditedAt: null,
          closingIssuesReferences: { nodes, pageInfo: { hasNextPage: more } },
          ...fields,
        },
      },
    },
  });
}

const ownClosingIssue = { number: 42, repository: { nameWithOwner: "OWNER/REPO" } };
const closingMismatch = "GitHub's closing issues do not match this branch. Fix the PR body with bin/wt pr edit.";
const unparsedClosingReference =
  "Text after a closing keyword looks like an issue reference. Reword it or close only this branch's issue.";

/** Refusals may inspect the PR and origin; every other subprocess is forbidden. */
function assertReadOnlyPrLookups(calls: Call[]): void {
  for (const { command, args } of calls) {
    if (command === "gh") {
      assert.deepEqual(args.slice(0, 2), ["pr", "view"]);
    } else {
      assert.equal(command, "git");
      assert.deepEqual(args, [...GIT_BASE, "remote", "get-url", "origin"]);
    }
  }
}

for (const [name, headRefName] of [
  ["missing", undefined],
  ["null", null],
  ["number", 42],
  ["object", {}],
  ["empty", ""],
  ["invalid", "emend-42-.."],
] as const) {
  test(`pr merge refuses a ${name} headRefName before closing checks`, () =>
    boundary(({ repo, state, calls }) => {
      state.prBody = "Description";
      state.mergeView = { headRefName };
      for (const pr of [undefined, "7"]) {
        calls.length = 0;
        assert.throws(
          () => prMerge(repo, { pr, matchHead: "a".repeat(40), subject: "T", body: "Body" }),
          (e: unknown) => e instanceof WtError && e.code === 1 && /head branch/.test(e.message),
        );
        assert.ok(calls.every((c) => exactPrLookup(c) || (c.command === "gh" && c.args[1] === "view")));
      }
    }));
}

test("pr merge requires the caller's branch except with --pr from the main checkout", () =>
  boundary(({ repo, state, calls }) => {
    state.prBody = "Description";
    state.mergeView = { headRefName: "emend-task-062-other" };
    const merge = (pr?: string) => prMerge(repo, { pr, matchHead: "a".repeat(40), subject: "T", body: "Body" });
    for (const top of [repo.mainRoot, join(repo.worktreesDir, "emend-42-fix")]) {
      repo.callerTop = top;
      for (const pr of [undefined, "7"]) {
        if (top === repo.mainRoot && pr !== undefined) continue;
        calls.length = 0;
        assert.throws(merge.bind(null, pr), /head branch does not match the caller/);
        assert.ok(calls.every((c) => exactPrLookup(c) || (c.command === "gh" && c.args[1] === "view")));
      }
    }
    state.mergeView = { headRefName: repo.callerBranch };
    state.prBody = "Closes #42";
    state.closing = { stdout: closingResponse([ownClosingIssue]) };
    prepareMergeIssue(repo);
    assert.equal(merge("7"), "QUEUED");
    repo.callerTop = repo.mainRoot;
    repo.callerBranch = "main";
    assert.throws(merge.bind(null, "7"), /Run issue check inside/);
    state.prBody = "Description";
    state.closing = { stdout: closingResponse() };
    assert.throws(merge.bind(null, "7"), /Run issue check inside/);
    state.mergeView = { headRefName: "emend-task-062-other" };
    assert.equal(merge("7"), "QUEUED");
  }));

for (const text of [
  "fix(render): resolve relative [links](a.md) in docs",
  "Summary: fixes `Array<string>` rendering",
  "fix(core): close unclosed <details> blocks",
  "Evidence: resolved the flaky test [see log]",
  "Fixes the bug in [x](y)",
]) {
  test(`closing guard accepts ordinary prose: ${text}`, () =>
    boundary(({ repo }) => {
      closingGuard(repo, "emend-task-062-x", text);
      closingGuard(repo, "emend-42-x", `${text}\n\nCloses #42`);
    }));
}

for (const text of ["Closes [the bug](https://github.com/o/r/issues/7)", "Closes <https://github.com/o/r/issues/7>"]) {
  test(`closing guard refuses a foreign issue link: ${text}`, () =>
    boundary(({ repo }) => {
      assert.throws(() => closingGuard(repo, "emend-task-062-x", text), /only issue branches/i);
      assert.throws(() => closingGuard(repo, "emend-42-x", `Closes #42\n${text}`), /must not close/);
    }));
}

test("closing positions honor keyword boundaries and stop at ordinary prose", () =>
  boundary(({ repo }) => {
    for (const keyword of ["CLOSE", "closes", "Closed", "FIX", "fixes", "Fixed", "RESOLVE", "resolves", "Resolved"]) {
      for (const branch of ["feature", "emend-42-x"]) {
        const prefix = branch === "feature" ? "" : "Closes #42\n";
        for (const token of ["#9", "GH-9", "other/repo#42", "github.com/o/r/issues/9"]) {
          closingGuard(repo, branch, `${prefix}${keyword} see ${token}`);
          assert.throws(
            () => closingGuard(repo, branch, `${prefix}${keyword} \`${token}\``),
            (e: unknown) => e instanceof WtError && e.code === 2 && e.message === unparsedClosingReference,
          );
        }
        for (const token of ["[", "<"]) closingGuard(repo, branch, `${prefix}${keyword} see ${token}`);
      }
    }
    for (const text of [
      "prefixes #9",
      "discloses #9",
      "resolvesx #9",
      "fix2 #9",
      "Fixes see\n#9",
      "Fixes see\r#9",
      "Fixes see\r\n#9",
    ])
      closingGuard(repo, "feature", text);
    closingGuard(repo, "emend-42-x", "Closes #42");
    assert.throws(() => closingGuard(repo, "emend-42-x", "Fixes see #42"), /must close/);
  }));

for (const command of ["create", "edit", "merge"] as const) {
  for (const branch of ["emend-42-x", "feature"]) {
    test(`GitHub closing references gate ${command} on ${branch}`, () =>
      boundary(({ repo, state, calls }) => {
        repo.callerBranch = state.prBranch = branch;
        const issueBranch = branch === "emend-42-x";
        state.prBody = issueBranch ? "Closes #42" : "Description";
        if (command === "merge" && issueBranch) prepareMergeIssue(repo);
        const invoke = () => {
          state.pr = command !== "create";
          calls.length = 0;
          if (command === "create") return prCreate(repo, { title: "T", body: state.prBody, draft: false });
          if (command === "edit") return prEdit(repo, { title: "T" });
          return prMerge(repo, { pr: "7", matchHead: "a".repeat(40), subject: "T", body: "Body" });
        };
        for (const [nodes, more] of [
          [[{ number: 9, repository: { nameWithOwner: "Owner/Repo" } }], false],
          [[{ number: 42, repository: { nameWithOwner: "other/repo" } }], false],
          [[ownClosingIssue, { number: 9, repository: { nameWithOwner: "Owner/Repo" } }], false],
          [[ownClosingIssue], true],
          [[], true],
        ] as const) {
          state.closing = { stdout: closingResponse([...nodes], more) };
          assert.throws(invoke, (e: unknown) => e instanceof WtError && e.code === 1 && e.message === closingMismatch);
          assert.equal(
            calls.some((c) => c.command === "gh" && c.args[1] === command),
            command !== "merge",
          );
        }
        for (const [reply, code] of [
          [{ status: 1, stderr: "network is unreachable" }, 69],
          [{ status: 1, stderr: "GraphQL query failed" }, 1],
          [{ stdout: "not json" }, 1],
          [{ stdout: JSON.stringify({ errors: [{ message: "unavailable" }] }) }, 1],
          [{ stdout: closingResponse([], false, "other/repo") }, 1],
          [{ stdout: closingResponse([null]) }, 1],
          [{ stdout: JSON.stringify({ data: { repository: { nameWithOwner: "Owner/Repo", pullRequest: null } } }) }, 1],
        ] as const) {
          state.closing = reply;
          assert.throws(invoke, (e: unknown) => e instanceof WtError && e.code === code);
          assert.ok(!calls.some((c) => c.command === "gh" && c.args[1] === "merge"));
        }
        for (const nodes of [[], [ownClosingIssue]]) {
          state.closing = { stdout: closingResponse(nodes) };
          const allowed = issueBranch ? command !== "merge" || nodes.length === 1 : nodes.length === 0;
          if (allowed)
            assert.equal(
              invoke(),
              command === "merge" ? "QUEUED" : command === "create" ? state.createOutput : "changed",
            );
          else
            assert.throws(
              invoke,
              (e: unknown) => e instanceof WtError && e.code === 1 && e.message === closingMismatch,
            );
          const query = calls.find(
            (c) => c.command === "gh" && c.args.some((arg) => arg.includes("closingIssuesReferences(first: 20)")),
          );
          assert.ok(query);
          assert.deepEqual(query.args.slice(-8), [
            "-f",
            "owner=owner",
            "-f",
            "name=repo",
            "-F",
            "number=7",
            "--hostname",
            "github.com",
          ]);
          assert.match(query.args.find((a) => a.startsWith("query=")) ?? "", /closingIssuesReferences\(first: 20\)/);
          const queryIndex = calls.indexOf(query);
          const mutation = calls.findIndex((c) => c.command === "gh" && c.args[1] === command);
          if (command !== "merge") assert.ok(mutation >= 0 && mutation < queryIndex);
          else assert.ok(allowed ? mutation > queryIndex : mutation === -1);
        }
      }));
  }
}

async function output(fn: () => unknown): Promise<string> {
  let text = "";
  const stub = mock.method(process.stdout, "write", (chunk: string) => {
    text += chunk;
    return true;
  });
  try {
    await fn();
    return text;
  } finally {
    stub.mock.restore();
  }
}

test("issue show command shares spawn's bytes and pick refusals", () =>
  boundary(async ({ repo, state, calls }) => {
    state.issue = readyIssue(42, {
      title: "  Visible\ttitle ",
      body: "```ts\nconst example = true;\n```",
      bodyText: "Visible\r\ntext",
    });
    const shown = await output(() => commands.issue?.({ repo, args: ["show", "42"] }));
    assert.equal(existsSync(join(repo.mainRoot, ".wt/issue.md")), false);
    assert.equal(existsSync(repo.worktreesDir), false);
    const dir = join(repo.mainRoot, "expected");
    mkdirSync(dir, { recursive: true });
    writeIssueSnapshot(dir, pickIssue(repo, 42));
    assert.equal(shown, readFileSync(join(dir, "issue.md"), "utf8"));
    assert.ok(calls.every((c) => c.command === "gh" || c.command === "git"));
    const before = process.env.HERDR_ENV;
    process.env.HERDR_ENV = "1";
    try {
      for (const status of ["untrusted", "blocked", "taken", "missing", "unavailable"]) {
        state.issue =
          status === "missing"
            ? null
            : readyIssue(
                42,
                status === "untrusted"
                  ? { author: { login: "outsider" } }
                  : status === "blocked"
                    ? { blockedBy: { nodes: [{ number: 9, state: "OPEN" }], pageInfo: { hasNextPage: false } } }
                    : {},
              );
        state.taken = status === "taken";
        state.unavailable = status === "unavailable";
        let refused: WtError | undefined;
        await assert.rejects(
          async () => commands.issue?.({ repo, args: ["show", "42"] }),
          (e: unknown) => {
            assert.ok(e instanceof WtError);
            refused = e;
            assert.equal(e.code, status === "taken" ? 3 : status === "unavailable" ? 69 : 2);
            return true;
          },
        );
        await assert.rejects(
          spawn(repo, { issue: 42, mode: "github" }),
          (e: unknown) => e instanceof WtError && e.code === refused?.code && e.message === refused.message,
        );
      }
    } finally {
      if (before === undefined) delete process.env.HERDR_ENV;
      else process.env.HERDR_ENV = before;
    }
  }));

test("queue, show and check preserve allowed Markdown, bare URLs and attachments", () =>
  boundary(async ({ repo, state, calls }) => {
    const body =
      "Owner text.\r\nhttps://example.com/docs/example.txt#L1-L40\n![Screenshot](https://github.com/user-attachments/assets/01234567-89ab-cdef-0123-456789abcdef)\n~~~md\n**Visible instructions**  \n~~~";
    state.issue = readyIssue(42, { body });
    delete state.issue.bodyText;
    const shown = await output(() => commands.issue?.({ repo, args: ["show", "42"] }));
    assert.equal(
      shown,
      `# Fix the review pane\n${state.issue.url}\nThe issue body as its owner wrote it, in Markdown.\n\n${body.replaceAll("\r\n", "\n")}`,
    );
    const rows = JSON.parse(await output(() => commands.issues?.({ repo, args: ["--json"] })));
    assert.equal(rows[0].status, "pickable");
    const dir = join(repo.mainRoot, ".wt");
    mkdirSync(dir, { recursive: true });
    writeIssueSnapshot(dir, pickIssue(repo, 42));
    assert.equal(readFileSync(join(dir, "issue.md"), "utf8"), shown);
    assert.equal(checkIssue(repo), 42);
    for (const call of calls) {
      const query = call.args.find((arg) => arg.startsWith("query="));
      if (!query || query.includes("pullRequests(states:")) continue;
      assert.doesNotMatch(query, /bodyText/);
      assert.match(query, /\bbody\b/);
    }
  }));

test("issue snapshot keeps the last word of a 250-character title while display rows stay bounded", () =>
  boundary(async ({ repo, state }) => {
    const title = `${"x".repeat(240)} finalword`;
    assert.equal(title.length, 250);
    state.issue = readyIssue(42, { title });
    const issue = pickIssue(repo, 42);
    const dir = join(repo.mainRoot, ".wt");
    mkdirSync(dir, { recursive: true });
    writeIssueSnapshot(dir, issue);
    const snapshot = readFileSync(join(dir, "issue.md"), "utf8");
    assert.equal(snapshot.split("\n")[0], `# ${title}`);
    assert.match(snapshot, / finalword\n/);
    assert.equal(checkIssue(repo), 42);
    assert.equal(await output(() => commands.issue?.({ repo, args: ["show", "42"] })), snapshot);
    const table = await output(() => commands.issues?.({ repo, args: [] }));
    assert.ok(table.endsWith(`${title.slice(0, 120)}\n`));
    assert.doesNotMatch(table, /finalword/);
    const sanitized = issueSnapshotText({ ...issue, title: `${title}\u0000\u202eend` });
    assert.equal(sanitized.split("\n")[0], `# ${title}  end`);
  }));

test("issue show --taken only exempts a claim and still enforces every eligibility check", () =>
  boundary(async ({ repo, state }) => {
    const expected = await output(() => commands.issue?.({ repo, args: ["show", "42"] }));
    assert.equal(await output(() => commands.issue?.({ repo, args: ["show", "42", "--taken"] })), expected);
    state.taken = true;
    assert.equal(await output(() => commands.issue?.({ repo, args: ["show", "42", "--taken"] })), expected);
    assert.throws(
      () => commands.issue?.({ repo, args: ["show", "42"] }),
      (e: unknown) => e instanceof WtError && e.code === 3,
    );
    assert.throws(
      () => pickIssue(repo, 42),
      (e: unknown) => e instanceof WtError && e.code === 3,
    );
    for (const extra of [
      { author: { login: "outsider" } },
      { body: "Invisible\u034f" },
      { state: "CLOSED" },
      { blockedBy: { nodes: [{ number: 9, state: "OPEN" }], pageInfo: { hasNextPage: false } } },
    ]) {
      state.issue = readyIssue(42, extra);
      let refusal: WtError | undefined;
      assert.throws(
        () => commands.issue?.({ repo, args: ["show", "42"] }),
        (e: unknown) => {
          assert.ok(e instanceof WtError);
          refusal = e;
          return e.code === 2;
        },
      );
      assert.throws(
        () => commands.issue?.({ repo, args: ["show", "42", "--taken"] }),
        (e: unknown) => e instanceof WtError && e.code === refusal?.code && e.message === refusal.message,
      );
    }
    state.issue = null;
    assert.throws(() => commands.issue?.({ repo, args: ["show", "42", "--taken"] }), /not open and ready/);
    state.unavailable = true;
    assert.throws(
      () => commands.issue?.({ repo, args: ["show", "42", "--taken"] }),
      (e: unknown) => e instanceof WtError && e.code === 69,
    );
  }));

test("issue show flag parsing keeps --taken scoped to show", () =>
  boundary(({ repo, calls }) => {
    for (const args of [
      ["show"],
      ["show", "42", "--taken=false"],
      ["show", "42", "--taken", "--taken"],
      ["show", "42", "43"],
      ["check", "--taken"],
    ])
      assert.throws(
        () => commands.issue?.({ repo, args }),
        (e: unknown) => e instanceof WtError && e.code === 2,
      );
    assert.equal(calls.length, 0);
  }));

for (const text of [
  "**Fixes** #9",
  "_Fixes_ #9",
  "Fixes **#9**",
  "Fixes: _#9_",
  "Fixes [#9](https://github.com/o/r/issues/9)",
  "Fixes [here](https://github.com/owner/repo/issues/9)",
  "Fixes <https://github.com/o/r/issues/9>",
  "Fixes [other/repo#42](https://github.com/owner/repo/issues/42)",
  "Fixes [https://github.com/other/repo/issues/42](https://example.invalid)",
  "Fixes [#9](https://github.com/owner/repo/issues/42)",
  "***Fixes*** **:** ~~#9~~",
  'Fixes <a href="https://github.com/o/r/issues/9">x</a>',
  "Fixes [#9][1]",
  "Fixes [#42](https://github.com/other/repo/issues/9)",
  "Closes #42 and #9",
]) {
  test(`Markdown closing reference is refused across PR commands: ${text}`, () =>
    boundary(({ repo, state, calls }) => {
      prepareMergeIssue(repo);
      calls.length = 0;
      const refuses = (fn: () => unknown) =>
        assert.throws(
          fn,
          (e: unknown) =>
            e instanceof WtError &&
            e.code === 2 &&
            (/must not close/.test(e.message) || e.message === unparsedClosingReference),
        );
      refuses(() => prCreate(repo, { title: "T", body: `Closes #42\n${text}`, draft: false }));
      refuses(() => prEdit(repo, { body: `Closes #42\n${text}` }));
      refuses(() => prMerge(repo, { pr: "7", matchHead: "a".repeat(40), subject: "T", body: text }));
      state.prBody = `Closes #42\n${text}`;
      refuses(() => prMerge(repo, { pr: "7", matchHead: "a".repeat(40), subject: "T", body: "Body" }));
      assert.ok(calls.every((c) => c.command !== "gh" || readOnlyPrOrIssue(c)));
    }));
}

test("Markdown own references satisfy the requirement without hiding other references", () =>
  boundary(({ repo, state }) => {
    for (const body of [
      "**Closes** #42",
      "Closes [#42](https://github.com/owner/repo/issues/42)",
      "Closes [OWNER/REPO#42](https://example.invalid)",
      "Closes [https://github.com/owner/repo/issues/42](https://example.invalid)",
      "Closes [here](https://github.com/owner/repo/issues/42)",
      "Closes <https://github.com/owner/repo/issues/42>",
      "***Closes*** **:** ___#42___",
    ]) {
      state.pr = false;
      assert.equal(prCreate(repo, { title: "T", body, draft: false }), "https://github.com/Owner/Repo/pull/7\n", body);
      state.pr = true;
      assert.equal(prEdit(repo, { body }), "changed", body);
    }
    for (const body of [
      "Discloses #42",
      "Closes #42abc",
      "Closes **#42abc**",
      "Closes [#42abc](https://example.invalid)",
    ])
      assert.throws(() => closingGuard(repo, "emend-42-fix", body), /must close/);
  }));

for (const branch of ["emend-task-042-task", "manual-change"]) {
  test(`only issue branches may close issues: ${branch}`, () =>
    boundary(({ repo, state, calls }) => {
      repo.callerBranch = branch;
      state.prBranch = branch;
      state.prBody = "Description";
      const refuses = (fn: () => unknown) =>
        assert.throws(
          fn,
          (e: unknown) =>
            e instanceof WtError &&
            e.code === 2 &&
            (/only issue branches/i.test(e.message) || e.message === unparsedClosingReference),
        );
      for (const text of [
        "Closes #42",
        "**Fixes** #9",
        "Fixes [here](https://github.com/owner/repo/issues/9)",
        "Fixes [#9][1]",
      ]) {
        refuses(() => prCreate(repo, { title: text, body: "Body", draft: false }));
        refuses(() => prCreate(repo, { title: "T", body: text, draft: false }));
        refuses(() => prEdit(repo, { title: text }));
        refuses(() => prEdit(repo, { body: text }));
        refuses(() => prMerge(repo, { pr: "7", matchHead: "a".repeat(40), subject: text, body: "Body" }));
        refuses(() => prMerge(repo, { pr: "7", matchHead: "a".repeat(40), subject: "T", body: text }));
        for (const field of ["prTitle", "prBody"] as const) {
          const previous = state[field];
          state[field] = text;
          refuses(() => prEdit(repo, field === "prTitle" ? { body: "Body" } : { title: "T" }));
          refuses(() => prMerge(repo, { pr: "7", matchHead: "a".repeat(40), subject: "T", body: "Body" }));
          state[field] = previous;
        }
      }
      assert.ok(calls.every((c) => c.command !== "gh" || exactPrLookup(c) || c.args[1] === "view"));
      assert.equal(prEdit(repo, { title: "Safe", body: "References #42" }), "changed");
    }));
}

test("queue commands fetch label evidence and expose no untrusted titles", () =>
  boundary(async ({ repo, state, calls }) => {
    state.issue = readyIssue(42, { author: { login: "outsider" }, title: "UNTRUSTED INSTRUCTION" });
    const table = await output(() => commands.issues?.({ repo, args: [] }));
    const json = await output(() => commands.issues?.({ repo, args: ["--json"] }));
    assert.equal(table, "#42  untrusted (current body was not written by the repository owner)\n");
    assert.deepEqual(JSON.parse(json), [
      { number: 42, status: "untrusted", reason: "current body was not written by the repository owner", title: null },
    ]);
    const query =
      calls.find((c) => c.args.some((a) => a.includes("issues(states:")))?.args.find((a) => a.startsWith("query=")) ??
      "";
    assert.match(query, /label\(name: "ready"\) \{ id updatedAt \}/);
    assert.doesNotMatch(query, /bodyText/);
    assert.match(query, /\bbody\b/);
    for (const type of ["LabeledEvent", "UnlabeledEvent"])
      assert.match(query, new RegExp(`on ${type} \\{ createdAt label \\{ id name \\}`));
  }));

test("issue check compares raw approval hashes without comparing live bodyText", () =>
  boundary(({ repo, state }) => {
    const issue = pickIssue(repo, 42);
    const dir = join(repo.mainRoot, ".wt");
    mkdirSync(dir, { recursive: true });
    writeIssueSnapshot(dir, issue);
    state.issue = readyIssue(42, { bodyText: "A different GitHub rendering" });
    assert.equal(checkIssue(repo), 42);
    for (const changed of [{ title: "Changed title" }, { body: "Changed raw body" }]) {
      state.issue = readyIssue(42, changed);
      assert.throws(() => checkIssue(repo), /differs from the snapshot/);
    }
  }));

const foreign = [
  "#9",
  "GH-9",
  "owner/repo#9",
  "other/repo#42",
  "https://github.com/other/repo/issues/42",
  "http://github.com/owner/repo/issues/9/",
  "www.github.com/owner/repo/issues/9/",
  "https://www.github.com/owner/repo/issues/9/",
];
for (const reference of foreign) {
  test(`PR command boundaries refuse other closing reference ${reference}`, () =>
    boundary(({ repo, calls }) => {
      prepareMergeIssue(repo);
      calls.length = 0;
      const refuses = (fn: () => unknown) =>
        assert.throws(fn, (e: unknown) => e instanceof WtError && e.code === 2 && /must not close/.test(e.message));
      for (const text of [`Fixes: ${reference}`, `\`\`\`\nFixes ${reference}\n\`\`\``, `<!-- Fixes ${reference} -->`]) {
        refuses(() => prCreate(repo, { title: "T", body: `Closes #42\n${text}`, draft: false }));
        refuses(() => prEdit(repo, { body: `Closes #42\n${text}` }));
        refuses(() => prMerge(repo, { pr: "7", matchHead: "a".repeat(40), subject: "Fix pane", body: text }));
      }
      refuses(() => prCreate(repo, { title: `Fixes ${reference}`, body: "Closes #42", draft: false }));
      refuses(() => prEdit(repo, { title: `Fixes ${reference}` }));
      refuses(() => prCreate(repo, { title: "Fixes", body: `${reference}\nCloses #42`, draft: false }));
      refuses(() => prEdit(repo, { title: "Fixes", body: `${reference}\nCloses #42` }));
      refuses(() => prMerge(repo, { pr: "7", matchHead: "a".repeat(40), subject: `Fixes ${reference}`, body: "Body" }));
      refuses(() => prMerge(repo, { pr: "7", matchHead: "a".repeat(40), subject: "Fixes", body: reference }));
      assert.ok(!calls.some((c) => c.command === "gh" && !readOnlyPrOrIssue(c)));
    }));
}

test("closing references resolve repositories case-insensitively for every keyword and form", () =>
  boundary(({ repo }) => {
    for (const keyword of ["close", "closes", "closed", "fix", "fixes", "fixed", "resolve", "resolves", "resolved"]) {
      for (const reference of [
        "#42",
        "OWNER/REPO#42",
        "https://github.com/OWNER/REPO/issues/42",
        "http://github.com/owner/repo/issues/42/",
        "www.github.com/owner/repo/issues/42/",
        "https://www.github.com/owner/repo/issues/42/",
      ]) {
        for (const colon of ["", ":"])
          closingGuard(repo, "emend-42-fix", `${keyword.toUpperCase()}${colon}\t${reference}`);
      }
    }
    assert.throws(
      () => closingGuard(repo, "emend-42-fix", "Closes #42\nFixes GH-42"),
      (e: unknown) => e instanceof WtError && e.message === unparsedClosingReference,
    );
    assert.throws(() => closingGuard(repo, "emend-42-fix", "Closes GH-42"), /must close/);
    assert.throws(() => closingGuard(repo, "feature", "Closes other/repo#9"), /only issue branches/i);
  }));

for (const command of ["create", "edit"]) {
  test(`pr ${command} command reads a literal title file`, () =>
    boundary(async ({ repo, state, calls }) => {
      state.pr = command === "edit";
      const file = join(repo.mainRoot, "title.txt");
      const title = 'fix: literal $(false) `false` $HOME "quotes"';
      writeFileSync(file, `${title}\r\n`);
      assert.equal(
        await output(() =>
          githubCommands.pr?.({ repo, args: [command, "--title-file", file, "--body", "Closes #42"] }),
        ),
        command === "create" ? state.createOutput : "changed\n",
      );
      assert.ok(calls.some((c) => c.args.includes(`--title=${title}`) && c.input === "Closes #42"));
      assert.throws(
        () =>
          githubCommands.pr?.({ repo, args: [command, "--title-file", file, "--title", "T", "--body", "Closes #42"] }),
        /not both/,
      );
      const invoke = () => githubCommands.pr?.({ repo, args: [command, "--title-file", file, "--body", "Closes #42"] });
      for (const value of [
        "",
        "two\nlines",
        "line\n\n",
        "a".repeat(73),
        "a\u0000b",
        "a".repeat(1024 * 1024 + 1),
        Buffer.from([0xff]),
      ]) {
        writeFileSync(file, value);
        assert.throws(invoke, (e: unknown) => e instanceof WtError && e.code === 2);
      }
      rmSync(file);
      assert.throws(invoke, /no symlinks/);
      const target = join(repo.mainRoot, "target.txt");
      writeFileSync(target, "Valid title");
      symlinkSync(target, file);
      assert.throws(invoke, /no symlinks/);
      rmSync(file);
      mkdirSync(file);
      assert.throws(invoke, /no symlinks/);
    }));
}

test("queue and pick both enforce current ready label identity and update time", () =>
  boundary(async ({ repo, state }) => {
    for (const label of [
      null,
      { ...READY_LABEL, updatedAt: "2026-01-03T00:00:00Z" },
      { ...READY_LABEL, updatedAt: READY_AT },
      { ...READY_LABEL, id: "replacement" },
    ]) {
      state.label = label;
      assert.throws(() => pickIssue(repo, 42), /untrusted/);
      const rows = JSON.parse(await output(() => commands.issues?.({ repo, args: ["--json"] })));
      assert.equal(rows[0].status, "untrusted");
    }
    state.label = READY_LABEL;
    assert.equal(pickIssue(repo, 42).status, "pickable");
  }));

test("edits and merges also guard the current PR title and description", () =>
  boundary(({ repo, state, calls }) => {
    prepareMergeIssue(repo);
    calls.length = 0;
    const refuses = (fn: () => unknown) =>
      assert.throws(fn, (e: unknown) => e instanceof WtError && e.code === 2 && /must not close/.test(e.message));
    state.prBody = "Closes #42\n<!-- Fixes other/repo#42 -->";
    refuses(() => prEdit(repo, { title: "Safe title" }));
    refuses(() =>
      prMerge(repo, { pr: "7", matchHead: "a".repeat(40), subject: "Safe subject", body: "Safe commit body" }),
    );
    state.prBody = "Closes #42";
    state.prTitle = "Fixes #9";
    refuses(() => prEdit(repo, { body: "Closes #42" }));
    refuses(() =>
      prMerge(repo, { pr: "7", matchHead: "a".repeat(40), subject: "Safe subject", body: "Safe commit body" }),
    );
    state.prTitle = "Safe title";
    state.prBody = "References #42";
    assert.throws(() => prEdit(repo, { title: "Safe title" }), /must close/);
    assert.ok(!calls.some((c) => c.command === "gh" && !readOnlyPrOrIssue(c)));
  }));

const bodyEdit = (login: string, editedAt: string) => ({ editedAt, editor: { login } });

test("newest-first edit pagination exposes a stranger's 51st version tied with ready", () =>
  boundary(async ({ repo, state, calls }) => {
    const oldest = Array.from({ length: 49 }, (_, i) =>
      bodyEdit("outsider", `2026-01-01T00:00:${String(i).padStart(2, "0")}Z`),
    );
    state.issue = readyIssue(42, {
      author: { login: "outsider" },
      createdAt: oldest[0]?.editedAt,
      lastEditedAt: READY_AT,
    });
    state.versions = [bodyEdit("outsider", READY_AT), bodyEdit("owner", READY_AT), ...oldest.reverse()];
    const rows = JSON.parse(await output(() => commands.issues?.({ repo, args: ["--json"] })));
    assert.equal(rows[0].status, "untrusted");
    assert.match(rows[0].reason, /body edited after ready/);
    assert.throws(() => pickIssue(repo, 42), /body edited after ready/);
    for (const call of calls) {
      const query = call.args.find((arg) => arg.startsWith("query="));
      if (!query?.includes("userContentEdits")) continue;
      assert.match(query, /userContentEdits\(first: 50\).*pageInfo \{ hasNextPage \}/);
      assert.match(query, /timelineItems\([^\n]*last: 50\)/);
    }
    const row = evaluateIssue(
      {
        ...state.issue,
        userContentEdits: { nodes: state.versions, pageInfo: { hasNextPage: true } },
      },
      "owner",
      new Map(),
      READY_LABEL,
    ).row;
    assert.equal(row.status, "untrusted");
    assert.match(row.reason ?? "", /body edited after ready/);
  }));

for (const [name, author, renames, more, included] of [
  ["stranger-authored title", "outsider", [], false, false],
  ["owner rename after stranger title", "outsider", ["outsider", "owner"], false, true],
  ["stranger rename after owner title", "owner", ["owner", "outsider"], false, false],
  ["incomplete rename history", "owner", ["owner"], true, false],
] as const) {
  test(`title ownership controls snapshot, show and queue: ${name}`, () =>
    boundary(async ({ repo, state }) => {
      const title = "Synthetic title from its latest writer";
      state.issue = readyIssue(42, {
        title,
        author: { login: author },
        createdAt: "2025-12-30T00:00:00Z",
        lastEditedAt: "2026-01-01T00:00:00Z",
        userContentEdits: {
          nodes: [bodyEdit("owner", "2026-01-01T00:00:00Z"), bodyEdit(author, "2025-12-30T00:00:00Z")],
          pageInfo: { hasNextPage: false },
        },
        timelineItems: {
          nodes: [
            ...renames.map((actor, i) => issueEvent(actor, "RenamedTitleEvent", `2025-12-31T0${i}:00:00Z`)),
            issueEvent(),
          ],
          pageInfo: { hasPreviousPage: more },
        },
      });
      const dir = join(repo.mainRoot, ".wt");
      mkdirSync(dir, { recursive: true });
      writeIssueSnapshot(dir, pickIssue(repo, 42));
      const markdown = readFileSync(join(dir, "issue.md"), "utf8");
      const metadata = JSON.parse(readFileSync(join(dir, "issue.json"), "utf8"));
      assert.equal(metadata.title, included ? title : null);
      assert.equal(metadata.titleSha256, sha256(title));
      assert.equal(markdown.split("\n")[0], included ? `# ${title}` : "# Issue 42");
      if (!included) {
        assert.ok(!markdown.includes(title));
        assert.ok(markdown.includes("The title is left out because the owner did not write it."));
      }
      assert.equal(await output(() => commands.issue?.({ repo, args: ["show", "42"] })), markdown);
      const table = await output(() => commands.issues?.({ repo, args: [] }));
      assert.equal(table.includes(title), included);
      const rows = JSON.parse(await output(() => commands.issues?.({ repo, args: ["--json"] })));
      assert.equal(rows[0].status, "pickable");
      assert.equal(rows[0].title, included ? title : null);
      assert.equal(checkIssue(repo), 42);
      state.issue.title = "A renamed synthetic title";
      assert.throws(() => checkIssue(repo), /Live issue title differs/);
    }));
}

for (const text of ["cloſes #7", "ﬁxes #7", "Closes ＃７", "ＦＩＸＥＳ #7"]) {
  test(`closing guard refuses normalized Unicode references: ${text}`, () =>
    boundary(({ repo }) => {
      assert.throws(
        () => closingGuard(repo, "emend-task-062-x", text),
        (e: unknown) => e instanceof WtError && e.code === 2,
      );
      assert.throws(
        () => closingGuard(repo, "emend-42-x", `Closes #42\n${text}`),
        (e: unknown) => e instanceof WtError && e.code === 2,
      );
    }));
}

test("normalized closing positions distinguish prose from direct references", () =>
  boundary(({ repo }) => {
    closingGuard(repo, "emend-42-x", "ｃｌｏｓｅｓ #42");
    closingGuard(repo, "emend-42-x", "ｃｌｏｓｅｓ #42\nＦＩＸＥＳ see ＃７");
    assert.throws(
      () => closingGuard(repo, "emend-42-x", "ｃｌｏｓｅｓ #42\nＦＩＸＥＳ `＃７`"),
      (e: unknown) => e instanceof WtError && e.code === 2 && e.message === unparsedClosingReference,
    );
  }));

for (const command of ["create", "edit", "merge"] as const) {
  test(`pr ${command} selects the same-repository PR despite a fork with the same head`, () =>
    boundary(({ repo, state, calls }) => {
      prepareMergeIssue(repo);
      calls.length = 0;
      state.pr = command !== "create";
      state.extraPrs = [
        { number: 8, state: "OPEN", headRefName: state.prBranch, isCrossRepository: true },
        { number: 9, state: "OPEN", headRefName: "emend-99-other", isCrossRepository: false },
        { number: 10, state: "CLOSED", headRefName: state.prBranch, isCrossRepository: false },
      ];
      state.closing = { stdout: closingResponse([ownClosingIssue]) };
      const result =
        command === "create"
          ? prCreate(repo, { title: "T", body: "Closes #42", draft: false })
          : command === "edit"
            ? prEdit(repo, { title: "T" })
            : prMerge(repo, { matchHead: "a".repeat(40), subject: "T", body: "Body" });
      assert.equal(result, command === "merge" ? "QUEUED" : command === "create" ? state.createOutput : "changed");
      const lookup = calls.find((c) => c.command === "gh" && exactPrLookup(c));
      assert.ok(lookup?.args.includes(`head=${state.prBranch}`));
      assert.ok(lookup?.args.some((a) => a.includes("states: [OPEN]")));
      assert.ok(!calls.some((c) => c.command === "gh" && c.args[1] === "list"));
      assert.ok(!calls.some((c) => c.command === "gh" && c.args[1] === "view" && c.args[2] === state.prBranch));
      if (command !== "create")
        assert.ok(calls.some((c) => c.command === "gh" && c.args[1] === command && c.args[2] === "7"));
    }));
}

test("caller branch lookup refuses multiple same-repository PRs before mutation", () =>
  boundary(({ repo, state, calls }) => {
    state.extraPrs = [{ number: 8, state: "OPEN", headRefName: state.prBranch, isCrossRepository: false }];
    assert.throws(
      () => prEdit(repo, { title: "T" }),
      (e: unknown) => e instanceof WtError && e.code === 1 && /More than one open pull request/.test(e.message),
    );
    assert.ok(calls.every((c) => exactPrLookup(c)));
  }));

test("issue check refuses a rewritten snapshot even when its stored hash matches", () =>
  boundary(({ repo }) => {
    const dir = join(repo.mainRoot, ".wt");
    mkdirSync(dir, { recursive: true });
    writeIssueSnapshot(dir, pickIssue(repo, 42));
    const path = join(dir, "issue.md");
    const changed = `${readFileSync(path, "utf8")}\nUnapproved synthetic instruction.\n`;
    writeFileSync(path, changed);
    const metadata = JSON.parse(readFileSync(join(dir, "issue.json"), "utf8"));
    metadata.snapshotSha256 = sha256(changed);
    writeFileSync(join(dir, "issue.json"), JSON.stringify(metadata));
    assert.throws(
      () => checkIssue(repo),
      (e: unknown) =>
        e instanceof WtError && e.code === 1 && /issue.md differs from the live approved issue/.test(e.message),
    );
  }));

test("caller branch lookup refuses incomplete or malformed PR lists before mutation", () =>
  boundary(({ repo, state, calls }) => {
    for (const invalid of [{ isCrossRepository: null }, { headRefName: null }, { state: null }]) {
      calls.length = 0;
      state.extraPrs = [
        { number: 8, state: "OPEN", headRefName: state.prBranch, isCrossRepository: false, ...invalid },
      ];
      assert.throws(
        () => prEdit(repo, { title: "T" }),
        (e: unknown) => e instanceof WtError && e.code === 1 && /could not read/.test(e.message),
      );
      assert.ok(calls.every((c) => exactPrLookup(c)));
    }
    calls.length = 0;
    state.extraPrs = Array.from({ length: 99 }, (_, i) => ({
      number: i + 8,
      state: "OPEN",
      headRefName: state.prBranch,
      isCrossRepository: true,
    }));
    state.brokenPrPage = true;
    assert.throws(() => prEdit(repo, { title: "T" }), /complete pull request list/);
    assert.ok(!calls.some((c) => c.command === "gh" && ["create", "edit", "merge"].includes(c.args[1] ?? "")));
  }));

for (const text of [
  "fix(ui): use #333 for the divider",
  "fix(cli): stop crash seen in PR #45",
  "This fixes the layout regression introduced in #45.",
  "Resolved in a follow-up, see #45",
  "Adds the fix. Known issue: #45",
]) {
  test(`closing guard accepts incidental references in prose: ${text}`, () =>
    boundary(({ repo }) => {
      closingGuard(repo, "emend-task-062-x", text);
      closingGuard(repo, "emend-42-x", `${text}\n\nCloses #42`);
    }));
}

test("closing guard stops after the next ordinary token on the following line", () =>
  boundary(({ repo }) => {
    writeFileSync(join(repo.mainRoot, ".wt/worktree.json"), JSON.stringify({ issue: 9 }));
    closingGuard(repo, "emend-9-x", "Closes #9\nsee step #2 of the plan");
  }));

for (const [text, message] of [
  ["Fixes #7, #8", "The PR text must not close an issue other than #9."],
  ["Closes #9 and #8", unparsedClosingReference],
  ["Closes #9, #8", unparsedClosingReference],
  ["Closes #9; **#8**", unparsedClosingReference],
  ["Closes #9 & `#8`", unparsedClosingReference],
  ["Closes #9 or [the bug](https://github.com/o/r/issues/8)", unparsedClosingReference],
] as const) {
  test(`closing guard refuses trailing foreign references: ${text}`, () =>
    boundary(({ repo }) => {
      writeFileSync(join(repo.mainRoot, ".wt/worktree.json"), JSON.stringify({ issue: 9 }));
      assert.throws(
        () => closingGuard(repo, "emend-9-x", `Closes #9\n${text}`),
        (e: unknown) => e instanceof WtError && e.code === 2 && e.message === message,
      );
    }));
}

test("closing positions cannot hide references behind more than 80 characters of whitespace", () =>
  boundary(({ repo }) => {
    for (const text of [`Fixes \`${" ".repeat(81)}#7\``, `Closes #42${" ".repeat(81)}and #7`]) {
      assert.throws(
        () => closingGuard(repo, "emend-42-x", `Closes #42\n${text}`),
        (e: unknown) => e instanceof WtError && e.code === 2 && e.message === unparsedClosingReference,
      );
    }
  }));

for (const text of [
  "Fixes see #9",
  "Fixes see GH-9",
  "Fixes see other/repo#42",
  "Fixes see github.com/owner/repo/issues/9",
]) {
  test(`prose before references is accepted across PR commands: ${text}`, () =>
    boundary(({ repo, state }) => {
      for (const branch of ["emend-task-062-x", "emend-42-x"]) {
        repo.callerBranch = state.prBranch = branch;
        const issueBranch = branch === "emend-42-x";
        if (issueBranch) prepareMergeIssue(repo);
        const body = `${issueBranch ? "Closes #42\n" : ""}${text}`;
        state.prTitle = text;
        state.prBody = body;
        state.closing = { stdout: closingResponse(issueBranch ? [ownClosingIssue] : []) };
        state.pr = false;
        assert.equal(prCreate(repo, { title: text, body, draft: false }), "https://github.com/Owner/Repo/pull/7\n");
        assert.equal(prEdit(repo, { title: text, body }), "changed");
        assert.equal(prMerge(repo, { matchHead: "a".repeat(40), subject: text, body: text }), "QUEUED");
      }
    }));
}

for (const destination of [
  `${" ".repeat(90)}https://github.com/owner/repo/issues/9`,
  `${" ".repeat(90)}<https://github.com/owner/repo/issues/9>`,
  "\n<https://github.com/owner/repo/issues/9>\n",
]) {
  test(`consumed closing links inspect the entire destination: ${JSON.stringify(destination)}`, () =>
    boundary(({ repo }) => {
      assert.throws(
        () => closingGuard(repo, "emend-42-x", `Closes [#42](${destination})`),
        (e: unknown) => e instanceof WtError && e.code === 2 && e.message === unparsedClosingReference,
      );
    }));
}

for (const text of [
  "Closes [the bug][ref]",
  "Closes [the bug][]",
  'Fixes <a href="https://github.com/owner/repo/issues/9">x</a>',
  "Fixes <a class='link'\nhref='https://github.com/owner/repo/issues/9'>x</a>",
  'Fixes <a href="&#x23;9">x</a>',
]) {
  test(`indirect closing links fail closed: ${text}`, () =>
    boundary(({ repo }) => {
      for (const branch of ["emend-task-062-x", "emend-42-x"]) {
        const body = `${branch === "emend-42-x" ? "Closes #42\n" : ""}${text}`;
        assert.throws(
          () => closingGuard(repo, branch, body),
          (e: unknown) => e instanceof WtError && e.code === 2 && e.message === unparsedClosingReference,
        );
      }
    }));
}

for (const entity of ["&#35;", "&#00035;", "&#x23;", "&#X00023;"]) {
  test(`closing references decode number-sign entity ${entity}`, () =>
    boundary(({ repo }) => {
      assert.throws(
        () => closingGuard(repo, "emend-task-062-x", `Fixes ${entity}13`),
        (e: unknown) => e instanceof WtError && e.code === 2 && e.message === "Only issue branches may close issues.",
      );
      writeFileSync(join(repo.mainRoot, ".wt/worktree.json"), JSON.stringify({ issue: 13 }));
      closingGuard(repo, "emend-13-x", `Closes ${entity}13`);
    }));
}

test("closing reference chains check the last operand without a length bound", () =>
  boundary(({ repo }) => {
    writeFileSync(join(repo.mainRoot, ".wt/worktree.json"), JSON.stringify({ issue: 12 }));
    const own = Array(30).fill("#12").join(", ");
    closingGuard(repo, "emend-12-x", `Fixes ${own}`);
    assert.throws(
      () => closingGuard(repo, "emend-12-x", `Fixes ${own}, #13`),
      (e: unknown) => e instanceof WtError && e.code === 2 && e.message === unparsedClosingReference,
    );
  }));

for (const [name, headRefName] of [
  ["missing", undefined],
  ["null", null],
  ["invalid", "emend-42-.."],
] as const) {
  test(`pr edit --pr refuses a ${name} headRefName before mutation`, () =>
    boundary(({ repo, state, calls }) => {
      state.mergeView = { headRefName };
      assert.throws(
        () => prEdit(repo, { pr: "7", body: "Description without a closing reference" }),
        (e: unknown) => e instanceof WtError && e.code === 1 && /head branch/.test(e.message),
      );
      assertReadOnlyPrLookups(calls);
    }));
}

test("pr edit --pr permits another valid head only from the main checkout", () =>
  boundary(({ repo, state, calls }) => {
    repo.callerTop = join(repo.worktreesDir, "emend-42-fix");
    state.mergeView = { headRefName: "emend-task-062-other" };
    assert.throws(() => prEdit(repo, { pr: "7", body: "Body" }), /head branch does not match the caller/);
    assertReadOnlyPrLookups(calls);
    repo.callerTop = repo.mainRoot;
    assert.equal(prEdit(repo, { pr: "7", body: "Body" }), "changed");
  }));

test("hidden Markdown is refused by queue, show and pick without exposing the body", () =>
  boundary(async ({ repo, state }) => {
    state.issue = readyIssue(42, { body: "<!-- synthetic hidden instruction -->" });
    const rows = JSON.parse(await output(() => commands.issues?.({ repo, args: ["--json"] })));
    assert.equal(rows[0].status, "untrusted");
    assert.equal(rows[0].reason, "hidden Markdown in the body: raw HTML");
    assert.ok(!JSON.stringify(rows).includes("synthetic hidden instruction"));
    const reason = "Issue #42 is untrusted: hidden Markdown in the body: raw HTML.";
    assert.throws(
      () => pickIssue(repo, 42),
      (e: unknown) => e instanceof WtError && e.code === 2 && e.message === reason,
    );
    await assert.rejects(
      async () => commands.issue?.({ repo, args: ["show", "42"] }),
      (e: unknown) => e instanceof WtError && e.code === 2 && e.message === `${reason} Nothing was created.`,
    );
    assert.equal(existsSync(join(repo.mainRoot, ".wt/issue.md")), false);
  }));

for (const [name, body, kind] of [
  ["fenced comment", "```text\n<!-- synthetic hidden instruction -->\n```", "raw HTML"],
  ["invisible link", "[ ](https://example.com/x)", "link destination"],
  ["fenced definition", "```md\n[x]: https://example.com\n```", "reference definition"],
  ["fenced character reference", "```text\n&#8203;\n```", "character reference"],
  ["fenced math", "```text\n$\\phantom{hidden}$\n```", "math"],
  ["inline shortcode", "`:smile:`", "emoji shortcode"],
  ["quoted mermaid", "> ```mermaid\n> %% hidden\n> ```", "fence info"],
  ["extra table cell", "| Task |\n| --- |\n| visible | HIDDEN |", "table"],
  ["pipe-free table", "- | a |\n  --:", "table"],
  ["multiline math", "Keep $`\\phantom{x}\n`$ visible.", "math"],
  ["rewritten GitHub link", "https://github.com/owner/repo/issues/12/hidden", "GitHub link"],
  [
    "unapproved screenshot alt",
    "![login.png](https://github.com/user-attachments/assets/01234567-89ab-cdef-0123-456789abcdef)",
    "alt text",
  ],
  ["long line", "x".repeat(201), "line length"],
  ["whitespace run", `a${" ".repeat(17)}b`, "whitespace run"],
  ["numeric emoji", ":+1:", "emoji shortcode"],
] as const) {
  test(`raw Markdown gates queue, show, pick and issue check: ${name}`, () =>
    boundary(async ({ repo, state }) => {
      prepareMergeIssue(repo);
      state.issue = readyIssue(42, { body });
      const reason = `Issue #42 is untrusted: hidden Markdown in the body: ${kind}.`;
      const rows = JSON.parse(await output(() => commands.issues?.({ repo, args: ["--json"] })));
      assert.equal(rows[0].status, "untrusted");
      assert.equal(rows[0].title, null);
      assert.equal(rows[0].reason, `hidden Markdown in the body: ${kind}`);
      const table = await output(() => commands.issues?.({ repo, args: [] }));
      assert.equal(table, `#42  untrusted (hidden Markdown in the body: ${kind})\n`);
      assert.throws(
        () => pickIssue(repo, 42),
        (e: unknown) => e instanceof WtError && e.code === 2 && e.message === reason,
      );
      await assert.rejects(
        async () => commands.issue?.({ repo, args: ["show", "42"] }),
        (e: unknown) => e instanceof WtError && e.code === 2 && e.message === `${reason} Nothing was created.`,
      );
      assert.throws(
        () => checkIssue(repo),
        (e: unknown) => e instanceof WtError && e.code === 1 && e.message === reason,
      );
    }));
}

for (const text of [
  "Closes [the bug #9](https://github.com/owner/repo/issues/42)",
  "Closes [#42](docs https://github.com/owner/repo/issues/9)",
  "Closes [#42](docs #9)",
  'Text <broken "\nCloses #42\nFixes <a href="https://github.com/owner/repo/issues/9">x</a>',
  'Closes #42\nFixes <a title="a < b > c" href="https://github.com/owner/repo/issues/9">x</a>',
]) {
  test(`closing links inspect references throughout both fields: ${text}`, () =>
    boundary(({ repo }) => {
      assert.throws(
        () => closingGuard(repo, "emend-42-x", text),
        (e: unknown) => e instanceof WtError && e.code === 2 && e.message === unparsedClosingReference,
      );
    }));
}

test("own closing links and unrelated prose do not require an unrelated repository lookup", () =>
  boundary(({ repo, calls }) => {
    closingGuard(repo, "emend-42-x", "Closes [#42](docs)\nSee other/repo#9 for context.");
    assert.ok(!calls.some((call) => call.command === "git" && call.args.includes("get-url")));
    closingGuard(repo, "emend-42-x", 'Closes #42\nFixes <a href="https://github.com/owner/repo/issues/42">x</a>');
  }));

test("closing scans handle many malformed openers and a long own-reference chain", () =>
  boundary(({ repo }) => {
    closingGuard(repo, "emend-task-062-x", `${"Fixes <text ".repeat(2000)}${" ".repeat(2000)}>`);
    const chain = Array(2000).fill("#42").join(", ");
    closingGuard(repo, "emend-42-x", `Closes ${chain}`);
    assert.throws(
      () => closingGuard(repo, "emend-42-x", `Closes ${chain}, #9`),
      (e: unknown) => e instanceof WtError && e.code === 2 && e.message === unparsedClosingReference,
    );
  }));

test("64k fix-hyphen closing scan bounds repository-prefix probes", () =>
  boundary(({ repo }) => {
    const body = "fix-".repeat(16_384);
    assert.equal(body.length, 65_536);
    const original = RegExp.prototype.exec;
    let examined = 0;
    const probe = mock.method(RegExp.prototype, "exec", function (this: RegExp, input: string) {
      if ((this.sticky || this.source.startsWith("^")) && this.source.includes("[a-z0-9_.-]+")) {
        examined += input.length - (this.sticky ? this.lastIndex : 0);
        assert.ok(
          examined <= body.length * 8,
          "repository-prefix probes must not repeatedly scan the remaining suffix",
        );
      }
      return original.call(this, input);
    });
    try {
      closingGuard(repo, "emend-task-062-x", body);
    } finally {
      probe.mock.restore();
    }
    assert.throws(
      () => closingGuard(repo, "emend-task-062-x", `${body}\nCloses #9`),
      (e: unknown) => e instanceof WtError && e.code === 2,
    );
  }));

test("indexed closing references preserve emphasis around qualified references", () =>
  boundary(({ repo }) => {
    for (const marks of ["_", "__", "___", "*", "**", "~~"]) {
      closingGuard(repo, "emend-42-x", `Closes ${marks}owner/repo#42${marks}`);
      assert.throws(
        () => closingGuard(repo, "emend-42-x", `Closes #42\nFixes ${marks}other/repo#42${marks}`),
        (e: unknown) => e instanceof WtError && e.code === 2,
      );
    }
  }));

function prepareMergeIssue(repo: Repo, issue = 42): void {
  const dir = join(repo.callerTop ?? repo.mainRoot, ".wt");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "worktree.json"), JSON.stringify({ issue }));
  writeIssueSnapshot(dir, pickIssue(repo, issue, repo.callerBranch ?? undefined));
}

for (const [failure, message] of [
  ["missing snapshot", "Could not read .wt/issue.json."],
  ["edited snapshot", ".wt/issue.md differs from the snapshot."],
  ["changed body", "Live issue body differs from the snapshot."],
  ["lost approval", "Issue #42 is untrusted: ready was not added by the repository owner."],
  ["another claim", "Issue #42 is taken: local branch emend-42-other."],
  ["main checkout", "Run issue check inside an emend-<n>-<slug> issue worktree."],
] as const) {
  test(`issue PR merge runs issue check: ${failure}`, () =>
    boundary(({ repo, state, calls }) => {
      state.closing = { stdout: closingResponse([ownClosingIssue]) };
      if (failure !== "missing snapshot" && failure !== "main checkout") prepareMergeIssue(repo);
      if (failure === "edited snapshot")
        writeFileSync(join(repo.mainRoot, ".wt/issue.md"), "Changed synthetic instructions.");
      if (failure === "changed body" && state.issue) state.issue.body = "Changed approved text.";
      if (failure === "lost approval" && state.issue)
        state.issue.timelineItems = { nodes: [issueEvent("outsider")], pageInfo: { hasPreviousPage: false } };
      if (failure === "another claim") state.taken = true;
      if (failure === "main checkout") repo.callerBranch = "main";
      calls.length = 0;
      assert.throws(
        () => prMerge(repo, { pr: "7", matchHead: "a".repeat(40), subject: "T", body: "Body" }),
        (e: unknown) => e instanceof WtError && e.code === 1 && e.message === message,
      );
      assert.ok(!calls.some((call) => call.command === "gh" && call.args[1] === "merge"));
      assert.ok(!calls.some((call) => call.command === "git" && call.args.includes("fetch")));
    }));
}

test("issue PR merge accepts the same live snapshot as issue check", () =>
  boundary(({ repo, state }) => {
    prepareMergeIssue(repo);
    state.closing = { stdout: closingResponse([ownClosingIssue]) };
    assert.equal(checkIssue(repo), 42);
    assert.equal(prMerge(repo, { matchHead: "a".repeat(40), subject: "T", body: "Body" }), "QUEUED");
  }));

for (const metadata of [undefined, {}, { issue: null }, { task: "042" }]) {
  test(`closing references require issue metadata: ${JSON.stringify(metadata)}`, () =>
    boundary(({ repo }) => {
      const dir = join(repo.mainRoot, ".wt");
      rmSync(dir, { recursive: true, force: true });
      if (metadata !== undefined) {
        mkdirSync(dir, { recursive: true });
        writeFileSync(join(dir, "worktree.json"), JSON.stringify(metadata));
      }
      for (const text of ["Closes #42", "Fixes &#35;42", "Closes [the bug][ref]", "Closes #42, #9"]) {
        assert.throws(
          () => closingGuard(repo, "emend-42-x", text),
          (e: unknown) => e instanceof WtError && e.code === 2,
        );
      }
    }));
}

for (const branch of ["emend-42-issue", "emend-042-task", "emend-0-zero", "emend-100-task"]) {
  test(`setup refuses numeric emend branch without issue: ${branch}`, () =>
    boundary(({ repo, calls }) => {
      assert.throws(
        () => setup(repo, { branch, busy: new Set() }),
        (e: unknown) => e instanceof WtError && e.code === 2 && /require --issue/.test(e.message),
      );
      assert.equal(calls.length, 0);
    }));
  test(`setup command refuses numeric emend branch without issue before checking ports: ${branch}`, () =>
    boundary(async ({ repo, calls }) => {
      await assert.rejects(
        async () => worktreeCommands.setup?.({ repo, args: [branch, "--task", "042"] }),
        (e: unknown) => e instanceof WtError && e.code === 2 && /require --issue/.test(e.message),
      );
      assert.equal(calls.length, 0);
    }));
}

test("setup requires its branch number to match the supplied issue", () =>
  boundary(({ repo, calls }) => {
    assert.throws(
      () => setup(repo, { branch: "emend-42-issue", issue: 9, busy: new Set() }),
      (e: unknown) => e instanceof WtError && e.code === 2 && /match --issue/.test(e.message),
    );
    assert.equal(calls.length, 0);
  }));

for (const [name, text] of [
  ["double-quoted title", 'Fixes <a title="Closes #9" href="docs">x</a>'],
  ["single-quoted title", "Fixes <a title='Resolved #9' href='docs'>x</a>"],
  ["alt", 'Fixes <a alt="Fixes #9" href="docs">x</a>'],
  ["unquoted attribute", "Fixes <a title=Closes #9 href=docs>x</a>"],
  ["nested link", 'Fixes <a title="Closes [the bug](https://github.com/owner/repo/issues/9)" href="docs">x</a>'],
] as const) {
  test(`closing keyword scan enters consumed anchor attributes: ${name}`, () =>
    boundary(({ repo }) => {
      assert.throws(
        () => closingGuard(repo, "emend-task-062-x", text),
        (e: unknown) => e instanceof WtError && e.code === 2 && e.message === "Only issue branches may close issues.",
      );
      assert.throws(
        () => closingGuard(repo, "emend-42-x", `Closes #42\n${text}`),
        (e: unknown) =>
          e instanceof WtError && e.code === 2 && e.message === "The PR text must not close an issue other than #42.",
      );
    }));
}

test("64k overlapping closing anchors fail closed within a linear inspection budget", () =>
  boundary(({ repo }) => {
    const suffix = 'href="docs">';
    const prefix = "Fixes <a ".repeat(Math.floor((65_536 - suffix.length) / 9));
    const body = `${prefix}${" ".repeat(65_536 - prefix.length - suffix.length)}${suffix}`;
    assert.equal(body.length, 65_536);
    assert.throws(
      () => closingGuard(repo, "emend-task-062-x", body),
      (e: unknown) => e instanceof WtError && e.code === 2 && /overlapping closing links/.test(e.message),
    );
  }));

for (const mark of ["\u0315", "\u093e", "\u20dd", "\u{1d165}"]) {
  test(`closing guard bounds consecutive combining marks: ${mark.codePointAt(0)?.toString(16)}`, () =>
    boundary(({ repo }) => {
      closingGuard(repo, "emend-task-062-x", `a${mark.repeat(32)}b${mark.repeat(32)}`);
      assert.throws(
        () => closingGuard(repo, "emend-task-062-x", `a${mark.repeat(33)}`),
        (e: unknown) => e instanceof WtError && e.code === 2 && /consecutive combining marks/.test(e.message),
      );
    }));
}

test("64k combining-mark attack is refused before Unicode normalization", () =>
  boundary(({ repo }) => {
    const body = `a${"\u0315".repeat(32_767)}${"\u0300".repeat(32_767)}\n`;
    assert.equal(body.length, 65_536);
    const original = String.prototype.normalize;
    const normalize = mock.method(String.prototype, "normalize", function (this: string, form?: string) {
      assert.equal(form, "NFKD", "the attack must not reach whole-text NFKC");
      assert.equal(String(this), "a", "only the initial base code point needs classification");
      return original.call(this, form);
    });
    try {
      assert.throws(
        () => closingGuard(repo, "emend-task-062-x", body),
        (e: unknown) => e instanceof WtError && e.code === 2 && /consecutive combining marks/.test(e.message),
      );
      assert.equal(normalize.mock.callCount(), 1);
    } finally {
      normalize.mock.restore();
    }
    closingGuard(repo, "emend-task-062-x", "a\u0315".repeat(32_768));
  }));

test("64k compatibility combining marks are refused before whole-text normalization", () =>
  boundary(({ repo }) => {
    const body = "\u0301\uff9e".repeat(32_768);
    assert.equal(body.length, 65_536);
    const original = String.prototype.normalize;
    const normalized: string[] = [];
    const normalize = mock.method(String.prototype, "normalize", function (this: string, form?: string) {
      const text = String(this);
      assert.equal(form, "NFKD", "the attack must not reach whole-text NFKC");
      assert.equal([...text].length, 1, "only individual code points may be decomposed before the bound");
      normalized.push(text);
      return original.call(text, form);
    });
    try {
      assert.throws(
        () => closingGuard(repo, "emend-task-062-x", body),
        (e: unknown) => e instanceof WtError && e.code === 2 && /consecutive combining marks/.test(e.message),
      );
      assert.deepEqual(normalized, ["\uff9e"], "cache each code point's compatibility classification");
    } finally {
      normalize.mock.restore();
    }
    closingGuard(repo, "emend-task-062-x", "a\uff9e".repeat(32_768));
    for (const mark of ["\uff9e", "\uff9f"]) {
      closingGuard(repo, "emend-task-062-x", `a${mark.repeat(32)}`);
      assert.throws(
        () => closingGuard(repo, "emend-task-062-x", `a${mark.repeat(33)}`),
        (e: unknown) => e instanceof WtError && e.code === 2 && /consecutive combining marks/.test(e.message),
      );
    }
  }));

for (const metadata of [undefined, {}, { issue: null }, { issue: 9 }]) {
  test(`issue check requires matching worktree issue metadata: ${JSON.stringify(metadata)}`, () =>
    boundary(({ repo, calls }) => {
      prepareMergeIssue(repo);
      assert.equal(checkIssue(repo), 42);
      const path = join(repo.mainRoot, ".wt/worktree.json");
      if (metadata === undefined) rmSync(path);
      else writeFileSync(path, JSON.stringify(metadata));
      calls.length = 0;
      assert.throws(
        () => checkIssue(repo),
        (e: unknown) =>
          e instanceof WtError && e.code === 1 && e.message === "Worktree issue does not match the branch.",
      );
      assert.equal(calls.length, 0, "metadata is required before remote access");
    }));
}

for (const metadata of [undefined, {}, { issue: null }, { issue: 9 }]) {
  test(`closing guard requires matching issue registration before scanning: ${JSON.stringify(metadata)}`, () =>
    boundary(({ repo, calls }) => {
      const file = join(repo.mainRoot, ".wt/worktree.json");
      if (metadata === undefined) rmSync(file);
      else writeFileSync(file, JSON.stringify(metadata));
      const normalize = mock.method(String.prototype, "normalize", () => {
        throw new Error("body was scanned");
      });
      try {
        assert.throws(
          () => closingGuard(repo, "emend-42-x", "Plain description"),
          (e: unknown) => e instanceof WtError && e.code === 2 && /issue.*match.*branch/i.test(e.message),
        );
        assert.equal(normalize.mock.callCount(), 0);
        assert.equal(calls.length, 0);
      } finally {
        normalize.mock.restore();
      }
    }));
}
for (const text of [
  'Fixes "#9"',
  "Fixes '#9'",
  "Fixes - #9",
  "Fixes \\#9",
  "Fixes \u200b#9",
  "Fixes \u2060#9",
  "Fixes # 9",
  "Fixes owner#9",
  "Fixes \u{e0100}#9",
  "Fixes “#9”",
  `Fixes ${"x".repeat(79)}#9`,
  `Fixes ${"x".repeat(77)}#9`,
]) {
  test(`closing guard refuses obscured closing reference: ${text}`, () =>
    boundary(({ repo }) => {
      for (const branch of ["emend-task-062-x", "emend-42-x"]) {
        assert.throws(
          () => closingGuard(repo, branch, `${branch === "emend-42-x" ? "Closes #42\n" : ""}${text}`),
          (e: unknown) => e instanceof WtError && e.code === 2,
        );
      }
    }));
}
test("issue check refuses a symlink to an otherwise valid snapshot", () =>
  boundary(({ repo }) => {
    prepareMergeIssue(repo);
    assert.equal(checkIssue(repo), 42);
    const file = join(repo.mainRoot, ".wt/issue.json");
    const bytes = readFileSync(file);
    const target = join(repo.mainRoot, "valid-snapshot.json");
    writeFileSync(target, bytes);
    rmSync(file);
    symlinkSync(target, file);
    assert.throws(
      () => checkIssue(repo),
      (e: unknown) => e instanceof WtError && e.code === 1 && e.message === "Could not read .wt/issue.json.",
    );
    assert.deepEqual(readFileSync(target), bytes);
  }));

test("setup --issue checks owner approval before creating a worktree", () =>
  boundary(({ repo, state, calls }) => {
    state.issue = readyIssue(42, {
      timelineItems: { nodes: [issueEvent("outsider")], pageInfo: { hasPreviousPage: false } },
    });
    assert.throws(
      () => setup(repo, { branch: "emend-42-x", issue: 42, busy: new Set() }),
      (e: unknown) =>
        e instanceof WtError && e.code === 2 && /ready was not added by the repository owner/.test(e.message),
    );
    assert.ok(calls.every(readOnlyPrOrIssueOrOrigin));
    function readOnlyPrOrIssueOrOrigin(call: Call): boolean {
      return (
        readOnlyPrOrIssue(call) ||
        (call.command === "git" && ["get-url", "for-each-ref", "ls-remote"].some((arg) => call.args.includes(arg)))
      );
    }
    assert.equal(existsSync(repo.worktreesDir), false);
  }));

test("caller PR lookup requests the current author and ignores a full page of forks", () =>
  boundary(({ repo, state, calls }) => {
    state.extraPrs = Array.from({ length: 100 }, (_, i) => ({
      number: i + 8,
      state: "OPEN",
      headRefName: state.prBranch,
      isCrossRepository: true,
    }));
    assert.equal(prEdit(repo, { body: "Closes #42" }), "changed");
    const lookups = calls.filter((c) => c.command === "gh" && exactPrLookup(c));
    assert.equal(lookups.length, 2);
    assert.ok(lookups[0]?.args.some((a) => a.includes("viewer { login }") && a.includes("author { login }")));
    assert.ok(!lookups[0]?.args.some((arg) => arg.startsWith("cursor=")));
    assert.ok(lookups[1]?.args.includes("cursor=100"));
    assert.ok(!calls.some((c) => c.args[1] === "list"));
  }));

test("queue indexes branch claims once across many issues", () =>
  boundary(({ repo, state }) => {
    const count = 200;
    state.queue = Array.from({ length: count }, (_, i) => readyIssue(i + 1));
    state.branches = Array.from({ length: count }, (_, i) => `emend-${i + 1000}-synthetic`);
    const original = String.prototype.startsWith;
    let probes = 0;
    const probe = mock.method(
      String.prototype,
      "startsWith",
      function (this: string, prefix: string, position?: number) {
        if (/^emend-[0-9]+-$/u.test(prefix)) {
          probes++;
          assert.ok(probes <= count * 2, "claims must not be rescanned per issue");
        }
        return original.call(this, prefix, position);
      },
    );
    try {
      const rows = scanIssues(repo);
      assert.equal(rows.length, count);
      assert.ok(rows.every((row) => row.status === "pickable"));
    } finally {
      probe.mock.restore();
    }
  }));

test("caller PR lookup detects a second same-repository PR beyond a full fork page", () =>
  boundary(({ repo, state }) => {
    state.extraPrs = Array.from({ length: 100 }, (_, i) => ({
      number: i + 8,
      state: "OPEN",
      headRefName: state.prBranch,
      isCrossRepository: true,
    }));
    state.extraPrs.unshift({ number: 200, state: "OPEN", headRefName: state.prBranch, isCrossRepository: false });
    assert.throws(() => prEdit(repo, { body: "Closes #42" }), /More than one open pull request/);
  }));

test("caller PR lookup excludes a different author even when its branch name matches", () =>
  boundary(({ repo, state }) => {
    state.extraPrs = [
      {
        number: 8,
        state: "OPEN",
        headRefName: state.prBranch,
        isCrossRepository: false,
        author: { login: "outsider" },
      },
    ];
    assert.equal(prEdit(repo, { body: "Closes #42" }), "changed");
  }));

for (const branch of ["emend-042-x", "emend-0-x"]) {
  test(`closing guard refuses unregistered numeric branch before reading text: ${branch}`, () =>
    boundary(({ repo }) => {
      assert.throws(
        () => closingGuard(repo, branch, "Plain prose", false),
        (e: unknown) =>
          e instanceof WtError && e.code === 2 && /Worktree issue does not match the branch/.test(e.message),
      );
    }));
}

test("closing guard preserves emphasized own references and trailing word fragments", () =>
  boundary(({ repo }) => {
    for (const body of [
      "_Closes #42_",
      "Closes #42\nprefixes #9",
      "Closes #42\nsuffix#9",
      "Closes #42\nprefix#5",
      "Closes #42\nfoo#5",
    ]) {
      assert.doesNotThrow(() => closingGuard(repo, "emend-42-x", body), body);
    }
  }));

test("closing guard still refuses direct and explicitly joined ambiguous references", () =>
  boundary(({ repo }) => {
    for (const reference of ["# 5", "owner#5", "owner/repo#5"]) {
      for (const branch of ["emend-task-062-x", "emend-42-x"]) {
        const prefix = branch === "emend-42-x" ? "Closes #42\n" : "";
        assert.throws(
          () => closingGuard(repo, branch, `${prefix}Fixes ${reference}`),
          (e: unknown) => e instanceof WtError && e.code === 2,
          reference,
        );
      }
      for (const separator of [", ", "; ", " & ", " and ", " or ", " and\n"]) {
        assert.throws(
          () => closingGuard(repo, "emend-42-x", `Closes #42${separator}${reference}`),
          (e: unknown) => e instanceof WtError && e.code === 2 && e.message === unparsedClosingReference,
          `${separator}${reference}`,
        );
      }
    }
    for (const reference of ["#5", "# 5", "owner/repo#5"]) {
      assert.throws(
        () => closingGuard(repo, "emend-42-x", `Closes #42\n${reference}`),
        (e: unknown) => e instanceof WtError && e.code === 2 && e.message === unparsedClosingReference,
        reference,
      );
    }
  }));

test("branch lookup uses exact GraphQL even on its first page", () =>
  boundary(({ repo, state, calls }) => {
    repo.callerBranch = state.prBranch = "fix";
    state.prBody = "Plain body";
    state.extraPrs = [
      { number: 8, state: "OPEN", headRefName: "fix-login", isCrossRepository: false },
      { number: 9, state: "OPEN", headRefName: "fix", isCrossRepository: true },
      { number: 10, state: "OPEN", headRefName: "fix", isCrossRepository: false, author: { login: "other" } },
    ];
    assert.equal(prEdit(repo, { title: "Synthetic title" }), "changed");
    assert.ok(
      calls.some((c) => c.args.includes("head=fix") && c.args.some((a) => a.includes("pullRequests(headRefName:"))),
    );
    assert.ok(
      !calls.some((c) => c.command === "gh" && (c.args[1] === "list" || (c.args[1] === "view" && c.args[2] === "fix"))),
    );
    state.pr = false;
    assert.throws(() => prEdit(repo, { title: "Synthetic title" }), {
      code: 1,
      message: "No open pull request for this branch.",
    });
  }));

test("pr create confirms the printed number without a stale search list", () =>
  boundary(({ repo, state, calls }) => {
    state.pr = false;
    state.staleList = true;
    assert.equal(prCreate(repo, { title: "Synthetic title", body: "Closes #42", draft: false }), state.createOutput);
    assert.equal(calls.filter((c) => c.args.some((a) => a.includes("pullRequests(headRefName:"))).length, 2);
    assert.ok(
      calls.some((c) => c.args.includes("number=7") && c.args.some((a) => a.includes("closingIssuesReferences"))),
    );
    assert.ok(!calls.some((c) => c.command === "gh" && c.args[1] === "list"));
  }));

for (const missing of [true, false]) {
  test(`pr create identifies the created PR when confirmation is ${missing ? "missing" : "different"}`, () =>
    boundary(({ repo, state, calls }) => {
      state.pr = false;
      state.hideCreated = missing;
      if (!missing) state.createOutput = "https://github.com/Owner/Repo/pull/8\n";
      assert.throws(() => prCreate(repo, { title: "Synthetic title", body: "Closes #42", draft: false }), {
        code: 1,
        message: `Pull request #${missing ? 7 : 8} was created, but its exact branch lookup could not confirm it. Check it before retrying.`,
      });
      assert.ok(!calls.some((c) => c.args.some((a) => a.includes("closingIssuesReferences"))));
    }));
}

for (const stateName of ["open", "merged"]) {
  test(`pr number prints exactly one ${stateName} number with --branch from main`, () =>
    boundary(async ({ repo, state, calls }) => {
      repo.callerBranch = "main";
      state.prState = stateName.toUpperCase();
      assert.equal(
        await output(() =>
          githubCommands.pr?.({ repo, args: ["number", "--branch", state.prBranch, "--state", stateName] }),
        ),
        "7\n",
      );
      assert.ok(calls.some((c) => c.args.includes(`head=${state.prBranch}`)));
      assert.ok(calls.some((c) => c.args.some((a) => a.includes(`states: [${state.prState}]`))));
    }));
}

test("pr number defaults to the current branch and open state", () =>
  boundary(async ({ repo }) => {
    assert.equal(await output(() => githubCommands.pr?.({ repo, args: ["number"] })), "7\n");
  }));

for (const count of [0, 2]) {
  test(`pr number refuses ${count} candidates with a one-line error`, () =>
    boundary(async ({ repo, state }) => {
      state.pr = count !== 0;
      if (count === 2)
        state.extraPrs = [{ number: 8, state: "OPEN", headRefName: state.prBranch, isCrossRepository: false }];
      await assert.rejects(async () => githubCommands.pr?.({ repo, args: ["number"] }), {
        code: 1,
        message:
          count === 0
            ? "No open pull request for this branch."
            : "More than one open pull request matches this branch.",
      });
    }));
}

test("pr number rejects an unsupported state before lookup", () =>
  boundary(async ({ repo, calls }) => {
    await assert.rejects(async () => githubCommands.pr?.({ repo, args: ["number", "--state", "closed"] }), {
      code: 2,
      message: "PR state must be open or merged.",
    });
    assert.deepEqual(calls, []);
  }));

for (const tail of [', "#6"', ", \\#6", ' and "#6"', ", \u200b#6", ", - #6", ", \u{e0100}#6"]) {
  test(`closing chains skip obscuring characters before every reference: ${tail}`, () =>
    boundary(({ repo }) => {
      assert.throws(() => closingGuard(repo, "emend-42-x", `Closes #42${tail}`), {
        code: 2,
        message: unparsedClosingReference,
      });
    }));
}

for (const source of ["local", "remote", "registry", "PR"]) {
  test(`oversized ${source} claims do not abort queue, show, pick, check or merge`, () =>
    boundary(async ({ repo, state }) => {
      const branch = "emend-99999999999999999999-x";
      if (source === "local") state.branches = [branch];
      if (source === "remote") state.remoteBranches = [branch];
      if (source === "PR") state.claimPrs = [{ number: 8, headRefName: branch }];
      if (source === "registry") {
        mkdirSync(join(repo.commonDir, "emend-wt"), { recursive: true });
        writeFileSync(
          registryPath(repo),
          JSON.stringify({
            version: 1,
            reservations: {},
            worktrees: {
              [branch]: {
                path: join(repo.worktreesDir, branch),
                port: 3637,
                task: null,
                mode: "github",
                createdAt: "2026-01-01T00:00:00Z",
              },
            },
          }),
        );
      }
      assert.equal(scanIssues(repo)[0]?.status, "pickable");
      const issue = pickIssue(repo, 42);
      assert.equal(await output(() => commands.issue?.({ repo, args: ["show", "42"] })), issueSnapshotText(issue));
      prepareMergeIssue(repo);
      assert.equal(checkIssue(repo), 42);
      state.closing = { stdout: closingResponse([ownClosingIssue]) };
      assert.equal(prMerge(repo, { matchHead: "a".repeat(40), subject: "Synthetic title", body: "Body" }), "QUEUED");
    }));
}

test("pr number passes branch names as GraphQL strings", () =>
  boundary(async ({ repo, state, calls }) => {
    repo.callerBranch = "main";
    for (const branch of ["true", "null", "123"]) {
      state.prBranch = branch;
      assert.equal(await output(() => githubCommands.pr?.({ repo, args: ["number", "--branch", branch] })), "7\n");
      const args = calls.find((c) => c.args.includes(`head=${branch}`))?.args;
      assert.ok(args);
      assert.equal(args[args.indexOf(`head=${branch}`) - 1], "-f");
    }
  }));

test("help prints the exact pr number usage", () => {
  const result = childProcess.spawnSync(process.execPath, [new URL("./main.ts", import.meta.url).pathname, "help"], {
    encoding: "utf8",
  });
  assert.equal(result.status, 0, result.stderr);
  assert.ok(result.stdout.split("\n").includes("  pr number [--branch <b>] [--state open|merged]"));
});

for (const command of ["create", "edit", "merge", "land"]) {
  const heading = command === "create" || command === "edit" ? "title" : "subject";
  for (const field of [heading, "body"]) {
    for (const source of ["argument", "file"]) {
      test(`public gate checks ${command} ${field} from ${source} before closing checks or mutation`, () =>
        boundary(async ({ repo, calls }) => {
          writeFileSync(join(repo.mainRoot, ".private-terms"), "fixturecorp\n");
          const text = "fixturecorp Fixes #9";
          const file = join(repo.mainRoot, "synthetic-text.md");
          writeFileSync(file, `${text}\n`);
          if (command === "land") {
            repo.callerBranch = "feature";
            repo.callerTop = join(repo.mainRoot, "worker");
          }
          const args = [
            ...(field !== heading ? [`--${heading}`, "Synthetic heading"] : []),
            ...(field !== "body" ? ["--body", "Closes #42"] : []),
            ...(command === "merge" || command === "land" ? ["--match-head", "a".repeat(40)] : []),
            `--${field}${source === "file" ? "-file" : ""}`,
            source === "file" ? file : text,
          ];
          const invoke = () =>
            command === "land"
              ? historyCommands.land?.({ repo, args })
              : githubCommands.pr?.({ repo, args: [command, ...args] });
          const label = heading === "title" ? field : "message";
          const line = heading === "subject" && field === "body" ? 3 : 1;
          await assert.rejects(async () => invoke(), {
            code: 1,
            message: `${label}:${line}:1: private term (file line 1)`,
          });
          assert.ok(!calls.some((c) => c.command === "gh"));
          assert.ok(
            calls.every(
              (c) => c.command === "git" && ["config", "symbolic-ref", "rev-parse"].some((a) => c.args.includes(a)),
            ),
          );
        }));
    }
  }
}

for (const command of ["edit", "merge"] as const) {
  for (const field of ["title", "body"] as const) {
    test(`public gate checks inherited PR ${field} before ${command} closing checks`, () =>
      boundary(({ repo, state, calls }) => {
        writeFileSync(join(repo.mainRoot, ".private-terms"), "fixturecorp\n");
        if (field === "title") state.prTitle = "fixturecorp Fixes #9";
        else state.prBody = "fixturecorp Closes #42";
        assert.throws(
          () =>
            command === "edit"
              ? prEdit(repo, field === "title" ? { body: "Closes #42" } : { title: "Synthetic title" })
              : prMerge(repo, { matchHead: "a".repeat(40), subject: "Synthetic title", body: "Body" }),
          { code: 1, message: `${field}:1:1: private term (file line 1)` },
        );
        for (const call of calls) {
          if (readOnlyPrOrIssue(call)) continue;
          assert.equal(call.command, "git");
          assert.deepEqual(call.args.slice(0, GIT_BASE.length), GIT_BASE);
          assert.ok(
            ["for-each-ref\0--format=%(refname)\0refs/heads/", "ls-remote\0--heads\0origin"].includes(
              call.args.slice(GIT_BASE.length).join("\0"),
            ),
          );
        }
      }));
  }
}

test("issue PR merge retains the public tree gate after issue and closing checks", () =>
  boundary(({ repo, state, calls }) => {
    writeFileSync(join(repo.mainRoot, ".private-terms"), "fixturecorp\n");
    prepareMergeIssue(repo);
    state.closing = { stdout: closingResponse([ownClosingIssue]) };
    state.changeBody = "fixturecorp";
    assert.throws(() => prMerge(repo, { matchHead: "a".repeat(40), subject: "Synthetic title", body: "Body" }), {
      code: 1,
      message: "synthetic.txt:1: private term (file line 1)",
    });
    assert.ok(calls.some((c) => c.command === "git" && c.args.includes("diff-tree")));
    assert.ok(!calls.some((c) => c.command === "gh" && c.args[1] === "merge"));
    assert.ok(calls.some((c) => c.command === "git" && c.args.includes("update-ref") && c.args.includes("-d")));
  }));

test("exact GraphQL lookup redacts GitHub diagnostics", () =>
  boundary(async ({ repo, state }) => {
    writeFileSync(join(repo.mainRoot, ".private-terms"), "fixturecorp\n");
    state.lookupFailure = { status: 1, stderr: "\u001b[31mfixturecorp\u001b[0m\u202e\n" };
    await assert.rejects(async () => githubCommands.pr?.({ repo, args: ["number"] }), {
      code: 1,
      message: "gh api pull requests failed: [line withheld: private term (file line 1)]",
    });
  }));

for (const attack of [
  "fix(cli): closes #1&#50;",
  "fix(ui): x&#97;closes #1",
  "fix(ui): ｘcloses #1",
  "fix(ui): ²closes #1",
]) {
  for (const location of [
    "create title",
    "create body",
    "edit title",
    "edit body",
    "merge PR title",
    "merge PR body",
    "merge subject",
    "merge body",
  ]) {
    test(`plain closing instruction survives decoding and NFKC: ${location}: ${attack}`, () =>
      boundary(({ repo, state, calls }) => {
        repo.callerBranch = state.prBranch = "emend-12-x";
        state.issue = readyIssue(12);
        state.prBody = "Closes #12";
        state.closing = { stdout: closingResponse([{ number: 12, repository: { nameWithOwner: "owner/repo" } }]) };
        prepareMergeIssue(repo, 12);
        state.pr = !location.startsWith("create");
        calls.length = 0;
        const invoke = () => {
          if (location.startsWith("create"))
            return prCreate(repo, {
              title: location.endsWith("title") ? attack : "Fix pane",
              body: location.endsWith("body") ? `Closes #12\n${attack}` : "Closes #12",
              draft: false,
            });
          if (location.startsWith("edit"))
            return prEdit(repo, location.endsWith("title") ? { title: attack } : { body: `Closes #12\n${attack}` });
          if (location === "merge PR title") state.prTitle = attack;
          if (location === "merge PR body") state.prBody += `\n${attack}`;
          return prMerge(repo, {
            pr: "7",
            matchHead: "a".repeat(40),
            subject: location === "merge subject" ? attack : "Fix pane",
            body: location === "merge body" ? attack : "Description",
          });
        };
        assert.throws(invoke, (error: unknown) => error instanceof WtError && error.code === 2);
        for (const call of calls) {
          if (readOnlyPrOrIssue(call)) continue;
          assert.equal(call.command, "git");
          assert.deepEqual(call.args.slice(0, GIT_BASE.length), GIT_BASE);
          assert.ok(
            ["for-each-ref\0--format=%(refname)\0refs/heads/", "ls-remote\0--heads\0origin"].includes(
              call.args.slice(GIT_BASE.length).join("\0"),
            ),
          );
        }
      }));
  }
}

for (const text of [
  "fix(ui): render &copy; in footer (#42)",
  "Fixes escaping of &lt;b&gt; and &hellip; (#7)",
  "Fixes escaping of x&y; (#7)",
  "a&fix; b&mask;",
  "AT&T; Q&A; R&D;",
  "Use `x&y;` in the example.",
]) {
  test(`named references in prose pass PR title and body gates: ${text}`, () =>
    boundary(({ repo, state }) => {
      const body = `Closes #42\n\n${text}`;
      state.closing = { stdout: closingResponse([ownClosingIssue]) };
      state.pr = false;
      assert.equal(prCreate(repo, { title: text, body, draft: false }), "https://github.com/Owner/Repo/pull/7\n");
      state.pr = true;
      assert.equal(prEdit(repo, { title: text, body }), "changed");
      prepareMergeIssue(repo);
      state.prTitle = text;
      state.prBody = body;
      assert.equal(prMerge(repo, { pr: "7", matchHead: "a".repeat(40), subject: text, body }), "QUEUED");
    }));
}

for (const attack of [
  "Cl**oses** #57",
  "Closes <span>#57</span>",
  "Closes [#57](https://x.test)",
  "Clos_es_ #57",
  "Closes `#57`",
  "Fixes &num;57",
  "Fixes &num;&#53;7",
  "Fixes&num;57",
  "Fixes Owner&sol;Repo#57",
  "Fixes GH&hyphen;57",
  "Fixes GH‐57",
  "Fixes&num;#57",
  "Fixes ##57",
  "Fixes https:&sol;&sol;github.com/Owner/Repo/issues/57",
  "Fixes https://github&period;com/Owner/Repo/issues/57",
  "Fixes [see this](https:&sol;&sol;github.com/Owner/Repo/issues/57)",
  "Fixes <https:&sol;&sol;github.com/Owner/Repo/issues/57>",
  "Fixes **&num;57**",
  "&Copf;loses &num;57",
  "&Copf;loses #57",
  "Fixes&colon; #57",
  "Fixes&NonBreakingSpace;#57",
  "Fixes &NonBreakingSpace; #57",
  "Fixes #57&nbsp",
  "Fixes&#10;&num;57",
  "Closes #42 &comma; #57",
  "Fixes&NewLine;&num;57",
  "Fixes &#x23;57",
  "Fixes&nbsp;#57",
  "Fi**xes**&nbsp#57",
  "Fixes&nbsp#&nbsp57",
  "Fixes\n&num;57",
  "Fi[xe][tag]s #57\n\n[tag]: https://example.com",
  "Fi[xe][]s #57\n\n[xe]: https://example.com",
  "Fixes\n[tag]: https://example.com\n#57",
  "Fixes\n  [tag]: https://example.com\n&num;57",
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
  for (const location of [
    "create title",
    "create body",
    "edit title",
    "edit body",
    "merge PR title",
    "merge PR body",
    "merge subject",
    "merge body",
  ]) {
    // Literal line breaks belong in bodies; title validation rejects them before the closing scanner.
    if (attack.includes("\n") && !location.endsWith("body")) continue;
    test(`inline markup or named references cannot hide a foreign closing instruction: ${location}: ${attack}`, () =>
      boundary(({ repo, state, calls }) => {
        prepareMergeIssue(repo);
        state.closing = { stdout: closingResponse([ownClosingIssue]) };
        state.pr = !location.startsWith("create");
        calls.length = 0;
        const invoke = () => {
          if (location.startsWith("create"))
            return prCreate(repo, {
              title: location.endsWith("title") ? attack : "Fix pane",
              body: location.endsWith("body") ? `Closes #42\n\n${attack}` : "Closes #42",
              draft: false,
            });
          if (location.startsWith("edit"))
            return prEdit(repo, location.endsWith("title") ? { title: attack } : { body: `Closes #42\n\n${attack}` });
          if (location === "merge PR title") state.prTitle = attack;
          if (location === "merge PR body") state.prBody += `\n\n${attack}`;
          return prMerge(repo, {
            pr: "7",
            matchHead: "a".repeat(40),
            subject: location === "merge subject" ? attack : "Fix pane",
            body: location === "merge body" ? attack : "Description",
          });
        };
        assert.throws(invoke, (error: unknown) => error instanceof WtError && error.code === 2);
        for (const call of calls) {
          if (readOnlyPrOrIssue(call)) continue;
          assert.equal(call.command, "git");
          assert.deepEqual(call.args.slice(0, GIT_BASE.length), GIT_BASE);
          assert.ok(
            ["for-each-ref\0--format=%(refname)\0refs/heads/", "ls-remote\0--heads\0origin"].includes(
              call.args.slice(GIT_BASE.length).join("\0"),
            ),
          );
        }
      }));
  }
}

const SETTLE_NOW = Date.parse("2026-02-01T12:00:00Z");
const SETTLE_MERGE = { pr: "7", matchHead: "a".repeat(40), subject: "Fix pane", body: "Closes #42" };
const isClosingQuery = (call: Call) =>
  call.command === "gh" && call.args.some((arg) => arg.includes("closingIssuesReferences(first: 20)"));

for (const [name, dates, retry] of [
  ["edited one minute ago", { lastEditedAt: "2026-02-01T11:59:00Z" }, "2026-02-01T12:09:00.000Z"],
  [
    "never edited and created two minutes ago",
    { lastEditedAt: null, createdAt: "2026-02-01T11:58:00Z" },
    "2026-02-01T12:08:00.000Z",
  ],
] as const) {
  test(`merge settle window refuses a PR ${name}`, () =>
    boundary(({ repo, state, calls }) => {
      prepareMergeIssue(repo);
      state.closing = { stdout: closingResponse([ownClosingIssue], false, "Owner/Repo", dates) };
      calls.length = 0;
      assert.throws(() => prMerge(repo, SETTLE_MERGE, () => SETTLE_NOW), {
        code: 1,
        message: `GitHub may not have parsed the body yet. Retry at ${retry} (UTC). Nothing was merged.`,
      });
      assert.ok(!calls.some((call) => call.command === "gh" && call.args[1] === "merge"));
      const query = calls.find(isClosingQuery)?.args.find((arg) => arg.startsWith("query="));
      assert.ok(query);
      for (const field of ["body", "createdAt", "lastEditedAt"]) assert.match(query, new RegExp(`\\b${field}\\b`));
    }));
}

test("merge settle window permits an eleven-minute-old edit and opens at exactly ten minutes", () =>
  boundary(({ repo, state, calls }) => {
    prepareMergeIssue(repo);
    state.closing = {
      stdout: closingResponse([ownClosingIssue], false, "Owner/Repo", { lastEditedAt: "2026-02-01T11:49:00Z" }),
    };
    assert.equal(
      prMerge(repo, SETTLE_MERGE, () => SETTLE_NOW),
      "QUEUED",
    );
    const retry = Date.parse("2026-02-01T11:59:00Z");
    calls.length = 0;
    assert.throws(() => prMerge(repo, SETTLE_MERGE, () => retry - 1), { code: 1 });
    assert.ok(!calls.some((call) => call.command === "gh" && call.args[1] === "merge"));
    assert.equal(
      prMerge(repo, SETTLE_MERGE, () => retry),
      "QUEUED",
    );
  }));

test("merge settle window refuses unreadable edit times", () =>
  boundary(({ repo, state, calls }) => {
    prepareMergeIssue(repo);
    for (const dates of [{ lastEditedAt: "invalid" }, { lastEditedAt: 123 }, { createdAt: null, lastEditedAt: null }]) {
      state.closing = { stdout: closingResponse([ownClosingIssue], false, "Owner/Repo", dates) };
      calls.length = 0;
      assert.throws(() => prMerge(repo, SETTLE_MERGE, () => SETTLE_NOW), {
        code: 1,
        message: "Could not read when the pull request body last changed. Nothing was merged.",
      });
      assert.ok(!calls.some((call) => call.command === "gh" && call.args[1] === "merge"));
    }
  }));

for (const [title, body] of [
  ["Fix pane", "Closes #42\nFixes #57"],
  ["Fixes", "#57\nCloses #42"],
]) {
  test(`merge scans the closing query body together with title ${title}`, () =>
    boundary(({ repo, state, calls }) => {
      prepareMergeIssue(repo);
      state.prTitle = title as string;
      state.closing = { stdout: closingResponse([ownClosingIssue], false, "Owner/Repo", { body }) };
      calls.length = 0;
      assert.throws(() => prMerge(repo, SETTLE_MERGE, () => SETTLE_NOW), {
        code: 2,
        message: "The PR text must not close an issue other than #42.",
      });
      assert.ok(!calls.some((call) => call.command === "gh" && call.args[1] === "merge"));
    }));
}

for (const outcome of ["foreign", "own", "failed read", "incomplete read"] as const) {
  test(`post-merge closing check preserves the merged result: ${outcome}`, (t) =>
    boundary(async ({ repo, state, calls }) => {
      prepareMergeIssue(repo);
      state.merged = true;
      state.closingReplies = [
        { stdout: closingResponse([ownClosingIssue]) },
        outcome === "failed read"
          ? { status: 1, stderr: "synthetic post-merge read failure" }
          : {
              stdout: closingResponse(
                outcome === "foreign"
                  ? [
                      ownClosingIssue,
                      { number: 57, repository: { nameWithOwner: "owner/repo" } },
                      { number: 42, repository: { nameWithOwner: "other/project" } },
                    ]
                  : [ownClosingIssue],
                outcome === "incomplete read",
              ),
            },
      ];
      t.mock.method(Date, "now", () => SETTLE_NOW);
      const stdout: string[] = [];
      t.mock.method(process.stdout, "write", (chunk: string | Uint8Array) => {
        stdout.push(String(chunk));
        return true;
      });
      const invoke = () =>
        githubCommands.pr?.({
          repo,
          args: ["merge", "--pr", "7", "--match-head", "a".repeat(40), "--subject", "Fix pane", "--body", "Closes #42"],
        });
      calls.length = 0;
      if (outcome === "own") assert.equal((await invoke()) ?? 0, 0);
      else
        await assert.rejects(
          async () => invoke(),
          (error: unknown) => {
            assert.ok(error instanceof WtError);
            assert.equal(error.code, 1);
            assert.match(error.message, /^Warning:/);
            if (outcome === "foreign") {
              assert.match(error.message, /owner\/repo#57/);
              assert.match(error.message, /other\/project#42/);
              assert.match(error.message, /Check and reopen each issue/);
            } else assert.match(error.message, /post-merge closing check could not run/);
            return true;
          },
        );
      assert.deepEqual(stdout, [`MERGED ${"c".repeat(40)}\n`]);
      const queries = calls.filter(isClosingQuery);
      assert.equal(queries.length, 2);
      const merge = calls.findIndex((call) => call.command === "gh" && call.args[1] === "merge");
      assert.ok(calls.indexOf(queries[0] as Call) < merge);
      assert.ok(calls.indexOf(queries[1] as Call) > merge);
      if (outcome !== "own") assert.ok(!calls.some((call) => call.command === "git" && call.args.includes("push")));
    }));
}
