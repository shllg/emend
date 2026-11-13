import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";
import {
  checkSync as runCheckSync,
  globToRegExp,
  isValidSyncTrailer,
  lastParagraphSyncValues,
} from "./check-sync.ts";

const home = mkdtempSync(path.join(tmpdir(), "sync-home-"));
const childEnv = {
  ...(process.env.PATH !== undefined ? { PATH: process.env.PATH } : {}),
  ...(process.env.TMPDIR !== undefined ? { TMPDIR: process.env.TMPDIR } : {}),
  HOME: home,
  LC_ALL: "C",
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_NOSYSTEM: "1",
};
const nodeTestContext = process.env.NODE_TEST_CONTEXT;
// checkSync's internal git calls inherit this process's environment.
for (const key of Object.keys(process.env)) delete process.env[key];
Object.assign(process.env, childEnv);
if (nodeTestContext !== undefined) process.env.NODE_TEST_CONTEXT = nodeTestContext;

const temps: string[] = [home];

after(() => {
  for (const dir of temps) rmSync(dir, { recursive: true, force: true });
});

function checkSync(options: Parameters<typeof runCheckSync>[0]) {
  const context = process.env.NODE_TEST_CONTEXT;
  delete process.env.NODE_TEST_CONTEXT;
  try {
    return runCheckSync(options);
  } finally {
    if (context !== undefined) process.env.NODE_TEST_CONTEXT = context;
  }
}

function git(dir: string, ...args: string[]): string {
  return execFileSync(
    "git",
    ["-C", dir, "-c", "user.name=t", "-c", "user.email=t@example.invalid", "-c", "commit.gpgsign=false", ...args],
    { env: childEnv, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
  );
}

function write(dir: string, file: string, content: string): void {
  const full = path.join(dir, file);
  mkdirSync(path.dirname(full), { recursive: true });
  writeFileSync(full, content);
}

function commit(dir: string, files: Record<string, string>, message: string): void {
  for (const [file, content] of Object.entries(files)) write(dir, file, content);
  git(dir, "add", "-A");
  git(dir, "commit", "-m", message);
}

/** A repo on main with an initial commit, optionally with a manifest, and a feature branch. */
function makeRepo(manifest?: string): string {
  const dir = mkdtempSync(path.join(tmpdir(), "sync-"));
  temps.push(dir);
  git(dir, "init", "-b", "main");
  const files: Record<string, string> = { "README.md": "hello\n" };
  if (manifest !== undefined) files["sync/manifest.json"] = manifest;
  commit(dir, files, "chore: start");
  git(dir, "switch", "-c", "feat/x");
  return dir;
}

const contractManifest = JSON.stringify({
  version: 1,
  surfaces: [{ id: "page", self: ["src/contract/**"], counterpart: "page" }],
});

test("fixture commits and sync checks ignore the caller's GIT_DIR", () => {
  const decoy = makeRepo();
  const before = git(decoy, "rev-parse", "HEAD");
  const previous = process.env.GIT_DIR;
  try {
    process.env.GIT_DIR = path.join(decoy, ".git");
    const dir = makeRepo(contractManifest);
    commit(dir, { "src/contract/page.ts": "export {};\n" }, "feat(contract): fixture only");
    assert.equal(git(dir, "log", "-1", "--format=%s").trim(), "feat(contract): fixture only");
    assert.equal(git(dir, "ls-files", "src/contract/page.ts").trim(), "src/contract/page.ts");

    // Re-enter the real file setup with poisoned input, selecting only a test
    // that exercises both fixture commits and checkSync's own inherited git calls.
    const stdout = execFileSync(
      process.execPath,
      [
        "--test",
        "--test-reporter=tap",
        "--test-name-pattern=^a commit under sync/ without a trailer fails$",
        fileURLToPath(import.meta.url),
      ],
      {
        env: { ...childEnv, GIT_DIR: process.env.GIT_DIR },
        encoding: "utf8",
        timeout: 10_000,
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    assert.match(stdout, /^ok \d+ - a commit under sync\/ without a trailer fails\r?$/m);
    assert.match(stdout, /^# tests 1\r?$/m);
    assert.match(stdout, /^# pass 1\r?$/m);
    assert.equal(git(decoy, "rev-parse", "HEAD"), before);
    assert.equal(git(decoy, "ls-files").trim(), "README.md");
  } finally {
    if (previous === undefined) delete process.env.GIT_DIR;
    else process.env.GIT_DIR = previous;
  }
});

test("globToRegExp matches ** across directories", () => {
  const re = globToRegExp("src/contract/**");
  assert.ok(re.test("src/contract/page.ts"));
  assert.ok(re.test("src/contract/a/b.ts"));
  assert.ok(!re.test("src/contractx/a.ts"));
});

test("globToRegExp keeps * inside one segment", () => {
  const re = globToRegExp("cli/*.ts");
  assert.ok(re.test("cli/take.ts"));
  assert.ok(!re.test("cli/a/take.ts"));
});

test("globToRegExp lets **/ match zero directories", () => {
  const re = globToRegExp("**/*.md");
  assert.ok(re.test("a.md"));
  assert.ok(re.test("x/y/a.md"));
});

test("globToRegExp treats ? as one non-slash character and escapes dots", () => {
  const re = globToRegExp("a?.ts");
  assert.ok(re.test("ab.ts"));
  assert.ok(!re.test("a/.ts"));
  assert.ok(!re.test("abxts"));
});

test("isValidSyncTrailer accepts each form", () => {
  assert.ok(isValidSyncTrailer("hunk-review-skill@abc1234"));
  assert.ok(isValidSyncTrailer(`hunk-review-skill@${"a".repeat(40)}`));
  assert.ok(isValidSyncTrailer("none — fixture only"));
  assert.ok(isValidSyncTrailer("none - fixture only"));
  assert.ok(isValidSyncTrailer("none -- fixture only"));
  assert.ok(isValidSyncTrailer("pending hunk-review-skill A3"));
});

test("isValidSyncTrailer rejects malformed values", () => {
  assert.ok(!isValidSyncTrailer("hunk-review-skill@xyz"));
  assert.ok(!isValidSyncTrailer("hunk-review-skill@abc12"));
  assert.ok(!isValidSyncTrailer("none —"));
  assert.ok(!isValidSyncTrailer("none"));
  assert.ok(!isValidSyncTrailer("pending"));
  assert.ok(!isValidSyncTrailer("pending hunk-review-skill"));
  assert.ok(!isValidSyncTrailer("vendis-ai/hunk-review-skill@abc1234"));
});

test("a commit under sync/ without a trailer fails", () => {
  const dir = makeRepo();
  commit(dir, { "sync/manifest.json": '{"version":1,"surfaces":[]}' }, "chore(sync): add manifest");
  const { errors } = checkSync({ cwd: dir, base: "main" });
  assert.equal(errors.length, 1);
  assert.match(errors[0], /chore\(sync\): add manifest/);
  assert.match(errors[0], /sync\/manifest\.json/);
  assert.match(errors[0], /Sync: none — <reason>/);
});

test("the same commit with a none trailer passes", () => {
  const dir = makeRepo();
  commit(
    dir,
    { "sync/manifest.json": '{"version":1,"surfaces":[]}' },
    "chore(sync): add manifest\n\nSync: none — fixture only",
  );
  const { errors, summary } = checkSync({ cwd: dir, base: "main" });
  assert.deepEqual(errors, []);
  assert.equal(summary, "check:sync ok: 1 commits since main, 1 touch shared surfaces");
});

test("a commit touching only README.md passes", () => {
  const dir = makeRepo();
  commit(dir, { "README.md": "changed\n" }, "docs: tweak readme");
  const { errors, summary } = checkSync({ cwd: dir, base: "main" });
  assert.deepEqual(errors, []);
  assert.equal(summary, "check:sync ok: 1 commits since main, 0 touch shared surfaces");
});

test("a self path from the manifest needs a trailer", () => {
  const dir = makeRepo(contractManifest);
  commit(dir, { "src/contract/page.ts": "export {};\n" }, "feat(contract): add page");
  assert.equal(checkSync({ cwd: dir, base: "main" }).errors.length, 1);
});

test("a self path from the manifest passes with a commit-hash trailer", () => {
  const dir = makeRepo(contractManifest);
  commit(
    dir,
    { "src/contract/page.ts": "export {};\n" },
    "feat(contract): add page\n\nSync: hunk-review-skill@abc1234",
  );
  assert.deepEqual(checkSync({ cwd: dir, base: "main" }).errors, []);
});

test("a merge commit is not checked", () => {
  const dir = makeRepo();
  git(dir, "switch", "-c", "other", "main");
  commit(dir, { "sync/a.json": "{}\n" }, "chore(sync): add a\n\nSync: none — fixture only");
  git(dir, "switch", "feat/x");
  commit(dir, { "README.md": "changed\n" }, "docs: tweak readme");
  git(dir, "merge", "--no-ff", "-m", "merge other", "other");
  const { errors, summary } = checkSync({ cwd: dir, base: "main" });
  assert.deepEqual(errors, []);
  assert.equal(summary, "check:sync ok: 2 commits since main, 1 touch shared surfaces");
});

test("an invalid manifest fails", () => {
  const dir = makeRepo("{ nope");
  const { errors } = checkSync({ cwd: dir, base: "main" });
  assert.equal(errors.length, 1);
  assert.match(errors[0], /sync\/manifest\.json is invalid/);
});

test("a manifest whose self is not an array of strings fails", () => {
  const dir = makeRepo('{"version":1,"surfaces":[{"id":"x","self":"src/**"}]}');
  assert.match(checkSync({ cwd: dir, base: "main" }).errors[0], /"self" as an array of strings/);
});

test("no commits ahead of main passes", () => {
  const dir = makeRepo();
  const { errors, summary } = checkSync({ cwd: dir, base: "main" });
  assert.deepEqual(errors, []);
  assert.equal(summary, "check:sync ok: 0 commits since main, 0 touch shared surfaces");
});

test("uncommitted shared changes add a note but do not fail", () => {
  const dir = makeRepo();
  write(dir, "sync/new.json", "{}\n");
  const { errors, notes } = checkSync({ cwd: dir, base: "main" });
  assert.deepEqual(errors, []);
  assert.equal(notes.length, 1);
  assert.match(notes[0], /^note: uncommitted changes touch shared surfaces \(sync\/new\.json\)/);
});

test("an unresolvable base asks for SYNC_BASE", () => {
  const dir = makeRepo();
  const { errors } = checkSync({ cwd: dir, base: "nope" });
  assert.match(errors[0], /set SYNC_BASE to the branch base/);
});

test("SYNC_BASE from the environment sets the base", () => {
  const dir = makeRepo();
  commit(dir, { "sync/a.json": "{}\n" }, "chore(sync): add a");
  process.env.SYNC_BASE = "feat/x~1";
  try {
    const { errors } = checkSync({ cwd: dir });
    assert.equal(errors.length, 1);
    assert.match(errors[0], /chore\(sync\): add a/);
    process.env.SYNC_BASE = "HEAD";
    assert.equal(checkSync({ cwd: dir }).summary, "check:sync ok: 0 commits since HEAD, 0 touch shared surfaces");
  } finally {
    delete process.env.SYNC_BASE;
  }
});

test("origin/main is preferred over main", () => {
  const dir = makeRepo();
  const origin = mkdtempSync(path.join(tmpdir(), "origin-"));
  temps.push(origin);
  git(origin, "init", "--bare", "-b", "main");
  git(dir, "remote", "add", "origin", origin);
  git(dir, "push", "-u", "origin", "main");
  git(dir, "switch", "main");
  commit(dir, { "sync/a.json": "{}\n" }, "chore(sync): local only");
  git(dir, "switch", "-c", "feat/y");
  // Against main nothing is ahead. Against origin/main the local commit counts and lacks a trailer.
  assert.deepEqual(checkSync({ cwd: dir, base: "main" }).errors, []);
  const { errors } = checkSync({ cwd: dir });
  assert.equal(errors.length, 1);
  assert.match(errors[0], /chore\(sync\): local only/);
});

test("a pending trailer passes", () => {
  const dir = makeRepo();
  commit(dir, { "sync/a.json": "{}\n" }, "chore(sync): add a\n\nSync: pending hunk-review-skill B9");
  assert.deepEqual(checkSync({ cwd: dir, base: "main" }).errors, []);
});

test("a Sync line that shares the last paragraph with a Closes line passes", () => {
  const dir = makeRepo();
  commit(dir, { "sync/a.json": "{}\n" }, "chore(sync): add a\n\nBody.\n\nCloses #80\nSync: none — fixture only");
  assert.deepEqual(checkSync({ cwd: dir, base: "main" }).errors, []);
});

test("a Sync line outside the last paragraph fails", () => {
  const dir = makeRepo();
  commit(dir, { "sync/a.json": "{}\n" }, "chore(sync): add a\n\nSync: none — fixture only\n\nCloses #80");
  assert.equal(checkSync({ cwd: dir, base: "main" }).errors.length, 1);
});

test("lastParagraphSyncValues reads only the last paragraph", () => {
  assert.deepEqual(lastParagraphSyncValues("feat: x\n\nCloses #80\nSync: none — reason\n"), [" none — reason"]);
  assert.deepEqual(lastParagraphSyncValues("feat: x\n\nSync: none — reason\n\nCloses #80\n"), []);
  assert.deepEqual(lastParagraphSyncValues("feat: x\n\nA line that mentions Sync: none — inline\n"), []);
});

test("an invalid trailer fails", () => {
  const dir = makeRepo();
  commit(dir, { "sync/a.json": "{}\n" }, "chore(sync): add a\n\nSync: bogus");
  assert.equal(checkSync({ cwd: dir, base: "main" }).errors.length, 1);
});

test("more than five shared files are summarized", () => {
  const dir = makeRepo();
  const files: Record<string, string> = {};
  for (let i = 1; i <= 7; i += 1) files[`sync/f${i}.json`] = "{}\n";
  commit(dir, files, "chore(sync): add seven");
  const { errors } = checkSync({ cwd: dir, base: "main" });
  assert.match(errors[0], /sync\/f1\.json, sync\/f2\.json, sync\/f3\.json, sync\/f4\.json, sync\/f5\.json and 2 more/);
});

test("a non-ASCII path under sync/ without a trailer fails", () => {
  const dir = makeRepo();
  commit(dir, { "sync/fixtures/café.json": "{}\n" }, "chore(sync): add cafe");
  const { errors } = checkSync({ cwd: dir, base: "main" });
  assert.equal(errors.length, 1);
  assert.match(errors[0], /sync\/fixtures\/café\.json/);
});

test("a staged rename out of sync/ adds a note naming the old path", () => {
  const dir = makeRepo();
  commit(dir, { "sync/a.json": "{}\n" }, "chore(sync): add a\n\nSync: none — fixture only");
  git(dir, "mv", "sync/a.json", "moved.json");
  const { errors, notes } = checkSync({ cwd: dir, base: "main" });
  assert.deepEqual(errors, []);
  assert.equal(notes.length, 1);
  assert.match(notes[0], /sync\/a\.json/);
});

test("a staged change adds a note", () => {
  const dir = makeRepo();
  write(dir, "sync/staged.json", "{}\n");
  git(dir, "add", "sync/staged.json");
  const { errors, notes } = checkSync({ cwd: dir, base: "main" });
  assert.deepEqual(errors, []);
  assert.match(notes[0], /sync\/staged\.json/);
});

test("a repository without commits has nothing to check", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "unborn-"));
  temps.push(dir);
  git(dir, "init", "-b", "main");
  const { errors, summary } = checkSync({ cwd: dir });
  assert.deepEqual(errors, []);
  assert.match(summary, /^check:sync ok: 0 commits/);
});
