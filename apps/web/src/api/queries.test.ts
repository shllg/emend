import { QueryClient } from "@tanstack/react-query";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { type InboxData, inboxQuery, serverNow } from "./queries.ts";

const started = Date.parse("2026-11-04T12:00:00.000Z");
beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date", "performance", "setTimeout", "clearTimeout"] });
  vi.setSystemTime(started);
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

test.each([-2, 0, 2])("inbox records both receipt clocks with the server %s hours ahead", async (hours) => {
  const response = Promise.withResolvers<Response>();
  vi.stubGlobal(
    "fetch",
    vi.fn(() => response.promise),
  );
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  try {
    const pending = client.fetchQuery(inboxQuery());
    vi.advanceTimersByTime(5000);
    const receivedAt = Date.now();
    const receivedMono = performance.now();
    const serverTime = new Date(receivedAt + hours * 3_600_000).toISOString();
    response.resolve(Response.json({ approvedActiveHours: 12, approvedActiveLimit: 5, items: [], serverTime }));
    const data = await pending;
    expect(data).toEqual({
      approvedActiveHours: 12,
      approvedActiveLimit: 5,
      items: [],
      serverTime,
      receivedAt,
      receivedMono,
    });
    expect(client.getQueryData(inboxQuery().queryKey)).toEqual(data);
    expect(serverNow(data)).toBe(Date.parse(serverTime));
  } finally {
    client.clear();
  }
});

test.each([
  { scenario: "no drift", wallJump: 0, elapsed: 90 * 60_000, expected: 90 * 60_000 },
  { scenario: "a backward wall-clock change", wallJump: -2 * 3_600_000, elapsed: 90 * 60_000, expected: 90 * 60_000 },
  {
    scenario: "sleep with a paused monotonic clock",
    wallJump: 10 * 3_600_000,
    elapsed: 60_000,
    expected: 10 * 3_600_000 + 60_000,
  },
])("the server clock advances correctly after $scenario", ({ wallJump, elapsed, expected }) => {
  const serverTime = started + 2 * 3_600_000;
  const data: InboxData = {
    approvedActiveHours: 12,
    approvedActiveLimit: 5,
    items: [],
    serverTime: new Date(serverTime).toISOString(),
    receivedAt: Date.now(),
    receivedMono: performance.now(),
  };
  vi.setSystemTime(Date.now() + wallJump);
  expect(performance.now()).toBe(data.receivedMono);
  vi.advanceTimersByTime(elapsed);
  expect(serverNow(data)).toBe(serverTime + expected);
});

const receipt = { serverTime: "2026-11-04T14:00:00.000Z", receivedAt: started, receivedMono: 0 };
test.each([
  { scenario: "no cache entry", data: undefined },
  { scenario: "an empty object", data: {} },
  { scenario: "missing serverTime", data: { receivedAt: started, receivedMono: 0 } },
  { scenario: "unparseable serverTime", data: { ...receipt, serverTime: "invalid" } },
  { scenario: "missing receivedAt", data: { serverTime: receipt.serverTime, receivedMono: 0 } },
  { scenario: "missing receivedMono", data: { serverTime: receipt.serverTime, receivedAt: started } },
  ...[Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY].flatMap((value) => [
    { scenario: `receivedAt = ${value}`, data: { ...receipt, receivedAt: value } },
    { scenario: `receivedMono = ${value}`, data: { ...receipt, receivedMono: value } },
  ]),
])("the server clock falls back to the supplied wall time for $scenario", ({ data }) => {
  const wall = started + 60_000;
  expect(serverNow(data, wall, 60_000)).toBe(wall);
});

test("the server clock falls back to the supplied wall time for a non-finite estimate", () => {
  const wall = started + 60_000;
  expect(serverNow({ ...receipt, receivedMono: -Number.MAX_VALUE }, wall, Number.MAX_VALUE)).toBe(wall);
});
