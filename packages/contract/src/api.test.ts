import { expect, test } from "vitest";
import {
  API_PREFIX,
  Capabilities,
  FileFlag,
  FileRole,
  FileStatus,
  LIMITS,
  MIN_CLIENT_VERSION,
  OTHER_TOPIC,
  PublishResponse,
  reviewDownloadPath,
  SCOPES_BY_KIND,
  Scope,
  ServerStopping,
  ServerStopRequest,
  TokenKind,
} from "./index.ts";

test("exports the v1 API, limits, file vocabulary and reserved fallback", () => {
  expect(API_PREFIX).toBe("/api/v1");
  expect(MIN_CLIENT_VERSION).toBe("0.1.0");
  expect(LIMITS).toEqual({
    inboxItems: 200,
    agentReviews: 100,
    binItems: 200,
    importRevisions: 1000,
    importThreads: 1000,
    importComments: 10000,
    importSends: 1000,
    importDeliveries: 1000,
    importRows: 50000,
    importRenderedBytes: 1073741824,
    importDerivedBytes: 67108864,
    importPlacementBytes: 1073741824,
    publicJsonBytes: 4096,
    commentBodyChars: 20000,
    instructionChars: 4000,
    quoteChars: 2000,
    prefixSuffixChars: 32,
    diffContextLines: 3,
    titleChars: 200,
    headingsPerDoc: 1024,
    headingTextChars: 200,
    headingIdChars: 256,
    headingLookupBytesPerRevision: 33554432,
    diffSideBytes: 1048576,
    markdownDocBytes: 1048576,
    sourceLinesPerRevision: 200000,
    sourceBytesPerRevision: 16777216,
    htmlDocBytes: 8388608,
    downloadInlineBytes: 134217728,
    assetBytes: 26214400,
    htmlDocWithAssetsBytes: 52428800,
    revisionBytes: 268435456,
    blocksPerRevision: 100000,
    renderedBytesPerRevision: 268435456,
    filesPerRevision: 10000,
    mediaPerRevision: 50,
    agentNotesPerFile: 8,
    agentNotesPerRevision: 64,
    pathChars: 4096,
    pathSegmentChars: 255,
    topicsPerReview: 200,
    summaryChars: 2000,
    blastScopeChars: 32,
    blastNoteChars: 2000,
    writeupSectionBytes: 1048576,
    writeupBytes: 2097152,
    targetLines: 1000,
    targetTextChars: 65536,
    contextLineChars: 2000,
    commentsPerHandoff: 5000,
    handoffBytes: 16777216,
    waitingTakesPerOwner: 32,
    historyPerComment: 500,
    instructionsPerHandoff: 100,
    versionChars: 64,
    featuresCount: 64,
    featureChars: 64,
    errorMessageChars: 1000,
    publishJsonBytes: 8388608,
    requestJsonBytes: 1048576,
  });
  expect(FileRole.options).toEqual(["diff", "doc", "asset"]);
  expect(FileStatus.options).toEqual(["added", "modified", "deleted", "renamed", "mode-changed"]);
  expect(FileFlag.options).toEqual(["binary", "oversized"]);
  expect(OTHER_TOPIC).toEqual({ slug: "other", title: "Other changes" });
});

test.each([
  ["diff side", LIMITS.diffSideBytes],
  ["Markdown doc", LIMITS.markdownDocBytes],
  ["HTML doc", LIMITS.htmlDocBytes],
  ["publish JSON", LIMITS.publishJsonBytes],
  // Import caps the serialized writeup source blob at publishJsonBytes.
  ["writeup source", LIMITS.publishJsonBytes],
  ["writeup strings", LIMITS.writeupBytes],
] as const)("the asset upload ceiling covers the %s blob limit", (_role, limit) => {
  expect(LIMITS.assetBytes).toBeGreaterThanOrEqual(limit);
});

test("assigns only the specified scopes to each token kind", () => {
  expect([...Scope.options].sort()).toEqual(
    [
      "pairings:create",
      "devices:manage",
      "settings:manage",
      "server:stop",
      "publish",
      "take",
      "reply",
      "read",
      "comment",
      "send",
    ].sort(),
  );
  for (const scopes of Object.values(SCOPES_BY_KIND)) {
    for (const scope of scopes) expect(Scope.parse(scope)).toBe(scope);
  }
  expect(Scope.safeParse("approve").success).toBe(false);
  expect(TokenKind.options).toEqual(["admin", "agent", "reviewer"]);
  expect(SCOPES_BY_KIND).toEqual({
    admin: ["pairings:create", "devices:manage", "server:stop"],
    agent: ["publish", "take", "reply"],
    reviewer: ["read", "comment", "send", "pairings:create", "devices:manage", "settings:manage"],
  });
});

test("accepts initial and additive capabilities while stripping unknown fields", () => {
  const capabilities = { api: 1, version: "0.1.0", features: ["attach", "html-docs", "mcp"] };
  expect(Capabilities.parse({ ...capabilities, extra: true })).toEqual(capabilities);
  expect(Capabilities.safeParse({ ...capabilities, api: 2 }).success).toBe(false);
  expect(
    Capabilities.safeParse({ ...capabilities, features: [...capabilities.features, "future-feature"] }).success,
  ).toBe(true);
});

test("server stopping confirms only an accepted stop request", () => {
  expect(ServerStopRequest.parse({})).toEqual({});
  expect(ServerStopRequest.safeParse({ extra: true }).success).toBe(false);
  expect(ServerStopping.parse({ stopping: true })).toEqual({ stopping: true });
  for (const value of [{}, { stopping: false }, { stopping: "true" }, null])
    expect(ServerStopping.safeParse(value).success).toBe(false);
});

test("validates publish response ids, revision, URL and placement counts", () => {
  const response = {
    reviewId: "11111111-1111-4111-8111-111111111111",
    revision: 1,
    url: "http://127.0.0.1:3636/reviews/11111111-1111-4111-8111-111111111111",
    placed: 2,
    unplaced: 0,
    unrendered: [],
  };
  expect(PublishResponse.parse({ ...response, extra: true })).toEqual(response);
  for (const change of [
    { reviewId: "invalid" },
    { revision: 0 },
    { revision: 1.5 },
    { placed: -1 },
    { unplaced: 0.5 },
    { url: "not a url" },
    { url: "javascript:alert(1)" },
  ]) {
    expect(PublishResponse.safeParse({ ...response, ...change }).success).toBe(false);
  }
});

test("builds a revision download path with an encoded review id", () => {
  expect(reviewDownloadPath("review/id ?", 3)).toBe("/api/v1/reviews/review%2Fid%20%3F/revisions/3/download");
});
