import { expect, test } from "vitest";
import { expectPaced, type PacingEvent, unitsOf } from "./pacing-test-support.ts";

const unit: PacingEvent = { kind: "payload-copy" };
const yielded: PacingEvent = { kind: "yield", phase: "import-placement-copy" };
const check = (events: PacingEvent[]) => expectPaced(events, "import-placement-copy", unitsOf("payload-copy"), 1);

test("pacing assertion checks leading and trailing work without relying on probe-side counters", () => {
  expect(() => check([unit, unit, yielded, yielded])).toThrow("units between yields");
  expect(() => check([yielded, unit, yielded, unit, unit])).toThrow("units between yields");
});

test("pacing assertion requires real work and two matching yields", () => {
  expect(() => check([yielded, yielded])).toThrow("input must exceed");
  expect(() => check([unit, yielded, unit])).toThrow("at least two yields");
});

test("a yield of any phase ends a work run", () => {
  expect(check([unit, yielded, unit, { kind: "yield", phase: "publish-render" }, unit, yielded])).toBe(3);
});
