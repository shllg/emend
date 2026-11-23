import { describe, expect, test } from "vitest";
import {
  ISSUE_REFS,
  IssueRefs,
  PublishLinks,
  PublishManifest,
  PublishRequest,
  plainIssueTitle,
  RepoUrl,
} from "./index.ts";

const link = { url: "https://example.test/o/r/pull/7", label: "PR 7", kind: "pr" as const };
const manifest = {
  version: 1,
  title: "Synthetic",
  topics: [],
  files: [],
  writeup: { overview: "", tldr: "", decisions: null, topics: {} },
};

describe("links", () => {
  test("accept https links with a label and an optional kind", () => {
    expect(PublishLinks.parse([link, { url: "https://example.test/i/1", label: "Issue" }])).toHaveLength(2);
    expect(PublishLinks.safeParse(Array.from({ length: 8 }, () => link)).success).toBe(true);
    expect(PublishLinks.safeParse(Array.from({ length: 9 }, () => link)).success).toBe(false);
  });

  test.each([
    "javascript:alert(1)",
    "data:text/html,x",
    "http://example.test/x",
    "https://user@example.test/x",
    "https://user:pw@example.test/x",
    "//example.test/x",
    "https://",
    "https://example.test/a b",
    "https://example.test/‮",
    `https://example.test/${"a".repeat(2048)}`,
  ])("refuse the url %j", (url) => {
    expect(PublishLinks.safeParse([{ ...link, url }]).success).toBe(false);
  });

  test.each(["", "   ", "x".repeat(61), "a\nb", "a‮b"])("refuse the label %j", (label) => {
    expect(PublishLinks.safeParse([{ ...link, label }]).success).toBe(false);
  });

  test("refuse an unknown kind", () => {
    expect(PublishLinks.safeParse([{ ...link, kind: "video" }]).success).toBe(false);
  });
});

describe("repoUrl", () => {
  test.each(["https://github.com/owner/name", "https://git.example.test:8443/o/r.js", "https://a.b-c.test/x_y/z.z"])(
    "accepts %s",
    (value) => expect(RepoUrl.safeParse(value).success).toBe(true),
  );

  test.each([
    "http://github.com/o/r",
    "https://user@github.com/o/r",
    "https://github.com/o",
    "https://github.com/o/r/sub",
    "https://github.com/o/r/",
    "https://github.com/o/r?x=1",
    "https://github.com/o/r#x",
    "https://github.com/../r",
    "https://GitHub.com/o/r",
    "https://gïthub.com/o/r",
    "https://github.com/o/r r",
    "ssh://git@github.com/o/r",
    "file:///tmp/o/r",
    `https://github.com/o/${"r".repeat(2048)}`,
  ])("refuses %j", (value) => expect(RepoUrl.safeParse(value).success).toBe(false));
});

describe("manifest and request", () => {
  test("a manifest takes links, and drops an invalid repoUrl instead of failing", () => {
    expect(PublishManifest.parse({ ...manifest, links: [link], repoUrl: "https://github.com/o/r" })).toMatchObject({
      links: [link],
      repoUrl: "https://github.com/o/r",
    });
    expect(PublishManifest.parse({ ...manifest, repoUrl: "javascript:alert(1)" }).repoUrl).toBeUndefined();
    // null is a deliberate opt-out of the derived address, and stays null.
    expect(PublishManifest.parse({ ...manifest, repoUrl: null }).repoUrl).toBeNull();
    expect(PublishManifest.safeParse({ ...manifest, links: [{ ...link, url: "javascript:x" }] }).success).toBe(false);
  });

  test("a request refuses an invalid repoUrl or link", () => {
    const request = { reviewKey: "a".repeat(64), repo: null, branch: null, title: "T", base: null, head: null };
    const base = { ...request, topics: [], writeup: manifest.writeup, files: [] };
    expect(PublishRequest.safeParse({ ...base, links: [link], repoUrl: "https://github.com/o/r" }).success).toBe(true);
    expect(PublishRequest.safeParse({ ...base, repoUrl: "http://github.com/o/r" }).success).toBe(false);
    expect(PublishRequest.safeParse({ ...base, links: [{ ...link, url: "http://x.test" }] }).success).toBe(false);
  });
});

describe("issueRefs", () => {
  const ref = { number: 17, title: "Retries never stop", state: "open" as const };

  test("hold the limits", () => {
    expect(IssueRefs.safeParse(Array.from({ length: 64 }, (_, i) => ({ ...ref, number: i + 1 }))).success).toBe(true);
    expect(IssueRefs.safeParse(Array.from({ length: 65 }, (_, i) => ({ ...ref, number: i + 1 }))).success).toBe(false);
    expect(IssueRefs.safeParse([{ ...ref, title: "a".repeat(256) }]).success).toBe(true);
    expect(IssueRefs.safeParse([{ ...ref, title: "a".repeat(257) }]).success).toBe(false);
    expect(IssueRefs.safeParse([{ ...ref, number: 0 }]).success).toBe(false);
    expect(IssueRefs.safeParse([{ ...ref, number: ISSUE_REFS.maxNumber }]).success).toBe(true);
    expect(IssueRefs.safeParse([{ ...ref, number: 10_000_000 }]).success).toBe(false);
    expect(IssueRefs.safeParse([{ ...ref, state: "draft" }]).success).toBe(false);
    expect(IssueRefs.safeParse([{ ...ref, title: "  " }]).success).toBe(false);
  });

  test("refuse a repeated number", () => {
    expect(IssueRefs.safeParse([ref, { ...ref, title: "Other" }]).success).toBe(false);
  });

  test("a request refuses a control or format character in a title", () => {
    const request = { reviewKey: "a".repeat(64), repo: null, branch: null, title: "T", base: null, head: null };
    const base = { ...request, topics: [], writeup: manifest.writeup, files: [] };
    expect(PublishRequest.safeParse({ ...base, issueRefs: [ref] }).success).toBe(true);
    for (const title of ["a\u0007b", "a\u202eb", "a\nb"])
      expect(PublishRequest.safeParse({ ...base, issueRefs: [{ ...ref, title }] }).success).toBe(false);
  });

  test("plainIssueTitle flattens, trims and cuts", () => {
    expect(plainIssueTitle("  a \t\n b\u0007c\u200bd ")).toBe("a b cd");
    expect(plainIssueTitle("\u0007 \n")).toBe("");
    expect(plainIssueTitle("a".repeat(300))).toHaveLength(256);
    // A surrogate pair is never split at the cut.
    const cut = plainIssueTitle(`${"a".repeat(255)}\u{1F600}`);
    expect(cut).toBe("a".repeat(255));
    expect(plainIssueTitle(`${"a".repeat(254)}\u{1F600}`)).toHaveLength(256);
    // Trim again after the cut.
    expect(plainIssueTitle(`${"a".repeat(255)} b`)).toBe("a".repeat(255));
  });

  test("a manifest cleans titles to plain text and keeps markup literal", () => {
    const parsed = PublishManifest.parse({
      ...manifest,
      issueRefs: [{ ...ref, title: "<img src=x onerror=alert(1)>\u0007 <b>Fix</b>\u202e" }],
    });
    expect(parsed.issueRefs).toEqual([{ ...ref, title: "<img src=x onerror=alert(1)> <b>Fix</b>" }]);
  });

  test("a title refuses characters that render as nothing", () => {
    const request = { reviewKey: "a".repeat(64), repo: null, branch: null, title: "T", base: null, head: null };
    const base = { ...request, topics: [], writeup: manifest.writeup, files: [] };
    for (const title of ["ㅤ", "Fix️ bug", "\u{E0041}x", "͏"])
      expect(PublishRequest.safeParse({ ...base, issueRefs: [{ ...ref, title }] }).success).toBe(false);
  });

  test("the manifest cleaner drops characters that render as nothing", () => {
    expect(plainIssueTitle("Fixㅤ bug️")).toBe("Fix bug");
    expect(plainIssueTitle("ㅤᅟᅠﾠ")).toBe("");
    const parsed = PublishManifest.parse({ ...manifest, issueRefs: [{ ...ref, title: "Fixㅤ bug️" }] });
    expect(parsed.issueRefs).toEqual([{ ...ref, title: "Fix bug" }]);
    expect(PublishManifest.safeParse({ ...manifest, issueRefs: [{ ...ref, title: "ㅤㅤ" }] }).success).toBe(false);
  });

  test("labels keep their rule for these characters", () => {
    expect(PublishLinks.safeParse([{ ...link, label: "PRㅤ 7" }]).success).toBe(true);
    expect(PublishLinks.safeParse([{ ...link, label: "PR​ 7" }]).success).toBe(false);
  });

  test("a manifest still fails on an entry invalid after cleaning", () => {
    for (const issueRefs of [
      [{ ...ref, title: "\u0007\u200b " }],
      [{ ...ref, number: 0 }],
      [{ ...ref, state: "draft" }],
      [ref, { ...ref, title: "Other" }],
      [{ ...ref, title: 5 }],
    ])
      expect(PublishManifest.safeParse({ ...manifest, issueRefs }).success).toBe(false);
  });
});
