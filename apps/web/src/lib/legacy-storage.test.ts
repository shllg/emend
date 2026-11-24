import { beforeEach, expect, test } from "vitest";
import { moveLegacyStorage } from "./legacy-storage.ts";

beforeEach(() => localStorage.clear());

test("copies an old key to the new name and removes the old one", () => {
  localStorage.setItem("emend.theme", "dark");
  localStorage.setItem("emend.layout.v1", '{"inboxCollapsed":true}');
  localStorage.setItem("emend.draft.review-1.thread", "half a comment");
  moveLegacyStorage();
  expect(Object.fromEntries(Object.entries(localStorage))).toEqual({
    "recense.theme": "dark",
    "recense.layout.v1": '{"inboxCollapsed":true}',
    "recense.draft.review-1.thread": "half a comment",
  });
});

test("keeps a value already stored under the new name and still drops the old key", () => {
  localStorage.setItem("emend.theme", "dark");
  localStorage.setItem("recense.theme", "light");
  moveLegacyStorage();
  expect(Object.fromEntries(Object.entries(localStorage))).toEqual({ "recense.theme": "light" });
});

test("leaves other keys alone and does nothing the second time", () => {
  localStorage.setItem("unrelated", "x");
  localStorage.setItem("emender.note", "not ours");
  moveLegacyStorage();
  moveLegacyStorage();
  expect(Object.fromEntries(Object.entries(localStorage))).toEqual({ unrelated: "x", "emender.note": "not ours" });
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
