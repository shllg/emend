import { access, chmod, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, onTestFinished, test, vi } from "vitest";
import { testDb } from "../../db/test-support.ts";
import { run } from "../../main.ts";
import { writeSecretFile } from "../../state/files.ts";
import * as credentials from "../../state/token-file.ts";
import { VERSION } from "../../version.ts";
import { escapeReference } from "../escape.ts";
import { ensureServer } from "../server-client.ts";
import { commandFixture, provenTestServer } from "../test-support.ts";

vi.mock("../server-client.ts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../server-client.ts")>()),
  ensureServer: vi.fn().mockResolvedValue({ url: "http://127.0.0.1:3636" }),
}));
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  vi.clearAllMocks();
});

const updateUrl = "https://github.com/shllg/emend/blob/release/docs/setup/update.md";
const localUrl = "http://127.0.0.1:3636";

async function openFixture() {
  const fixture = await testDb();
  const configHome = await mkdtemp(join(tmpdir(), "emend-config-"));
  onTestFinished(() => rm(configHome, { recursive: true, force: true }));
  return { ...fixture, configHome, configDir: join(configHome, "emend") };
}

async function versionFixture(version: string) {
  const f = await commandFixture();
  writeSecretFile(join(f.configDir, "config.json"), JSON.stringify({ openBrowser: false }));
  f.io.service = { platform: "linux", home: f.dir, uid: 501 };
  const proof = provenTestServer(f.dir);
  f.fetcher.mockImplementation(async (url, init) => {
    const response = proof(url, init);
    return response
      ? Response.json({ api: 1, version, features: [] }, { headers: response.headers })
      : Response.json({ items: [] });
  });
  return f;
}

async function attach(f: Awaited<ReturnType<typeof commandFixture>>) {
  const url = "https://hub.example.test";
  writeSecretFile(
    join(f.dir, "attach.json"),
    JSON.stringify({
      hubId: "11111111-1111-4111-8111-111111111111",
      hubName: "Synthetic hub",
      hubUrl: url,
    }),
  );
  return url;
}

test.each([VERSION, "0.0.9", "0.10.0", "0.1.0-dev", "00.1.0", "0.1.0\n\u001b[31m"])(
  "bare emend reports local version %j without changing stdout",
  async (version) => {
    const f = await versionFixture(version);
    const readCredential = vi.spyOn(credentials, "readTokenFile");
    expect(await run([], f.io)).toBe(0);
    expect(f.stdout).toEqual([`emend is running at ${localUrl}. Run emend in a terminal to get a sign-in link.\n`]);
    expect(f.stderr).toEqual(
      version === VERSION
        ? []
        : [
            version === "0.10.0"
              ? `emend: the emend server at ${localUrl} runs emend ${version}, newer than this emend ${VERSION}; update emend: ${updateUrl}\n`
              : `emend: the emend server at ${localUrl} runs emend ${escapeReference(version)}; this is emend ${VERSION}. Run emend stop, then emend, to start emend ${VERSION}.\n`,
          ],
    );
    expect(readCredential).not.toHaveBeenCalled();
    expect(f.fetcher.mock.calls.every(([, init]) => !new Headers(init?.headers).has("Authorization"))).toBe(true);
  },
);

test.each(["matching", "failed-query", "missing-tool"])(
  "bare emend checks service ownership (%s) before advising a restart",
  async (kind) => {
    const f = await versionFixture("0.0.9");
    const directory = join(f.io.env.XDG_CONFIG_HOME as string, "systemd", "user");
    await mkdir(directory, { recursive: true });
    await writeFile(join(directory, "emend.service"), "# written by emend\n");
    await writeFile(join(f.dir, "systemctl"), "synthetic executable\n", { mode: 0o755 });
    f.io.env.PATH = kind === "missing-tool" ? "" : f.dir;
    const runner = vi.fn(async () => ({
      code: kind === "failed-query" ? 1 : 0,
      stdout: `${process.pid}\n`,
      stderr: "",
    }));
    if (f.io.service) f.io.service.runner = runner;
    expect(await run([], f.io)).toBe(0);
    expect(f.stdout).toEqual([`emend is running at ${localUrl}. Run emend in a terminal to get a sign-in link.\n`]);
    expect(f.stderr).toEqual(
      kind === "matching"
        ? [
            `emend: the emend server at ${localUrl} runs emend 0.0.9; this is emend ${VERSION}. Run emend service install to restart it on emend ${VERSION}.\n`,
          ]
        : [],
    );
  },
);

test.each(["unverified", "unreachable"])("bare emend ignores a %s version probe", async (kind) => {
  const f = await versionFixture("0.0.9");
  f.fetcher.mockImplementation(async () => {
    if (kind === "unreachable") throw new TypeError("synthetic unavailable server");
    return Response.json({ api: 1, version: "0.0.9", features: [] });
  });
  expect(await run([], f.io)).toBe(0);
  expect(f.stderr).toEqual([]);
  expect(f.stdout).toEqual([`emend is running at ${localUrl}. Run emend in a terminal to get a sign-in link.\n`]);
});

test.each([
  [VERSION, ""],
  ["0.0.9", "Update the hub"],
  ["0.10.0", "Update this machine"],
  ["snapshot\n\u001b[31m", "Update both to the same version"],
  ["0.1.0\n", "Update both to the same version"],
])("attached emend reports hub version %j", async (version, action) => {
  const f = await versionFixture(version);
  const url = await attach(f);
  const readCredential = vi.spyOn(credentials, "readTokenFile");
  expect(await run([], f.io)).toBe(0);
  expect(f.stdout).toEqual([`${url}\n`]);
  expect(f.stderr).toEqual(
    action
      ? [
          `emend: the hub at ${url} runs emend ${escapeReference(version)}; this machine runs emend ${VERSION}. ${action}: ${updateUrl}\n`,
        ]
      : [],
  );
  expect(readCredential).not.toHaveBeenCalled();
  expect(f.fetcher).toHaveBeenCalledOnce();
  expect(f.fetcher.mock.calls[0]?.[0]).toBe(`${url}/api/v1/capabilities`);
  expect(new Headers(f.fetcher.mock.calls[0]?.[1]?.headers).has("Authorization")).toBe(false);
});

test.each(["unreachable", "timeout", "invalid-json"])("attached emend ignores a hub %s", async (kind) => {
  const f = await versionFixture("0.0.9");
  const url = await attach(f);
  f.fetcher.mockImplementation(async () => {
    if (kind === "timeout") throw new DOMException("synthetic timeout", "TimeoutError");
    if (kind === "unreachable") throw new TypeError("synthetic unreachable hub");
    return new Response("{");
  });
  expect(await run([], f.io)).toBe(0);
  expect(f.stdout).toEqual([`${url}\n`]);
  expect(f.stderr).toEqual([]);
});

test("attached emend opens the browser while the version probe is pending", async () => {
  const f = await versionFixture("0.0.9");
  const url = await attach(f);
  writeSecretFile(join(f.configDir, "config.json"), JSON.stringify({ openBrowser: true }));
  const opened = Promise.withResolvers<void>();
  f.fetcher.mockImplementation(async () => {
    await opened.promise;
    return Response.json({ api: 1, version: "0.0.9", features: [] });
  });
  f.io.openUrl = async () => {
    opened.resolve();
    return true;
  };
  expect(await run([], f.io)).toBe(0);
  expect(f.stdout).toEqual(["Opening emend in your browser.\n"]);
  expect(f.stderr).toEqual([
    `emend: the hub at ${url} runs emend 0.0.9; this machine runs emend ${VERSION}. Update the hub: ${updateUrl}\n`,
  ]);
});

test("ls against an older server prints no version notice", async () => {
  const f = await versionFixture("0.0.9");
  expect(await run(["ls", "--json"], f.io)).toBe(0);
  expect(f.stderr).toEqual([]);
  expect(f.stdout).toEqual(['{"items":[]}\n']);
});

test.each(["pairing", "token-mode"])("an older server plus a %s failure prints only the error", async (failure) => {
  const f = await versionFixture("0.0.9");
  const path = join(f.dir, "admin.token");
  writeSecretFile(path, `em_${"a".repeat(43)}`);
  if (failure === "token-mode") await chmod(path, 0o644);
  const normal = f.fetcher.getMockImplementation();
  f.fetcher.mockImplementation(async (url, init) => {
    if (String(url).endsWith("/pairings")) throw new TypeError("synthetic pairing failure");
    if (!normal) throw new Error("Missing fixture response");
    return normal(url, init);
  });
  expect(await run([], { ...f.io, isTTY: true })).toBe(1);
  expect(f.stdout).toEqual([]);
  expect(f.stderr).toEqual([
    failure === "pairing"
      ? "emend: Could not contact the emend server.\n"
      : `Token file ${path} has group or other permissions; fix it with chmod 600 '${path}'\n`,
  ]);
});

test("bare emend prints version advice after its successful stdout line", async () => {
  const f = await versionFixture("0.0.9");
  const order: string[] = [];
  const stdout = f.io.stdout;
  const stderr = f.io.stderr;
  f.io.stdout = (line) => {
    order.push("stdout");
    stdout(line);
  };
  f.io.stderr = (line) => {
    order.push("stderr");
    stderr(line);
  };
  expect(await run([], f.io)).toBe(0);
  expect(order).toEqual(["stdout", "stderr"]);
});

test("an unanswered hub version probe uses a one-second abort signal", async () => {
  const f = await versionFixture("0.0.9");
  const url = await attach(f);
  const controller = new AbortController();
  const timeout = AbortSignal.timeout;
  const deadlines = vi
    .spyOn(AbortSignal, "timeout")
    .mockImplementation((ms) => (ms === 1000 ? controller.signal : timeout(ms)));
  const entered = Promise.withResolvers<void>();
  const answer = Promise.withResolvers<Response>();
  f.fetcher.mockImplementation(async (_url, init) => {
    init?.signal?.addEventListener("abort", () => answer.reject(init.signal?.reason), { once: true });
    entered.resolve();
    return answer.promise;
  });
  const command = run([], f.io);
  await entered.promise;
  try {
    expect(deadlines).toHaveBeenCalledWith(1000);
    controller.abort(new DOMException("synthetic deadline", "TimeoutError"));
    expect(await command).toBe(0);
    expect(f.stdout).toEqual([`${url}\n`]);
    expect(f.stderr).toEqual([]);
  } finally {
    answer.reject(new DOMException("fixture cleanup", "AbortError"));
    await command;
  }
});
test.each(
  [true, false, undefined].flatMap((isTTY) => [
    { isTTY, openBrowser: undefined, opened: true },
    { isTTY, openBrowser: false, opened: true },
    { isTTY, openBrowser: true, opened: true },
    { isTTY, openBrowser: true, opened: false },
    { isTTY, openBrowser: true, opened: "throws" },
  ]),
)(
  "no arguments with isTTY=$isTTY, openBrowser=$openBrowser and opener result $opened",
  async ({ isTTY, openBrowser, opened }) => {
    const fixture = await openFixture();
    try {
      if (openBrowser !== undefined)
        writeSecretFile(join(fixture.configDir, "config.json"), JSON.stringify({ openBrowser }));
      writeSecretFile(join(fixture.dir, "admin.token"), `em_${"a".repeat(43)}`);
      const url = `http://127.0.0.1:3636/pair#emp_${"b".repeat(43)}`;
      const proof = provenTestServer(fixture.dir);
      const pairings = vi.fn(async () =>
        Response.json({ url, code: "ABCD-2345", expiresAt: "2026-01-01T00:10:00.000Z" }),
      );
      vi.stubGlobal(
        "fetch",
        vi.fn(async (target: string | URL, init?: RequestInit) => {
          const response = proof(target, init);
          if (response) return response;
          expect(String(target)).toBe("http://127.0.0.1:3636/api/v1/pairings");
          expect(init?.method).toBe("POST");
          expect(JSON.parse(String(init?.body))).toEqual({ purpose: "device" });
          return pairings();
        }),
      );
      const stdout: string[] = [];
      const stderr: string[] = [];
      const openUrl = vi.fn(async () => {
        expect(pairings).toHaveBeenCalledOnce();
        if (opened === "throws") throw new Error("opener failed");
        return opened === true;
      });
      const code = await run([], {
        isTTY,
        stdout: (s) => stdout.push(s),
        stderr: (s) => stderr.push(s),
        env: { EMEND_HOME: fixture.dir, XDG_CONFIG_HOME: fixture.configHome },
        openUrl,
      });
      expect(code).toBe(0);
      expect(stderr).toEqual([]);
      expect(ensureServer).toHaveBeenCalledWith(fixture.dir, {
        env: expect.objectContaining({ XDG_CONFIG_HOME: fixture.configHome }),
      });
      expect(pairings).toHaveBeenCalledTimes(openBrowser || isTTY ? 1 : 0);
      if (openBrowser) expect(openUrl).toHaveBeenCalledExactlyOnceWith(url);
      else expect(openUrl).not.toHaveBeenCalled();
      expect(stdout).toEqual([
        openBrowser && opened === true
          ? "Opening emend in your browser.\n"
          : isTTY
            ? `Open this link within 10 minutes: ${url}\n`
            : "emend is running at http://127.0.0.1:3636. Run emend in a terminal to get a sign-in link.\n",
      ]);
    } finally {
      await fixture.cleanup();
    }
  },
);

test("an HTTP failure is one stderr line, no stdout and exit 1", async () => {
  const fixture = await openFixture();
  try {
    writeSecretFile(join(fixture.dir, "admin.token"), `em_${"a".repeat(43)}`);
    const proof = provenTestServer(fixture.dir);
    vi.stubGlobal(
      "fetch",
      vi.fn(async (target: string | URL, init?: RequestInit) => {
        const response = proof(target, init);
        if (response) return response;
        throw new Error("private connection details");
      }),
    );
    const stdout: string[] = [];
    const stderr: string[] = [];
    expect(
      await run([], {
        isTTY: true,
        stdout: (s) => stdout.push(s),
        stderr: (s) => stderr.push(s),
        env: { EMEND_HOME: fixture.dir, XDG_CONFIG_HOME: fixture.configHome },
        openUrl: async () => true,
      }),
    ).toBe(1);
    expect(stdout).toEqual([]);
    expect(stderr).toEqual(["emend: Could not contact the emend server.\n"]);
  } finally {
    await fixture.cleanup();
  }
});

test("bare emend rewrites a public pairing link to the discovered loopback origin", async () => {
  const fixture = await openFixture();
  try {
    writeSecretFile(join(fixture.configDir, "config.json"), JSON.stringify({ openBrowser: true }));
    writeSecretFile(join(fixture.dir, "admin.token"), `em_${"a".repeat(43)}`);
    const secret = `emp_${"c".repeat(43)}`;
    const proof = provenTestServer(fixture.dir);
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async (target: string | URL, init?: RequestInit) =>
          proof(target, init) ??
          Response.json({
            url: `https://hub.example.ts.net/pair#${secret}`,
            code: "ABCD-2345",
            expiresAt: "2026-01-01T00:10:00.000Z",
          }),
      ),
    );
    const openUrl = vi.fn(async () => true);
    expect(
      await run([], {
        stdout: () => {},
        stderr: () => {},
        env: { EMEND_HOME: fixture.dir, XDG_CONFIG_HOME: fixture.configHome },
        openUrl,
      }),
    ).toBe(0);
    expect(openUrl).toHaveBeenCalledWith(`http://127.0.0.1:3636/pair#${secret}`);
  } finally {
    await fixture.cleanup();
  }
});

test.each(
  [true, false].flatMap((isTTY) => [
    { isTTY, openBrowser: undefined, opened: true },
    { isTTY, openBrowser: false, opened: true },
    { isTTY, openBrowser: true, opened: true },
    { isTTY, openBrowser: true, opened: false },
    { isTTY, openBrowser: true, opened: "throws" },
  ]),
)(
  "attached with isTTY=$isTTY, openBrowser=$openBrowser and opener result $opened",
  async ({ isTTY, openBrowser, opened }) => {
    const f = await commandFixture();
    const hubUrl = "https://hub.example.test";
    writeSecretFile(
      join(f.dir, "attach.json"),
      JSON.stringify({
        hubId: "11111111-1111-4111-8111-111111111111",
        hubName: "Synthetic hub",
        hubUrl,
      }),
    );
    if (openBrowser !== undefined) writeSecretFile(join(f.configDir, "config.json"), JSON.stringify({ openBrowser }));
    const openUrl = vi.fn(async () => {
      if (opened === "throws") throw new Error("opener failed");
      return opened === true;
    });
    expect(await run([], { ...f.io, isTTY, openUrl })).toBe(0);
    expect(f.stderr).toEqual([]);
    expect(f.stdout).toEqual([openBrowser && opened === true ? "Opening emend in your browser.\n" : `${hubUrl}\n`]);
    if (openBrowser) expect(openUrl).toHaveBeenCalledExactlyOnceWith(hubUrl);
    else expect(openUrl).not.toHaveBeenCalled();
    expect(ensureServer).not.toHaveBeenCalled();
    expect(f.fetcher).toHaveBeenCalledOnce();
    expect(f.fetcher.mock.calls[0]?.[0]).toBe(`${hubUrl}/api/v1/capabilities`);
    expect(new Headers(f.fetcher.mock.calls[0]?.[1]?.headers).has("Authorization")).toBe(false);
  },
);

test("invalid configuration fails before starting a server or opening a browser", async () => {
  const f = await commandFixture();
  writeSecretFile(join(f.configDir, "config.json"), JSON.stringify({ openBrowser: "true" }));
  const openUrl = vi.fn(async () => true);
  expect(await run([], { ...f.io, isTTY: true, openUrl })).toBe(1);
  expect(f.stdout).toEqual([]);
  expect(f.stderr).toEqual([`emend: invalid emend configuration in ${join(f.configDir, "config.json")}\n`]);
  expect(ensureServer).not.toHaveBeenCalled();
  expect(openUrl).not.toHaveBeenCalled();
  expect(f.fetcher).not.toHaveBeenCalled();
});

test.each([false, undefined])(
  "no terminal (%s) needs no admin credential when browser opening is disabled",
  async (isTTY) => {
    const f = await commandFixture();
    writeSecretFile(join(f.configDir, "config.json"), JSON.stringify({ openBrowser: false }));
    await expect(access(join(f.dir, "admin.token"))).rejects.toMatchObject({ code: "ENOENT" });
    const readCredential = vi.spyOn(credentials, "readTokenFile");
    const openUrl = vi.fn(async () => true);
    expect(await run([], { ...f.io, isTTY, openUrl })).toBe(0);
    expect(f.stdout).toEqual([
      "emend is running at http://127.0.0.1:3636. Run emend in a terminal to get a sign-in link.\n",
    ]);
    expect(f.stderr).toEqual([]);
    expect(ensureServer).toHaveBeenCalledWith(f.dir, { env: f.io.env });
    expect(readCredential).not.toHaveBeenCalled();
    expect(f.fetcher).toHaveBeenCalledOnce();
    expect(f.fetcher.mock.calls[0]?.[0]).toBe(`${localUrl}/api/v1/capabilities`);
    expect(new Headers(f.fetcher.mock.calls[0]?.[1]?.headers).has("Authorization")).toBe(false);
    expect(openUrl).not.toHaveBeenCalled();
  },
);

test.each(
  [false, undefined].flatMap(
    (isTTY) =>
      [
        { isTTY, platform: "linux", env: {} },
        { isTTY, platform: "linux", env: { DISPLAY: "", WAYLAND_DISPLAY: "" } },
        { isTTY, platform: "linux", env: { DISPLAY: ":0", PATH: "relative" } },
        { isTTY, platform: "darwin", env: { PATH: "relative" } },
        { isTTY, platform: "freebsd", env: { DISPLAY: ":0" } },
      ] as const,
  ),
)(
  "browser opt-in with no terminal ($isTTY) and no available opener on $platform: $env",
  async ({ isTTY, platform, env }) => {
    const f = await commandFixture();
    writeSecretFile(join(f.configDir, "config.json"), JSON.stringify({ openBrowser: true }));
    vi.spyOn(process, "platform", "get").mockReturnValue(platform);
    const readCredential = vi.spyOn(credentials, "readTokenFile");
    expect(await run([], { ...f.io, isTTY, env: { ...f.io.env, ...env } })).toBe(0);
    expect(f.stdout).toEqual([
      "emend is running at http://127.0.0.1:3636. Run emend in a terminal to get a sign-in link.\n",
    ]);
    expect(f.stderr).toEqual([]);
    expect(ensureServer).toHaveBeenCalledWith(f.dir, { env: { ...f.io.env, ...env } });
    expect(readCredential).not.toHaveBeenCalled();
    expect(f.fetcher).toHaveBeenCalledOnce();
    expect(f.fetcher.mock.calls[0]?.[0]).toBe(`${localUrl}/api/v1/capabilities`);
    expect(new Headers(f.fetcher.mock.calls[0]?.[1]?.headers).has("Authorization")).toBe(false);
  },
);

test("bare emend ignores a repository's browser opt-in and warns once", async () => {
  const f = await commandFixture();
  const repo = join(f.dir, "repo");
  await mkdir(join(repo, ".git"), { recursive: true });
  await writeFile(join(repo, ".git", "HEAD"), "ref: refs/heads/main\n");
  const configHome = join(repo, ".config"),
    configFile = join(configHome, "emend", "config.json");
  await mkdir(join(configHome, "emend"), { recursive: true });
  await writeFile(configFile, '{"openBrowser":true}');
  vi.spyOn(process, "cwd").mockReturnValue(repo);
  const openUrl = vi.fn(async () => true);
  expect(await run([], { ...f.io, env: { ...f.io.env, XDG_CONFIG_HOME: configHome }, openUrl })).toBe(0);
  expect(f.stderr).toEqual([`emend: ignoring ${configFile}: it sits inside the repository at ${repo}\n`]);
  expect(openUrl).not.toHaveBeenCalled();
  expect(f.stdout).toEqual([
    "emend is running at http://127.0.0.1:3636. Run emend in a terminal to get a sign-in link.\n",
  ]);
});

test.each([false, true])("bare emend ignores repository state config (linked=%s)", async (linked) => {
  const f = await commandFixture();
  await mkdir(join(f.dir, ".git"));
  await writeFile(join(f.dir, ".git", "HEAD"), "ref: refs/heads/main\n");
  const old = join(f.dir, "config.json");
  const target = linked ? join(f.configDir, "legacy.json") : old;
  if (linked) {
    await mkdir(f.configDir);
    await symlink(target, old);
  }
  const content = '{"docRoots":["/synthetic/docs"],"openBrowser":true}';
  await writeFile(target, content);
  vi.spyOn(process, "cwd").mockReturnValue(f.dir);
  const openUrl = vi.fn(async () => true);
  expect(await run([], { ...f.io, openUrl })).toBe(0);
  expect(f.stderr).toEqual([]);
  expect(openUrl).not.toHaveBeenCalled();
  expect(f.stdout).toEqual([
    "emend is running at http://127.0.0.1:3636. Run emend in a terminal to get a sign-in link.\n",
  ]);
  expect(await readFile(old, "utf8")).toBe(content);
  await expect(access(`${old}.migrated`)).rejects.toMatchObject({ code: "ENOENT" });
  await expect(access(join(f.configDir, "config.json"))).rejects.toMatchObject({ code: "ENOENT" });
});
