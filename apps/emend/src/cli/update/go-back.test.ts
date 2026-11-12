import { expect, test } from "vitest";
import { quoteShellArgument } from "../escape.ts";
import { goBack } from "./go-back.ts";

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

test.each(["npm", "pnpm", "mise"] as const)("%s go-back is one pinned shell list before and after locate", (kind) => {
  for (const hasService of [false, true])
    for (const platform of ["linux", "darwin"])
      for (const known of [false, true]) {
        const block = goBack({
          home: "/home/user",
          stateDir: "/state",
          database: "/state/emend.db",
          backupPath: "/state/backup.db",
          oldVersion: "0.1.0",
          oldEntry: "/old/emend.mjs",
          newEntry: known ? "/new/emend.mjs" : undefined,
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
        expect(commands[1]).toBe(
          hasService
            ? `  ${platform === "linux" ? "systemctl --user stop emend" : "launchctl bootout gui/1000/dev.emend.server"} &&`
            : `  EMEND_HOME='/state' '/runtime/node' '${known ? "/new" : "/old"}/emend.mjs' stop &&`,
        );
        const args = {
          npm: "install --global --prefix '/prefix' --ignore-scripts @shllg/emend@0.1.0",
          pnpm: "add --global --ignore-scripts --ignore-pnpmfile @shllg/emend@0.1.0",
          mise: "use --global npm:@shllg/emend@0.1.0",
        }[kind];
        expect(commands[2]).toBe(`  npm_config_ignore_scripts=true '/tools/${kind}' ${args} &&`);
        expect(commands[3]).toBe(
          "  cp '/state/backup.db' '/state/emend.db' && rm -f '/state/emend.db-wal' '/state/emend.db-shm' &&",
        );
        expect(commands[4]).toBe(
          `  EMEND_HOME='/state' '/runtime/node' '/old/emend.mjs'${hasService ? " service install" : ""}`,
        );
      }
});

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
  for (const absent of directoryNames.filter((candidate) => candidate !== name))
    expect(block).not.toContain(`${absent}=`);
  expect(block).not.toMatch(/PROXY|proxy.example|USER|private-identity|XDG_RUNTIME_DIR/);
  const emendPins = `EMEND_HOME=${quoteShellArgument(value)}${name === "XDG_CONFIG_HOME" ? ` XDG_CONFIG_HOME=${quoteShellArgument(value)}` : ""}`;
  expect(block).toContain(
    `${emendPins} ${quoteShellArgument(`${value}/node`)} ${quoteShellArgument(`${value}/emend.mjs`)} stop &&`,
  );
});
