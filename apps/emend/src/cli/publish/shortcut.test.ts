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

async function fixture() {
  const f = await directFixture();
  await rm(f.manifest);
  await rm(join(f.source, "plan.md"));
  vi.spyOn(process, "cwd").mockReturnValue(f.source);
  async function file(path: string, text = "# Synthetic document\n") {
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

test("reference-expansion main doc publishes with a bounded worker title", async () => {
  const f = await fixture();
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
}, 15000);

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
}, 15000);

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
}, 15000);

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
  await f.file("bundle/notes.txt", "not a doc");
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
  ]);
  expect(capture.requests[0]?.files.find((file) => file.path === "index.html")?.assets).toEqual(["image.png"]);
  expect(out.stderr.filter((line) => line.includes("notes.txt"))).toHaveLength(1);
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
  expect(result.stderr).toEqual(["emend: file exceeds its size limit\n"]);
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
  expect(large.stderr).toEqual(["emend: file exceeds its size limit\n"]);
  await f.file("plan.md");
  await f.file("other.md");
  const main = await f.publish("plan.md", "--main", "other.md");
  expect(main.code).toBe(1);
  expect(main.stdout).toEqual([]);
  expect(main.stderr).toEqual(["emend: --main must name a published doc\n"]);
  await expect(stat(join(f.stateDir, "emend.db"))).rejects.toMatchObject({ code: "ENOENT" });
}, 30000);

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
}, 15000);

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
    await Promise.all(Array.from({ length: 100 }, (_, i) => f.file(`bundle/junk-${batch * 100 + i}.txt`, "unused")));
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
}, 30000);

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
}, 30000);

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
  "a %s swapped outside its walked folder before upload is refused",
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
    const out = await f.publish("bundle");
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
  "shared asset confinement survives deduplication before %s (folder first: %s)",
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
    const out = await f.publish(...(folderFirst ? ["bundle", "a.html"] : ["a.html", "bundle"]));
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

test("assets with identical bytes retain their boundaries after blob deduplication", async () => {
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
  const out = await f.publish("a.html", "bundle");
  expect(out.code).toBe(1);
  expect(out.stdout).toEqual([]);
  expect(out.stderr).toEqual(["emend: symlink leaves the published folder: bundle\n"]);
  expect(capture.requests).toEqual([]);
});

test("a shared asset changed after its resolution read is refused at upload", async () => {
  const f = await fixture();
  await f.file("a.html", '<title>Explicit</title><img src="bundle/logo.png">');
  await f.file("bundle/index.html", '<title>Walked</title><img src="logo.png">');
  const source = await f.file("bundle/logo.png", "synthetic original image");
  const read = sourceReads.readRegular;
  let changed = false;
  vi.spyOn(sourceReads, "readRegular").mockImplementation(async (...args) => {
    const bytes = await read(...args);
    if (args[0] === source && !changed) {
      changed = true;
      await writeFile(source, "synthetic replacement image");
    }
    return bytes;
  });
  const capture = await f.capture();
  const out = await f.publish("a.html", "bundle");
  expect(changed).toBe(true);
  expect(out.code).toBe(1);
  expect(out.stdout).toEqual([]);
  expect(out.stderr).toEqual(["emend: blob changed before upload\n"]);
  expect(capture.requests).toEqual([]);
  const hash = createHash("sha256").update("synthetic original image").digest("hex");
  expect(capture.fetcher.mock.calls.some(([url, init]) => init?.method === "PUT" && String(url).endsWith(hash))).toBe(
    false,
  );
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
