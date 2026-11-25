import { realpath, unlink } from "node:fs/promises";
import { homedir, userInfo } from "node:os";
import { basename, isAbsolute, join, resolve } from "node:path";
import type { Io } from "../../main.ts";
import { VERSION } from "../../version.ts";
import { escapeReference, quoteShellArgument } from "../escape.ts";
import { filterExecutablePath, findExecutable, pathThroughRepository } from "../executable.ts";
import { CliError, CliSignalExit, CliUsageError } from "../http.ts";
import type { CliRuntime } from "../runtime.ts";
import { cliRuntime } from "../runtime.ts";
import { repositoryRoots } from "../runtime-repository.ts";
import { probeServer, serverRecord } from "../server-client.ts";
import { serviceFile, validatePaths } from "../service/common.ts";
import { plistPath } from "../service/launchd.ts";
import { unitPath } from "../service/systemd.ts";
import { hubCapabilities, readAttachment } from "../target.ts";
import { backupDatabase, databaseExists, pruneBackups } from "../update/backup.ts";
import { childEnvironment } from "../update/environment.ts";
import { goBack } from "../update/go-back.ts";
import {
  detectInstall,
  type Install,
  locateArgs,
  locateMisePackage,
  type Method,
  methodTool,
  updateArgs,
  updateDoc,
  updatePackage,
} from "../update/install.ts";
import { checkSkillLinks, localBuildNote, nextSteps } from "../update/next-steps.ts";
import { checkNewRecense, type NewRecense } from "../update/package.ts";
import { pnpmPackages } from "../update/pnpm.ts";
import { runChild, succeeded } from "../update/run.ts";
import { signalExitCodes, UpdateSignals } from "../update/signals.ts";
import { compareVersions } from "../version-notice.ts";

export interface UpdateOptions extends Partial<CliRuntime> {
  terminal?: boolean;
  uid?: number;
  platform?: string;
  home?: string;
  accountHome?: string;
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
      : install.where === "marked"
        ? "built with pnpm install:local"
        : `the checkout at ${escapeReference(install.root ?? "(unknown)")}`;
  const lines = [
    `recense: this recense is a local build (${where}); recense update changes nothing.`,
    "recense: to update it, review the new commits, then run in your recense checkout:",
  ];
  if (install.root !== undefined) lines.push(`  cd ${quoteShellArgument(install.root)}`);
  lines.push("  git pull", "  pnpm install", "  pnpm install:local");
  lines.push(localBuildNote());
  io.stdout(`${lines.join("\n")}\n`);
}

async function firstLine(text: string): Promise<string> {
  return text.split(/\r?\n/, 1)[0] ?? "";
}

function checkedOldEntry(entry: string): string {
  validatePaths(entry);
  if (entry.includes("=")) throw new CliError("could not use the old entry path");
  return entry;
}

export async function updateCommand(stateDirectory: string, args: string[], io: Io) {
  if (args.length) throw new CliUsageError("Usage: recense update.");
  const options = io.update ?? {};
  const terminal = options.terminal ?? (process.stdin.isTTY === true && process.stdout.isTTY === true);
  if (!terminal) throw new CliError("recense update runs only in your own terminal; nothing was changed.");
  const uid = options.uid ?? process.getuid?.();
  if (uid === 0) throw new CliError("run recense update as the user who runs recense, not as root.");
  const platform = options.platform ?? process.platform;
  if (platform !== "linux" && platform !== "darwin")
    throw new CliError(`recense update supports Linux and macOS; update recense as ${updateDoc} says.`);
  if (platform === "darwin" && uid === undefined) throw new CliError("Could not determine the service user.");
  const home = options.home ?? homedir();
  const stateDir = resolve(stateDirectory);
  try {
    if (!isAbsolute(home)) throw new CliError("");
    validatePaths(home, stateDir);
  } catch {
    throw new CliError("could not use the home folder; nothing was changed.");
  }
  try {
    if ((await realpath(home)) !== (await realpath(options.accountHome ?? userInfo().homedir)))
      throw new Error("home mismatch");
  } catch {
    throw new CliError(
      "HOME is not your account's home folder; run recense update from a normal shell. Nothing was changed.",
    );
  }
  const runtime = cliRuntime(options);
  const cwd = options.cwd ?? process.cwd();
  const unknown = (detail = "") =>
    new CliError(
      `could not tell how recense was installed${detail ? ` (${detail})` : ""}; update it as ${updateDoc} says. Nothing was changed.`,
    );
  let roots: string[];
  try {
    roots = await repositoryRoots(cwd, home);
  } catch {
    throw new CliError("could not check the working directory's repositories; nothing was changed.");
  }
  const prepareHelper = async (tool: string) => {
    try {
      const helper = await findExecutable(tool, io.env.PATH ?? "", { cwd, home });
      validatePaths(helper.file, runtime.node);
      if ([helper.file, runtime.node].some((path) => path.includes("="))) throw new Error("ambiguous env command");
      helper.path = await filterExecutablePath(["node", "npm", "pnpm", "bun", "aube", "systemctl"], helper.path, roots);
      const env = await childEnvironment(io.env, { path: helper.path, home, stateDir }, roots);
      return { helper, env };
    } catch (error) {
      throw new CliError(
        withNothingChanged(error instanceof CliError ? error.message : `could not use ${tool} on PATH`),
      );
    }
  };
  let prepared: Awaited<ReturnType<typeof prepareHelper>> | undefined;
  let install: Install;
  let rollbackEntry: string;
  try {
    const oldEntry = checkedOldEntry(await realpath(runtime.entry));
    install = await detectInstall(oldEntry, async (folder) => {
      prepared = await prepareHelper("pnpm");
      await pnpmPackages(prepared.helper.file, home, prepared.env, folder);
      return true;
    });
    rollbackEntry = oldEntry;
    if (install.kind === "mise" && install.entry !== undefined) {
      rollbackEntry = checkedOldEntry(install.entry);
      if (await pathThroughRepository(install.entry, roots).catch(() => true))
        throw new CliError("the old entry's path failed the repository check for the working directory");
    }
  } catch (error) {
    throw unknown(error instanceof CliError ? error.message : "");
  }
  if (install.kind === "local") return printLocalBuild(io, install);
  if (install.kind === "unknown") throw unknown();
  const method: Method = install.kind;
  const tool = methodTool[method];
  const { helper, env } = prepared ?? (await prepareHelper(tool));
  const servicePath = platform === "linux" ? unitPath(home, env.XDG_CONFIG_HOME) : plistPath(home);
  validatePaths(servicePath);
  const hasService = (await serviceFile(servicePath)) !== undefined;
  let systemctl: string | undefined;
  if (hasService && platform === "linux") {
    try {
      systemctl = (await findExecutable("systemctl", env.PATH, { cwd, home })).file;
      validatePaths(systemctl);
      if (systemctl.includes("=")) throw new Error("ambiguous env command");
    } catch {
      throw new CliError("could not use systemctl on PATH; nothing was changed.");
    }
  }

  const now = options.now ?? (() => new Date());
  const database = join(stateDir, "recense.db");
  let backupPath: string | undefined;
  let backupTime: string | undefined;
  let installerStarted = false;
  const rollback = () =>
    goBack({
      home,
      stateDir,
      database,
      backupPath,
      backupTime,
      oldVersion: VERSION,
      oldEntry: rollbackEntry,
      node: runtime.node,
      helper: helper.file,
      install,
      hasService,
      platform,
      uid,
      env,
      systemctl,
    });
  const fail = (reason: string, code = 1): never => {
    try {
      io.stderr(`recense: ${reason}\n${installerStarted ? rollback() : ""}`);
    } catch {
      // A hung-up terminal must not replace the interruption's exit code.
    }
    throw new CliSignalExit(code);
  };

  const signals = new UpdateSignals();
  const checkpoint = () => {
    if (signals.interrupted) fail("recense update was interrupted.", signalExitCodes[signals.interrupted]);
  };
  const step = async <T>(action: () => Promise<T>): Promise<T> => {
    checkpoint();
    const result = await action();
    checkpoint();
    return result;
  };
  try {
    if (await step(() => databaseExists(database))) {
      // Store the completed backup before checking a signal received while it was copying.
      const at = now();
      backupTime = at.toISOString();
      backupPath = await backupDatabase(stateDir, VERSION, at);
      checkpoint();
      io.stdout(`recense: backed up the database to ${escapeReference(backupPath)}\n`);
    } else io.stdout("recense: no database to back up yet.\n");
    const runningBefore = await step(options.localVersion ?? (() => localServer(stateDir)));
    const command = [basename(helper.file), ...updateArgs(install)].join(" ");
    io.stdout(`recense: running ${escapeReference(command)} in ${escapeReference(home)}\n`);
    const updated = await step(() => {
      installerStarted = true;
      return runChild(helper.file, updateArgs(install), {
        cwd: home,
        env,
        timeoutMs: 15 * minute,
        output: "inherit",
        signals,
      });
    });
    if (!succeeded(updated))
      return fail(
        `${escapeReference(command)} ${updated.timedOut ? "timed out" : updated.code === null ? "did not finish" : `failed with exit ${updated.code}`}.`,
      );
    const located = await step(() => locate(method, install, helper, env, home, signals));
    const currentRoots = await step(() => repositoryRoots(cwd, home));
    const checked = await checkNewRecense(located, currentRoots);
    checkpoint();
    const version = checked.version;
    if (compareVersions(version, VERSION) === -1)
      return fail(`${tool} installed recense ${version}, older than ${VERSION}.`);
    const asked = await step(() =>
      runChild(runtime.node, [checked.entry, "--version"], {
        cwd: home,
        env,
        timeoutMs: 30_000,
        output: "capture",
        signals,
      }),
    );
    if (!succeeded(asked) || asked.stdout !== `recense ${version}\n`)
      return fail("the new recense does not answer with its version.");
    io.stdout(
      version === VERSION
        ? `recense: recense ${version} is already installed; ${tool} installed nothing newer\n`
        : `recense: recense is now ${version}\n`,
    );
    const restarted = await step(() =>
      restartService(
        hasService,
        version,
        checked,
        runtime,
        env,
        home,
        io,
        stateDir,
        options,
        fail,
        runningBefore,
        signals,
        checkpoint,
      ),
    );
    io.stdout(`recense: this machine runs recense ${version}\n`);
    const attached = await step(() => reportHub(io, stateDir, version, options, checkpoint));
    if (backupPath !== undefined) {
      if (version === VERSION && !restarted && (!runningBefore || runningBefore.version === version)) {
        await unlink(backupPath);
        backupPath = undefined;
        io.stdout("recense: nothing changed; removed the backup.\n");
      } else {
        try {
          await pruneBackups(stateDir, backupPath);
        } catch {
          io.stderr("recense: could not remove old backups.\n");
        }
      }
    }
    const notes = await step(async () => nextSteps(version, await checkSkillLinks(home, checked.folder), attached));
    checkpoint();
    if (version !== VERSION) io.stdout(rollback());
    io.stdout(notes);
  } catch (error) {
    if (error instanceof CliSignalExit) throw error;
    checkpoint();
    return fail(error instanceof CliError ? escapeReference(error.message) : "the update failed.");
  } finally {
    signals.dispose();
  }
}

async function locate(
  method: Method,
  install: Install,
  helper: { file: string },
  env: Record<string, string>,
  home: string,
  signals: UpdateSignals,
): Promise<string> {
  if (install.kind === "npm") return join(install.prefix, "lib", "node_modules", updatePackage);
  if (method === "pnpm") {
    const folders = await pnpmPackages(helper.file, home, env, undefined, signals);
    if (folders.length !== 1 || folders[0] === undefined)
      throw new CliError("pnpm did not say where it installed recense.");
    return folders[0];
  }
  const result = await runChild(helper.file, locateArgs(install), {
    cwd: home,
    env,
    timeoutMs: 30_000,
    output: "capture",
    signals,
  });
  const line = await firstLine(result.stdout);
  if (!succeeded(result) || !line) throw new CliError(`${methodTool[method]} did not say where it installed recense.`);
  validatePaths(line);
  const folder = await locateMisePackage(line);
  if (folder === undefined) throw new CliError("mise did not install recense where expected.");
  return folder;
}

async function restartService(
  hasService: boolean,
  version: string,
  fresh: NewRecense,
  runtime: CliRuntime,
  env: Record<string, string>,
  home: string,
  io: Io,
  stateDir: string,
  options: UpdateOptions,
  fail: (reason: string, code?: number) => never,
  runningBefore: { url: string; version: string } | null,
  signals: UpdateSignals,
  checkpoint: () => void,
) {
  const probe = options.localVersion ?? (() => localServer(stateDir));
  if (!hasService) {
    const running = runningBefore;
    if (running && running.version !== version)
      io.stdout(
        `recense: the recense server at ${escapeReference(running.url)} still runs recense ${escapeReference(running.version)}. Run recense stop, then recense, to start recense ${version}.\n`,
      );
    return false;
  }
  if (version === VERSION) {
    const running = await probe();
    checkpoint();
    if (running?.version === version) {
      io.stdout(`recense: the recense service already runs recense ${version}\n`);
      return false;
    }
  }
  const installed = await runChild(runtime.node, [fresh.entry, "service", "install"], {
    cwd: home,
    env,
    timeoutMs: 3 * minute,
    output: "inherit",
    signals,
  });
  checkpoint();
  const mismatch = `the recense service does not run recense ${version} yet; run recense service status.`;
  if (!succeeded(installed)) return fail(mismatch);
  const running = await probe();
  checkpoint();
  if (running?.version !== version) return fail(mismatch);
  io.stdout(`recense: the recense service runs recense ${version}\n`);
  return true;
}

async function reportHub(io: Io, stateDir: string, version: string, options: UpdateOptions, checkpoint: () => void) {
  let url: string;
  try {
    const attachment = await readAttachment(stateDir);
    checkpoint();
    if (!attachment) return false;
    url = attachment.hubUrl;
  } catch (error) {
    if (error instanceof CliSignalExit) throw error;
    return false;
  }
  checkpoint();
  const shown = escapeReference(url);
  try {
    const signal = AbortSignal.timeout(3000);
    const hub = await (options.hubVersion ?? (async (hubUrl, abort) => (await hubCapabilities(hubUrl, abort)).version))(
      url,
      signal,
    );
    checkpoint();
    const comparison = compareVersions(hub, version);
    const advice =
      comparison === null
        ? "Update both to the same version."
        : comparison < 0
          ? "The hub is behind this machine; run recense update on the hub."
          : comparison > 0
            ? "This machine is behind the hub."
            : "Both run the same version.";
    io.stdout(`recense: the hub at ${shown} runs recense ${escapeReference(hub)}. ${advice}\n`);
  } catch (error) {
    if (error instanceof CliSignalExit) throw error;
    checkpoint();
    io.stdout(`recense: could not reach the hub at ${shown} to check its version.\n`);
  }
  return true;
}
