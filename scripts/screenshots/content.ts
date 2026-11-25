// Synthetic demo content for the screenshot round. Nothing here comes from a real review, client or
// machine. Fixture source files live under ./fixtures with a .txt suffix that the runner strips.
import { cpSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { assertInsideRoot } from "./safety.ts";

// A fixed id keeps the machine dot the same colour on every run.
export const INSTANCE_ID = "5f0c1d2e-8a4b-4c3d-9e6f-1a2b3c4d5e6f";
export const MAIN_ISSUE = 212;
export const MAIN_TITLE = "Pin a review to the top of the inbox";
export const REMOTE_URL = "https://github.com/example/recense.git";

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
  branch: "recense-212-pin-review",
  steps: [
    { fixture: "main/c1", message: "feat(db): add pinned_at to reviews" },
    { fixture: "main/c2", message: "feat(api): pin and unpin reviews" },
    { fixture: "main/c3", message: "feat(ui): sort pinned reviews first" },
    { fixture: "main/c4", message: "test: cover pins and the inbox order" },
  ],
};
export const MAIN_FIX: Step = { fixture: "main/c5", message: "fix(api): clear the pin when a review closes" };
export const DRAFTS_BRANCH: RepoPlan = {
  branch: "recense-205-keep-drafts",
  steps: [{ fixture: "b205", message: "feat(ui): keep a draft comment when a new revision arrives" }],
};
export const BLOB_BRANCH: RepoPlan = {
  branch: "recense-209-split-blob-store",
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

export function mainWriteup(revision: 1 | 2) {
  const pinEnds = revision === 1 ? "unpin it" : "unpin, approve or retire it";
  return {
    area: "inbox › pins",
    tldr: `Pin a review in your inbox (#${MAIN_ISSUE}). It stays at the top of the Open group until you ${pinEnds}.`,
    whyItMatters: "The reviews you return to stay in reach as the inbox grows.",
    overview: [
      "- **Goal:** After this, you can keep a review in sight when newer reviews arrive.",
      "- **Change:** A nullable `pinned_at` column stores the pin. Two reviewer-only routes set or clear it. " +
        "The inbox sorts pins first inside Open.",
    ].join("\n"),
    needsYou: [
      { kind: "decide", text: "Keep the limit at ten pins per owner, or make it a setting?", topic: "api" },
      {
        kind: "accept",
        text: "Keep `pinned_at` nullable with no backfill. Changing the column later takes a new migration.",
        topic: "migration",
      },
    ],
    ...(revision === 2 && {
      newInRevision: [
        { text: "Retire and approve now clear the pin in the same update that closes the review.", topic: "api" },
        { text: "The sort rule now spells out that Needs you stays above pinned reviews.", topic: "inbox" },
        { text: "Checked adds a test for retire and one for approve.", section: "checked" },
      ],
    }),
    whereToLook: [
      "- **Biggest risk:** Two pins can take an owner from nine to eleven if the count moves outside the transaction.",
      revision === 1
        ? "- **Look yourself:** Check the count and update in `pins.ts`. The limit test sends one request at a time."
        : "- **Look yourself:** Check `closeReview` in `reviews.ts`. The tests see the final row. " +
          "Only the update shows that the state and pin change together.",
    ].join("\n"),
    checked: [
      "- The eleventh pin for one owner returned `409 pin_limit`.",
      "- A request to pin another owner's review returned `404`.",
      "- The sort tests put pins first in Open and kept a pinned Done review in Done. " +
        "The group order keeps Needs you above pinned reviews in Open.",
      ...(revision === 2
        ? ["- Retiring a pinned review cleared `pinned_at`.", "- Approving a pinned review cleared `pinned_at`."]
        : []),
    ].join("\n"),
    notChecked: "- No test pins from two browsers at once with one slot left. Both could claim that slot.",
    decisions: [
      "- **Decided for you:** Chose a nullable `pinned_at` over a pins table because one pin per review is enough. " +
        "Would change if pins became per machine.",
      revision === 1
        ? "- **Trail:** An independent review found nothing blocking."
        : "- **Trail:** The reviewer left three comments. Fixed the stale pin. Explained the sort order and pin limit.",
    ].join("\n"),
    topics: {
      migration: {
        why: [
          "**What it is:** The reviews table holds each review's state.",
          "**Problem:** A row has no record of when its owner pinned it.",
          "**Fix:** Add a nullable `pinned_at` column and an index on `owner_id` and `pinned_at`.",
          "**Undo:** Revert, then add a migration that drops `pinned_at`.",
        ].join("\n\n"),
        example: "Before: An existing row has no pin column.\nAfter: Its `pinned_at` is null until its owner pins it.",
      },
      api: {
        why: [
          "**What it is:** The review routes handle changes made by the reviewer.",
          "**Problem:** A reviewer has no way to set or clear a pin.",
          "**Fix:** Add reviewer-only pin and unpin routes. Count and set pins in one transaction." +
            (revision === 2 ? " Retire and approve clear the pin in the update that closes the review." : ""),
        ].join("\n\n"),
        example: "Before: A reviewer cannot pin a review.\nAfter: Pinning it twice returns `204` both times.",
      },
      inbox: {
        why: [
          "**What it is:** Open lists reviews by their last update.",
          "**Problem:** A new review can push one you need out of sight.",
          "**Fix:** Sort pinned reviews first inside Open only, newest pin first. " +
            "Needs you, Snoozed and Done keep their order." +
            (revision === 2 ? " Needs you stays above pinned reviews." : ""),
        ].join("\n\n"),
        example: "Before: A new review pushes an older one down.\nAfter: Pin the older review and it leads Open.",
      },
      tests: {
        why: [
          "**What it is:** Route and inbox tests exercise the pin rules.",
          "**Problem:** Pinning one review cannot show what happens at the limit or across owners and inbox groups.",
          "**Fix:** Try an eleventh pin and a pin on another owner's review. Sort pinned rows in Open and Done.",
        ].join("\n\n"),
      },
    },
  };
}

export const MAIN_TOPICS = [
  {
    slug: "migration",
    title: "Pinned state in the database",
    importance: 10,
    attention: "critical",
    summary: "A nullable pinned_at column and an index on (owner_id, pinned_at).",
    blastRadius: { scope: "owners", note: "Every inbox query reads the new column." },
  },
  {
    slug: "api",
    title: "Pin and unpin endpoints",
    importance: 20,
    attention: "review",
    summary: "Two reviewer-only routes with a limit of ten pins per owner.",
    blastRadius: { scope: "reviewers", note: "Two new reviewer-only routes." },
  },
  {
    slug: "inbox",
    title: "Pinned reviews sort first",
    importance: 30,
    attention: "review",
    summary: "The Open group lists pinned reviews first, newest pin on top.",
    blastRadius: { scope: "reviewers", note: "Inbox order changes." },
  },
  {
    slug: "tests",
    title: "Tests that follow the code",
    importance: 99,
    attention: "skim",
    summary: "Route tests for the limit and owner isolation, and sort tests for the inbox.",
    blastRadius: { scope: "none", note: "Tests only." },
  },
] as const;

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
