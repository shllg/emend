import { randomUUID } from "node:crypto";
import { afterEach, expect, test, vi } from "vitest";
import { ReviewEvents } from "./events.ts";
import { error, mailboxFixture, nextWaiting } from "./mailbox/test-support.ts";

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});
test("repeated unsubscribe cannot detach a newer listener for the same review", () => {
  const events = new ReviewEvents(Date.now);
  const reviewId = randomUUID();
  const unsubscribe = events.subscribe("owner", reviewId, () => {});
  unsubscribe();
  const listener = vi.fn();
  const newer = events.subscribe("owner", reviewId, listener);
  unsubscribe();
  events.emit("owner", { type: "publish", reviewId, revision: 1 });
  expect(listener).toHaveBeenCalledOnce();
  newer();
});
test("owner subscriptions and Send waiters cannot hear a different owner even for the same review id", async () => {
  const events = new ReviewEvents(Date.now);
  const reviewId = randomUUID();
  const owner = vi.fn();
  const review = vi.fn();
  const stopOwner = events.subscribe("owner", null, owner);
  const stopReview = events.subscribe("owner", reviewId, review);
  const wait = events.waitForSend("owner", reviewId, 25);
  const woke = vi.fn();
  void wait.promise.then(woke);
  try {
    events.emit("foreign", { type: "send", reviewId, revision: 1, sendId: randomUUID() });
    await Promise.resolve();
    expect(owner).not.toHaveBeenCalled();
    expect(review).not.toHaveBeenCalled();
    expect(woke).not.toHaveBeenCalled();
    events.emit("owner", { type: "send", reviewId, revision: 1, sendId: randomUUID() });
    await wait.promise;
    expect(owner).toHaveBeenCalledOnce();
    expect(review).toHaveBeenCalledOnce();
    expect(woke).toHaveBeenCalledOnce();
  } finally {
    wait.cancel();
    stopOwner();
    stopReview();
  }
});
test.each(["snooze", "retire", "delete"] as const)(
  "a Send waiter also wakes on %s, and not on another owner's event",
  async (type) => {
    const events = new ReviewEvents(Date.now);
    const reviewId = randomUUID();
    const wait = events.waitForSend("owner", reviewId, 25);
    const woke = vi.fn();
    void wait.promise.then(woke);
    events.emit("foreign", { type, reviewId, revision: 1 });
    events.emit("owner", { type: "unsnooze", reviewId, revision: 1 });
    events.emit("owner", { type: "publish", reviewId, revision: 1 });
    await Promise.resolve();
    expect(woke).not.toHaveBeenCalled();
    events.emit("owner", { type, reviewId, revision: 1 });
    await wait.promise;
    expect(woke).toHaveBeenCalledOnce();
  },
);
test("waiting covers concurrent takes and 35 seconds of grace, emitting only transitions", async () => {
  vi.useFakeTimers();
  const events = new ReviewEvents(Date.now);
  const id = randomUUID();
  const changes: unknown[] = [];
  events.subscribe("owner", id, (event) => changes.push(event));
  const owner = vi.fn();
  const foreign = vi.fn();
  events.subscribe("owner", null, owner);
  events.subscribe("foreign", null, foreign);
  const endOne = events.beginWaiting("owner", id, 1);
  const endTwo = events.beginWaiting("owner", id, 1);
  expect(events.agentWaiting("owner", id)).toBe(true);
  endOne();
  await vi.advanceTimersByTimeAsync(35000);
  expect(events.agentWaiting("owner", id)).toBe(true);
  endTwo();
  await vi.advanceTimersByTimeAsync(34999);
  expect(events.agentWaiting("owner", id)).toBe(true);
  await vi.advanceTimersByTimeAsync(1);
  expect(events.agentWaiting("owner", id)).toBe(false);
  expect(changes).toEqual([
    { type: "waiting", reviewId: id, revision: 1 },
    { type: "waiting", reviewId: id, revision: 1 },
  ]);
  expect(owner.mock.calls.map(([event]) => event)).toEqual(changes);
  expect(foreign).not.toHaveBeenCalled();
});
test("a viewed event without a revision preserves the waiting revision through expiry", async () => {
  vi.useFakeTimers();
  const events = new ReviewEvents(Date.now);
  const reviewId = randomUUID();
  const listener = vi.fn();
  events.subscribe("owner", reviewId, listener);
  const end = events.beginWaiting("owner", reviewId, 2);
  events.emit("owner", { type: "viewed", reviewId });
  expect(listener).toHaveBeenLastCalledWith({ type: "viewed", reviewId });
  end();
  await vi.advanceTimersByTimeAsync(35000);
  expect(events.agentWaiting("owner", reviewId)).toBe(false);
  expect(listener).toHaveBeenLastCalledWith({ type: "waiting", reviewId, revision: 2 });
});
test("both stream kinds share the 32-stream owner cap and release slots on cancellation and abort", async () => {
  const f = await mailboxFixture();
  const responses: Response[] = [];
  try {
    for (let i = 0; i < 32; i++) {
      const response = await f.request(i % 2 ? `/reviews/${f.reviewId}/events` : "/events", "GET");
      expect(response.status).toBe(200);
      expect(response.headers.get("Content-Type")).toContain("text/event-stream");
      expect(response.headers.get("Cache-Control")).toBe("no-store");
      responses.push(response);
    }
    await error(await f.request(`/reviews/${f.reviewId}/events`, "GET"), 429, "rate_limited");
    await error(await f.request("/events", "GET"), 429, "rate_limited");
    await responses.pop()?.body?.cancel();
    const controller = new AbortController();
    const response = await f.request(`/reviews/${f.reviewId}/events`, "GET", undefined, "reviewer", controller.signal);
    expect(response.status).toBe(200);
    controller.abort();
    const replacement = await f.request(`/reviews/${f.reviewId}/events`, "GET");
    expect(replacement.status).toBe(200);
    responses.push(replacement);
  } finally {
    await Promise.all(responses.map((r) => r.body?.cancel()));
    await f.cleanup();
  }
});
test("waiting state and expiry are independent for the same review id under two owners", async () => {
  vi.useFakeTimers();
  const events = new ReviewEvents(Date.now);
  const id = randomUUID();
  const a = vi.fn();
  const b = vi.fn();
  events.subscribe("a", null, a);
  events.subscribe("b", null, b);
  const endA = events.beginWaiting("a", id, 1);
  expect(events.agentWaiting("b", id)).toBe(false);
  const endB = events.beginWaiting("b", id, 2);
  events.emit("a", { type: "publish", reviewId: id, revision: 3 });
  endA();
  await vi.advanceTimersByTimeAsync(35000);
  expect(events.agentWaiting("a", id)).toBe(false);
  expect(events.agentWaiting("b", id)).toBe(true);
  expect(a).toHaveBeenLastCalledWith({ type: "waiting", reviewId: id, revision: 3 });
  expect(b).toHaveBeenCalledOnce();
  endB();
  await vi.advanceTimersByTimeAsync(35000);
  expect(events.agentWaiting("b", id)).toBe(false);
  expect(b).toHaveBeenLastCalledWith({ type: "waiting", reviewId: id, revision: 2 });
});

test("revocation during the initial session check closes the stream before any event can escape", async () => {
  const events = new ReviewEvents(Date.now);
  const check = Promise.withResolvers<boolean>();
  const stream = events.stream("owner", null, "session", undefined, () => check.promise);
  const reader = stream.getReader();
  events.closeSession("owner", "session");
  events.emit("owner", { type: "publish", reviewId: randomUUID(), revision: 1 });
  check.resolve(true);
  expect(await reader.read()).toEqual({ done: true, value: undefined });
});
test.each(["review", "owner"])(
  "%s streams drop after 100 buffered events; keepalives run every 25 seconds",
  async (scope) => {
    vi.useFakeTimers();
    const events = new ReviewEvents(Date.now);
    const id = randomUUID();
    const stream = events.stream("owner", scope === "owner" ? null : id, "session");
    const reader = stream.getReader();
    expect(new TextDecoder().decode((await reader.read()).value)).toMatch(/^:/);
    await vi.advanceTimersByTimeAsync(25000);
    const ping = await reader.read();
    expect(new TextDecoder().decode(ping.value)).toBe("event: ping\ndata: {}\n\n");
    for (let i = 0; i < 101; i++) events.emit("owner", { type: "publish", reviewId: id, revision: i + 1 });
    await expect(reader.read()).rejects.toThrow();
    // The dropped stream has released its owner slot and event subscription.
    const streams = Array.from({ length: 32 }, () => events.stream("owner", id, "session"));
    const anotherOwner = events.stream("another-owner", randomUUID(), "session");
    await anotherOwner.cancel();
    await Promise.all(streams.map((s) => s.cancel()));
  },
);

async function expectPendingAfterWait(f: Awaited<ReturnType<typeof mailboxFixture>>) {
  const registered = nextWaiting(f.deps.events, f.ownerId, f.reviewId);
  const settled = vi.fn();
  const take = f.take(0.02);
  void take.then(settled);
  await registered;
  await vi.advanceTimersByTimeAsync(19);
  expect(settled).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(1);
  expect(await take).toMatchObject({ kind: "pending" });
}

test("empty take polls do not wait behind the writer queue", async () => {
  const f = await mailboxFixture();
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const writer = f.db.transaction(async () => {
    entered.resolve();
    await release.promise;
  });
  try {
    await entered.promise;
    await expectPendingAfterWait(f);
  } finally {
    release.resolve();
    await writer;
    await f.cleanup();
  }
});

test("a Send arriving between the empty read and wait is not missed", async () => {
  const f = await mailboxFixture();
  try {
    const read = f.db.read;
    let sent = false;
    f.db.read = async (operation) => {
      const result = await read(operation);
      if (result === undefined && !sent) {
        sent = true;
        await f.send({ revision: 1, kind: "go", instruction: "Between read and wait" });
      }
      return result;
    };
    const result = await f.take(25);
    expect(result).toMatchObject({ kind: "go", instructions: ["Between read and wait"] });
  } finally {
    await f.cleanup();
  }
});
test("a 25-second take wakes on Send, without blocking other work", async () => {
  const f = await mailboxFixture();
  try {
    const events = f.deps.events;
    expect(events).toBeDefined();
    const registered = nextWaiting(events, f.ownerId, f.reviewId);
    const waiting = f.take(25);
    await registered;
    expect(events?.agentWaiting(f.ownerId, f.reviewId)).toBe(true);
    await f.send({ revision: 1, kind: "go", instruction: "Wake" });
    expect(await waiting).toMatchObject({ kind: "go", instructions: ["Wake"] });
    expect(events?.agentWaiting(f.ownerId, f.reviewId)).toBe(true);
    f.advance(35000);
    expect(events?.agentWaiting(f.ownerId, f.reviewId)).toBe(false);
  } finally {
    await f.cleanup();
  }
});
test("a take timeout returns pending and an aborted take releases waiting state", async () => {
  const f = await mailboxFixture();
  try {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    await expectPendingAfterWait(f);
    // Expire the first take's grace period so the predicate observes the new take's registration.
    f.advance(35000);
    expect(f.deps.events?.agentWaiting(f.ownerId, f.reviewId)).toBe(false);
    const abort = new AbortController();
    const registered = nextWaiting(f.deps.events, f.ownerId, f.reviewId);
    const waiting = f.request(`/reviews/${f.reviewId}/take`, "POST", { waitSeconds: 25 }, "agent", abort.signal);
    await registered;
    expect(f.deps.events?.agentWaiting(f.ownerId, f.reviewId)).toBe(true);
    abort.abort();
    await waiting;
    f.advance(35000);
    expect(f.deps.events?.agentWaiting(f.ownerId, f.reviewId)).toBe(false);
  } finally {
    await f.cleanup();
  }
});
test("all six SSE events carry ids and revisions, never comments or instructions", async () => {
  const f = await mailboxFixture();
  const controller = new AbortController();
  const takeController = new AbortController();
  try {
    const response = await f.request(`/reviews/${f.reviewId}/events`, "GET", undefined, "reviewer", controller.signal);
    expect(response.status).toBe(200);
    const reader = response.body?.getReader();
    if (!reader) throw new Error("missing stream");
    await reader.read();
    const t = await f.thread("Secret comment text");
    const threadEvent = new TextDecoder().decode((await reader.read()).value);
    expect(threadEvent).toContain("event: thread");
    expect(threadEvent).toContain(t.threadId);
    expect(threadEvent).not.toContain("Secret");
    await f.send({ revision: 1, kind: "go", instruction: "Secret instruction text" });
    const sendEvent = new TextDecoder().decode((await reader.read()).value);
    expect(sendEvent).toContain("event: send");
    expect(sendEvent).not.toContain("Secret");
    const taken = await f.take();
    expect(new TextDecoder().decode((await reader.read()).value)).toContain("event: claimed");
    if (taken.kind === "pending") throw new Error("missing delivery");
    expect((await f.request(`/deliveries/${taken.deliveryId}/confirm`, "POST", undefined, "agent")).status).toBe(204);
    const confirmed = new TextDecoder().decode((await reader.read()).value);
    expect(confirmed).toContain("event: confirmed");
    expect(confirmed).toContain(taken.deliveryId);
    expect(confirmed).not.toContain("Secret");
    const waiting = f.request(
      `/reviews/${f.reviewId}/take`,
      "POST",
      { waitSeconds: 25 },
      "agent",
      takeController.signal,
    );
    expect(new TextDecoder().decode((await reader.read()).value)).toContain("event: waiting");
    takeController.abort();
    await waiting;
    const published = await f.request(
      "/publish",
      "POST",
      {
        reviewId: f.reviewId,
        reviewKey: "a".repeat(64),
        repo: null,
        branch: null,
        title: "Synthetic",
        base: null,
        head: null,
        topics: [],
        files: [],
        writeup: { overview: "Overview", tldr: "Summary", decisions: null, topics: {} },
      },
      "agent",
    );
    expect(published.status).toBe(200);
    expect(new TextDecoder().decode((await reader.read()).value)).toContain("event: publish");
  } finally {
    takeController.abort();
    controller.abort();
    await f.cleanup();
  }
});
