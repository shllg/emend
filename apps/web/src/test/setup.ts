import dns from "node:dns";
import { isIP } from "node:net";
import { configure } from "@testing-library/react";
import { afterAll, afterEach, beforeEach, expect, vi } from "vitest";
import { Channel, Events, Locks } from "./events.ts";

// A web test never reaches the network. The guard records every attempt it refuses, with the test
// name, and fails the test (afterEach, and afterAll for a late one). Two layers:
// - On the setup window (the one the test environment creates): happy-dom's fetch interceptor and a
//   WebSocket subclass refuse any http(s) or ws(s) request whose host is not loopback, before a socket
//   opens. That covers async fetch, link and popup loads, sync XHR (whose request runs in a child
//   process the dns patch cannot reach) and WebSocket. IP literals outside 127.0.0.0/8 and ::1 are refused too.
// - dns.lookup and dns.promises.lookup refuse any name that is not loopback, for sockets that anything
//   in this thread opens outside those paths. IP literals need no lookup, so this layer does not see them.
// Not covered: a window a test creates itself gets only the dns layer; worker threads get neither layer;
// any socket to an IP literal opened outside happy-dom's fetch and WebSocket (Node net, tls, http, https,
// undici); dns.resolve*, which net, http and tls never use. The name recorded is the test running when the
// attempt executes, so a late async request can be blamed on the next test.
// Loopback means localhost, 127.0.0.0/8 and ::1. Node does not pin *.localhost names to loopback, so they are refused.
type Blocked = { host: string; via: "request" | "websocket" | "dns"; test: string | undefined };
const blockedAttempts: Blocked[] = [];
/** For the guard's own test: returns the attempts blocked so far and clears them, so the test does not fail. */
export const takeBlockedAttempts = () => blockedAttempts.splice(0);
const record = (host: string, via: Blocked["via"]) => {
  blockedAttempts.push({ host, via, test: expect.getState().currentTestName });
  return Object.assign(new Error(`web test reached the network: ${via} ${host}; a web test must not use the network`), {
    code: "ENOTFOUND",
    hostname: host,
  });
};
const bare = (host: string) =>
  host
    .toLowerCase()
    .replace(/^\[|\]$/g, "")
    .replace(/\.$/, "");
/** Hosts a web test may connect to: localhost, 127.0.0.0/8 and ::1. */
export function isLoopbackHost(host: string) {
  const name = bare(host);
  return name === "localhost" || (isIP(name) === 4 && name.startsWith("127.")) || name === "::1";
}
/** Names dns.lookup may resolve: loopback hosts, and IP literals, which are never looked up. */
export function isLookupAllowed(host: unknown) {
  if (typeof host !== "string") return true;
  const name = bare(host);
  return name === "" || isLoopbackHost(name) || isIP(name) !== 0;
}
const realLookup = dns.lookup;
const guardedLookup = ((host: string, ...rest: unknown[]) => {
  if (isLookupAllowed(host)) return (realLookup as (...args: unknown[]) => unknown)(host, ...rest);
  const callback = rest.at(-1);
  const error = record(host, "dns");
  if (typeof callback === "function") process.nextTick(callback, error);
  return {};
}) as typeof dns.lookup;
Object.assign(guardedLookup, { __promisify__: undefined });
dns.lookup = guardedLookup;
const realPromiseLookup = dns.promises.lookup;
dns.promises.lookup = ((host: string, ...rest: unknown[]) =>
  isLookupAllowed(host)
    ? (realPromiseLookup as (...args: unknown[]) => unknown)(host, ...rest)
    : Promise.reject(record(host, "dns"))) as typeof dns.promises.lookup;
const isNetworkUrl = (url: URL) => ["http:", "https:", "ws:", "wss:"].includes(url.protocol);
type Context = { request: { url: string }; window: { Response: { error(): unknown } } };
// An async hook that throws leaves happy-dom's task started and never ended, so waitUntilComplete()
// would hang. Returning a network-error response ends the task and resolves fetch() with that response,
// where a browser would reject with a TypeError.
const interceptor = {
  beforeAsyncRequest: async ({ request, window }: Context) => {
    const url = new URL(request.url);
    if (isNetworkUrl(url) && !isLoopbackHost(url.hostname)) {
      record(url.hostname, "request");
      return window.Response.error();
    }
  },
  // A sync hook has no task; happy-dom turns the throw into the XHR's error event.
  beforeSyncRequest: ({ request }: Context) => {
    const url = new URL(request.url);
    if (isNetworkUrl(url) && !isLoopbackHost(url.hostname)) throw record(url.hostname, "request");
  },
};
type GuardedWindow = {
  WebSocket: new (url: string | URL, protocols?: string | string[]) => object;
  happyDOM: { settings: { fetch: { interceptor: unknown } } };
};
const guardedSockets = new WeakSet<object>();
function guardWindow(target: GuardedWindow) {
  target.happyDOM.settings.fetch.interceptor = interceptor;
  const Original = target.WebSocket;
  if (guardedSockets.has(Original)) return;
  class GuardedWebSocket extends Original {
    constructor(url: string | URL, protocols?: string | string[]) {
      const parsed = new URL(String(url), "http://localhost");
      if (isNetworkUrl(parsed) && !isLoopbackHost(parsed.hostname)) throw record(parsed.hostname, "websocket");
      super(url, protocols);
    }
  }
  guardedSockets.add(GuardedWebSocket);
  // The environment copies window globals onto globalThis; keep both names on the guarded class.
  if ((globalThis as { WebSocket?: unknown }).WebSocket === Original)
    (globalThis as { WebSocket?: unknown }).WebSocket = GuardedWebSocket;
  target.WebSocket = GuardedWebSocket;
}
// Some web tests deliberately use the Node environment instead of happy-dom. Install now, so a request
// at module top level or in beforeAll is covered, and again per test in case a test replaced them.
const installGuard = () => {
  if (typeof window !== "undefined") guardWindow(window as unknown as GuardedWindow);
};
installGuard();
const failOnBlocked = () => {
  const attempts = takeBlockedAttempts();
  if (attempts.length)
    throw new Error(
      `web test reached the network: ${attempts.map(({ host, via, test }) => `${host} (${via}, in "${test}")`).join("; ")}`,
    );
};

let restoreLocks = () => {};
// Vitest treats a test timeout of 0 as unlimited, and a timer given 0 or Infinity fires at once.
const LONGEST_TIMER_DELAY = 2_147_483_647;
// Testing Library's config is global, so this is wrong for concurrent tests; the polling guard bans them.
// There is no supported per-call timeout hook here, so a waitFor started late can run past the test's deadline.
beforeEach(({ task }) => configure({ asyncUtilTimeout: task.timeout || LONGEST_TIMER_DELAY }));
beforeEach(() => {
  // Some web tests deliberately use the Node environment instead of happy-dom.
  if (typeof window === "undefined") return;
  installGuard();
  Events.opened = [];
  Channel.opened = [];
  vi.stubGlobal("EventSource", Events);
  vi.stubGlobal("BroadcastChannel", Channel);
  const browser = navigator;
  const previous = Object.getOwnPropertyDescriptor(browser, "locks");
  Object.defineProperty(browser, "locks", { value: new Locks(), configurable: true });
  restoreLocks = () => {
    if (previous) Object.defineProperty(browser, "locks", previous);
    else Reflect.deleteProperty(browser, "locks");
  };
});
afterEach(() => {
  restoreLocks();
  vi.unstubAllGlobals();
  failOnBlocked();
});
// An attempt that arrives after the file's last afterEach still fails the file.
afterAll(failOnBlocked);
