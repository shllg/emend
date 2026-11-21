import { execFile, spawn, spawnSync } from "node:child_process";
import {
  closeSync,
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { afterEach, beforeEach, expect, onTestFinished, test } from "vitest";

const repo = fileURLToPath(new URL("..", import.meta.url));
const hasZsh =
  spawnSync("/bin/sh", ["-c", "command -v zsh"], {
    env: { PATH: [dirname(process.execPath), "/usr/bin", "/bin"].join(delimiter) },
    stdio: "ignore",
  }).status === 0;
let root: string;
let checkout: string;
let target: string;
let env: NodeJS.ProcessEnv;

async function command(program: string, args: string[]) {
  const output = mkdtempSync(join(root, "output-"));
  const stdout = join(output, "stdout");
  const stderr = join(output, "stderr");
  const descriptors = [openSync(stdout, "w"), openSync(stderr, "w")];
  try {
    const status = await new Promise<number>((resolve, reject) => {
      const child = spawn(program, args, {
        cwd: root,
        env,
        stdio: ["ignore", ...descriptors],
        timeout: 20_000,
      });
      child.on("error", reject);
      child.on("close", (code, signal) => {
        if (code === null) reject(new Error(`Child terminated by ${signal}`));
        else resolve(code);
      });
    });
    return { status, stdout: readFileSync(stdout, "utf8"), stderr: readFileSync(stderr, "utf8") };
  } finally {
    for (const descriptor of descriptors) closeSync(descriptor);
  }
}

beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "emend-launcher-")));
  checkout = join(root, "checkout with spaces");
  target = join(root, "bin/emend");
  env = { PATH: [dirname(process.execPath), "/usr/bin", "/bin"].join(delimiter), HOME: root, LC_ALL: "C" };
});

afterEach(() => rmSync(root, { recursive: true, force: true }));

function copyLauncher(source?: string) {
  const launcher = join(checkout, "apps/emend/bin/emend");
  mkdirSync(dirname(launcher), { recursive: true });
  copyFileSync(join(repo, "apps/emend/bin/emend"), launcher);
  expect(lstatSync(launcher).mode & 0o777).toBe(0o755);
  if (source !== undefined) {
    const dist = join(checkout, "apps/emend/dist");
    mkdirSync(dist);
    writeFileSync(join(dist, "emend.mjs"), source);
  }
  return launcher;
}

test("the executable POSIX launcher follows two symlinks, including a relative target, and preserves arguments", async () => {
  const launcher = copyLauncher();
  const dist = join(checkout, "apps/emend/dist");
  mkdirSync(dist);
  writeFileSync(
    join(dist, "emend.mjs"),
    `if (process.argv.length === 3 && process.argv[2] === "--version") {
  console.log("synthetic-emend 0.0.0");
} else {
  console.log(JSON.stringify(process.argv.slice(2)));
  process.exitCode = 17;
}
`,
  );
  mkdirSync(dirname(target), { recursive: true });
  symlinkSync(launcher, join(root, "launcher link"));
  symlinkSync(relative(dirname(target), join(root, "launcher link")), target);
  const version = await command(target, ["--version"]);
  expect(version.status).toBe(0);
  expect(version.stdout).toBe("synthetic-emend 0.0.0\n");
  const result = await command(target, ["--version", "argument with spaces", "", "*"]);
  expect(result.status).toBe(17);
  expect(JSON.parse(result.stdout)).toEqual(["--version", "argument with spaces", "", "*"]);
  expect(result.stderr).toBe("");
});

test.each([false, true])("the launcher handles a missing build (status line %s)", async (statusLine) => {
  const result = await command(copyLauncher(), statusLine ? ["status", "--line"] : ["status"]);
  expect(result.status).toBe(statusLine ? 0 : 1);
  expect(result.stdout).toBe("");
  expect(result.stderr).toBe(statusLine ? "" : "emend: not built; run pnpm build in the emend checkout\n");
});

test.each([false, true])("the launcher stops after 40 symlink hops (status line %s)", async (statusLine) => {
  const first = join(root, "loop first");
  const second = join(root, "loop second");
  symlinkSync(second, first);
  symlinkSync(first, second);
  const text = readFileSync(join(repo, "apps/emend/bin/emend"), "utf8");
  const args = statusLine ? ["status", "--line"] : ["status"];
  const result = await command("/bin/sh", ["-c", text, first, ...args]);
  expect(result.status).toBe(statusLine ? 0 : 1);
  expect(result.stdout).toBe("");
  expect(result.stderr).toBe(statusLine ? "" : "emend: too many levels of symlinks\n");
});

test("the status line launcher exits silently with status 0 when node kills itself", async () => {
  const launcher = copyLauncher('process.kill(process.pid, "SIGKILL");\n');
  expect(await command(launcher, ["status", "--line"])).toEqual({ status: 0, stdout: "", stderr: "" });
});

test.each([["status"], ["status", "--line", "extra"]])(
  "the launcher preserves SIGKILL outside exactly status --line (%j)",
  async (...args) => {
    const launcher = copyLauncher('process.kill(process.pid, "SIGKILL");\n');
    env.status_line = "1";
    await expect(command(launcher, args)).rejects.toThrow("Child terminated by SIGKILL");
  },
);

test("the status line launcher exits silently with status 0 when node cannot execute", async () => {
  const launcher = copyLauncher('throw new Error("node should not start");\n');
  const path = join(root, "fixture-bin");
  mkdirSync(path);
  writeFileSync(join(path, "node"), "#!/nonexistent\n", { mode: 0o755 });
  for (const name of ["dirname", "basename"]) symlinkSync(`/usr/bin/${name}`, join(path, name));
  env.PATH = path;
  expect(await command(launcher, ["status", "--line"])).toEqual({ status: 0, stdout: "", stderr: "" });
});

test("the status line launcher exits silently with status 0 for invalid NODE_OPTIONS", async () => {
  const launcher = copyLauncher('throw new Error("node should not start");\n');
  env.NODE_OPTIONS = "--bogus-flag";
  expect(await command(launcher, ["status", "--line"])).toEqual({ status: 0, stdout: "", stderr: "" });
});

test("the status line launcher exits 0 when opening /dev/null fails", async () => {
  const launcher = copyLauncher('throw new Error("node should not start");\n');
  const source = readFileSync(launcher, "utf8");
  // With no descriptor free, the shell cannot copy or open fd 2 and reports that itself; node cannot run there either, so only the status is kept.
  const result = await command("/bin/sh", ["-c", `ulimit -n 2\n${source}`, launcher, "status", "--line"]);
  expect(result).toMatchObject({ status: 0, stdout: "" });
}, 30000);

test("the status line launcher stays silent when its stderr redirect cannot be opened", async () => {
  const launcher = copyLauncher('throw new Error("node should not start");\n');
  const source = readFileSync(launcher, "utf8");
  // A test cannot make /dev read-only without namespaces, so use a nonexistent directory.
  const redirected = source.replace("exec 2>/dev/null", "exec 2>/nonexistent-emend-dir/null");
  expect(redirected).not.toBe(source);
  expect(await command("/bin/sh", ["-c", redirected, launcher, "status", "--line"])).toEqual({
    status: 0,
    stdout: "",
    stderr: "",
  });
});

test.each(["/bin/sh", ...(hasZsh ? ["zsh --emulate sh"] : [])])(
  "the status line launcher never signals its process group on a signal before node starts (%s)",
  async (shell) => {
    const marker = join(root, "stub.started");
    const siblingPidFile = join(root, "sibling.pid");
    const statusFile = join(root, "launcher.status");
    const stdoutFile = join(root, "launcher.stdout");
    const stderrFile = join(root, "launcher.stderr");
    const launcher = copyLauncher(`import { writeFileSync } from "node:fs";
writeFileSync(${JSON.stringify(marker)}, "started");
`);
    const source = readFileSync(launcher, "utf8");
    const interrupted = source.replace(
      '  node "$directory/../dist/emend.mjs" "$@" &',
      () => '  kill -TERM $$; node "$directory/../dist/emend.mjs" "$@" &',
    );
    expect(interrupted).not.toBe(source);
    // Capture the launcher's output separately from the wrapper's signal diagnostic.
    const wrapper = `sleep 30 &
printf '%s\\n' "$!" > "$3"
if [ "$7" = /bin/sh ]; then
  /bin/sh -c "$1" "$2" status --line >"$5" 2>"$6"
else
  zsh --emulate sh -c "$1" "$2" status --line >"$5" 2>"$6"
fi
printf '%s\\n' "$?" > "$4"
exit 0
`;
    const child = spawn(
      "/bin/sh",
      [
        "-c",
        wrapper,
        "emend-signal-wrapper",
        interrupted,
        launcher,
        siblingPidFile,
        statusFile,
        stdoutFile,
        stderrFile,
        shell,
      ],
      {
        cwd: root,
        env,
        stdio: "ignore",
        detached: true,
        timeout: 10000,
        killSignal: "SIGKILL",
      },
    );
    onTestFinished(async () => {
      // The process group also catches an orphaned sibling when the wrapper has exited.
      if (child.pid) {
        try {
          process.kill(-child.pid, "SIGKILL");
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
        }
      }
      await closed;
    });
    const closed = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve, reject) => {
      child.once("error", reject);
      child.once("close", (code, signal) => resolve({ code, signal }));
    });
    expect(await closed).toEqual({ code: 0, signal: null });
    expect(readFileSync(statusFile, "utf8")).toBe("143\n");
    expect(readFileSync(stdoutFile, "utf8")).toBe("");
    expect(readFileSync(stderrFile, "utf8")).toBe("");
    expect(existsSync(marker)).toBe(false);
    const siblingPid = Number(readFileSync(siblingPidFile, "utf8"));
    expect(siblingPid).toBeGreaterThan(0);
    expect(() => process.kill(siblingPid, 0)).not.toThrow();
  },
  20000,
);

test.each(["SIGTERM", "SIGINT", "SIGHUP"] as const)(
  "the status line launcher kills and reaps node promptly on %s",
  async (signal) => {
    const pidFile = join(root, "stub.pid");
    const launcher = copyLauncher(`import { writeFileSync } from "node:fs";
writeFileSync(${JSON.stringify(pidFile)}, String(process.pid));
setInterval(() => {}, 1000);
`);
    const child = spawn(launcher, ["status", "--line"], {
      cwd: root,
      env,
      stdio: ["ignore", "pipe", "pipe"],
      detached: true,
      timeout: 10000,
      killSignal: "SIGKILL",
    });
    onTestFinished(async () => {
      // The process group also catches an orphaned stub when the launcher fails the test.
      if (child.pid) {
        try {
          process.kill(-child.pid, "SIGKILL");
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
        }
      }
      await closed;
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let stdoutEnded = false;
    child.stdout.on("data", (chunk: Buffer) => stdout.push(chunk));
    child.stdout.once("end", () => {
      stdoutEnded = true;
    });
    child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
    const closed = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve, reject) => {
      child.once("error", reject);
      child.once("close", (code, signal) => resolve({ code, signal }));
    });
    await expect.poll(() => Number(readFileSync(pidFile, "utf8")), { timeout: 5000 }).toBeGreaterThan(0);
    const stubPid = Number(readFileSync(pidFile, "utf8"));
    const started = performance.now();
    expect(child.kill(signal)).toBe(true);
    await expect
      .poll(
        () => {
          let stubAlive = true;
          try {
            process.kill(stubPid, 0);
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
            stubAlive = false;
          }
          return { code: child.exitCode, signal: child.signalCode, stdoutEnded, stubAlive };
        },
        { timeout: 2000, interval: 10 },
      )
      .toEqual({ code: 0, signal: null, stdoutEnded: true, stubAlive: false });
    expect(performance.now() - started).toBeLessThan(500);
    expect(await closed).toEqual({ code: 0, signal: null });
    expect(Buffer.concat(stdout).toString()).toBe("");
    expect(Buffer.concat(stderr).toString()).toBe("");
  },
  20000,
);

test("the status line launcher prints a fast result without waiting for the deadline", async () => {
  const launcher = copyLauncher('console.log("emend r3 · your turn");\n');
  const started = performance.now();
  // Capture pipes so completion also proves stdout is no longer held open.
  const result = await promisify(execFile)(launcher, ["status", "--line"], {
    cwd: root,
    env,
    timeout: 4000,
    killSignal: "SIGKILL",
  });
  const elapsed = performance.now() - started;
  expect(result).toEqual({ stdout: "emend r3 · your turn\n", stderr: "" });
  expect(elapsed).toBeLessThan(1500);
});
