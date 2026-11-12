import { chmod, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
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
  "VOLTA_HOME",
  "NVM_DIR",
  "NODE_EXTRA_CA_CERTS",
  "SSL_CERT_FILE",
  "SSL_CERT_DIR",
  "TMPDIR",
  "XDG_DATA_HOME",
  "XDG_CONFIG_HOME",
  "XDG_CACHE_HOME",
  "XDG_STATE_HOME",
  "XDG_RUNTIME_DIR",
  "XDG_CUSTOM",
];
const defaults = {
  home: "/home/user",
  stateDir: "/state",
  database: "/state/emend.db",
  backupPath: "/state/backup.db",
  backupTime: "2026-11-12T10:20:30.123Z",
  oldVersion: "0.1.0",
  oldEntry: "/old/emend.mjs",
  node: "/runtime/node",
  helper: "/tools/npm",
  install: { kind: "npm", prefix: "/prefix" } as const,
  hasService: false,
  platform: "linux",
  uid: 1000,
  env: { PATH: "/tools", HOME: "/home/user" },
};
const pins = "/usr/bin/env -i PATH='/tools' HOME='/home/user'";
function parts(block: string) {
  return block.split("emend: only if").map((part) => part.split("\n").filter((line) => line.startsWith("  ")));
}

test.each(["npm", "pnpm", "mise"] as const)(
  "%s go-back prints two independent lists for every service and platform",
  (kind) => {
    for (const hasService of [false, true])
      for (const platform of ["linux", "darwin"]) {
        const block = goBack({
          ...defaults,
          helper: `/tools/${kind}`,
          install: kind === "npm" ? { kind, prefix: "/prefix" } : { kind },
          hasService,
          platform,
        });
        const [packagePart, databasePart] = parts(block);
        const emend = `${pins} EMEND_HOME='/state' '/runtime/node' '/old/emend.mjs'`;
        const launchctl = `${pins} '/bin/launchctl'`;
        const stop = hasService
          ? platform === "linux"
            ? `${pins} systemctl --user stop emend`
            : `( ${launchctl} bootout gui/1000/dev.emend.server; n=0; while ${launchctl} print gui/1000/dev.emend.server >/dev/null 2>&1 && [ "$n" -lt 50 ]; do n=$((n+1)); ${pins} /bin/sleep 0.2; done; ${launchctl} print gui/1000/dev.emend.server >/dev/null 2>&1; [ "$?" -eq 113 ] )`
          : `${emend} stop`;
        const args = {
          npm: "install --global --prefix '/prefix' --ignore-scripts @shllg/emend@0.1.0",
          pnpm: "add --global --ignore-scripts --ignore-pnpmfile @shllg/emend@0.1.0",
          mise: "use --global npm:@shllg/emend@0.1.0",
        }[kind];
        const restore = `${pins} npm_config_ignore_scripts=true '/tools/${kind}' ${args}`;
        const start = `  ${emend}${hasService ? " service install" : ""}`;
        expect(packagePart).toEqual([
          "  cd '/home/user' &&",
          `  ${hasService ? stop : restore} &&`,
          `  ${hasService ? restore : stop} &&`,
          start,
        ]);
        expect(databasePart).toEqual([
          "  cd '/home/user' &&",
          `  ${stop} &&`,
          `  ${pins} /bin/cp '/state/backup.db' '/state/emend.db' && ${pins} /bin/rm -f '/state/emend.db-wal' '/state/emend.db-shm' &&`,
          start,
        ]);
        expect(block).toContain('only if emend 0.1.0 then says "The emend database is newer than this emend"');
        expect(block).toContain(defaults.backupTime);
        expect(block).toContain("Everything since then is lost, including devices");
        expect(block).toContain("tokens revoked since then: revoke them again afterwards");
      }
  },
);

test("without a backup the package recovery still prints", () => {
  const block = goBack({ ...defaults, backupPath: undefined });
  expect(parts(block)).toHaveLength(1);
  expect(parts(block)[0]).toHaveLength(4);
  expect(block).not.toContain("/bin/cp");
});

test.each([...directoryNames, "DBUS_SESSION_BUS_ADDRESS", "XDG_$(printf injected)"])(
  "go-back pins present %s and omits absent names",
  (name) => {
    const value = "/safe/quote's $folder";
    const block = goBack({
      ...defaults,
      env: {
        ...defaults.env,
        [name]: value,
        HTTPS_PROXY: "https://proxy.example.test",
        USER: "private-identity",
        LOGNAME: "private-identity",
        SHELL: "/bin/sh",
        LANG: "C",
        TERM: "xterm",
      },
    });
    const printedName = name === "XDG_$(printf injected)" ? "'XDG_$(printf injected)'" : name;
    for (const part of parts(block))
      for (const line of part.slice(1)) expect(line).toContain(`${printedName}=${quoteShellArgument(value)}`);
    for (const absent of directoryNames.filter((candidate) => candidate !== name))
      expect(block).not.toContain(`${absent}=`);
    expect(block).toContain(`HTTPS_PROXY="\${HTTPS_PROXY-}"`);
    expect(block.includes("proxy.example")).toBe(false);
    expect(block).not.toMatch(/-u |USER=|LOGNAME=|SHELL=|LANG=|TERM=|private-identity/);
  },
);

test.each([false, true])(
  "pasted parts isolate every program and restore the database only on request (pins: %s)",
  async (present) => {
    const root = await mkdtemp(join(process.env.EMEND_HOME as string, "rollback-"));
    const safe = join(root, "safe");
    const hostile = join(root, "hostile");
    await mkdir(safe);
    await mkdir(hostile);
    const database = join(root, "emend.db"),
      backupPath = join(root, "backup.db"),
      log = join(root, "log");
    const helper = join(safe, "helper"),
      node = join(safe, "node"),
      oldEntry = join(root, "old-entry");
    const script = `#!${process.execPath}
const fs = require("node:fs");
const argv = process.argv.slice(2);
const env = { ...process.env };
// Record only presence and equality, never proxy values, even on a failing assertion.
const proxyMatches = env.HTTPS_PROXY === "https://proxy.example.test";
delete env.HTTPS_PROXY;
fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify({ argv, env, proxyMatches, database: fs.readFileSync(${JSON.stringify(database)}, "utf8") }) + "\\n");
`;
    await writeFile(helper, `${script}fs.writeFileSync(${JSON.stringify(oldEntry)}, "restored");`);
    await writeFile(node, `${script}if (!fs.existsSync(${JSON.stringify(oldEntry)})) process.exit(1);`);
    await writeFile(join(hostile, "node"), "#!/bin/sh\nexit 99\n", { mode: 0o755 });
    await Promise.all([helper, node].map((file) => chmod(file, 0o755)));
    await writeFile(database, "new database");
    await writeFile(backupPath, "old database");
    await writeFile(`${database}-wal`, "wal");
    await writeFile(`${database}-shm`, "shm");
    const pinned = {
      PATH: safe,
      HOME: root,
      ...(present
        ? Object.fromEntries(
            [...directoryNames, "DBUS_SESSION_BUS_ADDRESS", "XDG_$(printf injected)"].map((name) => [name, root]),
          )
        : {}),
    };
    const block = goBack({
      ...defaults,
      home: root,
      stateDir: root,
      database,
      backupPath,
      oldEntry,
      node,
      helper,
      env: { ...pinned, HTTPS_PROXY: "https://never-print.example.test", USER: "identity" },
    });
    expect(block.includes("never-print.example")).toBe(false);
    const commands = parts(block);
    for (const index of [0, 1]) {
      const result = await runChild("/bin/sh", ["-c", (commands[index] ?? []).join("\n")], {
        cwd: root,
        env: {
          PATH: hostile,
          HOME: hostile,
          NODE_OPTIONS: "--require /hostile",
          npm_config_registry: "https://hostile.invalid",
          MISE_ENV: "hostile",
          COREPACK_HOME: hostile,
          HTTPS_PROXY: "https://proxy.example.test",
          ...Object.fromEntries(directoryNames.map((name) => [name, hostile])),
        },
        timeoutMs: 3000,
        output: "capture",
      });
      expect(result.code).toBe(0);
      expect(await readFile(database, "utf8")).toBe(index === 0 ? "new database" : "old database");
      if (index === 0) {
        expect(await readFile(`${database}-wal`, "utf8")).toBe("wal");
        expect(await readFile(`${database}-shm`, "utf8")).toBe("shm");
      }
    }
    const calls = (await readFile(log, "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    expect(calls.map((call) => call.argv)).toEqual([
      ["install", "--global", "--prefix", "/prefix", "--ignore-scripts", "@shllg/emend@0.1.0"],
      [oldEntry, "stop"],
      [oldEntry],
      [oldEntry, "stop"],
      [oldEntry],
    ]);
    expect(calls[0].env).toEqual({ ...pinned, npm_config_ignore_scripts: "true" });
    expect(calls[0].proxyMatches).toBe(true);
    for (const call of calls.slice(1)) {
      expect(call.env).toEqual({ ...pinned, EMEND_HOME: root });
      expect(call.proxyMatches).toBe(false);
    }
    expect(calls.map((call) => call.database)).toEqual([
      "new database",
      "new database",
      "new database",
      "new database",
      "old database",
    ]);
    await expect(readFile(`${database}-wal`)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(readFile(`${database}-shm`)).rejects.toMatchObject({ code: "ENOENT" });
  },
);

test.each([0, 127, 1, 113])(
  "macOS stop fails closed except after launchctl reports 113 (final status %s)",
  async (status) => {
    const root = await mkdtemp(join(process.env.EMEND_HOME as string, "launchctl-"));
    const launchctl = join(root, "launchctl"),
      count = join(root, "count");
    await writeFile(
      launchctl,
      `#!/bin/sh
[ "$1" = bootout ] && exit 1
n=0
[ ! -f ${quoteShellArgument(count)} ] || read -r n < ${quoteShellArgument(count)}
printf '%s\\n' "$((n+1))" > ${quoteShellArgument(count)}
[ ${status} -ne 113 ] || [ "$n" -ne 0 ] || exit 0
exit ${status}
`,
      { mode: 0o755 },
    );
    const block = goBack({ ...defaults, platform: "darwin", hasService: true, launchctl });
    const stop = parts(block)[0]?.[1]?.trim().replace(/ &&$/, "");
    expect(stop).toBeDefined();
    const result = await runChild(
      "/bin/sh",
      ["-c", `n=untouched; ${stop}; result=$?; [ "$n" = untouched ] || exit 99; exit "$result"`],
      { cwd: root, env: { PATH: root, NODE_OPTIONS: "--require /hostile" }, timeoutMs: 14000, output: "capture" },
    );
    expect(result.timedOut).toBe(false);
    expect(result.code).toBe(status === 113 ? 0 : 1);
    expect(Number(await readFile(count, "utf8"))).toBe(status === 0 ? 52 : status === 113 ? 3 : 2);
  },
  15000,
);

test.each(["HTTP_PROXY", "HTTPS_PROXY", "NO_PROXY", "ALL_PROXY", "http_proxy", "https_proxy", "no_proxy", "all_proxy"])(
  "restore references only the retained %s without printing its value",
  (name) => {
    const block = goBack({ ...defaults, env: { ...defaults.env, [name]: "never-print-this-proxy-value" } });
    const reference = `${name}="\${${name}-}"`;
    const [packagePart, databasePart] = parts(block);
    expect(packagePart?.filter((line) => line.includes(reference))).toHaveLength(1);
    expect(databasePart?.some((line) => line.includes(reference))).toBe(false);
    expect(block.includes("never-print-this-proxy-value")).toBe(false);
    expect(goBack(defaults)).not.toContain(reference);
  },
);
