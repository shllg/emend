import { QueryClient, QueryClientProvider, useQuery } from "@tanstack/react-query";
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import type { ComponentProps, ReactNode } from "react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { reconnectReviewEvents } from "../../lib/event-stream.ts";
import { ToastProvider } from "../ui/Toast.tsx";
import { HANDOFF_CLOSE_MS, HANDOFF_REFETCH_MS, HANDOFF_WAIT_MS, type SendAgent } from "./HandOver.tsx";
import type { ReviewLifecycle } from "./ReviewActions.tsx";
import { SendBar } from "./SendBar.tsx";

// The live stream is not under test here: by default no stream reopens, as with no subscription.
vi.mock("../../lib/event-stream.ts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../lib/event-stream.ts")>()),
  reconnectReviewEvents: vi.fn(() => Promise.resolve(false)),
}));

const reviewId = "11111111-1111-4111-8111-111111111111";
const command = `/emend:emend-feedback ${reviewId}`;
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
  onDeleted: () => {},
};
const pickedUp = "No agent has picked this up yet. emend keeps it until one does.";
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
const refetches = (key: string) =>
  invalidate.mock.calls.filter((call: unknown[]) => (call[0] as { queryKey?: string[] })?.queryKey?.[0] === key).length;
const reviewRefetches = () => refetches("review");
const inboxRefetches = () => refetches("inbox");

test("the Send bar says an agent is waiting and shows no command", () => {
  mount({ agent: waiting });
  expect(screen.getByText("An agent is waiting. It gets this now.")).toBeTruthy();
  expect(screen.queryByText(command)).toBeNull();
  expect(screen.queryByRole("button", { name: "Copy" })).toBeNull();
});

test("the Send bar says no agent waits and gives the command, a Copy button and the line for other agents", () => {
  mount({ agent: idle });
  expect(screen.getByText("No agent is waiting. emend keeps this until an agent picks it up.")).toBeTruthy();
  expect(screen.getByText(command)).toBeTruthy();
  expect(screen.getByRole("button", { name: "Copy" })).toBeTruthy();
  expect(screen.getByText(`emend feedback ${reviewId}`).tagName).toBe("CODE");
  expect(screen.getByText(/and handle the result with the emend-feedback skill\.$/)).toBeTruthy();
});

test.each<[string, Partial<ReviewLifecycle>, string]>([
  ["a snoozed review", { snoozed: true }, "The agent stopped waiting when you snoozed this on"],
  ["a retired review", { state: "settled" }, "The agent stopped waiting when you retired this on"],
  ["any other review", {}, "The agent stopped waiting on"],
])("the Send bar says when emend ended the wait of %s, instead of the no-agent line", (_name, change, text) => {
  mount({ agent: { ...idle, releasedAt: "2026-03-05T12:00:00.000Z" }, lifecycle: { ...lifecycle, ...change } });
  expect(screen.getByText(new RegExp(`^${text} .*\\.$`))).toBeTruthy();
  expect(screen.queryByText(/No agent is waiting/)).toBeNull();
  expect(screen.getByText(command)).toBeTruthy();
});

test("the Send bar says nothing about the agent when it is not told, or when the review is approved", () => {
  const { update } = mount();
  expect(screen.queryByText(/agent is waiting|No agent|stopped waiting/)).toBeNull();
  update({ agent: idle, approved: true });
  expect(screen.queryByText(/No agent is waiting/)).toBeNull();
});

test("the phone puts the longer text in the Send sheet, not in the bar", () => {
  mount({ agent: idle, phone: true });
  expect(screen.queryByText(command)).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Send" }));
  expect(screen.getByText(command)).toBeTruthy();
});

test("with an agent waiting, the window waits, then confirms the pick-up and closes by itself", async () => {
  const { update } = mount({ agent: waiting });
  await send();
  const dialog = screen.getByRole("alertdialog", { name: "Sent" });
  expect(dialog.textContent).toContain("Waiting for the agent to pick this up…");
  expect(screen.getByText("Waiting for the agent to pick this up…").closest('[role="status"]')).toBeTruthy();
  update({ agent: { ...waiting, pickedUpAt: "2026-03-05T12:00:00.000Z" } });
  expect(screen.getByText("The agent picked up your feedback.")).toBeTruthy();
  await settle(HANDOFF_CLOSE_MS - 1);
  expect(screen.queryByRole("alertdialog")).toBeTruthy();
  await settle(1);
  expect(screen.queryByRole("alertdialog")).toBeNull();
  expect(fetchMock).toHaveBeenCalledOnce();
});

test("with no agent waiting, the window shows the fallback at once and asks the server once", async () => {
  mount({ agent: idle });
  await send();
  const dialog = screen.getByRole("alertdialog", { name: "Sent" });
  expect(dialog.textContent).toContain(pickedUp);
  expect(dialog.textContent).toContain(command);
  expect(dialog.textContent).toContain(`Run emend feedback ${reviewId} and handle the result`);
  // The Send's own success refetches once; the window adds one more, and no further one.
  expect(reviewRefetches()).toBe(2);
  expect(inboxRefetches()).toBe(2);
  await settle(HANDOFF_WAIT_MS * 2);
  expect(reviewRefetches()).toBe(2);
});

test("after 15 seconds without a pick-up the window refetches once, then shows the fallback", async () => {
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

test("a late pick-up switches the open window and then closes it", async () => {
  const { update } = mount({ agent: idle });
  await send();
  expect(screen.getByText(pickedUp)).toBeTruthy();
  update({ agent: { ...idle, pickedUpAt: "2026-03-05T12:00:00.000Z" } });
  expect(screen.getByText("The agent picked up your feedback.")).toBeTruthy();
  expect(within(screen.getByRole("alertdialog")).queryByText(command)).toBeNull();
  await settle(HANDOFF_CLOSE_MS);
  expect(screen.queryByRole("alertdialog")).toBeNull();
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

test("Approve opens no window", async () => {
  mount({ agent: waiting, unsentCount: 0 });
  approve("Approve revision 3");
  await settle();
  expect(screen.getByText("Approved revision 3")).toBeTruthy();
  expect(screen.queryByRole("alertdialog")).toBeNull();
  expect(screen.queryByText(/pick this up/)).toBeNull();
});

test("closing the window does not cancel the Send", async () => {
  mount({ agent: waiting });
  await send();
  const review = reviewRefetches();
  fireEvent.click(screen.getByRole("button", { name: "Close" }));
  await settle(HANDOFF_WAIT_MS * 2);
  expect(screen.queryByRole("alertdialog")).toBeNull();
  expect(fetchMock).toHaveBeenCalledOnce();
  expect(reviewRefetches()).toBe(review);
});

test("the phone shows the window in the bottom sheet", async () => {
  mount({ agent: idle, phone: true });
  await send(true);
  expect(screen.queryByRole("alertdialog")).toBeNull();
  const sheet = screen.getByRole("dialog", { name: "Sent" });
  expect(sheet.textContent).toContain(pickedUp);
  expect(sheet.textContent).toContain(command);
});

test("Copy writes the command, reads Copied for 2 seconds and announces it", async () => {
  const writeText = vi.fn().mockResolvedValue(undefined);
  Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
  mount({ agent: idle });
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
  fireEvent.click(screen.getByRole("button", { name: "Copy" }));
  await settle();
  expect(screen.getByText("Select and copy the command")).toBeTruthy();
  expect(window.getSelection()?.toString()).toBe(command);
  expect(screen.getByRole("button", { name: "Copy" })).toBeTruthy();
});

test("a missing clipboard counts as a failed Copy", async () => {
  Object.defineProperty(navigator, "clipboard", { value: undefined, configurable: true });
  mount({ agent: idle });
  fireEvent.click(screen.getByRole("button", { name: "Copy" }));
  await settle();
  expect(screen.getByText("Select and copy the command")).toBeTruthy();
});

test("the command renders as text, never HTML", () => {
  const hostile = "<img src=x onerror=alert(1)>";
  const { container } = mount({ reviewId: hostile, agent: idle });
  expect(container.querySelector("img")).toBeNull();
  expect(screen.getByText(`/emend:emend-feedback ${hostile}`)).toBeTruthy();
});

const pickedAt = "2026-03-05T12:00:00.000Z";
const pickedText = "The agent picked up your feedback.";
const nextRevision = (pendingSend: boolean): SendAgent => ({ ...waiting, pendingSend, newestRevision: 4 });

/** A registered review query: its fetch answers, never settles or fails, by `probe.mode`. */
const probe: { mode: "ok" | "hang" | "fail" } = { mode: "ok" };
function Probe() {
  useQuery({
    queryKey: ["review", reviewId],
    queryFn: () =>
      probe.mode === "hang"
        ? new Promise<never>(() => {})
        : probe.mode === "fail"
          ? Promise.reject(new TypeError("Failed to fetch"))
          : Promise.resolve(null),
  });
  return null;
}
function mountProbe() {
  render(
    <QueryClientProvider client={client}>
      <Probe />
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
  expect(within(screen.getByRole("alertdialog")).getByText(command)).toBeTruthy();
});

test("a pick-up is latched: later data never switches the window back", async () => {
  const { update } = mount({ agent: waiting });
  await send();
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
  update({ agent: nextRevision(false) });
  expect(screen.getByText(pickedText)).toBeTruthy();
});

test("a newer revision with the Send still pending does not count as picked up", async () => {
  const { update } = mount({ agent: waiting });
  await send();
  update({ agent: nextRevision(true) });
  expect(screen.queryByText(pickedText)).toBeNull();
  expect(screen.getByText("Waiting for the agent to pick this up…")).toBeTruthy();
});

test("the review changing revision while the window is open leaves it waiting", async () => {
  const { update } = mount({ agent: waiting });
  await send();
  update({ agent: nextRevision(true), revision: 4, newestRevision: 4 });
  expect(screen.getByRole("alertdialog", { name: "Sent" })).toBeTruthy();
  expect(screen.getByText("Waiting for the agent to pick this up…")).toBeTruthy();
});

test("a refetch that lands before the Send response opens the window already picked up", async () => {
  const pending = Promise.withResolvers<Response>();
  fetchMock.mockReturnValueOnce(pending.promise);
  const { update } = mount({ agent: waiting });
  fireEvent.click(screen.getByRole("button", { name: "Send" }));
  await settle();
  // The baseline was read at click time: this snapshot differs from it.
  update({ agent: { ...waiting, pickedUpAt: pickedAt } });
  await act(async () => pending.resolve(new Response(null, { status: 201 })));
  await settle();
  expect(screen.getByRole("alertdialog", { name: "Sent" })).toBeTruthy();
  expect(screen.getByText(pickedText)).toBeTruthy();
});

async function pickedWindow() {
  const view = mount({ agent: waiting });
  await send();
  view.update({ agent: { ...waiting, pickedUpAt: pickedAt } });
  return view;
}

test("auto-close runs 3 seconds after a pick-up when the reader has not touched the window", async () => {
  await pickedWindow();
  await settle(HANDOFF_CLOSE_MS);
  expect(screen.queryByRole("alertdialog")).toBeNull();
});

test.each([
  ["a pointer event", () => fireEvent.pointerDown(screen.getByRole("alertdialog"))],
  ["a key event", () => fireEvent.keyDown(screen.getByRole("alertdialog"), { key: "Tab" })],
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
])("%s inside the window cancels the auto-close", async (_name, touch) => {
  await pickedWindow();
  await settle(HANDOFF_CLOSE_MS - 1);
  act(() => {
    touch();
  });
  await settle(HANDOFF_CLOSE_MS * 3);
  expect(screen.getByRole("alertdialog", { name: "Sent" })).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Close" }));
  await settle();
  expect(screen.queryByRole("alertdialog")).toBeNull();
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
});

test("unmounting during the 3 second auto-close leaves no timer", async () => {
  const view = await pickedWindow();
  const errors = vi.spyOn(console, "error");
  view.unmount();
  await settle(HANDOFF_CLOSE_MS * 2);
  expect(errors).not.toHaveBeenCalled();
  expect(screen.queryByRole("alertdialog")).toBeNull();
});

test("on the desktop, closing the window returns focus to the instructions field", async () => {
  mount({ agent: waiting });
  await send();
  fireEvent.click(screen.getByRole("button", { name: "Close" }));
  await settle();
  expect(document.activeElement).toBe(screen.getByRole("textbox", { name: "Instructions" }));
});

test("on the phone, the window opens after the Send sheet closed, has a Close button and returns focus to Send", async () => {
  mount({ agent: idle, phone: true });
  await send(true);
  await settle();
  expect(screen.queryByRole("dialog", { name: "Send feedback" })).toBeNull();
  expect(screen.getByRole("dialog", { name: "Sent" })).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Close" }));
  await settle();
  expect(screen.queryByRole("dialog")).toBeNull();
  expect(document.activeElement).toBe(screen.getByRole("button", { name: "Send" }));
});

test("Copy after unmount sets no state and starts no timer", async () => {
  const pending = Promise.withResolvers<void>();
  Object.defineProperty(navigator, "clipboard", { value: { writeText: () => pending.promise }, configurable: true });
  const view = mount({ agent: idle });
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

test("on the phone, the window waits for the Send sheet's exit animation to end", async () => {
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
  expect(screen.queryByRole("dialog", { name: "Sent" })).toBeNull();
  fireEvent.animationEnd(sheet, { animationName: lastName });
  await settle();
  expect(screen.queryByRole("dialog", { name: "Send feedback" })).toBeNull();
  expect(screen.getByRole("dialog", { name: "Sent" })).toBeTruthy();
});

const lostText =
  "emend cannot reach its server right now, so a pick-up may not show here. If no agent has it yet, hand it over with the command below.";

test("a Send answered by the server opens the window and frees the button while the refetch never settles", async () => {
  mountProbe();
  await settle();
  probe.mode = "hang";
  mount({ agent: idle });
  await send();
  expect(screen.getByRole("alertdialog", { name: "Sent" })).toBeTruthy();
  const sendButton = screen.getByRole("button", { name: "Send", hidden: true });
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
  "the window says the server cannot be reached when the stream stays closed and the refetch %ss",
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
    const dialog = screen.getByRole("alertdialog");
    expect(within(dialog).getByText(command)).toBeTruthy();
    expect(within(dialog).getByRole("button", { name: "Copy" })).toBeTruthy();
    expect(within(dialog).getByText(/and handle the result with the emend-feedback skill\.$/)).toBeTruthy();
  },
);

test("the window keeps the normal wording when the stream reopens", async () => {
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
  // A reopened stream refetches by itself: the window adds no refetch of its own.
  expect(reviewRefetches()).toBe(review);
});

test("a late pick-up after the connection-lost wording switches the window to picked up", async () => {
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
