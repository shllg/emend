import {
  DocHeading,
  FilePath,
  FileView,
  HtmlDocChanges,
  HtmlDocPosition,
  HtmlSpanTarget,
  LIMITS,
  RepoUrl,
  ThemeBase,
  ThemeValid,
  ThreadView,
} from "@recense/contract";
import { codePxSchema, proseSizeSchema, readingWidthSchema } from "./layout-store.ts";

export const HtmlPosition = HtmlDocPosition;
export type HtmlPosition = typeof HtmlPosition._output;

// Reuse the contract's Zod schemas and limits without a second web dependency on Zod.
const span = HtmlSpanTarget.pick({ quote: true, prefix: true, suffix: true }).strict();
const empty = HtmlSpanTarget.pick({}).strict();
const literal = <T extends string>(value: T) =>
  HtmlSpanTarget.shape.quote.refine((text) => text === value).transform(() => value);
const threadId = ThreadView.shape.id;
export const DIAGRAM_SOURCE_MAX = 50_000;
export const DIAGRAM_COUNT_MAX = 50;
export const DIAGRAM_TOTAL_MAX = 1_000_000;
export const DIAGRAM_SVG_MAX = 4_000_000;
export const DIAGRAM_DIMENSION_MAX = 10_000;
export const DIAGRAM_REQUEST_MAX = 2_147_483_647;
const request = ThreadView.shape.createdOn.max(DIAGRAM_REQUEST_MAX);
const dimension = ThreadView.shape.createdOn.max(DIAGRAM_DIMENSION_MAX);
const svg = FileView.shape.mediaType
  .min(1)
  .max(DIAGRAM_SVG_MAX)
  .refine((text) => text.isWellFormed() && text.startsWith("<svg"));
const diagramResult = empty.extend({ svg, width: dimension, height: dimension });
const diagramFailure = empty.extend({
  svg: FileView.shape.mediaType
    .nullable()
    .refine((value) => value === null)
    .transform(() => null),
});
export const DiagramReply = diagramResult
  .extend({ type: literal("svg") })
  .or(diagramFailure.extend({ type: literal("svg") }));
export type DiagramReply = typeof DiagramReply._output;
const diagrams = empty
  .extend({
    type: literal("recense:diagrams"),
    request,
    diagrams: empty
      .extend({
        source: FileView.shape.mediaType
          .min(1)
          .max(DIAGRAM_SOURCE_MAX)
          .refine((text) => text.isWellFormed()),
        mode: ThemeBase,
        width: dimension,
      })
      .array()
      .min(1)
      .max(DIAGRAM_COUNT_MAX),
  })
  .refine(({ diagrams }) => diagrams.reduce((total, diagram) => total + diagram.source.length, 0) <= DIAGRAM_TOTAL_MAX);
export type DiagramJob = typeof diagrams._output;
const diagramAddress = {
  type: literal("recense:diagram"),
  request,
  index: FileView.shape.order.max(DIAGRAM_COUNT_MAX - 1),
};
const image = empty.extend({
  path: FileView.shape.mediaType.max(LIMITS.pathChars).refine((path) => path.isWellFormed()),
  caption: FileView.shape.mediaType.max(LIMITS.quoteChars).refine((caption) => caption.isWellFormed()),
});
const gallery = empty
  .extend({
    type: literal("recense:image"),
    images: image.array().min(1).max(LIMITS.filesPerRevision),
    index: FileView.shape.order,
  })
  .refine(({ images, index }) => index < images.length)
  .refine(
    ({ images }) => images.reduce((total, image) => total + image.path.length + image.caption.length, 0) <= 1_000_000,
  );
export const FrameToParent = span
  .extend({ type: literal("recense:anchor") })
  .or(empty.extend({ type: literal("recense:ready") }))
  .or(empty.extend({ type: literal("recense:deselect") }))
  .or(empty.extend({ type: literal("recense:issue"), number: ThreadView.shape.createdOn.max(9_999_999) }))
  .or(HtmlPosition.safeExtend({ type: literal("recense:position") }))
  .or(gallery)
  .or(diagrams)
  .or(
    empty.extend({
      type: literal("recense:navigate"),
      path: FilePath,
      fragment: FileView.shape.mediaType.max(1024).refine((fragment) => fragment.isWellFormed()),
    }),
  );
export type DocNavigation = Extract<typeof FrameToParent._output, { type: "recense:navigate" }>;
export const ParentToFrame = empty
  .extend({ type: literal("recense:highlight"), anchors: span.extend({ threadId }).array() })
  .or(empty.extend({ type: literal("recense:clear-selection") }))
  .or(empty.extend({ type: literal("recense:repo"), url: RepoUrl }))
  .or(HtmlDocChanges.safeExtend({ type: literal("recense:changed") }))
  .or(diagramResult.extend(diagramAddress))
  .or(diagramFailure.extend(diagramAddress))
  .or(empty.extend({ type: literal("recense:layout"), wide: FileView.shape.hasOld }))
  .or(
    empty.extend({
      type: literal("recense:layout"),
      wide: FileView.shape.hasOld,
      width: readingWidthSchema,
      prose: proseSizeSchema,
      code: codePxSchema,
    }),
  )
  .or(
    empty.extend({
      type: literal("recense:theme"),
      mode: ThemeBase,
      scales: ThemeValid.shape.scales,
      tokens: ThemeValid.shape.tokens,
    }),
  )
  .or(empty.extend({ type: literal("recense:scroll"), threadId }))
  .or(
    empty.extend({
      type: literal("recense:goto"),
      heading: HtmlPosition.shape.heading.unwrap(),
      label: DocHeading.shape.text,
      fraction: HtmlPosition.shape.fraction.optional(),
    }),
  )
  .or(empty.extend({ type: literal("recense:docs"), paths: FilePath.array() }));
export type ParentToFrame = typeof ParentToFrame._output;
