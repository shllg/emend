import type { TopicMeta, WriteupInput } from "@emend/contract";

export const SAMPLE_HTML_PATH = "sample.html";
export const SAMPLE_SVG =
  '<svg xmlns="http://www.w3.org/2000/svg" width="240" height="120" viewBox="0 0 240 120"><rect width="240" height="120" rx="12" fill="#e2e8f0"/><circle cx="60" cy="60" r="30" fill="#2563eb"/><path d="M120 85l35-50 45 50z" fill="#16a34a"/></svg>';
export async function sampleImageHash(): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(SAMPLE_SVG));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

export const SAMPLE_TOPICS: TopicMeta[] = [
  {
    slug: "delivery",
    title: "Deliver a parcel",
    importance: 1,
    summary: "Keep the delivery steps visible.",
    attention: "critical",
    door: "one-way",
    blastRadius: { scope: "queue", note: "Affects queued parcels." },
  },
  {
    slug: "tracking",
    title: "Track progress",
    importance: 2,
    summary: "Show the current step.",
    attention: "review",
    door: "two-way",
  },
  {
    slug: "cleanup",
    title: "Remove old labels",
    importance: 3,
    summary: "Retire unused labels.",
    attention: "skim",
    door: "two-way",
  },
];

export const SAMPLE_MARKDOWN = `# Parcel guide

A **parcel** has *one destination*, a [tracking guide](https://example.com/guide), and an inline \`label\`. ~~Old labels~~ are retired.

## Preparation

1. Read the label.
   1. Check its destination.
   2. Check its size.
2. Pack the parcel.

### Packing

- Choose a box.
  - Small parcels use a small box.
  - Large parcels use a large box.
- Attach a label.

#### Checklist

- [x] Label printed
- [ ] Parcel collected

##### Sizes

| Size | Capacity |
| :--- | ---: |
| Small | 2 |
| Large | 8 |

###### Note

> A readable label helps each parcel reach its destination.

---

\`\`\`typescript
// Choose a destination.
interface Parcel { label: string; size: number }
export function pack(parcel: Parcel): string {
  const ready = true;
  return ready ? parcel.label : "pending";
}
\`\`\`

\`\`\`json
{ "label": "small", "capacity": 2, "ready": true, "extra": null }
\`\`\`

\`\`\`sh
# Print the label.
label="small"
printf '%s\\n' "$label"
\`\`\`

\`\`\`yaml
parcel:
  label: small
  capacity: 2
  ready: true
\`\`\`
`;

export const SAMPLE_WRITEUP: WriteupInput = {
  area: "Parcel delivery",
  overview: SAMPLE_MARKDOWN,
  tldr: "A parcel moves from packing to delivery. This sample shows text, diagrams, files and feedback.",
  whyItMatters: "Clear labels make progress easier to follow.",
  review: { level: "everything", reason: "Check the delivery steps and their examples." },
  checked: "The small and large parcel examples.",
  notChecked: "No real parcels were sent.",
  whereToLook: "Start with the delivery diagram.",
  outOfScope: "Real addresses and live deliveries.",
  context: "All content on this page is synthetic.",
  decisions: "Drift: the label now includes the parcel size.",
  glossary: [{ term: "parcel", definition: "A small package prepared for delivery.", aliases: ["parcels"] }],
  topics: {
    delivery: {
      why: "A parcel follows a short, visible route.",
      example:
        "```mermaid\nflowchart LR\n  Pack[Pack parcel] --> Check{Label ready?}\n  Check -->|Yes| Send[Deliver parcel]\n  Check -->|No| Pack\n```\n\n![Two parcel shapes](sample.svg)",
    },
    tracking: {
      why: "The sender can see when the parcel is ready.",
      example:
        "```mermaid\nsequenceDiagram\n  participant Sender\n  participant Queue\n  Sender->>Queue: Prepare parcel\n  activate Queue\n  Note right of Queue: Check label\n  Queue-->>Sender: Ready\n  deactivate Queue\n```\n\n```mermaid\nstateDiagram-v2\n  [*] --> Packed\n  Packed --> Checked\n  Checked --> Delivered\n  Checked --> Held\n  Held --> Packed\n  Delivered --> [*]\n  class Packed blue\n  class Checked teal\n  class Delivered purple\n  class Held mayBreak\n```",
    },
    cleanup: {
      why: "Unused labels no longer need maintenance.",
      example:
        "```mermaid\nclassDiagram\n  class Parcel {\n    +String label\n    +pack()\n  }\n  class Label {\n    +String size\n  }\n  Parcel --> Label\n```",
    },
  },
};

export const SAMPLE_HTML = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="emend-look" content="emend"><title>Parcel handbook</title></head>
<body><main><article><header><h1>Parcel handbook</h1><p>A synthetic HTML publication.</p></header>
<section><h2>Preparation</h2><p>Use a <strong>clear label</strong> and <em>check the size</em>. Read the <a href="https://example.com/handbook">handbook</a>.</p>
<blockquote>Every parcel starts with a label.</blockquote><ul><li>Choose a box<ul><li>Check the fit</li></ul></li><li>Pack it</li></ul>
<table><caption>Parcel sizes</caption><thead><tr><th>Size</th><th>Capacity</th></tr></thead><tbody><tr><td>Small</td><td>2</td></tr></tbody></table>
<p>Print <code>label</code>, press <kbd>Enter</kbd>, and read the <mark>result</mark>.</p><pre><code>label: small\nready: true</code></pre></section>
<section><h2>Delivery</h2><pre class="mermaid">flowchart LR
  Pack --> Check --> Deliver</pre><details open><summary>More detail</summary><p>A parcel stays in its box.</p></details></section>
<footer><small>End of the sample handbook.</small></footer></article></main></body></html>`;

export const SAMPLE_SOURCE_PATH = "parcel.ts";
export const SAMPLE_SOURCE =
  "// Prepare a parcel.\ninterface Parcel { label: string; size: number }\nexport function pack(parcel: Parcel): string {\n  const count = 2;\n  return parcel.label + count;\n}\n";
export const SAMPLE_DIFFS = [
  {
    path: "delivery.ts",
    topic: "delivery",
    old: 'export function label(size: number): string {\n  // Prepare a label.\n  return "small";\n}\n',
    new: 'export function label(size: number): string {\n  // Prepare a label.\n  return size > 2 ? "large" : "small";\n}\n',
  },
  {
    path: "queue.json",
    topic: "tracking",
    old: '{\n  "capacity": 2,\n  "ready": false\n}\n',
    new: '{\n  "capacity": 8,\n  "ready": true\n}\n',
  },
  { path: "labels.yaml", topic: "tracking", old: "", new: "labels:\n  - small\n  - large\n" },
  { path: "old-label.sh", topic: "cleanup", old: '# Old label\nprintf "small\\n"\n', new: "" },
];
