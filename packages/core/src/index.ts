export { htmlAssetReferences } from "./assets.ts";
export { DIFF_COUNT_TIMEOUT_MS, diffLineCounts } from "./diff-counts.ts";
export { htmlHeadings, htmlHeadingsFromTree, markdownHeadings } from "./doc-headings.ts";
export { cleanDocTitle, inferDocTitle, markdownTitle } from "./doc-title.ts";
export { headingLookups } from "./heading-lookups.ts";
export {
  HTML_STRUCTURE,
  type HtmlColorScheme,
  type HtmlLook,
  type HtmlLookReason,
  htmlLook,
  htmlLookFromTree,
} from "./html-look.ts";
export {
  applyHtmlLook,
  HTML_LOOK_FILE_LAYER,
  type HtmlLookTheme,
  htmlLookInsertAt,
  htmlLookThemeRules,
  htmlLookThemeVars,
  stripHtmlLook,
} from "./html-look-file.ts";
export { HTML_PART_TAGS, htmlPartHashes, htmlPartTexts } from "./html-parts.ts";
export { type DocLinks, resolveDocLink } from "./links.ts";
export { isLockfile } from "./lockfiles.ts";
export { docText, parseDocHtml, placeHtmlSpan } from "./place/html.ts";
export { lineMap } from "./place/linemap.ts";
export { type FileSides, placeLines } from "./place/lines.ts";
export { type PlaceContext, placeThread } from "./place/place.ts";
export { composeRenames } from "./place/renames.ts";
export { makeSpan, placeSpan } from "./place/span.ts";
export { type Block, blockText, resectionBlocks } from "./render/blocks.ts";
export { changedBlockIds } from "./render/changed.ts";
export {
  buildCommentsDownload,
  buildDocDownload,
  buildHtmlDocDownload,
  buildOmittedDownload,
  buildWriteupDownload,
  createDownloadWork,
  DOWNLOAD_FILE_CSP,
  type DownloadAsset,
  type DownloadRenderTheme,
  type DownloadWork,
  type ResolveResult,
} from "./render/download.ts";
export {
  DOWNLOAD_DIFF_BYTES,
  DOWNLOAD_DIFF_CONTEXT,
  DOWNLOAD_DIFF_LINES,
  DOWNLOAD_DIFF_REVEAL_CONTEXT,
  type DownloadDiffFile,
  type DownloadDiffHunk,
  type DownloadDiffReveal,
  downloadDiffGroups,
  downloadDiffHunks,
} from "./render/download-diff.ts";
export {
  type DownloadComment,
  type DownloadFile,
  type DownloadThread,
  type DownloadThreadInput,
  type FileThreads,
  routeDownloadThreads,
} from "./render/download-threads.ts";
export { blockHash } from "./render/hash.ts";
export { HIGHLIGHT_FENCE_BYTES, HIGHLIGHT_LINE_CHARS, HIGHLIGHT_RENDER_BYTES } from "./render/highlight.ts";
export {
  markdownImageReferences,
  type RenderEffects,
  renderCommentHtml,
  renderDoc,
  renderMarkdown,
  renderMetadataBlocks,
} from "./render/markdown.ts";
export { normalizeText } from "./render/normalize.ts";
export { localMediaPath, type MediaSize } from "./render/sanitize.ts";
export * from "./render/source.ts";
export { type RenderedWriteup, renderWriteup } from "./render/writeup.ts";
export { buildSampleView } from "./sample/build.ts";
export { SAMPLE_HTML, SAMPLE_HTML_PATH, SAMPLE_IMAGE_HASH, SAMPLE_SVG, sampleImageHash } from "./sample/content.ts";
export { resolveShortcuts } from "./shortcuts.ts";
export * from "./text.ts";
export * from "./theme/index.ts";
export { type ChangedPath, UnchangedFilesError, withOtherChanges } from "./topics.ts";
