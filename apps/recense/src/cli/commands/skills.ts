import { randomUUID } from "node:crypto";
import {
  accessSync,
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  readlinkSync,
  readSync,
  realpathSync,
  renameSync,
  statSync,
  symlinkSync,
  unlinkSync,
} from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import type { Io } from "../../main.ts";
import { escapeReference } from "../escape.ts";
import { CliError, CliUsageError } from "../http.ts";
import { cliRuntime } from "../runtime.ts";

export interface SkillsOptions {
  source?: string;
  cwd?: string;
}

function parseArgs(args: string[]) {
  const usage = () => new CliUsageError("Usage: recense skills install [--dir <path>] [--dry-run].");
  if (args[0] !== "install") throw usage();
  let dir: string | undefined;
  let dryRun = false;
  for (let i = 1; i < args.length; i++) {
    if (args[i] === "--dry-run" && !dryRun) dryRun = true;
    else if (args[i] === "--dir" && dir === undefined) {
      dir = args[++i];
      if (!dir || dir.startsWith("--") || dir.includes("\0")) throw usage();
    } else throw usage();
  }
  return { dir, dryRun };
}

function skillSources(folder: string) {
  try {
    const sources = readdirSync(folder)
      .sort()
      .flatMap((name) => {
        const path = join(folder, name);
        return statSync(path).isDirectory() ? [{ name, source: realpathSync.native(path) }] : [];
      });
    if (sources.length) return sources;
  } catch {
    // Source execution has no adjacent skills until the package is built.
  }
  throw new CliError("no skills found next to this recense; run pnpm build in the checkout");
}

function isRecenseLink(target: string, previous: string, name: string, packageName = "@shllg/recense"): boolean {
  try {
    if (!statSync(target).isDirectory()) return false;
  } catch (error) {
    return (
      ["ENOENT", "ENOTDIR"].includes((error as NodeJS.ErrnoException).code ?? "") &&
      previous.endsWith(`/dist/skills/${name}`)
    );
  }
  try {
    const source = realpathSync.native(target);
    if (!source.endsWith(`${sep}dist${sep}skills${sep}${name}`)) return false;
    const metadata = join(dirname(dirname(dirname(source))), "package.json");
    const handle = openSync(metadata, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
    try {
      const info = fstatSync(handle);
      if (!info.isFile() || info.size > 1024 * 1024) return false;
      const bytes = Buffer.alloc(info.size);
      let offset = 0;
      while (offset < bytes.length) {
        const count = readSync(handle, bytes, offset, bytes.length - offset, offset);
        if (!count) return false;
        offset += count;
      }
      const value: unknown = JSON.parse(bytes.toString("utf8"));
      return value !== null && typeof value === "object" && "name" in value && value.name === packageName;
    } finally {
      closeSync(handle);
    }
  } catch {
    return false;
  }
}

function checkDestination(dir: string, error: CliError) {
  let parent = dir;
  for (;;) {
    try {
      if (!statSync(parent).isDirectory()) throw error;
      accessSync(parent, constants.W_OK | constants.X_OK);
      return;
    } catch (cause) {
      const next = dirname(parent);
      if ((cause as NodeJS.ErrnoException).code !== "ENOENT" || next === parent) throw error;
      parent = next;
    }
  }
}

export async function skillsCommand(_stateDir: string, args: string[], io: Io) {
  const options = parseArgs(args);
  const cwd = io.skills?.cwd ?? process.cwd();
  const home = io.env.HOME && isAbsolute(io.env.HOME) ? resolve(io.env.HOME) : undefined;
  if (!home && options.dir === undefined) throw new CliError("HOME must be an absolute path; pass --dir");
  const dir = resolve(cwd, options.dir ?? join(home ?? "", ".agents/skills"));
  const display = (path: string) => {
    const absolute = resolve(cwd, path);
    const suffix = home ? relative(home, absolute) : undefined;
    if (suffix === "") return "~";
    if (suffix !== undefined && suffix !== ".." && !suffix.startsWith(`..${sep}`) && !isAbsolute(suffix))
      return escapeReference(`~${sep}${suffix}`);
    return escapeReference(absolute);
  };
  const foreign = (target: string) =>
    new CliError(
      `${display(target)} exists and was not made by recense; move it away, then run recense skills install again`,
    );
  const folder = io.skills?.source ?? join(dirname(cliRuntime().entry), "skills");
  const sources = skillSources(folder);
  const notWritable = new CliError(`${display(dir)} is not a folder recense can write to`);
  checkDestination(dir, notWritable);
  const plan = sources.map(({ name, source }) => {
    const target = join(dir, name);
    const existing = lstatSync(target, { throwIfNoEntry: false });
    const previous = existing?.isSymbolicLink() ? readlinkSync(target) : undefined;
    if (existing && previous !== source && (previous === undefined || !isRecenseLink(target, previous, name)))
      throw foreign(target);
    return { source, target, previous, unchanged: previous === source };
  });

  if (!options.dryRun && plan.some((link) => !link.unchanged)) {
    try {
      mkdirSync(dir, { recursive: true });
    } catch {
      throw notWritable;
    }
    for (const link of plan) {
      if (link.unchanged) continue;
      if (link.previous === undefined) {
        try {
          symlinkSync(link.source, link.target);
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === "EEXIST") throw foreign(link.target);
          throw error;
        }
      } else {
        const temporary = join(dirname(link.target), `.recense-${randomUUID()}`);
        symlinkSync(link.source, temporary);
        try {
          // Refuse a target replaced since preflight, before renaming over it.
          if (
            !lstatSync(link.target, { throwIfNoEntry: false })?.isSymbolicLink() ||
            readlinkSync(link.target) !== link.previous
          )
            throw foreign(link.target);
          renameSync(temporary, link.target);
        } finally {
          if (lstatSync(temporary, { throwIfNoEntry: false })) unlinkSync(temporary);
        }
      }
    }
  }
  // Links the package before the rename made (emend-<skill> into an @shllg/emend install) are replaced by the new ones.
  const stale = sources.flatMap(({ name }) => {
    const oldName = name.replace(/^recense-/, "emend-");
    const target = join(dir, oldName);
    if (oldName === name || !lstatSync(target, { throwIfNoEntry: false })?.isSymbolicLink()) return [];
    return isRecenseLink(target, readlinkSync(target), oldName, "@shllg/emend") ? [target] : [];
  });
  if (!options.dryRun) for (const target of stale) unlinkSync(target);
  for (const target of stale)
    io.stdout(`${options.dryRun ? "would remove" : "removed"} ${display(target)} (the old emend link)\n`);
  for (const link of plan) {
    io.stdout(
      link.unchanged
        ? `${display(link.target)} already linked\n`
        : `${options.dryRun ? "would link" : "linked"} ${display(link.target)} -> ${display(link.source)}\n`,
    );
  }
}
