import { expect, test } from "vitest";
import { FrameToParent, ParentToFrame } from "../../lib/frame-messages.ts";
import { dedentDiagram, parseDiagramReply } from "./html-diagrams.ts";

test.each([
  ["\n    graph LR\n      A --> B\n    \n", "graph LR\n  A --> B"],
  ["\r\n\tgraph LR\r\n\t\tA --> B\r\n", "graph LR\n\tA --> B"],
  ["  graph LR\n\n    A --> B", "graph LR\n\n  A --> B"],
  ["graph LR\n  A --> B", "graph LR\n  A --> B"],
  [" \tgraph LR\n  A --> B", "\tgraph LR\n A --> B"],
  [" \n\t\r\n", ""],
])("dedents common whitespace in %j", (source, expected) => {
  expect(dedentDiagram(source)).toBe(expected);
});

const diagram = { source: "graph LR", mode: "light", width: 500 };
const job = { type: "recense:diagrams", request: 1, diagrams: [diagram] };
const reply = { type: "svg", svg: "<svg/>", width: 1, height: 10000 };
const relay = { ...reply, type: "recense:diagram", request: 1, index: 0 };

test("diagram schemas accept exactly the bounded job and answer shapes", () => {
  expect(FrameToParent.parse(job)).toEqual(job);
  expect(FrameToParent.parse({ ...job, request: 2147483647, diagrams: Array(50).fill(diagram) })).toBeDefined();
  expect(
    FrameToParent.safeParse({ ...job, diagrams: Array(20).fill({ ...diagram, source: "x".repeat(50000) }) }).success,
  ).toBe(true);
  expect(parseDiagramReply(reply)).toEqual(reply);
  expect(parseDiagramReply({ type: "svg", svg: null })).toEqual({ type: "svg", svg: null });
  expect(ParentToFrame.parse(relay)).toEqual(relay);
  expect(ParentToFrame.parse({ type: "recense:diagram", request: 2147483647, index: 49, svg: null })).toBeDefined();
  expect(parseDiagramReply({ ...reply, svg: `<svg${"x".repeat(3999996)}` })).toBeDefined();
  for (const patch of [
    { extra: true },
    { request: 0 },
    { request: 2147483648 },
    { request: 1.5 },
    { request: "1" },
    { diagrams: [] },
    { diagrams: Array(51).fill(diagram) },
    { diagrams: Array(21).fill({ ...diagram, source: "x".repeat(50000) }) },
    { diagrams: [...Array(20).fill({ ...diagram, source: "x".repeat(50000) }), { ...diagram, source: "x" }] },
  ])
    expect(FrameToParent.safeParse({ ...job, ...patch }).success).toBe(false);
  for (const patch of [
    { extra: true },
    { source: "" },
    { source: "x".repeat(50001) },
    { source: "\ud800" },
    { mode: "system" },
    { width: 0 },
    { width: 10001 },
    { width: 2.5 },
    { width: "2" },
  ])
    expect(FrameToParent.safeParse({ ...job, diagrams: [{ ...diagram, ...patch }] }).success).toBe(false);
  for (const patch of [
    { extra: true },
    { svg: "" },
    { svg: " <svg/>" },
    { svg: "<svg\ud800/>" },
    { svg: `<svg${"x".repeat(3999997)}` },
    { svg: 1 },
    { svg: null },
    { width: 0 },
    { width: 10001 },
    { height: 1.5 },
    { width: "2" },
  ]) {
    expect(parseDiagramReply({ ...reply, ...patch })).toBeUndefined();
    expect(ParentToFrame.safeParse({ ...relay, ...patch }).success).toBe(false);
  }
  for (const patch of [{ request: 0 }, { request: 2147483648 }, { index: -1 }, { index: 50 }, { index: 0.5 }])
    expect(ParentToFrame.safeParse({ ...relay, ...patch }).success).toBe(false);
  for (const data of [null, [], {}, { type: "size", height: 10 }, { type: "svg", svg: null, extra: true }])
    expect(parseDiagramReply(data)).toBeUndefined();
});
