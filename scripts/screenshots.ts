// pnpm screenshots: a sealed demo review round that captures the README and tour screenshots.
//
// Everything runs under one throwaway root: a server from this checkout's build, fixture git repos,
// the CLI, and a Chromium profile. No child inherits the parent environment, the browser reaches
// only the sealed origin, and the real emend server and state are never touched. The guards live in
// ./screenshots/safety.ts and are covered by scripts/screenshots.test.ts.
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { writeImages } from "./screenshots/images.ts";
import { type Page, PHONE } from "./screenshots/browser.ts";
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
import { assertOutputFolder, canonicalPath, filterPng } from "./screenshots/safety.ts";
import { api, createSealedLifecycle } from "./screenshots/sealed.ts";

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

const sealed = createSealedLifecycle("screenshots");
const step = (text: string) => console.log(`- ${text}`);

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  sealed.setKeep(options.keep);
  if (!existsSync(entry)) throw new Error("The CLI is not built. Run pnpm build first (pnpm screenshots does).");

  const { sealedRoot, env, realStateDirs } = sealed.createRoot(options.out, IDENTITY);
  const server = await sealed.startServer(entry, sealedRoot, env, INSTANCE_ID);
  const { origin, cli } = server;
  const git = (cwd: string, ...args: string[]) => sealed.git(cwd, env, ...args);

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

  const { browser, desktop } = await sealed.signIn(entry, sealedRoot, env, server, options.chromium);

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

await main().then(() => sealed.finish(), (error: Error) => sealed.finish(error));
