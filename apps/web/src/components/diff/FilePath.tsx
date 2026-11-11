import * as Primitive from "@radix-ui/react-dropdown-menu";
import { Copy } from "lucide-react";
import { Fragment, useEffect, useRef, useState } from "react";
import { Icon } from "../ui/Icon.tsx";
import { cn, focusRing } from "../ui/utils.ts";

const COPIED_MS = 2000;
/** U+00A0, built from its code so the source shows it: a plain trailing space may be collapsed. */
const NBSP = String.fromCharCode(0xa0);

export function Path({ path }: { path: string }) {
  const segments = path.split("/");
  return (
    <bdi dir="ltr">
      {segments.map((segment, index) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: Static path segments may repeat names.
        <Fragment key={index}>
          <span className={index === segments.length - 1 ? "font-medium text-fg-1" : "text-fg-3"}>
            {segment}
            {index < segments.length - 1 ? "/" : ""}
          </span>
          {index < segments.length - 1 && <wbr />}
        </Fragment>
      ))}
    </bdi>
  );
}

export function FilePathMenu({ path, oldPath }: { path: string; oldPath?: string | null }) {
  const [open, setOpen] = useState(false);
  const pointerClick = useRef(false);
  return (
    <Primitive.Root open={open} onOpenChange={setOpen}>
      <Primitive.Trigger asChild>
        <button
          type="button"
          aria-label={path}
          className={cn("em-file-path-button", focusRing)}
          onPointerDown={(event) => {
            pointerClick.current = event.pointerType === "touch" || event.pointerType === "pen";
            // Touch and pen open on click, so scrolling from the sticky header never opens the menu.
            if (pointerClick.current) event.preventDefault();
          }}
          onPointerCancel={() => {
            pointerClick.current = false;
          }}
          onKeyDown={() => {
            pointerClick.current = false;
          }}
          onClick={() => {
            if (pointerClick.current) {
              pointerClick.current = false;
              setOpen((value) => !value);
            }
          }}
        >
          <Path path={path} />
        </button>
      </Primitive.Trigger>
      <Primitive.Portal>
        <Primitive.Content
          align="start"
          sideOffset={4}
          collisionPadding={8}
          className="relative z-[calc(var(--z-sheet)+2)] max-h-(--radix-dropdown-menu-content-available-height) min-w-52 max-w-[min(36rem,var(--radix-dropdown-menu-content-available-width))] animate-[em-fade_var(--dur-1)_var(--ease-out)] overflow-y-auto rounded-lg border border-line-1 bg-raised p-1 shadow-3"
        >
          <FilePathContent path={path} oldPath={oldPath} />
        </Primitive.Content>
      </Primitive.Portal>
    </Primitive.Root>
  );
}

function FilePathContent({ path, oldPath }: { path: string; oldPath?: string | null }) {
  const text = useRef<HTMLDivElement>(null);
  const timer = useRef<number>(undefined);
  const [result, setResult] = useState<"idle" | "copied" | "failed">("idle");
  const [failures, setFailures] = useState(0);
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
      window.clearTimeout(timer.current);
    };
  }, []);
  const copy = () => {
    window.clearTimeout(timer.current);
    const done = () => {
      if (!alive.current) return;
      setResult("copied");
      timer.current = window.setTimeout(() => setResult("idle"), COPIED_MS);
    };
    const failed = () => {
      if (!alive.current) return;
      const node = text.current;
      const selection = window.getSelection();
      if (node && selection) {
        const range = document.createRange();
        range.selectNodeContents(node);
        selection.removeAllRanges();
        selection.addRange(range);
      }
      let copied = false;
      try {
        copied = typeof document.execCommand === "function" && document.execCommand("copy");
      } catch {
        copied = false;
      }
      if (copied) done();
      else {
        setResult("failed");
        setFailures((count) => count + 1);
      }
    };
    try {
      navigator.clipboard.writeText(path).then(done, failed);
    } catch {
      failed();
    }
  };
  return (
    <>
      <div
        ref={text}
        className="px-2.5 pt-2 pb-1 font-stretch-mono text-fg-1 [font:var(--type-path)] [overflow-wrap:anywhere] select-text"
      >
        <Path path={path} />
      </div>
      {oldPath && (
        <div className="px-2.5 pb-1 font-stretch-mono text-fg-3 [font:var(--type-path)] [overflow-wrap:anywhere] select-text">
          Renamed from <Path path={oldPath} />
        </div>
      )}
      <Primitive.Item
        onSelect={(event) => {
          event.preventDefault();
          copy();
        }}
        className={cn(
          "flex h-8 w-full items-center gap-2.5 rounded-[6px] border-0 bg-transparent px-2.5 text-left font-sans text-13 font-medium leading-(--lh-snug) font-[450] text-fg-1 no-underline hover:text-fg-1 data-highlighted:bg-hover [@media(pointer:coarse)]:h-11 [&>svg]:text-fg-3",
          focusRing,
        )}
      >
        <Icon icon={Copy} />
        <span>{result === "copied" ? "Copied" : "Copy path"}</span>
      </Primitive.Item>
      <span
        role="status"
        className={cn("block px-2.5 pb-1 text-fg-3 [font:var(--type-meta)]", result !== "failed" && "sr-only")}
      >
        {/* A trailing NBSP on every second failure makes repeated failures announce again. */}
        {result === "failed"
          ? `Select and copy the path${failures % 2 === 0 ? NBSP : ""}`
          : result === "copied"
            ? "Path copied"
            : ""}
      </span>
    </>
  );
}
