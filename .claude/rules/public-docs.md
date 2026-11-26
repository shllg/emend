---
paths:
  - "docs/setup.md"
  - "docs/setup/**"
  - "docs/usage.md"
  - "docs/site.json"
  - "docs/images/**"
  - "scripts/screenshots.ts"
  - "test/docs-contract*.ts"
---

# Public docs

`docs/setup.md`, every `docs/setup/*.md` and `docs/usage.md` are public pages. The website copies
them and the images from the newest `vX.Y.Z` tag on the release branch. It owns its navigation,
URLs, layout and prompts. `test/docs-contract.test.ts` checks the manifest, the page set, front
matter, the H1 and lead, heading slugs, links and fragments, fence info strings, the `$` prompt in
`sh` fences, prompt markers, raw HTML, images and screenshot sizes. Run it after any change here.
The other rules below are for authors and reviewers.

## Manifest `docs/site.json`

- `"schema": 1`, then `pages` and `screenshots`, with exactly the keys named here.
- `pages` lists docs/setup.md, every file in docs/setup/ and docs/usage.md, in reading order. Each
  entry has `id` (a stable lowercase slug that survives a rename), `path` (relative to `docs/`),
  `title` (exactly the page's H1) and `description` (one sentence, 1 to 160 characters, ending
  with a period, no line break).
- `screenshots` lists the product shots the website shows outside the docs. Each entry has `file`
  (`images/<view>-<device>.png`, or `<view>-<device>-light.png` for theme `light`), `view`,
  `device` (`desktop` or `phone`), `theme` (`dark` or `light`), and `width` and `height` in pixels.
  The test reads the PNG header and compares the size.
- A change that adds, renames or removes a public page updates `docs/site.json` in the same change.

## Every public page

- GitHub-flavoured Markdown. No front matter, MDX or custom directives.
- Line 1 is the only H1, then a one-paragraph lead.
- Heading slugs are unique within a page; the website builds anchors with GitHub's slug rule.
  Renaming a heading changes its anchor, so update every link to it in the same change.
- Setup steps stay `## N. Title` headings. A page that undoes its setup has exactly one `## Undo`.
- Links between docs pages are relative paths with fragments, for example `setup/local.md#undo`.
  Links to files that are not public pages are fine; the website points them at GitHub.
- Only tracked files count: the website copies the tag, so a link to an untracked, ignored or
  symlinked file fails.
- Every code fence has an info string: `sh` for commands the reader types (one per line, no `$`
  prompt, no output), `text` for output and other text only shown, the file's language for config.
- A fence that holds a prompt the reader pastes into an agent has the info string `text prompt`,
  exactly. A `text` fence that starts with `Rules:` is such a prompt. Nothing else carries the
  marker; program output never does.
- The website owns the prompts it shows. The marked prompts stay as the reference copy for GitHub
  readers. Never add a prompt for the website's sake.
- GitHub alerts (`> [!NOTE]`, `> [!TIP]`, `> [!WARNING]`) are allowed.
- No raw HTML, except `img` with `src`, `alt` and `width`, optionally inside a `p` without
  attributes.

## Images

- Docs images and product screenshots live in `docs/images/` as PNG. Pages reference them by
  relative path, and every image has meaningful alt text.
- Product screenshots come from `pnpm screenshots` and show only the synthetic demo data.
- Names follow `VIEW-DEVICE.png`, and light shots `VIEW-DEVICE-light.png`. A file name keeps its
  meaning: a new view gets a new name.
- Keep each screenshot's pixel size stable. A change updates `docs/site.json` and ships in a `fix`
  or `feat` commit, so it gets a release-note line.
- Never optimise or convert images for the website; it converts and resizes them itself.
