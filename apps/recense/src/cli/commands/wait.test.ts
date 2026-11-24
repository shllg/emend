import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { LEASE_SECONDS, type WaitResult } from "@recense/contract";
import { expect, onTestFinished, test, vi } from "vitest";
import { run } from "../../main.ts";
import { createToken } from "../../server/auth/tokens.ts";
import { mailboxFixture } from "../../server/mailbox/test-support.ts";
import { writeSecretFile } from "../../state/files.ts";
import { commandFixture } from "../test-support.ts";
import { takeFeedback } from "./wait.ts";

const reviewId = randomUUID();
const approve: WaitResult = { kind: "approve", reviewId, deliveryId: randomUUID(), revision: 1 };

test("immediate pending answers wait out each round instead of spinning", async () => {
  const f = await commandFixture();
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "performance"] });
  try {
    const rounds: number[] = [];
    f.setResponse(async (_url, init) => {
      rounds.push(JSON.parse(String(init?.body)).waitSeconds);
      if (rounds.length > 4) throw new Error("spinning");
      return Response.json({ kind: "pending", reviewId, waitedSeconds: 0 });
    });
    const result = takeFeedback(
      f.dir,
      { url: "https://hub.example", token: `em_${"a".repeat(43)}`, via: "hub" },
      reviewId,
      51,
    ).catch((error: unknown) => error);
    await vi.advanceTimersByTimeAsync(51000);
    expect(await result).toEqual({ kind: "pending", reviewId, waitedSeconds: 51 });
    expect(rounds).toEqual([25, 25, 1]);
  } finally {
    vi.useRealTimers();
  }
});

test("a final round under 50 ms waits to the deadline without another take", async () => {
  const f = await commandFixture();
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "performance"] });
  try {
    let takes = 0;
    f.setResponse(async () => {
      if (++takes > 1) throw new Error("unnecessary final take");
      await new Promise((resolve) => setTimeout(resolve, 25990));
      return Response.json({ kind: "pending", reviewId, waitedSeconds: 25.99 });
    });
    const result = takeFeedback(
      f.dir,
      { url: "https://hub.example", token: `em_${"a".repeat(43)}`, via: "hub" },
      reviewId,
      26,
    ).catch((error: unknown) => error);
    await vi.advanceTimersByTimeAsync(26000);
    expect(await result).toEqual({ kind: "pending", reviewId, waitedSeconds: 26 });
    expect(takes).toBe(1);
  } finally {
    vi.useRealTimers();
  }
});

test("wait prints one unchanged JSON line and confirms only after stdout has flushed", async () => {
  const f = await commandFixture();
  const events: string[] = [];
  let flush!: () => void;
  const writing = Promise.withResolvers<void>();
  f.io.stdoutAsync = async (line) => {
    f.stdout.push(line);
    writing.resolve();
    await new Promise<void>((resolve) => {
      flush = resolve;
    });
    events.push("flushed");
  };
  f.setResponse(async (url, init) => {
    if (String(url).endsWith("/take")) {
      expect(JSON.parse(String(init?.body))).toEqual({ waitSeconds: 25, accepts: ["closed"] });
      return Response.json(approve);
    }
    events.push("confirm");
    return new Response(null, { status: 204 });
  });
  const pending = run(["wait", reviewId], f.io);
  await writing.promise;
  expect(events).toEqual([]);
  flush();
  expect(await pending).toBe(0);
  expect(events).toEqual(["flushed", "confirm"]);
  expect(f.stdout).toEqual([`${JSON.stringify(approve)}\n`]);
  expect(f.stderr).toEqual([]);
});

test("wait uses remaining seconds, a round plus ten-second HTTP deadline, and whole total seconds", async () => {
  const f = await commandFixture();
  let now = 0;
  vi.spyOn(performance, "now").mockImplementation(() => now);
  const timeout = vi.spyOn(AbortSignal, "timeout");
  const rounds: number[] = [];
  f.setResponse(async (_url, init) => {
    const { waitSeconds } = JSON.parse(String(init?.body));
    rounds.push(waitSeconds);
    now += waitSeconds * 1000;
    return Response.json({ kind: "pending", reviewId, waitedSeconds: waitSeconds });
  });
  expect(await run(["wait", reviewId, "--timeout", "54"], f.io)).toBe(0);
  expect(rounds).toEqual([25, 25, 4]);
  expect(timeout.mock.calls.map(([ms]) => ms).filter((ms) => ms > 5000)).toEqual([35000, 35000, 14000]);
  expect(f.stdout).toEqual([`${JSON.stringify({ kind: "pending", reviewId, waitedSeconds: 54 })}\n`]);
});

test.each(["network", "unauthorized", "invalid", "unknown_review"])(
  "wait %s failure prints no JSON and never confirms or retries",
  async (kind) => {
    const f = await commandFixture();
    let takes = 0;
    f.setResponse(async (url) => {
      expect(String(url)).toMatch(/\/take$/);
      takes++;
      if (kind === "network") throw new Error("untrusted\nsecret");
      if (kind === "invalid") return Response.json({ kind: "bogus", body: "untrusted" });
      return Response.json({ error: { code: kind, message: "untrusted\nsecret" } }, { status: 401 });
    });
    expect(await run(["wait", reviewId], f.io)).toBe(1);
    expect(takes).toBe(1);
    expect(f.stdout).toEqual([]);
    expect(f.stderr).toHaveLength(1);
    expect(f.stderr[0]).toMatch(/^recense: [^\n]+\n$/);
    expect(f.stderr.join("")).not.toMatch(/untrusted|secret/);
  },
);

test.each(["write", "confirm"])("a failed %s preserves the unconfirmed delivery", async (failure) => {
  const f = await commandFixture();
  let confirms = 0;
  f.setResponse(async (url) => {
    if (String(url).endsWith("/take")) return Response.json(approve);
    confirms++;
    throw new Error("untrusted");
  });
  if (failure === "write")
    f.io.stdoutAsync = async () => {
      throw new Error("EPIPE");
    };
  expect(await run(["wait", reviewId], f.io)).toBe(failure === "write" ? 1 : 0);
  expect(confirms).toBe(failure === "write" ? 0 : 1);
  expect(f.stdout).toHaveLength(failure === "write" ? 0 : 1);
  expect(f.stderr).toHaveLength(1);
  if (failure === "confirm") expect(f.stderr[0]).toContain("same feedback will be offered again");
});

test.each([
  [],
  ["bad"],
  [reviewId, "--timeout", "0"],
  [reviewId, "--timeout", "86401"],
  [reviewId, "--timeout", "1.5"],
  [reviewId, "--timeout", "NaN"],
  [reviewId, "--timeout"],
  [reviewId, "--timeout", "1", "--timeout", "2"],
  [reviewId, "extra"],
])("invalid wait usage %j exits 2 before contacting a server", async (...args) => {
  const f = await commandFixture();
  expect(await run(["wait", ...args], f.io)).toBe(2);
  expect(f.stdout).toEqual([]);
  expect(f.stderr).toHaveLength(1);
  expect(f.fetcher).not.toHaveBeenCalled();
});

test("a wait killed before confirm loses nothing; feedback after a timed-out wait gets the next Send", async () => {
  const f = await commandFixture();
  const mailbox = await mailboxFixture();
  onTestFinished(() => mailbox.cleanup());
  const token = await createToken(mailbox.db, mailbox.ownerId, "agent", { instanceId: mailbox.instanceId });
  writeSecretFile(join(f.dir, "agent.token"), token.secret);
  let now = 0;
  vi.spyOn(performance, "now").mockImplementation(() => now);
  f.setResponse(async (url, init) => {
    const response = await mailbox.app.request(String(url), {
      ...init,
      headers: { ...init?.headers, Host: "127.0.0.1:3636" },
    });
    now += 1000;
    return response;
  });
  expect(await run(["wait", mailbox.reviewId, "--timeout", "1"], f.io)).toBe(0);
  expect(JSON.parse(f.stdout[0] ?? "")).toMatchObject({ kind: "pending" });
  const comment = await mailbox.thread();
  await mailbox.send();
  f.io.stdoutAsync = async () => {
    throw new Error("EPIPE");
  };
  expect(await run(["wait", mailbox.reviewId], f.io)).toBe(1);
  expect((await mailbox.take()).kind).toBe("pending");
  mailbox.advance(LEASE_SECONDS * 1000 + 1);
  f.io.stdoutAsync = async (line) => {
    f.stdout.push(line);
  };
  expect(await run(["feedback", mailbox.reviewId], f.io)).toBe(0);
  expect(JSON.parse(f.stdout[1] ?? "")).toMatchObject({ kind: "go", comments: [{ id: comment.commentId }] });
  expect((await mailbox.take()).kind).toBe("pending");
});

test.each(["wait", "feedback"])("%s keeps HTTP default signal behavior outside stdout flush", async (command) => {
  const f = await commandFixture();
  const counts = [process.listenerCount("SIGINT"), process.listenerCount("SIGTERM")];
  f.setResponse(async () => {
    expect([process.listenerCount("SIGINT"), process.listenerCount("SIGTERM")]).toEqual(counts);
    return Response.json(approve);
  });
  expect(await run([command, reviewId], f.io)).toBe(0);
});

test.each(["wait", "feedback"])(
  "%s skips HTTP confirmation on either signal during a stuck stdout flush",
  async (command) => {
    for (const [signal, code] of [
      ["SIGINT", 130],
      ["SIGTERM", 143],
    ] as const) {
      const f = await commandFixture();
      const writing = Promise.withResolvers<void>();
      const flush = Promise.withResolvers<void>();
      const before = process.listenerCount(signal);
      let confirms = 0;
      f.io.stdoutAsync = async (line) => {
        f.stdout.push(line);
        writing.resolve();
        await flush.promise;
      };
      f.setResponse(async (url) => {
        if (String(url).endsWith("/take")) return Response.json(approve);
        confirms++;
        return new Response(null, { status: 204 });
      });
      const pending = run([command, reviewId], f.io);
      await writing.promise;
      process.emit(signal);
      try {
        expect(await pending).toBe(code);
        expect(confirms).toBe(0);
        expect(f.stdout).toHaveLength(1);
        expect(f.stderr).toEqual([]);
        expect(process.listenerCount(signal)).toBe(before);
      } finally {
        flush.resolve();
      }
    }
  },
);
