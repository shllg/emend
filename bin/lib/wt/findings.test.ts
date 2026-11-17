import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs, {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { join } from "node:path";
import { afterEach, beforeEach, test } from "node:test";
import {
  addFinding,
  claimFindings,
  type FindingInput,
  findingsDir,
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
  assert.equal(readFileSync(stateDir(repo), "utf8"), "not a directory");
});

test("strict stored validation rejects corruption, extra fields and invalid state metadata", () => {
  const id = addFinding(repo, input()).id;
  const original = JSON.parse(readFileSync(stored(id), "utf8"));
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
    assert.throws(() => listFindings(repo), fails(1));
    assert.throws(() => addFinding(repo, input()), fails(1));
    assert.deepEqual(readFileSync(stored(id)), before);
  }
  for (const bytes of [Buffer.from("{"), Buffer.from([0xff]), Buffer.alloc(1024 * 1024 + 1)]) {
    writeFileSync(stored(id), bytes);
    assert.throws(() => showFinding(repo, id), fails(1));
  }
  rmSync(stored(id));
  const outside = join(env.root, "record.json");
  writeFileSync(outside, JSON.stringify(original));
  symlinkSync(outside, stored(id));
  assert.throws(() => addFinding(repo, input()), fails(1));
  assert.throws(() => showFinding(repo, id), fails(1));
  assert.deepEqual(JSON.parse(readFileSync(outside, "utf8")), original);
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
