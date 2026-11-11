import * as Primitive from "@radix-ui/react-dropdown-menu";
import { Copy } from "lucide-react";
import {
  type ComponentPropsWithoutRef,
  type ComponentPropsWithRef,
  type ReactNode,
  useEffect,
  useId,
  useRef,
  useState,
} from "react";
import { Icon } from "./Icon.tsx";
import { cn, focusRing } from "./utils.ts";

const COPIED_MS = 2000;
/** U+00A0, built from its code so the source shows it: a plain trailing space may be collapsed. */
const NBSP = String.fromCharCode(0xa0);

type TextBlock = { content: ReactNode; className: string };

/** A heading trigger with selectable text blocks and a Copy action. The first block is the fallback selection. */
export function CopyTextMenu({
  text: copyText,
  noun,
  heading: { as: Heading, ...headingProps },
  trigger,
  blocks,
}: {
  text: string;
  noun: "path" | "title";
  heading: { as: "h1" | "h4" } & Omit<ComponentPropsWithRef<"h1">, "children">;
  trigger: Pick<ComponentPropsWithoutRef<"button">, "className" | "aria-label" | "children">;
  blocks: [TextBlock, ...TextBlock[]];
}) {
  const [open, setOpen] = useState(false);
  const pointerClick = useRef(false);
  const id = useId();
  const textBlocks = blocks.map((block, index) => ({ ...block, id: `${id}-${index}` }));
  const text = useRef<HTMLDivElement>(null);
  const timer = useRef<number>(undefined);
  const attempt = useRef(0);
  const [result, setResult] = useState<"idle" | "copied" | "failed">("idle");
  const [failures, setFailures] = useState(0);
  const previousCopyText = useRef(copyText);
  useEffect(() => {
    if (previousCopyText.current === copyText) return;
    previousCopyText.current = copyText;
    attempt.current += 1;
    window.clearTimeout(timer.current);
    setResult("idle");
    setFailures(0);
  }, [copyText]);
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
      attempt.current += 1;
      window.clearTimeout(timer.current);
    };
  }, []);
  const changeOpen = (value: boolean) => {
    setOpen(value);
    if (!value) {
      window.clearTimeout(timer.current);
      attempt.current += 1;
      pointerClick.current = false;
      setResult("idle");
      setFailures(0);
    }
  };
  const copy = () => {
    const currentAttempt = ++attempt.current;
    window.clearTimeout(timer.current);
    const done = () => {
      if (!alive.current || attempt.current !== currentAttempt) return;
      window.clearTimeout(timer.current);
      setResult("copied");
      timer.current = window.setTimeout(() => setResult("idle"), COPIED_MS);
    };
    const failed = () => {
      if (!alive.current || attempt.current !== currentAttempt) return;
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
      navigator.clipboard.writeText(copyText).then(done, failed);
    } catch {
      failed();
    }
  };
  return (
    <Primitive.Root open={open} onOpenChange={changeOpen}>
      <Heading {...headingProps}>
        <Primitive.Trigger asChild>
          <button
            type="button"
            aria-label={trigger["aria-label"]}
            className={cn(trigger.className, focusRing)}
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
            onClick={(event) => {
              if (pointerClick.current || event.detail === 0) {
                pointerClick.current = false;
                changeOpen(!open);
              }
            }}
          >
            {trigger.children}
          </button>
        </Primitive.Trigger>
      </Heading>
      <span role="status" aria-live="polite" className="sr-only">
        {/* A trailing NBSP on every second failure makes repeated failures announce again. */}
        {result === "failed"
          ? `Select and copy the ${noun}${failures % 2 === 0 ? NBSP : ""}`
          : result === "copied"
            ? `${noun[0]?.toUpperCase()}${noun.slice(1)} copied`
            : ""}
      </span>
      <Primitive.Portal>
        <Primitive.Content
          align="start"
          sideOffset={4}
          collisionPadding={8}
          className="relative z-[calc(var(--z-sheet)+2)] max-h-(--radix-dropdown-menu-content-available-height) min-w-52 max-w-[min(36rem,var(--radix-dropdown-menu-content-available-width))] animate-[em-fade_var(--dur-1)_var(--ease-out)] overflow-y-auto rounded-lg border border-line-1 bg-raised p-1 shadow-3"
        >
          {textBlocks.map((block, index) => (
            <div
              key={block.id}
              id={block.id}
              ref={index === 0 ? text : undefined}
              aria-hidden="true"
              className={block.className}
            >
              {block.content}
            </div>
          ))}
          <Primitive.Item
            aria-describedby={textBlocks.map((block) => block.id).join(" ")}
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
            <span>{result === "copied" ? "Copied" : `Copy ${noun}`}</span>
          </Primitive.Item>
          {result === "failed" && (
            <span aria-hidden="true" className="block px-2.5 pb-1 text-fg-3 [font:var(--type-meta)]">
              Select and copy the {noun}
            </span>
          )}
        </Primitive.Content>
      </Primitive.Portal>
    </Primitive.Root>
  );
}
