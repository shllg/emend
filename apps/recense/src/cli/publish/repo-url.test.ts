import { expect, test } from "vitest";
import { remoteToRepoUrl } from "./repo-url.ts";

test.each([
  ["git@github.com:owner/name.git", "https://github.com/owner/name"],
  ["github.com:owner/name", "https://github.com/owner/name"],
  ["ssh://git@github.com/owner/name.git", "https://github.com/owner/name"],
  ["ssh://git@git.example.test:2222/owner/name.git", "https://git.example.test/owner/name"],
  ["git://github.com/owner/name.git", "https://github.com/owner/name"],
  ["https://github.com/owner/name.git", "https://github.com/owner/name"],
  ["https://github.com/owner/name/", "https://github.com/owner/name"],
  ["  https://GitHub.com/Owner/Name  ", "https://github.com/Owner/Name"],
  ["https://git.example.test:8443/o/r.js", "https://git.example.test:8443/o/r.js"],
])("normalizes %j to %j", (remote, expected) => {
  expect(remoteToRepoUrl(remote)).toBe(expected);
});

test.each([
  "",
  "   ",
  "/home/someone/projects/repo",
  "../relative/repo",
  "file:///tmp/owner/name.git",
  "https://user:secret@github.com/owner/name.git",
  "https://token@github.com/owner/name.git",
  "ssh://user:secret@github.com/owner/name.git",
  "http://github.com/owner/name",
  "ftp://github.com/owner/name",
  "javascript:alert(1)",
  "https://github.com/owner",
  "https://github.com/group/sub/name",
  "https://github.com/owner/name?x=1",
  "https://github.com/owner/name#frag",
  "https://github.com/../name",
  "github-work:owner/name",
  "git@github-work:owner/name.git",
  "ssh://git@github-work/owner/name.git",
  "git@github.com:owner",
  "git@github.com:2222/owner",
  "https://gïthub.com/owner/name",
  "https://github.com/‮owner/name",
  "https://github.com/owner/na me",
  "https://github.com\\@evil.test/owner/name",
])("gives no URL for %j", (remote) => {
  expect(remoteToRepoUrl(remote)).toBeNull();
});
