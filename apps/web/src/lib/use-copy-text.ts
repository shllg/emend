import { useEffect, useRef, useState } from "react";

const COPIED_MS = 2000;
/** U+00A0 keeps repeated failure announcements distinct. */
const NBSP = String.fromCharCode(0xa0);

export function useCopyText(value: string, noun: "command" | "text") {
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
      navigator.clipboard.writeText(value).then(done, failed);
    } catch {
      failed();
    }
  };
  const status =
    result === "failed"
      ? `Select and copy the ${noun}${failures % 2 === 0 ? NBSP : ""}`
      : result === "copied"
        ? `${noun === "command" ? "Command" : "Text"} copied`
        : "";
  return { text, copy, result, status };
}
