import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { outsideScope } from "./check-ui-scope.ts";
import { childEnvironment } from "./screenshots/safety.ts";

test("presentation components, routes, styles, public assets and UI tests are in scope", () => {
  assert.deepEqual(outsideScope([
    "apps/web/src/components/reading/Reader.tsx", "apps/web/src/routes/review.tsx",
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

test("the CLI prints tracked, index-only and untracked violations once each", (t) => {
  const cwd = mkdtempSync(join(tmpdir(), "recense-ui-scope-"));
  t.after(() => rmSync(cwd, { recursive: true, force: true }));
  const env = childEnvironment(cwd, process.platform);
  const git = (...args: string[]) => execFileSync("git", args, { cwd, env });
  git("init", "-q");
  git("config", "user.name", "Example");
  git("config", "user.email", "review@example.com");
  git("config", "commit.gpgsign", "false");
  for (const name of ["staged", "tracked"]) writeFileSync(join(cwd, name), "base");
  git("add", ".");
  git("commit", "-qm", "base");
  const check = (...args: string[]) => spawnSync(process.execPath, [join(import.meta.dirname, "check-ui-scope.ts"), ...args], {
    cwd, env, encoding: "utf8",
  });
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
