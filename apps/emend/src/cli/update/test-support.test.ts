import { join } from "node:path";
import { expect, test } from "vitest";
import { runChild } from "./run.ts";
import { makeFake } from "./test-support.ts";

test.each([
  ["list", "--global", "--json", "--depth", "0", "--ignore-pnpmfile"],
  ["add", "--json"],
  ["list", "--unknown"],
])("fake pnpm rejects unknown options for %j", async (...args) => {
  const fake = await makeFake(process.env.EMEND_HOME as string, "pnpm");
  const result = await runChild(join(fake.bin, "pnpm"), args, {
    cwd: fake.home,
    env: { PATH: fake.bin },
    timeoutMs: 1000,
    output: "capture",
  });
  expect(result.code).toBe(1);
  expect(result.stderr).toBe(`[ERROR] Unknown option: '${args.at(-1)?.slice(2)}'\n`);
});

test.each(["list", "add"])("fake pnpm accepts arbitrary config options for %s", async (verb) => {
  const fake = await makeFake(process.env.EMEND_HOME as string, "pnpm");
  const result = await runChild(join(fake.bin, "pnpm"), [verb, "--config.synthetic=value"], {
    cwd: fake.home,
    env: { PATH: fake.bin },
    timeoutMs: 1000,
    output: "capture",
  });
  expect(result.code).toBe(0);
});
