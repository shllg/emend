import { Copy } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { Button } from "../ui/Button.tsx";
import { cn } from "../ui/utils.ts";

const COPIED_MS = 2000;
/** U+00A0, built from its code so the source shows it: a plain trailing space may be collapsed. */
const NBSP = String.fromCharCode(0xa0);

/** The command that resumes a review's feedback loop, a Copy button, and the line for other agents. */
export function ResumeCommand({ reviewId, compact = false }: { reviewId: string; compact?: boolean }) {
  const command = `/emend:emend-feedback ${reviewId}`;
  const text = useRef<HTMLElement>(null);
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
      navigator.clipboard.writeText(command).then(done, failed);
    } catch {
      failed();
    }
  };
  return (
    <div className={cn("flex min-w-0 flex-col gap-1.5", compact && "gap-1")}>
      <div className="flex min-w-0 flex-wrap items-center gap-2">
        <code
          ref={text}
          className="min-w-0 break-all rounded-sm border border-line-1 bg-sunken px-2 py-1 font-mono text-13 text-fg-1 select-all"
        >
          {command}
        </code>
        <Button size="sm" icon={Copy} onClick={copy}>
          {result === "copied" ? "Copied" : "Copy"}
        </Button>
        <span role="status" className={cn("text-fg-3 [font:var(--type-meta)]", result !== "failed" && "sr-only")}>
          {/* A trailing U+00A0 (NBSP) on every second failure changes the text, so a repeat is announced again. */}
          {result === "failed"
            ? `Select and copy the command${failures % 2 === 0 ? NBSP : ""}`
            : result === "copied"
              ? "Command copied"
              : ""}
        </span>
      </div>
      <p className="m-0 text-fg-3 [font:var(--type-meta)]">
        Run <code className="font-mono">emend feedback {reviewId}</code> and handle the result with the emend-feedback
        skill.
      </p>
    </div>
  );
}
