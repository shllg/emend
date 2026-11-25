import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import {
  copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test, type TestContext } from "node:test";
import { outsideScope } from "./check-ui-scope.ts";
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

function repository(t: TestContext) {
  const temp = mkdtempSync(join(tmpdir(), "recense-ui-scope-"));
  t.after(() => rmSync(temp, { recursive: true, force: true }));
  const cwd = join(temp, "tree");
  mkdirSync(cwd);
  const env = childEnvironment(temp, process.platform);
  const git = (...args: string[]) => execFileSync("git", args, { cwd, env });
  git("init", "-q");
  git("config", "user.name", "Example");
  git("config", "user.email", "review@example.com");
  git("config", "commit.gpgsign", "false");
  const checker = join(temp, "check-ui-scope.mts");
  copyFileSync(join(import.meta.dirname, "check-ui-scope.ts"), checker);
  const check = (...args: string[]) =>
    spawnSync(process.execPath, [checker, ...args], { cwd, env, encoding: "utf8" });
  return { cwd, git, check, snapshot: join(temp, "ignored.json") };
}

test("the CLI prints tracked, index-only and untracked violations once each", (t) => {
  const { cwd, git, check } = repository(t);
  for (const name of ["staged", "tracked"]) writeFileSync(join(cwd, name), "base");
  git("add", ".");
  git("commit", "-qm", "base");
  assert.equal(check("--since", "HEAD").status, 0);
  assert.equal(check().status, 2);
  assert.equal(check("--since", "missing").status, 2);
  for (const name of ["staged", "tracked", "untracked file"]) writeFileSync(join(cwd, name), "new");
  git("add", "staged");
  writeFileSync(join(cwd, "staged"), "base");
  const checked = check("--since", "HEAD");
  assert.equal(checked.status, 1, checked.stderr);
  assert.equal(checked.stdout, "staged\ntracked\nuntracked file\n");
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
    "node_modules/root", "nested/node_modules/file", ".tsbuild/root", "nested/.tsbuild/file",
    "apps/web/dist/index.html", "apps/recense/dist/cli", ".wt/ui/phone.png", ".wt/ui-demo.json",
    ".wt/ui-demo.json.pending", ".claude/scheduled_tasks.lock",
  ];
  for (const path of [...skipped, ".wt/changed", "removed", "link-target"]) write(path, "old");
  symlinkSync("link-target", join(cwd, "unchanged-link"));
  symlinkSync("missing", join(cwd, "changed-link"));
  symlinkSync(".", join(cwd, "cycle"));
  const taken = check("--snapshot", snapshot);
  assert.equal(taken.status, 0, taken.stderr);
  assert.equal(statSync(snapshot).mode & 0o777, 0o600);
  const original = readFileSync(snapshot, "utf8");
  assert.equal(check("--since", "HEAD", "--snapshot", snapshot).status, 0);
  for (const path of [...skipped, ".wt/changed", ".wt/new", "link-target"]) write(path, "new");
  rmSync(join(cwd, "removed"));
  rmSync(join(cwd, "changed-link"));
  symlinkSync("new-target", join(cwd, "changed-link"));
  assert.equal(check("--snapshot", snapshot).status, 2);
  assert.equal(readFileSync(snapshot, "utf8"), original);
  const checked = check("--since", "HEAD", "--snapshot", snapshot);
  assert.equal(checked.status, 1, checked.stderr);
  assert.deepEqual(checked.stdout.trimEnd().split("\n"), [
    "ignored: .wt/changed", "ignored: .wt/new", "ignored: changed-link", "ignored: link-target",
    "ignored: removed",
  ]);
});

test("both index flags are reported even on allowed paths, with and without a snapshot", (t) => {
  const { cwd, git, check, snapshot } = repository(t);
  const dir = "apps/web/public";
  mkdirSync(join(cwd, dir), { recursive: true });
  for (const name of ["assumed", "skipped"]) writeFileSync(join(cwd, dir, name), "base");
  git("add", ".");
  git("commit", "-qm", "base");
  assert.equal(check("--snapshot", snapshot).status, 0);
  git("update-index", "--assume-unchanged", `${dir}/assumed`);
  git("update-index", "--skip-worktree", `${dir}/skipped`);
  for (const args of [[], ["--snapshot", snapshot]]) {
    const checked = check("--since", "HEAD", ...args);
    assert.equal(checked.status, 1, checked.stderr);
    assert.equal(checked.stdout, `index flag: ${dir}/assumed\nindex flag: ${dir}/skipped\n`);
  }
});
