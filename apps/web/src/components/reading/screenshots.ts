import { type RefObject, useCallback, useLayoutEffect, useState } from "react";

// A discriminant leaves room for another visual kind without treating arbitrary HTML as an image.
export type LightboxItem = {
  kind: "image";
  src: string;
  caption: string;
  blockId: string;
  element: HTMLImageElement;
};
export type ScreenshotGallery = { items: LightboxItem[]; index: number };

function screenshot(element: EventTarget | null, root: HTMLElement): LightboxItem | undefined {
  if (!(element instanceof HTMLImageElement) || !root.contains(element)) return;
  const wrapper = element.parentElement;
  const block = element.closest<HTMLElement>("[data-block-id]");
  const src = element.getAttribute("src");
  if (
    !wrapper?.matches("span.emend-media") ||
    !block ||
    !root.contains(block) ||
    !src ||
    src !== src.trim() ||
    !/^\/api\/v1\/media\/[0-9a-f]{64}$/.test(src)
  )
    return;
  const caption =
    wrapper.querySelector(":scope > .emend-media-caption")?.textContent?.trim() || element.alt.trim() || "Screenshot";
  return { kind: "image", src, caption, blockId: block.dataset.blockId ?? "", element };
}

function collect(root: HTMLElement) {
  // Include folded groups: the gallery follows all screenshots in writeup order.
  return [...root.querySelectorAll("span.emend-media > img")].flatMap((image) => {
    const item = screenshot(image, root);
    return item ? [item] : [];
  });
}

export function useScreenshots(root: RefObject<HTMLElement | null>, onOpen: () => void) {
  const [gallery, setGallery] = useState<ScreenshotGallery | null>(null);
  // BlockView can replace its HTML without changing the block id or the groups' identity.
  useLayoutEffect(() => {
    const element = root.current;
    if (!element) return;
    for (const item of collect(element)) {
      item.element.tabIndex = 0;
      item.element.setAttribute("role", "button");
      item.element.setAttribute("aria-haspopup", "dialog");
      item.element.setAttribute("aria-label", `Open screenshot: ${item.caption}`);
    }
    const activate = (event: MouseEvent | KeyboardEvent) => {
      if (event.defaultPrevented || event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;
      if (event instanceof KeyboardEvent && (event.repeat || (event.key !== "Enter" && event.key !== " "))) return;
      if (!screenshot(event.target, element)) return;
      event.preventDefault();
      const items = collect(element);
      const index = items.findIndex((item) => item.element === event.target);
      if (index < 0) return;
      window.getSelection()?.removeAllRanges();
      onOpen();
      setGallery({ items, index });
    };
    element.addEventListener("click", activate);
    element.addEventListener("keydown", activate);
    return () => {
      element.removeEventListener("click", activate);
      element.removeEventListener("keydown", activate);
    };
  });
  const closeGallery = useCallback(() => setGallery(null), []);
  return { gallery, closeGallery };
}
