import { expect, test, vi } from "vitest";
import { RetainedSources } from "./retained.ts";

vi.mock("@emend/contract", async (original) => {
  const contract = await original<typeof import("@emend/contract")>();
  return { ...contract, LIMITS: { ...contract.LIMITS, revisionBytes: 16 } };
});

test("retained source and asset buffers share one revision budget and deduplicate", () => {
  const sources = new RetainedSources();
  const doc = sources.keep("doc.txt", Buffer.alloc(8, 65));
  expect(sources.keep("alias.txt", Buffer.alloc(8, 65))).toBe(doc);
  expect(sources.get("alias.txt")).toBe(doc);
  const asset = sources.keep("asset.png", Buffer.alloc(8, 66));
  expect(sources.get("asset.png")).toBe(asset);
  expect(() => sources.keep("overflow.png", Buffer.from("C"))).toThrow("the docs pass the revision size limit");
  expect(sources.get("overflow.png")).toBeUndefined();
  expect(sources.keep("other.png", Buffer.alloc(8, 66))).toBe(asset);
});
