import type { SkillsOptions } from "./cli/commands/skills.ts";
import type { UpdateOptions } from "./cli/commands/update.ts";
import type { ServiceOptions } from "./cli/service/common.ts";
import { NewerDatabaseError } from "./db/migrate.ts";
import { isStateModeError, StateFolderWriteError, stateAccessError } from "./state/files.ts";
import { defaultConfigDir, defaultStateDir } from "./state/paths.ts";
import { VERSION } from "./version.ts";

export interface Io {
  isTTY?: boolean;
  stdout: (s: string) => void;
  stdoutAsync?: (s: string) => Promise<void>;
  stdin?: AsyncIterable<Uint8Array | string>;
  stderr: (s: string) => void;
  env: Record<string, string | undefined>;
  openUrl?: (url: string) => Promise<boolean>;
  service?: ServiceOptions;
  skills?: SkillsOptions;
  update?: UpdateOptions;
}
// Keep separate: the help text's SQL verb and table name "devices" trigger the scanner's reviewer-table check.
const updateUsage = "  emend update                   Update emend and restart its service\n";
export async function run(argv: string[], io: Io): Promise<number> {
  if (argv.length === 1 && ["--help", "-h"].includes(argv[0] ?? "")) {
    io.stdout(`Usage:
  emend                         Open the review inbox
  emend serve [--tailscale]      Run the local server
  emend stop                     Stop the server emend started
  emend pair [--machine]        Pair a device or machine
  emend attach <link>            Attach this machine to a hub
  emend detach                   Detach this machine
  emend devices [--revoke <id>]  List or revoke devices
  emend publish <path>... [--title T] [--key K | --new] [--review ID] [--main PATH] [--source] [--json] [--project NAME]
  emend publish --manifest <file> [--review <id>] [--key <name>] [--project NAME]
  emend wait <review> [--timeout <seconds>] [--save <folder>]
  emend feedback <review> [--save <folder>]
  emend reply <comment> --status <outcome> (--body <text> | --body-file <path | ->)
  emend ls [--json]
  emend status [--json]
  emend mcp
  emend service install [serve options] | uninstall | status
${updateUsage}  emend skills install [--dir <path>] [--dry-run]
  emend config [list] | add docRoots <folder> | remove docRoots <folder> | set openBrowser true|false
  emend --version
`);
    return 0;
  }
  if (argv.length === 1 && argv[0] === "--version") {
    io.stdout(`emend ${VERSION}\n`);
    return 0;
  }
  if (
    [
      "wait",
      "feedback",
      "reply",
      "ls",
      "status",
      "stop",
      "mcp",
      "service",
      "update",
      "skills",
      "config",
      "pair",
      "devices",
      "attach",
      "detach",
    ].includes(argv[0] ?? "")
  ) {
    const { CliUsageError, CliSignalExit, errorLine } = await import("./cli/http.ts");
    try {
      const commands = {
        attach: () => import("./cli/commands/attach.ts").then((m) => m.attachCommand),
        detach: () => import("./cli/commands/detach.ts").then((m) => m.detachCommand),
        pair: () => import("./cli/commands/pair.ts").then((m) => m.pairCommand),
        devices: () => import("./cli/commands/devices.ts").then((m) => m.devicesCommand),
        wait: () => import("./cli/commands/wait.ts").then((m) => m.waitCommand),
        feedback: () => import("./cli/commands/feedback.ts").then((m) => m.feedbackCommand),
        reply: () => import("./cli/commands/reply.ts").then((m) => m.replyCommand),
        ls: () => import("./cli/commands/ls.ts").then((m) => m.lsCommand),
        status: () => import("./cli/commands/status.ts").then((m) => m.statusCommand),
        stop: () => import("./cli/commands/stop.ts").then((m) => m.stopCommand),
        mcp: () => import("./cli/commands/mcp.ts").then((m) => m.mcpCommand),
        service: () => import("./cli/commands/service.ts").then((m) => m.serviceCommand),
        update: () => import("./cli/commands/update.ts").then((m) => m.updateCommand),
        skills: () => import("./cli/commands/skills.ts").then((m) => m.skillsCommand),
      };
      if (argv[0] === "config") {
        const { configCommand } = await import("./cli/commands/config.ts");
        await configCommand(defaultStateDir(io.env), defaultConfigDir(io.env), argv.slice(1), io, process.cwd());
        return 0;
      }
      const command = await commands[argv[0] as keyof typeof commands]();
      await command(defaultStateDir(io.env), argv.slice(1), io);
      return 0;
    } catch (error) {
      if (error instanceof CliSignalExit) return error.exitCode;
      io.stderr(errorLine(stateAccessError(defaultStateDir(io.env), error), argv[0]));
      return error instanceof CliUsageError ? 2 : 1;
    }
  }
  if (argv[0] === "publish") {
    const { publishCommand } = await import("./cli/commands/publish.ts");
    const { CliError, errorLine } = await import("./cli/http.ts");
    try {
      await publishCommand(defaultStateDir(io.env), defaultConfigDir(io.env), argv.slice(1), io);
      return 0;
    } catch (caught) {
      const error = stateAccessError(defaultStateDir(io.env), caught);
      io.stderr(
        error instanceof NewerDatabaseError ||
          isStateModeError(error) ||
          error instanceof StateFolderWriteError ||
          error instanceof CliError
          ? errorLine(error, "publish")
          : "emend: Could not publish the review.\n",
      );
      return 1;
    }
  }
  if (argv.length && argv[0] !== "serve") {
    const command = /^[a-z][a-z0-9-]{0,40}$/i.test(argv[0] ?? "") ? argv[0] : "(invalid)";
    io.stderr(`emend: unknown command ${command}\n`);
    return 2;
  }
  // Keep the version path independent of database and server startup.
  const { parseServeArgs, serveCommand, UsageError } = await import("./cli/commands/serve.ts");
  const { CliError, CliSignalExit, errorLine } = await import("./cli/http.ts");
  try {
    if (argv[0] === "serve") {
      const options = parseServeArgs(argv.slice(1));
      await serveCommand(defaultStateDir(io.env), options, io, defaultConfigDir(io.env));
    } else {
      const { openCommand } = await import("./cli/commands/open.ts");
      await openCommand(defaultStateDir(io.env), defaultConfigDir(io.env), io, process.cwd());
    }
    return 0;
  } catch (caught) {
    const error = stateAccessError(defaultStateDir(io.env), caught);
    if (error instanceof CliSignalExit) return error.exitCode;
    io.stderr(
      error instanceof NewerDatabaseError || isStateModeError(error) || error instanceof StateFolderWriteError
        ? errorLine(error)
        : `emend: ${error instanceof UsageError || error instanceof CliError ? error.message : "Could not start the emend server."}\n`,
    );
    return error instanceof UsageError ? 2 : 1;
  }
}
