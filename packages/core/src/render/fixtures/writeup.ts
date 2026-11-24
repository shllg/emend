import type { TopicMeta, WriteupInput } from "@recense/contract";

export const topics: TopicMeta[] = [
  { slug: "labels", title: "Clear labels", importance: 70, summary: "Name each shelf." },
  { slug: "search", title: "Shelf search", importance: 10, summary: "Find a book." },
  { slug: "sorting", title: "Stable sorting", importance: 10, summary: "Keep matching books in order." },
];

export const writeup: WriteupInput = {
  overview: "# Lantern library\n\nFind **books** by title & author.\n\nA second paragraph.",
  tldr: "- Search shelves\n  - Keep familiar names\n- Sort results\n\n> Existing loans stay valid.",
  decisions: null,
  glossary: "| Term | Meaning |\n| --- | --- |\n| Shelf | A named group of books |",
  topics: {
    labels: { why: "Readable shelf labels.", body: "Use the catalog name." },
    search: {
      why: "Readers need a quick lookup.",
      example: "```ts\nconst title: string = 'Lantern';\n```",
      body: "Match the title and author.",
    },
    sorting: { why: "Equal matches keep their order." },
  },
};
