import * as Primitive from "@radix-ui/react-dialog";
import { ChevronLeft, ChevronRight, MessageSquarePlus, Minus, Plus, X } from "lucide-react";
import { type RefObject, useCallback, useRef, useState } from "react";
import { isAtFit, maxScale, type Size } from "../../lib/lightbox-view.ts";
import { Button } from "../ui/Button.tsx";
import { IconButton } from "../ui/IconButton.tsx";
import { isToastInteraction } from "../ui/overlay.ts";
import { LightboxDiagram } from "./MermaidBlock.tsx";
import type { LightboxItem, ScreenshotGallery } from "./screenshots.ts";
import { useLightboxView } from "./use-lightbox-view.ts";

export function Lightbox({
  gallery,
  onClose,
  canComment,
  onComment,
}: {
  gallery: ScreenshotGallery;
  onClose: () => void;
  canComment: (item: LightboxItem) => boolean;
  onComment: (item: LightboxItem) => void;
}) {
  const [index, setIndex] = useState(gallery.index);
  const item = gallery.items[index];
  const opener = useRef<HTMLElement | null>(null);
  const closeButton = useRef<HTMLButtonElement>(null);
  const commenting = useRef(false);
  const step = useCallback(
    (delta: number) => setIndex((value) => Math.max(0, Math.min(gallery.items.length - 1, value + delta))),
    [gallery.items.length],
  );
  const imageView = useLightboxView(item, step, onClose);
  if (!item) return null;
  return (
    <Primitive.Root
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <Primitive.Portal>
        <Primitive.Overlay className="fixed inset-0 z-(--z-sheet) bg-app" />
        <Primitive.Content
          aria-modal="true"
          className="fixed inset-0 z-[calc(var(--z-sheet)+1)] flex flex-col overflow-hidden bg-app text-fg-1 pt-[env(safe-area-inset-top)] pr-[env(safe-area-inset-right)] pb-[env(safe-area-inset-bottom)] pl-[env(safe-area-inset-left)]"
          onInteractOutside={(event) => {
            if (isToastInteraction(event)) event.preventDefault();
          }}
          onOpenAutoFocus={(event) => {
            event.preventDefault();
            opener.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
            closeButton.current?.focus({ preventScroll: true });
          }}
          onCloseAutoFocus={(event) => {
            event.preventDefault();
            // FocusScope restores asynchronously; a newly mounted composer must keep its focus.
            if (!commenting.current && opener.current?.isConnected) opener.current.focus({ preventScroll: true });
          }}
          onKeyDown={(event) => {
            if (imageView.arrow(event.key)) event.preventDefault();
          }}
        >
          <LightboxImage
            item={item}
            imageView={imageView}
            index={index}
            count={gallery.items.length}
            galleryNoun={
              gallery.items.every((item) => item.kind === "image")
                ? "screenshot"
                : gallery.items.every((item) => item.kind === "diagram")
                  ? "diagram"
                  : undefined
            }
            closeButton={closeButton}
            onStep={step}
            onComment={
              canComment(item)
                ? () => {
                    commenting.current = true;
                    onClose();
                    onComment(item);
                  }
                : undefined
            }
          />
        </Primitive.Content>
      </Primitive.Portal>
    </Primitive.Root>
  );
}

function LightboxImage({
  item,
  imageView,
  index,
  count,
  galleryNoun,
  closeButton,
  onStep,
  onComment,
}: {
  item: LightboxItem;
  imageView: ReturnType<typeof useLightboxView>;
  index: number;
  count: number;
  galleryNoun?: "screenshot" | "diagram";
  closeButton: RefObject<HTMLButtonElement | null>;
  onStep: (delta: number) => void;
  onComment?: () => void;
}) {
  const { setStage, image, setImage, failed, setFailed, model, zoom } = imageView;
  const atFit = !model || isAtFit(model.view, model.bounds);
  const zoomUnavailable = !model || failed;
  const zoomOutUnavailable = atFit || failed;
  const zoomInUnavailable = !model || failed || model.view.scale >= maxScale(model.bounds);
  const zoomPercent = model ? `${Math.round(model.view.scale * 100)}%` : null;
  const onDiagramSize = useCallback(
    (natural: Size | null) => (natural ? setImage(natural) : setFailed(true)),
    [setImage, setFailed],
  );
  const noun = item.kind === "image" ? "screenshot" : "diagram";
  // Keep unavailable controls focusable so reaching a limit or loading an image preserves arrow navigation.
  return (
    <>
      <header className="flex shrink-0 flex-wrap items-center justify-end gap-1 border-b border-line-1 p-2">
        {count > 1 && (
          <span className="mr-auto whitespace-nowrap px-1 text-12 text-fg-2" aria-live="polite">
            {index + 1} of {count}
          </span>
        )}
        <IconButton
          icon={Minus}
          label="Zoom out"
          size="lg"
          aria-disabled={zoomOutUnavailable}
          onClick={() => {
            if (!zoomOutUnavailable) zoom(1 / 1.5);
          }}
        />
        <Button
          variant="ghost"
          size="lg"
          aria-label={zoomPercent ? `Fit to screen, ${zoomPercent}` : "Fit to screen"}
          aria-disabled={zoomUnavailable}
          className="min-w-16 px-2 tabular-nums"
          onClick={() => {
            if (!zoomUnavailable) zoom();
          }}
        >
          {zoomPercent ?? "Fit"}
        </Button>
        <IconButton
          icon={Plus}
          label="Zoom in"
          size="lg"
          aria-disabled={zoomInUnavailable}
          onClick={() => {
            if (!zoomInUnavailable) zoom(1.5);
          }}
        />
        {onComment && (
          <IconButton icon={MessageSquarePlus} label={`Comment on ${noun}`} size="lg" onClick={onComment} />
        )}
        <Primitive.Close asChild>
          <IconButton ref={closeButton} icon={X} label="Close" size="lg" tooltip={false} />
        </Primitive.Close>
      </header>
      <div
        ref={setStage}
        data-lightbox-stage
        className="relative min-h-0 flex-1 touch-none select-none overflow-hidden bg-sunken"
      >
        {failed ? (
          <p
            role="status"
            className="pointer-events-none absolute inset-0 grid place-items-center p-6 text-center text-fg-2"
          >
            {item.kind === "image" ? "The screenshot could not load." : "The diagram could not be drawn."}
          </p>
        ) : item.kind === "image" ? (
          <img
            key={index}
            data-lightbox-subject
            src={item.src}
            alt={item.caption}
            draggable={false}
            onLoad={(event) => {
              const { naturalWidth: width, naturalHeight: height } = event.currentTarget;
              if (width > 0 && height > 0) setImage({ width, height });
              else setFailed(true);
            }}
            onError={() => setFailed(true)}
            className={`absolute top-0 left-0 max-w-none origin-top-left select-none ${atFit ? "cursor-zoom-in" : "cursor-grab active:cursor-grabbing"}`}
            style={{
              width: image?.width,
              height: image?.height,
              visibility: model ? "visible" : "hidden",
              transform: model
                ? `translate(${model.view.x}px, ${model.view.y}px) scale(${model.view.scale})`
                : undefined,
            }}
          />
        ) : (
          <div
            key={index}
            data-lightbox-subject
            className={`absolute top-0 left-0 origin-top-left ${atFit ? "cursor-zoom-in" : "cursor-grab active:cursor-grabbing"}`}
            style={{
              width: image?.width ?? "100%",
              height: image?.height ?? "100%",
              visibility: model ? "visible" : "hidden",
              transform: model
                ? `translate(${model.view.x}px, ${model.view.y}px) scale(${model.view.scale})`
                : undefined,
            }}
          >
            <LightboxDiagram source={item.source} onSize={onDiagramSize} />
          </div>
        )}
        {count > 1 && (
          <>
            <IconButton
              icon={ChevronLeft}
              label={galleryNoun ? `Previous ${galleryNoun}` : "Previous"}
              size="lg"
              variant="secondary"
              className="absolute top-1/2 left-2 -translate-y-1/2"
              aria-disabled={index === 0}
              onClick={() => {
                if (index > 0) onStep(-1);
              }}
            />
            <IconButton
              icon={ChevronRight}
              label={galleryNoun ? `Next ${galleryNoun}` : "Next"}
              size="lg"
              variant="secondary"
              className="absolute top-1/2 right-2 -translate-y-1/2"
              aria-disabled={index === count - 1}
              onClick={() => {
                if (index < count - 1) onStep(1);
              }}
            />
          </>
        )}
      </div>
      {item.kind === "image" ? (
        <footer className="max-h-[25dvh] shrink-0 overflow-y-auto border-t border-line-1 px-4 py-3 text-center">
          <Primitive.Title dir="auto" className="m-0 whitespace-pre-wrap break-words text-14 font-medium">
            {item.caption}
          </Primitive.Title>
        </footer>
      ) : (
        <Primitive.Title className="sr-only">Diagram</Primitive.Title>
      )}
      <Primitive.Description className="sr-only">
        {item.kind === "image" ? "Screenshot" : "Diagram"} {index + 1} of {count}. Left and Right arrows move between{" "}
        {galleryNoun ? `${galleryNoun}s` : "screenshots and diagrams"}; when zoomed in, the arrow keys move the{" "}
        {item.kind === "image" ? "image" : "diagram"}. Escape closes.
      </Primitive.Description>
    </>
  );
}
