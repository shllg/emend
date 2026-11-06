import { vi } from "vitest";

/** Deliver intersections explicitly, independently of layout, clocks, or scrolling. */
export function stubIntersectionObserver() {
  const observed = new Map<Element, (isIntersecting: boolean) => void>();
  const options: (IntersectionObserverInit | undefined)[] = [];
  vi.stubGlobal(
    "IntersectionObserver",
    class {
      private callback: IntersectionObserverCallback;
      private targets = new Set<Element>();
      constructor(callback: IntersectionObserverCallback, init?: IntersectionObserverInit) {
        this.callback = callback;
        options.push(init);
      }
      observe(target: Element) {
        this.targets.add(target);
        observed.set(target, (isIntersecting) =>
          this.callback(
            [{ target, isIntersecting } as IntersectionObserverEntry],
            this as unknown as IntersectionObserver,
          ),
        );
      }
      unobserve(target: Element) {
        this.targets.delete(target);
        observed.delete(target);
      }
      disconnect() {
        for (const target of this.targets) observed.delete(target);
        this.targets.clear();
      }
    },
  );
  return {
    options,
    intersect(target: Element | null, isIntersecting = true) {
      if (!target || !observed.has(target)) throw new Error("Missing observed element");
      observed.get(target)?.(isIntersecting);
    },
  };
}
