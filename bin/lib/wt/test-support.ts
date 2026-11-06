/**
 * Shared base for the bin/wt tests. Not production code.
 *
 * makeTestEnv() builds a private HOME with an SSH signing key, a
 * directory of tool symlinks that becomes the whole PATH (so the real gh, herdr and fzf are unreachable),
 * and patches process.env to match. makeFixture() builds a main repository with a bare origin. installFake()
 * puts a fake gh, herdr or fzf on that PATH: it records its argv and replays canned output.
 *
 * Ports: makeTestEnv() moves the port range to 20 ports that testPortRange() claims for this process, so no test depends on
 * the developer's worktree servers (ports 3637 to 3656) being absent. A spawned child keeps the real range;
 * tests of spawned commands assert that a port lies inside it.
 *
 * A spawned bin/wt is the real launcher, with the same fake bin directory as its whole PATH.
 */
import { type ChildProcess, spawn, spawnSync } from "node:child_process";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import net from "node:net";
import os from "node:os";
import { delimiter, join } from "node:path";
import { run } from "./proc.ts";
import { setPortRangeForTests } from "./registry.ts";

export interface TestEnv {
  /** A temporary directory that holds everything below. */
  root: string;
  home: string;
  /** The only PATH entry: tool symlinks and the fakes. */
  fakeBin: string;
  /** The PATH the test process had before makeTestEnv() replaced it. */
  realPath: string;
  /** Removes `root` and restores process.env. Safe to call twice. */
  cleanup(): void;
}

const PATCHED = ["HOME", "PATH", "TERM"] as const;
const SCRUBBED_PREFIXES = [
  "GIT_",
  "HERDR_",
  "GH_",
  "GITHUB_",
  "CLAUDECODE",
  "NODE_OPTIONS",
  "WT_",
  "EMEND_PRIVATE_TERMS",
];

function findOnPath(name: string, pathValue: string): string | null {
  for (const dir of pathValue.split(delimiter)) {
    if (!dir) continue;
    const candidate = join(dir, name);
    if (existsSync(candidate)) return realpathSync(candidate);
  }
  return null;
}

/** Tools the fixture repositories need. Others (gh, herdr, fzf) come only from installFake(). */
const BASE_TOOLS = ["git", "ssh-keygen", "sh", "bash"];

const PORT_SLOT_SIZE = 20;
// Below 32768, so no kernel-chosen source port (Linux 32768 and up, macOS 49152 and up) can sit on a test port
// or connect to itself, which would make a closed port look busy.
const PORT_SLOT_BASE = 20000;
const PORT_SLOT_COUNT = 500;

const PORTS_FREE_SCRIPT =
  'const net=require("node:net");const min=Number(process.argv[1]);let n=0;' +
  `for(let i=0;i<${PORT_SLOT_SIZE};i++){const s=net.createServer();s.once("error",()=>process.exit(1));` +
  `s.listen(min+i,"127.0.0.1",()=>{if(++n===${PORT_SLOT_SIZE})process.exit(0)})}`;

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "EPERM";
  }
}

/** Takes the lock file exclusively. A lock whose process is dead is taken over. */
function takeLock(file: string): boolean {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      writeFileSync(file, String(process.pid), { flag: "wx" });
      return true;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "EEXIST") return false;
    }
    let owner: number;
    try {
      owner = Number(readFileSync(file, "utf8"));
    } catch {
      continue; // released meanwhile
    }
    if (Number.isInteger(owner) && owner > 0 && pidAlive(owner)) return false;
    try {
      // remove it only if it is still the dead owner's lock
      if (Number(readFileSync(file, "utf8")) === owner) rmSync(file, { force: true });
    } catch {
      // gone already
    }
  }
  return false;
}

let claimedRange: { min: number; max: number } | null = null;

/**
 * Twenty ports that no other test process of this machine uses. Each process claims a slot with an exclusive
 * lock file in the temporary directory (released on exit, taken over when its process is dead) and checks that
 * every port of the slot can be bound. The slot is fixed for the life of the process.
 */
export function testPortRange(): { min: number; max: number } {
  if (claimedRange) return claimedRange;
  const start = process.pid % PORT_SLOT_COUNT;
  const held: string[] = [];
  process.once("exit", () => {
    for (const file of held) {
      try {
        if (readFileSync(file, "utf8") === String(process.pid)) rmSync(file, { force: true });
      } catch {
        // already gone
      }
    }
  });
  for (let k = 0; k < PORT_SLOT_COUNT; k++) {
    const slot = (start + k) % PORT_SLOT_COUNT;
    const min = PORT_SLOT_BASE + slot * PORT_SLOT_SIZE;
    const file = join(os.tmpdir(), `wt-test-ports-${slot}.lock`);
    if (!takeLock(file)) continue;
    held.push(file); // kept even when the ports are busy, so this process does not retry the slot
    const probe = spawnSync(process.execPath, ["-e", PORTS_FREE_SCRIPT, String(min)], { timeout: 10_000 });
    if (probe.status === 0) {
      claimedRange = { min, max: min + PORT_SLOT_SIZE - 1 };
      return claimedRange;
    }
  }
  throw new Error("no free block of test ports");
}

let current: TestEnv | null = null;

export function makeTestEnv(): TestEnv {
  const realPath = process.env.PATH ?? "";
  const root = realpathSync(mkdtempSync(join(os.tmpdir(), "wt-test-")));
  const saved = new Map<string, string | undefined>();
  const restore = () => {
    for (const [key, value] of saved) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    saved.clear();
  };
  let cleaned = false;
  const cleanup = () => {
    if (cleaned) return;
    cleaned = true;
    restore();
    setPortRangeForTests(null);
    if (current?.root === root) current = null;
    rmSync(root, { recursive: true, force: true });
  };
  try {
    const home = join(root, "home");
    const fakeBin = join(root, "bin");
    mkdirSync(home, { mode: 0o700 });
    mkdirSync(fakeBin);

    const keygen = findOnPath("ssh-keygen", realPath);
    if (!keygen) throw new Error("ssh-keygen is needed to sign test commits");
    const key = join(home, "signing-key");
    const made = spawnSync(keygen, ["-q", "-t", "ed25519", "-N", "", "-C", "test", "-f", key], { encoding: "utf8" });
    if (made.status !== 0) throw new Error(`ssh-keygen failed: ${made.stderr}`);
    const allowed = join(home, "allowed_signers");
    writeFileSync(allowed, `test@example.invalid ${readFileSync(`${key}.pub`, "utf8")}`);
    writeFileSync(
      join(home, ".gitconfig"),
      [
        "[user]",
        "\tname = Test User",
        "\temail = test@example.invalid",
        `\tsigningkey = ${key}`,
        "[gpg]",
        "\tformat = ssh",
        '[gpg "ssh"]',
        `\tallowedSignersFile = ${allowed}`,
        "[commit]",
        "\tgpgsign = true",
        "[init]",
        "\tdefaultBranch = main",
        '[protocol "file"]',
        "\tallow = always",
        "",
      ].join("\n"),
    );

    for (const tool of BASE_TOOLS) {
      const target = findOnPath(tool, realPath);
      if (!target) throw new Error(`${tool} is needed by the tests`);
      symlinkSync(target, join(fakeBin, tool));
    }
    symlinkSync(process.execPath, join(fakeBin, "node"));

    for (const key2 of PATCHED) saved.set(key2, process.env[key2]);
    for (const key2 of Object.keys(process.env)) {
      if (SCRUBBED_PREFIXES.some((p) => key2.startsWith(p))) {
        saved.set(key2, process.env[key2]);
        delete process.env[key2];
      }
    }
    process.env.HOME = home;
    process.env.PATH = fakeBin;
    process.env.TERM = "dumb";
    setPortRangeForTests(testPortRange());
    current = { root, home, fakeBin, realPath, cleanup };
    return current;
  } catch (e) {
    cleanup();
    throw e;
  }
}

// ---------------------------------------------------------------------------------------------
// Fake executables

export interface FakeRule {
  /** Argv tokens that must appear in this order (not necessarily adjacent). Empty or absent: always matches. */
  match?: string[];
  stdout?: string;
  stderr?: string;
  code?: number;
  /** Use this rule at most N times; later calls fall through to the next rule. */
  times?: number;
}

const FAKE_SOURCE = `const fs = require("node:fs");
const path = require("node:path");
const self = fs.realpathSync(process.argv[1]);
const dir = path.dirname(self);
const name = path.basename(self);
const argv = process.argv.slice(2);
fs.appendFileSync(path.join(dir, "." + name + ".log"), JSON.stringify(argv) + "\\n");
const rules = JSON.parse(fs.readFileSync(path.join(dir, "." + name + ".rules.json"), "utf8"));
const stateFile = path.join(dir, "." + name + ".state.json");
let state = {};
try { state = JSON.parse(fs.readFileSync(stateFile, "utf8")); } catch {}
function matches(rule) {
  let at = 0;
  for (const token of rule.match || []) {
    const i = argv.indexOf(token, at);
    if (i === -1) return false;
    at = i + 1;
  }
  return true;
}
for (let i = 0; i < rules.length; i++) {
  const rule = rules[i];
  if (!matches(rule)) continue;
  if (rule.times !== undefined && (state[i] || 0) >= rule.times) continue;
  state[i] = (state[i] || 0) + 1;
  fs.writeFileSync(stateFile, JSON.stringify(state));
  if (rule.stdout) process.stdout.write(rule.stdout);
  if (rule.stderr) process.stderr.write(rule.stderr);
  process.exitCode = rule.code || 0;
  return;
}
process.stderr.write("fake " + name + ": no canned response\\n");
process.exitCode = 1;
`;

/** Installs a fake `name` on the test PATH. The first matching rule answers; no match exits 1. */
export function installFake(env: TestEnv, name: string, rules: FakeRule[]): void {
  const file = join(env.fakeBin, name);
  writeFileSync(file, `#!${process.execPath}\n${FAKE_SOURCE}`);
  chmodSync(file, 0o755);
  writeFileSync(join(env.fakeBin, `.${name}.rules.json`), JSON.stringify(rules));
  writeFileSync(join(env.fakeBin, `.${name}.log`), "");
  writeFileSync(join(env.fakeBin, `.${name}.state.json`), "{}");
}

/** Replaces the canned rules of an installed fake and resets its use counts. */
export function setFakeRules(env: TestEnv, name: string, rules: FakeRule[]): void {
  writeFileSync(join(env.fakeBin, `.${name}.rules.json`), JSON.stringify(rules));
  writeFileSync(join(env.fakeBin, `.${name}.state.json`), "{}");
}

/** Every argv the fake was called with, in order. */
export function fakeCalls(env: TestEnv, name: string): string[][] {
  const file = join(env.fakeBin, `.${name}.log`);
  if (!existsSync(file)) return [];
  return readFileSync(file, "utf8")
    .split("\n")
    .filter((l) => l !== "")
    .map((l) => JSON.parse(l) as string[]);
}

// ---------------------------------------------------------------------------------------------
// Repositories

/** Runs a program with the test environment and returns stdout without its final newline. Throws on failure. */
export function sh(cwd: string, cmd: string, args: string[]): string {
  const r = run(cmd, args, { cwd });
  if (r.code !== 0) throw new Error(`${cmd} ${args.join(" ")} failed (${r.code}): ${r.stderr}`);
  return r.stdout.replace(/\n$/, "");
}

export function gitIn(cwd: string, ...args: string[]): string {
  return sh(cwd, "git", args);
}

/** Writes a file, stages it by path and makes a signed commit. Returns the commit id. */
export function commitFile(cwd: string, rel: string, content: string, message = `change ${rel}`): string {
  const full = join(cwd, rel);
  mkdirSync(join(full, ".."), { recursive: true });
  writeFileSync(full, content);
  gitIn(cwd, "add", "--", rel);
  gitIn(cwd, "commit", "--quiet", "-m", message);
  return gitIn(cwd, "rev-parse", "HEAD");
}

export interface Fixture {
  env: TestEnv;
  /** The main checkout. */
  main: string;
  /** The bare origin. */
  origin: string;
}

const BIN_DIR = join(import.meta.dirname, "..", "..");

function copyBin(destRoot: string): void {
  mkdirSync(join(destRoot, "scripts"), { recursive: true });
  copyFileSync(join(BIN_DIR, "..", "scripts", "check-public.ts"), join(destRoot, "scripts", "check-public.ts"));
  const libDest = join(destRoot, "bin", "lib", "wt");
  mkdirSync(libDest, { recursive: true });
  copyFileSync(join(BIN_DIR, "wt"), join(destRoot, "bin", "wt"));
  chmodSync(join(destRoot, "bin", "wt"), 0o755);
  for (const file of readdirSync(join(BIN_DIR, "lib", "wt"))) {
    if (!file.endsWith(".ts") || file.endsWith(".test.ts") || file === "test-support.ts") continue;
    copyFileSync(join(BIN_DIR, "lib", "wt", file), join(libDest, file));
  }
  writeFileSync(join(destRoot, "package.json"), '{ "private": true, "type": "module" }\n');
}

/**
 * A main checkout with one commit, pushed to a bare origin. With `withBin`, the checkout also holds a
 * committed copy of bin/wt, so linked worktrees carry one too.
 */
export function makeFixture(env: TestEnv, o: { withBin?: boolean } = {}): Fixture {
  const origin = join(env.root, "origin.git");
  const main = join(env.root, "main");
  mkdirSync(origin);
  mkdirSync(main);
  gitIn(origin, "init", "--quiet", "--bare", "-b", "main");
  gitIn(main, "init", "--quiet", "-b", "main");
  writeFileSync(join(main, ".gitignore"), ".claude/worktrees/\n.wt/\n.private-terms\n");
  writeFileSync(join(main, "README.md"), "fixture\n");
  writeFileSync(join(main, ".private-terms"), "unused-synthetic-term\n");
  if (o.withBin) copyBin(main);
  gitIn(main, "add", "-A");
  gitIn(main, "commit", "--quiet", "-m", "init");
  gitIn(main, "remote", "add", "origin", origin);
  gitIn(main, "push", "--quiet", "-u", "origin", "main");
  return { env, main, origin };
}

// ---------------------------------------------------------------------------------------------
// Processes and sockets

export interface WtRun {
  code: number | null;
  stdout: string;
  stderr: string;
}

/**
 * Runs bin/wt (or any other program, such as a node script through process.execPath) as a child process with
 * a controlled environment: the test PATH and HOME, plus `env`. Never inherits the test process's
 * environment. For a path ending in `bin/wt` this is the real launcher.
 */
export function runWt(
  wtPath: string,
  args: string[],
  o: { cwd: string; env?: Record<string, string>; timeoutMs?: number },
): Promise<WtRun> {
  return spawnWt(wtPath, args, o);
}

/** Same as runWt(); kept so a test can say it means the launcher itself. */
export const runLauncher = runWt;

function spawnWt(
  wtPath: string,
  args: string[],
  o: { cwd: string; env?: Record<string, string>; timeoutMs?: number },
): Promise<WtRun> {
  return new Promise((resolve, reject) => {
    const child: ChildProcess = spawn(wtPath, args, {
      cwd: o.cwd,
      env: { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "", TERM: "dumb", ...o.env },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout?.on("data", (d) => {
      stdout += String(d);
    });
    child.stderr?.on("data", (d) => {
      stderr += String(d);
    });
    const timer = setTimeout(() => child.kill("SIGKILL"), o.timeoutMs ?? 60_000);
    child.on("error", reject);
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr });
    });
  });
}

/** Runs a node script file (with extra argv) as a child process. */
export function runNode(script: string, args: string[], cwd: string): Promise<WtRun> {
  return runWt(process.execPath, [script, ...args], { cwd });
}

/** The pid of a process that has already exited. */
export function deadPid(): number {
  const r = spawnSync(process.execPath, ["-e", "process.stdout.write(String(process.pid))"], { encoding: "utf8" });
  return Number(r.stdout);
}

/** Opens a listener on 127.0.0.1:port. */
export function listenOn(port: number): Promise<{ close(): Promise<void> }> {
  return new Promise((resolve, reject) => {
    const server = net.createServer((s) => s.destroy());
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => {
      resolve({
        close: () => new Promise<void>((done) => server.close(() => done())),
      });
    });
  });
}
