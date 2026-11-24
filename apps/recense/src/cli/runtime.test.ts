import { fileURLToPath } from "node:url";
import { expect, test } from "vitest";
import { cliRuntime } from "./runtime.ts";

test("the CLI runtime uses the source entry and process.execPath by default", () => {
  expect(cliRuntime()).toEqual({
    node: process.execPath,
    entry: fileURLToPath(new URL("../cli.ts", import.meta.url)),
  });
});
test("the bundled runtime uses the bundle itself", () => {
  expect(cliRuntime({}, "file:///synthetic/dist/recense.mjs")).toEqual({
    node: process.execPath,
    entry: "/synthetic/dist/recense.mjs",
  });
});
test("both runtime paths are injectable", () => {
  expect(cliRuntime({ node: "/synthetic/node", entry: "/synthetic/entry.mjs" })).toEqual({
    node: "/synthetic/node",
    entry: "/synthetic/entry.mjs",
  });
});
