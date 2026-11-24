/** Open mounted writeup content before any hash, search, map or thread navigation scrolls to it. */
export function revealReadingTarget(element: HTMLElement) {
  for (let ancestor: HTMLElement | null = element; ancestor; ancestor = ancestor.parentElement) {
    if (ancestor instanceof HTMLDetailsElement) ancestor.open = true;
  }
  element.dispatchEvent(new Event("recense:reveal-reading", { bubbles: true }));
}
