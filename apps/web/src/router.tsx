import { FilePath } from "@emend/contract";
import { createRootRoute, createRoute, createRouter, Link, Outlet, type RouterHistory } from "@tanstack/react-router";
import { cancelThreadActionFocus } from "./lib/thread-action-focus.ts";
import { DevicesPage } from "./routes/devices.tsx";
import { InboxPage } from "./routes/inbox.tsx";
import { PairPage } from "./routes/pair.tsx";
import { PairDevicePage } from "./routes/pair-device.tsx";
import { ReviewPage } from "./routes/review.tsx";

export type ReviewSearch = {
  rev?: number;
  tab?: "writeup" | "files" | "diff" | "docs" | "comments";
  thread?: string;
  doc?: string;
  view?: "reading" | "original";
};
export function validateReviewSearch(input: Record<string, unknown>): ReviewSearch {
  const rev = typeof input.rev === "string" || typeof input.rev === "number" ? Number(input.rev) : NaN;
  const tab =
    input.tab === "writeup" ||
    input.tab === "files" ||
    input.tab === "diff" ||
    input.tab === "docs" ||
    input.tab === "comments"
      ? input.tab
      : undefined;
  return {
    tab,
    view: input.view === "reading" || input.view === "original" ? input.view : undefined,
    // Router merges validation over the raw search: explicitly clear rejected values.
    rev: Number.isSafeInteger(rev) && rev > 0 ? rev : undefined,
    doc: FilePath.safeParse(input.doc).data,
    thread:
      typeof input.thread === "string" && /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i.test(input.thread)
        ? input.thread
        : undefined,
  };
}
const root = createRootRoute({
  component: Outlet,
  notFoundComponent: () => (
    <main className="p-6">
      <h1>Page not found</h1>
      <Link to="/">Inbox</Link>
    </main>
  ),
});
const inbox = createRoute({ getParentRoute: () => root, path: "/", component: InboxPage });
const review = createRoute({
  getParentRoute: () => root,
  path: "/r/$reviewId",
  validateSearch: validateReviewSearch,
  component: ReviewPage,
});
const pair = createRoute({ getParentRoute: () => root, path: "/pair", component: PairPage });
const devices = createRoute({ getParentRoute: () => root, path: "/devices", component: DevicesPage });
const pairDevice = createRoute({ getParentRoute: () => devices, path: "pair", component: PairDevicePage });
export const createWebRouter = (history?: RouterHistory) => {
  const router = createRouter({
    routeTree: root.addChildren([inbox, review, pair, devices.addChildren([pairDevice])]),
    history,
    search: { strict: true },
  });
  router.subscribe("onBeforeNavigate", cancelThreadActionFocus);
  // Initialize with default (uncached) scrolling. Passing a predicate to the
  // constructor enables the cache even when it returns false for some routes.
  // This version has no route-level switch; navigation flags miss direct URLs
  // and history traversal. The runtime predicate suppresses only review scrolls.
  router.update({ scrollRestoration: ({ location }) => !/^\/r\/[^/]+\/?$/.test(location.pathname) });
  return router;
};
declare module "@tanstack/react-router" {
  interface Register {
    router: ReturnType<typeof createWebRouter>;
  }
}
