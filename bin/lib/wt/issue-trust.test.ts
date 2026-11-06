import assert from "node:assert/strict";
import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { closingGuard, commands as githubCommands } from "./github.ts";
import { spawn, writeIssueSnapshot } from "./herdr.ts";
import { commands as historyCommands } from "./history.ts";
import {
  checkIssue,
  evaluateIssue,
  githubRepository,
  indexClaims,
  issueSnapshot,
  type PickedIssue,
  sha256,
  tidy,
} from "./issues.ts";
import type { Repo } from "./repo.ts";
import { issueEdits, issueEvent, READY_AT, READY_LABEL, readyIssue } from "./test-support.ts";
import { WtError } from "./validate.ts";

const BEFORE = "2026-01-01T00:00:00Z";
const AFTER = "2026-01-03T00:00:00Z";
const timeline = (nodes: unknown[], more = false) => ({ nodes, pageInfo: { hasPreviousPage: more } });
const history = issueEdits;
const edit = (editor: string | null, editedAt = AFTER) => ({
  editedAt,
  editor: editor === null ? null : { login: editor },
});

for (const [name, extra, status] of [
  ["owner approval", {}, "pickable"],
  ["non-owner approval", { timelineItems: timeline([issueEvent("outsider")]) }, "untrusted"],
  [
    "non-owner body edit after ready",
    { lastEditedAt: AFTER, userContentEdits: history([edit("outsider")]) },
    "untrusted",
  ],
  ["deleted editor after ready", { userContentEdits: history([edit(null)]) }, "untrusted"],
  [
    "non-owner rename after ready",
    { timelineItems: timeline([issueEvent(), issueEvent("outsider", "RenamedTitleEvent", AFTER)]) },
    "untrusted",
  ],
  [
    "unlabel after ready",
    { timelineItems: timeline([issueEvent(), issueEvent("owner", "UnlabeledEvent", AFTER)]) },
    "untrusted",
  ],
  [
    "owner edits with mixed case",
    {
      lastEditedAt: BEFORE,
      userContentEdits: history([edit("OwNeR", BEFORE)]),
      timelineItems: timeline([issueEvent("oWnEr", "RenamedTitleEvent", BEFORE), issueEvent("OWNER")]),
    },
    "pickable",
  ],
  [
    "edits before approval",
    {
      userContentEdits: history([edit("owner", BEFORE)]),
      timelineItems: timeline([issueEvent("outsider", "RenamedTitleEvent", "2025-12-31T00:00:00Z"), issueEvent()]),
    },
    "pickable",
  ],
  [
    "fresh owner approval after edits",
    {
      userContentEdits: history([edit("owner", READY_AT)]),
      timelineItems: timeline([issueEvent("outsider"), issueEvent("owner", "LabeledEvent", AFTER)]),
    },
    "pickable",
  ],
  [
    "timeline hides ready",
    { timelineItems: timeline([issueEvent("owner", "RenamedTitleEvent", AFTER)], true) },
    "untrusted",
  ],
  ["edit history hides interval", { userContentEdits: history([edit("owner")], true) }, "untrusted"],
  ["empty truncated edits", { userContentEdits: history([], true) }, "untrusted"],
  ["missing last edit", { lastEditedAt: AFTER }, "untrusted"],
  [
    "truncated history reaches approval",
    {
      timelineItems: timeline([issueEvent("owner", "RenamedTitleEvent", BEFORE), issueEvent()], true),
      userContentEdits: history([edit("outsider", "2025-12-31T00:00:00Z"), edit("owner", BEFORE)], true),
      lastEditedAt: BEFORE,
    },
    "pickable",
  ],
  ["closed issue", { state: "CLOSED" }, "untrusted"],
  ["missing ready label", { labels: { nodes: [], pageInfo: { hasNextPage: false } } }, "untrusted"],
] as const) {
  test(`issue trust: ${name}`, () => {
    const result = evaluateIssue(readyIssue(42, extra), "owner", new Map(), READY_LABEL);
    assert.equal(result.row.status, status);
    if (name === "non-owner rename after ready") assert.equal(result.row.title, null);
    assert.equal(
      result.readyAt,
      name === "timeline hides ready" ? null : name === "fresh owner approval after edits" ? AFTER : READY_AT,
    );
  });
}

test("missing connection evidence and partial blockers cannot release work", () => {
  for (const extra of [
    { timelineItems: { nodes: [issueEvent()] } },
    { userContentEdits: { nodes: [] } },
    { blockedBy: { nodes: [], pageInfo: { hasNextPage: true } } },
    { labels: { nodes: [], pageInfo: { hasNextPage: true } } },
  ])
    assert.throws(
      () => evaluateIssue(readyIssue(1, extra), "owner", new Map(), READY_LABEL),
      (e: unknown) => e instanceof WtError && e.code === 69,
    );
});

test("shared eligibility checks claims by number across slugs and registry metadata", () => {
  for (const claim of [
    { branch: "emend-42-other-title", reason: "local branch" },
    { branch: "emend-other", reason: "registered worktree", issue: 42 },
    { branch: "fix-anything", reason: "open PR #9", issue: 42 },
  ])
    assert.equal(evaluateIssue(readyIssue(42), "owner", indexClaims([claim]), READY_LABEL).row.status, "taken");
  assert.equal(
    evaluateIssue(
      readyIssue(42),
      "owner",
      indexClaims([{ branch: "emend-420-other", reason: "local branch" }]),
      READY_LABEL,
    ).row.status,
    "pickable",
  );
});

test("tidy removes format characters including bidi controls and zero-width characters", () => {
  assert.equal(tidy("a\u202eb\u200bc\u2066d\uFEFFe"), "a b c d e");
});

function snapshotFixture(fn: (dir: string, issue: PickedIssue) => void) {
  const dir = mkdtempSync(join(tmpdir(), "wt-snapshot-"));
  const data = readyIssue(42, {
    title: "Fix é\t",
    body: "  Exact body\r\n\nNo final newline  ",
  });
  const issue = {
    ...evaluateIssue(data, "owner", new Map(), READY_LABEL).row,
    title: data.title as string,
    titleOwned: true,
    body: data.body as string,
    readyAt: READY_AT,
    fetchedAt: AFTER,
  };
  try {
    fn(dir, issue);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("snapshot preserves raw title/body hashes, raw Markdown and private modes", () =>
  snapshotFixture((dir, issue) => {
    writeIssueSnapshot(dir, issue);
    assert.equal(
      readFileSync(join(dir, "issue.md"), "utf8"),
      `# ${tidy(issue.title)}\n${issue.url}\nThe issue body as its owner wrote it, in Markdown.\n\n${issue.body.replaceAll("\r\n", "\n")}`,
    );
    assert.deepEqual(JSON.parse(readFileSync(join(dir, "issue.json"), "utf8")), issueSnapshot(issue));
    assert.equal(issueSnapshot(issue).bodySha256, sha256(issue.body));
    for (const name of ["issue.md", "issue.json"]) assert.equal(statSync(join(dir, name)).mode & 0o777, 0o600);
  }));

test("snapshot refuses existing files, symlink files and symlink directories", () =>
  snapshotFixture((dir, issue) => {
    const target = join(dir, "target");
    writeFileSync(target, "untouched");
    for (const name of ["issue.md", "issue.json"]) {
      symlinkSync(target, join(dir, name));
      assert.throws(() => writeIssueSnapshot(dir, issue));
      assert.equal(readFileSync(target, "utf8"), "untouched");
      rmSync(join(dir, name));
      rmSync(join(dir, "issue.md"), { force: true });
    }
    writeFileSync(join(dir, "issue.md"), "existing");
    assert.throws(() => writeIssueSnapshot(dir, issue));
    assert.equal(readFileSync(join(dir, "issue.md"), "utf8"), "existing");
    const link = join(dir, "link");
    const empty = join(dir, "empty");
    mkdirSync(empty);
    symlinkSync(empty, link);
    try {
      assert.throws(() => writeIssueSnapshot(link, issue), /not a plain directory/);
    } finally {
      assert.deepEqual(readdirSync(empty), [], "no snapshot file may be written through the directory symlink");
    }
  }));

test("issue check refuses invalid branches, mismatched metadata, and missing or unsafe snapshots before remote access", () =>
  snapshotFixture((dir, issue) => {
    const repo: Repo = {
      mainRoot: dir,
      commonDir: join(dir, ".git"),
      worktreesDir: join(dir, "worktrees"),
      callerTop: dir,
      callerBranch: "emend-42-fix",
    };
    const fails = (reason: RegExp) =>
      assert.throws(
        () => checkIssue(repo),
        (e: unknown) => e instanceof WtError && e.code === 1 && reason.test(e.message) && !e.message.includes("\n"),
      );
    for (const branch of [null, "main", "emend-042-task", "emend-0-invalid", "emend-42-"]) {
      repo.callerBranch = branch;
      fails(/issue worktree/);
    }
    repo.callerBranch = "emend-42-fix";
    fails(/does not match/);
    mkdirSync(join(dir, ".wt"));
    writeFileSync(join(dir, ".wt/worktree.json"), JSON.stringify({ issue: 43 }));
    fails(/does not match/);
    writeFileSync(join(dir, ".wt/worktree.json"), "{");
    fails(/worktree.json/);
    writeFileSync(join(dir, ".wt/worktree.json"), "{}");
    fails(/does not match/);
    writeFileSync(join(dir, ".wt/worktree.json"), JSON.stringify({ issue: 42 }));
    fails(/issue.json/);
    writeFileSync(join(dir, ".wt/issue.json"), "{}");
    fails(/Invalid issue snapshot/);
    rmSync(join(dir, ".wt/issue.json"));
    writeIssueSnapshot(dir, issue);
    symlinkSync(join(dir, "issue.json"), join(dir, ".wt/issue.json"));
    fails(/issue.json/);
  }));

test("issue spawn refuses local mode before any tool call or filesystem access", async () => {
  await assert.rejects(
    spawn({} as Repo, { issue: 42, mode: "local" }),
    (e: unknown) =>
      e instanceof WtError &&
      e.code === 2 &&
      e.message.startsWith("A local landing does not close the issue; use the github mode."),
  );
});

test("closing keywords follow the registered issue branch and scan comments and fences", () =>
  snapshotFixture((dir) => {
    const repo = { callerTop: dir } as Repo;
    const branch = "emend-42-fix-pane";
    mkdirSync(join(dir, ".wt"));
    writeFileSync(join(dir, ".wt/worktree.json"), JSON.stringify({ issue: 42 }));
    for (const body of [
      "",
      "References #42",
      "Closes #420",
      "Closes #0042",
      "Closes #42abc",
      "Discloses #42",
      "Closes #42\nFixes #9",
      "Closes #42\nResolved: GH-9",
      "<!-- Closes #9 -->\nCloses #42",
      "```\nCloses #9\n```\nCloses #42",
    ])
      assert.throws(
        () => closingGuard(repo, branch, body),
        (e: unknown) => e instanceof WtError && e.code === 2,
        body,
      );
    for (const keyword of ["close", "closes", "closed", "fix", "fixes", "fixed", "resolve", "resolves", "resolved"]) {
      closingGuard(repo, branch, `${keyword.toUpperCase()}: #42`);
    }
    for (const body of [
      "<!-- Closes #42 -->",
      "<!--\nCloses #42\n-->",
      "<!-- Closes #42",
      "```md\nCloses #42\n```",
      "~~~\nCloses #42\n~~~",
      "````\n```\nCloses #42\n````",
      "```\nCloses #42",
      "> ```\n> Closes #42\n> ```",
      "- ```\n  Closes #42\n  ```",
      "```\n> ```\nCloses #42\n```",
      "<!-- Closes #42 -->\nCloses #42",
      "```\nCloses #42\n```\nCloses #42",
      "~~~\nCloses #42\n~~~\nCloses #42",
      "```\n<!--\n```\nCloses #42",
      "<!--\n```\n-->\nCloses #42",
    ])
      closingGuard(repo, branch, body);
    for (const name of ["emend-42-Uppercase", "emend-42-你好", "emend-42-"]) {
      assert.throws(() => closingGuard(repo, name, "No closing keyword"), /must close/);
      closingGuard(repo, name, "Closes #42");
    }
    for (const task of ["emend-task-042-old-task", "042-old-task", "feature-name"])
      closingGuard(repo, task, "No closing keyword required.");
    writeFileSync(join(dir, ".wt/worktree.json"), JSON.stringify({ issue: 43 }));
    assert.throws(() => closingGuard(repo, branch, "Closes #42"), /does not match/);
  }));

test("subject-file is exclusive, bounded, no-follow, and validated like subject in merge and land", () =>
  snapshotFixture((dir) => {
    const repo = { callerTop: dir } as Repo;
    const subject = join(dir, "subject.txt");
    const body = join(dir, "body.txt");
    writeFileSync(body, "Body");
    const base = ["--match-head", "a".repeat(40), "--body-file", body];
    const commands = [
      (flags: string[]) => githubCommands.pr?.({ repo, args: ["merge", "--pr", "7", ...base, ...flags] }),
      (flags: string[]) => historyCommands.land?.({ repo, args: [...base, ...flags] }),
    ];
    for (const invoke of commands) {
      assert.throws(() => invoke(["--subject", "a", "--subject-file", subject]), /not both/);
      for (const text of ["", "two\nlines", "line\n\n", "a".repeat(73), "a\u0000b", "a".repeat(1024 * 1024 + 1)]) {
        writeFileSync(subject, text);
        assert.throws(
          () => invoke(["--subject-file", subject]),
          (e: unknown) => e instanceof WtError && e.code === 2,
        );
      }
      rmSync(subject);
      symlinkSync(body, subject);
      assert.throws(() => invoke(["--subject-file", subject]), /no symlinks/);
      rmSync(subject);
    }
  }));

test("repository identity parses GitHub SSH and HTTPS origins only", () => {
  for (const url of [
    "git@github.com:Owner/repo.git",
    "https://github.com/Owner/repo.git",
    "https://github.com/Owner/repo",
    "ssh://git@github.com/Owner/repo.git",
    "ssh://git@github.com:22/Owner/repo.git",
  ])
    assert.deepEqual(githubRepository(url), { owner: "Owner", nameWithOwner: "Owner/repo" });
  for (const url of [
    "/tmp/repo",
    "https://example.invalid/owner/repo",
    "https://github.com.evil.invalid/owner/repo",
    "https://github.com/owner/repo?x=1",
    "https://github.com/owner/repo/extra",
  ])
    assert.throws(
      () => githubRepository(url),
      (e: unknown) => e instanceof WtError && e.code === 2,
    );
});
