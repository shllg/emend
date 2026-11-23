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
- `emend:layout` carries `wide`, a boolean from the app's 768px breakpoint, and goes first to each
  ready frame. For a frame in emend's look it also carries the View menu's `width` (`comfortable`,
  `wide` or `narrow`), `prose` (15 to 18) and `code` (12 to 15), all three or none; a message
  with only some of them, or any invalid, is ignored whole, `wide` included. The bridge checks
  each against that list and sets only `data-emend-layout` (`wide` or `narrow`),
  `data-emend-width`, `data-emend-prose` and `data-emend-code` on the root. When they change while
  a pinned position still holds (every `emend:goto` pins, and so does the bridge's own return after
  a layout change) or the reading heading's scroll path is scrolled, it returns to the same declared
  heading and fraction; a doc with nothing scrolled and no pin stays where it is.
- `emend:theme` carries only `mode` and theme colours to a ready frame in emend's look that has not
  navigated away; a light-only frame receives only `light`. The content path's `theme` query picks
  one of two fixed start tags, never writes the raw query and never overrides a light-only doc.
  The bridge validates every key and value and ignores the whole message on any invalid entry; it
  sets only `data-theme` on the root and one constructed stylesheet in layer `emend`.
- Diagrams: after ready, the bridge sends `emend:diagrams` with only the text of HTML
  `pre.mermaid` elements and of HTML `pre` elements whose only element child is a
  `code.language-mermaid` (at most 50, each up to 50,000 characters, 1,000,000 in all), a mode and a
  width each. An applied theme, a colour-scheme change, and the end or cancel of a transition or
  animation on an element that holds a diagram check the modes again; only a changed mode sends a
  new request.
  The app takes it only from a ready frame that has not navigated away, draws one diagram at a
  time in one hidden Mermaid frame, never puts the SVG into its own DOM, and relays it as
  `emend:diagram` only to that frame generation. The bridge accepts only the current request and
  a valid index, shows the SVG only as a `data:` image in a closed shadow root, and never changes
  the source `pre`'s text. Comments anchor in that text as in any HTML doc, and it shows below the
  image while a quote's range touches it.
- The bridge never changes `location`, handles links to a fragment of the same doc itself, and
  calls DOM methods from their prototypes, so doc markup cannot replace them.
- `emend:repo` carries only a checked repo URL to a ready frame. The bridge wraps `#123` text in
  its own links, never in code, pre, a or non-HTML elements; a click posts `emend:issue` with only
  the number. The parent opens only its own `repoUrl` with that number, never a URL from the frame.
- At ready the bridge reads the doc's own glossary (the first `dl` after a "Glossary" heading),
  wraps each entry's first use in its own spans (never in the elements above, headings or the `dl`),
  and draws the card as text in a closed shadow root. Nothing about the glossary crosses the frame.
- Titles and Contents labels pass `cleanDocTitle` on the server and render as isolated text
  (`dir="auto"`). The filename always shows.
- Position memory holds only the app's own block, thread and HTML-doc frame ids or declared
  headings, with fractions including an optional gap fraction, and the Files tab keeps only a pixel
  offset in memory, never quote text, heading text or a content URL. Remembered focus names
  only the app's own block, thread or writeup topic ids or a declared heading, and stays in memory
  only.
- The doc bar stays outside the frame and visible. Its sandbox label sits there too, on tablet and
  desktop; the phone layout drops the label to give the doc its row.
