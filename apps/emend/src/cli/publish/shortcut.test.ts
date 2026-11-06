import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import * as fs from "node:fs/promises";
import { mkdir, rm, stat, symlink, truncate, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { LIMITS, PublishRequest, PublishResponse } from "@emend/contract";
import { cleanDocTitle } from "@emend/core";
import { expect, test, vi } from "vitest";
import { reviews, revisions } from "../../db/schema.ts";
import { run } from "../../main.ts";
import * as executors from "../../server/publish/executor.ts";
import { workInThread } from "../../test/in-thread-worker.ts";
import { directFixture } from "../direct-test-support.ts";
import { escapeReference } from "../escape.ts";
import { provenTestServer } from "../test-support.ts";
import { docsKey } from "./key.ts";
import * as sourceReads from "./read.ts";
import { publishContext } from "./resolve.ts";
import * as shortcuts from "./shortcut.ts";
import { shortcutManifest } from "./shortcut.ts";
import { SHORTCUT_LIMITS } from "./shortcut-walk.ts";

vi.mock("node:fs/promises", async (original) => ({ ...(await original<typeof import("node:fs/promises")>()) }));
vi.mock("./read.ts", async (original) => ({ ...(await original<typeof import("./read.ts")>()) }));
vi.mock("./shortcut.ts", async (original) => ({ ...(await original<typeof import("./shortcut.ts")>()) }));
vi.mock("../../server/publish/executor.ts", async (original) => ({
  ...(await original<typeof import("../../server/publish/executor.ts")>()),
}));

const syntheticPrivateKey = (kind = "OPENSSH PRIVATE KEY") =>
  `-----BEGIN ${kind}-----\n${"A".repeat(64)}\n-----END ${kind}-----\n`;

async function fixture(realWorker = false) {
  const f = await directFixture();
  if (!realWorker) workInThread(executors);
  await rm(f.manifest);
  await rm(join(f.source, "plan.md"));
  vi.spyOn(process, "cwd").mockReturnValue(f.source);
  async function file(path: string, text: string | Buffer = "# Synthetic document\n") {
    const source = join(f.source, path);
    await mkdir(join(source, ".."), { recursive: true });
    await writeFile(source, text, { mode: 0o644 });
    return source;
  }
  async function publish(...args: string[]) {
    const out = f.output();
    const code = await run(["publish", ...args], out.io);
    return { ...out, code };
  }
  async function capture(kind: "local" | "hub" = "local", responseUrl?: string) {
    const instanceId = randomUUID();
    const reviewId = randomUUID();
    await writeFile(join(f.stateDir, "instance.json"), JSON.stringify({ id: instanceId }));
    await writeFile(join(f.stateDir, "agent.token"), `em_${"a".repeat(43)}`, { mode: 0o600 });
    const proof = provenTestServer(f.stateDir);
    const origin = kind === "hub" ? "https://hub.example" : "http://127.0.0.1:3636";
    if (kind === "hub") {
      await writeFile(
        join(f.stateDir, "attach.json"),
        JSON.stringify({ hubId: randomUUID(), hubName: "Synthetic", hubUrl: origin }),
      );
      await writeFile(join(f.stateDir, "hub.token"), `em_${"b".repeat(43)}`, { mode: 0o600 });
    }
    const requests: PublishRequest[] = [];
    const fetcher = vi.fn(async (url: string | URL, init?: RequestInit) => {
      if (String(url).endsWith("/capabilities")) {
        return kind === "local" ? proof(url, init) : Response.json({ api: 1, version: "0.1.0", features: [] });
      }
      if (init?.method === "HEAD") return new Response(null, { status: 404 });
      if (init?.method === "PUT") return new Response(null, { status: 204 });
      requests.push(PublishRequest.parse(JSON.parse(String(init?.body))));
      return Response.json({
        reviewId,
        revision: requests.length,
        placed: 0,
        unplaced: 0,
        unrendered: [],
        url: responseUrl ?? `${origin}/r/${reviewId}`,
      });
    });
    vi.stubGlobal("fetch", fetcher);
    return { requests, fetcher, instanceId, url: `${origin}/r/${reviewId}` };
  }
  return { ...f, file, publish, capture };
}

test.each(["md", "html"])("failed %s title inference falls back and closes the worker", async (extension) => {
  const f = await fixture();
  await f.file(`fallback.${extension}`, extension === "md" ? "# Own title" : "<title>Own title</title>");
  const capture = await f.capture();
  const close = vi.fn(async () => {});
  const execute = Object.assign(vi.fn().mockRejectedValue(new executors.WorkTimeout()), { close });
  vi.spyOn(executors, "workerExecutor").mockReturnValueOnce(execute);
  const result = await f.publish(`fallback.${extension}`);
  expect(result.code, result.stderr.join("")).toBe(0);
  expect(capture.requests[0]?.title).toBe(`fallback.${extension}`);
  expect(execute).toHaveBeenCalledWith(
    expect.objectContaining({ kind: "doc-metadata", format: extension === "md" ? "markdown" : "html" }),
  );
  expect(close).toHaveBeenCalledOnce();
});

// Real worker startup and bounded rendering of reference-expanding Markdown are the subject.
test("reference-expansion main doc publishes with a bounded worker title", async () => {
  const f = await fixture(true);
  await f.file(
    "expansion.md",
    `# Reference title\n\n${"[x][r] ".repeat(1000)}\n\n[r]: https://example.test/${"x".repeat(20000)}`,
  );
  const capture = await f.capture();
  const realWorker = executors.workerExecutor();
  const close = vi.spyOn(realWorker, "close");
  const execute = Object.assign(vi.fn(realWorker), { close });
  const worker = vi.spyOn(executors, "workerExecutor").mockReturnValueOnce(execute);
  const result = await f.publish("expansion.md");
  expect(result.code, result.stderr.join("")).toBe(0);
  expect(worker).toHaveBeenCalledOnce();
  expect(execute).toHaveBeenCalledExactlyOnceWith(
    expect.objectContaining({ kind: "doc-metadata", format: "markdown", bytes: expect.any(ArrayBuffer) }),
  );
  const metadata = await execute.mock.results[0]?.value.catch(() => undefined);
  expect(capture.requests[0]?.title).toBe(
    metadata?.kind === "doc-metadata" && metadata.title ? metadata.title : "expansion.md",
  );
  expect(close).toHaveBeenCalledOnce();
}, 15000);

test("one doc publishes directly, prints only its URL, and republishes to one review with two revisions", async () => {
  const f = await fixture();
  await f.file("plan.md", "# First plan\n");
  const first = await f.publish("plan.md");
  expect(first.code, first.stderr.join("")).toBe(0);
  expect(first.stdout).toEqual([expect.stringMatching(/^http:\/\/127\.0\.0\.1:3636\/r\/[a-f0-9-]{36}\n$/)]);
  expect(first.stderr.join("")).toContain("emend is not running");
  await f.file("plan.md", "# Updated plan\n");
  const second = await f.publish("./plan.md", "--json");
  expect(second.code, second.stderr.join("")).toBe(0);
  const result = PublishResponse.parse(JSON.parse(second.stdout.join("")));
  expect(result.revision).toBe(2);
  expect(first.stdout).toEqual([`${result.url}\n`]);
  expect(second.stdout).toEqual([`${JSON.stringify(result)}\n`]);
  const server = await f.reviewer();
  expect(await server.db.read((q) => q.select().from(reviews).all())).toHaveLength(1);
  expect(await server.db.read((q) => q.select().from(revisions).all())).toHaveLength(2);
});

test("--new creates separate reviews and --key keeps a review across regenerated paths", async () => {
  const f = await fixture();
  await f.file("first.md");
  await f.file("second.md");
  const results = [];
  for (const args of [
    ["first.md", "--new"],
    ["first.md", "--new"],
    ["first.md", "--key", "report"],
    ["second.md", "--key", "report"],
  ]) {
    const out = await f.publish(...args, "--json");
    expect(out.code, out.stderr.join("")).toBe(0);
    results.push(PublishResponse.parse(JSON.parse(out.stdout.join(""))));
  }
  expect(results[0]?.reviewId).not.toBe(results[1]?.reviewId);
  expect(results[2]?.reviewId).toBe(results[3]?.reviewId);
  expect(results[3]?.revision).toBe(2);
  const server = await f.reviewer();
  expect(await server.db.read((q) => q.select().from(reviews).all())).toHaveLength(3);
});

test("--review explicitly updates the named review from another path", async () => {
  const f = await fixture();
  await f.file("first.md");
  await f.file("second.md");
  const first = await f.publish("first.md", "--json");
  expect(first.code, first.stderr.join("")).toBe(0);
  const result = PublishResponse.parse(JSON.parse(first.stdout.join("")));
  const second = await f.publish("second.md", "--review", result.reviewId, "--json");
  expect(second.code, second.stderr.join("")).toBe(0);
  expect(JSON.parse(second.stdout.join(""))).toMatchObject({ reviewId: result.reviewId, revision: 2, url: result.url });
});

test.each(["local", "hub"] as const)(
  "the %s HTTP path gets the existing docs manifest and instance-scoped path key",
  async (kind) => {
    const f = await fixture();
    const source = await f.file("plan.md");
    const capture = await f.capture(kind);
    const out = await f.publish("plan.md");
    expect(out.code, out.stderr.join("")).toBe(0);
    expect(out.stdout).toEqual([`${capture.url}\n`]);
    expect(out.stderr.join("")).not.toContain("not running");
    const name = `path:${createHash("sha256")
      .update(JSON.stringify([capture.instanceId, source]))
      .digest("hex")
      .slice(0, 16)}`;
    expect(capture.requests[0]).toMatchObject({
      reviewKey: docsKey(capture.instanceId, name),
      title: "Synthetic document",
      main: "plan.md",
      base: null,
      head: null,
      repo: null,
      topics: [],
      files: [{ path: "plan.md", role: "doc" }],
    });
    await expect(stat(join(f.stateDir, "emend.db"))).rejects.toMatchObject({ code: "ENOENT" });
  },
);

test("multiple inputs use their sorted distinct real paths and retain the uploaded path layout", async () => {
  const f = await fixture();
  const a = await f.file("a/plan.md");
  const b = await f.file("b/plan.md");
  const capture = await f.capture();
  expect((await f.publish(a, b)).code).toBe(0);
  expect((await f.publish(b, a, a)).code).toBe(0);
  expect(capture.requests[0]?.reviewKey).toBe(capture.requests[1]?.reviewKey);
  expect(capture.requests[0]?.files.map((file) => file.path)).toEqual(["a/plan.md", "b/plan.md"]);
});

test("a folder keeps its key as documents are added and file aliases use the real path key", async () => {
  const f = await fixture();
  await f.file("bundle/index.md");
  const capture = await f.capture();
  expect((await f.publish("bundle")).code).toBe(0);
  await f.file("bundle/details.md");
  expect((await f.publish("./bundle")).code).toBe(0);
  expect(capture.requests[0]?.reviewKey).toBe(capture.requests[1]?.reviewKey);
  await symlink(join(f.source, "bundle/index.md"), join(f.source, "alias.md"));
  expect((await f.publish("bundle/index.md")).code).toBe(0);
  expect((await f.publish("alias.md")).code).toBe(0);
  expect(capture.requests[2]?.reviewKey).toBe(capture.requests[3]?.reviewKey);
});

test("folder publication bundles linked docs and a referenced image, skipping invisible files and unused files", async () => {
  const f = await fixture();
  await f.file(
    "bundle/index.html",
    '<title>Folder plan</title><a href="details.md">Details</a><img src="image.png"><script src="node_modules/tool.js"></script>',
  );
  await f.file("bundle/details.md", "# Details\n[Back](index.html)\n");
  await f.file("bundle/image.png", "synthetic image");
  await f.file("bundle/unused.png", "unused image");
  await f.file("bundle/notes.txt", "a text doc");
  for (const path of [
    ".git/config",
    ".hidden.md",
    ".private/hidden.md",
    ".DS_Store",
    "node_modules/tool.js",
    "node_modules/hidden.md",
  ])
    await f.file(`bundle/${path}`, "synthetic ignored");
  const capture = await f.capture();
  const out = await f.publish("bundle");
  expect(out.code, out.stderr.join("")).toBe(0);
  expect(capture.requests[0]).toMatchObject({ title: "Folder plan", main: "index.html" });
  expect(capture.requests[0]?.files.map((file) => [file.path, file.role])).toEqual([
    ["details.md", "doc"],
    ["index.html", "doc"],
    ["image.png", "asset"],
    ["notes.txt", "doc"],
  ]);
  expect(capture.requests[0]?.files.find((file) => file.path === "index.html")?.assets).toEqual(["image.png"]);
  expect(out.stderr.filter((line) => line.includes("notes.txt"))).toHaveLength(0);
  expect(out.stderr.filter((line) => line.includes("unused.png"))).toHaveLength(1);
  expect(out.stderr.join("")).not.toContain("hidden.md");
});

test.each([
  ["page.html", "<title>HTML title</title>", ["--title", "Explicit title"], "Explicit title"],
  ["page.html", "<TITLE> HTML &amp; title </TITLE>", [], "HTML & title"],
  ["page.htm", "<title>HTML title</title>", [], "HTML title"],
  ["page.html", "<svg><title>Wrong</title></svg><h1>Body title</h1>", [], "Body title"],
  ["plan.md", "<script>\n# Wrong\n</script>\n\n# Rendered title", [], "Rendered title"],
  ["plan.md", "## Ignore\n# First heading ###\n# Later heading", [], "First heading"],
  ["plan.markdown", "# Markdown title", [], "Markdown title"],
  ["plan.md", "No heading", [], "plan.md"],
  ["plan.md", "```md\n# Code\n```\n# Document", [], "Document"],
  ["page.html", "<!-- <title>Comment</title> --><title>Real title</title>", [], "Real title"],
  ["page.html", "<title>   </title>", [], "page.html"],
  ["page.html", `<title>${"a".repeat(300)}</title>`, [], "a".repeat(LIMITS.titleChars)],
  ["plan.md", "# Heading", ["--title", "b".repeat(5000)], "b".repeat(LIMITS.titleChars)],
] as const)("title selection for %s: %s", async (path, content, args, title) => {
  const f = await fixture();
  await f.file(path, content);
  const capture = await f.capture();
  const out = await f.publish(path, ...args);
  expect(out.code, out.stderr.join("")).toBe(0);
  expect(capture.requests[0]?.title).toBe(title);
});

test.each([
  [["only.markdown"], "only.markdown"],
  [["a.html", "index.html", "index.md"], "index.html"],
  [["only.htm", "index.md"], "only.htm"],
  [["a.html", "b.html", "index.md", "README.md"], "index.md"],
  [["a.html", "b.html", "README.md", "z.md"], "README.md"],
  [["a.html", "b.html", "z.markdown"], "z.markdown"],
  [["b.md", "a.md"], "a.md"],
] as const)("entry selection from %j", async (paths, main) => {
  const f = await fixture();
  for (const path of paths) await f.file(`bundle/${path}`);
  const capture = await f.capture();
  const out = await f.publish("bundle");
  expect(out.code, out.stderr.join("")).toBe(0);
  expect(capture.requests[0]?.main).toBe(main);
});

test.each(["details.md", "bundle/details.md"])("--main %s selects a bundled doc and its title", async (main) => {
  const f = await fixture();
  await f.file("bundle/index.html", "<title>Index</title>");
  await f.file("bundle/details.md", "# Details");
  const capture = await f.capture();
  const out = await f.publish("bundle", "--main", main);
  expect(out.code, out.stderr.join("")).toBe(0);
  expect(capture.requests[0]).toMatchObject({ main: "details.md", title: "Details" });
});

test.each([
  ["plan.md", "--manifest", "review.json"],
  ["plan.md", "--new", "--key", "named"],
  ["plan.md", "--new", "--review", "00000000-0000-4000-8000-000000000000"],
  ["plan.md", "--title"],
  ["plan.md", "--json", "--json"],
  ["--manifest", "review.json", "--new"],
  ["--unknown"],
])("invalid shortcut arguments fail before any state change: %j", async (...args) => {
  const f = await fixture();
  const out = await f.publish(...args);
  expect(out.code).toBe(1);
  expect(out.stdout).toEqual([]);
  expect(out.stderr).toHaveLength(1);
  await expect(stat(join(f.stateDir, "emend.db"))).rejects.toMatchObject({ code: "ENOENT" });
});

test("a source outside doc roots keeps the existing refusal and creates no state", async () => {
  const f = await fixture();
  const source = join(f.dir, "outside.md");
  await writeFile(source, "# Synthetic outside");
  const out = await f.publish(source);
  expect(out.code).toBe(1);
  expect(out.stdout).toEqual([]);
  expect(out.stderr).toEqual(["emend: source is outside the allowed doc roots\n"]);
  await expect(stat(join(f.stateDir, "emend.db"))).rejects.toMatchObject({ code: "ENOENT" });
});

test.each(["file", "folder"])(
  "a %s symlink leaving a bundle is refused even within an allowed doc root",
  async (kind) => {
    const f = await fixture();
    await f.file("bundle/plan.md");
    const target = await f.file("outside/other.md");
    await symlink(
      kind === "file" ? target : join(f.source, "outside"),
      join(f.source, "bundle", kind === "file" ? "escape.md" : "escape"),
    );
    const out = await f.publish("bundle");
    expect(out.code).toBe(1);
    expect(out.stdout).toEqual([]);
    expect(out.stderr.join("")).toContain("symlink leaves the published folder");
    await expect(stat(join(f.stateDir, "emend.db"))).rejects.toMatchObject({ code: "ENOENT" });
  },
);

test("a symlinked leading folder retains the existing refusal", async () => {
  const f = await fixture();
  await f.file("real/plan.md");
  await symlink(join(f.source, "real"), join(f.source, "alias"));
  const out = await f.publish("alias/plan.md");
  expect(out.code).toBe(1);
  expect(out.stderr).toEqual(["emend: source is behind a symlink or non-folder\n"]);
});

test("a sparse 2 GiB doc is refused without opening or reading it", async () => {
  const f = await fixture();
  const source = await f.file("huge.md", "");
  await truncate(source, 2 * 1024 ** 3);
  const open = vi.fn(fs.open);
  const read = sourceReads.readRegular;
  const checkedRead = vi
    .spyOn(sourceReads, "readRegular")
    .mockImplementation((file, limit, roots, fileSystem, gitDirs, check) =>
      read(file, limit, roots, fileSystem ?? { ...fs, open, platform: process.platform }, gitDirs, check),
    );
  const result = await f.publish("huge.md");
  expect(result.code).toBe(1);
  expect(result.stdout).toEqual([]);
  expect(result.stderr).toEqual(["emend: file exceeds its size limit: huge.md\n"]);
  expect(checkedRead.mock.calls.some(([path]) => path === source)).toBe(true);
  expect(open.mock.calls.filter(([path]) => path === source)).toEqual([]);
});

test("size limits and invalid main selections fail before creating state", async () => {
  const f = await fixture();
  const source = await f.file("plan.md");
  await truncate(source, LIMITS.markdownDocBytes + 1);
  const large = await f.publish("plan.md");
  expect(large.code).toBe(1);
  expect(large.stdout).toEqual([]);
  expect(large.stderr).toEqual(["emend: file exceeds its size limit: plan.md\n"]);
  await f.file("plan.md");
  await f.file("other.md");
  const main = await f.publish("plan.md", "--main", "other.md");
  expect(main.code).toBe(1);
  expect(main.stdout).toEqual([]);
  expect(main.stderr).toEqual(["emend: --main must name a published doc\n"]);
  await expect(stat(join(f.stateDir, "emend.db"))).rejects.toMatchObject({ code: "ENOENT" });
});

test("-- permits a filename beginning with a dash", async () => {
  const f = await fixture();
  await f.file("--plan.md");
  const capture = await f.capture();
  const out = await f.publish("--", "--plan.md");
  expect(out.code, out.stderr.join("")).toBe(0);
  expect(capture.requests[0]?.main).toBe("--plan.md");
});

test("git metadata is refused and worktree sources need no configured doc root", async () => {
  const f = await fixture();
  vi.restoreAllMocks();
  workInThread(executors);
  vi.spyOn(process, "cwd").mockReturnValue(f.source);
  await promisify(execFile)("git", ["-c", "init.templateDir=", "init", f.source], {
    env: { PATH: process.env.PATH, HOME: f.source, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" },
  });
  await writeFile(join(f.stateDir, "config.json"), JSON.stringify({ docRoots: [] }));
  await f.file("plan.md");
  await f.file(".git/hidden.md");
  const capture = await f.capture();
  const ok = await f.publish("plan.md");
  expect(ok.code, ok.stderr.join("")).toBe(0);
  const refused = await f.publish(".git/hidden.md");
  expect(refused.code).toBe(1);
  expect(refused.stdout).toEqual([]);
  expect(refused.stderr.join("")).toContain("refusing to read inside the git folder");
  expect(capture.requests).toHaveLength(1);
});

test("the manifest form still prints the result JSON", async () => {
  const f = await fixture();
  await f.file("plan.md");
  const manifest = await f.file(
    "review.json",
    JSON.stringify({
      version: 1,
      title: "Manifest",
      topics: [],
      files: [{ path: "plan.md", role: "doc" }],
      writeup: { overview: "", tldr: "", decisions: null, topics: {} },
    }),
  );
  const out = await f.publish("--manifest", manifest, "--key", "manifest");
  expect(out.code, out.stderr.join("")).toBe(0);
  expect(PublishResponse.safeParse(JSON.parse(out.stdout.join(""))).success).toBe(true);
});

test("a closed stdout produces one diagnostic for URL output", async () => {
  const f = await fixture();
  await f.file("plan.md");
  await f.capture();
  const out = f.output();
  out.io.stdoutAsync = async () => {
    throw new Error("closed");
  };
  expect(await run(["publish", "plan.md"], out.io)).toBe(1);
  expect(out.stdout).toEqual([]);
  expect(out.stderr).toEqual(["emend: Could not write to stdout.\n"]);
});

test("an attached unavailable hub never falls back to a local publication", async () => {
  const f = await fixture();
  await f.file("plan.md");
  await f.capture("hub");
  vi.stubGlobal("fetch", async () => {
    throw new Error("synthetic unavailable");
  });
  const out = await f.publish("plan.md");
  expect(out.code).toBe(1);
  expect(out.stdout).toEqual([]);
  expect(out.stderr.join("")).toContain("cannot reach the hub");
  await expect(stat(join(f.stateDir, "emend.db"))).rejects.toMatchObject({ code: "ENOENT" });
});

test("an explicit title does not read the main doc during shortcut preparation", async () => {
  const f = await fixture();
  const source = await f.file("plan.md");
  const context = await publishContext(f.source, f.stateDir);
  const read = vi.spyOn(sourceReads, "readRegular");
  const shortcut = await shortcutManifest({ paths: [source], title: "Explicit" }, f.stateDir, f.source, context);
  expect(shortcut.manifest.title).toBe("Explicit");
  expect(read.mock.calls.filter(([file]) => file === source)).toHaveLength(0);
});

test("title inference reuses the resolver read, with only the upload recheck reading again", async () => {
  const f = await fixture();
  const source = await f.file("plan.md", "# Inferred");
  const capture = await f.capture();
  const read = vi.spyOn(sourceReads, "readRegular");
  const out = await f.publish(source);
  expect(out.code, out.stderr.join("")).toBe(0);
  expect(capture.requests[0]?.title).toBe("Inferred");
  expect(read.mock.calls.filter(([file]) => file === source)).toHaveLength(2);
});

test.each([
  ["\u0001A\tB\u007f\u009b\u200e\u200f\u202a\u202e\u2066\u2069", "A B"],
  ["\u0001\u009b\u202e", "Inferred"],
  ["   ", "Inferred"],
  ["", "Inferred"],
])("given titles clean controls and fall back when empty", async (title, expected) => {
  const f = await fixture();
  await f.file("plan.md", "# Inferred");
  const capture = await f.capture();
  const out = await f.publish("plan.md", "--title", title);
  expect(out.code, out.stderr.join("")).toBe(0);
  expect(capture.requests[0]?.title).toBe(expected);
});

test("a hub URL cannot add stdout lines or terminal controls", async () => {
  const f = await fixture();
  await f.file("plan.md");
  const url = "https://hub.example/r/synthetic\n\u001b[31m\u202e";
  await f.capture("hub", url);
  const out = await f.publish("plan.md");
  expect(out.code, out.stderr.join("")).toBe(0);
  expect(out.stdout).toEqual([`${escapeReference(PublishResponse.shape.url.parse(url))}\n`]);
  expect(out.stdout.join("").split("\n")).toHaveLength(2);
});

test("shortcut assets cannot alias node_modules; the manifest form still accepts the same asset", async () => {
  const f = await fixture();
  await f.file("bundle/index.html", '<title>Assets</title><img src="logo.png">');
  const asset = await f.file("bundle/node_modules/pkg/logo.png", "synthetic image");
  await symlink(asset, join(f.source, "bundle/logo.png"));
  const capture = await f.capture();
  const out = await f.publish("bundle");
  expect(out.code, out.stderr.join("")).toBe(0);
  expect(capture.requests[0]?.files.map((file) => file.path)).toEqual(["index.html"]);
  const manifest = await f.file(
    "review.json",
    JSON.stringify({
      version: 1,
      title: "Manifest",
      topics: [],
      files: [{ path: "index.html", role: "doc", source: "bundle/index.html" }],
      writeup: { overview: "", tldr: "", decisions: null, topics: {} },
    }),
  );
  expect((await f.publish("--manifest", manifest, "--key", "manifest")).code).toBe(0);
  expect(capture.requests[1]?.files.map((file) => file.path)).toEqual(["index.html", "logo.png"]);
});

test("thousands of unrelated files need no per-file metadata and at most 21 warning lines", async () => {
  const f = await fixture();
  await f.file("bundle/index.md");
  for (let batch = 0; batch < 30; batch++)
    await Promise.all(Array.from({ length: 100 }, (_, i) => f.file(`bundle/junk-${batch * 100 + i}.png`, "unused")));
  const realpath = vi.spyOn(fs, "realpath");
  const lstat = vi.spyOn(fs, "lstat");
  await f.capture();
  const out = await f.publish("bundle");
  expect(out.code, out.stderr.join("")).toBe(0);
  const warnings = out.stderr.filter((line) => line.includes("skipped"));
  expect(warnings).toHaveLength(21);
  expect(warnings.at(-1)).toBe("emend: and 2980 more files skipped\n");
  for (const spy of [realpath, lstat])
    expect(spy.mock.calls.filter(([path]) => String(path).includes("junk-"))).toHaveLength(0);
});

test("folder walk errors name only the caller's argument", async () => {
  const f = await fixture();
  await f.file("bundle/index.md");
  const target = await f.file("outside/other.md");
  await symlink(target, join(f.source, "bundle/never-print-this-name.md"));
  const out = await f.publish("bundle");
  expect(out.code).toBe(1);
  expect(out.stdout).toEqual([]);
  expect(out.stderr).toEqual(["emend: symlink leaves the published folder: bundle\n"]);
});

test("a listing exceeding the entry cap stops enumeration and reports only the caller's folder", async () => {
  const f = await fixture();
  await f.file("bundle/index.md");
  await f.file("bundle/unrelated.txt");
  const entry = (await fs.readdir(join(f.source, "bundle"), { withFileTypes: true })).find(
    (entry) => entry.name === "unrelated.txt",
  );
  if (!entry) throw new Error("missing synthetic entry");
  let visited = 0;
  let closed = false;
  vi.spyOn(fs, "opendir").mockResolvedValue({
    async *[Symbol.asyncIterator]() {
      try {
        for (let i = 0; i < SHORTCUT_LIMITS.entries + 100; i++) {
          visited++;
          yield entry;
        }
      } finally {
        closed = true;
      }
    },
  } as unknown as Awaited<ReturnType<typeof fs.opendir>>);
  const out = await f.publish("bundle");
  expect(out.code).toBe(1);
  expect(out.stdout).toEqual([]);
  expect(out.stderr).toEqual([
    `emend: published folder bundle exceeds the ${SHORTCUT_LIMITS.entries}-entry walk limit\n`,
  ]);
  expect(visited).toBe(SHORTCUT_LIMITS.entries + 1);
  expect(closed).toBe(true);
  await expect(stat(join(f.stateDir, "emend.db"))).rejects.toMatchObject({ code: "ENOENT" });
});

// Creating and walking 2,001 real directories exercises the directory cap.
test("a tree exceeding the directory cap is refused before publication", async () => {
  const f = await fixture();
  await f.file("bundle/index.md");
  for (let batch = 0; batch < SHORTCUT_LIMITS.directories; batch += 100)
    await Promise.all(
      Array.from({ length: Math.min(100, SHORTCUT_LIMITS.directories - batch) }, (_, i) =>
        mkdir(join(f.source, "bundle", `sub-${batch + i}`)),
      ),
    );
  const out = await f.publish("bundle");
  expect(out.code).toBe(1);
  expect(out.stdout).toEqual([]);
  expect(out.stderr).toEqual([
    `emend: published folder bundle exceeds the ${SHORTCUT_LIMITS.directories}-directory walk limit\n`,
  ]);
  await expect(stat(join(f.stateDir, "emend.db"))).rejects.toMatchObject({ code: "ENOENT" });
}, 30000);

test.each(["linux", "darwin"] as const)(
  "%s lists the checked descriptor during a swap and restore",
  async (platform) => {
    const f = await fixture();
    await f.file("bundle/index.md");
    const capture = await f.capture();
    const outside = join(f.dir, "outside");
    await mkdir(outside);
    await writeFile(join(outside, "never-expose-this.md"), "synthetic outside content");
    const original = fs.opendir;
    vi.spyOn(process, "platform", "get").mockReturnValue(platform);
    const open = vi.spyOn(fs, "open");
    const list = vi.spyOn(fs, "opendir").mockImplementationOnce(async (path, options) => {
      await fs.rename(join(f.source, "bundle"), join(f.source, "moved"));
      await symlink(outside, join(f.source, "bundle"));
      const directory = await original(path, options);
      await rm(join(f.source, "bundle"));
      await fs.rename(join(f.source, "moved"), join(f.source, "bundle"));
      return directory;
    });
    const out = await f.publish("bundle");
    expect(out.code, out.stderr.join("")).toBe(0);
    expect(capture.requests[0]?.files.map((file) => file.path)).toEqual(["index.md"]);
    expect(out.stderr.join("")).not.toContain("never-expose-this");
    const flags = open.mock.calls.find(([path]) => path === join(f.source, "bundle"))?.[1];
    expect(typeof flags).toBe("number");
    expect(Number(flags) & constants.O_NOFOLLOW).toBe(constants.O_NOFOLLOW);
    expect(Number(flags) & constants.O_DIRECTORY).toBe(constants.O_DIRECTORY);
    expect(String(list.mock.calls[0]?.[0])).toMatch(
      platform === "linux" ? /^\/proc\/self\/fd\/\d+$/ : /^\/dev\/fd\/\d+$/,
    );
  },
);

// Sweeps every code point through escapeReference and cleanDocTitle.
test("title cleaning covers every code point escaped by terminal references", () => {
  const missed: number[] = [];
  for (let code = 0; code <= 0x10ffff; code++) {
    const char = String.fromCodePoint(code);
    if (escapeReference(char) === char) continue;
    const cleaned = cleanDocTitle(`a${char}b`);
    if (cleaned !== "ab" && cleaned !== "a b") missed.push(code);
  }
  expect(missed).toEqual([]);
}, 15000);

test.each(["doc", "asset"] as const)(
  "a %s swapped outside its walked folder before resolution is refused",
  async (kind) => {
    const f = await fixture();
    const path = kind === "doc" ? "plan.md" : "logo.png";
    await f.file("bundle/index.html", '<title>Bundle</title><img src="logo.png">');
    const source = await f.file(`bundle/${path}`);
    const target = await f.file(`private-${path}`, "outside synthetic content");
    const prepare = shortcuts.shortcutManifest;
    vi.spyOn(shortcuts, "shortcutManifest").mockImplementationOnce(async (...args) => {
      const result = await prepare(...args);
      await rm(source);
      await symlink(target, source);
      return result;
    });
    const capture = await f.capture();
    const read = vi.spyOn(sourceReads, "readRegular");
    const out = await f.publish("bundle");
    expect(out.code).toBe(1);
    expect(out.stdout).toEqual([]);
    expect(out.stderr).toEqual(["emend: symlink leaves the published folder: bundle\n"]);
    expect(read.mock.calls.some(([file]) => file === target)).toBe(false);
    expect(capture.requests).toEqual([]);
  },
);

test.each(["doc", "asset"] as const)(
  "a %s swapped before upload uses its rendered-doc or retained-asset policy",
  async (kind) => {
    const f = await fixture();
    const path = kind === "doc" ? "plan.md" : "logo.png";
    if (kind === "asset") await f.file("bundle/index.html", '<title>Bundle</title><img src="logo.png">');
    const source = await f.file(`bundle/${path}`, "synthetic same bytes");
    const target = await f.file(`private-${path}`, "synthetic same bytes");
    const capture = await f.capture();
    const respond = capture.fetcher.getMockImplementation();
    const hash = createHash("sha256").update("synthetic same bytes").digest("hex");
    capture.fetcher.mockImplementation(async (url, init) => {
      if (init?.method === "HEAD" && String(url).endsWith(hash)) {
        await rm(source);
        await symlink(target, source);
      }
      return respond?.(url, init);
    });
    const read = vi.spyOn(sourceReads, "readRegular");
    const out = await f.publish("bundle");
    if (kind === "asset") {
      expect(out.code, out.stderr.join("")).toBe(0);
      expect(read.mock.calls.filter(([path]) => path === source)).toHaveLength(1);
      expect(read.mock.calls.some(([path]) => path === target)).toBe(false);
      const uploaded = capture.fetcher.mock.calls
        .filter(([, init]) => init?.method === "PUT")
        .map(([, init]) => Buffer.from(init?.body as Uint8Array).toString());
      expect(uploaded).toContain("synthetic same bytes");
      return;
    }
    expect(out.code).toBe(1);
    expect(out.stdout).toEqual([]);
    expect(out.stderr).toEqual(["emend: symlink leaves the published folder: bundle\n"]);
    expect(capture.requests).toEqual([]);
  },
);

test("other platforms refuse folders but continue to publish file arguments", async () => {
  const f = await fixture();
  await f.file("bundle/index.md");
  await f.capture();
  vi.spyOn(process, "platform", "get").mockReturnValue("freebsd");
  const list = vi.spyOn(fs, "opendir");
  const out = await f.publish("bundle");
  expect(out.code).toBe(1);
  expect(out.stdout).toEqual([]);
  expect(out.stderr).toEqual(["emend: publishing folders is not supported on this platform yet: bundle\n"]);
  expect(list).not.toHaveBeenCalled();
  expect((await f.publish("bundle/index.md")).code).toBe(0);
});

// Creating and enumerating 10,001 real document files exercises the file cap.
test("a folder exceeding the file limit keeps the real refusal", async () => {
  const f = await fixture();
  for (let start = 0; start <= LIMITS.filesPerRevision; start += 100)
    await Promise.all(
      Array.from({ length: Math.min(100, LIMITS.filesPerRevision + 1 - start) }, (_, i) =>
        f.file(`bundle/doc-${start + i}.md`),
      ),
    );
  const out = await f.publish("bundle");
  expect(out.code).toBe(1);
  expect(out.stdout).toEqual([]);
  expect(out.stderr).toEqual(["emend: too many files in the review\n"]);
}, 30000);

test("dangling symlinks are skipped with capped warnings", async () => {
  const f = await fixture();
  await f.file("bundle/index.md");
  for (let i = 0; i < 25; i++) await symlink("missing.md", join(f.source, "bundle", `dangling-${i}.md`));
  const capture = await f.capture();
  const out = await f.publish("bundle");
  expect(out.code, out.stderr.join("")).toBe(0);
  expect(capture.requests[0]?.files.map((file) => file.path)).toEqual(["index.md"]);
  const warnings = out.stderr.filter((line) => line.includes("skipped"));
  expect(warnings).toHaveLength(21);
  expect(warnings[0]).toContain("dangling-");
  expect(warnings.at(-1)).toBe("emend: and 5 more files skipped\n");
});

test.each([false, true])("a skipped explicit alias names the argument as given (only argument: %s)", async (only) => {
  const f = await fixture();
  await f.file("visible.md");
  const target = await f.file(".hidden.md");
  await symlink(target, join(f.source, "alias.md"));
  await f.capture();
  const out = await f.publish(...(only ? [] : ["visible.md"]), "./alias.md");
  expect(out.code).toBe(only ? 1 : 0);
  const lines = out.stderr.filter((line) => line.includes("skipped"));
  expect(lines).toHaveLength(1);
  expect(lines[0]).toContain("./alias.md");
  expect(out.stderr.join("")).not.toContain(".hidden.md");
});

test("linked HTML docs and their image keep the required uploaded relative layout", async () => {
  const f = await fixture();
  const first = await f.file(
    "site/first.html",
    '<title>First</title><a href="second.html">Next</a><img src="img/logo.png">',
  );
  const second = await f.file(
    "site/second.html",
    '<title>Second</title><a href="first.html">Back</a><img src="img/logo.png">',
  );
  await f.file("site/img/logo.png", "synthetic image");
  const capture = await f.capture();
  const out = await f.publish(second, first);
  expect(out.code, out.stderr.join("")).toBe(0);
  expect(capture.requests[0]?.files.map((file) => file.path)).toEqual(["first.html", "img/logo.png", "second.html"]);
  expect(capture.requests[0]?.files.filter((file) => file.role === "doc").map((file) => file.assets)).toEqual([
    ["img/logo.png"],
    ["img/logo.png"],
  ]);
  const uploaded = capture.fetcher.mock.calls
    .filter(([, init]) => init?.method === "PUT")
    .map(([, init]) => Buffer.from(init?.body as Uint8Array).toString());
  expect(uploaded).toContain('<title>First</title><a href="second.html">Next</a><img src="img/logo.png">');
  expect(uploaded).toContain('<title>Second</title><a href="first.html">Back</a><img src="img/logo.png">');
  expect(uploaded).toContain("synthetic image");
});

test.each([
  ["resolution", false],
  ["resolution", true],
  ["upload", false],
  ["upload", true],
] as const)(
  "shared assets check boundaries at resolution and retain bytes for %s (folder first: %s)",
  async (stage, folderFirst) => {
    const f = await fixture();
    await f.file("a.html", '<title>Explicit</title><img src="bundle/logo.png">');
    await f.file("bundle/index.html", '<title>Walked</title><img src="logo.png">');
    const source = await f.file("bundle/logo.png", "synthetic shared image");
    const target = await f.file("private.png", "synthetic shared image");
    const swap = async () => {
      await rm(source);
      await symlink(target, source);
    };
    const capture = await f.capture();
    if (stage === "resolution") {
      const prepare = shortcuts.shortcutManifest;
      vi.spyOn(shortcuts, "shortcutManifest").mockImplementationOnce(async (...args) => {
        const result = await prepare(...args);
        await swap();
        return result;
      });
    } else {
      const respond = capture.fetcher.getMockImplementation();
      const hash = createHash("sha256").update("synthetic shared image").digest("hex");
      capture.fetcher.mockImplementation(async (url, init) => {
        if (init?.method === "HEAD" && String(url).endsWith(hash)) await swap();
        return respond?.(url, init);
      });
    }
    const read = vi.spyOn(sourceReads, "readRegular");
    const out = await f.publish(...(folderFirst ? ["bundle", "a.html"] : ["a.html", "bundle"]));
    if (stage === "upload") {
      expect(out.code, out.stderr.join("")).toBe(0);
      expect(read.mock.calls.filter(([path]) => path === source)).toHaveLength(1);
      expect(read.mock.calls.some(([path]) => path === target)).toBe(false);
      const uploaded = capture.fetcher.mock.calls
        .filter(([, init]) => init?.method === "PUT")
        .map(([, init]) => Buffer.from(init?.body as Uint8Array).toString());
      expect(uploaded).toContain("synthetic shared image");
      return;
    }
    expect(out.code).toBe(1);
    expect(out.stdout).toEqual([]);
    expect(out.stderr).toEqual(["emend: symlink leaves the published folder: bundle\n"]);
    expect(capture.requests).toEqual([]);
  },
);

test("shared explicit assets retain every referencing doc's folder at upload", async () => {
  const f = await fixture();
  await f.file("a.html", '<title>Outer</title><img src="bundle/logo.png">');
  await f.file("bundle/index.html", '<title>Inner</title><img src="logo.png">');
  const source = await f.file("bundle/logo.png", "synthetic shared image");
  const target = await f.file("private.png", "synthetic shared image");
  const capture = await f.capture();
  const respond = capture.fetcher.getMockImplementation();
  const hash = createHash("sha256").update("synthetic shared image").digest("hex");
  capture.fetcher.mockImplementation(async (url, init) => {
    if (init?.method === "HEAD" && String(url).endsWith(hash)) {
      await rm(source);
      await symlink(target, source);
    }
    return respond?.(url, init);
  });
  const out = await f.publish("a.html", "bundle/index.html");
  expect(out.code).toBe(1);
  expect(out.stdout).toEqual([]);
  expect(out.stderr).toEqual(["emend: source is outside the allowed doc roots\n"]);
  expect(capture.requests).toEqual([]);
});

test("blob deduplication keeps scoped assets retained and other assets on their read path", async () => {
  const f = await fixture();
  await f.file("a.html", '<title>Explicit</title><img src="first.png">');
  await f.file("bundle/index.html", '<title>Walked</title><img src="logo.png">');
  const target = await f.file("first.png", "synthetic shared image");
  const source = await f.file("bundle/logo.png", "synthetic shared image");
  const capture = await f.capture();
  const respond = capture.fetcher.getMockImplementation();
  const hash = createHash("sha256").update("synthetic shared image").digest("hex");
  capture.fetcher.mockImplementation(async (url, init) => {
    if (init?.method === "HEAD" && String(url).endsWith(hash)) {
      await rm(source);
      await symlink(target, source);
    }
    return respond?.(url, init);
  });
  const read = vi.spyOn(sourceReads, "readRegular");
  const out = await f.publish("a.html", "bundle");
  expect(out.code, out.stderr.join("")).toBe(0);
  expect(read.mock.calls.filter(([path]) => path === source)).toHaveLength(1);
  expect(read.mock.calls.filter(([path]) => path === target)).toHaveLength(2);
  const uploaded = capture.fetcher.mock.calls
    .filter(([, init]) => init?.method === "PUT")
    .map(([, init]) => Buffer.from(init?.body as Uint8Array).toString());
  expect(uploaded.filter((text) => text === "synthetic shared image")).toHaveLength(1);
});

test("a shared asset changed after its resolution read uploads the retained bytes", async () => {
  const f = await fixture();
  await f.file("a.html", '<title>Explicit</title><img src="bundle/logo.png">');
  await f.file("bundle/index.html", '<title>Walked</title><img src="logo.png">');
  const source = await f.file("bundle/logo.png", "synthetic original image");
  const read = sourceReads.readRegular;
  let changed = false;
  let assetReads = 0;
  vi.spyOn(sourceReads, "readRegular").mockImplementation(async (...args) => {
    const bytes = await read(...args);
    if (args[0] === source) assetReads++;
    if (args[0] === source && !changed) {
      changed = true;
      await writeFile(source, "synthetic replacement image");
    }
    return bytes;
  });
  const capture = await f.capture();
  const out = await f.publish("a.html", "bundle");
  expect(changed).toBe(true);
  expect(out.code, out.stderr.join("")).toBe(0);
  expect(assetReads).toBe(1);
  const uploaded = capture.fetcher.mock.calls
    .filter(([, init]) => init?.method === "PUT")
    .map(([, init]) => Buffer.from(init?.body as Uint8Array).toString());
  expect(uploaded).toContain("synthetic original image");
  expect(uploaded).not.toContain("synthetic replacement image");
});

test.each(["resolution", "upload"] as const)(
  "an asset referenced only by an explicit doc accepts an in-folder symlink at %s",
  async (stage) => {
    const f = await fixture();
    await f.file("a.html", '<title>Explicit</title><img src="bundle/logo.png">');
    const source = await f.file("bundle/logo.png", "synthetic shared image");
    const target = await f.file("real.png", "synthetic shared image");
    const swap = async () => {
      await rm(source);
      await symlink(target, source);
    };
    const capture = await f.capture();
    if (stage === "resolution") await swap();
    else {
      const respond = capture.fetcher.getMockImplementation();
      const hash = createHash("sha256").update("synthetic shared image").digest("hex");
      capture.fetcher.mockImplementation(async (url, init) => {
        if (init?.method === "HEAD" && String(url).endsWith(hash)) await swap();
        return respond?.(url, init);
      });
    }
    const out = await f.publish("a.html");
    expect(out.code, out.stderr.join("")).toBe(0);
    expect(capture.requests[0]?.files.map((file) => file.path)).toEqual(["a.html", "bundle/logo.png"]);
    const hash = createHash("sha256").update("synthetic shared image").digest("hex");
    const upload = capture.fetcher.mock.calls.find(
      ([url, init]) => init?.method === "PUT" && String(url).endsWith(hash),
    );
    expect(Buffer.from(upload?.[1]?.body as Uint8Array).toString()).toBe("synthetic shared image");
  },
);

test("folder and file-alias arguments publish the same regular source in both orders", async () => {
  const f = await fixture();
  const source = await f.file("bundle/plan.md", "# Walked plan\n");
  await symlink(source, join(f.source, "alias.md"));
  const capture = await f.capture();
  for (const args of [
    ["bundle", "alias.md"],
    ["alias.md", "bundle"],
  ]) {
    const out = await f.publish(...args);
    expect(out.code, out.stderr.join("")).toBe(0);
    expect(out.stdout).toEqual([`${capture.url}\n`]);
  }
  expect(capture.requests).toHaveLength(2);
  expect(capture.requests[0]).toEqual(capture.requests[1]);
  expect(capture.requests[0]?.files.map((file) => file.path)).toEqual(["plan.md"]);
  expect(capture.requests[0]?.title).toBe("Walked plan");
});

test("an explicit HTML alias uses the target folder for its image", async () => {
  const f = await fixture();
  await f.file("a.html", "<title>Root</title>");
  const target = await f.file("other/x.html", '<title>Target</title><img src="img/logo.png">');
  await f.file("img/logo.png", "synthetic wrong image");
  await f.file("other/img/logo.png", "synthetic target image");
  await symlink(target, join(f.source, "alias.html"));
  const capture = await f.capture();
  const out = await f.publish("a.html", "alias.html");
  expect(out.code, out.stderr.join("")).toBe(0);
  expect(capture.requests[0]?.files.map((file) => file.path)).toEqual(["a.html", "other/x.html", "other/img/logo.png"]);
  const uploaded = capture.fetcher.mock.calls
    .filter(([, init]) => init?.method === "PUT")
    .map(([, init]) => Buffer.from(init?.body as Uint8Array).toString());
  expect(uploaded).toContain("synthetic target image");
  expect(uploaded).not.toContain("synthetic wrong image");
});

test.each([".env", ".hidden/logo.png", "control-\u0001.png"])(
  "a post-preflight asset alias to %j is refused before its bytes are read",
  async (hidden) => {
    const f = await fixture();
    await f.file("a.html", '<title>Explicit</title><img src="logo.png">');
    const safe = await f.file("img/logo.png", "synthetic visible image");
    const target = await f.file(hidden, "synthetic forbidden image");
    const alias = join(f.source, "logo.png");
    await symlink(safe, alias);
    const originalStat = fs.stat;
    let swapped = false;
    vi.spyOn(fs, "stat").mockImplementation(async (...args) => {
      const info = await originalStat(...args);
      if (String(args[0]) === safe && !swapped) {
        swapped = true;
        await rm(alias);
        await symlink(target, alias);
      }
      return info;
    });
    const read = vi.spyOn(sourceReads, "readRegular");
    const capture = await f.capture();
    const out = await f.publish("a.html");
    expect(swapped).toBe(true);
    expect(out.code).toBe(1);
    expect(out.stdout).toEqual([]);
    expect(out.stderr).toEqual(["emend: target leaves the visible doc folder\n"]);
    expect(read.mock.calls.some(([path]) => path === target)).toBe(false);
    expect(capture.fetcher.mock.calls.some(([, init]) => init?.method === "PUT")).toBe(false);
    expect(capture.requests).toEqual([]);
  },
);

test("the opened-file callback refuses a hidden real path before content reads", async () => {
  const f = await fixture();
  await f.file("a.html", '<title>Explicit</title><img src="logo.png">');
  const source = await f.file("logo.png", "synthetic visible image");
  const target = await f.file(".env", "synthetic forbidden image");
  const original = sourceReads.readRegular;
  const originalOpen = fs.open;
  let hiddenBytesRead = 0;
  let injected = false;
  vi.spyOn(sourceReads, "readRegular").mockImplementation(async (...args) => {
    if (args[0] !== source) return original(...args);
    injected = true;
    // Inject a changed real path at the checked-read boundary; retain the real opened-file callback.
    const fileSystem = {
      ...fs,
      platform: process.platform,
      open: async (...openArgs: Parameters<typeof fs.open>) => {
        const handle = await originalOpen(...openArgs);
        const read = handle.read.bind(handle);
        vi.spyOn(handle, "read").mockImplementation(async (...readArgs: Parameters<typeof handle.read>) => {
          const result = await read(...readArgs);
          hiddenBytesRead += result.bytesRead;
          return result;
        });
        return handle;
      },
    };
    return original(target, args[1], args[2], fileSystem, args[4], args[5]);
  });
  const capture = await f.capture();
  const out = await f.publish("a.html");
  expect(injected).toBe(true);
  expect(out.code).toBe(1);
  expect(out.stderr).toEqual(["emend: target leaves the visible doc folder\n"]);
  expect(hiddenBytesRead).toBe(0);
  expect(capture.fetcher.mock.calls.some(([, init]) => init?.method === "PUT")).toBe(false);
  expect(capture.requests).toEqual([]);
});

const secretNameGroups = [
  [
    "deploy_key",
    "ssh_host_ed25519_key",
    "github_rsa",
    "wg0.conf",
    "keystore.properties",
    "local.settings.json",
    "auth.json",
    "token.txt",
    "api_key.txt",
    "apiKeys.json",
    "access_token",
    "session.har",
    "cookies.txt",
    "my.cnf",
    "rclone.conf",
  ],
  ["AUTH-TOKENS.json", "refresh token.txt", "tokens.txt", "github_dsa", "github_ecdsa", "github_ed25519", "wg.conf"],
  ["github-token.txt", "bot_token.txt", "slack token", "slack-token", "github_tokens", "token", "github.token"],
  ["prod.slack_token", "ci.github-token", "staging.deploy-token", "my.app_tokens"],
  "pem key p12 pfx p8 jks keystore bks ppk der keytab kdbx".split(" ").map((ext) => `private.${ext}`),
  "gpg pgp asc ovpn tfvars tfstate kubeconfig env secret secrets".split(" ").map((ext) => `private.${ext}`),
  [
    "id_rsa",
    "ID_Ed25519-Backup",
    "identity",
    "master.key",
    "htpasswd",
    "_netrc",
    "_pgpass",
    "pgpass.conf",
    "kubeconfig",
  ],
  ["secret", "secrets", "Secrets.local.json", "app_secret.yaml", "app-Secrets-backup", "my.secret.config"],
  ["passwd", "PASSWORD", "db_passwd.txt", "db.password.json", "old-PASSWORD-backup"],
  ["privatekey", "PRIVATE-KEY", "private_key", "app.privatekey.json", "my-Private_Key-backup"],
  ["token.json", "TOKEN.JSON", "firebase-adminsdk.json", "app-firebase-adminsdk-backup.JSON"],
  ["credential", "credentials", "my_credentials.json", "my-credential-backup", "my.credential.json"],
  ["client_secret.json", "CLIENT_SECRET-backup.JSON"],
  ["serviceaccount.json", "service_account-dev.json", "SERVICE-ACCOUNT.JSON"],
  ["user_accessKeys.CSV", "terraform.tfstate.backup", "local.TFVARS.JSON"],
  [
    "passwords.txt",
    "Chrome Passwords.csv",
    "password1.txt",
    "db password.txt",
    "AWS credentials.txt",
    "my secrets.yaml",
    "secret2.json",
    "private_keys.txt",
    "privatekeys.txt",
    "private keys.txt",
    "private key.txt",
    "passwds.txt",
    "1password.txt",
    "1credential2.txt",
    "1secret2.txt",
    "1private-key2.txt",
    "backup(password).txt",
  ],
];
test.each(secretNameGroups.map((names) => [names]))(
  "walk skips secret names before filesystem access: %j",
  async (names) => {
    const f = await fixture();
    await f.file("bundle/readme.txt", "Synthetic public text");
    for (const name of names) await f.file(`bundle/${name}`, "Synthetic credential placeholder");
    const capture = await f.capture();
    const realpath = vi.spyOn(fs, "realpath");
    const lstat = vi.spyOn(fs, "lstat");
    const open = vi.spyOn(fs, "open");
    for (const flags of [[], ["--source"]]) {
      const out = await f.publish("bundle", ...flags);
      expect(out.code, out.stderr.join("")).toBe(0);
      expect(out.stderr.filter((line) => line.includes("skipped"))).toEqual(
        [...names].sort().map((name) => `emend: skipped ${name}: may hold a secret\n`),
      );
      expect(capture.requests.at(-1)?.files.map((file) => file.path)).toEqual(["readme.txt"]);
    }
    const secretPaths = new Set(names.map((name) => join(f.source, "bundle", name)));
    for (const spy of [realpath, lstat, open])
      expect(spy.mock.calls.some(([path]) => secretPaths.has(String(path)))).toBe(false);
  },
);

test("rendered doc names are exempt from secret skips, with and without source", async () => {
  const f = await fixture();
  const names = [
    "api_keys.md",
    "auth.md",
    "secret.MD",
    "credentials.markdown",
    "client_secret.HTML",
    "id_rsa.HTM",
    "password.md",
    "private-key.html",
    "Chrome Passwords.MARKDOWN",
    "private keys.HTM",
    "secret2.md",
    "AWS credentials.html",
    "github-token.md",
    "bot_token.markdown",
    "slack-token.html",
    "token.htm",
  ];
  for (const name of names) await f.file(`bundle/${name}`, "Synthetic text");
  const capture = await f.capture();
  for (const flags of [[], ["--source"]]) {
    const out = await f.publish("bundle", ...flags, "--title", "Synthetic");
    expect(out.code, out.stderr.join("")).toBe(0);
    expect(out.stderr.filter((line) => line.includes("skipped"))).toEqual([]);
    expect(
      capture.requests
        .at(-1)
        ?.files.map((file) => file.path)
        .sort(),
    ).toEqual(names.sort());
  }
});

test("dotted token names are skipped while JSON design token files publish", async () => {
  const f = await fixture();
  for (const name of ["tokens.json", "design-tokens.json", "colors.tokens"]) await f.file(`bundle/${name}`, "{}");
  const capture = await f.capture();
  const out = await f.publish("bundle");
  expect(out.code, out.stderr.join("")).toBe(0);
  expect(out.stderr.filter((line) => line.includes("skipped"))).toEqual([
    "emend: skipped colors.tokens: may hold a secret\n",
  ]);
  expect(capture.requests[0]?.files.map((file) => file.path)).toEqual(["design-tokens.json", "tokens.json"]);
});

test.each([
  ["OpenSSH", syntheticPrivateKey()],
  ["PEM", syntheticPrivateKey("PRIVATE KEY")],
  ["PuTTY", `PuTTY-User-Key-File-3: ssh-ed25519\n${"A".repeat(64)}\n`],
  ["RSA", syntheticPrivateKey("RSA PRIVATE KEY")],
  ["PGP", syntheticPrivateKey("PGP PRIVATE KEY BLOCK")],
  ["age", `AGE-SECRET-KEY-1${"Q".repeat(58)}`],
  ["SSH2", `---- BEGIN SSH2 ENCRYPTED PRIVATE KEY ----\n${"A".repeat(64)}\n---- END SSH2 ENCRYPTED PRIVATE KEY ----`],
  ["JSON service account", JSON.stringify({ private_key: syntheticPrivateKey("PRIVATE KEY") })],
  [
    "PGP armor headers",
    `-----BEGIN PGP PRIVATE KEY BLOCK-----\nVersion: Synthetic fixture\n\n${"A".repeat(64)}\n-----END PGP PRIVATE KEY BLOCK-----`, // check-public: allow
  ],
  ["indented PEM", `  ${syntheticPrivateKey().replaceAll("\n", "\n  ")}`],
  ["YAML block scalar", `key: |\n  ${syntheticPrivateKey().replaceAll("\n", "\n  ")}`],
  ["Terraform heredoc", `key = <<-EOT\n    ${syntheticPrivateKey().replaceAll("\n", "\n    ")}EOT\n`],
  ["Ruby heredoc", `key = <<~KEY\n    ${syntheticPrivateKey().replaceAll("\n", "\n    ")}KEY\n`],
  ["Python indentation", `key = """\n    ${syntheticPrivateKey().replaceAll("\n", "\n    ")}"""\n`],
  ["XML indentation", `<key>\n    ${syntheticPrivateKey().replaceAll("\n", "\n    ")}</key>\n`],
  [
    "JS string array",
    `const key = ${JSON.stringify(syntheticPrivateKey().trimEnd().split("\n"), null, 2)}.join("\\n");`,
  ],
  [
    "JS concatenated strings",
    `const key = ${syntheticPrivateKey()
      .split("\n")
      .map((line) => JSON.stringify(line))
      .join(" +\n")};`,
  ],
  ["flattened PEM", syntheticPrivateKey().replaceAll("\n", " ")],
  [
    "PGP long Comment header",
    `-----BEGIN PGP PRIVATE KEY BLOCK-----\nComment: ${"synthetic ".repeat(200)}\n\n${"A".repeat(64)}\n-----END PGP PRIVATE KEY BLOCK-----`, // check-public: allow
  ],
  [
    "PuTTY in JSON",
    JSON.stringify({ key: `PuTTY-User-Key-File-3: ssh-ed25519\nPrivate-Lines: 1\n${"A".repeat(64)}\n` }),
  ],
])("walk skips %s key material, but an explicit file publishes", async (_kind, text) => {
  const f = await fixture();
  const name = "notes.txt";
  await f.file(`bundle/${name}`, `Synthetic fixture\n${text}`);
  await f.file("bundle/readme.txt", "Synthetic public text");
  const capture = await f.capture();
  const walked = await f.publish("bundle");
  expect(walked.code, walked.stderr.join("")).toBe(0);
  expect(capture.requests.at(-1)?.files.map((file) => file.path)).toEqual(["readme.txt"]);
  expect(walked.stderr.filter((line) => line.includes("skipped"))).toEqual([
    `emend: skipped ${escapeReference(name)}: may hold a secret\n`,
  ]);
  for (const paths of [[`bundle/${name}`], ["bundle", `bundle/${name}`], [`bundle/${name}`, "bundle"]]) {
    const explicit = await f.publish(...paths);
    expect(explicit.code, explicit.stderr.join("")).toBe(0);
    expect(capture.requests.at(-1)?.files.map((file) => file.path)).toContain(name);
    expect(explicit.stderr.filter((line) => line.includes("skipped"))).toEqual([]);
  }
});

test.each([
  ["age-prefix.ts", 'export const AGE_PREFIX = "AGE-SECRET-KEY-1";\n'],
  [
    "pem-header.ts",
    'const header = "-----BEGIN PRIVATE KEY-----";\nexport function headerText() {\n  return header;\n}\n', // check-public: allow
  ],
  ["putty-marker.ts", 'const marker = "PuTTY-User-Key-File-3: ssh-ed25519";\n'],
  ["putty-template.ts", "const marker = `\nPuTTY-User-Key-File-3: ssh-ed25519\n`;\n"],
  ["pgp-prose.txt", "Look for -----BEGIN PGP PRIVATE KEY BLOCK----- in an armored key.\nThis is ordinary prose.\n"], // check-public: allow
])("a private-key marker in %s is skipped even without material", async (name, text) => {
  const f = await fixture();
  await f.file(`bundle/${name}`, text);
  await f.file("bundle/readme.txt", "Synthetic public text");
  const capture = await f.capture();
  const out = await f.publish("bundle");
  expect(out.code, out.stderr.join("")).toBe(0);
  expect(capture.requests[0]?.files.map((file) => file.path)).toEqual(["readme.txt"]);
  expect(out.stderr.filter((line) => line.includes("skipped"))).toEqual([
    `emend: skipped ${name}: may hold a secret\n`,
  ]);
});

test("a UTF-16LE key is excluded as both a walked doc and an HTML asset", async () => {
  const f = await fixture();
  const html = '<title>Synthetic</title><script src="notes.js"></script>';
  await f.file("bundle/index.html", html);
  await f.file("bundle/notes.js", Buffer.from(syntheticPrivateKey(), "utf16le"));
  const capture = await f.capture();
  const out = await f.publish("bundle");
  expect(out.code, out.stderr.join("")).toBe(0);
  expect(capture.requests[0]?.files).toEqual([
    expect.objectContaining({ path: "index.html", role: "doc", assets: [] }),
  ]);
  expect(out.stderr).toContain("emend: skipped notes.js: may hold a secret\n");
  const uploaded = capture.fetcher.mock.calls
    .filter(([, init]) => init?.method === "PUT")
    .map(([, init]) => Buffer.from(init?.body as Uint8Array).toString());
  expect(uploaded).toEqual([html]);
});

test.each(["md", "markdown", "html", "htm"])("rendered walked %s docs remain unscanned", async (extension) => {
  const f = await fixture();
  const text = syntheticPrivateKey();
  await f.file(`bundle/notes.${extension}`, text);
  const capture = await f.capture();
  const out = await f.publish("bundle");
  expect(out.code, out.stderr.join("")).toBe(0);
  expect(capture.requests[0]?.files.map((file) => file.path)).toEqual([`notes.${extension}`]);
  expect(out.stderr.filter((line) => line.includes("skipped"))).toEqual([]);
  const uploaded = capture.fetcher.mock.calls
    .filter(([, init]) => init?.method === "PUT")
    .map(([, init]) => Buffer.from(init?.body as Uint8Array).toString());
  expect(uploaded).toEqual([text]);
});

test.each([["txt"], ["md", "--source"], ["html", "--source"]])(
  "a walked source %s uploads its one scanned read after replacement",
  async (extension, option?: string) => {
    const f = await fixture();
    const text = "Synthetic public text";
    const source = await f.file(`bundle/notes.${extension}`, text);
    const read = sourceReads.readRegular;
    let sourceReadsCount = 0;
    vi.spyOn(sourceReads, "readRegular").mockImplementation(async (...args) => {
      const bytes = await read(...args);
      if (args[0] === source && ++sourceReadsCount === 1) await writeFile(source, syntheticPrivateKey());
      return bytes;
    });
    const capture = await f.capture();
    const out = await f.publish("bundle", ...(option ? [option] : []));
    expect(out.code, out.stderr.join("")).toBe(0);
    expect(sourceReadsCount).toBe(1);
    const uploaded = capture.fetcher.mock.calls
      .filter(([, init]) => init?.method === "PUT")
      .map(([, init]) => Buffer.from(init?.body as Uint8Array).toString());
    expect(uploaded).toEqual([text]);
  },
);

test("a walked source doc referenced as an asset shares its one scanned buffer", async () => {
  const f = await fixture();
  const original = "const synthetic = true;";
  const source = await f.file("bundle/app.js", original);
  await f.file("bundle/index.html", '<title>Synthetic</title><script src="app.js"></script>');
  const read = sourceReads.readRegular;
  let reads = 0;
  vi.spyOn(sourceReads, "readRegular").mockImplementation(async (...args) => {
    const bytes = await read(...args);
    if (args[0] === source && ++reads === 1) await writeFile(source, syntheticPrivateKey());
    return bytes;
  });
  const capture = await f.capture();
  const out = await f.publish("bundle");
  expect(out.code, out.stderr.join("")).toBe(0);
  expect(reads).toBe(1);
  const uploaded = capture.fetcher.mock.calls
    .filter(([, init]) => init?.method === "PUT")
    .map(([, init]) => Buffer.from(init?.body as Uint8Array).toString());
  expect(uploaded).toContain(original);
  expect(uploaded.some((text) => text.includes(syntheticPrivateKey()))).toBe(false);
});

test.each(["notes.js", "alias.js"])("a walked private key is never uploaded as the HTML asset %s", async (ref) => {
  const f = await fixture();
  const html = `<title>Synthetic</title><script src="${ref}"></script>`;
  await f.file("bundle/index.html", html);
  const secret = await f.file("bundle/notes.js", syntheticPrivateKey());
  if (ref !== "notes.js") await symlink(secret, join(f.source, "bundle", ref));
  const capture = await f.capture();
  const out = await f.publish("bundle");
  expect(out.code, out.stderr.join("")).toBe(0);
  expect(capture.requests[0]?.files.map((file) => [file.path, file.role, file.assets])).toEqual([
    ["index.html", "doc", []],
  ]);
  const uploads = capture.fetcher.mock.calls.filter(([, init]) => init?.method === "PUT");
  expect(uploads).toHaveLength(1);
  expect(Buffer.from(uploads[0]?.[1]?.body as Uint8Array).toString()).toBe(html);
  expect(out.stderr).toContain("emend: skipped notes.js: may hold a secret\n");
});

test("folder assets cannot bypass private-key skips from names, folders, size or encoding", async () => {
  const f = await fixture();
  const key = syntheticPrivateKey();
  const rejected = ["notes.js", "secrets.js", "credentials/app.js", "big.js", "latin.js"];
  const accepted = ["api-key.js", "password.css"];
  const html = `<title>Synthetic</title>${[...rejected, ...accepted]
    .map((name) => `<script src="${name}"></script>`)
    .join("")}`;
  await f.file("bundle/index.html", html);
  for (const name of rejected.slice(0, 3)) await f.file(`bundle/${name}`, key);
  await f.file("bundle/big.js", key.padEnd(1.5 * 1024 * 1024, " "));
  await f.file("bundle/latin.js", Buffer.concat([Buffer.from(key), Buffer.from([0xa9])]));
  await f.file("bundle/api-key.js", "const synthetic = true;");
  await f.file("bundle/password.css", "body { color: blue; }");
  const read = vi.spyOn(sourceReads, "readRegular");
  const capture = await f.capture();
  const out = await f.publish("bundle");
  expect(out.code, out.stderr.join("")).toBe(0);
  expect(capture.requests[0]?.files.map((file) => [file.path, file.role])).toEqual([
    ["index.html", "doc"],
    ...accepted.map((name) => [name, "asset"]),
  ]);
  expect(capture.requests[0]?.files[0]?.assets).toEqual(accepted);
  const uploads = capture.fetcher.mock.calls.filter(([, init]) => init?.method === "PUT");
  expect(uploads).toHaveLength(3);
  for (const [, init] of uploads) expect(Buffer.from(init?.body as Uint8Array).includes(Buffer.from(key))).toBe(false);
  for (const name of rejected) expect(out.stderr).toContain(`emend: skipped ${name}: may hold a secret\n`);
  for (const name of ["index.html", ...accepted]) expect(out.stderr.join("")).not.toContain(`skipped ${name}:`);
  expect(out.stderr.filter((line) => line.includes("skipped notes.js:"))).toHaveLength(1);
  expect(read.mock.calls.filter(([path]) => path === join(f.source, "bundle/notes.js"))).toHaveLength(1);
  expect(read.mock.calls.some(([path]) => path === join(f.source, "bundle/credentials/app.js"))).toBe(false);
});

test.each(["alias.js", "big-key.js"])(
  "a named HTML outside a folder cannot upload its private-key asset bundle/%s",
  async (ref) => {
    const f = await fixture();
    const key = syntheticPrivateKey();
    const html = `<title>Synthetic</title><script src="bundle/${ref}"></script>`;
    await f.file("index.html", html);
    if (ref === "alias.js") {
      const target = await f.file("bundle/key.js", key);
      await symlink(target, join(f.source, "bundle/alias.js"));
    } else await f.file("bundle/big-key.js", key.padEnd(1.5 * 1024 * 1024, " "));
    const capture = await f.capture();
    const out = await f.publish("index.html", "bundle");
    expect(out.code, out.stderr.join("")).toBe(0);
    expect(capture.requests[0]?.files).toEqual([
      expect.objectContaining({ path: "index.html", role: "doc", assets: [] }),
    ]);
    const uploaded = capture.fetcher.mock.calls
      .filter(([, init]) => init?.method === "PUT")
      .map(([, init]) => Buffer.from(init?.body as Uint8Array).toString());
    expect(uploaded).toEqual([html]);
    expect(out.stderr).toContain(`emend: skipped bundle/${ref}: may hold a secret\n`);
  },
);

test("a secret reference folder cannot alias a key outside the folder argument", async () => {
  const f = await fixture();
  const ref = "bundle/credentials/alias.js";
  const html = `<title>Synthetic</title><script src="${ref}"></script>`;
  await f.file("index.html", html);
  const target = await f.file("outside.js", syntheticPrivateKey());
  await mkdir(join(f.source, "bundle/credentials"), { recursive: true });
  await symlink(target, join(f.source, ref));
  const read = vi.spyOn(sourceReads, "readRegular");
  const capture = await f.capture();
  const out = await f.publish("index.html", "bundle");
  expect(out.code, out.stderr.join("")).toBe(0);
  expect(capture.requests[0]?.files).toEqual([
    expect.objectContaining({ path: "index.html", role: "doc", assets: [] }),
  ]);
  expect(out.stderr).toContain(`emend: skipped ${ref}: may hold a secret\n`);
  expect(read.mock.calls.some(([path]) => path === target)).toBe(false);
  const uploaded = capture.fetcher.mock.calls
    .filter(([, init]) => init?.method === "PUT")
    .map(([, init]) => Buffer.from(init?.body as Uint8Array).toString());
  expect(uploaded).toEqual([html]);
});

test("an asset alias introduced after walking stays in scope through its reference path", async () => {
  const f = await fixture();
  const html = '<title>Synthetic</title><script src="bundle/alias.js"></script>';
  await f.file("index.html", html);
  await mkdir(join(f.source, "bundle"));
  const target = await f.file("outside.js", syntheticPrivateKey());
  const prepare = shortcuts.shortcutManifest;
  vi.spyOn(shortcuts, "shortcutManifest").mockImplementationOnce(async (...args) => {
    const result = await prepare(...args);
    await symlink(target, join(f.source, "bundle/alias.js"));
    return result;
  });
  const capture = await f.capture();
  const out = await f.publish("index.html", "bundle");
  expect(out.code, out.stderr.join("")).toBe(0);
  expect(capture.requests[0]?.files).toEqual([
    expect.objectContaining({ path: "index.html", role: "doc", assets: [] }),
  ]);
  expect(out.stderr).toContain("emend: skipped bundle/alias.js: may hold a secret\n");
  const uploaded = capture.fetcher.mock.calls
    .filter(([, init]) => init?.method === "PUT")
    .map(([, init]) => Buffer.from(init?.body as Uint8Array).toString());
  expect(uploaded).toEqual([html]);
});

test("an in-scope asset uploads its one scanned read after replacement with a key", async () => {
  const f = await fixture();
  await f.file("index.html", '<title>Synthetic</title><img src="bundle/logo.png">');
  const source = await f.file("bundle/logo.png", "synthetic image");
  const key = syntheticPrivateKey();
  const read = sourceReads.readRegular;
  let assetReads = 0;
  vi.spyOn(sourceReads, "readRegular").mockImplementation(async (...args) => {
    const bytes = await read(...args);
    if (args[0] === source && ++assetReads === 1) await writeFile(source, key);
    return bytes;
  });
  const capture = await f.capture();
  const out = await f.publish("index.html", "bundle");
  expect(assetReads).toBe(1);
  expect(out.code, out.stderr.join("")).toBe(0);
  expect(capture.requests).toHaveLength(1);
  const uploaded = capture.fetcher.mock.calls
    .filter(([, init]) => init?.method === "PUT")
    .map(([, init]) => Buffer.from(init?.body as Uint8Array).toString());
  expect(uploaded).toContain("synthetic image");
  expect(uploaded.some((text) => text.includes(key))).toBe(false);
});

test("an in-scope asset alias uploads retained bytes after its target changes", async () => {
  const f = await fixture();
  const html = '<title>Synthetic</title><script src="bundle/alias.js"></script>';
  await f.file("index.html", html);
  const original = "const synthetic = true;";
  const source = await f.file("bundle/api-key.js", original);
  const target = await f.file("outside.js", syntheticPrivateKey());
  const alias = join(f.source, "bundle/alias.js");
  await symlink(source, alias);
  const read = sourceReads.readRegular;
  const assetReads: string[] = [];
  vi.spyOn(sourceReads, "readRegular").mockImplementation(async (...args) => {
    const bytes = await read(...args);
    if (args[0] === source || args[0] === target) assetReads.push(args[0]);
    if (args[0] === source) {
      await rm(alias);
      await symlink(target, alias);
    }
    return bytes;
  });
  const capture = await f.capture();
  const out = await f.publish("index.html", "bundle");
  expect(out.code, out.stderr.join("")).toBe(0);
  expect(assetReads).toEqual([source]);
  const uploaded = capture.fetcher.mock.calls
    .filter(([, init]) => init?.method === "PUT")
    .map(([, init]) => Buffer.from(init?.body as Uint8Array).toString());
  expect(uploaded).toEqual([html, original]);
});

test.each([["credentials"], [".", "credentials"], ["credentials", "."]])(
  "a named credentials root admits key-free assets through any containing folder: %j",
  async (...paths) => {
    const f = await fixture();
    await f.file("index.html", '<title>Outer</title><img src="credentials/password.svg">');
    await f.file("credentials/index.html", '<title>Inner</title><img src="password.svg">');
    const asset = '<svg xmlns="http://www.w3.org/2000/svg"></svg>';
    await f.file("credentials/password.svg", asset);
    const capture = await f.capture();
    const out = await f.publish(...paths);
    expect(out.code, out.stderr.join("")).toBe(0);
    const files = capture.requests[0]?.files ?? [];
    const assetPath = paths.length === 1 ? "password.svg" : "credentials/password.svg";
    expect(files.filter((file) => file.role === "asset").map((file) => file.path)).toEqual([assetPath]);
    expect(files.filter((file) => file.role === "doc").every((file) => file.assets?.includes(assetPath))).toBe(true);
    expect(out.stderr.join("")).not.toContain("password.svg");
    const uploaded = capture.fetcher.mock.calls
      .filter(([, init]) => init?.method === "PUT")
      .map(([, init]) => Buffer.from(init?.body as Uint8Array).toString());
    expect(uploaded).toContain(asset);
  },
);

test.each(["shortcut", "manifest"])("named HTML keeps key assets without folder arguments (%s)", async (mode) => {
  const f = await fixture();
  await f.file("index.html", '<title>Synthetic</title><script src="credentials/secrets.js"></script>');
  const key = syntheticPrivateKey();
  await f.file("credentials/secrets.js", key);
  const capture = await f.capture();
  const args = ["index.html"];
  if (mode === "manifest") {
    await f.file(
      "review.json",
      JSON.stringify({
        version: 1,
        title: "Synthetic",
        topics: [],
        files: [{ path: "index.html", role: "doc" }],
        writeup: { overview: "", tldr: "", decisions: null, topics: {} },
      }),
    );
    args.splice(0, 1, "--manifest", "review.json", "--key", "synthetic");
  }
  const out = await f.publish(...args);
  expect(out.code, out.stderr.join("")).toBe(0);
  expect(capture.requests[0]?.files.map((file) => [file.path, file.role])).toEqual([
    ["index.html", "doc"],
    ["credentials/secrets.js", "asset"],
  ]);
  expect(capture.requests[0]?.files[0]?.assets).toEqual(["credentials/secrets.js"]);
  const uploads = capture.fetcher.mock.calls.filter(([, init]) => init?.method === "PUT");
  expect(uploads.some(([, init]) => Buffer.from(init?.body as Uint8Array).toString() === key)).toBe(true);
  expect(out.stderr.filter((line) => line.includes("skipped"))).toEqual([]);
});

test("explicitly named private-key content still publishes beside a referencing HTML doc", async () => {
  const f = await fixture();
  await f.file("bundle/index.html", '<title>Synthetic</title><script src="notes.js"></script>');
  const text = syntheticPrivateKey();
  await f.file("bundle/notes.js", text);
  const capture = await f.capture();
  for (const paths of [["bundle/notes.js"], ["bundle", "bundle/notes.js"], ["bundle/notes.js", "bundle"]]) {
    capture.fetcher.mockClear();
    const out = await f.publish(...paths);
    expect(out.code, out.stderr.join("")).toBe(0);
    expect(capture.requests.at(-1)?.files).toContainEqual(expect.objectContaining({ path: "notes.js", role: "doc" }));
    if (paths.length > 1)
      expect(capture.requests.at(-1)?.files.find((file) => file.path === "index.html")?.assets).toEqual(["notes.js"]);
    const uploads = capture.fetcher.mock.calls.filter(([, init]) => init?.method === "PUT");
    expect(uploads.some(([, init]) => Buffer.from(init?.body as Uint8Array).toString() === text)).toBe(true);
    expect(out.stderr.filter((line) => line.includes("skipped"))).toEqual([]);
  }
});

test("a named key file inside a secret folder remains a doc and a referenced asset", async () => {
  const f = await fixture();
  await f.file("bundle/index.html", '<title>Synthetic</title><script src="credentials/notes.js"></script>');
  const key = syntheticPrivateKey();
  await f.file("bundle/credentials/notes.js", key);
  const capture = await f.capture();
  const out = await f.publish("bundle", "bundle/credentials/notes.js");
  expect(out.code, out.stderr.join("")).toBe(0);
  const files = capture.requests[0]?.files ?? [];
  expect(files).toContainEqual(expect.objectContaining({ path: "credentials/notes.js", role: "doc" }));
  expect(files.find((file) => file.path === "index.html")?.assets).toEqual(["credentials/notes.js"]);
  const uploads = capture.fetcher.mock.calls.filter(([, init]) => init?.method === "PUT");
  expect(uploads.some(([, init]) => Buffer.from(init?.body as Uint8Array).toString() === key)).toBe(true);
  expect(out.stderr.join("")).not.toContain("skipped credentials/notes.js:");
});

test("private-key content warnings escape the listed path", async () => {
  const f = await fixture();
  await f.file("bundle/notes\u202e.txt", syntheticPrivateKey());
  await f.file("bundle/readme.txt", "Synthetic public text");
  const capture = await f.capture();
  const out = await f.publish("bundle");
  expect(out.code, out.stderr.join("")).toBe(0);
  expect(capture.requests[0]?.files.map((file) => file.path)).toEqual(["readme.txt"]);
  expect(out.stderr.filter((line) => line.includes("skipped"))).toEqual([
    "emend: skipped notes\\u{202e}.txt: may hold a secret\n",
  ]);
});

test("private-key content skips share the warning cap with name skips", async () => {
  const f = await fixture();
  await f.file("bundle/readme.txt", "Synthetic public text");
  await f.file("bundle/token.txt", "Synthetic placeholder");
  for (let i = 0; i < SHORTCUT_LIMITS.warnings; i++) await f.file(`bundle/notes-${i}.txt`, syntheticPrivateKey());
  const capture = await f.capture();
  const out = await f.publish("bundle");
  expect(out.code, out.stderr.join("")).toBe(0);
  expect(capture.requests[0]?.files.map((file) => file.path)).toEqual(["readme.txt"]);
  const warnings = out.stderr.filter((line) => line.includes("skipped"));
  expect(warnings).toHaveLength(SHORTCUT_LIMITS.warnings + 1);
  expect(warnings.slice(0, -1).every((line) => line.endsWith(": may hold a secret\n"))).toBe(true);
  expect(warnings.at(-1)).toBe("emend: and 1 more files skipped\n");
});

test.each([
  "private.PEM",
  "app_secret.yaml",
  "db.password.json",
  "app_private-key.txt",
  "TOKEN.JSON",
  "app-firebase-adminsdk-test.json",
  "Chrome Passwords.csv",
])("explicit secret-looking file %s publishes before or after a folder argument", async (name) => {
  const f = await fixture();
  await f.file(`bundle/${name}`, "Synthetic credential placeholder");
  await f.file("bundle/readme.txt", "Synthetic public text");
  const capture = await f.capture();
  for (const paths of [
    [`bundle/${name}`, "bundle"],
    ["bundle", `bundle/${name}`],
  ]) {
    for (const flags of [[], ["--source"]]) {
      const out = await f.publish(...paths, ...flags);
      expect(out.code, out.stderr.join("")).toBe(0);
      expect(capture.requests.at(-1)?.files.map((file) => file.path)).toEqual([name, "readme.txt"].sort());
      expect(out.stderr.filter((line) => line.includes("skipped"))).toEqual([]);
    }
  }
});

test.each(["too large", "EACCES", "EPERM"])("walk skips %s files and explicit arguments fail once", async (reason) => {
  const f = await fixture();
  await f.file("bundle/readme.txt", "Synthetic public text");
  const refused = await f.file("bundle/refused.txt", "Synthetic text");
  if (reason === "too large") await truncate(refused, LIMITS.markdownDocBytes + 1);
  else {
    const read = sourceReads.readRegular;
    vi.spyOn(sourceReads, "readRegular").mockImplementation(async (path, ...args) => {
      if (path === refused) throw Object.assign(new Error("Synthetic permission failure"), { code: reason });
      return read(path, ...args);
    });
  }
  await f.capture();
  const diagnostic = reason === "too large" ? reason : "unreadable";
  const out = await f.publish("bundle");
  expect(out.code, out.stderr.join("")).toBe(0);
  expect(out.stderr.filter((line) => line.includes("skipped"))).toEqual([
    `emend: skipped refused.txt: ${diagnostic}\n`,
  ]);
  expect(out.stderr).toContain("emend: published 1 files from bundle\n");
  for (const paths of [
    ["./bundle/refused.txt"],
    ["./bundle/refused.txt", "bundle"],
    ["bundle", "./bundle/refused.txt"],
  ]) {
    const explicit = await f.publish(...paths);
    expect(explicit.code).toBe(1);
    expect(explicit.stdout).toEqual([]);
    expect(explicit.stderr).toEqual([
      `emend: ${reason === "too large" ? "file exceeds its size limit" : diagnostic}: ./bundle/refused.txt\n`,
    ]);
  }
});

test("walked non-UTF-8 HTML keeps rendered rules, while source skips it", async () => {
  const f = await fixture();
  await f.file("bundle/readme.txt", "Synthetic public text");
  await writeFile(await f.file("bundle/page.html"), Buffer.from([60, 112, 62, 255]));
  const capture = await f.capture();
  const rendered = await f.publish("bundle", "--title", "Synthetic");
  expect(rendered.code, rendered.stderr.join("")).toBe(0);
  expect(capture.requests.at(-1)?.files.map((file) => file.path)).toEqual(["page.html", "readme.txt"]);
  const source = await f.publish("bundle", "--source");
  expect(source.code, source.stderr.join("")).toBe(0);
  expect(capture.requests.at(-1)?.files.map((file) => file.path)).toEqual(["readme.txt"]);
  expect(source.stderr).toContain("emend: skipped page.html: not a text file\n");
});

test("folder summaries are per argument, escaped, uncapped, and keep JSON stdout", async () => {
  const f = await fixture();
  await f.file("bundle/a.txt", "Synthetic text");
  await f.file("other/b.txt", "Synthetic text");
  await symlink(join(f.source, "other"), join(f.source, "other\u202e"));
  for (let i = 0; i < 25; i++) await f.file(`bundle/secret.${i}`, "Synthetic credential placeholder");
  await f.capture();
  const out = await f.publish("./bundle", "other\u202e", "bundle", "--json");
  expect(out.code, out.stderr.join("")).toBe(0);
  expect(out.stdout).toHaveLength(1);
  PublishResponse.parse(JSON.parse(out.stdout[0] ?? ""));
  expect(out.stderr.filter((line) => /published \d+ files/.test(line))).toEqual([
    "emend: published 1 files from ./bundle\n",
    "emend: published 1 files from other\\u{202e}\n",
    "emend: published 1 files from bundle\n",
  ]);
  expect(out.stderr.filter((line) => line.includes("skipped"))).toHaveLength(SHORTCUT_LIMITS.warnings + 1);
});

test("a refused symlink names the written argument instead of the target basename", async () => {
  const f = await fixture();
  await writeFile(await f.file("other.bin"), Buffer.from([0]));
  await symlink(join(f.source, "other.bin"), join(f.source, "link\u202e.txt"));
  const out = await f.publish("./link\u202e.txt");
  expect(out.code).toBe(1);
  expect(out.stdout).toEqual([]);
  expect(out.stderr).toEqual(["emend: not a text file: ./link\\u{202e}.txt\n"]);
});

test.each([
  "bin dat npy npz pkl pickle parquet onnx pt pth safetensors gguf h5",
  "docx xlsx pptx odt iso dmg apk whl deb rpm msi pyc",
])("walk skips the additional binary extensions: %s", async (extensions) => {
  const f = await fixture();
  await f.file("bundle/readme.txt", "Synthetic public text");
  const names = extensions.split(" ").map((ext) => `sample.${ext.toUpperCase()}`);
  for (const name of names) await f.file(`bundle/${name}`, "Synthetic binary placeholder");
  await f.capture();
  const out = await f.publish("bundle");
  expect(out.code, out.stderr.join("")).toBe(0);
  expect(out.stderr.filter((line) => line.includes("skipped"))).toEqual(
    names.sort().map((name) => `emend: skipped ${name}: binary file\n`),
  );
});

test("secret folders are skipped by entry name before opening or checking their contents", async () => {
  const f = await fixture();
  const names = ["secret", "SECRETS", "Credential", "credentials"];
  for (const name of names) await f.file(`bundle/${name}/nested/readme.md`, "Synthetic placeholder");
  await f.file("bundle/readme.txt", "Synthetic public text");
  const publicFolders = ["secrets-guide", "my secrets", "secret2", "AWS credentials", "passwords", "private_keys"];
  for (const name of publicFolders) await f.file(`bundle/${name}/note.txt`, "Public guide");
  const capture = await f.capture();
  const calls = [vi.spyOn(fs, "realpath"), vi.spyOn(fs, "lstat"), vi.spyOn(fs, "open")];
  const out = await f.publish("bundle");
  expect(out.code, out.stderr.join("")).toBe(0);
  expect(out.stderr.filter((line) => line.includes("skipped"))).toEqual(
    [...names].sort().map((name) => `emend: skipped ${name}: may hold a secret\n`),
  );
  expect(capture.requests.at(-1)?.files.map((file) => file.path)).toEqual(
    ["readme.txt", ...publicFolders.map((name) => `${name}/note.txt`)].sort(),
  );
  const skipped = names.map((name) => join(f.source, "bundle", name));
  for (const spy of calls)
    expect(
      spy.mock.calls.some(([path]) =>
        skipped.some((folder) => String(path) === folder || String(path).startsWith(`${folder}/`)),
      ),
    ).toBe(false);
});

test.each(["secret", "secrets", "credential", "credentials"])(
  "an explicitly named %s folder is walked as the argument",
  async (name) => {
    const f = await fixture();
    await f.file(`${name}/note.txt`, "Synthetic public text");
    await f.file(`${name}/secrets/nested.txt`, "Synthetic placeholder");
    const capture = await f.capture();
    const out = await f.publish(name);
    expect(out.code, out.stderr.join("")).toBe(0);
    expect(capture.requests.at(-1)?.files.map((file) => file.path)).toEqual(["note.txt"]);
    expect(out.stderr.filter((line) => line.includes("skipped"))).toEqual([
      "emend: skipped secrets: may hold a secret\n",
    ]);
  },
);

test("secret patterns respect delimiters and asset names, but exclude assets below secret folders", async () => {
  const f = await fixture();
  const names = ["token.ts", "tokens.json", "mytoken.json", "secretary.txt", "passwordless.txt", "privatekeynotes.txt"];
  for (const name of names) await f.file(`bundle/${name}`, "Synthetic public text");
  await f.file(
    "bundle/index.html",
    '<title>Synthetic</title><script src="private-key.js"></script><script src="credentials/client.js"></script>',
  );
  await f.file("bundle/private-key.js", "const synthetic = true;");
  await f.file("bundle/credentials/client.js", "const synthetic = false;");
  const capture = await f.capture();
  const out = await f.publish("bundle");
  expect(out.code, out.stderr.join("")).toBe(0);
  const files = capture.requests.at(-1)?.files ?? [];
  expect(
    files
      .filter((file) => file.role === "doc")
      .map((file) => file.path)
      .sort(),
  ).toEqual([...names, "index.html"].sort());
  expect(
    files
      .filter((file) => file.role === "asset")
      .map((file) => file.path)
      .sort(),
  ).toEqual(["private-key.js"]);
  expect(files.find((file) => file.path === "index.html")?.assets).toEqual(["private-key.js"]);
  expect(out.stderr).toContain("emend: skipped credentials/client.js: may hold a secret\n");
  expect(out.stderr.join("")).not.toContain("skipped private-key.js");
});

test("an entirely skipped walk reports escaped paths and reasons in its one capped error line", async () => {
  const f = await fixture();
  await f.file("bundle/00-password-\u202e.json", "Synthetic placeholder");
  await f.file("bundle/01.png", "Synthetic binary name");
  await f.file("bundle/02.txt", "nul\0text");
  for (let i = 0; i < 22; i++)
    await f.file(`bundle/z-secret-${String(i).padStart(2, "0")}.json`, "Synthetic placeholder");
  const out = await f.publish("bundle");
  expect(out.code).toBe(1);
  expect(out.stdout).toEqual([]);
  expect(out.stderr).toHaveLength(1);
  const line = out.stderr[0] ?? "";
  expect(line).toContain("no text docs to publish; skipped ");
  expect(line).toContain("bundle/00-password-\\u{202e}.json: may hold a secret");
  expect(line).toContain("bundle/01.png: binary file");
  expect(line).toContain("bundle/02.txt: not a text file");
  expect(line.match(/: (may hold a secret|binary file|not a text file)/g)).toHaveLength(SHORTCUT_LIMITS.warnings);
  expect(line).toContain(" and 5 more files");
  expect(line).not.toContain("z-secret-17");
  expect(line.split("\n")).toHaveLength(2);
});
