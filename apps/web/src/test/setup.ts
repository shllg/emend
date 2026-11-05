import { configure } from "@testing-library/react";
import { afterEach, beforeEach, vi } from "vitest";
import { Channel, Events, Locks } from "./events.ts";

let restoreLocks = () => {};
// Vitest treats a test timeout of 0 as unlimited, and a timer given 0 or Infinity fires at once.
const LONGEST_TIMER_DELAY = 2_147_483_647;
// Testing Library's config is global, so this is wrong for concurrent tests; the polling guard bans them.
beforeEach(({ task }) => configure({ asyncUtilTimeout: task.timeout || LONGEST_TIMER_DELAY }));
beforeEach(() => {
  // Some web tests deliberately use the Node environment instead of happy-dom.
  if (typeof window === "undefined") return;
  Events.opened = [];
  Channel.opened = [];
  vi.stubGlobal("EventSource", Events);
  vi.stubGlobal("BroadcastChannel", Channel);
  const browser = navigator;
  const previous = Object.getOwnPropertyDescriptor(browser, "locks");
  Object.defineProperty(browser, "locks", { value: new Locks(), configurable: true });
  restoreLocks = () => {
    if (previous) Object.defineProperty(browser, "locks", previous);
    else Reflect.deleteProperty(browser, "locks");
  };
});
afterEach(() => {
  restoreLocks();
  vi.unstubAllGlobals();
});
