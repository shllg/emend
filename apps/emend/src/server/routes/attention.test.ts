import { ImportBundle, MachineRegistered, PairingCreated, PublishResponse, RevisionView } from "@emend/contract";
import { expect, test } from "vitest";
import { snapshot } from "../../cli/attach/bundle.ts";
import { mailboxFixture } from "../mailbox/test-support.ts";

test("published attention survives views and export/import; absence and importance order stay intact", async () => {
  const source = await mailboxFixture();
  const destination = await mailboxFixture();
  try {
    const topics = ["skim", "review", "critical", undefined].map((attention, importance) => ({
      slug: `seed-${importance}`,
      title: `Seed ${importance}`,
      summary: "A synthetic garden",
      importance,
      ...(attention ? { attention } : {}),
    }));
    const response = await source.request(
      "/publish",
      "POST",
      {
        reviewKey: "b".repeat(64),
        repo: null,
        branch: null,
        title: "Synthetic attention",
        base: null,
        head: null,
        topics,
        files: [],
        writeup: { overview: "Synthetic overview", tldr: "", decisions: null, topics: {} },
      },
      "agent",
    );
    expect(response.status).toBe(200);
    const { reviewId } = PublishResponse.parse(await response.json());
    const view = async (f: typeof source) => {
      const response = await f.request(`/reviews/${reviewId}/revisions/1`, "GET");
      expect(response.status).toBe(200);
      return RevisionView.parse(await response.json());
    };
    expect((await view(source)).topics).toEqual(topics);
    expect((await view(source)).topics[3]).not.toHaveProperty("attention");
    const exported = await source.db.transaction((q) =>
      snapshot(q, source.ownerId, source.instanceId, reviewId, "http://127.0.0.1:3637", source.deps.now(), false),
    );
    expect(exported.kind).toBe("bundle");
    if (exported.kind !== "bundle") throw new Error("Expected an export bundle");
    const bundle = ImportBundle.parse(JSON.parse(exported.json));
    expect(bundle.topics.map((topic) => topic.attention)).toEqual(["skim", "review", "critical", undefined]);
    expect(bundle.topics[3]).not.toHaveProperty("attention");
    for (const hash of new Set(bundle.writeups.flatMap((row) => [row.sourceBlob, row.renderedBlob]))) {
      const bytes = await source.deps.blobs.get(source.ownerId, hash);
      if (!bytes) throw new Error("Missing synthetic writeup");
      await destination.deps.blobs.put(destination.ownerId, bytes, "application/json");
    }
    const pairing = PairingCreated.parse(
      await (await destination.request("/pairings", "POST", { purpose: "machine" })).json(),
    );
    const registered = await destination.request("/machines", "POST", {
      secret: new URL(pairing.url).hash.slice(1),
      instance: { id: source.instanceId, name: "Synthetic source" },
    });
    expect(registered.status).toBe(201);
    const { token } = MachineRegistered.parse(await registered.json());
    const imported = await destination.app.request("http://127.0.0.1:3636/api/v1/import", {
      method: "POST",
      headers: { Host: "127.0.0.1:3636", "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: exported.json,
    });
    expect(imported.status).toBe(201);
    expect((await view(destination)).topics).toEqual(topics);
    expect((await view(destination)).topics[3]).not.toHaveProperty("attention");
  } finally {
    await source.cleanup();
    await destination.cleanup();
  }
});
