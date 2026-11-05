import { cleanup, render, waitFor } from "@testing-library/react";
import { afterEach, expect, test } from "vitest";
import { DiffView, HighlightNote, TOKENIZE_MAX_LINES } from "./FileDiff.tsx";
import { parsePair } from "./parse.worker.ts";

afterEach(() => {
  cleanup();
});

const lines = (count: number) => `${Array.from({ length: count }, (_, i) => `const v${i} = ${i};`).join("\n")}\n`;
const file = (count: number) => parsePair({ oldFile: null, newFile: { name: "big.ts", contents: lines(count) } });

test("a file over the cap shows a muted note with its line count", () => {
  const view = render(<HighlightNote diff={file(TOKENIZE_MAX_LINES + 1214)} />);
  expect(view.container.textContent).toBe("Not highlighted: 6,214 lines is over 5,000.");
  expect(view.container.querySelector(".em-diff-summary")).toBeTruthy();
});

test("a file at or under the cap shows no note", () => {
  expect(render(<HighlightNote diff={file(TOKENIZE_MAX_LINES)} />).container.textContent).toBe("");
  expect(render(<HighlightNote diff={file(10)} />).container.textContent).toBe("");
});

const shadowOf = (container: HTMLElement) => container.querySelector("diffs-container")?.shadowRoot;
const styledSpan = (container: HTMLElement) => shadowOf(container)?.querySelector("[data-line] span[style]");
const renderFile = (count: number) =>
  render(<DiffView fileDiff={file(count)} diffStyle="split" annotations={[]} selected={null} onSelect={() => {}} />);

test("a file under the cap highlights", async () => {
  const small = renderFile(20);
  await waitFor(() => expect(styledSpan(small.container)).toBeTruthy());
});

test("a file between 1001 lines and the cap highlights", async () => {
  const view = renderFile(1500);
  await waitFor(() => expect(styledSpan(view.container)).toBeTruthy());
}, 20000);

test("a file one line over the cap renders without highlighting, as the note says", async () => {
  const view = renderFile(TOKENIZE_MAX_LINES + 1);
  await waitFor(() => expect(shadowOf(view.container)?.querySelector("[data-line]")).toBeTruthy());
  await new Promise((resolve) => setTimeout(resolve, 500));
  expect(styledSpan(view.container)).toBeFalsy();
}, 20000);
