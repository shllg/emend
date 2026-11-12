import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, expect, test } from "vitest";
import { LineTotals } from "./LineTotals.tsx";

afterEach(cleanup);

test("totals format numbers, use diff colors and announce singular and plural lines", () => {
  render(<LineTotals counts={{ additions: 1234, deletions: 1 }} />);
  expect(screen.getByText("1,234 lines added, 1 line removed").className).toBe("sr-only");
  for (const [text, color] of [
    ["+1,234", "text-diff-add-fg"],
    ["−1", "text-diff-del-fg"],
  ] as const) {
    const span = screen.getByText(text);
    expect(span.getAttribute("aria-hidden")).toBe("true");
    expect(span.classList.contains(color)).toBe(true);
    expect(span.parentElement?.className).toContain("font-mono tabular-nums font-stretch-mono");
  }
});

test("missing counts render nothing", () => {
  const { container } = render(<LineTotals counts={null} />);
  expect(container.textContent).toBe("");
});
