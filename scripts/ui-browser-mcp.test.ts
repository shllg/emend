import assert from "node:assert/strict";
import {
  existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, statSync, writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { browserArgs, browserEnv, chromiumMajor, main, sealedBrowserEnv, worktreePort }
  from "./ui-browser-mcp.ts";

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
      "--no-performance-crux",
    ]);
    assert(args.includes("--no-performance-crux"));
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

test("the MCP child gets private folders and no parent-only variable", (t) => {
  const scratch = mkdtempSync(join(tmpdir(), "recense-ui-browser-test-"));
  t.after(() => rmSync(scratch, { recursive: true, force: true }));
  const key = "RECENSE_UI_TEST_PARENT_ONLY";
  const saved = process.env[key];
  try {
    process.env[key] = "parent";
    const env = sealedBrowserEnv(scratch);
    assert.equal(env[key], undefined);
    assert.equal(env.HOME, join(scratch, "home"));
    assert.equal(env.TMPDIR, join(scratch, "tmp"));
    assert.equal(env.CHROME_DEVTOOLS_MCP_NO_CONFIG_DISCOVERY, "1");
    for (const folder of ["home", "config", "data", "state", "cache", "runtime", "tmp"]) {
      const info = statSync(join(scratch, folder));
      assert(info.isDirectory());
      assert.equal(info.mode & 0o777, 0o700);
    }
  } finally {
    if (saved === undefined) delete process.env[key];
    else process.env[key] = saved;
  }
});

test("only Chromium versions with URL filtering can start the MCP child", () => {
  assert.equal(chromiumMajor("Chromium 149.0.7520.0 Arch Linux\n"), 149);
  assert.equal(chromiumMajor("Google Chrome 150.0.1.2"), 150);
  assert.throws(() => chromiumMajor("Chromium 148.0.1.2"), /149.*found Chromium 148\.0\.1\.2/);
  assert.throws(() => chromiumMajor("garbage 150"), /Could not read the Chromium version/);
});

test("the version probe and MCP share a seal that is cleaned up on exit and failure", async (t) => {
  const temp = mkdtempSync(join(tmpdir(), "recense-browser-test-"));
  t.after(() => rmSync(temp, { recursive: true, force: true }));
  const chromium = join(temp, "chromium");
  const top = chromium + ".tree";
  const pkg = join(top, "node_modules", "chrome-devtools-mcp");
  mkdirSync(pkg, { recursive: true });
  mkdirSync(join(top, ".wt"));
  writeFileSync(join(top, ".git"), "gitdir: synthetic");
  writeFileSync(join(top, ".wt", "worktree.json"), JSON.stringify({ port: 3637 }));
  writeFileSync(join(pkg, "package.json"), JSON.stringify({
    version: "1.13.0", bin: { "chrome-devtools-mcp": "mcp.cjs" },
  }));
  writeFileSync(join(pkg, "mcp.cjs"), [
    'const { existsSync, writeFileSync } = require("node:fs");',
    'if (!existsSync(process.env.HOME + "/probe")) process.exit(2);',
    'if (process.env.CHROMIUM_PATH || !process.env.TMPDIR) process.exit(3);',
    'writeFileSync("launched", "yes");',
    'process.exit(17);',
  ].join("\n"));
  const version = (text: string, extra = "") => writeFileSync(chromium, [
    "#!/bin/sh", '[ "$1" = "--version" ] || exit 2', '[ -z "$CHROMIUM_PATH" ] || exit 3',
    'touch "$HOME/probe" || exit 4', extra, `echo "${text}"`,
  ].join("\n"), { mode: 0o700 });
  const clean = () =>
    assert(!readdirSync(temp).some((name) => name.startsWith("recense-ui-browser-")));
  const previous = { CHROMIUM_PATH: process.env.CHROMIUM_PATH, TMPDIR: process.env.TMPDIR };
  try {
    process.env.CHROMIUM_PATH = chromium;
    process.env.TMPDIR = temp;
    version("Chromium 148.1.2.3");
    await assert.rejects(main(top), /found Chromium 148/);
    assert(!existsSync(join(top, "launched")));
    clean();
    version("Google Chrome 149.1.2.3");
    assert.equal(await main(top), 17);
    assert(existsSync(join(top, "launched")));
    clean();
    // Moving the synthetic cwd after the probe makes the MCP spawn itself fail.
    version("Chromium 150.1.2.3", 'mv "$0.tree" "$0.moved" || exit 5');
    await assert.rejects(main(top), { code: "ENOENT" });
    clean();
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});
