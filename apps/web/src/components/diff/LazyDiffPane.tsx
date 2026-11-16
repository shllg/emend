import { Component, type ComponentType, lazy, type ReactNode, Suspense, useState } from "react";
import { Button } from "../ui/Button.tsx";
import type { DiffPaneProps } from "./DiffPane.tsx";

const loadDiff = () => import("./DiffPane.tsx");
type Loader = () => Promise<{ default: ComponentType<DiffPaneProps> }>;
class PaneBoundary extends Component<
  { children: ReactNode; retry: () => void; retried: boolean },
  { failed: boolean }
> {
  state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  render() {
    return this.state.failed ? (
      <div className="space-y-3 p-5">
        <p role="alert">Could not load the diff.</p>
        <Button onClick={this.props.retry}>Retry</Button>
        {this.props.retried && <Button onClick={() => window.location.reload()}>Reload the page</Button>}
      </div>
    ) : (
      this.props.children
    );
  }
}
export function LazyDiffPane({
  load = loadDiff,
  focusBar,
  ...props
}: DiffPaneProps & { load?: Loader; focusBar?: ReactNode }) {
  const [attempt, setAttempt] = useState(() => ({ Pane: lazy(load), number: 0 }));
  const Pane = attempt.Pane;
  return (
    <>
      {focusBar}
      <PaneBoundary
        key={attempt.number}
        retried={attempt.number > 0}
        retry={() => setAttempt({ Pane: lazy(load), number: attempt.number + 1 })}
      >
        <Suspense
          fallback={
            <p role="status" className="p-5">
              Loading diff…
            </p>
          }
        >
          <Pane {...props} />
        </Suspense>
      </PaneBoundary>
    </>
  );
}
