// Only keys that scroll the pane count as reader input, and not while typing in a text field.
const scrollKeys = new Set(["PageUp", "PageDown", "Home", "End", "ArrowUp", "ArrowDown", " "]);
const textEntry = 'input, textarea, select, [contenteditable]:not([contenteditable="false"])';

export function onReaderInput(pane: HTMLElement, onInput: () => void): () => void {
  const onKey = (event: KeyboardEvent) => {
    if (event.defaultPrevented || !scrollKeys.has(event.key)) return;
    const target = event.target;
    // Keys aimed at another pane, the inbox or a control elsewhere do not scroll this pane.
    if (!(target instanceof Node) || (target !== document.body && !pane.contains(target))) return;
    if (target instanceof HTMLElement && target.closest(textEntry)) return;
    onInput();
  };
  const events = ["wheel", "touchstart", "touchmove", "pointerdown"] as const;
  for (const event of events) pane.addEventListener(event, onInput, { passive: true });
  window.addEventListener("keydown", onKey);
  return () => {
    for (const event of events) pane.removeEventListener(event, onInput);
    window.removeEventListener("keydown", onKey);
  };
}
