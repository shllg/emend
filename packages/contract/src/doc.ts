import { z } from "zod";
import { LIMITS } from "./limits.ts";
export const DocTitle = z
  .string()
  .min(1)
  .max(LIMITS.titleChars)
  .refine((title) => /\S/.test(title), "title must not be blank");
export const DocHeading = z.object({
  level: z.union([z.literal(2), z.literal(3)]),
  text: z.string().max(LIMITS.headingTextChars),
  id: z.string().min(1).max(LIMITS.headingIdChars).optional(),
});
export type DocHeading = z.infer<typeof DocHeading>;
export const DocHeadings = z.array(DocHeading).max(LIMITS.headingsPerDoc);

/** The bridge and parent validate the index again against the current doc's declared heading list. */
export const HtmlDocPosition = z
  .object({
    heading: z
      .number()
      .int()
      .min(0)
      .max(LIMITS.headingsPerDoc - 1)
      .nullable(),
    fraction: z.number().finite().min(0).max(1),
  })
  .strict()
  .refine((position) => position.heading !== null || position.fraction === 0, "the introduction has zero fraction");
export type HtmlDocPosition = z.infer<typeof HtmlDocPosition>;

export const DocView = z.enum(["rendered", "source"]);
export type DocView = z.infer<typeof DocView>;
/** The effective view is shared by manifests, publishing, imports and the CLI. */
export function docViewOf(file: { path: string; view?: DocView }): DocView {
  return file.view === "source" || !/\.(md|markdown|html|htm)$/i.test(file.path) ? "source" : "rendered";
}
export function isRenderedHtmlDoc(file: { role: string; path: string; view?: DocView }): boolean {
  return file.role === "doc" && docViewOf(file) === "rendered" && /\.html?$/i.test(file.path);
}
export function validateDocView(file: { role: string; path: string; view?: DocView }, ctx: z.RefinementCtx) {
  if (file.view !== undefined && file.role !== "doc")
    ctx.addIssue({ code: "custom", path: ["view"], message: "only doc files have a view" });
  if (file.view === "rendered" && docViewOf(file) !== "rendered")
    ctx.addIssue({ code: "custom", path: ["view"], message: "only Markdown and HTML docs render" });
}
export const Color = z.string().regex(/^#[0-9a-fA-F]{3,8}$/);
export const SourceToken = z.object({
  text: z.string().max(LIMITS.markdownDocBytes),
  light: Color.optional(),
  dark: Color.optional(),
});
export type SourceToken = z.infer<typeof SourceToken>;
export const SourceContent = z.object({
  language: z.enum([
    "ts",
    "tsx",
    "js",
    "jsx",
    "json",
    "css",
    "html",
    "md",
    "yaml",
    "sh",
    "go",
    "py",
    "sql",
    "diff",
    "text",
  ]),
  lines: z.array(z.array(SourceToken).max(LIMITS.markdownDocBytes)).max(LIMITS.markdownDocBytes),
});
export type SourceContent = z.infer<typeof SourceContent>;
