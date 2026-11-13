import { expect, test, vi } from "vitest";
import { chargePlacementMetadata } from "./placement-budget.ts";

function bytes(value: unknown) {
  let total = 0;
  chargePlacementMetadata(value, (n) => {
    total += n;
  });
  return total;
}
test("topic metadata charges title and summary text carried by Maps", () => {
  const empty = bytes(new Map([["garden", { title: "", summary: "" }]]));
  const text = bytes(new Map([["garden", { title: "界".repeat(200), summary: "界".repeat(2000) }]]));
  expect(text - empty).toBe(3 * 2200);
});
test("fix5: metadata counts shared structures once per job without serializing", () => {
  const renames = new Map(Array.from({ length: 600 }, (_, i) => [`${i}/${"界".repeat(1000)}`, null]));
  const stringify = vi.spyOn(JSON, "stringify").mockImplementation(() => {
    throw new Error("Unexpected JSON allocation");
  });
  try {
    const single = bytes([renames]);
    const shared = bytes(Array.from({ length: 1000 }, () => renames));
    const separate = bytes([renames, new Map(renames)]);
    expect(shared - single).toBeLessThan(32 * 1000);
    expect(separate).toBeGreaterThan(2 * single - 100);
    expect(single).toBeGreaterThan(600 * 3000); // UTF-8, not UTF-16 units.
    expect(stringify).not.toHaveBeenCalled();
    expect(bytes([renames])).toBe(single); // No cross-job identity retention.
  } finally {
    stringify.mockRestore();
  }
});
test("fix5: metadata stops at the first excess without visiting later fields", () => {
  const later = vi.fn(() => "must not be read");
  const value = {
    first: "x".repeat(1000),
    get later() {
      return later();
    },
  };
  let total = 0;
  expect(() =>
    chargePlacementMetadata(value, (n) => {
      if (n > 100 - total) throw new Error("budget exceeded");
      total += n;
    }),
  ).toThrow("budget exceeded");
  expect(later).not.toHaveBeenCalled();
});
test("fix5: unexpected metadata errors remain visible", () => {
  const failure = new Error("Synthetic bug");
  const value = {
    get path() {
      throw failure;
    },
  };
  expect(() => bytes(value)).toThrow(failure);
});
