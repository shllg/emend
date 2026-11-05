import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { chmod, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { type ImportBundle, importRowCount, LIMITS } from "@emend/contract";
import { and, eq } from "drizzle-orm";
import { expect, test, vi } from "vitest";
import { comments, reviews } from "../db/schema.ts";
import { run } from "../main.ts";
import { initializeServerState } from "../server/state.ts";
import { writeSecretFile } from "../state/files.ts";
import * as tokens from "../state/token-file.ts";
import { prepareBundle } from "./attach/bundle.ts";
import { canClearCopyMark, copyReviews } from "./attach/copy.ts";
import { lockAttach } from "./attach/lock.ts";
import { takeDirect } from "./direct/index.ts";
import { directFixture } from "./direct-test-support.ts";
import { escapeReference } from "./escape.ts";
import { apiRequest, CliApiError, CliConnectionError, CliError, CliHttpError, CliSignalExit } from "./http.ts";
import { movedError } from "./moved.ts";
import * as pauses from "./pause.ts";
import * as targets from "./target.ts";

const origin = "https://hub.example.test";
const link = `${origin}/pair#emp_${"s".repeat(43)}`;
const token = `em_${"t".repeat(43)}`;
const hub = { id: randomUUID(), name: "Synthetic hub", url: origin };
const capabilities = () => Response.json({ api: 1, version: "0.1.0", features: ["attach"] });
async function fixture() {
  const f = await directFixture();
  const calls: { url: string; init: RequestInit }[] = [];
  const handler = vi.fn(async (url: string, init: RequestInit): Promise<Response> => {
    if (url.endsWith("/capabilities")) return capabilities();
    if (url.endsWith("/machines")) return Response.json({ token, hub }, { status: 201 });
    if (init.method === "HEAD") return new Response(null, { status: 404 });
    if (init.method === "PUT" || init.method === "DELETE") return new Response(null, { status: 204 });
    if (url.endsWith("/import")) return Response.json({ skipped: false }, { status: 201 });
    throw new Error("Unexpected request");
  });
  vi.stubGlobal("fetch", async (url: string | URL, init: RequestInit = {}) => {
    calls.push({ url: String(url), init });
    return handler(String(url), init);
  });
  const command = async (args = ["attach", link]) => {
    const out = f.output();
    const code = await run(args, out.io);
    const text = out.stderr.join("");
    expect(text + out.stdout.join("")).not.toContain(token);
    return { ...out, code, text };
  };
  const absent = async () => {
    for (const file of ["attach.json", "hub.token", "attach.pending"])
      await expect(stat(join(f.stateDir, file))).rejects.toMatchObject({ code: "ENOENT" });
  };
  const lockReleased = async () => {
    const path = join(f.stateDir, "attach.lock");
    const before = await stat(path);
    expect(before.mode & 0o777).toBe(0o600);
    lockAttach(f.stateDir)();
    expect((await stat(path)).ino).toBe(before.ino);
  };
  return { ...f, handler, calls, command, absent, lockReleased };
}

test("hub without attach is refused before bootstrap or registration", async () => {
  const f = await fixture();
  f.handler.mockResolvedValue(Response.json({ api: 1, version: "0.1.0", features: [] }));
  expect(await f.command()).toMatchObject({
    code: 1,
    text: `emend: the server at ${origin} cannot accept machines.\n`,
  });
  expect(f.calls).toHaveLength(1);
  await f.absent();
  await expect(stat(join(f.stateDir, "instance.json"))).rejects.toMatchObject({ code: "ENOENT" });
});

test.each([400, 401, 409])(
  "registration %i prints the hub message as one line and writes no credentials",
  async (status) => {
    const f = await fixture();
    f.handler.mockImplementation(async (url) =>
      url.endsWith("/capabilities")
        ? capabilities()
        : Response.json(
            {
              error: {
                code: status === 400 ? "wrong_origin" : status === 401 ? "unauthorized" : "instance_attached",
                message: `Synthetic refusal\n${token}`,
              },
            },
            { status },
          ),
    );
    expect(await f.command()).toMatchObject({ code: 1, text: "emend: Synthetic refusal [redacted]\n" });
    await f.absent();
  },
);

test("mismatched registration revokes only at the pairing origin and writes nothing", async () => {
  const f = await fixture();
  f.handler.mockImplementation(async (url, init) =>
    url.endsWith("/capabilities")
      ? capabilities()
      : init.method === "DELETE"
        ? new Response(null, { status: 204 })
        : Response.json({ token, hub: { ...hub, url: "https://other.example.test" } }, { status: 201 }),
  );
  expect(await f.command()).toMatchObject({
    code: 1,
    text: "emend: the hub's address does not match the pairing link.\n",
  });
  expect(f.calls.map((c) => c.url)).toEqual([
    `${origin}/api/v1/capabilities`,
    `${origin}/api/v1/machines`,
    `${origin}/api/v1/machines/self`,
  ]);
  expect(f.calls.every((c) => c.init.redirect === "error")).toBe(true);
  await f.absent();
});

test("a different hub is refused without contacting either hub or replacing files", async () => {
  const f = await fixture();
  expect((await f.command()).code).toBe(0);
  const before = await readFile(join(f.stateDir, "attach.json"));
  f.calls.length = 0;
  expect(await f.command(["attach", link.replace("hub.example.test", "other.example.test")])).toMatchObject({
    code: 1,
    text: "emend: emend is attached to Synthetic hub. Run emend detach first.\n",
  });
  expect(f.calls).toEqual([]);
  expect(await readFile(join(f.stateDir, "attach.json"))).toEqual(before);
  expect((await readFile(join(f.stateDir, "hub.token"), "utf8")) === token).toBe(true);
});

test("each new registration to the same hub writes a fresh id; a repeated attach preserves it", async () => {
  const f = await fixture();
  const path = join(f.stateDir, "attach.json");
  expect((await f.command()).code).toBe(0);
  const first = JSON.parse(await readFile(path, "utf8"));
  expect(first.registration).toMatch(/^[A-Za-z0-9_-]{22}$/);
  expect(Buffer.from(first.registration, "base64url")).toHaveLength(16);
  expect((await f.command()).code).toBe(0);
  expect(JSON.parse(await readFile(path, "utf8"))).toEqual(first);
  expect((await f.command(["detach"])).code).toBe(0);
  expect((await f.command()).code).toBe(0);
  const second = JSON.parse(await readFile(path, "utf8"));
  expect(second).toEqual({ ...first, registration: expect.any(String) });
  expect(second.registration).toMatch(/^[A-Za-z0-9_-]{22}$/);
  expect(Buffer.from(second.registration, "base64url")).toHaveLength(16);
  expect(second.registration).not.toBe(first.registration);
  expect(f.calls.filter((call) => call.url.endsWith("/machines"))).toHaveLength(2);
});

test.each(["💻", "  Synthetic  💻 laptop!  "])("machine name is filtered: %s", async (name) => {
  const f = await fixture();
  writeSecretFile(join(f.stateDir, "instance.json"), JSON.stringify({ id: randomUUID(), name }));
  expect((await f.command()).code).toBe(0);
  const request = f.calls.find((c) => c.url.endsWith("/machines"));
  expect(JSON.parse(String(request?.init.body)).instance.name).toBe(name === "💻" ? "Machine" : "Synthetic laptop");
  await expect(stat(join(f.stateDir, "agent.token"))).rejects.toMatchObject({ code: "ENOENT" });
  await expect(stat(join(f.stateDir, "admin.token"))).rejects.toMatchObject({ code: "ENOENT" });
  await expect(stat(join(f.stateDir, "server.json"))).rejects.toMatchObject({ code: "ENOENT" });
});

test("capabilities are size limited and redirects never receive a credential", async () => {
  const f = await fixture();
  f.handler.mockResolvedValue(new Response(" ".repeat(LIMITS.publicJsonBytes + 1)));
  expect((await f.command()).code).toBe(1);
  expect(f.calls).toHaveLength(1);
  expect(new Headers(f.calls[0]?.init.headers).has("Authorization")).toBe(false);
  expect(f.calls[0]?.init.redirect).toBe("error");
  await f.absent();
  f.handler.mockResolvedValue(new Response(null, { status: 302, headers: { Location: "https://other.example.test" } }));
  expect((await f.command()).code).toBe(1);
  await f.absent();
});

test("failed imports undo the marker, retry a busy hub five times, and can be copied later", async () => {
  const f = await fixture();
  const published = await f.publish();
  const state = await initializeServerState(f.stateDir, { tokens: false });
  f.cleanup.push(() => state.db.close());
  const normal = f.handler.getMockImplementation();
  if (!normal) throw new Error("Missing handler");
  const delay = vi.spyOn(pauses, "pause").mockResolvedValue();
  let markedAtUpload = false;
  f.handler.mockImplementation(async (url, init) => {
    if (url.endsWith("/import")) {
      markedAtUpload = Boolean(
        await state.db.read((q) =>
          q
            .select()
            .from(reviews)
            .where(
              and(
                eq(reviews.ownerId, state.ownerId),
                eq(reviews.id, published.result.reviewId),
                eq(reviews.movedToUrl, `${origin}/r/${published.result.reviewId}`),
              ),
            )
            .get(),
        ),
      );
      return Response.json(
        { error: { code: "rate_limited", message: "The server is busy importing; try again." } },
        { status: 429 },
      );
    }
    return normal(url, init);
  });
  const failed = await f.command();
  expect(failed.code).toBe(1);
  await f.lockReleased();
  expect(failed.text).toContain("The server is busy importing; try again.");
  expect(markedAtUpload).toBe(true);
  expect(f.calls.filter((c) => c.url.endsWith("/import"))).toHaveLength(6);
  expect(delay.mock.calls).toHaveLength(5);
  expect(delay.mock.calls.every((call) => call[0] === 1000 && call[1] instanceof AbortSignal)).toBe(true);
  expect(
    await state.db.read((q) =>
      q
        .select()
        .from(reviews)
        .where(and(eq(reviews.ownerId, state.ownerId), eq(reviews.id, published.result.reviewId)))
        .get(),
    ),
  ).toMatchObject({ movedToUrl: null });
  f.handler.mockImplementation(normal);
  f.calls.length = 0;
  expect((await f.command()).code).toBe(0);
  expect(f.calls.filter((c) => c.url.endsWith("/machines"))).toEqual([]);
  const imported = JSON.parse(String(f.calls.find((c) => c.url.endsWith("/import"))?.init.body));
  expect(imported.placements).toBeUndefined();
  expect(imported.changedBlocks).toBeUndefined();
  expect(imported.review.ownerId).toBeUndefined();
  expect(imported.revisions[0].contentKey).toBeUndefined();
  const rendered = imported.writeups[0].renderedBlob;
  expect(f.calls.some((c) => c.url.endsWith(`/blobs/${rendered}`) && c.init.method === "PUT")).toBe(true);
  const bundle: ImportBundle = imported;
  expect(importRowCount(bundle)).toBeLessThan(LIMITS.importRows);
  for (const [key, limit] of [
    ["revisions", LIMITS.importRevisions],
    ["threads", LIMITS.importThreads],
    ["comments", LIMITS.importComments],
    ["sends", LIMITS.importSends],
    ["deliveries", LIMITS.importDeliveries],
  ] as const) {
    expect(() => prepareBundle({ ...bundle, [key]: Array.from({ length: limit + 1 }) })).toThrow("too large");
  }
  expect(() => prepareBundle({ ...bundle, docAssets: Array.from({ length: LIMITS.importRows }) })).toThrow("too large");
});

test("import byte preflight measures UTF-8 and restores the mark without any upload", async () => {
  const f = await fixture();
  const published = await f.publish();
  const state = await initializeServerState(f.stateDir, { tokens: false });
  f.cleanup.push(() => state.db.close());
  const reviewer = await f.reviewer();
  // Each comment is valid; the whole JSON exceeds the byte cap with multibyte text.
  const response = await reviewer.request(`/reviews/${published.result.reviewId}/threads`, {
    revision: 1,
    target: { kind: "review" },
    body: "Synthetic thread",
  });
  const created = (await response.json()) as { threadId: string };
  expect(response.status).toBe(201);
  await state.db.transaction(
    (q) =>
      q.insert(comments).values(
        Array.from({ length: 150 }, () => ({
          ownerId: state.ownerId,
          reviewId: published.result.reviewId,
          threadId: created.threadId,
          author: "user" as const,
          body: "界".repeat(20000),
        })),
      ),
    { offThread: true },
  );
  const out = await f.command();
  expect(out.code).toBe(1);
  expect(out.text).toContain(`could not copy review ${published.result.reviewId}: too large.`);
  expect(f.calls.filter((c) => /\/(import|blobs\/)/.test(c.url))).toEqual([]);
  expect(
    await state.db.read((q) =>
      q
        .select()
        .from(reviews)
        .where(and(eq(reviews.ownerId, state.ownerId), eq(reviews.id, published.result.reviewId)))
        .get(),
    ),
  ).toMatchObject({ movedToUrl: null });
});

test.each(["publish", "wait", "feedback", "reply", "mcp"])(
  "rejected credential on %s has the required line",
  async (command) => {
    const f = await fixture();
    const review = await f.publish();
    expect((await f.command()).code).toBe(0);
    f.handler.mockImplementation(async (url) =>
      url.endsWith("/capabilities")
        ? capabilities()
        : Response.json({ error: { code: "unauthorized", message: "Authentication is required." } }, { status: 401 }),
    );
    const cwd = vi.spyOn(process, "cwd").mockReturnValue(f.source);
    const args =
      command === "publish"
        ? [command, "--manifest", f.manifest, "--review", review.result.reviewId]
        : command === "reply"
          ? [command, randomUUID(), "--status", "fixed", "--body", "Synthetic reply"]
          : command === "mcp"
            ? [command]
            : [command, review.result.reviewId];
    const out = await f.command(args);
    cwd.mockRestore();
    expect(out.code).toBe(1);
    expect(out.text).toBe(
      `emend: the hub at ${origin} rejected this machine's credential. Run emend detach, then attach again. Nothing was changed.\n`,
    );
    expect(out.stdout).toEqual([]);
  },
);

test("detach when unattached fails without bootstrap", async () => {
  const f = await fixture();
  expect(await f.command(["detach"])).toMatchObject({ code: 1, text: "emend: emend is not attached.\n" });
  expect(f.calls).toEqual([]);
  await f.absent();
});

test.each([
  [413, "too_large", "Hub render budget exceeded.", "too large"],
  [400, "blob_missing", "A required blob is missing.", "A required blob is missing"],
  [400, "invalid_request", "The request is invalid.", "The request is invalid"],
  [
    401,
    "unauthorized",
    "Authentication is required.",
    "the hub rejected this machine's credential. Run emend detach, then attach again",
  ],
] as const)("copy failure %i/%s clears its marker and retains attachment", async (status, code, message, reason) => {
  const f = await fixture();
  const published = await f.publish();
  const normal = f.handler.getMockImplementation();
  if (!normal) throw new Error("Missing handler");
  f.handler.mockImplementation(async (url, init) => {
    if (url.endsWith("/import")) {
      if (!status) throw new TypeError("Synthetic network failure");
      return Response.json({ error: { code, message } }, { status });
    }
    return normal(url, init);
  });
  const out = await f.command();
  expect(out.code).toBe(1);
  expect(out.text).toContain(`emend: could not copy review ${published.result.reviewId}: ${reason}.\n`);
  expect(out.text).toContain("attached to Synthetic hub; copied 0 reviews, skipped 0.");
  const state = await initializeServerState(f.stateDir, { tokens: false });
  f.cleanup.push(() => state.db.close());
  expect(
    await state.db.read((q) =>
      q
        .select()
        .from(reviews)
        .where(and(eq(reviews.ownerId, state.ownerId), eq(reviews.id, published.result.reviewId)))
        .get(),
    ),
  ).toMatchObject({ movedToUrl: null });
  expect((await stat(join(f.stateDir, "attach.json"))).isFile()).toBe(true);
});

test.each(["hub.token", "attach.json"])(
  "a failed %s write removes partial state and revokes registration",
  async (name) => {
    const f = await fixture();
    const normal = f.handler.getMockImplementation();
    if (!normal) throw new Error("Missing handler");
    f.handler.mockImplementation(async (url, init) => {
      if (url.endsWith("/machines")) await mkdir(join(f.stateDir, name));
      return normal(url, init);
    });
    expect(await f.command()).toMatchObject({ code: 1, text: "emend: could not save the attachment.\n" });
    await f.absent();
    const revoke = f.calls.find((call) => call.init.method === "DELETE");
    expect(revoke?.url).toBe(`${origin}/api/v1/machines/self`);
    expect(new Headers(revoke?.init.headers).get("Authorization") === `Bearer ${token}`).toBe(true);
  },
);

test.each(["json", "schema"])("an unreadable registration %s answer gives recovery guidance", async (kind) => {
  const f = await fixture();
  f.handler.mockImplementation(async (url) =>
    url.endsWith("/capabilities")
      ? capabilities()
      : kind === "json"
        ? new Response("{", { status: 201 })
        : Response.json({ token }, { status: 201 }),
  );
  expect(await f.command()).toMatchObject({
    code: 1,
    text: "emend: the hub's answer could not be read. Revoke this machine in the hub's devices.\n",
  });
  await f.absent();
});

test.each(["{", "{}"])("detach removes invalid attachment %s without a request", async (value) => {
  const f = await fixture();
  await writeFile(join(f.stateDir, "attach.json"), value);
  writeSecretFile(join(f.stateDir, "hub.token"), token);
  expect(await f.command(["detach"])).toMatchObject({
    code: 0,
    text: "emend: detached. The hub was not reached; revoke this machine in its devices.\n",
  });
  expect(f.calls).toEqual([]);
  await f.absent();
});

test.each(["missing", "invalid", "directory"])("detach with a %s token still names the unchanged hub", async (kind) => {
  const f = await fixture();
  writeSecretFile(
    join(f.stateDir, "attach.json"),
    JSON.stringify({ hubId: hub.id, hubName: hub.name, hubUrl: origin }),
  );
  if (kind === "invalid") writeSecretFile(join(f.stateDir, "hub.token"), "invalid");
  else if (kind === "directory") await mkdir(join(f.stateDir, "hub.token"));
  expect(await f.command(["detach"])).toMatchObject({
    code: 0,
    text: "emend: detached from Synthetic hub. The hub was not reached; revoke this machine in its devices.\n",
  });
  expect(f.calls).toEqual([]);
  await f.absent();
});

test.each([false, true])(
  "a local command meeting the move while attached gives rerun guidance (publish %s)",
  async (publish) => {
    const f = await fixture();
    const review = await f.publish();
    expect((await f.command()).code).toBe(0);
    await expect(
      movedError(f.stateDir, new CliApiError("review_moved"), { reviewId: review.result.reviewId }, publish),
    ).rejects.toThrow(`This review moved to ${origin}. Run the command again.`);
  },
);

test.each(["key", "id"])("attached publish by %s refuses an uncopied local review before any request", async (by) => {
  const f = await fixture();
  const review = await f.publish("still-local");
  writeSecretFile(
    join(f.stateDir, "attach.json"),
    JSON.stringify({ hubId: hub.id, hubName: hub.name, hubUrl: origin }),
  );
  writeSecretFile(join(f.stateDir, "hub.token"), token);
  const before = await readFile(join(f.stateDir, "emend.db"));
  const cwd = vi.spyOn(process, "cwd").mockReturnValue(f.source);
  const out = await f.command([
    "publish",
    "--manifest",
    f.manifest,
    ...(by === "id" ? ["--review", review.result.reviewId] : ["--key", "still-local"]),
  ]);
  cwd.mockRestore();
  expect(out.code).toBe(1);
  expect(out.text).toBe(
    `emend: review ${review.result.reviewId} is still on this machine. Run emend attach again to copy it.\n`,
  );
  expect(f.calls).toEqual([]);
  expect(await readFile(join(f.stateDir, "emend.db"))).toEqual(before);
});

test.each(["ECONNREFUSED", "ENOTFOUND", "EAI_AGAIN", "ECONNRESET", "timeout"])(
  "hub mutation transport failure %s reports certainty accurately",
  async (code) => {
    const f = await fixture();
    f.handler.mockImplementation(async () => {
      throw code === "timeout"
        ? new DOMException("Synthetic timeout", "TimeoutError")
        : new TypeError("Synthetic failure", { cause: { code } });
    });
    const pending = apiRequest(f.stateDir, { via: "hub", url: origin, token }, "/publish", {
      method: "POST",
      body: {},
    });
    if (["ECONNREFUSED", "ENOTFOUND", "EAI_AGAIN"].includes(code))
      await expect(pending).rejects.toThrow("Nothing was changed.");
    else
      await expect(pending).rejects.toThrow(
        `the hub at ${origin} did not answer. The request may have reached it; check before trying again.`,
      );
  },
);

test.each(["network", "5xx", "malformed", "wrong-status"])(
  "unknown %s import outcomes retry once and keep the move",
  async (failure) => {
    const f = await fixture();
    const review = await f.publish();
    const normal = f.handler.getMockImplementation();
    if (!normal) throw new Error("Missing handler");
    f.handler.mockImplementation(async (url, init) => {
      if (!url.endsWith("/import")) return normal(url, init);
      if (failure === "network") throw new TypeError("Synthetic lost response");
      if (failure === "5xx")
        return Response.json({ error: { code: "internal", message: "Synthetic failure." } }, { status: 500 });
      return Response.json(failure === "malformed" ? {} : { skipped: false }, {
        status: failure === "wrong-status" ? 202 : 201,
      });
    });
    const out = await f.command();
    expect(out.code).toBe(1);
    expect(out.text).toContain(`could not confirm the copy of review ${review.result.reviewId}:`);
    expect(f.calls.filter((call) => call.url.endsWith("/import"))).toHaveLength(2);
    await expect(takeDirect(f.stateDir, review.result.reviewId, 0)).rejects.toMatchObject({ code: "review_moved" });
  },
);

test.each(["SIGINT", "SIGTERM", "SIGHUP"] as const)(
  "%s before import aborts upload, clears the mark and restores handlers",
  async (signalName) => {
    const f = await fixture();
    const review = await f.publish();
    const normal = f.handler.getMockImplementation();
    if (!normal) throw new Error("Missing handler");
    const listeners = process.listenerCount(signalName);
    let aborted = false;
    f.handler.mockImplementation(async (url, init) => {
      if (init.method === "PUT") {
        const requestSignal = init.signal;
        if (!requestSignal) throw new Error("Missing signal");
        return new Promise((_resolve, reject) => {
          requestSignal.addEventListener(
            "abort",
            () => {
              aborted = true;
              reject(requestSignal.reason);
            },
            { once: true },
          );
          process.emit(signalName);
        });
      }
      return normal(url, init);
    });
    expect((await f.command()).code).toBe(signalName === "SIGINT" ? 130 : signalName === "SIGTERM" ? 143 : 129);
    expect(aborted).toBe(true);
    expect(process.listenerCount(signalName)).toBe(listeners);
    await f.lockReleased();
    expect(f.calls.some((call) => call.url.endsWith("/import"))).toBe(false);
    expect(await takeDirect(f.stateDir, review.result.reviewId, 0)).toMatchObject({ kind: "pending" });
  },
);

test("a signal after sending import never clears the mark", async () => {
  const f = await fixture();
  const review = await f.publish();
  const normal = f.handler.getMockImplementation();
  if (!normal) throw new Error("Missing handler");
  f.handler.mockImplementation(async (url, init) => {
    if (url.endsWith("/import")) {
      process.emit("SIGTERM");
      init.signal?.throwIfAborted();
    }
    return normal(url, init);
  });
  expect((await f.command()).code).toBe(143);
  await f.lockReleased();
  await expect(takeDirect(f.stateDir, review.result.reviewId, 0)).rejects.toMatchObject({ code: "review_moved" });
});

test("a failing clear transaction keeps the mark recoverable by the next attach", async () => {
  const f = await fixture();
  const review = await f.publish();
  writeSecretFile(
    join(f.stateDir, "attach.json"),
    JSON.stringify({ hubId: hub.id, hubName: hub.name, hubUrl: origin }),
  );
  writeSecretFile(join(f.stateDir, "hub.token"), token);
  const state = await initializeServerState(f.stateDir, { tokens: false });
  f.cleanup.push(() => state.db.close());
  const transaction = state.db.transaction.bind(state.db);
  let count = 0;
  vi.spyOn(state.db, "transaction").mockImplementation((fn, options) => {
    if (++count === 2) throw new Error("Synthetic clear failure");
    return transaction(fn, options);
  });
  const normal = f.handler.getMockImplementation();
  if (!normal) throw new Error("Missing handler");
  f.handler.mockImplementation(async (url, init) =>
    url.endsWith("/import")
      ? Response.json({ error: { code: "invalid_request", message: "Synthetic refusal." } }, { status: 400 })
      : normal(url, init),
  );
  const out = f.output();
  expect(await copyReviews(f.stateDir, state, { via: "hub", url: origin, token }, out.io)).toMatchObject({ failed: 1 });
  expect(out.stderr.join("")).toContain("could not clear the local mark. Run emend attach again.");
  await expect(takeDirect(f.stateDir, review.result.reviewId, 0)).rejects.toMatchObject({ code: "review_moved" });
  f.handler.mockImplementation(normal);
  expect(await f.command()).toMatchObject({ code: 0 });
  expect(f.calls.filter((call) => call.url.endsWith("/import"))).toHaveLength(2);
});

test("detach removes an unreadable attachment directory without contacting a hub", async () => {
  const f = await fixture();
  await mkdir(join(f.stateDir, "attach.json"));
  writeSecretFile(join(f.stateDir, "hub.token"), token);
  expect(await f.command(["detach"])).toMatchObject({
    code: 0,
    text: "emend: removed a leftover hub token. If a hub lists this machine, revoke it in its devices.\n",
  });
  expect(f.calls).toEqual([]);
  await f.absent();
});

test.each(["network", "5xx", "malformed"])("an immediate retry settles a first %s failure", async (failure) => {
  const f = await fixture();
  const review = await f.publish();
  const normal = f.handler.getMockImplementation();
  if (!normal) throw new Error("Missing handler");
  let attempts = 0;
  f.handler.mockImplementation(async (url, init) => {
    if (url.endsWith("/import") && ++attempts === 1) {
      if (failure === "network") throw new TypeError("Synthetic lost response");
      return failure === "5xx" ? new Response("Synthetic failure", { status: 502 }) : Response.json({});
    }
    return normal(url, init);
  });
  const out = await f.command();
  expect(out.code).toBe(0);
  expect(out.text).toContain("copied 1 reviews, skipped 0.");
  const sent = f.calls.filter((call) => call.url.endsWith("/import"));
  expect(sent).toHaveLength(2);
  expect(sent[0]?.init.body).toBe(sent[1]?.init.body);
  await expect(takeDirect(f.stateDir, review.result.reviewId, 0)).rejects.toMatchObject({ code: "review_moved" });
});

test.each([400, 401, 408, 429])("a bare gateway %i keeps the mark and retries once", async (status) => {
  const f = await fixture();
  const review = await f.publish();
  const normal = f.handler.getMockImplementation();
  if (!normal) throw new Error("Missing handler");
  f.handler.mockImplementation(async (url, init) =>
    url.endsWith("/import") ? new Response("Not JSON", { status }) : normal(url, init),
  );
  const out = await f.command();
  expect(out.code).toBe(1);
  expect(out.text).toContain(`could not confirm the copy of review ${review.result.reviewId}:`);
  expect(f.calls.filter((call) => call.url.endsWith("/import"))).toHaveLength(2);
  await expect(takeDirect(f.stateDir, review.result.reviewId, 0)).rejects.toMatchObject({ code: "review_moved" });
});

test.each(["current", "other"])(
  "a hub 400 clears a current mark but leaves another hub's mark alone (%s)",
  async (destination) => {
    const f = await fixture();
    const review = await f.publish();
    const state = await initializeServerState(f.stateDir, { tokens: false });
    f.cleanup.push(() => state.db.close());
    await state.db.query((q) =>
      q
        .update(reviews)
        .set({
          movedToUrl: `${destination === "current" ? origin : "https://other.example.test"}/r/${review.result.reviewId}`,
        })
        .where(and(eq(reviews.ownerId, state.ownerId), eq(reviews.id, review.result.reviewId))),
    );
    const normal = f.handler.getMockImplementation();
    if (!normal) throw new Error("Missing handler");
    f.handler.mockImplementation(async (url, init) =>
      url.endsWith("/import")
        ? Response.json({ error: { code: "invalid_request", message: "Synthetic refusal." } }, { status: 400 })
        : normal(url, init),
    );
    expect((await f.command()).code).toBe(destination === "current" ? 1 : 0);
    expect(f.calls.filter((call) => call.url.endsWith("/import"))).toHaveLength(destination === "current" ? 1 : 0);
    expect(f.calls.some((call) => call.url.includes("/blobs/"))).toBe(false);
    if (destination === "current")
      expect(await takeDirect(f.stateDir, review.result.reviewId, 0)).toMatchObject({ kind: "pending" });
    else
      await expect(takeDirect(f.stateDir, review.result.reviewId, 0)).rejects.toMatchObject({ code: "review_moved" });
  },
);

test.each(["missing", "PUT", "next import", "next connection", "signal"])(
  "a resend's absence evidence survives blob recovery only until a new import is sent (%s)",
  async (failure) => {
    const f = await fixture();
    const review = await f.publish();
    const id = review.result.reviewId;
    expect((await f.command()).code).toBe(0);
    const state = await initializeServerState(f.stateDir, { tokens: false });
    f.cleanup.push(() => state.db.close());
    const normal = f.handler.getMockImplementation();
    if (!normal) throw new Error("Missing handler");
    let imports = 0;
    if (failure === "missing") vi.spyOn(state.blobs, "get").mockResolvedValue(null);
    f.handler.mockImplementation(async (url, init) => {
      if (url.endsWith("/import")) {
        if (++imports === 1)
          return Response.json({ error: { code: "blob_missing", message: "Missing blob." } }, { status: 400 });
        if (failure === "next connection")
          throw new TypeError("Synthetic refused connection", { cause: { code: "ECONNREFUSED" } });
        throw new TypeError("Synthetic lost response");
      }
      if (init.method === "PUT") {
        await expect(takeDirect(f.stateDir, id, 0)).rejects.toMatchObject({ code: "review_moved" });
        if (failure === "PUT") throw new TypeError("Synthetic failed blob upload");
        if (failure === "signal") {
          process.emit("SIGINT");
          init.signal?.throwIfAborted();
        }
      }
      return normal(url, init);
    });
    const out = f.output();
    const result = copyReviews(f.stateDir, state, { via: "hub", url: origin, token }, out.io);
    if (failure === "signal") await expect(result).rejects.toMatchObject({ exitCode: 130 });
    else expect(await result).toMatchObject({ failed: 1 });
    if (failure === "next import") {
      expect(imports).toBe(3);
      expect(out.stderr.join("")).toContain(`could not confirm the copy of review ${id}:`);
      await expect(takeDirect(f.stateDir, id, 0)).rejects.toMatchObject({ code: "review_moved" });
    } else {
      expect(imports).toBe(failure === "next connection" ? 2 : 1);
      expect(await takeDirect(f.stateDir, id, 0)).toMatchObject({ kind: "pending" });
    }
  },
);

test("a new mark, unknown import, blob_missing and signal before the next import clears the mark", async () => {
  const f = await fixture();
  const review = await f.publish();
  const normal = f.handler.getMockImplementation();
  if (!normal) throw new Error("Missing handler");
  let imports = 0;
  f.handler.mockImplementation(async (url, init) => {
    if (url.endsWith("/import")) {
      if (++imports === 1) throw new TypeError("Synthetic lost response");
      return Response.json({ error: { code: "blob_missing", message: "Missing blob." } }, { status: 400 });
    }
    if (imports === 2 && init.method === "PUT") {
      process.emit("SIGTERM");
      init.signal?.throwIfAborted();
    }
    return normal(url, init);
  });
  expect((await f.command()).code).toBe(143);
  expect(imports).toBe(2);
  expect(await takeDirect(f.stateDir, review.result.reviewId, 0)).toMatchObject({ kind: "pending" });
  await f.lockReleased();
});

test("attach preserves the state-folder chmod advice for a 0755 EMEND_HOME", async () => {
  const f = await fixture();
  await chmod(f.stateDir, 0o755);
  const out = await f.command();
  expect(out.code).toBe(1);
  expect(out.stdout).toEqual([]);
  expect(out.stderr).toEqual([
    `State directory ${f.stateDir} has group or other permissions; fix it with chmod 700 '${f.stateDir}'\n`,
  ]);
  expect(f.calls).toEqual([]);
  await f.absent();
  await expect(stat(join(f.stateDir, "attach.lock"))).rejects.toMatchObject({ code: "ENOENT" });
});

test.each(["busy", "invalid"])("a %s lock refusal survives a failing close", async (failure) => {
  const f = await fixture();
  const release = failure === "busy" ? lockAttach(f.stateDir) : undefined;
  if (failure === "invalid") await writeFile(join(f.stateDir, "attach.lock"), "not a database");
  const close = DatabaseSync.prototype.close;
  const closing = vi.spyOn(DatabaseSync.prototype, "close").mockImplementationOnce(function (this: DatabaseSync) {
    close.call(this);
    throw new Error("Synthetic close failure");
  });
  try {
    expect(await f.command()).toMatchObject({
      code: 1,
      text:
        failure === "busy"
          ? "emend: another emend attach is running. Nothing was changed.\n"
          : `emend: could not use the lock file ${escapeReference(join(f.stateDir, "attach.lock"))}. If no emend attach or detach is running, including one started with sudo, remove that file and try again.\n`,
      stdout: [],
    });
    expect(closing).toHaveBeenCalledOnce();
    expect(f.calls).toEqual([]);
  } finally {
    closing.mockRestore();
    release?.();
  }
});

test("a failed lock rollback still closes and preserves the command's refusal", async () => {
  const f = await fixture();
  f.handler.mockImplementation(async (url) =>
    url.endsWith("/capabilities")
      ? capabilities()
      : Response.json({ error: { code: "unauthorized", message: "Synthetic refusal." } }, { status: 401 }),
  );
  const exec = DatabaseSync.prototype.exec;
  let failed = false;
  const executing = vi.spyOn(DatabaseSync.prototype, "exec").mockImplementation(function (this: DatabaseSync, sql) {
    if (sql === "ROLLBACK") {
      failed = true;
      throw new Error("Synthetic rollback failure");
    }
    return exec.call(this, sql);
  });
  expect(await f.command()).toMatchObject({ code: 1, text: "emend: Synthetic refusal.\n", stdout: [] });
  expect(failed).toBe(true);
  executing.mockRestore();
  await f.lockReleased();
});

test.each(["attach", "detach"].flatMap((command) => ["invalid", "directory"].map((kind) => [command, kind])))(
  "%s reports an unusable %s lock without taking it over",
  async (command, kind) => {
    const f = await fixture();
    const path = join(f.stateDir, "attach.lock");
    if (kind === "directory") await mkdir(path);
    else await writeFile(path, "not a database");
    const before = await stat(path);
    expect(await f.command(command === "attach" ? ["attach", link] : ["detach"])).toMatchObject({
      code: 1,
      text: `emend: could not use the lock file ${escapeReference(path)}. If no emend attach or detach is running, including one started with sudo, remove that file and try again.\n`,
    });
    expect(f.calls).toEqual([]);
    expect((await stat(path)).ino).toBe(before.ino);
    await f.absent();
  },
);

test.skipIf(process.getuid?.() === 0).each(["attach", "detach"])(
  "%s names an unreadable lock file without changing it",
  async (command) => {
    const f = await fixture();
    const path = join(f.stateDir, "attach.lock");
    await writeFile(path, "not a database", { mode: 0o000 });
    try {
      expect(await f.command(command === "attach" ? ["attach", link] : ["detach"])).toMatchObject({
        code: 1,
        text: `emend: could not use the lock file ${escapeReference(path)}. If no emend attach or detach is running, including one started with sudo, remove that file and try again.\n`,
      });
      expect(f.calls).toEqual([]);
      expect((await stat(path)).mode & 0o777).toBe(0);
    } finally {
      await chmod(path, 0o600);
    }
  },
);

test("an unusable lock path is escaped onto one terminal line", async () => {
  const f = await fixture();
  const dir = join(f.stateDir, "synthetic\n\u001b[31m");
  await mkdir(dir, { mode: 0o700 });
  await mkdir(join(dir, "attach.lock"));
  const out = f.output();
  out.io.env.EMEND_HOME = dir;
  expect(await run(["detach"], out.io)).toBe(1);
  expect(out.stderr).toEqual([
    `emend: could not use the lock file ${escapeReference(join(dir, "attach.lock"))}. If no emend attach or detach is running, including one started with sudo, remove that file and try again.\n`,
  ]);
});

test("a second lock holder in the same process refuses before any request", async () => {
  const f = await fixture();
  const release = lockAttach(f.stateDir);
  try {
    expect(() => lockAttach(f.stateDir)).toThrow("another emend attach is running. Nothing was changed.");
    expect(await f.command()).toMatchObject({
      code: 1,
      text: "emend: another emend attach is running. Nothing was changed.\n",
    });
    expect(f.calls).toEqual([]);
  } finally {
    release();
  }
  await f.lockReleased();
  await f.absent();
});

test("a refused same-process contender leaves the OS lock held against another process", async () => {
  const f = await fixture();
  const script = join(f.dir, "try-attach-lock.mjs");
  await writeFile(
    script,
    `
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
const db = new DatabaseSync(join(process.env.EMEND_HOME, "attach.lock"), { timeout: 0 });
try {
  db.exec("PRAGMA locking_mode = EXCLUSIVE");
  db.exec("BEGIN EXCLUSIVE");
  process.exitCode = 1;
} catch (error) {
  if (error.errcode !== 5) throw error;
} finally {
  db.close();
}
`,
  );
  const release = lockAttach(f.stateDir);
  try {
    expect(() => lockAttach(f.stateDir)).toThrow("another emend attach is running. Nothing was changed.");
    const child = spawn(process.execPath, [script], {
      env: { PATH: process.env.PATH, HOME: f.stateDir, EMEND_HOME: f.stateDir, LC_ALL: "C" },
      stdio: ["ignore", "ignore", "pipe"],
    });
    let stderr = "";
    child.stderr?.on("data", (chunk) => {
      stderr += chunk;
    });
    expect(await once(child, "exit"), stderr).toEqual([0, null]);
  } finally {
    release();
  }
  await f.lockReleased();
});

test.each(["close", "SIGKILL"])(
  "a child holds the attach/detach lock until %s, preserving files and the local mark",
  async (end) => {
    const f = await fixture();
    const review = await f.publish();
    const state = await initializeServerState(f.stateDir, { tokens: false });
    f.cleanup.push(() => state.db.close());
    const row = () =>
      state.db.read((q) =>
        q
          .select()
          .from(reviews)
          .where(and(eq(reviews.ownerId, state.ownerId), eq(reviews.id, review.result.reviewId)))
          .get(),
      );
    const before = await row();
    const attachment = JSON.stringify({ hubId: hub.id, hubName: hub.name, hubUrl: origin });
    writeSecretFile(join(f.stateDir, "hub.token"), token);
    writeSecretFile(join(f.stateDir, "attach.json"), attachment);
    const script = join(f.dir, "hold-attach-lock.mjs");
    await writeFile(
      script,
      `
import { closeSync, openSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
const path = join(process.env.EMEND_HOME, "attach.lock");
closeSync(openSync(path, "a", 0o600));
const db = new DatabaseSync(path, { timeout: 0 });
db.exec("PRAGMA locking_mode = EXCLUSIVE");
db.exec("BEGIN EXCLUSIVE");
process.on("message", () => {
  db.exec("ROLLBACK");
  db.close();
  process.disconnect();
});
process.send("locked");
`,
    );
    const child = spawn(process.execPath, [script], {
      env: { PATH: process.env.PATH, HOME: f.stateDir, EMEND_HOME: f.stateDir, LC_ALL: "C" },
      stdio: ["ignore", "ignore", "pipe", "ipc"],
    });
    let stderr = "";
    child.stderr?.on("data", (chunk) => {
      stderr += chunk;
    });
    const exited = once(child, "exit");
    try {
      expect(
        await Promise.race([
          once(child, "message"),
          exited.then(() => {
            throw new Error(`Lock holder exited before acquiring: ${stderr}`);
          }),
        ]),
      ).toEqual(["locked", undefined]);
      expect(await f.command()).toMatchObject({
        code: 1,
        text: "emend: another emend attach is running. Nothing was changed.\n",
      });
      expect(await f.command(["detach"])).toMatchObject({
        code: 1,
        text: "emend: another emend attach is running. Nothing was changed.\n",
      });
      expect(f.calls).toEqual([]);
      expect(await readFile(join(f.stateDir, "attach.json"), "utf8")).toBe(attachment);
      expect(await readFile(join(f.stateDir, "hub.token"), "utf8")).toBe(token);
      expect(await row()).toEqual(before);
      expect((await stat(join(f.stateDir, "attach.lock"))).mode & 0o777).toBe(0o600);
      if (end === "SIGKILL") child.kill("SIGKILL");
      else child.send("release");
      expect(await exited).toEqual(end === "SIGKILL" ? [null, "SIGKILL"] : [0, null]);
      expect((await f.command()).code).toBe(0);
      expect(f.calls.some((call) => call.url.endsWith("/import"))).toBe(true);
      expect(await row()).toMatchObject({ movedToUrl: `${origin}/r/${review.result.reviewId}` });
      await f.lockReleased();
      expect((await f.command(["detach"])).code).toBe(0);
      await f.absent();
      await f.lockReleased();
    } finally {
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
      await exited;
    }
  },
);

test.each(["failure", "SIGINT", "SIGTERM", "SIGHUP"])("registration %s releases the attach lock", async (failure) => {
  const f = await fixture();
  const listeners = process.listenerCount(failure);
  f.handler.mockImplementation(async (url, init) => {
    if (url.endsWith("/capabilities")) return capabilities();
    expect(() => lockAttach(f.stateDir)).toThrow("another emend attach is running. Nothing was changed.");
    if (failure !== "failure") {
      const signal = init.signal;
      if (!signal) throw new Error("Missing signal");
      return new Promise((_resolve, reject) => {
        signal.addEventListener("abort", () => reject(signal.reason), { once: true });
        process.emit(failure);
      });
    }
    return Response.json({ error: { code: "unauthorized", message: "Synthetic refusal." } }, { status: 401 });
  });
  expect(await f.command()).toMatchObject({
    code: failure === "SIGINT" ? 130 : failure === "SIGTERM" ? 143 : failure === "SIGHUP" ? 129 : 1,
    text:
      failure === "failure"
        ? "emend: Synthetic refusal.\n"
        : `emend: the hub at ${origin} did not answer. The request may have reached it; check before trying again. Revoke this machine in the hub's devices before you attach again.\n`,
  });
  expect(process.listenerCount(failure)).toBe(listeners);
  await f.lockReleased();
  await f.absent();
});

test("a signal before registration gives no revoke advice and releases the attach lock", async () => {
  const f = await fixture();
  f.handler.mockImplementation(async (_url, init) => {
    process.emit("SIGTERM");
    init.signal?.throwIfAborted();
    return capabilities();
  });
  expect(await f.command()).toMatchObject({ code: 143, text: "", stdout: [] });
  expect(f.calls.map((call) => call.url)).toEqual([`${origin}/api/v1/capabilities`]);
  await f.absent();
  await f.lockReleased();
});

test.each([201, 401])(
  "a signal during a %s registration response revokes a returned token and respects a definite refusal",
  async (status) => {
    const f = await fixture();
    f.handler.mockImplementation(async (url, init) => {
      if (url.endsWith("/capabilities")) return capabilities();
      if (init.method === "DELETE") return new Response(null, { status: 204 });
      process.emit("SIGTERM");
      return Response.json(
        status === 201 ? { token, hub } : { error: { code: "unauthorized", message: "Synthetic refusal." } },
        { status },
      );
    });
    const out = await f.command();
    expect(out.code).toBe(143);
    expect(out.stdout).toEqual([]);
    expect(out.stderr).toEqual([]);
    const deleted = f.calls.filter((call) => call.init.method === "DELETE");
    expect(deleted).toHaveLength(status === 201 ? 1 : 0);
    if (status === 201) {
      expect(deleted[0]?.url).toBe(`${origin}/api/v1/machines/self`);
      expect(new Headers(deleted[0]?.init.headers).get("Authorization")).toBe(`Bearer ${token}`);
    }
    await f.absent();
    await f.lockReleased();
  },
);

test("a concurrent attach during registration is refused without another request", async () => {
  const f = await fixture();
  const normal = f.handler.getMockImplementation();
  if (!normal) throw new Error("Missing handler");
  f.handler.mockImplementation(async (url, init) => {
    if (url.endsWith("/machines")) {
      const before = f.calls.length;
      expect(await f.command()).toMatchObject({
        code: 1,
        text: "emend: another emend attach is running. Nothing was changed.\n",
      });
      expect(f.calls).toHaveLength(before);
    }
    return normal(url, init);
  });
  expect((await f.command()).code).toBe(0);
});

test("a resend refused with hub 401 tells the user to detach and keeps the mark", async () => {
  const f = await fixture();
  const review = await f.publish();
  expect((await f.command()).code).toBe(0);
  const normal = f.handler.getMockImplementation();
  if (!normal) throw new Error("Missing handler");
  f.handler.mockImplementation(async (url, init) =>
    url.endsWith("/import")
      ? Response.json({ error: { code: "unauthorized", message: "Authentication is required." } }, { status: 401 })
      : normal(url, init),
  );
  const out = await f.command();
  expect(out.code).toBe(1);
  expect(out.stderr).toEqual([
    `emend: copying review ${review.result.reviewId}…\n`,
    `emend: could not confirm the copy of review ${review.result.reviewId}: the hub rejected this machine's credential. Run emend detach, then attach again.\n`,
    "emend: attached to Synthetic hub; copied 0 reviews, skipped 0.\n",
  ]);
  await expect(takeDirect(f.stateDir, review.result.reviewId, 0)).rejects.toMatchObject({ code: "review_moved" });
});

test("an attachment created after publish's read cannot redirect an unchecked key to the hub", async () => {
  const f = await fixture();
  const review = await f.publish();
  const read = targets.readAttachmentPair;
  const attachment = vi.spyOn(targets, "readAttachmentPair").mockImplementationOnce(async (dir) => {
    const value = await read(dir);
    expect(value).toBeNull();
    writeSecretFile(join(dir, "attach.json"), JSON.stringify({ hubId: hub.id, hubName: hub.name, hubUrl: origin }));
    writeSecretFile(join(dir, "hub.token"), token);
    return value;
  });
  const next = await f.publish();
  expect(next.result).toMatchObject({ reviewId: review.result.reviewId, revision: 2, url: review.result.url });
  expect(attachment).toHaveBeenCalledOnce();
  expect(f.calls).toEqual([]);
});

test.each(
  ["publish", "wait", "feedback", "reply", "mcp", "detach", "attach"].flatMap((command) =>
    ["another hub", "removed"].map((change) => [command, change]),
  ),
)("%s refuses an attachment %s during the token read without any request", async (command, change) => {
  const f = await fixture();
  const review = await f.publish();
  expect((await f.command()).code).toBe(0);
  f.calls.length = 0;
  const path = join(f.stateDir, "attach.json");
  const replacement = JSON.stringify({
    hubId: randomUUID(),
    hubName: "Other hub",
    hubUrl: "https://other.example.test",
  });
  const otherToken = `em_${"y".repeat(43)}`;
  const read = tokens.readTokenFile;
  let changed = false;
  vi.spyOn(tokens, "readTokenFile").mockImplementation(async (...args) => {
    if (args[0] === join(f.stateDir, "hub.token") && !changed) {
      changed = true;
      if (change === "removed") await rm(path);
      else {
        writeSecretFile(path, replacement);
        writeSecretFile(join(f.stateDir, "hub.token"), otherToken);
      }
    }
    return read(...args);
  });
  const cwd = vi.spyOn(process, "cwd").mockReturnValue(f.source);
  const args =
    command === "publish"
      ? [command, "--manifest", f.manifest, "--key", "synthetic"]
      : command === "reply"
        ? [command, randomUUID(), "--status", "fixed", "--body", "Synthetic reply"]
        : command === "mcp" || command === "detach"
          ? [command]
          : [command ?? "", command === "attach" ? link : review.result.reviewId];
  const out = await f.command(args);
  cwd.mockRestore();
  expect(changed).toBe(true);
  expect(out).toMatchObject({
    code: 1,
    text: "emend: the attachment changed while this command started. Run it again. Nothing was changed.\n",
    stdout: [],
  });
  expect(f.calls).toEqual([]);
  if (change === "removed") await expect(stat(path)).rejects.toMatchObject({ code: "ENOENT" });
  else expect(await readFile(path, "utf8")).toBe(replacement);
  expect(await readFile(join(f.stateDir, "hub.token"), "utf8")).toBe(change === "removed" ? token : otherToken);
});

test("a hub mutation whose response body disconnects reports an uncertain outcome", async () => {
  const f = await fixture();
  f.handler.mockResolvedValue(
    new Response(
      new ReadableStream({
        start(controller) {
          controller.error(new TypeError("Synthetic body disconnect"));
        },
      }),
      { status: 200 },
    ),
  );
  await expect(
    apiRequest(f.stateDir, { via: "hub", url: origin, token }, "/publish", { method: "POST", body: {} }),
  ).rejects.toThrow(`the hub at ${origin} did not answer. The request may have reached it; check before trying again.`);
});

// Later local errors never replace the evidence from the latest import.
test.each([
  ["pre-import blob failure", true, "none", new CliError("blob failed"), true],
  ["pre-import signal", true, "none", new CliSignalExit(130), true],
  ["first connection refused", true, "none", new CliConnectionError("refused"), true],
  ["resend connection refused", false, "none", new CliConnectionError("refused"), false],
  ["signal after sending", true, "unknown", new CliSignalExit(143), false],
  ["new hub 429", true, "absent", new CliApiError("rate_limited"), true],
  ["new hub 401", true, "absent", new CliApiError("unauthorized"), true],
  ["unknown then hub 429", true, "other", new CliApiError("rate_limited"), false],
  ["unknown then hub 401", true, "other", new CliApiError("unauthorized"), false],
  ["unknown then hub 404", true, "other", new CliApiError("not_found"), false],
  ["unknown then hub 400", true, "absent", new CliApiError("invalid_request"), true],
  ["unknown then hub 413", true, "absent", new CliApiError("too_large"), true],
  ["resend hub 400", false, "absent", new CliApiError("invalid_request"), true],
  ["resend hub 413", false, "absent", new CliApiError("too_large"), true],
  ["resend hub 429", false, "other", new CliApiError("rate_limited"), false],
  ["resend hub 401", false, "other", new CliApiError("unauthorized"), false],
  ["resend hub 404", false, "other", new CliApiError("not_found"), false],
  ["bare gateway 408", true, "unknown", new CliHttpError(408, "gateway"), false],
  ["bare gateway 429", true, "unknown", new CliHttpError(429, "gateway"), false],
  ["hub 500", true, "unknown", new CliApiError("invalid_request", "failed", 500), false],
  ["unknown then connection refused", true, "unknown", new CliConnectionError("refused"), false],
  ["m: resend, blob_missing, missing local blob", false, "absent", new CliError("missing blob"), true],
  ["n: resend, blob_missing, PUT fails", false, "absent", new CliError("PUT failed"), true],
  ["o: resend, blob_missing, upload, next import unknown", false, "unknown", new CliError("reset"), false],
  ["p: new, unknown, blob_missing, signal before next import", true, "absent", new CliSignalExit(130), true],
] as const)("copy marker evidence: %s", (_name, newMark, latest, error, clear) => {
  expect(canClearCopyMark({ newMark, latest }, error)).toBe(clear);
});

test.each([413, 429])("a resend receiving hub %i restores local access only on a sure refusal", async (status) => {
  const f = await fixture();
  const review = await f.publish();
  expect((await f.command()).code).toBe(0);
  f.calls.length = 0;
  const delay = vi.spyOn(pauses, "pause").mockResolvedValue();
  const normal = f.handler.getMockImplementation();
  if (!normal) throw new Error("Missing handler");
  f.handler.mockImplementation(async (url, init) =>
    url.endsWith("/import")
      ? Response.json(
          { error: { code: status === 413 ? "too_large" : "rate_limited", message: "Synthetic refusal." } },
          { status },
        )
      : normal(url, init),
  );
  const out = await f.command();
  expect(out.code).toBe(1);
  expect(f.calls.filter((call) => call.url.endsWith("/import"))).toHaveLength(status === 429 ? 6 : 1);
  expect(delay).toHaveBeenCalledTimes(status === 429 ? 5 : 0);
  expect(f.calls.some((call) => call.url.includes("/blobs/"))).toBe(false);
  if (status === 413) {
    expect(out.text).toContain(`could not copy review ${review.result.reviewId}: too large.`);
    expect(await takeDirect(f.stateDir, review.result.reviewId, 0)).toMatchObject({ kind: "pending" });
    const cwd = vi.spyOn(process, "cwd").mockReturnValue(f.source);
    expect((await f.command(["detach"])).code).toBe(0);
    expect((await f.command(["publish", "--manifest", f.manifest, "--review", review.result.reviewId])).code).toBe(0);
    cwd.mockRestore();
  } else {
    expect(out.text).toContain(`could not confirm the copy of review ${review.result.reviewId}:`);
    await expect(takeDirect(f.stateDir, review.result.reviewId, 0)).rejects.toMatchObject({ code: "review_moved" });
  }
});

test.each(["ECONNREFUSED", "ENOTFOUND", "EAI_AGAIN"])(
  "first import %s clears its new mark without retry",
  async (code) => {
    const f = await fixture();
    const review = await f.publish();
    const normal = f.handler.getMockImplementation();
    if (!normal) throw new Error("Missing handler");
    f.handler.mockImplementation(async (url, init) => {
      if (url.endsWith("/import")) throw new TypeError("Synthetic connection failure", { cause: { code } });
      return normal(url, init);
    });
    const out = await f.command();
    expect(out.code).toBe(1);
    expect(out.text).toContain(`could not copy review ${review.result.reviewId}:`);
    expect(out.text).not.toContain("could not confirm");
    expect(f.calls.filter((call) => call.url.endsWith("/import"))).toHaveLength(1);
    expect(await takeDirect(f.stateDir, review.result.reviewId, 0)).toMatchObject({ kind: "pending" });
    const sent = vi.fn();
    await expect(
      apiRequest(f.stateDir, { via: "hub", url: origin, token }, "/import", {
        method: "POST",
        body: {},
        onSend: sent,
      }),
    ).rejects.toThrow("Nothing was changed.");
    expect(sent).not.toHaveBeenCalled();
  },
);

test.each([400, 401, 404, 413])(
  "unknown import followed by hub %i uses the evidence of both attempts",
  async (status) => {
    const f = await fixture();
    const review = await f.publish();
    const normal = f.handler.getMockImplementation();
    if (!normal) throw new Error("Missing handler");
    let attempts = 0;
    f.handler.mockImplementation(async (url, init) => {
      if (!url.endsWith("/import")) return normal(url, init);
      if (++attempts === 1) throw new TypeError("Synthetic lost response");
      const code =
        status === 400
          ? "invalid_request"
          : status === 401
            ? "unauthorized"
            : status === 404
              ? "not_found"
              : "too_large";
      return Response.json({ error: { code, message: "Synthetic refusal." } }, { status });
    });
    const out = await f.command();
    expect(out.code).toBe(1);
    expect(attempts).toBe(2);
    if (status === 400 || status === 413) {
      expect(out.text).toContain(`could not copy review ${review.result.reviewId}:`);
      expect(await takeDirect(f.stateDir, review.result.reviewId, 0)).toMatchObject({ kind: "pending" });
    } else {
      expect(out.text).toContain(`could not confirm the copy of review ${review.result.reviewId}:`);
      await expect(takeDirect(f.stateDir, review.result.reviewId, 0)).rejects.toMatchObject({ code: "review_moved" });
    }
  },
);

test.each(["ECONNRESET", "timeout", "ECONNREFUSED", "ENOTFOUND", "EAI_AGAIN"])(
  "registration %s adds revoke guidance only if it may have reached the hub",
  async (code) => {
    const f = await fixture();
    f.handler.mockImplementation(async (url) => {
      if (url.endsWith("/capabilities")) return capabilities();
      throw code === "timeout"
        ? new DOMException("Synthetic timeout", "TimeoutError")
        : new TypeError("Synthetic failure", { cause: { code } });
    });
    const out = await f.command();
    expect(out.code).toBe(1);
    if (["ECONNRESET", "timeout"].includes(code))
      expect(out.text).toBe(
        `emend: the hub at ${origin} did not answer. The request may have reached it; check before trying again. Revoke this machine in the hub's devices before you attach again.\n`,
      );
    else {
      expect(out.text).toContain("Nothing was changed.");
      expect(out.text).not.toContain("Revoke");
    }
    await f.absent();
  },
);

test.each(["missing", "directory", "{", "null", "{}", '{"id":"not-an-id","name":"Synthetic"}'])(
  "attached publish refuses an unreadable identity (%s) before any request",
  async (value) => {
    const f = await fixture();
    await f.publish();
    expect((await f.command()).code).toBe(0);
    const path = join(f.stateDir, "instance.json");
    await rm(path);
    if (value === "directory") await mkdir(path);
    else if (value !== "missing") await writeFile(path, value);
    f.calls.length = 0;
    const before = await readFile(join(f.stateDir, "emend.db"));
    const cwd = vi.spyOn(process, "cwd").mockReturnValue(f.source);
    const out = await f.command(["publish", "--manifest", f.manifest, "--key", "synthetic"]);
    cwd.mockRestore();
    expect(out).toMatchObject({
      code: 1,
      text: "emend: could not read this machine's identity. Nothing was changed.\n",
    });
    expect(f.calls).toEqual([]);
    expect(await readFile(join(f.stateDir, "emend.db"))).toEqual(before);
  },
);
