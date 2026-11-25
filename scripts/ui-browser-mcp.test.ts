import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { browserArgs, browserEnv, worktreePort } from "./ui-browser-mcp.ts";

test("the browser is isolated, headless and sealed to the exact worktree port", () => {
  for (const port of [3637, 3656]) {
    const args = browserArgs({ port, chromium: "/synthetic/chromium" });
    assert.deepEqual(args, [
      "--headless",
      "--isolated",
      "--executablePath=/synthetic/chromium",
      `--allowedUrlPattern=http://127.0.0.1:${port}/*`,
      "--chromeArg=--host-resolver-rules=MAP * ~NOTFOUND , EXCLUDE 127.0.0.1",
      "--viewport=1600x1000",
    ]);
    assert(!args.some((arg) => /headless=false|--no-headless/.test(arg)));
  }
  assert.throws(() => browserArgs({ port: 3637, chromium: "chromium" }));
  for (const port of [3636, 3600, 3657, 3637.5])
    assert.throws(() => browserArgs({ port, chromium: "/synthetic/chromium" }));
});

test("the MCP child cannot discover config, report statistics or check for updates", () => {
  const base = Object.freeze({ PATH: "/bin", CHROME_DEVTOOLS_MCP_NO_CONFIG_DISCOVERY: "0" });
  assert.deepEqual(browserEnv(base), {
    PATH: "/bin",
    CHROME_DEVTOOLS_MCP_NO_CONFIG_DISCOVERY: "1",
    CHROME_DEVTOOLS_MCP_NO_USAGE_STATISTICS: "1",
    CHROME_DEVTOOLS_MCP_NO_UPDATE_CHECKS: "1",
  });
});

test("only a linked worktree with an allocated port can start the UI browser", (t) => {
  const top = mkdtempSync(join(tmpdir(), "recense-browser-test-"));
  t.after(() => rmSync(top, { recursive: true, force: true }));
  const git = join(top, ".git");
  const wt = join(top, ".wt");
  mkdirSync(wt);
  const record = join(wt, "worktree.json");
  writeFileSync(record, JSON.stringify({ port: 3637 }));
  assert.throws(() => worktreePort(top));
  mkdirSync(git);
  assert.throws(() => worktreePort(top));
  rmSync(git, { recursive: true });
  writeFileSync(git, "gitdir: synthetic");
  rmSync(record);
  assert.throws(() => worktreePort(top));
  for (const port of [3636, 3657, 3600, 3637.1, null, "3637"]) {
    writeFileSync(record, JSON.stringify({ port }));
    assert.throws(() => worktreePort(top));
  }
  for (const port of [3637, 3656]) {
    writeFileSync(record, JSON.stringify({ port }));
    assert.equal(worktreePort(top), port);
  }
});
