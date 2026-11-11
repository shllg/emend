import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import * as fs from "node:fs/promises";
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { expect, onTestFinished, test, vi } from "vitest";
import { run } from "../../main.ts";
import * as roots from "../publish/root.ts";
import { commandFixture } from "../test-support.ts";

vi.mock("node:fs/promises", async (original) => {
  const actual = await original<typeof import("node:fs/promises")>();
  return { ...actual, open: vi.fn(actual.open) };
});

const topic = { slug: "auth", title: "Auth", importance: 10, summary: "Synthetic topic" };
const manifest = () => ({
  version: 1,
  title: "Synthetic review",
  topics: [topic],
  files: [],
  writeup: { overview: "", tldr: "", decisions: null, topics: {} },
});

async function fixture(inGit = true) {
  const f = await commandFixture();
  const root = await mkdtemp(join(tmpdir(), "emend-readiness-repo-"));
  onTestFinished(() => rm(root, { recursive: true, force: true }));
  if (inGit)
    await promisify(execFile)("git", ["-c", "init.templateDir=", "init", root], {
      env: {
        PATH: process.env.PATH,
        HOME: root,
        LC_ALL: "C",
        GIT_CONFIG_GLOBAL: "/dev/null",
        GIT_CONFIG_NOSYSTEM: "1",
      },
    });
  // Ignore unrelated repositories above the temporary folder.
  else vi.spyOn(roots, "worktreeRoot").mockResolvedValue(null);
  vi.spyOn(process, "cwd").mockReturnValue(root);
  const path = join(f.dir, "review.json");
  return {
    ...f,
    root,
    path,
    publish: () => run(["publish", "--manifest", path, "--key", "synthetic"], f.io),
  };
}

test.each([
  [{ base: "received-base", head: "worktree" }, "base (a full commit hash)"],
  [{ base: "a".repeat(40), head: "received-head" }, "head (a full commit hash or worktree)"],
  [
    { topics: [{ ...topic, slug: "Received" }] },
    "topics.0.slug (topic slug: lowercase letters, digits and -, at most 64)",
  ],
  [{ topics: [{ ...topic, door: "received-door" }] }, "topics.0.door (one-way or two-way)"],
  [{ topics: [{ ...topic, attention: "received-attention" }] }, "topics.0.attention (critical, review or skim)"],
  [
    { topics: [{ ...topic, blastRadius: { scope: "received scope", note: "Synthetic" } }] },
    "topics.0.blastRadius.scope (one word, at most 32 characters)",
  ],
  [{ topics: [{ ...topic, importance: 101 }] }, "topics.0.importance (a number from 0 to 100)"],
  [{ title: "x".repeat(201) }, "title (at most 200 characters)"],
  [{ topics: [{ ...topic, summary: "x".repeat(2001) }] }, "topics.0.summary (at most 2000 characters)"],
  [{ title: undefined }, "title (required)"],
  [{ topics: [{ ...topic, slug: undefined }] }, "topics.0.slug (required)"],
  [{ topics: [{ ...topic, importance: undefined }] }, "topics.0.importance (required)"],
  [{ base: "a".repeat(40) }, "head (required)"],
  [{ title: { received: "private text" } }, "title (Invalid input: expected string)"],
  [{ version: "received-version" }, "version (Invalid input: expected 1)"],
  [{ topics: [topic, topic] }, "topics.1.slug (duplicate topic slug)"],
] as const)("invalid manifest names the field: %s", async (change, expected) => {
  const f = await fixture();
  await writeFile(f.path, JSON.stringify({ ...manifest(), ...change }));
  expect(await f.publish()).toBe(1);
  expect(f.stdout).toEqual([]);
  expect(f.stderr).toEqual([`emend: invalid publish manifest: ${expected}\n`]);
  expect(f.stderr.join("")).not.toContain("received");
  expect(f.stderr.join("")).not.toContain("private text");
});

test("invalid manifest reports three issues and counts the fourth", async () => {
  const f = await fixture();
  await writeFile(
    f.path,
    JSON.stringify({
      ...manifest(),
      base: "received-base",
      head: "received-head",
      topics: [{ ...topic, door: "received-door", blastRadius: { scope: "received scope", note: "Synthetic" } }],
    }),
  );
  expect(await f.publish()).toBe(1);
  expect(f.stdout).toEqual([]);
  expect(f.stderr).toEqual([
    "emend: invalid publish manifest: base (a full commit hash); head (a full commit hash or worktree); topics.0.door (one-way or two-way); and 1 more\n",
  ]);
});

test("invalid manifest escapes hostile record keys on one line without printing their values", async () => {
  const f = await fixture();
  await writeFile(
    f.path,
    JSON.stringify({
      ...manifest(),
      writeup: { ...manifest().writeup, topics: { "Auth\n\u001b[31m": { why: "received private value" } } },
    }),
  );
  expect(await f.publish()).toBe(1);
  expect(f.stdout).toEqual([]);
  expect(f.stderr).toEqual([
    "emend: invalid publish manifest: writeup.topics.Auth\\u{a}\\u{1b}[31m (topic slug: lowercase letters, digits and -, at most 64)\n",
  ]);
  expect(f.stderr.join("").split("\n")).toHaveLength(2);
});

test("invalid manifest bounds a long record key after escaping it", async () => {
  const f = await fixture();
  const key = `\n${"x".repeat(8192)}`;
  await writeFile(
    f.path,
    JSON.stringify({ ...manifest(), writeup: { ...manifest().writeup, topics: { [key]: { why: "Synthetic" } } } }),
  );
  expect(await f.publish()).toBe(1);
  expect(f.stdout).toEqual([]);
  expect(f.stderr).toEqual([
    `emend: invalid publish manifest: writeup.topics.\\u{a}${"x".repeat(59)}… (topic slug: lowercase letters, digits and -, at most 64)\n`,
  ]);
  expect(f.stderr.join("").length).toBeLessThan(200);
  expect(f.stderr.join("").split("\n")).toHaveLength(2);
});

test("a manifest that is not JSON says so without its text", async () => {
  const f = await fixture();
  await writeFile(f.path, '{"received private value":');
  expect(await f.publish()).toBe(1);
  expect(f.stdout).toEqual([]);
  expect(f.stderr).toEqual(["emend: the manifest is not valid JSON\n"]);
  expect(f.stderr.join("")).not.toContain("received private value");
});

test.each(["missing", "directory", "directory without extension", "non-folder", "alias", "escaped"])(
  "a %s doc source has one stderr diagnostic",
  async (kind) => {
    const f = await fixture();
    const source =
      kind === "non-folder"
        ? "plain/plan.md"
        : kind === "escaped"
          ? "plan\u0085.md"
          : kind === "directory without extension"
            ? "drafts"
            : "draft.md";
    if (kind.startsWith("directory")) await mkdir(join(f.root, source));
    if (kind === "non-folder") await writeFile(join(f.root, "plain"), "Synthetic file");
    if (kind === "alias") await symlink("missing.md", join(f.root, source));
    await writeFile(f.path, JSON.stringify({ ...manifest(), files: [{ path: "plan.md", role: "doc", source }] }));
    expect(await f.publish()).toBe(1);
    expect(f.stdout).toEqual([]);
    expect(f.stderr).toEqual([
      kind === "directory without extension"
        ? "emend: doc source must end in .md, .markdown, .html or .htm, like its path.\n"
        : `emend: doc not found: ${kind === "escaped" ? "plan\\u{85}.md" : source}\n`,
    ]);
    expect(f.fetcher).not.toHaveBeenCalled();
  },
);

test.each([
  { source: "report.txt", mode: 0o000 },
  { source: ".env", mode: 0o600 },
])("publish refuses $source before opening it", async ({ source, mode }) => {
  const f = await fixture();
  await writeFile(join(f.root, source), "Synthetic non-document content", { mode });
  await writeFile(f.path, JSON.stringify({ ...manifest(), files: [{ path: "plan.md", role: "doc", source }] }));
  const open = vi.mocked(fs.open);
  open.mockClear();
  expect(await f.publish()).toBe(1);
  expect(f.stdout).toEqual([]);
  expect(f.stderr).toEqual(["emend: doc source must end in .md, .markdown, .html or .htm, like its path.\n"]);
  // Only the manifest may be opened; neither refused doc source may reach open.
  expect(open.mock.calls.map(([path]) => path)).toEqual([f.path]);
  expect(f.fetcher).not.toHaveBeenCalled();
});

test("a missing doc without a source names its manifest path", async () => {
  const f = await fixture();
  await writeFile(f.path, JSON.stringify({ ...manifest(), files: [{ path: "plan.md", role: "doc" }] }));
  expect(await f.publish()).toBe(1);
  expect(f.stdout).toEqual([]);
  expect(f.stderr).toEqual(["emend: doc not found: plan.md\n"]);
});

test("a code review outside git reports the repository error", async () => {
  const f = await fixture(false);
  await writeFile(f.path, JSON.stringify({ ...manifest(), base: "a".repeat(40), head: "worktree" }));
  expect(await f.publish()).toBe(1);
  expect(f.stdout).toEqual([]);
  expect(f.stderr).toEqual(["emend: not a git repository\n"]);
  expect(f.fetcher).not.toHaveBeenCalled();
});

test.each([
  { name: "an allowed doc succeeds", allowed: true, present: true, error: null },
  {
    name: "a doc without docRoots is refused",
    allowed: false,
    present: true,
    error: "emend: source is outside the allowed doc roots\n",
  },
  {
    name: "a missing doc names its source",
    allowed: true,
    present: false,
    error: "missing",
  },
])("docs-only outside git: $name", async ({ allowed, present, error }) => {
  const f = await fixture(false);
  const docs = await realpath(await mkdtemp(join(tmpdir(), "emend-readiness-docs-")));
  onTestFinished(() => rm(docs, { recursive: true, force: true }));
  if (present) await writeFile(join(docs, "draft.md"), "# Synthetic plan\n");
  await mkdir(f.configDir, { recursive: true, mode: 0o700 });
  if (allowed) await writeFile(join(f.configDir, "config.json"), JSON.stringify({ docRoots: [docs] }));
  await rm(join(f.dir, "server.json"));
  await writeFile(
    f.path,
    JSON.stringify({ ...manifest(), files: [{ path: "plan.md", role: "doc", source: join(docs, "draft.md") }] }),
  );
  expect(await f.publish()).toBe(error ? 1 : 0);
  if (error) {
    expect(f.stdout).toEqual([]);
    expect(f.stderr).toEqual([error === "missing" ? `emend: doc not found: ${join(docs, "draft.md")}\n` : error]);
  } else {
    expect(f.stdout).toHaveLength(1);
    expect(f.stdout[0]?.split("\n")).toHaveLength(2);
    const result = JSON.parse(f.stdout[0] ?? "");
    expect(result).toMatchObject({ revision: 1, unrendered: [] });
    expect(f.stderr).toEqual([
      `emend: published revision 1: ${result.url}\n`,
      "emend: emend is not running; the review opens once it runs (emend serve, or emend service install)\n",
    ]);
  }
  expect(f.fetcher).not.toHaveBeenCalled();
});

test("direct publish succeeds with one JSON line and a note that the server must run", async () => {
  const f = await fixture();
  await rm(join(f.dir, "server.json"));
  await writeFile(f.path, JSON.stringify(manifest()));
  expect(await f.publish()).toBe(0);
  expect(f.stdout).toHaveLength(1);
  expect(f.stdout[0]?.split("\n")).toHaveLength(2);
  const result = JSON.parse(f.stdout[0] ?? "");
  expect(result).toMatchObject({ revision: 1, unrendered: [] });
  expect(f.stderr).toEqual([
    `emend: published revision 1: ${result.url}\n`,
    "emend: emend is not running; the review opens once it runs (emend serve, or emend service install)\n",
  ]);
});

test.each(["local", "hub"])("publish through a %s server prints no stopped-server note", async (kind) => {
  const f = await fixture();
  await writeFile(f.path, JSON.stringify(manifest()));
  await writeFile(join(f.dir, "instance.json"), JSON.stringify({ id: randomUUID() }));
  if (kind === "hub") {
    await writeFile(
      join(f.dir, "attach.json"),
      JSON.stringify({ hubUrl: "https://hub.example", hubId: randomUUID(), hubName: "Synthetic hub" }),
    );
    await writeFile(join(f.dir, "hub.token"), `em_${"b".repeat(43)}`, { mode: 0o600 });
  }
  const reviewId = randomUUID();
  const url = `${kind === "hub" ? "https://hub.example" : "http://127.0.0.1:3636"}/r/${reviewId}`;
  f.setResponse(async () => Response.json({ reviewId, revision: 1, placed: 0, unplaced: 0, unrendered: [], url }));
  expect(await f.publish()).toBe(0);
  expect(f.stdout).toHaveLength(1);
  expect(f.stdout[0]?.split("\n")).toHaveLength(2);
  expect(JSON.parse(f.stdout[0] ?? "")).toMatchObject({ reviewId, revision: 1, url });
  expect(f.stderr).toEqual([`emend: published revision 1: ${url}\n`]);
});

test.each([false, true])("publish ignores committed repository config (shortcut=%s)", async (shortcut) => {
  const f = await fixture();
  const docs = await mkdtemp(join(tmpdir(), "emend-outside-docs-"));
  onTestFinished(() => rm(docs, { recursive: true, force: true }));
  const source = join(docs, "plan.md");
  await writeFile(source, "# Synthetic plan");
  const configHome = join(f.root, ".config");
  const configDir = join(configHome, "emend");
  const configFile = join(configDir, "config.json");
  await mkdir(configDir, { recursive: true });
  const content = JSON.stringify({ docRoots: [docs], openBrowser: true });
  await writeFile(configFile, content);
  const git = (args: string[]) =>
    promisify(execFile)(
      "git",
      [
        "-C",
        f.root,
        "-c",
        "core.hooksPath=/dev/null",
        "-c",
        "commit.gpgsign=false",
        "-c",
        "user.name=Synthetic",
        "-c",
        "user.email=synthetic@example.com",
        ...args,
      ],
      {
        env: { PATH: process.env.PATH, HOME: f.root, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" },
      },
    );
  await git(["add", ".config/emend/config.json"]);
  await git(["commit", "-m", "synthetic config"]);
  await writeFile(join(f.dir, "config.json"), '{"approvedActiveHours":24}');
  f.io.env.XDG_CONFIG_HOME = configHome;
  await writeFile(f.path, JSON.stringify({ ...manifest(), files: [{ path: "plan.md", role: "doc", source }] }));
  expect(await (shortcut ? run(["publish", source], f.io) : f.publish())).toBe(1);
  expect(f.stdout).toEqual([]);
  expect(f.stderr).toEqual([
    `emend: ignoring ${configFile}: it sits inside the repository at ${f.root}\n`,
    "emend: source is outside the allowed doc roots\n",
  ]);
  expect(await fs.readFile(configFile, "utf8")).toBe(content);
  expect(await fs.readFile(join(f.dir, "config.json"), "utf8")).toBe('{"approvedActiveHours":24}');
  await expect(fs.stat(join(f.dir, "config.json.migrated"))).rejects.toMatchObject({ code: "ENOENT" });
});
