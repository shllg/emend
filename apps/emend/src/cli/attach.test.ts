import { randomUUID } from "node:crypto";
import { cp, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  Capabilities,
  InboxList,
  PairingCreated,
  PublishResponse,
  REVIEW_BIN_FEATURE,
  WaitResult,
} from "@emend/contract";
import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, onTestFinished, test, vi } from "vitest";
import { openDb } from "../db/client.ts";
import { listBin } from "../db/repo/lifecycle.ts";
import { comments, deliveries, devices, docAssets, instances, owners, reviews, sends, threads } from "../db/schema.ts";
import { run } from "../main.ts";
import { createApp } from "../server/app.ts";
import { createToken, SESSION_MS } from "../server/auth/tokens.ts";
import * as executors from "../server/publish/executor.ts";
import * as rendering from "../server/publish/render.ts";
import { initializeServerState, serverConfig, startServer } from "../server/serve.ts";
import { writeSecretFile } from "../state/files.ts";
import { BlobStore } from "../store/blobs.ts";
import { workInThread } from "../test/in-thread-worker.ts";
import { lockAttach } from "./attach/lock.ts";
import { publishCommand } from "./commands/publish.ts";
import { confirmDirect, takeDirect } from "./direct/index.ts";
import { directFixture } from "./direct-test-support.ts";
import { apiRequest } from "./http.ts";
import * as pauses from "./pause.ts";
import { localTarget, resolveTarget } from "./target.ts";

vi.mock("../server/publish/executor.ts", async (original) => ({
  ...(await original<typeof import("../server/publish/executor.ts")>()),
}));

let templates: string;
beforeAll(async () => {
  templates = await mkdtemp(join(tmpdir(), "emend-attach-seed-"));
  // Separate identities for laptop and hub; close SQLite before copying its state per case.
  for (const name of ["laptop", "hub"]) {
    const state = await initializeServerState(join(templates, name));
    await state.db.close();
  }
});
afterAll(async () => {
  await rm(templates, { recursive: true, force: true });
});

describe.each(["HTTP", "in-process"])("%s transport", (mode) => {
  async function fixture() {
    const f = await directFixture();
    workInThread(executors);
    const hubDir = join(f.dir, "hub");
    const hubConfigDir = join(f.dir, "hub-config", "emend");
    await cp(join(templates, "laptop"), f.stateDir, { recursive: true });
    await cp(join(templates, "hub"), hubDir, { recursive: true });
    const apps = new Map<string, ReturnType<typeof createApp>>();
    if (mode === "in-process")
      vi.stubGlobal("fetch", async (input: string | URL | Request, init?: RequestInit) => {
        const request = new Request(input, init);
        const url = new URL(request.url);
        const app = apps.get(url.origin);
        if (!app) throw new TypeError("fetch failed", { cause: { code: "ECONNREFUSED" } });
        request.headers.set("Host", url.host);
        return app.fetch(request);
      });
    async function start(stateDir: string, port: number) {
      if (mode === "HTTP") return startServer({ stateDir, host: "127.0.0.1", port: 0 });
      const state = await initializeServerState(stateDir);
      const config = serverConfig("127.0.0.1", port, f.dir);
      const url = config.baseUrl;
      apps.set(url, createApp({ ...state, config, now: () => Date.now() }));
      writeSecretFile(join(stateDir, "server.json"), JSON.stringify({ url, pid: process.pid, key: config.serverKey }));
      let closed = false;
      return {
        url,
        close: async () => {
          if (closed) return;
          closed = true;
          apps.delete(url);
          await state.db.close();
          await rm(join(stateDir, "server.json"), { force: true });
        },
      };
    }
    const laptop = await start(f.stateDir, 3637);
    f.cleanup.push(laptop.close);
    const hub = await start(hubDir, 3638);
    f.cleanup.push(hub.close);
    writeSecretFile(join(hubConfigDir, "config.json"), JSON.stringify({ docRoots: [f.source] }));
    const pairing = PairingCreated.parse(
      await apiRequest(hubDir, await localTarget(hubDir, hub.url, "admin"), "/pairings", {
        method: "POST",
        body: { purpose: "machine" },
      }),
    );
    async function command(args: string[]) {
      const out = f.output();
      const cwd = vi.spyOn(process, "cwd").mockReturnValue(f.source);
      let code: number;
      try {
        code = await run(args, out.io);
      } finally {
        cwd.mockRestore();
      }
      return { ...out, code, text: out.stderr.join("") };
    }
    let reviewer: ReturnType<typeof f.reviewer> | undefined;
    return { ...f, hub, hubDir, hubConfigDir, laptop, pairing, command, reviewer: () => (reviewer ??= f.reviewer()) };
  }

  async function feedback(f: Awaited<ReturnType<typeof fixture>>, reviewId: string) {
    const reviewer = await f.reviewer();
    const thread = await reviewer.request(`/reviews/${reviewId}/threads`, {
      revision: 1,
      target: { kind: "review" },
      body: "Synthetic feedback",
    });
    expect(thread.status).toBe(201);
    const send = await reviewer.request(`/reviews/${reviewId}/sends`, { kind: "go", revision: 1, mode: "fix-clear" });
    expect(send.status).toBe(201);
    return reviewer;
  }

  test("machine pairing prints attach instruction without a QR code", async () => {
    const f = await fixture();
    const out = f.output();
    out.io.env.EMEND_HOME = f.hubDir;
    out.io.isTTY = true;
    expect(await run(["pair", "--machine"], out.io)).toBe(0);
    expect(out.stdout.join("")).toMatch(
      /^http.*\/pair#emp_.*\nThis link works only on this machine\. To attach another machine, run emend serve --tailscale\.\n[0-9A-Z]{4}-[0-9A-Z]{4}\nValid for 10 minutes, once\.\nOn the other machine, run: emend attach /,
    );
  });

  test.each([
    { feature: false, binned: true },
    { feature: false, binned: false },
    { feature: true, binned: true },
  ])("attach preserves the bin (hub feature=$feature, local binned=$binned)", async ({ feature, binned }) => {
    const f = await fixture();
    const { result } = await f.publish();
    const local = await f.reviewer();
    if (binned) expect((await local.request(`/reviews/${result.reviewId}/bin`, {})).status).toBe(204);
    const localRow = () =>
      local.db.read((q) =>
        q
          .select()
          .from(reviews)
          .where(and(eq(reviews.ownerId, local.ownerId), eq(reviews.id, result.reviewId)))
          .get(),
      );
    const before = await localRow();
    const hubState = await initializeServerState(f.hubDir);
    f.cleanup.push(() => hubState.db.close());
    const hubDevices = () =>
      hubState.db.read((q) => q.select().from(devices).where(eq(devices.ownerId, hubState.ownerId)));
    const devicesBefore = await hubDevices();
    const fetcher = globalThis.fetch;
    const requests = vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      const response = await fetcher(input, init);
      if (!feature && String(input) === `${f.hub.url}/api/v1/capabilities`) {
        const capabilities = Capabilities.parse(await response.json());
        return Response.json({
          ...capabilities,
          features: capabilities.features.filter((name) => name !== REVIEW_BIN_FEATURE),
        });
      }
      return response;
    });
    const attached = await f.command(["attach", f.pairing.url]);
    if (!feature && binned) {
      expect(attached).toMatchObject({
        code: 1,
        stdout: [],
        text: `emend: the server at ${f.hub.url} has no bin yet. Update emend there, or restore or delete the reviews in this machine's bin first.\n`,
      });
      expect(requests.mock.calls.map(([input]) => String(input))).toEqual([`${f.hub.url}/api/v1/capabilities`]);
      expect(await localRow()).toEqual(before);
      expect(await hubDevices()).toEqual(devicesBefore);
      for (const name of ["hub.token", "attach.json", "attach.pending"])
        await expect(stat(join(f.stateDir, name))).rejects.toMatchObject({ code: "ENOENT" });
      return;
    }
    expect(attached.code, attached.text).toBe(0);
    expect(attached.text).toContain("copied 1 reviews, skipped 0.");
    const copied = await hubState.db.read((q) =>
      q
        .select()
        .from(reviews)
        .where(and(eq(reviews.ownerId, hubState.ownerId), eq(reviews.id, result.reviewId)))
        .get(),
    );
    expect(copied?.binnedAt).toBe(before?.binnedAt);
    expect((await listBin(hubState.ownerId, hubState.db)).items.map((item) => item.id)).toEqual(
      binned ? [result.reviewId] : [],
    );
    expect((await localRow())?.movedToUrl).toBe(`${f.hub.url}/r/${result.reviewId}`);
    expect(await listBin(local.ownerId, local.db)).toEqual({ items: [], total: 0, more: false });
  });

  test.each(["detach", "attach"])("%s recovers a crash after saving the hub token", async (command) => {
    const f = await fixture();
    expect((await f.command(["attach", f.pairing.url])).code).toBe(0);
    await expect(stat(join(f.stateDir, "attach.pending"))).rejects.toMatchObject({ code: "ENOENT" });
    const target = await resolveTarget(f.stateDir);
    const token = await readFile(join(f.stateDir, "hub.token"), "utf8");
    await rm(join(f.stateDir, "attach.json"));
    writeSecretFile(join(f.stateDir, "attach.pending"), JSON.stringify({ hubUrl: f.hub.url }));
    const nextPairing = PairingCreated.parse(
      await apiRequest(f.hubDir, await localTarget(f.hubDir, f.hub.url, "admin"), "/pairings", {
        method: "POST",
        body: { purpose: "machine" },
      }),
    );
    const requests = vi.spyOn(globalThis, "fetch");
    const out = await f.command(command === "attach" ? [command, nextPairing.url] : [command]);
    expect(out.code).toBe(0);
    expect(out.text).toBe(
      `emend: removed an unfinished attachment to ${f.hub.url}; the hub revoked this machine.\n` +
        (command === "attach"
          ? "emend: attached to " +
            JSON.parse(await readFile(join(f.stateDir, "attach.json"), "utf8")).hubName +
            "; copied 0 reviews, skipped 0.\n"
          : ""),
    );
    const deleted = requests.mock.calls.filter(([, init]) => init?.method === "DELETE");
    expect(deleted).toHaveLength(1);
    expect(String(deleted[0]?.[0])).toBe(`${f.hub.url}/api/v1/machines/self`);
    expect(new Headers(deleted[0]?.[1]?.headers).get("Authorization")).toBe(`Bearer ${token}`);
    expect(out.text).not.toContain(token);
    await expect(apiRequest(f.stateDir, target, "/machines/self", { method: "DELETE" })).rejects.toThrow(
      "rejected this machine's credential",
    );
    await expect(stat(join(f.stateDir, "attach.pending"))).rejects.toMatchObject({ code: "ENOENT" });
    if (command === "detach")
      for (const name of ["hub.token", "attach.json"])
        await expect(stat(join(f.stateDir, name))).rejects.toMatchObject({ code: "ENOENT" });
    else expect(await readFile(join(f.stateDir, "hub.token"), "utf8")).not.toBe(token);
  });

  test("detach recovers an unfinished attachment when its hub is down", async () => {
    const f = await fixture();
    expect((await f.command(["attach", f.pairing.url])).code).toBe(0);
    await rm(join(f.stateDir, "attach.json"));
    writeSecretFile(join(f.stateDir, "attach.pending"), JSON.stringify({ hubUrl: f.hub.url }));
    await f.hub.close();
    expect(await f.command(["detach"])).toMatchObject({
      code: 0,
      text: `emend: removed an unfinished attachment to ${f.hub.url}. The hub did not confirm the revocation; revoke this machine in its devices.\n`,
    });
    for (const name of ["hub.token", "attach.json", "attach.pending"])
      await expect(stat(join(f.stateDir, name))).rejects.toMatchObject({ code: "ENOENT" });
  });

  test.each([true, false])(
    "a signal after registration revokes its token or names it (hub available %s)",
    async (available) => {
      const f = await fixture();
      const fetcher = globalThis.fetch;
      let token = "";
      const revocations: { url: string; authorization: string | null; aborted: boolean }[] = [];
      const transport = vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
        if (init?.method === "DELETE")
          revocations.push({
            url: String(input),
            authorization: new Headers(init.headers).get("Authorization"),
            aborted: Boolean(init.signal?.aborted),
          });
        const response = await fetcher(input, init);
        if (String(input).endsWith("/machines") && response.status === 201) {
          token = ((await response.clone().json()) as { token: string }).token;
          if (!available) await f.hub.close();
          process.emit("SIGTERM");
        }
        return response;
      });
      const out = await f.command(["attach", f.pairing.url]);
      expect(out).toMatchObject({
        code: 143,
        text: available
          ? ""
          : "emend: the hub registered this machine before emend stopped. Revoke this machine in the hub's devices.\n",
        stdout: [],
      });
      expect(token).toMatch(/^em_[A-Za-z0-9_-]{43}$/);
      expect(out.text).not.toContain(token);
      expect(revocations).toEqual([
        { url: `${f.hub.url}/api/v1/machines/self`, authorization: `Bearer ${token}`, aborted: false },
      ]);
      transport.mockRestore();
      if (available)
        await expect(
          apiRequest(f.stateDir, { via: "hub", url: f.hub.url, token }, "/machines/self", { method: "DELETE" }),
        ).rejects.toThrow("rejected this machine's credential");
      for (const name of ["hub.token", "attach.json", "attach.pending"])
        await expect(stat(join(f.stateDir, name))).rejects.toMatchObject({ code: "ENOENT" });
    },
  );

  // HTTP runs two real servers through copying two reviews, reconciliation, publishing and detaching.
  test(
    "attach copies whole reviews once, preserves ids, publishes and opens on the hub, then detaches",
    async () => {
      const f = await fixture();
      const first = await f.publish("first");
      const second = await f.publish("second");
      const local = await feedback(f, first.result.reviewId);
      await feedback(f, second.result.reviewId);
      const before = await local.db.read(async (q) => ({
        threads: await q.select().from(threads).where(eq(threads.ownerId, local.ownerId)),
        comments: await q.select().from(comments).where(eq(comments.ownerId, local.ownerId)),
        sends: await q.select().from(sends).where(eq(sends.ownerId, local.ownerId)),
      }));
      const attached = await f.command(["attach", f.pairing.url]);
      expect(attached.code).toBe(0);
      expect(attached.text).toContain("copied 2 reviews, skipped 0.");
      const token = await readFile(join(f.stateDir, "hub.token"), "utf8");
      for (const name of ["hub.token", "attach.json"])
        expect((await stat(join(f.stateDir, name))).mode & 0o777).toBe(0o600);
      expect(attached.text + attached.stdout.join("")).not.toContain(token.trim());
      // Simulate a prior response loss: the hub has this id, but its local mark was cleared.
      await local.db.query((q) =>
        q
          .update(reviews)
          .set({ movedToUrl: null })
          .where(and(eq(reviews.ownerId, local.ownerId), eq(reviews.id, first.result.reviewId))),
      );
      const repeat = await f.command(["attach", f.pairing.url]);
      expect(repeat.code).toBe(0);
      expect(repeat.text).toContain("copied 0 reviews, skipped 2.");
      expect(await readFile(join(f.stateDir, "hub.token"), "utf8")).toBe(token);
      // The hub is already initialized; these assertions only need a connection to read it.
      const hubDb = openDb(join(f.hubDir, "emend.db"));
      f.cleanup.push(() => hubDb.close());
      const hubOwner = await hubDb.read((q) => q.select({ id: owners.id }).from(owners).get());
      if (!hubOwner) throw new Error("Missing hub owner");
      for (const [table, rows] of [
        [threads, before.threads],
        [comments, before.comments],
        [sends, before.sends],
      ] as const) {
        const copied = await hubDb.read((q) =>
          q.select({ id: table.id }).from(table).where(eq(table.ownerId, hubOwner.id)),
        );
        expect(copied.map((r) => r.id).sort()).toEqual(rows.map((r) => r.id).sort());
      }
      writeSecretFile(join(f.configDir, "config.json"), JSON.stringify({ docRoots: [f.source], openBrowser: true }));
      const open = f.output();
      open.io.openUrl = vi.fn().mockResolvedValue(true);
      expect(await run([], open.io)).toBe(0);
      expect(open.io.openUrl).toHaveBeenCalledWith(f.hub.url);
      const headless = f.output();
      headless.io.openUrl = vi.fn().mockResolvedValue(false);
      expect(await run([], headless.io)).toBe(0);
      expect(headless.stdout.join("")).toBe(`${f.hub.url}\n`);
      const pub = await f.command(["publish", "--manifest", f.manifest, "--review", first.result.reviewId]);
      expect(pub.code, pub.text).toBe(0);
      expect(PublishResponse.parse(JSON.parse(pub.stdout.join("")))).toMatchObject({
        reviewId: first.result.reviewId,
        revision: 2,
        url: `${f.hub.url}/r/${first.result.reviewId}`,
      });
      const fresh = await f.publish("fresh");
      expect(fresh.result.url).toBe(`${f.hub.url}/r/${fresh.result.reviewId}`);
      const origin = await hubDb.read((q) =>
        q
          .select()
          .from(reviews)
          .where(and(eq(reviews.ownerId, hubOwner.id), eq(reviews.id, fresh.result.reviewId)))
          .get(),
      );
      expect(origin?.originInstanceId).toBe(local.instance.id);
      const target = await resolveTarget(f.stateDir);
      expect((await f.command(["detach"])).code).toBe(0);
      await expect(
        apiRequest(f.stateDir, target, `/reviews/${first.result.reviewId}/take`, {
          method: "POST",
          body: { waitSeconds: 0 },
        }),
      ).rejects.toThrow("rejected this machine's credential");
      const moved = await f.command(["publish", "--manifest", f.manifest, "--review", first.result.reviewId]);
      expect(moved.code).toBe(1);
      expect(moved.text).toBe(
        `emend: This review moved to ${f.hub.url}. Attach again, or pass --key for a new review.\n`,
      );
      await f.laptop.close();
      const directMoved = await f.command(["publish", "--manifest", f.manifest, "--key", "first"]);
      expect(directMoved.text).toBe(
        `emend: This review moved to ${f.hub.url}. Attach again, or pass --key for a new review.\n`,
      );
      for (const args of [
        ["feedback", first.result.reviewId],
        ["wait", first.result.reviewId],
        ["reply", before.comments[0]?.id ?? "", "--status", "fixed", "--body", "Synthetic reply"],
      ]) {
        const out = await f.command(args);
        expect(out.code).toBe(1);
        expect(out.text).toBe(`emend: This review moved to ${f.hub.url}. Attach again.\n`);
      }
    },
    mode === "HTTP" ? 30000 : undefined,
  );

  test("expired leases copy with feedback available; live unconfirmed leases remain local", async () => {
    const f = await fixture();
    const expired = await f.publish("expired");
    const live = await f.publish("live");
    const local = await feedback(f, expired.result.reviewId);
    await feedback(f, live.result.reviewId);
    const target = await localTarget(f.stateDir, f.laptop.url);
    for (const reviewId of [expired.result.reviewId, live.result.reviewId])
      await apiRequest(f.stateDir, target, `/reviews/${reviewId}/take`, { method: "POST", body: { waitSeconds: 0 } });
    await local.db.query((q) =>
      q
        .update(deliveries)
        .set({ leaseUntil: 1 })
        .where(and(eq(deliveries.ownerId, local.ownerId), eq(deliveries.reviewId, expired.result.reviewId))),
    );
    // Fix the clock relative to leases, without timing assertions.
    const lease = await local.db.read((q) =>
      q
        .select()
        .from(deliveries)
        .where(and(eq(deliveries.ownerId, local.ownerId), eq(deliveries.reviewId, live.result.reviewId)))
        .get(),
    );
    if (!lease) throw new Error("Missing lease");
    vi.spyOn(Date, "now").mockReturnValue(lease.leaseUntil - 60_000);
    const out = await f.command(["attach", f.pairing.url]);
    expect(out.code).toBe(1);
    expect(out.text).toContain(
      `review ${live.result.reviewId} has a running wait; run emend attach again when it ends.`,
    );
    const got = await f.command(["wait", expired.result.reviewId]);
    expect(got.code).toBe(0);
    expect(JSON.parse(got.stdout.join(""))).toMatchObject({ kind: "go", comments: [{ body: "Synthetic feedback" }] });
    expect(
      await local.db.read((q) =>
        q
          .select()
          .from(reviews)
          .where(and(eq(reviews.ownerId, local.ownerId), eq(reviews.id, live.result.reviewId)))
          .get(),
      ),
    ).toMatchObject({ movedToUrl: null });
  });

  test("a confirmed delivery with a future lease copies and is not offered again", async () => {
    const f = await fixture();
    const review = await f.publish();
    const local = await feedback(f, review.result.reviewId);
    expect((await f.command(["feedback", review.result.reviewId])).code).toBe(0);
    const delivery = await local.db.read((q) =>
      q
        .select()
        .from(deliveries)
        .where(and(eq(deliveries.ownerId, local.ownerId), eq(deliveries.reviewId, review.result.reviewId)))
        .get(),
    );
    if (!delivery) throw new Error("Missing confirmed delivery");
    expect(delivery.confirmedAt).not.toBeNull();
    vi.spyOn(Date, "now").mockReturnValue(delivery.leaseUntil - 60000);
    // Keep import's default executor wiring covered by a real worker on both transports.
    vi.mocked(executors.workerExecutor).mockRestore();
    const worker = vi.spyOn(executors, "workerExecutor");
    expect((await f.command(["attach", f.pairing.url])).code).toBe(0);
    expect(worker).toHaveBeenCalled();
    const after = await f.command(["feedback", review.result.reviewId]);
    expect(after.code).toBe(0);
    expect(JSON.parse(after.stdout.join(""))).toMatchObject({ kind: "pending" });
  });

  test("a pre-existing mark with no hub row resumes import, uploads missing blobs and preserves ids", async () => {
    const f = await fixture();
    const review = await f.publish();
    const local = await feedback(f, review.result.reviewId);
    await local.db.query((q) =>
      q
        .update(reviews)
        .set({ movedToUrl: `${f.hub.url}/r/${review.result.reviewId}` })
        .where(and(eq(reviews.ownerId, local.ownerId), eq(reviews.id, review.result.reviewId))),
    );
    const fetcher = vi.spyOn(globalThis, "fetch");
    const out = await f.command(["attach", f.pairing.url]);
    expect(out.code, out.text).toBe(0);
    expect(out.text).toContain("copied 1 reviews, skipped 0.");
    const paths = fetcher.mock.calls.map((call) => new URL(String(call[0])).pathname);
    expect(paths.indexOf("/api/v1/import")).toBeLessThan(paths.findIndex((path) => path.includes("/blobs/")));
    const got = await f.command(["feedback", review.result.reviewId]);
    expect(got.code).toBe(0);
    expect(JSON.parse(got.stdout.join(""))).toMatchObject({
      reviewId: review.result.reviewId,
      kind: "go",
      comments: [{ body: "Synthetic feedback" }],
    });
    fetcher.mockClear();
    const repeated = await f.command(["attach", f.pairing.url]);
    expect(repeated.code).toBe(0);
    expect(repeated.text).toContain("copied 0 reviews, skipped 1.");
    expect(fetcher.mock.calls.some((call) => String(call[0]).includes("/blobs/"))).toBe(false);
  });

  test("lost responses after hub commitment keep local delivery closed until a later attach confirms", async () => {
    const f = await fixture();
    const review = await f.publish();
    const local = await feedback(f, review.result.reviewId);
    const fetcher = globalThis.fetch;
    const bodies: unknown[] = [];
    const lost = vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      const response = await fetcher(input, init);
      if (String(input).endsWith("/import")) {
        bodies.push(init?.body);
        expect([200, 201]).toContain(response.status);
        throw new TypeError("Synthetic response lost after commit");
      }
      return response;
    });
    const out = await f.command(["attach", f.pairing.url]);
    expect(out.code).toBe(1);
    expect(out.text).toContain(`emend: could not confirm the copy of review ${review.result.reviewId}:`);
    expect(out.text).toContain("Run emend attach again.");
    expect(bodies).toHaveLength(2);
    expect(bodies[0]).toBe(bodies[1]);
    await expect(takeDirect(f.stateDir, review.result.reviewId, 0)).rejects.toMatchObject({ code: "review_moved" });
    expect(
      await local.db.read((q) =>
        q
          .select()
          .from(reviews)
          .where(and(eq(reviews.ownerId, local.ownerId), eq(reviews.id, review.result.reviewId)))
          .get(),
      ),
    ).toMatchObject({ movedToUrl: `${f.hub.url}/r/${review.result.reviewId}` });
    lost.mockRestore();
    const resumed = await f.command(["attach", f.pairing.url]);
    expect(resumed.code).toBe(0);
    expect(resumed.text).toContain("copied 0 reviews, skipped 1.");
  });

  test.each(["network", "gateway 504"])(
    "an un-aborted import with a lost %s answer and six busy retries cannot deliver twice",
    async (failure) => {
      const f = await fixture();
      const review = await f.publish();
      const id = review.result.reviewId;
      const local = await feedback(f, id);
      const originalSend = await local.db.read((q) =>
        q
          .select()
          .from(sends)
          .where(and(eq(sends.ownerId, local.ownerId), eq(sends.reviewId, id)))
          .get(),
      );
      const entered = Promise.withResolvers<void>();
      const resume = Promise.withResolvers<void>();
      const render = rendering.renderRevision;
      vi.spyOn(rendering, "renderRevision").mockImplementationOnce(async (...args) => {
        entered.resolve();
        await resume.promise;
        return render(...args);
      });
      const delay = vi.spyOn(pauses, "pause").mockResolvedValue();
      const fetcher = globalThis.fetch;
      let pending: Promise<Response> | undefined;
      const statuses: number[] = [];
      const bodies: unknown[] = [];
      const transport = vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
        if (!String(input).endsWith("/import")) return fetcher(input, init);
        bodies.push(init?.body);
        if (!pending) {
          // A proxy loses the answer but leaves the hub's request alive during rendering.
          pending = fetcher(input, { ...init, signal: undefined });
          await entered.promise;
          if (failure === "network") throw new TypeError("Synthetic connection lost after sending");
          return new Response("Synthetic gateway timeout", { status: 504 });
        }
        const response = await fetcher(input, init);
        statuses.push(response.status);
        expect(await response.clone().json()).toMatchObject({ error: { code: "rate_limited" } });
        return response;
      });
      onTestFinished(async () => {
        resume.resolve();
        transport.mockRestore();
        await pending;
      });
      try {
        const out = await f.command(["attach", f.pairing.url]);
        expect(out.code).toBe(1);
        expect(out.text).toContain(`could not confirm the copy of review ${id}:`);
        expect(out.text).toContain("Run emend attach again.");
        expect(statuses).toEqual(Array(6).fill(429));
        expect(delay).toHaveBeenCalledTimes(5);
        expect(new Set(bodies).size).toBe(1);
        await expect(takeDirect(f.stateDir, id, 0)).rejects.toMatchObject({ code: "review_moved" });
        expect(
          await local.db.read((q) =>
            q
              .select()
              .from(deliveries)
              .where(and(eq(deliveries.ownerId, local.ownerId), eq(deliveries.reviewId, id))),
          ),
        ).toEqual([]);
      } finally {
        resume.resolve();
        transport.mockRestore();
        if (pending) expect((await pending).status).toBe(201);
      }
      const target = await resolveTarget(f.stateDir);
      const taken = WaitResult.parse(
        await apiRequest(f.stateDir, target, `/reviews/${id}/take`, {
          method: "POST",
          body: { waitSeconds: 0 },
        }),
      );
      expect(taken.kind).toBe("go");
      if (taken.kind === "pending") throw new Error("Missing hub delivery");
      await apiRequest(f.stateDir, target, `/deliveries/${taken.deliveryId}/confirm`, { method: "POST" });
      const hubState = await initializeServerState(f.hubDir);
      f.cleanup.push(() => hubState.db.close());
      expect(
        await hubState.db.read((q) =>
          q
            .select()
            .from(sends)
            .where(and(eq(sends.ownerId, hubState.ownerId), eq(sends.id, originalSend?.id ?? "")))
            .get(),
        ),
      ).toMatchObject({ id: originalSend?.id, deliveryId: taken.deliveryId });
      expect(
        await hubState.db.read((q) =>
          q
            .select()
            .from(deliveries)
            .where(and(eq(deliveries.ownerId, hubState.ownerId), eq(deliveries.id, taken.deliveryId)))
            .get(),
        ),
      ).toMatchObject({ confirmedAt: expect.any(Number) });
      await expect(takeDirect(f.stateDir, id, 0)).rejects.toMatchObject({ code: "review_moved" });
      const resumed = await f.command(["attach", f.pairing.url]);
      expect(resumed.code).toBe(0);
      expect(resumed.text).toContain("copied 0 reviews, skipped 1.");
    },
  );

  test("publishing by key during copy addresses the original id until import commits", async () => {
    const f = await fixture();
    const review = await f.publish("copying");
    const local = await feedback(f, review.result.reviewId);
    await local.db.query((q) =>
      q
        .update(reviews)
        .set({ movedToUrl: `${f.hub.url}/r/${review.result.reviewId}` })
        .where(and(eq(reviews.ownerId, local.ownerId), eq(reviews.id, review.result.reviewId))),
    );
    const fetcher = globalThis.fetch;
    let publishing: Awaited<ReturnType<typeof f.command>> | undefined;
    const transport = vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      if (String(input).endsWith("/import") && !publishing) {
        publishing = await f.command(["publish", "--manifest", f.manifest, "--key", "copying"]);
        expect(publishing.code).toBe(1);
        expect(publishing.text).toBe("emend: unknown_review\n");
      }
      return fetcher(input, init);
    });
    const copied = await f.command(["attach", f.pairing.url]);
    expect(copied.code, copied.text).toBe(0);
    const requests = transport.mock.calls.filter(([url]) => String(url).endsWith("/publish"));
    expect(requests).toHaveLength(1);
    expect(JSON.parse(String(requests[0]?.[1]?.body))).toMatchObject({ reviewId: review.result.reviewId });
    const after = await f.publish("copying");
    expect(after.result).toMatchObject({ reviewId: review.result.reviewId, revision: 2 });
  });

  test("a resend with a missing local blob releases the mark instead of stranding the Send on every attach", async () => {
    const f = await fixture();
    const review = await f.publish();
    const id = review.result.reviewId;
    const local = await feedback(f, id);
    await local.db.query((q) =>
      q
        .update(reviews)
        .set({ movedToUrl: `${f.hub.url}/r/${id}` })
        .where(and(eq(reviews.ownerId, local.ownerId), eq(reviews.id, id))),
    );
    const hubState = await initializeServerState(f.hubDir);
    f.cleanup.push(() => hubState.db.close());
    const fetcher = globalThis.fetch;
    const imports: number[] = [];
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      const response = await fetcher(input, init);
      if (String(input).endsWith("/import")) {
        imports.push(response.status);
        expect(await response.clone().json()).toMatchObject({ error: { code: "blob_missing" } });
      }
      return response;
    });
    const missing = vi.spyOn(BlobStore.prototype, "get").mockResolvedValue(null);
    for (let attempt = 0; attempt < 3; attempt++) {
      const out = await f.command(["attach", f.pairing.url]);
      expect(out.code).toBe(1);
      expect(out.text).toContain(`could not copy review ${id}: A required blob is missing.`);
      expect(
        await local.db.read((q) =>
          q
            .select()
            .from(reviews)
            .where(and(eq(reviews.ownerId, local.ownerId), eq(reviews.id, id)))
            .get(),
        ),
      ).toMatchObject({ movedToUrl: null });
      expect(
        await hubState.db.read((q) => q.select().from(reviews).where(eq(reviews.ownerId, hubState.ownerId))),
      ).toEqual([]);
    }
    expect(imports).toEqual([400]);
    missing.mockRestore();
    const taken = await takeDirect(f.stateDir, id, 0);
    expect(taken.kind).toBe("go");
    if (taken.kind === "pending") throw new Error("Missing local delivery");
    await confirmDirect(f.stateDir, taken.deliveryId);
    expect(await takeDirect(f.stateDir, id, 0)).toMatchObject({ kind: "pending" });
  });

  test("a concurrent attach cannot clear the paused import's mark or deliver its Send locally", async () => {
    const f = await fixture();
    const review = await f.publish();
    const id = review.result.reviewId;
    await feedback(f, id);
    const entered = Promise.withResolvers<void>();
    const resume = Promise.withResolvers<void>();
    const render = rendering.renderRevision;
    vi.spyOn(rendering, "renderRevision").mockImplementationOnce(async (...args) => {
      entered.resolve();
      await resume.promise;
      return render(...args);
    });
    vi.spyOn(pauses, "pause").mockResolvedValue();
    const fetcher = vi.spyOn(globalThis, "fetch");
    const first = f.command(["attach", f.pairing.url]);
    onTestFinished(async () => {
      resume.resolve();
      await first;
    });
    await entered.promise;
    try {
      fetcher.mockClear();
      const second = await f.command(["attach", f.pairing.url]);
      expect(second).toMatchObject({ code: 1, text: "emend: another emend attach is running. Nothing was changed.\n" });
      expect(fetcher).not.toHaveBeenCalled();
      expect((await stat(join(f.stateDir, "attach.lock"))).mode & 0o777).toBe(0o600);
      await expect(takeDirect(f.stateDir, id, 0)).rejects.toMatchObject({ code: "review_moved" });
    } finally {
      resume.resolve();
      expect((await first).code).toBe(0);
    }
    lockAttach(f.stateDir)();
    expect((await stat(join(f.stateDir, "attach.lock"))).mode & 0o777).toBe(0o600);
    await expect(takeDirect(f.stateDir, id, 0)).rejects.toMatchObject({ code: "review_moved" });
    const out = await f.command(["feedback", id]);
    expect(out.code).toBe(0);
    expect(JSON.parse(out.stdout.join(""))).toMatchObject({ kind: "go", reviewId: id });
    const again = await f.command(["feedback", id]);
    expect(JSON.parse(again.stdout.join(""))).toMatchObject({ kind: "pending" });
  });

  test("machine scope isolates the hub's reviews and its inbox identifies the laptop", async () => {
    const f = await fixture();
    const out = f.output();
    // Keep server publish's default executor wiring covered by a real worker too.
    vi.mocked(executors.workerExecutor).mockRestore();
    const worker = vi.spyOn(executors, "workerExecutor");
    await publishCommand(f.hubDir, f.hubConfigDir, ["--manifest", f.manifest, "--key", "hub-review"], out.io, f.source);
    expect(worker).toHaveBeenCalled();
    workInThread(executors);
    const hubReview = PublishResponse.parse(JSON.parse(out.stdout.join("")));
    expect((await f.command(["attach", f.pairing.url])).code).toBe(0);
    const target = await resolveTarget(f.stateDir);
    await expect(
      apiRequest(f.stateDir, target, `/reviews/${hubReview.reviewId}/take`, {
        method: "POST",
        body: { waitSeconds: 0 },
      }),
    ).rejects.toMatchObject({ code: "unknown_review" });
    const local = await f.publish("laptop-review");
    const state = await initializeServerState(f.hubDir);
    f.cleanup.push(() => state.db.close());
    const device = await state.db.query((q) =>
      q
        .insert(devices)
        .values({ ownerId: state.ownerId, kind: "browser", name: "Synthetic reviewer" })
        .returning()
        .get(),
    );
    const session = await createToken(state.db, state.ownerId, "reviewer", {
      deviceId: device?.id,
      expiresAt: Date.now() + SESSION_MS,
    });
    const response = await fetch(`${f.hub.url}/api/v1/reviews`, {
      headers: { Cookie: `emend_session=${session.secret}` },
    });
    expect(response.status).toBe(200);
    const inbox = InboxList.parse(await response.json());
    const instance = JSON.parse(await readFile(join(f.stateDir, "instance.json"), "utf8"));
    expect(inbox.items.find((r) => r.id === local.result.reviewId)?.origin).toEqual(instance);
  });

  test("copy preserves HTML asset associations and ignores other origins", async () => {
    const f = await fixture();
    await writeFile(join(f.source, "one.html"), '<h1>Synthetic one</h1><img src="shared.svg">');
    await writeFile(join(f.source, "two.html"), '<h1>Synthetic two</h1><img src="shared.svg">');
    await writeFile(join(f.source, "shared.svg"), '<svg xmlns="http://www.w3.org/2000/svg"/>');
    const manifest = JSON.parse(await readFile(f.manifest, "utf8"));
    manifest.files.push({ path: "one.html", role: "doc" }, { path: "two.html", role: "doc" });
    await writeFile(f.manifest, JSON.stringify(manifest));
    const current = await f.publish("current");
    const earlier = await f.publish("earlier");
    const foreign = await f.publish("foreign");
    const state = await initializeServerState(f.stateDir, { tokens: false });
    f.cleanup.push(() => state.db.close());
    await state.db.transaction(
      async (q) => {
        for (const [id, wasSelf] of [
          [earlier.result.reviewId, true],
          [foreign.result.reviewId, false],
        ] as const) {
          const instanceId = randomUUID();
          await q.insert(instances).values({ id: instanceId, name: "Synthetic other", wasSelf });
          await q
            .update(reviews)
            .set({ originInstanceId: instanceId })
            .where(and(eq(reviews.ownerId, state.ownerId), eq(reviews.id, id)));
        }
      },
      { offThread: true },
    );
    const before = await state.db.read((q) => q.select().from(docAssets).where(eq(docAssets.ownerId, state.ownerId)));
    const out = await f.command(["attach", f.pairing.url]);
    expect(out.code, out.text).toBe(0);
    expect(out.text).toContain("copied 1 reviews, skipped 0.");
    const hubState = await initializeServerState(f.hubDir);
    f.cleanup.push(() => hubState.db.close());
    const copied = await hubState.db.read((q) =>
      q.select().from(docAssets).where(eq(docAssets.ownerId, hubState.ownerId)),
    );
    expect(copied.length).toBeGreaterThan(0);
    for (const row of copied) expect(before).toContainEqual({ ...row, ownerId: state.ownerId });
    expect(
      await hubState.db.read((q) =>
        q.select({ id: reviews.id }).from(reviews).where(eq(reviews.ownerId, hubState.ownerId)),
      ),
    ).toEqual([{ id: current.result.reviewId }]);
  });

  test("hub down never falls back and detach still removes attachment", async () => {
    const f = await fixture();
    const review = await f.publish();
    expect((await f.command(["attach", f.pairing.url])).code).toBe(0);
    await f.hub.close();
    await f.laptop.close();
    const before = await readFile(join(f.stateDir, "emend.db"));
    for (const args of [
      ["publish", "--manifest", f.manifest, "--review", review.result.reviewId],
      ["wait", review.result.reviewId],
      ["feedback", review.result.reviewId],
      ["reply", randomUUID(), "--status", "fixed", "--body", "Reply"],
      ["mcp"],
    ]) {
      const out = await f.command(args);
      expect(out.code).toBe(1);
      expect(out.stdout).toEqual([]);
      expect(out.text).toBe(`emend: cannot reach the hub at ${f.hub.url}: connection refused. Nothing was changed.\n`);
    }
    expect((await readFile(join(f.stateDir, "emend.db"))).equals(before)).toBe(true);
    await expect(stat(join(f.stateDir, "server.json"))).rejects.toMatchObject({ code: "ENOENT" });
    const out = await f.command(["detach"]);
    expect(out.code).toBe(0);
    expect(out.text).toContain("The hub was not reached; revoke this machine in its devices.");
    for (const file of ["attach.json", "hub.token"])
      await expect(stat(join(f.stateDir, file))).rejects.toMatchObject({ code: "ENOENT" });
  });
});

test.each([
  "not a url",
  `http://example.test/pair#emp_${"a".repeat(43)}`,
  `https://user@example.test/pair#emp_${"a".repeat(43)}`,
  `https://example.test/pair?x#emp_${"a".repeat(43)}`,
  `https://example.test/x/../pair#emp_${"a".repeat(43)}`,
])("invalid pairing link: %s", async (link) => {
  const f = await directFixture();
  const out = f.output();
  expect(await run(["attach", link], out.io)).toBe(2);
  expect(out.stderr.join("")).toBe("emend: Invalid pairing link.\n");
  for (const file of ["attach.json", "hub.token"])
    await expect(stat(join(f.stateDir, file))).rejects.toMatchObject({ code: "ENOENT" });
});
