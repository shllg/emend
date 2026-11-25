import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { ReviewState } from "@recense/contract";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, expect, test } from "vitest";
import { AgentStatus, agentStatusOf, agentStatusText } from "./AgentStatus.tsx";
import { OriginBadge } from "./OriginBadge.tsx";
import { StateBadge } from "./StateBadge.tsx";

afterEach(cleanup);

test("origin tint depends on the id, stays stable across renames, and covers all eight tints", () => {
  const { rerender } = render(<OriginBadge origin={{ id: "machine-1", name: "Workshop" }} />);
  const classes = screen.getByTitle("From Workshop").className;
  rerender(<OriginBadge origin={{ id: "machine-1", name: "Renamed" }} />);
  expect(screen.getByTitle("From Renamed").className).toBe(classes);
  const tints = new Set<string>();
  for (let i = 0; i < 32; i++) {
    rerender(<OriginBadge origin={{ id: `machine-${i}`, name: "Workshop" }} />);
    tints.add(screen.getByTitle("From Workshop").className.match(/bg-origin-\d-bg/)?.[0] ?? "missing");
  }
  expect([...tints].sort()).toEqual(Array.from({ length: 8 }, (_, i) => `bg-origin-${i + 1}-bg`));
});

test("origin dot is labelled with the machine name and uses its foreground tint", () => {
  const { rerender } = render(<OriginBadge origin={{ id: "machine", name: "Workshop" }} size="sm" />);
  const tint = screen.getByTitle("From Workshop").className.match(/text-origin-(\d)-fg/)?.[1];
  rerender(<OriginBadge origin={{ id: "machine", name: "Workshop" }} dot />);
  expect(screen.getByRole("img", { name: "From Workshop" }).className).toContain(`bg-origin-${tint}-fg`);
});

test.each(["pill", "inline"] as const)("state badges label all states in %s form", (variant) => {
  const { rerender } = render(<StateBadge state="open" variant={variant} revision={3} />);
  expect(screen.getByText("Open")).toBeTruthy();
  rerender(<StateBadge state="approved" variant={variant} />);
  expect(screen.getByText("Approved")).toBeTruthy();
  rerender(<StateBadge state="approved" variant={variant} revision={3} />);
  expect(screen.getByText("Approved · rev 3")).toBeTruthy();
  rerender(<StateBadge state="settled" variant={variant} revision={3} />);
  expect(screen.getByText("Retired")).toBeTruthy();
  expect(screen.queryByRole("status")).toBeNull();
});

const states: ReviewState[] = ["open", "approved", "settled"];
for (const state of states)
  for (const agentWaiting of [false, true])
    for (const pendingSend of [false, true]) {
      test(`agent status for ${state}, waiting=${agentWaiting}, pending=${pendingSend}`, () => {
        expect(agentStatusOf({ state, agentWaiting, pendingSend, pickedUpAt: null })).toBe(
          state === "approved" ? "approved" : agentWaiting ? "waiting" : pendingSend ? "pending" : null,
        );
      });
    }

test.each([
  ["waiting", "Agent waiting"],
  ["pending", "Not picked up yet"],
  ["pickedUp", "Picked up"],
  ["approved", "Approved"],
] as const)("agent %s is static labelled text", (status, label) => {
  const { container } = render(<AgentStatus status={status} pill />);
  expect(screen.getByText(label)).toBeTruthy();
  expect(screen.queryByRole("status")).toBeNull();
  expect(container.querySelector('[aria-hidden="true"]')).toBeTruthy();
});

test("the waiting dot pulses a few times, ending within five seconds, then holds still", () => {
  const { container } = render(<AgentStatus status="waiting" />);
  const classes = container.querySelector('[aria-hidden="true"]')?.className ?? "";
  expect(classes).toContain("em-pulse");
  expect(classes).not.toContain("infinite");
  const count = Number(/animate-\[em-pulse_var\(--dur-pulse\)_\S+_([1-9]\d*)\]/.exec(classes)?.[1]);
  const css = readFileSync(resolve(import.meta.dirname, "../../styles/spacing.css"), "utf8");
  const duration = Number(/--dur-pulse:\s*(\d+)ms;/.exec(css)?.[1]);
  expect(count).toBeGreaterThanOrEqual(2);
  expect(count * duration).toBeLessThanOrEqual(5000);
});

test("the still waiting dot has a ring that the other dots lack", () => {
  const { container } = render(<AgentStatus status="waiting" />);
  const classes = container.querySelector('[aria-hidden="true"]')?.classList;
  expect(classes).toContain("outline-1");
  expect(classes).toContain("outline-offset-1");
  expect(classes).toContain("outline-current");

  for (const status of ["pickedUp", "pending"] as const) {
    cleanup();
    const { container } = render(<AgentStatus status={status} />);
    expect(container.querySelector('[aria-hidden="true"]')?.className).not.toContain("outline");
  }
});

test("label priority: approved, waiting, not picked up, picked up, none", () => {
  const base = {
    state: "open" as const,
    agentWaiting: true,
    pendingSend: true,
    pickedUpAt: "2026-03-05T12:00:00.000Z",
  };
  expect(agentStatusOf({ ...base, state: "approved" })).toBe("approved");
  expect(agentStatusOf(base)).toBe("waiting");
  expect(agentStatusOf({ ...base, agentWaiting: false })).toBe("pending");
  expect(agentStatusOf({ ...base, agentWaiting: false, pendingSend: false })).toBe("pickedUp");
  expect(agentStatusOf({ ...base, agentWaiting: false, pendingSend: false, pickedUpAt: null })).toBeNull();
});

test("picked up shows its relative time in a time element and no pulse", () => {
  const at = "2026-03-05T12:00:00.000Z";
  const { container } = render(<AgentStatus status="pickedUp" pickedUpAt={at} now={Date.parse(at) + 5 * 60_000} />);
  expect(screen.getByText("Picked up")).toBeTruthy();
  const time = container.querySelector("time");
  expect(time?.textContent).toBe("5m");
  expect(time?.getAttribute("dateTime")).toBe(at);
  expect(container.querySelector('[class*="animate-"]')).toBeNull();
  expect(agentStatusText("pickedUp", at, Date.parse(at) + 5 * 60_000)).toBe("Picked up 5m");
});

test("no agent status renders nothing", () => {
  const { container } = render(<AgentStatus status={null} />);
  expect(container.textContent).toBe("");
});
