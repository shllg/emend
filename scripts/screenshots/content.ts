// Synthetic demo content for the screenshot round. Nothing here comes from a real review, client or
// machine. Fixture source files live under ./fixtures with a .txt suffix that the runner strips.
import { cpSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { assertInsideRoot } from "./safety.ts";

// A fixed id keeps the machine dot the same colour on every run.
export const INSTANCE_ID = "5f0c1d2e-8a4b-4c3d-9e6f-1a2b3c4d5e6f";
export const MAIN_ISSUE = 212;
export const MAIN_TITLE = "Pin a review to the top of the inbox";
export const REMOTE_URL = "https://github.com/example/emend.git";

export const IDENTITY = { name: "Ada Example", email: "ada@example.com" };

export interface Step {
  fixture: string;
  message: string;
}

export interface RepoPlan {
  branch: string;
  steps: Step[];
}

// One base commit on main; each branch adds commits from the overlays named here.
export const BASE: Step = { fixture: "main/base", message: "chore: start from the current inbox" };
export const MAIN_BRANCH: RepoPlan = {
  branch: "emend-212-pin-review",
  steps: [
    { fixture: "main/c1", message: "feat(db): add pinned_at to reviews" },
    { fixture: "main/c2", message: "feat(api): pin and unpin reviews" },
    { fixture: "main/c3", message: "feat(ui): sort pinned reviews first" },
    { fixture: "main/c4", message: "test: cover pins and the inbox order" },
  ],
};
export const MAIN_FIX: Step = { fixture: "main/c5", message: "fix(api): clear the pin when a review closes" };
export const DRAFTS_BRANCH: RepoPlan = {
  branch: "emend-205-keep-drafts",
  steps: [{ fixture: "b205", message: "feat(ui): keep a draft comment when a new revision arrives" }],
};
export const BLOB_BRANCH: RepoPlan = {
  branch: "emend-209-split-blob-store",
  steps: [{ fixture: "b209", message: "refactor(core): split the blob store into read and write paths" }],
};

/** Copy a fixture overlay into a repo, dropping the .txt suffix that keeps tools from reading it as code. */
export function applyFixture(fixturesDir: string, fixture: string, repo: string): string[] {
  const source = join(fixturesDir, fixture);
  const written: string[] = [];
  const walk = (dir: string) => {
    for (const name of readdirSync(dir)) {
      const path = join(dir, name);
      if (statSync(path).isDirectory()) walk(path);
      else if (dir === source && name === "removed.txt") {
        // A list of repository paths this step deletes, one per line.
        for (const removed of readFileSync(path, "utf8").split("\n").filter(Boolean)) rmSync(assertInsideRoot(repo, removed));
      } else {
        if (!name.endsWith(".txt")) throw new Error("Fixture files end in .txt");
        const target = join(repo, relative(source, path).slice(0, -".txt".length));
        mkdirSync(join(target, ".."), { recursive: true });
        cpSync(path, target);
        written.push(target);
      }
    }
  };
  walk(source);
  return written;
}

// ---- Main review: writeups -------------------------------------------------------------------

export function mainWriteup(revision: 1 | 2): string {
  if (revision === 1)
    return `## What changed

Reviews can now be pinned. A pinned review stays at the top of the Open group in the inbox until
you unpin it. Issue #212.

- A new migration adds \`pinned_at\` to \`reviews\`. Nothing is backfilled.
- \`POST /api/v1/reviews/:id/pin\` and \`/unpin\` are reviewer-only and filter \`owner_id\`.
- The inbox sorts pinned reviews first, newest pin on top.

## What to look at

1. **The pin limit.** Ten pins per owner; the eleventh returns \`409 pin_limit\`.
2. **The sort order.** Pinned reviews sort first inside the Open group only.

## How I checked it

\`pnpm verify\` passes. New tests cover the limit, owner isolation and the sort order.
`;
  return `## What changed

Reviews can now be pinned. A pinned review stays at the top of the Open group in the inbox until
you unpin, approve or retire it. Issue #212.

- A new migration adds \`pinned_at\` to \`reviews\`. Nothing is backfilled.
- \`POST /api/v1/reviews/:id/pin\` and \`/unpin\` are reviewer-only and filter \`owner_id\`.
- The inbox sorts pinned reviews first, newest pin on top.

## What to look at

1. **Retire and approve clear the pin.** Both clear pinned_at in the same transaction as the state change.
2. **The pin limit.** Ten pins per owner; the eleventh returns \`409 pin_limit\`.
3. **The sort order.** Pinned reviews sort first inside the Open group only. Reviews in Needs you stay above them.

## How I checked it

\`pnpm verify\` passes. New tests cover the limit, owner isolation and the sort order.
`;
}

export function mainTldr(revision: 1 | 2): string {
  return revision === 1
    ? "- **Biggest risk:** A committed migration is never edited, so the column has to be right now.\n- **Check first:** The pin limit in `pins.ts`."
    : "- **Biggest risk:** A committed migration is never edited, so the column has to be right now.\n- **Check first:** `closeReview` in `reviews.ts` now clears the pin.";
}

export const MAIN_TOPICS = [
  {
    slug: "migration",
    title: "Pinned state in the database",
    importance: 10,
    attention: "critical",
    summary: "A nullable pinned_at column and an index on (owner_id, pinned_at).",
    door: "one-way",
    blastRadius: { scope: "owners", note: "Every inbox query reads the new column." },
  },
  {
    slug: "api",
    title: "Pin and unpin endpoints",
    importance: 20,
    attention: "review",
    summary: "Two reviewer-only routes with a limit of ten pins per owner.",
    door: "two-way",
    blastRadius: { scope: "reviewers", note: "Two new reviewer-only routes." },
  },
  {
    slug: "inbox",
    title: "Pinned reviews sort first",
    importance: 30,
    attention: "review",
    summary: "The Open group lists pinned reviews first, newest pin on top.",
    door: "two-way",
    blastRadius: { scope: "reviewers", note: "Inbox order changes." },
  },
  {
    slug: "tests",
    title: "Tests that follow the code",
    importance: 99,
    attention: "skim",
    summary: "Route tests for the limit and owner isolation, and sort tests for the inbox.",
    door: "two-way",
    blastRadius: { scope: "none", note: "Tests only." },
  },
] as const;

export const MAIN_TOPIC_TEXT: Record<string, string> = {
  migration:
    "**What it is:** One nullable column and an index.\n\n**Why one-way:** A committed migration is never edited or removed.",
  api: "**What it is:** `POST /pin` and `POST /unpin`, both reviewer-only.\n\n**Limit:** The eleventh pin returns `409 pin_limit`.",
  inbox: "**What it is:** Pinned reviews sort first inside the Open group.\n\n**Scope:** Needs you, Snoozed and Done keep their order.",
  tests: "**What it is:** Route tests and sort tests that follow the code.",
};

// ---- Other reviews ---------------------------------------------------------------------------

export function smallReview(title: string, topic: { slug: string; title: string; summary: string }, files: string[]) {
  return {
    version: 1,
    title,
    topics: [
      {
        slug: topic.slug,
        title: topic.title,
        importance: 10,
        attention: "review",
        summary: topic.summary,
        door: "two-way",
        blastRadius: { scope: "reviewers", note: topic.summary },
      },
    ],
    files: files.map((path) => ({ path, role: "diff", topic: topic.slug })),
    writeup: {
      overview: `## What changed\n\n${topic.summary}\n\n## How I checked it\n\n\`pnpm verify\` passes.\n`,
      tldr: `- **Check first:** ${topic.title}.`,
      decisions: null,
      topics: { [topic.slug]: { why: `**What it is:** ${topic.summary}` } },
    },
  };
}

export const COMMENTS = {
  retire:
    "Retiring a pinned review leaves `pinned_at` set, so it jumps back to the top when someone reopens it. Clear it in the same update?",
  sort: "Should a pinned review beat one that waits on me? I'd keep those first.",
  limits: "Ten feels arbitrary. Where does that number come from?",
  blob: "Should the writer own the temporary file naming, so two writers can never pick the same name?",
} as const;

export const REPLIES = {
  retire: {
    status: "fixed",
    body: "Fixed in revision 2. Retire and approve now clear `pinned_at` in the same transaction, and each has a test.",
  },
  sort: {
    status: "explained",
    body: "Pinned reviews sort first only inside the Open group, so reviews in Needs you stay above them. I added that to the writeup.",
  },
  limits: {
    status: "explained",
    body: "Ten rows fit on a phone screen without scrolling. I noted that in the plan.",
  },
} as const;
