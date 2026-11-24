import type { RevisionView, ViewedRequest } from "@recense/contract";
import { QueryClient, QueryClientProvider, useQuery } from "@tanstack/react-query";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { refreshQueries } from "../lib/query-refresh.ts";
import { useViewedCollapse } from "../lib/viewed-collapse.ts";
import { useViewedErrors, useViewedMutation, useViewedRevision } from "./mutations.ts";
import { revisionQuery } from "./queries.ts";

const id = "11111111-1111-4111-8111-111111111111";
const initial: RevisionView = {
  seq: 1,
  base: null,
  head: null,
  main: null,
  writeupEmpty: true,
  topics: [],
  docs: [],
  writeup: { sections: [] },
  threads: [],
  changedBlocks: [],
  files: ["a.ts", "b.ts"].map((path, order) => ({
    id: crypto.randomUUID(),
    path,
    order,
    oldPath: null,
    topic: null,
    role: "diff",
    status: "modified",
    mediaType: "text/plain",
    flag: null,
    hasOld: true,
    hasNew: true,
  })),
};
let client: QueryClient;
let calls: { body: ViewedRequest; reply: (success?: boolean) => void; commit: () => void }[];
let server: Set<string>;
let holdGets: boolean;
let reads: { snapshot: RevisionView; reply: () => void }[];
let fetcher: ReturnType<typeof vi.fn>;
const fromServer = () => ({
  ...initial,
  files: initial.files.map((file) => ({
    ...file,
    ...(server.has(file.path) ? { viewed: "viewed" as const, viewedOn: 1 } : {}),
  })),
});
beforeEach(() => {
  client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  client.setQueryData(revisionQuery(id, 1).queryKey, initial);
  calls = [];
  server = new Set();
  holdGets = false;
  reads = [];
  fetcher = vi.fn(async (_path: string, init?: RequestInit) => {
    if (init?.method !== "PUT") {
      const snapshot = fromServer();
      if (!holdGets) return Response.json(snapshot);
      return new Promise<Response>((resolve) =>
        reads.push({ snapshot, reply: () => resolve(Response.json(snapshot)) }),
      );
    }
    const body = JSON.parse(String(init.body)) as ViewedRequest;
    let committed = false;
    const commit = () => {
      if (committed) return;
      committed = true;
      for (const path of body.paths) {
        if (body.viewed) server.add(path);
        else server.delete(path);
      }
    };
    return new Promise<Response>((resolve) =>
      calls.push({
        body,
        commit,
        reply: (success = true) => {
          if (success) commit();
          resolve(
            success
              ? new Response(null, { status: 204 })
              : Response.json({ error: { code: "invalid_request", message: "Failed" } }, { status: 400 }),
          );
        },
      }),
    );
  });
  vi.stubGlobal("fetch", fetcher);
});
afterEach(() => {
  cleanup();
  client.clear();
  vi.restoreAllMocks();
});
function Files({ view, mark }: { view: RevisionView; mark: (body: ViewedRequest) => void }) {
  const [collapsed, setCollapsed] = useViewedCollapse(id, view);
  return (
    <>
      <button
        type="button"
        onClick={() => mark({ revision: view.seq, paths: view.files.map((file) => file.path), viewed: true })}
      >
        Mark topic
      </button>
      {view.files.map((file) => (
        <div key={file.id}>
          <button
            type="button"
            aria-label={`Viewed ${file.path}`}
            aria-pressed={file.viewed === "viewed"}
            onClick={() => mark({ revision: view.seq, paths: [file.path], viewed: file.viewed !== "viewed" })}
          >
            {file.path}
          </button>
          <button
            type="button"
            aria-label={`Fold ${file.path}`}
            aria-pressed={collapsed.has(file.id)}
            onClick={() =>
              setCollapsed((previous) => {
                const next = new Set(previous);
                if (next.has(file.id)) next.delete(file.id);
                else next.add(file.id);
                return next;
              })
            }
          >
            Fold
          </button>
        </div>
      ))}
    </>
  );
}
function Page() {
  const query = useQuery(revisionQuery(id, 1));
  const view = useViewedRevision(id, query.data);
  const mutation = useViewedMutation(id);
  const errors = useViewedErrors(id);
  return (
    <>
      {errors.errors.map((failure) => (
        <div role="alert" key={failure.id}>
          {failure.error?.message}: {failure.failedPaths?.join(", ")}
          <button type="button" onClick={() => errors.dismiss(failure.id)}>
            Dismiss
          </button>
        </div>
      ))}
      {view && <Files view={view} mark={mutation.mutate} />}
    </>
  );
}
const mount = () =>
  render(
    <QueryClientProvider client={client}>
      <Page />
    </QueryClientProvider>,
  );
const viewed = (path: string) => screen.getByRole("button", { name: `Viewed ${path}` });
const fold = (path: string) => screen.getByRole("button", { name: `Fold ${path}` });
const pressed = (button: HTMLElement) => button.getAttribute("aria-pressed");

test("a slow topic mark and later unmark serialize across unmount/remount with immediate queued optimism", async () => {
  const invalidate = vi.spyOn(client, "invalidateQueries");
  const first = mount();
  fireEvent.click(screen.getByRole("button", { name: "Mark topic" }));
  await waitFor(() => expect(calls).toHaveLength(1));
  expect(pressed(viewed("a.ts"))).toBe("true");
  expect(pressed(viewed("b.ts"))).toBe("true");
  expect(viewed("b.ts").hasAttribute("disabled")).toBe(false);
  first.unmount();
  mount();
  expect(pressed(viewed("a.ts"))).toBe("true");
  fireEvent.click(viewed("a.ts"));
  await waitFor(() => expect(pressed(viewed("a.ts"))).toBe("false"));
  expect(calls).toHaveLength(1);
  expect(pressed(viewed("b.ts"))).toBe("true");
  await act(async () => calls[0]?.reply());
  await waitFor(() => expect(calls).toHaveLength(2));
  expect(calls.map(({ body }) => body)).toEqual([
    { revision: 1, paths: ["a.ts", "b.ts"], viewed: true },
    { revision: 1, paths: ["a.ts"], viewed: false },
  ]);
  // A live event can fetch the first committed state while the next PUT is pending.
  act(() => client.setQueryData(revisionQuery(id, 1).queryKey, fromServer()));
  expect(pressed(viewed("a.ts"))).toBe("false");
  await act(async () => calls[1]?.reply());
  await waitFor(() => expect(client.isMutating()).toBe(0));
  expect(server).toEqual(new Set(["b.ts"]));
  expect(pressed(viewed("a.ts"))).toBe("false");
  await waitFor(() => expect(client.getQueryData(revisionQuery(id, 1).queryKey)?.files[0]?.viewed).toBeUndefined());
  expect(invalidate).toHaveBeenCalledExactlyOnceWith({ queryKey: ["revision", id] });
});

test("a failed earlier action rolls back without erasing a later queued mark", async () => {
  const invalidate = vi.spyOn(client, "invalidateQueries");
  mount();
  fireEvent.click(screen.getByRole("button", { name: "Mark topic" }));
  await waitFor(() => expect(calls).toHaveLength(1));
  fireEvent.click(viewed("a.ts"));
  await waitFor(() => expect(pressed(viewed("a.ts"))).toBe("false"));
  fireEvent.click(viewed("a.ts"));
  await waitFor(() => expect(pressed(viewed("a.ts"))).toBe("true"));
  expect(calls).toHaveLength(1);
  await act(async () => calls[0]?.reply(false));
  await waitFor(() => expect(calls).toHaveLength(2));
  await waitFor(() => expect(pressed(viewed("b.ts"))).toBe("false"));
  expect(pressed(viewed("a.ts"))).toBe("true");
  expect(pressed(fold("b.ts"))).toBe("false");
  await act(async () => calls[1]?.reply());
  await waitFor(() => expect(calls).toHaveLength(3));
  expect(pressed(viewed("a.ts"))).toBe("true");
  await act(async () => calls[2]?.reply());
  await waitFor(() => expect(client.isMutating()).toBe(0));
  expect(server).toEqual(new Set(["a.ts"]));
  await waitFor(() => expect(invalidate).toHaveBeenCalledExactlyOnceWith({ queryKey: ["revision", id] }));
});

test("local folds respect manual expansion while pending, and unmarking Viewed expands the file", async () => {
  mount();
  fireEvent.click(viewed("a.ts"));
  await waitFor(() => expect(calls).toHaveLength(1));
  expect(pressed(fold("a.ts"))).toBe("true");
  fireEvent.click(fold("a.ts"));
  expect(pressed(fold("a.ts"))).toBe("false");
  await act(async () => calls[0]?.reply());
  await waitFor(() => expect(client.isMutating()).toBe(0));
  expect(pressed(fold("a.ts"))).toBe("false");
  fireEvent.click(fold("a.ts"));
  fireEvent.click(viewed("a.ts"));
  await waitFor(() => expect(calls).toHaveLength(2));
  expect(calls[1]?.body.viewed).toBe(false);
  expect(pressed(fold("a.ts"))).toBe("false");
  await act(async () => calls[1]?.reply());
  await waitFor(() => expect(client.isMutating()).toBe(0));
  expect(pressed(fold("a.ts"))).toBe("false");
});

test("unmarking while the mark request is pending leaves the file expanded after both resolve", async () => {
  mount();
  fireEvent.click(viewed("a.ts"));
  await waitFor(() => expect(calls).toHaveLength(1));
  expect(pressed(fold("a.ts"))).toBe("true");
  fireEvent.click(viewed("a.ts"));
  await waitFor(() => expect(pressed(viewed("a.ts"))).toBe("false"));
  expect(pressed(fold("a.ts"))).toBe("false");
  await act(async () => calls[0]?.reply());
  await waitFor(() => expect(calls).toHaveLength(2));
  expect(pressed(fold("a.ts"))).toBe("false");
  await act(async () => calls[1]?.reply());
  await waitFor(() => expect(client.isMutating()).toBe(0));
  expect(calls.map(({ body }) => body.viewed)).toEqual([true, false]);
  expect(pressed(fold("a.ts"))).toBe("false");
});

test("a fold made by hand on another file survives a Viewed unmark", async () => {
  server.add("a.ts");
  client.setQueryData(revisionQuery(id, 1).queryKey, fromServer());
  mount();
  expect(pressed(fold("a.ts"))).toBe("true");
  fireEvent.click(fold("b.ts"));
  fireEvent.click(viewed("a.ts"));
  await waitFor(() => expect(calls).toHaveLength(1));
  expect(pressed(fold("a.ts"))).toBe("false");
  expect(pressed(fold("b.ts"))).toBe("true");
  await act(async () => calls[0]?.reply());
  await waitFor(() => expect(client.isMutating()).toBe(0));
  expect(pressed(fold("a.ts"))).toBe("false");
  expect(pressed(fold("b.ts"))).toBe("true");
});

test("initial and switched revisions collapse viewed files while remote marks preserve current folds", () => {
  const revision = (seq: number, marked: string): RevisionView => ({
    ...initial,
    seq,
    files: initial.files.map((file) => ({
      ...file,
      ...(file.path === marked ? { viewed: "viewed", viewedOn: seq } : {}),
    })),
  });
  const show = (view: RevisionView) => {
    client.setQueryData(revisionQuery(id, view.seq).queryKey, view);
    return (
      <QueryClientProvider client={client}>
        <Files view={view} mark={vi.fn()} />
      </QueryClientProvider>
    );
  };
  const page = render(show(revision(1, "a.ts")));
  expect(pressed(fold("a.ts"))).toBe("true");
  expect(pressed(fold("b.ts"))).toBe("false");
  fireEvent.click(fold("a.ts"));
  page.rerender(show(revision(1, "b.ts")));
  expect(pressed(viewed("b.ts"))).toBe("true");
  expect(pressed(fold("a.ts"))).toBe("false");
  expect(pressed(fold("b.ts"))).toBe("false");
  page.rerender(show(revision(2, "b.ts")));
  expect(pressed(fold("a.ts"))).toBe("false");
  expect(pressed(fold("b.ts"))).toBe("true");
});

test("a pre-unmark fetch resolving after that write cannot erase its overlay", async () => {
  server.add("b.ts");
  client.setQueryData(revisionQuery(id, 1).queryKey, fromServer());
  holdGets = true;
  mount();
  fireEvent.click(viewed("a.ts"));
  await waitFor(() => expect(calls).toHaveLength(1));
  await act(async () => calls[0]?.reply());
  await waitFor(() => expect(reads).toHaveLength(1));
  fireEvent.click(viewed("b.ts"));
  await waitFor(() => expect(calls).toHaveLength(2));
  await act(async () => calls[1]?.reply());
  await act(async () => reads[0]?.reply());
  expect(client.getQueryData(revisionQuery(id, 1).queryKey)?.files[1]?.viewed).toBe("viewed");
  expect(pressed(viewed("b.ts"))).toBe("false");
  await waitFor(() => expect(reads).toHaveLength(2));
  await act(async () => reads[1]?.reply());
  await waitFor(() => expect(client.getQueryData(revisionQuery(id, 1).queryKey)?.files[1]?.viewed).toBeUndefined());
  expect(pressed(viewed("a.ts"))).toBe("true");
  expect(pressed(viewed("b.ts"))).toBe("false");
});

test("a delayed PUT response cannot overwrite a newer remote unmark in the revision cache", async () => {
  holdGets = true;
  mount();
  const writeCache = vi.spyOn(client, "setQueryData");
  fireEvent.click(viewed("a.ts"));
  await waitFor(() => expect(calls).toHaveLength(1));
  calls[0]?.commit();
  server.delete("a.ts"); // Another device writes while this response is delayed.
  refreshQueries(client, [["revision", id]]);
  await waitFor(() => expect(reads).toHaveLength(1));
  await act(async () => reads[0]?.reply());
  await act(async () => calls[0]?.reply());
  expect(client.getQueryData(revisionQuery(id, 1).queryKey)?.files[0]?.viewed).toBeUndefined();
  expect(pressed(viewed("a.ts"))).toBe("true");
  expect(writeCache).not.toHaveBeenCalled();
  await waitFor(() => expect(reads).toHaveLength(2));
  await act(async () => reads[1]?.reply());
  await waitFor(() => expect(pressed(viewed("a.ts"))).toBe("false"));
  expect(server.has("a.ts")).toBe(false);
});

test("a burst of successful writes and viewed events coalesces into one revision fetch", async () => {
  fetcher.mockImplementation(async (_path: string, init?: RequestInit) => {
    if (init?.method !== "PUT") return Response.json(fromServer());
    for (const path of (JSON.parse(String(init.body)) as ViewedRequest).paths) server.add(path);
    refreshQueries(client, [["revision", id]]);
    return new Response(null, { status: 204 });
  });
  mount();
  for (let i = 0; i < 10; i++) fireEvent.click(screen.getByRole("button", { name: "Mark topic" }));
  await waitFor(() => expect(fetcher.mock.calls.filter(([, init]) => init?.method === "PUT")).toHaveLength(10));
  await waitFor(() => expect(fetcher.mock.calls.filter(([, init]) => init?.method !== "PUT")).toHaveLength(1));
  expect(pressed(viewed("a.ts"))).toBe("true");
  expect(client.getQueryData(revisionQuery(id, 1).queryKey)?.files[0]?.viewed).toBe("viewed");
});

test.each(["dismiss", "retry"])(
  "an earlier failure remains visible after another success and remount until %s",
  async (action) => {
    const page = mount();
    fireEvent.click(viewed("a.ts"));
    await waitFor(() => expect(calls).toHaveLength(1));
    fireEvent.click(viewed("b.ts"));
    await act(async () => calls[0]?.reply(false));
    await waitFor(() => expect(calls).toHaveLength(2));
    await act(async () => calls[1]?.reply());
    await waitFor(() => expect(pressed(viewed("a.ts"))).toBe("false"));
    expect(screen.getByRole("alert").textContent).toContain("Failed: a.ts");
    page.unmount();
    mount();
    expect(screen.getByRole("alert").textContent).toContain("Failed: a.ts");
    if (action === "dismiss") fireEvent.click(screen.getByRole("button", { name: "Dismiss" }));
    else {
      fireEvent.click(viewed("a.ts"));
      await waitFor(() => expect(calls).toHaveLength(3));
      await act(async () => calls[2]?.reply());
    }
    await waitFor(() => expect(screen.queryByRole("alert")).toBeNull());
  },
);

test("a pending mark remains a temporary fold across remount and unfolds on failure", async () => {
  const page = mount();
  fireEvent.click(viewed("a.ts"));
  await waitFor(() => expect(calls).toHaveLength(1));
  expect(pressed(fold("a.ts"))).toBe("true");
  page.unmount();
  mount();
  expect(pressed(fold("a.ts"))).toBe("true");
  await act(async () => calls[0]?.reply(false));
  await waitFor(() => expect(pressed(viewed("a.ts"))).toBe("false"));
  expect(pressed(fold("a.ts"))).toBe("false");
});
