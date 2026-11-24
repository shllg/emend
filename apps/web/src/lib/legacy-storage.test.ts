import { beforeEach, expect, test, vi } from "vitest";
import { moveLegacyStorage } from "./legacy-storage.ts";

beforeEach(() => localStorage.clear());

test("copies an old key to the new name and keeps the old one", () => {
  localStorage.setItem("emend.theme", "dark");
  localStorage.setItem("emend.layout.v1", '{"inboxCollapsed":true}');
  localStorage.setItem("emend.draft.review-1.thread", "half a comment");
  localStorage.setItem("emend:inbox-kind", "review");
  moveLegacyStorage();
  expect(Object.fromEntries(Object.entries(localStorage))).toEqual({
    "emend.theme": "dark",
    "emend.layout.v1": '{"inboxCollapsed":true}',
    "emend.draft.review-1.thread": "half a comment",
    "emend:inbox-kind": "review",
    "recense.theme": "dark",
    "recense.layout.v1": '{"inboxCollapsed":true}',
    "recense.draft.review-1.thread": "half a comment",
    "recense:inbox-kind": "review",
  });
});

test("keeps a value already stored under the new name, and never writes the old key", () => {
  localStorage.setItem("emend.theme", "dark");
  localStorage.setItem("recense.theme", "light");
  moveLegacyStorage();
  expect(Object.fromEntries(Object.entries(localStorage))).toEqual({ "emend.theme": "dark", "recense.theme": "light" });
  // A newer value an old tab wrote after the copy does not replace the new one on the next load either.
  localStorage.setItem("emend.theme", "newer");
  moveLegacyStorage();
  expect(localStorage.getItem("recense.theme")).toBe("light");
});

test("leaves other keys alone and does nothing the second time", () => {
  localStorage.setItem("unrelated", "x");
  localStorage.setItem("emender.note", "not ours");
  moveLegacyStorage();
  moveLegacyStorage();
  expect(Object.fromEntries(Object.entries(localStorage))).toEqual({ unrelated: "x", "emender.note": "not ours" });
});

test("blocked storage, even when reaching it throws, does not throw", () => {
  const blocked = vi.spyOn(window, "localStorage", "get").mockImplementation(() => {
    throw new DOMException("denied", "SecurityError");
  });
  try {
    expect(() => moveLegacyStorage()).not.toThrow();
  } finally {
    blocked.mockRestore();
  }
});

test("the boot module copies the old layout before the layout store loads, so the saved layout survives", async () => {
  localStorage.setItem("emend.layout.v1", JSON.stringify({ proseSize: 18 }));
  vi.resetModules();
  // The same order main.tsx has: the boot module first, then anything that reads or writes storage at load.
  await import("./legacy-storage-boot.ts");
  const { layoutStore } = await import("./layout-store.ts");
  expect(layoutStore.getSnapshot().proseSize).toBe(18);
  expect(JSON.parse(localStorage.getItem("recense.layout.v1") ?? "{}").proseSize).toBe(18);
  expect(localStorage.getItem("emend.layout.v1")).not.toBeNull();
});

test("a storage that throws keeps what it has", () => {
  const broken = {
    length: 1,
    key: () => {
      throw new Error("denied");
    },
  } as unknown as Storage;
  expect(() => moveLegacyStorage(broken)).not.toThrow();
});
