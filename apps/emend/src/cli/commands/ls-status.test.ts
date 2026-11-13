import { randomUUID } from "node:crypto";
import { chmod, mkdtemp, readdir, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AgentReviewList } from "@emend/contract";
import { eq } from "drizzle-orm";
import { beforeEach, expect, onTestFinished, test, vi } from "vitest";
import { reviews, revisions } from "../../db/schema.ts";
import { run } from "../../main.ts";
import * as executors from "../../server/publish/executor.ts";
import { writeSecretFile } from "../../state/files.ts";
import { workInThread } from "../../test/in-thread-worker.ts";
import { VERSION } from "../../version.ts";
import { directFixture } from "../direct-test-support.ts";
import { sandboxHint } from "../http.ts";
import { commandFixture } from "../test-support.ts";

vi.mock("../../server/publish/executor.ts", async (original) => ({
  ...(await original<typeof import("../../server/publish/executor.ts")>()),
}));

beforeEach(() => {
  workInThread(executors);
});

const token = `em_${"a".repeat(43)}`;
const hubToken = `em_${"b".repeat(43)}`;
const reviewId = randomUUID();
const item = {
  id: reviewId,
  title: "Synthetic review",
  branch: null,
  state: "open",
  newest: null,
  approved: null,
  updatedAt: "2026-01-01T00:10:00.000Z",
  url: `http://127.0.0.1:3636/r/${reviewId}`,
};
function attach(dir: string, hubUrl = "https://hub.example") {
  writeSecretFile(join(dir, "attach.json"), JSON.stringify({ hubId: randomUUID(), hubName: "Synthetic hub", hubUrl }));
  writeSecretFile(join(dir, "hub.token"), hubToken);
}

test("ls against a local server lists the instance's reviews, one tab-separated line each", async () => {
  const f = await commandFixture();
  f.setResponse(async (url, init) => {
    expect(String(url)).toBe("http://127.0.0.1:3636/api/v1/agent/reviews");
    expect(new Headers(init?.headers).get("Authorization")).toBe(`Bearer ${token}`);
    return Response.json({ items: [item] });
  });
  expect(await run(["ls"], f.io)).toBe(0);
  expect(f.stdout.join("")).toBe(`${reviewId}\topen\t${item.updatedAt}\tSynthetic review\t${item.url}\n`);
  expect(f.stderr).toEqual([]);
});

test("ls --json prints one AgentReviewList line", async () => {
  const f = await commandFixture();
  f.setResponse(async () => Response.json({ items: [item] }));
  expect(await run(["ls", "--json"], f.io)).toBe(0);
  expect(f.stdout).toHaveLength(1);
  expect(AgentReviewList.parse(JSON.parse(f.stdout[0] ?? ""))).toEqual({ items: [item] });
});

test("ls against an attached hub sends the hub token to the hub only", async () => {
  const f = await commandFixture();
  attach(f.dir);
  f.setResponse(async (url, init) => {
    if (String(url) === "https://hub.example/api/v1/agent/reviews") {
      expect(new Headers(init?.headers).get("Authorization")).toBe(`Bearer ${hubToken}`);
      return Response.json({ items: [item] });
    }
    return Response.json({}, { status: 500 });
  });
  expect(await run(["ls", "--json"], f.io)).toBe(0);
  expect(AgentReviewList.parse(JSON.parse(f.stdout.join("")))).toEqual({ items: [item] });
  expect(f.stdout.join("")).not.toContain(hubToken);
});

test("ls escapes control characters in a title", async () => {
  const f = await commandFixture();
  f.setResponse(async () => Response.json({ items: [{ ...item, title: "Two\nlines\u001b[31m" }] }));
  expect(await run(["ls"], f.io)).toBe(0);
  expect(f.stdout.join("").split("\n")).toHaveLength(2);
  expect(f.stdout.join("")).not.toContain("\u001b");
});

// C1 CSI, bidi override, line separator, tag character, grapheme joiner, variation selectors.
const hostileCodes = [0x9b, 0x202e, 0x2028, 0xe0041, 0x34f, 0xfe0f, 0xe0100];
const hostileChars = hostileCodes.map((code) => String.fromCodePoint(code));
const hostile = `a${hostileChars.join("x")}h`;
const hostilePattern = new RegExp(`[${hostileChars.join("")}]`, "u");
test("a title with C1, bidi, line separator and invisible characters is escaped in both forms", async () => {
  const f = await commandFixture();
  f.setResponse(async () => Response.json({ items: [{ ...item, title: hostile }] }));
  expect(await run(["ls"], f.io)).toBe(0);
  expect(f.stdout.join("")).not.toMatch(hostilePattern);
  const json = await commandFixture();
  json.setResponse(async () => Response.json({ items: [{ ...item, title: hostile }] }));
  expect(await run(["ls", "--json"], json.io)).toBe(0);
  expect(json.stdout.join("")).not.toMatch(hostilePattern);
  expect(AgentReviewList.parse(JSON.parse(json.stdout.join(""))).items[0]?.title).toBe(hostile);
});

test("ls prints nothing for an empty list", async () => {
  const f = await commandFixture();
  f.setResponse(async () => Response.json({ items: [] }));
  expect(await run(["ls"], f.io)).toBe(0);
  expect(f.stdout).toEqual([]);
  const json = await commandFixture();
  json.setResponse(async () => Response.json({ items: [] }));
  expect(await run(["ls", "--json"], json.io)).toBe(0);
  expect(JSON.parse(json.stdout.join(""))).toEqual({ items: [] });
});

test("ls against a hub that is down exits 1 with the hub error line", async () => {
  const f = await commandFixture();
  attach(f.dir);
  f.fetcher.mockImplementation(async () => {
    throw new TypeError("fetch failed", { cause: { code: "ECONNREFUSED" } });
  });
  expect(await run(["ls"], f.io)).toBe(1);
  expect(f.stdout).toEqual([]);
  expect(f.stderr).toEqual([
    "emend: cannot reach the hub at https://hub.example: connection refused. Nothing was changed.\n",
  ]);
});

test.each([401, 500])("ls against a local server answering %s exits 1 with one stderr line", async (status) => {
  const f = await commandFixture();
  f.setResponse(async () =>
    status === 401
      ? Response.json({ error: { code: "unauthorized", message: "Unauthorized." } }, { status })
      : new Response("boom", { status }),
  );
  expect(await run(["ls"], f.io)).toBe(1);
  expect(f.stdout).toEqual([]);
  expect(f.stderr).toHaveLength(1);
  expect(f.stderr[0]).toMatch(/^emend: [^\n]+\n$/);
  expect(f.stderr.join("")).not.toContain(token);
});

test("ls rejects arguments and an invalid server answer", async () => {
  const f = await commandFixture();
  expect(await run(["ls", "--bogus"], f.io)).toBe(2);
  expect(f.stderr.join("")).toContain("Usage: emend ls [--json] [--head <sha>]");
  f.setResponse(async () => Response.json({ items: [{ id: "x" }] }));
  expect(await run(["ls"], f.io)).toBe(1);
  expect(f.stderr.join("")).toContain("invalid response");
});

test("ls without a server reads the state folder directly, newest first", async () => {
  const f = await directFixture();
  const first = await f.publish("first");
  const second = await f.publish("second");
  const state = await f.reviewer();
  await state.db.query((q) =>
    q.update(reviews).set({ updatedAt: 1_000 }).where(eq(reviews.id, second.result.reviewId)),
  );
  await state.db.query((q) => q.update(reviews).set({ updatedAt: 2_000 }).where(eq(reviews.id, first.result.reviewId)));
  const out = f.output();
  expect(await run(["ls", "--json"], out.io)).toBe(0);
  const list = AgentReviewList.parse(JSON.parse(out.stdout.join("")));
  expect(list.items).toMatchObject([
    { id: first.result.reviewId, title: "Synthetic direct review", state: "open" },
    { id: second.result.reviewId, state: "open" },
  ]);
  expect(list.items[0]?.url).toBe(first.result.url);
  const human = f.output();
  expect(await run(["ls"], human.io)).toBe(0);
  const lines = human.stdout.join("").split("\n");
  expect(lines[0]).toContain(`${first.result.reviewId}\topen\t`);
  expect(lines[1]).toContain(`${second.result.reviewId}\topen\t`);
});

const sha = "ab".repeat(20);
test("ls --json --head sends the head as a query, in either order", async () => {
  for (const args of [
    ["ls", "--json", "--head", sha],
    ["ls", "--head", sha, "--json"],
  ]) {
    const f = await commandFixture();
    f.setResponse(async (url) => {
      expect(String(url)).toBe(`http://127.0.0.1:3636/api/v1/agent/reviews?head=${sha}`);
      return Response.json({
        items: [{ ...item, branch: "feature", newest: { revision: 2, head: sha }, approved: null }],
      });
    });
    expect(await run(args, f.io)).toBe(0);
    expect(AgentReviewList.parse(JSON.parse(f.stdout.join(""))).items[0]).toMatchObject({
      newest: { revision: 2, head: sha },
      approved: null,
    });
  }
});

test.each([
  ["--head"],
  ["--head", "abc"],
  ["--head", "worktree"],
  ["--head", sha.toUpperCase()],
  ["--head", sha, "--head", sha],
  ["--json", "--json"],
  ["--bogus"],
])("ls %s is a usage error", async (...args) => {
  const f = await commandFixture();
  f.setResponse(async () => Response.json({ items: [] }));
  expect(await run(["ls", ...args], f.io)).toBe(2);
  expect(f.stderr.join("")).toContain("Usage: emend ls [--json] [--head <sha>]");
  expect(f.stdout).toEqual([]);
});

test("ls --head without a server filters the state folder directly", async () => {
  const f = await directFixture();
  const first = await f.publish("first");
  const second = await f.publish("second");
  const state = await f.reviewer();
  await state.db.query((q) =>
    q.update(revisions).set({ head: sha }).where(eq(revisions.reviewId, first.result.reviewId)),
  );
  await state.db.query((q) =>
    q
      .update(revisions)
      .set({ head: "cd".repeat(20) })
      .where(eq(revisions.reviewId, second.result.reviewId)),
  );
  const out = f.output();
  expect(await run(["ls", "--json", "--head", sha], out.io)).toBe(0);
  const list = AgentReviewList.parse(JSON.parse(out.stdout.join("")));
  expect(list.items).toHaveLength(1);
  expect(list.items[0]).toMatchObject({
    id: first.result.reviewId,
    newest: { revision: 1, head: sha },
    approved: null,
  });
  const human = f.output();
  expect(await run(["ls", "--head", sha], human.io)).toBe(0);
  expect(human.stdout.join("").split("\n").filter(Boolean)).toHaveLength(1);
});

test("status without a server reports local, not answering, and no address", async () => {
  const f = await directFixture();
  const out = f.output();
  expect(await run(["status", "--json"], out.io)).toBe(0);
  expect(JSON.parse(out.stdout.join(""))).toEqual({
    mode: "local",
    address: null,
    hub: null,
    instance: null,
    answering: false,
    version: VERSION,
  });
  const human = f.output();
  expect(await run(["status"], human.io)).toBe(0);
  expect(human.stdout.join("")).toBe(
    `mode: local\naddress: none\ninstance: none\nserver: not answering\nversion: ${VERSION}\n`,
  );
});

test("status creates nothing: a fresh or missing state folder stays as it is", async () => {
  const fresh = await mkdtemp(join(tmpdir(), "emend-status-"));
  onTestFinished(() => rm(fresh, { recursive: true, force: true }));
  const out = (env: string) => ({ stdout: [] as string[], stderr: [] as string[], env: { EMEND_HOME: env } });
  const run1 = out(fresh);
  expect(
    await run(["status", "--json"], {
      ...run1,
      stdout: (s) => void run1.stdout.push(s),
      stderr: (s) => void run1.stderr.push(s),
    }),
  ).toBe(0);
  expect(JSON.parse(run1.stdout.join("")).instance).toBeNull();
  expect(await readdir(fresh)).toEqual([]);
  expect(run1.stderr).toEqual([]);
  const missing = join(fresh, "missing");
  const run2 = out(missing);
  expect(
    await run(["status"], {
      ...run2,
      stdout: (s) => void run2.stdout.push(s),
      stderr: (s) => void run2.stderr.push(s),
    }),
  ).toBe(0);
  expect(run2.stdout.join("")).toContain("instance: none\n");
  expect(run2.stderr).toEqual([
    `emend: state folder ${missing} not found: emend has not run on this machine yet, or an agent sandbox hides it. ${sandboxHint}\n`,
  ]);
  await expect(stat(missing)).rejects.toMatchObject({ code: "ENOENT" });
  const run3 = out(missing);
  expect(
    await run(["status", "--json"], {
      ...run3,
      stdout: (s) => void run3.stdout.push(s),
      stderr: (s) => void run3.stderr.push(s),
    }),
  ).toBe(0);
  expect(JSON.parse(run3.stdout.join(""))).toMatchObject({ mode: "local", instance: null, answering: false });
  expect(run3.stderr).toHaveLength(1);
  await expect(stat(missing)).rejects.toMatchObject({ code: "ENOENT" });
});

test("status in a read-only state folder still reports", async () => {
  const dir = await mkdtemp(join(tmpdir(), "emend-status-"));
  onTestFinished(async () => {
    await chmod(dir, 0o700);
    await rm(dir, { recursive: true, force: true });
  });
  await chmod(dir, 0o500);
  const stdout: string[] = [];
  const stderr: string[] = [];
  expect(
    await run(["status", "--json"], {
      stdout: (s) => void stdout.push(s),
      stderr: (s) => void stderr.push(s),
      env: { EMEND_HOME: dir },
    }),
  ).toBe(0);
  expect(JSON.parse(stdout.join(""))).toMatchObject({ mode: "local", instance: null, answering: false });
  expect(stderr).toEqual([]);
});

test("status reports the instance name from instance.json", async () => {
  const f = await commandFixture();
  writeSecretFile(join(f.dir, "instance.json"), JSON.stringify({ id: randomUUID(), name: "Synthetic laptop" }));
  expect(await run(["status", "--json"], f.io)).toBe(0);
  expect(JSON.parse(f.stdout.join("")).instance).toBe("Synthetic laptop");
});

test("status prints a hostile instance name escaped in both forms", async () => {
  const f = await commandFixture();
  writeSecretFile(join(f.dir, "instance.json"), JSON.stringify({ id: randomUUID(), name: hostile }));
  expect(await run(["status"], f.io)).toBe(0);
  expect(f.stdout.join("")).not.toMatch(hostilePattern);
  const json = await commandFixture();
  writeSecretFile(join(json.dir, "instance.json"), JSON.stringify({ id: randomUUID(), name: hostile }));
  expect(await run(["status", "--json"], json.io)).toBe(0);
  expect(json.stdout.join("")).not.toMatch(hostilePattern);
  expect(JSON.parse(json.stdout.join("")).instance).toBe(hostile);
});

test("status reports a local server on a non-default port", async () => {
  const f = await commandFixture();
  const key = Buffer.alloc(32, 3).toString("base64url");
  writeSecretFile(join(f.dir, "server.json"), JSON.stringify({ url: "http://127.0.0.1:4001", pid: process.pid, key }));
  expect(await run(["status", "--json"], f.io)).toBe(0);
  expect(JSON.parse(f.stdout.join(""))).toMatchObject({ address: "http://127.0.0.1:4001", answering: true });
});

test("attached status without hub.token still reports and prints no token", async () => {
  const f = await commandFixture();
  attach(f.dir);
  await rm(join(f.dir, "hub.token"));
  expect(await run(["status"], f.io)).toBe(0);
  expect(f.stdout.join("")).toContain("mode: attached\n");
  expect(f.stdout.join("")).not.toMatch(/em_[A-Za-z0-9_-]{43}/);
});

test("status with a local server answering reports its address", async () => {
  const f = await commandFixture();
  expect(await run(["status", "--json"], f.io)).toBe(0);
  expect(JSON.parse(f.stdout.join(""))).toMatchObject({
    mode: "local",
    address: "http://127.0.0.1:3636",
    answering: true,
  });
});

test("status attached names the hub, and a silent hub is reported, not an error", async () => {
  const f = await commandFixture();
  attach(f.dir);
  f.fetcher.mockImplementation(async () => {
    throw new TypeError("fetch failed", { cause: { code: "ECONNREFUSED" } });
  });
  expect(await run(["status", "--json"], f.io)).toBe(0);
  expect(JSON.parse(f.stdout.join(""))).toEqual({
    mode: "attached",
    address: "https://hub.example",
    hub: "Synthetic hub",
    instance: null,
    answering: false,
    version: VERSION,
  });
});

test("status attached reports an answering hub", async () => {
  const f = await commandFixture();
  attach(f.dir);
  f.fetcher.mockImplementation(async () => Response.json({ api: 1, version: "0.1.0", features: [] }));
  const human = await run(["status"], f.io);
  expect(human).toBe(0);
  expect(f.stdout.join("")).toContain("mode: attached\naddress: https://hub.example\nhub: Synthetic hub\n");
  expect(f.stdout.join("")).toContain("server: answering\n");
});

test.each([false, true])("status never prints a token (attached %s)", async (attached) => {
  const f = await commandFixture();
  if (attached) attach(f.dir);
  const spy = vi.fn();
  for (const args of [["status"], ["status", "--json"]]) {
    expect(await run(args, { ...f.io, stderr: spy })).toBe(0);
  }
  const all = f.stdout.join("") + spy.mock.calls.flat().join("");
  expect(all).not.toContain(token);
  expect(all).not.toContain(hubToken);
  expect(all).not.toMatch(/em_[A-Za-z0-9_-]{43}/);
});

test("status rejects arguments", async () => {
  const f = await commandFixture();
  expect(await run(["status", "--bogus"], f.io)).toBe(2);
  expect(f.stderr.join("")).toContain("Usage: emend status [--json]");
});

test("--help lists ls and status", async () => {
  const f = await commandFixture();
  expect(await run(["--help"], f.io)).toBe(0);
  expect(f.stdout.join("")).toContain("emend ls [--json]");
  expect(f.stdout.join("")).toContain("emend status [--json]");
});
