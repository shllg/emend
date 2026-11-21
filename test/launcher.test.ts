import { spawn } from "node:child_process";
import {
  closeSync,
  copyFileSync,
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
import { afterEach, beforeEach, expect, test } from "vitest";

const repo = fileURLToPath(new URL("..", import.meta.url));
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

function copyLauncher() {
  const launcher = join(checkout, "apps/emend/bin/emend");
  mkdirSync(dirname(launcher), { recursive: true });
  copyFileSync(join(repo, "apps/emend/bin/emend"), launcher);
  expect(lstatSync(launcher).mode & 0o777).toBe(0o755);
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
