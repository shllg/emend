import { type ReactNode, useCallback, useContext, useEffect, useRef, useState } from "react";
import { useReadOnlyReview } from "../../lib/read-only-review.ts";
import { ChangedMarker } from "../status/ChangedMarker.tsx";
import { ReadingFoldContext } from "./ReadingGroup.tsx";

export function WriteupDetails({
  reviewId,
  revision,
  sectionKey,
  changedIn,
  children,
}: {
  reviewId: string;
  revision: number;
  sectionKey: string;
  changedIn?: number;
  children: ReactNode;
}) {
  const readOnly = useReadOnlyReview();
  const root = useRef<HTMLDetailsElement>(null);
  const folds = useContext(ReadingFoldContext);
  const foldKey = JSON.stringify([reviewId, revision, sectionKey, "details"]);
  const [choice, setChoice] = useState({ open: false });
  const open = folds ? (folds.choices.get(foldKey) ?? false) : choice.open;
  const rememberOpen = useCallback(
    (next: boolean) => {
      if (!readOnly) folds?.choices.set(foldKey, next);
      setChoice({ open: next });
    },
    [readOnly, folds, foldKey],
  );
  useEffect(() => {
    const details = root.current;
    const reveal = () => {
      if (details) details.open = true;
      rememberOpen(true);
    };
    details?.addEventListener("emend:reveal-reading", reveal);
    details?.addEventListener("beforematch", reveal);
    return () => {
      details?.removeEventListener("emend:reveal-reading", reveal);
      details?.removeEventListener("beforematch", reveal);
    };
  }, [rememberOpen]);
  return (
    <details
      ref={root}
      className="em-writeup-details"
      open={open}
      onToggle={(event) => {
        if (event.target === event.currentTarget) rememberOpen(event.currentTarget.open);
      }}
    >
      <summary>
        Details
        {!open && changedIn !== undefined && <ChangedMarker revision={changedIn} className="ml-2 align-middle" />}
      </summary>
      {children}
    </details>
  );
}
