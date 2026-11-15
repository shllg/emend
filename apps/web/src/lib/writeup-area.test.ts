import { expect, test } from "vitest";
import { sharedDiffFolder } from "./writeup-area.ts";

test.each([
  [[], undefined],
  [["src/cli/serve.ts"], "src/cli"],
  [["src/cli/serve.ts", "src/cli/commands/run.ts"], "src/cli"],
  [["src/cli/serve.ts", "src/core/run.ts"], "src"],
  [["src/cli.ts", "docs/guide.md"], undefined],
  [["src/cli.ts", "README.md"], undefined],
  [["README.md"], undefined],
  [["source/a.ts", "src/b.ts"], undefined],
] as const)("deepest shared diff folder for %j is %s", (paths, expected) => {
  expect(sharedDiffFolder(paths.map((path) => ({ path, role: "diff" })))).toBe(expected);
});

test("docs and assets do not affect the folder", () => {
  expect(sharedDiffFolder([{ path: "docs/guide.md", role: "doc" }])).toBeUndefined();
  expect(
    sharedDiffFolder([
      { path: "src/cli/a.ts", role: "diff" },
      { path: "guide.md", role: "doc" },
      { path: "photo.png", role: "asset" },
    ]),
  ).toBe("src/cli");
});
