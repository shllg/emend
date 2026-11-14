import type { ReactNode } from "react";

export type ThreadJump = { threadId: string; token: object };

/** Source views keep their inline thread cards in the line flow. */
export function BlockThreads({ children }: { children: ReactNode }) {
  return (
    <div className="em-block-threads">
      <div className="em-block-threads__cards">{children}</div>
    </div>
  );
}
