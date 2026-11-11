import { readFile, writeFile } from "node:fs/promises";
import { PublishResponse, RevisionView, type WriteupInput } from "@emend/contract";
import { expect, test } from "vitest";
import { directFixture } from "../../cli/direct-test-support.ts";
import { mailboxFixture } from "../mailbox/test-support.ts";

const blank: WriteupInput = {
  overview: " \n",
  tldr: "\t",
  decisions: " ",
  glossary: "\n",
  topics: { routing: { why: " ", example: "\t", body: "\n" } },
};
const topic = { slug: "routing", title: "Routing", importance: 1, summary: "Synthetic" };

test.each([undefined, "writeup", "plan.md"])("publish round trip stores main %s and blank writeup", async (main) => {
  const f = await mailboxFixture();
  try {
    const hash = await f.deps.blobs.put(f.ownerId, Buffer.from("# Synthetic plan"), "text/markdown");
    const response = await f.request(
      "/publish",
      "POST",
      {
        reviewKey: "b".repeat(64),
        repo: null,
        branch: null,
        title: "Synthetic",
        base: null,
        head: null,
        main,
        topics: [topic],
        writeup: blank,
        files: [{ path: "plan.md", role: "doc", oldPath: null, oldBlob: null, newBlob: hash, flag: null }],
      },
      "agent",
    );
    expect(response.status).toBe(200);
    const published = PublishResponse.parse(await response.json());
    const view = RevisionView.parse(
      await (await f.request(`/reviews/${published.reviewId}/revisions/1`, "GET")).json(),
    );
    expect(view).toMatchObject({ main: main ?? null, writeupEmpty: true });
  } finally {
    await f.cleanup();
  }
});

test.each([
  "overview",
  "tldr",
  "outOfScope",
  "whereToLook",
  "context",
  "decisions",
  "glossary",
  "why",
  "example",
  "body",
] as const)("publish counts text in %s before rendering", async (field) => {
  const f = await mailboxFixture();
  try {
    const writeup = structuredClone(blank);
    if (field === "why" || field === "example" || field === "body")
      writeup.topics.routing = { why: " ", ...writeup.topics.routing, [field]: "<!-- text -->" };
    else writeup[field] = "<!-- text -->";
    const response = await f.request(
      "/publish",
      "POST",
      {
        reviewKey: "b".repeat(64),
        repo: null,
        branch: null,
        title: "Synthetic",
        base: null,
        head: null,
        topics: [topic],
        writeup,
        files: [],
      },
      "agent",
    );
    expect(response.status).toBe(200);
    const published = PublishResponse.parse(await response.json());
    const view = RevisionView.parse(
      await (await f.request(`/reviews/${published.reviewId}/revisions/1`, "GET")).json(),
    );
    expect(view).toMatchObject({ main: null, writeupEmpty: false });
  } finally {
    await f.cleanup();
  }
});

test("direct publish carries main from the manifest through the shared ingest path", async () => {
  const f = await directFixture();
  const manifest = JSON.parse(await readFile(f.manifest, "utf8"));
  await writeFile(
    f.manifest,
    JSON.stringify({ ...manifest, main: "plan.md", writeup: { overview: "", tldr: "", decisions: null, topics: {} } }),
  );
  const { result } = await f.publish();
  const server = await f.reviewer();
  const view = RevisionView.parse(await (await server.request(`/reviews/${result.reviewId}/revisions/1`)).json());
  expect(view).toMatchObject({ main: "plan.md", writeupEmpty: true });
});
