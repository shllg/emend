# UI guide

How to change what the reviewer sees in `apps/web`. Section 1 holds the north star and the UX
principles: the direction every change moves in. Sections 2 to 10 hold the rules. Each rule names a
value, a token, a behaviour or a state that must exist. Breaking a rule, or making a principle's
check worse, is a defect; anything beyond the principles and the rules is taste. Check at desktop
1600×1000 and phone 390×844, in Light and Dark (`localStorage["recense.theme"]` = `light` or
`dark`, then reload). Values live in `apps/web/src/styles/`; where a rule and the code differ, the
code wins and the rule gets fixed. The principles are targets: where the code still falls short of
one, an issue moves the code and its rule toward it. `.claude/rules/content-isolation.md` comes
first.

## 1. North star and UX principles

**North star: the content is the interface.** The reviewer's attention belongs to the agent's work:
the writeup, the pubs and, when they choose, the diff. recense should feel like paper, not like a
tool.

Each principle has a rule and a check that measures it. Where a rule in sections 2 to 10 still
differs from a principle, that rule describes today's code and stays until an issue changes it.

1. **Content first; chrome recedes.**
   - Rule: the reading surface gets the screen. Chrome is quiet text on hairlines, with fills only
     for a state. Headers fold away while reading.
   - Check: measure the content share of the viewport. A change never lowers it.
2. **Decision first, detail on demand.**
   - Rule: every surface opens with what the reviewer must decide. Detail is one deliberate step
     away, at most two levels deep. The first screen holds about four groups.
   - Check: at 1280×800 and 390×844, the ask (decisions owed, TL;DR) shows without scrolling.
3. **Writeups and pubs lead; the diff is ranked, chunked and honest.**
   - Rule: reading comes first. When the reviewer opens the diff, it follows topic rank, then
     reading order, never the alphabet. One topic reads as one chunk with a clear start and end.
     Viewed state follows the file's content. Coverage shows calmly at Approve.
   - Check: file order matches the topic order; a changed file loses its viewed mark; Approve
     names what was not viewed, without blocking.
4. **Comfortable reading by default.**
   - Rule: by default, prose lines hold about 60 to 75 characters. The reader's width choice
     (Narrow, Comfortable, Wide) persists, so readers who prefer longer lines keep them. Code,
     tables and diagrams may use the full column. Prose stays at 16 px or more, with a line height
     near 1.6. Light and dark both stay first-class.
   - Check: count characters per prose line at 1280, 1600 and 1920 px with the default width.
5. **The accent is scarce.**
   - Rule: ochre marks only Needs you, the reviewer's unsent work, Send and focus. Links are text
     colour with an underline. New in this revision uses the violet of "Changed in revision N".
     Red stays for errors and High risk.
   - Check: count accent elements on the opening screen.
6. **Quiet, not hidden.**
   - Rule: actions used on every review stay in reach: comment, Send, Approve. An action for one
     item shows when the reader points at it, focuses it or picks it, never as a permanent icon
     beside every paragraph. A pick or a text selection offers Comment in one bottom bar, on every
     surface.
   - Check: on the phone, count controls that are not content in the first screen.
7. **Never move under the reader; resume exactly.**
   - Rule: live updates never shift what the reader sees. Position, open folds and unsent drafts
     come back per review. A returning reviewer sees what changed since they looked.
   - Check: no layout shift during a live update; reload restores the reading position.
8. **State is calm and certain.**
   - Rule: every review answers three questions at a glance: reviewed, changed, PR state
     (`VISION.md`). Agent state is one word, a mark and a time. No motion that never ends.
   - Check: after five seconds, nothing on screen moves without the reader's action.
9. **Configurable within guarantees.**
   - Rule: the default theme is the product. Few settings: theme, text size, width, density.
     Themes change semantic tokens only; contrast is checked when a theme loads; density changes
     chrome, never reading text or touch targets.
   - Check: every theme passes the readability pairs; tap targets stay 40 px or more at every
     density.

## 2. Core rules

1. **Content first.** Writeup, docs and diff fill the page. Chrome is `--fg-2` and `--fg-3` text
   on `--border-1` hairlines. Fills appear only for a state.
2. **One meaning per colour.** Accent (ochre) is the reviewer's own action: unsent work, the
   primary button, focus, selection, and on a writeup card a decision the reviewer owes (Needs
   you). Blue is the agent (`--agent-waiting`, `--thread-sent`). Violet is "changed since an
   earlier revision" (`--changed-*`); the New in this revision card uses `--fg-link`, not violet.
   Teal is topic navigation (`--topic-*`). Green and red are added and deleted lines, success and
   danger; green is also Approved. Callouts use `--info-*` and `--warning-*`. No hue is
   decoration.
3. **Colour never works alone.** Every state also shows a word, an icon or a dot shape.
4. **One card for written words.** Composer, comment, agent reply and agent note share `.em-card`.
5. **The frame stays put; panes scroll.** On the inbox, review, Settings and Devices pages
   `document.scrollingElement.scrollHeight <= innerHeight`; the top bar never moves.
6. **The page never moves under the reader.** No live update switches the revision, takes focus
   or shifts the pane being read.
7. **Nothing essential hides behind hover.** Focus reveals it too; touch screens always show it.
8. **Choices stay in the browser**: pane mode, widths, text sizes, diff layout, wrap, agent notes,
   resolved threads, file order, topic details and inbox collapse in `localStorage` key
   `recense.layout.v1` (`lib/layout-store.ts`), with the Tabs move marked in
   `recense.layout.tabs-default`; the theme in `recense.theme`, an own theme's text in
   `recense.theme.custom`. **One URL, one view**: `?tab=` and the other parameters work on any
   screen.
9. **Fixed behaviours**, each a defect when missing:
   - A new revision shows the banner "Revision N is ready." with **Show**; the page never
     switches revision by itself.
   - Send and Approve are disabled on an older revision ("Revision N is newer. Switch to it to
     send or approve."). On desktop the bar's button reads "Approve revision N"; on the phone it
     reads "Approve". Approve waits for unsent comments and asks first: "Approve revision N?".
   - On the phone a Send takes two taps: the bar's **Send** opens the "Send feedback" sheet, whose
     button names the count and the revision ("Send N … on revision N").
   - After a Send, a non-modal **Sent** notice appears above the Send bar inside the review pane.
     Returning to that review in the same tab shows the notice until the reader closes it or it
     closes itself after a pick-up.
   - A thread shows at its exact place, under **Unplaced**, or, on text the writeup no longer
     shows, under **Comments on hidden text** with the note "The writeup no longer shows the text
     this comment is on."; never at a guessed place.
   - Only the reviewer resolves or reopens a thread; an agent reply shows an outcome badge.
   - A file's role is the one the agent set; the UI never infers it from the file type.
   - An empty tab (Writeup, Files, Docs, Diff) is hidden. Comments always shows.

## 3. Layout and density

- Breakpoints from `useLayout()` (`lib/layout.ts`): phone below 768 px, tablet 768–1279 px,
  desktop from 1280 px; CSS uses `max-width: 767px` and `min-width: 768px`. No other viewport
  breakpoint; pane thresholds, such as the diff's 760 px, measure the pane.
- `.em-app` is an `h-dvh` column: top bar (`--topbar-h`), content, and on a review the Send bar
  (at least `--sendbar-h`; 52 px on the phone), then the phone tab bar. At regular density the
  top bar is 48 px and the Send bar 56 px.

| Review page | Desktop | Tablet | Phone |
|---|---|---|---|
| Inbox | Pane, 280 px default, drag 220–520 px; collapses to a 52 px rail | 52 px rail; opens as a left sheet | Own page, via the back link and More |
| Reading and diff | Tabs by default; Split from View → Panes | As desktop | One pane, bottom tabs |

- Split: the reading pane starts at `clamp(420px, 42%, 760px)` of the area, minimum 360 px, saved
  as a share; the diff keeps at least 440 px. A diff pane under 760 px renders Unified, with Split
  disabled and titled "Widen the diff pane for Split". Resize handles: 8 px hit area, a 1 px
  `--border-1` line that turns 3 px `--accent` on hover, focus and drag; double-click or Enter
  resets.
- Full-page views (inbox at `/`, Settings and its pages Integrations and the theme sample,
  Devices): one centred column, `max-width: 760px`, 20 px side padding, 32 px top, 80 px bottom.
- Reading column (`.em-reading-column`): the measure from View → Reading width, Comfortable 1024 px
  (default), Wide 1248 px or Narrow 68ch. From 768 px a 56 px left gutter holds the block comment
  button and change bars, right padding 32–56 px; below 768 px, 40 px each side. HTML docs in
  recense's look follow the same measure and text sizes.
- No sideways page scroll: `scrollWidth <= innerWidth`. Code, tables, diffs and long paths scroll
  or truncate inside their own box.
- Density: a theme picks compact, regular or roomy; `<html data-density>` sets `--density` to
  0.75, 1 or 1.25 (`styles/density.css`). Compact falls back to regular on any coarse pointer, so
  tap targets never shrink. `--touch-min`, `--tab-touch` and `--tabbar-h` never scale.
- Sizes at regular density: UI text 14 px (`--type-body`), controls 13 px (`--type-ui`), meta
  12 px. Heights `sm` 28 px, `md` 32 px (default), `lg` 40 px for Button, IconButton and fields
  alike; tab rows 40 px. Heights and spacing scale with `--density`; text sizes do not.
- Spacing from `--space-*` (2, 4, 6, 8, 10, 12, 16, 20, 24, 32, 40, 48, 64 px at regular) or the
  equal Tailwind steps; both scale with `--density`. A hand-set px in CSS uses
  `calc(Npx * var(--density))`. No new off-grid value, and no Tailwind `leading-<n>` in TSX (it
  scales with `--spacing`; `styles/density.test.ts`).
- Radii: `--radius-sm` 5 px small controls, `--radius-md` 7 px buttons and fields, `--radius-lg`
  10 px cards and menus, `--radius-xl` 14 px sheets and dialogs, `--radius-full` pills. Known
  exceptions, not to copy: `.em-writeup-card` 12 px, `.em-term-card` 8 px.
- Elevation: `--shadow-1` resting cards and buttons, `--shadow-2` hovered or focused cards and
  popovers, `--shadow-3` menus, dialogs, sheets, toasts. Layers: `--z-sticky` 10, `--z-bar` 20,
  `--z-sheet` 40 (content +1, menus +2), `--z-toast` 60, `--z-tooltip` 70; plain 1–4 only inside
  one component.

## 4. Type and colour tokens

Type (`styles/typography.css`):

- `--font-sans` and `--font-mono` default to Geist and JetBrains Mono. Six more are bundled in
  `apps/web/src/fonts/` and download only when a theme names them: Inter, Roboto, Atkinson
  Hyperlegible Next, Geist Mono, Roboto Mono, Fira Code (`lib/built-in-fonts.ts`). A theme can
  also bring font files from its own folder. Use the variables or `font-sans`/`font-mono`, never
  a family name. Nothing comes from another host. A CSS mono declaration also sets
  `font-feature-settings: var(--mono-features)` (no ligatures); TSX uses `font-mono`, never an
  arbitrary `[font:…]` utility (`styles.test.ts`).
- Sizes `--text-11` to `--text-40` (Tailwind `text-11` to `text-40`), never `text-xs`, `text-sm`
  or `text-base`. No new off-scale size; the 9.5–11.5 px values belong to counters and badges.
  Known exceptions, not to copy: the topic chip 12.5 px and topic title 19 px
  (`styles/reading.css`), the inbox jump number 10 px.
- Roles: `--type-h1` 600 24 px (page titles), `--type-h2` 600 18 px, `--type-h3` 600 15 px,
  `--type-body` 400 14/1.55, `--type-ui` 500 13 px, `--type-meta` 400 12 px, `--type-label` 500
  12 px, `--type-path` 13 px mono, `--type-prose` 16/1.7 (writeup, Markdown docs), `--type-code`
  13/1.6 mono (diff code). The reader picks prose at 15–18 px and code at 12–15 px, so prose and
  diff code use these roles and never a fixed px size.

Colour (`styles/colors.css`; Tailwind names in `styles/theme.css`: `--bg-surface` is `bg-surface`,
`--fg-2` is `text-fg-2`, `--border-1` is `border-line-1`):

| Group | Tokens | Use |
|---|---|---|
| Surfaces | `--bg-app`, `--bg-surface`, `--bg-sunken`, `--bg-raised`, `--bg-inverse` | Page; panes, cards; card heads, wells; menus; tooltips, toasts |
| Interaction | `--bg-hover`, `--bg-active`, `--bg-selected`, `--bg-overlay` | Hover; pressed or current; selected; behind overlays |
| Text | `--fg-1`, `--fg-2`, `--fg-3`, `--fg-disabled`, `--fg-inverse`, `--fg-link`, `--fg-link-hover` | Primary; secondary; meta and placeholders |
| Lines | `--border-1`, `--border-2`, `--border-strong`, `--border-focus`, `--focus-color`, `--focus-ring` | Hairlines; control edges; hovered controls; focus |
| Reading | `--bg-reading`, `--bg-reading-card`, `--fg-reading`, `--fg-reading-muted`, `--fg-reading-strong` | Writeup, docs, comment bodies |
| Accent | `--accent`, `-hover`, `-press`, `-fg`, `--accent-text`, `--accent-tint`, `--accent-tint-2`, `--mark-bg`, `--mark-bg-active`, `--mark-line` | The reviewer's action; commented text |
| Feedback | `--{success,info,warning,danger}-{fg,bg,solid}` | Results, errors, callouts |
| Review | `--state-{open,approved,settled,snoozed}-{fg,bg}`, `--agent-{waiting,working,none,approved}`, `--thread-{open,sent,answered,resolved}`, `--outcome-{fixed,explained,held,declined}-{fg,bg}`, `--changed-{fg,bg,line}`, `--topic-{fg,bg,bg-2,solid,line,on-solid}`, `--origin-{1…8}-{bg,fg}` | Status words, badges, bars |
| Diff | `--syn-{keyword,type,function,string,number,comment,punct,plain}`, `--diff-{add,del}-{bg,word,hover,fg}`, `--diff-gutter`, `--diff-hunk-bg`, `--diff-select-bg` | Syntax and change colours |

- No colour literal (hex, `rgb()`, `hsl()`, `oklch()`) outside `colors.css` and the shadow tokens
  in `spacing.css`. The exceptions: white behind an HTML doc that keeps its own look; the
  `theme-color` meta defaults in `lib/theme.ts`; the per-mode diagram class palette in
  `components/reading/mermaid-classes.ts`. A colour derived from a token (`oklch(from var(--x)
  …)`) is fine.
- Use a semantic token (chrome the app ones, writeup, docs and comment bodies the reading ones); a
  scale step (`--n-*`, `--ochre-*` …) only where none fits. Never Tailwind's palette
  (`text-neutral-500`, `bg-blue-600`).
- Dark mode and themes come only from token values: no `dark:` variant and no
  `prefers-color-scheme` query in a component. `<html data-theme>` carries Light, Dark or a
  theme's base. A user theme sets token values and the font variables inline on `<html>`, and
  its density as `data-density` (compact or roomy; regular sets none). A dark override in
  `colors.css`, `spacing.css` or `prose.css` exists twice: under
  `:root:not([data-theme="light"])` in the dark media query and under `[data-theme="dark"]`.
- A new colour token is a contract change: add it in order to the three blocks of `colors.css`,
  to `packages/core/src/theme/bases.ts`, to `THEME_TOKENS` in `packages/contract/src/themes.ts`,
  and to the Themes section of `docs/api.md` with its readability pairs (`styles/themes.test.ts`).
  It also shows on the theme sample page (`routes/theme-sample.tsx`), whose test fails when a
  theme token appears nowhere.
- The readability pairs in `docs/api.md` hold in both bases: text 4.5:1, syntax colours 3:1. The
  seven surface tokens and `--fg-1`, `--fg-2`, `--fg-3` stay opaque.
- Topic risk words (High, Medium, Low) are text colour only, no fill or border; only High uses
  `--danger-fg`.
- Diagram change classes (added green, changed amber, removed red and dashed) come from
  `mermaid-classes.ts`, one palette per mode; the legend sits inside the diagram.

## 5. Components and states

Build with `components/ui/`: Button, IconButton, Tabs, SegmentedControl, Select, TextField,
Textarea, Checkbox, RadioGroup, Menu, Dialog, Sheet, Tooltip, Toast, Banner, Kbd, Icon,
CopyTextMenu, PairingCodeInput. Never a second version of one. A new library, an icon set
included, needs the owner's approval.

- Icons: lucide-react through `Icon`, stroke 1.75, 16 px (14 with `sm`, 18 with `lg`),
  `aria-hidden` unless it carries meaning. An icon-only control is an IconButton whose `label` is
  its accessible name and tooltip (350 ms).
- Buttons: `primary` (accent fill) for the main action, at most one per bar, card, dialog or
  sheet; `secondary` by default; `ghost` for quiet actions and Cancel; `approve` only for Approve;
  `danger` for delete, retire and revoke. A destructive action confirms in a Dialog whose least
  destructive button has `data-autofocus`.
- Status has one component each; reuse it, never restyle a state in place: StateBadge (Open,
  Approved, Retired), SnoozeBadge, AgentStatus (Agent waiting: ringed dot that pulses three times;
  Not picked up yet: hollow dot; Picked up: grey dot and time; Approved: check), ThreadStateBadge
  (Unsent: dashed ring; Resolved: hollow ring), OutcomeBadge, ChangedMarker, OriginBadge (8 tints by
  machine id).
- The proof-kind pill (`.em-proof-kind`) sits at the start of the item's first line. It is filled
  for Ran, tinted with a solid border for Read, and dashed for Reasoned.
- Cards (`.em-card`, `styles/threads.css`): 1 px `--border-1`, `--radius-lg`, `--shadow-1`; a
  36 px `--bg-sunken` head with the target in `--type-path` and a state pill; a 3 px left bar in
  `--thread-open` (draft, unsent, open), `--thread-sent`, `--thread-answered`, none when resolved.
  Hover (hover-capable pointers): `--accent` edge, 3 px `--accent-tint` ring, `--shadow-2`. Focus
  inside or a jump target (`data-jump`): 3 px `--accent-tint-2` ring. A card fills its column and
  never widens it; Split stays 50/50.
- Inbox sections: Pinned (open at start, above Active), Active (open at start, foldable),
  Snoozed, groups, Done. A pinned item also shows a pin mark in its own section. The first ten
  open rows show a jump number (`data-jump-number`) for Alt+1 to Alt+0; a folded section has none.
- Inbox rows: a row that needs the reviewer gets an accent dot and medium weight. Approved and
  done rows sit at 60 % opacity until hover, focus or current; a moved row is 50 % and no link.
- Row actions: right-click, Shift+F10 or the menu key opens the review's actions menu; on touch a
  left swipe reveals a 56 px ⋯ button. The menu is the same in the pane, the page, the tablet
  sheet and the collapsed rail. Escape returns focus to the row; when the action hides the row,
  focus moves to a neighbour.
- Pinned order: the drag grip shows only with a fine, hovering pointer, never on the phone. Move
  up and Move down in the row menu work on every device; a screen reader hears the new place.
- Text for an agent to paste is a `CopyPrompt`: a mono well and a Copy button that reads "Copied"
  and announces the result in a `role="status"` line, not a toast.
- Banner: info, warning, danger or neutral; at least 40 px; one action at most, plus dismiss;
  role `status`, `alert` for danger. Toast (`useToast`): one at a time, bottom centre above the
  Send and tab bars, 3.2 s, polite; only for the result of a one-shot action ("Link copied").
- Overlays: Dialog (`alertdialog`, `min(440px, 92%)`) for a decision; Sheet (right 400 px, left
  340 px, bottom up to 85 % of the visual viewport, or full) for a panel; Menu for actions or
  choices. Dialogs and sheets dim the page with `--bg-overlay`.

States. A part that can be in one of these states shows it:

- **Empty:** an `--fg-3` sentence naming what is empty, plus the next step or a way out: "No
  comments yet." with "Select text in the writeup or a doc, or click a line in the diff.".
- **Loading:** a `role="status"` line "Loading <thing>…" where the content will appear. A waiting
  button uses `loading` (spinner, `aria-busy`, inactive). No skeletons, no page-wide spinner.
- **Error:** a `role="alert"` sentence "Could not <verb> <thing>." with **Retry** or "Try again."
  in place of the content; a failed one-shot action shows a danger toast with `mutationMessage`;
  a field error uses the field's `error` prop. Never a raw error code or stack trace.
- **Disabled:** native `disabled` (`aria-disabled` with `asChild`), opacity .48 on Button and .45
  on IconButton and menu items, `cursor: not-allowed`. A disabled main action says why in one
  sentence, in `title` and through `aria-describedby`, as Send and Approve do.
- **Hover:** `--bg-hover` on ghost controls and rows, `--bg-sunken` with `--border-strong` on
  secondary buttons, `--fg-link-hover` on links. Hover changes colour and shadow, never layout.
- **Active:** `--bg-active` while pressed; Button moves 0.5 px down; primary turns `--accent-press`.
- **Selected or current**, in ARIA as well as colour: a tab has `aria-selected` and a 2 px
  `--ochre-500` underline; a phone tab `aria-current="page"` and a 2 px `--accent` top bar; an
  inbox row `aria-current="page"` and `--bg-active`; a segment `aria-checked` and `--bg-raised`;
  a toggle IconButton `aria-pressed` or `aria-expanded` and `--bg-active`; a menu choice a check.

## 6. Writeup and docs

- The writeup runs in four layers: Decide, Frame, Topics, Trail. `DepthMarker` follows the
  scroll: in the reading tab row on desktop and tablet, compact in the header on the phone. A
  layer without content shows at 0.4 opacity; the current one has `aria-current="step"`.
- The opening is one-line rows in two groups, Risk then Frame. The topic index has one line per
  topic in importance order: rank, title, risk word, summary; each line jumps to its topic.
- Writeup cards (`.em-writeup-card`): TL;DR, New in this revision (from revision 2) and Needs
  you, each 1 px `--border-1` on `--bg-reading-card` with a 3 px left bar (Needs you
  `--ochre-400`, New `--fg-link`). New shows four lines, then "and N more" in a fold. Needs you
  holds at most four lines and a status line. A writeup without the field shows neither card.
- Changes since an earlier revision show as `ChangedMarker` ("Changed in rev N", "revision N" for
  screen readers) with a violet line. A closed Details or glossary fold whose block changed shows
  the marker in its summary until it opens.
- Callouts (`> [!NOTE]`, `TIP`, `IMPORTANT`, `WARNING`, `CAUTION`): notes in `--info-fg` on
  `--bg-sunken`, warnings in `--warning-fg` on `--warning-bg` (`styles/prose.css`). The label
  comes from `::before`, never text, so block ids stay.
- A Before and After image pair offers Before, After and Side by side; a third image with alt
  text "Diff" adds a Diff mode.
- A changed image in the diff offers Before, After and Side by side. An added image shows After, and a deleted image shows Before.
  Each picture opens in the lightbox. A side over 25 MiB shows a Not shown line. An SVG offers Pictures and Text.
- Hover cards (`.em-term-card`, 20 rem, `--bg-raised`, `--shadow-3`, `--z-tooltip`): a glossary
  term or an issue or PR number opens one on hover, focus or tap, a term also on Enter or Space.
  A number without a recorded title stays a plain link.

Agent content (detail in `.claude/rules/content-isolation.md` and `doc-navigation.md`):

- Writeup, Markdown docs and comment bodies arrive as sanitized HTML; only `BlockView.tsx` puts
  them on the page. HTML docs show only in their sandboxed frame; Mermaid draws in its own
  frames.
- App CSS never reaches into a frame. An HTML pub gets recense's look by default; only
  `<meta name="recense-look" content="custom">` opts out. A doc in recense's look gets
  `styles/pub.css` (built into `pub-frame.css` from the same tokens) and follows the Light, Dark
  or System pick and an own theme through `recense:theme`; a doc without dark styles stays light.
  Changing the pub style, a frame attribute or the bridge needs `recense-security-reviewer`.
- Diff text renders through `@pierre/diffs` with the `recense` syntax theme on `--syn-*`
  (`components/diff/theme.ts`); style around it, never put HTML into it.

## 7. Keyboard and focus

- Every control is reachable with Tab in visual order and has an accessible name.
- `:focus-visible` shows `--focus-ring` (2 px `--bg-surface` gap, 2 px `--focus-color`) through
  `focusRing` in `ui/utils.ts`. Tabs use a 2 px inset `--ochre-500` ring; text fields
  `--border-focus` with a 3 px `--accent-tint-2` glow. `outline: none` without one of these is a
  defect. An element only script focuses (`tabIndex={-1}`: headings, panes) shows no ring.
- A composite widget is one tab stop with arrow keys: Tabs, SegmentedControl and RadioGroup
  (arrows, Home, End), Menu. A resize handle is `role="separator"` with `aria-valuenow`: Left and
  Right move 16 px, 64 px with Shift; Home and End go to the limits; Enter resets.
- Overlays keep focus inside. A Dialog focuses its `data-autofocus` button, a Sheet its content or
  `initialFocus`. Escape closes the innermost layer only (composer, popover, menu, sheet, dialog).
  On close focus returns to the opener or a named fallback, never to `<body>`.
- ⌘↵ or Ctrl+↵ saves a comment, and sends from the instructions field.
- A command shortcut needs a default in `SHORTCUT_DEFAULTS` (`packages/contract/src/settings.ts`),
  a label in `shortcutLabels` (`lib/shortcuts.ts`) and a handler through `useShortcut`.
  `ShortcutProvider` is the only global command listener. The command then shows in the `?`
  dialog and in Settings → Keyboard shortcuts, where it can be changed or turned off.
- `?` lists the bindings. Defaults include j/k next and previous review, 1–5 tabs, n/p file,
  v viewed, `.`/`,` thread, s instructions, Shift+A approve, z snooze, Shift+P pin, Alt+1 to
  Alt+0 inbox rows, Ctrl or ⌘+Shift+P the palette.
- The palette ("Search reviews and commands") lists commands and a "Reviews and pubs" group;
  done items rank below the rest.
- Shortcuts never fire in a text field, a select or contenteditable, with Alt (except Alt+digit,
  the inbox jump keys), during IME composition, or while a dialog, sheet or menu is open. A
  handler that cannot act returns `false`.
- A key shown in the UI comes from the current binding through `keyLabel`; never write a
  changeable key into a label. Announce without moving focus: `role="status"` for changes,
  `role="alert"` for failures.

## 8. Phone

Below 768 px; check at 390×844.

- One pane at a time. The top bar has "‹ Inbox" on a review or the wordmark elsewhere, and the ⋯
  More menu on the right; its height is `--topbar-h` plus the top safe area.
- Bottom tabs on a review only: Writeup, Files N/M, Docs, Comments, Diff, each hidden when empty
  except Comments; 48 px tall (`--tab-touch`), an 18 px icon over an 11 px label. Comments shows
  "unsent / not resolved / all", filled with accent while anything is unsent.
- The Send bar sits above the tabs: unsent count and revision, Approve and Send at `lg`. Send
  opens the bottom sheet "Send feedback": mode cards, instructions and a full-width button that
  names the count and the revision.
- A new comment's composer opens in a bottom sheet; a reply stays inline. Bottom sheets sit above
  the on-screen keyboard (`--keyboard-inset`), so the keyboard never covers the field.
- The More menu holds what desktop bars hold. Update items come first when an update waits. On a
  review: on the Diff tab the file list, then Refresh, Search reviews and commands, Copy link,
  Comment on review, Download, text sizes, Long lines, on the Diff tab Agent notes, then Inbox,
  Devices, Settings. Elsewhere: Refresh, Search, Devices, Settings, Pair a device. Every desktop
  action has a phone place, except Panes, Reading width, Split or Unified, resize handles, inbox
  collapse and the pin drag grip.
- Diffs are always Unified; long lines follow Scroll or Wrap; a path truncates from its start and
  keeps the file name.
- In a diff, swipe from a line number to scroll or tap it to comment on that line. To comment on
  a range, hold a line number for about half a second, then drag.
- Touch targets at least 40×40 px (`--touch-min`); menu, palette and list rows 44 px on coarse
  pointers; tabs 48 px. Buttons in the composer and the Send sheet use `lg`.
- Text entry is 16 px on touch screens (`styles/touch-fields.css`) so iOS does not zoom; a field
  already at 16 px or more sets `data-own-size`. The page stays zoomable.
- Top bar, tab bar and bottom and full sheets pad with `env(safe-area-inset-*)`; nothing tappable
  sits under the home indicator.
- Shortcuts are off; nothing depends on one. What waits for hover on a fine pointer shows always.

## 9. Motion

- `--dur-1` 90 ms for hover, press, colour and tooltips; `--dur-2` 160 ms for overlay and dialog
  fades; `--dur-3` 240 ms for sheets and toasts; `--dur-pulse` 1600 ms for the Agent waiting dot
  only. Entrances ease with `--ease-out`. Reuse the keyframes `em-fade`, `em-sheet-up`,
  `em-sheet-right`, `em-sheet-left`, `em-tooltip`, `em-pulse` and `em-spin`.
- Motion only confirms a change: an overlay or toast arrives, a control answers, a spinner waits,
  a new inbox row fades from `--accent-tint` over 1 s. When waiting starts, the waiting dot pulses
  three times (4.8 s), then holds still. Its ring sets it apart from the grey Picked up dot.
  The review header also shows the words "Agent waiting", and an inbox row names the dot
  "Agent waiting" for screen readers. Only spinners loop, and only while work runs. No decorative
  motion and no entrance over 240 ms.
- Animate opacity, transform, colour and shadow only, never size or position; a resize drag
  follows the pointer. Jumps to a thread, file, topic or heading are instant, never smooth.
- CSS animations and transitions only. `prefers-reduced-motion: reduce` cuts each to 1 ms and runs
  every animation once (`animation-iteration-count: 1` in `styles/base.css`) so it shows its end
  state and holds still. The waiting dot stays still and spinners stand still, while `aria-busy` and
  the inactive button keep the busy state clear. One-off highlights such as the inbox arrival are
  skipped there.

## 10. Copy

`docs/standards.md`, section "UI text", holds the wording rules. This section adds the app's
patterns only.

- Counts use `plural()` from `lib/count.ts`: "1 comment", "2 comments".
- Write "revision" in sentences and buttons. "rev N" only in compact badges, with "revision N" for
  screen readers, as ChangedMarker does.
- Labels and buttons use sentence case; a button names its action with a verb ("Clear filter").
- Mode labels come from `MODE_LABELS`, outcome names from the contract; never retype them. Their
  wording is shared with hunk-review-skill under the sync rule in `AGENTS.md`.
