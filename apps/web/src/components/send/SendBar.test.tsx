import { LIMITS, MODE_LABELS } from "@emend/contract";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { type ComponentProps, type ReactNode, StrictMode } from "react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { ToastProvider } from "../ui/Toast.tsx";
import { SendBar } from "./SendBar.tsx";

const reviewId = "11111111-1111-4111-8111-111111111111";
let client: QueryClient;
let fetchMock: ReturnType<typeof vi.fn<typeof fetch>>;
beforeEach(() => {
  localStorage.clear();
  window.dispatchEvent(new StorageEvent("storage", { key: null }));
  client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  fetchMock = vi.fn<typeof fetch>().mockResolvedValue(new Response(null, { status: 201 }));
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => {
  cleanup();
  client.clear();
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
function button(name: string | RegExp) {
  return screen.getByRole<HTMLButtonElement>("button", { name });
}
function description(node: HTMLElement) {
  return node
    .getAttribute("aria-describedby")
    ?.split(" ")
    .map((id) => document.getElementById(id)?.textContent)
    .join(" ");
}
/** The text of the window after a Send, while an agent has not picked up. */
const sentText = /No agent has picked this up yet|Waiting for the agent to pick this up/;
/** Waits for the window after a Send and closes it, so the page behind it is reachable again. */
async function closeSent() {
  await screen.findByText(sentText);
  fireEvent.click(button("Close"));
  await waitFor(() => expect(screen.queryByText(sentText)).toBeNull());
}
/** Presses the dialog's Approve, which the bar's Approve opens. */
function confirmApproval() {
  fireEvent.click(within(screen.getByRole("alertdialog")).getByRole("button", { name: "Approve" }));
}
/** Approving asks first: the bar's Approve opens the dialog, and its Approve sends. */
function approve(name: string | RegExp) {
  fireEvent.click(button(name));
  confirmApproval();
}
function input() {
  return screen.getByRole<HTMLInputElement | HTMLTextAreaElement>("textbox", { name: "Instructions" });
}
function expectSend(body: object) {
  expect(fetchMock).toHaveBeenCalledExactlyOnceWith(`/api/v1/reviews/${reviewId}/sends`, {
    method: "POST",
    credentials: "same-origin",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

test.each([0, 1, 2, 3])("desktop count %s, Send eligibility and visible approval reason", (unsentCount) => {
  mount({ unsentCount });
  const bar = within(screen.getByRole("region", { name: "Send and approve" }));
  expect(
    bar.getByText(
      unsentCount ? `${unsentCount} unsent ${unsentCount === 1 ? "comment" : "comments"}` : "No unsent comments",
    ),
  ).toBeTruthy();
  expect(button("Send").disabled).toBe(unsentCount === 0);
  if (unsentCount) {
    const count = bar.getByText(`${unsentCount} to send`);
    expect(count.nextElementSibling).toBe(button("Send"));
    expect(description(button("Send"))).toContain(`${unsentCount} to send`);
  } else expect(bar.queryByText(/\d+ to send/)).toBeNull();
  expect(button("Approve revision 3").disabled).toBe(unsentCount > 0);
  if (unsentCount) {
    expect(bar.getByText(String(unsentCount)).getAttribute("aria-hidden")).toBe("true");
    expect(description(button("Approve revision 3"))).toBe("Send or delete before approving");
  } else expect(description(button("Send"))).toBe("Write a comment or an instruction first.");
  if (unsentCount) {
    fireEvent.click(button("Approve revision 3"));
    expect(fetchMock).not.toHaveBeenCalled();
  }
});

test("blank instructions do not enable Send and Ctrl+Enter posts the selected mode and untrimmed instruction", async () => {
  mount();
  const instructions = input();
  expect(instructions.tagName).toBe("TEXTAREA");
  expect(instructions.getAttribute("rows")).toBe("1");
  expect(instructions.getAttribute("enterkeyhint")).toBe("enter");
  expect(instructions.getAttribute("placeholder")).toBe("Instructions for the agent (optional)");
  expect(instructions.maxLength).toBe(LIMITS.instructionChars);
  fireEvent.change(instructions, { target: { value: "  " } });
  expect(button("Send").disabled).toBe(true);
  fireEvent.submit(instructions.closest("form") as HTMLFormElement);
  expect(fetchMock).not.toHaveBeenCalled();
  fireEvent.change(instructions, { target: { value: "  Explain the boundary  " } });
  expect(button("Send").disabled).toBe(false);
  const mode = screen.getByRole("combobox", { name: "Mode" });
  expect(
    within(mode)
      .getAllByRole("option")
      .map((option) => option.textContent),
  ).toEqual(Object.values(MODE_LABELS));
  fireEvent.change(mode, { target: { value: "explain" } });
  fireEvent.keyDown(instructions, { key: "Enter", ctrlKey: true, isComposing: true });
  expect(fetchMock).not.toHaveBeenCalled();
  fireEvent.keyDown(instructions, { key: "Enter", ctrlKey: true });
  await closeSent();
  expectSend({ revision: 3, kind: "go", mode: "explain", instruction: "  Explain the boundary  " });
  expect(instructions.value).toBe("");
  expect(button("Send").disabled).toBe(true);
  expect(screen.queryByRole("alert")).toBeNull();
});

test.each([1, 2])("desktop sends %s comments with the exact existing body and a success toast", async (unsentCount) => {
  mount({ unsentCount });
  fireEvent.click(button("Send"));
  await closeSent();
  expectSend({ revision: 3, kind: "go", mode: "fix-clear", instruction: "" });
});

test.each([false, true])(
  "approval uses only revision and kind; approved state is disabled (phone %s)",
  async (phone) => {
    const { rerender } = mount({ phone });
    approve(phone ? "Approve" : "Approve revision 3");
    await screen.findByText("Approved revision 3");
    expectSend({ revision: 3, kind: "approve" });
    rerender(<SendBar reviewId={reviewId} revision={3} newestRevision={3} unsentCount={0} approved phone={phone} />);
    expect(button("Approved").disabled).toBe(true);
    fireEvent.click(button("Approved"));
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(screen.queryByText("Send or delete before approving")).toBeNull();
  },
);

test.each([false, true])(
  "loading and failed revisions disable both actions with visible descriptions (phone %s)",
  (phone) => {
    const { rerender } = mount({ phone, revision: undefined, unsentCount: 1 });
    for (const name of [/^Send/, /^Approve/]) {
      expect(button(name).disabled).toBe(true);
      expect(description(button(name))).toContain("Loading revision…");
      fireEvent.click(button(name));
    }
    expect(screen.getByText("Loading revision…").getAttribute("role")).toBe("status");
    rerender(
      <SendBar
        reviewId={reviewId}
        revision={undefined}
        newestRevision={3}
        revisionError
        unsentCount={1}
        phone={phone}
      />,
    );
    expect(screen.getByRole("alert").textContent).toBe("Could not load this revision.");
    for (const name of [/^Send/, /^Approve/]) {
      expect(button(name).disabled).toBe(true);
      expect(description(button(name))).toContain("Could not load this revision.");
    }
    expect(fetchMock).not.toHaveBeenCalled();
  },
);

test.each([false, true])("pending Send disables repeat requests and both actions (phone %s)", async (phone) => {
  const pending = Promise.withResolvers<Response>();
  fetchMock.mockReturnValue(pending.promise);
  mount({ phone, unsentCount: 1 });
  const opener = button("Send");
  const approve = button(phone ? "Approve" : "Approve revision 3");
  fireEvent.click(opener);
  if (phone) fireEvent.click(button("Send 1 comment on revision 3"));
  const send = phone ? button("Send 1 comment on revision 3") : opener;
  await waitFor(() => expect(send.disabled).toBe(true));
  expect(send.getAttribute("aria-busy")).toBe("true");
  expect(approve.disabled).toBe(true);
  expect(input().disabled).toBe(true);
  fireEvent.click(send);
  fireEvent.submit(input().closest("form") as HTMLFormElement);
  expect(fetchMock).toHaveBeenCalledOnce();
  await act(async () => pending.resolve(new Response(null, { status: 201 })));
  await closeSent();
});

test.each([false, true])(
  "stale revision failures stay inline, retain instructions and do not show a success toast (phone %s)",
  async (phone) => {
    fetchMock.mockResolvedValue(
      Response.json({ error: { code: "stale_revision", message: "Old revision" } }, { status: 409 }),
    );
    mount({ phone });
    if (phone) fireEvent.click(button("Send"));
    fireEvent.change(input(), { target: { value: "Keep this instruction" } });
    fireEvent.click(button(phone ? "Send instructions on revision 3" : "Send"));
    expect((await screen.findByRole("alert")).textContent).toBe(
      "This page is out of date. Reload to see the newest revision.",
    );
    expect(input().value).toBe("Keep this instruction");
    expect(screen.queryByText(sentText)).toBeNull();
    if (phone) expect(screen.getByRole("dialog", { name: "Send feedback" })).toBeTruthy();
  },
);

test("network failure is inline, never just a toast", async () => {
  fetchMock.mockRejectedValue(new Error("Synthetic failure"));
  mount();
  approve("Approve revision 3");
  expect((await screen.findByRole("alert")).textContent).toBe("The request failed. Try again.");
  expect(screen.queryByText("Approved revision 3")).toBeNull();
});

test.each([0, 1, 2])(
  "phone compact bar and sheet send %s comments or instructions, then close",
  async (unsentCount) => {
    mount({ phone: true, unsentCount });
    const bar = within(screen.getByRole("region", { name: "Send and approve" }));
    expect(bar.getByText(unsentCount ? "to send" : "Nothing to send")).toBeTruthy();
    expect(bar.getByText("Revision 3")).toBeTruthy();
    expect(screen.queryByRole("textbox")).toBeNull();
    if (unsentCount) {
      expect(bar.getByText(String(unsentCount)).hasAttribute("aria-hidden")).toBe(false);
      expect(button("Approve").disabled).toBe(true);
      expect(description(button("Approve"))).toBe("Send or delete before approving");
    }
    expect(button("Send").disabled).toBe(false);
    fireEvent.click(button("Send"));
    const sheet = within(screen.getByRole("dialog", { name: "Send feedback" }));
    expect(sheet.getByRole("group", { name: "Mode" })).toBeTruthy();
    expect(sheet.getAllByRole("radio").map((radio) => (radio as HTMLInputElement).value)).toEqual([
      "fix-clear",
      "explain",
      "fix-all",
    ]);
    expect((sheet.getByRole("radio", { name: MODE_LABELS["fix-clear"] }) as HTMLInputElement).checked).toBe(true);
    fireEvent.click(sheet.getByRole("radio", { name: MODE_LABELS["fix-all"] }));
    expect(input().tagName).toBe("TEXTAREA");
    expect(input().getAttribute("placeholder")).toBe("Optional. Applies to every comment in this Send.");
    expect(sheet.getByText(`0 / ${LIMITS.instructionChars}`)).toBeTruthy();
    const send = button(
      unsentCount
        ? `Send ${unsentCount} ${unsentCount === 1 ? "comment" : "comments"} on revision 3`
        : "Send instructions on revision 3",
    );
    expect(send.disabled).toBe(unsentCount === 0);
    if (!unsentCount) {
      expect(description(send)).toBe("Write a comment or an instruction first.");
      fireEvent.change(input(), { target: { value: "   " } });
      expect(send.disabled).toBe(true);
      fireEvent.change(input(), { target: { value: "Explain" } });
      expect(send.disabled).toBe(false);
      expect(sheet.getByText(`7 / ${LIMITS.instructionChars}`)).toBeTruthy();
    }
    fireEvent.click(send);
    await screen.findByText(sentText);
    expect(screen.queryByRole("dialog", { name: "Send feedback" })).toBeNull();
    expect(screen.getByRole("dialog", { name: "Sent" })).toBeTruthy();
    expectSend({ revision: 3, kind: "go", mode: "fix-all", instruction: unsentCount ? "" : "Explain" });
    await closeSent();
    fireEvent.click(button("Send"));
    expect(input().value).toBe("");
  },
);

test("phone soft limit keeps excess text and disables Send with a visible linked reason", async () => {
  const { rerender } = mount({ phone: true, unsentCount: 1 });
  fireEvent.click(button("Send"));
  const excess = "x".repeat(LIMITS.instructionChars + 1);
  fireEvent.change(input(), { target: { value: excess } });
  const send = button("Send 1 comment on revision 3");
  expect(input().value).toBe(excess);
  expect(input().hasAttribute("maxlength")).toBe(false);
  expect(input().getAttribute("aria-invalid")).toBe("true");
  expect(screen.getByText(`${LIMITS.instructionChars + 1} / ${LIMITS.instructionChars}`)).toBeTruthy();
  expect(send.disabled).toBe(true);
  expect(description(send)).toBe(`Shorten the instructions to ${LIMITS.instructionChars} characters.`);
  fireEvent.submit(input().closest("form") as HTMLFormElement);
  expect(fetchMock).not.toHaveBeenCalled();
  // An over-limit phone draft must remain blocked after a resize to desktop.
  rerender(<SendBar reviewId={reviewId} revision={3} newestRevision={3} unsentCount={1} />);
  expect(button("Send").disabled).toBe(true);
  expect(description(button("Send"))).toBe(
    `Shorten the instructions to ${LIMITS.instructionChars} characters. 1 to send`,
  );
  fireEvent.change(input(), { target: { value: "x".repeat(LIMITS.instructionChars) } });
  expect(button("Send").disabled).toBe(false);
});

test("Safari's IME confirmation Enter with keyCode 229 does not Send", async () => {
  mount({ unsentCount: 1 });
  const instructions = input();
  fireEvent.compositionStart(instructions);
  fireEvent.change(instructions, { target: { value: "変換" } });
  fireEvent.keyDown(instructions, { key: "Enter", ctrlKey: true, isComposing: false, keyCode: 229 });
  fireEvent.compositionEnd(instructions);
  fireEvent.keyUp(instructions, { key: "Enter", keyCode: 229 });
  await act(async () => {});
  expect(fetchMock).not.toHaveBeenCalled();
  expect(instructions.value).toBe("変換");
});

test("Enter on a phone mode radio prevents implicit form submission", async () => {
  mount({ phone: true, unsentCount: 1 });
  fireEvent.click(button("Send"));
  const radio = screen.getByRole("radio", { name: MODE_LABELS["fix-all"] });
  act(() => radio.focus());
  const event = new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true });
  fireEvent(radio, event);
  expect(event.defaultPrevented).toBe(true);
  await act(async () => {});
  expect(fetchMock).not.toHaveBeenCalled();
  expect(screen.getByRole("dialog", { name: "Send feedback" })).toBeTruthy();
});

test.each([
  { phone: false, action: "Send" },
  { phone: false, action: "Approve" },
  { phone: false, action: "Enter" },
  { phone: true, action: "Send" },
  { phone: true, action: "Approve" },
])("two immediate $action activations make one POST, then unlock (phone $phone)", async ({ phone, action }) => {
  const pending = Promise.withResolvers<Response>();
  fetchMock.mockReturnValueOnce(pending.promise);
  const unsentCount = action === "Approve" ? 0 : 1;
  mount({ phone, unsentCount });
  if (phone && action === "Send") fireEvent.click(button("Send"));
  const activate =
    action === "Enter"
      ? () => fireEvent.keyDown(input(), { key: "Enter", ctrlKey: true })
      : action === "Approve"
        ? () => approve(/^Approve/)
        : () => fireEvent.click(button(phone ? "Send 1 comment on revision 3" : "Send"));
  if (action === "Approve") {
    // The dialog's Approve is the one pressed twice.
    fireEvent.click(button(/^Approve/));
    const confirm = within(screen.getByRole("alertdialog")).getByRole("button", { name: "Approve" });
    act(() => {
      fireEvent.click(confirm);
      fireEvent.click(confirm);
    });
  } else
    act(() => {
      activate();
      activate();
    });
  await waitFor(() => expect(fetchMock).toHaveBeenCalledOnce());
  await act(async () => pending.resolve(new Response(null, { status: 201 })));
  if (action === "Approve") await screen.findByText("Approved revision 3");
  else await closeSent();
  if (phone && action === "Send") fireEvent.click(button("Send"));
  activate();
  await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
});

test("a multiline phone draft survives desktop editing and Shift+Enter, and posts its newlines", async () => {
  const { rerender } = mount({ phone: true });
  fireEvent.click(button("Send"));
  fireEvent.change(input(), { target: { value: "First line\nSecond line" } });
  rerender(<SendBar reviewId={reviewId} revision={3} newestRevision={3} unsentCount={0} />);
  expect(input().value).toBe("First line\nSecond line");
  expect(input().tagName).toBe("TEXTAREA");
  expect(fireEvent.keyDown(input(), { key: "Enter", shiftKey: true })).toBe(true);
  expect(fetchMock).not.toHaveBeenCalled();
  fireEvent.change(input(), { target: { value: "First line\nSecond line\nThird line" } });
  fireEvent.keyDown(input(), { key: "Enter", ctrlKey: true });
  await closeSent();
  expectSend({ revision: 3, kind: "go", mode: "fix-clear", instruction: "First line\nSecond line\nThird line" });
});

test("a 4100-character phone draft is retained through desktop edits while Send remains blocked", () => {
  const { rerender } = mount({ phone: true });
  fireEvent.click(button("Send"));
  const draft = "x".repeat(4100);
  fireEvent.change(input(), { target: { value: draft } });
  rerender(<SendBar reviewId={reviewId} revision={3} newestRevision={3} unsentCount={0} />);
  expect(input().value).toBe(draft);
  expect(input().maxLength).toBe(LIMITS.instructionChars);
  expect(button("Send").disabled).toBe(true);
  expect(description(button("Send"))).toBe("Shorten the instructions to 4000 characters.");
  fireEvent.change(input(), { target: { value: draft.slice(1) } });
  expect(input().value).toHaveLength(4099);
  expect(button("Send").disabled).toBe(true);
  fireEvent.keyDown(input(), { key: "Enter", ctrlKey: true });
  expect(fetchMock).not.toHaveBeenCalled();
});

test.each([false, true])(
  "older revision blocks Send and Approve until the latest is loaded (phone %s)",
  async (phone) => {
    const { rerender } = mount({ revision: 1, newestRevision: 2 });
    fireEvent.change(input(), { target: { value: "Keep the instruction" } });
    rerender(<SendBar reviewId={reviewId} revision={1} newestRevision={2} unsentCount={0} phone={phone} />);
    const reason = "Revision 2 is newer. Switch to it to send or approve.";
    for (const name of [/^Send$/, /^Approve/]) {
      const action = button(name);
      expect(action.disabled).toBe(true);
      expect(description(action)).toBe(reason);
      fireEvent.click(action);
    }
    expect(screen.getByText(reason)).toBeTruthy();
    expect(fetchMock).not.toHaveBeenCalled();
    rerender(<SendBar reviewId={reviewId} revision={2} newestRevision={2} unsentCount={0} phone={phone} />);
    expect(button("Send").disabled).toBe(false);
    expect(button(/^Approve/).disabled).toBe(false);
    fireEvent.click(button("Send"));
    if (phone) fireEvent.click(button("Send instructions on revision 2"));
    await closeSent();
    expectSend({ revision: 2, kind: "go", mode: "fix-clear", instruction: "Keep the instruction" });
    approve(/^Approve/);
    await screen.findByText("Approved revision 2");
    expect(fetchMock).toHaveBeenLastCalledWith(
      `/api/v1/reviews/${reviewId}/sends`,
      expect.objectContaining({ body: JSON.stringify({ revision: 2, kind: "approve" }) }),
    );
  },
);

test("a newer revision arriving while the phone sheet is open blocks its footer with the reason", () => {
  const { rerender } = mount({ phone: true, revision: 1, newestRevision: 1, unsentCount: 1 });
  fireEvent.click(button("Send"));
  rerender(<SendBar reviewId={reviewId} revision={1} newestRevision={2} unsentCount={1} phone />);
  const send = button("Send 1 comment on revision 1");
  expect(send.disabled).toBe(true);
  expect(description(send)).toBe("Revision 2 is newer. Switch to it to send or approve.");
  expect(screen.getAllByText("Revision 2 is newer. Switch to it to send or approve.")).toHaveLength(1);
  fireEvent.click(send);
  expect(fetchMock).not.toHaveBeenCalled();
});

test("desktop reasons share the revision status line and never add an idle row", () => {
  const { rerender } = mount();
  const bar = screen.getByRole("region", { name: "Send and approve" });
  const reason = screen.getByText("Write a comment or an instruction first.");
  expect(reason.parentElement?.textContent).toBe("Revision 3 · Write a comment or an instruction first.");
  expect(bar.children).toHaveLength(1);
  rerender(<SendBar reviewId={reviewId} revision={1} newestRevision={2} unsentCount={1} />);
  fireEvent.change(input(), { target: { value: "x".repeat(4100) } });
  const approval = screen.getByText("Send or delete before approving");
  const tooLong = screen.getByText("Shorten the instructions to 4000 characters.");
  const older = screen.getByText("Revision 2 is newer. Switch to it to send or approve.");
  expect(approval.parentElement).toBe(tooLong.parentElement);
  expect(older.parentElement).toBe(tooLong.parentElement);
  expect(older.parentElement?.textContent).toBe(
    "Revision 1 · Send or delete before approving · Shorten the instructions to 4000 characters. · Revision 2 is newer. Switch to it to send or approve.",
  );
  expect(new Set([approval.id, tooLong.id, older.id]).size).toBe(3);
  expect(description(button("Send"))).toBe(`${tooLong.textContent} ${older.textContent} 1 to send`);
  expect(description(button("Approve revision 1"))).toBe(`${approval.textContent} ${older.textContent}`);
  expect(bar.children).toHaveLength(1);
});

test("phone revision loading/error messages have one copy while its sheet is open", () => {
  const { rerender } = mount({ phone: true, unsentCount: 1 });
  fireEvent.click(button("Send"));
  rerender(<SendBar reviewId={reviewId} revision={undefined} newestRevision={3} unsentCount={1} phone />);
  expect(screen.getAllByText("Loading revision…")).toHaveLength(1);
  expect(description(button("Send 1 comment on revision …"))).toBe("Loading revision…");
  rerender(<SendBar reviewId={reviewId} revision={undefined} newestRevision={3} revisionError unsentCount={1} phone />);
  expect(screen.getAllByRole("alert", { hidden: true })).toHaveLength(1);
  expect(description(button("Send 1 comment on revision …"))).toBe("Could not load this revision.");
});

test.each([
  { phone: false, change: "instruction" },
  { phone: false, change: "mode" },
  { phone: true, change: "instruction" },
  { phone: true, change: "mode" },
  { phone: true, change: "reopen" },
])("$change clears a failed Send's error (phone $phone)", async ({ phone, change }) => {
  fetchMock.mockRejectedValue(new Error("Synthetic failure"));
  mount({ phone, unsentCount: 1 });
  if (phone) fireEvent.click(button("Send"));
  fireEvent.change(input(), { target: { value: "Retain this instruction" } });
  fireEvent.click(button(phone ? "Send 1 comment on revision 3" : "Send"));
  await screen.findByRole("alert");
  expect(screen.getAllByRole("alert", { hidden: true })).toHaveLength(1);
  if (change === "instruction") fireEvent.change(input(), { target: { value: "Edited instruction" } });
  else if (change === "mode") {
    if (phone) fireEvent.click(screen.getByRole("radio", { name: MODE_LABELS.explain }));
    else fireEvent.change(screen.getByRole("combobox", { name: "Mode" }), { target: { value: "explain" } });
  } else {
    fireEvent.click(button("Close"));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(screen.getAllByRole("alert", { hidden: true })).toHaveLength(1);
    fireEvent.click(button("Send"));
  }
  expect(screen.queryAllByRole("alert", { hidden: true })).toHaveLength(0);
  expect(input().value).toBe(change === "instruction" ? "Edited instruction" : "Retain this instruction");
  expect(fetchMock).toHaveBeenCalledOnce();
});

test.each(["dialog", "instructions", "footer"])(
  "leaving phone closes the sheet, moves %s focus to Instructions, and keeps it closed on return",
  async (focus) => {
    const { rerender } = mount({ phone: true, unsentCount: 1 });
    fireEvent.click(button("Send"));
    const focused =
      focus === "dialog"
        ? screen.getByRole("dialog")
        : focus === "instructions"
          ? input()
          : button("Send 1 comment on revision 3");
    act(() => focused.focus());
    expect(document.activeElement).toBe(focused);
    rerender(<SendBar reviewId={reviewId} revision={3} newestRevision={3} unsentCount={1} />);
    await waitFor(() => expect(document.activeElement).toBe(input()));
    expect(screen.queryByRole("dialog")).toBeNull();
    rerender(<SendBar reviewId={reviewId} revision={3} newestRevision={3} unsentCount={1} phone />);
    expect(screen.queryByRole("dialog")).toBeNull();
  },
);

test("resizing after closing the sheet does not steal focus", async () => {
  const { rerender } = mount({ phone: true });
  fireEvent.click(button("Send"));
  fireEvent.click(button("Close"));
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  render(<button type="button">Keep focus</button>);
  const keepFocus = button("Keep focus");
  act(() => keepFocus.focus());
  rerender(<SendBar reviewId={reviewId} revision={3} newestRevision={3} unsentCount={0} />);
  expect(document.activeElement).toBe(keepFocus);
});

test("phone success closes and clears; a later failure stays open with the draft and one alert", async () => {
  mount({ phone: true });
  fireEvent.click(button("Send"));
  fireEvent.change(input(), { target: { value: "Successful instruction" } });
  fireEvent.click(button("Send instructions on revision 3"));
  await closeSent();
  expect(screen.queryByRole("dialog")).toBeNull();
  fireEvent.click(button("Send"));
  expect(input().value).toBe("");
  fetchMock.mockRejectedValueOnce(new Error("Synthetic failure"));
  fireEvent.change(input(), { target: { value: "Keep after failure" } });
  fireEvent.click(button("Send instructions on revision 3"));
  await screen.findByRole("alert");
  expect(screen.getByRole("dialog", { name: "Send feedback" })).toBeTruthy();
  expect(input().value).toBe("Keep after failure");
  expect(screen.getAllByRole("alert", { hidden: true })).toHaveLength(1);
  // Settlement unlocks a failed request as well as a successful one.
  fireEvent.click(button("Send instructions on revision 3"));
  await closeSent();
  fireEvent.click(button("Send"));
  expect(input().value).toBe("");
  expect(fetchMock).toHaveBeenCalledTimes(3);
});

test.each([
  { outcome: "success", edit: "instruction" },
  { outcome: "failure", edit: "instruction" },
  { outcome: "success", edit: "mode" },
  { outcome: "failure", edit: "mode" },
])(
  "an immediate $edit edit preserves the pending Send's $outcome and unlocks the next request",
  async ({ outcome, edit }) => {
    const pending = Promise.withResolvers<Response>();
    fetchMock.mockReturnValueOnce(pending.promise);
    mount();
    const instructions = input();
    fireEvent.change(instructions, { target: { value: "Submitted instruction" } });
    act(() => {
      fireEvent.keyDown(instructions, { key: "Enter", ctrlKey: true });
      if (edit === "instruction") fireEvent.change(instructions, { target: { value: "Edited before settlement" } });
      else fireEvent.change(screen.getByRole("combobox", { name: "Mode" }), { target: { value: "explain" } });
    });
    await waitFor(() => expect(fetchMock).toHaveBeenCalledOnce());
    expectSend({ revision: 3, kind: "go", mode: "fix-clear", instruction: "Submitted instruction" });
    expect(instructions.value).toBe(edit === "instruction" ? "Edited before settlement" : "Submitted instruction");
    await waitFor(() => expect(instructions.disabled).toBe(true));
    expect(button("Send").disabled).toBe(true);
    expect(button("Approve revision 3").disabled).toBe(true);
    await act(async () =>
      pending.resolve(
        outcome === "success"
          ? new Response(null, { status: 201 })
          : Response.json({ error: { code: "too_large", message: "Synthetic failure" } }, { status: 413 }),
      ),
    );
    if (outcome === "success") {
      await closeSent();
      expect(instructions.value).toBe(edit === "instruction" ? "Edited before settlement" : "");
      expect(screen.queryByRole("alert")).toBeNull();
    } else {
      expect((await screen.findByRole("alert")).textContent).toBe("Synthetic failure");
      expect(screen.getAllByRole("alert", { hidden: true })).toHaveLength(1);
      expect(instructions.value).toBe(edit === "instruction" ? "Edited before settlement" : "Submitted instruction");
    }
    expect(button("Approve revision 3").disabled).toBe(false);
    fireEvent.change(instructions, { target: { value: "Next instruction" } });
    act(() => {
      fireEvent.click(button("Send"));
      fireEvent.click(button("Send"));
    });
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(instructions.value).toBe(""));
    expect(screen.getByText(sentText)).toBeTruthy();
    expect(screen.queryByRole("alert")).toBeNull();
    expect(fetchMock).toHaveBeenLastCalledWith(
      `/api/v1/reviews/${reviewId}/sends`,
      expect.objectContaining({
        method: "POST",
        credentials: "same-origin",
        body: JSON.stringify({
          revision: 3,
          kind: "go",
          mode: edit === "mode" ? "explain" : "fix-clear",
          instruction: "Next instruction",
        }),
      }),
    );
  },
);

test("a pending Approve holds its dialog; the Send sheet works once it settles", async () => {
  const pending = Promise.withResolvers<Response>();
  fetchMock.mockReturnValueOnce(pending.promise);
  mount({ phone: true });
  approve("Approve");
  expect(screen.getByRole("alertdialog")).toBeTruthy();
  await waitFor(() => expect(fetchMock).toHaveBeenCalledOnce());
  expectSend({ revision: 3, kind: "approve" });
  // The modal makes the bar inert while the approval is pending.
  expect(screen.queryByRole("button", { name: "Send" })).toBeNull();
  expect(screen.getByRole("button", { name: "Send", hidden: true }).closest("[aria-hidden='true']")).toBeTruthy();
  await act(async () => pending.resolve(new Response(null, { status: 201 })));
  await screen.findByText("Approved revision 3");
  await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
  fireEvent.click(button("Send"));
  fireEvent.change(input(), { target: { value: "Follow-up instruction" } });
  fireEvent.click(button("Send instructions on revision 3"));
  await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
  await screen.findByText(sentText);
  expect(screen.queryByRole("dialog", { name: "Send feedback" })).toBeNull();
});

test.each([
  { outcome: "success", movedFocus: false },
  { outcome: "failure", movedFocus: false },
  { outcome: "success", movedFocus: true },
  { outcome: "failure", movedFocus: true },
])(
  "pending phone Send defers resize focus through $outcome without overriding a reviewer move ($movedFocus)",
  async ({ outcome, movedFocus }) => {
    const pending = Promise.withResolvers<Response>();
    fetchMock.mockReturnValueOnce(pending.promise);
    const { rerender } = mount({ phone: true });
    fireEvent.click(button("Send"));
    fireEvent.change(input(), { target: { value: "Phone instruction" } });
    fireEvent.click(button("Send instructions on revision 3"));
    await waitFor(() => expect(input().disabled).toBe(true));
    act(() => button("Close").focus());
    expect(document.activeElement).toBe(button("Close"));
    rerender(<SendBar reviewId={reviewId} revision={3} newestRevision={3} unsentCount={0} />);
    const instructions = input();
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(instructions.disabled).toBe(true);
    expect(document.activeElement).toBe(document.body);
    let keepFocus: HTMLElement | undefined;
    if (movedFocus) {
      render(<button type="button">Keep focus while sending</button>);
      keepFocus = button("Keep focus while sending");
      act(() => keepFocus?.focus());
    }
    await act(async () =>
      pending.resolve(
        outcome === "success"
          ? new Response(null, { status: 201 })
          : Response.json({ error: { code: "too_large", message: "Synthetic failure" } }, { status: 413 }),
      ),
    );
    await waitFor(() => expect(instructions.disabled).toBe(false));
    // A success opens the window after the Send, which takes focus; only a failure returns it.
    if (outcome === "failure")
      await waitFor(() => expect(document.activeElement).toBe(movedFocus ? keepFocus : instructions));
    if (outcome === "success") {
      expect(screen.getByText(sentText)).toBeTruthy();
      expect(instructions.value).toBe("");
    } else {
      expect(screen.getByRole("alert").textContent).toBe("Synthetic failure");
      expect(instructions.value).toBe("Phone instruction");
    }
  },
);

test.each([
  { action: "Send", ownToast: false },
  { action: "Approve", ownToast: false },
  { action: "Send", ownToast: true },
  { action: "Approve", ownToast: true },
])(
  "leaving review A suppresses its pending $action completion and preserves review B's toast ($ownToast)",
  async ({ action, ownToast }) => {
    const pending = Promise.withResolvers<Response>();
    fetchMock.mockReturnValueOnce(pending.promise);
    const nextReviewId = "22222222-2222-4222-8222-222222222222";
    const { rerender } = render(
      <SendBar
        key={reviewId}
        reviewId={reviewId}
        revision={3}
        newestRevision={3}
        unsentCount={action === "Send" ? 1 : 0}
      />,
      {
        wrapper: ({ children }: { children: ReactNode }) => (
          <StrictMode>
            <QueryClientProvider client={client}>
              <ToastProvider>{children}</ToastProvider>
            </QueryClientProvider>
          </StrictMode>
        ),
      },
    );
    if (action === "Send") fireEvent.click(button("Send"));
    else approve("Approve revision 3");
    await waitFor(() => expect(fetchMock).toHaveBeenCalledOnce());
    expectSend(
      action === "Send"
        ? { revision: 3, kind: "go", mode: "fix-clear", instruction: "" }
        : { revision: 3, kind: "approve" },
    );
    rerender(<SendBar key={nextReviewId} reviewId={nextReviewId} revision={7} newestRevision={7} unsentCount={0} />);
    fireEvent.change(input(), { target: { value: "Keep review B's draft" } });
    if (ownToast) {
      approve("Approve revision 7");
      await screen.findByText("Approved revision 7");
    }
    await act(async () => pending.resolve(new Response(null, { status: 201 })));
    await waitFor(() => expect(client.isMutating()).toBe(0));
    expect(screen.queryByText(action === "Send" ? sentText : "Approved revision 3")).toBeNull();
    if (ownToast) expect(screen.getByText("Approved revision 7")).toBeTruthy();
    else expect(screen.getByRole("status").textContent).toBe("");
    expect(input().value).toBe("Keep review B's draft");
    expect(fetchMock).toHaveBeenCalledTimes(ownToast ? 2 : 1);
  },
);

const retiredLifecycle = {
  title: "Synthetic review",
  state: "settled" as const,
  snoozed: false,
  snoozedUntil: null,
  onDeleted: vi.fn(),
};
test.each([false, true])("a retired review disables Send and Approve with the reason (phone %s)", (phone) => {
  mount({ phone, unsentCount: 1, lifecycle: retiredLifecycle });
  const reason = "This review is retired. Reopen it to send or approve.";
  for (const name of [/^Send/, /^Approve/]) {
    expect(button(name).disabled).toBe(true);
    expect(description(button(name))).toContain(reason);
    fireEvent.click(button(name));
  }
  expect(screen.getAllByText(reason).length).toBeGreaterThan(0);
  expect(screen.queryByText("Send or delete before approving")).toBeNull();
  expect(fetchMock).not.toHaveBeenCalled();
});

test.each([false, true])("the actions menu sits beside Approve and Send (phone %s)", (phone) => {
  mount({ phone, lifecycle: { ...retiredLifecycle, state: "open" } });
  const bar = within(screen.getByRole("region", { name: "Send and approve" }));
  const names = bar.getAllByRole("button").map((node) => node.getAttribute("aria-label") ?? node.textContent ?? "");
  expect(names.filter((name) => /More review actions|Approve|^Send/.test(name))).toEqual(
    phone ? ["More review actions", "Approve", "Send"] : ["More review actions", "Approve revision 3", "Send"],
  );
});

test("without a lifecycle the bar has no actions menu", () => {
  mount();
  expect(screen.queryByRole("button", { name: "More review actions" })).toBeNull();
});
