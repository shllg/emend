// pnpm screenshots: a sealed demo review round that captures the README and tour screenshots.
//
// Everything runs under one throwaway root: a server from this checkout's build, fixture git repos,
// the CLI, and a Chromium profile. No child inherits the parent environment, the browser reaches
// only the sealed origin, and the real emend server and state are never touched. The guards live in
// ./screenshots/safety.ts and are covered by scripts/screenshots.test.ts.
import { type ChildProcess, execFileSync, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { request } from "node:http";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { writeImages } from "./screenshots/images.ts";
import { Browser, DESKTOP, findChromium, type Page, PHONE } from "./screenshots/browser.ts";
import {
  applyFixture,
  BASE,
  BLOB_BRANCH,
  COMMENTS,
  DRAFTS_BRANCH,
  IDENTITY,
  INSTANCE_ID,
  MAIN_BRANCH,
  MAIN_FIX,
  MAIN_ISSUE,
  MAIN_TITLE,
  MAIN_TOPIC_TEXT,
  MAIN_TOPICS,
  mainTldr,
  mainWriteup,
  REMOTE_URL,
  REPLIES,
  type RepoPlan,
  smallReview,
} from "./screenshots/content.ts";
import {
  assertOutputFolder,
  assertPortAvailable,
  assertSealedPaths,
  canonicalPath,
  childEnvironment,
  currentProtectedStateDirs,
  filterPng,
  parsePairingLink,
  sealedOrigin,
} from "./screenshots/safety.ts";

const here = dirname(fileURLToPath(import.meta.url));
const checkout = resolve(here, "..");
const fixturesDir = join(here, "screenshots", "fixtures");
const entry = join(checkout, "apps", "emend", "dist", "emend.mjs");

interface Options {
  keep: boolean;
  out: string;
  chromium: string | undefined;
}

function parseArgs(argv: string[]): Options {
  const options: Options = { keep: false, out: join(checkout, "docs", "images"), chromium: undefined };
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    if (flag === "--keep") options.keep = true;
    else if (flag === "--out" && argv[i + 1]) options.out = resolve(argv[++i] as string);
    else if (flag === "--chromium" && argv[i + 1]) options.chromium = resolve(argv[++i] as string);
    else throw new Error("Usage: node scripts/screenshots.ts [--keep] [--out <dir>] [--chromium <path>]");
  }
  return options;
}

// Every child, with whether it leads its own process group (Chromium does, so its helpers die too).
const children = new Map<ChildProcess, boolean>();
let root: string | undefined;
let keep = false;
let cleaning: Promise<void> | undefined;
let aborted = false;

function assertRunning(): void {
  if (aborted) throw new Error("The run is ending");
}

function track(child: ChildProcess, group = false): void {
  children.set(child, group);
  // A child that appears after cleanup began is never left running.
  if (aborted) signalChild(child, "SIGKILL");
}

function signalChild(child: ChildProcess, signal: NodeJS.Signals): void {
  try {
    if (children.get(child) && child.pid) process.kill(-child.pid, signal);
    else if (child.exitCode === null && child.signalCode === null) child.kill(signal);
  } catch {
    // Already gone.
  }
}

function removeRoot(): void {
  if (!root || keep) return;
  try {
    rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  } catch {
    // Never replace the original error; say where the leftovers are.
    console.error(`screenshots: could not remove ${root}`);
  }
}

/** Resolves when every tracked child has exited, or after `ms`, whichever is first. */
async function childrenExited(ms: number): Promise<void> {
  const exited = [...children.keys()].map(
    (child) =>
      new Promise<void>((resolve) => {
        if (child.exitCode !== null || child.signalCode !== null) resolve();
        else child.once("exit", () => resolve());
      }),
  );
  let timer: NodeJS.Timeout | undefined;
  await Promise.race([
    Promise.all(exited),
    new Promise<void>((resolve) => {
      timer = setTimeout(resolve, ms);
    }),
  ]);
  clearTimeout(timer);
}

async function doCleanup(): Promise<void> {
  aborted = true;
  for (const child of children.keys()) signalChild(child, "SIGTERM");
  await childrenExited(4000);
  // Kill whatever is left, and sweep each process group once more for helpers.
  for (const child of children.keys()) signalChild(child, "SIGKILL");
  await childrenExited(5000);
  removeRoot();
  if (root && keep) console.log(`Kept the sealed folder: ${root}`);
}

/** One cleanup for the whole process: every caller awaits the same promise. */
const cleanup = (): Promise<void> => {
  cleaning ??= doCleanup();
  return cleaning;
};

// One exit decision: the first reason wins (signal, fatal error or success), and the process exits
// once, after cleanup finished.
let exitCode: number | undefined;
let exiting = false;
function terminate(code: number): void {
  exitCode ??= code;
  if (exiting) return;
  exiting = true;
  void cleanup().finally(() => process.exit(exitCode));
}

for (const [signal, code] of [
  ["SIGINT", 130],
  ["SIGTERM", 143],
  ["SIGHUP", 129],
] as const) {
  process.on(signal, () => terminate(code));
}
for (const event of ["uncaughtException", "unhandledRejection"] as const) {
  process.on(event, () => {
    console.error(`screenshots: ${event}`);
    terminate(1);
  });
}
// A synchronous last resort if the process ends without the async cleanup having finished.
process.on("exit", () => {
  for (const child of children.keys()) signalChild(child, "SIGKILL");
  removeRoot();
});

function step(text: string): void {
  console.log(`- ${text}`);
}

interface RunResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

function run(
  command: string,
  args: string[],
  options: { cwd: string; env: Record<string, string>; input?: string; timeoutMs?: number; group?: boolean },
): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    assertRunning();
    // A command that must not outlive cleanup (the pty and what runs under it) gets its own group.
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: options.env,
      stdio: ["pipe", "pipe", "pipe"],
      detached: options.group === true,
    });
    track(child, options.group === true);
    // A command that never ends is killed; the caller reports the exit code only.
    const timer = setTimeout(() => signalChild(child, "SIGKILL"), options.timeoutMs ?? 120_000);
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8").on("data", (chunk: string) => (stdout += chunk));
    child.stderr.setEncoding("utf8").on("data", (chunk: string) => (stderr += chunk));
    child.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once("close", (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr });
    });
    child.stdin.end(options.input ?? "");
  });
}

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : 0;
      server.close(() => resolve(port));
    });
  });
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  keep = options.keep;
  if (!existsSync(entry)) throw new Error("The CLI is not built. Run pnpm build first (pnpm screenshots does).");

  // ---- The sealed root --------------------------------------------------------------------
  const realStateDirs = currentProtectedStateDirs();
  assertOutputFolder(options.out, realStateDirs, canonicalPath);
  const tmpDir = realpathSync(tmpdir());
  root = mkdtempSync(join(tmpDir, "emend-screenshots-"));
  const sealedRoot = root;
  const env = childEnvironment(sealedRoot, process.platform);
  for (const key of ["HOME", "XDG_CONFIG_HOME", "XDG_DATA_HOME", "XDG_STATE_HOME", "XDG_CACHE_HOME", "TMPDIR"])
    mkdirSync(env[key] as string, { recursive: true });
  mkdirSync(env.XDG_RUNTIME_DIR as string, { recursive: true, mode: 0o700 });
  mkdirSync(env.EMEND_HOME as string, { recursive: true, mode: 0o700 });
  assertSealedPaths(
    {
      root: sealedRoot,
      tmpDir,
      emendHome: env.EMEND_HOME as string,
      realStateDirs,
    },
    canonicalPath,
  );
  writeFileSync(
    env.GIT_CONFIG_GLOBAL as string,
    `[user]\n\tname = ${IDENTITY.name}\n\temail = ${IDENTITY.email}\n[commit]\n\tgpgsign = false\n[tag]\n\tgpgsign = false\n` +
      "[init]\n\tdefaultBranch = main\n[advice]\n\tdetachedHead = false\n",
  );

  const port = await freePort();
  await assertPortAvailable(port);
  const origin = sealedOrigin(port);
  writeFileSync(
    join(env.EMEND_HOME as string, "instance.json"),
    JSON.stringify({ id: INSTANCE_ID, name: "laptop" }),
    { mode: 0o600 },
  );

  // ---- The server -------------------------------------------------------------------------
  step("starting a sealed server");
  assertRunning();
  const server = spawn(process.execPath, [entry, "serve", "--port", String(port)], {
    cwd: sealedRoot,
    env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  track(server);
  let serverLog = "";
  server.stdout.setEncoding("utf8").on("data", (chunk: string) => (serverLog += chunk));
  server.stderr.setEncoding("utf8").on("data", (chunk: string) => (serverLog += chunk));
  const serverAlive = () => {
    if (server.exitCode !== null || server.signalCode !== null)
      throw new Error(`The sealed server stopped: ${serverLog.trim().slice(-300)}`);
  };
  for (let i = 0; ; i++) {
    serverAlive();
    if (serverLog.includes(`emend is serving ${origin}`)) break;
    if (i > 300) throw new Error("The sealed server did not start");
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  // node:http to the literal loopback address: no redirects, no proxy environment, no resolver.
  const status = await new Promise<number>((resolve, reject) => {
    const probe = request(
      { host: "127.0.0.1", port, path: "/api/v1/capabilities", method: "GET", agent: false, timeout: 10_000 },
      (response) => {
        response.resume();
        resolve(response.statusCode ?? 0);
      },
    );
    probe.once("timeout", () => probe.destroy(new Error("The sealed server did not answer")));
    probe.once("error", reject);
    probe.end();
  });
  if (status !== 200) throw new Error("The sealed server does not answer");
  const record = JSON.parse(readFileSync(join(env.EMEND_HOME as string, "server.json"), "utf8")) as { url?: string };
  if (new URL(record.url ?? "http://invalid").origin !== origin)
    throw new Error("The sealed server record names another URL");

  const cli = async (args: string[], cwd: string, timeoutMs?: number): Promise<string> => {
    serverAlive();
    const result = await run(process.execPath, [entry, ...args], { cwd, env, ...(timeoutMs ? { timeoutMs } : {}) });
    if (result.code !== 0) throw new Error(`emend ${args[0]} failed: ${result.stderr.trim().slice(0, 300)}`);
    return result.stdout;
  };
  const git = (cwd: string, ...args: string[]): string => {
    assertRunning();
    return execFileSync("git", args, { cwd, env, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  };

  // ---- Fixture repositories ---------------------------------------------------------------
  step("building fixture repositories");
  const reposDir = join(sealedRoot, "repos");
  const repo = join(reposDir, "emend");
  mkdirSync(repo, { recursive: true });
  git(repo, "init", "-q");
  git(repo, "remote", "add", "origin", REMOTE_URL);
  const commit = (fixture: string, message: string) => {
    applyFixture(fixturesDir, fixture, repo);
    git(repo, "add", "-A");
    git(repo, "commit", "-q", "-m", message);
  };
  commit(BASE.fixture, BASE.message);
  git(repo, "branch", "-M", "main");
  const baseCommit = git(repo, "rev-parse", "HEAD");
  const buildBranch = (plan: RepoPlan) => {
    git(repo, "checkout", "-q", "-b", plan.branch, baseCommit);
    for (const part of plan.steps) commit(part.fixture, part.message);
    return git(repo, "rev-parse", "HEAD");
  };
  const draftsHead = buildBranch(DRAFTS_BRANCH);
  const blobHead = buildBranch(BLOB_BRANCH);
  const mainHead1 = buildBranch(MAIN_BRANCH);
  commit(MAIN_FIX.fixture, MAIN_FIX.message);
  const mainHead2 = git(repo, "rev-parse", "HEAD");
  git(repo, "checkout", "-q", MAIN_BRANCH.branch);
  git(repo, "reset", "-q", "--hard", mainHead1);

  const notes = join(reposDir, "notes");
  mkdirSync(notes, { recursive: true });
  git(notes, "init", "-q");
  applyFixture(fixturesDir, "notes", notes);
  git(notes, "add", "-A");
  git(notes, "commit", "-q", "-m", "docs: add the first notes");

  const reviewsDir = join(sealedRoot, "reviews");
  mkdirSync(reviewsDir, { mode: 0o700 });
  const folder = (name: string) => {
    const path = join(reviewsDir, name);
    mkdirSync(path, { mode: 0o700 });
    return path;
  };
  const publishManifest = async (name: string, manifest: unknown, extra: string[] = []) => {
    const dir = folder(`${name}-${randomUUID().slice(0, 8)}`);
    const file = join(dir, "review.json");
    writeFileSync(file, JSON.stringify(manifest), { mode: 0o600 });
    const out = await cli(["publish", "--manifest", file, ...extra], manifestRepo);
    return JSON.parse(out.trim().split("\n").at(-1) as string) as { reviewId: string; revision: number; url: string };
  };
  let manifestRepo = repo;

  // ---- Sign in ----------------------------------------------------------------------------
  step("signing in through a pty");
  const pairCommand = [process.execPath, entry, "pair"];
  const quoted = pairCommand.map((part) => `'${part.replaceAll("'", `'\\''`)}'`).join(" ");
  const scriptArgs = process.platform === "darwin" ? ["-q", "/dev/null", ...pairCommand] : ["-qec", quoted, "/dev/null"];
  serverAlive();
  const paired = await run("script", scriptArgs, { cwd: sealedRoot, env, timeoutMs: 60_000, group: true });
  if (paired.code !== 0) throw new Error(`The pairing command exited with code ${paired.code}`);
  const link = parsePairingLink(paired.stdout, origin);

  step("starting a sealed browser");
  assertRunning();
  const executable = findChromium(options.chromium, process.platform);
  const browser = await Browser.launch({
    executable,
    profile: join(sealedRoot, "chromium"),
    env,
    port,
    platform: process.platform,
    onSpawn: (child) => track(child, true),
  });
  const desktop = await browser.newPage(DESKTOP);
  await desktop.goto(link);
  await desktop.waitFor("location.pathname === '/'", "the signed-in inbox");
  await desktop.settle("the empty inbox");

  const api = async (page: Page, method: string, path: string, body?: unknown) => {
    const result = await page.eval<{ status: number; text: string }>(
      `(async () => { const response = await fetch(${JSON.stringify(path)}, { method: ${JSON.stringify(method)}, ` +
        `headers: { 'content-type': 'application/json' }${body === undefined ? "" : `, body: ${JSON.stringify(JSON.stringify(body))}`} }); ` +
        "return { status: response.status, text: await response.text() }; })()",
    );
    if (result.status >= 300) throw new Error(`${method} ${path} answered ${result.status}: ${result.text.slice(0, 300)}`);
    return result.text ? (JSON.parse(result.text) as Record<string, unknown>) : {};
  };

  // ---- The other inbox items --------------------------------------------------------------
  const lineTarget = (ref: string, path: string, start: number, end: number) => {
    const lines = git(repo, "show", `${ref}:${path}`).split("\n");
    return {
      kind: "lines" as const,
      side: "new" as const,
      path,
      start,
      end,
      lines: lines.slice(start - 1, end),
      before: lines.slice(Math.max(0, start - 4), start - 1),
      after: lines.slice(end, end + 3),
    };
  };
  const lineOf = (ref: string, path: string, needle: string) => {
    const index = git(repo, "show", `${ref}:${path}`)
      .split("\n")
      .findIndex((line) => line.includes(needle));
    if (index < 0) throw new Error(`Fixture line not found in ${path}`);
    return index + 1;
  };

  step("publishing the other reviews");
  manifestRepo = repo;
  git(repo, "checkout", "-q", DRAFTS_BRANCH.branch);
  const drafts = await publishManifest("drafts", {
    ...smallReview(
      "Keep a draft comment when a new revision arrives",
      {
        slug: "drafts",
        title: "Drafts move to the newest revision",
        summary: "A comment you are still writing is carried to the newest revision instead of being lost.",
      },
      ["apps/web/src/lib/drafts.ts"],
    ),
    base: baseCommit,
    head: draftsHead,
  });
  git(repo, "checkout", "-q", BLOB_BRANCH.branch);
  const blobs = await publishManifest("blobs", {
    ...smallReview(
      "Split the blob store into read and write paths",
      {
        slug: "blobs",
        title: "Read and write paths",
        summary: "BlobReader serves reads; BlobWriter extends it with the atomic write.",
      },
      ["apps/emend/src/blobs/read.ts", "apps/emend/src/blobs/write.ts"],
    ),
    base: baseCommit,
    head: blobHead,
  });
  manifestRepo = notes;
  await publishManifest(
    "offline",
    {
      version: 1,
      title: "Plan: read reviews offline on the phone",
      topics: [],
      files: [{ path: "plans/offline-phone.md", role: "doc" }],
      writeup: { overview: "", tldr: "", decisions: null, topics: {} },
    },
    ["--key", "offline-phone-plan-2026-11-05"],
  );
  const publishDoc = async (path: string, title: string) => {
    const out = await cli(["publish", path, "--title", title, "--json"], notes);
    return JSON.parse(out.trim().split("\n").at(-1) as string) as { reviewId: string; url: string };
  };
  await publishDoc("release-notes-0.9.md", "Release notes for 0.9");
  const trouble = await publishDoc("troubleshooting-service-macos.md", "Troubleshooting: service install on macOS");

  // ---- The main review --------------------------------------------------------------------
  step(`publishing the main review (#${MAIN_ISSUE}), revision 1`);
  manifestRepo = repo;
  git(repo, "checkout", "-q", MAIN_BRANCH.branch);
  const planPath = "docs/plans/review-pins.md";
  const fileTopics: Record<string, string> = {
    "apps/emend/drizzle/0012_review_pins.sql": "migration",
    "apps/emend/src/db/schema.ts": "migration",
    "apps/emend/src/server/routes/pins.ts": "api",
    "apps/emend/src/server/routes/reviews.ts": "api",
    "packages/contract/src/review.ts": "api",
    "docs/api.md": "api",
    "apps/web/src/lib/inbox-order.ts": "inbox",
    "apps/web/src/components/inbox/ReviewRow.tsx": "inbox",
    "apps/emend/src/server/routes/pins.test.ts": "tests",
    "apps/web/src/lib/inbox-order.test.ts": "tests",
    [planPath]: "inbox",
  };
  const mainManifest = (revision: 1 | 2) => {
    const head = revision === 1 ? mainHead1 : mainHead2;
    const files: unknown[] = Object.entries(fileTopics).map(([path, topic]) => {
      const notesFor: unknown[] = [];
      if (path.endsWith("pins.ts"))
        notesFor.push({
          side: "new",
          start: lineOf(head, path, "if (pinned >= PIN_LIMIT)"),
          end: lineOf(head, path, "if (pinned >= PIN_LIMIT)"),
          summary: "The count and the update share one transaction, so two pins cannot pass the limit together.",
          rationale: "Counting outside the transaction would let two concurrent pins both see ten.",
        });
      if (path.endsWith("routes/reviews.ts"))
        notesFor.push({
          side: "new",
          start: lineOf(head, path, "state,"),
          end: lineOf(head, path, "snoozedUntil: null,"),
          summary: "Retire and approve share this one update.",
          rationale: "Anything a closed review must reset belongs here, in the same statement.",
        });
      if (path.endsWith("inbox-order.ts"))
        notesFor.push({
          side: "new",
          start: lineOf(head, path, "return ga === \"open\""),
          end: lineOf(head, path, "return ga === \"open\""),
          summary: "Only the Open group uses the pin order.",
        });
      return { path, role: "diff", topic, ...(notesFor.length ? { notes: notesFor } : {}) };
    });
    files.push({ path: planPath, role: "doc", topic: "inbox" });
    return {
      version: 1,
      title: MAIN_TITLE,
      base: baseCommit,
      head,
      main: "writeup",
      topics: MAIN_TOPICS,
      files,
      writeup: {
        overview: mainWriteup(revision),
        tldr: mainTldr(revision),
        decisions: null,
        topics: Object.fromEntries(Object.entries(MAIN_TOPIC_TEXT).map(([slug, why]) => [slug, { why }])),
      },
    };
  };
  const reviewFolder = folder("main");
  const manifestFile = join(reviewFolder, "review.json");
  writeFileSync(manifestFile, JSON.stringify(mainManifest(1)), { mode: 0o600 });
  const published = JSON.parse((await cli(["publish", "--manifest", manifestFile], repo)).trim().split("\n").at(-1) as string) as {
    reviewId: string;
  };
  const reviewId = published.reviewId;

  step("an agent waits for the Send");
  const waitSaved = join(reviewFolder, "wait-1");
  mkdirSync(waitSaved, { mode: 0o700 });
  const firstWait = cli(["wait", reviewId, "--timeout", "300", "--save", waitSaved], repo, 330_000);
  firstWait.catch(() => undefined);

  // Reviewer comments, through the signed-in browser session.
  step("the reviewer leaves three comments");
  const revisionView = (await api(desktop, "GET", `/api/v1/reviews/${reviewId}/revisions/1`)) as {
    docs: { path: string; kind: string; blocks?: { id: string; text: string }[] }[];
  };
  const limitsBlock = revisionView.docs
    .find((doc) => doc.path === planPath)
    ?.blocks?.find((block) => block.text.startsWith("Each owner can pin at most ten reviews."));
  if (!limitsBlock) throw new Error("The Limits paragraph is missing from the rendered plan");
  const limitsQuote = "Each owner can pin at most ten reviews.";
  const retireStart = lineOf(mainHead1, "apps/emend/src/server/routes/reviews.ts", "state,");
  const sortLine = lineOf(mainHead1, "apps/web/src/lib/inbox-order.ts", "return ga === \"open\"");
  const threadIds: Record<string, string> = {};
  const comment = async (key: keyof typeof COMMENTS, target: unknown) => {
    const created = (await api(desktop, "POST", `/api/v1/reviews/${reviewId}/threads`, {
      revision: 1,
      target,
      body: COMMENTS[key],
    })) as { threadId: string };
    threadIds[key] = created.threadId;
  };
  await comment("retire", lineTarget(mainHead1, "apps/emend/src/server/routes/reviews.ts", retireStart, retireStart + 1));
  await comment("sort", lineTarget(mainHead1, "apps/web/src/lib/inbox-order.ts", sortLine, sortLine));
  await comment("limits", {
    kind: "doc-span",
    path: planPath,
    blockId: limitsBlock.id,
    quote: limitsQuote,
    prefix: "",
    suffix: limitsBlock.text.slice(limitsQuote.length, limitsQuote.length + 32),
  });

  const shots: Record<string, Buffer> = {};
  const reviewUrl = (query: string) => `${origin}/r/${reviewId}${query}`;

  step("capturing the Send panel");
  await desktop.goto(reviewUrl("?tab=comments&rev=1"));
  await desktop.waitFor("document.body.innerText.includes('3 unsent comments')", "three unsent comments");
  await desktop.settle("the comments tab");
  shots["send-desktop.png"] = await desktop.screenshot();

  step("pressing Send");
  await desktop.eval(
    "(() => { const button = [...document.querySelectorAll('button')].find((b) => /^Send 3/.test(b.innerText.trim())); " +
      "if (!button) throw new Error('no Send button'); button.click(); })()",
  );
  const delivered = JSON.parse((await firstWait).trim()) as {
    kind: string;
    comments: { id: string; body: string }[];
  };
  if (delivered.kind !== "go" || delivered.comments.length !== 3) throw new Error("The agent did not receive the Send");

  step("the agent replies");
  for (const key of ["retire", "sort", "limits"] as const) {
    const found = delivered.comments.find((entry) => entry.body === COMMENTS[key]);
    if (!found) throw new Error("A delivered comment is missing");
    await cli(["reply", found.id, "--status", REPLIES[key].status, "--body", REPLIES[key].body], repo);
  }

  step("publishing revision 2");
  git(repo, "reset", "-q", "--hard", mainHead2);
  writeFileSync(manifestFile, JSON.stringify(mainManifest(2)), { mode: 0o600 });
  await cli(["publish", "--manifest", manifestFile, "--review", reviewId], repo);
  await api(desktop, "POST", `/api/v1/threads/${threadIds.retire}/resolve`);
  const keepWaiting = cli(["wait", reviewId, "--timeout", "600", "--save", waitSaved], repo, 630_000);
  keepWaiting.catch(() => undefined);

  // The other reviews' states, through the same browser session.
  step("approving, sending and retiring the others");
  await api(desktop, "POST", `/api/v1/reviews/${drafts.reviewId}/sends`, { revision: 1, kind: "approve" });
  const blobTarget = lineTarget(
    blobHead,
    "apps/emend/src/blobs/write.ts",
    lineOf(blobHead, "apps/emend/src/blobs/write.ts", "const temporary"),
    lineOf(blobHead, "apps/emend/src/blobs/write.ts", "const temporary"),
  );
  await api(desktop, "POST", `/api/v1/reviews/${blobs.reviewId}/threads`, {
    revision: 1,
    target: blobTarget,
    body: COMMENTS.blob,
  });
  await api(desktop, "POST", `/api/v1/reviews/${blobs.reviewId}/sends`, {
    revision: 1,
    kind: "go",
    mode: "fix-clear",
  });
  await api(desktop, "POST", `/api/v1/reviews/${trouble.reviewId}/retire`);

  // ---- Screenshots ------------------------------------------------------------------------
  // The Done group starts folded; open it so all six reviews show.
  const showDone = async (page: Page) => {
    await page.settle("the inbox");
    await page.eval(
      "(() => { const toggle = [...document.querySelectorAll('button, summary, [role=\"button\"]')]" +
        ".find((element) => /^done/i.test(element.textContent.trim())); " +
        "if (toggle && toggle.getAttribute('aria-expanded') !== 'true') toggle.click(); })()",
    );
    await page.waitFor("document.body.innerText.includes('Troubleshooting: service install on macOS')", "the Done group");
  };

  step("capturing the inbox");
  await desktop.goto(`${origin}/`);
  await desktop.waitFor("document.body.innerText.includes('Release notes for 0.9')", "the inbox rows");
  await showDone(desktop);
  await desktop.settle("the inbox");
  shots["inbox-desktop.png"] = await desktop.screenshot();

  const phone = await browser.newPage(PHONE);
  await phone.goto(`${origin}/`);
  await phone.waitFor("document.body.innerText.includes('Release notes for 0.9')", "the phone inbox rows");
  await showDone(phone);
  await phone.settle("the phone inbox");
  shots["inbox-phone.png"] = await phone.screenshot();

  // Scroll a pane until the element found by `find` (a page expression) sits just below the pane's
  // sticky headers. The header height is measured in the page, never assumed.
  const revealBelowHeaders = async (page: Page, scope: string, find: string, what: string, gap: number) => {
    const root = `document.querySelector(${JSON.stringify(scope)})`;
    const stickyBottom =
      `(() => { const pane = ${root}; const paneTop = pane.getBoundingClientRect().top; let bottom = paneTop; ` +
      "for (const el of pane.querySelectorAll('*')) { if (getComputedStyle(el).position !== 'sticky') continue; " +
      "const rect = el.getBoundingClientRect(); if (rect.top <= paneTop + 400 && rect.bottom > bottom) bottom = rect.bottom; } return bottom; })()";
    await page.waitFor(find, `${what} in its pane`);
    // Diffs above the target load as they scroll into range and move it; repeat until it stays put.
    for (let attempt = 0; attempt < 8; attempt++) {
      const offset = await page.eval<number>(
        `(() => { const delta = (${find}).getBoundingClientRect().top - (${stickyBottom} + ${gap}); ${root}.scrollBy(0, delta); return delta; })()`,
      );
      await page.settle(`${what} in place`);
      if (Math.abs(offset) < 4) return;
    }
    throw new Error(`Could not keep ${what} in place`);
  };
  const withText = (scope: string, selector: string, text: string) =>
    `(() => { const root = document.querySelector(${JSON.stringify(scope)}); if (!root) return null; ` +
    `return [...root.querySelectorAll(${JSON.stringify(selector)})].find((el) => el.textContent.includes(${JSON.stringify(text)})) ?? null; })()`;
  // The deepest element of a pane that shows this text.
  const leafWithText = (scope: string, text: string) =>
    `(() => { const root = document.querySelector(${JSON.stringify(scope)}); if (!root) return null; ` +
    `return [...root.querySelectorAll('*')].find((el) => el.textContent.includes(${JSON.stringify(text)}) && ` +
    `![...el.children].some((child) => child.textContent.includes(${JSON.stringify(text)}))) ?? null; })()`;

  step("capturing the review");
  await desktop.goto(reviewUrl("?rev=2"));
  await desktop.settle("the desktop review");
  // The agent note above the thread must clear the sticky file header, with the thread below it.
  await revealBelowHeaders(
    desktop,
    "[data-diff-scroll]",
    withText("[data-diff-scroll]", "article[data-agent-note]", "Retire and approve share this one update."),
    "the agent note",
    0,
  );
  shots["review-desktop.png"] = await desktop.screenshot();

  await phone.goto(reviewUrl("?rev=2&tab=comments"));
  await phone.settle("the phone review");
  shots["review-phone.png"] = await phone.screenshot();

  step("capturing the plan doc");
  await desktop.goto(reviewUrl(`?rev=2&tab=docs&doc=${encodeURIComponent(planPath)}`));
  await desktop.settle("the plan doc");
  await revealBelowHeaders(
    desktop,
    "[data-reading-scroll]",
    leafWithText("[data-reading-scroll]", "Behaviour"),
    "the Behaviour heading",
    8,
  );
  shots["doc-desktop.png"] = await desktop.screenshot();

  browser.check();
  // Filter every picture first, then replace the whole set or nothing (see images.ts).
  const filtered = Object.entries(shots).map(([name, bytes]) => [name, filterPng(bytes)] as const);
  assertOutputFolder(options.out, realStateDirs, canonicalPath);
  mkdirSync(options.out, { recursive: true });
  assertOutputFolder(options.out, realStateDirs, canonicalPath);
  writeImages(options.out, filtered);
  console.log(`Wrote ${Object.keys(shots).length} screenshots to ${options.out}`);
  await browser.close();
}

await main().then(
  () => terminate(0),
  (error: Error) => {
    // A signal that arrived first already decided the exit; do not add noise to it.
    if (exitCode === undefined) console.error(`screenshots: ${error.message}`);
    terminate(1);
  },
);
