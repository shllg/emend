import { randomUUID } from "node:crypto";
import { expect, test } from "vitest";
import { run } from "../../main.ts";
import { commandFixture } from "../test-support.ts";
import { confirmWarning } from "./wait.ts";

test("feedback takes once without waiting and prints pending with zero waited seconds", async () => {
  const f = await commandFixture();
  const reviewId = randomUUID();
  let takes = 0;
  f.setResponse(async (url, init) => {
    expect(String(url)).toMatch(/\/take$/);
    expect(JSON.parse(String(init?.body))).toEqual({ waitSeconds: 0, accepts: ["closed"] });
    takes++;
    return Response.json({ kind: "pending", reviewId, waitedSeconds: 0.01 });
  });
  expect(await run(["feedback", reviewId], f.io)).toBe(0);
  expect(takes).toBe(1);
  expect(f.stdout).toEqual([`${JSON.stringify({ kind: "pending", reviewId, waitedSeconds: 0 })}\n`]);
});

test.each([[], ["invalid"], [randomUUID(), "--timeout", "1"]])(
  "feedback refuses extra or invalid arguments %j",
  async (...args) => {
    const f = await commandFixture();
    expect(await run(["feedback", ...args], f.io)).toBe(2);
    expect(f.fetcher).not.toHaveBeenCalled();
    expect(f.stdout).toEqual([]);
    expect(f.stderr).toHaveLength(1);
  },
);

const rid = randomUUID();
const did = randomUUID();
const results = {
  go: {
    kind: "go",
    reviewId: rid,
    deliveryId: did,
    revision: 1,
    sentOn: 1,
    mode: "fix-clear",
    modeLabel: "Fix what's clear, ask about the rest",
    instructions: [],
    approvalSetAside: false,
    comments: [],
  },
  approve: { kind: "approve", reviewId: rid, deliveryId: did, revision: 1 },
  closed: { kind: "closed", reviewId: rid, deliveryId: did, revision: 1, reason: "retired", until: null },
  pending: { kind: "pending", reviewId: rid, waitedSeconds: 0 },
};

test.each(["feedback", "wait"] as const)(
  "%s prints the reply hint on stderr only for go from feedback",
  async (command) => {
    for (const kind of ["go", "approve", "closed", "pending"] as const) {
      const f = await commandFixture();
      f.setResponse(async (url) =>
        String(url).endsWith("/take") ? Response.json(results[kind]) : new Response(null, { status: 204 }),
      );
      expect(await run([command, rid, ...(command === "wait" ? ["--timeout", "1"] : [])], f.io)).toBe(0);
      expect(f.stdout).toHaveLength(1);
      // A wait that ends pending reports its own waited seconds.
      if (kind === "pending") expect(JSON.parse(f.stdout[0] ?? "")).toMatchObject({ kind, reviewId: rid });
      else expect(f.stdout).toEqual([`${JSON.stringify(results[kind])}\n`]);
      const hint = `recense: answer each comment with recense reply <comment> --status <outcome> --body <text>, then publish changes with recense publish <path>... --review ${rid}\n`;
      expect(f.stderr).toEqual(command === "feedback" && kind === "go" ? [hint] : []);
    }
  },
  20000,
);

test("feedback prints no reply hint when the confirm fails, only the confirm warning", async () => {
  const f = await commandFixture();
  f.setResponse(async (url) =>
    String(url).endsWith("/take") ? Response.json(results.go) : new Response(null, { status: 500 }),
  );
  expect(await run(["feedback", rid], f.io)).toBe(0);
  expect(f.stdout).toEqual([`${JSON.stringify(results.go)}\n`]);
  expect(f.stderr).toEqual([confirmWarning]);
});
