import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, expect, test } from "vitest";
import { LineTotals } from "./LineTotals.tsx";

afterEach(cleanup);

test("totals format numbers, use diff colors and announce singular and plural lines", () => {
  const { container } = render(<LineTotals counts={{ additions: 1234, deletions: 1, uncounted: 0 }} />);
  expect(screen.queryByText("≥")).toBeNull();
  expect(container.querySelector("[title]")).toBeNull();
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

test.each([1, 2])("partial totals disclose %s uncounted files visually and to assistive technology", (uncounted) => {
  render(<LineTotals counts={{ additions: 1234, deletions: 1, uncounted }} />);
  const missing = `${uncounted} ${uncounted === 1 ? "file" : "files"} not counted`;
  const wrapper = screen.getByTitle(`Partial: ${missing}`);
  const marker = screen.getByText("≥");
  expect(marker.getAttribute("aria-hidden")).toBe("true");
  expect(marker.classList.contains("text-fg-3")).toBe(true);
  expect(marker.nextElementSibling).toBe(screen.getByText("+1,234"));
  expect(wrapper.contains(marker)).toBe(true);
  expect(screen.getByText(`At least 1,234 lines added, 1 line removed; ${missing}`).className).toBe("sr-only");
});

test("missing counts render nothing", () => {
  const { container } = render(<LineTotals counts={null} />);
  expect(container.textContent).toBe("");
});
