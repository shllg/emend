// Stdio belongs to the MCP child. Wrapper diagnostics go to stderr.
import { spawn } from "node:child_process";
import { lstatSync, readFileSync } from "node:fs";
import { constants } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { findChromium } from "./screenshots/browser.ts";

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

async function main(): Promise<number> {
  const top = resolve(import.meta.dirname, "..");
  const port = worktreePort(top);
  const chromium = findChromium(undefined, process.platform);
  const directory = join(top, "node_modules", "chrome-devtools-mcp");
  const pkg = JSON.parse(readFileSync(join(directory, "package.json"), "utf8"));
  if (pkg.version !== "1.13.0") throw new Error("Expected chrome-devtools-mcp 1.13.0");
  const bin = join(directory, pkg.bin["chrome-devtools-mcp"]);
  const child = spawn(process.execPath, [bin, ...browserArgs({ port, chromium })], {
    cwd: top, env: browserEnv(process.env), stdio: "inherit",
  });
  for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"] as const)
    process.on(signal, () => child.kill(signal));
  return new Promise((done, reject) => {
    child.once("error", reject);
    child.once("exit", (code, signal) => done(code ?? (signal ? 128 + constants.signals[signal] : 1)));
  });
}

if (import.meta.main) {
  try {
    process.exitCode = await main();
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
