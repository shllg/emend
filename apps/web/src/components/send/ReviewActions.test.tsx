import { QueryClient, QueryClientProvider, useQuery } from "@tanstack/react-query";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { type ComponentProps, type ReactNode, useState } from "react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { reviewQuery } from "../../api/queries.ts";
import { wakeTime } from "../../lib/time.ts";
import { Button } from "../ui/Button.tsx";
import { Dialog } from "../ui/Dialog.tsx";
import { ToastProvider } from "../ui/Toast.tsx";
import { ReviewActions, type ReviewLifecycle } from "./ReviewActions.tsx";

const reviewId = "11111111-1111-4111-8111-111111111111";
const base = `/api/v1/reviews/${reviewId}`;
const lifecycle: ReviewLifecycle = {
  title: "Synthetic <b>review</b>",
  state: "open",
  snoozed: false,
  snoozedUntil: null,
  onDeleted: vi.fn(),
};
let client: QueryClient;
let fetchMock: ReturnType<typeof vi.fn<typeof fetch>>;
beforeEach(() => {
  vi.mocked(lifecycle.onDeleted).mockClear();
  client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  fetchMock = vi.fn<typeof fetch>(async () => new Response(null, { status: 204 }));
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => {
  cleanup();
  client.clear();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});
function wrapper({ children }: { children: ReactNode }) {
  return (
    <QueryClientProvider client={client}>
      <ToastProvider>{children}</ToastProvider>
    </QueryClientProvider>
  );
}
type Props = { lifecycle?: Partial<ReviewLifecycle> } & Partial<
  Omit<ComponentProps<typeof ReviewActions>, "lifecycle">
>;
function mount(props: Props = {}) {
  const element = (next: Props) => (
    <ReviewActions
      reviewId={reviewId}
      unsentCount={0}
      phone={false}
      {...next}
      lifecycle={{ ...lifecycle, ...next.lifecycle }}
    />
  );
  const result = render(element(props), { wrapper });
  return { ...result, update: (next: Props) => result.rerender(element(next)) };
}
function openMenu() {
  fireEvent.keyDown(screen.getByRole("button", { name: "More review actions" }), { key: "ArrowDown" });
}
async function choose(name: string | RegExp) {
  openMenu();
  fireEvent.click(await screen.findByRole("menuitem", { name }));
}
function sent() {
  return fetchMock.mock.calls.map(([path, init]) => [init?.method, path, init?.body]);
}

test.each([
  ["open", false, ["Snooze", "Retire", "Delete"]],
  ["open", true, ["Snooze again", "Unsnooze", "Retire", "Delete"]],
  ["settled", false, ["Reopen", "Delete"]],
  ["approved", false, ["Delete"]],
] as const)("the %s review (snoozed %s) offers %j", async (state, snoozed, expected) => {
  mount({ lifecycle: { state, snoozed, snoozedUntil: snoozed ? "2026-11-05T09:00:00.000Z" : null } });
  openMenu();
  await screen.findAllByRole("menuitem");
  expect(screen.getAllByRole("menuitem").map((item) => item.textContent)).toEqual(expected);
});

test("the snooze choices show their wake times and send the right body at a late evening clock", async () => {
  // Wednesday 4 November 2026, 22:30 local time: three hours later is already Thursday.
  const now = new Date(2026, 10, 4, 22, 30);
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(now);
  const later = new Date(2026, 10, 5, 1, 30);
  const tomorrow = new Date(2026, 10, 5, 9, 0);
  const week = new Date(2026, 10, 9, 9, 0);
  const cases = [
    [/^Until it changes$/, { untilRevision: true }],
    [new RegExp(`^Later today · ${wakeTime(later, now.getTime())}$`), { until: later.toISOString() }],
    [new RegExp(`^Tomorrow morning · ${wakeTime(tomorrow, now.getTime())}$`), { until: tomorrow.toISOString() }],
    [new RegExp(`^Next week · ${wakeTime(week, now.getTime())}$`), { until: week.toISOString() }],
  ] as const;
  for (const [name, body] of cases) {
    fetchMock.mockClear();
    const view = mount();
    await choose("Snooze");
    const dialog = await screen.findByRole("alertdialog", { name: "Snooze this review" });
    fireEvent.click(within(dialog).getByRole("button", { name }));
    await waitFor(() => expect(sent()).toEqual([["POST", `${base}/snooze`, JSON.stringify(body)]]));
    await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
    view.unmount();
  }
});

test("Next week on a Monday goes a full week out; on a Sunday it is the next day", async () => {
  for (const [now, monday] of [
    [new Date(2026, 10, 9, 10, 0), new Date(2026, 10, 16, 9, 0)],
    [new Date(2026, 10, 8, 10, 0), new Date(2026, 10, 9, 9, 0)],
  ] as const) {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(now);
    fetchMock.mockClear();
    const view = mount();
    await choose("Snooze");
    fireEvent.click(await screen.findByRole("button", { name: /^Next week/ }));
    await waitFor(() =>
      expect(sent()).toEqual([["POST", `${base}/snooze`, JSON.stringify({ until: monday.toISOString() })]]),
    );
    view.unmount();
  }
});

test("unsnooze and reopen call their routes without a body", async () => {
  const snoozed = mount({ lifecycle: { snoozed: true, snoozedUntil: null } });
  await choose("Unsnooze");
  await screen.findByText("Review unsnoozed");
  expect(sent()).toEqual([["POST", `${base}/unsnooze`, undefined]]);
  snoozed.unmount();
  fetchMock.mockClear();
  mount({ lifecycle: { state: "settled" } });
  await choose("Reopen");
  await screen.findByText("Review reopened");
  expect(sent()).toEqual([["POST", `${base}/reopen`, undefined]]);
});

test("retire without unsent comments sends an empty body", async () => {
  mount();
  await choose("Retire");
  const dialog = await screen.findByRole("alertdialog", { name: "Retire this review?" });
  expect(dialog.textContent).toContain("moves to Done without an approval");
  expect(dialog.textContent).toContain("agent waiting on it stops");
  expect(document.activeElement).toBe(within(dialog).getByRole("button", { name: "Cancel" }));
  fireEvent.click(within(dialog).getByRole("button", { name: "Retire" }));
  await screen.findByText("Review retired");
  expect(sent()).toEqual([["POST", `${base}/retire`, "{}"]]);
});

test("retire with unsent comments discards them only through the explicit button", async () => {
  mount({ unsentCount: 2 });
  await choose("Retire");
  const dialog = await screen.findByRole("alertdialog", { name: "Retire this review?" });
  expect(within(dialog).queryByRole("button", { name: "Retire" })).toBeNull();
  fireEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));
  await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
  expect(fetchMock).not.toHaveBeenCalled();
  await choose("Retire");
  fireEvent.click(await screen.findByRole("button", { name: "Discard 2 unsent comments and retire" }));
  await screen.findByText("Review retired");
  expect(sent()).toEqual([["POST", `${base}/retire`, JSON.stringify({ discardUnsent: true })]]);
});

function ReviewWithCount() {
  const { data } = useQuery(reviewQuery(reviewId));
  return <ReviewActions reviewId={reviewId} lifecycle={lifecycle} unsentCount={data?.unsentCount ?? 0} phone={false} />;
}
function reviewView(unsentCount: number) {
  return {
    id: reviewId,
    title: "Synthetic review",
    origin: { id: "22222222-2222-4222-8222-222222222222", name: "Workshop" },
    repo: "c".repeat(64),
    branch: "main",
    state: "open",
    newestRevision: 1,
    unsentCount,
    openThreads: 0,
    agentWaiting: false,
    pendingSend: false,
    updatedAt: "2026-01-01T00:00:00.000Z",
    movedTo: null,
    list: "active",
    snoozed: false,
    snoozedUntil: null,
    activeUntil: null,
    releasedAt: null,
    pickedUpAt: null,
    kind: "review",
    importedAt: null,
    revisions: [{ seq: 1, createdAt: "2026-01-01T00:00:00.000Z" }],
  };
}

test("a 409 unsent_comments refetches the review, shows the alert and the discard button, and never discards by itself", async () => {
  const invalidate = vi.spyOn(client, "invalidateQueries");
  let serverCount = 0;
  let retires = 0;
  fetchMock.mockImplementation(async (path, init) => {
    if (init?.method === "POST") {
      retires++;
      return retires === 1
        ? Response.json(
            { error: { code: "unsent_comments", message: "The review has unsent comments." } },
            { status: 409 },
          )
        : new Response(null, { status: 204 });
    }
    return Response.json(reviewView(String(path).endsWith(reviewId) ? serverCount : 0));
  });
  render(<ReviewWithCount />, { wrapper });
  await waitFor(() => expect(fetchMock).toHaveBeenCalledOnce());
  await choose("Retire");
  const plain = await screen.findByRole("button", { name: "Retire" });
  // Two comments arrive on another device before the press.
  serverCount = 2;
  fireEvent.click(plain);
  // The refetch lands through the real invalidation.
  const discard = await screen.findByRole("button", { name: "Discard 2 unsent comments and retire" });
  expect(invalidate).toHaveBeenCalledWith({ queryKey: ["revision", reviewId] });
  expect(screen.getByRole("alert").textContent).toBe("2 new unsent comments arrived.");
  expect(screen.queryByText("The review has unsent comments.")).toBeNull();
  expect(retires).toBe(1);
  // The label changed a moment ago: this press must not count.
  fireEvent.click(discard);
  expect(retires).toBe(1);
  await new Promise((resolve) => setTimeout(resolve, 1100));
  fireEvent.click(discard);
  await screen.findByText("Review retired");
  expect(sent().filter(([method]) => method === "POST")).toHaveLength(2);
  expect(sent().findLast(([method]) => method === "POST")).toEqual([
    "POST",
    `${base}/retire`,
    JSON.stringify({ discardUnsent: true }),
  ]);
});

test("a 409 shows the alert even before the refetch lands", async () => {
  fetchMock.mockResolvedValueOnce(
    Response.json({ error: { code: "unsent_comments", message: "The review has unsent comments." } }, { status: 409 }),
  );
  mount();
  await choose("Retire");
  fireEvent.click(await screen.findByRole("button", { name: "Retire" }));
  expect((await screen.findByRole("alert")).textContent).toBe("New unsent comments arrived.");
  expect(screen.getByRole("button", { name: "Retire" })).toBeTruthy();
  expect(fetchMock).toHaveBeenCalledOnce();
});

test("a live change of the unsent count while the dialog is open guards the discard button for one second", async () => {
  const view = mount();
  await choose("Retire");
  await screen.findByRole("button", { name: "Retire" });
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  act(() => view.update({ unsentCount: 2 }));
  const discard = screen.getByRole("button", { name: "Discard 2 unsent comments and retire" });
  expect(screen.getByRole("alert").textContent).toBe("2 new unsent comments arrived.");
  expect(discard.getAttribute("aria-disabled")).toBe("true");
  fireEvent.click(discard);
  act(() => void vi.advanceTimersByTime(999));
  fireEvent.click(discard);
  expect(fetchMock).not.toHaveBeenCalled();
  // A further change restarts the guard.
  act(() => view.update({ unsentCount: 3 }));
  const again = screen.getByRole("button", { name: "Discard 3 unsent comments and retire" });
  act(() => void vi.advanceTimersByTime(999));
  fireEvent.click(again);
  expect(fetchMock).not.toHaveBeenCalled();
  act(() => void vi.advanceTimersByTime(2));
  expect(again.getAttribute("aria-disabled")).toBeNull();
  await act(async () => {
    fireEvent.click(again);
  });
  expect(sent()).toEqual([["POST", `${base}/retire`, JSON.stringify({ discardUnsent: true })]]);
});

test("a plain Retire sends no discardUnsent even after the count fell back to zero", async () => {
  const view = mount({ unsentCount: 2 });
  await choose("Retire");
  await screen.findByRole("button", { name: "Discard 2 unsent comments and retire" });
  view.update({ unsentCount: 0 });
  expect((await screen.findByRole("alert")).textContent).toBe("Some unsent comments were sent or deleted.");
  const plain = screen.getByRole("button", { name: "Retire" });
  await new Promise((resolve) => setTimeout(resolve, 1100));
  fireEvent.click(plain);
  await screen.findByText("Review retired");
  expect(sent()).toEqual([["POST", `${base}/retire`, "{}"]]);
});

test.each(["Snooze", "Retire", "Delete"])(
  "the %s dialog returns focus to the trigger and unlocks the page",
  async (item) => {
    mount();
    const trigger = screen.getByRole("button", { name: "More review actions" });
    for (const how of ["Cancel", "Escape"]) {
      await choose(item);
      const dialog = await screen.findByRole("alertdialog");
      if (how === "Cancel") fireEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));
      else fireEvent.keyDown(dialog, { key: "Escape" });
      await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
      await waitFor(() => expect(document.activeElement).toBe(trigger));
      expect(document.body.style.pointerEvents).toBe("");
      expect([...document.body.children].filter((node) => node.hasAttribute("data-aria-hidden"))).toEqual([]);
      expect([...document.body.children].filter((node) => node.getAttribute("aria-hidden") === "true")).toEqual([]);
    }
    expect(fetchMock).not.toHaveBeenCalled();
  },
);

function ReturningDialog({ returnTo }: { returnTo: HTMLElement }) {
  const [open, setOpen] = useState(true);
  return (
    <Dialog
      open={open}
      onOpenChange={setOpen}
      returnFocus={{ current: returnTo }}
      title="Title"
      description="Text"
      actions={<Button onClick={() => setOpen(false)}>Close</Button>}
    />
  );
}
test("a dialog whose opener is gone returns focus to the element it was given", async () => {
  const returnTo = document.createElement("button");
  document.body.append(returnTo);
  const gone = document.createElement("button");
  document.body.append(gone);
  gone.focus();
  render(<ReturningDialog returnTo={returnTo} />);
  gone.remove();
  fireEvent.click(await screen.findByRole("button", { name: "Close" }));
  await waitFor(() => expect(document.activeElement).toBe(returnTo));
  returnTo.remove();
});

test("the trigger keeps focus while an action runs and does not open the menu", async () => {
  let finish: (response: Response) => void = () => {};
  fetchMock.mockImplementation(() => new Promise<Response>((resolve) => (finish = resolve)));
  mount({ lifecycle: { snoozed: true, snoozedUntil: null } });
  await choose("Unsnooze");
  const trigger = screen.getByRole<HTMLButtonElement>("button", { name: "More review actions" });
  await waitFor(() => expect(trigger.getAttribute("aria-disabled")).toBe("true"));
  expect(trigger.disabled).toBe(false);
  trigger.focus();
  fireEvent.keyDown(trigger, { key: "ArrowDown" });
  expect(screen.queryByRole("menu")).toBeNull();
  expect(document.activeElement).toBe(trigger);
  // fireEvent returns false when the event was default-prevented.
  expect(fireEvent.keyDown(trigger, { key: "Tab" })).toBe(true);
  expect(fireEvent.keyDown(trigger, { key: "Enter" })).toBe(false);
  finish(new Response(null, { status: 204 }));
  await waitFor(() => expect(trigger.getAttribute("aria-disabled")).not.toBe("true"));
});

test("after the server moved the review to the bin a further press is a no-op", async () => {
  mount();
  await choose("Delete");
  fireEvent.click(await screen.findByRole("button", { name: "Move to bin" }));
  await waitFor(() => expect(lifecycle.onDeleted).toHaveBeenCalledOnce());
  // The dialog is closed at once, and the menu cannot open another one.
  await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
  await choose("Delete");
  await new Promise((resolve) => setTimeout(resolve, 50));
  expect(screen.queryByRole("alertdialog")).toBeNull();
  expect(sent().filter(([method, path]) => method === "POST" && String(path).endsWith("/bin"))).toHaveLength(1);
  expect(lifecycle.onDeleted).toHaveBeenCalledOnce();
});

test("delete asks first, names the title as text, then moves it to the bin, calls onDeleted and toasts", async () => {
  mount();
  await choose("Delete");
  const dialog = await screen.findByRole("alertdialog", { name: "Delete “Synthetic <b>review</b>”?" });
  expect(dialog.querySelector("b")).toBeNull();
  expect(dialog.textContent).toContain(
    "It moves to the bin in Settings, where you can restore it or delete it for good. It leaves the inbox, and an agent waiting on it stops.",
  );
  expect(document.activeElement).toBe(within(dialog).getByRole("button", { name: "Cancel" }));
  expect(fetchMock).not.toHaveBeenCalled();
  fireEvent.click(within(dialog).getByRole("button", { name: "Move to bin" }));
  await screen.findByText("Moved “Synthetic <b>review</b>” to the bin");
  expect(sent()).toEqual([["POST", `${base}/bin`, undefined]]);
  expect(lifecycle.onDeleted).toHaveBeenCalledOnce();
});

test("cancelling a delete sends nothing", async () => {
  mount();
  await choose("Delete");
  fireEvent.click(within(await screen.findByRole("alertdialog")).getByRole("button", { name: "Cancel" }));
  await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
  expect(fetchMock).not.toHaveBeenCalled();
  expect(lifecycle.onDeleted).not.toHaveBeenCalled();
});

test("a pending delete shows progress and cannot be pressed twice", async () => {
  let finish: (response: Response) => void = () => {};
  fetchMock.mockImplementation(() => new Promise<Response>((resolve) => (finish = resolve)));
  mount();
  await choose("Delete");
  const button = await screen.findByRole("button", { name: "Move to bin" });
  fireEvent.click(button);
  await waitFor(() => expect(button.getAttribute("aria-busy")).toBe("true"));
  fireEvent.click(button);
  expect(fetchMock).toHaveBeenCalledOnce();
  finish(new Response(null, { status: 204 }));
  await waitFor(() => expect(lifecycle.onDeleted).toHaveBeenCalledOnce());
});

test("a failed action shows the server's message in a toast and keeps the dialog", async () => {
  fetchMock.mockResolvedValueOnce(
    Response.json({ error: { code: "invalid_state", message: "The review is not open." } }, { status: 409 }),
  );
  mount();
  await choose("Retire");
  fireEvent.click(await screen.findByRole("button", { name: "Retire" }));
  await screen.findByText("The review is not open.");
  expect(screen.getByRole("alertdialog", { name: "Retire this review?" })).toBeTruthy();
});

test("on the phone the menu button is a 40px touch target with the same label", async () => {
  mount({ phone: true });
  const button = screen.getByRole<HTMLButtonElement>("button", { name: "More review actions" });
  expect(button.className).toContain("size-10");
  await choose("Snooze");
  expect(await screen.findByRole("alertdialog", { name: "Snooze this review" })).toBeTruthy();
});
