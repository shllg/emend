import { QueryClient } from "@tanstack/react-query";
import { afterEach, expect, test, vi } from "vitest";
import { inboxQuery } from "./queries.ts";

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

test.each([-2, 0, 2])("inbox measures a %s hour clock offset at response receipt", async (hours) => {
  vi.useFakeTimers({ toFake: ["Date"] });
  const started = Date.parse("2026-11-04T12:00:00.000Z");
  vi.setSystemTime(started);
  const response = Promise.withResolvers<Response>();
  vi.stubGlobal(
    "fetch",
    vi.fn(() => response.promise),
  );
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  try {
    const pending = client.fetchQuery(inboxQuery());
    const receivedAt = started + 5000;
    vi.setSystemTime(receivedAt);
    const serverTime = new Date(receivedAt + hours * 3_600_000).toISOString();
    response.resolve(Response.json({ items: [], serverTime }));
    const data = await pending;
    expect(data).toEqual({ items: [], serverTime, clockOffset: hours * 3_600_000 });
    expect(client.getQueryData(inboxQuery().queryKey)).toEqual(data);
  } finally {
    client.clear();
  }
});
