# Writing for the reader

emend-review, emend-feedback and emend-publish share these rules. Follow them for a review
writeup, a feedback reply and every document you write to publish. Each section says where it
applies. A document the user wrote is published as it is.

## Sentences

Keep each section useful to someone who has not opened the code.
Put the effect before the mechanism, explain unfamiliar terms, and cite paths you inspected.
Answer first, then give the reason and relevant validation.
Use one fact per sentence and short sentences of 20 words or fewer.

## TL;DR

Open with two or three short sentences on what this work is and why it matters for the project.
Name the issue or plan task it serves when there is one.
The reader reads it first, often straight from other work.

- A review writeup holds it in `tldr`.
- A document opens with it, under a "TL;DR" heading right after the title.

## Why and Example

A review topic's `why` explains what the area does, the problem and the fix.
Its `example` shows a concrete before/after case.
Keep examples grounded in the actual change.
A document that explains a change or a proposal gives the same why and a grounded example.

## Review verdict and risk

This section applies to a review writeup. It tells the reviewer how deep to read, and why.
The reviewer decides. Your verdict is advice, and Checked and Not checked are its evidence.

### Risk, in plain words

Give each topic one risk level in `attention`. Set the value in brackets; the app shows the word.

- Low (`skim`): a rare path, and tests cover it. Mechanical changes, renames and wording are Low.
- Medium (`review`): a common path can break, and users notice.
- High (`critical`): data loss, a security hole, money, or an outage.

Rate what breaks if the change is wrong, not what the code touches.
Touching auth is not risky by itself; breaking it is.
Most reviews have no High topic. Mark at most one topic High.
If two topics seem High, the change is too big. Say so under **Biggest risk** in `whereToLook`.

### Sensitivity

Sensitivity is a plain tag, not a level. Put it in the topic's `blastRadius.scope`.
Use `auth`, `data`, `money`, `privacy` or `network` when the topic touches one of them.
Otherwise use one word for who or what is affected.
`blastRadius.note` says how a break would show.

### Undo, in plain words

Every topic has one of three undos:

- Revert.
- Revert, then a named repair: "Revert, then rerun the import."
- Cannot be undone, with the step named: "Cannot be undone: drops column `x`."

Without a named step, the undo is a revert.
When a revert is not enough, end the topic's `why` with a line that starts with **Undo:**.
A feature flag does not undo writes already made.

### The verdict

`review` holds the verdict: one of three levels and one short sentence, `reason`, that says why.

- `skim` shows as "Skim, then merge.": every topic is Low risk, the undo is a revert or a revert
  plus one named repair, and the checks cover the changed behavior.
- `topics` shows as "Read topics" with their titles: one or two topics carry Medium risk or need a
  repair. List their slugs in `topics`. With more than two such topics, read everything.
- `everything` shows as "Read everything.": any High topic. Every data migration lands here.

`checked` lists what you actually ran or verified: commands, tests, manual checks.
`notChecked` lists what you did not run or verify. Neither is ever empty.
If you ran nothing, say so in `checked`.
When in doubt, pick the deeper level and say why in `reason`. Never round down.

### Data migrations

A data migration always states, in its topic:

- what data changes, and roughly how much;
- whether it can be reversed, and how;
- how it was tried: a dry run, or a copy of the data;
- what to watch after the deploy.

### Worked examples

These cases are synthetic. Each shows the topics, the verdict and its evidence.

**Low: skim, then merge.** A change renames `fetchUser` to `loadUser` in eight files.

- Topic "Rename the user loader": Low. The undo is a revert.
- `review`: `{ "level": "skim", "reason": "A rename that the type checker and the tests cover." }`
- `checked`: the full test suite and the type check pass.
- `notChecked`: no manual run of the app.

**Medium: read topics.** A change caps request retries at three and rewords a settings label.

- Topic "Retry budget": Medium, because every request passes the loop. The undo is a revert.
- Topic "Settings label": Low. The undo is a revert.
- `review`: `{ "level": "topics", "topics": ["retry-budget"], "reason": "Every request passes the new retry loop." }`
- `checked`: unit tests for one, two and three failed attempts.
- `notChecked`: a real network that drops requests.

**High: read everything.** A data migration moves invoice amounts from decimals to whole cents.

- Topic "Cents migration": High, because it rewrites stored money. Its `why` ends with
  "**Undo:** Cannot be undone: drops column `amount_decimal`."
- The topic states the migration facts: it rewrites about 1.2 million invoice rows. Only the
  backup taken before the deploy reverses it. A dry run on a copy of last week's data matched every
  total to the cent. After the deploy, watch the nightly totals report and failed invoice creation.
- `review`: `{ "level": "everything", "reason": "A data migration rewrites every stored invoice amount." }`
- `checked`: the dry run on the copy and the full test suite.
- `notChecked`: the migration's run time on the live table under load.

## Glossary

Give brief definitions of the domain terms the text uses.
Prefer existing project meanings and omit general programming terms.
Keep it to at most 12 terms and one short sentence per definition.
A review writeup holds it in `glossary` as a list of entries with `term`, `definition` and optional `aliases`.
emend marks each term's first use in every section.
It shows the definition when the reader points at it.
Add an alias for another form the text uses, such as an abbreviation.
A document keeps its glossary as a list under a "Glossary" heading, one term per item.

## Screenshots

A review writeup or a document can show images, such as before and after screenshots of a UI change.

In a review writeup:

- List each image under `media`, as [the manifest reference](manifest.md) says.
- Reference it from any writeup section with `![Alt](path)`. The alt text becomes the caption.
- Put a before and an after image in one paragraph, with alt text "Before" and "After", to show them
  side by side.
- Only listed paths render. Any other image reference in the writeup is dropped.
- Remote image URLs do not show. List the file under `media` instead.
- Images do not render in Markdown docs.

In a published document, Markdown shows no local images yet; use HTML for images.

## HTML pages

These rules hold for every HTML document you write to publish.

- Keep the page self-contained. emend runs none of its scripts and loads nothing from other hosts.
  Use no CDN scripts, styles or fonts.
- Keep images and styles beside the file, using relative paths.
- Give the main column a max width of 1024px.
- Use body text around 18px with a line height around 1.65.
