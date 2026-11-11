import { APPROVED_ACTIVE_HOURS, type InboxItem, type ReviewView, type RevisionView } from "@emend/contract";
import { QueryClient, QueryClientProvider, useQuery } from "@tanstack/react-query";
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { type InboxData, inboxQuery, reviewQuery, revisionQuery } from "../../api/queries.ts";
import { reconnectReviewEvents } from "../../lib/event-stream.ts";
import { formatThreadCounts, threadCounts } from "../status/ThreadStateBadge.tsx";
import { ToastProvider } from "../ui/Toast.tsx";
import { HANDOFF_REFETCH_MS, HANDOFF_WAIT_MS } from "./HandOver.tsx";
import { SendBar } from "./SendBar.tsx";

// No live stream reopens here, as with no subscription.
vi.mock("../../lib/event-stream.ts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../lib/event-stream.ts")>()),
  reconnectReviewEvents: vi.fn(() => Promise.resolve(false)),
}));

const reviewId = "11111111-1111-4111-8111-111111111111";
const base: ReviewView = {
  id: reviewId,
  title: "Synthetic review",
  origin: { id: reviewId, name: "Workshop" },
  repo: null,
  project: null,
  branch: null,
  state: "open",
  newestRevision: 3,
  unsentCount: 1,
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
  revisions: [{ seq: 3, createdAt: "2026-01-01T00:00:00.000Z" }],
};
/** How the fake server answers a review GET. */
type Mode = "ok" | "hang" | "network" | "notfound" | "held";
/** Resolvers of fetches answered later (mode "held"), oldest first. */
let held: Array<{ url: string; resolve: (response: Response) => void }> = [];
let mode: Mode;
let server: ReviewView;
let posts: number;
let reviewGets: number;
let postAnswer: () => Response;
let client: QueryClient;
let serverOffset: number;

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date", "performance", "setTimeout", "clearTimeout", "setInterval", "clearInterval"] });
  vi.mocked(reconnectReviewEvents).mockReset().mockResolvedValue(false);
  localStorage.clear();
  mode = "ok";
  serverOffset = 0;
  server = base;
  posts = 0;
  reviewGets = 0;
  held = [];
  postAnswer = () => new Response(null, { status: 201 });
  client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) => {
      if (init?.method === "POST") {
        posts += 1;
        return postAnswer();
      }
      if (url === "/api/v1/reviews") {
        if (mode === "held") return new Promise<Response>((resolve) => held.push({ url, resolve }));
        return Response.json({ items: [server], serverTime: new Date(Date.now() + serverOffset).toISOString() });
      }
      if (url === `/api/v1/reviews/${reviewId}`) {
        reviewGets += 1;
        if (mode === "held") return new Promise<Response>((resolve) => held.push({ url, resolve }));
        if (mode === "hang") return new Promise<Response>(() => {});
        if (mode === "network") throw new TypeError("Failed to fetch");
        if (mode === "notfound")
          return Response.json({ error: { code: "unknown_review", message: "Unknown review" } }, { status: 404 });
        return Response.json(server);
      }
      throw new Error(`Unexpected request ${url}`);
    }),
  );
});
afterEach(() => {
  cleanup();
  client.clear();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

/** The Send bar fed from the cached review, as the review route does. */
function Connected() {
  const review = useQuery(reviewQuery(reviewId)).data;
  if (!review) return null;
  return (
    <SendBar
      reviewId={reviewId}
      revision={review.newestRevision}
      newestRevision={review.newestRevision}
      unsentCount={review.unsentCount}
      approved={review.state === "approved"}
      agent={{
        agentWaiting: review.agentWaiting,
        pendingSend: review.pendingSend,
        pickedUpAt: review.pickedUpAt,
        releasedAt: review.releasedAt,
        newestRevision: review.newestRevision,
      }}
    />
  );
}
/** An active inbox query, as the sidebar holds. */
function Inbox() {
  useQuery(inboxQuery());
  return null;
}
/** An inbox query whose fetch never settles. */
function SlowInbox() {
  useQuery({ queryKey: ["inbox"], queryFn: () => new Promise<never>(() => {}) });
  return null;
}
async function settle(ms = 0) {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
}
async function mount(extra?: React.ReactNode) {
  render(
    <QueryClientProvider client={client}>
      <ToastProvider>
        <Connected />
        {extra}
      </ToastProvider>
    </QueryClientProvider>,
  );
  await settle();
}
const button = (name: string, hidden = false) => screen.getByRole<HTMLButtonElement>("button", { name, hidden });
/** Approving asks first: the bar's Approve opens a dialog, and its Approve sends. */
function approve(name: string) {
  fireEvent.click(button(name));
  fireEvent.click(within(screen.getByRole("alertdialog")).getByRole("button", { name: "Approve" }));
}
const lostText =
  "emend cannot reach its server right now, so a pick-up may not show here. If no agent has it yet, hand it over with the command below.";
const normalText = "No agent has picked this up yet. emend keeps it until one does.";

function revisionView(sent = false): RevisionView {
  const target = { kind: "file", path: "example.ts" } as const;
  return {
    seq: 3,
    base: null,
    head: null,
    main: null,
    writeupEmpty: true,
    writeup: { sections: [] },
    docs: [],
    files: [],
    topics: [],
    changedBlocks: [],
    threads: [
      {
        id: reviewId,
        target,
        createdOn: 1,
        state: sent ? "sent" : "open",
        placement: { status: "placed", location: target },
        comments: [{ id: reviewId, author: "user", body: "A comment", sent, sentOn: sent ? 3 : null }],
      },
    ],
  };
}

function RevisionCounts() {
  const { data } = useQuery(revisionQuery(reviewId, 3));
  return <output>{data ? formatThreadCounts(threadCounts(data.threads)).text : "Loading threads"}</output>;
}

test("an accepted Send aborts a pending first revision fetch and loads post-Send threads", async () => {
  const first = Promise.withResolvers<Response>();
  const signals: (AbortSignal | null | undefined)[] = [];
  const fallback = vi.mocked(fetch).getMockImplementation();
  vi.mocked(fetch).mockImplementation(async (url, init) => {
    if (url === `/api/v1/reviews/${reviewId}/revisions/3`) {
      signals.push(init?.signal);
      return signals.length === 1 ? first.promise : Response.json(revisionView(true));
    }
    return fallback?.(url, init) as Promise<Response>;
  });
  await mount(<RevisionCounts />);
  expect(screen.getByText("Loading threads")).toBeTruthy();
  expect(signals).toHaveLength(1);
  expect(signals[0]?.aborted).toBe(false);
  server = { ...base, unsentCount: 0, pendingSend: true };
  fireEvent.click(button("Send 1"));
  await settle();
  expect(posts).toBe(1);
  expect(signals[0]?.aborted).toBe(true);
  expect(signals).toHaveLength(2);
  expect(screen.getByText("0 / 1 / 1")).toBeTruthy();
  first.resolve(Response.json(revisionView()));
  await settle();
  expect(screen.getByText("0 / 1 / 1")).toBeTruthy();
  expect(client.getQueryData(["revision", reviewId, 3])).toEqual(revisionView(true));
});

test.each(["Send", "Approve", "refused Send"])(
  "only an accepted Send marks pending user comments sent across cached revisions (%s)",
  async (action) => {
    const target = { kind: "file", path: "example.ts" } as const;
    const comments: RevisionView["threads"][number]["comments"] = [
      { id: "pending", author: "user", body: "Pending", sent: false, sentOn: null },
      { id: "sent", author: "user", body: "Already sent", sent: true, sentOn: 1 },
      { id: "agent", author: "agent", body: "Answer", sent: false, sentOn: null },
    ];
    const pending = {
      id: reviewId,
      target,
      createdOn: 1,
      state: "resolved" as const,
      placement: { status: "placed" as const, location: target },
      comments,
    };
    const cached: RevisionView = {
      seq: 1,
      base: null,
      head: null,
      main: null,
      writeupEmpty: true,
      writeup: { sections: [] },
      docs: [],
      files: [],
      topics: [],
      changedBlocks: [],
      threads: [
        pending,
        { ...pending, id: "answered", state: "answered", comments: comments.slice(1) },
        { ...pending, id: "agent-only", comments: comments.slice(2) },
      ],
    };
    for (const seq of [1, 2, 3]) client.setQueryData(["revision", reviewId, seq], { ...cached, seq });
    const otherId = "22222222-2222-4222-8222-222222222222";
    client.setQueryData(["revision", otherId, 1], cached);
    if (action === "Approve") server = { ...base, unsentCount: 0 };
    if (action === "refused Send")
      postAnswer = () => Response.json({ error: { code: "stale_revision", message: "Stale" } }, { status: 409 });
    await mount();
    mode = "hang";
    if (action === "Approve") approve("Approve revision 3");
    else fireEvent.click(button("Send 1"));
    await settle();
    expect(posts).toBe(1);
    for (const seq of [1, 2, 3]) {
      const view = client.getQueryData<RevisionView>(["revision", reviewId, seq]);
      expect(view).toEqual({
        ...cached,
        seq,
        threads:
          action === "Send"
            ? [
                {
                  ...pending,
                  state: "sent",
                  comments: [{ ...comments[0], sent: true, sentOn: 3 }, ...comments.slice(1)],
                },
                ...cached.threads.slice(1),
              ]
            : cached.threads,
      });
    }
    expect(client.getQueryData(["revision", otherId, 1])).toEqual(cached);
    expect(client.getQueryData(["revision", reviewId, 4])).toBeUndefined();
  },
);

test("a second Approve in the gap before the refetch lands sends nothing", async () => {
  server = { ...base, unsentCount: 0 };
  await mount();
  mode = "hang";
  approve("Approve revision 3");
  await settle();
  expect(posts).toBe(1);
  expect(button("Approved").disabled).toBe(true);
  fireEvent.click(button("Approved"));
  await settle();
  expect(posts).toBe(1);
});

test("after a successful approval focus moves to the bar's status, not to the page", async () => {
  server = { ...base, unsentCount: 0 };
  await mount();
  server = { ...server, state: "approved" };
  approve("Approve revision 3");
  await settle();
  expect(screen.queryByRole("alertdialog")).toBeNull();
  const bar = screen.getByRole("region", { name: "Send and approve" });
  expect(button("Approved").disabled).toBe(true);
  await settle(50);
  expect(document.activeElement).toBe(bar.querySelector("[tabindex='-1']"));
  expect(document.activeElement).not.toBe(document.body);
});

test("a second Send after closing the window, while the refetch hangs, sends nothing", async () => {
  await mount();
  mode = "hang";
  fireEvent.click(button("Send 1"));
  await settle();
  fireEvent.click(button("Close"));
  await settle();
  // The accepted Send cleared the unsent count in the cache: nothing is left to send.
  expect(button("Send").disabled).toBe(true);
  fireEvent.click(button("Send"));
  await settle();
  expect(posts).toBe(1);
});

test("a refused Send heals the stale bar and revision counts from the server", async () => {
  let revisionGets = 0;
  const fallback = vi.mocked(fetch).getMockImplementation();
  vi.mocked(fetch).mockImplementation(async (url, init) => {
    if (url === `/api/v1/reviews/${reviewId}/revisions/3`) {
      revisionGets += 1;
      return Response.json(revisionView(server.unsentCount === 0));
    }
    return fallback?.(url, init) as Promise<Response>;
  });
  await mount(<RevisionCounts />);
  expect(screen.getByText("1 / 1 / 1")).toBeTruthy();
  expect(revisionGets).toBe(1);
  server = { ...base, unsentCount: 0 };
  postAnswer = () => Response.json({ error: { code: "empty_send", message: "Nothing to send." } }, { status: 400 });
  fireEvent.click(button("Send 1"));
  await settle();
  expect(screen.getByRole("alert").textContent).toBe("Nothing to send.");
  expect(button("Send").disabled).toBe(true);
  expect(screen.queryByRole("button", { name: "Send 1" })).toBeNull();
  expect(revisionGets).toBe(2);
  expect(screen.getByText("0 / 1 / 1")).toBeTruthy();
});

test("a slow but successful inbox does not say the server cannot be reached", async () => {
  await mount(<SlowInbox />);
  fireEvent.click(button("Send 1"));
  await settle();
  await settle(HANDOFF_REFETCH_MS * 2);
  expect(screen.getByText(normalText)).toBeTruthy();
  expect(screen.queryByText(lostText)).toBeNull();
});

test("an HTTP error such as a 404 does not say the server cannot be reached", async () => {
  await mount();
  mode = "notfound";
  fireEvent.click(button("Send 1"));
  await settle();
  await settle(HANDOFF_REFETCH_MS * 2);
  expect(screen.getByText(normalText)).toBeTruthy();
  expect(screen.queryByText(lostText)).toBeNull();
});

test("a stalled review fetch says it, and a later success clears it", async () => {
  await mount();
  mode = "hang";
  fireEvent.click(button("Send 1"));
  await settle();
  await settle(HANDOFF_REFETCH_MS);
  expect(screen.getByText(lostText)).toBeTruthy();
  mode = "ok";
  await act(async () => {
    await client.invalidateQueries({ queryKey: ["review", reviewId] });
  });
  await settle();
  expect(screen.queryByText(lostText)).toBeNull();
  expect(screen.getByText(normalText)).toBeTruthy();
});

test("a network error says the server cannot be reached", async () => {
  await mount();
  mode = "network";
  fireEvent.click(button("Send 1"));
  await settle();
  expect(screen.getByText(lostText)).toBeTruthy();
});

test("the window's refetch joins the Send's own refetch instead of cancelling it", async () => {
  await mount();
  mode = "hang";
  const before = reviewGets;
  fireEvent.click(button("Send 1"));
  await settle();
  // The Send's background refetch started one fetch; the window's ask did not start another.
  expect(reviewGets).toBe(before + 1);
  await settle(HANDOFF_WAIT_MS);
  expect(reviewGets).toBe(before + 1);
});

test.each(["Send", "Approve"] as const)("a fetch that started before the accepted %s cannot undo it", async (kind) => {
  const before: ReviewView = {
    ...base,
    unsentCount: kind === "Send" ? 1 : 0,
    ...(kind === "Approve" ? { list: "snoozed", snoozed: true, snoozedUntil: "2026-11-05T09:00:00.000Z" } : {}),
  };
  server = before;
  serverOffset = 2 * 3_600_000;
  await mount(<Inbox />);
  const received = client.getQueryData<InboxData>(["inbox"]);
  expect(received).toMatchObject({
    serverTime: new Date(Date.now() + serverOffset).toISOString(),
    receivedAt: Date.now(),
    receivedMono: performance.now(),
  });
  mode = "held";
  act(() => {
    void client.invalidateQueries({ queryKey: ["review", reviewId] });
    void client.invalidateQueries({ queryKey: ["inbox"] });
  });
  await settle();
  const stale = [...held];
  expect(stale.map((fetch) => fetch.url).sort()).toEqual(["/api/v1/reviews", `/api/v1/reviews/${reviewId}`]);
  const activeUntil = new Date(Date.now() + serverOffset + APPROVED_ACTIVE_HOURS * 3_600_000).toISOString();
  if (kind === "Send") fireEvent.click(button("Send 1"));
  else approve("Approve revision 3");
  await settle();
  // Both stale fetches now answer with the data from before the write.
  for (const fetch of stale)
    fetch.resolve(
      Response.json(
        fetch.url === "/api/v1/reviews"
          ? { items: [before], serverTime: new Date(Date.now() + serverOffset).toISOString() }
          : before,
      ),
    );
  await settle();
  const accepted = (item: InboxItem | undefined) =>
    kind === "Send"
      ? [item?.unsentCount, item?.pendingSend]
      : [item?.state, item?.list, item?.snoozed, item?.snoozedUntil, item?.activeUntil];
  const expected = kind === "Send" ? [0, true] : ["approved", "active", false, null, activeUntil];
  expect(accepted(client.getQueryData<ReviewView>(["review", reviewId]))).toEqual(expected);
  expect(accepted(client.getQueryData<InboxData>(["inbox"])?.items[0])).toEqual(expected);
  expect(client.getQueryData<InboxData>(["inbox"])).toMatchObject({
    receivedAt: received?.receivedAt,
    receivedMono: received?.receivedMono,
    serverTime: received?.serverTime,
  });
  // The background refetch then brings the server's own data.
  const after =
    kind === "Send"
      ? { ...before, unsentCount: 0, pendingSend: true }
      : {
          ...before,
          state: "approved" as const,
          list: "active" as const,
          snoozed: false,
          snoozedUntil: null,
          activeUntil: "2026-11-05T21:00:00.000Z",
        };
  for (const fetch of held.filter((item) => !stale.includes(item)))
    fetch.resolve(
      Response.json(
        fetch.url === "/api/v1/reviews"
          ? { items: [after], serverTime: new Date(Date.now() + serverOffset).toISOString() }
          : after,
      ),
    );
  await settle();
  expect(client.getQueryData<ReviewView>(["review", reviewId])).toMatchObject(after);
});

test("a manual cache write does not clear the connection-lost wording; a real fetch does", async () => {
  await mount();
  mode = "hang";
  fireEvent.click(button("Send 1"));
  await settle();
  await settle(HANDOFF_REFETCH_MS);
  expect(screen.getByText(lostText)).toBeTruthy();
  // The accepted-write update and any other manual write are not evidence of a reachable server.
  act(() => {
    client.setQueryData(["review", reviewId], { ...server, unsentCount: 0, pendingSend: true });
  });
  await settle();
  expect(screen.getByText(lostText)).toBeTruthy();
  mode = "ok";
  await act(async () => {
    await client.invalidateQueries({ queryKey: ["review", reviewId] });
  });
  await settle();
  expect(screen.queryByText(lostText)).toBeNull();
});
