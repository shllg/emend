import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { expect, test } from "vitest";
import { VERSION } from "./version.ts";

test("VERSION is the version in apps/recense/package.json", () => {
  const manifest: { version: string } = JSON.parse(
    readFileSync(fileURLToPath(new URL("../package.json", import.meta.url)), "utf8"),
  );
  expect(VERSION).toBe(manifest.version);
});
