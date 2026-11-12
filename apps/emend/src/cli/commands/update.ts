import { realpath, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, isAbsolute, join, resolve } from "node:path";
import type { Io } from "../../main.ts";
import { VERSION } from "../../version.ts";
import { escapeReference, quoteShellArgument } from "../escape.ts";
import { findExecutable } from "../executable.ts";
import { CliError, CliSignalExit, CliUsageError } from "../http.ts";
import type { CliRuntime } from "../runtime.ts";
import { cliRuntime } from "../runtime.ts";
import { probeServer, serverRecord } from "../server-client.ts";
import { serviceFile, validatePaths } from "../service/common.ts";
import { plistPath } from "../service/launchd.ts";
import { unitPath } from "../service/systemd.ts";
import { hubCapabilities, readAttachment } from "../target.ts";
import { backupDatabase, databaseExists, pruneBackups } from "../update/backup.ts";
import { childEnvironment } from "../update/environment.ts";
import {
  detectInstall,
  type Install,
  locateArgs,
  type Method,
  methodTool,
  restoreArgs,
  updateArgs,
  updateDoc,
  updatePackage,
} from "../update/install.ts";
import { checkNewEmend, type NewEmend } from "../update/package.ts";
import { runChild, succeeded } from "../update/run.ts";
import { compareVersions } from "../version-notice.ts";

export interface UpdateOptions extends Partial<CliRuntime> {
  terminal?: boolean;
  uid?: number;
  platform?: string;
  home?: string;
  cwd?: string;
  now?: () => Date;
  localVersion?: () => Promise<{ url: string; version: string } | null>;
  hubVersion?: (url: string, signal: AbortSignal) => Promise<string>;
}

const minute = 60_000;

async function localServer(stateDir: string): Promise<{ url: string; version: string } | null> {
  try {
    const record = await serverRecord(stateDir);
    if (!record) return null;
    const result = await probeServer(record, 1000);
    if (result.kind !== "verified" || !result.capabilities) return null;
    return { url: record.url, version: result.capabilities.version };
  } catch {
    return null;
  }
}

const withNothingChanged = (message: string) =>
  `${message}${message.endsWith(".") ? " Nothing was changed." : "; nothing was changed."}`;

function printLocalBuild(io: Io, install: Extract<Install, { kind: "local" }>) {
  const where =
    install.where === "mise-link"
      ? "linked into mise"
      : `the checkout at ${escapeReference(install.root ?? "(unknown)")}`;
  const lines = [
    `emend: this emend is a local build (${where}); emend update changes nothing.`,
    "emend: to update it, review the new commits, then run in your emend checkout:",
  ];
  if (install.root !== undefined) lines.push(`  cd ${quoteShellArgument(install.root)}`);
  lines.push("  git pull", "  pnpm install", "  pnpm install:local");
  io.stdout(`${lines.join("\n")}\n`);
}

async function firstLine(text: string): Promise<string> {
  return text.split(/\r?\n/, 1)[0] ?? "";
}

export async function updateCommand(stateDirectory: string, args: string[], io: Io) {
  if (args.length) throw new CliUsageError("Usage: emend update.");
  const options = io.update ?? {};
  const terminal = options.terminal ?? (process.stdin.isTTY === true && process.stdout.isTTY === true);
  if (!terminal) throw new CliError("emend update runs only in your own terminal; nothing was changed.");
  const uid = options.uid ?? process.getuid?.();
  if (uid === 0) throw new CliError("run emend update as the user who runs emend, not as root.");
  const platform = options.platform ?? process.platform;
  if (platform !== "linux" && platform !== "darwin")
    throw new CliError(`emend update supports Linux and macOS; update emend as ${updateDoc} says.`);
  if (platform === "darwin" && uid === undefined) throw new CliError("Could not determine the service user.");
  const home = options.home ?? homedir();
  const stateDir = resolve(stateDirectory);
  try {
    if (!isAbsolute(home)) throw new CliError("");
    validatePaths(home, stateDir);
  } catch {
    throw new CliError("could not use the home folder; nothing was changed.");
  }
  const runtime = cliRuntime(options);
  const cwd = options.cwd ?? process.cwd();
  const unknown = () =>
    new CliError(`could not tell how emend was installed; update it as ${updateDoc} says. Nothing was changed.`);
  let install: Install;
  try {
    install = await detectInstall(await realpath(runtime.entry));
  } catch {
    throw unknown();
  }
  if (install.kind === "local") return printLocalBuild(io, install);
  if (install.kind === "unknown") throw unknown();
  const method: Method = install.kind;
  const tool = methodTool[method];
  let helper: { file: string; path: string };
  try {
    helper = await findExecutable(tool, io.env.PATH ?? "", { cwd, home });
    validatePaths(helper.file, runtime.node);
  } catch (error) {
    throw new CliError(withNothingChanged(error instanceof CliError ? error.message : `could not use ${tool} on PATH`));
  }
  const env = childEnvironment(io.env, { path: helper.path, home, stateDir });
  const servicePath = platform === "linux" ? unitPath(home, io.env.XDG_CONFIG_HOME) : plistPath(home);
  validatePaths(servicePath);
  const hasService = (await serviceFile(servicePath)) !== undefined;

  const now = options.now ?? (() => new Date());
  const database = join(stateDir, "emend.db");
  let backupPath: string | undefined;
  if (await databaseExists(database)) {
    backupPath = await backupDatabase(stateDir, VERSION, now());
    try {
      await pruneBackups(stateDir);
    } catch {
      io.stderr("emend: could not remove old backups.\n");
    }
    io.stdout(`emend: backed up the database to ${escapeReference(backupPath)}\n`);
  } else io.stdout("emend: no database to back up yet.\n");

  const goBack = (): string => {
    if (backupPath === undefined) return "";
    const stop = hasService
      ? platform === "linux"
        ? "systemctl --user stop emend"
        : `launchctl bootout gui/${uid}/dev.emend.server`
      : "emend stop";
    const old = [tool, ...restoreArgs(install, VERSION)]
      .map((word, index, words) => (words[index - 1] === "--prefix" ? quoteShellArgument(word) : word))
      .join(" ");
    const restore = `cp ${quoteShellArgument(backupPath)} ${quoteShellArgument(database)} && rm -f ${quoteShellArgument(`${database}-wal`)} ${quoteShellArgument(`${database}-shm`)}`;
    return `emend: to go back to emend ${VERSION} with the database from before this update, run:
  ${stop}
  ${old}
  ${restore}
  ${hasService ? "emend service install" : "emend"}
`;
  };
  const fail = (reason: string): never => {
    io.stderr(`emend: ${reason}\n${goBack()}`);
    throw new CliSignalExit(1);
  };

  try {
    const command = [basename(helper.file), ...updateArgs(install)].join(" ");
    io.stdout(`emend: running ${escapeReference(command)} in ${escapeReference(home)}\n`);
    const updated = await runChild(helper.file, updateArgs(install), {
      cwd: home,
      env,
      timeoutMs: 15 * minute,
      output: "inherit",
    });
    if (!succeeded(updated))
      return fail(
        `${escapeReference(command)} ${updated.timedOut ? "timed out" : updated.code === null ? "did not finish" : `failed with exit ${updated.code}`}.`,
      );
    const located = await locate(method, install, helper, env, home);
    const fresh = await checkNewEmend(located).catch((error: unknown) => {
      throw error instanceof CliError ? error : new CliError("the package manager did not install a usable emend.");
    });
    const version = fresh.version;
    const asked = await runChild(runtime.node, [fresh.entry, "--version"], {
      cwd: home,
      env,
      timeoutMs: 30_000,
      output: "capture",
    });
    if (!succeeded(asked) || asked.stdout !== `emend ${version}\n`)
      return fail("the new emend does not answer with its version.");
    io.stdout(
      version === VERSION
        ? `emend: emend ${version} is already the newest release\n`
        : `emend: emend is now ${version}\n`,
    );
    await restartService(hasService, version, fresh, runtime, env, home, io, stateDir, options, fail);
    io.stdout(`emend: this machine runs emend ${version}\n`);
    await reportHub(io, stateDir, version, options);
    const block = goBack();
    if (block) io.stdout(block);
  } catch (error) {
    if (error instanceof CliSignalExit) throw error;
    return fail(error instanceof CliError ? escapeReference(error.message) : "the update failed.");
  }
}

async function locate(
  method: Method,
  install: Install,
  helper: { file: string },
  env: Record<string, string>,
  home: string,
): Promise<string> {
  if (install.kind === "npm") return join(install.prefix, "lib", "node_modules", updatePackage);
  const result = await runChild(helper.file, locateArgs(install), {
    cwd: home,
    env,
    timeoutMs: 30_000,
    output: "capture",
  });
  const line = await firstLine(result.stdout);
  if (!succeeded(result) || !line) throw new CliError(`${methodTool[method]} did not say where it installed emend.`);
  validatePaths(line);
  if (method === "pnpm") return join(line, updatePackage);
  for (const candidate of [
    join(line, "lib", "node_modules", updatePackage),
    join(line, "node_modules", updatePackage),
  ]) {
    if (
      await stat(candidate).then(
        (info) => info.isDirectory(),
        () => false,
      )
    )
      return candidate;
  }
  throw new CliError("mise did not install emend where expected.");
}

async function restartService(
  hasService: boolean,
  version: string,
  fresh: NewEmend,
  runtime: CliRuntime,
  env: Record<string, string>,
  home: string,
  io: Io,
  stateDir: string,
  options: UpdateOptions,
  fail: (reason: string) => never,
) {
  const probe = options.localVersion ?? (() => localServer(stateDir));
  if (!hasService) {
    const running = await probe();
    if (running && running.version !== version)
      io.stdout(
        `emend: the emend server at ${escapeReference(running.url)} still runs emend ${escapeReference(running.version)}. Run emend stop, then emend, to start emend ${version}.\n`,
      );
    return;
  }
  if (version === VERSION && (await probe())?.version === version) {
    io.stdout(`emend: the emend service already runs emend ${version}\n`);
    return;
  }
  const installed = await runChild(runtime.node, [fresh.entry, "service", "install"], {
    cwd: home,
    env,
    timeoutMs: 3 * minute,
    output: "inherit",
  });
  const mismatch = `the emend service does not run emend ${version} yet; run emend service status.`;
  if (!succeeded(installed)) return fail(mismatch);
  const running = await probe();
  if (running?.version !== version) return fail(mismatch);
  io.stdout(`emend: the emend service runs emend ${version}\n`);
}

async function reportHub(io: Io, stateDir: string, version: string, options: UpdateOptions) {
  let url: string;
  try {
    const attachment = await readAttachment(stateDir);
    if (!attachment) return;
    url = attachment.hubUrl;
  } catch {
    return;
  }
  const shown = escapeReference(url);
  try {
    const signal = AbortSignal.timeout(3000);
    const hub = await (options.hubVersion ?? (async (hubUrl, abort) => (await hubCapabilities(hubUrl, abort)).version))(
      url,
      signal,
    );
    const comparison = compareVersions(hub, version);
    const advice =
      comparison === null
        ? "Update both to the same version."
        : comparison < 0
          ? "The hub is behind this machine; run emend update on the hub."
          : comparison > 0
            ? "This machine is behind the hub."
            : "Both run the same version.";
    io.stdout(`emend: the hub at ${shown} runs emend ${escapeReference(hub)}. ${advice}\n`);
  } catch {
    io.stdout(`emend: could not reach the hub at ${shown} to check its version.\n`);
  }
}
