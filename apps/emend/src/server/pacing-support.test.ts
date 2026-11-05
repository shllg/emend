import { expect, test } from "vitest";
import { expectPaced, type PacingEvent, unitsOf } from "./pacing-test-support.ts";

const unit: PacingEvent = { kind: "payload-copy" };
const yielded: PacingEvent = { kind: "yield", phase: "import-placement-copy" };
const turn: PacingEvent = { kind: "turn" };
const check = (events: PacingEvent[]) => expectPaced(events, "import-placement-copy", unitsOf("payload-copy"), 1);

test("pacing assertion checks leading and trailing work without relying on probe-side counters", () => {
  expect(() => check([unit, unit, yielded, turn, yielded, turn])).toThrow("units between yields");
  expect(() => check([yielded, turn, unit, yielded, turn, unit, unit])).toThrow("units between yields");
});

test("pacing assertion requires real work and two matching yields", () => {
  expect(() => check([yielded, turn, yielded, turn])).toThrow("input must exceed");
  expect(() => check([unit, yielded, turn, unit])).toThrow("at least two yields");
});

test("a yield of any phase followed by a real turn ends a work run", () => {
  expect(
    check([unit, yielded, turn, unit, { kind: "yield", phase: "publish-render" }, turn, unit, yielded, turn]),
  ).toBe(3);
});

test("unawaited probes do not break a work run or count as separate yields", () => {
  expect(() => check([unit, yielded, unit, yielded, turn])).toThrow("units between yields");
  expect(() => check([unit, yielded, yielded, turn, unit])).toThrow("at least two yields");
  expect(() => check([unit, yielded, turn, unit, yielded])).toThrow("at least two yields");
});

test("a turn without a preceding probe does not end a work run", () => {
  expect(() => check([unit, turn, unit, yielded, turn, yielded, turn])).toThrow("units between yields");
});
