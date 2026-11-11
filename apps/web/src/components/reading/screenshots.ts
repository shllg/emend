import { type RefObject, useCallback, useLayoutEffect, useState } from "react";

export type LightboxItem =
  | {
      kind: "image";
      src: string;
      caption: string;
      blockId: string;
      element: HTMLImageElement;
    }
  | { kind: "diagram"; source: string; blockId: string; element: HTMLButtonElement };
export type ScreenshotGallery = { items: LightboxItem[]; index: number };
type DiagramSource = (blockId: string) => string | undefined;

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

function diagram(
  element: EventTarget | null,
  root: HTMLElement,
  diagramSource: DiagramSource,
): LightboxItem | undefined {
  if (
    !(element instanceof HTMLButtonElement) ||
    !element.matches("button[data-lightbox-diagram]") ||
    !root.contains(element)
  )
    return;
  const block = element.closest<HTMLElement>("[data-block-id]");
  if (!block || !root.contains(block) || block.dataset.blockKind !== "diagram") return;
  const blockId = block.dataset.blockId ?? "";
  const source = diagramSource(blockId);
  if (typeof source !== "string") return;
  return { kind: "diagram", source, blockId, element };
}

function collect(root: HTMLElement, diagramSource: DiagramSource) {
  // Include folded groups: the gallery follows all screenshots and diagrams in reading order.
  return [...root.querySelectorAll("span.emend-media > img, button[data-lightbox-diagram]")].flatMap((element) => {
    const item = screenshot(element, root) ?? diagram(element, root, diagramSource);
    return item ? [item] : [];
  });
}

export function useScreenshots(root: RefObject<HTMLElement | null>, onOpen: () => void, diagramSource: DiagramSource) {
  const [gallery, setGallery] = useState<ScreenshotGallery | null>(null);
  // BlockView can replace its HTML without changing the block id or the groups' identity.
  useLayoutEffect(() => {
    const element = root.current;
    if (!element) return;
    for (const item of collect(element, diagramSource)) {
      if (item.kind !== "image") continue;
      item.element.tabIndex = 0;
      item.element.setAttribute("role", "button");
      item.element.setAttribute("aria-haspopup", "dialog");
      item.element.setAttribute("aria-label", `Open screenshot: ${item.caption}`);
    }
    const activate = (event: MouseEvent | KeyboardEvent) => {
      if (event.defaultPrevented || event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;
      if (event instanceof KeyboardEvent && (event.repeat || (event.key !== "Enter" && event.key !== " "))) return;
      const item =
        screenshot(event.target, element) ??
        (event.type === "click" && event.target instanceof Element
          ? diagram(event.target.closest("button[data-lightbox-diagram]"), element, diagramSource)
          : undefined);
      if (!item) return;
      event.preventDefault();
      const items = collect(element, diagramSource);
      const index = items.findIndex((entry) => entry.element === item.element);
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
