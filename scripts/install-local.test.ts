import assert from "node:assert/strict";
import childProcess from "node:child_process";
import { EventEmitter } from "node:events";
import {
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
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { PassThrough } from "node:stream";
import { type TestContext, test } from "node:test";
import { hooks } from "../.pnpmfile.mjs";
import { installLocal, type Runner, runCommand } from "./install-local.ts";
import { cleanPackageDocs, preparePackageDocs, requirePnpmPacking } from "./package-docs.ts";

interface FixtureOptions {
  mise?: boolean;
  tag?: string;
  nearerTags?: string[];
  moveHeadAfterRead?: boolean;
  missingVersion?: boolean;
  env?: NodeJS.ProcessEnv;
  dirty?: string;
  service?: string;
  fail?: string;
  path?: "missing" | "foreign" | "checkout" | "linked" | "relative" | "shim";
  miseWhich?: "matching" | "foreign";
  signalDuringBuild?: "SIGINT" | "SIGTERM";
}

function fixture(t: TestContext, options: FixtureOptions = {}) {
  const base = mkdtempSync(join(tmpdir(), "emend-local-test-"));
  t.after(() => rmSync(base, { recursive: true, force: true }));
  const root = join(base, "checkout with spaces");
  const temporaryRoot = join(base, "temporary");
  const bin = join(root, "tools");
  const prefix = join(base, "npm prefix");
  const env: NodeJS.ProcessEnv = {
    HOME: join(base, "home"),
    PATH: bin,
    npm_config_registry: "https://registry.invalid",
    ...options.env,
  };
  for (const directory of [root, temporaryRoot, bin]) mkdirSync(directory, { recursive: true });
  const executable = (file: string) => {
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, "synthetic executable; never run", { mode: 0o755 });
  };
  if (options.mise) executable(join(bin, "mise"));
  if (options.path === "foreign") executable(join(bin, "emend"));
  if (options.path === "checkout") {
    const previous = join(root, "apps/emend/bin/emend");
    executable(previous);
    symlinkSync(previous, join(bin, "emend"));
  }
  if (options.path === "shim") symlinkSync(join(bin, "mise"), join(bin, "emend"));
  if (options.path === "relative") env.PATH = "tools";
  // Real temporary history exercises the planner's tag selector without installing anything.
  const git = (...args: string[]) =>
    childProcess
      .execFileSync(
        "git",
        [
          "-C",
          root,
          "-c",
          "commit.gpgsign=false",
          "-c",
          "tag.gpgsign=false",
          "-c",
          "user.name=Test",
          "-c",
          "user.email=test@example.com",
          "-c",
          "core.hooksPath=/dev/null",
          ...args,
        ],
        {
          encoding: "utf8",
          stdio: ["ignore", "pipe", "pipe"],
          env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" },
        },
      )
      .trim();
  git("init", "-q", "-b", "main");
  git("commit", "--allow-empty", "-q", "-m", "chore: synthetic source");
  if (options.tag) git("tag", options.tag);
  if (options.nearerTags?.length) {
    git("commit", "--allow-empty", "-q", "-m", "chore: newer source");
    for (const tag of options.nearerTags) git("tag", tag);
  }
  const commit = git("rev-parse", "HEAD");
  // An uncommitted manifest must never supply the installed version.
  mkdirSync(join(root, "apps/emend"), { recursive: true });
  writeFileSync(join(root, "apps/emend/package.json"), '{"version":"uncommitted"}');

  const calls: { program: string; args: string[]; cwd: string; capture: boolean; label: string }[] = [];
  const stdout: string[] = [];
  const stderr: string[] = [];
  const signals = new EventEmitter();
  const forwarded: unknown[] = [];
  let folder = "";
  let work = "";
  let installedVersion = "";
  let builtSource = "";
  const run: Runner = async (program, args, command) => {
    assert.strictEqual(command.env, env, "every command gets the injected environment");
    const label =
      program === "git"
        ? `git ${args[0]}`
        : program === "pnpm"
          ? `pnpm ${args[0]}`
          : program === "npm"
            ? `npm ${args[0]}`
            : program === "tar"
              ? "tar"
              : program === join(bin, "mise")
                ? `mise ${args[0]}`
                : `service ${args[1]}`;
    calls.push({ program, args, cwd: command.cwd, capture: command.capture, label });
    if (label === options.fail) throw new Error("Synthetic command failure");
    if (label === "pnpm build" && options.signalDuringBuild) {
      assert(command.signal);
      const interrupted = new Promise<string>((_resolve, reject) => {
        command.signal?.addEventListener(
          "abort",
          () => {
            forwarded.push(command.signal?.reason);
            reject(new Error("Synthetic interrupted build"));
          },
          { once: true },
        );
      });
      signals.emit(options.signalDuringBuild);
      return interrupted;
    }
    if (label === "git rev-parse") {
      const resolved = git(...args);
      if (options.moveHeadAfterRead) {
        git("commit", "--allow-empty", "-q", "-m", "chore: concurrent change");
        git("tag", "v9.0.0");
      }
      return `${resolved}\n`;
    }
    if (label === "git status") return options.dirty ?? "";
    if (label === "git archive") {
      const archive = args[2].slice("--output=".length);
      work = dirname(archive);
      writeFileSync(archive, "synthetic archive");
    }
    if (label === "tar") {
      const source = args[3];
      mkdirSync(join(source, "apps/emend/src"), { recursive: true });
      writeFileSync(join(source, "apps/emend/package.json"), '{"version":"1.2.3"}');
      writeFileSync(
        join(source, "apps/emend/src/version.ts"),
        options.missingVersion ? "// missing\n" : 'export const VERSION = "1.2.3";\n',
      );
    }
    if (label === "pnpm install") {
      installedVersion = JSON.parse(readFileSync(join(command.cwd, "apps/emend/package.json"), "utf8")).version;
      builtSource = readFileSync(join(command.cwd, "apps/emend/src/version.ts"), "utf8");
    }
    if (label === "pnpm pack") {
      const manifest = JSON.parse(readFileSync(join(command.cwd, "package.json"), "utf8"));
      const archive = calls.find((call) => call.args[0] === "archive");
      assert.equal(manifest.emendLocalBuild, archive?.args.at(-1), "packed local builds carry the archived commit");
      assert.equal(typeof manifest.emendLocalBuild, "string");
      writeFileSync(join(args[2], `shllg-emend-${installedVersion}.tgz`), "synthetic tarball");
    }
    if (label === "npm install") {
      folder = args[2] === "--prefix" ? args[3] : prefix;
      assert.equal(readFileSync(args[args.length - 1], "utf8"), "synthetic tarball");
      const installed = join(folder, "bin/emend");
      executable(installed);
      if (options.path === "linked" || options.path === "relative") symlinkSync(installed, join(bin, "emend"));
    }
    if (label === "npm prefix") return `${prefix}\n`;
    if (label === "mise which") {
      if (options.miseWhich === "foreign") {
        const foreign = join(base, "other/bin/emend");
        executable(foreign);
        return `${foreign}\n`;
      }
      return `${join(folder, "bin/emend")}\n`;
    }
    if (label === "service status") return options.service ?? "emend: service not installed\n";
    return "";
  };
  return {
    base,
    root,
    commit,
    git,
    temporaryRoot,
    bin,
    env,
    prefix,
    calls,
    stdout,
    stderr,
    signals,
    forwarded,
    get folder() {
      return folder;
    },
    get installedVersion() {
      return installedVersion;
    },
    get builtSource() {
      return builtSource;
    },
    get work() {
      return work;
    },
    run: (args: string[] = []) =>
      installLocal(args, {
        root,
        env,
        run,
        signals,
        temporaryRoot,
        stdout: (line) => stdout.push(line),
        stderr: (line) => stderr.push(line),
      }),
    clean: () => {
      assert.deepEqual(readdirSync(temporaryRoot), [], "export and pack folder must be removed");
      assert.equal(signals.listenerCount("SIGINT"), 0);
      assert.equal(signals.listenerCount("SIGTERM"), 0);
    },
  };
}

const buildSteps = ["git rev-parse", "git status", "git archive", "tar", "pnpm install", "pnpm build", "pnpm pack"];

for (const capture of [true, false]) {
  test(`command stdout ${capture ? "is captured quietly" : "inherits the terminal"}`, async (t) => {
    const query = "a1b2c3d\n M tracked.ts\n?? untracked.ts\nemend: service not installed\n";
    const child = new childProcess.ChildProcess();
    const stream = new PassThrough();
    child.stdout = capture ? stream : null;
    const spawn = t.mock.method(childProcess, "spawn", () => {
      queueMicrotask(() => {
        stream.end(query);
        child.emit("close", 0);
      });
      return child;
    });
    syncBuiltinESMExports();
    const terminal = t.mock.method(process.stdout, "write", () => true);
    let output: string;
    const options = { cwd: tmpdir(), env: {}, capture };
    try {
      output = await runCommand("synthetic-command", ["query"], options);
    } finally {
      terminal.mock.restore();
      spawn.mock.restore();
      syncBuiltinESMExports();
    }
    assert.equal(output, capture ? query : "");
    assert.equal(terminal.mock.callCount(), 0);
    assert.deepEqual(spawn.mock.calls[0].arguments, [
      "synthetic-command",
      ["query"],
      { cwd: options.cwd, env: options.env, stdio: capture ? ["inherit", "pipe", "inherit"] : "inherit" },
    ]);
  });
}

test("npm layout exports HEAD, builds outside the checkout, installs the tarball and cleans up", async (t) => {
  const f = fixture(t);
  assert.equal(await f.run(), 0);
  assert.deepEqual(
    f.calls.map((call) => call.label),
    [...buildSteps, "npm install", "npm prefix", "service status"],
  );
  const source = join(f.work, "src");
  const pack = join(f.work, "pack");
  const installed = join(f.prefix, "bin/emend");
  assert.deepEqual(
    f.calls.map(({ program, args, cwd, capture }) => ({ program, args, cwd, capture })),
    [
      { program: "git", args: ["rev-parse", "--verify", "HEAD"], cwd: f.root, capture: true },
      { program: "git", args: ["status", "--porcelain", "--untracked-files=all"], cwd: f.root, capture: true },
      {
        program: "git",
        args: ["archive", "--format=tar", `--output=${join(f.work, "src.tar")}`, f.commit],
        cwd: f.root,
        capture: false,
      },
      { program: "tar", args: ["-xf", join(f.work, "src.tar"), "-C", source], cwd: f.root, capture: false },
      { program: "pnpm", args: ["install", "--frozen-lockfile"], cwd: source, capture: false },
      { program: "pnpm", args: ["build"], cwd: source, capture: false },
      { program: "pnpm", args: ["pack", "--pack-destination", pack], cwd: join(source, "apps/emend"), capture: false },
      { program: "npm", args: ["install", "-g", join(pack, "shllg-emend-1.2.3.tgz")], cwd: f.root, capture: false },
      { program: "npm", args: ["prefix", "-g"], cwd: f.root, capture: true },
      { program: installed, args: ["service", "status"], cwd: f.root, capture: true },
    ],
  );
  assert.deepEqual(f.stdout, [
    `install:local: installed emend 1.2.3 (${f.commit}).`,
    `install:local: emend is not on your PATH; add ${join(f.prefix, "bin")} to it.`,
    "Next: emend service install, then emend skills install.",
  ]);
  assert.deepEqual(f.stderr, []);
  assert(existsSync(installed), "installation survives removal of the export");
  f.clean();
});

for (const dirty of [" M tracked.ts\n", "?? untracked.ts\n"]) {
  test(`uncommitted changes are reported and never refuse the install (${dirty.trim()})`, async (t) => {
    const f = fixture(t, { dirty });
    assert.equal(await f.run(), 0);
    assert.deepEqual(f.stdout, [
      `install:local: uncommitted changes are not included; installing ${f.commit}.`,
      `install:local: installed emend 1.2.3 (${f.commit}).`,
      `install:local: emend is not on your PATH; add ${join(f.prefix, "bin")} to it.`,
      "Next: emend service install, then emend skills install.",
    ]);
    assert(f.calls.some((call) => call.label === "npm install"));
    f.clean();
  });
}

for (const choice of ["mise", "xdg", "home", "empty"] as const) {
  test(`mise data directory precedence: ${choice}`, async (t) => {
    const f = fixture(t, { mise: true, path: "linked" });
    const explicit = join(f.base, "mise data");
    const xdg = join(f.base, "xdg data");
    if (choice === "mise") f.env.MISE_DATA_DIR = explicit;
    if (choice === "mise" || choice === "xdg") f.env.XDG_DATA_HOME = xdg;
    if (choice === "empty") {
      f.env.MISE_DATA_DIR = "";
      f.env.XDG_DATA_HOME = "";
    }
    assert(f.env.HOME);
    const expected = join(
      choice === "mise" ? explicit : choice === "xdg" ? join(xdg, "mise") : join(f.env.HOME, ".local/share/mise"),
      "linked-installs/npm-shllg-emend-local",
    );
    assert.equal(await f.run(), 0);
    assert.equal(f.folder, expected);
    assert.deepEqual(
      f.calls.map((call) => call.label),
      [...buildSteps, "npm install", "mise link", "service status"],
    );
    assert.deepEqual(f.calls.find((call) => call.label === "npm install")?.args, [
      "install",
      "-g",
      "--prefix",
      expected,
      join(f.work, "pack/shllg-emend-1.2.3.tgz"),
    ]);
    assert.deepEqual(f.calls.find((call) => call.label === "mise link")?.args, [
      "link",
      "--force",
      "npm:@shllg/emend@local",
      expected,
    ]);
    assert.equal(f.calls.find((call) => call.label === "service status")?.program, join(expected, "bin/emend"));
    assert.deepEqual(f.stdout, [
      `install:local: installed emend 1.2.3 (${f.commit}).`,
      "Next: emend service install, then emend skills install.",
    ]);
    assert.deepEqual(f.stderr, []);
    f.clean();
  });
}

test("--npm overrides an available mise and keeps the user's npm environment", async (t) => {
  const f = fixture(t, { mise: true });
  assert.equal(await f.run(["--npm"]), 0);
  assert.equal(f.folder, f.prefix);
  assert.deepEqual(
    f.calls.map((call) => call.label),
    [...buildSteps, "npm install", "npm prefix", "service status"],
  );
  f.clean();
});

for (const args of [["--unknown"], ["--help"], ["--npm", "--npm"], ["extra"], ["--npm", "extra"]]) {
  test(`usage error precedes every command and temporary folder: ${args.join(" ")}`, async (t) => {
    const f = fixture(t);
    assert.equal(await f.run(args), 2);
    assert.deepEqual(f.calls, []);
    assert.deepEqual(f.stdout, []);
    assert.deepEqual(f.stderr, ["Usage: pnpm install:local [--npm]"]);
    f.clean();
  });
}

for (const path of ["missing", "foreign", "checkout", "linked", "relative"] as const) {
  test(`PATH compares real paths (${path}) and always calls the installed binary`, async (t) => {
    const f = fixture(t, { path, service: "emend: service running\n" });
    assert.equal(await f.run(), 0);
    const hint = `install:local: emend is not on your PATH; add ${join(f.prefix, "bin")} to it.`;
    assert.equal(f.stdout.includes(hint), path === "missing");
    if (path === "foreign" || path === "checkout") {
      const found = join(f.bin, "emend");
      assert(
        f.stdout.includes(
          `install:local: the emend on your PATH is ${found} (${realpathSync(found)}), not this install; remove it or put ${join(f.prefix, "bin")} before it.`,
        ),
      );
    }
    assert.deepEqual(
      f.calls.slice(-2).map(({ program, args, capture }) => ({ program, args, capture })),
      [
        { program: join(f.prefix, "bin/emend"), args: ["service", "status"], capture: true },
        { program: join(f.prefix, "bin/emend"), args: ["service", "install"], capture: false },
      ],
    );
    assert(!f.stdout.some((line) => line.includes("Next:") || line.includes("skills")));
    f.clean();
  });
}

for (const service of ["emend: service stopped\n", "", "emend: service not installed\r\n"]) {
  test(`service branch is chosen only by the not-installed message (${JSON.stringify(service)})`, async (t) => {
    const f = fixture(t, { service });
    assert.equal(await f.run(), 0);
    assert.equal(
      f.calls.some((call) => call.label === "service install"),
      service.trim() !== "emend: service not installed",
    );
    f.clean();
  });
}

const failureLabels: Record<string, string> = {
  "git rev-parse": "read HEAD",
  "git status": "git status",
  "git archive": "git archive",
  tar: "tar extract",
  "pnpm install": "pnpm install",
  "pnpm build": "pnpm build",
  "pnpm pack": "pnpm pack",
  "npm install": "npm install",
  "npm prefix": "npm prefix",
  "service install": "service install",
};
const allSteps = [...buildSteps, "npm install", "npm prefix", "service status", "service install"];
for (const [fail, label] of Object.entries(failureLabels)) {
  test(`failure at ${fail} stops immediately and removes the export`, async (t) => {
    const f = fixture(t, { fail, service: "emend: service running\n" });
    assert.equal(await f.run(), 1);
    assert.deepEqual(
      f.calls.map((call) => call.label),
      allSteps.slice(0, allSteps.indexOf(fail) + 1),
    );
    assert.deepEqual(f.stderr, [`install:local: ${label} failed`]);
    f.clean();
  });
}

test("mise link failure skips service commands and cleans up", async (t) => {
  const f = fixture(t, { mise: true, fail: "mise link" });
  assert.equal(await f.run(), 1);
  assert.deepEqual(
    f.calls.map((call) => call.label),
    [...buildSteps, "npm install", "mise link"],
  );
  assert.deepEqual(f.stderr, ["install:local: mise link failed"]);
  assert(!f.stdout.some((line) => line.startsWith("install:local: installed")));
  f.clean();
});

for (const [signal, code] of [
  ["SIGINT", 130],
  ["SIGTERM", 143],
] as const) {
  test(`${signal} during build stops the run, cleans up and returns ${code}`, async (t) => {
    const f = fixture(t, { signalDuringBuild: signal });
    assert.equal(await f.run(), code);
    assert.deepEqual(
      f.calls.map((call) => call.label),
      buildSteps.slice(0, buildSteps.indexOf("pnpm build") + 1),
    );
    assert.deepEqual(f.forwarded, [signal]);
    assert.deepEqual(f.stderr, ["install:local: pnpm build failed"]);
    f.clean();
  });

  test(`runCommand forwards ${signal} to the running child`, async (t) => {
    const child = new childProcess.ChildProcess();
    const interruption = new AbortController();
    const kill = t.mock.method(child, "kill", () => {
      queueMicrotask(() => child.emit("close", null, signal));
      return true;
    });
    const spawn = t.mock.method(childProcess, "spawn", () => child);
    syncBuiltinESMExports();
    try {
      const running = runCommand("synthetic-command", [], {
        cwd: tmpdir(),
        env: {},
        capture: false,
        signal: interruption.signal,
      });
      interruption.abort(signal);
      await assert.rejects(running);
      assert.deepEqual(
        kill.mock.calls.map((call) => call.arguments),
        [[signal]],
      );
    } finally {
      spawn.mock.restore();
      syncBuiltinESMExports();
    }
  });
}

for (const choice of ["matching", "foreign", "failed"] as const) {
  test(`mise shim uses the captured mise which result (${choice})`, async (t) => {
    const f = fixture(t, {
      mise: true,
      path: "shim",
      miseWhich: choice === "foreign" ? "foreign" : "matching",
      fail: choice === "failed" ? "mise which" : undefined,
    });
    assert.equal(await f.run(), 0);
    const lookup = f.calls.find((call) => call.label === "mise which");
    assert(lookup);
    assert.equal(lookup.capture, true);
    assert.deepEqual(lookup.args, ["which", "emend"]);
    const found = join(f.bin, "emend");
    const effective = choice === "foreign" ? join(f.base, "other/bin/emend") : realpathSync(found);
    const hint = `install:local: the emend on your PATH is ${found} (${effective}), not this install; remove it or put ${join(f.folder, "bin")} before it.`;
    assert.equal(f.stdout.includes(hint), choice !== "matching");
    assert.equal(
      f.stdout.some((line) => line.includes("not this install")),
      choice !== "matching",
    );
    assert.deepEqual(f.stderr, []);
    f.clean();
  });
}

test("--npm still resolves an emend mise shim for the PATH check", async (t) => {
  const f = fixture(t, { mise: true, path: "shim" });
  assert.equal(await f.run(["--npm"]), 0);
  assert(f.calls.some((call) => call.label === "mise which"));
  assert(!f.calls.some((call) => call.label === "mise link"));
  assert(!f.stdout.some((line) => line.includes("PATH")));
  f.clean();
});

test("an unavailable service check keeps a successful install successful", async (t) => {
  const f = fixture(t, { fail: "service status" });
  assert.equal(await f.run(), 0);
  assert.equal(
    f.stdout.at(-1),
    "install:local: could not check the emend service; if you use it, run emend service install.",
  );
  assert.deepEqual(f.stderr, []);
  assert(!f.calls.some((call) => call.label === "service install"));
  f.clean();
});

test("npm install failure in the mise layout skips mise link and cleans up", async (t) => {
  const f = fixture(t, { mise: true, fail: "npm install" });
  assert.equal(await f.run(), 1);
  assert.deepEqual(
    f.calls.map((call) => call.label),
    [...buildSteps, "npm install"],
  );
  assert.deepEqual(f.stderr, ["install:local: npm install failed"]);
  f.clean();
});

test("runCommand rejects a real child exiting nonzero", async () => {
  await assert.rejects(
    runCommand(process.execPath, ["-e", "process.exit(3)"], { cwd: tmpdir(), env: {}, capture: false }),
    /exited 3/,
  );
});

test("runCommand rejects a program that does not exist", async (t) => {
  const f = fixture(t);
  await assert.rejects(runCommand(join(f.base, "missing-program"), [], { cwd: f.base, env: {}, capture: false }), {
    code: "ENOENT",
  });
});

test("prepack accepts a pnpm user agent", () => {
  assert.doesNotThrow(() => requirePnpmPacking("pnpm/11.20.0 npm/? node/v24.18.0 linux x64"));
});

for (const userAgent of ["npm/11.0.0 node/v24.18.0 linux x64", "", undefined]) {
  test(`prepack refuses a non-pnpm user agent (${JSON.stringify(userAgent)})`, () => {
    assert.throws(() => requirePnpmPacking(userAgent), {
      message:
        "package-docs: pack @shllg/emend with pnpm (pnpm pack or pnpm publish); npm would publish its private workspace devDependencies.",
    });
  });
}

test("package documents can be prepared again after a failed pack", (t) => {
  const f = fixture(t);
  for (const name of ["README.md", "LICENSE"]) writeFileSync(join(f.root, name), `synthetic ${name}\n`);
  preparePackageDocs(f.root);
  preparePackageDocs(f.root);
  for (const name of ["README.md", "LICENSE"]) {
    assert.deepEqual(readFileSync(join(f.root, "apps/emend", name)), readFileSync(join(f.root, name)));
  }
  cleanPackageDocs(f.root);
  for (const name of ["README.md", "LICENSE"]) assert(!existsSync(join(f.root, "apps/emend", name)));
});

for (const differing of ["README.md", "LICENSE"]) {
  test(`prepack refuses a differing ${differing}, and cleanup leaves it alone`, (t) => {
    const f = fixture(t);
    for (const name of ["README.md", "LICENSE"]) writeFileSync(join(f.root, name), `synthetic ${name}\n`);
    preparePackageDocs(f.root);
    const target = join(f.root, "apps/emend", differing);
    writeFileSync(target, "keep this differing document\n");
    assert.throws(() => preparePackageDocs(f.root), {
      message: `package-docs: apps/emend/${differing} differs from the root ${differing}; remove it`,
    });
    cleanPackageDocs(f.root);
    assert.equal(readFileSync(target, "utf8"), "keep this differing document\n");
    const other = differing === "README.md" ? "LICENSE" : "README.md";
    assert(!existsSync(join(f.root, "apps/emend", other)));
  });
}

for (const [tag, expected] of [
  ["v1.3.0", "1.3.0"],
  ["v1.2.3", "1.2.3"],
  ["v1.1.9", "1.2.3"],
  [undefined, "1.2.3"],
]) {
  test(`local install stamps only a newer reachable release (${tag ?? "no tag"})`, async (t) => {
    const f = fixture(t, { tag });
    assert.equal(await f.run(), 0);
    assert.equal(f.installedVersion, expected, "stamped before pnpm install");
    assert.equal(f.builtSource, `export const VERSION = "${expected}";\n`);
    assert(f.stdout.includes(`install:local: installed emend ${expected} (${f.commit}).`));
    assert.equal(readFileSync(join(f.root, "apps/emend/package.json"), "utf8"), '{"version":"uncommitted"}');
    f.clean();
  });
}

for (const tag of ["v1.3.0-beta", "v1.3.0+build", "v01.3.0"]) {
  test(`local install ignores a non-plain tag (${tag})`, async (t) => {
    const f = fixture(t, { tag });
    assert.equal(await f.run(), 0);
    assert.equal(f.installedVersion, "1.2.3");
    assert.deepEqual(f.stderr, []);
    f.clean();
  });
}

test("local install refuses a missing VERSION line before installing dependencies", async (t) => {
  const f = fixture(t, { tag: "v1.3.0", missingVersion: true });
  assert.equal(await f.run(), 1);
  assert.deepEqual(f.stderr, ["install:local: stamp release version failed"]);
  assert(!f.calls.some((call) => call.label === "pnpm install"));
  f.clean();
});

test("local install skips a nearer prerelease and chooses the highest reachable plain version", async (t) => {
  const f = fixture(t, { tag: "v1.5.0", nearerTags: ["v1.6.0-rc.1", "v1.6.0+build", "v1.4.0"] });
  assert.equal(await f.run(), 0);
  assert.equal(f.installedVersion, "1.5.0");
  assert.equal(f.builtSource, 'export const VERSION = "1.5.0";\n');
  assert.deepEqual(f.stderr, []);
  f.clean();
});

test("local install resolves HEAD once and keeps the archive, tag and printed SHA on that commit", async (t) => {
  const f = fixture(t, { tag: "v1.3.0", moveHeadAfterRead: true });
  assert.equal(await f.run(), 0);
  assert.notEqual(f.git("rev-parse", "HEAD"), f.commit, "HEAD moved during the install");
  assert.match(f.commit, /^[0-9a-f]{40}$/);
  assert.deepEqual(
    f.calls.filter((call) => call.label === "git rev-parse").map((call) => call.args),
    [["rev-parse", "--verify", "HEAD"]],
  );
  assert.equal(f.calls.find((call) => call.label === "git archive")?.args.at(-1), f.commit);
  assert.equal(f.installedVersion, "1.3.0", "the newer HEAD's v9.0.0 tag must not be used");
  assert(f.stdout.includes(`install:local: installed emend 1.3.0 (${f.commit}).`));
  f.clean();
});


test("packing preserves the local-build marker while stripping workspace dependencies", () => {
  const packed = hooks.beforePacking({ name: "@shllg/emend", emendLocalBuild: "abc123", devDependencies: { "@emend/core": "workspace:*" } });
  assert.equal(packed.emendLocalBuild, "abc123");
  assert.equal(packed.devDependencies, undefined);
});
