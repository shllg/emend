import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type { ComponentProps, ReactNode } from "react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { ToastProvider } from "../ui/Toast.tsx";
import { SendBar } from "./SendBar.tsx";

const reviewId = "11111111-1111-4111-8111-111111111111";
let client: QueryClient;
let fetchMock: ReturnType<typeof vi.fn<typeof fetch>>;

beforeEach(() => {
  localStorage.clear();
  client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  fetchMock = vi.fn<typeof fetch>().mockResolvedValue(new Response(null, { status: 201 }));
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => {
  cleanup();
  client.clear();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

function mount(props: Partial<ComponentProps<typeof SendBar>> = {}) {
  return render(<SendBar reviewId={reviewId} revision={3} newestRevision={3} unsentCount={0} {...props} />, {
    wrapper: ({ children }: { children: ReactNode }) => (
      <QueryClientProvider client={client}>
        <ToastProvider>{children}</ToastProvider>
      </QueryClientProvider>
    ),
  });
}
const trigger = () => screen.getByRole<HTMLButtonElement>("button", { name: "Approve revision 3" });
const dialog = () => screen.getByRole("alertdialog", { name: "Approve revision 3?" });
const confirm = () => within(dialog()).getByRole<HTMLButtonElement>("button", { name: "Approve" });
const closed = () => waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());

test("Approve opens a confirmation and sends nothing", () => {
  mount();
  fireEvent.click(trigger());
  expect(dialog().textContent).toContain(
    "The agent receives the approval, now if one is waiting and otherwise when it next picks up. The review moves to Done.",
  );
  expect(fetchMock).not.toHaveBeenCalled();
});

test.each([
  [null, "The review moves to Done."],
  ["22222222-2222-4222-8222-222222222222", "The review stays in its group."],
])("Approve describes the destination for group %s", (groupId, destination) => {
  mount({
    lifecycle: {
      title: "Synthetic review",
      groupId,
      pinned: false,
      state: "open",
      snoozed: false,
      snoozedUntil: null,
      onDeleted: vi.fn(),
    },
  });
  fireEvent.click(trigger());
  expect(
    within(dialog()).getByText(
      `The agent receives the approval, now if one is waiting and otherwise when it next picks up. ${destination}`,
    ),
  ).toBeTruthy();
  expect(fetchMock).not.toHaveBeenCalled();
});

test("the phone's Approve asks first as well", () => {
  mount({ phone: true });
  fireEvent.click(screen.getByRole("button", { name: "Approve" }));
  expect(dialog()).toBeTruthy();
  expect(fetchMock).not.toHaveBeenCalled();
});

test("with unsent comments Approve is unavailable, so the dialog never offers to drop them", () => {
  mount({ unsentCount: 2 });
  expect(trigger().disabled).toBe(true);
  fireEvent.click(trigger());
  expect(screen.queryByRole("alertdialog")).toBeNull();
  expect(fetchMock).not.toHaveBeenCalled();
});

test("focus starts on Cancel", () => {
  mount();
  fireEvent.click(trigger());
  expect(document.activeElement).toBe(within(dialog()).getByRole("button", { name: "Cancel" }));
});

test("Cancel sends nothing and returns focus to the Approve button", async () => {
  mount();
  trigger().focus();
  fireEvent.click(trigger());
  fireEvent.click(within(dialog()).getByRole("button", { name: "Cancel" }));
  await closed();
  await waitFor(() => expect(document.activeElement).toBe(trigger()));
  expect(fetchMock).not.toHaveBeenCalled();
});

test("Escape sends nothing", async () => {
  mount();
  fireEvent.click(trigger());
  fireEvent.keyDown(dialog(), { key: "Escape" });
  await closed();
  expect(fetchMock).not.toHaveBeenCalled();
});

test("a press outside the dialog sends nothing", async () => {
  mount();
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  fireEvent.click(trigger());
  // Radix listens for outside presses from the next tick on.
  await act(async () => {
    await vi.advanceTimersByTimeAsync(0);
  });
  vi.useRealTimers();
  const overlay = document.querySelector(".bg-overlay");
  if (!overlay) throw new Error("No overlay");
  fireEvent.pointerDown(overlay, { button: 0, pointerType: "mouse" });
  fireEvent.pointerUp(overlay, { button: 0, pointerType: "mouse" });
  fireEvent.click(overlay);
  await closed();
  expect(fetchMock).not.toHaveBeenCalled();
});

test("confirming sends one approval for the revision on screen and closes", async () => {
  mount();
  fireEvent.click(trigger());
  fireEvent.click(confirm());
  await screen.findByText("Approved revision 3");
  await closed();
  expect(fetchMock).toHaveBeenCalledExactlyOnceWith(`/api/v1/reviews/${reviewId}/sends`, {
    method: "POST",
    credentials: "same-origin",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ revision: 3, kind: "approve" }),
  });
});

test("a double click on the dialog's Approve sends one, and the button shows it is pending", async () => {
  const pending = Promise.withResolvers<Response>();
  fetchMock.mockReturnValueOnce(pending.promise);
  mount();
  fireEvent.click(trigger());
  const button = confirm();
  fireEvent.click(button);
  fireEvent.click(button);
  await waitFor(() => expect(button.getAttribute("aria-busy")).toBe("true"));
  expect(button.disabled).toBe(true);
  expect(fetchMock).toHaveBeenCalledOnce();
  await act(async () => pending.resolve(new Response(null, { status: 201 })));
  await closed();
  expect(fetchMock).toHaveBeenCalledOnce();
});

test("an error keeps the dialog open and shows the error in it", async () => {
  fetchMock.mockResolvedValueOnce(
    Response.json({ error: { code: "stale_revision", message: "Stale." } }, { status: 409 }),
  );
  mount();
  fireEvent.click(trigger());
  fireEvent.click(confirm());
  const alert = await within(dialog()).findByRole("alert");
  expect(alert.textContent).toBe("This page is out of date. Reload to see the newest revision.");
  expect(screen.getAllByRole("alert", { hidden: true })).toHaveLength(1);
  expect(confirm().disabled).toBe(false);
});

test("a newer revision arriving while the dialog is open closes it, sends nothing and shows the reason", async () => {
  const { rerender } = mount();
  fireEvent.click(trigger());
  expect(dialog()).toBeTruthy();
  rerender(<SendBar reviewId={reviewId} revision={3} newestRevision={4} unsentCount={0} />);
  await closed();
  expect(fetchMock).not.toHaveBeenCalled();
  expect(screen.getByText("Revision 4 is newer. Switch to it to send or approve.")).toBeTruthy();
});

test("unsent comments arriving while the dialog is open close it", async () => {
  const { rerender } = mount();
  fireEvent.click(trigger());
  rerender(<SendBar reviewId={reviewId} revision={3} newestRevision={3} unsentCount={1} />);
  await closed();
  expect(fetchMock).not.toHaveBeenCalled();
});

test("a double click on the Approve button opens one dialog and sends nothing", () => {
  mount();
  const button = trigger();
  act(() => {
    fireEvent.click(button);
    fireEvent.click(button);
  });
  expect(screen.getAllByRole("alertdialog")).toHaveLength(1);
  expect(fetchMock).not.toHaveBeenCalled();
});

test("an unsent_comments refusal keeps the dialog open and shows the error", async () => {
  fetchMock.mockResolvedValueOnce(
    Response.json({ error: { code: "unsent_comments", message: "Unsent comments remain." } }, { status: 409 }),
  );
  mount();
  fireEvent.click(trigger());
  fireEvent.click(confirm());
  const alert = await within(dialog()).findByRole("alert");
  expect(alert.textContent).toBe("Unsent comments remain.");
  expect(dialog()).toBeTruthy();
});
