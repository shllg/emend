import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { type RouterHistory, RouterProvider, useRouterState } from "@tanstack/react-router";
import { type ReactNode, useState } from "react";
import { ToastProvider } from "./components/ui/Toast.tsx";
import { TooltipProvider } from "./components/ui/Tooltip.tsx";
import { ReviewEventsProvider } from "./lib/events.tsx";
import { InboxViewProvider } from "./lib/inbox-view.tsx";
import { createWebRouter } from "./router.tsx";

function AppEvents({ children }: { children: ReactNode }) {
  const pairing = useRouterState({ select: (state) => /^\/pair\/?$/i.test(state.location.pathname) });
  // An unauthenticated EventSource gets a terminal 401; start after pairing instead.
  return <ReviewEventsProvider enabled={!pairing}>{children}</ReviewEventsProvider>;
}

export function App({ queryClient, history }: { queryClient?: QueryClient; history?: RouterHistory } = {}) {
  const [client] = useState(() => queryClient ?? new QueryClient({ defaultOptions: { queries: { retry: false } } }));
  const [router] = useState(() => createWebRouter(history));
  return (
    <QueryClientProvider client={client}>
      <TooltipProvider>
        <ToastProvider>
          <InboxViewProvider>
            <RouterProvider router={router} InnerWrap={AppEvents} />
          </InboxViewProvider>
        </ToastProvider>
      </TooltipProvider>
    </QueryClientProvider>
  );
}
