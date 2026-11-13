import type { ThreadView } from "@emend/contract";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import {
  clearDraft,
  draftKey,
  editDraftKey,
  hasDraft,
  instructionKey,
  listDrafts,
  loadDraft,
  saveDraft,
} from "../../lib/drafts.ts";
import { Composer } from "../threads/Composer.tsx";
import { ThreadCard } from "../threads/ThreadCard.tsx";
import { ToastProvider } from "../ui/Toast.tsx";
import { SendBar } from "./SendBar.tsx";

const id = "11111111-1111-4111-8111-111111111111";
const other = "22222222-2222-4222-8222-222222222222";
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
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});
function mount(children: ReactNode) {
  return render(children, {
    wrapper: ({ children }) => (
      <QueryClientProvider client={client}>
        <ToastProvider>{children}</ToastProvider>
      </QueryClientProvider>
    ),
  });
}
function bar(reviewId = id, unsentCount = 0, phone = false) {
  return (
    <SendBar
      key={reviewId}
      reviewId={reviewId}
      revision={1}
      newestRevision={1}
      unsentCount={unsentCount}
      phone={phone}
    />
  );
}
function button(name: string | RegExp) {
  return screen.getByRole<HTMLButtonElement>("button", { name });
}
function instructions() {
  return screen.getByRole<HTMLTextAreaElement>("textbox", { name: "Instructions" });
}

test.each(["Send", "Approve"].flatMap((action) => ["success", "failure"].map((outcome) => ({ action, outcome }))))(
  "fix1 pending $action survives remount and unlocks after $outcome",
  async ({ action, outcome }) => {
    const pending = Promise.withResolvers<Response>();
    const refresh = Promise.withResolvers<void>();
    fetchMock.mockReturnValueOnce(pending.promise);
    const invalidate = vi.spyOn(client, "invalidateQueries").mockReturnValue(refresh.promise);
    const view = mount(bar());
    fireEvent.change(instructions(), { target: { value: "Submitted instructions" } });
    fireEvent.click(button(action === "Send" ? "Send" : /^Approve/));
    // Approving asks first.
    if (action === "Approve")
      fireEvent.click(within(screen.getByRole("alertdialog")).getByRole("button", { name: "Approve" }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledOnce());
    view.rerender(bar(other));
    fireEvent.change(instructions(), { target: { value: "Other review instructions" } });
    expect(button("Send").disabled).toBe(false);
    expect(button(/^Approve/).disabled).toBe(false);
    act(() => saveDraft(instructionKey(id), "Next instructions"));
    view.rerender(bar());
    expect(instructions().value).toBe("Next instructions");
    expect(button("Send").disabled).toBe(true);
    expect(button(/^Approve/).disabled).toBe(true);
    fireEvent.keyDown(instructions(), { key: "Enter", ctrlKey: true });
    fireEvent.submit(instructions().closest("form") as HTMLFormElement);
    expect(fetchMock).toHaveBeenCalledOnce();
    await act(async () => {
      if (outcome === "success") pending.resolve(new Response(null, { status: 201 }));
      else pending.reject(new Error("Synthetic failure"));
    });
    if (outcome === "success") {
      // The server's answer frees the bar; the refetch is still pending.
      await waitFor(() => expect(invalidate).toHaveBeenCalledTimes(3));
    }
    await waitFor(() => expect(button("Send").disabled).toBe(false));
    expect(button(/^Approve/).disabled).toBe(false);
    if (outcome === "success") await act(async () => refresh.resolve());
    expect(fetchMock).toHaveBeenCalledOnce();
  },
);

test.each(["success", "failure"])("fix1 deleting holds Send through request and refresh (%s)", async (outcome) => {
  const pending = Promise.withResolvers<Response>();
  const refresh = Promise.withResolvers<void>();
  fetchMock.mockReturnValueOnce(pending.promise);
  const invalidate = vi.spyOn(client, "invalidateQueries").mockReturnValue(refresh.promise);
  const thread: ThreadView = {
    id,
    target: { kind: "review" },
    createdOn: 1,
    state: "open",
    placement: { status: "placed", location: { kind: "review" } },
    comments: [{ id, author: "user", body: "Original text", sent: false, sentOn: null }],
  };
  const view = mount(
    <>
      {bar()}
      <ThreadCard reviewId={id} revision={1} thread={thread} changedBlocks={[]} />
    </>,
  );
  fireEvent.change(instructions(), { target: { value: "Send after deleting" } });
  fireEvent.click(button("Delete"));
  fireEvent.click(within(screen.getByRole("alertdialog")).getByRole("button", { name: "Delete" }));
  await waitFor(() => expect(fetchMock).toHaveBeenCalledOnce());
  expect(fetchMock.mock.calls[0]?.[1]?.method).toBe("DELETE");
  view.rerender(bar());
  expect(button("Send").disabled).toBe(true);
  fireEvent.keyDown(instructions(), { key: "Enter", ctrlKey: true });
  fireEvent.submit(instructions().closest("form") as HTMLFormElement);
  await act(async () => {
    if (outcome === "success") pending.resolve(new Response(null, { status: 204 }));
    else pending.reject(new Error("Synthetic failure"));
  });
  if (outcome === "success") {
    await waitFor(() => expect(invalidate).toHaveBeenCalledTimes(3));
    expect(button("Send").disabled).toBe(true);
    await act(async () => refresh.resolve());
  }
  await waitFor(() => expect(button("Send").disabled).toBe(false));
  expect(fetchMock).toHaveBeenCalledOnce();
});

test("fix1 deleting clears a dismissed edit before refresh even when its card unmounts", async () => {
  const pending = Promise.withResolvers<Response>();
  const refresh = Promise.withResolvers<void>();
  fetchMock.mockReturnValueOnce(pending.promise);
  const invalidate = vi.spyOn(client, "invalidateQueries").mockReturnValue(refresh.promise);
  const thread: ThreadView = {
    id,
    target: { kind: "review" },
    createdOn: 1,
    state: "open",
    placement: { status: "placed", location: { kind: "review" } },
    comments: [{ id, author: "user", body: "Original text", sent: false, sentOn: null }],
  };
  const view = mount(
    <>
      {bar()}
      <ThreadCard reviewId={id} revision={1} thread={thread} changedBlocks={[]} />
    </>,
  );
  fireEvent.change(instructions(), { target: { value: "Instructions after deletion" } });
  fireEvent.click(button("Edit"));
  const edit = screen.getByRole("textbox", { name: "Edit comment" });
  fireEvent.change(edit, { target: { value: "Changed edit" } });
  fireEvent.keyDown(edit, { key: "Escape" });
  expect(listDrafts(id)).toHaveLength(1);
  fireEvent.click(button("Delete"));
  fireEvent.click(within(screen.getByRole("alertdialog")).getByRole("button", { name: "Delete" }));
  await waitFor(() => expect(fetchMock).toHaveBeenCalledOnce());
  view.rerender(bar());
  await act(async () => pending.resolve(new Response(null, { status: 204 })));
  await waitFor(() => expect(invalidate).toHaveBeenCalledTimes(3));
  expect(hasDraft(editDraftKey(id, id))).toBe(false);
  expect(listDrafts(id)).toHaveLength(0);
  expect(button("Send").disabled).toBe(true);
  await act(async () => refresh.resolve());
  await waitFor(() => expect(button("Send").disabled).toBe(false));
  expect(listDrafts(id)).toHaveLength(0);
});

test("fix1 Ctrl+Enter and form submission cannot send an unsaved or saving comment", async () => {
  const pending = Promise.withResolvers<Response>();
  const refresh = Promise.withResolvers<void>();
  fetchMock.mockReturnValueOnce(pending.promise);
  vi.spyOn(client, "invalidateQueries").mockReturnValue(refresh.promise);
  mount(
    <>
      {bar()}
      <Composer reviewId={id} revision={1} target={{ kind: "review" }} />
    </>,
  );
  fireEvent.change(instructions(), { target: { value: "Send after saving" } });
  fireEvent.change(screen.getByRole("textbox", { name: "Comment" }), { target: { value: "Unsaved comment" } });
  const trySending = () => {
    fireEvent.keyDown(instructions(), { key: "Enter", ctrlKey: true });
    fireEvent.submit(instructions().closest("form") as HTMLFormElement);
    expect(fetchMock.mock.calls.filter(([path]) => String(path).endsWith("/sends"))).toHaveLength(0);
  };
  trySending();
  expect(fetchMock).not.toHaveBeenCalled();
  fireEvent.click(button("Save comment"));
  await waitFor(() => expect(fetchMock).toHaveBeenCalledOnce());
  trySending();
  await act(async () => pending.resolve(new Response(null, { status: 201 })));
  await waitFor(() => expect(listDrafts(id)).toHaveLength(0));
  trySending();
  await act(async () => refresh.resolve());
  await waitFor(() => expect(button("Send").disabled).toBe(false));
});

test.each(["comment", "instruction"])(
  "fix1 a failed second storage write cannot restore old %s text after saving",
  async (kind) => {
    const key = kind === "comment" ? draftKey(id, { kind: "review" }) : instructionKey(id);
    mount(kind === "comment" ? <Composer reviewId={id} revision={1} target={{ kind: "review" }} /> : bar());
    const input = screen.getByRole("textbox", { name: kind === "comment" ? "Comment" : "Instructions" });
    fireEvent.change(input, { target: { value: "Old text" } });
    expect(localStorage.getItem(key)).toBe("Old text");
    const storage = localStorage;
    const setItem = vi.fn(() => {
      throw new Error("Synthetic quota failure");
    });
    vi.spyOn(window, "localStorage", "get").mockReturnValue(
      new Proxy(storage, {
        get: (value, property) => (property === "setItem" ? setItem : Reflect.get(value, property)),
      }),
    );
    fireEvent.change(input, { target: { value: "New text" } });
    expect(loadDraft(key)).toBe("New text");
    expect(localStorage.getItem(key)).toBeNull();
    fireEvent.click(button(kind === "comment" ? "Save comment" : "Send"));
    await waitFor(() => expect(hasDraft(key)).toBe(false));
    expect(localStorage.getItem(key)).toBeNull();
    expect(listDrafts(id)).toHaveLength(0);
    expect(JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body))[kind === "comment" ? "body" : "instruction"]).toBe(
      "New text",
    );
  },
);

test.each([false, true])("fix1 clearing instructions removes their storage entry (phone %s)", (phone) => {
  mount(bar(id, 0, phone));
  if (phone) fireEvent.click(button("Send"));
  fireEvent.change(instructions(), { target: { value: "Temporary instructions" } });
  expect(localStorage.getItem(instructionKey(id))).toBe("Temporary instructions");
  fireEvent.change(instructions(), { target: { value: "" } });
  expect(localStorage.getItem(instructionKey(id))).toBeNull();
  expect(hasDraft(instructionKey(id))).toBe(false);
});

test("fix1 instruction fallback sizing handles input, restore and clearing, with a six-line CSS cap", () => {
  vi.stubGlobal("CSS", { supports: () => false });
  vi.spyOn(HTMLElement.prototype, "scrollHeight", "get").mockImplementation(function (this: HTMLElement) {
    return this instanceof HTMLTextAreaElement ? this.value.split("\n").length * 20 + 6 : 0;
  });
  const view = mount(bar());
  expect(instructions().style.height).toBe("");
  expect(instructions().className).toContain("h-7");
  fireEvent.change(instructions(), { target: { value: "Line 1\nLine 2\nLine 3" } });
  expect(Number.parseFloat(instructions().style.height)).toBeGreaterThanOrEqual(66);
  expect(instructions().className).toContain("max-h-32");
  expect(instructions().className).toContain("overflow-y-auto");
  view.rerender(bar(other));
  view.rerender(bar());
  expect(Number.parseFloat(instructions().style.height)).toBeGreaterThanOrEqual(66);
  fireEvent.change(instructions(), { target: { value: "One line" } });
  expect(Number.parseFloat(instructions().style.height)).toBeLessThan(66);
  fireEvent.change(instructions(), { target: { value: "" } });
  expect(instructions().style.height).toBe("");
  expect(instructions().className.split(" ")).toContain("h-7");
});

test("fix1 supported field sizing grows natively and keeps empty instructions one row high", () => {
  vi.stubGlobal("CSS", { supports: () => true });
  saveDraft(instructionKey(id), "Restored\nlines");
  mount(bar());
  expect(instructions().className).toContain("[field-sizing:content]");
  expect(instructions().className).toContain("max-h-32");
  expect(instructions().style.height).toBe("");
  fireEvent.change(instructions(), { target: { value: "" } });
  expect(instructions().className).not.toContain("[field-sizing:content]");
  expect(instructions().className.split(" ")).toContain("h-7");
});

test.each([false, true])("unsaved comments live-update both actions and reasons (phone %s)", async (phone) => {
  mount(
    <>
      {bar(id, 0, phone)}
      <Composer reviewId={id} revision={1} target={{ kind: "review" }} />
    </>,
  );
  fireEvent.change(screen.getByRole("textbox", { name: "Comment" }), { target: { value: "Keep this comment" } });
  const reason = "1 unsaved comment: save or discard it first.";
  expect(screen.getByText(reason)).toBeTruthy();
  expect(button(/^Approve/).disabled).toBe(true);
  expect(button("Send").disabled).toBe(true);
  fireEvent.click(button(/^Approve/));
  expect(fetchMock).not.toHaveBeenCalled();
  const second = draftKey(id, { kind: "file", path: "seed.ts" });
  act(() => saveDraft(second, "Another draft"));
  expect(screen.getByText("2 unsaved comments: save or discard them first.")).toBeTruthy();
  act(() => clearDraft(second));
  expect(screen.getByText(reason)).toBeTruthy();
  fireEvent.click(button("Save comment"));
  await waitFor(() => expect(screen.queryByText(reason)).toBeNull());
  await waitFor(() => expect(button(/^Approve/).disabled).toBe(false));
});

test("saving a typed draft re-enables Send", async () => {
  mount(
    <>
      {bar(id, 1)}
      <Composer reviewId={id} revision={1} target={{ kind: "review" }} />
    </>,
  );
  fireEvent.change(screen.getByRole("textbox", { name: "Comment" }), { target: { value: "New comment" } });
  expect(button("Send").disabled).toBe(true);
  fireEvent.click(button("Save comment"));
  await waitFor(() => expect(button("Send").disabled).toBe(false));
});

test("all pending saves must finish refreshing before either action unlocks", async () => {
  const first = Promise.withResolvers<void>();
  const second = Promise.withResolvers<void>();
  let refreshes = 0;
  vi.spyOn(client, "invalidateQueries").mockImplementation(() => (++refreshes <= 3 ? first.promise : second.promise));
  mount(
    <>
      {bar()}
      <Composer reviewId={id} revision={1} target={{ kind: "review" }} />
      <Composer reviewId={id} revision={1} target={{ kind: "file", path: "seed.ts" }} />
    </>,
  );
  fireEvent.change(instructions(), { target: { value: "Send after saving" } });
  const inputs = screen.getAllByRole("textbox", { name: "Comment" });
  inputs.forEach((input, index) => {
    fireEvent.change(input, { target: { value: `Comment ${index}` } });
  });
  for (const button of screen.getAllByRole("button", { name: "Save comment" })) fireEvent.click(button);
  await waitFor(() => expect(refreshes).toBe(6));
  expect(listDrafts(id)).toHaveLength(0);
  expect(button("Send").disabled).toBe(true);
  expect(button(/^Approve/).disabled).toBe(true);
  expect(screen.queryByText(/unsaved comment:/)).toBeNull();
  await act(async () => first.resolve());
  expect(button("Send").disabled).toBe(true);
  expect(button(/^Approve/).disabled).toBe(true);
  await act(async () => second.resolve());
  await waitFor(() => expect(button("Send").disabled).toBe(false));
  expect(button(/^Approve/).disabled).toBe(false);
});

test.each(["success", "failure"])(
  "a pending PATCH holds Send through settlement and cache refresh (%s)",
  async (outcome) => {
    const patch = Promise.withResolvers<Response>();
    const refresh = Promise.withResolvers<void>();
    fetchMock.mockReturnValueOnce(patch.promise);
    const invalidate = vi.spyOn(client, "invalidateQueries").mockReturnValue(refresh.promise);
    const thread: ThreadView = {
      id,
      target: { kind: "review" },
      createdOn: 1,
      state: "open",
      placement: { status: "placed", location: { kind: "review" } },
      comments: [{ id, author: "user", body: "Original text", sent: false, sentOn: null }],
    };
    mount(
      <>
        {bar(id, 1)}
        <ThreadCard reviewId={id} revision={1} thread={thread} changedBlocks={[]} />
      </>,
    );
    fireEvent.click(button("Edit"));
    fireEvent.change(screen.getByRole("textbox", { name: "Edit comment" }), { target: { value: "Edited text" } });
    fireEvent.click(button("Save changes"));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledOnce());
    expect(fetchMock.mock.calls[0]?.[1]?.method).toBe("PATCH");
    expect(button("Send").disabled).toBe(true);
    fireEvent.click(button("Send"));
    await act(async () => {
      if (outcome === "success") patch.resolve(new Response(null, { status: 204 }));
      else patch.reject(new Error("Synthetic failure"));
    });
    if (outcome === "success") {
      await waitFor(() => expect(invalidate).toHaveBeenCalledTimes(3));
      expect(listDrafts(id)).toHaveLength(0);
      expect(screen.queryByText("1 unsaved comment: save or discard it first.")).toBeNull();
      expect(button("Send").disabled).toBe(true);
      fireEvent.click(button("Send"));
      await act(async () => refresh.resolve());
      await waitFor(() => expect(button("Send").disabled).toBe(false));
    } else {
      await screen.findByRole("alert");
      expect(loadDraft(editDraftKey(id, id))).toBe("Edited text");
      expect(button("Send").disabled).toBe(true);
      expect(invalidate).not.toHaveBeenCalled();
    }
    expect(fetchMock).toHaveBeenCalledOnce();
  },
);

test("drafts and saves belong to their review; instructions survive navigation and clear after Send", async () => {
  saveDraft(draftKey(other, { kind: "review" }), "Other review's comment");
  const view = mount(bar());
  fireEvent.change(instructions(), { target: { value: "Review A instructions" } });
  expect(listDrafts(id)).toHaveLength(0);
  expect(button("Send").disabled).toBe(false);
  view.rerender(bar(other));
  expect(instructions().value).toBe("");
  fireEvent.change(instructions(), { target: { value: "Review B instructions" } });
  view.rerender(bar());
  expect(instructions().value).toBe("Review A instructions");
  expect(localStorage.getItem(instructionKey(id))).toBe("Review A instructions");
  fireEvent.click(button("Send"));
  fireEvent.click(await screen.findByRole("button", { name: "Close" }));
  await waitFor(() => expect(instructions().value).toBe(""));
  expect(localStorage.getItem(instructionKey(id))).toBeNull();
  view.rerender(bar(other));
  expect(instructions().value).toBe("Review B instructions");
  view.rerender(bar());
  expect(instructions().value).toBe("");
});

test.each([false, true])(
  "a completed Send compare-clears instructions even after leaving (newer text %s)",
  async (newer) => {
    const pending = Promise.withResolvers<Response>();
    fetchMock.mockReturnValueOnce(pending.promise);
    const view = mount(bar());
    fireEvent.change(instructions(), { target: { value: "Submitted instruction" } });
    fireEvent.click(button("Send"));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledOnce());
    view.rerender(bar(other));
    if (newer) act(() => saveDraft(instructionKey(id), "Newer instruction"));
    await act(async () => pending.resolve(new Response(null, { status: 201 })));
    await waitFor(() => expect(client.isMutating()).toBe(0));
    view.rerender(bar());
    expect(instructions().value).toBe(newer ? "Newer instruction" : "");
  },
);

test("instructions survive remount with blocked browser storage", async () => {
  vi.spyOn(window, "localStorage", "get").mockImplementation(() => {
    throw new Error("Storage blocked");
  });
  const view = mount(bar());
  fireEvent.change(instructions(), { target: { value: "Keep in memory" } });
  view.unmount();
  mount(bar());
  expect(instructions().value).toBe("Keep in memory");
  fireEvent.click(button("Send"));
  fireEvent.click(await screen.findByRole("button", { name: "Close" }));
  await waitFor(() => expect(instructions().value).toBe(""));
});

test.each(["MacIntel", "Linux x86_64"])(
  "Enter keeps multiline instructions; the displayed shortcut sends on %s",
  async (platform) => {
    vi.spyOn(navigator, "platform", "get").mockReturnValue(platform);
    mount(bar());
    fireEvent.change(instructions(), { target: { value: "First line" } });
    expect(fireEvent.keyDown(instructions(), { key: "Enter" })).toBe(true);
    expect(fetchMock).not.toHaveBeenCalled();
    fireEvent.change(instructions(), { target: { value: "First line\nSecond line" } });
    expect(screen.getByText(platform === "MacIntel" ? "⌘↵" : "Ctrl ↵")).toBeTruthy();
    fireEvent.keyDown(instructions(), {
      key: "Enter",
      metaKey: platform === "MacIntel",
      ctrlKey: platform !== "MacIntel",
    });
    await waitFor(() => expect(fetchMock).toHaveBeenCalledOnce());
    expect(JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body)).instruction).toBe("First line\nSecond line");
  },
);
