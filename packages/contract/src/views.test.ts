import { expect, test } from "vitest";
import { z } from "zod";
import * as contract from "./index.ts";

test("HTML doc images are optional, bounded asset paths", () => {
  const schema = contract.RevisionView.shape.docs;
  const doc = { path: "page.html", kind: "html", contentUrl: "/content/synthetic/page.html" };
  for (const images of [[], ["images/first.png", "images/second image.svg"]])
    expect(schema.parse([{ ...doc, images }])).toEqual([{ ...doc, images }]);
  for (const images of [
    ["../outside.png"],
    ["https://example.com/image.png"],
    [42],
    Array.from({ length: contract.LIMITS.filesPerRevision + 1 }, () => "image.png"),
  ])
    expect(schema.safeParse([{ ...doc, images }]).success).toBe(false);
});

test("HTML doc looks accept recense, custom or absence, and reject other values", () => {
  const schema = contract.RevisionView.shape.docs;
  const doc = { path: "page.html", kind: "html", contentUrl: "/content/synthetic/page.html" };
  expect(schema.parse([doc])).toEqual([doc]);
  for (const look of ["recense", "custom"]) expect(schema.parse([{ ...doc, look }])).toEqual([{ ...doc, look }]);
  for (const look of ["other", "RECENSE", "", null, false])
    expect(schema.safeParse([{ ...doc, look }]).success).toBe(false);
  expect(schema.parse([{ ...doc, colorScheme: "light" }])).toEqual([{ ...doc, colorScheme: "light" }]);
  for (const colorScheme of ["auto", "dark", "", null, false])
    expect(schema.safeParse([{ ...doc, colorScheme }]).success).toBe(false);
});

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
  expect(contract.ReviewView.parse({ ...item, revisions: [] }).related).toEqual([]);
  // Four blocks of 200 plus up to 50 pins missing from those blocks.
  expect(
    contract.InboxList.safeParse({
      approvedActiveHours: 12,
      approvedActiveLimit: 5,
      serverTime: "2026-11-04T10:00:00.000Z",
      items: Array.from({ length: 850 }, () => item),
    }).success,
  ).toBe(true);
  expect(
    contract.InboxList.safeParse({
      approvedActiveHours: 12,
      approvedActiveLimit: 5,
      serverTime: "2026-11-04T10:00:00.000Z",
      items: Array.from({ length: 851 }, () => item),
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
  expect(
    contract.RenderedBlock.safeParse({
      id: "overview-12345678",
      section: "overview",
      kind: "chart",
      html: "",
      text: "{}",
      source: "{}",
    }).success,
  ).toBe(true);
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

test("rendered glossary terms are optional, bounded and reference validated blocks", () => {
  const term = { term: "Budget", definition: "Attempts.", blockId: "glossary-12345678" };
  expect(contract.RenderedWriteup.parse({ sections: [], terms: [term] }).terms).toEqual([term]);
  expect(contract.RenderedWriteup.parse({ sections: [] })).not.toHaveProperty("terms");
  for (const patch of [{ blockId: "bad" }, { term: "" }, { term: "x".repeat(101) }, { definition: "x".repeat(2001) }])
    expect(contract.RenderedWriteup.safeParse({ sections: [], terms: [{ ...term, ...patch }] }).success).toBe(false);
  expect(contract.GlossaryTerm.parse({ ...term, term: "x".repeat(100), definition: "x".repeat(2000) })).toBeDefined();
  expect(contract.GlossaryTerm.parse({ ...term, definition: "" })).toBeDefined();
  expect(
    contract.RenderedWriteup.safeParse({ sections: [], terms: Array.from({ length: 50 }, () => term) }).success,
  ).toBe(true);
  expect(
    contract.RenderedWriteup.safeParse({ sections: [], terms: Array.from({ length: 51 }, () => term) }).success,
  ).toBe(false);
});

test("rendered writeups omit invalid stored areas instead of refusing the revision", () => {
  expect(contract.RenderedWriteup.parse({ sections: [], area: "Requests" }).area).toBe("Requests");
  for (const area of ["", " ", "x".repeat(61), "bad\u200earea", "bad\narea", "\ud800", 42, null]) {
    expect(contract.RenderedWriteup.parse({ sections: [], area }).area).toBeUndefined();
  }
  const schema = contract.RevisionView.shape.changedSince;
  for (const changedSince of [undefined, 1, 3]) expect(schema.parse(changedSince)).toBe(changedSince);
  for (const changedSince of [null, 0, -1, 1.5]) expect(schema.safeParse(changedSince).success).toBe(false);
});

test("rendered needsYou preserves valid and empty lists and drops invalid stored values", () => {
  const item = { kind: "answer", topic: "routing", blockIds: ["needsYou-0123abcd", "needsYou-0123abcd-2"] };
  for (const needsYou of [[], [item]]) {
    expect(contract.RenderedWriteup.parse({ sections: [], needsYou }).needsYou).toEqual(needsYou);
  }
  expect(contract.RenderedWriteup.parse({ sections: [] })).not.toHaveProperty("needsYou");
  for (const needsYou of [
    null,
    42,
    [{ ...item, kind: "unknown" }],
    [{ ...item, topic: "Bad slug" }],
    [{ ...item, blockIds: ["overview-0123abcd"] }],
    [{ ...item, blockIds: ["bad"] }],
    Array.from({ length: 5 }, () => item),
  ]) {
    expect(contract.RenderedWriteup.parse({ sections: [], needsYou }).needsYou).toBeUndefined();
  }
  const block = {
    id: item.blockIds[0],
    section: "needsYou",
    kind: "paragraph",
    html: "<p>Choose.</p>",
    text: "Choose.",
  };
  expect(
    contract.RenderedWriteup.parse({
      sections: [{ key: "needsYou", label: "Needs you", topic: null, blocks: [block] }],
      needsYou: [item],
    }).needsYou,
  ).toEqual([item]);
});

test("rendered newInRevision preserves valid lists and drops invalid stored values", () => {
  const item = { topic: "routing", blockIds: ["newInRevision-0123abcd", "newInRevision-0123abcd-2"] };
  for (const newInRevision of [
    [item],
    [{ ...item, blockId: "t-routing-body-0123abcd" }],
    [{ section: "checked", blockId: "checked-0123abcd", blockIds: item.blockIds }],
    [{ blockId: "overview-0123abcd", blockIds: [] }],
  ]) {
    expect(contract.RenderedWriteup.parse({ sections: [], newInRevision }).newInRevision).toEqual(newInRevision);
  }
  expect(contract.RenderedWriteup.parse({ sections: [] })).not.toHaveProperty("newInRevision");
  for (const newInRevision of [
    [],
    null,
    42,
    [{ ...item, section: "unknown" }],
    [{ ...item, topic: "Bad slug" }],
    [{ ...item, blockIds: ["overview-0123abcd"] }],
    [{ ...item, blockIds: ["bad"] }],
    [{ ...item, blockId: "bad" }],
    [{ ...item, blockId: "newInRevision-0123abcd" }],
    [{ ...item, blockId: "doc-0123abcd-0123abcd" }],
    Array.from({ length: 13 }, () => item),
  ]) {
    expect(contract.RenderedWriteup.parse({ sections: [], newInRevision }).newInRevision).toBeUndefined();
  }
  const block = {
    id: item.blockIds[0],
    section: "newInRevision",
    kind: "paragraph",
    html: "<p>Choose.</p>",
    text: "Choose.",
  };
  expect(
    contract.RenderedWriteup.parse({
      sections: [{ key: "newInRevision", label: "New in this revision", topic: null, blocks: [block] }],
      newInRevision: [item],
    }).newInRevision,
  ).toEqual([item]);
});

test("related reviews default to an empty list and cap code reviews plus one intent review", () => {
  expect(contract.LIMITS.relatedReviews).toBe(8);
  const schema = contract.ReviewView.shape.related;
  expect(schema.parse(undefined)).toEqual([]);
  const entry = {
    id: "22222222-2222-4222-8222-222222222222",
    role: "intent",
    title: "Synthetic intent",
    state: "approved",
  };
  expect(contract.RelatedReview.parse(entry)).toEqual(entry);
  expect(schema.parse([entry, { ...entry, role: "code", state: "open" }])).toHaveLength(2);
  expect(schema.safeParse(Array.from({ length: 9 }, () => entry)).success).toBe(true);
  expect(schema.safeParse(Array.from({ length: 10 }, () => entry)).success).toBe(false);
  for (const patch of [
    { id: "bad" },
    { role: "other" },
    { state: "unknown" },
    { title: " " },
    { title: "x".repeat(201) },
  ])
    expect(contract.RelatedReview.safeParse({ ...entry, ...patch }).success).toBe(false);
});

test("deviations are a revision section and a rendered section with stable block ids", () => {
  expect(contract.NewInRevisionSection.parse("deviations")).toBe("deviations");
  const block = {
    id: "deviations-12345678",
    section: "deviations",
    kind: "paragraph",
    html: "<p>None.</p>",
    text: "None.",
  };
  expect(contract.BlockId.parse(block.id)).toBe(block.id);
  expect(
    contract.RenderedWriteup.parse({
      sections: [{ key: "deviations", label: "Deviations from the approved intent", topic: null, blocks: [block] }],
    }).sections[0]?.blocks,
  ).toEqual([block]);
});

test("the look `emend`, as named before the rename, is accepted and read as `recense`", () => {
  const schema = contract.RevisionView.shape.docs;
  const doc = { path: "page.html", kind: "html", contentUrl: "/content/synthetic/page.html" };
  expect(schema.parse([{ ...doc, look: "emend" }])).toEqual([{ ...doc, look: "recense" }]);
  expect(contract.HtmlLookValue.parse("emend")).toBe("recense");
  expect(contract.HtmlLookValue.safeParse("EMEND").success).toBe(false);
});

test("the wire spells the recense look `emend`, so 0.17 readers still accept it in both directions", () => {
  // The schemas of 0.17: an old CLI reading a publish response, an old hub reading an import bundle row.
  const oldLook = z.enum(["emend", "custom"]);
  const oldPublishResponse = z.object({ htmlLooks: z.array(z.object({ path: z.string(), look: oldLook })).optional() });
  const oldImportFile = z.object({ look: oldLook.nullable().optional() });
  expect(contract.wireHtmlLook("recense")).toBe("emend");
  expect(contract.wireHtmlLook("custom")).toBe("custom");
  // New hub to old CLI: the wire value passes the old schema and the new one reads it as `recense`.
  const response = { htmlLooks: [{ path: "a.html", look: contract.wireHtmlLook("recense") }] };
  expect(oldPublishResponse.parse(response)).toEqual(response);
  expect(contract.PublishResponse.shape.htmlLooks.parse(response.htmlLooks)).toEqual([
    { path: "a.html", look: "recense" },
  ]);
  // New CLI to old hub: a request row carries `emend`, and a new hub reads `emend` or `recense` alike.
  const row = { look: contract.wireHtmlLook("recense") };
  expect(oldImportFile.parse(row)).toEqual(row);
  expect(oldImportFile.safeParse({ look: "recense" }).success).toBe(false);
  expect(contract.HtmlLookValue.parse(row.look)).toBe("recense");
  expect(contract.HtmlLookValue.parse("recense")).toBe("recense");
});
