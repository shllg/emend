import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import {
  existsSync, mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync, statSync, symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { buffer } from "node:stream/consumers";
import { test } from "node:test";
import {
  browserArgs, browserEnv, browserScratch, browserWorkspace, chromiumMajor, filterClientRoots,
  main, sealedBrowserEnv, worktreePort,
} from "./ui-browser-mcp.ts";

test("the browser is isolated, headless and sealed to the exact worktree port", () => {
  const paths = { chromium: "/synthetic/chromium", workspace: "/synthetic/.wt/ui" };
  for (const port of [3637, 3656]) {
    const args = browserArgs({ port, ...paths });
    assert.deepEqual(args, [
      "--headless",
      "--isolated",
      "--executablePath=/synthetic/chromium",
      `--allowedUrlPattern=http://127.0.0.1:${port}/*`,
      "--chromeArg=--host-resolver-rules=MAP * ~NOTFOUND , EXCLUDE 127.0.0.1",
      "--chromeArg=--force-webrtc-ip-handling-policy=disable_non_proxied_udp",
      "--workspace=/synthetic/.wt/ui",
      "--viewport=1600x1000",
      "--no-performance-crux",
    ]);
    assert(args.includes("--no-performance-crux"));
    assert(!args.some((arg) => /headless=false|--no-headless/.test(arg)));
  }
  assert.throws(() => browserArgs({ port: 3637, ...paths, chromium: "chromium" }));
  assert.throws(() => browserArgs({ port: 3637, ...paths, workspace: ".wt/ui" }));
  for (const port of [3636, 3600, 3657, 3637.5])
    assert.throws(() => browserArgs({ port, ...paths }));
});

function filtered(...chunks: Buffer[]): Promise<Buffer> {
  return buffer(Readable.from(chunks).pipe(filterClientRoots()));
}

test("initialize loses only the roots capability across three input chunks", async () => {
  const request = {
    jsonrpc: "2.0", id: 7, method: "initialize",
    params: { clientInfo: { name: "café" }, capabilities: { roots: {}, sampling: {} } },
  };
  const line = Buffer.from(`${JSON.stringify(request)}\r\n`);
  const split = line.indexOf("é") + 1;
  const result = await filtered(
    line.subarray(0, split), line.subarray(split, -1), line.subarray(-1),
  );
  const expected = { ...request, params: { ...request.params, capabilities: { sampling: {} } } };
  assert.equal(result.toString(), `${JSON.stringify(expected)}\n`);
});

test("other messages, invalid bytes, CRLF and trailing bytes pass through verbatim", async () => {
  const input = Buffer.concat([
    Buffer.from(' { "method": "ping", "params": { "capabilities": { "roots": {} } } }\r\n'),
    Buffer.from('[ { "id": 3, "result": {} } ]\n\n'),
    Buffer.from([0xff, 0x0a]),
    Buffer.from("unfinished"),
  ]);
  assert.deepEqual(await filtered(input), input);
});

test("a final batch without a newline filters every initialize request", async () => {
  const init = { method: "initialize", params: { capabilities: { roots: {} } } };
  const ping = { method: "ping", params: { capabilities: { roots: {} } } };
  const clean = { method: "initialize", params: { capabilities: {} } };
  const result = await filtered(Buffer.from(JSON.stringify([init, ping, init])));
  assert.equal(result.toString(), `${JSON.stringify([clean, ping, clean])}\n`);
});

test("the browser workspace is private and accepts only real directories", (t) => {
  const top = mkdtempSync(join(tmpdir(), "recense-browser-test-"));
  t.after(() => rmSync(top, { recursive: true, force: true }));
  const wt = join(realpathSync(top), ".wt");
  const ui = join(wt, "ui");
  assert.equal(browserWorkspace(top), ui);
  assert.equal(statSync(ui).mode & 0o777, 0o700);
  assert.equal(browserWorkspace(top), ui);
  rmSync(ui, { recursive: true });
  symlinkSync(top, ui, "dir");
  assert.throws(() => browserWorkspace(top));
  rmSync(ui);
  writeFileSync(ui, "");
  assert.throws(() => browserWorkspace(top));
  rmSync(wt, { recursive: true });
  symlinkSync(top, wt, "dir");
  assert.throws(() => browserWorkspace(top));
  assert(!existsSync(join(top, "ui")));
});

test("a temp parent inside protected state gets no scratch folder", (t) => {
  const state = mkdtempSync(join(tmpdir(), "recense-browser-test-"));
  t.after(() => rmSync(state, { recursive: true, force: true }));
  const parent = join(state, "tmp");
  mkdirSync(parent);
  const previous = { TMPDIR: process.env.TMPDIR, RECENSE_HOME: process.env.RECENSE_HOME };
  try {
    process.env.RECENSE_HOME = state;
    process.env.TMPDIR = parent;
    assert.throws(() => browserScratch(), /temporary directory overlaps real recense state/);
    assert.deepEqual(readdirSync(parent), []);
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
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
  assert.equal(chromiumMajor("Chromium 149.0.7520.0 snap"), 149);
  assert.equal(chromiumMajor("Google Chrome 150.0.1.2"), 150);
  assert.equal(chromiumMajor("Google Chrome 150.0.1.2 beta"), 150);
  assert.equal(chromiumMajor("Google Chrome for Testing 150.0.7700.0"), 150);
  assert.throws(() => chromiumMajor("Chromium 148.0.1.2"), /149.*found Chromium 148\.0\.1\.2/);
  assert.throws(() => chromiumMajor("garbage 150"), /Could not read the Chromium version/);
  assert.throws(() => chromiumMajor("garbage 150.0.1.2"), /Could not read the Chromium version/);
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
    'require("node:readline").createInterface({ input: process.stdin }).once("line", line => {',
    "  const msg = JSON.parse(line);",
    '  if (msg.method !== "initialize" || "roots" in msg.params.capabilities) process.exit(4);',
    '  writeFileSync("launched", "yes");',
    '  if (msg.id === "exit-after-initialize") process.exit(17);',
    '  process.stdin.once("data", () => process.exit(17));',
    "});",
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
    version("Chromium 150.0.1.2", 'kill -TERM "$PPID"\nexec sleep 15');
    const module = new URL("./ui-browser-mcp.ts", import.meta.url).href;
    const interrupted = spawnSync(process.execPath, [
      "--input-type=module", "-e", "await (await import(process.argv[1])).main(process.argv[2])",
      module, top,
    ], { timeout: 20_000, encoding: "utf8" });
    assert.equal(interrupted.status, 143, interrupted.stderr);
    assert(!existsSync(join(top, "launched")));
    clean();
    version("Google Chrome 149.1.2.3");
    // The child exits while the wrapper is still writing the large second line to its pipe.
    const init = { method: "initialize", params: { capabilities: { roots: {} } } };
    const wrapperArgs = [
      "--input-type=module", "-e",
      "process.exitCode = await (await import(process.argv[1])).main(process.argv[2])", module, top,
    ];
    const launched = spawnSync(process.execPath, wrapperArgs, {
      input: `${JSON.stringify(init)}\n${" ".repeat(4 * 1024 * 1024)}\n`,
      timeout: 20_000, encoding: "utf8",
    });
    assert.equal(launched.status, 17, launched.stderr);
    assert(existsSync(join(top, "launched")));
    clean();
    await t.test("the wrapper exits with the child while client stdin stays open", async () => {
      const wrapper = spawn(process.execPath, wrapperArgs, {
        stdio: ["pipe", "ignore", "inherit"], timeout: 20_000, killSignal: "SIGKILL",
      });
      const exited = once(wrapper, "exit");
      wrapper.stdin.write(`${JSON.stringify({ ...init, id: "exit-after-initialize" })}\n`);
      assert.deepEqual(await exited, [17, null]);
    });
    // The worktree disappears between the version probe and the MCP launch.
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
