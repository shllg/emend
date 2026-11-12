import { execFileSync, spawn } from "node:child_process";
import { access, mkdir, mkdtemp, open, readdir, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, onTestFinished, test } from "vitest";
import { escapeReference } from "./cli/escape.ts";

const syntheticId = "11111111-1111-4111-8111-111111111111";

async function entryFixture() {
  const directory = await realpath(await mkdtemp(join(tmpdir(), "emend-cli-runtime-")));
  onTestFinished(() => rm(directory, { recursive: true, force: true }));
  const state = join(directory, "state");
  await mkdir(state, { mode: 0o700 });
  const entry = await realpath(fileURLToPath(new URL("./cli.ts", import.meta.url)));
  const env = {
    PATH: [dirname(process.execPath), "/usr/bin", "/bin"].join(delimiter),
    HOME: directory,
    LC_ALL: "C",
    EMEND_HOME: state,
  };
  const invoke = async (cwd: string, args: string[], nodeArgs: string[] = []) => {
    const stdoutPath = join(directory, "stdout");
    const stderrPath = join(directory, "stderr");
    const stdout = await open(stdoutPath, "w", 0o600);
    const stderr = await open(stderrPath, "w", 0o600);
    try {
      const code = await new Promise<number | null>((resolve, reject) => {
        const child = spawn(process.execPath, [...nodeArgs, entry, ...args], {
          cwd,
          env,
          stdio: ["ignore", stdout.fd, stderr.fd],
        });
        child.once("error", reject);
        child.once("close", resolve);
      });
      return { code, stdout: await readFile(stdoutPath, "utf8"), stderr: await readFile(stderrPath, "utf8") };
    } finally {
      await Promise.all([stdout.close(), stderr.close()]);
    }
  };
  return { directory, state, entry, invoke };
}

test.each([
  ["publish", "--manifest", "missing.json", "--key", "synthetic"],
  ["wait", syntheticId],
  ["feedback", syntheticId],
  ["reply", syntheticId, "--status", "explained", "--body", "Synthetic reply"],
  ["mcp"],
  ["stop"],
  ["service", "install"],
  ["update"],
  ["skills", "install"],
])("the real %s entry refuses a runtime inside the repository without touching state", async (...args) => {
  const f = await entryFixture();
  expect(await f.invoke(dirname(dirname(f.entry)), args)).toEqual({
    code: 1,
    stdout: "",
    stderr: `emend: this emend runs from inside the current repository (${escapeReference(f.entry)}); run emend from an install outside the repository.\n`,
  });
  expect(await readdir(f.state)).toEqual([]);
});

test("a refused entry never loads main.ts", async () => {
  const f = await entryFixture();
  const guard = join(f.directory, "guard.mjs");
  await writeFile(
    guard,
    `import { registerHooks } from "node:module";
registerHooks({ resolve(specifier, context, next) {
  if (specifier === "./main.ts") throw new Error("main loaded before refusal");
  return next(specifier, context);
} });\n`,
  );
  expect(await f.invoke(dirname(dirname(f.entry)), ["stop"], ["--import", guard])).toEqual({
    code: 1,
    stdout: "",
    stderr: `emend: this emend runs from inside the current repository (${escapeReference(f.entry)}); run emend from an install outside the repository.\n`,
  });
  expect(await readdir(f.state)).toEqual([]);
});

test("the real feedback entry allows a working directory outside any repository", async () => {
  const f = await entryFixture();
  const result = await f.invoke(f.directory, ["feedback", syntheticId]);
  expect(result).toEqual({
    code: 1,
    stdout: "",
    stderr: `emend: review ${syntheticId} was deleted or never existed\n`,
  });
});

test("the real entry fails closed on an invalid repository entry before touching state", async () => {
  const f = await entryFixture();
  const repo = join(f.directory, "repo");
  await mkdir(repo);
  await writeFile(join(repo, ".git"), "not a repository\n");
  expect(await f.invoke(repo, ["feedback", syntheticId])).toEqual({
    code: 1,
    stdout: "",
    stderr: "emend: could not check where this emend runs; nothing was changed.\n",
  });
  expect(await readdir(f.state)).toEqual([]);
});

test("the CLI prints its version through a symlink without the caller's NODE_OPTIONS preload", async () => {
  const directory = await mkdtemp(join(tmpdir(), "emend-cli-test-"));
  const previous = process.env.NODE_OPTIONS;
  try {
    const marker = join(directory, "preload-ran");
    const preload = join(directory, "preload.cjs");
    await writeFile(preload, `require("node:fs").writeFileSync(${JSON.stringify(marker)}, "ran");\n`);
    process.env.NODE_OPTIONS = `--require ${JSON.stringify(preload)}`;
    const entry = join(directory, "cli.ts");
    await symlink(fileURLToPath(new URL("./cli.ts", import.meta.url)), entry);
    const stdout = execFileSync(process.execPath, [entry, "--version"], {
      encoding: "utf8",
      env: { PATH: process.env.PATH, HOME: directory, EMEND_HOME: join(directory, "state"), LC_ALL: "C" },
    });
    expect(stdout).toBe("emend 0.1.0\n");
    await expect(access(marker)).rejects.toMatchObject({ code: "ENOENT" });
  } finally {
    if (previous === undefined) delete process.env.NODE_OPTIONS;
    else process.env.NODE_OPTIONS = previous;
    await rm(directory, { recursive: true, force: true });
  }
});
