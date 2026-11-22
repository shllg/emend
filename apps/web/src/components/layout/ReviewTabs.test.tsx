import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import type { ReviewSearch } from "../../router.tsx";
import { ReviewTabs } from "./ReviewTabs.tsx";

vi.mock("@tanstack/react-router", () => ({ useNavigate: () => vi.fn() }));
vi.mock("../../lib/layout.ts", () => ({ usePaneMode: () => "tabs" }));

afterEach(cleanup);

test.each([undefined, "writeup", "files", "docs", "comments", "diff"] as const)(
  "the depth slot exists only when writeup is active (tab=%s)",
  (tab) => {
    const depthSlot = vi.fn();
    const props = {
      id: "review",
      search: { tab } as ReviewSearch,
      hasDocs: true,
      hasWriteup: true,
      hasDiff: true,
      filesCount: 2,
      docsCount: 1,
      idBase: "reading",
      depthSlot,
    };
    const view = render(<ReviewTabs {...props} />);
    const row = view.container.querySelector(".em-review-tabs");
    const slot = view.container.querySelector(".em-depth-slot");
    if (tab === undefined || tab === "writeup") {
      expect(slot).not.toBeNull();
      expect(row?.classList.contains("flex-nowrap")).toBe(true);
      expect(row?.classList.contains("flex-wrap")).toBe(false);
      expect(depthSlot).toHaveBeenLastCalledWith(slot);
      expect(slot?.previousElementSibling).toBe(screen.getByRole("tablist", { name: "Reading tabs" }));
      view.rerender(<ReviewTabs {...props} search={{ tab: "docs" }} />);
      expect(view.container.querySelector(".em-depth-slot")).toBeNull();
      expect(row?.classList.contains("flex-wrap")).toBe(true);
      expect(row?.classList.contains("flex-nowrap")).toBe(false);
      expect(slot?.isConnected).toBe(false);
      // React's development ref cleanup also forwards unused arguments.
      expect(depthSlot.mock.calls.at(-1)?.[0]).toBeNull();
      view.rerender(<ReviewTabs {...props} depthSlot={undefined} />);
      expect(view.container.querySelector(".em-depth-slot")).toBeNull();
      expect(row?.classList.contains("flex-wrap")).toBe(true);
      expect(row?.classList.contains("flex-nowrap")).toBe(false);
    } else {
      expect(slot).toBeNull();
      expect(row?.classList.contains("flex-wrap")).toBe(true);
      expect(row?.classList.contains("flex-nowrap")).toBe(false);
      expect(depthSlot).not.toHaveBeenCalled();
    }
  },
);
