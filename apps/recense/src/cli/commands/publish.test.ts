import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, realpath, rm, stat, truncate, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Writable } from "node:stream";
import { promisify } from "node:util";
import { LIMITS, type PublishManifest, PublishRequest, PublishResponse } from "@recense/contract";
import * as core from "@recense/core";
import { afterEach, expect, onTestFinished, test, vi } from "vitest";
import { run } from "../../main.ts";
import { projectKey } from "../publish/key.ts";
import * as roots from "../publish/root.ts";
import { commandFixture, provenTestServer } from "../test-support.ts";
import { manifestJsonError, parsePublishArgs, publishCommand, publishTimeoutMs } from "./publish.ts";

afterEach(() => vi.unstubAllGlobals());

test("a local HTML classifier error still publishes and prints the server's generic look note", async () => {
  const f = await commandFixture();
  const source = await realpath(await mkdtemp(join(tmpdir(), "recense-pub-look-error-")));
  onTestFinished(() => rm(source, { recursive: true, force: true }));
  vi.spyOn(roots, "worktreeRoot").mockResolvedValue(null);
  const classify = vi.spyOn(core, "htmlLook").mockImplementation(() => {
    throw new RangeError("Synthetic classifier failure");
  });
  await mkdir(f.configDir, { recursive: true });
  await writeFile(join(f.configDir, "config.json"), JSON.stringify({ docRoots: [source] }));
  await writeFile(join(f.dir, "instance.json"), JSON.stringify({ id: randomUUID() }));
  await writeFile(join(source, "page.html"), "<style>p{margin:0}</style><p>Synthetic plan</p>");
  const response = {
    reviewId: randomUUID(),
    revision: 1,
    placed: 0,
    unplaced: 0,
    unrendered: [],
    htmlLooks: [{ path: "page.html", look: "recense" }],
    url: "http://127.0.0.1:3636/r/synthetic",
  };
  f.setResponse(async (_url, init) => {
    if (init?.method === "HEAD") return new Response(null, { status: 404 });
    if (init?.method === "PUT") return new Response(null, { status: 204 });
    return Response.json(response);
  });
  await publishCommand(f.dir, f.configDir, ["page.html", "--title", "Synthetic", "--key", "synthetic"], f.io, source);
  expect(classify).toHaveBeenCalled();
  expect(f.stdout).toEqual([`${response.url}\n`]);
  expect(f.stderr).toEqual([
    "recense: page.html shows in recense's look\n",
    `recense: published revision 1: ${response.url}\n`,
  ]);
});

test.each(["manifest", "shortcut", "json"])(
  "%s publishes report each HTML look on stderr without changing stdout",
  async (mode) => {
    const f = await commandFixture();
    const source = await realpath(await mkdtemp(join(tmpdir(), "recense-pub-look-")));
    onTestFinished(() => rm(source, { recursive: true, force: true }));
    vi.spyOn(roots, "worktreeRoot").mockResolvedValue(null);
    await mkdir(f.configDir, { recursive: true });
    await writeFile(join(f.configDir, "config.json"), JSON.stringify({ docRoots: [source] }));
    await writeFile(join(f.dir, "instance.json"), JSON.stringify({ id: randomUUID() }));
    const sources = [
      ["structure.html", "<h1>Plan</h1><x-one></x-one>", "shows in recense's look"],
      [
        "marked.html",
        '<meta name="recense-look" content="recense"><style>p{}</style>',
        "shows in recense's look; its own styles apply on top",
      ],
      [
        "custom.html",
        '<meta name="recense-look" content="custom"><script>alert(1)</script>',
        "shows as a custom page with its own styles only: marked custom",
      ],
      ["styled.html", "<style>p{}</style>", "shows in recense's look; its own styles apply on top"],
      ["light.html", "<style>p{color:#222}</style>", "shows in recense's look; its own styles apply on top"],
      [
        "dark.html",
        "<style>p{color:#222}@media(prefers-color-scheme:dark){p{color:white}}</style>",
        "shows in recense's look; its own styles apply on top",
      ],
      ["deep.html", "<div>".repeat(600), "shows as a custom page: recense could not read its structure"],
      [
        "outside\u034f.html",
        "<a-\u001b></a-\u001b><button></button><canvas></canvas><form></form><iframe></iframe><input><x-widget></x-widget>",
        "shows in recense's look",
      ],
      [
        "safe-outside.html",
        "<x-a></x-a><x-b></x-b><x-c></x-c><x-d></x-d><x-e></x-e><x-f></x-f>",
        "shows in recense's look",
      ],
      ["omitted.html", `<x-\u00a0></x-\u00a0><x-${"a".repeat(31)}></x-${"a".repeat(31)}>`, "shows in recense's look"],
      [
        "capped.html",
        Array.from(
          { length: 21 },
          (_, i) => `<x-${String(i).padStart(2, "0")}></x-${String(i).padStart(2, "0")}>`,
        ).join(""),
        "shows in recense's look",
      ],
      [
        "failed.html",
        '<meta name="recense-look" content="recense"><x-failure></x-failure>',
        "shows as a custom page: recense could not read its structure",
      ],
      ["plan.md", "# Plan", ""],
    ] as const;
    for (const [path, text] of sources) await writeFile(join(source, path), text);
    const response = {
      reviewId: randomUUID(),
      revision: 1,
      placed: 0,
      unplaced: 0,
      unrendered: ["failed.html", "plan.md"],
      htmlLooks: sources.flatMap(([path, , note]) =>
        path === "failed.html" || path === "plan.md"
          ? []
          : [
              {
                path,
                look: note.startsWith("shows in") ? "recense" : "custom",
                ...(path === "light.html" ? { colorScheme: "light" } : {}),
              },
            ],
      ),
      url: "http://127.0.0.1:3636/r/synthetic",
    };
    f.setResponse(async (_url, init) => {
      if (init?.method === "HEAD") return new Response(null, { status: 404 });
      if (init?.method === "PUT") return new Response(null, { status: 204 });
      // Remove the files after upload: look diagnostics must never read them again.
      for (const [path] of sources) await rm(join(source, path));
      return Response.json(response);
    });
    const manifest = join(source, "review.json");
    await writeFile(
      manifest,
      JSON.stringify({
        version: 1,
        title: "Synthetic",
        topics: [],
        files: sources.map(([path]) => ({ path, role: "doc" })),
        writeup: { overview: "", tldr: "", decisions: null, topics: {} },
      }),
    );
    const args =
      mode === "manifest"
        ? ["--manifest", manifest, "--key", "synthetic"]
        : [
            ...sources.map(([path]) => path),
            "--title",
            "Synthetic",
            "--key",
            "synthetic",
            ...(mode === "json" ? ["--json"] : []),
          ];
    await publishCommand(f.dir, f.configDir, args, f.io, source);
    expect(f.stdout).toEqual([
      mode === "shortcut" ? `${response.url}\n` : `${JSON.stringify(PublishResponse.parse(response))}\n`,
    ]);
    for (const [path, , note] of sources) {
      if (note) expect(f.stderr).toContain(`recense: ${path.replace("\u034f", "\\u{34f}")} ${note}\n`);
      else expect(f.stderr.join("")).not.toContain(`${path} shows `);
    }
    expect(f.stderr.filter((line) => line.includes(" shows "))).toHaveLength(13);
    const lightLine =
      "recense: light.html shows in light mode, also while recense is dark: its styles set colours but have no dark-mode rule; add a prefers-color-scheme: dark rule in a style element so it follows dark mode\n";
    expect(f.stderr.filter((line) => line.includes("shows in light mode"))).toEqual([lightLine]);
    expect(f.stderr[f.stderr.indexOf(lightLine) - 1]).toBe(
      "recense: light.html shows in recense's look; its own styles apply on top\n",
    );
    expect(f.stderr.filter((line) => line.includes("failed.html"))).toEqual([
      "recense: failed.html shows as a custom page: recense could not read its structure\n",
    ]);
    expect(f.stderr.filter((line) => line.includes("plan.md"))).toEqual(["recense: could not render plan.md\n"]);
    expect(f.stderr.join("")).not.toContain("failed.html shows in recense");
    expect(f.stderr.join("")).not.toContain("<x-failure>");
    expect(f.stderr).toContain(
      "recense: structure.html uses elements outside recense's page structure: <x-one>; recense's look has no styles for them\n",
    );
    expect(f.stderr.filter((line) => line.includes("uses elements outside"))).toHaveLength(5);
    expect(f.stderr).toContain(
      "recense: outside\\u{34f}.html uses elements outside recense's page structure: <button>, <canvas>, <form>, <iframe>, <input> and more; recense's look has no styles for them\n",
    );
    expect(f.stderr).toContain(
      "recense: safe-outside.html uses elements outside recense's page structure: <x-a>, <x-b>, <x-c>, <x-d>, <x-e> and 1 more; recense's look has no styles for them\n",
    );
    expect(f.stderr).toContain(
      "recense: omitted.html uses elements outside recense's page structure; recense's look has no styles for them\n",
    );
    expect(f.stderr).toContain(
      "recense: capped.html uses elements outside recense's page structure: <x-00>, <x-01>, <x-02>, <x-03>, <x-04> and more; recense's look has no styles for them\n",
    );
    expect(f.stderr.join("")).not.toContain("\\u{1b}");
    expect(f.stderr.join("")).not.toContain("\u00a0");
    expect(f.stderr.join("")).not.toContain("a".repeat(31));
    for (const code of [0x1b, 0x34f]) expect(f.stderr.join("")).not.toContain(String.fromCodePoint(code));
  },
);

test.each(["legacy", "empty", "different", "scheme-omitted", "scheme-added"])(
  "%s server look metadata controls HTML notes",
  async (mode) => {
    const f = await commandFixture();
    const source = await realpath(await mkdtemp(join(tmpdir(), "recense-server-look-")));
    onTestFinished(() => rm(source, { recursive: true, force: true }));
    vi.spyOn(roots, "worktreeRoot").mockResolvedValue(null);
    await mkdir(f.configDir, { recursive: true });
    await writeFile(join(f.configDir, "config.json"), JSON.stringify({ docRoots: [source] }));
    await writeFile(join(f.dir, "instance.json"), JSON.stringify({ id: randomUUID() }));
    const sources = {
      "default.html": '<meta name="recense-look" content="recense"><x-extra></x-extra>',
      "custom.html": '<meta name="recense-look" content="custom"><style>p{}</style><x-extra></x-extra>',
      "light.html": "<style>p{color:#222}</style><x-extra></x-extra>",
      "failed.html": "<h1>Fails remotely</h1>",
      "plan.md": "# Plan",
    };
    for (const [path, text] of Object.entries(sources)) await writeFile(join(source, path), text);
    const htmlLooks =
      mode === "different"
        ? [
            { path: "default.html", look: "custom" },
            { path: "custom.html", look: "recense" },
          ]
        : mode === "scheme-omitted"
          ? [{ path: "light.html", look: "recense" }]
          : mode === "scheme-added"
            ? [{ path: "default.html", look: "recense", colorScheme: "light" }]
            : [];
    const response = {
      reviewId: randomUUID(),
      revision: 1,
      placed: 0,
      unplaced: 0,
      unrendered: ["failed.html", "plan.md"],
      ...(mode === "legacy" ? {} : { htmlLooks }),
      url: "http://127.0.0.1:3636/r/synthetic",
    };
    f.setResponse(async (_url, init) => {
      if (init?.method === "HEAD" || init?.method === "PUT") return new Response(null, { status: 204 });
      return Response.json(response);
    });
    await publishCommand(
      f.dir,
      f.configDir,
      [...Object.keys(sources), "--title", "Synthetic", "--key", "synthetic", "--json"],
      f.io,
      source,
    );
    expect(f.stdout).toEqual([`${JSON.stringify(PublishResponse.parse(response))}\n`]);
    expect(f.stderr.filter((line) => line.includes(" shows "))).toEqual([
      ...(mode === "different"
        ? ["recense: custom.html shows in recense's look\n", "recense: default.html shows as a custom page\n"]
        : []),
      ...(mode === "scheme-added"
        ? [
            "recense: default.html shows in recense's look\n",
            "recense: default.html shows in light mode, also while recense is dark: its styles set colours but have no dark-mode rule; add a prefers-color-scheme: dark rule in a style element so it follows dark mode\n",
          ]
        : []),
      ...(mode === "legacy"
        ? []
        : ["recense: failed.html shows as a custom page: recense could not read its structure\n"]),
      ...(mode === "scheme-omitted" ? ["recense: light.html shows in recense's look\n"] : []),
    ]);
    expect(f.stderr.join("")).not.toContain("uses elements outside");
    expect(f.stderr.filter((line) => line.includes("could not render"))).toEqual([
      "recense: could not render plan.md\n",
    ]);
  },
);

test("source HTML and Markdown publish without look diagnostics", async () => {
  const f = await commandFixture();
  const source = await realpath(await mkdtemp(join(tmpdir(), "recense-pub-source-")));
  onTestFinished(() => rm(source, { recursive: true, force: true }));
  vi.spyOn(roots, "worktreeRoot").mockResolvedValue(null);
  await mkdir(f.configDir, { recursive: true });
  await writeFile(join(f.configDir, "config.json"), JSON.stringify({ docRoots: [source] }));
  await writeFile(join(f.dir, "instance.json"), JSON.stringify({ id: randomUUID() }));
  await writeFile(join(source, "page.html"), "<h1>Plan</h1>");
  await writeFile(join(source, "plan.md"), "# Plan");
  f.setResponse(async (_url, init) => {
    if (init?.method === "HEAD") return new Response(null, { status: 204 });
    return Response.json({
      reviewId: randomUUID(),
      revision: 1,
      placed: 0,
      unplaced: 0,
      unrendered: [],
      url: "http://127.0.0.1:3636/r/synthetic",
    });
  });
  await publishCommand(
    f.dir,
    f.configDir,
    ["page.html", "plan.md", "--source", "--title", "Synthetic", "--key", "synthetic"],
    f.io,
    source,
  );
  expect(f.stderr.some((line) => line.includes(" shows ") || line.includes("page structure"))).toBe(false);
  expect(f.stdout).toEqual(["http://127.0.0.1:3636/r/synthetic\n"]);
});

test("help lists the project option for both publish forms", async () => {
  const stdout: string[] = [];
  const stderr = vi.fn();
  expect(await run(["--help"], { stdout: (line) => stdout.push(line), stderr, env: {} })).toBe(0);
  const forms = stdout
    .join("")
    .split("\n")
    .filter((line) => line.includes("recense publish"));
  expect(forms).toHaveLength(2);
  expect(forms.every((line) => line.endsWith("[--project NAME]"))).toBe(true);
  expect(stderr).not.toHaveBeenCalled();
});

test.each([["plan.md"], ["--manifest", "review.json"]])("project option works with %j", (...args) => {
  expect(parsePublishArgs([...args, "--project", "  Synthetic project  "]).project).toBe("Synthetic project");
  expect(parsePublishArgs([...args, "--project", "x".repeat(200)]).project).toHaveLength(200);
  for (const name of [
    "",
    "   ",
    "x".repeat(201),
    "bad\u0000name",
    "bad\u001fname",
    "bad\u007fname",
    "\nname",
    "name\t",
  ])
    expect(() => parsePublishArgs([...args, "--project", name])).toThrow("invalid project name");
  expect(() => parsePublishArgs([...args, "--project", "One", "--project", "Two"])).toThrow("duplicate publish option");
  expect(() => parsePublishArgs([...args, "--project"])).toThrow("usage:");
});

test.each([
  ["Unexpected token ] in JSON at position 9", " (line 2, column 8)"],
  ["Expected property name at position 9 (line 2 column 8)", " (line 2, column 8)"],
  ["Unexpected end of JSON input", ""],
  ["Unexpected token ] in JSON at position 99", ""],
  ['Unexpected token, "position 9 (line 2 column 8)" is not valid JSON', ""],
])("manifest JSON diagnostics use only an engine location: %s", (engineMessage, suffix) => {
  expect(manifestJsonError(new SyntaxError(engineMessage), '{\n  "x": ]\n}')).toBe(
    `the manifest is not valid JSON${suffix}`,
  );
});

test.each([
  { endings: "CR-only", text: '{\r "x":1,\r}', position: 10, line: 3, column: 1 },
  { endings: "CRLF", text: '{\r\n "x":1,\r\n}', position: 12, line: 3, column: 1 },
  { endings: "mixed", text: '{\r\n "x":1,\r "y":2,\n  }', position: 21, line: 4, column: 3 },
])("manifest JSON positions count $endings line endings", ({ text, position, line, column }) => {
  expect(manifestJsonError(new SyntaxError(`Unexpected token } in JSON at position ${position}`), text)).toBe(
    `the manifest is not valid JSON (line ${line}, column ${column})`,
  );
});

test("publish with closed stdout exits 1 with one diagnostic", async () => {
  const f = await commandFixture();
  const manifest = join(f.dir, "manifest.json");
  await writeFile(
    manifest,
    JSON.stringify({
      version: 1,
      title: "Synthetic",
      topics: [],
      files: [],
      writeup: { overview: "", tldr: "", decisions: null, topics: {} },
    }),
  );
  await writeFile(join(f.dir, "instance.json"), JSON.stringify({ id: randomUUID() }));
  const reviewId = randomUUID();
  f.setResponse(async () =>
    Response.json({
      reviewId,
      revision: 1,
      placed: 0,
      unplaced: 0,
      unrendered: ["synthetic.md"],
      url: `http://127.0.0.1:3636/r/${reviewId}`,
    }),
  );
  const closed = new Writable({
    write(_chunk, _encoding, callback) {
      callback();
    },
  });
  closed.on("error", () => {});
  closed.destroy();
  f.io.stdoutAsync = (line) =>
    new Promise<void>((resolve, reject) => {
      closed.write(line, (error) => (error ? reject(error) : resolve()));
    });
  expect(await run(["publish", "--manifest", manifest, "--key", "synthetic"], f.io)).toBe(1);
  expect(f.stdout).toEqual([]);
  expect(f.stderr).toEqual(["recense: Could not write to stdout.\n"]);
});
test("publish deadlines include the slot, counting, one render pass and three placement attempts", () => {
  expect(publishTimeoutMs([])).toBe(165000);
  expect(
    publishTimeoutMs([
      { role: "doc", path: "one.md" },
      { role: "doc", path: "two.markdown" },
      { role: "doc", path: "page.html" },
      { role: "diff", path: "source.md" },
    ]),
  ).toBe(185000);
});
test("publish stdout is exactly one JSON line and unchanged docs upload nothing twice", async () => {
  const dir = await realpath(await mkdtemp(join(tmpdir(), "recense-command-")));
  const state = await mkdtemp(join(tmpdir(), "recense-command-state-"));
  const configHome = await mkdtemp(join(tmpdir(), "recense-config-"));
  const configDir = join(configHome, "recense");
  try {
    const docs = join(dir, "docs");
    await mkdir(docs);
    await promisify(execFile)("git", ["init", dir], {
      env: {
        PATH: process.env.PATH,
        HOME: dir,
        LC_ALL: "C",
        GIT_CONFIG_GLOBAL: "/dev/null",
        GIT_CONFIG_NOSYSTEM: "1",
      },
    });
    await writeFile(join(state, "agent.token"), `em_${"a".repeat(43)}`, { mode: 0o600 });
    await writeFile(join(state, "instance.json"), JSON.stringify({ id: randomUUID() }));
    await mkdir(configDir, { recursive: true, mode: 0o700 });
    await writeFile(join(configDir, "config.json"), JSON.stringify({ docRoots: [docs] }));
    const input: PublishManifest = {
      version: 1,
      title: "Synthetic",
      topics: [],
      files: [{ path: "plan.md", role: "doc", source: "docs/plan.md" }],
      writeup: { overview: "hi", tldr: "short", decisions: null, topics: {} },
    };
    const path = join(dir, "manifest.json");
    await writeFile(path, JSON.stringify(input));
    await writeFile(join(docs, "plan.md"), "# Plan");
    const proof = provenTestServer(state);
    const blobs = new Set<string>();
    const reviewId = randomUUID();
    let revision = 0;
    let puts = 0;
    vi.stubGlobal("fetch", async (url: string | URL, init?: RequestInit) => {
      const proven = proof(url, init);
      if (proven) return proven;
      if (init?.method === "HEAD") return new Response(null, { status: blobs.has(String(url)) ? 204 : 404 });
      if (init?.method === "PUT") {
        puts++;
        blobs.add(String(url));
        return new Response(null, { status: 204 });
      }
      const request = PublishRequest.parse(JSON.parse(String(init?.body)));
      if (revision === 1)
        expect(request.repo).toEqual({ key: projectKey("Synthetic project"), name: "Synthetic project" });
      return Response.json({
        reviewId,
        revision: ++revision,
        placed: 0,
        unplaced: 0,
        unrendered: revision === 2 ? ["plan.md"] : [],
        url: `http://127.0.0.1:3636/r/${reviewId}`,
      });
    });
    for (let i = 1; i <= 2; i++) {
      const stdout: string[] = [];
      const stderr: string[] = [];
      await publishCommand(
        state,
        configDir,
        ["--manifest", path, "--key", "plan", ...(i === 2 ? ["--project", "Synthetic project"] : [])],
        {
          stdout: (s) => stdout.push(s),
          stderr: (s) => stderr.push(s),
          env: { RECENSE_HOME: state, XDG_CONFIG_HOME: configHome },
        },
        dir,
      );
      expect(stdout).toHaveLength(1);
      expect(stdout[0]?.split("\n")).toHaveLength(2);
      expect(JSON.parse(stdout[0] ?? "")).toMatchObject({ reviewId, revision: i });
      expect(stderr).toEqual([
        ...(i === 2 ? ["recense: could not render plan.md\n"] : []),
        `recense: published revision ${i}: http://127.0.0.1:3636/r/${reviewId}\n`,
      ]);
    }
    expect(puts).toBe(1);
  } finally {
    await rm(state, { recursive: true, force: true });
    await rm(configHome, { recursive: true, force: true });
    await rm(dir, { recursive: true, force: true });
  }
});
test("docs-only without a key, malformed manifests and unknown reviews fail with one stderr line", async () => {
  const dir = await mkdtemp(join(tmpdir(), "recense-command-errors-"));
  try {
    const path = join(dir, "manifest.json");
    await writeFile(
      path,
      JSON.stringify({
        version: 1,
        title: "Synthetic",
        topics: [],
        files: [],
        writeup: { overview: "", tldr: "", decisions: null, topics: {} },
      }),
    );
    const proof = provenTestServer(dir);
    await writeFile(join(dir, "agent.token"), `em_${"a".repeat(43)}`, { mode: 0o600 });
    await writeFile(join(dir, "instance.json"), JSON.stringify({ id: randomUUID() }));
    vi.stubGlobal(
      "fetch",
      async (url: string | URL, init?: RequestInit) =>
        proof(url, init) ??
        Response.json({ error: { code: "unknown_review", message: "untrusted\nmessage" } }, { status: 404 }),
    );
    for (const [args, expected] of [
      [["--manifest", path], "recense: pass --review or --key\n"],
      [["--manifest", path, "--review", randomUUID()], "recense: unknown_review\n"],
      [["--manifest", join(dir, "missing")], `recense: manifest not found: ${join(dir, "missing")}\n`],
    ] as const) {
      const stdout: string[] = [];
      const stderr: string[] = [];
      expect(
        await run(["publish", ...args], {
          stdout: (s) => stdout.push(s),
          stderr: (s) => stderr.push(s),
          env: { RECENSE_HOME: dir },
        }),
      ).toBe(1);
      expect(stdout).toEqual([]);
      expect(stderr).toEqual([expected]);
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test.each(["missing", "non-directory parent", "directory", "empty", "truncated", "secret-looking", "oversized"])(
  "a %s manifest fails with one safe diagnostic and creates no review",
  async (kind) => {
    const f = await commandFixture();
    const root = await mkdtemp(join(tmpdir(), "recense-manifest-repo-"));
    onTestFinished(() => rm(root, { recursive: true, force: true }));
    await promisify(execFile)("git", ["-c", "init.templateDir=", "init", root], {
      env: {
        PATH: process.env.PATH,
        HOME: root,
        LC_ALL: "C",
        GIT_CONFIG_GLOBAL: "/dev/null",
        GIT_CONFIG_NOSYSTEM: "1",
      },
    });
    vi.spyOn(process, "cwd").mockReturnValue(root);
    const name = kind === "non-directory parent" ? "plain/review.json" : "review.json";
    const path = join(f.dir, name);
    const secret = `emp_${"a".repeat(43)}`;
    let expected: string;
    if (kind === "missing" || kind === "non-directory parent" || kind === "directory") {
      if (kind === "non-directory parent") await writeFile(join(f.dir, "plain"), "Synthetic file");
      if (kind === "directory") await mkdir(path);
      expected = `recense: manifest not found: ${path}\n`;
    } else if (kind === "oversized") {
      await writeFile(path, "");
      await truncate(path, LIMITS.publishJsonBytes + 1);
      expected = "recense: manifest exceeds its size limit\n";
    } else {
      const content =
        kind === "empty"
          ? ""
          : kind === "truncated"
            ? '{\n  "version": 1,\n  "title": "Synthetic"'
            : `{"title":"${secret}" broken}`;
      await writeFile(path, content);
      expected =
        kind === "empty"
          ? "recense: the manifest is not valid JSON\n"
          : kind === "truncated"
            ? "recense: the manifest is not valid JSON (line 3, column 23)\n"
            : "recense: the manifest is not valid JSON (line 1, column 60)\n";
    }
    expect(await run(["publish", "--manifest", path, "--key", "synthetic"], f.io)).toBe(1);
    expect(f.stdout).toEqual([]);
    expect(f.stderr).toEqual([expected]);
    expect(f.stderr.join("")).not.toContain(secret);
    expect(f.stderr.join("").split("\n")).toHaveLength(2);
    expect(f.fetcher).not.toHaveBeenCalled();
    await expect(stat(join(f.dir, "recense.db"))).rejects.toMatchObject({ code: "ENOENT" });
  },
);

test("a missing manifest escapes the supplied path on one line", async () => {
  const f = await commandFixture();
  const root = await mkdtemp(join(tmpdir(), "recense-manifest-repo-"));
  onTestFinished(() => rm(root, { recursive: true, force: true }));
  await promisify(execFile)("git", ["-c", "init.templateDir=", "init", root], {
    env: {
      PATH: process.env.PATH,
      HOME: root,
      LC_ALL: "C",
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_CONFIG_NOSYSTEM: "1",
    },
  });
  vi.spyOn(process, "cwd").mockReturnValue(root);
  expect(await run(["publish", "--manifest", "missing\u2028.json", "--key", "synthetic"], f.io)).toBe(1);
  expect(f.stdout).toEqual([]);
  expect(f.stderr).toEqual(["recense: manifest not found: missing\\u{2028}.json\n"]);
  expect(f.fetcher).not.toHaveBeenCalled();
  await expect(stat(join(f.dir, "recense.db"))).rejects.toMatchObject({ code: "ENOENT" });
});

test("a 200 with an invalid publish response reports possible publication on one stderr line", async () => {
  const dir = await mkdtemp(join(tmpdir(), "recense-command-answer-"));
  try {
    const path = join(dir, "manifest.json");
    await writeFile(
      path,
      JSON.stringify({
        version: 1,
        title: "Synthetic",
        topics: [],
        files: [],
        writeup: { overview: "", tldr: "", decisions: null, topics: {} },
      }),
    );
    await writeFile(join(dir, "agent.token"), `em_${"a".repeat(43)}`, { mode: 0o600 });
    await writeFile(join(dir, "instance.json"), JSON.stringify({ id: randomUUID() }));
    const proof = provenTestServer(dir);
    vi.stubGlobal(
      "fetch",
      async (url: string | URL, init?: RequestInit) =>
        proof(url, init) ?? Response.json({ revision: "invalid", message: "untrusted\nmessage" }),
    );
    const stdout: string[] = [];
    const stderr: string[] = [];
    expect(
      await run(["publish", "--manifest", path, "--key", "docs"], {
        stdout: (s) => stdout.push(s),
        stderr: (s) => stderr.push(s),
        env: { RECENSE_HOME: dir },
      }),
    ).toBe(1);
    expect(stdout).toEqual([]);
    expect(stderr).toEqual(["recense: the server's answer was cut off; the revision may have been published\n"]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
