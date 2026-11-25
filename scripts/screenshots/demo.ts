// The synthetic round shared by the screenshot runner and the worktree UI demo.
import { randomUUID } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Browser, Page } from "./browser.ts";
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
  MAIN_TOPICS,
  mainWriteup,
  REMOTE_URL,
  REPLIES,
  type RepoPlan,
  smallReview,
} from "./content.ts";
import { api, createSealedLifecycle } from "./sealed.ts";

const fixturesDir = join(import.meta.dirname, "fixtures");
const step = (text: string) => console.log(`- ${text}`);

type Lifecycle = ReturnType<typeof createSealedLifecycle>;
type Server = Awaited<ReturnType<Lifecycle["startServer"]>>;

interface Options {
  port?: number;
  keep: boolean;
  out: string;
  entry: string | ((root: string) => string);
  chromium?: string;
  beforeSend?: (desktop: Page) => Promise<void>;
}

interface RoundContext {
  sealed: Lifecycle;
  sealedRoot: string;
  entry: string;
  env: Record<string, string>;
  server: Server;
  chromium?: string;
  beforeSend?: Options["beforeSend"];
}

export type DemoRound = (context: RoundContext) => Promise<{ reviewId: string; browser?: Browser }>;

interface Running {
  origin: string;
  root: string;
  realStateDirs: string[];
  restart: Server["restart"];
  stop: Lifecycle["cleanup"];
}

export type ScreenshotDemo = Running & Awaited<ReturnType<typeof playRound>>;

export function startSealedDemo(options: Options): Promise<ScreenshotDemo>;
export function startSealedDemo(options: Options, round?: DemoRound): Promise<Running & Awaited<ReturnType<DemoRound>>>;
export async function startSealedDemo(options: Options, round: DemoRound = playRound) {
  const sealed = createSealedLifecycle(options.port === undefined ? "screenshots" : "ui-demo");
  sealed.setKeep(options.keep);
  try {
    const { sealedRoot, env, realStateDirs } = sealed.createRoot(options.out, IDENTITY);
    const entry = typeof options.entry === "string" ? options.entry : options.entry(sealedRoot);
    const server = await sealed.startServer(entry, sealedRoot, env, INSTANCE_ID, false, options.port);
    const result = await round({ sealed, sealedRoot, env, entry, server, chromium: options.chromium, beforeSend: options.beforeSend });
    return { ...result, origin: server.origin, root: sealedRoot, realStateDirs, restart: server.restart, stop: sealed.cleanup };
  } catch (error) {
    await sealed.cleanup();
    throw error;
  }
}

async function playRound({ sealed, sealedRoot, env, entry, server, chromium, beforeSend }: RoundContext) {
  const { origin, cli } = server;
  const git = (cwd: string, ...args: string[]) => sealed.git(cwd, env, ...args);

  // ---- Fixture repositories ---------------------------------------------------------------
  step("building fixture repositories");
  const reposDir = join(sealedRoot, "repos");
  const repo = join(reposDir, "recense");
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

  const { browser, desktop } = await sealed.signIn(entry, sealedRoot, env, server, chromium);

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
      ["apps/recense/src/blobs/read.ts", "apps/recense/src/blobs/write.ts"],
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
    "apps/recense/drizzle/0012_review_pins.sql": "migration",
    "apps/recense/src/db/schema.ts": "migration",
    "apps/recense/src/server/routes/pins.ts": "api",
    "apps/recense/src/server/routes/reviews.ts": "api",
    "packages/contract/src/review.ts": "api",
    "docs/api.md": "api",
    "apps/web/src/lib/inbox-order.ts": "inbox",
    "apps/web/src/components/inbox/ReviewRow.tsx": "inbox",
    "apps/recense/src/server/routes/pins.test.ts": "tests",
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
      writeup: mainWriteup(revision),
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
  const retireStart = lineOf(mainHead1, "apps/recense/src/server/routes/reviews.ts", "state,");
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
  await comment("retire", lineTarget(mainHead1, "apps/recense/src/server/routes/reviews.ts", retireStart, retireStart + 1));
  await comment("sort", lineTarget(mainHead1, "apps/web/src/lib/inbox-order.ts", sortLine, sortLine));
  await comment("limits", {
    kind: "doc-span",
    path: planPath,
    blockId: limitsBlock.id,
    quote: limitsQuote,
    prefix: "",
    suffix: limitsBlock.text.slice(limitsQuote.length, limitsQuote.length + 32),
  });

  const reviewUrl = (query: string) => `${origin}/r/${reviewId}${query}`;

  step("capturing the Send panel");
  await desktop.goto(reviewUrl("?tab=comments&rev=1"));
  await desktop.waitFor("document.body.innerText.includes('3 unsent comments')", "three unsent comments");
  await desktop.settle("the comments tab");
  await beforeSend?.(desktop);

  step("pressing Send");
  const sendBar = `document.querySelector('section[aria-label="Send and approve"]')`;
  await desktop.waitFor(`${sendBar}?.innerText.includes('3 to send')`, "three comments in the Send bar");
  await desktop.eval(`(() => {
    const section = ${sendBar};
    if (!section) throw new Error('Send bar is missing');
    const button = [...section.querySelectorAll('button[type="submit"]')].find((b) => b.innerText.trim() === 'Send');
    if (!button) throw new Error('Send button is missing');
    if (button.disabled) throw new Error('Send button is disabled');
    button.click();
  })()`);
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
    "apps/recense/src/blobs/write.ts",
    lineOf(blobHead, "apps/recense/src/blobs/write.ts", "const temporary"),
    lineOf(blobHead, "apps/recense/src/blobs/write.ts", "const temporary"),
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

  return { browser, desktop, reviewId, reviewUrl, planPath };
}
