import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { deflateSync } from "node:zlib";
import type { Page } from "../screenshots/browser.ts";
import { api } from "../screenshots/sealed.ts";

export const SEED = {
  inboxReviews: 300,
  largeReviewFiles: 200,
  largeReviewDiffLines: 20_000,
  pubDocs: 50,
  pubImages: 10,
  pubMermaid: 1,
  commentedReviews: 30,
  repliedReviews: 15,
} as const;
export const IDENTITY = { name: "Synthetic Reviewer", email: "reviewer@example.invalid" };
export const FIXED_DATE = "2026-10-26T12:00:00Z";
export const LARGE_TITLE = "Synthetic large review";
export const PUB_TITLE = "Synthetic handbook";

function crc32(bytes: Buffer): number {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
  }
  return (crc ^ 0xffffffff) >>> 0;
}
function chunk(type: string, data: Buffer): Buffer {
  const name = Buffer.from(type);
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([name, data])));
  return Buffer.concat([length, name, data, crc]);
}
export function png(red: number, green: number, blue: number): Buffer {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(16, 0);
  header.writeUInt32BE(16, 4);
  header[8] = 8;
  header[9] = 2;
  const row = Buffer.concat([
    Buffer.from([0]),
    Buffer.from(Array.from({ length: 16 }, () => [red, green, blue]).flat()),
  ]);
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk("IHDR", header),
    chunk("IDAT", deflateSync(Buffer.concat(Array.from({ length: 16 }, () => row)))),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

/** No filesystem, clock, random IDs or server: the whole planned payload is reproducible. */
export function buildSeedPlan() {
  let state = 175;
  const next = () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state;
  };
  const pad = (n: number) => String(n).padStart(3, "0");
  const lines = SEED.largeReviewDiffLines / SEED.largeReviewFiles / 2;
  const files = Array.from({ length: SEED.largeReviewFiles }, (_, i) => {
    const values = Array.from({ length: lines }, () => next() % 100_000);
    return {
      path: `src/module-${pad(i)}.ts`,
      before: values.map((n, j) => `export const oldValue${j} = ${n};`).join("\n") + "\n",
      after: values.map((n, j) => `export const newValue${j} = ${n + 1};`).join("\n") + "\n",
    };
  });
  const manifest = (title: string, paths: string[]) => ({
    version: 1,
    title,
    topics: [],
    files: paths.map((path) => ({ path, role: "diff" })),
    writeup: {
      overview: `# ${title}\n\nSynthetic changes prepared on ${FIXED_DATE}.`,
      tldr: "Deterministic performance fixture.",
      decisions: null,
      topics: {},
    },
  });
  const reviews = Array.from({ length: SEED.inboxReviews - 2 }, (_, i) => ({
    key: `review-${pad(i)}`,
    manifest: manifest(`Synthetic review ${pad(i)}`, ["sample.ts"]),
    commented: i < SEED.commentedReviews,
    replied: i < SEED.repliedReviews,
    state: i < SEED.commentedReviews ? "sent" : ["open", "approved", "retired", "snoozed"][i % 4],
  }));
  const images = Array.from({ length: SEED.pubImages }, (_, i) => ({
    path: `images/image-${pad(i)}.png`,
    bytes: png(next() % 256, next() % 256, next() % 256),
  }));
  const docs = Array.from({ length: SEED.pubDocs }, (_, i) => ({
    path: `doc-${pad(i)}.md`,
    text:
      `# Handbook ${pad(i)}\n\nSynthetic document ${i}, prepared on ${FIXED_DATE}.\n\n` +
      Array.from({ length: 12 }, (_, j) => `## Section ${j}\n\nA deterministic example: ${next() % 10000}.\n\n`).join(
        "",
      ) +
      (i < images.length ? `![Synthetic image ${i}](${images[i].path})\n\n` : "") +
      (i < SEED.pubMermaid ? "```mermaid\nflowchart LR\n  Draft --> Review --> Publish\n```\n" : ""),
  }));
  return {
    identity: IDENTITY,
    date: FIXED_DATE,
    files,
    reviews,
    largeManifest: manifest(
      LARGE_TITLE,
      files.map((f) => f.path),
    ),
    docs,
    images,
  };
}

export interface Skip {
  step: string;
  reason: string;
}
export type Cli = (args: string[], cwd: string, timeoutMs?: number) => Promise<string>;
// Both the seed and timed publications start inside this repo, never above it.
export function publishPub(cli: Cli, folder: string, fresh = false): Promise<string> {
  return cli(["publish", folder, "--title", PUB_TITLE, ...(fresh ? ["--new"] : []), "--json"], folder);
}
export interface Seeded {
  largeId?: string;
  pubId?: string;
  pubFolder: string;
  reviewIds: string[];
}
export const publishedId = (output: string): string => {
  const record = JSON.parse(output.trim().split("\n").at(-1) ?? "{}");
  if (typeof record.reviewId !== "string") throw new Error("Publish returned no review id");
  return record.reviewId;
};

export async function seed(options: {
  root: string;
  cli: Cli;
  git: (cwd: string, ...args: string[]) => string;
  page: Page;
  skip: (step: string, error: unknown) => void;
}): Promise<Seeded> {
  const plan = buildSeedPlan();
  const { root, cli, git, page, skip } = options;
  const write = (folder: string, path: string, data: string | Buffer) => {
    const target = join(folder, path);
    mkdirSync(join(target, ".."), { recursive: true });
    writeFileSync(target, data);
  };
  const repo = (name: string, files: { path: string; before: string; after: string }[]) => {
    const folder = join(root, name);
    mkdirSync(folder);
    git(folder, "init", "-q");
    for (const f of files) write(folder, f.path, f.before);
    git(folder, "add", ".");
    git(folder, "commit", "-qm", "test: synthetic base");
    const base = git(folder, "rev-parse", "HEAD");
    for (const f of files) write(folder, f.path, f.after);
    git(folder, "add", ".");
    git(folder, "commit", "-qm", "test: synthetic changes");
    return { folder, base, head: git(folder, "rev-parse", "HEAD") };
  };
  const small = repo("small", [
    { path: "sample.ts", before: "export const value = 1;\n", after: "export const value = 2;\n" },
  ]);
  const large = repo("large", plan.files);
  const pubFolder = join(root, "handbook");
  mkdirSync(pubFolder);
  for (const doc of plan.docs) write(pubFolder, doc.path, doc.text);
  for (const image of plan.images) write(pubFolder, image.path, image.bytes);
  // The caller's git helper supplies the fixed identity and dates, as for the review repos.
  git(pubFolder, "init", "-q");
  git(pubFolder, "add", ".");
  git(pubFolder, "commit", "-qm", "docs: synthetic handbook");
  const publish = async (key: string, manifest: unknown, source: typeof small) => {
    const file = join(root, `${key}.json`);
    writeFileSync(file, JSON.stringify({ ...(manifest as object), base: source.base, head: source.head }));
    return publishedId(await cli(["publish", "--manifest", file, "--key", `perf-${key}`], source.folder));
  };
  const result: Seeded = { pubFolder, reviewIds: [] };
  // Sequential publishing fixes insertion order, even when createdAt is assigned by the server.
  for (const item of plan.reviews) {
    let id: string;
    try {
      id = await publish(item.key, item.manifest, small);
      result.reviewIds.push(id);
    } catch (error) {
      skip(`seed/${item.key}`, error);
      continue;
    }
    try {
      if (item.commented) {
        const thread = await api(page, "POST", `/api/v1/reviews/${id}/threads`, {
          revision: 1,
          target: { kind: "file", path: "sample.ts" },
          body: "Please explain the synthetic value change.",
        });
        await api(page, "POST", `/api/v1/reviews/${id}/sends`, { revision: 1, kind: "go", mode: "fix-clear" });
        if (item.replied)
          await cli(
            [
              "reply",
              String(thread.commentId),
              "--status",
              "explained",
              "--body",
              "The synthetic value is intentional.",
            ],
            small.folder,
          );
      } else if (item.state === "approved")
        await api(page, "POST", `/api/v1/reviews/${id}/sends`, { revision: 1, kind: "approve" });
      else if (item.state === "retired") await api(page, "POST", `/api/v1/reviews/${id}/retire`);
      else if (item.state === "snoozed")
        await api(page, "POST", `/api/v1/reviews/${id}/snooze`, { untilRevision: true });
    } catch (error) {
      skip(`seed/${item.key}/${item.state}`, error);
    }
  }
  try {
    result.largeId = await publish("large", plan.largeManifest, large);
    result.reviewIds.push(result.largeId);
  } catch (error) {
    skip("seed/large", error);
  }
  try {
    result.pubId = publishedId(await publishPub(cli, pubFolder));
    result.reviewIds.push(result.pubId);
  } catch (error) {
    skip("seed/pub", error);
  }
  return result;
}
