import { createHash, randomUUID } from "node:crypto";
import { ImportBundle, importRowCount, LIMITS, MachineRegistered, PairingCreated } from "@emend/contract";
import * as core from "@emend/core";
import { sql } from "drizzle-orm";
import { expect } from "vitest";
import * as tables from "../../db/schema.ts";
import { mailboxFixture } from "../mailbox/test-support.ts";

export async function importFixture() {
  const f = await mailboxFixture();
  try {
    const origin = randomUUID();
    const pairing = PairingCreated.parse(await (await f.request("/pairings", "POST", { purpose: "machine" })).json());
    const registered = await f.request("/machines", "POST", {
      secret: new URL(pairing.url).hash.slice(1),
      instance: { id: origin, name: "Synthetic laptop" },
    });
    expect(registered.status).toBe(201);
    const token = MachineRegistered.parse(await registered.json()).token;
    function importRequest(path: string, body: unknown, signal?: AbortSignal) {
      const url = `http://127.0.0.1:3636/api/v1${path}`;
      const init = {
        method: "POST",
        headers: { Host: "127.0.0.1:3636", "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify(body),
      };
      // A Request follows its signal only weakly; keep it alive so an abort is not lost to garbage collection.
      return signal ? f.app.request(f.keep(new Request(url, { ...init, signal }))) : f.app.request(url, init);
    }
    return { ...f, origin, importRequest };
  } catch (error) {
    await f.cleanup();
    throw error;
  }
}

type ImportFixture = Awaited<ReturnType<typeof importFixture>>;

export async function bundle(f: ImportFixture) {
  const now = new Date(f.deps.now() - 1000).toISOString();
  const id = randomUUID();
  const revisionIds = [randomUUID(), randomUUID()];
  const threadId = randomUUID();
  const sendIds = [randomUUID(), randomUUID()];
  const deliveryIds = [randomUUID(), randomUUID()];
  const blob = await f.deps.blobs.put(
    f.ownerId,
    Buffer.from(JSON.stringify({ overview: "Synthetic writeup", tldr: "", decisions: null, topics: {} })),
    "application/json",
  );
  const html = await f.deps.blobs.put(f.ownerId, Buffer.from("<h1>Synthetic doc</h1>"), "text/html");
  return {
    review: {
      id,
      originInstanceId: f.origin,
      reviewKey: "b".repeat(64),
      repo: { key: "c".repeat(64), name: "Synthetic repo" },
      branch: "main",
      title: "Copied review",
      state: "open",
      approvedRevision: null,
      createdAt: now,
      updatedAt: now,
      movedTo: "https://unused.example",
    },
    revisions: revisionIds
      .map((id, i) => ({
        id,
        reviewId: "",
        seq: i + 1,
        base: null,
        head: null,
        main: null,
        writeupEmpty: false,
        contentKey: "A".repeat(43),
        createdAt: now,
      }))
      .map((r) => ({ ...r, reviewId: id })),
    topics: revisionIds.map((revisionId) => ({
      id: randomUUID(),
      revisionId,
      slug: "synthetic",
      title: "Synthetic topic",
      importance: 20,
      summary: "Synthetic summary",
    })),
    files: [
      {
        id: randomUUID(),
        revisionId: revisionIds[0],
        path: "doc.html",
        oldPath: null,
        role: "doc",
        status: null,
        topicSlug: null,
        ord: 0,
        mediaType: "text/html",
        oldBlob: null,
        newBlob: html,
        renderedBlob: null,
        flag: null,
        parentDocId: null,
      },
    ],
    docAssets: [],
    writeups: revisionIds.map((revisionId) => ({ id: randomUUID(), revisionId, sourceBlob: blob, renderedBlob: blob })),
    changedBlocks: revisionIds.map((revisionId) => ({
      id: randomUUID(),
      revisionId,
      blockId: `overview-${createHash("sha256").update("Synthetic writeup").digest("hex").slice(0, 8)}`,
    })),
    threads: [
      {
        id: threadId,
        reviewId: id,
        target: { kind: "review" },
        state: "sent",
        createdRevisionId: revisionIds[0],
        createdAt: now,
        updatedAt: now,
      },
    ],
    placements: revisionIds.map((revisionId) => ({
      reviewId: id,
      threadId,
      revisionId,
      status: "placed",
      location: { kind: "review" },
      reason: null,
      carried: null,
    })),
    comments: [
      {
        id: randomUUID(),
        reviewId: id,
        threadId,
        author: "user",
        body: "First feedback",
        outcome: null,
        sendId: sendIds[0],
        createdAt: now,
        updatedAt: now,
      },
      {
        id: randomUUID(),
        reviewId: id,
        threadId,
        author: "agent",
        body: "Explained",
        outcome: "explained",
        sendId: null,
        createdAt: now,
        updatedAt: now,
      },
      {
        id: randomUUID(),
        reviewId: id,
        threadId,
        author: "user",
        body: "Second feedback",
        outcome: null,
        sendId: sendIds[1],
        createdAt: now,
        updatedAt: now,
      },
    ],
    sends: sendIds
      .map((id, i) => ({
        id,
        reviewId: "",
        revisionId: revisionIds[i],
        kind: "go",
        mode: "fix-clear",
        instruction: null,
        deliveryId: deliveryIds[i],
        setAsideAt: i ? now : null,
        createdAt: now,
      }))
      .map((s) => ({ ...s, reviewId: id })),
    deliveries: deliveryIds.map((deliveryId, i) => ({
      id: deliveryId,
      reviewId: id,
      leaseUntil: now,
      confirmedAt: i ? null : now,
      createdAt: now,
    })),
  };
}

export async function snapshot(f: ImportFixture) {
  return f.db.read(async (q) => {
    const result = [];
    for (const table of [
      tables.reviews,
      tables.revisions,
      tables.topics,
      tables.files,
      tables.docAssets,
      tables.writeups,
      tables.changedBlocks,
      tables.threads,
      tables.placements,
      tables.comments,
      tables.sends,
      tables.deliveries,
      tables.blobs,
      tables.repos,
    ])
      result.push(await q.select({ n: sql<number>`count(*)` }).from(table).get());
    return result;
  });
}

export function required<T>(value: T | undefined): T {
  if (value === undefined) throw new Error("Missing fixture row");
  return value;
}

export function longPath(extension: string) {
  return `${Array.from({ length: 15 }, () => "界".repeat(255)).join("/")}/${"界".repeat(255 - extension.length)}${extension}`;
}

/** Every collection cap, 50000 inserts, 8 MiB JSON and within two bytes of 64 MiB
 * stored derived rows. Both long multibyte and escaped paths, all four target kinds,
 * and file/line renames run through the production insertion path. */
export async function multibyteCapsBundle(f: ImportFixture) {
  const input = ImportBundle.parse(await bundle(f));
  const revision = required(input.revisions[0]),
    writeup = required(input.writeups[0]),
    thread = required(input.threads[0]);
  const comment = required(input.comments[0]),
    send = required(input.sends[0]),
    delivery = required(input.deliveries[0]),
    file = required(input.files[0]);
  input.revisions = Array.from({ length: 1000 }, (_, i) => ({ ...revision, id: randomUUID(), seq: i + 1 }));
  const source = { overview: "Synthetic multibyte boundary", tldr: "", decisions: null, topics: {} };
  const hash = await f.deps.blobs.put(f.ownerId, Buffer.from(JSON.stringify(source, null, 2)), "application/json");
  input.writeups = input.revisions.map((r) => ({ ...writeup, id: randomUUID(), revisionId: r.id, sourceBlob: hash }));
  const markdown = await f.deps.blobs.put(f.ownerId, Buffer.from("needle"), "text/markdown");
  const html = await f.deps.blobs.put(f.ownerId, Buffer.from("<p>needle</p>"), "text/html");
  const paths = [longPath(".md"), longPath(".md").replaceAll("界", '"')];
  const htmlPaths = [longPath(".html"), longPath(".html").replaceAll("界", '"')];
  const shortPaths = ["a.md", "q.md"];
  const blocks = await Promise.all(paths.map(async (path) => required((await core.renderDoc("needle", path))[0])));
  input.files = input.revisions.slice(-50).flatMap((r, i) =>
    paths.flatMap((path, j) => [
      {
        ...file,
        id: randomUUID(),
        revisionId: r.id,
        path: i ? path : required(shortPaths[j]),
        role: "diff" as const,
        status: i ? ("renamed" as const) : ("added" as const),
        oldPath: i ? required(shortPaths[j]) : null,
        newBlob: markdown,
        ord: j * 3,
      },
      { ...file, id: randomUUID(), revisionId: r.id, path, newBlob: markdown, ord: j * 3 + 1 },
      { ...file, id: randomUUID(), revisionId: r.id, path: required(htmlPaths[j]), newBlob: html, ord: j * 3 + 2 },
    ]),
  );
  const targets: ImportBundle["threads"][number]["target"][] = paths.flatMap((path, i) => [
    { kind: "file", path },
    { kind: "lines", path, side: "new", start: 1, end: 1, lines: ["needle"], before: [], after: [] },
    { kind: "doc-span", path, blockId: required(blocks[i]).id, quote: "needle", prefix: "", suffix: "" },
    { kind: "html-span", path: required(htmlPaths[i]), quote: "needle", prefix: "", suffix: "" },
  ]);
  input.topics = [];
  input.docAssets = [];
  const last = required(input.revisions.at(-1));
  input.threads = Array.from({ length: 1000 }, (_, i) => ({
    ...thread,
    id: randomUUID(),
    createdRevisionId: last.id,
    target:
      i < 4
        ? { ...required(targets[i < 2 ? i : i + 2]), path: required(shortPaths[Math.floor(i / 2)]) }
        : i < 64
          ? required(targets[i % 8])
          : i === 64
            ? { kind: "file" as const, path: "z" }
            : { kind: "review" as const },
  }));
  const tuningFile = {
    ...file,
    id: randomUUID(),
    revisionId: last.id,
    role: "diff" as const,
    status: "added" as const,
    path: "z",
    newBlob: markdown,
    ord: 6,
  };
  input.files.push(tuningFile);
  input.deliveries = Array.from({ length: 1000 }, () => ({ ...delivery, id: randomUUID() }));
  input.sends = input.deliveries.map((d) => ({ ...send, id: randomUUID(), revisionId: last.id, deliveryId: d.id }));
  input.comments = Array.from({ length: 10000 }, (_, i) => ({
    ...comment,
    id: randomUUID(),
    body: "x",
    threadId: required(input.threads[i % 1000]).id,
    sendId: required(input.sends[i % 1000]).id,
  }));
  const changed = blocks;
  const generatedRows = 4 + changed.length; // Writeup source/rendering and two doc renderings.
  const withoutPlacements = importRowCount(input) - input.threads.length;
  const lengths: number[] = Array.from({ length: 65 }, (_, i) => (i < 4 ? 50 : 1));
  const location = (
    target: ImportBundle["threads"][number]["target"],
    path?: string,
  ): NonNullable<typeof tables.placements.$inferSelect.location> => {
    if (target.kind === "file") return { kind: "file", path: path ?? target.path };
    if (target.kind === "lines") return { kind: "lines", path: path ?? target.path, side: "new", start: 1, end: 1 };
    if (target.kind === "doc-span")
      return { kind: "doc-span", path: target.path, blockId: target.blockId, start: 0, end: 6 };
    if (target.kind === "html-span") return { kind: "html-span", path: target.path, start: 0, end: 6 };
    throw new Error("Unexpected cap target");
  };
  const price = (target: ImportBundle["threads"][number]["target"], path?: string) => {
    const loc = location(target, path);
    return placementStorage(loc, {
      path: "path" in loc ? loc.path : null,
      ...(target.kind === "lines" ? { side: "new" as const } : {}),
    });
  };
  const prices = input.threads.slice(0, 65).map((t) => price(t.target));
  const renamedPrices = input.threads.slice(0, 4).map((t, i) => price(t.target, required(paths[Math.floor(i / 2)])));
  const balance = () => {
    const shortCount = 50000 - withoutPlacements - generatedRows - lengths.reduce((sum, n) => sum + n, 0);
    for (const [i, t] of input.threads.entries()) {
      const count = i < 65 ? required(lengths[i]) : Math.floor(shortCount / 935) + Number(i - 65 < shortCount % 935);
      t.createdRevisionId = required(input.revisions.at(-count)).id;
    }
    let bytes =
      changed.reduce((n, b) => n + 64 + 3 * 36 + Buffer.byteLength(b.id), 0) +
      shortCount * placementStorage({ kind: "review" }, { path: null });
    for (let i = 0; i < 65; i++) {
      bytes +=
        i < 4 ? required(prices[i]) + 49 * required(renamedPrices[i]) : required(lengths[i]) * required(prices[i]);
    }
    return bytes;
  };
  for (let i = 4; i < 64; i++) {
    while (required(lengths[i]) < 49) {
      lengths[i] = required(lengths[i]) + 1;
      if (balance() >= LIMITS.importDerivedBytes) {
        lengths[i] = required(lengths[i]) - 1;
        break;
      }
    }
  }
  // One final file placement fills the remaining even number of bytes. Path separators
  // cost one byte; CJK costs three. Keep every segment and the full path within its cap.
  const extra = Math.floor((LIMITS.importDerivedBytes - 1 - balance()) / 2);
  const pathBytes = extra + 1;
  for (let length = 1; length <= 4095; length++) {
    const multibyte = (pathBytes - length) / 2;
    const chars: string[] = Array.from({ length }, (_, i) => (i % 256 === 255 ? "/" : "z"));
    if (
      !Number.isInteger(multibyte) ||
      multibyte < 0 ||
      multibyte > length - Math.floor(length / 256) ||
      chars.at(-1) === "/"
    )
      continue;
    let left = multibyte;
    for (let i = 0; i < chars.length && left; i++)
      if (chars[i] !== "/") {
        chars[i] = "界";
        left--;
      }
    tuningFile.path = chars.join("");
    break;
  }
  expect(Buffer.byteLength(tuningFile.path)).toBe(pathBytes);
  required(input.threads[64]).target = { kind: "file", path: tuningFile.path };
  prices[64] = price(required(input.threads[64]).target);
  const derivedBytes = balance();
  expect(importRowCount(input) + generatedRows).toBe(50000);
  expect(LIMITS.importDerivedBytes - derivedBytes).toBeGreaterThan(0);
  expect(LIMITS.importDerivedBytes - derivedBytes).toBeLessThanOrEqual(2);
  let remaining = LIMITS.publishJsonBytes - Buffer.byteLength(JSON.stringify(input));
  expect(remaining).toBeGreaterThan(0);
  for (const comment of input.comments) {
    const added = Math.min(remaining, LIMITS.commentBodyChars - comment.body.length);
    comment.body += "x".repeat(added);
    remaining -= added;
    if (!remaining) break;
  }
  expect(remaining).toBe(0);
  expect(ImportBundle.safeParse(input).success).toBe(true);
  return { input, derivedBytes };
}

export function placementStorage(
  location: NonNullable<typeof tables.placements.$inferSelect.location>,
  carried: NonNullable<typeof tables.placements.$inferSelect.carried>,
) {
  return (
    64 +
    4 * 36 +
    Buffer.byteLength("placed") +
    Buffer.byteLength(JSON.stringify(location)) +
    Buffer.byteLength(JSON.stringify(carried))
  );
}

export async function replayBundle(f: ImportFixture, revisions: number, threads: number) {
  const input = ImportBundle.parse(await bundle(f));
  const revision = required(input.revisions[0]),
    writeup = required(input.writeups[0]),
    thread = required(input.threads[0]);
  input.revisions = Array.from({ length: revisions }, (_, i) => ({ ...revision, id: randomUUID(), seq: i + 1 }));
  input.writeups = input.revisions.map((r) => ({ ...writeup, id: randomUUID(), revisionId: r.id }));
  input.threads = Array.from({ length: threads }, () => ({
    ...thread,
    id: randomUUID(),
    createdRevisionId: required(input.revisions[0]).id,
  }));
  input.topics = [];
  input.comments = [];
  input.sends = [];
  input.deliveries = [];
  return input;
}

export async function escapedHtmlBundle(f: ImportFixture, count: number, controls: number) {
  const input = await replayBundle(f, 1, count);
  const file = required(input.files[0]);
  input.files = [];
  for (const [i, thread] of input.threads.entries()) {
    const path = `${i}.html`;
    const quote = `needle-${i}-`;
    const hash = await f.deps.blobs.put(
      f.ownerId,
      Buffer.from(`<p>${quote}${"\x01".repeat(controls)}</p>`),
      "text/html",
    );
    input.files.push({
      ...file,
      id: randomUUID(),
      revisionId: required(input.revisions[0]).id,
      path,
      newBlob: hash,
      ord: i,
    });
    thread.target = { kind: "html-span", path, quote, prefix: "", suffix: "" };
  }
  return input;
}

export function metadataPath(index: number, length: number, character: string) {
  const prefix = `${index}/`;
  const segments: string[] = [];
  let left = length - prefix.length;
  while (left > 255) {
    segments.push(character.repeat(255));
    left -= 256;
  }
  segments.push(character.repeat(left));
  return prefix + segments.join("/");
}

export async function capsBundle(f: ImportFixture) {
  const input = ImportBundle.parse(await bundle(f));
  const revision = required(input.revisions[0]),
    writeup = required(input.writeups[0]),
    thread = required(input.threads[0]);
  const comment = required(input.comments[0]),
    send = required(input.sends[0]),
    delivery = required(input.deliveries[0]);
  input.revisions = Array.from({ length: LIMITS.importRevisions }, (_, i) => ({
    ...revision,
    id: randomUUID(),
    seq: i + 1,
  }));
  writeup.sourceBlob = await f.deps.blobs.put(
    f.ownerId,
    Buffer.from(
      JSON.stringify({ overview: "Synthetic boundary writeup", tldr: "", decisions: null, topics: {} }, null, 2),
    ),
    "application/json",
  );
  input.writeups = input.revisions.map((r) => ({ ...writeup, id: randomUUID(), revisionId: r.id }));
  input.topics = [];
  input.files = [];
  input.docAssets = [];
  const last = required(input.revisions.at(-1));
  const creation = required(input.revisions.at(-35));
  input.threads = Array.from({ length: LIMITS.importThreads }, (_, i) => ({
    ...thread,
    id: randomUUID(),
    createdRevisionId: i < 4 ? required(input.revisions.at(-34)).id : creation.id,
  }));
  input.deliveries = Array.from({ length: LIMITS.importDeliveries }, () => ({ ...delivery, id: randomUUID() }));
  input.sends = input.deliveries.map((d) => ({ ...send, id: randomUUID(), revisionId: last.id, deliveryId: d.id }));
  input.comments = Array.from({ length: LIMITS.importComments }, (_, i) => ({
    ...comment,
    id: randomUUID(),
    body: "x",
    threadId: required(input.threads[i % input.threads.length]).id,
    sendId: required(input.sends[i % input.sends.length]).id,
  }));
  return { input, creation };
}

export async function sharedTargetBundle(f: ImportFixture) {
  const input = await replayBundle(f, 1, 1);
  const revision = required(input.revisions[0]);
  const thread = required(input.threads[0]);
  const line = "\\".repeat(65536);
  input.files = [
    {
      ...required(input.files[0]),
      revisionId: revision.id,
      path: "a.txt",
      role: "diff",
      status: "added",
      newBlob: await f.deps.blobs.put(f.ownerId, Buffer.from(line), "text/plain"),
    },
  ];
  thread.target = { kind: "lines", path: "a.txt", side: "new", start: 1, end: 1, lines: [line], before: [], after: [] };
  input.sends = Array.from({ length: 100 }, () => ({
    id: randomUUID(),
    reviewId: input.review.id,
    revisionId: revision.id,
    kind: "go",
    mode: "fix-clear",
    instruction: null,
    deliveryId: null,
    setAsideAt: null,
    createdAt: revision.createdAt,
  }));
  input.comments = input.sends.flatMap((send) =>
    Array.from({ length: 100 }, () => ({
      id: randomUUID(),
      reviewId: input.review.id,
      threadId: thread.id,
      author: "user",
      body: "x",
      outcome: null,
      sendId: send.id,
      createdAt: revision.createdAt,
      updatedAt: revision.createdAt,
    })),
  );
  return { input, thread };
}

export async function nestedSourceBundle(f: ImportFixture) {
  const input = await replayBundle(f, 20, 0);
  input.files = [];
  const prefix = '{"overview":"Synthetic","tldr":"","decisions":null,"topics":{},"junk":';
  const depth = Math.floor((LIMITS.publishJsonBytes - prefix.length - 2) / 2);
  const source = Buffer.from(`${prefix}${"[".repeat(depth)}0${"]".repeat(depth)}}`.padEnd(LIMITS.publishJsonBytes));
  expect(source.byteLength).toBe(8 * 1024 * 1024);
  const hash = await f.deps.blobs.put(f.ownerId, source, "application/json");
  for (const row of input.writeups) row.sourceBlob = hash;
  return input;
}

export const metadataShapes = [
  { label: "600 long multibyte paths", files: 600, length: 2815, character: "界", threads: 1000 },
  { label: "1899 body-capped paths", files: 1899, length: 4000, character: "x", threads: 1000 },
  { label: "3000 ordinary paths", files: 3000, length: 60, character: "x", threads: 300 },
];

export async function metadataBundle(f: ImportFixture, shape: (typeof metadataShapes)[number]) {
  const input = await replayBundle(f, 2, shape.threads);
  const file = required(input.files[0]);
  const first = required(input.revisions[0]).id;
  input.files = Array.from({ length: shape.files }, (_, i) => ({
    ...file,
    id: randomUUID(),
    revisionId: first,
    role: "diff",
    status: "added",
    path: metadataPath(i, shape.length, shape.character),
    newBlob: null,
    flag: "binary",
    ord: i,
  }));
  input.files.push({ ...required(input.files[0]), id: randomUUID(), path: "x", ord: shape.files });
  for (const thread of input.threads) thread.target = { kind: "file", path: "x" };
  // ISO timestamps without fractional seconds keep the 1899-file reproduction inside 8 MiB.
  for (const thread of input.threads) thread.createdAt = thread.updatedAt = "2026-01-01T00:00:00Z";
  return input;
}

export const unchangedSideShapes = [
  { threads: 60, sideBytes: 316_000 },
  { threads: 300, sideBytes: 72_000 },
];

export async function unchangedSidesBundle(f: ImportFixture, shape: (typeof unchangedSideShapes)[number]) {
  const input = await replayBundle(f, 40, shape.threads);
  const file = required(input.files[0]);
  const hashes = await Promise.all(
    Array.from({ length: 10 }, (_, i) =>
      f.deps.blobs.put(f.ownerId, Buffer.from(`needle\n${String(i).repeat(shape.sideBytes - 7)}`), "text/plain"),
    ),
  );
  input.files = input.revisions.flatMap((r) =>
    hashes.map((hash, i) => ({
      ...file,
      id: randomUUID(),
      revisionId: r.id,
      role: "diff",
      status: "added",
      path: `${i}.txt`,
      newBlob: hash,
      ord: i,
    })),
  );
  for (const [i, thread] of input.threads.entries())
    thread.target = {
      kind: "lines",
      path: `${i % 10}.txt`,
      side: "new",
      start: 1,
      end: 1,
      lines: ["needle"],
      before: [],
      after: [],
    };
  return input;
}
