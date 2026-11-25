// Stdio belongs to the MCP child. Wrapper diagnostics go to stderr.
import { type ChildProcess, execFile, spawn } from "node:child_process";
import { once } from "node:events";
import { lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { constants, tmpdir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { promisify } from "node:util";
import { findChromium } from "./screenshots/browser.ts";
import { childEnvironment } from "./screenshots/safety.ts";

function checkPort(port: unknown): number {
  if (typeof port !== "number" || !Number.isInteger(port) || port < 3637 || port > 3656)
    throw new Error("Expected a worktree port from 3637 to 3656");
  return port;
}

export function worktreePort(top: string): number {
  if (!isAbsolute(top) || !lstatSync(join(top, ".git"), { throwIfNoEntry: false })?.isFile())
    throw new Error("Run the UI browser in a linked worktree");
  return checkPort(JSON.parse(readFileSync(join(top, ".wt", "worktree.json"), "utf8")).port);
}

export function browserArgs({ port, chromium }: { port: number; chromium: string }): string[] {
  checkPort(port);
  if (!isAbsolute(chromium)) throw new Error("Expected an absolute Chromium path");
  return [
    "--headless",
    "--isolated",
    `--executablePath=${chromium}`,
    `--allowedUrlPattern=http://127.0.0.1:${port}/*`,
    "--chromeArg=--host-resolver-rules=MAP * ~NOTFOUND , EXCLUDE 127.0.0.1",
    "--viewport=1600x1000",
    "--no-performance-crux",
  ];
}

export function browserEnv(base: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return {
    ...base,
    CHROME_DEVTOOLS_MCP_NO_CONFIG_DISCOVERY: "1",
    CHROME_DEVTOOLS_MCP_NO_USAGE_STATISTICS: "1",
    CHROME_DEVTOOLS_MCP_NO_UPDATE_CHECKS: "1",
  };
}

export function sealedBrowserEnv(scratch: string): NodeJS.ProcessEnv {
  const env = childEnvironment(scratch, process.platform);
  for (const dir of [
    env.HOME, env.XDG_CONFIG_HOME, env.XDG_DATA_HOME, env.XDG_STATE_HOME, env.XDG_CACHE_HOME,
    env.XDG_RUNTIME_DIR, env.TMPDIR,
  ]) mkdirSync(dir, { mode: 0o700 });
  return browserEnv(env);
}

export function chromiumMajor(text: string): number {
  const match = /^.*?(?:Chromium|Chrome).*?[ \t]+(\d+)\.\d+\.\d+\.\d+(?=\s|$)/m.exec(text);
  if (!match) throw new Error("Could not read the Chromium version");
  const major = Number(match[1]);
  if (major < 149) throw new Error(`Chromium 149 or newer is required, found ${match[0]}`);
  return major;
}

export async function main(top: string): Promise<number> {
  const port = worktreePort(top);
  const chromium = findChromium(undefined, process.platform);
  const directory = join(top, "node_modules", "chrome-devtools-mcp");
  const pkg = JSON.parse(readFileSync(join(directory, "package.json"), "utf8"));
  if (pkg.version !== "1.13.0") throw new Error("Expected chrome-devtools-mcp 1.13.0");
  const bin = join(directory, pkg.bin["chrome-devtools-mcp"]);
  const signals = ["SIGINT", "SIGTERM", "SIGHUP"] as const;
  const probe = new AbortController();
  let scratch: string | undefined;
  let child: ChildProcess | undefined;
  function cleanup() {
    if (scratch) rmSync(scratch, { recursive: true, force: true });
  }
  function interrupt(signal: NodeJS.Signals) {
    if (child) {
      child.kill(signal);
      return;
    }
    try {
      probe.abort();
      cleanup();
    } finally {
      process.exit(128 + constants.signals[signal]);
    }
  }
  for (const signal of signals) process.on(signal, interrupt);
  try {
    scratch = mkdtempSync(join(realpathSync(tmpdir()), "recense-ui-browser-"));
    const env = sealedBrowserEnv(scratch);
    const version = await promisify(execFile)(chromium, ["--version"], {
      env, signal: probe.signal, timeout: 10_000, killSignal: "SIGKILL",
    });
    chromiumMajor(version.stdout);
    child = spawn(process.execPath, [bin, ...browserArgs({ port, chromium })], {
      cwd: top, env, stdio: "inherit",
    });
    const [code, signal] = await once(child, "exit") as [number | null, NodeJS.Signals | null];
    return code ?? (signal ? 128 + constants.signals[signal] : 1);
  } finally {
    try {
      cleanup();
    } finally {
      for (const signal of signals) process.off(signal, interrupt);
    }
  }
}

if (import.meta.main) {
  try {
    process.exitCode = await main(resolve(import.meta.dirname, ".."));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
