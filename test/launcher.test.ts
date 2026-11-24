import { execFile, spawn, spawnSync } from "node:child_process";
import {
  chmodSync,
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
  root = realpathSync(mkdtempSync(join(tmpdir(), "recense-launcher-")));
  checkout = join(root, "checkout with spaces");
  target = join(root, "bin/recense");
  env = { PATH: [dirname(process.execPath), "/usr/bin", "/bin"].join(delimiter), HOME: root, LC_ALL: "C" };
});

afterEach(() => rmSync(root, { recursive: true, force: true }));

function copyLauncher(source?: string) {
  const launcher = join(checkout, "apps/recense/bin/recense");
  mkdirSync(dirname(launcher), { recursive: true });
  copyFileSync(join(repo, "apps/recense/bin/recense"), launcher);
  expect(lstatSync(launcher).mode & 0o777).toBe(0o755);
  if (source !== undefined) {
    const dist = join(checkout, "apps/recense/dist");
    mkdirSync(dist);
    writeFileSync(join(dist, "recense.mjs"), source);
  }
  return launcher;
}

test("the executable POSIX launcher follows two symlinks, including a relative target, and preserves arguments", async () => {
  const launcher = copyLauncher();
  const dist = join(checkout, "apps/recense/dist");
  mkdirSync(dist);
  writeFileSync(
    join(dist, "recense.mjs"),
    `if (process.argv.length === 3 && process.argv[2] === "--version") {
  console.log("synthetic-recense 0.0.0");
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
  expect(version.stdout).toBe("synthetic-recense 0.0.0\n");
  const result = await command(target, ["--version", "argument with spaces", "", "*"]);
  expect(result.status).toBe(17);
  expect(JSON.parse(result.stdout)).toEqual(["--version", "argument with spaces", "", "*"]);
  expect(result.stderr).toBe("");
});

test.each([false, true])("the launcher handles a missing build (status line %s)", async (statusLine) => {
  const result = await command(copyLauncher(), statusLine ? ["status", "--line"] : ["status"]);
  expect(result.status).toBe(statusLine ? 0 : 1);
  expect(result.stdout).toBe("");
  expect(result.stderr).toBe(statusLine ? "" : "recense: not built; run pnpm build in the recense checkout\n");
});

test.each([false, true])("the launcher stops after 40 symlink hops (status line %s)", async (statusLine) => {
  const first = join(root, "loop first");
  const second = join(root, "loop second");
  symlinkSync(second, first);
  symlinkSync(first, second);
  const text = readFileSync(join(repo, "apps/recense/bin/recense"), "utf8");
  const args = statusLine ? ["status", "--line"] : ["status"];
  const result = await command("/bin/sh", ["-c", text, first, ...args]);
  expect(result.status).toBe(statusLine ? 0 : 1);
  expect(result.stdout).toBe("");
  expect(result.stderr).toBe(statusLine ? "" : "recense: too many levels of symlinks\n");
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
  const redirected = source.replace("exec 2>/dev/null", "exec 2>/nonexistent-recense-dir/null");
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
      '  node "$directory/../dist/recense.mjs" "$@" &',
      () => '  kill -TERM $$; node "$directory/../dist/recense.mjs" "$@" &',
    );
    expect(interrupted).not.toBe(source);
    // Subshell redirections keep the wrapper's own signal notice on its ignored stderr.
    const wrapper = `sleep 30 &
printf '%s\\n' "$!" > "$3"
if [ "$7" = /bin/sh ]; then
  ( exec /bin/sh -c "$1" "$2" status --line ) >"$5" 2>"$6"
else
  ( exec zsh --emulate sh -c "$1" "$2" status --line ) >"$5" 2>"$6"
fi
printf '%s\\n' "$?" > "$4"
exit 0
`;
    const child = spawn(
      "/bin/sh",
      [
        "-c",
        wrapper,
        "recense-signal-wrapper",
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
  const launcher = copyLauncher('console.log("recense r3 · your turn");\n');
  const started = performance.now();
  // Capture pipes so completion also proves stdout is no longer held open.
  const result = await promisify(execFile)(launcher, ["status", "--line"], {
    cwd: root,
    env,
    timeout: 4000,
    killSignal: "SIGKILL",
  });
  const elapsed = performance.now() - started;
  expect(result).toEqual({ stdout: "recense r3 · your turn\n", stderr: "" });
  expect(elapsed).toBeLessThan(1500);
});

const RENAME_LINE = "emend is now recense: use the recense command. The emend command goes away in a later release.\n";

function copyAlias(launcher: string) {
  const alias = join(dirname(launcher), "emend");
  copyFileSync(join(repo, "apps/recense/bin/emend"), alias);
  chmodSync(alias, 0o755);
  expect(lstatSync(join(repo, "apps/recense/bin/emend")).mode & 0o777).toBe(0o755);
  return alias;
}

test("the emend alias prints one line on stderr, then runs the recense launcher with its arguments and exit code", async () => {
  const launcher = copyLauncher(
    'console.log(JSON.stringify(process.argv.slice(2)));\nconsole.error("from recense");\nprocess.exitCode = 17;\n',
  );
  const alias = copyAlias(launcher);
  mkdirSync(dirname(target), { recursive: true });
  const link = join(dirname(target), "emend");
  symlinkSync(alias, link);
  const result = await command(link, ["wait", "argument with spaces", "", "*"]);
  expect(result.status).toBe(17);
  expect(JSON.parse(result.stdout)).toEqual(["wait", "argument with spaces", "", "*"]);
  expect(result.stderr).toBe(`${RENAME_LINE}from recense\n`);
});

test("the emend alias leaves stdout to the recense command alone, so MCP over stdio keeps working", async () => {
  const launcher = copyLauncher('process.stdout.write("{}\\n");\n');
  const result = await command(copyAlias(launcher), ["mcp"]);
  expect(result).toEqual({ status: 0, stdout: "{}\n", stderr: RENAME_LINE });
});

test("the emend alias keeps status --line free of stderr output", async () => {
  const launcher = copyLauncher('console.log("recense r3 · your turn");\n');
  expect(await command(copyAlias(launcher), ["status", "--line"])).toEqual({
    status: 0,
    stdout: "recense r3 · your turn\n",
    stderr: "",
  });
});

test("the emend alias stays silent and exits 0 for status --line on its own errors, like bin/recense", async () => {
  const first = join(root, "alias loop first");
  const second = join(root, "alias loop second");
  symlinkSync(second, first);
  symlinkSync(first, second);
  const text = readFileSync(join(repo, "apps/recense/bin/emend"), "utf8");
  expect(await command("/bin/sh", ["-c", text, first, "status", "--line"])).toEqual({
    status: 0,
    stdout: "",
    stderr: "",
  });
  // The same loop for another command still reports and fails.
  const failed = await command("/bin/sh", ["-c", text, first, "status"]);
  expect(failed.status).toBe(1);
  expect(failed.stderr).toContain("emend: too many levels of symlinks");
  // An unopenable stderr redirect stays silent too.
  const redirected = text.replace("exec 2>/dev/null", "exec 2>/nonexistent-recense-dir/null");
  expect(redirected).not.toBe(text);
  expect(await command("/bin/sh", ["-c", redirected, first, "status", "--line"])).toEqual({
    status: 0,
    stdout: "",
    stderr: "",
  });
});

test("a closed stderr does not stop the emend alias before it runs the recense command", async () => {
  const launcher = copyLauncher('console.log("ran");\n');
  const alias = copyAlias(launcher);
  const result = await command("/bin/sh", ["-c", 'exec 2>&-; exec "$0" "$@"', alias, "mcp"]);
  expect(result).toMatchObject({ status: 0, stdout: "ran\n" });
});

test("the emend alias reports a missing build through the recense launcher", async () => {
  const result = await command(copyAlias(copyLauncher()), ["status"]);
  expect(result.status).toBe(1);
  expect(result.stderr).toBe(`${RENAME_LINE}recense: not built; run pnpm build in the recense checkout\n`);
});
