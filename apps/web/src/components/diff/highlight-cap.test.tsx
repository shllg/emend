import { getSharedHighlighter } from "@pierre/diffs";
import { cleanup, render, waitFor } from "@testing-library/react";
import { afterEach, expect, onTestFinished, test, vi } from "vitest";
import { DiffView, HighlightNote, TOKENIZE_MAX_LINES } from "./FileDiff.tsx";
import { parsePair } from "./parse.worker.ts";
import { diffTheme } from "./theme.ts";

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
const renderFile = (count: number, onRendered?: () => void) =>
  render(
    <DiffView
      fileDiff={file(count)}
      diffStyle="split"
      annotations={[]}
      selected={null}
      onSelect={() => {}}
      onSlots={(state) => {
        if (state.rendered) onRendered?.();
      }}
    />,
  );

test("a file under the cap highlights", async () => {
  const small = renderFile(20);
  await waitFor(() => expect(styledSpan(small.container)).toBeTruthy());
});

test("a file between 1001 lines and the cap highlights", async () => {
  const view = renderFile(1500);
  await waitFor(() => expect(styledSpan(view.container)).toBeTruthy());
});

// Rendering all 5,001 DOM lines is the cap-boundary workload.
test("a file one line over the cap renders without highlighting, as the note says", async () => {
  // Load the real theme/language before rendering, so plain output cannot be an interim paint.
  const highlighter = await getSharedHighlighter({
    themes: [diffTheme.name],
    langs: ["typescript"],
    preferredHighlighter: "shiki-js",
  });
  const tokenize = vi.spyOn(highlighter, "codeToTokens");
  const rendered = Promise.withResolvers<void>();
  onTestFinished(() => {
    cleanup();
    tokenize.mockRestore();
  });
  const view = renderFile(TOKENIZE_MAX_LINES + 1, rendered.resolve);
  await rendered.promise;
  expect(shadowOf(view.container)?.querySelector("[data-line]")).toBeTruthy();
  expect(styledSpan(view.container)).toBeFalsy();
  expect(tokenize).toHaveBeenCalled();
  expect(tokenize.mock.calls.every(([, options]) => options.lang === "text")).toBe(true);
}, 20000);
