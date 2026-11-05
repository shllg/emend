import dns from "node:dns";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { expect, onTestFinished, test } from "vitest";
import { isLookupAllowed, isLoopbackHost, takeBlockedAttempts } from "./setup.ts";

const settled = () =>
  (window as unknown as { happyDOM: { waitUntilComplete(): Promise<void> } }).happyDOM.waitUntilComplete();

test("loopback hosts pass the request guard; IP literals elsewhere and other names do not", () => {
  for (const host of ["localhost", "LOCALHOST.", "127.0.0.1", "127.9.9.9", "[::1]", "::1"])
    expect(isLoopbackHost(host), host).toBe(true);
  for (const host of [
    "10.1.2.3",
    "192.0.2.1",
    "example.test",
    "localhost.example.test",
    "app.localhost",
    "notlocalhost",
    "::2",
  ])
    expect(isLoopbackHost(host), host).toBe(false);
});

test("the DNS layer lets IP literals pass, since no lookup happens for them, and blocks other names", () => {
  for (const host of ["localhost", "127.0.0.1", "10.1.2.3", "::1"]) expect(isLookupAllowed(host), host).toBe(true);
  for (const host of ["example.test", "localhost.example.test", "app.localhost"])
    expect(isLookupAllowed(host), host).toBe(false);
});

test("an async fetch to a TEST-NET address is refused before any connect, and names the test", async () => {
  const response = await fetch("http://192.0.2.1/x");
  expect([response.type, response.status]).toEqual(["error", 0]);
  expect(takeBlockedAttempts()).toEqual([
    {
      host: "192.0.2.1",
      via: "request",
      test: expect.stringContaining("an async fetch to a TEST-NET address is refused before any connect"),
    },
  ]);
});

test("an async fetch to a non-loopback name is refused", async () => {
  const response = await fetch("http://guard-self-test.example.test/x");
  expect([response.type, response.status]).toEqual(["error", 0]);
  // The refused fetch must not leave a happy-dom task open.
  await settled();
  expect(takeBlockedAttempts().map(({ host, via }) => [host, via])).toEqual([
    ["guard-self-test.example.test", "request"],
  ]);
});

test("a refused WebSocket never connects, is recorded, and covers window and globalThis", () => {
  for (const Socket of [window.WebSocket, globalThis.WebSocket])
    expect(() => new Socket("ws://192.0.2.1/")).toThrow(/websocket 192\.0\.2\.1/);
  expect(takeBlockedAttempts().map(({ host, via }) => [host, via])).toEqual([
    ["192.0.2.1", "websocket"],
    ["192.0.2.1", "websocket"],
  ]);
});

test("a WebSocket to loopback is delegated to happy-dom", async () => {
  const server = createServer();
  onTestFinished(() => {
    server.closeAllConnections();
    return new Promise<void>((resolve) => server.close(() => resolve()));
  });
  server.on("upgrade", (_, socket) => {
    socket.write("HTTP/1.1 400 Bad Request\r\n\r\n");
    socket.destroy();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  const socket = new WebSocket(`ws://127.0.0.1:${port}/`);
  onTestFinished(() => socket.close());
  await new Promise((resolve) => {
    socket.addEventListener("error", resolve);
    socket.addEventListener("close", resolve);
  });
  expect(takeBlockedAttempts()).toEqual([]);
});

test("a sync XHR to a non-loopback host is refused and fails with a network error", async () => {
  const request = new XMLHttpRequest();
  let failed = false;
  request.addEventListener("error", () => {
    failed = true;
  });
  request.open("GET", "http://sync-self-test.example.test/x", false);
  try {
    request.send();
  } catch {
    failed = true;
  }
  expect(failed).toBe(true);
  expect(request.status).toBe(0);
  await settled();
  expect(takeBlockedAttempts().map(({ host, via }) => [host, via])).toEqual([
    ["sync-self-test.example.test", "request"],
  ]);
});

test("dns.lookup and dns.promises.lookup, the backstop, refuse another host name and record it", async () => {
  await expect(dns.promises.lookup("promises.example.test")).rejects.toMatchObject({
    code: "ENOTFOUND",
    hostname: "promises.example.test",
  });
  const error = await new Promise<NodeJS.ErrnoException | null>((resolve) =>
    dns.lookup("callback.example.test", (failure) => resolve(failure)),
  );
  expect(error).toMatchObject({ code: "ENOTFOUND", hostname: "callback.example.test" });
  expect(takeBlockedAttempts().map(({ host, via }) => [host, via])).toEqual([
    ["promises.example.test", "dns"],
    ["callback.example.test", "dns"],
  ]);
});

test("a loopback request still passes", async () => {
  const server = createServer((_, response) => {
    // The page is on another origin, so the response needs CORS for the fetch to read it.
    response.setHeader("Access-Control-Allow-Origin", "*");
    response.end("ok");
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  onTestFinished(() => new Promise<void>((resolve) => server.close(() => resolve())));
  const { port } = server.address() as AddressInfo;
  const response = await fetch(`http://127.0.0.1:${port}/x`);
  expect(await response.text()).toBe("ok");
  expect((await dns.promises.lookup("localhost")).address).toMatch(/^(127\.0\.0\.1|::1)$/);
  expect(takeBlockedAttempts()).toEqual([]);
});
