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
  claimFindings,
  type FindingInput,
  findingsDir,
  groomNext,
  groomVisited,
  listFindings,
  releaseFindings,
  resolveFinding,
  showFinding,
} from "./findings.ts";
import { stateDir, withStateLock } from "./registry.ts";
import { type Repo, resolveRepo } from "./repo.ts";
import {
  commitFile,
  deadPid,
  type Fixture,
  gitIn,
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
    source: { kind: "review", branch: "emend-fixture", round: "1" },
    ...overrides,
  };
}

function cli(...args: string[]) {
  return runWt(join(fx.main, "bin", "wt"), ["findings", ...args], { cwd: fx.main });
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
  return { branch: "emend-fix-selection", worktree: fx.main };
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
    { ...input(), source: { kind: "review", branch: "emend-fixture", round: "1", pass: "1" } },
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
    [],
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
  gitIn(fx.main, "worktree", "add", "--quiet", "-b", "emend-linked", worktree);
  const commit = commitFile(worktree, "linked.md", "linked content\n");
  const linkedRepo = resolveRepo(worktree);
  const result = addFinding(linkedRepo, input({ path: "linked.md" }));
  assert.equal(showFinding(repo, result.id).commit, commit);
  assert.equal(findingsDir(linkedRepo), findingsDir(repo));
  assert.throws(() => addFinding(repo, input({ path: "linked.md" })), fails(2));
});

test("claim rejects security, large, non-open, unknown and invalid ids as one batch", () => {
  const open = addFinding(repo, input()).id;
  const security = addFinding(repo, input({ kind: "security" })).id;
  const large = addFinding(repo, input({ rule: "large", size: "large" })).id;
  const claimed = addFinding(repo, input({ rule: "claimed" })).id;
  claimFindings(repo, [claimed], target());
  const before = listFindings(repo);
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
  const worktree = ["", "ho" + "me", "worker" + "-name", "src", "repo"].join("/");
  claimFindings(repo, [id], { ...target(), worktree });
  const record = JSON.parse(readFileSync(stored(id), "utf8"));
  assert.equal(record.state, "claimed");
  assert.equal(record.claim.worktree, worktree);
  assert.deepEqual(listFindings(repo), [{ ...record, orphaned: true }]);
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
        error.message.includes("bin/wt findings list") &&
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
  claimFindings(repo, [fixed, released], target());
  const commit = gitIn(fx.main, "rev-parse", "HEAD");
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

test("release validates the whole batch before writing", () => {
  const claimed = addFinding(repo, input()).id;
  const open = addFinding(repo, input({ rule: "open" })).id;
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
  assert.equal(text.stdout, `${first}\tclaimed orphaned\tbug\tmedium\tdocs/guide.md:1\t${input().title}\n`);
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
    else assert.equal(result.stdout, `${valid}\topen\tbug\tmedium\tREADME.md:1\t${input().title}\n`);
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
          error.message === `Another bin/wt call holds the ${name} lock. Try again in a moment.`,
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
        error.message === "Another bin/wt call holds the findings lock. Try again in a moment.",
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
  assert.equal(result.stderr, "Another bin/wt call holds the findings lock. Try again in a moment.\n");
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

test("bin/wt help lists findings", async () => {
  const result = await runWt(join(fx.main, "bin", "wt"), ["help"], { cwd: fx.main });
  assert.equal(result.code, 0, result.stderr);
  assert.match(result.stdout, /findings add --file/);
  assert.match(result.stdout, /findings resolve/);
});

function groomCli(...args: string[]) {
  return runWt(join(fx.main, "bin", "wt"), ["groom", ...args], { cwd: fx.main });
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
    "apps/emend/drizzle/0001.sql",
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
  const help = await runWt(join(fx.main, "bin", "wt"), ["help"], { cwd: fx.main });
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
    assert.equal(result.stderr.trim(), "Unknown groom action. Run bin/wt help.");
  }
  assert.deepEqual(readFileSync(visitsPath()), before);
});

test("groom reads main HEAD from a worktree and ignores staged changes in main", async () => {
  const blob = headBlob();
  const worktree = join(env.root, "worktree");
  gitIn(fx.main, "worktree", "add", "--quiet", "-b", "emend-groom", worktree);
  commitFile(worktree, "README.md", "worktree content\n");
  writeFileSync(join(fx.main, "README.md"), "staged content\n");
  gitIn(fx.main, "add", "README.md");
  const result = await runWt(join(fx.main, "bin", "wt"), ["groom", "next", "--count", "50"], { cwd: worktree });
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
      assert.throws(call, { code: 69, message: "Another bin/wt call holds the groom lock. Try again in a moment." });
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
