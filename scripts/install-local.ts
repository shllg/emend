import { spawn } from "node:child_process";
import {
  accessSync,
  constants,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { delimiter, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { compareVersions, lastTag, stampVersion, VERSION_PATTERN } from "./release.ts";

interface CommandOptions {
  cwd: string;
  env: NodeJS.ProcessEnv;
  capture: boolean;
  signal?: AbortSignal;
}

type StopSignal = "SIGINT" | "SIGTERM";

interface SignalSource {
  on(signal: StopSignal, listener: () => void): unknown;
  off(signal: StopSignal, listener: () => void): unknown;
}

export type Runner = (command: string, args: string[], options: CommandOptions) => Promise<string>;

// Captured query stdout stays quiet; other commands inherit the terminal.
export const runCommand: Runner = (command, args, options) =>
  new Promise((resolve, reject) => {
    options.signal?.throwIfAborted();
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: options.env,
      stdio: options.capture ? ["inherit", "pipe", "inherit"] : "inherit",
    });
    const interrupt = () => child.kill(options.signal?.reason as StopSignal);
    const detach = () => options.signal?.removeEventListener("abort", interrupt);
    options.signal?.addEventListener("abort", interrupt, { once: true });
    let output = "";
    child.stdout?.setEncoding("utf8");
    child.stdout?.on("data", (chunk: string) => {
      output += chunk;
    });
    child.on("error", (error) => {
      detach();
      reject(error);
    });
    child.on("close", (code) => {
      detach();
      if (code === 0) resolve(output);
      else reject(new Error(`${command} exited ${code}`));
    });
  });

function findExecutable(name: string, env: NodeJS.ProcessEnv, cwd: string): string | undefined {
  if (env.PATH === undefined) return;
  for (const directory of env.PATH.split(delimiter)) {
    const candidate = resolve(cwd, directory, name);
    try {
      accessSync(candidate, constants.X_OK);
      if (statSync(candidate).isFile()) return candidate;
    } catch {
      // Continue to the next PATH entry, as command lookup does.
    }
  }
}

interface InstallOptions {
  root?: string;
  env?: NodeJS.ProcessEnv;
  run?: Runner;
  signals?: SignalSource;
  temporaryRoot?: string;
  stdout?: (line: string) => void;
  stderr?: (line: string) => void;
}

export async function installLocal(args: string[], options: InstallOptions = {}): Promise<number> {
  const stdout = options.stdout ?? console.log;
  const stderr = options.stderr ?? console.error;
  if (args.length > 1 || (args.length === 1 && args[0] !== "--npm")) {
    stderr("Usage: pnpm install:local [--npm]");
    return 2;
  }

  const root = options.root ?? fileURLToPath(new URL("..", import.meta.url));
  const env = options.env ?? process.env;
  const run = options.run ?? runCommand;
  const signals = options.signals ?? process;
  const interruption = new AbortController();
  const onInterrupt = () => interruption.abort("SIGINT");
  const onTerminate = () => interruption.abort("SIGTERM");
  let step = "read HEAD";
  let temporary: string | undefined;
  let status = 0;
  const command = async (label: string, program: string, argv: string[], cwd = root, capture = false) => {
    step = label;
    interruption.signal.throwIfAborted();
    const output = await run(program, argv, { cwd, env, capture, signal: interruption.signal });
    interruption.signal.throwIfAborted();
    return output;
  };

  signals.on("SIGINT", onInterrupt);
  signals.on("SIGTERM", onTerminate);
  try {
    const commit = (await command("read HEAD", "git", ["rev-parse", "--verify", "HEAD"], root, true)).trim();
    const dirty = await command("git status", "git", ["status", "--porcelain", "--untracked-files=all"], root, true);
    if (dirty.trim()) stdout(`install:local: uncommitted changes are not included; installing ${commit}.`);

    step = "create temporary folder";
    temporary = mkdtempSync(join(options.temporaryRoot ?? tmpdir(), "emend-install-local-"));
    const source = join(temporary, "src");
    const pack = join(temporary, "pack");
    mkdirSync(source);
    mkdirSync(pack);
    await command("git archive", "git", ["archive", "--format=tar", `--output=${join(temporary, "src.tar")}`, commit]);
    await command("tar extract", "tar", ["-xf", join(temporary, "src.tar"), "-C", source]);
    step = "read release tag";
    const tag = lastTag(root, commit);
    if (tag) {
      step = "stamp release version";
      const version = tag.slice(1);
      const committed = JSON.parse(readFileSync(join(source, "apps/emend/package.json"), "utf8")).version;
      if (typeof committed !== "string" || !VERSION_PATTERN.test(committed)) {
        throw new Error("Expected a plain release version");
      }
      if (compareVersions(version, committed) > 0) stampVersion(source, version);
    }
    step = "stamp local build";
    const manifestPath = join(source, "apps/emend/package.json");
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
    writeFileSync(manifestPath, `${JSON.stringify({ ...manifest, emendLocalBuild: commit }, null, 2)}\n`);
    await command("pnpm install", "pnpm", ["install", "--frozen-lockfile"], source);
    await command("pnpm build", "pnpm", ["build"], source);
    const pkg = join(source, "apps/emend");
    await command("pnpm pack", "pnpm", ["pack", "--pack-destination", pack], pkg);
    step = "read package";
    const version = JSON.parse(readFileSync(join(pkg, "package.json"), "utf8")).version;
    const tarballs = readdirSync(pack).filter((name) => name.endsWith(".tgz"));
    if (tarballs.length !== 1 || typeof version !== "string") throw new Error("Invalid packed package");
    const tarball = join(pack, tarballs[0]);

    let folder: string;
    const mise = findExecutable("mise", env, root);
    if (mise && args[0] !== "--npm") {
      const data =
        env.MISE_DATA_DIR ||
        (env.XDG_DATA_HOME ? join(env.XDG_DATA_HOME, "mise") : join(env.HOME || homedir(), ".local/share/mise"));
      folder = resolve(data, "linked-installs/npm-shllg-emend-local");
      await command("npm install", "npm", ["install", "-g", "--prefix", folder, tarball]);
      await command("mise link", mise, ["link", "--force", "npm:@shllg/emend@local", folder]);
    } else {
      await command("npm install", "npm", ["install", "-g", tarball]);
      folder = (await command("npm prefix", "npm", ["prefix", "-g"], root, true)).trim();
      if (!folder) throw new Error("Empty npm prefix");
    }
    stdout(`install:local: installed emend ${version} (${commit}).`);

    step = "check PATH";
    const installed = join(folder, "bin/emend");
    const installedPath = realpathSync(installed);
    const onPath = findExecutable("emend", env, root);
    if (!onPath) {
      stdout(`install:local: emend is not on your PATH; add ${join(folder, "bin")} to it.`);
    } else {
      let foundPath = realpathSync(onPath);
      let matches = foundPath === installedPath;
      if (mise && foundPath === realpathSync(mise)) {
        try {
          foundPath = realpathSync((await command("mise which", mise, ["which", "emend"], root, true)).trim());
          matches = foundPath === installedPath;
        } catch {
          interruption.signal.throwIfAborted();
          matches = false;
        }
      }
      if (!matches) {
        stdout(
          `install:local: the emend on your PATH is ${onPath} (${foundPath}), not this install; remove it or put ${join(folder, "bin")} before it.`,
        );
      }
    }

    let service: string | undefined;
    try {
      service = await command("service status", installed, ["service", "status"], root, true);
    } catch {
      interruption.signal.throwIfAborted();
      stdout("install:local: could not check the emend service; if you use it, run emend service install.");
    }
    if (service?.trim() === "emend: service not installed") {
      stdout("Next: emend service install, then emend skills install.");
    } else if (service !== undefined) {
      await command("service install", installed, ["service", "install"]);
    }
  } catch {
    stderr(`install:local: ${step} failed`);
    status = 1;
  } finally {
    if (temporary) {
      try {
        rmSync(temporary, { recursive: true, force: true });
      } catch {
        stderr("install:local: cleanup failed");
        status = 1;
      }
    }
    signals.off("SIGINT", onInterrupt);
    signals.off("SIGTERM", onTerminate);
  }
  return interruption.signal.aborted ? (interruption.signal.reason === "SIGINT" ? 130 : 143) : status;
}

if (import.meta.main) process.exitCode = await installLocal(process.argv.slice(2));
