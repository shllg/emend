import { mkdir, readdir, realpath, rm, stat, writeFile } from "node:fs/promises";
import { delimiter, join, sep } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { beforeEach, describe, expect, test, vi } from "vitest";
import { run } from "../../main.ts";
import { VERSION } from "../../version.ts";
import {
  attachHub,
  emendScript,
  type Fake,
  installService,
  type Layout,
  makeDatabase,
  makeFake,
} from "../update/test-support.ts";

let fixtureRoot = "";
// Like the tailscale tests: a lookup with a PATH outside the test's own folder never reaches the live PATH.
vi.mock("../executable.ts", async (original) => {
  const actual = await original<typeof import("../executable.ts")>();
  return {
    async findExecutable(...args: Parameters<typeof actual.findExecutable>) {
      const entries = (args[1] ?? "").split(delimiter).filter(Boolean);
      if (!fixtureRoot || entries.length === 0 || entries.some((entry) => !entry.startsWith(`${fixtureRoot}${sep}`)))
        throw new Error("executable lookup outside the test fixtures");
      return actual.findExecutable(...args);
    },
  };
});

let fake: Fake;
async function make(layout: Layout) {
  fake = await makeFake(process.env.EMEND_HOME as string, layout);
  fixtureRoot = fake.root;
  return fake;
}
const out = () => fake.stdout.join("");
const err = () => fake.stderr.join("");
const update = (...args: string[]) => run(["update", ...args], fake.io);

beforeEach(() => {
  fixtureRoot = "";
});

describe("refusals change nothing", () => {
  beforeEach(async () => {
    await make("npm");
    await makeDatabase(join(fake.state, "emend.db"));
  });
  const untouched = async () => {
    expect(await fake.calls()).toEqual([]);
    expect(await readdir(fake.state)).not.toContain("backups");
  };

  test("a call with arguments is a usage error", async () => {
    expect(await update("now")).toBe(2);
    expect(err()).toBe("emend: Usage: emend update.\n");
    await untouched();
  });

  test("a call without a terminal refuses", async () => {
    fake.options.terminal = false;
    expect(await update()).toBe(1);
    expect(err()).toBe("emend: emend update runs only in your own terminal; nothing was changed.\n");
    expect(out()).toBe("");
    await untouched();
  });

  test("root refuses", async () => {
    fake.options.uid = 0;
    expect(await update()).toBe(1);
    expect(err()).toBe("emend: run emend update as the user who runs emend, not as root.\n");
    await untouched();
  });

  test("an unsupported platform refuses and names the update page", async () => {
    fake.options.platform = "win32";
    expect(await update()).toBe(1);
    expect(err()).toContain("https://github.com/shllg/emend/blob/release/docs/setup/update.md");
    await untouched();
  });

  test("a relative home folder refuses", async () => {
    fake.options.home = "relative/home";
    expect(await update()).toBe(1);
    expect(err()).toBe("emend: could not use the home folder; nothing was changed.\n");
    await untouched();
  });

  test("a missing package manager refuses before the backup", async () => {
    fake.io.env.PATH = join(fake.root, "empty");
    await mkdir(join(fake.root, "empty"));
    expect(await update()).toBe(1);
    expect(err()).toBe("emend: npm was not found on PATH; nothing was changed.\n");
    await untouched();
  });

  test("an unknown layout exits 1 and changes nothing", async () => {
    const entry = join(fake.root, "elsewhere/dist/emend.mjs");
    await mkdir(join(fake.root, "elsewhere/dist"), { recursive: true });
    await writeFile(entry, "");
    fake.options.entry = entry;
    expect(await update()).toBe(1);
    expect(err()).toBe(
      "emend: could not tell how emend was installed; update it as https://github.com/shllg/emend/blob/release/docs/setup/update.md says. Nothing was changed.\n",
    );
    await untouched();
  });
});

describe("a local build", () => {
  beforeEach(async () => {
    await make("npm");
    await makeDatabase(join(fake.state, "emend.db"));
  });

  test("a checkout prints the commands and runs nothing", async () => {
    const checkout = join(fake.root, "check out");
    await mkdir(join(checkout, ".git"), { recursive: true });
    await mkdir(join(checkout, "apps/emend/dist"), { recursive: true });
    fake.options.entry = join(checkout, "apps/emend/dist/emend.mjs");
    await writeFile(fake.options.entry, "");
    expect(await update()).toBe(0);
    expect(out()).toBe(`emend: this emend is a local build (the checkout at ${checkout}); emend update changes nothing.
emend: to update it, review the new commits, then run in your emend checkout:
  cd '${checkout}'
  git pull
  pnpm install
  pnpm install:local
`);
    expect(await fake.calls()).toEqual([]);
    expect(await readdir(fake.state)).not.toContain("backups");
  });

  test("a mise link prints the commands without a checkout folder", async () => {
    const dir = join(fake.root, "mise/linked-installs/npm-shllg-emend/dev/dist");
    await mkdir(dir, { recursive: true });
    fake.options.entry = join(dir, "emend.mjs");
    await writeFile(fake.options.entry, "");
    expect(await update()).toBe(0);
    expect(out()).toContain("this emend is a local build (linked into mise)");
    expect(out()).not.toContain("cd ");
    expect(out()).toContain("  pnpm install:local\n");
    expect(await fake.calls()).toEqual([]);
    expect(await readdir(fake.state)).not.toContain("backups");
  });
});

describe.each([
  [
    "npm",
    (f: Fake) => [`install`, `--global`, `--prefix`, join(f.root, "prefix"), `--ignore-scripts`, `@shllg/emend@latest`],
  ],
  ["pnpm", () => ["add", "--global", "--ignore-scripts", "@shllg/emend@latest"]],
  ["mise", () => ["upgrade", "--bump", "npm:@shllg/emend"]],
] as const)("%s install", (layout, expected) => {
  beforeEach(async () => {
    await make(layout);
    await makeDatabase(join(fake.state, "emend.db"));
  });

  test("runs the update from the home folder even inside a repository, then checks the new emend", async () => {
    const repo = join(fake.root, "repo");
    await mkdir(join(repo, ".git/objects"), { recursive: true });
    await mkdir(join(repo, ".git/refs"), { recursive: true });
    await writeFile(join(repo, ".git/HEAD"), "ref: refs/heads/main\n");
    fake.options.cwd = repo;
    expect(await update()).toBe(0);
    const calls = await fake.calls();
    const updateCall = calls[0] as { tool: string; argv: string[]; cwd: string };
    expect(updateCall.tool).toBe(layout);
    expect(updateCall.argv).toEqual(expected(fake));
    for (const call of calls) expect(await realpath((call as { cwd: string }).cwd)).toBe(fake.home);
    expect(out()).toContain("emend: emend is now 0.2.0\n");
    expect(out()).toContain("emend: this machine runs emend 0.2.0\n");
    expect(out()).toContain(`emend: running ${layout} `);
    expect(err()).toBe("");
  });

  test("passes only the allowlisted environment to every child", async () => {
    expect(await update()).toBe(0);
    for (const call of (await fake.calls()) as { env: string[]; values: Record<string, string> }[]) {
      expect(call.env).not.toContain("NODE_OPTIONS");
      expect(call.env).not.toContain("NODE_PATH");
      expect(call.env.filter((name) => /^npm_config_/i.test(name))).toEqual([]);
      expect(call.env).not.toContain("MISE_SOMETHING");
      expect(call.env).not.toContain("XDG_RUNTIME_DIR");
      expect(call.env).toEqual(expect.arrayContaining(["EMEND_HOME", "HOME", "PATH", "USER", "LC_ALL"]));
    }
    const first = (await fake.calls())[0] as { values: Record<string, string> };
    expect(first.values).toEqual({ PATH: fake.bin, HOME: fake.home, EMEND_HOME: fake.state });
  });

  test("a failing package manager exits 1, keeps the backup and prints how to go back", async () => {
    await fake.set({ updateFails: true });
    expect(await update()).toBe(1);
    const backups = await readdir(join(fake.state, "backups"));
    expect(backups).toEqual(["emend-0.1.0-20261112T102030123Z.db"]);
    const backup = join(fake.state, "backups", backups[0] as string);
    expect(err()).toContain("failed with exit 3.");
    expect(err()).toContain(`emend: to go back to emend ${VERSION} with the database from before this update, run:`);
    expect(err()).toContain(`  cp '${backup}' '${join(fake.state, "emend.db")}' && rm -f `);
    expect(err()).toContain("  emend stop\n");
    expect(err()).toContain("  emend\n");
    const old = {
      npm: `npm install --global --prefix '${join(fake.root, "prefix")}' @shllg/emend@${VERSION}`,
      pnpm: `pnpm add --global @shllg/emend@${VERSION}`,
      mise: `mise use --global npm:@shllg/emend@${VERSION}`,
    }[layout];
    expect(err()).toContain(`  ${old}\n`);
    expect(out()).not.toContain("emend is now");
  });

  test("a wrong version answer fails", async () => {
    await fake.set({ badVersion: true });
    expect(await update()).toBe(1);
    expect(err()).toContain("emend: the new emend does not answer with its version.\n");
    expect(err()).toContain("to go back to emend");
  });

  test("reports an emend that is already the newest", async () => {
    await fake.set({
      newVersion: VERSION,
      newScript: emendScript(VERSION, fake.root),
    });
    expect(await update()).toBe(0);
    expect(out()).toContain(`emend: emend ${VERSION} is already the newest release\n`);
  });
});

describe("the database backup", () => {
  beforeEach(async () => {
    await make("npm");
  });

  test("without a database it says so and continues", async () => {
    expect(await update()).toBe(0);
    expect(out()).toContain("emend: no database to back up yet.\n");
    expect(out()).not.toContain("to go back");
    expect(await readdir(fake.state)).not.toContain("backups");
  });

  test("holds the data, is private, and keeps only the 3 newest", async () => {
    await makeDatabase(join(fake.state, "emend.db"), "kept row");
    const folder = join(fake.state, "backups");
    await mkdir(folder, { mode: 0o700 });
    const old = [
      "emend-0.0.1-20260101T000000000Z.db",
      "emend-0.0.2-20260102T000000000Z.db",
      "emend-0.0.3-20260103T000000000Z.db",
    ];
    for (const name of [...old, "notes.txt", "emend-0.0.4-20260104T000000000Z.db.partial"])
      await writeFile(join(folder, name), "x");
    expect(await update()).toBe(0);
    expect((await readdir(folder)).sort()).toEqual([
      "emend-0.0.2-20260102T000000000Z.db",
      "emend-0.0.3-20260103T000000000Z.db",
      "emend-0.0.4-20260104T000000000Z.db.partial",
      "emend-0.1.0-20261112T102030123Z.db",
      "notes.txt",
    ]);
    const backup = join(folder, "emend-0.1.0-20261112T102030123Z.db");
    expect((await stat(backup)).mode & 0o777).toBe(0o600);
    expect((await stat(folder)).mode & 0o777).toBe(0o700);
    const copy = new DatabaseSync(backup, { readOnly: true });
    expect(copy.prepare("SELECT value FROM sample").all()).toEqual([{ value: "kept row" }]);
    copy.close();
    expect(out()).toContain(`emend: backed up the database to ${backup}\n`);
    expect(out()).toContain("emend: to go back to emend");
  });
});

describe("the service", () => {
  beforeEach(async () => {
    await make("npm");
    await makeDatabase(join(fake.state, "emend.db"));
  });

  test("is reinstalled with the new entry when the unit file exists", async () => {
    await installService(fake);
    expect(await update()).toBe(0);
    const calls = await fake.calls();
    const reinstall = calls.find((call) => call.tool === "service-install") as { entry: string; cwd: string };
    expect(reinstall.entry).toBe(join(fake.oldPackage, "dist/emend.mjs"));
    expect(await realpath(reinstall.cwd)).toBe(fake.home);
    expect(out()).toContain("emend: the emend service runs emend 0.2.0\n");
    expect(out()).toContain("  systemctl --user stop emend\n");
    expect(out()).toContain("  emend service install\n");
  });

  test("a macOS go-back block boots the agent out", async () => {
    fake.options.platform = "darwin";
    const plist = join(fake.home, "Library/LaunchAgents/dev.emend.server.plist");
    await mkdir(join(fake.home, "Library/LaunchAgents"), { recursive: true });
    await writeFile(plist, "x");
    expect(await update()).toBe(0);
    expect(out()).toContain("  launchctl bootout gui/1000/dev.emend.server\n");
  });

  test("is not touched without a unit file", async () => {
    expect(await update()).toBe(0);
    expect((await fake.calls()).some((call) => call.tool === "service-install")).toBe(false);
  });

  test("a service that runs another version afterwards fails", async () => {
    await installService(fake);
    await fake.set({ serverVersion: "0.1.0" });
    expect(await update()).toBe(1);
    expect(err()).toContain("emend: the emend service does not run emend 0.2.0 yet; run emend service status.\n");
    expect(err()).toContain("to go back to emend");
  });

  test("a failing service install fails", async () => {
    await installService(fake);
    await fake.set({ serviceFails: true });
    expect(await update()).toBe(1);
    expect(err()).toContain("does not run emend 0.2.0 yet");
  });

  test("a server that runs the newest version already is left alone", async () => {
    await installService(fake);
    await fake.set({
      newVersion: VERSION,
      newScript: emendScript(VERSION, fake.root),
    });
    await writeFile(join(fake.root, "server-version"), VERSION);
    expect(await update()).toBe(0);
    expect(out()).toContain(`emend: the emend service already runs emend ${VERSION}\n`);
    expect((await fake.calls()).some((call) => call.tool === "service-install")).toBe(false);
  });

  test("without a service, an old running server gets a hint", async () => {
    await writeFile(join(fake.root, "server-version"), "0.1.0");
    expect(await update()).toBe(0);
    expect(out()).toContain(
      "emend: the emend server at http://127.0.0.1:3636 still runs emend 0.1.0. Run emend stop, then emend, to start emend 0.2.0.\n",
    );
  });
});

describe("the hub report", () => {
  beforeEach(async () => {
    await make("npm");
    await attachHub(fake.state);
  });
  test.each([
    ["0.1.0", "The hub is behind this machine; run emend update on the hub."],
    ["0.3.0", "This machine is behind the hub."],
    ["0.2.0", "Both run the same version."],
    ["0.3.0-rc.1", "Update both to the same version."],
  ])("a hub at %s", async (hub, advice) => {
    fake.options.hubVersion = async () => hub;
    expect(await update()).toBe(0);
    expect(out()).toContain(`emend: the hub at https://hub.example.test runs emend ${hub}. ${advice}\n`);
  });

  test("an unreachable hub is not a failure", async () => {
    fake.options.hubVersion = async () => {
      throw new Error("down");
    };
    expect(await update()).toBe(0);
    expect(out()).toContain("emend: could not reach the hub at https://hub.example.test to check its version.\n");
  });

  test("a machine without an attachment prints no hub line", async () => {
    await rm(join(fake.state, "attach.json"));
    expect(await update()).toBe(0);
    expect(out()).not.toContain("the hub at");
  });
});
