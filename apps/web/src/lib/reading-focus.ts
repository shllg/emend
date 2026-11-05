let movingFocus: HTMLElement | null = null;

/** Navigation and restore move focus without treating their synchronous focusin as reader input. */
export function focusReadingTarget(element: HTMLElement | null | undefined) {
  if (!element) return;
  const previous = movingFocus;
  movingFocus = element;
  try {
    element.focus({ preventScroll: true });
  } finally {
    movingFocus = previous;
  }
}

export function isReadingFocusMove(element: Element | null) {
  return element !== null && element === movingFocus;
}
