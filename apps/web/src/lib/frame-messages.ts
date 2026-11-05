import { DocHeading, FilePath, FileView, HtmlDocPosition, HtmlSpanTarget, ThreadView } from "@emend/contract";

export const HtmlPosition = HtmlDocPosition;
export type HtmlPosition = typeof HtmlPosition._output;

// Reuse the contract's Zod schemas and limits without a second web dependency on Zod.
const span = HtmlSpanTarget.pick({ quote: true, prefix: true, suffix: true }).strict();
const empty = HtmlSpanTarget.pick({}).strict();
const literal = <T extends string>(value: T) =>
  HtmlSpanTarget.shape.quote.refine((text) => text === value).transform(() => value);
const threadId = ThreadView.shape.id;
export const FrameToParent = span
  .extend({ type: literal("emend:anchor") })
  .or(empty.extend({ type: literal("emend:ready") }))
  .or(HtmlPosition.safeExtend({ type: literal("emend:position") }))
  .or(
    empty.extend({
      type: literal("emend:navigate"),
      path: FilePath,
      fragment: FileView.shape.mediaType.max(1024).refine((fragment) => fragment.isWellFormed()),
    }),
  );
export type DocNavigation = Extract<typeof FrameToParent._output, { type: "emend:navigate" }>;
export const ParentToFrame = empty
  .extend({ type: literal("emend:highlight"), anchors: span.extend({ threadId }).array() })
  .or(empty.extend({ type: literal("emend:scroll"), threadId }))
  .or(
    empty.extend({
      type: literal("emend:goto"),
      heading: HtmlPosition.shape.heading.unwrap(),
      label: DocHeading.shape.text,
      fraction: HtmlPosition.shape.fraction.optional(),
    }),
  )
  .or(empty.extend({ type: literal("emend:docs"), paths: FilePath.array() }));
export type ParentToFrame = typeof ParentToFrame._output;
