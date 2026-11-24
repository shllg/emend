export const overlayClass = "fixed inset-0 z-(--z-sheet) animate-[em-fade_var(--dur-2)_var(--ease-out)] bg-overlay";

export function isToastInteraction(event: Event) {
  return event.target instanceof Element && event.target.closest("[data-recense-toast]") !== null;
}
