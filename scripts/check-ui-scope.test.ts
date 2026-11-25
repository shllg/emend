import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync, copyFileSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync,
  statSync, symlinkSync, utimesSync, writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test, type TestContext } from "node:test";
import { outsideScope, worktreeEntry } from "./check-ui-scope.ts";
import { childEnvironment } from "./screenshots/safety.ts";

test("presentation components, routes, styles, public assets and UI tests are in scope", () => {
  assert.deepEqual(outsideScope([
    "apps/web/src/components/reading/ReadingMenu.tsx", "apps/web/src/routes/inbox.tsx",
    "apps/web/src/components/diff/LineTotals.tsx",
    "apps/web/src/components/review/LayoutControls.tsx",
    "apps/web/src/components/threads/DraftList.tsx", "apps/web/src/pins-ui.test.tsx",
    "apps/web/src/styles/inbox.css", "apps/web/src/styles.css", "apps/web/src/App.tsx",
    "apps/web/index.html", "apps/web/public/images/icon.png", "apps/web/src/ui.test.ts",
    "apps/web/src/ui.test.tsx",
  ]), []);
});

test("server, data access, navigation and content boundaries stay out of scope", () => {
  const paths = [
    "AGENTS.md", "apps/web/src/api/list.ts", "apps/web/src/lib/store.ts",
    "apps/web/src/test/helpers.ts", "apps/web/src/main.tsx", "apps/web/src/router.tsx",
    ...["BlockView.tsx", "HtmlDocFrame.tsx", "HtmlDiagramRenderer.tsx", "MermaidBlock.tsx"]
      .map((name) => `apps/web/src/components/reading/${name}`),
    ...["SW.js", "sw-worker.js", "Mermaid.css", "HTML-Bridge.ts", "html-doc.ts",
      "Sanitize.ts", "frame-build.ts"].map((name) => `apps/web/public/${name}`),
  ];
  assert.deepEqual(outsideScope([...paths, ...paths]), paths.sort());
});

test("content validation, frames and their tests are outside the finisher scope", () => {
  const paths = [
    "App.test.tsx", "diff-boundary.test.ts", "lifecycle-ui.test.tsx", "main.test.tsx",
    "reading-navigation.test.tsx", "reading-position.test.tsx", "reading.test.tsx",
    "source.test.tsx", "routes/review.tsx", "routes/theme-sample.test.tsx",
    ...["comment-lines.test.tsx", "parse-client.test.ts", "parse-client.ts", "parse.worker.ts",
      "render.test.tsx", "visibility.test.tsx", "worker-pool.test.tsx", "worker-render.test.tsx"]
      .map((file) => `components/diff/${file}`),
    ...["ChartBlock.test.tsx", "ChartBlock.tsx", "DocView.tsx", "GlossaryTerms.tsx",
      "IssueCards.tsx", "SourceView.tsx", "agent-note-refs.test.tsx", "agent-note-refs.ts",
      "glossary-terms.test.tsx", "highlights.test.tsx", "html-diagrams.test.ts", "html-diagrams.ts",
      "issue-cards.test.tsx", "lightbox.test.tsx", "screenshots.ts", "thread-marks.test.tsx",
      "writeup.test.tsx"].map((file) => `components/reading/${file}`),
    "components/review/ReviewHeader.test.tsx", "components/review/ReviewHeader.tsx",
    "components/threads/threads.test.tsx",
  ].map((file) => `apps/web/src/${file}`);
  assert.deepEqual(outsideScope(paths), paths.sort());
});

function repository(t: TestContext, format = "sha1") {
  const temp = mkdtempSync(join(tmpdir(), "recense-ui-scope-"));
  t.after(() => rmSync(temp, { recursive: true, force: true }));
  const cwd = join(temp, "tree");
  mkdirSync(cwd);
  const env = childEnvironment(temp, process.platform);
  const git = (...args: string[]) => execFileSync("git", args, { cwd, env });
  git("init", "-q", "--object-format=" + format);
  git("config", "user.name", "Example");
  git("config", "user.email", "review@example.com");
  git("config", "commit.gpgsign", "false");
  const checker = join(temp, "check-ui-scope.mts");
  copyFileSync(join(import.meta.dirname, "check-ui-scope.ts"), checker);
  const trace = join(temp, "git-trace.jsonl");
  const checkAt = (tree: string, ...args: string[]) =>
    spawnSync(process.execPath, [checker, ...args], {
      cwd: tree, encoding: "utf8",
      env: { ...env, GIT_TRACE2_EVENT: trace, GIT_TRACE2_ENV_VARS: "GIT_OPTIONAL_LOCKS" },
    });
  const check = (...args: string[]) => checkAt(cwd, ...args);
  const snapshot = join(temp, "ignored.json");
  function takeSnapshot(tree = cwd) {
    const base = git("-C", tree, "rev-parse", "HEAD").toString().trim();
    const taken = checkAt(tree, "--snapshot", snapshot);
    assert.equal(taken.status, 0, taken.stderr);
    const digest = taken.stdout.trim().split(" ").at(-1)!;
    return () => checkAt(tree, "--since", base, "--snapshot", snapshot,
      "--snapshot-sha256", digest);
  }
  return { cwd, git, env, check, trace, snapshot, takeSnapshot };
}

test("the CLI prints tracked, index-only and untracked violations once each", (t) => {
  const { cwd, git, check, trace } = repository(t);
  for (const name of ["staged", "tracked"]) writeFileSync(join(cwd, name), "base");
  git("add", ".");
  git("commit", "-qm", "base");
  const base = git("rev-parse", "HEAD").toString().trim();
  assert.equal(check("--since", base).status, 0);
  assert.equal(check().status, 2);
  for (const ref of ["HEAD", base.slice(0, 12), "missing", base + "f", "0".repeat(40)]) {
    const refused = check("--since", ref);
    assert.equal(refused.status, 2);
    assert.match(refused.stderr, /Usage:/);
  }
  for (const name of ["staged", "tracked", "untracked file"]) writeFileSync(join(cwd, name), "new");
  git("add", "staged");
  writeFileSync(join(cwd, "staged"), "base");
  const checked = check("--since", base);
  assert.equal(checked.status, 1, checked.stderr);
  assert.equal(checked.stdout, 'staged\ntracked\n"untracked file"\n');
  const events = readFileSync(trace, "utf8").trimEnd().split("\n").map((line) => JSON.parse(line));
  const calls = events.filter((event) => event.event === "start");
  assert(calls.length > 0);
  const options = [
    "--no-replace-objects", "-c", "core.fsmonitor=false", "-c", "core.untrackedCache=false",
    "-c", "core.fileMode=true", "-c", "core.trustctime=true", "-c", "core.checkStat=default",
    "-c", "core.symlinks=true",
  ];
  for (const { argv, sid } of calls) {
    assert.deepEqual(argv.slice(1, 1 + options.length), options);
    assert(events.some((e) => e.sid === sid && e.event === "def_param" &&
      e.param.endsWith("GIT_OPTIONAL_LOCKS") && e.value === "0"));
  }
});

test("a sha256 repository requires its full commit id", (t) => {
  const { git, check } = repository(t, "sha256");
  git("commit", "-qm", "base", "--allow-empty");
  const base = git("rev-parse", "HEAD").toString().trim();
  assert.equal(base.length, 64);
  assert.equal(check("--since", base).status, 0);
  assert.equal(check("--since", base.slice(0, 40)).status, 2);
  assert.equal(check("--since", git("rev-parse", "HEAD^{tree}").toString().trim()).status, 2);
});

test("the snapshot detects ignored edits, additions and removals without following links", (t) => {
  const { cwd, git, check, snapshot } = repository(t);
  writeFileSync(join(cwd, ".gitignore"), "*\n!.gitignore\n");
  git("add", ".gitignore");
  git("commit", "-qm", "base");
  function write(file: string, body: string) {
    mkdirSync(dirname(join(cwd, file)), { recursive: true });
    writeFileSync(join(cwd, file), body);
  }
  const skipped = [
    "node_modules/.vite/root", "apps/web/node_modules/.cache/file",
    "packages/core/node_modules/.vite/file",
    "apps/web/dist/index.html", "apps/recense/dist/cli", ".wt/ui/phone.png", ".wt/ui-demo.json",
    ".wt/ui-demo.json.pending", ".claude/scheduled_tasks.lock", ".tsbuild/root",
    "packages/core/.tsbuild/file",
  ];
  const installed = ["node_modules/root", "apps/web/node_modules/pkg/file",
    "packages/core/node_modules/pkg/.cache/file"];
  const hashed = ["nested/.tsbuild/file", "nested/node_modules/file"];
  for (const path of [...skipped, ...installed, ...hashed, ".wt/changed", "removed", "link-target"])
    write(path, "old");
  symlinkSync("link-target", join(cwd, "unchanged-link"));
  symlinkSync("missing", join(cwd, "changed-link"));
  symlinkSync("root", join(cwd, "node_modules/link"));
  symlinkSync(".", join(cwd, "cycle"));
  const taken = check("--snapshot", snapshot);
  assert.equal(taken.status, 0, taken.stderr);
  assert.equal(statSync(snapshot).mode & 0o777, 0o600);
  const original = readFileSync(snapshot, "utf8");
  const digest = createHash("sha256").update(original).digest("hex");
  assert.equal(taken.stdout, `snapshot sha256: ${digest}\n`);
  const { files: entries, main } = JSON.parse(original);
  assert.deepEqual(main, {});
  for (const path of installed) {
    const stat = lstatSync(join(cwd, path), { bigint: true });
    assert.equal(entries[path], ["meta", stat.size, stat.mode, stat.ino, stat.dev, stat.nlink,
      stat.mtimeNs, stat.ctimeNs].join(":"));
  }
  for (const path of hashed)
    assert.equal(entries[path], createHash("sha256").update("old").digest("hex"));
  assert.equal(entries["node_modules/link"], "link:" + createHash("sha256").update("root")
    .digest("hex"));
  const base = git("rev-parse", "HEAD").toString().trim();
  const compare = () => check("--since", base, "--snapshot", snapshot, "--snapshot-sha256", digest);
  assert.equal(check("--since", base, "--snapshot", snapshot).status, 2);
  assert.equal(compare().status, 0);
  write("apps/web/.tsbuild/new", "new");
  write("apps/web/src/.tsbuild/new", "new");
  write("node_modules/.vitest-cache/new", "new");
  write("node_modules/.vitest-cache-extra/new", "new");
  const nested = "apps/web/src/components/node_modules/new";
  for (const path of [...skipped, ...installed, ...hashed, ".wt/changed", ".wt/new", "link-target",
    nested]) write(path, "changed");
  rmSync(join(cwd, "removed"));
  rmSync(join(cwd, "changed-link"));
  symlinkSync("new-target", join(cwd, "changed-link"));
  assert.equal(check("--snapshot", snapshot).status, 2);
  assert.equal(readFileSync(snapshot, "utf8"), original);
  const checked = compare();
  assert.equal(checked.status, 1, checked.stderr);
  assert.deepEqual(checked.stdout.trimEnd().split("\n").sort(), [
    ...[...installed, ...hashed, ".wt/changed", "changed-link", "link-target"]
      .map((path) => "ignored changed: " + path),
    "ignored new: .wt/new", "ignored new: apps/web/src/.tsbuild/new", "ignored new: " + nested,
    "ignored new: node_modules/.vitest-cache-extra/new", "ignored removed: removed",
  ].sort());
  writeFileSync(snapshot, original + "\n");
  const tampered = compare();
  assert.equal(tampered.status, 2);
  assert.match(tampered.stderr, /snapshot sha256 differs/i);
});

test("both index flags are reported even on allowed paths, with and without a snapshot", (t) => {
  const { cwd, git, check, snapshot } = repository(t);
  const dir = "apps/web/public";
  mkdirSync(join(cwd, dir), { recursive: true });
  for (const name of ["assumed", "skipped"]) writeFileSync(join(cwd, dir, name), "base");
  git("add", ".");
  git("commit", "-qm", "base");
  const base = git("rev-parse", "HEAD").toString().trim();
  const taken = check("--snapshot", snapshot);
  assert.equal(taken.status, 0);
  const digest = taken.stdout.trim().split(" ").at(-1)!;
  git("update-index", "--assume-unchanged", `${dir}/assumed`);
  git("update-index", "--skip-worktree", `${dir}/skipped`);
  const fresh = snapshot + ".new";
  for (const args of [
    ["--snapshot", fresh], ["--since", base],
    ["--since", base, "--snapshot", snapshot, "--snapshot-sha256", digest],
  ]) {
    const checked = check(...args);
    assert.equal(checked.status, 1, checked.stderr);
    assert.equal(checked.stdout, `index flag: ${dir}/assumed\nindex flag: ${dir}/skipped\n`);
  }
  assert(!existsSync(fresh));
});

test("raw Git blobs match files and link targets in either object format", async (t) => {
  for (const format of ["sha1", "sha256"]) {
    const { cwd, git, env, check } = repository(t, format);
    const file = Buffer.alloc(2 * 1024 * 1024, 0xff);
    const target = Buffer.from("missing\nname");
    writeFileSync(join(cwd, "file"), file);
    symlinkSync(target, join(cwd, "link"));
    git("add", "file", "link");
    git("commit", "-qm", "base");
    const entries = [["file", "100644", file], ["link", "120000", target]] as const;
    for (const [path, mode, bytes] of entries) {
      const id = execFileSync("git", ["hash-object", "--no-filters", "--stdin"],
        { cwd, env, input: bytes }).toString().trim();
      const absolute = join(cwd, path);
      assert.equal(await worktreeEntry(absolute, lstatSync(absolute), format), mode + " " + id);
    }
    const base = git("rev-parse", "HEAD").toString().trim();
    const clean = check("--since", base);
    assert.equal(clean.status, 0, clean.stderr + clean.stdout);
  }
});

test("the base comparison detects content and mode changes with minimal Git stat checks", (t) => {
  const { cwd, git, takeSnapshot } = repository(t);
  git("config", "core.checkStat", "minimal");
  git("config", "core.trustctime", "false");
  git("config", "core.fileMode", "false");
  const file = join(cwd, "content");
  const mode = join(cwd, "mode");
  writeFileSync(file, "base");
  writeFileSync(mode, "");
  chmodSync(mode, 0o644);
  const time = new Date("2020-01-02T00:00:00Z");
  utimesSync(file, time, time);
  git("add", ".");
  git("commit", "-qm", "base");
  const compare = takeSnapshot();
  writeFileSync(file, "edit");
  utimesSync(file, time, time);
  chmodSync(mode, 0o755);
  const result = compare();
  assert.equal(result.status, 1, result.stderr);
  assert.equal(result.stdout, "content\nmode\n");
});

test("a same-size install edit is reported after restoring its mtime", (t) => {
  const { cwd, git, takeSnapshot } = repository(t);
  mkdirSync(join(cwd, "node_modules"));
  const file = join(cwd, "node_modules", "entry");
  writeFileSync(file, "base");
  const time = new Date("2020-01-02T00:00:00Z");
  utimesSync(file, time, time);
  writeFileSync(join(cwd, ".gitignore"), "node_modules/\n");
  git("add", ".gitignore");
  git("commit", "-qm", "base");
  const compare = takeSnapshot();
  writeFileSync(file, "edit");
  utimesSync(file, time, time);
  const result = compare();
  assert.equal(result.status, 1, result.stderr);
  assert.equal(result.stdout, "ignored changed: node_modules/entry\n");
});

test("only the expected upstream values on other branches can change silently", (t) => {
  const { git, takeSnapshot } = repository(t);
  git("commit", "-qm", "base", "--allow-empty");
  git("checkout", "-qb", "work/Topic.v1");
  const current = git("symbolic-ref", "--short", "-q", "HEAD").toString().trimEnd();
  git("config", `branch.${current}.merge`, "refs/heads/base");
  const compare = takeSnapshot();
  function expectConfigChange(changed: boolean) {
    const result = compare();
    assert.equal(result.status, changed ? 1 : 0, result.stderr + result.stdout);
    assert.equal(result.stdout, changed ? "git changed: config\n" : "");
  }

  git("config", "branch.other.remote", "origin");
  git("config", "branch.other.merge", "refs/heads/other");
  expectConfigChange(false);
  for (const remote of ["../other.git", "https://example.invalid/other.git", "origin\nextra"]) {
    git("config", "branch.other.remote", remote);
    expectConfigChange(true);
  }
  git("config", "branch.other.remote", "origin");
  git("config", "branch.other.merge", "refs/heads/main");
  expectConfigChange(true);
  git("config", "branch.other.merge", "refs/heads/other");
  expectConfigChange(false);
  git("config", "--remove-section", "branch.other");
  expectConfigChange(false);
  git("config", "branch.other.pushRemote", "publish");
  expectConfigChange(true);
  git("config", "--unset", "branch.other.pushRemote");
  git("config", `branch.${current}.merge`, "refs/heads/next");
  expectConfigChange(true);
  git("config", `branch.${current}.merge`, "refs/heads/base");
  git("config", `branch.${current}.remote`, "origin");
  expectConfigChange(true);
});

test("the current branch's merge setting is checked when a tag shares its name", (t) => {
  const { git, takeSnapshot } = repository(t);
  git("commit", "-qm", "base", "--allow-empty");
  const current = "work/Topic.v1";
  git("checkout", "-qb", current);
  git("tag", current);
  const compare = takeSnapshot();
  git("config", `branch.${current}.merge`, `refs/heads/${current}`);
  const result = compare();
  assert.equal(result.status, 1, result.stderr + result.stdout);
  assert.equal(result.stdout, "git changed: config\n");
});

for (const head of ["detached HEAD", "HEAD pointing at a tag"]) {
  test(`a ${head} includes every branch's upstream in the config digest`, (t) => {
    const { git, takeSnapshot } = repository(t);
    git("commit", "-qm", "base", "--allow-empty");
    if (head === "detached HEAD") git("checkout", "-q", "--detach");
    else {
      git("tag", "snapshot");
      git("symbolic-ref", "HEAD", "refs/tags/snapshot");
    }
    const compare = takeSnapshot();
    git("config", "branch.other.remote", "origin");
    const result = compare();
    assert.equal(result.status, 1, result.stderr + result.stdout);
    assert.equal(result.stdout, "git changed: config\n");
  });
}

test("a moved HEAD and changes to repository settings are reported by key", (t) => {
  const { cwd, git, takeSnapshot } = repository(t);
  git("commit", "-qm", "base", "--allow-empty");
  const info = join(cwd, ".git", "info", "extra");
  symlinkSync("old", info);
  const compare = takeSnapshot();
  git("checkout", "-q", "--detach");
  assert.equal(compare().stdout, "git changed: HEAD\n");
  git("commit", "-qm", "next", "--allow-empty");
  const head = git("rev-parse", "HEAD").toString().trim();
  git("config", "example.changed", "true");
  mkdirSync(join(cwd, ".git", "hooks", "nested"), { recursive: true });
  writeFileSync(join(cwd, ".git", "hooks", "nested", "new hook"), "hook");
  rmSync(info);
  symlinkSync("new", info);
  writeFileSync(join(cwd, ".git", "config.worktree"), "");
  const result = compare();
  assert.equal(result.status, 1, result.stderr);
  assert.deepEqual(result.stdout.trimEnd().split("\n"), [
    "head moved: " + head, "git changed: HEAD", "git changed: config",
    "git changed: config.worktree", 'git changed: "hooks/nested/new hook"',
    "git changed: info/extra",
  ]);
  rmSync(info);
  assert(compare().stdout.includes("git changed: info/extra\n"));
});

test("changed links and .git names are reported even in an allowed folder", (t) => {
  const { cwd, git, snapshot, takeSnapshot } = repository(t);
  const dir = "apps/web/public/";
  mkdirSync(join(cwd, dir), { recursive: true });
  writeFileSync(join(cwd, dir, "tracked"), "base");
  git("add", ".");
  git("commit", "-qm", "base");
  const compare = takeSnapshot();
  rmSync(join(cwd, dir, "tracked"));
  for (const name of ["new", "staged", "tracked"]) symlinkSync("missing", join(cwd, dir, name));
  git("add", dir + "staged");
  rmSync(join(cwd, dir, "staged"));
  writeFileSync(join(cwd, dir, "staged"), "regular again");
  writeFileSync(join(cwd, dir, ".gitattributes"), "*.css text\n");
  const result = compare();
  assert.equal(result.status, 1, result.stderr);
  assert.deepEqual(result.stdout.trimEnd().split("\n"), [
    dir + ".gitattributes", ...["new", "staged", "tracked"].map((name) => "symlink: " + dir + name),
  ]);
  assert.equal(readFileSync(join(dirname(snapshot), "restore.nul"), "utf8"),
    dir + "staged\0" + dir + "tracked\0");
  assert.equal(readFileSync(join(dirname(snapshot), "delete.nul"), "utf8"),
    dir + ".gitattributes\0" + dir + "new\0");
});

test("an unmerged index entry counts as changed even with the original blob", (t) => {
  const { cwd, git, env, takeSnapshot } = repository(t);
  writeFileSync(join(cwd, "file"), "base");
  git("add", ".");
  git("commit", "-qm", "base");
  const compare = takeSnapshot();
  const id = git("rev-parse", "HEAD:file").toString().trim();
  const input = "0 " + "0".repeat(40) + "\tfile\n100644 " + id + " 2\tfile\n";
  execFileSync("git", ["update-index", "--index-info"], { cwd, env, input });
  const result = compare();
  assert.equal(result.status, 1, result.stderr);
  assert.equal(result.stdout, "file\n");
});

test("step 2 restores and deletes literal names from separate, replaceable NUL lists", (t) => {
  const { cwd, env, git, snapshot, takeSnapshot } = repository(t);
  const tracked = '$(touch x) "tracked"';
  const ignored = '$(touch x) "ignored".tmp';
  const untracked = "-new";
  writeFileSync(join(cwd, ".gitignore"), "*.tmp\n");
  writeFileSync(join(cwd, tracked), "base");
  writeFileSync(join(cwd, "both.tmp"), "base");
  git("add", ".");
  git("add", "-f", "both.tmp");
  git("commit", "-qm", "base");
  const base = git("rev-parse", "HEAD").toString().trim();
  const compare = takeSnapshot();
  writeFileSync(join(cwd, tracked), "edit");
  git("add", "--", tracked);
  git("rm", "--cached", "both.tmp");
  for (const name of [ignored, untracked]) writeFileSync(join(cwd, name), "new");
  const temp = dirname(snapshot);
  const restore = join(temp, "restore.nul");
  const remove = join(temp, "delete.nul");
  for (const list of [restore, remove]) symlinkSync(snapshot, list);
  const result = compare();
  assert.equal(result.status, 1, result.stderr);
  assert.deepEqual(result.stdout.trimEnd().split("\n").sort(), [
    JSON.stringify(tracked), JSON.stringify(untracked), "both.tmp", "ignored new: both.tmp",
    "ignored new: " + JSON.stringify(ignored),
  ].sort());
  assert.equal(readFileSync(restore, "utf8"), tracked + "\0both.tmp\0");
  assert.equal(readFileSync(remove, "utf8"), ignored + "\0" + untracked + "\0");
  for (const list of [restore, remove]) assert.equal(lstatSync(list).mode & 0o777, 0o600);
  const cleanup = [
    'xargs -0 -r rm -f -- < "$1/delete.nul"',
    'test ! -s "$1/restore.nul" || git --no-replace-objects --literal-pathspecs ' +
      '-c core.fsmonitor=false restore --source="$2" --staged --worktree ' +
      '--pathspec-from-file="$1/restore.nul" --pathspec-file-nul',
  ].join("\n");
  execFileSync("sh", ["-ec", cleanup, "cleanup", temp, base], { cwd, env });
  const clean = compare();
  assert.equal(clean.status, 0, clean.stderr + clean.stdout);
  for (const list of [restore, remove]) assert.equal(statSync(list).size, 0);
  for (const name of [ignored, untracked, "x"]) assert(!existsSync(join(cwd, name)));
  for (const name of [tracked, "both.tmp"]) assert.equal(readFileSync(join(cwd, name), "utf8"),
    "base");
});

test("snapshot parts and their value formats are validated even with a matching digest", (t) => {
  const { git, check, snapshot } = repository(t);
  git("commit", "-qm", "base", "--allow-empty");
  const base = git("rev-parse", "HEAD").toString().trim();
  const parts = { files: {}, git: {}, main: {} };
  for (const invalid of [
    {}, { ...parts, extra: {} }, { ...parts, files: [] }, { ...parts, main: null },
    { ...parts, files: { bad: "meta:1:2:3:4" } }, { ...parts, main: { HEAD: 1 } },
    { ...parts, git: { config: "link:" + "a".repeat(64) } },
  ]) {
    const bytes = JSON.stringify(invalid);
    writeFileSync(snapshot, bytes);
    const digest = createHash("sha256").update(bytes).digest("hex");
    const result = check("--since", base, "--snapshot", snapshot, "--snapshot-sha256", digest);
    assert.equal(result.status, 2);
    assert.match(result.stderr, /Invalid snapshot/);
  }
});

test("a linked worktree compares the main checkout only while its Git settings match", (t) => {
  const { cwd, git, takeSnapshot, trace } = repository(t);
  mkdirSync(join(cwd, "bin"));
  const tool = join(cwd, "bin", "tool");
  writeFileSync(tool, "base");
  writeFileSync(join(cwd, ".gitignore"), ".claude/settings.local.json\n");
  git("add", ".");
  git("commit", "-qm", "base");
  const linked = join(dirname(cwd), "linked");
  git("worktree", "add", "-qb", "linked", linked);
  const dirty = join(cwd, "already changed");
  writeFileSync(dirty, "old");
  const compare = takeSnapshot(linked);
  mkdirSync(join(cwd, ".claude", "worktrees", "other"), { recursive: true });
  writeFileSync(join(cwd, ".claude", "worktrees", "other", "file"), "skip");
  assert.equal(compare().status, 0);
  writeFileSync(dirty, "new");
  writeFileSync(tool, "edit");
  writeFileSync(join(cwd, ".claude", "settings.local.json"), "{}");
  const edited = compare();
  assert.equal(edited.status, 1, edited.stderr);
  assert.deepEqual(edited.stdout.trimEnd().split("\n"), [
    "main changed: files/.claude/settings.local.json", "main changed: files/bin/tool",
    "main changed: status",
  ]);
  writeFileSync(tool, "base");
  assert(compare().stdout.includes("main changed: status\n"));
  writeFileSync(dirty, "old");
  git("commit", "-qm", "next", "--allow-empty");
  assert.equal(compare().stdout,
    "main changed: HEAD\nmain changed: files/.claude/settings.local.json\n");
  git("config", "example.changed", "true");
  writeFileSync(trace, "");
  const settings = compare();
  assert.equal(settings.status, 1, settings.stderr);
  assert.equal(settings.stdout, "git changed: config\n");
  const events = readFileSync(trace, "utf8").trimEnd().split("\n").map((line) => JSON.parse(line));
  assert(!events.some((e) => e.event === "def_repo" && e.worktree === cwd));
});
