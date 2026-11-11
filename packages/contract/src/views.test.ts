import { expect, test } from "vitest";
import * as contract from "./index.ts";

test("review views validate their states, limits, rendered blocks and doc variants", () => {
  expect(contract.ReviewState.options).toEqual(["open", "approved", "settled"]);
  expect(contract.LIMITS.inboxItems).toBe(200);
  const id = "11111111-1111-4111-8111-111111111111";
  const item = {
    id,
    title: "Synthetic",
    origin: { id, name: "Workshop" },
    repo: null,
    branch: null,
    state: "open",
    newestRevision: 1,
    unsentCount: 0,
    openThreads: 0,
    agentWaiting: false,
    pendingSend: false,
    updatedAt: "2026-01-01T00:00:00.000Z",
    movedTo: null,
    list: "active",
    snoozed: false,
    snoozedUntil: null,
    activeUntil: null,
    releasedAt: null,
    pickedUpAt: null,
    kind: "review",
  };
  expect(contract.InboxItem.safeParse({ ...item, pickedUpAt: "2026-01-01T00:00:00.000Z" }).success).toBe(true);
  expect(contract.InboxItem.safeParse({ ...item, pickedUpAt: "yesterday" }).success).toBe(false);
  const { pickedUpAt: _omitted, ...withoutPickedUp } = item;
  expect(contract.InboxItem.safeParse(withoutPickedUp).success).toBe(false);
  expect(contract.InboxItem.parse(item).project).toBeNull();
  expect(contract.ReviewView.parse({ ...item, revisions: [] }).project).toBeNull();
  // The cap of 200 applies to each of the three lists.
  expect(
    contract.InboxList.safeParse({
      serverTime: "2026-11-04T10:00:00.000Z",
      items: Array.from({ length: 600 }, () => item),
    }).success,
  ).toBe(true);
  expect(
    contract.InboxList.safeParse({
      serverTime: "2026-11-04T10:00:00.000Z",
      items: Array.from({ length: 601 }, () => item),
    }).success,
  ).toBe(false);
  expect(
    contract.RenderedBlock.safeParse({
      id: "overview-12345678",
      section: "overview",
      kind: "paragraph",
      html: "<p>Hi</p>",
      text: "Hi",
    }).success,
  ).toBe(true);
  expect(
    contract.RenderedBlock.safeParse({ id: "bad", section: "overview", kind: "script", html: "", text: "" }).success,
  ).toBe(false);
  const revision = {
    seq: 1,
    base: null,
    head: null,
    main: null,
    writeupEmpty: false,
    topics: [],
    files: [],
    writeup: { sections: [] },
    docs: [],
    threads: [],
    changedBlocks: [],
  };
  expect(contract.RevisionView.safeParse(revision).success).toBe(true);
  expect(
    contract.RevisionView.safeParse({
      ...revision,
      docs: [{ path: "a.html", kind: "html", contentUrl: "https://evil.example/a" }],
    }).success,
  ).toBe(false);
});

test("project names are nullable and bounded, with an absent name defaulting to null", () => {
  for (const schema of [contract.InboxItem.shape.project, contract.ReviewView.shape.project]) {
    expect(schema.parse(null)).toBeNull();
    expect(schema.parse(undefined)).toBeNull();
    expect(schema.parse("x".repeat(200))).toBe("x".repeat(200));
    expect(schema.safeParse("").success).toBe(false);
    expect(schema.safeParse("x".repeat(201)).success).toBe(false);
  }
});

test("changed blocks retain validated IDs and positive revision sequences", () => {
  const schema = contract.RevisionView.shape.changedBlocks;
  const change = { blockId: "overview-12345678", revision: 3 };
  expect(schema.parse([change])).toEqual([change]);
  expect(schema.safeParse([{ ...change, blockId: "bad" }]).success).toBe(false);
  for (const revision of [0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1, null, undefined]) {
    expect(schema.safeParse([{ ...change, revision }]).success).toBe(false);
  }
});

test("comment sentOn is a required nullable positive revision sequence", () => {
  const schema = contract.ThreadView.shape.comments.element;
  const comment = {
    id: "11111111-1111-4111-8111-111111111111",
    author: "user",
    body: "Please explain.",
    sent: true,
    sentOn: 2,
  };
  expect(schema.parse(comment)).toEqual(comment);
  expect(schema.parse({ ...comment, sent: false, sentOn: null }).sentOn).toBeNull();
  expect(schema.parse({ ...comment, author: "agent", sent: false, sentOn: null }).sentOn).toBeNull();
  for (const sentOn of [0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1, undefined]) {
    expect(schema.safeParse({ ...comment, sentOn }).success).toBe(false);
  }
});
