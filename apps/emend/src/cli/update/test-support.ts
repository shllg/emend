import { randomUUID } from "node:crypto";
import { chmod, mkdir, mkdtemp, readFile, realpath, symlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { Io } from "../../main.ts";
import type { UpdateOptions } from "../commands/update.ts";

export type Layout = "npm" | "pnpm" | "mise";

export interface Fake {
  root: string;
  home: string;
  state: string;
  bin: string;
  log: string;
  config: string;
  layout: Layout;
  /** The folder of the installed package that runs now. */
  oldPackage: string;
  entry: string;
  stdout: string[];
  stderr: string[];
  io: Io;
  options: UpdateOptions;
  calls: () => Promise<Record<string, unknown>[]>;
  set: (patch: Record<string, unknown>) => Promise<void>;
}

/** An emend whose `--version` answers `version`; `service install` records itself and sets the server version. */
export function emendScript(version: string, root: string): string {
  return `import { appendFileSync, readFileSync, writeFileSync } from "node:fs";
const config = JSON.parse(readFileSync(${JSON.stringify(join(root, "fake.json"))}, "utf8"));
const argv = process.argv.slice(2);
if (argv[0] === "--version") {
  appendFileSync(config.newLog, "version\\n");
  process.stdout.write(config.badVersion ? "emend nonsense\\n" : "emend ${version}\\n");
}
else if (argv[0] === "service" && argv[1] === "install") {
  appendFileSync(config.newLog, "service\\n");
  appendFileSync(config.log, JSON.stringify({ tool: "service-install", entry: process.argv[1], node: process.execPath, argv, cwd: process.cwd(), env: Object.keys(process.env), emendHome: process.env.EMEND_HOME }) + "\\n");
  if (config.serviceFails) process.exit(1);
  writeFileSync(config.serverFile, config.serverVersion ?? "${version}");
}
`;
}

function toolScript(tool: string, root: string): string {
  return `#!${process.execPath}
const fs = require("node:fs");
const path = require("node:path");
const config = JSON.parse(fs.readFileSync(${JSON.stringify(join(root, "fake.json"))}, "utf8"));
const argv = process.argv.slice(2);
fs.appendFileSync(config.log, JSON.stringify({ tool: ${JSON.stringify(tool)}, argv, cwd: process.cwd(), env: Object.keys(process.env), values: { PATH: process.env.PATH, HOME: process.env.HOME, EMEND_HOME: process.env.EMEND_HOME, npm_config_ignore_scripts: process.env.npm_config_ignore_scripts } }) + "\\n");
const verb = argv[0];
if (verb === "install" || verb === "add" || verb === "upgrade") {
  if (config.sleep) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, config.sleep);
  if (config.updateFails) process.exit(3);
  fs.writeFileSync(config.updated, "yes");
  fs.mkdirSync(path.join(config.newPackage, "dist"), { recursive: true });
  fs.writeFileSync(path.join(config.newPackage, "package.json"), JSON.stringify({ name: "@shllg/emend", version: config.newVersion }));
  fs.writeFileSync(path.join(config.newPackage, "dist/emend.mjs"), config.newScript);
} else if (verb === "list") {
  if (config.listWarning) process.stderr.write(config.listWarning);
  if (config.listError) { process.stderr.write(config.listError); process.exit(2); }
  const folder = fs.existsSync(config.updated) ? config.newPackage : config.oldPackage;
  process.stdout.write(config.listOutput ?? JSON.stringify([{ dependencies: config.unlisted ? {} : { "@shllg/emend": { version: "0.1.0", path: folder } } }]));
}
else if (verb === "where") process.stdout.write(config.located + "\\n");
`;
}

export async function makeDatabase(path: string, value = "synthetic row") {
  const database = new DatabaseSync(path);
  database.exec("PRAGMA journal_mode = WAL; CREATE TABLE sample (value TEXT); ");
  database.prepare("INSERT INTO sample (value) VALUES (?)").run(value);
  database.close();
}

export async function makeFake(parent: string, layout: Layout, oldVersion = "0.1.0"): Promise<Fake> {
  const root = await realpath(await mkdtemp(join(parent, "update-")));
  const home = join(root, "home");
  const state = join(root, "state");
  const bin = join(root, "bin");
  const log = join(root, "log.jsonl");
  const config = join(root, "fake.json");
  await Promise.all([home, bin].map((path) => mkdir(path, { recursive: true })));
  await mkdir(state, { mode: 0o700 });
  await writeFile(log, "");
  await writeFile(join(root, "new-log"), "");
  let oldPackage: string;
  let newPackage: string;
  let located: string;
  if (layout === "npm") {
    oldPackage = newPackage = join(root, "prefix/lib/node_modules/@shllg/emend");
    located = "";
  } else if (layout === "pnpm") {
    const modules = join(root, "pnpm/global/5/node_modules");
    oldPackage = newPackage = join(modules, ".pnpm/@shllg+emend@x/node_modules/@shllg/emend");
    located = modules;
  } else {
    oldPackage = join(root, "mise/installs/npm-shllg-emend/0.1.0/lib/node_modules/@shllg/emend");
    const next = join(root, "mise/installs/npm-shllg-emend/0.2.0");
    newPackage = join(next, "lib/node_modules/@shllg/emend");
    located = next;
  }
  await mkdir(join(oldPackage, "dist"), { recursive: true });
  await writeFile(join(oldPackage, "package.json"), JSON.stringify({ name: "@shllg/emend", version: oldVersion }));
  await writeFile(join(oldPackage, "dist/emend.mjs"), emendScript(oldVersion, root));
  if (layout === "npm") {
    await mkdir(join(oldPackage, "bin"));
    await writeFile(join(oldPackage, "bin/emend"), "synthetic launcher");
    await mkdir(join(root, "prefix/bin"));
    await symlink(join(oldPackage, "bin/emend"), join(root, "prefix/bin/emend"));
  }
  let entry = join(oldPackage, "dist/emend.mjs");
  if (layout === "pnpm") {
    const link = join(root, "pnpm/global/5/node_modules/@shllg/emend");
    await mkdir(dirname(link), { recursive: true });
    await symlink(oldPackage, link);
    entry = join(link, "dist/emend.mjs");
  }
  for (const tool of ["npm", "pnpm", "mise"]) {
    await writeFile(join(bin, tool), toolScript(tool, root));
    await chmod(join(bin, tool), 0o755);
  }
  const fake: Fake = {
    root,
    home,
    state,
    bin,
    log,
    config,
    layout,
    oldPackage,
    entry,
    stdout: [],
    stderr: [],
    options: {
      terminal: true,
      uid: 1000,
      platform: "linux",
      home,
      accountHome: home,
      node: process.execPath,
      cwd: home,
      entry,
      now: () => new Date("2026-11-12T10:20:30.123Z"),
      localVersion: async () => {
        const version = await readFile(join(root, "server-version"), "utf8").catch(() => "");
        return version ? { url: "http://127.0.0.1:3636", version } : null;
      },
    },
    io: undefined as unknown as Io,
    calls: async () =>
      (await readFile(log, "utf8"))
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line)),
    set: async (patch) => {
      const current = JSON.parse(await readFile(config, "utf8"));
      await writeFile(config, JSON.stringify({ ...current, ...patch }));
    },
  };
  await writeFile(
    config,
    JSON.stringify({
      log,
      newLog: join(root, "new-log"),
      updated: join(root, "updated"),
      oldPackage,
      serverFile: join(root, "server-version"),
      newPackage,
      newVersion: "0.2.0",
      newScript: emendScript("0.2.0", root),
      located,
    }),
  );
  fake.io = {
    stdout: (s) => fake.stdout.push(s),
    stderr: (s) => fake.stderr.push(s),
    env: {
      PATH: bin,
      HOME: home,
      EMEND_HOME: state,
      USER: "synthetic",
      NODE_OPTIONS: "--require /nowhere.js",
      NODE_PATH: "/nowhere",
      npm_config_registry: "http://nowhere.invalid",
      NPM_CONFIG_PREFIX: "/nowhere",
      MISE_SOMETHING: "1",
      LC_ALL: "C",
      XDG_CONFIG_HOME: join(home, ".config"),
      XDG_RUNTIME_DIR: "relative",
    },
    update: fake.options,
  };
  return fake;
}

export async function installService(fake: Fake) {
  const unit = join(fake.home, ".config/systemd/user/emend.service");
  await mkdir(dirname(unit), { recursive: true });
  await writeFile(unit, "# written by emend\n");
}

export async function attachHub(state: string, url = "https://hub.example.test") {
  await writeFile(
    join(state, "attach.json"),
    JSON.stringify({ hubId: randomUUID(), hubName: "Synthetic hub", hubUrl: url }),
    { mode: 0o600 },
  );
}
