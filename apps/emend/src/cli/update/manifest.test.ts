import { expect, test } from "vitest";
import { isInstalledManifest, isPnpmProjects, isReleaseManifest } from "./manifest.ts";

test("installed manifests allow extra fields and do not require a release version", () => {
  for (const manifest of [
    { name: "@shllg/emend" },
    { name: "@shllg/emend", version: "dev", private: true },
    { name: "@shllg/emend", emendLocalBuild: "" },
    { name: "@shllg/emend", emendLocalBuild: "abc123" },
    { name: "@shllg/emend", emendLocalBuild: undefined },
  ]) {
    expect(isInstalledManifest(manifest)).toBe(true);
  }
});

test.each([null, [], "@shllg/emend", {}, { name: "other" }, { name: 1 }])(
  "rejects an invalid package identity: %j",
  (manifest) => {
    expect(isInstalledManifest(manifest)).toBe(false);
    expect(isReleaseManifest(manifest)).toBe(false);
  },
);

test.each([null, false, 1, [], {}])("rejects a non-string local build marker: %j", (emendLocalBuild) => {
  const manifest = { name: "@shllg/emend", version: "1.2.3", emendLocalBuild };
  expect(isInstalledManifest(manifest)).toBe(false);
  expect(isReleaseManifest(manifest)).toBe(false);
});

test.each(["0.0.0", "1.2.3", "10.20.300"])("accepts release version %s", (version) => {
  expect(isReleaseManifest({ name: "@shllg/emend", version, emendLocalBuild: "", extra: true })).toBe(true);
});

test.each([
  undefined,
  null,
  123,
  "",
  "1.2",
  "1.2.3.4",
  "01.2.3",
  "1.02.3",
  "1.2.03",
  "1.2.3-rc.1",
  "1.2.3+build",
  "v1.2.3",
  " 1.2.3",
  "1.2.3 ",
  "-1.2.3",
])("rejects an invalid release version: %j", (version) => {
  expect(isReleaseManifest({ name: "@shllg/emend", version })).toBe(false);
});

test("pnpm lists allow empty projects, extra fields and arbitrary dependency names and strings", () => {
  expect(isPnpmProjects([])).toBe(true);
  expect(
    isPnpmProjects([
      {},
      { dependencies: undefined },
      { dependencies: {} },
      {
        name: "global",
        dependencies: {
          "@shllg/emend": { version: "1.2.3", path: "/global/emend", extra: true },
          other: { version: "dev", path: "" },
        },
      },
    ]),
  ).toBe(true);
});

test.each([null, {}, "[]", [null], [[]], [{ dependencies: null }], [{ dependencies: [] }]])(
  "rejects an invalid pnpm list or project: %j",
  (value) => {
    expect(isPnpmProjects(value)).toBe(false);
  },
);

test.each([
  null,
  [],
  {},
  "package",
  { version: "1.2.3" },
  { path: "/global/other" },
  { version: 1, path: "" },
  { version: "", path: null },
])("rejects malformed dependencies even when emend's entry is valid: %j", (other) => {
  expect(
    isPnpmProjects([{ dependencies: { "@shllg/emend": { version: "1.2.3", path: "/global/emend" }, other } }]),
  ).toBe(false);
});
