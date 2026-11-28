import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs, {
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { delimiter, join } from "node:path";
import { afterEach, beforeEach, test } from "node:test";
import { pathToFileURL } from "node:url";
import {
  addFinding,
  approveFindings,
  claimFindings,
  type FindingInput,
  findingsDir,
  groomNext,
  groomVisited,
  listFindings,
  releaseFindings,
  releaseOrphanedClaim,
  resolveFinding,
  resolveMergedFindings,
  showFinding,
} from "./findings.ts";
import { renderTriagePage } from "./findings-page.ts";
import { stateDir, withStateLock } from "./registry.ts";
import { type Repo, resolveRepo } from "./repo.ts";
import {
  commitFile,
  deadPid,
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

let env: TestEnv;
let fx: Fixture;
let repo: Repo;

beforeEach(() => {
  env = makeTestEnv({ ports: false });
  fx = makeFixture(env, { withBin: true });
  repo = resolveRepo(fx.main);
});
afterEach(() => env.cleanup());

function input(overrides: Partial<FindingInput> = {}): FindingInput {
  return {
    title: "Handle the empty selection",
    detail: "An empty selection must keep the current document.\n\tAdd a regression case.",
    path: "README.md",
    line: 1,
    kind: "bug",
    severity: "medium",
    size: "small",
    source: { kind: "review", branch: "recense-fixture", round: "1" },
    ...overrides,
  };
}

function cli(...args: string[]) {
  return runWt(join(fx.main, "bin", "findings"), args, { cwd: fx.main });
}

function inputFile(value: unknown = input()): string {
  const file = join(env.root, "finding.json");
  writeFileSync(file, JSON.stringify(value));
  return file;
}

function stored(id: string): string {
  return join(findingsDir(repo), `${id}.json`);
}

function fails(code: number) {
  return (error: unknown) => error instanceof WtError && error.code === code;
}

function target() {
  return { branch: "recense-fix-selection", worktree: fx.main };
}

test("add prints its id and stores a private, open version 1 record", async () => {
  const result = await cli("add", "--file", inputFile());
  assert.equal(result.code, 0, result.stderr);
  assert.match(result.stdout, /^f-[0-9a-f]{12}\n$/);
  const id = result.stdout.trim();
  assert.deepEqual(readdirSync(findingsDir(repo)), [`${id}.json`]);
  assert.equal(statSync(stateDir(repo)).mode & 0o777, 0o700);
  assert.equal(statSync(findingsDir(repo)).mode & 0o777, 0o700);
  assert.equal(statSync(stored(id)).mode & 0o777, 0o600);
  const record = JSON.parse(readFileSync(stored(id), "utf8"));
  const anchor = createHash("sha256").update("fixture").digest("hex");
  const fingerprint = createHash("sha256").update(["README.md", "bug", "", anchor].join("\n")).digest("hex");
  assert.equal(id, `f-${fingerprint.slice(0, 12)}`);
  assert.deepEqual(record, {
    ...input(),
    version: 1,
    id,
    fingerprint,
    anchor,
    commit: gitIn(fx.main, "rev-parse", "HEAD"),
    state: "open",
    createdAt: record.createdAt,
  });
  assert.equal(new Date(record.createdAt).toISOString(), record.createdAt);
  const shown = await cli("show", id);
  assert.equal(shown.code, 0, shown.stderr);
  assert.deepEqual(JSON.parse(shown.stdout), { ...record, orphaned: false });
});

test("add refuses unknown keys and overlong fields with exit 2", async () => {
  for (const value of [
    { ...input(), extra: true },
    input({ title: "a".repeat(121) }),
    input({ detail: "a".repeat(4001) }),
  ]) {
    const result = await cli("add", "--file", inputFile(value));
    assert.equal(result.code, 2, result.stderr);
    assert.equal(result.stdout, "");
    assert.equal(existsSync(stateDir(repo)), false);
  }
});

test("input validation rejects missing, malformed and wrongly typed fields without writing", () => {
  const missing = { ...input() } as Record<string, unknown>;
  delete missing.detail;
  for (const value of [
    null,
    [],
    missing,
    { ...input(), title: 1 },
    { ...input(), line: "1" },
    input({ title: "two\nlines" }),
    input({ title: "hidden\u200btext" }),
    input({ detail: "control\u0007" }),
    input({ detail: "hidden\u200btext" }),
    input({ path: "../file" }),
    input({ path: "/file" }),
    input({ path: "a//b" }),
    input({ path: "a/./b" }),
    input({ path: "a\\b" }),
    input({ path: "a\nb" }),
    input({ path: "a".repeat(301) }),
    input({ line: 0 }),
    input({ line: 1.5 }),
    input({ line: Number.MAX_SAFE_INTEGER + 1 }),
    input({ rule: "Bad rule" }),
    { ...input(), kind: "unknown" },
    { ...input(), severity: "urgent" },
    { ...input(), size: "tiny" },
    { ...input(), source: { kind: "review", branch: "main", round: "1" } },
    { ...input(), source: { kind: "review", branch: "recense-fixture", round: "1", pass: "1" } },
    { ...input(), source: { kind: "groom", pass: "Invalid" } },
    { ...input(), source: { kind: "groom", pass: "1", extra: true } },
  ])
    assert.throws(() => addFinding(repo, value), fails(2));
  assert.equal(existsSync(stateDir(repo)), false);
  const accepted = addFinding(repo, input({ title: "😀".repeat(120), source: { kind: "groom", pass: "first-pass" } }));
  assert.equal(showFinding(repo, accepted.id).title, "😀".repeat(120));
});

test("add requires regular bounded UTF-8 JSON input and safe flags", async () => {
  const file = inputFile();
  const link = join(env.root, "input-link");
  symlinkSync(file, link);
  assert.equal((await cli("add", "--file", link)).code, 2);
  assert.equal((await cli("add", "--file", env.root)).code, 2);
  for (const content of ["{", "[]", Buffer.from([0xff]), "a".repeat(1024 * 1024 + 1)]) {
    writeFileSync(file, content);
    assert.equal((await cli("add", "--file", file)).code, 2);
  }
  for (const args of [
    ["add"],
    ["add", "--file"],
    ["list", "--json=true"],
    ["show"],
    ["release"],
    ["show", "../bad"],
    ["list", "--path", "../bad"],
  ]) {
    assert.equal((await cli(...args)).code, 2);
  }
  const refused = ["gh", "p_", "Ab01".repeat(9)].join("");
  const result = await cli("list", `--${refused}`);
  assert.equal(result.code, 2);
  assert.equal(result.stderr.includes(refused), false);
  assert.equal(existsSync(stateDir(repo)), false);
});

test("add refuses untracked paths and lines beyond the committed blob", async () => {
  writeFileSync(join(fx.main, "untracked.md"), "untracked\n");
  const result = await cli("add", "--file", inputFile(input({ path: "untracked.md" })));
  assert.equal(result.code, 2, result.stderr);
  writeFileSync(join(fx.main, "README.md"), "worktree\nextra\nlines\n");
  assert.throws(() => addFinding(repo, input({ line: 3 })), fails(2));
  assert.equal(existsSync(findingsDir(repo)), false);
  assert.equal(addFinding(repo, input()).created, true);
});

test("a final newline ends a line and an empty blob has no lines", async () => {
  commitFile(fx.main, "empty.md", "");
  for (const value of [input({ line: 2 }), input({ path: "empty.md" })]) {
    const result = await cli("add", "--file", inputFile(value));
    assert.equal(result.code, 2, result.stderr);
    assert.equal(result.stdout, "");
    assert.equal(existsSync(findingsDir(repo)), false);
  }
  commitFile(fx.main, "two-lines.md", "a\nb");
  const result = await cli("add", "--file", inputFile(input({ path: "two-lines.md", line: 2 })));
  assert.equal(result.code, 0, result.stderr);
  assert.equal(showFinding(repo, result.stdout.trim()).anchor, createHash("sha256").update("b").digest("hex"));
});

test("add and list path filters refuse invisible and line-separator characters", async () => {
  for (const character of ["\u202e", "\u200b", "\u2028", "\u2029"]) {
    const path = `docs/${character}note.md`;
    const added = await cli("add", "--file", inputFile(input({ path })));
    const listed = await cli("list", "--path", path);
    for (const result of [added, listed]) {
      assert.equal(result.code, 2, result.stderr);
      assert.equal(result.stdout, "");
      assert.equal(result.stderr.includes(path), false);
    }
    assert.equal(existsSync(stateDir(repo)), false);
  }
});

test("add anchors the captured commit even when HEAD moves after rev-parse", () => {
  const original = gitIn(fx.main, "rev-parse", "HEAD");
  const later = commitFile(fx.main, "README.md", "replacement\n");
  gitIn(fx.main, "update-ref", "HEAD", original);
  const git = join(env.fakeBin, "git");
  const realGit = realpathSync(git);
  rmSync(git);
  writeFileSync(
    git,
    `#!${process.execPath}
const { spawnSync } = require("node:child_process");
const args = process.argv.slice(2);
const capturing = args.at(-2) === "rev-parse" && args.at(-1) === "HEAD";
const result = spawnSync(${JSON.stringify(realGit)}, args, {
  stdio: capturing ? ["inherit", "pipe", "inherit"] : "inherit",
});
if (capturing && result.status === 0) {
  const moved = spawnSync(${JSON.stringify(realGit)}, ["update-ref", "HEAD", ${JSON.stringify(later)}], {
    stdio: "inherit",
  });
  if (moved.status !== 0) process.exit(1);
  process.stdout.write(result.stdout);
}
process.exitCode = result.status ?? 1;
`,
    { mode: 0o755 },
  );
  const result = addFinding(repo, input());
  const finding = showFinding(repo, result.id);
  assert.equal(finding.commit, original);
  assert.equal(finding.anchor, createHash("sha256").update("fixture").digest("hex"));
  assert.equal(gitIn(fx.main, "rev-parse", "HEAD"), later);
});

test("only regular tracked UTF-8 blobs are accepted, with literal paths", () => {
  commitFile(fx.main, "docs/note[1].md", "first\nsecond");
  assert.equal(addFinding(repo, input({ path: "docs/note[1].md", line: 2 })).created, true);
  assert.throws(() => addFinding(repo, input({ path: "docs" })), fails(2));
  assert.throws(() => addFinding(repo, input({ path: ":(glob)*" })), fails(2));
  symlinkSync("README.md", join(fx.main, "link.md"));
  writeFileSync(join(fx.main, "binary.bin"), Buffer.from([0xff, 0xfe]));
  gitIn(fx.main, "add", "--", "link.md", "binary.bin");
  gitIn(fx.main, "update-index", "--add", "--cacheinfo", `160000,${gitIn(fx.main, "rev-parse", "HEAD")},module`);
  gitIn(fx.main, "commit", "--quiet", "-m", "add synthetic non-regular entries");
  for (const path of ["link.md", "binary.bin", "module"])
    assert.throws(() => addFinding(repo, input({ path })), fails(2));
});

test("secret-shaped detail exits 2 with a field and rule label, never the text", async () => {
  const secret = ["gh", "p_", "Ab01".repeat(9)].join("");
  const result = await cli("add", "--file", inputFile(input({ detail: secret })));
  assert.equal(result.code, 2);
  assert.match(result.stderr, /^detail: .*secret.*\n$/);
  assert.equal(result.stderr.includes(secret), false);
  assert.equal(result.stdout, "");
  assert.equal(existsSync(stateDir(repo)), false);
  for (const field of ["title", "path", "rule"] as const) {
    assert.throws(
      () => addFinding(repo, input({ [field]: secret })),
      (error) =>
        error instanceof WtError &&
        error.code === 2 &&
        error.message.startsWith(`${field}:`) &&
        !error.message.includes(secret),
    );
  }
});

test("moving a line three lines down dedupes and leaves the original record unchanged", async () => {
  const file = inputFile();
  const first = await cli("add", "--file", file);
  assert.equal(first.code, 0, first.stderr);
  const id = first.stdout.trim();
  const before = readFileSync(stored(id));
  commitFile(fx.main, "README.md", "one\ntwo\nthree\n  fixture  \n");
  inputFile(input({ line: 4, title: "A later title" }));
  const second = await cli("add", "--file", file);
  assert.equal(second.code, 3, second.stderr);
  assert.equal(second.stdout, first.stdout);
  assert.deepEqual(readFileSync(stored(id)), before);
});

test("simultaneous child-process adds leave one record and return 0 and 3", async () => {
  const file = inputFile();
  const results = await Promise.all([cli("add", "--file", file), cli("add", "--file", file)]);
  assert.deepEqual(results.map((result) => result.code).sort(), [0, 3]);
  assert.equal(results[0]?.stdout, results[1]?.stdout);
  assert.deepEqual(readdirSync(findingsDir(repo)), [`${results[0]?.stdout.trim()}.json`]);
});

test("a linked worktree uses its own HEAD and the shared finding store", () => {
  const worktree = join(env.root, "linked");
  gitIn(fx.main, "worktree", "add", "--quiet", "-b", "recense-linked", worktree);
  const commit = commitFile(worktree, "linked.md", "linked content\n");
  const linkedRepo = resolveRepo(worktree);
  const result = addFinding(linkedRepo, input({ path: "linked.md" }));
  assert.equal(showFinding(repo, result.id).commit, commit);
  assert.equal(findingsDir(linkedRepo), findingsDir(repo));
  assert.throws(() => addFinding(repo, input({ path: "linked.md" })), fails(2));
});

async function triagePage(cwd = fx.main): Promise<{ page: string | null; key: string; findings: string[] }> {
  const result = await runWt(join(fx.main, "bin/findings"), ["page"], { cwd });
  assert.equal(result.code, 0, result.stderr);
  return JSON.parse(result.stdout);
}

test("page groups findings in page order, fences their text and excerpts main HEAD", async () => {
  const path = "docs/guide`/chapter.md";
  const lines = Array.from({ length: 16 }, (_, i) => `source line ${i + 1}.`);
  lines[7] = "````";
  commitFile(fx.main, path, `${lines.join("\n")}\n`);
  commitFile(fx.main, "private.md", "private excerpt marker\n");
  function record(day: number, fields: Partial<FindingInput>): string {
    const id = addFinding(repo, input(fields)).id;
    const data = JSON.parse(readFileSync(stored(id), "utf8"));
    writeFileSync(stored(id), JSON.stringify({ ...data, createdAt: `2026-01-0${day}T00:00:00.000Z` }));
    return id;
  }
  const security = record(1, {
    path: "private.md",
    kind: "security",
    title: "private title marker",
    detail: "private detail marker",
  });
  const first = record(2, { path, line: 8, title: "`a``b`", detail: "before\n```\n### literal text" });
  const root = record(3, {});
  const second = record(4, { path, line: 9 });
  const large = record(5, { size: "large", rule: "large", title: "Large change" });
  writeFileSync(join(fx.main, path), "working tree marker\n");

  const { page, findings } = await triagePage();
  const directory = join(fx.main, ".wt");
  assert.equal(page, join(directory, "triage.md"));
  assert.deepEqual(readdirSync(directory), ["triage.md"]);
  assert.equal(statSync(directory).mode & 0o777, 0o700);
  assert.equal(statSync(page).mode & 0o777, 0o600);
  assert.deepEqual(findings, [first, second, root, large]);
  const text = readFileSync(page, "utf8");
  assert.deepEqual(text.match(/^#{1,3} .+$/gm), [
    "# Findings triage",
    "## How to answer",
    "## `` docs/guide` ``",
    `### ${first}`,
    "### literal text", // Inside the detail's text fence.
    `### ${second}`,
    "## `README.md`",
    `### ${root}`,
    "## Not for /e-fix",
    `### ${large}`,
  ]);
  const block = text.slice(text.indexOf(`### ${first}`), text.indexOf(`### ${second}`));
  assert.ok(block.includes("bug · medium · small · ``docs/guide`/chapter.md:8`` · 2026-01-02T00:00:00.000Z"));
  assert.ok(block.includes("\n\n``` `a``b` ```\n\n````text\nbefore\n```\n### literal text\n````\n"));
  assert.ok(block.includes(["", "", "`````", ...lines.slice(1, 14), "`````", ""].join("\n")));
  assert.doesNotMatch(block, /source line (1|15)\./);
  assert.doesNotMatch(text, /working tree marker|private\.md|private (title|detail|excerpt) marker/);
  assert.ok(!text.includes(security));
  const count =
    "1 security findings are open. They stay on this machine: list them with `bin/findings list --state open --kind security`.";
  assert.equal(text.split(count).length, 2);
  assert.ok(text.indexOf("## How to answer") < text.indexOf(count) && text.indexOf(count) < text.indexOf("## `"));
  assert.ok(text.includes("`Large change`"));
});

test("page with only security findings gives their open count and no triage ids", async () => {
  const ids = ["first", "second", "third"].map((rule) => addFinding(repo, input({ kind: "security", rule })).id);
  resolveFinding(repo, ids[0] as string, { stale: true });
  const { page, findings } = await triagePage();
  assert.ok(page);
  assert.deepEqual(findings, []);
  const text = readFileSync(page, "utf8");
  assert.match(text, /^2 security findings are open\./m);
  assert.doesNotMatch(text, /^### |f-[0-9a-f]{12}|## Not for \/e-fix|README\.md/m);
});

test("page shortens finding ids in titles, details, excerpts and paths while preserving id headings", async () => {
  const other = addFinding(repo, input()).id;
  const short = `${other.slice(0, 6)}…`;
  const path = `docs/${other}/guide.md`;
  commitFile(fx.main, path, `line ${other}\n`);
  const id = addFinding(repo, input({ path, title: other, detail: `See ${other} and ${other}.` })).id;
  const { page, findings } = await triagePage();
  assert.ok(page);
  const text = readFileSync(page, "utf8");
  assert.deepEqual(text.match(/f-[0-9a-f]{12}/g), findings);
  for (const heading of [other, id]) assert.ok(text.includes(`\n### ${heading}\n`));
  assert.ok(text.includes(`\n\n\`${short}\`\n\n`));
  assert.ok(text.includes(`\nSee ${short} and ${short}.\n`));
  assert.ok(text.includes(`\nline ${short}\n`));
});

test("page omits untracked files present on disk and symlinks tracked by main", async () => {
  const linked = join(env.root, "linked");
  gitIn(fx.main, "worktree", "add", "--quiet", "-b", "recense-linked", linked);
  const linkedRepo = resolveRepo(linked);
  for (const path of ["local.md", "link.md"]) {
    commitFile(linked, path, "linked excerpt marker\n");
    addFinding(linkedRepo, input({ path }));
  }
  writeFileSync(join(fx.main, "local.md"), "untracked excerpt marker\n");
  symlinkSync("local.md", join(fx.main, "link.md"));
  gitIn(fx.main, "add", "--", "link.md");
  gitIn(fx.main, "commit", "--quiet", "-m", "track the link");
  const { page } = await triagePage();
  assert.ok(page);
  const text = readFileSync(page, "utf8");
  assert.equal(text.split("Not tracked as a file in the main checkout's HEAD.").length - 1, 2);
  assert.doesNotMatch(text, /excerpt marker/);
});

test("page omits excerpts for oversized blobs, NUL bytes and invalid UTF-8", async () => {
  const files = [
    ["large.txt", "x".repeat(1024 * 1024 + 1)],
    ["binary.txt", "binary marker\0tail"],
  ] as const;
  for (const [path, content] of files) {
    commitFile(fx.main, path, "plain text\n");
    addFinding(repo, input({ path }));
    commitFile(fx.main, path, content);
  }
  addFinding(repo, input());
  writeFileSync(join(fx.main, "README.md"), Buffer.from([0x61, 0xff, 0x62]));
  gitIn(fx.main, "commit", "--quiet", "-am", "store invalid UTF-8");
  const { page } = await triagePage();
  assert.ok(page);
  const text = readFileSync(page, "utf8");
  assert.equal(text.split("The file is too large or not text.").length - 1, 3);
  assert.doesNotMatch(text, /binary marker|x{10}|plain text|\uFFFD/);
});

test("page omits the excerpt when the recorded line is past the end of HEAD", async () => {
  commitFile(fx.main, "README.md", "first\nrecorded\n");
  addFinding(repo, input({ line: 2 }));
  commitFile(fx.main, "README.md", "last remaining line\n");
  const { page } = await triagePage();
  assert.ok(page);
  const text = readFileSync(page, "utf8");
  assert.ok(text.includes("Line 2 is past the end of the file in the main checkout's HEAD."));
  assert.doesNotMatch(text, /last remaining line/);
});

test("page warns on a changed anchor and treats surrounding whitespace as the same line", async () => {
  addFinding(repo, input());
  commitFile(fx.main, "README.md", "\tfixture  \r\n");
  const { page } = await triagePage();
  assert.ok(page);
  const warning = "The recorded line changed since the finding was recorded.";
  assert.ok(!readFileSync(page, "utf8").includes(warning));
  commitFile(fx.main, "README.md", "updated excerpt\n");
  await triagePage();
  assert.ok(readFileSync(page, "utf8").includes(`\nupdated excerpt\n\`\`\`\n\n${warning}`));
});

test("page reports a blob read failure after finding the tracked file in HEAD", () => {
  const finding = showFinding(repo, addFinding(repo, input()).id);
  const blob = gitIn(fx.main, "rev-parse", "HEAD:README.md");
  rmSync(join(env.fakeBin, "git"));
  installFake(env, "git", [
    { match: ["ls-tree"], stdout: `100644 blob ${blob}       8\tREADME.md\0` },
    { match: ["cat-file", "blob", blob], code: 1 },
  ]);
  const page = renderTriagePage(repo, [finding]);
  assert.ok(page?.markdown.includes("Could not read the file from the main checkout's HEAD."));
});

test("page reports an invalid ls-tree size without reading the blob", () => {
  const finding = showFinding(repo, addFinding(repo, input()).id);
  const blob = gitIn(fx.main, "rev-parse", "HEAD:README.md");
  rmSync(join(env.fakeBin, "git"));
  installFake(env, "git", [{ match: ["ls-tree"], stdout: `100644 blob ${blob}     BAD\tREADME.md\0` }]);
  const page = renderTriagePage(repo, [finding]);
  assert.ok(page?.markdown.includes("Could not read the file from the main checkout's HEAD."));
  assert.ok(!fakeCalls(env, "git").some((args) => args.includes("cat-file")));
});

test("page reports a read failure when HEAD names a missing directory tree", () => {
  commitFile(fx.main, "docs/a.md", "fixture\n");
  const finding = showFinding(repo, addFinding(repo, input({ path: "docs/a.md" })).id);
  const tree = spawnSync("git", ["mktree", "--missing"], {
    cwd: fx.main,
    input: `040000 tree ${"1".repeat(40)}\tdocs\n`,
    encoding: "utf8",
  });
  assert.equal(tree.status, 0, tree.stderr);
  const commit = gitIn(fx.main, "commit-tree", tree.stdout.trim(), "-p", "HEAD", "-m", "reference a missing tree");
  gitIn(fx.main, "update-ref", "HEAD", commit);

  const page = renderTriagePage(repo, [finding]);
  assert.ok(page);
  assert.ok(page.markdown.includes("Could not read the file from the main checkout's HEAD."));
  assert.ok(!page.markdown.includes("Not tracked as a file in the main checkout's HEAD."));
});

test("page reports a read failure when HEAD names a missing blob", () => {
  const finding = showFinding(repo, addFinding(repo, input()).id);
  const tree = spawnSync("git", ["mktree", "--missing"], {
    cwd: fx.main,
    input: `100644 blob ${"1".repeat(40)}\tREADME.md\n`,
    encoding: "utf8",
  });
  assert.equal(tree.status, 0, tree.stderr);
  const commit = gitIn(fx.main, "commit-tree", tree.stdout.trim(), "-p", "HEAD", "-m", "reference a missing blob");
  gitIn(fx.main, "update-ref", "HEAD", commit);

  const page = renderTriagePage(repo, [finding]);
  assert.ok(page);
  assert.ok(page.markdown.includes("Could not read the file from the main checkout's HEAD."));
  assert.ok(!page.markdown.includes("Not tracked as a file in the main checkout's HEAD."));
});

test("page writes nothing without untriaged findings and returns a stable key per checkout", async () => {
  const empty = await triagePage();
  const key = `e-triage-${createHash("sha256").update(realpathSync(fx.main)).digest("hex").slice(0, 12)}`;
  assert.deepEqual(empty, { page: null, key, findings: [] });
  assert.equal(existsSync(join(fx.main, ".wt")), false);
  const other = join(env.root, "other-main");
  gitIn(fx.main, "clone", "--quiet", fx.main, other);
  assert.notEqual((await triagePage(other)).key, key);
  const id = addFinding(repo, input()).id;
  const outside = join(env.root, "previous-page");
  writeFileSync(outside, "preserve this file\n");
  mkdirSync(join(fx.main, ".wt"), { mode: 0o700 });
  symlinkSync(outside, join(fx.main, ".wt", "triage.md"));
  const written = await triagePage();
  assert.equal(written.key, key);
  assert.ok(written.page);
  assert.ok(lstatSync(written.page).isFile());
  assert.equal(readFileSync(outside, "utf8"), "preserve this file\n");
  const before = statSync(written.page);
  approveFindings(repo, [id], "P2");
  assert.deepEqual(await triagePage(), empty);
  assert.deepEqual(statSync(written.page), before);
});

test("page refuses linked worktrees, arguments and a symlinked .wt folder", async () => {
  addFinding(repo, input());
  const linked = join(env.root, "linked");
  gitIn(fx.main, "worktree", "add", "--quiet", "-b", "recense-linked", linked);
  const result = await runWt(join(fx.main, "bin/findings"), ["page"], { cwd: linked });
  assert.equal(result.code, 2);
  assert.equal(result.stderr.trim(), "Only the main checkout writes the triage page. Nothing was changed.");
  assert.equal((await cli("page", "extra")).code, 2);
  assert.equal(existsSync(join(fx.main, ".wt")), false);
  const outside = join(env.root, "outside");
  mkdirSync(outside);
  symlinkSync(outside, join(fx.main, ".wt"));
  assert.equal((await cli("page")).code, 2);
  assert.deepEqual(readdirSync(outside), []);
});

test("approve records a priority for every id from main and replaces the priority and time", async () => {
  const first = addFinding(repo, input()).id;
  const second = addFinding(repo, input({ rule: "second" })).id;
  const result = await cli("approve", first, second, "--priority", "P2");
  assert.equal(result.code, 0, result.stderr);
  const approval = showFinding(repo, first).approval;
  assert.ok(approval);
  assert.equal(approval.priority, "P2");
  assert.equal(new Date(approval.at).toISOString(), approval.at);
  assert.deepEqual(showFinding(repo, second).approval, approval);
  const updated = await cli("approve", first, "--priority", "P0");
  assert.equal(updated.code, 0, updated.stderr);
  const replacement = showFinding(repo, first).approval;
  assert.ok(replacement && replacement.at > approval.at);
  assert.equal(replacement.priority, "P0");
  assert.deepEqual(showFinding(repo, second).approval, approval);
});

test("approve refuses a linked worktree and leaves the finding untriaged", async () => {
  const id = addFinding(repo, input()).id;
  const worktree = join(env.root, "linked");
  gitIn(fx.main, "worktree", "add", "--quiet", "-b", "recense-linked", worktree);
  const result = await runWt(join(fx.main, "bin/findings"), ["approve", id, "--priority", "P1"], { cwd: worktree });
  assert.equal(result.code, 2);
  assert.equal(result.stderr.trim(), "Only the main checkout approves findings. Nothing was changed.");
  assert.equal(showFinding(repo, id).approval, undefined);
});

test("approve rejects an invalid priority or id and refuses a mixed batch atomically", async () => {
  const open = addFinding(repo, input()).id;
  const claimed = addFinding(repo, input({ rule: "claimed" })).id;
  const resolved = addFinding(repo, input({ rule: "stale" })).id;
  const security = addFinding(repo, input({ kind: "security" })).id;
  const large = addFinding(repo, input({ rule: "large", size: "large" })).id;
  approveFindings(repo, [claimed], "P2");
  claimFindings(repo, [claimed], target());
  resolveFinding(repo, resolved, { stale: true });
  const before = listFindings(repo);
  for (const id of [claimed, resolved, security, large, "f-000000000000"]) {
    const result = await cli("approve", open, id, "--priority", "P0");
    if (id === security || id === large) {
      assert.equal(result.code, 2);
      assert.equal(result.stderr.trim(), "/e-fix does not take security or large findings. Nothing was changed.");
    } else {
      assert.equal(result.code, 1);
      assert.equal(
        result.stderr.trim(),
        id === "f-000000000000" ? "Unknown finding." : `Finding ${id} is claimed or resolved. Nothing was changed.`,
      );
    }
    assert.deepEqual(listFindings(repo), before);
  }
  for (const args of [
    [open, "--priority", "P3"],
    [open],
    ["--priority", "P1"],
    [open, open, "--priority", "P1"],
    [open, "bad", "--priority", "P1"],
  ]) {
    assert.equal((await cli("approve", ...args)).code, 2);
    assert.deepEqual(listFindings(repo), before);
  }
});

test("skip dismisses untriaged findings together from main with the owner's triage reason", async () => {
  const ids = [addFinding(repo, input()).id, addFinding(repo, input({ rule: "large", size: "large" })).id];
  const result = await cli("skip", ...ids);
  assert.equal(result.code, 0, result.stderr);
  for (const id of ids) {
    const finding = showFinding(repo, id);
    assert.equal(finding.state, "dismissed");
    assert.equal(finding.resolution?.reason, "skipped by the owner in triage");
  }
});

test("skip refuses a linked worktree and leaves the finding open", async () => {
  const id = addFinding(repo, input()).id;
  const linked = join(env.root, "linked");
  gitIn(fx.main, "worktree", "add", "--quiet", "-b", "recense-linked", linked);
  const result = await runWt(join(fx.main, "bin/findings"), ["skip", id], { cwd: linked });
  assert.equal(result.code, 2);
  assert.equal(result.stderr.trim(), "Only the main checkout skips findings. Nothing was changed.");
  assert.equal(showFinding(repo, id).state, "open");
});

test("skip leaves the batch unchanged for claimed, resolved, approved, unknown or invalid ids", async () => {
  const open = addFinding(repo, input()).id;
  const claimed = addFinding(repo, input({ rule: "claimed" })).id;
  const resolved = addFinding(repo, input({ rule: "stale" })).id;
  const approved = addFinding(repo, input({ rule: "approved" })).id;
  approveFindings(repo, [claimed, approved], "P2");
  claimFindings(repo, [claimed], target());
  resolveFinding(repo, resolved, { stale: true });
  const before = listFindings(repo);
  for (const id of [claimed, resolved, approved]) {
    const result = await cli("skip", open, id);
    assert.equal(result.code, 1);
    assert.equal(result.stderr.trim(), `Finding ${id} is claimed, resolved or approved. Nothing was changed.`);
    assert.deepEqual(listFindings(repo), before);
  }
  const unknown = await cli("skip", open, "f-000000000000");
  assert.equal(unknown.code, 1);
  assert.equal(unknown.stderr.trim(), "Unknown finding.");
  for (const args of [[], [open, open], [open, "bad"]]) assert.equal((await cli("skip", ...args)).code, 2);
  assert.deepEqual(listFindings(repo), before);
});

test("claim rejects unapproved, security, large, non-open, unknown and invalid ids as one batch", () => {
  const open = addFinding(repo, input()).id;
  const security = addFinding(repo, input({ kind: "security" })).id;
  const large = addFinding(repo, input({ rule: "large", size: "large" })).id;
  const claimed = addFinding(repo, input({ rule: "claimed" })).id;
  const untriaged = addFinding(repo, input({ rule: "untriaged" })).id;
  approveFindings(repo, [open, claimed], "P2");
  claimFindings(repo, [claimed], target());
  const before = listFindings(repo);
  assert.throws(() => claimFindings(repo, [open, untriaged], target()), {
    code: 2,
    message: `Finding ${untriaged} is not approved for fixing. Run /e-triage first. Nothing was changed.`,
  });
  for (const id of [security, large, claimed, "f-000000000000"]) {
    assert.throws(() => claimFindings(repo, [open, id], target()), fails(1));
    assert.deepEqual(listFindings(repo), before);
  }
  assert.throws(() => claimFindings(repo, [open, "../bad"], target()), fails(2));
  assert.throws(() => claimFindings(repo, [open], { ...target(), worktree: "relative" }), fails(2));
  assert.throws(() => claimFindings(repo, [open], { ...target(), branch: "main" }), fails(2));
  assert.deepEqual(listFindings(repo), before);
});

test("claim accepts and stores a worktree under a home folder", () => {
  const id = addFinding(repo, input()).id;
  approveFindings(repo, [id], "P1");
  const worktree = ["", "ho" + "me", "worker" + "-name", "src", "repo"].join("/");
  claimFindings(repo, [id], { ...target(), worktree });
  const record = JSON.parse(readFileSync(stored(id), "utf8"));
  assert.equal(record.state, "claimed");
  assert.equal(record.claim.worktree, worktree);
  assert.deepEqual(listFindings(repo), [{ ...record, orphaned: true }]);
});

test("orphan release rechecks every claim field and the worktree directory", () => {
  const { id } = addFinding(repo, input());
  approveFindings(repo, [id], "P1");
  const worktree = join(env.root, "returning-worker");
  claimFindings(repo, [id], { ...target(), worktree });
  const seen = showFinding(repo, id).claim;
  assert.ok(seen);
  const unexpectedLockCheck = () => assert.fail("only a matching orphaned claim needs a lock check");
  for (const changed of [{ branch: "other" }, { worktree: fx.main }, { at: "2000-01-01T00:00:00.000Z" }]) {
    assert.equal(releaseOrphanedClaim(repo, id, { ...seen, ...changed }, unexpectedLockCheck), false);
    assert.deepEqual(showFinding(repo, id).claim, seen);
  }
  mkdirSync(worktree);
  assert.equal(releaseOrphanedClaim(repo, id, seen, unexpectedLockCheck), false);
  assert.deepEqual(showFinding(repo, id).claim, seen);
  rmSync(worktree, { recursive: true });
  const released = releaseOrphanedClaim(repo, id, seen, (path) => {
    assert.equal(path, worktree);
    assert.ok(existsSync(join(stateDir(repo), "findings.lock")));
    return false;
  });
  assert.equal(released, true);
  assert.equal(releaseOrphanedClaim(repo, id, seen, unexpectedLockCheck), false);
});

test("claim worktree paths reject combining-mark runs and URL passwords without changing storage", () => {
  const id = addFinding(repo, input()).id;
  const before = readFileSync(stored(id));
  const secret = ["gh", "p_", "Ab01".repeat(9)].join("");
  const url = ["https://", "user", ":", "synthetic", "-password", "@", "host", "/x"].join("");
  for (const [suffix, label] of [
    [`${"\u0301".repeat(40)}${secret}`, "combining-mark run"],
    [url, "URL password"],
  ]) {
    const worktree = `${env.root}/${suffix}`;
    assert.throws(
      () => claimFindings(repo, [id], { ...target(), worktree }),
      (error) => error instanceof WtError && error.code === 2 && error.message === `claim worktree: ${label}`,
    );
    assert.deepEqual(readFileSync(stored(id)), before);
    assert.deepEqual(readdirSync(findingsDir(repo)), [`${id}.json`]);
    assert.deepEqual(readdirSync(stateDir(repo)), ["findings"]);
  }
});

test("claim worktree paths reject secrets in inline SVG images without changing storage", () => {
  const id = addFinding(repo, input()).id;
  const before = readFileSync(stored(id));
  const secret = ["gh", "p_", "Ab01".repeat(9)].join("");
  const svg = `<svg xmlns="http://www.w3.org/2000/svg"><text>${secret}</text></svg>`;
  const worktree = `${env.root}/data:image/svg+xml;base64,${Buffer.from(svg).toString("base64")}`;
  assert.throws(
    () => claimFindings(repo, [id], { ...target(), worktree }),
    (error) =>
      error instanceof WtError && error.code === 2 && error.message === "claim worktree (inline image): secret shape",
  );
  assert.deepEqual(readFileSync(stored(id)), before);
  assert.deepEqual(readdirSync(findingsDir(repo)), [`${id}.json`]);
  assert.equal(existsSync(join(stateDir(repo), "findings.lock")), false);
});

test("claim worktree paths reject secrets, invisible text, separators and overlong input", () => {
  const id = addFinding(repo, input()).id;
  const before = readFileSync(stored(id));
  const secret = ["gh", "p_", "Ab01".repeat(9)].join("");
  for (const suffix of [secret, "\u202e", "\u200b", "\u2028", "\u2029", "\n", "a".repeat(4096)]) {
    const worktree = join(env.root, suffix);
    assert.throws(
      () => claimFindings(repo, [id], { ...target(), worktree }),
      (error) =>
        error instanceof WtError &&
        error.code === 2 &&
        !error.message.includes(worktree) &&
        (suffix !== secret || (error.message.startsWith("claim worktree:") && !error.message.includes(secret))),
    );
    assert.deepEqual(readFileSync(stored(id)), before);
    assert.deepEqual(readdirSync(findingsDir(repo)), [`${id}.json`]);
    assert.equal(existsSync(join(stateDir(repo), "findings.lock")), false);
  }
});

for (const action of ["claim", "release"] as const) {
  for (const failure of ["staging", "rename"] as const) {
    test(`${action} restores both records after a second-record ${failure} failure`, (t) => {
      const ids = [addFinding(repo, input()).id, addFinding(repo, input({ rule: "second" })).id];
      approveFindings(repo, ids, "P1");
      if (action === "release") claimFindings(repo, ids, target());
      // Noncanonical whitespace must also survive rollback byte for byte.
      for (const id of ids) {
        const record = JSON.parse(readFileSync(stored(id), "utf8"));
        writeFileSync(stored(id), ` ${JSON.stringify(record)}\n\n`);
      }
      const before = ids.map((id) => readFileSync(stored(id)));
      const originalFsync = fs.fsyncSync;
      const originalRename = fs.renameSync;
      let staged = 0;
      let renamed = 0;
      const fsync = t.mock.method(fs, "fsyncSync", (fd: number) => {
        if (++staged === 2 && failure === "staging") throw new Error("synthetic staging failure");
        originalFsync(fd);
      });
      const rename = t.mock.method(fs, "renameSync", (...args: Parameters<typeof fs.renameSync>) => {
        assert.ok(staged >= 2, "all records must be staged before the first rename");
        if (++renamed === 2 && failure === "rename") throw new Error("synthetic rename failure");
        originalRename(...args);
      });
      syncBuiltinESMExports();
      try {
        assert.throws(
          () => (action === "claim" ? claimFindings(repo, ids, target()) : releaseFindings(repo, ids)),
          (error) => error instanceof WtError && error.code === 1 && error.message.includes("Nothing was changed"),
        );
      } finally {
        fsync.mock.restore();
        rename.mock.restore();
        syncBuiltinESMExports();
      }
      assert.equal(staged, failure === "staging" ? 2 : 3);
      assert.equal(renamed, failure === "staging" ? 0 : 3);
      assert.deepEqual(
        ids.map((id) => readFileSync(stored(id))),
        before,
      );
      assert.deepEqual(readdirSync(findingsDir(repo)).sort(), ids.map((id) => `${id}.json`).sort());
      for (const id of ids) assert.equal(statSync(stored(id)).mode & 0o777, 0o600);
      assert.equal(existsSync(join(stateDir(repo), "findings.lock")), false);
    });
  }
}

test("a failed rollback reports possible changes and cleans up remaining temp files", (t) => {
  const first = addFinding(repo, input()).id;
  const second = addFinding(repo, input({ rule: "second" })).id;
  approveFindings(repo, [first, second], "P1");
  const originalRename = fs.renameSync;
  let renamed = 0;
  const mocked = t.mock.method(fs, "renameSync", (...args: Parameters<typeof fs.renameSync>) => {
    if (++renamed >= 2) throw new Error("synthetic rename and rollback failure");
    originalRename(...args);
  });
  syncBuiltinESMExports();
  try {
    assert.throws(
      () => claimFindings(repo, [first, second], target()),
      (error) =>
        error instanceof WtError &&
        error.code === 1 &&
        error.message.includes("Some findings may have changed") &&
        error.message.includes("bin/findings list") &&
        !error.message.includes("Nothing was changed"),
    );
  } finally {
    mocked.mock.restore();
    syncBuiltinESMExports();
  }
  assert.equal(renamed, 3);
  assert.equal(showFinding(repo, first).state, "claimed");
  assert.equal(showFinding(repo, second).state, "open");
  assert.deepEqual(readdirSync(findingsDir(repo)).sort(), [`${first}.json`, `${second}.json`].sort());
  assert.equal(existsSync(join(stateDir(repo), "findings.lock")), false);
});

test("resolve and release implement state transitions and clear claims", async () => {
  const fixed = addFinding(repo, input()).id;
  const released = addFinding(repo, input({ rule: "released" })).id;
  const stale = addFinding(repo, input({ rule: "stale" })).id;
  const dismissed = addFinding(repo, input({ rule: "dismissed" })).id;
  approveFindings(repo, [fixed, released, stale, dismissed], "P0");
  const approval = showFinding(repo, fixed).approval;
  claimFindings(repo, [fixed, released], target());
  const commit = commitFile(fx.main, "fix.md", "local fix\n");
  assert.equal((await cli("resolve", fixed, "--fixed", commit)).code, 0);
  assert.equal((await cli("release", released)).code, 0);
  assert.equal((await cli("resolve", stale, "--stale")).code, 0);
  assert.equal((await cli("resolve", dismissed, "--dismissed", "Covered by the existing test")).code, 0);
  for (const [id, state] of [
    [fixed, "fixed"],
    [released, "open"],
    [stale, "stale"],
    [dismissed, "dismissed"],
  ]) {
    const finding = showFinding(repo, id as string);
    assert.equal(finding.state, state);
    assert.deepEqual(finding.approval, approval);
    assert.equal(Object.hasOwn(finding, "claim"), false);
  }
  assert.equal(showFinding(repo, fixed).resolution?.commit, commit);
  assert.equal(showFinding(repo, dismissed).resolution?.reason, "Covered by the existing test");
  assert.deepEqual(Object.keys(showFinding(repo, stale).resolution ?? {}), ["at"]);
  for (const id of [fixed, stale, dismissed]) {
    const before = readFileSync(stored(id));
    assert.equal((await cli("resolve", id, "--stale")).code, 1);
    assert.deepEqual(readFileSync(stored(id)), before);
  }
});

test("a linked worktree can release and resolve only its own claims", async () => {
  const branch = "recense-linked";
  const worktree = join(env.root, "linked");
  gitIn(fx.main, "worktree", "add", "--quiet", "-b", branch, worktree);
  const alias = join(env.root, "alias");
  symlinkSync(worktree, alias);
  const own = addFinding(repo, input()).id;
  const otherBranch = addFinding(repo, input({ rule: "other-branch" })).id;
  const otherPath = addFinding(repo, input({ rule: "other-path" })).id;
  const open = addFinding(repo, input({ rule: "open" })).id;
  approveFindings(repo, [own, otherBranch, otherPath], "P1");
  claimFindings(repo, [own], { branch, worktree: alias });
  claimFindings(repo, [otherBranch], { branch: "other-worker", worktree });
  claimFindings(repo, [otherPath], { branch, worktree: fx.main });
  const linked = (...args: string[]) => runWt(join(fx.main, "bin/findings"), args, { cwd: worktree });
  const before = listFindings(repo);
  const refused = async (...args: string[]) => {
    const result = await linked(...args);
    assert.equal(result.code, 1, result.stderr);
    assert.match(result.stderr, /A worktree may only resolve or release findings it claimed\. Nothing was changed\./);
    assert.deepEqual(listFindings(repo), before);
  };
  for (const id of [open, otherBranch, otherPath]) {
    await refused("release", own, id);
    await refused("resolve", id, "--stale");
  }
  gitIn(worktree, "switch", "--detach");
  await refused("release", own);
  await refused("resolve", own, "--stale");
  gitIn(worktree, "switch", branch);
  assert.equal((await linked("release", own)).code, 0);
  assert.equal(showFinding(repo, own).state, "open");
  claimFindings(repo, [own], { branch, worktree: alias });
  assert.equal((await linked("resolve", own, "--stale")).code, 0);
  assert.equal(showFinding(repo, own).state, "stale");

  assert.equal((await cli("release", otherBranch)).code, 0);
  assert.equal((await cli("resolve", otherPath, "--stale")).code, 0);
  assert.equal((await cli("resolve", open, "--stale")).code, 0);
});

test("a linked worktree cannot resolve its claim as fixed", async () => {
  const branch = "recense-linked";
  const worktree = join(env.root, "linked");
  gitIn(fx.main, "worktree", "add", "--quiet", "-b", branch, worktree);
  const id = addFinding(repo, input()).id;
  approveFindings(repo, [id], "P1");
  claimFindings(repo, [id], { branch, worktree });
  const claimed = showFinding(repo, id);
  const commit = gitIn(fx.main, "rev-parse", "origin/main");
  const result = await runWt(join(fx.main, "bin/findings"), ["resolve", id, "--fixed", commit], { cwd: worktree });
  assert.equal(result.code, 2);
  assert.equal(
    result.stderr.trim(),
    "A fixer's merge records its findings as fixed. A worktree cannot resolve a finding as fixed. Nothing was changed.",
  );
  assert.deepEqual(showFinding(repo, id), claimed);
});

test("resolveMergedFindings matches listed claims by branch and path, including legacy claims", () => {
  const first = addFinding(repo, input()).id;
  const legacy = addFinding(repo, input({ rule: "legacy" })).id;
  const other = addFinding(repo, input({ rule: "other" })).id;
  const wrongPath = addFinding(repo, input({ rule: "wrong-path" })).id;
  const unlisted = addFinding(repo, input({ rule: "unlisted" })).id;
  const released = addFinding(repo, input({ rule: "released" })).id;
  const ids = [first, legacy, other, wrongPath, released];
  approveFindings(repo, [...ids, unlisted], "P2");
  claimFindings(repo, [first, legacy, released, unlisted], target());
  claimFindings(repo, [other], { ...target(), branch: "other-worker" });
  claimFindings(repo, [wrongPath], { ...target(), worktree: join(env.root, "old-worker") });
  releaseFindings(repo, [released]);
  const record = JSON.parse(readFileSync(stored(legacy), "utf8"));
  delete record.approval;
  writeFileSync(stored(legacy), JSON.stringify(record));
  const before = listFindings(repo);
  const commit = "c".repeat(40);
  assert.throws(() => resolveMergedFindings(repo, ids, target(), "bad"), fails(2));
  assert.deepEqual(listFindings(repo), before);
  assert.deepEqual(resolveMergedFindings(repo, ids, target(), commit), [first, legacy].sort());
  for (const id of [first, legacy]) {
    const finding = showFinding(repo, id);
    assert.equal(finding.state, "fixed");
    assert.equal(finding.claim, undefined);
    assert.ok(finding.resolution);
    assert.deepEqual(finding.resolution, { at: new Date(finding.resolution.at).toISOString(), commit });
    assert.deepEqual(finding.approval, before.find((record) => record.id === id)?.approval);
  }
  for (const id of [other, released, wrongPath, unlisted])
    assert.deepEqual(
      showFinding(repo, id),
      before.find((record) => record.id === id),
    );
  assert.deepEqual(resolveMergedFindings(repo, ids, target(), commit), []);
});

test("release validates the whole batch before writing", () => {
  const claimed = addFinding(repo, input()).id;
  const open = addFinding(repo, input({ rule: "open" })).id;
  approveFindings(repo, [claimed], "P1");
  claimFindings(repo, [claimed], target());
  const before = readFileSync(stored(claimed));
  for (const id of [open, "f-000000000000"]) {
    assert.throws(() => releaseFindings(repo, [claimed, id]), fails(1));
    assert.deepEqual(readFileSync(stored(claimed)), before);
  }
  assert.throws(() => releaseFindings(repo, [claimed, "../bad"]), fails(2));
  assert.deepEqual(readFileSync(stored(claimed)), before);
  releaseFindings(repo, [claimed, claimed]);
  assert.equal(showFinding(repo, claimed).state, "open");
});

test("resolution rejects missing or competing choices, noncommits, and unsafe reasons", async () => {
  const id = addFinding(repo, input()).id;
  const before = readFileSync(stored(id));
  const blob = gitIn(fx.main, "rev-parse", "HEAD:README.md");
  const secret = ["gh", "p_", "Ab01".repeat(9)].join("");
  for (const flags of [
    [],
    ["--stale", "--dismissed", "reason"],
    ["--fixed", "bad"],
    ["--fixed", "0".repeat(40)],
    ["--fixed", blob],
    ["--dismissed", ""],
    ["--dismissed", "a".repeat(201)],
    ["--dismissed", "two\nlines"],
    ["--dismissed", secret],
  ]) {
    const result = await cli("resolve", id, ...flags);
    assert.equal(result.code, 2, result.stderr);
    assert.equal(result.stderr.includes(secret), false);
    assert.deepEqual(readFileSync(stored(id)), before);
  }
  assert.equal((await cli("show", "f-000000000000")).code, 1);
  assert.throws(() => resolveFinding(repo, "../bad", { stale: true }), fails(2));
});

test("list is read-only when absent and filters and sorts records with orphan status", async () => {
  assert.deepEqual(listFindings(repo), []);
  assert.equal((await cli("list")).stdout, "");
  assert.equal((await cli("list", "--json")).stdout, "[]\n");
  assert.equal(existsSync(stateDir(repo)), false);
  commitFile(fx.main, "docs/guide.md", "guide\n");
  commitFile(fx.main, "docs-extra.md", "other\n");
  const first = addFinding(repo, input({ path: "docs/guide.md" })).id;
  const second = addFinding(repo, input({ path: "docs-extra.md", kind: "docs" })).id;
  const worktree = join(env.root, "claim-folder");
  mkdirSync(worktree);
  approveFindings(repo, [first], "P1");
  claimFindings(repo, [first], { ...target(), worktree });
  assert.equal(showFinding(repo, first).orphaned, false);
  rmSync(worktree, { recursive: true });
  const recordBefore = readFileSync(stored(first));
  assert.equal(showFinding(repo, first).orphaned, true);
  assert.deepEqual(
    listFindings(repo, { path: "docs" }).map((finding) => finding.id),
    [first],
  );
  assert.deepEqual(
    listFindings(repo, { path: "docs/guide.md", state: "claimed", kind: "bug" }).map((finding) => finding.id),
    [first],
  );
  assert.deepEqual(
    listFindings(repo, { kind: "docs", state: "open" }).map((finding) => finding.id),
    [second],
  );
  assert.deepEqual(listFindings(repo, { path: "not-tracked" }), []);
  assert.deepEqual(readFileSync(stored(first)), recordBefore);
  const text = await cli("list", "--state", "claimed");
  assert.equal(text.stdout, `${first}\tclaimed orphaned\tP1\tbug\tmedium\tdocs/guide.md:1\t${input().title}\n`);
  const json = await cli("list", "--json", "--path", "docs");
  assert.equal(JSON.parse(json.stdout)[0].orphaned, true);
  // Timestamp ordering comes first; ids break ties independent of directory order.
  for (const [id, at] of [
    [first, "2026-01-02T00:00:00.000Z"],
    [second, "2026-01-01T00:00:00.000Z"],
  ]) {
    const record = JSON.parse(readFileSync(stored(id as string), "utf8"));
    writeFileSync(stored(id as string), JSON.stringify({ ...record, createdAt: at }));
  }
  assert.deepEqual(
    listFindings(repo).map((finding) => finding.id),
    [second, first],
  );
  const record = JSON.parse(readFileSync(stored(first), "utf8"));
  writeFileSync(stored(first), JSON.stringify({ ...record, createdAt: "2026-01-01T00:00:00.000Z" }));
  assert.deepEqual(
    listFindings(repo).map((finding) => finding.id),
    [first, second].sort(),
  );
  assert.throws(() => listFindings(repo, { state: "unknown" }), fails(2));
  assert.throws(() => listFindings(repo, { kind: "unknown" }), fails(2));
});

test("list filters approved and untriaged findings and prints the priority after state", async () => {
  const approved = addFinding(repo, input()).id;
  const open = addFinding(repo, input({ rule: "untriaged" })).id;
  approveFindings(repo, [approved], "P1");
  for (const [triage, id, priority] of [
    ["approved", approved, "P1"],
    ["untriaged", open, "-"],
  ] as const) {
    const args = ["list", "--state", "open", "--triage", triage];
    const row = await cli(...args);
    assert.equal(row.code, 0, row.stderr);
    assert.deepEqual(row.stdout.trimEnd().split("\t").slice(0, 4), [id, "open", priority, "bug"]);
    const json = await cli(...args, "--json");
    assert.deepEqual(JSON.parse(json.stdout), [showFinding(repo, id)]);
  }
  assert.equal((await cli("list", "--triage", "unknown")).code, 2);
});

test("untriaged alone selects only open unapproved findings and approved includes any state", async () => {
  const open = addFinding(repo, input()).id;
  const claimed = addFinding(repo, input({ rule: "legacy-claim" })).id;
  const fixed = addFinding(repo, input({ rule: "fixed" })).id;
  const dismissed = addFinding(repo, input({ rule: "dismissed" })).id;
  const stale = addFinding(repo, input({ rule: "stale" })).id;
  approveFindings(repo, [claimed, stale], "P2");
  claimFindings(repo, [claimed], target());
  const record = JSON.parse(readFileSync(stored(claimed), "utf8"));
  delete record.approval;
  writeFileSync(stored(claimed), JSON.stringify(record));
  resolveFinding(repo, fixed, { fixed: gitIn(fx.main, "rev-parse", "HEAD") });
  resolveFinding(repo, dismissed, { dismissed: "reviewed" });
  resolveFinding(repo, stale, { stale: true });
  for (const [filter, expected] of [
    ["untriaged", open],
    ["approved", stale],
  ] as const) {
    const result = await cli("list", "--triage", filter, "--json");
    assert.equal(result.code, 0, result.stderr);
    assert.deepEqual(JSON.parse(result.stdout), [showFinding(repo, expected)]);
  }
});

test("symlinked state and findings folders are refused on reads and writes without touching targets", () => {
  const outside = join(env.root, "outside");
  mkdirSync(outside);
  for (const path of [stateDir(repo), findingsDir(repo)]) {
    if (path === findingsDir(repo)) mkdirSync(stateDir(repo));
    symlinkSync(outside, path);
    assert.throws(() => addFinding(repo, input()), fails(1));
    assert.throws(() => listFindings(repo), fails(1));
    assert.throws(() => showFinding(repo, "f-000000000000"), fails(1));
    assert.deepEqual(readdirSync(outside), []);
    rmSync(stateDir(repo), { recursive: true });
  }
  writeFileSync(stateDir(repo), "not a directory");
  assert.throws(() => addFinding(repo, input()), fails(1));
  assert.throws(() => listFindings(repo), fails(1));
  assert.equal(readFileSync(stateDir(repo), "utf8"), "not a directory");
  rmSync(stateDir(repo));
  mkdirSync(stateDir(repo));
  writeFileSync(findingsDir(repo), "not a directory");
  assert.throws(() => listFindings(repo), fails(1));
});

test("strict stored validation rejects corruption, extra fields and invalid state metadata", () => {
  const id = addFinding(repo, input()).id;
  const original = JSON.parse(readFileSync(stored(id), "utf8"));
  const secret = ["gh", "p_", "Ab01".repeat(9)].join("");
  for (const patch of [
    { version: 2 },
    { id: "f-000000000000" },
    { fingerprint: "0".repeat(64) },
    { anchor: "0".repeat(64) },
    { extra: true },
    { path: "elsewhere.md" },
    { commit: "bad" },
    { createdAt: "yesterday" },
    { state: "unknown" },
    { approval: null },
    { approval: { priority: "P2" } },
    { approval: { at: original.createdAt } },
    { approval: { priority: "P3", at: original.createdAt } },
    { approval: { priority: "P1", at: "yesterday" } },
    { approval: { priority: "P0", at: original.createdAt, extra: true } },
    { line: 0 },
    { title: "" },
    { source: { kind: "groom", pass: "1", extra: 1 } },
    { claim: { ...target(), at: original.createdAt } },
    { state: "claimed" },
    { state: "claimed", claim: { ...target(), at: original.createdAt, extra: true } },
    ...[secret, "\u202e", "\u200b", "\u2028", "\u2029", "\n", "a".repeat(4096)].map((suffix) => ({
      state: "claimed",
      claim: { ...target(), worktree: join(env.root, suffix), at: original.createdAt },
    })),
    { state: "fixed" },
    { state: "fixed", resolution: { at: original.createdAt, commit: "bad" } },
    { state: "stale", resolution: { at: original.createdAt, reason: "extra" } },
    { resolution: { at: original.createdAt } },
    { state: "dismissed", resolution: { at: original.createdAt, reason: "" } },
    { orphaned: false },
  ]) {
    writeFileSync(stored(id), JSON.stringify({ ...original, ...patch }));
    const before = readFileSync(stored(id));
    assert.throws(() => showFinding(repo, id), fails(1));
    const skipped: string[] = [];
    assert.deepEqual(
      listFindings(repo, {}, (message) => skipped.push(message)),
      [],
    );
    assert.deepEqual(skipped, [`Skipped unreadable finding ${id}.`]);
    assert.throws(() => addFinding(repo, input()), fails(1));
    assert.throws(() => claimFindings(repo, [id], target()), fails(1));
    assert.throws(() => releaseFindings(repo, [id]), fails(1));
    assert.throws(() => resolveFinding(repo, id, { stale: true }), fails(1));
    assert.deepEqual(readFileSync(stored(id)), before);
  }
  for (const bytes of [Buffer.from("{"), Buffer.from([0xff]), Buffer.alloc(1024 * 1024 + 1)]) {
    writeFileSync(stored(id), bytes);
    assert.throws(() => showFinding(repo, id), fails(1));
    const skipped: string[] = [];
    assert.deepEqual(
      listFindings(repo, {}, (message) => skipped.push(message)),
      [],
    );
    assert.deepEqual(skipped, [`Skipped unreadable finding ${id}.`]);
  }
  rmSync(stored(id));
  const outside = join(env.root, "record.json");
  writeFileSync(outside, JSON.stringify(original));
  symlinkSync(outside, stored(id));
  assert.throws(() => addFinding(repo, input()), fails(1));
  assert.throws(() => showFinding(repo, id), fails(1));
  assert.deepEqual(JSON.parse(readFileSync(outside, "utf8")), original);
});

test("list skips corrupt, symlinked and invalidly named records with diagnostics only on stderr", async () => {
  const valid = addFinding(repo, input()).id;
  const corrupt = addFinding(repo, input({ rule: "corrupt" })).id;
  const linked = addFinding(repo, input({ rule: "linked" })).id;
  const outside = join(env.root, "outside.json");
  const linkedBytes = readFileSync(stored(linked));
  writeFileSync(outside, linkedBytes);
  rmSync(stored(linked));
  symlinkSync(outside, stored(linked));
  writeFileSync(stored(corrupt), "{not json");
  const invalidName = `${["gh", "p_", "Ab01".repeat(9)].join("")}\n\u202e.json`;
  writeFileSync(join(findingsDir(repo), invalidName), "{}");
  const expected = [
    `Skipped unreadable finding ${corrupt}.`,
    `Skipped unreadable finding ${linked}.`,
    "Skipped a finding file with an invalid name.",
  ].sort();
  const skipped: string[] = [];
  const findings = listFindings(repo, {}, (message) => skipped.push(message));
  assert.deepEqual(findings, [showFinding(repo, valid)]);
  assert.deepEqual(skipped.sort(), expected);
  for (const flags of [[], ["--json"]]) {
    const result = await cli("list", ...flags);
    assert.equal(result.code, 0, result.stderr);
    assert.deepEqual(result.stderr.trimEnd().split("\n").sort(), expected);
    if (flags.length) assert.deepEqual(JSON.parse(result.stdout), findings);
    else assert.equal(result.stdout, `${valid}\topen\t-\tbug\tmedium\tREADME.md:1\t${input().title}\n`);
  }
  assert.equal(readFileSync(stored(corrupt), "utf8"), "{not json");
  assert.equal(lstatSync(stored(linked)).isSymbolicLink(), true);
  assert.deepEqual(readFileSync(outside), linkedBytes);
  assert.equal(existsSync(join(findingsDir(repo), invalidName)), true);
});

test("failed atomic rename removes its temp file and releases the lock", (t) => {
  const mocked = t.mock.method(fs, "renameSync", () => {
    throw new Error("synthetic write failure");
  });
  syncBuiltinESMExports();
  try {
    assert.throws(() => addFinding(repo, input()), fails(1));
  } finally {
    mocked.mock.restore();
    syncBuiltinESMExports();
  }
  assert.deepEqual(readdirSync(findingsDir(repo)), []);
  assert.equal(existsSync(join(stateDir(repo), "findings.lock")), false);
  assert.equal(addFinding(repo, input()).created, true);
});

test("named state locks are independent, non-reentrant and release on error", () => {
  assert.equal(
    withStateLock(repo, "findings", () => withStateLock(repo, "groom", () => 7)),
    7,
  );
  assert.throws(() => withStateLock(repo, "findings", () => withStateLock(repo, "findings", () => 1)), /re-entrant/);
  assert.throws(
    () =>
      withStateLock(repo, "groom", () => {
        throw new Error("failure");
      }),
    /failure/,
  );
  assert.deepEqual(readdirSync(stateDir(repo)), []);
  writeFileSync(join(stateDir(repo), "findings.lock"), `${deadPid()}\n`);
  assert.equal(
    withStateLock(repo, "findings", () => 3),
    3,
  );
  assert.deepEqual(readdirSync(stateDir(repo)), []);
});

test("busy state locks name the lock and exit 69", (t) => {
  mkdirSync(stateDir(repo));
  for (const name of ["findings", "groom"] as const) {
    const lock = join(stateDir(repo), `${name}.lock`);
    writeFileSync(lock, `${process.pid}\n`);
    let now = 0;
    const mocked = t.mock.method(Date, "now", () => (now += 31_000));
    try {
      assert.throws(
        () => withStateLock(repo, name, () => 1),
        (error) =>
          error instanceof WtError &&
          error.code === 69 &&
          error.message === `Another bin/wt or bin/findings call holds the ${name} lock. Try again in a moment.`,
      );
    } finally {
      mocked.mock.restore();
    }
    assert.deepEqual(readdirSync(stateDir(repo)), [`${name}.lock`]);
    rmSync(lock);
  }
});

test("list waits for the findings lock when the findings folder exists", (t) => {
  const id = addFinding(repo, input()).id;
  const before = readFileSync(stored(id));
  const lock = join(stateDir(repo), "findings.lock");
  const content = `${process.pid}\n`;
  writeFileSync(lock, content);
  let now = 0;
  const mocked = t.mock.method(Date, "now", () => (now += 31_000));
  try {
    assert.throws(
      () => listFindings(repo),
      (error) =>
        error instanceof WtError &&
        error.code === 69 &&
        error.message === "Another bin/wt or bin/findings call holds the findings lock. Try again in a moment.",
    );
  } finally {
    mocked.mock.restore();
  }
  assert.equal(showFinding(repo, id).state, "open");
  assert.deepEqual(readFileSync(stored(id)), before);
  assert.equal(readFileSync(lock, "utf8"), content);
  assert.deepEqual(readdirSync(stateDir(repo)).sort(), ["findings", "findings.lock"]);
});

test("a symlinked findings lock is never read through or reaped", (t) => {
  mkdirSync(stateDir(repo));
  const lock = join(stateDir(repo), "findings.lock");
  const outside = join(env.root, "outside-lock");
  const content = `${deadPid()}\n`;
  writeFileSync(outside, content);
  symlinkSync(outside, lock);
  let now = 0;
  const clock = t.mock.method(Date, "now", () => (now += 31_000));
  const read = t.mock.method(fs, "readSync");
  syncBuiltinESMExports();
  try {
    assert.throws(() => withStateLock(repo, "findings", () => assert.fail("must not run")), fails(69));
    assert.equal(read.mock.callCount(), 0);
  } finally {
    clock.mock.restore();
    read.mock.restore();
    syncBuiltinESMExports();
  }
  assert.equal(lstatSync(lock).isSymbolicLink(), true);
  assert.equal(readFileSync(outside, "utf8"), content);
  assert.deepEqual(readdirSync(stateDir(repo)), ["findings.lock"]);
});

test("a FIFO findings lock times out without blocking", async (t) => {
  const mkfifo = env.realPath
    .split(delimiter)
    .filter(Boolean)
    .map((dir) => join(dir, "mkfifo"))
    .find(existsSync);
  if (!mkfifo) return t.skip("mkfifo is unavailable");
  mkdirSync(stateDir(repo));
  const lock = join(stateDir(repo), "findings.lock");
  const made = spawnSync(mkfifo, [lock], { encoding: "utf8", timeout: 5000 });
  assert.equal(made.status, 0, made.stderr);
  const script = `
    import { withStateLock } from ${JSON.stringify(pathToFileURL(join(import.meta.dirname, "registry.ts")).href)};
    let now = 0;
    Date.now = () => (now += 31_000);
    try {
      withStateLock(${JSON.stringify(repo)}, "findings", () => { throw new Error("must not run"); });
    } catch (error) {
      process.stderr.write(error.message + "\\n");
      process.exitCode = error.code ?? 1;
    }
  `;
  const result = await runWt(process.execPath, ["--input-type=module", "-e", script], {
    cwd: fx.main,
    timeoutMs: 5000,
  });
  assert.equal(result.code, 69, result.stderr);
  assert.equal(result.stderr, "Another bin/wt or bin/findings call holds the findings lock. Try again in a moment.\n");
  assert.equal(lstatSync(lock).isFIFO(), true);
  assert.deepEqual(readdirSync(stateDir(repo)), ["findings.lock"]);
});

test("nonregular, oversized and malformed findings locks are left alone", (t) => {
  mkdirSync(stateDir(repo));
  const lock = join(stateDir(repo), "findings.lock");
  const pid = deadPid();
  for (const content of [null, `${pid}${" ".repeat(64)}`, `${pid}garbage`, "0", "9007199254740992", ""]) {
    if (content === null) mkdirSync(lock);
    else writeFileSync(lock, content);
    let now = 0;
    const mocked = t.mock.method(Date, "now", () => (now += 31_000));
    try {
      assert.throws(() => withStateLock(repo, "findings", () => assert.fail("must not run")), fails(69));
    } finally {
      mocked.mock.restore();
    }
    if (content === null) assert.equal(lstatSync(lock).isDirectory(), true);
    else assert.equal(readFileSync(lock, "utf8"), content);
    assert.deepEqual(readdirSync(stateDir(repo)), ["findings.lock"]);
    rmSync(lock, { recursive: true });
  }
});

test("withStateLock rejects symlinked and non-directory state before calling back", () => {
  const outside = join(env.root, "outside");
  mkdirSync(outside);
  symlinkSync(outside, stateDir(repo));
  assert.throws(() => withStateLock(repo, "groom", () => assert.fail("must not run")), fails(1));
  assert.deepEqual(readdirSync(outside), []);
  rmSync(stateDir(repo));
  writeFileSync(stateDir(repo), "file");
  assert.throws(() => withStateLock(repo, "groom", () => assert.fail("must not run")), fails(1));
});

test("missing git is unavailable and does not create a finding", async () => {
  rmSync(join(env.fakeBin, "git"));
  assert.throws(() => addFinding(repo, input()), fails(69));
  assert.equal(existsSync(findingsDir(repo)), false);
  assert.equal((await cli("list")).code, 69);
});

test("bin/findings help lists every registry, fixer and groom command", async () => {
  const result = await cli("help");
  assert.equal(result.code, 0, result.stderr);
  const lines = result.stdout.split("\n").map((line) => line.trim());
  for (const usage of [
    "add --file <file>",
    "list [--state <s>] [--kind <k>] [--path <p>] [--triage approved|untriaged] [--json]",
    "untriaged means open with no approval. approved means an approval in any state.",
    "page ",
    "show <id>",
    "approve <id>... --priority P0|P1|P2",
    "skip <id>...",
    "release <id>...",
    "resolve <id> (--fixed <sha> | --dismissed <reason> | --stale)",
    "groom next [--count N]",
    "groom visited <path> --blob <sha> --findings N",
    "Exit codes:",
  ]) {
    assert.ok(
      lines.some((line) => line.startsWith(usage)),
      usage,
    );
  }
  assert.deepEqual(
    lines.filter((line) => line.includes("--slug")),
    ["spawn <id,id> --slug <slug> [--model <m>] [--effort <e>]"],
  );
  for (const args of [[], ["--help"], ["-h"]]) assert.deepEqual(await cli(...args), result);
});

test("bin/findings rejects unknown subcommands with exit 2", async () => {
  for (const sub of ["unknown", "toString"]) {
    assert.deepEqual(await cli(sub), { code: 2, stdout: "", stderr: "Unknown subcommand. Run bin/findings help.\n" });
  }
  assert.equal(existsSync(stateDir(repo)), false);
});

test("bin/findings lists through a symlink chain", async () => {
  const id = addFinding(repo, input()).id;
  const direct = await cli("list", "--json");
  assert.equal(direct.code, 0, direct.stderr);
  assert.deepEqual(JSON.parse(direct.stdout), [showFinding(repo, id)]);
  const link = join(env.root, "findings-link");
  const second = join(env.root, "second-link");
  symlinkSync(join(fx.main, "bin/findings"), link);
  symlinkSync("findings-link", second);
  for (const path of [link, second]) {
    const result = await runWt(path, ["list", "--json"], {
      cwd: fx.main,
      env: { PATH: `${env.fakeBin}${delimiter}${env.realPath}` },
    });
    assert.deepEqual(result, direct);
  }
});

test("bin/wt rejects the former findings commands without claiming or creating a worktree", async () => {
  const id = addFinding(repo, input()).id;
  const before = readFileSync(stored(id));
  const wt = join(fx.main, "bin/wt");
  for (const args of [
    ["findings", "list"],
    ["groom", "next"],
    ["spawn", "--findings", id, "--slug", "x"],
  ]) {
    const result = await runWt(wt, args, { cwd: fx.main });
    assert.equal(result.code, 2, result.stderr);
    assert.match(result.stderr, args[0] === "spawn" ? /Unknown option --findings/ : /Unknown subcommand/);
    assert.deepEqual(readFileSync(stored(id)), before);
    assert.deepEqual(readdirSync(stateDir(repo)), ["findings"]);
    assert.equal(existsSync(repo.worktreesDir), false);
    assert.equal(gitIn(fx.main, "branch", "--list", "recense-*"), "");
  }
});

function groomCli(...args: string[]) {
  return cli("groom", ...args);
}

function visitsPath(): string {
  return join(stateDir(repo), "groom", "visits.json");
}

function headBlob(path = "README.md"): string {
  return gitIn(fx.main, "rev-parse", `HEAD:${path}`);
}

const GROOM_STORAGE_ERROR = "Groom storage is unreadable, corrupt or symlinked. Nothing was changed.";

test("groom orders new paths by code unit, changed paths by age, then unchanged visits by age", () => {
  const paths = ["new/a.ts", "new/Z.ts", "changed/a.ts", "changed/Z.ts", "changed/old.ts", "old/a.ts", "old/Z.ts"];
  for (const path of paths) commitFile(fx.main, path, "before\n");
  const candidates = groomNext(repo, 50);
  assert.ok(candidates.length < 50);
  const visits = new Map(
    candidates
      .filter(({ path }) => !path.startsWith("new/"))
      .map(({ path, blob }) => [path, { blob, at: "2026-03-01T00:00:00.000Z", findings: 0 }]),
  );
  for (const [path, visit] of visits) {
    if (path.startsWith("old/")) visit.at = "2026-01-01T00:00:00.000Z";
    if (path === "changed/old.ts") visit.at = "2026-02-01T00:00:00.000Z";
  }
  mkdirSync(join(stateDir(repo), "groom"));
  writeFileSync(visitsPath(), JSON.stringify({ version: 1, visits: Object.fromEntries(visits) }));
  for (const path of paths.filter((path) => path.startsWith("changed/"))) commitFile(fx.main, path, "after\n");
  const before = readFileSync(visitsPath());
  const mtime = statSync(visitsPath()).mtimeMs;
  const next = groomNext(repo, 50);
  assert.deepEqual(
    next.filter(({ path }) => paths.includes(path)).map(({ path, reason }) => [path, reason]),
    [
      ["new/Z.ts", "new"],
      ["new/a.ts", "new"],
      ["changed/old.ts", "changed"],
      ["changed/Z.ts", "changed"],
      ["changed/a.ts", "changed"],
      ["old/Z.ts", "oldest"],
      ["old/a.ts", "oldest"],
    ],
  );
  assert.deepEqual(groomNext(repo, 3), next.slice(0, 3));
  for (const { path, blob } of next) assert.equal(blob, headBlob(path));
  assert.deepEqual(readFileSync(visitsPath()), before);
  assert.equal(statSync(visitsPath()).mtimeMs, mtime);
});

test("groom skips generated paths, fixtures, image and font extensions, symlinks and gitlinks", () => {
  const skipped = [
    "pnpm-lock.yaml",
    "nested/pnpm-lock.yaml",
    "apps/recense/drizzle/0001.sql",
    "docs/images/a.md",
    "docs/vendor/a.md",
    "fixtures/a.ts",
    "nested/fixtures/a.ts",
    ...["PNG", "jpg", "jpeg", "gif", "webp", "ico", "svg", "woff", "woff2", "ttf"].map((ext) => `asset.${ext}`),
  ];
  const kept = ["docs/imagesx/a.md", "docs/vendorx/a.md", "fixtures.md", "nested/fixturesx/a.ts", "run.sh"];
  for (const path of [...skipped, ...kept]) {
    mkdirSync(join(fx.main, path, ".."), { recursive: true });
    writeFileSync(join(fx.main, path), "synthetic\n");
  }
  symlinkSync("README.md", join(fx.main, "linked.md"));
  gitIn(fx.main, "add", "-A");
  gitIn(fx.main, "update-index", "--chmod=+x", "run.sh");
  gitIn(fx.main, "update-index", "--add", "--cacheinfo", `160000,${gitIn(fx.main, "rev-parse", "HEAD")},submodule`);
  gitIn(fx.main, "commit", "--quiet", "-m", "candidate paths");
  const paths = groomNext(repo, 50).map(({ path }) => path);
  for (const path of [...skipped, "linked.md", "submodule"]) assert.equal(paths.includes(path), false, path);
  for (const path of kept) assert.ok(paths.includes(path), path);
});

test("groom skips invalid UTF-8 and every path that findings would refuse", () => {
  const secret = ["gh", "p_", "Ab01".repeat(9)].join("");
  const skipped = [
    "back\\slash",
    "line\nbreak",
    "hidden\u200btext",
    "split\u2028text",
    secret,
    `${"a".repeat(200)}/${"b".repeat(101)}`,
  ];
  for (const path of skipped) {
    mkdirSync(join(fx.main, path, ".."), { recursive: true });
    writeFileSync(join(fx.main, path), "synthetic\n");
  }
  writeFileSync(Buffer.concat([Buffer.from(`${fx.main}/invalid-`), Buffer.from([0xff])]), "synthetic\n");
  gitIn(fx.main, "add", "-A");
  gitIn(fx.main, "commit", "--quiet", "-m", "unusual paths");
  const paths = groomNext(repo, 50).map(({ path }) => path);
  assert.ok(paths.includes("README.md"));
  for (const path of skipped) assert.equal(paths.includes(path), false);
  assert.equal(
    paths.some((path) => path.startsWith("invalid-")),
    false,
  );
});

test("groom excludes leading dashes and single quotes but keeps later dashes in paths", async () => {
  const skipped = ["-dash.md", "it's.md", "docs/it's.md"];
  const kept = ["docs/a-b.md", "docs/-x.md"];
  for (const path of [...skipped, ...kept]) commitFile(fx.main, path, "synthetic\n");
  const result = await groomCli("next", "--count", "50");
  assert.equal(result.code, 0, result.stderr);
  const next: { path: string }[] = JSON.parse(result.stdout);
  assert.ok(next.length < 50);
  const paths = next.map(({ path }) => path);
  for (const path of skipped) assert.equal(paths.includes(path), false, path);
  for (const path of kept) assert.ok(paths.includes(path), path);
  assert.equal(existsSync(visitsPath()), false);
  for (const path of skipped) {
    assert.throws(() => groomVisited(repo, path, headBlob(path), 0), {
      code: 2,
      message: "The path is not a groom candidate at HEAD.",
    });
    assert.equal(existsSync(visitsPath()), false);
  }
});

test("groom next defaults to five JSON candidates and leaves absent groom storage absent", async () => {
  const result = await groomCli("next");
  assert.equal(result.code, 0, result.stderr);
  const next = JSON.parse(result.stdout);
  assert.equal(next.length, 5);
  assert.deepEqual(next, groomNext(repo, 5));
  assert.equal(result.stdout, `${JSON.stringify(next, null, 2)}\n`);
  for (const entry of next) {
    assert.deepEqual(Object.keys(entry), ["path", "blob", "reason"]);
    assert.match(entry.blob, /^[0-9a-f]{40}$/);
    assert.equal(entry.reason, "new");
  }
  assert.equal(existsSync(join(stateDir(repo), "groom")), false);
  assert.deepEqual(readdirSync(stateDir(repo)), []);
  const help = await cli("help");
  assert.match(help.stdout, /groom next \[--count N\]/);
  assert.match(help.stdout, /groom visited <path> --blob <sha> --findings N/);
});

test("groom visits write private version 1 storage and preserve prototype-named paths", async () => {
  for (const path of ["__proto__", "constructor"]) commitFile(fx.main, path, "synthetic\n");
  const start = Date.now();
  for (const path of ["__proto__", "constructor"]) {
    const result = await groomCli("visited", path, "--blob", headBlob(path), "--findings", "2");
    assert.equal(result.code, 0, result.stderr);
    assert.equal(result.stdout, "");
  }
  const stored = JSON.parse(readFileSync(visitsPath(), "utf8"));
  assert.deepEqual(Object.keys(stored), ["version", "visits"]);
  assert.equal(stored.version, 1);
  assert.deepEqual(Object.keys(stored.visits), ["__proto__", "constructor"]);
  for (const path of Object.keys(stored.visits)) {
    const visit = stored.visits[path];
    assert.deepEqual(visit, { blob: headBlob(path), at: visit.at, findings: 2 });
    assert.equal(new Date(visit.at).toISOString(), visit.at);
    assert.ok(Date.parse(visit.at) >= start && Date.parse(visit.at) <= Date.now());
    assert.equal(groomNext(repo, 50).find((entry) => entry.path === path)?.reason, "oldest");
  }
  assert.equal(statSync(join(stateDir(repo), "groom")).mode & 0o777, 0o700);
  assert.equal(statSync(visitsPath()).mode & 0o777, 0o600);
  assert.deepEqual(readdirSync(join(stateDir(repo), "groom")), ["visits.json"]);
});

for (const action of ["next", "visited"] as const) {
  test(`groom ${action} prunes deleted, renamed and no longer regular visits`, () => {
    for (const path of ["deleted.md", "renamed.md", "linked.md"]) {
      commitFile(fx.main, path, "synthetic\n");
      groomVisited(repo, path, headBlob(path), 0);
    }
    gitIn(fx.main, "rm", "deleted.md");
    gitIn(fx.main, "mv", "renamed.md", "new-name.md");
    rmSync(join(fx.main, "linked.md"));
    symlinkSync("README.md", join(fx.main, "linked.md"));
    gitIn(fx.main, "add", "linked.md");
    gitIn(fx.main, "commit", "--quiet", "-m", "remove old candidates");
    const stored = JSON.parse(readFileSync(visitsPath(), "utf8"));
    stored.visits["fixtures/old.ts"] = { blob: headBlob(), at: "2026-01-01T00:00:00.000Z", findings: 0 };
    writeFileSync(visitsPath(), JSON.stringify(stored));
    if (action === "visited") {
      groomVisited(repo, "README.md", headBlob(), 1);
      assert.deepEqual(Object.keys(JSON.parse(readFileSync(visitsPath(), "utf8")).visits), ["README.md"]);
    }
    const next = groomNext(repo, 50);
    assert.equal(
      next.some(({ path }) => ["deleted.md", "renamed.md", "linked.md"].includes(path)),
      false,
    );
    assert.equal(next.find(({ path }) => path === "new-name.md")?.reason, "new");
    assert.deepEqual(
      Object.keys(JSON.parse(readFileSync(visitsPath(), "utf8")).visits),
      action === "next" ? [] : ["README.md"],
    );
  });
}

test("groom refuses noncandidates and mismatched blobs without changing visits", async () => {
  commitFile(fx.main, "pnpm-lock.yaml", "synthetic\n");
  symlinkSync("README.md", join(fx.main, "linked.md"));
  gitIn(fx.main, "add", "linked.md");
  gitIn(fx.main, "commit", "--quiet", "-m", "linked path");
  writeFileSync(join(fx.main, "untracked.md"), "synthetic\n");
  groomVisited(repo, "README.md", headBlob(), 0);
  const before = readFileSync(visitsPath());
  for (const [path, blob, message] of [
    ["README.md", "0".repeat(40), "The blob does not match HEAD for that path."],
    ...["untracked.md", "pnpm-lock.yaml", "linked.md"].map((path) => [
      path,
      headBlob(),
      "The path is not a groom candidate at HEAD.",
    ]),
  ]) {
    const result = await groomCli("visited", path as string, "--blob", blob as string, "--findings", "0");
    assert.equal(result.code, 2, result.stderr);
    assert.equal(result.stderr.trim(), message);
    assert.deepEqual(readFileSync(visitsPath()), before);
  }
});

test("groom validates API inputs before taking the lock", () => {
  const blob = headBlob();
  for (const count of [0, 51, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1])
    assert.throws(() => groomNext(repo, count), { code: 2, message: "Invalid groom count." });
  for (const path of [
    "",
    "/README.md",
    "a//b",
    "a/./b",
    "../README.md",
    "back\\slash",
    "line\nbreak",
    "hidden\u200b",
    "a".repeat(301),
  ])
    assert.throws(() => groomVisited(repo, path, blob, 0), { code: 2, message: "Invalid groom path." });
  for (const value of ["", "A".repeat(40), "0".repeat(39), "g".repeat(40), `${blob}\n`])
    assert.throws(() => groomVisited(repo, "README.md", value, 0), { code: 2, message: "Invalid groom blob." });
  for (const count of [-1, 10001, 0.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1])
    assert.throws(() => groomVisited(repo, "README.md", blob, count), {
      code: 2,
      message: "Invalid groom findings count.",
    });
  assert.equal(existsSync(stateDir(repo)), false);
});

test("groom CLI refuses malformed counts, options and actions without changing visits", async () => {
  const blob = headBlob();
  groomVisited(repo, "README.md", blob, 0);
  const before = readFileSync(visitsPath());
  for (const count of ["0", "51", "5x", "01", "1.5", "1e1", "9007199254740992", "5\n"]) {
    const result = await groomCli("next", "--count", count);
    assert.equal(result.code, 2, result.stderr);
  }
  for (const count of ["-1", "01", "5x", "1.5", "10001", "9007199254740992", "0\n"]) {
    const result = await groomCli("visited", "README.md", "--blob", blob, `--findings=${count}`);
    assert.equal(result.code, 2, result.stderr);
  }
  for (const args of [
    ["next", "extra"],
    ["next", "--unknown"],
    ["next", "--count"],
    ["next", "--count", "5", "--count", "6"],
    ["visited", "README.md"],
    ["visited", "--blob", blob, "--findings", "0"],
    ["visited", "README.md", "extra", "--blob", blob, "--findings", "0"],
    ["visited", "README.md", "--blob", blob],
    ["visited", "README.md", "--findings", "0"],
  ]) {
    const result = await groomCli(...args);
    assert.equal(result.code, 2, result.stderr);
    assert.equal(result.stderr.trim(), "Invalid groom options.");
  }
  for (const args of [[], ["unknown"]]) {
    const result = await groomCli(...args);
    assert.equal(result.code, 2, result.stderr);
    assert.equal(result.stderr.trim(), "Unknown groom action. Run bin/findings help.");
  }
  assert.deepEqual(readFileSync(visitsPath()), before);
});

test("groom reads main HEAD from a worktree and ignores staged changes in main", async () => {
  const blob = headBlob();
  const worktree = join(env.root, "worktree");
  gitIn(fx.main, "worktree", "add", "--quiet", "-b", "recense-groom", worktree);
  commitFile(worktree, "README.md", "worktree content\n");
  writeFileSync(join(fx.main, "README.md"), "staged content\n");
  gitIn(fx.main, "add", "README.md");
  const result = await runWt(join(fx.main, "bin", "findings"), ["groom", "next", "--count", "50"], { cwd: worktree });
  assert.equal(result.code, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).find((entry: { path: string }) => entry.path === "README.md").blob, blob);
  groomVisited(resolveRepo(worktree), "README.md", blob, 0);
  assert.equal(JSON.parse(readFileSync(visitsPath(), "utf8")).visits["README.md"].blob, blob);
});

test("groom refuses symlinked storage and nonregular directories before writing", async () => {
  const outside = join(env.root, "outside");
  mkdirSync(outside);
  const blob = headBlob();
  const content = JSON.stringify({ version: 1, visits: {} });
  const target = join(outside, "visits.json");
  writeFileSync(target, content);
  for (const path of [stateDir(repo), join(stateDir(repo), "groom"), visitsPath()]) {
    mkdirSync(join(path, ".."), { recursive: true });
    symlinkSync(path === visitsPath() ? target : outside, path);
    for (const args of [["next"], ["visited", "README.md", "--blob", blob, "--findings", "0"]]) {
      const result = await groomCli(...args);
      assert.equal(result.code, 1, result.stderr);
      assert.equal(result.stderr.trim(), GROOM_STORAGE_ERROR);
    }
    assert.equal(lstatSync(path).isSymbolicLink(), true);
    assert.equal(readFileSync(target, "utf8"), content);
    assert.deepEqual(readdirSync(outside), ["visits.json"]);
    rmSync(stateDir(repo), { recursive: true });
  }
  for (const path of [stateDir(repo), join(stateDir(repo), "groom")]) {
    mkdirSync(join(path, ".."), { recursive: true });
    writeFileSync(path, "not a directory");
    assert.throws(() => groomNext(repo, 5), { code: 1, message: GROOM_STORAGE_ERROR });
    assert.equal(readFileSync(path, "utf8"), "not a directory");
    rmSync(stateDir(repo), { recursive: true });
  }
  const commonLink = join(env.root, "common-link");
  symlinkSync(repo.commonDir, commonLink);
  assert.throws(() => groomNext({ ...repo, commonDir: commonLink }, 5), { code: 1, message: GROOM_STORAGE_ERROR });
});

test("groom refuses corrupt or nonregular visit storage without altering it", async () => {
  const blob = headBlob();
  groomVisited(repo, "README.md", blob, 0);
  const visit = { blob, at: "2026-01-01T00:00:00.000Z", findings: 0 };
  const values: unknown[] = [
    null,
    [],
    {},
    { version: 2, visits: {} },
    { version: 1, visits: {}, extra: true },
    { version: 1, visits: [] },
  ];
  for (const bad of [
    null,
    [],
    {},
    { ...visit, extra: true },
    { ...visit, blob: "A".repeat(40) },
    { ...visit, blob: `${blob}\n` },
    { ...visit, at: "2026-01-01" },
    { ...visit, at: "bad" },
    { ...visit, findings: -1 },
    { ...visit, findings: 10001 },
    { ...visit, findings: 1.5 },
    { ...visit, findings: "0" },
  ])
    values.push({ version: 1, visits: { "README.md": bad } });
  for (const path of ["../bad", "a//b", "a\\b", "a\u200b", "a".repeat(301)])
    values.push({ version: 1, visits: { [path]: visit } });
  const bytes = [
    ...values.map((value) => Buffer.from(JSON.stringify(value))),
    Buffer.from("{"),
    Buffer.from([0xff]),
    Buffer.alloc(1024 * 1024 + 1),
  ];
  for (const content of bytes) {
    writeFileSync(visitsPath(), content);
    for (const call of [() => groomNext(repo, 5), () => groomVisited(repo, "README.md", blob, 0)])
      assert.throws(call, { code: 1, message: GROOM_STORAGE_ERROR });
    assert.deepEqual(readFileSync(visitsPath()), content);
  }
  writeFileSync(visitsPath(), "{bad json");
  assert.equal((await groomCli("next")).code, 1);
  rmSync(visitsPath());
  mkdirSync(visitsPath());
  assert.throws(() => groomNext(repo, 5), { code: 1, message: GROOM_STORAGE_ERROR });
  assert.deepEqual(readdirSync(visitsPath()), []);
});

for (const failure of ["fsyncSync", "renameSync"] as const) {
  test(`groom cleans temporary files and preserves visits after ${failure} fails`, (t) => {
    const blob = headBlob();
    groomVisited(repo, "README.md", blob, 0);
    const before = readFileSync(visitsPath());
    const mocked = t.mock.method(fs, failure, () => {
      throw new Error("synthetic write failure");
    });
    syncBuiltinESMExports();
    try {
      assert.throws(() => groomVisited(repo, "README.md", blob, 1), { code: 1, message: GROOM_STORAGE_ERROR });
    } finally {
      mocked.mock.restore();
      syncBuiltinESMExports();
    }
    assert.deepEqual(readFileSync(visitsPath()), before);
    assert.deepEqual(readdirSync(join(stateDir(repo), "groom")), ["visits.json"]);
    assert.equal(existsSync(join(stateDir(repo), "groom.lock")), false);
  });
}

test("groom reads and writes both wait for the groom lock", (t) => {
  const blob = headBlob();
  mkdirSync(stateDir(repo));
  const lock = join(stateDir(repo), "groom.lock");
  writeFileSync(lock, `${process.pid}\n`);
  let now = 0;
  const mocked = t.mock.method(Date, "now", () => (now += 31_000));
  try {
    for (const call of [() => groomNext(repo, 5), () => groomVisited(repo, "README.md", blob, 0)])
      assert.throws(call, {
        code: 69,
        message: "Another bin/wt or bin/findings call holds the groom lock. Try again in a moment.",
      });
  } finally {
    mocked.mock.restore();
  }
  assert.deepEqual(readdirSync(stateDir(repo)), ["groom.lock"]);
});

test("groom maps unavailable git and other git failures without creating visit storage", () => {
  const blob = headBlob();
  gitIn(fx.main, "update-ref", "-d", "refs/heads/main");
  assert.throws(() => groomNext(repo, 5), { code: 1, message: "Could not read HEAD of the main checkout." });
  rmSync(join(env.fakeBin, "git"));
  for (const call of [() => groomNext(repo, 5), () => groomVisited(repo, "README.md", blob, 0)])
    assert.throws(call, { code: 69, message: "Git is unavailable." });
  assert.equal(existsSync(join(stateDir(repo), "groom")), false);
});

test("groom CLI maps missing git to unavailable without creating visit storage", async () => {
  rmSync(join(env.fakeBin, "git"));
  const next = await groomCli("next");
  assert.equal(next.code, 69, next.stderr);
  assert.equal(existsSync(join(stateDir(repo), "groom")), false);
  const visited = await groomCli("visited", "README.md", "--blob", "0".repeat(40), "--findings", "0");
  assert.equal(visited.code, 69, visited.stderr);
  assert.equal(existsSync(join(stateDir(repo), "groom")), false);
});
