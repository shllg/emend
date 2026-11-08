import assert from "node:assert/strict";
import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { PassThrough } from "node:stream";
import { fileURLToPath } from "node:url";
import { Browser } from "./screenshots/browser.ts";
import { applyFixture } from "./screenshots/content.ts";
import { writeImages } from "./screenshots/images.ts";
import {
  acceptsLoopbackConnection,
  assertInsideRoot,
  assertOutputFolder,
  assertPortAvailable,
  assertRequestAllowed,
  assertSafePort,
  assertSealedPaths,
  canonicalPath,
  childEnvironment,
  chromiumArgs,
  classifyTarget,
  filterPng,
  parsePairingLink,
  portProbeFailed,
  protectedStateDirs,
  requestAllowed,
  sealedOrigin,
  socketAllowed,
} from "./screenshots/safety.ts";

test("child environments contain only the allowlist and never inherit parent values", () => {
  const root = "/tmp/emend-screenshots-synthetic";
  const poisoned = {
    PATH: "/synthetic/parent/bin",
    HOME: "/synthetic/parent/home",
    XDG_CONFIG_HOME: "/synthetic/config",
    XDG_DATA_HOME: "/synthetic/data",
    XDG_STATE_HOME: "/synthetic/state",
    XDG_CACHE_HOME: "/synthetic/cache",
    XDG_RUNTIME_DIR: "/synthetic/runtime",
    TMPDIR: "/synthetic/tmp",
    EMEND_HOME: "/synthetic/emend",
    LANG: "synthetic",
    TZ: "synthetic",
    GIT_CONFIG_NOSYSTEM: "0",
    GIT_CONFIG_GLOBAL: "/synthetic/gitconfig",
    GIT_CONFIG_COUNT: "1",
    GIT_CONFIG_KEY_0: "core.hooksPath",
    GIT_CONFIG_VALUE_0: "/synthetic/hooks",
    GIT_DIR: "/synthetic/repo",
    GIT_WORK_TREE: "/synthetic/worktree",
    NODE_OPTIONS: "--require=/synthetic/injected.js",
    LD_PRELOAD: "/synthetic/injected.so",
    HTTP_PROXY: "http://example.invalid",
    HTTPS_PROXY: "http://example.invalid",
    ALL_PROXY: "http://example.invalid",
    CHROMIUM_PATH: "/synthetic/chromium",
    SCREENSHOTS_PARENT_ONLY: "synthetic",
  };
  const previous = Object.fromEntries(Object.keys(poisoned).map((key) => [key, process.env[key]]));
  try {
    Object.assign(process.env, poisoned);
    for (const platform of ["linux", "darwin"]) {
      assert.deepEqual(childEnvironment(root, platform), {
        PATH: platform === "darwin" ? "/usr/bin:/bin:/opt/homebrew/bin:/usr/local/bin" : "/usr/bin:/bin",
        HOME: join(root, "home"),
        XDG_CONFIG_HOME: join(root, "config"),
        XDG_DATA_HOME: join(root, "data"),
        XDG_STATE_HOME: join(root, "state"),
        XDG_CACHE_HOME: join(root, "cache"),
        XDG_RUNTIME_DIR: join(root, "runtime"),
        TMPDIR: join(root, "tmp"),
        EMEND_HOME: join(root, "emend"),
        LANG: "C.UTF-8",
        TZ: "UTC",
        GIT_CONFIG_NOSYSTEM: "1",
        GIT_CONFIG_GLOBAL: join(root, "gitconfig"),
      });
    }
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
  assert.throws(() => childEnvironment("relative", "linux"), /absolute/);
});

const home = "/synthetic/home";
const stateCases = [
  { name: "Linux default", platform: "linux", env: {}, expected: join(home, ".local/share/emend") },
  {
    name: "Linux XDG",
    platform: "linux",
    env: { XDG_DATA_HOME: "/synthetic/data" },
    expected: "/synthetic/data/emend",
    // The plain default stays protected even when XDG_DATA_HOME points elsewhere.
    alsoProtected: [join(home, ".local/share/emend")],
  },
  {
    name: "Linux relative XDG falls back to home",
    platform: "linux",
    env: { XDG_DATA_HOME: "relative" },
    expected: join(home, ".local/share/emend"),
  },
  {
    name: "macOS ignores XDG",
    platform: "darwin",
    env: { XDG_DATA_HOME: "/synthetic/data" },
    expected: join(home, "Library/Application Support/emend"),
  },
];

for (const scenario of stateCases) {
  test(`protects real state for ${scenario.name}, including containing and nested paths`, () => {
    const realStateDirs = protectedStateDirs(scenario.env, scenario.platform, home);
    assert.deepEqual(realStateDirs, [scenario.expected, ...(scenario.alsoProtected ?? [])]);
    for (const emendHome of [scenario.expected, join(scenario.expected, "nested"), resolve(scenario.expected, "..")]) {
      assert.throws(
        () => assertSealedPaths({ root: "/synthetic", tmpDir: "/", emendHome, realStateDirs }, resolve),
        /overlaps real emend state/,
      );
    }
  });
}

test("an explicit EMEND_HOME does not hide the default state directory", () => {
  for (const scenario of stateCases) {
    const dirs = protectedStateDirs({ ...scenario.env, EMEND_HOME: "/synthetic/override" }, scenario.platform, home);
    assert.deepEqual(dirs, [scenario.expected, ...(scenario.alsoProtected ?? []), "/synthetic/override"]);
    assert.throws(
      () => assertSealedPaths({ root: "/synthetic", tmpDir: "/", emendHome: "/synthetic/override", realStateDirs: dirs }, resolve),
      /overlaps real emend state/,
    );
  }
  assert.throws(() => protectedStateDirs({ EMEND_HOME: "relative" }, "linux", home), /absolute/);
});

test("root and EMEND_HOME guards require strict containment and protect the cleanup root", () => {
  const paths = {
    root: "/tmp/emend-screenshots-synthetic",
    tmpDir: "/tmp",
    emendHome: "/tmp/emend-screenshots-synthetic/emend",
    realStateDirs: ["/synthetic/emend"],
  };
  assert.doesNotThrow(() => assertSealedPaths(paths, resolve));
  for (const root of ["/tmp", "/tmp-other/demo", "/elsewhere", "/tmp/../elsewhere"]) {
    assert.throws(() => assertSealedPaths({ ...paths, root }, resolve), /inside the temporary directory/);
  }
  for (const emendHome of [paths.root, `${paths.root}-other/emend`, "/elsewhere/emend"]) {
    assert.throws(() => assertSealedPaths({ ...paths, emendHome }, resolve), /inside the sealed root/);
  }
  assert.throws(() => assertSealedPaths({ ...paths, root: "relative" }, resolve), /absolute/);
  assert.throws(() => assertSealedPaths({ ...paths, realStateDirs: [] }, resolve), /must be supplied/);
  assert.throws(
    () => assertSealedPaths({ ...paths, realStateDirs: [join(paths.root, "real-state")] }, resolve),
    /sealed root overlaps/,
  );
});

test("filesystem guards resolve symlinks, including ancestors of paths that do not yet exist", (t) => {
  const fixture = mkdtempSync(join(realpathSync(tmpdir()), "emend-screenshots-guard-"));
  t.after(() => rmSync(fixture, { recursive: true, force: true }));
  const temporary = join(fixture, "tmp");
  const outside = join(fixture, "outside");
  const root = join(temporary, "demo");
  mkdirSync(root, { recursive: true });
  mkdirSync(outside);
  const paths = { root, tmpDir: temporary, emendHome: join(root, "emend"), realStateDirs: [join(outside, "real")] };
  assert.doesNotThrow(() => assertSealedPaths(paths, canonicalPath));

  symlinkSync(outside, join(temporary, "escape"), "dir");
  assert.throws(
    () => assertSealedPaths({ ...paths, root: join(temporary, "escape", "missing") }, canonicalPath),
    /inside the temporary directory/,
  );
  symlinkSync(outside, join(root, "escape"), "dir");
  assert.throws(
    () => assertSealedPaths({ ...paths, emendHome: join(root, "escape", "missing") }, canonicalPath),
    /inside the sealed root/,
  );

  // Simulate the real state directory having an alias into the apparently sealed tree.
  symlinkSync(root, join(outside, "alias"), "dir");
  assert.throws(
    () => assertSealedPaths({ ...paths, realStateDirs: [join(outside, "alias", "emend")] }, canonicalPath),
    /overlaps real emend state/,
  );
  symlinkSync(join(outside, "missing"), join(root, "dangling"), "dir");
  assert.throws(() => canonicalPath(join(root, "dangling", "emend")), { code: "ENOENT" });
});

test("the port guard rejects the default, invalid ports and a port accepting connections", async () => {
  for (const port of [3636, 0, -1, 65536, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
    assert.throws(() => assertSafePort(port));
    await assert.rejects(assertPortAvailable(port, async () => assert.fail("must not probe an unsafe port")));
  }
  assert.throws(() => assertSafePort(49231, true), /already accepts connections/);
  await assert.rejects(assertPortAvailable(49231, async () => true), /already accepts connections/);
  await assertPortAvailable(49231, async (port) => {
    assert.equal(port, 49231);
    return false;
  });
  await assert.rejects(
    assertPortAvailable(49231, async () => { throw new Error("EPERM"); }),
    /EPERM/,
  );
});

const origin = sealedOrigin(49231);

// Fetch interception sees HTTP(S), data and blob requests only. WebSockets are checked by socketAllowed.
test("browser requests allow only the exact sealed origin, data and blob URLs", () => {
  for (const url of [origin, `${origin}/api/v1/reviews`, "data:text/plain,synthetic", `blob:${origin}/synthetic`]) {
    assert.equal(requestAllowed(url, origin), true, url);
  }
  for (const url of [
    "http://localhost:49231/reviews",
    "http://127.0.0.1:3636/reviews",
    "http://127.0.0.1:49232/reviews",
    "https://127.0.0.1:49231/reviews",
    "ws://127.0.0.1:49231/reviews",
    "file:///tmp/synthetic",
    "http://example.invalid/reviews",
    "http://127.0.0.1.example.invalid:49231/reviews",
    "http://user@127.0.0.1:49231/reviews",
    "/api/v1/reviews",
    "not a URL",
  ]) {
    assert.equal(requestAllowed(url, origin), false, url);
    assert.throws(() => assertRequestAllowed(url, origin), /Blocked screenshot request/);
  }
  for (const expected of ["http://127.0.0.1:3636", "https://127.0.0.1:49231", `${origin}/`, "invalid"]) {
    assert.throws(() => requestAllowed("data:text/plain,synthetic", expected), /sealed HTTP loopback origin/);
  }
  assert.throws(() => assertRequestAllowed("https://example.invalid/private#synthetic", origin), {
    message: "Blocked screenshot request to https://example.invalid",
  });
});

// Assemble a synthetic secret; no real pairing data is used in tests or diagnostics.
const fragment = `emp_${"a".repeat(43)}`;
const pair = `${origin}/pair#${fragment}`;

test("the pairing parser accepts TTY output without exposing the secret", () => {
  assert.equal(parsePairingLink(`\x1b[32m${pair}\x1b[0m\r\nValid for 10 minutes, once.\r\n`, origin), pair);
});

test("the pairing parser refuses another host, port, scheme, path or malformed secret", () => {
  for (const output of [
    pair.replace("127.0.0.1", "localhost"),
    pair.replace("127.0.0.1", "example.invalid"),
    pair.replace("49231", "3636"),
    pair.replace("49231", "49232"),
    pair.replace("http:", "https:"),
    pair.replace("http:", "ftp:"),
    pair.replace("/pair#", "/pair?query=synthetic#"),
    pair.replace("/pair#", "/pair/other#"),
    pair.replace("127.0.0.1", "user@127.0.0.1"),
    pair.replace(fragment, "synthetic"),
    `${pair}\n${pair}`,
    "no pairing link",
  ]) {
    assert.throws(() => parsePairingLink(output, origin), (error: Error) => {
      assert(!error.message.includes(fragment));
      return /pairing link/i.test(error.message);
    });
  }
});

// ---- Added guards -------------------------------------------------------------------------------

test("the account home's default state directory is protected as well as $HOME's", () => {
  const xdg = { XDG_DATA_HOME: "/synthetic/data" };
  const dirs = protectedStateDirs(xdg, "linux", "/synthetic/userdir", "/synthetic/account");
  // The plain defaults stay protected even when XDG_DATA_HOME points elsewhere.
  for (const expected of [
    "/synthetic/data/emend",
    "/synthetic/userdir/.local/share/emend",
    "/synthetic/account/.local/share/emend",
  ]) {
    assert(dirs.includes(expected), expected);
  }
  assert.deepEqual(protectedStateDirs({}, "darwin", "/synthetic/userdir", "/synthetic/account"), [
    "/synthetic/userdir/Library/Application Support/emend",
    "/synthetic/account/Library/Application Support/emend",
  ]);
});

test("a folder named ..x inside the root is inside, not a parent reference", () => {
  const paths = {
    root: "/tmp/emend-screenshots-synthetic",
    tmpDir: "/tmp",
    emendHome: "/tmp/emend-screenshots-synthetic/..x",
    realStateDirs: ["/synthetic/emend"],
  };
  assert.doesNotThrow(() => assertSealedPaths(paths, resolve));
});

test("the output folder may not overlap real state, also through a symlink", (t) => {
  const fixture = mkdtempSync(join(realpathSync(tmpdir()), "emend-screenshots-out-"));
  t.after(() => rmSync(fixture, { recursive: true, force: true }));
  const state = join(fixture, "state", "emend");
  mkdirSync(state, { recursive: true });
  assert.doesNotThrow(() => assertOutputFolder(join(fixture, "images"), [state], canonicalPath));
  for (const out of [state, join(state, "images"), join(fixture, "state")]) {
    assert.throws(() => assertOutputFolder(out, [state], canonicalPath), /overlaps real emend state/);
  }
  symlinkSync(state, join(fixture, "alias"), "dir");
  assert.throws(() => assertOutputFolder(join(fixture, "alias", "images"), [state], canonicalPath), /overlaps/);
  assert.throws(() => assertOutputFolder("relative", [state], canonicalPath), /absolute/);
});

test("fixture deletions stay inside the fixture repository", (t) => {
  const fixture = mkdtempSync(join(realpathSync(tmpdir()), "emend-screenshots-fixture-"));
  t.after(() => rmSync(fixture, { recursive: true, force: true }));
  const repo = join(fixture, "repo");
  const outside = join(fixture, "outside.txt");
  mkdirSync(repo);
  writeFileSync(outside, "keep");
  writeFileSync(join(repo, "gone.ts"), "x");
  assert.equal(assertInsideRoot(repo, "gone.ts"), join(repo, "gone.ts"));
  for (const path of ["../outside.txt", "a/../../outside.txt", outside, ".", ""]) {
    assert.throws(() => assertInsideRoot(repo, path), /leaves its repository/, path);
  }
  const steps = join(fixture, "fixtures");
  mkdirSync(join(steps, "bad"), { recursive: true });
  writeFileSync(join(steps, "bad", "removed.txt"), "../outside.txt\n");
  assert.throws(() => applyFixture(steps, "bad", repo), /leaves its repository/);
  assert.equal(readFileSync(outside, "utf8"), "keep");
  mkdirSync(join(steps, "good"), { recursive: true });
  writeFileSync(join(steps, "good", "removed.txt"), "gone.ts\n");
  applyFixture(steps, "good", repo);
  assert.throws(() => readFileSync(join(repo, "gone.ts")), { code: "ENOENT" });
});

test("the loopback probe sees a real listener", async () => {
  const listener = createServer();
  try {
    await new Promise<void>((done) => listener.listen(0, "127.0.0.1", done));
    const address = listener.address();
    assert(address && typeof address === "object");
    assert.equal(await acceptsLoopbackConnection(address.port), true);
  } finally {
    await new Promise<void>((done) => listener.close(() => done()));
  }
});

test("a failed probe means free only for a refused connection; every other code throws", () => {
  assert.equal(portProbeFailed("ECONNREFUSED"), false);
  for (const code of ["EACCES", "EPERM", "ETIMEDOUT", "ECONNRESET", "EHOSTUNREACH", undefined]) {
    assert.throws(() => portProbeFailed(code), /Cannot check screenshot port/);
  }
});

test("target types: controlled, inert browser chrome, and everything else a violation", () => {
  for (const type of ["page", "iframe", "worker", "shared_worker", "service_worker"]) {
    assert.equal(classifyTarget(type, "http://127.0.0.1:49231/"), "controlled", type);
  }
  assert.equal(classifyTarget("browser", ""), "inert");
  // Tabs are excluded at the browser-level attach filter; one that still shows up is a violation.
  assert.equal(classifyTarget("tab", ""), "violation");
  for (const url of ["chrome://omnibox-popup.top-chrome/", "chrome-extension://synthetic/page.html"]) {
    assert.equal(classifyTarget("other", url), "inert", url);
    assert.equal(classifyTarget("browser_ui", url), "inert", url);
  }
  for (const [type, url] of [
    ["other", "about:blank"], // The first page is a controlled `page`; no inert target needs an about: URL.
    ["other", "http://example.invalid/"],
    ["other", "not a URL"],
    ["browser_ui", "https://example.invalid/"],
    ["background_page", "chrome-extension://synthetic/background.html"],
    ["webview", "chrome://synthetic/"],
    ["synthetic_unknown", ""],
  ]) {
    assert.equal(classifyTarget(type as string, url as string), "violation", `${type} ${url}`);
  }
});

test("only a WebSocket to the sealed origin is allowed", () => {
  assert.equal(socketAllowed("ws://127.0.0.1:49231/stream", origin), true);
  for (const url of [
    "ws://127.0.0.1:3636/stream",
    "ws://localhost:49231/stream",
    "wss://127.0.0.1:49231/stream",
    "http://127.0.0.1:49231/stream",
    "ws://example.invalid/stream",
    "ws://user@127.0.0.1:49231/stream",
    "nope",
  ]) {
    assert.equal(socketAllowed(url, origin), false, url);
  }
});

test("the Chromium command line is exactly the sealed list", () => {
  const profile = "/tmp/emend-screenshots-synthetic/chromium";
  const common = [
    "--headless=new",
    "--remote-debugging-pipe",
    `--user-data-dir=${profile}`,
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-background-networking",
    "--disable-component-update",
    "--disable-sync",
    "--disable-extensions",
    "--disable-component-extensions-with-background-pages",
    "--no-proxy-server",
    "--host-resolver-rules=MAP * ~NOTFOUND , EXCLUDE 127.0.0.1",
    "--hide-scrollbars",
    "--force-color-profile=srgb",
  ];
  assert.deepEqual(chromiumArgs(profile, "linux"), [...common, "about:blank"]);
  assert.deepEqual(chromiumArgs(profile, "darwin"), [
    ...common,
    "--use-mock-keychain",
    "--password-store=basic",
    "about:blank",
  ]);
  for (const platform of ["linux", "darwin"]) {
    assert(!chromiumArgs(profile, platform).some((arg) => arg.startsWith("--remote-debugging-port")));
  }
  assert.throws(() => chromiumArgs("relative", "linux"), /absolute/);
});

function chunk(type: string, data: Buffer): Buffer {
  const header = Buffer.alloc(8);
  header.writeUInt32BE(data.length, 0);
  header.write(type, 4, "latin1");
  return Buffer.concat([header, data, Buffer.alloc(4)]); // The checksum is copied, never recomputed.
}

test("PNG metadata chunks are dropped and pixel and colour chunks stay", () => {
  const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const keep = ["IHDR", "sRGB", "gAMA", "cHRM", "pHYs", "PLTE", "tRNS", "IDAT", "IEND"].map((type) =>
    chunk(type, Buffer.from(type)),
  );
  const drop = ["tEXt", "zTXt", "iTXt", "tIME", "eXIf", "iCCP"].map((type) => chunk(type, Buffer.from("synthetic")));
  const source = Buffer.concat([signature, keep[0] as Buffer, ...drop, ...keep.slice(1)]);
  assert.deepEqual(filterPng(source), Buffer.concat([signature, ...keep]));
  // Anything after IEND is dropped, even a metadata chunk or junk that is not a chunk at all.
  const trailing = Buffer.concat([source, chunk("tEXt", Buffer.from("after")), Buffer.from("junk")]);
  assert.deepEqual(filterPng(trailing), Buffer.concat([signature, ...keep]));
  assert.throws(() => filterPng(Buffer.from("not a png")), /Not a PNG/);
  assert.throws(() => filterPng(source.subarray(0, source.length - 3)), /Truncated/);
  assert.throws(() => filterPng(Buffer.concat([signature, keep[0] as Buffer])), /no IEND/);
});

// A fake Chromium on the other end of the CDP pipe: records commands, answers by rule.
type Reply = { error: { message: string } } | { result: Record<string, unknown> } | "hold" | undefined;
function fakeChromium(answer: (method: string) => Reply = () => undefined) {
  const toBrowser = new PassThrough();
  const fromBrowser = new PassThrough();
  const sent: { method: string; params: Record<string, unknown>; sessionId?: string }[] = [];
  // Replies the fake was told to hold back; `release()` sends them.
  const held: (() => void)[] = [];
  let buffer = "";
  fromBrowser.on("data", (data: Buffer) => {
    buffer += data.toString();
    for (let end = buffer.indexOf("\0"); end >= 0; end = buffer.indexOf("\0")) {
      const message = JSON.parse(buffer.slice(0, end));
      buffer = buffer.slice(end + 1);
      sent.push({ method: message.method, params: message.params, sessionId: message.sessionId });
      const reply = answer(message.method);
      const write = () =>
        toBrowser.write(`${JSON.stringify({ id: message.id, ...(reply === "hold" || !reply ? { result: {} } : reply) })}\0`);
      if (reply === "hold") held.push(write);
      else write();
    }
  });
  const emit = (method: string, params: Record<string, unknown>, sessionId?: string) =>
    toBrowser.write(`${JSON.stringify({ method, params, ...(sessionId ? { sessionId } : {}) })}\0`);
  const yieldOnce = () => new Promise((done) => setImmediate(done));
  const release = () => {
    for (const write of held.splice(0)) write();
  };
  return { browser: new Browser(fromBrowser, toBrowser, origin), sent, emit, yieldOnce, toBrowser, release };
}

test("Fetch.requestPaused continues the sealed origin and fails everything else", async () => {
  const fake = fakeChromium();
  fake.emit("Fetch.requestPaused", { requestId: "ok", request: { url: `${origin}/api/v1/reviews` } }, "s1");
  fake.emit("Fetch.requestPaused", { requestId: "data", request: { url: "data:text/plain,synthetic" } }, "s1");
  await fake.yieldOnce();
  assert.deepEqual(
    fake.sent.map((entry) => [entry.method, entry.params.requestId]),
    [
      ["Fetch.continueRequest", "ok"],
      ["Fetch.continueRequest", "data"],
    ],
  );
  assert.doesNotThrow(() => fake.browser.check());
  fake.emit("Fetch.requestPaused", { requestId: "bad", request: { url: "https://example.invalid/x?synthetic" } }, "s1");
  await fake.yieldOnce();
  assert.equal(fake.sent.at(-1)?.method, "Fetch.failRequest");
  assert.throws(() => fake.browser.check(), { message: "Blocked screenshot request to https://example.invalid" });
});

test("sockets outside the sealed origin are violations, because Fetch does not see them", async () => {
  const allowed = fakeChromium();
  allowed.emit("Network.webSocketCreated", { requestId: "1", url: "ws://127.0.0.1:49231/stream" }, "s1");
  await allowed.yieldOnce();
  assert.doesNotThrow(() => allowed.browser.check());
  for (const [method, url] of [
    ["Network.webSocketCreated", "ws://127.0.0.1:3636/stream?synthetic"],
    ["Network.webSocketCreated", "wss://example.invalid/stream"],
    ["Network.webTransportCreated", "https://127.0.0.1:49231/"],
  ] as const) {
    const fake = fakeChromium();
    fake.emit(method, { url }, "s1");
    await fake.yieldOnce();
    assert.throws(() => fake.browser.check(), /^Error: Blocked screenshot socket to /);
    assert.throws(() => fake.browser.check(), (error: Error) => !error.message.includes("synthetic"));
  }
});

test("a message the seal cannot read is a violation, never an exception", async () => {
  const fake = fakeChromium();
  fake.toBrowser.write("{not json\0");
  await fake.yieldOnce();
  assert.throws(() => fake.browser.check(), /could not read/);
  const odd = fakeChromium();
  odd.emit("Network.requestWillBeSent", { requestId: "1", type: "Fetch", request: { url: "not a url" } }, "s1");
  await odd.yieldOnce();
  assert.throws(() => odd.browser.check());
});

test("targets are sealed before they resume; a failed seal closes the target and never resumes it", async () => {
  const target = (type: string, url = "http://127.0.0.1:49231/") => ({
    sessionId: "s2",
    targetInfo: { targetId: "t2", type, url },
    waitingForDebugger: true,
  });
  const reject = (...methods: string[]) => (method: string) =>
    methods.includes(method) ? { error: { message: "synthetic" } } : undefined;
  const methodsOf = (fake: ReturnType<typeof fakeChromium>) => fake.sent.map((entry) => entry.method);
  const attach = async (fake: ReturnType<typeof fakeChromium>, type: string, url?: string) => {
    fake.emit("Target.attachedToTarget", target(type, url));
    await fake.yieldOnce();
    await fake.browser.idle();
  };

  // Every controlled type but a dedicated worker: a failed command means no resume and a closeTarget.
  for (const [type, failing] of [
    ["page", "Fetch.enable"],
    ["page", "Network.enable"],
    ["page", "Target.setAutoAttach"],
    ["iframe", "Fetch.enable"],
    ["iframe", "Target.setAutoAttach"],
    ["service_worker", "Fetch.enable"],
    ["shared_worker", "Network.enable"],
  ] as const) {
    const fake = fakeChromium(reject(failing));
    await attach(fake, type);
    assert.throws(() => fake.browser.check(), new RegExp(`Could not seal a ${type} target`), `${type} ${failing}`);
    assert(!methodsOf(fake).includes("Runtime.runIfWaitingForDebugger"), `${type} ${failing} resumed`);
    const closed = fake.sent.find((entry) => entry.method === "Target.closeTarget");
    assert.equal(closed?.params.targetId, "t2", `${type} ${failing} not closed`);
  }

  // The seal is in place before the resume, in this order.
  for (const [type, expected] of [
    ["page", ["Fetch.enable", "Network.enable", "Target.setAutoAttach", "Page.enable", "Page.addScriptToEvaluateOnNewDocument"]],
    ["iframe", ["Fetch.enable", "Network.enable", "Target.setAutoAttach"]],
    ["service_worker", ["Fetch.enable", "Network.enable", "Target.setAutoAttach"]],
  ] as const) {
    const fake = fakeChromium();
    await attach(fake, type);
    assert.doesNotThrow(() => fake.browser.check());
    assert.deepEqual(methodsOf(fake), [...expected, "Runtime.runIfWaitingForDebugger"], type);
  }

  // Service and shared workers may refuse nested attach; that alone is not a failure.
  for (const type of ["service_worker", "shared_worker"]) {
    const fake = fakeChromium(reject("Target.setAutoAttach"));
    await attach(fake, type);
    assert.doesNotThrow(() => fake.browser.check());
    assert(methodsOf(fake).includes("Runtime.runIfWaitingForDebugger"));
  }

  // A dedicated worker has no Fetch domain (its requests pass the parent's session) but it can host
  // nested workers, so Network.enable and Target.setAutoAttach are required.
  const dedicated = fakeChromium(reject("Fetch.enable"));
  await attach(dedicated, "worker");
  assert.doesNotThrow(() => dedicated.browser.check());
  assert.deepEqual(methodsOf(dedicated), [
    "Fetch.enable",
    "Network.enable",
    "Target.setAutoAttach",
    "Runtime.runIfWaitingForDebugger",
  ]);
  for (const failing of ["Network.enable", "Target.setAutoAttach"]) {
    const fake = fakeChromium(reject(failing));
    await attach(fake, "worker");
    assert.throws(() => fake.browser.check(), /Could not seal a worker target/, failing);
  }

  // Only a worker may be discounted for terminating during setup; any other target that fails is a violation.
  const terminated = fakeChromium(reject("Network.enable"));
  terminated.emit("Target.attachedToTarget", target("worker"));
  terminated.emit("Target.detachedFromTarget", { sessionId: "s2" });
  await terminated.yieldOnce();
  await terminated.browser.idle();
  assert.doesNotThrow(() => terminated.browser.check());
  // A non-worker target that detached before it was ever resumed never ran, so it is no violation
  // (a removed Mermaid frame is one). Failing after the resume, or without a detach, is.
  const frame = fakeChromium(reject("Network.enable"));
  frame.emit("Target.attachedToTarget", target("iframe"));
  frame.emit("Target.detachedFromTarget", { sessionId: "s2" });
  await frame.yieldOnce();
  await frame.browser.idle();
  assert.doesNotThrow(() => frame.browser.check());
  assert(!methodsOf(frame).includes("Runtime.runIfWaitingForDebugger"));
  // A target that attached already running was never paused, so a detach during setup does not
  // prove it never ran: it is a violation.
  const running = fakeChromium(reject("Fetch.enable"));
  running.emit("Target.attachedToTarget", { ...target("iframe"), waitingForDebugger: false });
  running.emit("Target.detachedFromTarget", { sessionId: "s2" });
  await running.yieldOnce();
  await running.browser.idle();
  assert.throws(() => running.browser.check(), /Could not seal an? iframe target/);
  const afterResume = fakeChromium(reject("Runtime.runIfWaitingForDebugger"));
  afterResume.emit("Target.attachedToTarget", target("iframe"));
  afterResume.emit("Target.detachedFromTarget", { sessionId: "s2" });
  await afterResume.yieldOnce();
  await afterResume.browser.idle();
  assert.throws(() => afterResume.browser.check(), /Could not seal an? iframe target/);

  const unknown = fakeChromium();
  await attach(unknown, "synthetic_unknown");
  assert.throws(() => unknown.browser.check(), /Unexpected browser target type synthetic_unknown/);

  const inert = fakeChromium();
  await attach(inert, "other", "chrome://omnibox-popup.top-chrome/");
  assert.doesNotThrow(() => inert.browser.check());
  assert.deepEqual(methodsOf(inert), ["Runtime.runIfWaitingForDebugger", "Target.detachFromTarget"]);
});

test("a failed seal is recorded before the target is closed, even if the close never answers", async () => {
  const fake = fakeChromium((method) =>
    method === "Fetch.enable" ? { error: { message: "synthetic" } } : method === "Target.closeTarget" ? "hold" : undefined,
  );
  fake.emit("Target.attachedToTarget", {
    sessionId: "s2",
    targetInfo: { targetId: "t2", type: "page", url: "about:blank" },
    waitingForDebugger: true,
  });
  await fake.yieldOnce();
  await fake.yieldOnce();
  // The close was sent and is still unanswered, yet the violation is already there.
  assert(fake.sent.some((entry) => entry.method === "Target.closeTarget"));
  assert.throws(() => fake.browser.check(), /Could not seal a page target/);
  fake.release();
  await fake.browser.idle();
});

test("newPage waits for its target's seal and resume before anything else is sent", async () => {
  const fake = fakeChromium((method) =>
    method === "Target.createTarget" ? { result: { targetId: "t9" } } : method === "Fetch.enable" ? "hold" : undefined,
  );
  let resolved = false;
  const opened = fake.browser.newPage({ width: 1, height: 1, scale: 1, mobile: false }).then((page) => {
    resolved = true;
    return page;
  });
  await fake.yieldOnce();
  fake.emit("Target.attachedToTarget", {
    sessionId: "s9",
    targetInfo: { targetId: "t9", type: "page", url: "about:blank" },
    waitingForDebugger: true,
  });
  for (let turn = 0; turn < 5; turn++) await fake.yieldOnce();
  // Fetch.enable is held: the page is not open, was not resumed, and nothing was sent to it.
  assert.equal(resolved, false);
  const methods = () => fake.sent.map((entry) => entry.method);
  assert(methods().includes("Fetch.enable"));
  assert(!methods().includes("Runtime.runIfWaitingForDebugger"));
  assert(!methods().some((method) => method.startsWith("Emulation.") || method === "Page.navigate"));
  fake.release();
  await opened;
  assert.equal(resolved, true);
  const order = methods();
  assert(order.indexOf("Runtime.runIfWaitingForDebugger") < order.indexOf("Emulation.setDeviceMetricsOverride"));
});

test("the images are replaced all or nothing, with no temporary or backup file left", (t) => {
  const folder = mkdtempSync(join(realpathSync(tmpdir()), "emend-screenshots-images-"));
  t.after(() => rmSync(folder, { recursive: true, force: true }));
  const files = () => readdirSync(folder).sort();
  const read = (name: string) => readFileSync(join(folder, name), "utf8");
  writeFileSync(join(folder, "a.png"), "old a");
  mkdirSync(join(folder, "b.png"));
  const images = [
    ["a.png", Buffer.from("new a")],
    ["b.png", Buffer.from("new b")],
  ] as const;
  // A directory at the second destination is refused before anything is touched.
  assert.throws(() => writeImages(folder, images), /not a regular file/);
  assert.equal(read("a.png"), "old a");
  assert.deepEqual(files(), ["a.png", "b.png"]);
  rmSync(join(folder, "b.png"), { recursive: true });

  // A rename that fails halfway restores every original and removes the new files.
  writeFileSync(join(folder, "b.png"), "old b");
  let renames = 0;
  assert.throws(
    () =>
      writeImages(folder, images, {
        rename: (from, to) => {
          if (++renames === 4) throw new Error("synthetic rename failure"); // The second temp over its target.
          renameSync(from, to);
        },
      }),
    /synthetic rename failure/,
  );
  assert.equal(read("a.png"), "old a");
  assert.equal(read("b.png"), "old b");
  assert.deepEqual(files(), ["a.png", "b.png"]);

  // The normal path replaces both, also over a missing file, and leaves nothing behind.
  rmSync(join(folder, "b.png"));
  writeImages(folder, images);
  assert.equal(read("a.png"), "new a");
  assert.equal(read("b.png"), "new b");
  assert.deepEqual(files(), ["a.png", "b.png"]);

  // A link at a destination is not a regular file either.
  symlinkSync(join(folder, "a.png"), join(folder, "c.png"));
  assert.throws(() => writeImages(folder, [["c.png", Buffer.from("x")]]), /not a regular file/);
});

// The text of one balanced call, from its opening parenthesis; strings and comments are skipped.
function callText(text: string, open: number): string {
  let depth = 0;
  for (let i = open; i < text.length; i++) {
    const char = text[i] as string;
    if (char === '"' || char === "'" || char === "`") {
      for (i++; i < text.length && text[i] !== char; i++) if (text[i] === "\\") i++;
    } else if (char === "/" && text[i + 1] === "/") {
      i = text.indexOf("\n", i);
      if (i < 0) break;
    } else if (char === "(") depth++;
    else if (char === ")" && --depth === 0) return text.slice(open, i + 1);
  }
  throw new Error("unbalanced call");
}

// Splits at the commas of one nesting level; strings are skipped.
function topLevel(text: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < text.length; i++) {
    const char = text[i] as string;
    if (char === '"' || char === "'" || char === "`") {
      for (i++; i < text.length && text[i] !== char; i++) if (text[i] === "\\") i++;
    } else if ("([{".includes(char)) depth++;
    else if (")]}".includes(char)) depth--;
    else if (char === "," && depth === 0) {
      parts.push(text.slice(start, i));
      start = i + 1;
    }
  }
  parts.push(text.slice(start));
  return parts.map((part) => part.trim()).filter(Boolean);
}

/** True when the call's last argument is an object literal with its own top-level `env` property. */
function hasEnvOption(call: string): boolean {
  const args = topLevel(call.slice(1, -1));
  const options = args.at(-1) ?? "";
  if (!options.startsWith("{") || !options.endsWith("}")) return false;
  return topLevel(options.slice(1, -1)).some((property) => /^env\s*(:|$)/.test(property));
}

test("the parent's environment is read only to find Chromium, and every child gets an env", () => {
  const dir = fileURLToPath(new URL(".", import.meta.url));
  const runner = readFileSync(join(dir, "screenshots.ts"), "utf8");
  const browser = readFileSync(join(dir, "screenshots", "browser.ts"), "utf8");
  const lookup = browser.slice(browser.indexOf("export function findChromium"), browser.indexOf("export class Browser"));
  assert(lookup.includes("process.env"));
  const rest = (text: string) => text.replace(lookup, "");
  for (const text of [rest(runner), rest(browser)]) {
    assert(!text.includes("process.env"));
    assert(!/process\s*\[\s*["'`]env["'`]\s*\]/.test(text), "process[env]");
    assert(!/\{[^}]*\benv\b[^}]*\}\s*=\s*process\b/.test(text), "destructured env");
    assert(!/import\s*\{[^}]*\benv\b[^}]*\}\s*from\s*["'](?:node:)?process["']/.test(text), "imported env");
  }
  // Each spawn-like call passes `env` as a property of its options object argument.
  const sample = [...runner.matchAll(/\bspawn\(/g)].length + [...browser.matchAll(/\bspawn\(/g)].length;
  assert(sample >= 3, "the tripwire must see the spawn calls it guards");
  for (const text of [runner, browser]) {
    for (const call of text.matchAll(/\b(spawn|spawnSync|execFile|execFileSync|exec|execSync|fork)\(/g)) {
      const statement = callText(text, (call.index as number) + call[0].length - 1);
      assert(hasEnvOption(statement), `${call[1]} without an env option`);
    }
  }
  // The checks above can fail. These calls must be refused or caught:
  const open = (call: string) => callText(call, call.indexOf("("));
  assert(!hasEnvOption(open('spawn("x", [], { cwd, stdio: "pipe" })')));
  assert(!hasEnvOption(open('spawn("node", makeArgs({ env }), { cwd })')), "env only inside another argument");
  assert(!hasEnvOption(open('spawn("node", args, { stdio: { env: 1 } })')), "env nested in the options");
  assert(!hasEnvOption(open('spawn("node", args)')));
  assert(hasEnvOption(open('spawn("node", args, { cwd, env, stdio: "pipe" })')));
  assert(hasEnvOption(open('spawn("node", args, { cwd, env: options.env })')));
  assert(/process\s*\[\s*["'`]env["'`]\s*\]/.test('process["env"].PATH'));
  assert(/\{[^}]*\benv\b[^}]*\}\s*=\s*process\b/.test("const { env } = process;"));
  assert(/import\s*\{[^}]*\benv\b[^}]*\}\s*from\s*["'](?:node:)?process["']/.test('import { env } from "node:process";'));
});
