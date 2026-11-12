import { chmod, mkdtemp, readFile, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, test } from "vitest";
import { quoteShellArgument } from "../escape.ts";
import { goBack } from "./go-back.ts";
import { runChild } from "./run.ts";

const directoryNames = [
  "MISE_DATA_DIR",
  "MISE_CONFIG_DIR",
  "MISE_CACHE_DIR",
  "MISE_STATE_DIR",
  "PNPM_HOME",
  "XDG_DATA_HOME",
  "XDG_CONFIG_HOME",
  "XDG_CACHE_HOME",
  "XDG_STATE_HOME",
];

test.each(["npm", "pnpm", "mise"] as const)(
  "%s go-back restores before stopping without a service, and stops the service first otherwise",
  (kind) => {
    for (const hasService of [false, true])
      for (const platform of ["linux", "darwin"]) {
        const block = goBack({
          home: "/home/user",
          stateDir: "/state",
          database: "/state/emend.db",
          backupPath: "/state/backup.db",
          oldVersion: "0.1.0",
          oldEntry: "/old/emend.mjs",
          node: "/runtime/node",
          helper: `/tools/${kind}`,
          install: kind === "npm" ? { kind, prefix: "/prefix" } : { kind },
          hasService,
          platform,
          uid: 1000,
          env: {},
        });
        const commands = block.split("\n").filter((line) => line.startsWith("  "));
        expect(commands).toHaveLength(5);
        expect(commands.slice(0, -1).every((line) => line.endsWith(" &&"))).toBe(true);
        expect(commands[0]).toBe("  cd '/home/user' &&");
        expect(commands[hasService ? 1 : 2]).toBe(
          hasService
            ? `  ${platform === "linux" ? "systemctl --user stop emend" : "{ launchctl bootout gui/1000/dev.emend.server || ! launchctl print gui/1000/dev.emend.server >/dev/null 2>&1; }"} &&`
            : `  /usr/bin/env -u XDG_CONFIG_HOME EMEND_HOME='/state' '/runtime/node' '/old/emend.mjs' stop &&`,
        );
        const args = {
          npm: "install --global --prefix '/prefix' --ignore-scripts @shllg/emend@0.1.0",
          pnpm: "add --global --ignore-scripts --ignore-pnpmfile @shllg/emend@0.1.0",
          mise: "use --global npm:@shllg/emend@0.1.0",
        }[kind];
        expect(commands[hasService ? 2 : 1]).toBe(
          `  /usr/bin/env ${directoryNames.map((name) => `-u ${name}`).join(" ")} npm_config_ignore_scripts=true '/tools/${kind}' ${args} &&`,
        );
        expect(commands[3]).toBe(
          "  cp '/state/backup.db' '/state/emend.db' && rm -f '/state/emend.db-wal' '/state/emend.db-shm' &&",
        );
        expect(commands[4]).toBe(
          `  /usr/bin/env -u XDG_CONFIG_HOME EMEND_HOME='/state' '/runtime/node' '/old/emend.mjs'${hasService ? " service install" : ""}`,
        );
      }
  },
);

test.each(directoryNames)("rollback pins only the child's %s and quotes shell metacharacters", (name) => {
  const value = "/safe/quote's $folder";
  const block = goBack({
    home: value,
    stateDir: value,
    database: `${value}/emend.db`,
    backupPath: `${value}/backup.db`,
    oldVersion: "0.1.0",
    oldEntry: `${value}/emend.mjs`,
    node: `${value}/node`,
    helper: `${value}/mise`,
    install: { kind: "mise" },
    hasService: false,
    platform: "linux",
    uid: 1000,
    env: {
      [name]: value,
      HTTPS_PROXY: "https://proxy.example.test",
      USER: "private-identity",
      XDG_RUNTIME_DIR: "/runtime",
    },
  });
  expect(block).toContain(`npm_config_ignore_scripts=true ${name}=${quoteShellArgument(value)} `);
  for (const absent of directoryNames.filter((candidate) => candidate !== name)) {
    expect(block).toContain(`-u ${absent}`);
    expect(block).not.toContain(`${absent}=`);
  }
  expect(block).not.toMatch(/PROXY|proxy.example|USER|private-identity|XDG_RUNTIME_DIR/);
  const emendPins = `/usr/bin/env ${name === "XDG_CONFIG_HOME" ? "" : "-u XDG_CONFIG_HOME "}EMEND_HOME=${quoteShellArgument(value)}${name === "XDG_CONFIG_HOME" ? ` XDG_CONFIG_HOME=${quoteShellArgument(value)}` : ""}`;
  expect(block).toContain(
    `${emendPins} ${quoteShellArgument(`${value}/node`)} ${quoteShellArgument(`${value}/emend.mjs`)} stop &&`,
  );
});

test.each([false, true])(
  "the pasted list clears absent names and pins present ones (config present: %s)",
  async (configPresent) => {
    const root = await mkdtemp(join(process.env.EMEND_HOME as string, "rollback-"));
    const database = join(root, "emend.db");
    const backupPath = join(root, "backup.db");
    const log = join(root, "log");
    const helper = join(root, "helper");
    const node = join(root, "node");
    const oldEntry = join(root, "old-entry");
    const names = [...directoryNames, "npm_config_ignore_scripts", "EMEND_HOME"];
    const script = `#!${process.execPath}
const fs = require("node:fs");
const argv = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify({ argv, env: Object.fromEntries(${JSON.stringify(names)}.map(name => [name, process.env[name] ?? null])), database: fs.readFileSync(${JSON.stringify(database)}, "utf8") }) + "\\n");
`;
    await writeFile(helper, `${script}fs.writeFileSync(${JSON.stringify(oldEntry)}, "restored");`);
    await writeFile(node, `${script}if (!fs.existsSync(${JSON.stringify(oldEntry)})) process.exit(1);`);
    await Promise.all([helper, node].map((file) => chmod(file, 0o755)));
    // The shell sees only the fixture PATH, with the real file tools explicitly linked in.
    await symlink("/bin/cp", join(root, "cp"));
    await symlink("/bin/rm", join(root, "rm"));
    await writeFile(database, "new database");
    await writeFile(backupPath, "old database");
    await writeFile(`${database}-wal`, "wal");
    await writeFile(`${database}-shm`, "shm");
    const env = { PNPM_HOME: root, ...(configPresent ? { XDG_CONFIG_HOME: root } : {}) };
    const block = goBack({
      home: root,
      stateDir: root,
      database,
      backupPath,
      oldVersion: "0.1.0",
      oldEntry,
      node,
      helper,
      install: { kind: "pnpm" },
      hasService: false,
      platform: "linux",
      env,
    });
    const commands = block
      .split("\n")
      .filter((line) => line.startsWith("  "))
      .join("\n");
    const result = await runChild("/bin/sh", ["-c", commands], {
      cwd: root,
      env: { PATH: root, ...Object.fromEntries(names.map((name) => [name, "/repository/changed"])) },
      timeoutMs: 3000,
      output: "capture",
    });
    expect(result.code, result.stderr).toBe(0);
    const calls = (await readFile(log, "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    expect(calls.map((call) => call.argv)).toEqual([
      ["add", "--global", "--ignore-scripts", "--ignore-pnpmfile", "@shllg/emend@0.1.0"],
      [oldEntry, "stop"],
      [oldEntry],
    ]);
    for (const name of directoryNames) expect(calls[0].env[name]).toBe(env[name as keyof typeof env] ?? null);
    expect(calls[0].env.npm_config_ignore_scripts).toBe("true");
    for (const call of calls.slice(1)) {
      expect(call.env.XDG_CONFIG_HOME).toBe(configPresent ? root : null);
      expect(call.env.EMEND_HOME).toBe(root);
    }
    expect(calls.map((call) => call.database)).toEqual(["new database", "new database", "old database"]);
    expect(await readFile(database, "utf8")).toBe("old database");
    await expect(readFile(`${database}-wal`)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(readFile(`${database}-shm`)).rejects.toMatchObject({ code: "ENOENT" });
  },
);
