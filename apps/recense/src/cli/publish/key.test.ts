import { expect, test } from "vitest";
import { docsKey, normalizeRemote, projectKey, reviewKey } from "./key.ts";

test("keys distinguish worktrees, branches, instances and concatenation boundaries", () => {
  expect(reviewKey("one", "/tmp/a", "main")).toBe(reviewKey("one", "/tmp/a", "main"));
  expect(reviewKey("one", "/tmp/a", "main")).not.toBe(reviewKey("one", "/tmp/b", "main"));
  expect(docsKey("ab", "c")).not.toBe(docsKey("a", "bc"));
  expect(docsKey("one", "plan")).toMatch(/^[a-f0-9]{64}$/);
  expect(projectKey("Synthetic")).toMatch(/^[a-f0-9]{64}$/);
  expect(projectKey("Synthetic")).not.toBe(projectKey("synthetic"));
  expect(projectKey("Synthetic")).not.toBe(docsKey("project", "Synthetic"));
  expect(normalizeRemote("HTTPS://user:password@EXAMPLE.TEST/org/repo.git/")).toBe("https://example.test/org/repo");
  expect(normalizeRemote("git@EXAMPLE.TEST:org/repo.git")).toBe("ssh://example.test/org/repo");
  expect(() => normalizeRemote("https://credential@")).toThrow("invalid origin URL");
});
