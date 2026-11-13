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

## Glossary

Give brief definitions of the domain terms the text uses.
Prefer existing project meanings and omit general programming terms.
Write the glossary as a list, one term per item.

- A review writeup holds it in `glossary`.
- A document that uses such terms holds it under a "Glossary" heading.

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
