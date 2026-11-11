import { QueryClient, QueryClientProvider, QueryObserver } from "@tanstack/react-query";
import { act, cleanup, render, within } from "@testing-library/react";
import { StrictMode } from "react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { Channel, Events } from "../test/events.ts";
import { reconnectReviewEvents } from "./event-stream.ts";
import { ReviewEventsProvider, usePublishedRevision } from "./events.tsx";
import { refreshQueries } from "./query-refresh.ts";

const id = "11111111-1111-4111-8111-111111111111";
const other = "22222222-2222-4222-8222-222222222222";
const clients: QueryClient[] = [];
beforeEach(() => {
  vi.useFakeTimers();
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(null, { status: 200 })));
});
afterEach(() => {
  cleanup();
  for (const client of clients.splice(0)) client.clear();
  vi.useRealTimers();
  vi.restoreAllMocks();
});
function Published({ reviewId }: { reviewId: string }) {
  return <output aria-label={reviewId}>{usePublishedRevision(reviewId)}</output>;
}
const tick = (ms = 200) =>
  act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
async function mount() {
  const client = new QueryClient();
  clients.push(client);
  const invalidate = vi.spyOn(client, "invalidateQueries");
  const result = render(
    <QueryClientProvider client={client}>
      <ReviewEventsProvider>
        <Published reviewId={id} />
        <Published reviewId={other} />
      </ReviewEventsProvider>
    </QueryClientProvider>,
  );
  await tick();
  expect(invalidate).not.toHaveBeenCalled();
  return { ...result, client, invalidate, view: within(result.container) };
}
function source() {
  const current = Events.opened.at(-1);
  if (!current) throw new Error("missing EventSource");
  return current;
}

test("all valid events refresh inbox and their review; comment, delivery and retirement changes refresh revisions", async () => {
  const { invalidate, unmount } = await mount();
  expect(Events.opened).toHaveLength(1);
  expect(source().url).toBe("/api/v1/events");
  for (const reviewId of [id, other]) {
    for (const type of ["publish", "waiting", "thread", "send", "claimed", "confirmed", "retire"]) {
      invalidate.mockClear();
      act(() => source().emit(type, { reviewId, revision: 1, threadId: id, sendId: id, deliveryId: id }));
      await tick();
      expect(invalidate.mock.calls.map(([options]) => options?.queryKey)).toEqual([
        ["inbox"],
        ["review", reviewId],
        ...(["thread", "send", "claimed", "confirmed", "retire"].includes(type) ? [["revision", reviewId]] : []),
      ]);
    }
  }
  unmount();
  expect(source().close).toHaveBeenCalledOnce();
});

test("a burst invalidates each query key once per 200 ms while publishing the banner state immediately", async () => {
  const { invalidate, view } = await mount();
  act(() => {
    for (let i = 0; i < 20; i++) source().emit("thread", { reviewId: id, revision: 1, threadId: other });
    source().emit("publish", { reviewId: id, revision: 2 });
    source().emit("claimed", { reviewId: other, revision: 1 });
  });
  expect(view.getByLabelText(id).textContent).toBe("2");
  await tick(199);
  expect(invalidate).not.toHaveBeenCalled();
  await tick(1);
  expect(invalidate.mock.calls.map(([options]) => options?.queryKey)).toEqual([
    ["inbox"],
    ["review", id],
    ["revision", id],
    ["review", other],
    ["revision", other],
  ]);
  invalidate.mockClear();
  act(() => source().emit("thread", { reviewId: id, revision: 1, threadId: other }));
  await tick();
  expect(invalidate).toHaveBeenCalledTimes(3);
});

test("malformed and invalid source events are ignored", async () => {
  const { invalidate, view } = await mount();
  act(() => {
    source().dispatchEvent(new MessageEvent("publish", { data: "not json" }));
    source().emit("publish", null);
    source().emit("publish", { reviewId: id, revision: -1 });
    source().emit("publish", { reviewId: "invalid", revision: 1 });
    source().emit("thread", { reviewId: id, revision: 1 });
    source().emit("confirmed", { reviewId: id, revision: 1, deliveryId: "invalid" });
    source().emit("unknown", { reviewId: id, revision: 1 });
  });
  await tick();
  expect(invalidate).not.toHaveBeenCalled();
  expect(view.getByLabelText(id).textContent).toBe("0");
});

test("published revisions retain the newest value independently for each review", async () => {
  const { view } = await mount();
  act(() => {
    source().emit("publish", { reviewId: id, revision: 3 });
    source().emit("publish", { reviewId: other, revision: 2 });
    source().emit("publish", { reviewId: id, revision: 1 });
    source().emit("claimed", { reviewId: other, revision: 4 });
  });
  expect(view.getByLabelText(id).textContent).toBe("3");
  expect(view.getByLabelText(other).textContent).toBe("2");
});

test("every open including the first refreshes all queries and supersedes pending key invalidations", async () => {
  const { invalidate } = await mount();
  for (let open = 1; open <= 3; open++) {
    act(() => {
      source().emit("thread", { reviewId: id, revision: 1, threadId: other });
      source().open();
    });
    await tick();
    expect(invalidate).toHaveBeenCalledTimes(open);
    expect(invalidate).toHaveBeenLastCalledWith({ predicate: expect.any(Function) }, { cancelRefetch: false });
  }
  expect(Events.opened).toHaveLength(1);
});

test("two tabs share one stream, parse forwarded events, and refresh the follower on open", async () => {
  const leader = await mount();
  const follower = await mount();
  expect(Events.opened).toHaveLength(1);
  expect(Channel.opened.map((channel) => channel.name)).toEqual(["emend-events", "emend-events"]);
  act(() => source().emit("publish", { reviewId: id, revision: 3, body: "discarded" }));
  await tick();
  for (const tab of [leader, follower]) {
    expect(tab.view.getByLabelText(id).textContent).toBe("3");
    expect(tab.invalidate.mock.calls.map(([options]) => options?.queryKey)).toEqual([["inbox"], ["review", id]]);
    tab.invalidate.mockClear();
  }
  act(() => source().open());
  await tick();
  for (const tab of [leader, follower])
    expect(tab.invalidate).toHaveBeenCalledExactlyOnceWith(
      { predicate: expect.any(Function) },
      { cancelRefetch: false },
    );
});

test("malformed channel messages cannot update either tab or invalidate queries", async () => {
  const a = await mount();
  const b = await mount();
  const attacker = new Channel("emend-events");
  act(() => {
    for (const value of [
      null,
      "publish",
      {},
      { kind: "open", data: "junk" },
      { kind: "event", type: "publish", data: "not json" },
      { kind: "event", type: "publish", data: { reviewId: id, revision: 2 } },
      { kind: "event", type: "publish", data: JSON.stringify({ reviewId: id, revision: 0 }) },
      { kind: "event", type: "untrusted", data: JSON.stringify({ reviewId: id, revision: 2 }) },
    ])
      attacker.postMessage(value);
  });
  await tick();
  for (const tab of [a, b]) {
    expect(tab.invalidate).not.toHaveBeenCalled();
    expect(tab.view.getByLabelText(id).textContent).toBe("0");
  }
  attacker.close();
});

test("leader hand-over opens exactly one new stream and refreshes the new leader once", async () => {
  const leader = await mount();
  const follower = await mount();
  const previous = source();
  const old = observe(follower.client, ["review", id], Date.now() - 1);
  const fresh = observe(follower.client, ["review", other], Date.now());
  leader.unmount();
  await tick(0);
  expect(follower.invalidate).not.toHaveBeenCalled();
  expect(previous.close).toHaveBeenCalledOnce();
  expect(Events.opened).toHaveLength(2);
  act(() => source().open());
  await tick();
  expect(follower.invalidate).toHaveBeenCalledExactlyOnceWith(
    { predicate: expect.any(Function) },
    { cancelRefetch: false },
  );
  expect(old.fetcher).toHaveBeenCalledOnce();
  expect(fresh.fetcher).not.toHaveBeenCalled();
  old.stop();
  fresh.stop();
  expect(Events.opened.filter((event) => event.readyState !== Events.CLOSED)).toHaveLength(1);
});

test.each(["locks", "channel"])("without %s each tab falls back to its own stream", async (missing) => {
  if (missing === "locks") vi.stubGlobal("navigator", {});
  else vi.stubGlobal("BroadcastChannel", undefined);
  await mount();
  await mount();
  expect(Events.opened).toHaveLength(2);
});

test("CLOSED streams retry with exponential backoff capped at 60 seconds and reset on open", async () => {
  await mount();
  for (const delay of [1000, 2000, 4000, 8000, 16000, 32000, 60000, 60000]) {
    const count = Events.opened.length;
    act(() => {
      source().fail();
      source().fail();
    });
    await tick(delay - 1);
    expect(Events.opened).toHaveLength(count);
    await tick(1);
    expect(Events.opened).toHaveLength(count + 1);
  }
  act(() => source().open());
  const count = Events.opened.length;
  act(() => source().fail());
  await tick(1000);
  expect(Events.opened).toHaveLength(count + 1);
});

test("native reconnects keep their stream and online or visible recovery immediately retries a CLOSED stream", async () => {
  const { unmount } = await mount();
  act(() => source().fail(Events.CONNECTING));
  await tick(60000);
  expect(Events.opened).toHaveLength(1);
  act(() => {
    source().fail();
    window.dispatchEvent(new Event("online"));
  });
  await tick(0);
  expect(Events.opened).toHaveLength(2);
  const visibility = vi.spyOn(document, "visibilityState", "get").mockReturnValue("hidden");
  act(() => {
    source().fail();
    document.dispatchEvent(new Event("visibilitychange"));
  });
  await tick(0);
  expect(Events.opened).toHaveLength(2);
  visibility.mockReturnValue("visible");
  act(() => document.dispatchEvent(new Event("visibilitychange")));
  await tick(0);
  expect(Events.opened).toHaveLength(3);
  act(() => {
    source().open();
    window.dispatchEvent(new Event("online"));
    document.dispatchEvent(new Event("visibilitychange"));
  });
  expect(Events.opened).toHaveLength(3);
  act(() => source().fail());
  unmount();
  window.dispatchEvent(new Event("online"));
  await tick(60000);
  expect(Events.opened).toHaveLength(3);
});

test("StrictMode effect replay keeps one active stream and releases pending leadership on unmount", async () => {
  const client = new QueryClient();
  clients.push(client);
  const { unmount } = render(
    <StrictMode>
      <QueryClientProvider client={client}>
        <ReviewEventsProvider>
          <Published reviewId={id} />
        </ReviewEventsProvider>
      </QueryClientProvider>
    </StrictMode>,
  );
  await tick();
  expect(Events.opened.filter((event) => event.readyState !== Events.CLOSED)).toHaveLength(1);
  unmount();
  await tick();
  for (const event of Events.opened) expect(event.close).toHaveBeenCalledOnce();
});

function observe(client: QueryClient, key: string[], updatedAt: number) {
  client.setQueryData(key, "cached", { updatedAt });
  const fetcher = vi.fn(async () => "fresh");
  const observer = new QueryObserver(client, { queryKey: key, queryFn: fetcher, staleTime: Infinity });
  const stop = observer.subscribe(() => {});
  return { fetcher, stop };
}

test("an open refetches only data older than receipt, including data refreshed within the batch window", async () => {
  const { client } = await mount();
  const old = observe(client, ["review", id], Date.now() - 1);
  const fresh = observe(client, ["review", other], Date.now());
  const refreshed = observe(client, ["inbox"], Date.now() - 1);
  act(() => source().open());
  await tick(100);
  client.setQueryData(["inbox"], "completed after open");
  await tick(100);
  expect(old.fetcher).toHaveBeenCalledOnce();
  expect(fresh.fetcher).not.toHaveBeenCalled();
  expect(refreshed.fetcher).not.toHaveBeenCalled();
  old.stop();
  fresh.stop();
  refreshed.stop();
});

test.each([false, true])("an open preserves the first in-flight payload fetch (cached: %s)", async (cached) => {
  const { client } = await mount();
  const key = ["revision", id, 1];
  if (cached) client.setQueryData(key, "cached", { updatedAt: Date.now() - 1 });
  const payload = Promise.withResolvers<string>();
  const fetcher = vi.fn(({ signal }: { signal: AbortSignal }) => {
    expect(signal.aborted).toBe(false);
    return payload.promise;
  });
  const observer = new QueryObserver(client, { queryKey: key, queryFn: fetcher });
  const stop = observer.subscribe(() => {});
  act(() => source().open());
  await tick();
  expect(fetcher).toHaveBeenCalledOnce();
  expect(fetcher.mock.calls[0]?.[0].signal.aborted).toBe(false);
  payload.resolve("loaded");
  await tick();
  expect(client.getQueryData(key)).toBe("loaded");
  expect(fetcher).toHaveBeenCalledOnce();
  stop();
});

test("an event after open still refreshes its review when its data is newer than the open notice", async () => {
  const { client, invalidate } = await mount();
  const review = observe(client, ["review", id], Date.now());
  act(() => source().open());
  await tick(100);
  client.setQueryData(["review", id], "loaded after open");
  act(() => source().emit("publish", { reviewId: id, revision: 2 }));
  await tick(100);
  expect(invalidate).toHaveBeenCalledOnce();
  expect(review.fetcher).toHaveBeenCalledOnce();
  review.stop();
});

test.each([401, 403])("a CLOSED stream probes once and stops all retries after %s", async (status) => {
  const assign = vi.spyOn(window.location, "assign").mockImplementation(() => {});
  const response = Promise.withResolvers<Response>();
  const fetcher = vi.fn(() => response.promise);
  vi.stubGlobal("fetch", fetcher);
  await mount();
  act(() => {
    source().fail();
    source().fail();
    window.dispatchEvent(new Event("online"));
  });
  await tick(0);
  expect(fetcher).toHaveBeenCalledExactlyOnceWith(
    "/api/v1/events",
    expect.objectContaining({ method: "HEAD", credentials: "same-origin" }),
  );
  expect(Events.opened).toHaveLength(1);
  response.resolve(new Response(null, { status }));
  await tick(0);
  if (status === 401) expect(assign).toHaveBeenCalledExactlyOnceWith("/pair");
  vi.spyOn(document, "visibilityState", "get").mockReturnValue("visible");
  act(() => {
    source().fail();
    window.dispatchEvent(new Event("online"));
    document.dispatchEvent(new Event("visibilitychange"));
  });
  await tick(180_000);
  expect(Events.opened).toHaveLength(1);
  expect(fetcher).toHaveBeenCalledOnce();
});

test("a CLOSED stream receiving 429 keeps exponential backoff without redirecting", async () => {
  const assign = vi.spyOn(window.location, "assign").mockImplementation(() => {});
  const fetcher = vi.fn().mockResolvedValue(new Response(null, { status: 429 }));
  vi.stubGlobal("fetch", fetcher);
  await mount();
  for (const delay of [1000, 2000, 4000]) {
    const count = Events.opened.length;
    act(() => source().fail());
    await tick(delay - 1);
    expect(Events.opened).toHaveLength(count);
    await tick(1);
    expect(Events.opened).toHaveLength(count + 1);
    expect(fetcher).toHaveBeenCalledTimes(count);
  }
  expect(assign).not.toHaveBeenCalled();
});

test("unmount aborts a pending HEAD probe and cannot resume its closed stream", async () => {
  const response = Promise.withResolvers<Response>();
  const fetcher = vi.fn((_path: string, _init?: RequestInit) => response.promise);
  vi.stubGlobal("fetch", fetcher);
  const { unmount } = await mount();
  act(() => source().fail());
  const signal = fetcher.mock.calls[0]?.[1]?.signal;
  expect(signal?.aborted).toBe(false);
  unmount();
  expect(signal?.aborted).toBe(true);
  response.resolve(new Response(null, { status: 200 }));
  await tick(60_000);
  expect(Events.opened).toHaveLength(1);
});

test("viewed events invalidate only the review's revision queries in every tab, once per batch", async () => {
  const leader = await mount();
  const follower = await mount();
  act(() => {
    for (let i = 0; i < 5; i++) source().emit("viewed", { reviewId: id });
  });
  await tick(199);
  expect(leader.invalidate).not.toHaveBeenCalled();
  expect(follower.invalidate).not.toHaveBeenCalled();
  await tick(1);
  for (const tab of [leader, follower]) {
    expect(tab.invalidate).toHaveBeenCalledExactlyOnceWith({ queryKey: ["revision", id] });
    expect(tab.view.getByLabelText(id).textContent).toBe("0");
  }
});

test("a burst of settled writes and viewed events share one refetch batch", async () => {
  const { client, invalidate } = await mount();
  const revision = observe(client, ["revision", id, "1"], Date.now());
  act(() => {
    for (let i = 0; i < 10; i++) {
      source().emit("viewed", { reviewId: id });
      refreshQueries(client, [["revision", id]], { settled: true });
    }
  });
  await tick();
  expect(invalidate).toHaveBeenCalledExactlyOnceWith({ queryKey: ["revision", id] });
  expect(revision.fetcher).toHaveBeenCalledOnce();
  revision.stop();
});

const live = () => Events.opened.filter((event) => event.readyState !== Events.CLOSED);

test("40 seconds without a frame closes and reopens the stream, and the new open refreshes queries", async () => {
  const { invalidate } = await mount();
  const first = source();
  act(() => first.open());
  await tick(39_000);
  expect(Events.opened).toHaveLength(1);
  await tick(1_000);
  expect(first.close).toHaveBeenCalled();
  expect(Events.opened).toHaveLength(2);
  invalidate.mockClear();
  act(() => source().open());
  await tick();
  expect(invalidate).toHaveBeenCalledExactlyOnceWith({ predicate: expect.any(Function) }, { cancelRefetch: false });
});

test("a ping or an event resets the silence timer", async () => {
  await mount();
  act(() => source().open());
  await tick(30_000);
  act(() => source().emit("ping", {}));
  await tick(30_000);
  act(() => source().emit("viewed", { reviewId: id }));
  await tick(30_000);
  expect(Events.opened).toHaveLength(1);
  await tick(10_000);
  expect(Events.opened).toHaveLength(2);
});

test("returning after more than 5 seconds hidden reconnects; a shorter absence does not", async () => {
  await mount();
  act(() => source().open());
  await tick(2_000);
  const visibility = vi.spyOn(document, "visibilityState", "get").mockReturnValue("hidden");
  act(() => document.dispatchEvent(new Event("visibilitychange")));
  await tick(4_000);
  visibility.mockReturnValue("visible");
  act(() => document.dispatchEvent(new Event("visibilitychange")));
  await tick(0);
  expect(Events.opened).toHaveLength(1);
  visibility.mockReturnValue("hidden");
  act(() => document.dispatchEvent(new Event("visibilitychange")));
  await tick(5_001);
  visibility.mockReturnValue("visible");
  act(() => document.dispatchEvent(new Event("visibilitychange")));
  await tick(0);
  expect(Events.opened).toHaveLength(2);
  expect(live()).toHaveLength(1);
});

test.each([
  ["pageshow, persisted", () => new PageTransitionEvent("pageshow", { persisted: true })],
  ["pageshow", () => new PageTransitionEvent("pageshow")],
  ["online", () => new Event("online")],
])("%s reconnects an open stream once, even when signals arrive together", async (_name, make) => {
  await mount();
  act(() => source().open());
  await tick(2_000);
  act(() => {
    window.dispatchEvent(make());
    window.dispatchEvent(make());
    window.dispatchEvent(new Event("online"));
  });
  await tick(0);
  expect(Events.opened).toHaveLength(2);
  expect(live()).toHaveLength(1);
});

test("a visible follower with no relayed frame for 40 seconds takes over and the old leader closes its stream", async () => {
  vi.spyOn(document, "visibilityState", "get").mockReturnValue("visible");
  const leader = await mount();
  const follower = await mount();
  const asleep = source();
  expect(Events.opened).toHaveLength(1);
  await tick(30_000);
  expect(Events.opened).toHaveLength(1);
  await tick(20_000);
  expect(asleep.close).toHaveBeenCalled();
  expect(Events.opened).toHaveLength(2);
  expect(live()).toHaveLength(1);
  leader.invalidate.mockClear();
  follower.invalidate.mockClear();
  act(() => source().open());
  await tick();
  for (const tab of [leader, follower]) expect(tab.invalidate).toHaveBeenCalledTimes(1);
  act(() => source().emit("publish", { reviewId: id, revision: 5 }));
  await tick();
  for (const tab of [leader, follower]) expect(tab.view.getByLabelText(id).textContent).toBe("5");
  await tick(30_000);
  expect(Events.opened).toHaveLength(2);
});

test("two quick steals in one tab leave one live stream and the lock held", async () => {
  vi.spyOn(document, "visibilityState", "get").mockReturnValue("visible");
  await mount();
  await mount();
  const asleep = source();
  await tick(31_000);
  void reconnectReviewEvents();
  void reconnectReviewEvents();
  await tick(0);
  expect(Events.opened).toHaveLength(2);
  expect(live()).toHaveLength(1);
  expect(asleep.close).toHaveBeenCalled();
  // The lock is still held: a third tab queues behind it and opens nothing.
  await mount();
  expect(Events.opened).toHaveLength(2);
});

test("a stolen leader does not steal back at once", async () => {
  vi.spyOn(document, "visibilityState", "get").mockReturnValue("visible");
  await mount();
  await mount();
  await tick(50_000);
  expect(Events.opened).toHaveLength(2);
  await tick(10_000);
  expect(Events.opened).toHaveLength(2);
});

test("a follower that becomes visible waits before judging the leader", async () => {
  const visibility = vi.spyOn(document, "visibilityState", "get").mockReturnValue("hidden");
  await mount();
  await mount();
  await tick(120_000);
  visibility.mockReturnValue("visible");
  act(() => document.dispatchEvent(new Event("visibilitychange")));
  await tick(30_000);
  expect(Events.opened).toHaveLength(1);
  await tick(30_000);
  expect(Events.opened).toHaveLength(2);
});

test("Refresh in a follower steals only when the last relayed frame is older than 30 seconds", async () => {
  vi.spyOn(document, "visibilityState", "get").mockReturnValue("visible");
  await mount();
  await mount();
  act(() => source().open());
  await tick(5_000);
  await expect(reconnectReviewEvents()).resolves.toBe(false);
  expect(Events.opened).toHaveLength(1);
  await tick(31_000);
  void reconnectReviewEvents();
  await tick(0);
  expect(Events.opened).toHaveLength(2);
});

test("an immediate reconnect replaces a pending HEAD probe and the probe schedules nothing", async () => {
  const late = Promise.withResolvers<Response>();
  vi.stubGlobal(
    "fetch",
    vi.fn(() => late.promise),
  );
  await mount();
  act(() => source().fail());
  await tick(0);
  const count = Events.opened.length;
  void reconnectReviewEvents();
  await tick(0);
  expect(Events.opened).toHaveLength(count + 1);
  late.resolve(new Response(null, { status: 200 }));
  await tick(60_000);
  expect(Events.opened).toHaveLength(count + 1);
});

test("Refresh resets the backoff delay; a failed stream afterwards retries after the base delay", async () => {
  await mount();
  for (const delay of [1000, 2000, 4000]) {
    act(() => source().fail());
    await tick(delay);
  }
  const count = Events.opened.length;
  void reconnectReviewEvents();
  await tick(0);
  expect(Events.opened).toHaveLength(count + 1);
  act(() => source().fail());
  await tick(999);
  expect(Events.opened).toHaveLength(count + 1);
  await tick(1);
  expect(Events.opened).toHaveLength(count + 2);
});

test("a reconnect refreshes revision data but not immutable file queries", async () => {
  const { client } = await mount();
  const old = Date.now() - 1;
  const revisionData = observe(client, ["revision", id, "1"], old);
  const file = observe(client, ["file", "f", "new"], old);
  const diff = observe(client, ["file-diff", "f"], old);
  const counts = observe(client, ["file-counts", "f"], old);
  act(() => source().open());
  await tick();
  expect(revisionData.fetcher).toHaveBeenCalledOnce();
  for (const query of [file, diff, counts]) {
    expect(query.fetcher).not.toHaveBeenCalled();
    query.stop();
  }
  revisionData.stop();
});

test("a reconnect retries an immutable file query that failed, and leaves a loaded one alone", async () => {
  const { client } = await mount();
  const failing = vi.fn(async () => {
    throw new Error("offline");
  });
  const failed = new QueryObserver(client, { queryKey: ["file-diff", "bad"], queryFn: failing, retry: false });
  const stop = failed.subscribe(() => {});
  await tick(0);
  expect(failed.getCurrentResult().status).toBe("error");
  const loaded = observe(client, ["file-diff", "good"], Date.now() - 1);
  failing.mockClear();
  act(() => source().open());
  await tick();
  expect(failing).toHaveBeenCalledOnce();
  expect(loaded.fetcher).not.toHaveBeenCalled();
  stop();
  loaded.stop();
});

test("a hidden follower does not take over", async () => {
  vi.spyOn(document, "visibilityState", "get").mockReturnValue("hidden");
  await mount();
  await mount();
  await tick(120_000);
  expect(Events.opened).toHaveLength(1);
});

test("relayed pings keep a visible follower from taking over", async () => {
  vi.spyOn(document, "visibilityState", "get").mockReturnValue("visible");
  await mount();
  await mount();
  act(() => source().open());
  for (let i = 0; i < 6; i++) {
    act(() => source().emit("ping", {}));
    await tick(25_000);
  }
  expect(Events.opened).toHaveLength(1);
});
