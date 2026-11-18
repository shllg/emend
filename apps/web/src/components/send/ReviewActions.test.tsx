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
  groupId: null,
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
  ["open", false, ["Snooze", "Retire", "Move to group…", "Delete"]],
  ["open", true, ["Snooze again", "Unsnooze", "Retire", "Move to group…", "Delete"]],
  ["settled", false, ["Reopen", "Move to group…", "Delete"]],
  ["approved", false, ["Move to group…", "Delete"]],
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
    expect(dialog.textContent).toContain("It leaves your active list until then. A new revision wakes it early.");
    fireEvent.click(within(dialog).getByRole("button", { name }));
    await waitFor(() => expect(sent()).toEqual([["POST", `${base}/snooze`, JSON.stringify(body)]]));
    await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
    view.unmount();
  }
});

test("snoozing a grouped review says it stays in its group", async () => {
  mount({ lifecycle: { groupId: groupA.id } });
  await choose("Snooze");
  const dialog = await screen.findByRole("alertdialog", { name: "Snooze this review" });
  expect(dialog.textContent).toContain("It stays in its group, snoozed until then. A new revision wakes it early.");
  expect(dialog.textContent).not.toContain("It leaves your active list");
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
  expect(dialog.textContent).toContain("It moves to Done without an approval, and an agent waiting on it stops.");
  expect(document.activeElement).toBe(within(dialog).getByRole("button", { name: "Cancel" }));
  fireEvent.click(within(dialog).getByRole("button", { name: "Retire" }));
  await screen.findByText("Review retired");
  expect(sent()).toEqual([["POST", `${base}/retire`, "{}"]]);
});

test("retire with unsent comments discards them only through the explicit button", async () => {
  mount({ unsentCount: 2 });
  await choose("Retire");
  const dialog = await screen.findByRole("alertdialog", { name: "Retire this review?" });
  expect(dialog.textContent).toContain(
    "It moves to Done without an approval, and an agent waiting on it stops. Its 2 unsent comments will be deleted.",
  );
  expect(within(dialog).queryByRole("button", { name: "Retire" })).toBeNull();
  fireEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));
  await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
  expect(fetchMock).not.toHaveBeenCalled();
  await choose("Retire");
  fireEvent.click(await screen.findByRole("button", { name: "Discard 2 unsent comments and retire" }));
  await screen.findByText("Review retired");
  expect(sent()).toEqual([["POST", `${base}/retire`, JSON.stringify({ discardUnsent: true })]]);
});

test.each([
  [0, ""],
  [1, " Its 1 unsent comment will be deleted."],
  [2, " Its 2 unsent comments will be deleted."],
] as const)(
  "retiring a grouped review with %i unsent comments says it stays in its group",
  async (unsentCount, warning) => {
    mount({ lifecycle: { groupId: groupA.id }, unsentCount });
    await choose("Retire");
    const dialog = await screen.findByRole("alertdialog", { name: "Retire this review?" });
    expect(
      within(dialog).getByText(
        `It stays in its group, closed without an approval, and an agent waiting on it stops.${warning}`,
      ),
    ).toBeTruthy();
    expect(dialog.textContent).not.toContain("It moves to Done");
  },
);

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
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  await act(async () => {
    fireEvent.click(plain);
  });
  // Commit the 200 ms query-refresh batch and its notifications before checking the changed label.
  await act(async () => {
    await vi.advanceTimersByTimeAsync(200);
  });
  // The refetch lands through the real invalidation.
  const discard = screen.getByRole("button", { name: "Discard 2 unsent comments and retire" });
  expect(invalidate).toHaveBeenCalledWith({ queryKey: ["revision", reviewId] });
  expect(screen.getByRole("alert").textContent).toBe("2 new unsent comments arrived.");
  expect(screen.queryByText("The review has unsent comments.")).toBeNull();
  expect(retires).toBe(1);
  // The label changed a moment ago: this press must not count.
  fireEvent.click(discard);
  expect(retires).toBe(1);
  // ReviewActions' DISCARD_GUARD_MS is 1000 ms from the label change.
  await act(async () => {
    await vi.advanceTimersByTimeAsync(1001);
  });
  expect(retires).toBe(1);
  vi.useRealTimers();
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
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  view.update({ unsentCount: 0 });
  expect(screen.getByRole("alert").textContent).toBe("Some unsent comments were sent or deleted.");
  const plain = screen.getByRole("button", { name: "Retire" });
  // Pass DISCARD_GUARD_MS after the label returns to plain Retire.
  await act(async () => {
    await vi.advanceTimersByTimeAsync(1001);
  });
  vi.useRealTimers();
  fireEvent.click(plain);
  await screen.findByText("Review retired");
  expect(sent()).toEqual([["POST", `${base}/retire`, "{}"]]);
});

test.each(["Snooze", "Retire", "Move to group…", "Delete"])(
  "the %s dialog returns focus to the trigger and unlocks the page",
  async (item) => {
    if (item === "Move to group…") groupResponses();
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
    expect(fetchMock.mock.calls.filter(([, init]) => init?.method)).toEqual([]);
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
  openMenu();
  const remove = await screen.findByRole("menuitem", { name: "Delete" });
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  fireEvent.click(remove);
  // Drain the menu's deferred focus restoration and any work the press scheduled.
  await act(async () => {
    await vi.runAllTimersAsync();
  });
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

test("on the phone the menu button keeps its width while its height follows density", async () => {
  mount({ phone: true });
  const button = screen.getByRole<HTMLButtonElement>("button", { name: "More review actions" });
  expect(button.className).toContain("h-10");
  expect(button.className).toContain("w-[2.5rem]");
  await choose("Snooze");
  expect(await screen.findByRole("alertdialog", { name: "Snooze this review" })).toBeTruthy();
});

const groupA = { id: "22222222-2222-4222-8222-222222222222", name: "Alpha" };
const groupB = { id: "33333333-3333-4333-8333-333333333333", name: "Beta" };
function groupResponses(initial = [groupB, groupA]) {
  let groups = initial;
  fetchMock.mockImplementation(async (path, init) => {
    if (path === "/api/v1/reviews")
      return Response.json({
        items: [],
        groups: groups.map((group) => ({ ...group, members: 0 })),
        approvedActiveHours: 12,
        approvedActiveLimit: 5,
        serverTime: "2026-11-04T12:00:00.000Z",
      });
    if (path === "/api/v1/groups" && init?.method === "POST") {
      const created = { id: "44444444-4444-4444-8444-444444444444", name: JSON.parse(String(init.body)).name.trim() };
      groups = [...groups, created];
      return Response.json(created, { status: 201 });
    }
    return new Response(null, { status: 204 });
  });
}
const groupWrites = () => sent().filter(([method]) => method === "POST" || method === "PUT");

test.each([lifecycle.title, "Synthetic \u202ereview"])("move dialog isolates the review title: %s", async (title) => {
  groupResponses();
  mount({ lifecycle: { title } });
  await choose("Move to group…");
  const dialog = await screen.findByRole("alertdialog");
  const heading = within(dialog).getByRole("heading");
  expect(heading.querySelector("bdi")?.textContent).toBe(title);
  expect(heading.textContent).toBe(`Move “${title}” to a group`);
  expect(heading.querySelector("b")).toBeNull();
});

test("move dialog sorts groups, marks the current group, moves and invalidates its review and inbox", async () => {
  groupResponses();
  const invalidate = vi.spyOn(client, "invalidateQueries");
  mount({ lifecycle: { groupId: groupA.id } });
  await choose("Move to group…");
  const dialog = await screen.findByRole("alertdialog");
  expect(within(dialog).getByRole("heading").textContent).toBe(`Move “${lifecycle.title}” to a group`);
  const current = await within(dialog).findByRole<HTMLButtonElement>("button", { name: "Alpha Current" });
  expect(current.disabled).toBe(true);
  expect(
    within(dialog)
      .getAllByRole("button")
      .slice(0, 2)
      .map((button) => button.textContent),
  ).toEqual(["AlphaCurrent", "Beta"]);
  expect(dialog.textContent).toContain("It stays in the group until you move it out. New revisions keep it there.");
  fireEvent.click(within(dialog).getByRole("button", { name: "Beta" }));
  await screen.findByText("Moved to “Beta”");
  expect(groupWrites()).toEqual([["PUT", `${base}/group`, JSON.stringify({ groupId: groupB.id })]]);
  expect(invalidate.mock.calls.map(([options]) => options?.queryKey)).toEqual([["inbox"], ["review", reviewId]]);
  await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
  expect(document.activeElement).toBe(screen.getByRole("button", { name: "More review actions" }));
});

test("remove from group sends null and names the previous group", async () => {
  groupResponses();
  mount({ lifecycle: { groupId: groupA.id }, phone: true });
  await choose("Move to group…");
  await screen.findByRole("button", { name: "Alpha Current" });
  fireEvent.click(screen.getByRole("button", { name: "Remove from group" }));
  await screen.findByText("Removed from “Alpha”");
  expect(groupWrites()).toEqual([["PUT", `${base}/group`, '{"groupId":null}']]);
});

test("create and move submits a name, then the returned id; whitespace cannot submit", async () => {
  groupResponses();
  mount();
  await choose("Move to group…");
  const field = await screen.findByRole<HTMLInputElement>("textbox", { name: "New group" });
  expect(field.maxLength).toBe(80);
  const create = screen.getByRole<HTMLButtonElement>("button", { name: "Create and move" });
  expect(create.disabled).toBe(true);
  fireEvent.change(field, { target: { value: "  " } });
  expect(create.disabled).toBe(true);
  fireEvent.submit(field.closest("form") as HTMLFormElement);
  expect(groupWrites()).toEqual([]);
  fireEvent.change(field, { target: { value: " New project " } });
  fireEvent.submit(field.closest("form") as HTMLFormElement);
  await screen.findByText("Moved to “New project”");
  expect(groupWrites()).toEqual([
    ["POST", "/api/v1/groups", JSON.stringify({ name: " New project " })],
    ["PUT", `${base}/group`, JSON.stringify({ groupId: "44444444-4444-4444-8444-444444444444" })],
  ]);
});

test("at the group limit the dialog keeps move choices and hides creation", async () => {
  groupResponses(
    Array.from({ length: 50 }, (_, i) => ({
      id: `55555555-5555-4555-8555-${String(i).padStart(12, "0")}`,
      name: `Group ${i}`,
    })),
  );
  mount();
  await choose("Move to group…");
  await screen.findByText("You have the most groups allowed.");
  expect(screen.queryByRole("textbox", { name: "New group" })).toBeNull();
  expect(screen.queryByRole("button", { name: "Create and move" })).toBeNull();
  expect(screen.getByRole("button", { name: "Group 0" })).toBeTruthy();
});

test("group failures show the server message and do not start a move after a failed create", async () => {
  groupResponses();
  mount();
  await choose("Move to group…");
  const field = await screen.findByRole("textbox", { name: "New group" });
  fetchMock.mockResolvedValueOnce(
    Response.json({ error: { code: "invalid_state", message: "A group with this name exists." } }, { status: 409 }),
  );
  fireEvent.change(field, { target: { value: "Alpha" } });
  fireEvent.click(screen.getByRole("button", { name: "Create and move" }));
  await screen.findByText("A group with this name exists.");
  expect(groupWrites()).toEqual([["POST", "/api/v1/groups", '{"name":"Alpha"}']]);
  expect(screen.getByRole("alertdialog")).toBeTruthy();
});

test("pending moves block duplicate submissions and cancellation, including after unmount", async () => {
  groupResponses();
  const { unmount } = mount();
  await choose("Move to group…");
  const target = await screen.findByRole("button", { name: "Alpha" });
  const response = Promise.withResolvers<Response>();
  fetchMock.mockImplementationOnce(() => response.promise);
  fireEvent.click(target);
  fireEvent.click(target);
  fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
  expect(screen.getByRole("alertdialog")).toBeTruthy();
  await waitFor(() => expect(groupWrites()).toHaveLength(1));
  unmount();
  await act(async () => response.resolve(new Response(null, { status: 204 })));
  expect(groupWrites()).toHaveLength(1);
});

test.each(["<img src=x onerror=alert(1)>", "مشروع"])("move choices render group name as text: %s", async (name) => {
  groupResponses([{ ...groupA, name }]);
  mount();
  await choose("Move to group…");
  const choice = await screen.findByRole("button", { name });
  expect(within(choice).getByText(name).getAttribute("dir")).toBe("auto");
  expect(screen.getByRole("alertdialog").querySelector("img")).toBeNull();
});

test("move choices truncate long names, keep Current visible and wrap the dialog title", async () => {
  const name = "x".repeat(80);
  groupResponses([{ ...groupA, name }]);
  mount({ lifecycle: { groupId: groupA.id, title: name }, phone: true });
  await choose("Move to group…");
  const choice = await screen.findByRole("button", { name: `${name} Current` });
  const label = within(choice).getByText(name);
  expect(label.classList.contains("min-w-0")).toBe(true);
  expect(label.classList.contains("truncate")).toBe(true);
  expect(label.getAttribute("title")).toBe(name);
  expect(within(choice).getByText("Current").classList.contains("shrink-0")).toBe(true);
  const heading = screen.getByRole("heading");
  expect(heading.textContent).toBe(`Move “${name}” to a group`);
  expect(heading.classList.contains("[overflow-wrap:anywhere]")).toBe(true);
});
