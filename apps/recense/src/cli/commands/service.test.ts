import { createHash } from "node:crypto";
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  realpath,
  stat,
  symlink,
  unlink,
  utimes,
  writeFile,
} from "node:fs/promises";
import { dirname, join, relative, sep } from "node:path";
import { LIMITS } from "@recense/contract";
import { beforeEach, describe, expect, test, vi } from "vitest";
import { type Io, run } from "../../main.ts";
import { startServer } from "../../server/serve.ts";
import * as stateFiles from "../../state/files.ts";
import * as credentials from "../../state/token-file.ts";
import { VERSION } from "../../version.ts";
import { CliError } from "../http.ts";
import type { ServiceOptions, ServiceResult, ServiceRunner } from "../service/common.ts";
import { writeService } from "../service/common.ts";
import { waitForServer as waitForManagedServer } from "../service/takeover.ts";
import { provenTestServer } from "../test-support.ts";
import { serviceCommand } from "./service.ts";

vi.mock("../service/common.ts", async (original) => {
  const actual = await original<typeof import("../service/common.ts")>();
  return { ...actual, writeService: vi.fn(actual.writeService) };
});
vi.mock("node:fs/promises", async (original) => {
  const actual = await original<typeof import("node:fs/promises")>();
  return { ...actual, lstat: vi.fn(actual.lstat), unlink: vi.fn(actual.unlink) };
});
vi.mock("../../state/files.ts", async (original) => ({ ...(await original<typeof import("../../state/files.ts")>()) }));

const ok: ServiceResult = { code: 0, stdout: "", stderr: "" };
const failed: ServiceResult = { code: 1, stdout: "", stderr: "first failure\nmore detail\n" };
const unsupported =
  "recense: recense service supports systemd on Linux and launchd on macOS; run recense serve yourself.\n";
const linger = "To keep recense running after you log out, run sudo loginctl enable-linger $USER.\n";
const publicUrl = "https://public.example.test";
const installedOutput = (url = "http://127.0.0.1:3636", host?: string) => [
  "recense: service installed\n",
  `recense: the service starts at login and serves ${url}\n`,
  ...(host ? [`recense: the service listens on ${host}, so other machines can reach it\n`] : []),
  "To sign a browser in, run recense in your own terminal.\n",
];

let root: string;
let home: string;
let state: string;
let bin: string;
let stdout: string[];
let stderr: string[];
let options: ServiceOptions;
let io: Io;
let recorded: ReturnType<typeof vi.fn<ServiceRunner>>;
let callLog: string[][];
let stopLocalServer: ReturnType<typeof vi.fn<NonNullable<ServiceOptions["stopLocalServer"]>>>;
let waitForServer: ReturnType<typeof vi.fn<NonNullable<ServiceOptions["waitForServer"]>>>;
let elapsed: number;
let sleep: ReturnType<typeof vi.fn<(ms: number) => Promise<void>>>;

async function gitDirectory(directory: string) {
  const git = join(directory, ".git");
  await mkdir(join(git, "objects"), { recursive: true });
  await mkdir(join(git, "refs"));
  await writeFile(join(git, "HEAD"), "ref: refs/heads/main\n");
}

beforeEach(async () => {
  root = await realpath(await mkdtemp(join(process.env.RECENSE_HOME as string, "service-")));
  const actual = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
  vi.mocked(unlink).mockImplementation(actual.unlink);
  // Only synthetic repositories belong to this fixture, including on hosts with a .git above it.
  vi.mocked(lstat).mockImplementation(async (...args) => {
    const entry = String(args[0]);
    if (entry.endsWith(`${sep}.git`) && !entry.startsWith(`${root}${sep}`))
      throw Object.assign(new Error("no synthetic repository entry"), { code: "ENOENT" });
    return actual.lstat(...args);
  });
  home = join(root, "home space%&");
  state = join(home, "state");
  bin = join(root, "bin");
  await mkdir(home);
  await mkdir(state, { mode: 0o700 });
  await mkdir(bin);
  for (const tool of ["systemctl", "loginctl", "launchctl"]) {
    // These are only resolved, never executed: every call goes to the recorded runner.
    await writeFile(join(bin, tool), "synthetic executable\n", { mode: 0o755 });
  }
  stdout = [];
  stderr = [];
  recorded = vi.fn(async (_file, args) => (args[0] === "print" ? failed : ok));
  callLog = [];
  stopLocalServer = vi.fn(async () => undefined);
  waitForServer = vi.fn<NonNullable<ServiceOptions["waitForServer"]>>(async (ready) => ({
    url: "http://127.0.0.1:3636",
    pid: 12345,
    ...(ready.publicOrigin ? { publicUrl } : {}),
  }));
  elapsed = 0;
  sleep = vi.fn(async (ms) => {
    elapsed += ms;
  });
  const cwd = join(root, "cwd");
  await mkdir(cwd);
  await gitDirectory(cwd);
  await writeFile(join(home, "node"), "synthetic node");
  await writeFile(join(home, "recense.mjs"), "synthetic entry");
  options = {
    platform: "linux",
    home,
    node: join(home, "node"),
    entry: join(home, "recense.mjs"),
    username: "synthetic-user",
    uid: 501,
    runner: async (file, args, context) => {
      callLog.push([file, ...args]);
      return recorded(file, args, context);
    },
    stopLocalServer: async () => {
      callLog.push(["stopLocalServer"]);
      return stopLocalServer();
    },
    waitForServer: async (ready) => {
      callLog.push(["waitForServer"]);
      return waitForServer(ready);
    },
    cwd,
    now: () => elapsed,
    sleep,
  };
  io = {
    stdout: (s) => stdout.push(s),
    stderr: (s) => stderr.push(s),
    env: { HOME: home, RECENSE_HOME: state, PATH: bin },
    service: options,
  };
});

function unitPath() {
  return join(home, ".config/systemd/user/recense.service");
}
function plistPath() {
  return join(home, "Library/LaunchAgents/dev.recense.server.plist");
}
function pendingPath() {
  return join(state, "service.pending");
}
function optionsPath() {
  return join(state, "service.json");
}
async function put(path: string, content: string) {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, content);
}
function calls() {
  return callLog;
}
function systemctl(...args: string[]) {
  return [join(bin, "systemctl"), "--user", ...args];
}
function loginctl() {
  return [join(bin, "loginctl"), "show-user", "synthetic-user", "--property=Linger", "--value"];
}
function launchctl(...args: string[]) {
  return [join(bin, "launchctl"), ...args];
}
function resetOutput() {
  recorded.mockClear();
  stopLocalServer.mockClear();
  waitForServer.mockClear();
  callLog.length = 0;
  stdout.length = 0;
  stderr.length = 0;
}
async function invoke(...args: string[]) {
  return run(["service", ...args], io);
}

test.each(["linux", "darwin"])(
  "%s service install refuses a loose admin token before changing files",
  async (platform) => {
    options.platform = platform;
    delete options.stopLocalServer;
    const path = join(state, "admin.token");
    stateFiles.writeSecretFile(path, `em_${"a".repeat(43)}`);
    const proof = provenTestServer(state);
    await chmod(path, 0o644);
    const before = await readdir(state);
    const fetcher = vi.fn(async (url: string | URL, init?: RequestInit) => {
      const response = proof(url, init);
      return response
        ? Response.json({ api: 1, version: "0.1.0", features: ["server-stop"] }, { headers: response.headers })
        : Response.json({});
    });
    vi.stubGlobal("fetch", fetcher);
    try {
      expect(await invoke("install")).toBe(1);
      expect(stderr).toEqual([`Token file ${path} has group or other permissions; fix it with chmod 600 '${path}'\n`]);
      expect(stdout).toEqual([]);
      expect(calls()).toEqual([]);
      expect(fetcher.mock.calls.every(([, init]) => !new Headers(init?.headers).has("Authorization"))).toBe(true);
      expect(await readdir(state)).toEqual(before);
      expect((await stat(path)).mode & 0o777).toBe(0o644);
      await expect(lstat(platform === "linux" ? unitPath() : plistPath())).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      vi.unstubAllGlobals();
    }
  },
);

test("Linux writes the exact unit with port 4000, spaces, percent, and the resolved state directory", async () => {
  expect(await invoke("install", "--port", "4000")).toBe(0);
  const escapedHome = home.replaceAll("%", "%%");
  expect(await readFile(unitPath(), "utf8")).toBe(`# written by recense
[Unit]
Description=recense review server

[Service]
Type=exec
ExecStart="${escapedHome}/node" "${escapedHome}/recense.mjs" serve --port 4000
Environment="RECENSE_HOME=${escapedHome}/state"
Restart=on-failure

[Install]
WantedBy=default.target
`);
  expect(calls()).toEqual([
    systemctl("daemon-reload"),
    systemctl("enable", "recense"),
    systemctl("stop", "recense"),
    ["stopLocalServer"],
    systemctl("start", "recense"),
    ["waitForServer"],
    loginctl(),
  ]);
  expect(stderr).toEqual([]);
});

test.each(["deleted unit", "failed uninstall"])(
  "Linux replaces a running public-host service after a %s",
  async (cause) => {
    let running = "";
    recorded.mockImplementation(async (_file, args) => {
      if (args.includes("disable")) return failed;
      if (args.includes("stop")) running = "";
      if (args.includes("start") && !running) running = await readFile(unitPath(), "utf8");
      return ok;
    });
    expect(await invoke("install", "--host", "0.0.0.0")).toBe(0);
    expect(running).toContain("--host 0.0.0.0");
    if (cause === "deleted unit") await unlink(unitPath());
    else {
      expect(await invoke("uninstall")).toBe(0);
      expect(stderr).toHaveLength(1);
    }
    await expect(lstat(unitPath())).rejects.toMatchObject({ code: "ENOENT" });
    expect(running).toContain("--host 0.0.0.0");
    resetOutput();
    expect(await invoke("install")).toBe(0);
    expect(calls()).toEqual([
      systemctl("daemon-reload"),
      systemctl("enable", "recense"),
      systemctl("stop", "recense"),
      ["stopLocalServer"],
      systemctl("start", "recense"),
      ["waitForServer"],
      loginctl(),
    ]);
    expect(running).toBe(await readFile(unitPath(), "utf8"));
    expect(running).not.toContain("--host");
    expect(stdout).toEqual(installedOutput());
  },
);

test("Linux reloads an unchanged unit with no pending record after an interrupted uninstall", async () => {
  let loaded = "";
  let running = "";
  recorded.mockImplementation(async (_file, args) => {
    if (args.includes("disable")) return failed;
    if (args.includes("daemon-reload")) loaded = await readFile(unitPath(), "utf8");
    if (args.includes("stop")) running = "";
    if (args.includes("start") && !running) running = loaded;
    return ok;
  });
  expect(await invoke("install", "--host", "0.0.0.0")).toBe(0);
  expect(running).toContain("--host 0.0.0.0");
  const writer = stateFiles.writeSecretFile;
  const spy = vi.spyOn(stateFiles, "writeSecretFile").mockImplementation((file, ...args) => {
    if (file === optionsPath()) throw new Error("synthetic interruption after unit rename");
    return writer(file, ...args);
  });
  try {
    expect(await invoke("install", "--port", "3636")).toBe(1);
  } finally {
    spy.mockRestore();
  }
  const content = await readFile(unitPath(), "utf8");
  expect(content).toContain("serve --port 3636");
  expect(content).not.toContain("--host");
  expect(loaded).toContain("--host 0.0.0.0");
  await expect(lstat(pendingPath())).resolves.toBeDefined();

  const actual = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
  vi.mocked(unlink).mockImplementation(async (file) => {
    if (file === unitPath()) throw new Error("synthetic interruption before unit removal");
    return actual.unlink(file);
  });
  resetOutput();
  try {
    expect(await invoke("uninstall")).toBe(1);
  } finally {
    vi.mocked(unlink).mockImplementation(actual.unlink);
  }
  expect(calls()).toEqual([systemctl("disable", "--now", "recense")]);
  await expect(lstat(optionsPath())).rejects.toMatchObject({ code: "ENOENT" });
  await expect(lstat(pendingPath())).rejects.toMatchObject({ code: "ENOENT" });
  expect(await readFile(unitPath(), "utf8")).toBe(content);
  expect(loaded).toContain("--host 0.0.0.0");

  resetOutput();
  vi.mocked(writeService).mockClear();
  expect(await invoke("install", "--port", "3636")).toBe(0);
  expect(writeService).not.toHaveBeenCalled();
  expect(calls()).toEqual([
    systemctl("daemon-reload"),
    systemctl("enable", "recense"),
    systemctl("stop", "recense"),
    ["stopLocalServer"],
    systemctl("start", "recense"),
    ["waitForServer"],
    loginctl(),
  ]);
  expect(loaded).toBe(content);
  expect(running).toBe(content);
  expect(stdout).toEqual(installedOutput());
  expect(stderr).toEqual([]);
  await expect(lstat(pendingPath())).rejects.toMatchObject({ code: "ENOENT" });
});

test("macOS writes the exact plist with port 4000 and XML-escaped paths", async () => {
  options.platform = "darwin";
  options.node = join(home, `node<>"'`);
  await writeFile(options.node, "synthetic node");
  expect(await invoke("install", "--port", "4000")).toBe(0);
  const xmlHome = home.replaceAll("&", "&amp;");
  expect(await readFile(plistPath(), "utf8")).toBe(`<?xml version="1.0" encoding="UTF-8"?>
<!-- written by recense -->
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>dev.recense.server</string>
  <key>ProgramArguments</key>
  <array>
    <string>${xmlHome}/node&lt;&gt;&quot;&apos;</string>
    <string>${xmlHome}/recense.mjs</string>
    <string>serve</string>
    <string>--port</string>
    <string>4000</string>
  </array>
  <key>EnvironmentVariables</key>
  <dict>
    <key>RECENSE_HOME</key>
    <string>${xmlHome}/state</string>
    <key>PATH</key>
    <string>/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin</string>
  </dict>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <dict>
    <key>SuccessfulExit</key>
    <false/>
  </dict>
  <key>StandardOutPath</key>
  <string>${xmlHome}/Library/Logs/recense.log</string>
  <key>StandardErrorPath</key>
  <string>${xmlHome}/Library/Logs/recense.log</string>
</dict>
</plist>
`);
  expect(calls()).toEqual([["stopLocalServer"], launchctl("bootstrap", "gui/501", plistPath()), ["waitForServer"]]);
  expect((await stat(join(home, "Library/Logs"))).isDirectory()).toBe(true);
  expect(stderr).toEqual([]);
});

test("a first macOS install stops the detached server without bootout", async () => {
  options.platform = "darwin";
  await expect(lstat(plistPath())).rejects.toMatchObject({ code: "ENOENT" });
  await expect(lstat(pendingPath())).rejects.toMatchObject({ code: "ENOENT" });
  stopLocalServer.mockResolvedValueOnce("http://127.0.0.1:3636");
  expect(await invoke("install")).toBe(0);
  expect(calls()).toEqual([["stopLocalServer"], launchctl("bootstrap", "gui/501", plistPath()), ["waitForServer"]]);
  expect(stdout).toEqual([
    "recense: stopped the recense server at http://127.0.0.1:3636, so the service can take over\n",
    ...installedOutput(),
  ]);
});

test("a failed systemd stop never signals a server or starts the service", async () => {
  recorded.mockImplementation(async (_file, args) => (args.includes("stop") ? failed : ok));
  expect(await invoke("install")).toBe(1);
  expect(calls()).toEqual([systemctl("daemon-reload"), systemctl("enable", "recense"), systemctl("stop", "recense")]);
  expect(stderr).toEqual(["recense: systemctl --user stop recense: first failure\n"]);
  expect(stdout).toEqual([]);
  expect(stopLocalServer).not.toHaveBeenCalled();
  expect(waitForServer).not.toHaveBeenCalled();
});

test("a macOS server start timeout escapes the log path", async () => {
  options.platform = "darwin";
  home = join(root, "home\u202e");
  options.home = home;
  waitForServer.mockResolvedValueOnce(null);
  expect(await invoke("install")).toBe(1);
  expect(stderr).toEqual([
    `recense: the recense service did not start a server; see ${root}/home\\u{202e}/Library/Logs/recense.log.\n`,
  ]);
  expect(stdout).toEqual([]);
  expect((await stat(plistPath())).isFile()).toBe(true);
  await expect(lstat(pendingPath())).rejects.toMatchObject({ code: "ENOENT" });
});

test.each([undefined, "relative", "/absolute"])(
  "Linux selects the unit directory for XDG_CONFIG_HOME=%s",
  async (value) => {
    io.env.XDG_CONFIG_HOME = value === "/absolute" ? join(root, "custom-config") : value;
    expect(await invoke("install")).toBe(0);
    const path = value === "/absolute" ? join(root, "custom-config/systemd/user/recense.service") : unitPath();
    expect(await readFile(path, "utf8")).toContain(" serve\n");
  },
);

describe.each(["linux", "darwin"])("%s service lifecycle", (platform) => {
  const path = () => (platform === "linux" ? unitPath() : plistPath());
  beforeEach(() => {
    options.platform = platform;
  });

  test.each(["install", "uninstall", "status"])("root cannot run service %s", async (action) => {
    options.uid = 0;
    expect(await invoke(action)).toBe(1);
    expect(stderr).toEqual(["recense: run recense service as the user who runs recense, not as root.\n"]);
    expect(stdout).toEqual([]);
    expect(calls()).toEqual([]);
    await expect(lstat(path())).rejects.toMatchObject({ code: "ENOENT" });
  });

  test.each(["0.0.0.0", "::", "127.0.0.2"])("reports whether other machines can reach --host %s", async (host) => {
    expect(await invoke("install", "--host", host)).toBe(0);
    expect(stdout).toEqual(installedOutput(undefined, host === "127.0.0.2" ? undefined : host));
  });

  test.each(["matching", "old", "zero"])("confirms only the managed server (pid: %s)", async (kind) => {
    const server = await startServer({ stateDir: state, port: 0 });
    const mainPid = kind === "matching" ? process.pid : kind === "old" ? process.pid + 1 : 0;
    recorded.mockImplementation(async (_file, args) => {
      if (args.includes("show")) return { ...ok, stdout: `${mainPid}\n` };
      if (args[0] === "print")
        return { ...ok, stdout: `target = {\n nested = {\n pid = ${process.pid}\n }\n pid = ${mainPid}\n}\n` };
      return ok;
    });
    waitForServer.mockImplementation((ready) =>
      waitForManagedServer(state, { ...ready, timeoutMs: 500, now: () => elapsed, sleep }),
    );
    try {
      expect(await invoke("install")).toBe(kind === "matching" ? 0 : 1);
      const query =
        platform === "linux"
          ? systemctl("show", "--property=MainPID", "--value", "recense")
          : launchctl("print", "gui/501/dev.recense.server");
      expect(calls()).toContainEqual(query);
      if (kind === "matching") {
        expect(stdout).toEqual(installedOutput(server.url));
        expect(stderr).toEqual([]);
      } else {
        const log =
          platform === "linux" ? "run journalctl --user -u recense" : `see ${join(home, "Library/Logs/recense.log")}`;
        expect(stderr).toEqual([
          kind === "zero"
            ? platform === "linux"
              ? `recense: the recense service did not start a server; ${log} to see why.\n`
              : `recense: the recense service did not start a server; ${log}.\n`
            : `recense: the recense service runs, but this command could not confirm its server; ${log}${platform === "linux" ? " to see why" : ""}, or run recense service install again in your own terminal if an agent sandbox runs this command.\n`,
        ]);
        expect(stdout).toEqual([]);
        expect(elapsed).toBe(500);
        expect(calls().filter((call) => JSON.stringify(call) === JSON.stringify(query))).toHaveLength(3);
      }
      expect((await stat(path())).isFile()).toBe(true);
      await expect(lstat(pendingPath())).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      await server.close();
    }
  });

  test.each([
    {
      name: "tailscale readiness waits for the public origin after matching the managed pid",
      flags: ["--tailscale"],
      publicOrigin: "https://review.example.ts.net",
    },
    {
      name: "tailscale readiness with a chosen port waits for the public origin that has the port",
      flags: ["--tailscale", "--tailscale-port", "13636"],
      publicOrigin: "https://review.example.ts.net:13636",
    },
    {
      name: "--public-url prints the public address the service serves",
      flags: ["--public-url", "https://recense.example.test"],
      publicOrigin: "https://recense.example.test",
    },
  ])("$name", async ({ flags, publicOrigin }) => {
    const server = await startServer({ stateDir: state, port: 0, publicOrigin });
    recorded.mockImplementation(async (_file, args) => {
      if (args.includes("show")) return { ...ok, stdout: `${process.pid}\n` };
      if (args[0] === "print") return { ...ok, stdout: `target = {\n pid = ${process.pid}\n}\n` };
      return ok;
    });
    sleep.mockImplementation(async (ms) => {
      elapsed += ms;
      expect(stdout).toEqual([]);
      if (elapsed >= 400) server.setPublicOriginReady(true);
    });
    waitForServer.mockImplementation((ready) =>
      waitForManagedServer(state, { ...ready, timeoutMs: 1000, now: () => elapsed, sleep }),
    );
    try {
      expect(await invoke("install", ...flags)).toBe(0);
      expect(elapsed).toBe(400);
      expect(stdout).toEqual(installedOutput(publicOrigin));
      expect(JSON.parse(await readFile(join(state, "server-url.json"), "utf8"))).toEqual({ baseUrl: publicOrigin });
    } finally {
      await server.close();
    }
  });

  test("a default install prints the sign-in command without a sign-in link or code", async () => {
    expect(await invoke("install")).toBe(0);
    const output = stdout.join("");
    expect(output).not.toContain("/pair");
    expect(output).not.toContain("#");
    expect(output.endsWith("To sign a browser in, run recense in your own terminal.\n")).toBe(true);
  });

  const validAttachment = JSON.stringify({
    hubId: "11111111-1111-4111-8111-111111111111",
    hubName: "Synthetic hub",
    hubUrl: "https://hub.example.test",
  });

  test("an attached machine prints the hub pairing command without a sign-in link or code", async () => {
    stateFiles.writeSecretFile(join(state, "attach.json"), validAttachment);
    expect(await invoke("install")).toBe(0);
    expect(stdout).toEqual([
      ...installedOutput().slice(0, 2),
      "This machine publishes to a hub; to pair a browser, run recense pair in your own terminal on the hub.\n",
    ]);
    const output = stdout.join("");
    expect(output).not.toContain("/pair");
    expect(output).not.toContain("#");
  });

  test.each(["invalid JSON", "a symlink"])("install prints local sign-in help when attach.json is %s", async (kind) => {
    const attachment = join(state, "attach.json");
    if (kind === "invalid JSON") {
      stateFiles.writeSecretFile(attachment, "{");
    } else {
      const target = join(root, "valid-attachment.json");
      stateFiles.writeSecretFile(target, validAttachment);
      await symlink(target, attachment);
    }
    expect(await invoke("install")).toBe(0);
    expect(stdout).toEqual(installedOutput());
    expect(stderr).toEqual([]);
  });

  test("stops the service and detached server before starting and confirming the replacement", async () => {
    expect(await invoke("install")).toBe(0);
    resetOutput();
    stopLocalServer.mockResolvedValueOnce("http://127.0.0.1:3636");
    waitForServer.mockImplementationOnce(async () => {
      await expect(lstat(pendingPath())).rejects.toMatchObject({ code: "ENOENT" });
      expect(stdout).toEqual([
        "recense: stopped the recense server at http://127.0.0.1:3636, so the service can take over\n",
      ]);
      return { url: "http://127.0.0.1:3636", pid: 12345 };
    });
    expect(await invoke("install")).toBe(0);
    expect(calls()).toEqual(
      platform === "linux"
        ? [
            systemctl("daemon-reload"),
            systemctl("enable", "recense"),
            systemctl("stop", "recense"),
            ["stopLocalServer"],
            systemctl("start", "recense"),
            ["waitForServer"],
            loginctl(),
          ]
        : [
            launchctl("bootout", "gui/501/dev.recense.server"),
            launchctl("print", "gui/501/dev.recense.server"),
            ["stopLocalServer"],
            launchctl("bootstrap", "gui/501", path()),
            ["waitForServer"],
          ],
    );
    expect(stdout).toEqual([
      "recense: stopped the recense server at http://127.0.0.1:3636, so the service can take over\n",
      ...installedOutput(),
    ]);
    expect(stderr).toEqual([]);
  });

  test("a server start timeout keeps the service file and clears the pending record", async () => {
    waitForServer.mockImplementationOnce(async () => {
      await expect(lstat(pendingPath())).rejects.toMatchObject({ code: "ENOENT" });
      return null;
    });
    expect(await invoke("install")).toBe(1);
    expect(stderr).toEqual([
      platform === "linux"
        ? "recense: the recense service did not start a server; run journalctl --user -u recense to see why.\n"
        : `recense: the recense service did not start a server; see ${join(home, "Library/Logs/recense.log")}.\n`,
    ]);
    expect(stdout).toEqual([]);
    expect((await stat(path())).isFile()).toBe(true);
    await expect(lstat(pendingPath())).rejects.toMatchObject({ code: "ENOENT" });
    expect(stopLocalServer).toHaveBeenCalledOnce();
    expect(waitForServer).toHaveBeenCalledOnce();
    expect(calls()).not.toContainEqual(loginctl());
  });

  test("a server stop failure prevents service startup", async () => {
    const message =
      "the recense server at http://127.0.0.1:3636 did not stop; stop it, then run recense service install again.";
    stopLocalServer.mockRejectedValueOnce(new CliError(message));
    expect(await invoke("install")).toBe(1);
    expect(stderr).toEqual([`recense: ${message}\n`]);
    expect(stdout).toEqual([]);
    expect(calls()).not.toContainEqual(systemctl("start", "recense"));
    expect(calls()).not.toContainEqual(launchctl("bootstrap", "gui/501", path()));
    expect(waitForServer).not.toHaveBeenCalled();
    await expect(lstat(pendingPath())).resolves.toBeDefined();
  });

  test.each(["uninstall", "status"])("%s never stops or waits for a local server", async (action) => {
    expect(await invoke("install")).toBe(0);
    resetOutput();
    expect(await invoke(action)).toBe(0);
    expect(stopLocalServer).not.toHaveBeenCalled();
    expect(waitForServer).not.toHaveBeenCalled();
  });

  test("identical install preserves bytes and mtime while restarting the service", async () => {
    expect(await invoke("install", "--port", "4000")).toBe(0);
    const content = await readFile(path());
    await utimes(path(), 1000, 1000);
    const before = await stat(path());
    resetOutput();
    expect(await invoke("install", "--port", "4000")).toBe(0);
    expect(await readFile(path())).toEqual(content);
    expect((await stat(path())).mtimeMs).toBe(before.mtimeMs);
    expect(calls()).toEqual(
      platform === "linux"
        ? [
            systemctl("daemon-reload"),
            systemctl("enable", "recense"),
            systemctl("stop", "recense"),
            ["stopLocalServer"],
            systemctl("start", "recense"),
            ["waitForServer"],
            loginctl(),
          ]
        : [
            launchctl("bootout", "gui/501/dev.recense.server"),
            launchctl("print", "gui/501/dev.recense.server"),
            ["stopLocalServer"],
            launchctl("bootstrap", "gui/501", path()),
            ["waitForServer"],
          ],
    );
  });

  test("changed install applies the flags in their original order", async () => {
    expect(await invoke("install", "--port", "4000")).toBe(0);
    resetOutput();
    if (platform === "darwin") recorded.mockResolvedValueOnce(failed).mockResolvedValueOnce(failed);
    expect(await invoke("install", "--port", "4001", "--host", "192.0.2.1")).toBe(0);
    const content = await readFile(path(), "utf8");
    expect(content.indexOf("4001")).toBeLessThan(content.indexOf("--host"));
    expect(content).toContain("192.0.2.1");
    expect(calls()).toEqual(
      platform === "linux"
        ? [
            systemctl("daemon-reload"),
            systemctl("enable", "recense"),
            systemctl("stop", "recense"),
            ["stopLocalServer"],
            systemctl("start", "recense"),
            ["waitForServer"],
            loginctl(),
          ]
        : [
            launchctl("bootout", "gui/501/dev.recense.server"),
            launchctl("print", "gui/501/dev.recense.server"),
            ["stopLocalServer"],
            launchctl("bootstrap", "gui/501", path()),
            ["waitForServer"],
          ],
    );
    expect(stderr).toEqual([]);
  });

  test.each([false, true])("uninstall removes an owned file even when stop fails: %s", async (stopFails) => {
    expect(await invoke("install")).toBe(0);
    resetOutput();
    if (stopFails) recorded.mockResolvedValueOnce(failed);
    expect(await invoke("uninstall")).toBe(0);
    await expect(lstat(path())).rejects.toMatchObject({ code: "ENOENT" });
    await expect(lstat(optionsPath())).rejects.toMatchObject({ code: "ENOENT" });
    expect(calls()).toEqual(
      platform === "linux"
        ? [systemctl("disable", "--now", "recense"), systemctl("daemon-reload")]
        : [launchctl("bootout", "gui/501/dev.recense.server")],
    );
    expect(stderr).toHaveLength(stopFails ? 1 : 0);
    if (stopFails) {
      expect(stderr[0]).toContain("first failure\n");
      expect(stderr[0]?.split("\n")).toHaveLength(2);
      expect(stderr[0]).toContain(
        platform === "linux" ? "systemctl --user disable --now recense" : "launchctl bootout",
      );
    }
  });

  test("uninstall of an absent service succeeds without running a command", async () => {
    await writeFile(optionsPath(), "invalid stale options");
    expect(await invoke("uninstall")).toBe(0);
    expect(stdout).toEqual(["recense: the service is not installed.\n"]);
    expect(stderr).toEqual([]);
    expect(calls()).toEqual([]);
    await expect(lstat(optionsPath())).rejects.toMatchObject({ code: "ENOENT" });
  });

  test.each(["install", "uninstall"])("%s leaves a foreign file byte for byte unchanged", async (command) => {
    const foreign =
      platform === "linux" ? "# foreign\n# written by recense\n" : "<!-- foreign -->\n<!-- written by recense -->\n";
    await put(path(), foreign);
    expect(await invoke(command)).toBe(1);
    expect(await readFile(path(), "utf8")).toBe(foreign);
    expect(stderr).toEqual([`recense: ${path()} was not written by recense; move it away, then try again.\n`]);
    expect(stdout).toEqual([]);
    expect(calls()).toEqual([]);
  });

  test("a marker line at EOF still identifies an owned service", async () => {
    await put(
      path(),
      platform === "linux"
        ? "# written by recense"
        : '<?xml version="1.0" encoding="UTF-8"?>\n<!-- written by recense -->',
    );
    expect(await invoke("uninstall")).toBe(0);
    await expect(lstat(path())).rejects.toMatchObject({ code: "ENOENT" });
  });

  test.each(["install", "uninstall"])(
    "%s refuses a symlink even when its target carries the marker",
    async (command) => {
      expect(await invoke("install")).toBe(0);
      const target = path();
      const content = await readFile(target);
      options.home = join(root, "other-home");
      await mkdir(options.home);
      const linked =
        platform === "linux"
          ? join(options.home, ".config/systemd/user/recense.service")
          : join(options.home, "Library/LaunchAgents/dev.recense.server.plist");
      await mkdir(dirname(linked), { recursive: true });
      await symlink(target, linked);
      resetOutput();
      expect(await invoke(command)).toBe(1);
      expect(await readFile(target)).toEqual(content);
      expect((await lstat(linked)).isSymbolicLink()).toBe(true);
      expect(calls()).toEqual([]);
    },
  );

  test.each(["absent", "stopped", "running", "failed-query"])(
    "status reports %s in one stdout line",
    async (status) => {
      if (status !== "absent") await put(path(), "foreign but installed\n");
      recorded.mockResolvedValue(
        status === "failed-query" || (platform === "linux" && status === "stopped")
          ? failed
          : { ...ok, stdout: status === "running" ? "target = {\n\tstate = running\n}\n" : "state = not running\n" },
      );
      expect(await invoke("status")).toBe(0);
      expect(stdout).toEqual([
        status === "absent"
          ? "recense: service not installed\n"
          : `recense: service ${status === "running" ? "running" : "installed but not running"} (${path()})\n`,
      ]);
      expect(stderr).toEqual([]);
      expect(calls()).toEqual(
        status === "absent"
          ? []
          : platform === "linux"
            ? [systemctl("is-active", "recense")]
            : [launchctl("print", "gui/501/dev.recense.server")],
      );
    },
  );

  test.each(["older", "equal", "no-record", "unverified", "probe-failed", "query-failed"])(
    "running service version notice (%s)",
    async (kind) => {
      const order: string[] = [];
      const writeOut = io.stdout;
      const writeErr = io.stderr;
      io.stdout = (line) => {
        order.push("stdout");
        writeOut(line);
      };
      io.stderr = (line) => {
        order.push("stderr");
        writeErr(line);
      };
      await put(
        path(),
        platform === "linux"
          ? "# written by recense\n"
          : '<?xml version="1.0" encoding="UTF-8"?>\n<!-- written by recense -->\n',
      );
      const proof = kind === "no-record" ? undefined : provenTestServer(state);
      recorded.mockImplementation(async (_file, args) => {
        if (args.includes("is-active")) return ok;
        return kind === "query-failed" && recorded.mock.calls.length > 1
          ? failed
          : {
              ...ok,
              stdout:
                platform === "linux" ? `${process.pid}\n` : `target = {\n state = running\n pid = ${process.pid}\n}\n`,
            };
      });
      const fetcher = vi.fn(async (url: string | URL, init?: RequestInit) => {
        if (kind === "probe-failed") throw new TypeError("synthetic probe failure");
        const response = proof?.(url, init);
        return Response.json(
          { api: 1, version: kind === "equal" ? VERSION : "0.0.9", features: [] },
          { headers: kind === "unverified" ? {} : response?.headers },
        );
      });
      const readCredential = vi.spyOn(credentials, "readTokenFile");
      vi.stubGlobal("fetch", fetcher);
      try {
        expect(await invoke("status")).toBe(0);
        expect(stdout).toEqual([`recense: service running (${path()})\n`]);
        expect(order).toEqual(kind === "older" ? ["stdout", "stderr"] : ["stdout"]);
        expect(stderr).toEqual(
          kind === "older"
            ? [
                `recense: the recense server at http://127.0.0.1:3636 runs recense 0.0.9; this is recense ${VERSION}. Run recense service install to restart it on recense ${VERSION}.\n`,
              ]
            : [],
        );
        expect(readCredential).not.toHaveBeenCalled();
        if (kind === "no-record") expect(fetcher).not.toHaveBeenCalled();
        else expect(fetcher).toHaveBeenCalledOnce();
        expect(fetcher.mock.calls.every(([, init]) => !new Headers(init?.headers).has("Authorization"))).toBe(true);
      } finally {
        vi.unstubAllGlobals();
        readCredential.mockRestore();
      }
    },
  );

  test.each(["absent", "stopped"])("%s service never probes a server version", async (status) => {
    if (status === "stopped") await put(path(), "# written by recense\n");
    provenTestServer(state);
    recorded.mockResolvedValue(failed);
    const fetcher = vi.fn();
    vi.stubGlobal("fetch", fetcher);
    try {
      expect(await invoke("status")).toBe(0);
      expect(stdout).toEqual([
        status === "absent"
          ? "recense: service not installed\n"
          : `recense: service installed but not running (${path()})\n`,
      ]);
      expect(stderr).toEqual([]);
      expect(fetcher).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

test("an identical but unloaded launch agent is bootstrapped without rewriting", async () => {
  options.platform = "darwin";
  expect(await invoke("install")).toBe(0);
  await utimes(plistPath(), 1000, 1000);
  resetOutput();
  recorded.mockResolvedValueOnce(failed);
  expect(await invoke("install")).toBe(0);
  expect((await stat(plistPath())).mtimeMs).toBe(1000000);
  expect(calls()).toEqual([
    launchctl("bootout", "gui/501/dev.recense.server"),
    launchctl("print", "gui/501/dev.recense.server"),
    ["stopLocalServer"],
    launchctl("bootstrap", "gui/501", plistPath()),
    ["waitForServer"],
  ]);
});

test.each(["no", "yes", "failed", "missing"])("linger %s prints only the prescribed advice when off", async (value) => {
  if (value === "missing") await chmod(join(bin, "loginctl"), 0o644);
  recorded.mockImplementation(async (file) =>
    file.endsWith("/loginctl") ? (value === "failed" ? failed : { ...ok, stdout: `${value}\n` }) : ok,
  );
  expect(await invoke("install")).toBe(0);
  expect(stdout.filter((line) => line.includes("linger"))).toEqual(value === "no" ? [linger] : []);
  expect(stderr).toEqual([]);
});

test.each(
  [
    [],
    ["unknown"],
    ["install", "--tailscale", "--tailscale"],
    ["install", "--port", "65536"],
    ["install", "--port", "4000", "--port", "4001"],
    ["status", "--port", "4000"],
    ["uninstall", "extra"],
  ].map((args) => ({ args })),
)("invalid service arguments $args are usage errors before side effects", async ({ args }) => {
  expect(await invoke(...args)).toBe(2);
  expect(stderr).toHaveLength(1);
  expect(stderr[0]?.split("\n")).toHaveLength(2);
  expect(stdout).toEqual([]);
  expect(calls()).toEqual([]);
  await expect(lstat(join(home, ".config"))).rejects.toMatchObject({ code: "ENOENT" });
});

test.each(["win32", "freebsd", "linux"])(
  "unsupported %s or missing systemctl fails before writes",
  async (platform) => {
    options.platform = platform;
    io.env.PATH = ":relative";
    expect(await invoke("install")).toBe(1);
    expect(stderr).toEqual([unsupported]);
    expect(calls()).toEqual([]);
    await expect(lstat(join(home, ".config"))).rejects.toMatchObject({ code: "ENOENT" });
  },
);

test("missing launchctl fails before writing a plist", async () => {
  options.platform = "darwin";
  io.env.PATH = "relative";
  expect(await invoke("install")).toBe(1);
  expect(stderr).toEqual([unsupported]);
  expect(calls()).toEqual([]);
  await expect(lstat(join(home, "Library"))).rejects.toMatchObject({ code: "ENOENT" });
});

test("a fake systemctl in a relative PATH entry is never run", async () => {
  await mkdir(join(home, "relative"));
  await writeFile(join(home, "relative/systemctl"), "synthetic relative executable\n", { mode: 0o755 });
  io.env.PATH = `${relative(process.cwd(), join(home, "relative"))}::${bin}`;
  expect(await invoke("install")).toBe(0);
  expect(calls()).toEqual([
    systemctl("daemon-reload"),
    systemctl("enable", "recense"),
    systemctl("stop", "recense"),
    ["stopLocalServer"],
    systemctl("start", "recense"),
    ["waitForServer"],
    loginctl(),
  ]);
  expect(recorded.mock.calls[0]).toEqual([
    join(bin, "systemctl"),
    ["--user", "daemon-reload"],
    { cwd: home, env: { ...io.env, PATH: bin } },
  ]);
});

test.each(["\n", "\r", "\t", "\0", "\u001b", "\u007f", "\u0085"])(
  "control character %j is refused before writing anything",
  async (control) => {
    options.entry = join(home, `entry${control}.mjs`);
    expect(await invoke("install")).toBe(1);
    expect(stderr).toHaveLength(1);
    expect(stderr[0]?.split("\n")).toHaveLength(2);
    expect(calls()).toEqual([]);
    await expect(lstat(join(home, ".config"))).rejects.toMatchObject({ code: "ENOENT" });
  },
);

test.each(["node", "entry", "home"] as const)("relative %s is refused before writing", async (key) => {
  options[key] = "relative";
  expect(await invoke("install")).toBe(1);
  expect(stderr).toHaveLength(1);
  expect(calls()).toEqual([]);
});

describe.each(["linux", "darwin"])("%s pending installs", (platform) => {
  const path = () => (platform === "linux" ? unitPath() : plistPath());
  const changedCalls = () =>
    platform === "linux"
      ? [
          systemctl("daemon-reload"),
          systemctl("enable", "recense"),
          systemctl("stop", "recense"),
          ["stopLocalServer"],
          systemctl("start", "recense"),
          ["waitForServer"],
          loginctl(),
        ]
      : [
          launchctl("bootout", "gui/501/dev.recense.server"),
          launchctl("print", "gui/501/dev.recense.server"),
          ["stopLocalServer"],
          launchctl("bootstrap", "gui/501", path()),
          ["waitForServer"],
        ];
  beforeEach(() => {
    options.platform = platform;
  });

  for (const previous of ["absent", "changed"]) {
    const steps =
      platform === "linux"
        ? ["write", "daemon-reload", "enable", "stop", "start"]
        : ["write", ...(previous === "changed" ? ["wait"] : []), "bootstrap"];
    test.each(steps)(`a failed ${previous} install at %s is finished by a retry`, async (step) => {
      if (previous === "changed") expect(await invoke("install")).toBe(0);
      resetOutput();
      if (step === "write") vi.mocked(writeService).mockRejectedValueOnce(new Error("synthetic write failure"));
      recorded.mockImplementation(async (_file, args) => {
        await expect(lstat(pendingPath())).resolves.toBeDefined();
        if (args[0] === "print") return step === "wait" ? ok : failed;
        return args.includes(step) ? failed : ok;
      });
      expect(await invoke("install", "--port", "4000")).toBe(1);
      await expect(lstat(pendingPath())).resolves.toBeDefined();
      if (step !== "write") expect(await readFile(path(), "utf8")).toContain("4000");
      expect(stderr).toHaveLength(1);
      expect(stderr[0]?.split("\n")).toHaveLength(2);
      if (step !== "write" && step !== "wait") {
        expect(stderr[0]).toContain(step);
        expect(stderr[0]).toContain("first failure\n");
      }
      expect(stdout).toEqual([]);
      const identical = step !== "write";
      const content = identical ? await readFile(path()) : undefined;
      if (identical) await utimes(path(), 1000, 1000);
      resetOutput();
      recorded.mockImplementation(async (_file, args) => (args[0] === "print" ? failed : ok));
      expect(await invoke("install", "--port", "4000")).toBe(0);
      expect(calls()).toEqual(changedCalls());
      if (identical) {
        expect(await readFile(path())).toEqual(content);
        expect((await stat(path())).mtimeMs).toBe(1000000);
      }
      await expect(lstat(pendingPath())).rejects.toMatchObject({ code: "ENOENT" });
      resetOutput();
      recorded.mockImplementation(async (_file, args) => (args[0] === "print" ? failed : ok));
      expect(await invoke("install", "--port", "4000")).toBe(0);
      expect(calls()).toEqual(
        platform === "linux"
          ? [
              systemctl("daemon-reload"),
              systemctl("enable", "recense"),
              systemctl("stop", "recense"),
              ["stopLocalServer"],
              systemctl("start", "recense"),
              ["waitForServer"],
              loginctl(),
            ]
          : [
              launchctl("bootout", "gui/501/dev.recense.server"),
              launchctl("print", "gui/501/dev.recense.server"),
              ["stopLocalServer"],
              launchctl("bootstrap", "gui/501", path()),
              ["waitForServer"],
            ],
      );
    });
  }

  test.each([false, true])("uninstall clears a pending marker with an installed file: %s", async (installed) => {
    if (installed) expect(await invoke("install")).toBe(0);
    await writeFile(pendingPath(), "pending\n");
    expect(await invoke("uninstall")).toBe(0);
    await expect(lstat(pendingPath())).rejects.toMatchObject({ code: "ENOENT" });
  });

  test("status ignores a pending marker", async () => {
    await writeFile(pendingPath(), "pending\n");
    expect(await invoke("status")).toBe(0);
    expect(stdout).toEqual(["recense: service not installed\n"]);
    expect(await readFile(pendingPath(), "utf8")).toBe("pending\n");
    expect(calls()).toEqual([]);
  });
});

test.each([false, true])("launchd waits for disappearance even when bootout fails: %s", async (bootoutFails) => {
  options.platform = "darwin";
  expect(await invoke("install")).toBe(0);
  resetOutput();
  recorded
    .mockResolvedValueOnce(bootoutFails ? failed : ok)
    .mockResolvedValueOnce(ok)
    .mockResolvedValueOnce(ok)
    .mockResolvedValueOnce(failed);
  expect(await invoke("install", "--port", "4000")).toBe(0);
  expect(calls()).toEqual([
    launchctl("bootout", "gui/501/dev.recense.server"),
    ...Array.from({ length: 3 }, () => launchctl("print", "gui/501/dev.recense.server")),
    ["stopLocalServer"],
    launchctl("bootstrap", "gui/501", plistPath()),
    ["waitForServer"],
  ]);
  expect(sleep.mock.calls).toEqual([[200], [200]]);
  expect(elapsed).toBe(400);
  expect(stderr).toEqual([]);
});

test("launchd stops waiting at ten seconds, keeps the marker, and never bootstraps the dying job", async () => {
  options.platform = "darwin";
  expect(await invoke("install")).toBe(0);
  resetOutput();
  recorded.mockResolvedValue(ok);
  expect(await invoke("install", "--port", "4000")).toBe(1);
  expect(elapsed).toBe(10000);
  expect(sleep.mock.calls).toEqual(Array.from({ length: 50 }, () => [200]));
  expect(calls().filter((call) => call[1] === "bootstrap")).toEqual([]);
  expect(stderr).toEqual(["recense: the old recense service did not stop; try again.\n"]);
  await expect(lstat(pendingPath())).resolves.toBeDefined();
});

test.each(["$", '"', "'", "\\"])("Linux refuses node paths containing %j before writing", async (char) => {
  options.node = join(home, `node${char}`);
  await writeFile(options.node, "synthetic node");
  expect(await invoke("install")).toBe(1);
  expect(stderr).toEqual([
    "recense: the node path contains $, quotes or a backslash, which a systemd unit cannot run; use a node installed at a plain path.\n",
  ]);
  expect(calls()).toEqual([]);
  await expect(lstat(pendingPath())).rejects.toMatchObject({ code: "ENOENT" });
  await expect(lstat(join(home, ".config"))).rejects.toMatchObject({ code: "ENOENT" });
});

test("Linux keeps dollar escaping for the entry and literal dollars in Environment", async () => {
  options.entry = join(home, "entry$VAR%.mjs");
  await writeFile(options.entry, "synthetic entry");
  io.env.RECENSE_HOME = join(home, "state$VAR%");
  expect(await invoke("install")).toBe(0);
  const content = await readFile(unitPath(), "utf8");
  expect(content).toContain("entry$$VAR%%.mjs");
  expect(content).toContain("state$VAR%%");
});

test.each(["$", '"', "'", "\\"])("macOS still accepts node paths containing %j", async (char) => {
  options.platform = "darwin";
  options.node = join(home, `node${char}`);
  await writeFile(options.node, "synthetic node");
  expect(await invoke("install")).toBe(0);
  expect(calls()).toEqual([["stopLocalServer"], launchctl("bootstrap", "gui/501", plistPath()), ["waitForServer"]]);
});

describe.each(["linux", "darwin"])("%s install boundaries", (platform) => {
  const path = () => (platform === "linux" ? unitPath() : plistPath());
  beforeEach(() => {
    options.platform = platform;
  });

  test.each([
    { key: "node", linked: false },
    { key: "node", linked: true },
    { key: "entry", linked: false },
    { key: "entry", linked: true },
  ] as const)("refuses $key resolved inside the current repository (symlink=$linked)", async ({ key, linked }) => {
    const repo = join(root, "reviewed");
    options.cwd = join(repo, "nested");
    await mkdir(options.cwd, { recursive: true });
    await gitDirectory(repo);
    const target = join(repo, "node_modules/@shllg/recense/dist", key);
    await put(target, "synthetic runtime");
    const link = join(home, `${key}-link`);
    await symlink(target, link);
    options[key] = linked ? link : target;
    expect(await invoke("install")).toBe(1);
    expect(stderr).toEqual([
      "recense: this recense runs from inside the current repository; run recense service install from outside it.\n",
    ]);
    expect(calls()).toEqual([]);
    await expect(lstat(path())).rejects.toMatchObject({ code: "ENOENT" });
    await expect(lstat(pendingPath())).rejects.toMatchObject({ code: "ENOENT" });
    resetOutput();
    options.cwd = join(root, "cwd");
    expect(await invoke("install")).toBe(0);
  });

  for (const nested of ["sub", ".worktrees/feat"]) {
    test.each([
      { key: "node", linked: false },
      { key: "node", linked: true },
      { key: "entry", linked: false },
      { key: "entry", linked: true },
    ] as const)(`from ${nested}, refuses $key in the outer repository (symlink=$linked)`, async ({ key, linked }) => {
      const repo = join(root, "reviewed");
      const inner = join(repo, nested);
      await gitDirectory(repo);
      await mkdir(join(repo, ".git", nested === "sub" ? "modules/sub" : "worktrees/feat"), { recursive: true });
      await put(
        join(inner, ".git"),
        `gitdir: ${nested === "sub" ? "../.git/modules/sub" : "../../.git/worktrees/feat"}\n`,
      );
      const cwd = join(inner, "nested");
      await mkdir(cwd);
      // Resolve the current directory too: its spelling need not be inside either repository.
      options.cwd = join(root, "cwd-link");
      await symlink(cwd, options.cwd);
      const target = join(repo, "node_modules/@shllg/recense/dist", key);
      await put(target, "synthetic runtime");
      const link = join(home, `${key}-link`);
      await symlink(target, link);
      options[key] = linked ? link : target;
      expect(await invoke("install")).toBe(1);
      expect(stderr).toEqual([
        "recense: this recense runs from inside the current repository; run recense service install from outside it.\n",
      ]);
      expect(stdout).toEqual([]);
      expect(calls()).toEqual([]);
      await expect(lstat(path())).rejects.toMatchObject({ code: "ENOENT" });
      await expect(lstat(pendingPath())).rejects.toMatchObject({ code: "ENOENT" });
      resetOutput();
      options.cwd = join(root, "cwd");
      expect(await invoke("install")).toBe(0);
      expect(stderr).toEqual([]);
      expect((await lstat(path())).isFile()).toBe(true);
      expect(calls()).toEqual(
        platform === "linux"
          ? [
              systemctl("daemon-reload"),
              systemctl("enable", "recense"),
              systemctl("stop", "recense"),
              ["stopLocalServer"],
              systemctl("start", "recense"),
              ["waitForServer"],
              loginctl(),
            ]
          : [["stopLocalServer"], launchctl("bootstrap", "gui/501", plistPath()), ["waitForServer"]],
      );
    });
  }

  test.each(["malformed file", "symlink", "dangling symlink"])(
    "refuses a %s .git above the nearest repository before writing",
    async (kind) => {
      const repo = join(root, "reviewed");
      options.cwd = join(repo, "sub");
      await gitDirectory(options.cwd);
      if (kind === "malformed file") await writeFile(join(repo, ".git"), "not a repository\n");
      else await symlink(kind === "symlink" ? home : join(root, "missing"), join(repo, ".git"));
      expect(await invoke("install")).toBe(1);
      expect(stderr).toEqual(["recense: invalid repository entry\n"]);
      expect(stdout).toEqual([]);
      expect(calls()).toEqual([]);
      await expect(lstat(path())).rejects.toMatchObject({ code: "ENOENT" });
      await expect(lstat(pendingPath())).rejects.toMatchObject({ code: "ENOENT" });
    },
  );

  test("without a .git ancestor, install allows node and entry inside the current directory", async () => {
    options.cwd = home;
    expect(await invoke("install")).toBe(0);
    expect(stderr).toEqual([]);
    expect((await lstat(path())).isFile()).toBe(true);
    expect(calls()).toEqual(
      platform === "linux"
        ? [
            systemctl("daemon-reload"),
            systemctl("enable", "recense"),
            systemctl("stop", "recense"),
            ["stopLocalServer"],
            systemctl("start", "recense"),
            ["waitForServer"],
            loginctl(),
          ]
        : [["stopLocalServer"], launchctl("bootstrap", "gui/501", plistPath()), ["waitForServer"]],
    );
  });

  test.each(["install", "uninstall"])(
    "%s refuses a folder at the service path and leaves it intact",
    async (action) => {
      await mkdir(path(), { recursive: true });
      await writeFile(join(path(), "keep"), "synthetic content");
      expect(await invoke(action)).toBe(1);
      expect((await lstat(path())).isDirectory()).toBe(true);
      expect(await readFile(join(path(), "keep"), "utf8")).toBe("synthetic content");
      expect(stderr).toEqual([`recense: ${path()} was not written by recense; move it away, then try again.\n`]);
      expect(calls()).toEqual([]);
    },
  );

  test("a control character in the tool path keeps its own error", async () => {
    const tools = join(root, "bad\npath");
    await mkdir(tools);
    await writeFile(join(tools, platform === "linux" ? "systemctl" : "launchctl"), "synthetic tool", { mode: 0o755 });
    io.env.PATH = tools;
    expect(await invoke("install")).toBe(1);
    expect(stderr).toEqual(["recense: Service paths must not contain control characters.\n"]);
    expect(calls()).toEqual([]);
    await expect(lstat(path())).rejects.toMatchObject({ code: "ENOENT" });
  });
});

test("launchd status uses the first service-level state, never nested states", async () => {
  options.platform = "darwin";
  await put(plistPath(), "installed\n");
  recorded.mockResolvedValue({
    ...ok,
    stdout: `gui/501/dev.recense.server = {
\tstate = not running
\tresource coalition = {
\t\tstate = running
\t}
\tstate = running
}
`,
  });
  expect(await invoke("status")).toBe(0);
  expect(stdout).toEqual([`recense: service installed but not running (${plistPath()})\n`]);
});

test.each(["linux", "darwin"])("%s service install saves the public URL and waits for its origin", async (platform) => {
  options.platform = platform;
  const flags = ["--public-url", "https://recense.example.com"];
  expect(await invoke("install", ...flags)).toBe(0);
  expect(stdout).toEqual(installedOutput(publicUrl));
  const path = platform === "linux" ? unitPath() : plistPath();
  const content = await readFile(path, "utf8");
  expect(content).toContain(
    platform === "linux"
      ? "serve --public-url https://recense.example.com"
      : "<string>--public-url</string>\n    <string>https://recense.example.com</string>",
  );
  expect(waitForServer).toHaveBeenCalledWith(expect.objectContaining({ publicOrigin: true }));
  expect(JSON.parse(await readFile(optionsPath(), "utf8"))).toEqual(flags);
  resetOutput();
  expect(await invoke("install")).toBe(0);
  expect(await readFile(path, "utf8")).toBe(content);
  expect(waitForServer).toHaveBeenCalledWith(expect.objectContaining({ publicOrigin: true }));
  expect(stdout).toEqual([`recense: keeping the service options ${flags.join(" ")}\n`, ...installedOutput(publicUrl)]);
});

test.each(["linux", "darwin"])("%s service install without options needs no public origin", async (platform) => {
  options.platform = platform;
  expect(await invoke("install")).toBe(0);
  expect(waitForServer).toHaveBeenCalledWith(expect.objectContaining({ publicOrigin: false }));
});

test.each(["linux", "darwin"])(
  "%s service install refuses unsafe public URLs before any side effect",
  async (platform) => {
    options.platform = platform;
    for (const value of [
      "https://recense.example.com\n",
      "https://recense.\texample.com",
      "https://recense.example.com/recense",
    ]) {
      expect(await invoke("install", "--public-url", value)).toBe(2);
      expect(stderr.at(-1)).toBe(
        "recense: --public-url must be an https origin such as https://recense.example.com, with no path.\n",
      );
    }
    expect(calls()).toEqual([]);
    await expect(lstat(platform === "linux" ? unitPath() : plistPath())).rejects.toMatchObject({ code: "ENOENT" });
    await expect(lstat(optionsPath())).rejects.toMatchObject({ code: "ENOENT" });
  },
);

test.each(["linux", "darwin"])("%s service install preserves tailscale serve flags", async (platform) => {
  options.platform = platform;
  expect(await invoke("install", "--tailscale", "--port", "4000")).toBe(0);
  expect(stdout).toEqual(installedOutput(publicUrl));
  const content = await readFile(platform === "linux" ? unitPath() : plistPath(), "utf8");
  expect(content).toContain(platform === "linux" ? "serve --tailscale --port 4000" : "<string>--tailscale</string>");
});

test.each(["linux", "darwin"])("%s service install saves and keeps the tailscale port", async (platform) => {
  options.platform = platform;
  const flags = ["--tailscale", "--tailscale-port", "13636"];
  expect(await invoke("install", ...flags)).toBe(0);
  expect(stdout).toEqual(installedOutput(publicUrl));
  const content = await readFile(platform === "linux" ? unitPath() : plistPath(), "utf8");
  expect(content).toContain(
    platform === "linux"
      ? "serve --tailscale --tailscale-port 13636"
      : "<string>--tailscale-port</string>\n    <string>13636</string>",
  );
  expect(JSON.parse(await readFile(optionsPath(), "utf8"))).toEqual(flags);
  resetOutput();
  expect(await invoke("install")).toBe(0);
  expect(stdout).toEqual([`recense: keeping the service options ${flags.join(" ")}\n`, ...installedOutput(publicUrl)]);
  expect(await readFile(platform === "linux" ? unitPath() : plistPath(), "utf8")).toBe(content);
  expect(JSON.parse(await readFile(optionsPath(), "utf8"))).toEqual(flags);
  resetOutput();
  expect(await invoke("install", "--tailscale")).toBe(0);
  expect(stdout).toEqual(installedOutput(publicUrl));
  expect(await readFile(platform === "linux" ? unitPath() : plistPath(), "utf8")).not.toContain("13636");
});

test("service install refuses a tailscale port without tailscale before any side effect", async () => {
  expect(await invoke("install", "--tailscale-port", "13636")).toBe(2);
  expect(stderr[0]).toContain("--tailscale-port requires --tailscale.");
  await expect(lstat(unitPath())).rejects.toMatchObject({ code: "ENOENT" });
});

test("launchd installs a fixed trusted PATH including both Homebrew locations", async () => {
  options.platform = "darwin";
  io.env.PATH = `${bin}:./node_modules/.bin:/synthetic/review/node_modules/.bin`;
  expect(await invoke("install", "--tailscale")).toBe(0);
  expect(stdout).toEqual(installedOutput(publicUrl));
  const content = await readFile(plistPath(), "utf8");
  expect(content).toContain(
    "<key>PATH</key>\n    <string>/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin</string>",
  );
  expect(content).not.toContain("node_modules");
});

describe.each(["linux", "darwin"])("%s saved service options", (platform) => {
  const path = () => (platform === "linux" ? unitPath() : plistPath());
  const saved = async () => JSON.parse(await readFile(optionsPath(), "utf8"));
  const invalid = "recense: invalid saved service options; run recense service install with your options\n";
  const defaults = "recense: no saved service options; the service now uses the defaults\n";
  beforeEach(() => {
    options.platform = platform;
  });

  test.each([
    { flags: ["--tailscale"], url: publicUrl },
    { flags: ["--public-url", "https://recense.example.test"], url: publicUrl },
    { flags: ["--port", "4000", "--host", "192.0.2.1"], url: "http://127.0.0.1:3636", host: "192.0.2.1" },
  ])("a bare reinstall keeps $flags in order and announces them first", async ({ flags, url, host }) => {
    expect(await invoke("install", ...flags)).toBe(0);
    expect(stdout).toEqual(installedOutput(url, host));
    expect(await saved()).toEqual(flags);
    expect((await stat(optionsPath())).mode & 0o777).toBe(0o600);
    const content = await readFile(path(), "utf8");
    resetOutput();
    expect(await invoke("install")).toBe(0);
    expect(stdout).toEqual([
      `recense: keeping the service options ${flags.join(" ")}\n`,
      ...installedOutput(url, host),
    ]);
    expect(await readFile(path(), "utf8")).toBe(content);
    expect(await saved()).toEqual(flags);
    expect(calls()).toContainEqual(
      platform === "linux" ? systemctl("start", "recense") : launchctl("bootstrap", "gui/501", path()),
    );
  });

  test("empty saved options never print a keep line", async () => {
    for (let i = 0; i < 2; i++) {
      resetOutput();
      expect(await invoke("install")).toBe(0);
      expect(await saved()).toEqual([]);
      expect(stdout).toEqual(installedOutput());
    }
  });

  test("given options replace the whole saved list, including tailscale", async () => {
    expect(await invoke("install", "--tailscale", "--port", "4000")).toBe(0);
    expect(stdout).toEqual(installedOutput(publicUrl));
    resetOutput();
    expect(await invoke("install", "--port", "3636")).toBe(0);
    expect(await saved()).toEqual(["--port", "3636"]);
    expect(await readFile(path(), "utf8")).not.toContain("--tailscale");
    expect(stdout).toEqual(installedOutput());
  });

  test.each([false, true])("an older install announces defaults once (legacy pending marker: %s)", async (pending) => {
    expect(await invoke("install", "--tailscale")).toBe(0);
    expect(stdout).toEqual(installedOutput(publicUrl));
    await unlink(optionsPath());
    if (pending) await writeFile(pendingPath(), "");
    resetOutput();
    expect(await invoke("install")).toBe(0);
    expect(await saved()).toEqual([]);
    expect(await readFile(path(), "utf8")).not.toContain("--tailscale");
    expect(stdout).toEqual([defaults, ...installedOutput()]);
    await expect(lstat(pendingPath())).rejects.toMatchObject({ code: "ENOENT" });
    resetOutput();
    expect(await invoke("install")).toBe(0);
    expect(stdout).toEqual(installedOutput());
  });

  test("an older install already using defaults prints no defaults notice", async () => {
    expect(await invoke("install")).toBe(0);
    const content = await readFile(path(), "utf8");
    await unlink(optionsPath());
    resetOutput();
    expect(await invoke("install")).toBe(0);
    expect(await readFile(path(), "utf8")).toBe(content);
    expect(await saved()).toEqual([]);
    expect(stdout).toEqual(installedOutput());
  });

  test("an older install announces defaults before a failed start or bootstrap", async () => {
    expect(await invoke("install", "--tailscale")).toBe(0);
    expect(stdout).toEqual(installedOutput(publicUrl));
    await unlink(optionsPath());
    const start = platform === "linux" ? "start" : "bootstrap";
    let outputAtStart: string[] | undefined;
    recorded.mockImplementation(async (_file, args) => {
      if (args.includes(start)) {
        outputAtStart = [...stdout];
        return failed;
      }
      return args[0] === "print" ? failed : ok;
    });
    resetOutput();
    expect(await invoke("install")).toBe(1);
    expect(outputAtStart).toEqual([defaults]);
    expect(stdout).toEqual([defaults]);
    expect(stderr).toHaveLength(1);
    expect(stderr[0]).toContain(start);
    expect(await saved()).toEqual([]);
    expect(await readFile(path(), "utf8")).not.toContain("--tailscale");
    await expect(lstat(pendingPath())).resolves.toBeDefined();
  });

  test("explicit options on an older install print no defaults notice", async () => {
    expect(await invoke("install", "--tailscale")).toBe(0);
    expect(stdout).toEqual(installedOutput(publicUrl));
    await unlink(optionsPath());
    resetOutput();
    expect(await invoke("install", "--port", "3636")).toBe(0);
    expect(await saved()).toEqual(["--port", "3636"]);
    expect(stdout).toEqual(installedOutput());
  });

  test("saved empty options print no defaults notice when the runtime changes", async () => {
    expect(await invoke("install")).toBe(0);
    options.entry = join(home, "updated-recense.mjs");
    await writeFile(options.entry, "synthetic updated entry");
    resetOutput();
    expect(await invoke("install")).toBe(0);
    expect(await readFile(path(), "utf8")).toContain("updated-recense.mjs");
    expect(stdout).toEqual(installedOutput());
  });

  test.each([false, true])("a deleted unit discards a saved host (pending record: %s)", async (pending) => {
    const flags = ["--host", "0.0.0.0"];
    expect(await invoke("install", ...flags)).toBe(0);
    const content = await readFile(path(), "utf8");
    if (pending)
      await writeFile(
        pendingPath(),
        JSON.stringify({ flags, hash: createHash("sha256").update(content).digest("hex") }),
      );
    await unlink(path());
    resetOutput();
    expect(await invoke("install")).toBe(0);
    expect(await saved()).toEqual([]);
    expect(await readFile(path(), "utf8")).not.toContain("--host");
    expect(stdout).toEqual(installedOutput());
    await expect(lstat(pendingPath())).rejects.toMatchObject({ code: "ENOENT" });
  });

  test.each(["invalid", "symlink"])("a first install ignores orphaned %s saved options", async (kind) => {
    const target = join(root, "orphaned-options");
    if (kind === "symlink") {
      await writeFile(target, '["--host","0.0.0.0"]');
      await symlink(target, optionsPath());
    } else await writeFile(optionsPath(), "invalid stale options");
    expect(await invoke("install")).toBe(0);
    expect(await saved()).toEqual([]);
    expect(await readFile(path(), "utf8")).not.toContain("--host");
    expect(stdout).toEqual(installedOutput());
    if (kind === "symlink") expect(await readFile(target, "utf8")).toBe('["--host","0.0.0.0"]');
  });

  test.each(["not valid JSON", '{"flags":[],"content":"x"}'])(
    "a first install ignores a broken orphaned pending record (case %#)",
    async (pending) => {
      await writeFile(pendingPath(), pending);
      await writeFile(optionsPath(), '["--host","0.0.0.0"]');
      expect(await invoke("install")).toBe(0);
      expect(await saved()).toEqual([]);
      expect(await readFile(path(), "utf8")).not.toContain("--host");
      expect(stdout).toEqual(installedOutput());
      expect(stderr).toEqual([]);
      await expect(lstat(pendingPath())).rejects.toMatchObject({ code: "ENOENT" });
    },
  );

  test("an owned unit with a round-0 pending record refuses a bare install and accepts explicit flags", async () => {
    expect(await invoke("install", "--tailscale")).toBe(0);
    expect(stdout).toEqual(installedOutput(publicUrl));
    const content = await readFile(path(), "utf8");
    const pending = JSON.stringify({ flags: ["--tailscale"], content });
    await writeFile(pendingPath(), pending);
    resetOutput();
    expect(await invoke("install")).toBe(1);
    expect(stderr).toEqual([invalid]);
    expect(stdout).toEqual([]);
    expect(calls()).toEqual([]);
    expect(await readFile(path(), "utf8")).toBe(content);
    expect(await readFile(pendingPath(), "utf8")).toBe(pending);
    resetOutput();
    expect(await invoke("install", "--port", "3636")).toBe(0);
    expect(await saved()).toEqual(["--port", "3636"]);
    expect(await readFile(path(), "utf8")).not.toContain("--tailscale");
    expect(stdout).toEqual(installedOutput());
    await expect(lstat(pendingPath())).rejects.toMatchObject({ code: "ENOENT" });
  });

  test.each([false, true])("an interrupted uninstall leaves defaults (pending record: %s)", async (pending) => {
    const flags = ["--host", "0.0.0.0"];
    expect(await invoke("install", ...flags)).toBe(0);
    const content = await readFile(path(), "utf8");
    if (pending)
      await writeFile(
        pendingPath(),
        JSON.stringify({ flags, hash: createHash("sha256").update(content).digest("hex") }),
      );
    const actual = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
    vi.mocked(unlink).mockImplementation(async (file) => {
      if (file === path()) {
        await expect(lstat(optionsPath())).rejects.toMatchObject({ code: "ENOENT" });
        await expect(lstat(pendingPath())).rejects.toMatchObject({ code: "ENOENT" });
        throw new Error("synthetic interruption before unit removal");
      }
      return actual.unlink(file);
    });
    resetOutput();
    try {
      expect(await invoke("uninstall")).toBe(1);
    } finally {
      vi.mocked(unlink).mockImplementation(actual.unlink);
    }
    expect(await readFile(path(), "utf8")).toBe(content);
    await expect(lstat(optionsPath())).rejects.toMatchObject({ code: "ENOENT" });
    await expect(lstat(pendingPath())).rejects.toMatchObject({ code: "ENOENT" });
    resetOutput();
    expect(await invoke("install")).toBe(0);
    expect(await saved()).toEqual([]);
    expect(await readFile(path(), "utf8")).not.toContain("--host");
    expect(stdout).toEqual([defaults, ...installedOutput()]);
  });

  test.each(["options", "pending", "unit"])(
    "an interrupted uninstall after removing %s never restores a stale public host",
    async (step) => {
      expect(await invoke("install", "--host", "0.0.0.0")).toBe(0);
      const writer = stateFiles.writeSecretFile;
      const spy = vi.spyOn(stateFiles, "writeSecretFile").mockImplementation((file, ...args) => {
        if (file === optionsPath()) throw new Error("synthetic interruption after unit rename");
        return writer(file, ...args);
      });
      try {
        expect(await invoke("install", "--port", "3636")).toBe(1);
      } finally {
        spy.mockRestore();
      }
      expect(await saved()).toEqual(["--host", "0.0.0.0"]);
      const content = await readFile(path(), "utf8");
      expect(content).not.toContain("--host");
      expect(content).toContain("3636");
      const pending = await readFile(pendingPath(), "utf8");
      expect(JSON.parse(pending)).toEqual({
        flags: ["--port", "3636"],
        hash: createHash("sha256").update(content).digest("hex"),
      });

      const order = [optionsPath(), pendingPath(), path()];
      const count = step === "options" ? 1 : step === "pending" ? 2 : 3;
      const removed: string[] = [];
      const actual = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
      vi.mocked(unlink).mockImplementation(async (file) => {
        await actual.unlink(file);
        removed.push(String(file));
        if (file === order[count - 1]) throw new Error("synthetic interruption after uninstall step");
      });
      resetOutput();
      try {
        expect(await invoke("uninstall")).toBe(1);
      } finally {
        vi.mocked(unlink).mockImplementation(actual.unlink);
      }
      expect(removed).toEqual(order.slice(0, count));
      await expect(lstat(optionsPath())).rejects.toMatchObject({ code: "ENOENT" });
      if (step === "options") expect(await readFile(pendingPath(), "utf8")).toBe(pending);
      else await expect(lstat(pendingPath())).rejects.toMatchObject({ code: "ENOENT" });
      if (step === "unit") await expect(lstat(path())).rejects.toMatchObject({ code: "ENOENT" });
      else expect(await readFile(path(), "utf8")).toBe(content);

      resetOutput();
      expect(await invoke("install")).toBe(0);
      expect(await saved()).toEqual(step === "options" ? ["--port", "3636"] : []);
      expect(await readFile(path(), "utf8")).not.toContain("--host");
      expect(stdout).toEqual([
        ...(step === "options"
          ? ["recense: keeping the service options --port 3636\n"]
          : step === "pending"
            ? [defaults]
            : []),
        ...installedOutput(),
      ]);
      await expect(lstat(pendingPath())).rejects.toMatchObject({ code: "ENOENT" });
    },
  );

  test("a state folder with mode 0755 keeps the precise chmod hint", async () => {
    await chmod(state, 0o755);
    expect(await invoke("install")).toBe(1);
    expect(stderr).toEqual([
      `State directory ${state} has group or other permissions; fix it with chmod 700 '${state}'\n`,
    ]);
    expect(stdout).toEqual([]);
    expect(calls()).toEqual([]);
    await expect(lstat(path())).rejects.toMatchObject({ code: "ENOENT" });
    await expect(lstat(pendingPath())).rejects.toMatchObject({ code: "ENOENT" });
  });

  test("a state-folder write error keeps its precise diagnostic", async () => {
    const spy = vi.spyOn(stateFiles, "writeSecretFile").mockImplementationOnce(() => {
      throw new stateFiles.StateFolderWriteError(state);
    });
    try {
      expect(await invoke("install")).toBe(1);
    } finally {
      spy.mockRestore();
    }
    expect(stderr).toEqual([`recense cannot write its state folder ${state}.\n`]);
    expect(stdout).toEqual([]);
    expect(calls()).toEqual([]);
    await expect(lstat(path())).rejects.toMatchObject({ code: "ENOENT" });
  });

  test("long paths install successfully and recover through a small hashed pending record", async () => {
    home = join(root, ...Array.from({ length: 8 }, () => "long-path-".repeat(18)));
    state = join(home, "state");
    options.home = home;
    options.node = join(home, "node");
    options.entry = join(home, "recense.mjs");
    io.env.HOME = home;
    io.env.RECENSE_HOME = state;
    await mkdir(state, { recursive: true, mode: 0o700 });
    await writeFile(options.node, "synthetic node");
    await writeFile(options.entry, "synthetic entry");
    expect(await invoke("install", "--tailscale")).toBe(0);
    expect(stdout).toEqual(installedOutput(publicUrl));
    expect(Buffer.byteLength(await readFile(path(), "utf8"))).toBeGreaterThan(LIMITS.publicJsonBytes);
    const writer = stateFiles.writeSecretFile;
    const spy = vi.spyOn(stateFiles, "writeSecretFile").mockImplementation((file, ...args) => {
      if (file === optionsPath()) throw new Error("synthetic interruption after unit rename");
      return writer(file, ...args);
    });
    try {
      expect(await invoke("install", "--port", "4000")).toBe(1);
    } finally {
      spy.mockRestore();
    }
    const content = await readFile(path(), "utf8");
    const pending = await readFile(pendingPath(), "utf8");
    expect(Buffer.byteLength(content)).toBeGreaterThan(LIMITS.publicJsonBytes);
    expect(Buffer.byteLength(pending)).toBeLessThan(LIMITS.publicJsonBytes);
    expect(JSON.parse(pending)).toEqual({
      flags: ["--port", "4000"],
      hash: createHash("sha256").update(content).digest("hex"),
    });
    expect(await saved()).toEqual(["--tailscale"]);
    resetOutput();
    expect(await invoke("install")).toBe(0);
    expect(await saved()).toEqual(["--port", "4000"]);
    expect(await readFile(path(), "utf8")).toBe(content);
    expect(stdout).toEqual(["recense: keeping the service options --port 4000\n", ...installedOutput()]);
    await expect(lstat(pendingPath())).rejects.toMatchObject({ code: "ENOENT" });
  });

  test.each([
    "{",
    "null",
    "{}",
    '"--tailscale"',
    "[1]",
    '["--unknown"]',
    '["--port"]',
    '["--port","65536"]',
    '["--tailscale","--tailscale"]',
    '["--tailscale","--host","0.0.0.0"]',
    JSON.stringify(["--host", "bad\n\u001b[31m\u202e"]),
    JSON.stringify(["--host", "a".repeat(LIMITS.publicJsonBytes)]),
  ])(
    "invalid saved options refuse without changing the unit, and explicit flags repair them (case %#)",
    async (bad) => {
      expect(await invoke("install", "--tailscale")).toBe(0);
      expect(stdout).toEqual(installedOutput(publicUrl));
      const content = await readFile(path(), "utf8");
      await writeFile(optionsPath(), bad);
      resetOutput();
      expect(await invoke("install")).toBe(1);
      expect(stderr).toEqual([invalid]);
      expect(stdout).toEqual([]);
      expect(calls()).toEqual([]);
      expect(await readFile(path(), "utf8")).toBe(content);
      expect(await readFile(optionsPath(), "utf8")).toBe(bad);
      await expect(lstat(pendingPath())).rejects.toMatchObject({ code: "ENOENT" });
      resetOutput();
      expect(await invoke("install", "--port", "3636")).toBe(0);
      expect(await saved()).toEqual(["--port", "3636"]);
      expect(stdout).toEqual(installedOutput());
    },
  );

  test.each([false, true])("a saved-options symlink is invalid even if dangling: %s", async (dangling) => {
    expect(await invoke("install")).toBe(0);
    const content = await readFile(path(), "utf8");
    await unlink(optionsPath());
    const target = join(root, "synthetic-options");
    if (!dangling) await writeFile(target, '["--tailscale"]');
    await symlink(target, optionsPath());
    resetOutput();
    expect(await invoke("install")).toBe(1);
    expect(stderr).toEqual([invalid]);
    expect(calls()).toEqual([]);
    expect(await readFile(path(), "utf8")).toBe(content);
    resetOutput();
    expect(await invoke("install", "--port", "3636")).toBe(0);
    expect((await lstat(optionsPath())).isSymbolicLink()).toBe(false);
    expect(await saved()).toEqual(["--port", "3636"]);
    if (!dangling) expect(await readFile(target, "utf8")).toBe('["--tailscale"]');
    else await expect(lstat(target)).rejects.toMatchObject({ code: "ENOENT" });
  });

  test.skipIf(process.getuid?.() === 0)(
    "unreadable saved options refuse, and explicit flags replace the file",
    async () => {
      expect(await invoke("install", "--tailscale")).toBe(0);
      expect(stdout).toEqual(installedOutput(publicUrl));
      const content = await readFile(path(), "utf8");
      await chmod(optionsPath(), 0o000);
      try {
        resetOutput();
        expect(await invoke("install")).toBe(1);
        expect(stderr).toEqual([invalid]);
        expect(stdout).toEqual([]);
        expect(calls()).toEqual([]);
        expect(await readFile(path(), "utf8")).toBe(content);
        resetOutput();
        expect(await invoke("install", "--port", "3636")).toBe(0);
        expect(await saved()).toEqual(["--port", "3636"]);
        expect((await stat(optionsPath())).mode & 0o777).toBe(0o600);
      } finally {
        await chmod(optionsPath(), 0o600);
      }
    },
  );

  for (const installed of [false, true]) {
    test.each(["pending", "unit", "options", "start"])(
      `a failed ${installed ? "repeat" : "first"} install at %s recovers the options for the unit on disk`,
      async (step) => {
        if (installed) {
          expect(await invoke("install", "--tailscale")).toBe(0);
          expect(stdout).toEqual(installedOutput(publicUrl));
        }
        resetOutput();
        const writer = stateFiles.writeSecretFile;
        const spy = vi.spyOn(stateFiles, "writeSecretFile").mockImplementation((file, ...args) => {
          if (file === (step === "options" ? optionsPath() : step === "pending" ? pendingPath() : ""))
            throw new Error("synthetic state write failure");
          return writer(file, ...args);
        });
        if (step === "unit") vi.mocked(writeService).mockRejectedValueOnce(new Error("synthetic unit write failure"));
        if (step === "start") {
          recorded.mockImplementation(async (_file, args) =>
            args[0] === "print" || args.includes(platform === "linux" ? "start" : "bootstrap") ? failed : ok,
          );
        }
        try {
          expect(await invoke("install", "--port", "4000")).toBe(1);
        } finally {
          spy.mockRestore();
        }
        const renamed = step === "options" || step === "start";
        const expected = renamed ? ["--port", "4000"] : installed ? ["--tailscale"] : [];
        if (renamed) expect(await readFile(path(), "utf8")).toContain("4000");
        if (step !== "pending") expect((await stat(pendingPath())).mode & 0o777).toBe(0o600);
        resetOutput();
        recorded.mockImplementation(async (_file, args) => (args[0] === "print" ? failed : ok));
        expect(await invoke("install")).toBe(0);
        expect(await saved()).toEqual(expected);
        expect(stdout).toEqual([
          ...(expected.length ? [`recense: keeping the service options ${expected.join(" ")}\n`] : []),
          ...installedOutput(expected.includes("--tailscale") ? publicUrl : undefined),
        ]);
        const content = await readFile(path(), "utf8");
        expect(content.includes("4000")).toBe(renamed);
        expect(content.includes("--tailscale")).toBe(!renamed && installed);
        await expect(lstat(pendingPath())).rejects.toMatchObject({ code: "ENOENT" });
      },
    );
  }

  test("a second failed explicit update cannot discard an earlier pending options recovery", async () => {
    expect(await invoke("install", "--tailscale")).toBe(0);
    expect(stdout).toEqual(installedOutput(publicUrl));
    const writer = stateFiles.writeSecretFile;
    const spy = vi.spyOn(stateFiles, "writeSecretFile").mockImplementation((file, ...args) => {
      if (file === optionsPath()) throw new Error("synthetic options write failure");
      return writer(file, ...args);
    });
    try {
      expect(await invoke("install", "--port", "4000")).toBe(1);
    } finally {
      spy.mockRestore();
    }
    expect(await saved()).toEqual(["--tailscale"]);
    expect(await readFile(path(), "utf8")).toContain("4000");
    vi.mocked(writeService).mockRejectedValueOnce(new Error("synthetic unit write failure"));
    expect(await invoke("install", "--port", "5000")).toBe(1);
    expect(await saved()).toEqual(["--port", "4000"]);
    resetOutput();
    expect(await invoke("install")).toBe(0);
    expect(await saved()).toEqual(["--port", "4000"]);
    expect(await readFile(path(), "utf8")).toContain("4000");
    expect(stdout[0]).toBe("recense: keeping the service options --port 4000\n");
  });
});

test.each(["linux", "darwin"])("%s service preserves the global config home", async (platform) => {
  options.platform = platform;
  const configHome = join(root, "synthetic config");
  io.env.XDG_CONFIG_HOME = configHome;
  expect(await invoke("install")).toBe(0);
  const path = platform === "linux" ? join(configHome, "systemd/user/recense.service") : plistPath();
  const document = await readFile(path, "utf8");
  expect(document).toContain(
    platform === "linux"
      ? `Environment="XDG_CONFIG_HOME=${configHome}"`
      : `<key>XDG_CONFIG_HOME</key>\n    <string>${configHome}</string>`,
  );
});

describe.each(["linux", "darwin"])("%s service from before the rename", (platform) => {
  const oldPath = () =>
    platform === "linux"
      ? join(home, ".config/systemd/user/emend.service")
      : join(home, "Library/LaunchAgents/dev.emend.server.plist");
  const newPath = () => (platform === "linux" ? unitPath() : plistPath());
  const defaultOldState = () =>
    platform === "linux" ? join(home, ".local/share/emend") : join(home, "Library/Application Support/emend");
  // The words the old install wrote: ExecStart, or ProgramArguments, then the state folder it pinned.
  const oldUnit = (options: string[] = [], stateDir = defaultOldState()) =>
    platform === "linux"
      ? `# written by emend
[Unit]
Description=emend review server

[Service]
Type=exec
ExecStart=/usr/bin/node "/opt/e mend/entry.mjs" serve ${options.join(" ")}
Environment="EMEND_HOME=${stateDir}"
Restart=on-failure

[Install]
WantedBy=default.target
`
      : `<?xml version="1.0" encoding="UTF-8"?>
<!-- written by emend -->
<plist version="1.0">
<dict>
  <key>ProgramArguments</key>
  <array>
${["/usr/bin/node", "/opt/e &amp; mend/entry.mjs", "serve", ...options].map((word) => `    <string>${word}</string>`).join("\n")}
  </array>
  <key>EnvironmentVariables</key>
  <dict>
    <key>EMEND_HOME</key>
    <string>${stateDir}</string>
  </dict>
</dict>
</plist>
`;
  const stopCall = () =>
    platform === "linux" ? systemctl("stop", "emend") : launchctl("bootout", "gui/501/dev.emend.server");
  const startCall = () =>
    platform === "linux" ? systemctl("start", "emend") : launchctl("bootstrap", "gui/501", oldPath());
  const removeCalls = () => (platform === "linux" ? [systemctl("disable", "emend"), systemctl("daemon-reload")] : []);
  // The old server: running until it is stopped, and for `lag` more status checks after that.
  let stopped: boolean;
  let lag: number;
  let holders: number[];
  const oldPid = 123;
  beforeEach(() => {
    options.platform = platform;
    stopped = false;
    lag = 0;
    holders = [];
    recorded.mockImplementation(async (_file, args) => {
      const line = args.join(" ");
      if (line === "--user stop emend" || line === "bootout gui/501/dev.emend.server") {
        stopped = true;
        return ok;
      }
      const running = !stopped || lag-- > 0;
      if (line === "--user is-active emend") return running ? ok : { ...failed, code: 3 };
      if (line === "--user show --property=MainPID --value emend")
        return { ...ok, stdout: `${running ? oldPid : 0}\n` };
      if (line === "print gui/501/dev.emend.server")
        return running ? { ...ok, stdout: `gui/501/dev.emend.server = {\n\tpid = ${oldPid}\n}\n` } : failed;
      return args[0] === "print" ? failed : ok;
    });
    options.holders = () => holders;
  });
  const oldFiles = async (folder = state) => {
    await writeFile(join(folder, "emend.db"), "db");
    await writeFile(join(folder, "emend.db-wal"), "wal");
  };

  test("install stops the old service first, installs the new one, then removes the old one", async () => {
    await put(oldPath(), oldUnit());
    expect(await invoke("install")).toBe(0);
    await expect(lstat(oldPath())).rejects.toMatchObject({ code: "ENOENT" });
    expect(
      (await readFile(newPath(), "utf8")).startsWith(platform === "linux" ? "# written by recense\n" : "<?xml"),
    ).toBe(true);
    const log = calls().map((call) => call.join(" "));
    const at = (call: string[]) => log.indexOf(call.join(" "));
    expect(at(stopCall())).toBeGreaterThanOrEqual(0);
    expect(at(stopCall())).toBeLessThan(log.indexOf("waitForServer"));
    for (const call of removeCalls())
      expect(log.lastIndexOf(call.join(" "))).toBeGreaterThan(log.indexOf("waitForServer"));
    expect(stdout).toContain("recense: removed the old emend service; the recense service replaces it\n");
    expect(stderr).toEqual([]);
  });

  test("a file of that name that emend did not write is left alone", async () => {
    await put(oldPath(), "# planted by someone else\n");
    expect(await invoke("install")).toBe(0);
    expect(await readFile(oldPath(), "utf8")).toBe("# planted by someone else\n");
    expect(calls()).not.toContainEqual(stopCall());
  });

  test("status says that the old service is still installed, and changes nothing", async () => {
    await put(oldPath(), oldUnit());
    expect(await invoke("status")).toBe(0);
    expect(stdout.join("")).toContain("the old emend service is still installed; run recense service install");
    expect(await readFile(oldPath(), "utf8")).toBe(oldUnit());
    expect(calls().flat().join(" ")).not.toMatch(/disable|bootout|stop/);
  });

  test("uninstall removes the old service too, also without a new one", async () => {
    await put(oldPath(), oldUnit());
    expect(await invoke("uninstall")).toBe(0);
    await expect(lstat(oldPath())).rejects.toMatchObject({ code: "ENOENT" });
    expect(calls()).toContainEqual(stopCall());
    for (const call of removeCalls()) expect(calls()).toContainEqual(call);
    expect(stdout.join("")).toContain("removed the old emend service");
    expect(stdout.join("")).toContain("the service is not installed");
  });

  test("an old service that does not stop is left as it was, and nothing moves", async () => {
    await put(oldPath(), oldUnit());
    await oldFiles();
    lag = 10000;
    expect(await invoke("install", "--port", "4000")).toBe(1);
    expect(stderr.join("")).toContain("the old emend service did not stop; it was left as it was");
    expect(await readFile(oldPath(), "utf8")).toBe(oldUnit());
    await expect(lstat(newPath())).rejects.toMatchObject({ code: "ENOENT" });
    expect(await readFile(join(state, "emend.db"), "utf8")).toBe("db");
  });

  test("the handover waits for the old service to stop before it moves anything", async () => {
    await put(oldPath(), oldUnit());
    await oldFiles();
    lag = 3;
    // The old server's process holds the database until it is gone.
    options.holders = () => (stopped && lag > 0 ? [oldPid] : []);
    expect(await invoke("install")).toBe(0);
    expect(sleep).toHaveBeenCalled();
    expect(await readFile(join(state, "recense.db"), "utf8")).toBe("db");
    expect(await readFile(join(state, "recense.db-wal"), "utf8")).toBe("wal");
    await expect(lstat(join(state, "emend.db"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  test("another process that holds the old database stops the handover before the old service stops", async () => {
    await put(oldPath(), oldUnit());
    await oldFiles();
    holders = [777];
    expect(await invoke("install")).toBe(1);
    expect(stderr.join("")).toContain("pid 777");
    expect(calls()).not.toContainEqual(stopCall());
    expect(await readFile(oldPath(), "utf8")).toBe(oldUnit());
    expect(await readFile(join(state, "emend.db"), "utf8")).toBe("db");
  });

  test("the old service's own process may hold the database until it stops", async () => {
    await put(oldPath(), oldUnit());
    await oldFiles();
    options.holders = () => (stopped ? [] : [oldPid]);
    expect(await invoke("install")).toBe(0);
    expect(await readFile(join(state, "recense.db"), "utf8")).toBe("db");
  });

  test("a move refused after the old service stopped starts the old service again", async () => {
    await put(oldPath(), oldUnit(["--port", "4000"]));
    await oldFiles();
    // A holder shows up only after the old service is stopped.
    options.holders = () => (stopped ? [888] : []);
    expect(await invoke("install")).toBe(1);
    expect(stderr.join("")).toContain("pid 888");
    expect(calls()).toContainEqual(startCall());
    expect(await readFile(oldPath(), "utf8")).toBe(oldUnit(["--port", "4000"]));
    await expect(lstat(newPath())).rejects.toMatchObject({ code: "ENOENT" });
    // A rerun, once the holder is gone, still finds the old options.
    resetOutput();
    options.holders = () => [];
    expect(await invoke("install")).toBe(0);
    expect(JSON.parse(await readFile(optionsPath(), "utf8"))).toEqual(["--port", "4000"]);
  });

  test("a failure before the new unit is written starts the old service again, and a rerun keeps the options", async () => {
    await put(oldPath(), oldUnit(["--port", "4000", "--tailscale"]));
    vi.mocked(writeService).mockRejectedValueOnce(new CliError("synthetic write failure"));
    expect(await invoke("install")).toBe(1);
    expect(calls()).toContainEqual(startCall());
    expect(await readFile(oldPath(), "utf8")).toBe(oldUnit(["--port", "4000", "--tailscale"]));
    await expect(lstat(newPath())).rejects.toMatchObject({ code: "ENOENT" });
    resetOutput();
    expect(await invoke("install")).toBe(0);
    expect(stdout).toEqual(expect.arrayContaining(installedOutput(publicUrl)));
    expect(JSON.parse(await readFile(optionsPath(), "utf8"))).toEqual(["--port", "4000", "--tailscale"]);
    await expect(lstat(oldPath())).rejects.toMatchObject({ code: "ENOENT" });
  });

  test("a failure after the new unit is written leaves it with the old options, and a rerun keeps them", async () => {
    await put(oldPath(), oldUnit(["--port", "4000", "--tailscale"]));
    waitForServer.mockResolvedValueOnce(null);
    expect(await invoke("install")).toBe(1);
    // The new unit exists with the inherited options; the old service is not started again.
    expect(await readFile(newPath(), "utf8")).toContain("4000");
    expect(JSON.parse(await readFile(optionsPath(), "utf8"))).toEqual(["--port", "4000", "--tailscale"]);
    expect(calls()).not.toContainEqual(startCall());
    expect(await readFile(oldPath(), "utf8")).toBe(oldUnit(["--port", "4000", "--tailscale"]));
    resetOutput();
    expect(await invoke("install")).toBe(0);
    expect(stdout).toEqual(expect.arrayContaining(installedOutput(publicUrl)));
    expect(JSON.parse(await readFile(optionsPath(), "utf8"))).toEqual(["--port", "4000", "--tailscale"]);
    expect(await readFile(newPath(), "utf8")).toContain("tailscale");
    await expect(lstat(oldPath())).rejects.toMatchObject({ code: "ENOENT" });
  });

  test("an install without options keeps the options of the old service", async () => {
    await put(oldPath(), oldUnit(["--port", "4000", "--tailscale", "--tailscale-port", "8443"]));
    expect(await invoke("install")).toBe(0);
    expect(stdout).toEqual(expect.arrayContaining(installedOutput(publicUrl)));
    expect(await readFile(newPath(), "utf8")).toContain(
      platform === "linux"
        ? "serve --port 4000 --tailscale --tailscale-port 8443\n"
        : "<string>--port</string>\n    <string>4000</string>\n    <string>--tailscale</string>",
    );
    expect(JSON.parse(await readFile(optionsPath(), "utf8"))).toEqual([
      "--port",
      "4000",
      "--tailscale",
      "--tailscale-port",
      "8443",
    ]);
    expect(stdout).toContain(
      "recense: keeping the options of the old emend service: --port 4000 --tailscale --tailscale-port 8443\n",
    );
    // The old service is stopped before the new one starts, so its port is free.
    const calling = calls().flat().join(" ");
    expect(calling.indexOf(platform === "linux" ? "stop emend" : "dev.emend.server")).toBeLessThan(
      calling.indexOf(platform === "linux" ? "start recense" : "bootstrap"),
    );
  });

  test("an old service with no options gives the new one the defaults", async () => {
    await put(oldPath(), oldUnit());
    expect(await invoke("install")).toBe(0);
    expect(JSON.parse(await readFile(optionsPath(), "utf8"))).toEqual([]);
    expect(stdout.join("")).not.toContain("keeping the options");
  });

  test("options given on the command line win over the old ones", async () => {
    await put(oldPath(), oldUnit(["--port", "4000"]));
    expect(await invoke("install", "--port", "4100")).toBe(0);
    expect(JSON.parse(await readFile(optionsPath(), "utf8"))).toEqual(["--port", "4100"]);
  });

  test("an existing recense service keeps its own saved options", async () => {
    expect(await invoke("install", "--port", "4200")).toBe(0);
    await put(oldPath(), oldUnit(["--port", "4000"]));
    resetOutput();
    expect(await invoke("install")).toBe(0);
    expect(JSON.parse(await readFile(optionsPath(), "utf8"))).toEqual(["--port", "4200"]);
    await expect(lstat(oldPath())).rejects.toMatchObject({ code: "ENOENT" });
  });

  test("options that cannot be read leave the old service running and ask for them", async () => {
    await put(oldPath(), oldUnit(["--bogus", "1"]));
    expect(await invoke("install")).toBe(1);
    expect(stderr.join("")).toContain("could not read the options of the old emend service, so it was left running");
    expect(await readFile(oldPath(), "utf8")).toBe(oldUnit(["--bogus", "1"]));
    expect(calls()).toEqual([]);
    // With the options given, the install goes ahead.
    resetOutput();
    expect(await invoke("install", "--port", "4000")).toBe(0);
    await expect(lstat(oldPath())).rejects.toMatchObject({ code: "ENOENT" });
  });

  test("a node path a systemd unit cannot run leaves the old service running", async () => {
    if (platform !== "linux") return;
    await put(oldPath(), oldUnit(["--port", "4000"]));
    options.node = join(home, "no'de");
    await writeFile(options.node, "synthetic node");
    expect(await invoke("install")).toBe(1);
    expect(stderr.join("")).toContain("node path contains");
    expect(calls()).not.toContainEqual(stopCall());
    expect(await readFile(oldPath(), "utf8")).toBe(oldUnit(["--port", "4000"]));
  });

  test("a state folder pinned by the old service is named when the shell chooses another", async () => {
    await put(oldPath(), oldUnit([], join(root, "custom-old-state")));
    expect(await invoke("install")).toBe(0);
    expect(stdout.join("")).toContain(`the old emend service used the state folder ${join(root, "custom-old-state")}`);
    expect(stdout.join("")).toContain(`set RECENSE_HOME=${join(root, "custom-old-state")}`);
  });

  test("a state folder pinned by the old service carries over as RECENSE_HOME, with its database renamed", async () => {
    const custom = join(root, "custom-old-state");
    await mkdir(custom, { mode: 0o700 });
    await oldFiles(custom);
    await put(oldPath(), oldUnit(["--port", "4000"], custom));
    delete io.env.RECENSE_HOME;
    await serviceCommand(join(root, "default-state"), ["install"], io);
    const unit = await readFile(newPath(), "utf8");
    expect(unit).toContain(platform === "linux" ? `RECENSE_HOME=${custom}` : `<string>${custom}</string>`);
    expect(unit).not.toContain("default-state");
    expect(JSON.parse(await readFile(join(custom, "service.json"), "utf8"))).toEqual(["--port", "4000"]);
    expect(await readFile(join(custom, "recense.db"), "utf8")).toBe("db");
    await expect(lstat(join(custom, "emend.db"))).rejects.toMatchObject({ code: "ENOENT" });
    expect(stdout.join("")).toContain("keeps using it");
  });
});
