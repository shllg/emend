import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import type { AgentReviewItem } from "@emend/contract";
import { expect, onTestFinished, test, vi } from "vitest";
import { run } from "../../main.ts";
import { writeSecretFile } from "../../state/files.ts";
import { reviewKey } from "../publish/key.ts";
import { commandFixture } from "../test-support.ts";
import { statusLineText } from "./status.ts";

const exec = promisify(execFile);
const token = `em_${"a".repeat(43)}`;
const hubToken = `em_${"b".repeat(43)}`;
const branch = "synthetic-feature";
const reviewId = randomUUID();
const item: AgentReviewItem = {
  id: reviewId,
  title: "Synthetic review",
  branch,
  state: "open",
  turn: "reviewer",
  newest: { revision: 3, head: "ab".repeat(20) },
  approved: null,
  updatedAt: "2026-01-01T00:10:00.000Z",
  url: `http://127.0.0.1:3636/r/${reviewId}`,
};

function attach(dir: string) {
  writeSecretFile(
    join(dir, "attach.json"),
    JSON.stringify({ hubId: randomUUID(), hubName: "Synthetic hub", hubUrl: "https://hub.example" }),
  );
  writeSecretFile(join(dir, "hub.token"), hubToken);
}

async function lineFixture() {
  const f = await commandFixture();
  const repo = await mkdtemp(join(tmpdir(), "emend-status-line-"));
  onTestFinished(() => rm(repo, { recursive: true, force: true }));
  const git = (...args: string[]) =>
    exec(
      "git",
      [
        "-c",
        "core.hooksPath=/dev/null",
        "-c",
        "commit.gpgSign=false",
        "-c",
        "user.name=Synthetic",
        "-c",
        "user.email=synthetic@example.test",
        ...args,
      ],
      {
        cwd: repo,
        env: {
          PATH: process.env.PATH,
          LC_ALL: "C",
          GIT_CONFIG_GLOBAL: "/dev/null",
          GIT_CONFIG_NOSYSTEM: "1",
        },
      },
    );
  await git("init", "-b", "main");
  await git("commit", "--allow-empty", "-m", "synthetic base");
  await git("checkout", "-b", branch);
  const instanceId = randomUUID();
  writeSecretFile(join(f.dir, "instance.json"), JSON.stringify({ id: instanceId, name: "Synthetic machine" }));
  vi.spyOn(process, "cwd").mockReturnValue(repo);
  f.setResponse(async () => Response.json({ items: [item] }));
  return { ...f, repo, git, instanceId };
}

test("status --line requests the publish key with the agent token and prints the reviewer's turn", async () => {
  const f = await lineFixture();
  const key = reviewKey(f.instanceId, await realpath(f.repo), branch);
  const respond = vi.fn(async (url: string | URL, init?: RequestInit) => {
    expect(String(url)).toBe(`http://127.0.0.1:3636/api/v1/agent/reviews?key=${key}`);
    expect(new Headers(init?.headers).get("Authorization")).toBe(`Bearer ${token}`);
    expect(init?.method).toBe("GET");
    return Response.json({ items: [item] });
  });
  f.setResponse(respond);
  expect(await run(["status", "--line"], f.io)).toBe(0);
  expect(respond).toHaveBeenCalledOnce();
  expect(f.stdout).toEqual(["emend r3 · your turn\n"]);
  expect(f.stderr).toEqual([]);
});

test.each([
  { name: "agent's turn", overrides: { turn: "agent" }, expected: "emend r3 · agent's turn\n" },
  {
    name: "approved revision",
    overrides: { state: "approved", turn: null, approved: { revision: 2, head: null } },
    expected: "emend r2 · approved\n",
  },
  { name: "retired", overrides: { state: "settled", turn: null }, expected: "emend r3 · retired\n" },
  { name: "an older server without turn", overrides: { turn: undefined }, expected: "emend r3\n" },
])("status --line prints $name", async ({ overrides, expected }) => {
  const f = await lineFixture();
  f.setResponse(async () => Response.json({ items: [{ ...item, ...overrides }] }));
  expect(await run(["status", "--line"], f.io)).toBe(0);
  expect(f.stdout).toEqual([expected]);
  expect(f.stderr).toEqual([]);
});

test.each([
  { name: "an invalid answer", answer: { items: [{ id: "invalid" }] } },
  { name: "another branch", answer: { items: [{ ...item, branch: "another-feature" }] } },
  { name: "an empty list", answer: { items: [] } },
  { name: "no newest revision", answer: { items: [{ ...item, newest: null }] } },
])("status --line stays silent with $name", async ({ answer }) => {
  const f = await lineFixture();
  f.setResponse(async () => Response.json(answer));
  expect(await run(["status", "--line"], f.io)).toBe(0);
  expect(f.stdout).toEqual([]);
  expect(f.stderr).toEqual([]);
});

test.each([401, 500])("status --line stays silent when the server answers %s", async (status) => {
  const f = await lineFixture();
  f.setResponse(async () => new Response("failure", { status }));
  expect(await run(["status", "--line"], f.io)).toBe(0);
  expect(f.stdout).toEqual([]);
  expect(f.stderr).toEqual([]);
});

test.each(["server.json", "instance.json"])("status --line stays silent without %s", async (file) => {
  const f = await lineFixture();
  await rm(join(f.dir, file));
  expect(await run(["status", "--line"], f.io)).toBe(0);
  expect(f.stdout).toEqual([]);
  expect(f.stderr).toEqual([]);
  expect(f.fetcher).not.toHaveBeenCalled();
});

test.each([null, {}, { id: 123 }, { id: "invalid" }])(
  "status --line stays silent with an invalid instance record: %j",
  async (instance) => {
    const f = await lineFixture();
    writeSecretFile(join(f.dir, "instance.json"), JSON.stringify(instance));
    expect(await run(["status", "--line"], f.io)).toBe(0);
    expect(f.stdout).toEqual([]);
    expect(f.stderr).toEqual([]);
    expect(f.fetcher).not.toHaveBeenCalled();
  },
);

test("status --line stays silent without a state folder and creates nothing", async () => {
  const f = await lineFixture();
  await rm(f.dir, { recursive: true, force: true });
  expect(await run(["status", "--line"], f.io)).toBe(0);
  expect(f.stdout).toEqual([]);
  expect(f.stderr).toEqual([]);
  await expect(realpath(f.dir)).rejects.toMatchObject({ code: "ENOENT" });
  expect(f.fetcher).not.toHaveBeenCalled();
});

test("status --line stays silent outside a git repository", async () => {
  const f = await lineFixture();
  await rm(join(f.repo, ".git"), { recursive: true, force: true });
  expect(await run(["status", "--line"], f.io)).toBe(0);
  expect(f.stdout).toEqual([]);
  expect(f.stderr).toEqual([]);
  expect(f.fetcher).not.toHaveBeenCalled();
});

test("status --line stays silent on a detached HEAD", async () => {
  const f = await lineFixture();
  await f.git("checkout", "--detach", "HEAD");
  expect(await run(["status", "--line"], f.io)).toBe(0);
  expect(f.stdout).toEqual([]);
  expect(f.stderr).toEqual([]);
  expect(f.fetcher).not.toHaveBeenCalled();
});

test("status --line stays silent when the root is refused", async () => {
  const f = await lineFixture();
  const stateDir = join(f.repo, "state");
  await mkdir(stateDir);
  expect(await run(["status", "--line"], { ...f.io, env: { ...f.io.env, EMEND_HOME: stateDir } })).toBe(0);
  expect(f.stdout).toEqual([]);
  expect(f.stderr).toEqual([]);
  expect(f.fetcher).not.toHaveBeenCalled();
});

test("status --line stays silent when the hub is down", async () => {
  const f = await lineFixture();
  attach(f.dir);
  f.fetcher.mockImplementation(async () => {
    throw new TypeError("fetch failed", { cause: { code: "ECONNREFUSED" } });
  });
  expect(await run(["status", "--line"], f.io)).toBe(0);
  expect(f.stdout).toEqual([]);
  expect(f.stderr).toEqual([]);
  expect(f.fetcher).toHaveBeenCalledOnce();
  expect(new Headers(f.fetcher.mock.calls[0]?.[1]?.headers).has("Authorization")).toBe(false);
});

test("status --line checks the hub before sending the hub token to the hub only", async () => {
  const f = await lineFixture();
  attach(f.dir);
  const key = reviewKey(f.instanceId, await realpath(f.repo), branch);
  f.setResponse(async () => Response.json({ items: [item] }));
  expect(await run(["status", "--line"], f.io)).toBe(0);
  expect(f.stdout).toEqual(["emend r3 · your turn\n"]);
  expect(f.stderr).toEqual([]);
  expect(f.fetcher.mock.calls.map(([url]) => String(url))).toEqual([
    "https://hub.example/api/v1/capabilities",
    `https://hub.example/api/v1/agent/reviews?key=${key}`,
  ]);
  const headers = f.fetcher.mock.calls.map(([, init]) => new Headers(init?.headers).get("Authorization"));
  expect(headers).toEqual([null, `Bearer ${hubToken}`]);
  expect(f.stdout.join("")).not.toContain(hubToken);
});

test.each([false, true])("status --line sends no token to an unverified target (attached %s)", async (attached) => {
  const f = await lineFixture();
  if (attached) attach(f.dir);
  f.fetcher.mockImplementation(async () => Response.json({}));
  expect(await run(["status", "--line"], f.io)).toBe(0);
  expect(f.stdout).toEqual([]);
  expect(f.stderr).toEqual([]);
  expect(f.fetcher).toHaveBeenCalledOnce();
  expect(new Headers(f.fetcher.mock.calls[0]?.[1]?.headers).has("Authorization")).toBe(false);
});

test("status --line stays silent when its deadline expires during the request", async () => {
  const f = await lineFixture();
  const deadline = new AbortController();
  const timeout = AbortSignal.timeout.bind(AbortSignal);
  vi.spyOn(AbortSignal, "timeout").mockImplementation((ms) => (ms === 2000 ? deadline.signal : timeout(ms)));
  const respond = vi.fn(async (_url: string | URL, init?: RequestInit) => {
    deadline.abort(new DOMException("Synthetic deadline", "TimeoutError"));
    init?.signal?.throwIfAborted();
    return Response.json({ items: [item] });
  });
  f.setResponse(respond);
  expect(await run(["status", "--line"], f.io)).toBe(0);
  expect(respond).toHaveBeenCalledOnce();
  expect(f.stdout).toEqual([]);
  expect(f.stderr).toEqual([]);
});

test("status --line selects the first matching branch from an older server", async () => {
  const f = await lineFixture();
  f.setResponse(async () =>
    Response.json({
      items: [{ ...item, branch: "another-feature" }, item, { ...item, newest: { revision: 2, head: null } }],
    }),
  );
  expect(await run(["status", "--line"], f.io)).toBe(0);
  expect(f.stdout).toEqual(["emend r3 · your turn\n"]);
  expect(f.stderr).toEqual([]);
});

test("status --line stays silent if writing stdout fails", async () => {
  const f = await lineFixture();
  const stdout = vi.fn(() => {
    throw new Error("closed stdout");
  });
  expect(await run(["status", "--line"], { ...f.io, stdout })).toBe(0);
  expect(stdout).toHaveBeenCalledOnce();
  expect(f.stderr).toEqual([]);
});

test.each([
  ["--line", "--json"],
  ["--line", "extra"],
])("status %s %s is a usage error", async (...args) => {
  const f = await commandFixture();
  expect(await run(["status", ...args], f.io)).toBe(2);
  expect(f.stdout).toEqual([]);
  expect(f.stderr).toEqual(["emend: Usage: emend status [--json | --line].\n"]);
  expect(f.fetcher).not.toHaveBeenCalled();
});

test.each<{ name: string; overrides: Partial<AgentReviewItem>; expected: string | null }>([
  { name: "no newest revision", overrides: { newest: null }, expected: null },
  { name: "reviewer's turn", overrides: {}, expected: "emend r3 · your turn" },
  { name: "agent's turn", overrides: { turn: "agent" }, expected: "emend r3 · agent's turn" },
  { name: "unknown turn", overrides: { turn: null }, expected: "emend r3" },
  {
    name: "approved revision",
    overrides: { state: "approved", approved: { revision: 2, head: null } },
    expected: "emend r2 · approved",
  },
  { name: "approval without a revision pointer", overrides: { state: "approved" }, expected: "emend r3 · approved" },
  { name: "retired", overrides: { state: "settled" }, expected: "emend r3 · retired" },
  { name: "approved without a newest revision", overrides: { state: "approved", newest: null }, expected: null },
  { name: "retired without a newest revision", overrides: { state: "settled", newest: null }, expected: null },
])("statusLineText: $name", ({ overrides, expected }) => {
  expect(statusLineText({ ...item, ...overrides })).toBe(expected);
});
