import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { closingGuard, commands as githubCommands, prCreate, prEdit, prMerge } from "./github.ts";
import { writeIssueSnapshot } from "./herdr.ts";
import { checkIssue, evaluateIssue, type PickedIssue, pickIssue, sha256 } from "./issues.ts";
import { type Repo, resolveRepo } from "./repo.ts";
import {
  branchPrPage,
  fakeCalls,
  fakeGithubOrigin,
  githubPage,
  gitIn,
  installFake,
  issueEdits,
  issueEvent,
  issueRules,
  makeFixture,
  makeTestEnv,
  READY_AT,
  READY_LABEL,
  readyIssue,
  runWt,
} from "./test-support.ts";
import { WtError } from "./validate.ts";

const BEFORE = "2026-01-01T00:00:00Z";
const AFTER = "2026-01-03T00:00:00Z";
const timeline = (nodes: unknown[], more = false) => ({ nodes, pageInfo: { hasPreviousPage: more } });
const history = issueEdits;
const edit = (login: string, editedAt = BEFORE) => ({ editedAt, editor: { login } });
const evaluate = (extra: Record<string, unknown> = {}, label: unknown = READY_LABEL) =>
  evaluateIssue(readyIssue(42, extra), "owner", new Map(), label).row;
const NOTICE = "The issue body as its owner wrote it, in Markdown.";

for (const [name, extra, reason] of [
  [
    "body edit tied with ready",
    { userContentEdits: history([edit("outsider", READY_AT), edit("owner", AFTER)]) },
    /body edited after ready/,
  ],
  ["truncated timeline tied with ready", { timelineItems: timeline([issueEvent()], true) }, /timeline is truncated/],
  [
    "truncated edits tied with ready",
    { userContentEdits: history([edit("owner", READY_AT)], true) },
    /body edit history is truncated/,
  ],
] as const) {
  test(`trust refuses ${name}`, () => {
    const row = evaluate(extra);
    assert.equal(row.status, "untrusted");
    assert.match(row.reason ?? "", reason);
  });
}

for (const [name, label, extra] of [
  ["renamed ready label", { ...READY_LABEL, updatedAt: AFTER }, {}],
  ["missing ready label", null, {}],
  ["different ready label id", { ...READY_LABEL, id: "replacement-label" }, {}],
] as const) {
  test(`trust refuses ${name}`, () => {
    const row = evaluate(extra, label);
    assert.equal(row.status, "untrusted");
    if (name === "renamed ready label") assert.equal(row.reason, "ready label changed after approval");
  });
}

test("the current ready label refuses a same-second rename and tracks removals by id", () => {
  const tied = evaluate({}, { ...READY_LABEL, updatedAt: READY_AT });
  assert.equal(tied.status, "untrusted");
  assert.equal(tied.reason, "ready label changed after approval");
  const removed = { ...issueEvent("owner", "UnlabeledEvent", AFTER), label: { id: READY_LABEL.id, name: "other" } };
  assert.equal(evaluate({ timelineItems: timeline([issueEvent(), removed]) }).status, "untrusted");
});

for (const [name, extra, status] of [
  ["owner-authored unedited", {}, "pickable"],
  ["stranger-authored unedited", { author: { login: "outsider" } }, "untrusted"],
  [
    "stranger-authored then owner-edited",
    {
      author: { login: "outsider" },
      lastEditedAt: BEFORE,
      userContentEdits: history([edit("OwNeR")], false, "outsider"),
    },
    "pickable",
  ],
  ["owner-authored then stranger-edited before ready", { userContentEdits: history([edit("outsider")]) }, "untrusted"],
  [
    "newest-first edits with stranger newest",
    { userContentEdits: history([edit("outsider", BEFORE), edit("owner", "2025-12-31T00:00:00Z")]) },
    "untrusted",
  ],
  ["ambiguous newest editors", { userContentEdits: history([edit("outsider"), edit("owner")]) }, "untrusted"],
] as const) {
  test(`body ownership: ${name}`, () => assert.equal(evaluate(extra).status, status));
}

for (const [name, character] of [
  ["combining grapheme joiner", "\u034f"],
  ["Hangul choseong filler", "\u115f"],
  ["Hangul jungseong filler", "\u1160"],
  ["Hangul filler", "\u3164"],
  ["halfwidth Hangul filler", "\uffa0"],
  ["format", "\u200b"],
  ["bidi format", "\u202e"],
  ["private use", "\ue000"],
  ["supplementary private use", "\u{f0000}"],
  ["unassigned", "\u0378"],
  ["tag", "\u{e0061}"],
  ["tag start", "\u{e0000}"],
  ["tag end", "\u{e007f}"],
  ["variation selector", "\ufe00"],
  ["text variation selector", "\ufe0e"],
  ["supplementary variation selector", "\u{e0100}"],
  ["last variation selector", "\u{e01ef}"],
  ["misplaced emoji selector", "\ufe0f"],
  ["misplaced joiner", "\u200d"],
  ["C0 control", "\u0000"],
  ["C1 control", "\u0085"],
  ["DEL", "\u007f"],
  ["bare CR", "\r"],
  ["joiner lacking pictograph after", "👩\u200dx"],
  ["joiner lacking pictograph before", "x\u200d💻"],
]) {
  for (const field of ["title", "body"]) {
    test(`invisible ${name} in ${field} is untrusted`, () => {
      const row = evaluate({ [field]: `Visible ${character} text` });
      assert.equal(row.status, "untrusted");
      assert.equal(row.reason, "invisible characters in the title or body");
    });
  }
}

test("visible emoji joiners and selectors, tabs and CRLF stay trusted", () => {
  for (const text of ["👩‍💻", "👩️‍💻️", "👩‍👩‍👧‍👦", "❤️", "Visible\r\n\ttext"]) {
    assert.equal(evaluate({ title: text, body: text }).status, "pickable", text);
  }
});

for (const renamedAt of [BEFORE, "2026-01-01T12:00:00Z"]) {
  test(`stranger title at ${renamedAt} is omitted independently of body approval`, () => {
    const row = evaluate({
      author: { login: "outsider" },
      lastEditedAt: BEFORE,
      userContentEdits: history([edit("owner", BEFORE)], false, "outsider"),
      timelineItems: timeline([issueEvent("outsider", "RenamedTitleEvent", renamedAt), issueEvent()]),
    });
    assert.equal(row.status, "pickable");
    assert.equal(row.title, null);
  });
}

test("an unedited owner's body does not approve a stranger's renamed title", () => {
  const row = evaluate({
    timelineItems: timeline([issueEvent("outsider", "RenamedTitleEvent", BEFORE), issueEvent()]),
  });
  assert.equal(row.status, "pickable");
  assert.equal(row.title, null);
});

test("incomplete rename history omits the title even when the newest visible rename is by the owner", () => {
  const row = evaluate({
    timelineItems: timeline([issueEvent("owner", "RenamedTitleEvent", "2026-01-01T12:00:00Z"), issueEvent()], true),
  });
  assert.equal(row.status, "pickable");
  assert.equal(row.title, null);
});

test("an owner body edit after a stranger rename approves only the body", () => {
  const row = evaluate({
    author: { login: "outsider" },
    lastEditedAt: "2026-01-01T12:00:00Z",
    userContentEdits: history([edit("owner", "2026-01-01T12:00:00Z")], false, "outsider"),
    timelineItems: timeline([issueEvent("outsider", "RenamedTitleEvent", BEFORE), issueEvent()]),
  });
  assert.equal(row.status, "pickable");
  assert.equal(row.title, null);
});

async function scenario(
  fn: (ctx: {
    env: ReturnType<typeof makeTestEnv>;
    fx: ReturnType<typeof makeFixture>;
    repo: ReturnType<typeof resolveRepo>;
  }) => void | Promise<void>,
) {
  const env = makeTestEnv({ ports: false });
  try {
    const fx = makeFixture(env, { withBin: true });
    fakeGithubOrigin(env, fx);
    await fn({ env, fx, repo: resolveRepo(fx.main) });
  } finally {
    env.cleanup();
  }
}

function localSnapshot(fn: (dir: string, issue: PickedIssue, repo: Repo) => void) {
  const top = mkdtempSync(join(tmpdir(), "wt-issue-snapshot-"));
  const dir = join(top, ".wt");
  mkdirSync(dir);
  writeFileSync(join(dir, "worktree.json"), JSON.stringify({ issue: 42 }));
  const data = readyIssue(42);
  const issue: PickedIssue = {
    ...evaluate(),
    title: data.title as string,
    titleOwned: true,
    body: data.body as string,
    readyAt: READY_AT,
    fetchedAt: AFTER,
  };
  const repo: Repo = {
    mainRoot: top,
    commonDir: join(top, ".git"),
    worktreesDir: join(top, "worktrees"),
    callerTop: top,
    callerBranch: "emend-42-fix",
  };
  try {
    fn(dir, issue, repo);
  } finally {
    rmSync(top, { recursive: true, force: true });
  }
}

test("snapshot uses raw Markdown, normalized newlines and exact byte hashes", () =>
  localSnapshot((dir, issue) => {
    issue.body =
      "Visible.\r\n~~~md\n**Visible instruction**  \n- [ ] Keep spacing\n~~~\n![Screenshot](https://github.com/user-attachments/assets/01234567-89ab-cdef-0123-456789abcdef)";
    issue.title = "  Fix\tthe pane  ";
    assert.equal(evaluate({ body: issue.body }).status, "pickable");
    writeIssueSnapshot(dir, issue);
    const bytes = readFileSync(join(dir, "issue.md"));
    assert.equal(bytes.toString(), `# Fix the pane\n${issue.url}\n${NOTICE}\n\n${issue.body.replaceAll("\r\n", "\n")}`);
    assert.match(bytes.toString(), /\*\*Visible instruction\*\* {2}\n- \[ \] Keep spacing/);
    const snapshot = JSON.parse(readFileSync(join(dir, "issue.json"), "utf8"));
    assert.equal(snapshot.snapshotSha256, sha256(bytes));
    assert.equal(snapshot.bodySha256, sha256(issue.body));
    assert.equal(snapshot.titleSha256, sha256(issue.title));
  }));

for (const mutation of ["modified", "deleted", "symlinked", "directory", "oversized", "BOM"] as const) {
  test(`issue check refuses ${mutation} issue.md`, () =>
    localSnapshot((dir, issue, repo) => {
      writeIssueSnapshot(dir, issue);
      const path = join(dir, "issue.md");
      const original = readFileSync(path);
      rmSync(path);
      if (mutation === "modified") writeFileSync(path, "Changed instructions");
      if (mutation === "symlinked") {
        const target = join(dir, "target.md");
        writeFileSync(target, original);
        symlinkSync(target, path);
      }
      if (mutation === "directory") mkdirSync(path);
      if (mutation === "oversized") writeFileSync(path, "a".repeat(1024 * 1024 + 1));
      if (mutation === "BOM") writeFileSync(path, Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), original]));
      assert.throws(
        () => checkIssue(repo),
        (e: unknown) => e instanceof WtError && e.code === 1 && /issue.md/.test(e.message),
      );
    }));
}

test("issue show prints exactly the spawn snapshot without creating files", () =>
  scenario(async ({ env, fx, repo }) => {
    installFake(env, "gh", issueRules([readyIssue(42, { body: "Visible\r\nNo final newline" })]));
    const out = await runWt(join(fx.main, "bin/wt"), ["issue", "show", "42"], { cwd: fx.main });
    assert.equal(out.code, 0, out.stderr);
    assert.equal(existsSync(join(fx.main, ".wt")), false);
    assert.equal(existsSync(repo.worktreesDir), false);
    assert.equal(gitIn(fx.main, "status", "--porcelain"), "");
    const dir = join(env.root, "snapshot");
    mkdirSync(dir);
    writeIssueSnapshot(dir, pickIssue(repo, 42));
    assert.equal(out.stdout, readFileSync(join(dir, "issue.md"), "utf8"));
    assert.deepEqual(fakeCalls(env, "herdr"), []);
    const help = await runWt(join(fx.main, "bin/wt"), ["help"], { cwd: fx.main });
    assert.match(help.stdout, /issue show <n> \[--taken\]/);
  }));

for (const state of ["untrusted", "blocked", "taken", "missing", "unavailable"] as const) {
  test(`issue show matches spawn's ${state} refusal`, () =>
    scenario(async ({ env, fx }) => {
      const issue = readyIssue(
        42,
        state === "untrusted"
          ? { author: { login: "outsider" } }
          : state === "blocked"
            ? { blockedBy: { nodes: [{ number: 9, state: "OPEN" }], pageInfo: { hasNextPage: false } } }
            : {},
      );
      if (state === "taken") gitIn(fx.main, "branch", "emend-42-taken");
      const rules =
        state === "unavailable"
          ? [{ code: 1, stderr: "network is unreachable" }]
          : issueRules(state === "missing" ? [] : [issue]);
      installFake(env, "gh", rules);
      const show = await runWt(join(fx.main, "bin/wt"), ["issue", "show", "42"], { cwd: fx.main });
      const spawn = await runWt(join(fx.main, "bin/wt"), ["spawn", "--issue", "42"], {
        cwd: fx.main,
        env: { HERDR_ENV: "1" },
      });
      assert.equal(show.code, state === "taken" ? 3 : state === "unavailable" ? 69 : 2, show.stderr);
      assert.equal(show.stdout, "");
      assert.equal(show.code, spawn.code);
      assert.equal(show.stderr, spawn.stderr);
    }));
}

test("queue and pick fetch the current label identity and raw body", () =>
  scenario(({ env, repo }) => {
    installFake(env, "gh", issueRules([readyIssue(42)]));
    pickIssue(repo, 42);
    const query =
      fakeCalls(env, "gh")
        .find((c) => c.includes("number=42"))
        ?.find((a) => a.startsWith("query=")) ?? "";
    assert.match(query, /label\(name: "ready"\)\s*\{\s*id updatedAt\s*\}/);
    assert.doesNotMatch(query, /bodyText/);
    assert.match(query, /\bbody\b/);
    for (const type of ["LabeledEvent", "UnlabeledEvent"])
      assert.match(query, new RegExp(`on ${type} \\{ createdAt label \\{ id name \\}`));
    for (const label of [null, { ...READY_LABEL, updatedAt: AFTER }, { ...READY_LABEL, id: "other" }]) {
      installFake(env, "gh", [
        { match: ["number=42"], stdout: githubPage({ issue: readyIssue(42), label }) },
        ...issueRules([]),
      ]);
      assert.throws(() => pickIssue(repo, 42), /untrusted/);
    }
  }));

test("untrusted queue titles never reach table or JSON output", () =>
  scenario(async ({ env, fx }) => {
    const title = "UNTRUSTED INSTRUCTION";
    installFake(env, "gh", issueRules([readyIssue(42, { title, timelineItems: timeline([issueEvent("outsider")]) })]));
    for (const flags of [[], ["--json"]]) {
      const out = await runWt(join(fx.main, "bin/wt"), ["issues", ...flags], { cwd: fx.main });
      assert.equal(out.code, 0, out.stderr);
      assert.doesNotMatch(out.stdout, /UNTRUSTED INSTRUCTION/);
      if (flags.length) {
        const [row] = JSON.parse(out.stdout);
        assert.equal(row.title, null);
        assert.deepEqual(Object.keys(row).sort(), ["number", "reason", "status", "title"]);
      } else assert.equal(out.stdout, "#42  untrusted (ready was not added by the repository owner)\n");
    }
  }));

const otherReferences = [
  "#9",
  "GH-9",
  "owner/repo#9",
  "other/repo#42",
  "https://github.com/other/repo/issues/42",
  "http://github.com/owner/repo/issues/9/",
  "www.github.com/owner/repo/issues/9/",
  "https://www.github.com/owner/repo/issues/9/",
];
for (const ref of otherReferences) {
  test(`closing guard rejects ${ref} in all PR text`, () =>
    scenario(({ env, fx, repo }) => {
      const branch = "emend-42-fix";
      gitIn(fx.main, "checkout", "--quiet", "-b", branch);
      repo.callerBranch = branch;
      mkdirSync(join(fx.main, ".wt"));
      writeFileSync(join(fx.main, ".wt/worktree.json"), JSON.stringify({ issue: 42 }));
      const pr = {
        number: 7,
        state: "OPEN",
        baseRefName: "main",
        headRefName: branch,
        isCrossRepository: false,
        headRefOid: "a".repeat(40),
        title: "Fix pane",
        body: "Closes #42",
      };
      installFake(env, "gh", [
        { match: ["api", "graphql", `head=${branch}`], stdout: branchPrPage([pr]) },
        { match: ["pr", "view", "7"], stdout: JSON.stringify(pr) },
        ...issueRules([readyIssue(42)]),
      ]);
      writeIssueSnapshot(join(fx.main, ".wt"), pickIssue(repo, 42, branch));
      const refuses = (fn: () => unknown) =>
        assert.throws(fn, (e: unknown) => e instanceof WtError && e.code === 2 && /must not close/.test(e.message));
      for (const text of [`Fixes: ${ref}`, `\`\`\`\nFixes ${ref}\n\`\`\``, `<!-- Fixes ${ref} -->`]) {
        refuses(() => prCreate(repo, { title: "T", body: `Closes #42\n${text}`, draft: false }));
        refuses(() => prEdit(repo, { body: `Closes #42\n${text}` }));
        refuses(() => prMerge(repo, { pr: "7", matchHead: "a".repeat(40), subject: "Fix pane", body: text }));
      }
      refuses(() => prCreate(repo, { title: `Fixes ${ref}`, body: "Closes #42", draft: false }));
      refuses(() => prEdit(repo, { title: `Fixes ${ref}` }));
      refuses(() => prMerge(repo, { pr: "7", matchHead: "a".repeat(40), subject: `Fixes ${ref}`, body: "Body" }));
      assert.ok(
        fakeCalls(env, "gh").every(
          (c) =>
            ["view", "list"].includes(c[1] ?? "") ||
            (c[0] === "api" &&
              c[1] === "graphql" &&
              c.some(
                (arg) =>
                  arg.startsWith("query=query(") &&
                  (arg.includes("issue(number:") ||
                    arg.includes("pullRequests(states:") ||
                    arg.includes("pullRequests(headRefName:")),
              )),
        ),
      );
    }));
}

test("closing guard recognizes every keyword and same-repository full reference", () =>
  scenario(({ repo, fx }) => {
    mkdirSync(join(fx.main, ".wt"));
    writeFileSync(join(fx.main, ".wt/worktree.json"), JSON.stringify({ issue: 42 }));
    for (const keyword of ["close", "closes", "closed", "fix", "fixes", "fixed", "resolve", "resolves", "resolved"]) {
      for (const ref of [
        "#42",
        "OWNER/REPO#42",
        "https://github.com/OWNER/REPO/issues/42",
        "http://github.com/owner/repo/issues/42/",
        "www.github.com/owner/repo/issues/42/",
        "https://www.github.com/owner/repo/issues/42/",
      ]) {
        closingGuard(repo, "emend-42-fix", `${keyword.toUpperCase()}:\n${ref}`);
      }
    }
    assert.throws(
      () => closingGuard(repo, "emend-42-fix", "Closes #42\nFixes GH-42"),
      /Text after a closing keyword looks like an issue reference/,
    );
    assert.throws(() => closingGuard(repo, "emend-42-fix", "Closes GH-42"), /must close/);
    assert.throws(() => closingGuard(repo, "feature", "Closes other/repo#9"), /only issue branches/i);
  }));

for (const command of ["create", "edit"]) {
  test(`pr ${command} accepts literal title-file and rejects unsafe files`, () =>
    scenario(async ({ env, fx, repo }) => {
      gitIn(fx.main, "checkout", "--quiet", "-b", "feature");
      repo.callerBranch = "feature";
      installFake(env, "gh", [
        {
          match: ["api", "graphql", "head=feature"],
          ...(command === "create"
            ? { stdout: branchPrPage([]), times: 1 }
            : {
                stdout: branchPrPage([{ number: 7, state: "OPEN", headRefName: "feature", isCrossRepository: false }]),
              }),
        },
        {
          match: ["api", "graphql", "head=feature"],
          stdout: branchPrPage([{ number: 7, state: "OPEN", headRefName: "feature", isCrossRepository: false }]),
        },
        { match: ["pr", command], stdout: command === "create" ? "https://github.com/owner/repo/pull/7\n" : "ok" },
        {
          match: ["api", "graphql"],
          stdout: githubPage({
            pullRequest: { closingIssuesReferences: { nodes: [], pageInfo: { hasNextPage: false } } },
          }),
        },
      ]);
      const file = join(env.root, "title.txt");
      const title = 'fix: literal $(false) `false` $HOME "quotes"';
      writeFileSync(file, `${title}\r\n`);
      const out = await runWt(join(fx.main, "bin/wt"), ["pr", command, "--title-file", file, "--body", "Body"], {
        cwd: fx.main,
      });
      assert.equal(out.code, 0, out.stderr);
      assert.ok(fakeCalls(env, "gh").some((c) => c.includes(`--title=${title}`)));
      const invoke = (args: string[]) => githubCommands.pr?.({ repo, args: [command, "--body", "Body", ...args] });
      assert.throws(() => invoke(["--title", "T", "--title-file", file]), /not both/);
      for (const value of ["", "two\nlines", "line\n\n", "a".repeat(73), "a\u0000b", "a".repeat(1024 * 1024 + 1)]) {
        writeFileSync(file, value);
        assert.throws(
          () => invoke(["--title-file", file]),
          (e: unknown) => e instanceof WtError && e.code === 2,
        );
      }
      rmSync(file);
      assert.throws(() => invoke(["--title-file", file]), /no symlinks/);
      symlinkSync(join(fx.main, "bin/wt"), file);
      assert.throws(() => invoke(["--title-file", file]), /no symlinks/);
      rmSync(file);
      mkdirSync(file);
      assert.throws(() => invoke(["--title-file", file]), /no symlinks/);
      const help = await runWt(join(fx.main, "bin/wt"), ["help"], { cwd: fx.main });
      assert.match(help.stdout, /--title-file <path>/);
    }));
}

test("edit pagination must cover every version tied for newest even before ready", () => {
  const row = evaluate({ userContentEdits: history([edit("owner", BEFORE)], true) });
  assert.equal(row.status, "untrusted");
  assert.equal(row.reason, "body edit history is truncated around the newest version");
  const covered = evaluate({
    userContentEdits: history([edit("owner", BEFORE), edit("outsider", "2025-12-31T00:00:00Z")], true),
  });
  assert.equal(covered.status, "pickable");
});

test("edit history in the wrong order fails closed instead of choosing a different newest version", () => {
  const edits = history([edit("owner", BEFORE)]);
  edits.nodes.reverse();
  const row = evaluate({ userContentEdits: edits });
  assert.equal(row.status, "untrusted");
  assert.equal(row.reason, "body edit history is not newest first");
});

for (const createdAt of [BEFORE, READY_AT]) {
  test(`never-edited owner issue requires ready after creation at ${createdAt}`, () => {
    const row = evaluate({
      createdAt,
      lastEditedAt: null,
      userContentEdits: { nodes: [], totalCount: 0, pageInfo: { hasNextPage: false } },
    });
    assert.equal(row.status, createdAt === READY_AT ? "untrusted" : "pickable");
    assert.equal(
      row.reason,
      createdAt === READY_AT ? "ready must be strictly later than the newest body version" : null,
    );
  });
}

test("never-edited stranger issue is refused based on the original body writer", () => {
  const row = evaluate({
    author: { login: "outsider" },
    lastEditedAt: null,
    userContentEdits: { nodes: [], totalCount: 0, pageInfo: { hasNextPage: false } },
  });
  assert.equal(row.status, "untrusted");
  assert.equal(row.reason, "current body was not written by the repository owner");
});

for (const [name, lastEditedAt, nodes, more] of [
  ["null lastEditedAt with versions", null, [edit("owner", BEFORE)], false],
  ["non-null lastEditedAt without versions", BEFORE, [], false],
  ["null lastEditedAt with incomplete history", null, [], true],
] as const) {
  test(`inconsistent edit history is refused: ${name}`, () => {
    const row = evaluate({
      lastEditedAt,
      userContentEdits: { nodes, pageInfo: { hasNextPage: more } },
    });
    assert.equal(row.status, "untrusted");
    assert.match(row.reason ?? "", /edit history|last edit/);
  });
}

for (const renamedAt of [READY_AT, AFTER]) {
  for (const actor of ["outsider", null]) {
    test(`non-owner rename at ${renamedAt} by ${actor} invalidates ready`, () => {
      const row = evaluate({
        timelineItems: timeline([issueEvent(), issueEvent(actor, "RenamedTitleEvent", renamedAt)]),
      });
      assert.equal(row.status, "untrusted");
      assert.equal(row.title, null);
      assert.equal(row.reason, "renamed after ready by someone other than the owner");
    });
  }
}

for (const time of [READY_AT, AFTER]) {
  for (const source of ["owner edit", "creation", "owner rename"]) {
    test(`ready must follow ${source} strictly: ${time}`, () => {
      const extra =
        source === "owner edit"
          ? { userContentEdits: history([edit("owner", time)]) }
          : source === "creation"
            ? { createdAt: time }
            : { timelineItems: timeline([issueEvent(), issueEvent("owner", "RenamedTitleEvent", time)]) };
      const row = evaluate(extra);
      assert.equal(row.status, "untrusted");
      assert.match(row.reason ?? "", /ready must be strictly later/);
    });
  }
}
