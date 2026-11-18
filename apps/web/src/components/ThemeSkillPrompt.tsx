import { Copy } from "lucide-react";
import { themeSkillPrompt } from "../lib/theme-skill.ts";
import { useCopyText } from "../lib/use-copy-text.ts";
import { Button } from "./ui/Button.tsx";
import { cn } from "./ui/utils.ts";

export function ThemeSkillPrompt() {
  const prompt = themeSkillPrompt(__EMEND_VERSION__);
  const { text, copy, result, status } = useCopyText(prompt, "text");
  return (
    <div className="mt-4 flex min-w-0 flex-col gap-2">
      <h3 className="text-14 font-semibold">Make a theme with your agent</h3>
      <p className="text-14 text-fg-3">Paste this into any coding agent and add what you want.</p>
      <code
        ref={text}
        className="min-w-0 rounded-sm border border-line-1 bg-sunken px-3 py-2 font-mono text-13 whitespace-pre-wrap text-fg-1 wrap-anywhere select-all"
      >
        {prompt}
      </code>
      <div className="flex min-w-0 flex-wrap items-center gap-2">
        <Button size="sm" icon={Copy} onClick={copy}>
          {result === "copied" ? "Copied" : "Copy"}
        </Button>
        <span role="status" className={cn("text-fg-3 [font:var(--type-meta)]", result !== "failed" && "sr-only")}>
          {status}
        </span>
      </div>
    </div>
  );
}
