import type { LinesTarget, TopicMeta } from "@recense/contract";
import { Composer } from "../threads/Composer.tsx";

export function LineComposer({
  target,
  ...props
}: {
  reviewId: string;
  revision: number;
  target: LinesTarget;
  topics?: TopicMeta[];
  onSaved: () => void;
  onCancel: () => void;
}) {
  return (
    <section className="space-y-2 p-3" aria-label="Line comment">
      <Composer surface="diff" {...props} target={target} />
    </section>
  );
}
