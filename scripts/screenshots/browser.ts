// Headless Chromium over --remote-debugging-pipe, sealed to one HTTP origin. No debugging port, no
// WebSocket, no dependency: CDP messages are NUL-terminated JSON on file descriptors 3 and 4.
//
// Fail closed: every unexpected CDP failure becomes a recorded violation, and `check()` rethrows the
// first one. The browser's own host-resolver rules are a second layer under the Fetch filter.
import { type ChildProcess, spawn } from "node:child_process";
import { accessSync, constants } from "node:fs";
import { join } from "node:path";
import type { Readable, Writable } from "node:stream";
import { assertRequestAllowed, chromiumArgs, classifyTarget, sealedOrigin, socketAllowed } from "./safety.ts";

type Json = Record<string, unknown>;
type Handler = (params: Json, sessionId: string | undefined) => void;

export const DESKTOP = { width: 1600, height: 1000, scale: 2, mobile: false } as const;
export const PHONE = { width: 390, height: 844, scale: 3, mobile: true } as const;
export type Viewport = typeof DESKTOP | typeof PHONE;

const COMMAND_TIMEOUT_MS = 30_000;
const FRAME_WATCHDOG_MS = 2_000;

const HIDE_CARET_AND_MOTION =
  "(() => { const add = () => { const s = document.createElement('style'); " +
  "s.textContent = '*, *::before, *::after { caret-color: transparent !important; " +
  "animation: none !important; transition: none !important; }'; (document.head || document.documentElement).append(s); }; " +
  "if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', add); else add(); })();";

// Sockets, layer by layer (checked against real Chromium with a TCP listener on a free loopback port):
// - Network.setBlockedURLs with ws/wss patterns is sent in every session as the requested seal, but
//   it does NOT stop a WebSocket handshake here: the listener still got a connection from a page
//   without the stub and from a dedicated worker.
// - In pages and in frames (Page.enable, then Page.addScriptToEvaluateOnNewDocument) the stub below
//   replaces the constructors before any script runs; frames need their own Page.enable, or an
//   out-of-process frame skips the script.
// - In dedicated workers, also nested ones, the same stub is evaluated with Runtime.evaluate while
//   the worker is paused on start, before the resume; the listener got no handshake.
// - Service and shared workers have no stub hook: the app's CSP (connect-src) stops their sockets,
//   and Network.webSocketCreated / webTransportCreated records a violation as a backstop, which fails
//   the run after the handshake went out (to the sealed origin at most, with the app's CSP).
export const SOCKET_BLOCKED_URLS = ["ws://*", "wss://*"];
const SOCKET_NAMES = ["WebSocket", "WebSocketStream", "WebTransport", "RTCPeerConnection", "webkitRTCPeerConnection"];
export const BLOCK_SOCKETS =
  "(() => { const names = " +
  JSON.stringify(SOCKET_NAMES) +
  "; for (const name of names) { " +
  "const blocked = function () { throw new TypeError('Network sockets are unavailable'); }; " +
  "try { Object.defineProperty(globalThis, name, { value: blocked, writable: false, configurable: false }); } catch {} } })();";

// The Chromium lookup is the only place the parent environment is read.
export function findChromium(explicit: string | undefined, platform: string): string {
  const env = process.env;
  const candidates: string[] = [];
  if (explicit) candidates.push(explicit);
  else if (env.CHROMIUM_PATH) candidates.push(env.CHROMIUM_PATH);
  else {
    for (const dir of (env.PATH ?? "").split(":").filter((entry) => entry.startsWith("/"))) {
      for (const name of ["chromium", "chromium-browser", "google-chrome", "google-chrome-stable"])
        candidates.push(join(dir, name));
    }
    if (platform === "darwin")
      candidates.push(
        "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
        "/Applications/Chromium.app/Contents/MacOS/Chromium",
      );
  }
  for (const candidate of candidates) {
    try {
      accessSync(candidate, constants.X_OK);
      return candidate;
    } catch {
      // Try the next one.
    }
  }
  throw new Error("Chromium not found. Pass --chromium <path> or set CHROMIUM_PATH.");
}

export class Browser {
  readonly origin: string;
  readonly child: ChildProcess | undefined;
  private readonly input: Writable;
  private nextId = 1;
  private buffer = "";
  private readonly pending = new Map<
    number,
    { resolve: (value: Json) => void; reject: (error: Error) => void; timer: NodeJS.Timeout }
  >();
  private readonly handlers: Handler[] = [];
  private violation: Error | undefined;
  private closed = false;
  private readonly tasks = new Set<Promise<void>>();
  /** The attach task of each target, so a caller can wait for exactly its target's seal. */
  private readonly attachTasks = new Map<string, Promise<void>>();
  /** Open network requests per session, without long-lived streams. */
  private readonly inflight = new Map<string, Map<string, string>>();
  private readonly sessions = new Map<string, { type: string; targetId: string; url: string }>();

  /** The streams are the CDP pipe: `input` is Chromium's fd 3, `output` its fd 4. Tests pass fakes. */
  constructor(input: Writable, output: Readable, origin: string, child?: ChildProcess) {
    this.origin = sealedOrigin(Number(new URL(origin).port));
    this.child = child;
    this.input = input;
    input.on("error", () => this.fail(new Error("The browser pipe failed")));
    output.setEncoding("utf8");
    output.on("data", (chunk: string) => this.receive(chunk));
    output.on("error", () => this.fail(new Error("The browser pipe failed")));
    child?.once("exit", () => {
      this.closed = true;
      for (const waiter of this.pending.values()) waiter.reject(new Error("Chromium exited"));
      this.pending.clear();
    });
    this.handlers.push((params, sessionId) => this.handleEvent(params, sessionId));
  }

  static async launch(options: {
    executable: string;
    profile: string;
    env: Record<string, string>;
    port: number;
    platform: string;
    onSpawn?: (child: ChildProcess) => void;
  }): Promise<Browser> {
    const origin = sealedOrigin(options.port);
    const child = spawn(options.executable, chromiumArgs(options.profile, options.platform), {
      env: options.env,
      stdio: ["ignore", "ignore", "ignore", "pipe", "pipe"],
      // Its own process group, so cleanup can end the helper processes too.
      detached: true,
    });
    // Tracked before anything can fail, so cleanup always reaches it.
    options.onSpawn?.(child);
    await new Promise<void>((resolve, reject) => {
      child.once("spawn", resolve);
      child.once("error", reject);
    });
    const browser = new Browser(child.stdio[3] as Writable, child.stdio[4] as Readable, origin, child);
    // Browser and tab targets are the browser's own; everything else attaches, and attach() decides.
    await browser.send("Target.setAutoAttach", {
      autoAttach: true,
      waitForDebuggerOnStart: true,
      flatten: true,
      filter: [{ type: "browser", exclude: true }, { type: "tab", exclude: true }, {}],
    });
    return browser;
  }

  /** Records the first problem. Nothing here throws, so no event handler can crash the parent. */
  private fail(error: Error): void {
    this.violation ??= error;
  }

  /** Throws when a request left the sealed origin or the seal broke. */
  check(): void {
    if (this.violation) throw this.violation;
    if (this.closed) throw new Error("Chromium exited");
  }

  private receive(chunk: string): void {
    try {
      this.buffer += chunk;
      for (;;) {
        const end = this.buffer.indexOf("\0");
        if (end < 0) return;
        const raw = this.buffer.slice(0, end);
        this.buffer = this.buffer.slice(end + 1);
        if (!raw) continue;
        const message = JSON.parse(raw) as Json;
        if (typeof message.id === "number") {
          const waiter = this.pending.get(message.id);
          this.pending.delete(message.id);
          if (!waiter) continue;
          clearTimeout(waiter.timer);
          if (message.error) waiter.reject(new Error(String((message.error as Json).message)));
          else waiter.resolve((message.result ?? {}) as Json);
        } else if (typeof message.method === "string") {
          const params = (message.params ?? {}) as Json;
          const sessionId = typeof message.sessionId === "string" ? message.sessionId : undefined;
          for (const handler of this.handlers) handler({ ...params, method: message.method }, sessionId);
        }
      }
    } catch {
      this.fail(new Error("The browser sent a message the seal could not read"));
    }
  }

  on(handler: Handler): void {
    this.handlers.push(handler);
  }

  send(method: string, params: Json = {}, sessionId?: string): Promise<Json> {
    this.check();
    return this.rawSend(method, params, sessionId);
  }

  // Bypasses check(): blocking a request must still work after a violation was recorded.
  private rawSend(method: string, params: Json, sessionId?: string): Promise<Json> {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`The browser did not answer ${method}`));
      }, COMMAND_TIMEOUT_MS);
      this.pending.set(id, { resolve, reject, timer });
      try {
        this.input.write(`${JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) })}\0`);
      } catch (error) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(error as Error);
      }
    });
  }

  private handleEvent(params: Json, sessionId: string | undefined): void {
    try {
      this.dispatch(params, sessionId);
    } catch (error) {
      this.fail(error instanceof Error ? error : new Error("The seal could not handle a browser event"));
    }
  }

  private dispatch(params: Json, sessionId: string | undefined): void {
    const method = params.method as string;
    if (method === "Target.targetInfoChanged") {
      const info = params.targetInfo as { targetId: string; url: string };
      for (const session of this.sessions.values()) if (session.targetId === info.targetId) session.url = info.url;
    } else if (method === "Target.attachedToTarget") {
      const task = this.attach(params).catch((error: Error) => this.fail(error));
      this.tasks.add(task);
      this.attachTasks.set((params.targetInfo as { targetId: string }).targetId, task);
      void task.finally(() => this.tasks.delete(task));
    } else if (method === "Target.detachedFromTarget") {
      const detached = params.sessionId as string;
      this.inflight.delete(detached);
      this.sessions.delete(detached);
    } else if (method === "Fetch.requestPaused" && sessionId) {
      const request = params.request as { url: string };
      const requestId = params.requestId as string;
      try {
        assertRequestAllowed(request.url, this.origin);
        void this.rawSend("Fetch.continueRequest", { requestId }, sessionId).catch((error: Error) => this.fail(error));
      } catch (error) {
        this.fail(error as Error);
        void this.rawSend("Fetch.failRequest", { requestId, errorReason: "BlockedByClient" }, sessionId).catch(
          () => undefined,
        );
      }
    } else if (method === "Network.webSocketCreated" || method === "Network.webTransportCreated") {
      // Fetch interception does not see sockets, so they are checked at creation. Report the origin only.
      const url = String(params.url);
      if (method === "Network.webTransportCreated" || !socketAllowed(url, this.origin)) {
        let blocked = "invalid URL";
        try {
          blocked = new URL(url).origin;
        } catch {
          // Keep the generic text; never echo an unparseable URL.
        }
        this.fail(new Error(`Blocked screenshot socket to ${blocked}`));
      }
    } else if (method === "Network.requestWillBeSent" && sessionId) {
      const type = params.type as string | undefined;
      if (type === "EventSource" || type === "WebSocket" || type === "Ping") return;
      // Worker scripts are reported by the creating page and never finish there. The page's own
      // scripts have finished once readyState is complete, so scripts are not part of "quiet".
      if (type === "Script" || this.sessions.get(sessionId)?.type.endsWith("worker")) return;
      const label = `${type ?? "?"} ${new URL((params.request as { url: string }).url).pathname}`;
      this.inflight.get(sessionId)?.set(params.requestId as string, label);
    } else if (method === "Network.loadingFinished" || method === "Network.loadingFailed") {
      // A worker's script is reported by its creator and finished by the worker's own session.
      for (const requests of this.inflight.values()) requests.delete(params.requestId as string);
    }
  }

  private async attach(params: Json): Promise<void> {
    const sessionId = params.sessionId as string;
    const info = params.targetInfo as { targetId: string; type: string; url: string };
    const kind = classifyTarget(info.type, info.url);
    if (kind === "violation") throw new Error(`Unexpected browser target type ${info.type}`);
    if (kind === "inert") {
      // Browser chrome that cannot reach the network: resume it, then let it go uninspected.
      if (params.waitingForDebugger) await this.rawSend("Runtime.runIfWaitingForDebugger", {}, sessionId);
      await this.rawSend("Target.detachFromTarget", { sessionId }).catch(() => undefined);
      return;
    }
    this.sessions.set(sessionId, { type: info.type, targetId: info.targetId, url: info.url });
    this.inflight.set(sessionId, new Map());
    const waiting = Boolean(params.waitingForDebugger);
    const resume = () => this.rawSend("Runtime.runIfWaitingForDebugger", {}, sessionId);
    const reason = (error: unknown) => String((error as Error)?.message).slice(0, 80);
    const autoAttach = () =>
      this.rawSend("Target.setAutoAttach", { autoAttach: true, waitForDebuggerOnStart: true, flatten: true }, sessionId);

    const blockSockets = () =>
      this.rawSend("Network.setBlockedURLs", { urls: SOCKET_BLOCKED_URLS }, sessionId);

    // Every target is sealed before it runs: a paused target answers these commands at once, so
    // waiting for them cannot deadlock, and a target that fails any of them is never resumed. A
    // dedicated worker differs in two places. It has no Fetch domain ("'Fetch.enable' wasn't found";
    // its requests are paused through its parent's Fetch session, checked against real Chromium), so
    // that command is fire-and-forget. And it has no script hook, so the socket stub is evaluated in
    // it before the resume. It can host nested workers, so Network.enable and Target.setAutoAttach
    // are required: a nested worker is attached, sealed and stubbed the same way. A worker terminated
    // during setup (the diff parsers are) reports a detach, and its lost commands are no gap.
    const worker = info.type === "worker";
    let resumed = false;
    try {
      const fetchEnable = this.rawSend("Fetch.enable", { patterns: [{ urlPattern: "*" }] }, sessionId);
      if (worker) void fetchEnable.catch(() => undefined);
      else await fetchEnable;
      await this.rawSend("Network.enable", {}, sessionId);
      await blockSockets();
      if (info.type === "page" || info.type === "iframe" || worker) await autoAttach();
      else await autoAttach().catch(() => undefined); // Service and shared workers may refuse it.
      if (info.type === "page" || info.type === "iframe") {
        // Without Page.enable an out-of-process frame does not run the injected script.
        await this.rawSend("Page.enable", {}, sessionId);
        const source = info.type === "page" ? `${BLOCK_SOCKETS}\n${HIDE_CARET_AND_MOTION}` : BLOCK_SOCKETS;
        await this.rawSend("Page.addScriptToEvaluateOnNewDocument", { source }, sessionId);
      }
      if (worker) {
        const stub = (await this.rawSend("Runtime.evaluate", { expression: BLOCK_SOCKETS }, sessionId)) as {
          exceptionDetails?: unknown;
        };
        if (stub.exceptionDetails) throw new Error("the socket stub failed");
      }
      if (waiting) {
        resumed = true;
        await resume();
      }
    } catch (error) {
      // A target that was attached paused and detached before it was ever resumed never ran,
      // sealed or not. A removed Mermaid frame is one; it must not fail the run.
      const gone = !this.sessions.has(sessionId) || /not found|closed|detach/i.test(reason(error));
      if (waiting && !resumed && gone) return;
      // Record first, so check() fails at once even if the close below stalls.
      const failure = new Error(`Could not seal a ${info.type} target (${reason(error)})`);
      this.fail(failure);
      await this.rawSend("Target.closeTarget", { targetId: info.targetId }).catch(() => undefined);
      throw failure;
    }
  }

  /** Resolves when every target attach in progress has finished, sealed or failed. */
  async idle(): Promise<void> {
    while (this.tasks.size) await Promise.all([...this.tasks]);
  }

  /** Requests that are still open in every session of one page tree. */
  openRequests(): string[] {
    return [...this.inflight.values()].flatMap((requests) => [...requests.values()]);
  }

  diagramSessions(): string[] {
    return [...this.sessions.entries()]
      .filter(([, session]) => session.type === "iframe" && session.url.endsWith("/mermaid-frame.html"))
      .map(([sessionId]) => sessionId);
  }

  /** A navigation cancels the old document's requests without a finish event. */
  forgetRequests(sessionId: string): void {
    this.inflight.get(sessionId)?.clear();
  }

  async newPage(viewport: Viewport): Promise<Page> {
    const created = (await this.send("Target.createTarget", { url: "about:blank" })) as { targetId: string };
    const sessionId = await this.sealedSession(created.targetId);
    const page = new Page(this, sessionId);
    await page.configure(viewport);
    return page;
  }

  /** Waits for the target's whole attach (seal confirmed, then resumed), then returns its session. */
  private async sealedSession(targetId: string): Promise<string> {
    const deadline = Date.now() + COMMAND_TIMEOUT_MS;
    let task = this.attachTasks.get(targetId);
    while (!task) {
      this.check();
      if (Date.now() > deadline) throw new Error("The browser page did not attach");
      await new Promise((resolve) => setImmediate(resolve));
      task = this.attachTasks.get(targetId);
    }
    await task;
    this.check();
    for (const [sessionId, session] of this.sessions)
      if (session.targetId === targetId && session.type === "page") return sessionId;
    throw new Error("The browser page did not attach");
  }

  async close(): Promise<void> {
    if (this.closed || !this.child) return;
    try {
      await this.rawSend("Browser.close", {});
    } catch {
      // Fall through to the signal.
    }
    if (!this.closed) this.child.kill("SIGKILL");
  }
}

class TimedOut extends Error {
  constructor(what: string) {
    super(`Timed out waiting for ${what}`);
  }
}

/** Rejects when the deadline passes first. The work keeps running, but nobody awaits it. */
async function within<T>(work: Promise<T>, deadline: number, what: string): Promise<T> {
  // An abandoned promise must never reach unhandledRejection.
  work.catch(() => undefined);
  const remaining = deadline - Date.now();
  if (remaining <= 0) throw new TimedOut(what);
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      work,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new TimedOut(what)), remaining);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

export class Page {
  readonly browser: Browser;
  readonly sessionId: string;

  constructor(browser: Browser, sessionId: string) {
    this.browser = browser;
    this.sessionId = sessionId;
  }

  send(method: string, params: Json = {}): Promise<Json> {
    return this.browser.send(method, params, this.sessionId);
  }

  async configure(viewport: Viewport): Promise<void> {
    await this.send("Emulation.setDeviceMetricsOverride", {
      width: viewport.width,
      height: viewport.height,
      deviceScaleFactor: viewport.scale,
      mobile: viewport.mobile,
    });
    await this.send("Emulation.setFocusEmulationEnabled", { enabled: true });
    await this.send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-color-scheme", value: "dark" }] });
    if (viewport.mobile) {
      await this.send("Emulation.setTouchEmulationEnabled", { enabled: true, maxTouchPoints: 5 });
      await this.send("Emulation.setEmitTouchEventsForMouse", { enabled: true, configuration: "mobile" });
    }
  }

  async goto(url: string): Promise<void> {
    const origin = this.browser.origin;
    if (new URL(url).origin !== origin) throw new Error("Refusing to navigate outside the sealed origin");
    this.browser.forgetRequests(this.sessionId);
    // A page behind another tab gets no animation frames, so work on the one in front.
    await this.send("Page.bringToFront");
    await this.send("Page.navigate", { url });
  }

  /** Evaluates an expression in the page and returns its JSON value. */
  async eval<T = unknown>(expression: string): Promise<T> {
    const result = (await this.send("Runtime.evaluate", {
      expression,
      awaitPromise: true,
      returnByValue: true,
    })) as { result?: { value?: T }; exceptionDetails?: { text?: string; exception?: { description?: string } } };
    if (result.exceptionDetails)
      throw new Error(
        `Page script failed: ${result.exceptionDetails.exception?.description ?? result.exceptionDetails.text}`,
      );
    return result.result?.value as T;
  }

  /**
   * Two animation frames: layout, observers and effects from the last change have run. A page that
   * is not in front gets no frames, so a stalled wait re-activates the page and asks again; this
   * watchdog never counts as readiness, which still needs the frames to come.
   */
  private async frames(deadline: number): Promise<void> {
    for (;;) {
      this.browser.check();
      try {
        await within(
          this.eval("new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done)))"),
          Math.min(deadline, Date.now() + FRAME_WATCHDOG_MS),
          "the next frame",
        );
        return;
      } catch (error) {
        // Only a missed frame is a stall; any other failure is real.
        if (!(error instanceof TimedOut) || Date.now() >= deadline) throw error;
        await within(this.send("Page.bringToFront"), deadline, "re-activating the page");
      }
    }
  }

  /** Polls a page expression until it is truthy, once per frame. The condition is the signal. */
  async waitFor(expression: string, what: string, timeoutMs = 30_000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      this.browser.check();
      const done = await within(this.eval<boolean>(`Boolean(${expression})`), deadline, what).catch((error: Error) => {
        if (error instanceof TimedOut) throw error;
        return false;
      });
      if (done) return;
      await this.frames(deadline);
    }
  }

  /** Data loaded, fonts ready, no open requests, and any diagram frame has drawn, for three frames in a row. */
  async settle(what: string, timeoutMs = 30_000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    let calm = 0;
    let state = "";
    for (;;) {
      this.browser.check();
      // Let the layout and any observers triggered by the last scroll or render run first.
      await this.frames(deadline);
      const loaded = await within(
        this.eval<boolean>(
          "document.fonts.ready.then(() => document.readyState === 'complete' && " +
            "![...document.images].some((image) => !image.complete) && " +
            "!document.body.innerText.includes('Loading diff') && " +
            "!document.querySelector('[aria-busy=\"true\"], [role=\"progressbar\"]'))",
        ),
        deadline,
        `${what} to load`,
      ).catch((error: Error) => {
        if (error instanceof TimedOut) throw error;
        return false;
      });
      const open = this.browser.openRequests();
      const quiet = open.length === 0;
      const drawn = quiet && loaded && (await within(this.diagramsDrawn(), deadline, `${what} diagrams`));
      state = `loaded=${loaded} open=[${open.slice(0, 5).join(", ")}] drawn=${drawn}`;
      // Consecutive ready polls: a request started by the last render shows up in a later one.
      calm = loaded && quiet && drawn ? calm + 1 : 0;
      if (calm >= 3) return;
      if (Date.now() > deadline) throw new Error(`Timed out waiting for ${what} to settle (${state})`);
    }
  }

  private async diagramsDrawn(): Promise<boolean> {
    const count = await this.eval<number>("document.querySelectorAll('iframe[title=\"Diagram\"]').length");
    if (!count) return true;
    // A sandboxed frame lives in its own target; ask that target whether Mermaid has drawn.
    const frames = this.browser.diagramSessions();
    if (frames.length < count) return false;
    for (const sessionId of frames) {
      const result = (await this.browser
        .send(
          "Runtime.evaluate",
          { expression: "Boolean(document.querySelector('svg'))", returnByValue: true },
          sessionId,
        )
        .catch(() => ({}))) as { result?: { value?: boolean } };
      if (!result.result?.value) return false;
    }
    return true;
  }

  async screenshot(): Promise<Buffer> {
    this.browser.check();
    const shot = (await this.send("Page.captureScreenshot", { format: "png", fromSurface: true })) as { data: string };
    this.browser.check();
    return Buffer.from(shot.data, "base64");
  }
}
