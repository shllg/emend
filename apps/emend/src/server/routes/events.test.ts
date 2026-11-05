import { randomUUID } from "node:crypto";
import { DeviceList, type ReviewEvent as EventPayload, PublishResponse, ReviewEvent } from "@emend/contract";
import { and, eq } from "drizzle-orm";
import { expect, onTestFinished, test, vi } from "vitest";
import { deliveries, devices } from "../../db/schema.ts";
import { createToken, SESSION_MS } from "../auth/tokens.ts";
import { error, mailboxFixture } from "../mailbox/test-support.ts";

async function readEvent(reader: ReadableStreamDefaultReader<Uint8Array>) {
  const text = new TextDecoder().decode((await reader.read()).value);
  const [, type, data] = /^event: (\w+)\ndata: (.+)\n\n$/.exec(text) ?? [];
  return ReviewEvent.parse({ ...JSON.parse(data ?? "null"), type });
}

test.each(["device", "logout"])(
  "%s revocation immediately closes both stream kinds and preserves another device's session",
  async (kind) => {
    const f = await mailboxFixture();
    const controller = new AbortController();
    const readers: ReadableStreamDefaultReader<Uint8Array>[] = [];
    try {
      const current = DeviceList.parse(await (await f.request("/devices", "GET")).json()).items.find(
        (item) => item.current,
      );
      if (!current) throw new Error("missing device");
      const deviceId = randomUUID();
      await f.db.query((q) =>
        q.insert(devices).values({ id: deviceId, ownerId: f.ownerId, kind: "browser", name: "Second browser" }),
      );
      const sibling = await createToken(f.db, f.ownerId, "reviewer", {
        deviceId: current.id,
        expiresAt: f.deps.now() + SESSION_MS,
      });
      const separate = await createToken(f.db, f.ownerId, "reviewer", {
        deviceId,
        expiresAt: f.deps.now() + SESSION_MS,
      });
      for (const path of ["/events", `/reviews/${f.reviewId}/events`]) {
        const response = await f.request(path, "GET", undefined, "reviewer", controller.signal);
        const reader = response.body?.getReader();
        if (!reader) throw new Error("missing stream");
        readers.push(reader);
        await reader.read();
      }
      for (const token of [sibling, separate]) {
        const response = await f.app.request(
          f.keep(
            new Request("http://127.0.0.1:3636/api/v1/events", {
              signal: controller.signal,
              headers: { Host: "127.0.0.1:3636", Cookie: `emend_session=${token.secret}` },
            }),
          ),
        );
        const reader = response.body?.getReader();
        if (!reader) throw new Error("missing stream");
        readers.push(reader);
        await reader.read();
      }
      expect((await f.request(kind === "device" ? `/devices/${current.id}` : "/session", "DELETE")).status).toBe(204);
      f.deps.events?.emit(f.ownerId, { type: "publish", reviewId: f.reviewId, revision: 2 });
      for (const reader of readers.slice(0, 3)) expect(await reader.read()).toEqual({ done: true, value: undefined });
      const survivor = readers[3];
      if (!survivor) throw new Error("missing survivor");
      expect(await readEvent(survivor)).toEqual({ type: "publish", reviewId: f.reviewId, revision: 2 });
    } finally {
      controller.abort();
      await Promise.all(readers.map((reader) => reader.cancel()));
      await f.cleanup();
    }
  },
);

test("owner-wide streams receive two owned reviews and never another owner's events", async () => {
  const f = await mailboxFixture();
  const controller = new AbortController();
  const readers: ReadableStreamDefaultReader<Uint8Array>[] = [];
  try {
    for (const [path, who] of [
      ["/events", "reviewer"],
      ["/events", "foreign"],
      [`/reviews/${f.reviewId}/events`, "reviewer"],
    ] as const) {
      const response = await f.request(path, "GET", undefined, who, controller.signal);
      expect(response.status).toBe(200);
      const reader = response.body?.getReader();
      if (!reader) throw new Error("missing stream");
      readers.push(reader);
      await reader.read();
    }
    const [own, foreign, perReview] = readers;
    if (!own || !foreign || !perReview) throw new Error("missing readers");
    const published: EventPayload[] = [];
    for (const [reviewKey, who, reviewId] of [
      ["a", "agent", f.reviewId],
      ["b", "agent", undefined],
      ["c", "stranger", undefined],
    ] as const) {
      const response = await f.request(
        "/publish",
        "POST",
        {
          reviewId,
          reviewKey: reviewKey.repeat(64),
          repo: null,
          branch: null,
          title: "Synthetic",
          base: null,
          head: null,
          topics: [],
          files: [],
          writeup: { overview: "Overview", tldr: "Summary", decisions: null, topics: {} },
        },
        who,
      );
      expect(response.status).toBe(200);
      const result = PublishResponse.parse(await response.json());
      published.push({ type: "publish", reviewId: result.reviewId, revision: result.revision });
    }
    // Closing drains queued frames and lets the test prove no extra foreign frame arrived.
    controller.abort();
    expect(await readEvent(own)).toEqual(published[0]);
    expect(await readEvent(own)).toEqual(published[1]);
    expect((await own.read()).done).toBe(true);
    expect(await readEvent(foreign)).toEqual(published[2]);
    expect((await foreign.read()).done).toBe(true);
    expect(await readEvent(perReview)).toEqual(published[0]);
    expect((await perReview.read()).done).toBe(true);
  } finally {
    controller.abort();
    await Promise.all(readers.map((reader) => reader.cancel()));
    await f.cleanup();
  }
});

test("owner-wide HEAD allocates no stream and GET and HEAD require reviewer scope", async () => {
  const f = await mailboxFixture();
  try {
    if (!f.deps.events) throw new Error("missing events");
    const stream = vi.spyOn(f.deps.events, "stream");
    for (let i = 0; i < 33; i++) {
      const response = await f.request("/events", "HEAD");
      expect(response.status).toBe(200);
      expect(response.headers.get("Content-Type")).toContain("text/event-stream");
      expect(response.headers.get("Cache-Control")).toBe("no-store");
      expect(await response.text()).toBe("");
    }
    expect(stream).not.toHaveBeenCalled();
    for (const method of ["GET", "HEAD"]) {
      expect((await f.request("/events", method, undefined, "agent")).status).toBe(403);
      expect(
        (
          await f.app.request("http://127.0.0.1:3636/api/v1/events", {
            method,
            headers: { Host: "127.0.0.1:3636", Origin: "http://127.0.0.1:3636" },
          })
        ).status,
      ).toBe(401);
    }
    const response = await f.request("/events", "GET");
    expect(response.status).toBe(200);
    await response.body?.cancel();
  } finally {
    await f.cleanup();
  }
});

test.each([0, 25])(
  "take with waitSeconds=%s and confirm emit once, after commit, with ids only",
  async (waitSeconds) => {
    const f = await mailboxFixture();
    const observations: Promise<void>[] = [];
    const received: EventPayload[] = [];
    const waiting = Promise.withResolvers<void>();
    const unsubscribe = f.deps.events?.subscribe(f.ownerId, null, (event) => {
      if (event.type === "waiting" && event.reviewId === f.reviewId) waiting.resolve();
      if (event.type !== "claimed" && event.type !== "confirmed") return;
      received.push(event);
      observations.push(
        f.db.read(async (q) => {
          const rows = await q
            .select()
            .from(deliveries)
            .where(and(eq(deliveries.ownerId, f.ownerId), eq(deliveries.reviewId, event.reviewId)));
          expect(rows).toHaveLength(1);
          if (event.type === "confirmed") expect(rows[0]?.confirmedAt).not.toBeNull();
        }),
      );
    });
    // A waiting event that never arrives ends the test by timeout without unwinding; onTestFinished still runs.
    onTestFinished(async () => {
      unsubscribe?.();
      await f.cleanup();
    });
    const send = () => f.send({ revision: 1, kind: "go", instruction: "Synthetic instruction" });
    if (!waitSeconds) await send();
    const take = f.take(waitSeconds);
    if (waitSeconds) {
      await waiting.promise;
      expect(f.deps.events?.agentWaiting(f.ownerId, f.reviewId)).toBe(true);
      await send();
    }
    const result = await take;
    if (result.kind === "pending") throw new Error("missing delivery");
    expect(await f.take()).toMatchObject({ kind: "pending" });
    await error(
      await f.request(`/deliveries/${result.deliveryId}/confirm`, "POST", undefined, "stranger"),
      404,
      "not_found",
    );
    const confirm = await f.request(`/deliveries/${result.deliveryId}/confirm`, "POST", undefined, "agent");
    expect(confirm.status).toBe(204);
    await error(
      await f.request(`/deliveries/${result.deliveryId}/confirm`, "POST", undefined, "agent"),
      404,
      "not_found",
    );
    expect(received).toEqual([
      { type: "claimed", reviewId: f.reviewId, revision: 1 },
      { type: "confirmed", reviewId: f.reviewId, revision: 1, deliveryId: result.deliveryId },
    ]);
    await Promise.all(observations);
  },
);
