import { Copy } from "lucide-react";
import { useCopyText } from "../../lib/use-copy-text.ts";
import { Button } from "../ui/Button.tsx";
import { cn } from "../ui/utils.ts";

/** The command that resumes a review's feedback loop, a Copy button, and the line for other agents. */
export function ResumeCommand({
  reviewId,
  compact = false,
  buttonSize = "sm",
  buttonClassName,
}: {
  reviewId: string;
  compact?: boolean;
  buttonSize?: "sm" | "lg";
  buttonClassName?: string;
}) {
  const command = `/recense:recense-feedback ${reviewId}`;
  const { text, copy, result, status } = useCopyText(command, "command");
  return (
    <div className={cn("flex min-w-0 flex-col gap-1.5", compact && "gap-1")}>
      <div className="flex min-w-0 flex-wrap items-center gap-2">
        <code
          ref={text}
          className="min-w-0 break-all rounded-sm border border-line-1 bg-sunken px-2 py-1 font-mono text-13 text-fg-1 select-all"
        >
          {command}
        </code>
        <Button size={buttonSize} icon={Copy} className={buttonClassName} onClick={copy}>
          {result === "copied" ? "Copied" : "Copy"}
        </Button>
        <span role="status" className={cn("text-fg-3 [font:var(--type-meta)]", result !== "failed" && "sr-only")}>
          {status}
        </span>
      </div>
      <p className="m-0 text-fg-3 [font:var(--type-meta)]">
        Run <code className="font-mono">recense feedback {reviewId}</code> and handle the result with the
        recense-feedback skill.
      </p>
    </div>
  );
}
