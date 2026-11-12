---
paths:
  - "packages/core/src/links*.ts"
  - "packages/core/src/doc-title.ts"
  - "packages/core/src/render/**"
  - "packages/core/src/place/**"
  - "apps/web/src/**"
  - "apps/emend/src/server/content/**"
  - "apps/emend/src/server/publish/**"
---

# Doc navigation

Links between docs, Contents, titles and reading positions carry text that agents wrote into the
app's own routes and frame messages. `content-isolation.md` still applies in full; these rules add
to it. Any change here needs `emend-security-reviewer`.

- Relative links in the writeup and in Markdown docs keep no `href`, except one that resolves,
  through core's shared resolver, to a doc of the same revision. The hardener rewrites that link
  after sanitize to `?tab=docs&doc=<manifest path>`, plus `#h-<declared id>` when the fragment,
  decoded once, exactly matches one of that doc's lookup names for a declared heading: its author
  id, then its hunk-review slug, then its GitHub slug; the first match wins. The fragment itself is
  never emitted or compared with a declared id. Author queries and other fragments are dropped.
  Comment HTML never gets these links.
- The resolver decodes each path segment once. It refuses `%2F`, `%5C`, NUL, control characters,
  schemes, `//`, a leading `/`, queries, and any `..` above the root, and matches exact paths
  only. The writeup resolves from the repo root. The bridge uses the same case table.
- The app reads a heading only from the `#h-` namespace and only as a declared heading of the open
  doc, and finds it by comparing ids inside the open doc's container, for links, Contents,
  `emend:goto` and position restore. `document.getElementById` takes only the app's own block,
  thread, diff, writeup topic, doc section and HTML-doc frame ids (`block-`, `thread-`, `diff-`,
  `topic-`, `doc-`, `html-doc-`); any other hash is ignored. A heading never becomes a thread,
  block or diff target. A not-found line never echoes the request. Only a heading that is the
  direct child of one of the open doc's own heading blocks counts; nothing inside comment HTML, a
  thread or a form.
- `emend:goto` carries only a declared heading and is posted only to a ready frame that has not
  navigated away. `emend:position` is accepted only from the current trusted frame after its
  ready, parsed with zod, with a declared heading and a fraction in [0, 1].
- The bridge never changes `location`, handles links to a fragment of the same doc itself, and
  calls DOM methods from their prototypes, so doc markup cannot replace them.
- Titles and Contents labels pass `cleanDocTitle` on the server and render as isolated text
  (`dir="auto"`). The filename always shows.
- Position memory holds only the app's own block, thread and HTML-doc frame ids or declared
  headings, with fractions including an optional gap fraction, and the Files tab keeps only a pixel
  offset in memory, never quote text, heading text or a content URL. Remembered focus names
  only the app's own block, thread or writeup topic ids or a declared heading, and stays in memory
  only.
- The doc bar stays outside the frame and visible. Its sandbox label sits there too, on tablet and
  desktop; the phone layout drops the label to give the doc its row.
