import { setTimeout } from "node:timers/promises";
import { expect, test } from "vitest";
import { pollUntil } from "./poll-until.ts";

test("polling can complete after Vitest's default wait deadline", async () => {
  const ready = setTimeout(1100, "ready");
  expect(await pollUntil(() => ready)).toBe("ready");
}, 10000);

test("polling under an unlimited test timeout keeps polling until the condition holds", { timeout: 0 }, async () => {
  let calls = 0;
  const value = await pollUntil(() => {
    calls++;
    if (calls < 3) throw new Error("not yet");
    return calls;
  });
  expect(value).toBe(3);
  expect(calls).toBe(3);
});
