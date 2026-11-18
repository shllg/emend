---
name: emend-theme
description: Make or change a custom colour theme for emend, the review app. Use when the person asks for an emend theme or wants emend's colours or fonts changed.
---

# Make an emend theme

## What a theme is

A theme is one `theme.json` file in its own folder.
The person picks it in Settings → Appearance, under Custom themes.
They pick it on each device, including their phone.
The choice applies to that device only.

## Rules to follow

1. Start with `emend theme copy <dark|light|existing-name> <new-name>`.
   Use Dark, Light or an existing valid theme as the source.
   Never write a theme file from scratch.
2. Change only what the person asked for.
   Leave every other value as the copy wrote it.
3. Run `emend theme check <name>` before reporting back.
   Fix every problem it prints.
   Run it again until it prints `emend: <name> is valid`.
4. Never write a theme into a repository.
   Before `emend theme copy`, resolve `<config folder>/themes` with `realpath`.
   If `themes` does not exist, resolve the config folder and use its `themes` child as the destination.
   Without running git, look for a `.git` entry in the resolved folder and every parent up to the filesystem root.
   Ignore only the `.git` entry in the resolved home folder itself.
   If you find another, stop, write nothing and tell the person the real themes folder path.
   If you cannot resolve or inspect the path, stop without writing and report the problem.
   After copying, resolve the path in `emend: wrote <path>` and confirm it is `<name>/theme.json` inside the checked themes folder.
   The CLI also refuses a themes folder inside a repository that holds the working directory.
5. Edit only `theme.json` inside the theme's folder.

## Where themes live

The path is `<config folder>/themes/<name>/theme.json`.
The config folder is `$XDG_CONFIG_HOME/emend/` when `XDG_CONFIG_HOME` is an absolute path.
Otherwise it is `~/.config/emend/`, also on macOS.
These files live on the machine running the emend server that the browser reaches.
Run the commands and edit the file on that machine.

Use 1 to 40 lowercase letters, digits or hyphens for the name.
Start and end with a letter or digit.
Do not use `system`, `dark` or `light`.
Emend lists at most 50 theme folders, in name order.
Each `theme.json` is at most 32 KiB.
Keep the `themes` folder at 1000 entries or fewer, including hidden files and other entries.
A larger folder shows a folder error and no themes.
Top-level files and dot entries are ignored when listing themes.
A symlink counts only when it points to a folder.
Links to files, missing targets and link loops are skipped.

## File format

This valid, partial example shows the shape.
Omitted values come from the base.
Use the full file made by the copy command for your changes.

```json
{
  "version": 1,
  "base": "dark",
  "fonts": {
    "text": "Geist",
    "code": "JetBrains Mono"
  },
  "scales": {
    "ochre-300": "oklch(0.85 0.14 81)"
  },
  "tokens": {
    "fg-link": "ochre-300"
  }
}
```

`version` must be `1`.
`base` must be `"dark"` or `"light"`.
`fonts`, `scales` and `tokens` are optional objects.
Unknown fields, font keys, scale names and token names are refused.

Colours accept only these forms:

- Hex `#rgb`, `#rgba`, `#rrggbb` or `#rrggbbaa`, in either case.
- `oklch(L C H)` or `oklch(L C H / A)`.
  `L` is 0 to 1, or 0% to 100%.
  `C` is 0 to 0.5.
  `H` is a number of degrees, with optional `deg`.
  Negative hues and hues beyond 360 wrap around the colour wheel.
  `A` is 0 to 1, or 0% to 100%, and defaults to 1.

Each colour string is at most 64 characters.
Use decimal numbers without exponents or a leading plus sign.
CSS names, `rgb()`, `var()`, `color-mix()` and other CSS expressions are refused.
Emend keeps and shows normalized colours in its validated theme.
Hex becomes lowercase with six or eight digits.
OKLCH percentages become fractions, hues wrap to 0 through less than 360, and numbers round to six decimal places.
Normalization removes `deg`, redundant zeros and an alpha of 1.
Checking a file does not rewrite it.

Scales take colours only.
A token can instead name a scale step, such as `"fg-link": "ochre-300"`.
Changing that step recolours every token that names it.
A token set to a colour keeps its own value.
Tokens cannot name other tokens in the file.

These surfaces must be opaque, including when set through a scale step:
`bg-app`, `bg-surface`, `bg-sunken`, `bg-raised`, `bg-inverse`, `bg-reading` and `bg-reading-card`.

`emend theme copy` writes every scale step as a resolved colour.
It writes every token as the scale step it names or as its own colour.
It also writes both fonts.

## Fonts by name

`fonts.text` sets reading and interface text.
`fonts.code` sets code and other monospaced text, such as file paths.
Each value is one installed font family name, not a file path, URL or list of fonts.
Use 1 to 64 characters: Unicode letters or digits, spaces, hyphens and underscores.
Start and end with a letter or digit.

Choose a font installed on every device that shows emend.
The server does not send custom font files to the browser.
Emend keeps Geist as the text fallback and JetBrains Mono as the code fallback.
A missing font falls back to them, then to system sans-serif or monospace fonts.
Changing a name does not install a font.

## Commands

Run these outside any repository.

- `emend theme list` prints one tab-separated line per theme:
  `<name>\t<base>\tvalid` or `<name>\t<base>\trefused: <first problem>`.
  Here `\t` means a tab.
  The base is `dark`, `light` or `-` when unknown.
  More problems add ` (<count> more)` after the first problem.
  An empty list prints `emend: no themes in <folder>; use emend theme copy dark <name>`.
- `emend theme copy <source> <name>` copies `dark`, `light` or an existing valid theme.
  It prints `emend: wrote <path>` with the new `theme.json` path.
  It refuses an existing name with `emend: theme <name> already exists`.
- `emend theme check <name>` prints `emend: <name> is valid` on success.
  A refused theme prints one `emend: <name>: <problem>` line per reported problem and exits with status 1.
  A missing theme reports `emend: unknown theme <name>`.

## Readability

The check measures WCAG contrast after compositing transparent colours over their background.
Transparent backgrounds normally sit over `bg-surface`.
The Download pairs below use `bg-sunken` instead.
Text and plain code need at least 4.5 to 1.
The seven syntax highlight colours need at least 3 to 1.
Muted reading text also has the 3-to-1 exceptions listed below.

Each contrast problem has this form:
`<foreground> on <background>: <ratio> to 1, needs <minimum> to 1.`
The ratio has two decimal places.
The CLI prefixes it with `emend: <name>: `.

The check covers these groups:

- Interface: `fg-1`, `fg-2`, `fg-3`, `fg-link` and `accent-text` on each of
  `bg-app`, `bg-surface`, `bg-sunken` and `bg-raised`.
  It also checks `fg-inverse` on `bg-inverse`.
- Reading: `fg-reading`, `fg-reading-strong` and `fg-reading-muted` on both
  `bg-reading` and `bg-reading-card`, plus `fg-link` on `bg-reading`.
- Download reading and code: `fg-reading` and `fg-reading-strong` on `bg-sunken`
  and on each of `diff-add-bg` and `diff-del-bg` composited over `bg-sunken`.
  `fg-reading-muted` needs 3 to 1 on these same backgrounds.
- Selection and marks: `fg-1` on `bg-selected`, `bg-hover`, `bg-active`, `accent-tint`,
  `mark-bg` and `mark-bg-active`.
  It also checks `fg-reading` on `mark-bg` composited over `bg-reading`.
- Accent buttons: `accent-fg` on `accent`, `accent-hover` and `accent-press`.
- Status: each of `success`, `info`, `warning` and `danger` has its `-fg` checked
  on its own `-bg` and on `bg-surface`.
- Review states: each of `state-open`, `state-approved`, `state-settled` and
  `state-snoozed` has its `-fg` checked on its own `-bg`.
- Outcomes and changes: each of `outcome-fixed`, `outcome-explained`, `outcome-held`,
  `outcome-declined` and `changed` has its `-fg` checked on its own `-bg`.
- Topics: `topic-fg` on `topic-bg`, `topic-bg-2` and `bg-surface`, plus
  `topic-on-solid` on `topic-solid`.
- Origins: each `origin-1-fg` through `origin-8-fg` on its matching `origin-N-bg`.
- Diff code: `syn-plain` at 4.5 to 1 and `syn-keyword`, `syn-type`, `syn-function`,
  `syn-string`, `syn-number`, `syn-comment` and `syn-punct` at 3 to 1 on each of
  `bg-surface`, `bg-hover`, `diff-add-bg`, `diff-del-bg`, `diff-add-hover`,
  `diff-del-hover` and `diff-select-bg`.
  The same text colours and minimums apply on `diff-add-word` over `diff-add-bg`
  and `diff-del-word` over `diff-del-bg`.
- Diff labels: `diff-add-fg` on `diff-add-bg`, `diff-del-fg` on `diff-del-bg`,
  `fg-3` on `diff-gutter`, `fg-1` and `fg-2` on `diff-hunk-bg`, and `fg-1` on `diff-select-bg`.

For a failing pair, move the foreground and background lightness further apart.
Change only the colour the person's request touched when possible.
Run the check again after each correction.

## See the result

Tell the person the theme name and ask them to pick it in Settings → Appearance.
While it is picked, saving `theme.json` updates open emend pages within a few seconds.
No reload is needed.
A refused file leaves each page on its last valid version.
Settings shows why the update was refused.

## Scale steps

A copy shows which scale step each token names.
The neutral ramp runs from `n-0` (lightest) to `n-1000` (darkest).
The colour ramps serve accent, status, review and topic colours.
Some steps are available for your own references but have no token pointing to them in either base.

Tokens that hold their own colour do not change when you change a ramp.
In Dark, the neutral colours of `bg-sunken`, `bg-hover`, `bg-active`, `bg-overlay` and `fg-reading` are their own values.
In Light, this applies to `bg-hover`, `bg-active`, `bg-overlay` and `fg-reading-muted`.
Many Dark tints also hold their own transparent colours, including `accent-tint`, `mark-bg`,
`success-bg`, `info-bg`, `warning-bg`, `danger-bg` and the diff backgrounds.
For a whole ramp retint, change these independent colours too when the person's request includes them.
The copy shows them as colours rather than step names.

The app also uses steps directly: `n-500`, `n-1000`, `ochre-200`, `ochre-400`, `ochre-500`,
`ochre-600`, `green-400`, `blue-400`, `red-400` and the origin pairs.
Button highlights reference `n-0` but fix the result to translucent white.
The rows below name these direct uses alongside the roles reached through tokens.
Origin pairs colour source badges and compact source dots.
The source id chooses one of eight pairs, so a number does not name a fixed machine or project.

| Step | What it colours |
| --- | --- |
| `n-0` | Light panels, raised menus, reading cards and solid topic badge text. Both bases reference it for button inner highlights, but fix those to translucent white. |
| `n-25` | Light page and reading background, plus text on inverse surfaces. Dark has no token pointing to it. |
| `n-50` | Dark primary text and plain diff code. Light sunken areas, settled badges and diff gutters. |
| `n-100` | Dark inverse surfaces such as tooltips. Light Open badge backgrounds. |
| `n-200` | Dark strong reading text. Light subtle borders. |
| `n-300` | Dark secondary interface text. Light stronger borders. |
| `n-400` | Dark muted interface and reading text, settled labels and syntax punctuation. Light disabled text. |
| `n-500` | Both bases' idle agent marks, resolved thread rings and syntax comments; Light strong borders. Tooltip key borders use its hue and chroma with fixed lightness and opacity. |
| `n-600` | Dark disabled text and strong borders. Light muted interface text, settled labels and syntax punctuation. |
| `n-700` | Light secondary interface text. Dark has no token pointing to it. |
| `n-800` | Dark stronger borders. Light has no token pointing to it. |
| `n-850` | Dark subtle borders and Open badge backgrounds. Light has no token pointing to it. |
| `n-900` | Dark raised menus, reading cards and settled badge backgrounds. Light inverse surfaces. |
| `n-950` | Dark panels, reading background, diff gutters and inverse text. Light primary text, reading text and plain diff code. |
| `n-1000` | Dark page background and solid topic badge text. Both bases use it for accent button text, browser-selected text and diff comment-button text. |
| `ochre-50` | Light selected backgrounds, accent tint, warning backgrounds and Held badges. Dark uses separate transparent colours for these. |
| `ochre-100` | Light stronger accent tint and selected diff lines. Dark uses separate transparent colours. |
| `ochre-200` | Dark hovered links and both bases' browser text-selection background. |
| `ochre-300` | Both bases' hovered accent buttons. Dark links, accent text, warning text and Held labels. |
| `ochre-400` | Both bases' `accent` token, neutral toast icons, decisions borders and diff comment-button fills. Dark focus rings, mark underlines, open thread dots and reserved `agent-working` also use it. |
| `ochre-500` | Both bases' `border-focus`, `accent-press`, `warning-solid`, desktop tab focus rings and active underlines, and selected radio-card borders. Light also uses it for general focus rings, mark underlines and reserved `agent-working`. |
| `ochre-600` | Light open thread dots and both bases' accent button border mix. |
| `ochre-700` | Light accent text, such as comment counts and note references. Dark has no token pointing to it. |
| `ochre-800` | Light links, warning text and Held labels. Dark has no token pointing to it. |
| `ochre-900` | Light hovered links. Dark has no token pointing to it. |
| `green-50` | Light success, Approved and Fixed badge backgrounds. Dark uses separate transparent colours. |
| `green-100` | Pale green available for success or addition tints. Neither base points a token to it. |
| `green-400` | Dark success, Approved, Fixed and addition text, plus reserved `agent-approved`. Both bases use it directly for success toast icons. |
| `green-500` | Light reserved approved-agent colour. Dark has no token pointing to it. |
| `green-600` | Both bases' solid success colour, mixed into Approve button borders. |
| `green-700` | Light success, Approved, Fixed and addition text. Dark has no token pointing to it. |
| `green-900` | Deep green available for success or addition colours. Neither base points a token to it. |
| `blue-50` | Light information, Snoozed and Explained backgrounds, plus diff hunk headers. Dark uses separate transparent colours. |
| `blue-100` | Pale blue available for information tints. Neither base points a token to it. |
| `blue-400` | Dark information, Snoozed and Explained text, waiting-agent dots and sent-thread marks. Both bases use it directly for information toast icons. |
| `blue-500` | Light waiting-agent dots. Dark has no token pointing to it. |
| `blue-600` | Both bases' solid information colour for banner borders. Light also uses it for sent-thread marks. |
| `blue-700` | Light information, Snoozed and Explained text. Dark has no token pointing to it. |
| `blue-900` | Deep blue available for information colours. Neither base points a token to it. |
| `violet-50` | Light changed-since-last-read and answered-thread badge backgrounds. Dark uses a separate transparent colour. |
| `violet-100` | Pale violet available for change or answered-thread tints. Neither base points a token to it. |
| `violet-400` | Dark answered-thread marks, changed labels and changed-block lines. |
| `violet-500` | Light changed-block lines. Dark has no token pointing to it. |
| `violet-600` | Light answered-thread marks. Dark has no token pointing to it. |
| `violet-700` | Light changed labels. Dark has no token pointing to it. |
| `violet-900` | Deep violet available for change or answered-thread colours. Neither base points a token to it. |
| `teal-50` | Light topic rank backgrounds and example callouts. Dark uses a separate transparent colour. |
| `teal-100` | Light reserved stronger topic tint, `topic-bg-2`. Dark uses a separate transparent colour. |
| `teal-400` | Dark topic text and topic lines. |
| `teal-500` | Dark solid topic rank backgrounds. Light topic lines. |
| `teal-600` | Light solid topic rank backgrounds. Dark has no token pointing to it. |
| `teal-700` | Light topic text. Dark has no token pointing to it. |
| `red-50` | Light danger and Declined badge backgrounds. Dark uses separate transparent colours. |
| `red-100` | Pale red available for danger or deletion tints. Neither base points a token to it. |
| `red-400` | Dark danger, Declined and deletion text. Both bases use it directly for danger toast icons. |
| `red-500` | Middle red available for danger or deletion colours. Neither base points a token to it. |
| `red-600` | Both bases' solid danger colour for destructive button borders and error borders. |
| `red-700` | Light danger, Declined and deletion text. Dark has no token pointing to it. |
| `red-900` | Deep red available for danger or deletion colours. Neither base points a token to it. |
| `origin-1-bg` | Background of source badges assigned palette 1, blue in both bases. |
| `origin-1-fg` | Text and compact source dots for palette 1, blue in both bases. |
| `origin-2-bg` | Background of source badges assigned palette 2, violet in both bases. |
| `origin-2-fg` | Text and compact source dots for palette 2, violet in both bases. |
| `origin-3-bg` | Background of source badges assigned palette 3, green in both bases. |
| `origin-3-fg` | Text and compact source dots for palette 3, green in both bases. |
| `origin-4-bg` | Background of source badges assigned palette 4, ochre in both bases. |
| `origin-4-fg` | Text and compact source dots for palette 4, ochre in both bases. |
| `origin-5-bg` | Background of source badges assigned palette 5, rose in both bases. |
| `origin-5-fg` | Text and compact source dots for palette 5, rose in both bases. |
| `origin-6-bg` | Background of source badges assigned palette 6, cyan in both bases. |
| `origin-6-fg` | Text and compact source dots for palette 6, cyan in both bases. |
| `origin-7-bg` | Background of source badges assigned palette 7, orange in both bases. |
| `origin-7-fg` | Text and compact source dots for palette 7, orange in both bases. |
| `origin-8-bg` | Background of source badges assigned palette 8, indigo in both bases. |
| `origin-8-fg` | Text and compact source dots for palette 8, indigo in both bases. |

## Tokens

These names describe the colour's role, regardless of its base value.
Custom colours and fonts apply to the app document, not to HTML doc contents inside sandboxed frames.
HTML docs in emend's look use built-in Dark or Light colours from the static `pub-frame.css`.
Its `prefers-color-scheme` query follows the embedding page's colour scheme, which a custom theme sets to its base.
The doc's own `data-theme` attribute or CSS can override that look.

A Download with a custom theme uses nine resolved token colours for the files emend draws:
the writeup, Markdown docs, docs shown as source, the comments file and omitted-content note pages.
These are `bg-reading`, `bg-sunken`, `fg-reading`, `fg-reading-strong`, `fg-reading-muted`,
`border-1`, `fg-link`, `diff-add-bg` and `diff-del-bg`.
Fonts and code-block colours stay unchanged.
An HTML doc downloads as its own bytes, without emend's injected styles.

### Surfaces

| Token | What it colours |
| --- | --- |
| `bg-app` | The page behind all panels and the image lightbox background. |
| `bg-surface` | Panels, dialogs, input fields and the diff's unchanged lines. |
| `bg-sunken` | Recessed areas such as code blocks, file headers and quote boxes. Also code and diff containers in the offline Download. |
| `bg-raised` | Menus, popovers and the active segment in a segmented control. |
| `bg-hover` | Hovered buttons, menu items and unchanged diff lines. |
| `bg-active` | Pressed controls and small count badges on tabs. |
| `bg-selected` | The selected source in the inbox rail and selected outline rows. |
| `bg-inverse` | Tooltip and toast backgrounds. |
| `bg-overlay` | The dim layer behind dialogs and sheets. |

### Text

| Token | What it colours |
| --- | --- |
| `fg-1` | Primary interface text, labels and input text. |
| `fg-2` | Secondary interface text, descriptions and file headers. |
| `fg-3` | Muted metadata, hints, captions, diff line numbers and hunk labels. |
| `fg-disabled` | Disabled input text and placeholders. |
| `fg-inverse` | Text in tooltips and toasts. |
| `fg-link` | Links in Markdown docs, writeups and the interface. Also links in the offline Download. |
| `fg-link-hover` | Hovered links in Markdown docs, writeups and the interface. |

### Borders and focus

| Token | What it colours |
| --- | --- |
| `border-1` | Subtle panel, card, table and code-block borders. Also borders in the offline Download. |
| `border-2` | Input outlines, blockquote lines and stronger table separators. |
| `border-strong` | Radio outlines and hovered input borders. |
| `border-focus` | Focused input borders. |
| `focus-color` | The general outer keyboard-focus ring around controls and focusable content. |

### Reading

| Token | What it colours |
| --- | --- |
| `bg-reading` | The document reading pane background. Also the offline Download page. |
| `bg-reading-card` | Writeup summary cards. |
| `fg-reading` | Body text in Markdown docs, writeups and comments. Also body text in the offline Download. |
| `fg-reading-muted` | Quiet and muted writeup sections. Also metadata and muted text in the offline Download. |
| `fg-reading-strong` | Reading headings, strong text and inline code. Also strong text in the offline Download. |

### Accent

| Token | What it colours |
| --- | --- |
| `accent` | Primary buttons, count and revision badges, unread dots and phone-tab underlines. Also thread card borders, note-reference focus outlines, source selection lines, active diff-comment lines and active pane dividers. |
| `accent-hover` | Primary action buttons while hovered. |
| `accent-press` | Primary action buttons while pressed. |
| `accent-fg` | Text and icons on primary action buttons and accent count badges. |
| `accent-text` | Comment counts, note references and highlighted comment controls. |
| `accent-tint` | Selected radio cards, note references, selected source lines, hovered source line numbers and blocks whose comment anchors moved. Also rings around comment composers and hovered thread cards. |
| `accent-tint-2` | The soft ring around focused input fields and focused or jumped-to thread cards. |

### Marks

| Token | What it colours |
| --- | --- |
| `mark-bg` | Highlighted comment quotes, marked text and marked source lines. |
| `mark-bg-active` | The currently active comment highlight. |
| `mark-line` | Underlines beneath marked text and the line beside marked source lines. |

### Status

| Token | What it colours |
| --- | --- |
| `success-fg` | Approve button text and inline Approved labels and icons. |
| `success-bg` | The hovered Approve button background. |
| `success-solid` | The success colour mixed into the Approve button border. |
| `info-fg` | Information banner text and renamed-file marks. |
| `info-bg` | Information banner backgrounds. |
| `info-solid` | The information colour mixed into banner borders. |
| `warning-fg` | Warning text and icons, including thread placement warnings. |
| `warning-bg` | Warning banners and thread placement warnings. |
| `warning-solid` | The warning colour mixed into banner borders. |
| `danger-fg` | Error messages, destructive menu text and invalid field labels. |
| `danger-bg` | Error field rings, destructive hover areas and danger banners. |
| `danger-solid` | Invalid field borders and the colour mixed into destructive button and danger banner borders. |

### Review states

| Token | What it colours |
| --- | --- |
| `state-open-fg` | Open review label text and icon. |
| `state-open-bg` | Open review badge background. |
| `state-approved-fg` | Approved review badge text and icon. |
| `state-approved-bg` | Approved review badge background. |
| `state-settled-fg` | Settled review badge text and icon. |
| `state-settled-bg` | Settled review badge background. |
| `state-snoozed-fg` | Snoozed review badge text and icon. |
| `state-snoozed-bg` | Snoozed review badge background. |

### Agent

| Token | What it colours |
| --- | --- |
| `agent-waiting` | The pulsing dot when an agent is waiting for feedback. |
| `agent-working` | Reserved working-agent colour, exposed as an app colour utility. No current screen element uses it. |
| `agent-none` | The hollow pending-agent mark and the filled mark after feedback is picked up. |
| `agent-approved` | Reserved approved-agent colour, exposed as an app colour utility. No current screen element uses it. |

### Threads

| Token | What it colours |
| --- | --- |
| `thread-open` | Open thread dots, dashed unsent-thread rings and draft, unsent or open card state lines. |
| `thread-sent` | Sent thread dots and card state lines. |
| `thread-answered` | Answered thread dots and card state lines. |
| `thread-resolved` | Resolved thread rings. |

### Outcomes

| Token | What it colours |
| --- | --- |
| `outcome-fixed-fg` | Fixed outcome badge text and icon. |
| `outcome-fixed-bg` | Fixed outcome badge background. |
| `outcome-explained-fg` | Explained outcome badge text and icon. |
| `outcome-explained-bg` | Explained outcome badge and sent-thread badge backgrounds. |
| `outcome-held-fg` | Held outcome badge text and icon. |
| `outcome-held-bg` | Held outcome badge background. |
| `outcome-declined-fg` | Declined outcome badge text and icon. |
| `outcome-declined-bg` | Declined outcome badge background. |

### Changes

| Token | What it colours |
| --- | --- |
| `changed-fg` | Changed-since-last-read labels and file change indicators. |
| `changed-bg` | Changed-since-last-read and answered-thread badge backgrounds. |
| `changed-line` | The line beside a reading block changed since the last read. |

### Topics

| Token | What it colours |
| --- | --- |
| `topic-fg` | Topic rank text and example callout labels. |
| `topic-bg` | Topic rank backgrounds and writeup example callouts. |
| `topic-bg-2` | Reserved stronger topic tint, exposed as an app colour utility. No current screen element uses it. |
| `topic-solid` | Current topic rank backgrounds and selected topic markers in the outline. |
| `topic-line` | Topic guide lines and the line across the current diff topic header. |
| `topic-on-solid` | Text on the current topic's solid rank badge. |

### Syntax

These colours apply to highlighted diff code.
Rendered Markdown code blocks and source docs use their renderer's separate syntax colours.

| Token | What it colours |
| --- | --- |
| `syn-keyword` | Keywords in diff code. |
| `syn-type` | Type names in diff code. |
| `syn-function` | Function names in diff code. |
| `syn-string` | Strings, string expressions and highlighted links in diff code. |
| `syn-number` | Numbers and constants in diff code. |
| `syn-comment` | Comments in diff code. |
| `syn-punct` | Punctuation in diff code. |
| `syn-plain` | Plain diff code, parameters and text without another syntax colour. |

### Diff

| Token | What it colours |
| --- | --- |
| `diff-add-bg` | Added line and line-number backgrounds in a diff. Also added lines in the offline Download. |
| `diff-add-word` | Changed words within added diff lines. |
| `diff-add-hover` | Added diff lines while hovered. |
| `diff-add-fg` | Addition counts, addition markers and inserted-token text in a diff. |
| `diff-del-bg` | Deleted line and line-number backgrounds in a diff. Also deleted lines in the offline Download. |
| `diff-del-word` | Changed words within deleted diff lines. |
| `diff-del-hover` | Deleted diff lines while hovered. |
| `diff-del-fg` | Deletion counts, deletion markers and deleted-token text in a diff. |
| `diff-gutter` | The line-number gutter beside unchanged diff lines. |
| `diff-hunk-bg` | Diff hunk separators and headers. |
| `diff-select-bg` | Selected diff line backgrounds. |
