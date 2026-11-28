import { onlineManager, QueryClient, QueryClientProvider, type QueryFunction, useQuery } from "@tanstack/react-query";
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import type { ComponentProps, ReactNode } from "react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { ApiError } from "../../api/client.ts";
import { reconnectReviewEvents } from "../../lib/event-stream.ts";
import { getHandoffNotice } from "../../lib/handoff-notices.ts";
import { shortDate } from "../../lib/time.ts";
import { ToastProvider } from "../ui/Toast.tsx";
import {
  HANDOFF_ANNOUNCE_MS,
  HANDOFF_CLOSE_MS,
  HANDOFF_REFETCH_MS,
  HANDOFF_WAIT_MS,
  type SendAgent,
} from "./HandOver.tsx";
import type { ReviewLifecycle } from "./ReviewActions.tsx";
import { SendBar } from "./SendBar.tsx";

// The live stream is not under test here: by default no stream reopens, as with no subscription.
vi.mock("../../lib/event-stream.ts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../lib/event-stream.ts")>()),
  reconnectReviewEvents: vi.fn(() => Promise.resolve(false)),
}));

const reviewId = "11111111-1111-4111-8111-111111111111";
const command = `/recense:recense-feedback ${reviewId}`;
const idle: SendAgent = {
  agentWaiting: false,
  pendingSend: true,
  pickedUpAt: null,
  releasedAt: null,
  newestRevision: 3,
};
const waiting: SendAgent = { ...idle, agentWaiting: true };
const lifecycle: ReviewLifecycle = {
  title: "Synthetic review",
  state: "open",
  snoozed: false,
  snoozedUntil: null,
  groupId: null,
  pinned: false,
  onDeleted: () => {},
};
const pickedUp = "No agent has picked this up yet. recense keeps it until one does.";
let client: QueryClient;
let fetchMock: ReturnType<typeof vi.fn<typeof fetch>>;
let invalidate: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  vi.useFakeTimers();
  vi.mocked(reconnectReviewEvents).mockReset().mockResolvedValue(false);
  probe.mode = "ok";
  localStorage.clear();
  client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  invalidate = vi.spyOn(client, "invalidateQueries");
  fetchMock = vi.fn<typeof fetch>().mockImplementation(async () => new Response(null, { status: 201 }));
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => {
  cleanup();
  client.clear();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function tree(props: Partial<ComponentProps<typeof SendBar>>): ReactNode {
  return (
    <QueryClientProvider client={client}>
      <ToastProvider>
        <SendBar reviewId={reviewId} revision={3} newestRevision={3} unsentCount={1} {...props} />
      </ToastProvider>
    </QueryClientProvider>
  );
}
function mount(props: Partial<ComponentProps<typeof SendBar>> = {}) {
  const view = render(tree(props));
  return { ...view, update: (next: Partial<ComponentProps<typeof SendBar>>) => view.rerender(tree(next)) };
}
async function settle(ms = 0) {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
}
async function send(phone = false) {
  if (phone) fireEvent.click(screen.getByRole("button", { name: "Send" }));
  fireEvent.click(screen.getByRole("button", { name: phone ? /^Send 1 comment/ : "Send" }));
  await settle();
}
function openResume() {
  const trigger = screen.getByRole("button", { name: "How to resume" });
  act(() => trigger.focus());
  fireEvent.click(trigger);
  return screen.getByRole("alertdialog", { name: "How to resume" });
}
async function openActions() {
  fireEvent.keyDown(screen.getByRole("button", { name: "More review actions" }), { key: "ArrowDown" });
  await settle();
  return screen.getByRole("menu", { name: "More review actions" });
}
const refetches = (key: string) =>
  invalidate.mock.calls.filter((call: unknown[]) => (call[0] as { queryKey?: string[] })?.queryKey?.[0] === key).length;
const reviewRefetches = () => refetches("review");
const inboxRefetches = () => refetches("inbox");

test("the desktop status says an agent is waiting without a resume action or an extra row", async () => {
  mount({ agent: waiting, lifecycle });
  expect(screen.getByText("An agent is waiting").parentElement?.tabIndex).toBe(-1);
  expect(screen.queryByRole("button", { name: "How to resume" })).toBeNull();
  expect(screen.queryByText(command)).toBeNull();
  expect(screen.queryByRole("button", { name: "Copy" })).toBeNull();
  expect(screen.getByRole("region", { name: "Send and approve" }).children).toHaveLength(1);
  expect(
    within(await openActions())
      .getByRole("menuitem", { name: "How to resume" })
      .getAttribute("aria-disabled"),
  ).toBe("true");
});

test("the desktop status opens the resume command in a dialog and Close returns focus to the link", async () => {
  mount({ agent: idle });
  const trigger = screen.getByRole("button", { name: "How to resume" });
  expect(trigger.parentElement?.textContent).toBe("No agent waiting · How to resume");
  expect(trigger.getAttribute("type")).toBe("button");
  expect(screen.queryByText(command)).toBeNull();
  expect(screen.getByRole("region", { name: "Send and approve" }).children).toHaveLength(1);
  const dialog = within(openResume());
  expect(dialog.getByText("No agent is waiting. recense keeps this until an agent picks it up.")).toBeTruthy();
  expect(dialog.getByText(command)).toBeTruthy();
  expect(dialog.getByRole("button", { name: "Copy" })).toBeTruthy();
  expect(dialog.getByText(`recense feedback ${reviewId}`).tagName).toBe("CODE");
  expect(dialog.getByText(/and handle the result with the recense-feedback skill\.$/)).toBeTruthy();
  const close = dialog.getByRole("button", { name: "Close" });
  expect(document.activeElement).toBe(close);
  fireEvent.click(close);
  await settle();
  expect(screen.queryByRole("alertdialog")).toBeNull();
  expect(document.activeElement).toBe(trigger);
  expect(fetchMock).not.toHaveBeenCalled();
});

test.each<[string, Partial<ReviewLifecycle>, string]>([
  ["a snoozed review", { snoozed: true }, "The agent stopped waiting when you snoozed this on"],
  ["a retired review", { state: "settled" }, "The agent stopped waiting when you retired this on"],
  ["any other review", {}, "The agent stopped waiting on"],
])("the desktop status dates the ended wait of %s and its dialog explains why", (_name, change, text) => {
  const releasedAt = "2026-03-05T12:00:00.000Z";
  const date = shortDate(releasedAt);
  mount({ agent: { ...idle, releasedAt }, lifecycle: { ...lifecycle, ...change } });
  expect(screen.getByText(`The agent stopped waiting on ${date} ·`)).toBeTruthy();
  expect(screen.queryByText(command)).toBeNull();
  const dialog = within(openResume());
  expect(dialog.getByText(`${text} ${date}.`)).toBeTruthy();
  expect(screen.queryByText(/No agent is waiting/)).toBeNull();
  expect(dialog.getByText(command)).toBeTruthy();
});

test.each([
  { name: "without agent data", props: { lifecycle } },
  { name: "after approval", props: { agent: idle, approved: true, lifecycle } },
  {
    name: "after retirement without a release date",
    props: { agent: idle, lifecycle: { ...lifecycle, state: "settled" as const } },
  },
])("the desktop bar omits agent status and the resume link $name", async ({ props }) => {
  mount(props);
  expect(screen.queryByText(/agent is waiting|No agent|stopped waiting/)).toBeNull();
  expect(screen.queryByRole("button", { name: "How to resume" })).toBeNull();
  expect(screen.getByText("1 unsent comment").parentElement?.children).toHaveLength(1);
  const menu = within(await openActions());
  if ("agent" in props) {
    expect(menu.getByRole("menuitem", { name: "How to resume" }).getAttribute("aria-disabled")).toBe("true");
  } else {
    expect(menu.queryByRole("menuitem", { name: "How to resume" })).toBeNull();
  }
});

test("an invalid release date uses the no-agent status and explanation", () => {
  mount({ agent: { ...idle, releasedAt: "invalid" } });
  expect(screen.getByText("No agent waiting ·")).toBeTruthy();
  expect(
    within(openResume()).getByText("No agent is waiting. recense keeps this until an agent picks it up."),
  ).toBeTruthy();
});

test("the first more-actions item opens the resume dialog after the menu closes", async () => {
  mount({ agent: idle, lifecycle });
  const menu = within(await openActions());
  const resume = menu.getByRole("menuitem", { name: "How to resume" });
  expect(menu.getAllByRole("menuitem")[0]).toBe(resume);
  expect(resume.nextElementSibling?.getAttribute("role")).toBe("separator");
  fireEvent.click(resume);
  await settle();
  expect(screen.queryByRole("menu")).toBeNull();
  const dialog = within(screen.getByRole("alertdialog", { name: "How to resume" }));
  expect(dialog.getByText(command)).toBeTruthy();
  expect(dialog.getByText("No agent is waiting. recense keeps this until an agent picks it up.")).toBeTruthy();
  fireEvent.click(dialog.getByRole("button", { name: "Close" }));
  await settle();
  expect(document.activeElement).toBe(screen.getByRole("button", { name: "More review actions" }));
  expect(document.body.style.pointerEvents).not.toBe("none");
  expect(fetchMock).not.toHaveBeenCalled();
});

test("agent wait changes preserve the focused more-actions item", async () => {
  const { update } = mount({ agent: idle, lifecycle });
  const menu = within(await openActions());
  const move = menu.getByRole("menuitem", { name: "Move to group…" });
  act(() => move.focus());
  update({ agent: waiting, lifecycle });
  await settle();
  expect(document.activeElement?.getAttribute("role")).toBe("menuitem");
  expect(document.activeElement?.textContent).toBe("Move to group…");
  expect(document.activeElement).toBe(move);
  expect(menu.getByRole("menuitem", { name: "How to resume" }).getAttribute("aria-disabled")).toBe("true");
  update({ agent: idle, lifecycle });
  await settle();
  expect(document.activeElement?.getAttribute("role")).toBe("menuitem");
  expect(document.activeElement?.textContent).toBe("Move to group…");
  expect(document.activeElement).toBe(move);
  expect(menu.getByRole("menuitem", { name: "How to resume" }).getAttribute("aria-disabled")).not.toBe("true");
  expect(fetchMock).not.toHaveBeenCalled();
});

test.each([
  { name: "without more actions", lifecycle: undefined },
  { name: "with more actions", lifecycle },
])("a pending Send blocks resume $name and restores focus after Sent closes", async ({ lifecycle }) => {
  const pending = Promise.withResolvers<Response>();
  fetchMock.mockImplementation(() => pending.promise);
  mount({ agent: idle, unsentCount: 1, lifecycle });
  try {
    await send();
    const resume = screen.getByRole<HTMLButtonElement>("button", { name: "How to resume" });
    expect(resume.disabled).toBe(true);
    fireEvent.click(resume);
    await settle();
    expect(screen.queryByRole("alertdialog")).toBeNull();
    if (lifecycle) {
      const menu = await openActions();
      const item = within(menu).getByRole("menuitem", { name: "How to resume" });
      expect(item.getAttribute("aria-disabled")).toBe("true");
      fireEvent.click(item);
      await settle();
      expect(screen.queryByRole("alertdialog")).toBeNull();
      fireEvent.keyDown(menu, { key: "Escape" });
      await settle();
      expect(screen.queryByRole("menu")).toBeNull();
    }
    await act(async () => pending.resolve(new Response(null, { status: 201 })));
    await settle();
    const close = within(sentNotice()).getByRole("button", { name: "Close" });
    act(() => close.focus());
    fireEvent.click(close);
    await settle();
    expect(screen.queryByRole("region", { name: "Sent" })).toBeNull();
    expect(document.activeElement).toBe(screen.getByRole("textbox", { name: "Instructions" }));
    expect(screen.getByRole<HTMLButtonElement>("button", { name: "How to resume" }).disabled).toBe(false);
    if (lifecycle) {
      expect(
        within(await openActions())
          .getByRole("menuitem", { name: "How to resume" })
          .getAttribute("aria-disabled"),
      ).not.toBe("true");
    }
    expect(fetchMock).toHaveBeenCalledOnce();
  } finally {
    // Release the in-flight Send even if a regression assertion fails.
    await act(async () => pending.resolve(new Response(null, { status: 201 })));
    await settle();
  }
});

test("switching to phone closes the resume dialog and switching back leaves it closed", async () => {
  const { update } = mount({ agent: idle });
  openResume();
  update({ agent: idle, phone: true });
  await settle();
  expect(screen.queryByRole("alertdialog")).toBeNull();
  expect(screen.queryByRole("button", { name: "How to resume" })).toBeNull();
  update({ agent: idle });
  await settle();
  expect(screen.queryByRole("alertdialog")).toBeNull();
  expect(screen.getByRole("button", { name: "How to resume" })).toBeTruthy();
});

test("switching to phone before the resume menu callback runs keeps the dialog closed on desktop", async () => {
  const { update } = mount({ agent: idle, lifecycle });
  const menu = within(await openActions());
  fireEvent.click(menu.getByRole("menuitem", { name: "How to resume" }));
  // The menu's unmount autofocus runs its selected handler on the next timer tick.
  update({ agent: idle, lifecycle, phone: true });
  await settle();
  update({ agent: idle, lifecycle });
  await settle();
  expect(screen.queryByRole("alertdialog")).toBeNull();
});

test("approval closes the resume dialog and returns focus to the status column", async () => {
  const { update } = mount({ agent: idle });
  openResume();
  update({ agent: idle, approved: true });
  await settle();
  expect(screen.queryByRole("alertdialog")).toBeNull();
  expect(screen.queryByRole("button", { name: "How to resume" })).toBeNull();
  const status = screen.getByText("1 unsent comment").parentElement;
  expect(status?.tabIndex).toBe(-1);
  expect(document.activeElement).toBe(status);
});

test("an agent starting to wait closes the resume dialog and returns focus to the status column", async () => {
  const { update } = mount({ agent: idle });
  openResume();
  update({ agent: waiting });
  await settle();
  expect(screen.queryByRole("alertdialog")).toBeNull();
  const status = screen.getByText("1 unsent comment").parentElement;
  expect(status?.tabIndex).toBe(-1);
  expect(status?.textContent).toContain("An agent is waiting");
  expect(document.activeElement).toBe(status);
});

test("an agent starting to wait closes the resume dialog opened from the menu and returns focus to its trigger", async () => {
  const { update } = mount({ agent: idle, lifecycle });
  const menu = within(await openActions());
  fireEvent.click(menu.getByRole("menuitem", { name: "How to resume" }));
  await settle();
  expect(screen.getByRole("alertdialog", { name: "How to resume" })).toBeTruthy();
  update({ agent: waiting, lifecycle });
  await settle();
  expect(screen.queryByRole("alertdialog")).toBeNull();
  expect(document.activeElement).toBe(screen.getByRole("button", { name: "More review actions" }));
});

test("the phone bar and more-actions menu have no resume action", async () => {
  mount({ agent: idle, phone: true, lifecycle });
  expect(screen.queryByRole("button", { name: "How to resume" })).toBeNull();
  expect(within(await openActions()).queryByRole("menuitem", { name: "How to resume" })).toBeNull();
});

test("the phone puts the longer text in the Send sheet, not in the bar", () => {
  mount({ agent: idle, phone: true });
  expect(screen.queryByText(command)).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Send" }));
  expect(screen.getByText(command)).toBeTruthy();
});

const sentNotice = () => screen.getByRole("region", { name: "Sent" });

test("the status line starts empty, then receives its text so a screen reader announces it", async () => {
  mount({ agent: idle });
  await send();
  const region = sentNotice().querySelector<HTMLElement>("p[role=status]") as HTMLElement;
  expect(region.textContent).toBe("");
  await settle(HANDOFF_ANNOUNCE_MS);
  expect(region.textContent).toBe(pickedUp);
  expect(sentNotice().contains(region)).toBe(true);
});

test("a pick-up that removes the focused resume command moves focus to Close", async () => {
  const { update } = mount({ agent: idle });
  await send();
  await settle(HANDOFF_ANNOUNCE_MS);
  const copy = within(sentNotice()).getByRole("button", { name: "Copy" });
  act(() => copy.focus());
  expect(document.activeElement).toBe(copy);
  update({ agent: { ...idle, pickedUpAt: "2026-03-05T12:00:00.000Z" } });
  await settle();
  expect(within(sentNotice()).queryByRole("button", { name: "Copy" })).toBeNull();
  expect(document.activeElement).toBe(within(sentNotice()).getByRole("button", { name: "Close" }));
});

test.each([
  ["the instructions field", () => screen.getByRole("textbox", { name: "Instructions" })],
  ["the page body", () => document.body],
  ["the Send button", () => screen.getByRole("button", { name: "Send" })],
] as const)("a pick-up leaves focus on %s after the reader leaves Copy", async (_name, destination) => {
  const { update } = mount({ agent: idle });
  await send();
  const copy = within(sentNotice()).getByRole("button", { name: "Copy" });
  act(() => copy.focus());
  expect(document.activeElement).toBe(copy);
  const target = destination();
  act(() => {
    // Leaving Copy can blur it without a related target before the reader focuses anything else.
    copy.blur();
    if (target !== document.body) target.focus();
  });
  expect(document.activeElement).toBe(target);
  update({ agent: { ...idle, pickedUpAt: pickedAt } });
  expect(within(sentNotice()).queryByRole("button", { name: "Copy" })).toBeNull();
  expect(document.activeElement).toBe(target);
});

test("with an agent waiting, the notice waits, then confirms the pick-up and closes by itself", async () => {
  const { update } = mount({ agent: waiting });
  await send();
  await settle(HANDOFF_ANNOUNCE_MS);
  const notice = sentNotice();
  expect(notice.textContent).toContain("Waiting for the agent to pick this up…");
  expect(screen.getByText("Waiting for the agent to pick this up…").closest('[role="status"]')).toBeTruthy();
  update({ agent: { ...waiting, pickedUpAt: "2026-03-05T12:00:00.000Z" } });
  expect(screen.getByText("The agent picked up your feedback.")).toBeTruthy();
  await settle(HANDOFF_CLOSE_MS - 1);
  expect(screen.queryByRole("region", { name: "Sent" })).toBeTruthy();
  await settle(1);
  expect(screen.queryByRole("region", { name: "Sent" })).toBeNull();
  expect(fetchMock).toHaveBeenCalledOnce();
});

test("with no agent waiting, the notice shows the fallback at once and asks the server once", async () => {
  mount({ agent: idle });
  await send();
  await settle(HANDOFF_ANNOUNCE_MS);
  const notice = sentNotice();
  expect(notice.textContent).toContain(pickedUp);
  expect(notice.textContent).toContain(command);
  expect(notice.textContent).toContain(`Run recense feedback ${reviewId} and handle the result`);
  // The Send's own success refetches once; the notice adds one more, and no further one.
  expect(reviewRefetches()).toBe(2);
  expect(inboxRefetches()).toBe(2);
  await settle(HANDOFF_WAIT_MS * 2);
  expect(reviewRefetches()).toBe(2);
});

test("after 15 seconds without a pick-up the notice refetches once, then shows the fallback", async () => {
  mount({ agent: waiting });
  await send();
  const review = reviewRefetches();
  const inbox = inboxRefetches();
  await settle(HANDOFF_WAIT_MS - 1);
  expect(reviewRefetches()).toBe(review);
  expect(screen.queryByText(pickedUp)).toBeNull();
  await settle(1);
  expect(reviewRefetches()).toBe(review + 1);
  expect(inboxRefetches()).toBe(inbox + 1);
  expect(screen.getByText(pickedUp)).toBeTruthy();
  await settle(HANDOFF_WAIT_MS * 2);
  expect(reviewRefetches()).toBe(review + 1);
});

test("a late pick-up switches the open notice and then closes it", async () => {
  const { update } = mount({ agent: idle });
  await send();
  await settle(HANDOFF_ANNOUNCE_MS);
  expect(screen.getByText(pickedUp)).toBeTruthy();
  update({ agent: { ...idle, pickedUpAt: "2026-03-05T12:00:00.000Z" } });
  expect(screen.getByText("The agent picked up your feedback.")).toBeTruthy();
  expect(within(sentNotice()).queryByText(command)).toBeNull();
  await settle(HANDOFF_CLOSE_MS);
  expect(screen.queryByRole("region", { name: "Sent" })).toBeNull();
});

test("a pickedUpAt from an earlier Send never counts as a pick-up", async () => {
  const earlier = { ...waiting, pickedUpAt: "2026-03-01T09:00:00.000Z" };
  const { update } = mount({ agent: earlier });
  await send();
  update({ agent: { ...earlier } });
  expect(screen.queryByText("The agent picked up your feedback.")).toBeNull();
  await settle(HANDOFF_WAIT_MS);
  expect(screen.getByText(pickedUp)).toBeTruthy();
  update({ agent: { ...earlier, pickedUpAt: "2026-03-05T12:00:00.000Z" } });
  expect(screen.getByText("The agent picked up your feedback.")).toBeTruthy();
});

/** Approving asks first: the bar's Approve opens a dialog, and its Approve sends. */
function approve(name: string) {
  fireEvent.click(screen.getByRole("button", { name }));
  fireEvent.click(within(screen.getByRole("alertdialog")).getByRole("button", { name: "Approve" }));
}

test("Approve opens no Sent notice", async () => {
  mount({ agent: waiting, unsentCount: 0 });
  approve("Approve revision 3");
  await settle();
  expect(screen.getByText("Approved revision 3")).toBeTruthy();
  expect(screen.queryByRole("alertdialog")).toBeNull();
  expect(screen.queryByRole("region", { name: "Sent" })).toBeNull();
  expect(screen.queryByText(/pick this up/)).toBeNull();
});

test("closing the notice does not cancel the Send", async () => {
  const view = mount({ agent: waiting });
  await send();
  const review = reviewRefetches();
  fireEvent.click(screen.getByRole("button", { name: "Close" }));
  await settle(HANDOFF_WAIT_MS * 2);
  expect(screen.queryByRole("region", { name: "Sent" })).toBeNull();
  expect(fetchMock).toHaveBeenCalledOnce();
  expect(reviewRefetches()).toBe(review);
  view.unmount();
  mount({ agent: waiting });
  expect(screen.queryByRole("region", { name: "Sent" })).toBeNull();
});

test.each([
  { layout: "desktop", phone: false },
  { layout: "phone", phone: true },
])("the $layout Sent notice occupies the first row of the Send bar", async ({ phone }) => {
  mount({ agent: idle, phone });
  await send(phone);
  await settle(HANDOFF_ANNOUNCE_MS);
  expect(screen.queryByRole("alertdialog")).toBeNull();
  expect(screen.queryByRole("dialog")).toBeNull();
  const bar = screen.getByRole("region", { name: "Send and approve" });
  const notice = sentNotice();
  expect(bar.firstElementChild).toBe(notice);
  expect(notice.classList.contains("absolute")).toBe(false);
  expect(notice.classList.contains("fixed")).toBe(false);
  expect(notice.textContent).toContain(pickedUp);
  expect(notice.textContent).toContain(command);
});

test("Copy writes the command, reads Copied for 2 seconds and announces it", async () => {
  const writeText = vi.fn().mockResolvedValue(undefined);
  Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
  mount({ agent: idle });
  openResume();
  fireEvent.click(screen.getByRole("button", { name: "Copy" }));
  expect(writeText).toHaveBeenCalledExactlyOnceWith(command);
  await settle();
  expect(screen.getByRole("button", { name: "Copied" })).toBeTruthy();
  expect(screen.getByText("Command copied").closest('[role="status"]')).toBeTruthy();
  await settle(1999);
  expect(screen.getByRole("button", { name: "Copied" })).toBeTruthy();
  await settle(1);
  expect(screen.getByRole("button", { name: "Copy" })).toBeTruthy();
});

test("a failed Copy selects the command text and asks the reader to copy it", async () => {
  const writeText = vi.fn().mockRejectedValue(new Error("denied"));
  Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
  mount({ agent: idle });
  openResume();
  fireEvent.click(screen.getByRole("button", { name: "Copy" }));
  await settle();
  expect(screen.getByText("Select and copy the command")).toBeTruthy();
  expect(window.getSelection()?.toString()).toBe(command);
  expect(screen.getByRole("button", { name: "Copy" })).toBeTruthy();
});

test("a missing clipboard counts as a failed Copy", async () => {
  Object.defineProperty(navigator, "clipboard", { value: undefined, configurable: true });
  mount({ agent: idle });
  openResume();
  fireEvent.click(screen.getByRole("button", { name: "Copy" }));
  await settle();
  expect(screen.getByText("Select and copy the command")).toBeTruthy();
});

test("the command renders as text, never HTML", () => {
  const hostile = "<img src=x onerror=alert(1)>";
  mount({ reviewId: hostile, agent: idle });
  const dialog = openResume();
  expect(dialog.querySelector("img")).toBeNull();
  expect(screen.getByText(`/recense:recense-feedback ${hostile}`)).toBeTruthy();
});

const pickedAt = "2026-03-05T12:00:00.000Z";
const pickedText = "The agent picked up your feedback.";
const nextRevision = (pendingSend: boolean): SendAgent => ({ ...waiting, pendingSend, newestRevision: 4 });

/** A registered review query: its fetch answers, never settles or fails, by `probe.mode`. */
const probe: { mode: "ok" | "hang" | "fail" } = { mode: "ok" };
function fetchProbeReview(): Promise<null> {
  if (probe.mode === "hang") return new Promise<never>(() => {});
  if (probe.mode === "fail") return Promise.reject(new TypeError("Failed to fetch"));
  return Promise.resolve(null);
}
function Probe({ queryFn }: { queryFn: QueryFunction<unknown> }) {
  useQuery({ queryKey: ["review", reviewId], queryFn });
  return null;
}
function mountProbe(queryFn: QueryFunction<unknown> = fetchProbeReview) {
  return render(
    <QueryClientProvider client={client}>
      <Probe queryFn={queryFn} />
    </QueryClientProvider>,
  );
}

test("the fallback shows at 15 seconds even when the refetch never settles", async () => {
  probe.mode = "ok";
  mountProbe();
  mount({ agent: waiting });
  await send();
  probe.mode = "hang";
  await settle(HANDOFF_WAIT_MS);
  expect(screen.getByText(pickedUp)).toBeTruthy();
  expect(within(sentNotice()).getByText(command)).toBeTruthy();
});

test("a pick-up is latched: later data never switches the notice back", async () => {
  const { update } = mount({ agent: waiting });
  await send();
  await settle(HANDOFF_ANNOUNCE_MS);
  update({ agent: { ...waiting, pickedUpAt: pickedAt } });
  expect(screen.getByText(pickedText)).toBeTruthy();
  // The agent publishes: the revision is newer, pickedUpAt is cleared, a Send is pending again.
  update({ agent: nextRevision(true) });
  expect(screen.getByText(pickedText)).toBeTruthy();
  await settle(HANDOFF_WAIT_MS);
  expect(screen.queryByText(pickedUp)).toBeNull();
});

test("a newer revision with nothing pending counts as picked up", async () => {
  const { update } = mount({ agent: waiting });
  await send();
  await settle(HANDOFF_ANNOUNCE_MS);
  update({ agent: nextRevision(false) });
  expect(screen.getByText(pickedText)).toBeTruthy();
});

test("a newer revision with the Send still pending does not count as picked up", async () => {
  const { update } = mount({ agent: waiting });
  await send();
  await settle(HANDOFF_ANNOUNCE_MS);
  update({ agent: nextRevision(true) });
  expect(screen.queryByText(pickedText)).toBeNull();
  expect(screen.getByText("Waiting for the agent to pick this up…")).toBeTruthy();
});

test("the review changing revision while the notice is open leaves it waiting", async () => {
  const { update } = mount({ agent: waiting });
  await send();
  await settle(HANDOFF_ANNOUNCE_MS);
  update({ agent: nextRevision(true), revision: 4, newestRevision: 4 });
  expect(sentNotice()).toBeTruthy();
  expect(screen.getByText("Waiting for the agent to pick this up…")).toBeTruthy();
});

test("a refetch that lands before the Send response opens the notice already picked up", async () => {
  const pending = Promise.withResolvers<Response>();
  fetchMock.mockReturnValueOnce(pending.promise);
  const { update } = mount({ agent: waiting });
  fireEvent.click(screen.getByRole("button", { name: "Send" }));
  await settle();
  // The baseline was read at click time: this snapshot differs from it.
  update({ agent: { ...waiting, pickedUpAt: pickedAt } });
  await act(async () => pending.resolve(new Response(null, { status: 201 })));
  await settle(HANDOFF_ANNOUNCE_MS);
  expect(sentNotice()).toBeTruthy();
  expect(screen.getByText(pickedText)).toBeTruthy();
});

async function pickedNotice() {
  const view = mount({ agent: waiting });
  await send();
  view.update({ agent: { ...waiting, pickedUpAt: pickedAt } });
  return view;
}

test("auto-close runs 3 seconds after a pick-up when the reader has not touched the notice", async () => {
  await pickedNotice();
  await settle(HANDOFF_CLOSE_MS);
  expect(screen.queryByRole("region", { name: "Sent" })).toBeNull();
});

test.each([
  ["a pointer event", () => fireEvent.pointerDown(sentNotice())],
  ["focus", () => within(sentNotice()).getByRole("button", { name: "Close" }).focus()],
  ["a key event", () => fireEvent.keyDown(sentNotice(), { key: "Tab" })],
  [
    "a text selection",
    () => {
      const range = document.createRange();
      range.selectNodeContents(screen.getByText(pickedText));
      const selection = window.getSelection();
      selection?.removeAllRanges();
      selection?.addRange(range);
      document.dispatchEvent(new Event("selectionchange"));
    },
  ],
])("%s inside the notice cancels the auto-close", async (_name, touch) => {
  await pickedNotice();
  await settle(HANDOFF_CLOSE_MS - 1);
  act(() => {
    touch();
  });
  await settle(HANDOFF_CLOSE_MS * 3);
  expect(sentNotice()).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Close" }));
  await settle();
  expect(screen.queryByRole("region", { name: "Sent" })).toBeNull();
});

test("unmounting during the 15 second wait leaves no timer and no refetch", async () => {
  const view = mount({ agent: waiting });
  await send();
  const review = reviewRefetches();
  const errors = vi.spyOn(console, "error");
  view.unmount();
  await settle(HANDOFF_WAIT_MS * 2);
  expect(reviewRefetches()).toBe(review);
  expect(errors).not.toHaveBeenCalled();
  mount({ agent: waiting });
  expect(within(sentNotice()).getByText(pickedUp)).toBeTruthy();
  await settle();
  expect(reviewRefetches()).toBe(review + 1);
  await settle(HANDOFF_WAIT_MS);
  expect(reviewRefetches()).toBe(review + 1);
});

test("returning before the fallback deadline waits only the time left since Send", async () => {
  const view = mount({ agent: waiting });
  await send();
  view.unmount();
  await settle(HANDOFF_WAIT_MS - 1000);
  mount({ agent: waiting });
  await settle(999);
  expect(within(sentNotice()).getByText("Waiting for the agent to pick this up…")).toBeTruthy();
  expect(reconnectReviewEvents).not.toHaveBeenCalled();
  await settle(1);
  expect(within(sentNotice()).getByText(pickedUp)).toBeTruthy();
  expect(reconnectReviewEvents).toHaveBeenCalledOnce();
});

test("returning after the fallback asked keeps the notice without reconnecting or invalidating queries", async () => {
  mountProbe();
  const first = mount({ agent: waiting });
  await send();
  await settle(HANDOFF_WAIT_MS);
  expect(reconnectReviewEvents).toHaveBeenCalledOnce();
  first.unmount();
  invalidate.mockClear();
  mount({ agent: waiting });
  expect(within(sentNotice()).getByText(pickedUp)).toBeTruthy();
  await settle(HANDOFF_WAIT_MS);
  expect(reconnectReviewEvents).toHaveBeenCalledOnce();
  expect(invalidate).not.toHaveBeenCalled();
});

test("leaving before the fallback ask starts lets the next visit ask once", async () => {
  mountProbe();
  const first = mount({ agent: waiting });
  await send();
  first.unmount();
  await settle(HANDOFF_WAIT_MS);
  mount({ agent: waiting }).unmount();
  await settle();
  expect(getHandoffNotice(reviewId)?.asked).toBe(false);
  expect(reconnectReviewEvents).not.toHaveBeenCalled();
  render(tree({ agent: waiting }), { reactStrictMode: true });
  await settle();
  expect(getHandoffNotice(reviewId)?.asked).toBe(true);
  expect(reconnectReviewEvents).toHaveBeenCalledOnce();
});

test("a pick-up while away shows on return for three seconds, then stays closed", async () => {
  const view = mount({ agent: waiting });
  await send();
  view.unmount();
  await settle(HANDOFF_WAIT_MS);
  const agent = { ...waiting, pickedUpAt: pickedAt };
  const returned = mount({ agent });
  await settle(HANDOFF_CLOSE_MS - 1);
  expect(within(sentNotice()).getByText(pickedText)).toBeTruthy();
  expect(reconnectReviewEvents).not.toHaveBeenCalled();
  await settle(1);
  expect(screen.queryByRole("region", { name: "Sent" })).toBeNull();
  returned.unmount();
  mount({ agent });
  expect(screen.queryByRole("region", { name: "Sent" })).toBeNull();
});

test("a held notice keeps its pick-up across visits until the reader closes it", async () => {
  const view = mount({ agent: waiting });
  await send();
  fireEvent.pointerDown(sentNotice());
  view.unmount();
  const returned = mount({ agent: { ...waiting, pickedUpAt: pickedAt } });
  await settle(HANDOFF_CLOSE_MS);
  expect(within(sentNotice()).getByText(pickedText)).toBeTruthy();
  returned.unmount();
  mount({ agent: nextRevision(true) });
  await settle(HANDOFF_CLOSE_MS);
  expect(within(sentNotice()).getByText(pickedText)).toBeTruthy();
  fireEvent.click(within(sentNotice()).getByRole("button", { name: "Close" }));
  expect(screen.queryByRole("region", { name: "Sent" })).toBeNull();
});

test("a second Send replaces the picked-up notice and starts a fresh wait", async () => {
  const view = mount({ agent: waiting });
  await send();
  await settle(HANDOFF_WAIT_MS - 1);
  view.update({ agent: { ...waiting, pickedUpAt: pickedAt } });
  const first = sentNotice();
  expect(within(first).getByText(pickedText)).toBeTruthy();
  await send();
  expect(sentNotice()).not.toBe(first);
  await settle(HANDOFF_WAIT_MS - 1);
  expect(within(sentNotice()).getByText("Waiting for the agent to pick this up…")).toBeTruthy();
  await settle(1);
  expect(within(sentNotice()).getByText(pickedUp)).toBeTruthy();
});

test("unmounting during the 3 second auto-close leaves no timer", async () => {
  const view = await pickedNotice();
  const errors = vi.spyOn(console, "error");
  view.unmount();
  await settle(HANDOFF_CLOSE_MS * 2);
  expect(errors).not.toHaveBeenCalled();
  expect(screen.queryByRole("region", { name: "Sent" })).toBeNull();
});

test.each(["Close", "Escape"])("on desktop, %s inside Sent returns focus to the instructions field", async (key) => {
  mount({ agent: waiting });
  await send();
  expect(document.activeElement).toBe(screen.getByRole("textbox", { name: "Instructions" }));
  const close = within(sentNotice()).getByRole("button", { name: "Close" });
  act(() => close.focus());
  if (key === "Escape") fireEvent.keyDown(close, { key });
  else fireEvent.click(close);
  expect(screen.queryByRole("region", { name: "Sent" })).toBeNull();
  expect(document.activeElement).toBe(screen.getByRole("textbox", { name: "Instructions" }));
});

test("on the phone, the notice opens after the Send sheet closed, has a Close button and returns focus to Send", async () => {
  mount({ agent: idle, phone: true });
  await send(true);
  await settle();
  expect(screen.queryByRole("dialog", { name: "Send feedback" })).toBeNull();
  const close = within(sentNotice()).getByRole("button", { name: "Close" });
  act(() => close.focus());
  fireEvent.click(close);
  await settle();
  expect(screen.queryByRole("region", { name: "Sent" })).toBeNull();
  expect(document.activeElement).toBe(screen.getByRole("button", { name: "Send" }));
});

test("Copy after unmount sets no state and starts no timer", async () => {
  const pending = Promise.withResolvers<void>();
  Object.defineProperty(navigator, "clipboard", { value: { writeText: () => pending.promise }, configurable: true });
  const view = mount({ agent: idle });
  openResume();
  fireEvent.click(screen.getByRole("button", { name: "Copy" }));
  view.unmount();
  await act(async () => {
    pending.resolve();
    await vi.advanceTimersByTimeAsync(0);
  });
  expect(vi.getTimerCount()).toBe(0);
});

test("when the clipboard fails, an execCommand copy that succeeds reads as Copied", async () => {
  Object.defineProperty(navigator, "clipboard", {
    value: { writeText: vi.fn().mockRejectedValue(new Error("denied")) },
    configurable: true,
  });
  const execCommand = vi.fn(() => true);
  Object.defineProperty(document, "execCommand", { value: execCommand, configurable: true, writable: true });
  mount({ agent: idle });
  openResume();
  fireEvent.click(screen.getByRole("button", { name: "Copy" }));
  await settle();
  expect(execCommand).toHaveBeenCalledExactlyOnceWith("copy");
  expect(window.getSelection()?.toString()).toBe(command);
  expect(screen.getByRole("button", { name: "Copied" })).toBeTruthy();
  expect(screen.queryByText("Select and copy the command")).toBeNull();
  Reflect.deleteProperty(document, "execCommand");
});

test("a repeated failure changes the announcement text so it is announced again", async () => {
  Object.defineProperty(navigator, "clipboard", {
    value: { writeText: vi.fn().mockRejectedValue(new Error("denied")) },
    configurable: true,
  });
  Object.defineProperty(document, "execCommand", { value: () => false, configurable: true, writable: true });
  mount({ agent: idle });
  openResume();
  fireEvent.click(screen.getByRole("button", { name: "Copy" }));
  await settle();
  const first = screen.getByText("Select and copy the command").textContent;
  fireEvent.click(screen.getByRole("button", { name: "Copy" }));
  await settle();
  const second = screen.getByText("Select and copy the command").textContent;
  expect(second).not.toBe(first);
  expect(`${first}|${second}`).toContain(String.fromCharCode(0xa0));
  Reflect.deleteProperty(document, "execCommand");
});

test("on the phone, the notice mounts in the Send bar during the Send sheet's exit animation", async () => {
  // Happy DOM runs no animations: report one on the Send sheet, with a different name once closed, so
  // the name changes on close and the sheet stays mounted until its animationend.
  let lastName = "";
  const real = globalThis.getComputedStyle.bind(globalThis);
  vi.spyOn(globalThis, "getComputedStyle").mockImplementation((element, pseudo) => {
    const style = real(element, pseudo);
    const sheet = element.getAttribute("role") === "dialog" && element.textContent?.includes("Send feedback");
    if (!sheet) return style;
    // A live object, like a real computed style: Radix keeps it and reads it again on close.
    return {
      get animationName() {
        lastName = element.getAttribute("data-state") === "closed" ? "sheet-exit" : "sheet-enter";
        return lastName;
      },
      getPropertyValue: () => "",
      display: "block",
    } as unknown as CSSStyleDeclaration;
  });
  mount({ agent: idle, phone: true });
  await send(true);
  await settle();
  const sheet = screen.getByRole("dialog", { name: "Send feedback", hidden: true });
  expect(within(screen.getByLabelText("Send and approve")).getByLabelText("Sent")).toBeTruthy();
  fireEvent.animationEnd(sheet, { animationName: lastName });
  await settle();
  expect(screen.queryByRole("dialog", { name: "Send feedback" })).toBeNull();
  expect(sentNotice()).toBeTruthy();
});

const lostText =
  "recense cannot reach its server right now, so a pick-up may not show here. If no agent has it yet, hand it over with the command below.";

test("returning while the server is unreachable keeps the warning through one retry until the review fetch succeeds", async () => {
  mountProbe();
  const first = mount({ agent: waiting });
  await send();
  probe.mode = "fail";
  await settle(HANDOFF_WAIT_MS);
  expect(within(sentNotice()).getByText(lostText)).toBeTruthy();
  expect(reconnectReviewEvents).toHaveBeenCalledOnce();
  first.unmount();

  const retry = Promise.withResolvers<boolean>();
  vi.mocked(reconnectReviewEvents).mockReturnValueOnce(retry.promise);
  invalidate.mockClear();
  render(tree({ agent: waiting }), { reactStrictMode: true });
  expect(within(sentNotice()).getByText(lostText)).toBeTruthy();
  await settle();
  expect(reconnectReviewEvents).toHaveBeenCalledTimes(2);
  expect(within(sentNotice()).getByText(lostText)).toBeTruthy();
  expect(getHandoffNotice(reviewId)?.lost).toBe(true);

  probe.mode = "ok";
  await act(async () => retry.resolve(false));
  await settle();
  expect(reviewRefetches()).toBe(1);
  expect(inboxRefetches()).toBe(1);
  expect(within(sentNotice()).getByText(pickedUp)).toBeTruthy();
  expect(getHandoffNotice(reviewId)).toMatchObject({ asked: true, lost: false });
  expect(reconnectReviewEvents).toHaveBeenCalledTimes(2);
});

test("an offline retry keeps the warning until the paused review fetch succeeds", async () => {
  const fetchReview = vi.fn(fetchProbeReview);
  mountProbe(fetchReview);
  const first = mount({ agent: waiting });
  await send();
  probe.mode = "fail";
  await settle(HANDOFF_WAIT_MS);
  expect(getHandoffNotice(reviewId)?.lost).toBe(true);
  first.unmount();

  const wasOnline = onlineManager.isOnline();
  try {
    onlineManager.setOnline(false);
    probe.mode = "ok";
    fetchReview.mockClear();
    mount({ agent: waiting });
    await settle();
    expect(reconnectReviewEvents).toHaveBeenCalledTimes(2);
    expect(client.getQueryState(["review", reviewId])?.fetchStatus).toBe("paused");
    expect(fetchReview).not.toHaveBeenCalled();
    expect(within(sentNotice()).getByText(lostText)).toBeTruthy();
    expect(getHandoffNotice(reviewId)).toMatchObject({ asked: true, lost: true });

    await act(async () => onlineManager.setOnline(true));
    expect(fetchReview).toHaveBeenCalledOnce();
    expect(within(sentNotice()).getByText(pickedUp)).toBeTruthy();
    expect(getHandoffNotice(reviewId)?.lost).toBe(false);
  } finally {
    onlineManager.setOnline(wasOnline);
  }
});

test("leaving during the first review fetch cancels it and lets the next visit ask again", async () => {
  const fetchReview = vi.fn<QueryFunction<null>>().mockResolvedValue(null);
  const observer = mountProbe(fetchReview);
  const first = mount({ agent: waiting });
  await send();
  fetchReview.mockClear();
  fetchReview.mockImplementationOnce(
    ({ signal }) => new Promise<never>((_, reject) => signal.addEventListener("abort", () => reject(signal.reason))),
  );
  await settle(HANDOFF_WAIT_MS);
  expect(fetchReview).toHaveBeenCalledOnce();
  expect(getHandoffNotice(reviewId)?.asked).toBe(true);
  first.unmount();
  observer.unmount();
  await settle();
  expect(fetchReview.mock.calls[0]?.[0].signal.aborted).toBe(true);
  expect(getHandoffNotice(reviewId)).toMatchObject({ asked: false, lost: false });

  invalidate.mockClear();
  mount({ agent: waiting });
  await settle();
  expect(reconnectReviewEvents).toHaveBeenCalledTimes(2);
  expect(reviewRefetches()).toBe(1);
  expect(fetchReview).toHaveBeenCalledTimes(2);
  expect(getHandoffNotice(reviewId)).toMatchObject({ asked: true, lost: false });
});

test("a Send fetch failure during reconnect lets the next visit retry a cancelled first ask", async () => {
  const queryKey = ["review", reviewId];
  const fetchReview = vi.fn<QueryFunction<null>>().mockResolvedValue(null);
  const observer = mountProbe(fetchReview);
  const first = mount({ agent: waiting });
  await settle();

  const background = Promise.withResolvers<null>();
  const reconnect = Promise.withResolvers<boolean>();
  vi.mocked(reconnectReviewEvents).mockReturnValueOnce(reconnect.promise);
  fetchReview
    .mockClear()
    .mockReturnValueOnce(background.promise)
    .mockImplementationOnce(
      ({ signal }) => new Promise<never>((_, reject) => signal.addEventListener("abort", () => reject(signal.reason))),
    );
  await send();
  await settle(HANDOFF_WAIT_MS);
  expect(reconnectReviewEvents).toHaveBeenCalledOnce();
  expect(fetchReview).toHaveBeenCalledOnce();
  const error = new TypeError("Failed to fetch");
  await act(async () => background.reject(error));
  expect(client.getQueryState(queryKey)?.error).toBe(error);

  await act(async () => reconnect.resolve(false));
  expect(fetchReview).toHaveBeenCalledTimes(2);
  first.unmount();
  observer.unmount();
  await settle();
  expect(fetchReview.mock.calls[1]?.[0].signal.aborted).toBe(true);
  expect(getHandoffNotice(reviewId)).toMatchObject({ asked: false, lost: false });

  fetchReview.mockRejectedValueOnce(error);
  mount({ agent: waiting });
  await settle();
  expect(reconnectReviewEvents).toHaveBeenCalledTimes(2);
  expect(within(sentNotice()).getByText(lostText)).toBeTruthy();
});

test.each(["new data", "HTTP 500"])(
  "a Send fetch returning %s during reconnect still counts after leaving cancels the first ask's refetch",
  async (answer) => {
    const queryKey = ["review", reviewId];
    const fetchReview = vi.fn<QueryFunction<SendAgent | null>>().mockResolvedValue(null);
    const observer = mountProbe(fetchReview);
    const first = mount({ agent: waiting });
    await settle();

    const background = Promise.withResolvers<SendAgent>();
    const reconnect = Promise.withResolvers<boolean>();
    vi.mocked(reconnectReviewEvents).mockReturnValueOnce(reconnect.promise);
    fetchReview
      .mockClear()
      .mockReturnValueOnce(background.promise)
      .mockImplementationOnce(({ signal }) => {
        return new Promise<never>((_, reject) => signal.addEventListener("abort", () => reject(signal.reason)));
      });
    await send();
    await settle(HANDOFF_WAIT_MS);
    expect(reconnectReviewEvents).toHaveBeenCalledOnce();
    expect(fetchReview).toHaveBeenCalledOnce();
    if (answer === "new data") {
      await act(async () => background.resolve(waiting));
      expect(client.getQueryData(queryKey)).toEqual(waiting);
    } else {
      const error = new ApiError(500, "internal_error", "Internal server error");
      await act(async () => background.reject(error));
      expect(client.getQueryState(queryKey)?.error).toBe(error);
    }

    await act(async () => reconnect.resolve(false));
    expect(fetchReview).toHaveBeenCalledTimes(2);
    first.unmount();
    observer.unmount();
    await settle();
    expect(fetchReview.mock.calls[1]?.[0].signal.aborted).toBe(true);
    expect(getHandoffNotice(reviewId)).toMatchObject({ asked: true, lost: false });

    invalidate.mockClear();
    mount({ agent: waiting });
    await settle();
    expect(within(sentNotice()).getByText(pickedUp)).toBeTruthy();
    expect(reconnectReviewEvents).toHaveBeenCalledOnce();
    expect(reviewRefetches()).toBe(0);
    expect(fetchReview).toHaveBeenCalledTimes(2);
  },
);

test("a newer cached TypeError alone keeps the warning when the retry resolves", async () => {
  const queryKey = ["review", reviewId];
  mountProbe();
  const first = mount({ agent: waiting });
  await send();
  probe.mode = "fail";
  await settle(HANDOFF_WAIT_MS);
  expect(getHandoffNotice(reviewId)?.lost).toBe(true);
  first.unmount();

  // Let the retry resolve normally while a separate review fetch updates only the cached error.
  const retry = Promise.withResolvers<void>();
  invalidate.mockClear().mockReturnValue(retry.promise);
  mount({ agent: waiting });
  await settle();
  expect(reviewRefetches()).toBe(1);
  const before = client.getQueryState(queryKey);
  await act(async () => {
    await client.refetchQueries({ queryKey });
    retry.resolve();
  });
  expect(client.getQueryState(queryKey)).toMatchObject({
    dataUpdateCount: before?.dataUpdateCount,
    errorUpdateCount: (before?.errorUpdateCount ?? 0) + 1,
    error: expect.any(TypeError),
  });
  expect(getHandoffNotice(reviewId)).toMatchObject({ asked: true, lost: true });
  expect(within(sentNotice()).getByText(lostText)).toBeTruthy();
});

test("a fallback refetch that times out while the reader is away records the failure for the next visit", async () => {
  mountProbe();
  const first = mount({ agent: waiting });
  await send();
  probe.mode = "hang";
  await settle(HANDOFF_WAIT_MS);
  first.unmount();
  await settle(HANDOFF_REFETCH_MS);
  expect(getHandoffNotice(reviewId)).toMatchObject({ asked: true, lost: true });
  mount({ agent: waiting });
  expect(within(sentNotice()).getByText(lostText)).toBeTruthy();
});

async function leaveBeforeFirstReviewRefetch() {
  const fetchReview = vi.fn<typeof fetchProbeReview>().mockResolvedValue(null);
  const observer = mountProbe(fetchReview);
  const first = mount({ agent: waiting });
  await send();
  const reconnect = Promise.withResolvers<boolean>();
  vi.mocked(reconnectReviewEvents).mockReturnValueOnce(reconnect.promise);
  await settle(HANDOFF_WAIT_MS);
  expect(reconnectReviewEvents).toHaveBeenCalledOnce();
  first.unmount();
  observer.unmount();
  expect(
    client
      .getQueryCache()
      .find({ queryKey: ["review", reviewId] })
      ?.getObserversCount(),
  ).toBe(0);
  fetchReview.mockClear();
  return { fetchReview, reconnect };
}

test("a review that answers the first ask while unobserved shows the plain fallback without asking again", async () => {
  const { fetchReview, reconnect } = await leaveBeforeFirstReviewRefetch();
  await act(async () => reconnect.resolve(false));
  expect(fetchReview).toHaveBeenCalledOnce();
  expect(getHandoffNotice(reviewId)).toMatchObject({ asked: true, lost: false });
  invalidate.mockClear();
  mount({ agent: waiting });
  await settle(HANDOFF_WAIT_MS);
  expect(within(sentNotice()).getByText(pickedUp)).toBeTruthy();
  expect(reconnectReviewEvents).toHaveBeenCalledOnce();
  expect(reviewRefetches()).toBe(0);
  expect(fetchReview).toHaveBeenCalledOnce();
});

test("a network failure while away shows the warning on return until the retry receives an HTTP error", async () => {
  const { fetchReview, reconnect } = await leaveBeforeFirstReviewRefetch();
  fetchReview.mockRejectedValueOnce(new TypeError("Failed to fetch"));
  await act(async () => reconnect.resolve(false));
  expect(fetchReview).toHaveBeenCalledOnce();
  expect(getHandoffNotice(reviewId)).toMatchObject({ asked: true, lost: true });

  fetchReview.mockRejectedValueOnce(new ApiError(500, "internal_error", "Internal server error"));
  mount({ agent: waiting });
  expect(within(sentNotice()).getByText(lostText)).toBeTruthy();
  await settle(HANDOFF_WAIT_MS);
  expect(reconnectReviewEvents).toHaveBeenCalledTimes(2);
  expect(fetchReview).toHaveBeenCalledTimes(2);
  expect(within(sentNotice()).getByText(pickedUp)).toBeTruthy();
  expect(getHandoffNotice(reviewId)?.lost).toBe(false);
});

test("a Send answered by the server opens the notice and frees the button while the refetch never settles", async () => {
  mountProbe();
  await settle();
  probe.mode = "hang";
  mount({ agent: idle });
  await send();
  expect(sentNotice()).toBeTruthy();
  const sendButton = screen.getByRole("button", { name: "Send" });
  expect(sendButton.getAttribute("aria-busy")).not.toBe("true");
  expect((sendButton as HTMLButtonElement).disabled).toBe(false);
});

test("an Approve answered by the server shows its toast and frees the button while the refetch never settles", async () => {
  mountProbe();
  await settle();
  probe.mode = "hang";
  mount({ agent: idle, unsentCount: 0 });
  approve("Approve revision 3");
  await settle();
  expect(screen.getByText("Approved revision 3")).toBeTruthy();
  const approveButton = screen.getByRole<HTMLButtonElement>("button", { name: "Approve revision 3" });
  expect(approveButton.getAttribute("aria-busy")).not.toBe("true");
  expect(approveButton.disabled).toBe(false);
  expect(screen.queryByRole("alertdialog")).toBeNull();
});

test.each(["hang", "fail"] as const)(
  "the notice says the server cannot be reached when the stream stays closed and the refetch %ss",
  async (mode) => {
    mountProbe();
    await settle();
    mount({ agent: waiting });
    await send();
    probe.mode = mode;
    await settle(HANDOFF_WAIT_MS);
    // The fallback never waits on the network: a stalled fetch leaves the usual wording until the
    // refetch's own limit passes, while a failed one is known at once.
    if (mode === "hang") expect(screen.getByText(pickedUp)).toBeTruthy();
    await settle(HANDOFF_REFETCH_MS);
    expect(screen.getByText(lostText)).toBeTruthy();
    const notice = sentNotice();
    expect(within(notice).getByText(command)).toBeTruthy();
    expect(within(notice).getByRole("button", { name: "Copy" })).toBeTruthy();
    expect(within(notice).getByText(/and handle the result with the recense-feedback skill\.$/)).toBeTruthy();
  },
);

test("the notice keeps the normal wording when the stream reopens", async () => {
  vi.mocked(reconnectReviewEvents).mockResolvedValue(true);
  mountProbe();
  await settle();
  mount({ agent: waiting });
  await send();
  probe.mode = "hang";
  const review = reviewRefetches();
  await settle(HANDOFF_WAIT_MS + HANDOFF_REFETCH_MS * 2);
  expect(screen.getByText(pickedUp)).toBeTruthy();
  expect(screen.queryByText(lostText)).toBeNull();
  // A reopened stream refetches by itself: the notice adds no refetch of its own.
  expect(reviewRefetches()).toBe(review);
});

test("a late pick-up after the connection-lost wording switches the notice to picked up", async () => {
  mountProbe();
  await settle();
  probe.mode = "fail";
  const { update } = mount({ agent: idle });
  await send();
  await settle(HANDOFF_REFETCH_MS * 2);
  expect(screen.getByText(lostText)).toBeTruthy();
  update({ agent: { ...idle, pickedUpAt: pickedAt } });
  expect(screen.getByText(pickedText)).toBeTruthy();
  expect(screen.queryByText(lostText)).toBeNull();
});
