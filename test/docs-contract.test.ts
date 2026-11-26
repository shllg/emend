import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, expect, test } from "vitest";
import { checkDocs } from "./docs-contract.ts";

const repo = fileURLToPath(new URL("..", import.meta.url));
const fence = "```";
const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

const png = (width: number, height: number): Buffer => {
  const buffer = Buffer.alloc(33);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(buffer);
  buffer.writeUInt32BE(13, 8);
  buffer.write("IHDR", 12, "latin1");
  buffer.writeUInt32BE(width, 16);
  buffer.writeUInt32BE(height, 20);
  return buffer;
};

type Files = Record<string, string | Buffer>;
type Manifest = {
  schema: number;
  pages: Record<string, unknown>[];
  screenshots: Record<string, unknown>[];
  [key: string]: unknown;
};

const manifest = (): Manifest => ({
  schema: 1,
  pages: [
    { id: "setup", path: "setup.md", title: "Setup", description: "How to set up." },
    { id: "a", path: "setup/a.md", title: "Page A", description: "Page A helps." },
    { id: "usage", path: "usage.md", title: "Using", description: "How to use." },
  ],
  screenshots: [
    { file: "images/review-desktop.png", view: "review", device: "desktop", theme: "dark", width: 100, height: 50 },
  ],
});

const validFiles = (): Files => ({
  "docs/site.json": `${JSON.stringify(manifest(), null, 2)}\n`,
  "docs/setup.md": [
    "# Setup",
    "",
    "Lead with [page A](setup/a.md#undo) and [usage](usage.md).",
    "",
    "## The setups",
    "",
    "![Review screen](images/review-desktop.png)",
    "",
  ].join("\n"),
  "docs/setup/a.md": [
    "# Page A",
    "",
    "Lead of A, see [setup](../setup.md#the-setups) and [here](#undo).",
    "",
    "## Set it up with an agent",
    "",
    `${fence}text prompt`,
    "Rules: do it.",
    fence,
    "",
    "## Undo",
    "",
    `${fence}sh`,
    "recense stop",
    fence,
    "",
    '<p><img src="../images/review-desktop.png" alt="Review" width="300"></p>',
    "",
  ].join("\n"),
  "docs/usage.md": "# Using\n\nLead.\n\n## Themes\n",
  "docs/images/review-desktop.png": png(100, 50),
});

function check(change: (files: Files) => void = () => {}): string[] {
  const files = validFiles();
  change(files);
  const root = mkdtempSync(join(tmpdir(), "docs-contract-"));
  roots.push(root);
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), content);
  }
  return checkDocs(root);
}

const put = (path: string, content: string | Buffer) => (files: Files) => {
  files[path] = content;
};
const drop = (path: string) => (files: Files) => {
  delete files[path];
};
const withManifest = (change: (value: Manifest) => void) => (files: Files) => {
  const value = manifest();
  change(value);
  files["docs/site.json"] = `${JSON.stringify(value, null, 2)}\n`;
};
const edit = (path: string, from: string, to: string) => (files: Files) => {
  files[path] = String(files[path]).replace(from, to);
};
const page = (path: string, change: (text: string) => string) => (files: Files) => {
  files[path] = change(String(files[path]));
};

test("the repository's public docs follow the contract", () => {
  const violations = checkDocs(repo);
  expect(violations, violations.join("\n")).toEqual([]);
});

test("a valid docs tree has no violations", () => {
  expect(check()).toEqual([]);
});

test("invalid manifest JSON is one violation at line 1", () => {
  expect(check(put("docs/site.json", "{ nope"))).toEqual([expect.stringMatching(/^docs\/site\.json:1: invalid JSON/)]);
});

test("a manifest with an unexpected key points at that key", () => {
  const found = check(
    withManifest((value) => {
      value.pages[1] = { ...value.pages[1], extra: 1 };
    }),
  );
  expect(found).toEqual(['docs/site.json:15: unexpected key "extra"']);
});

test("a manifest page that misses a key points at the entry", () => {
  const found = check(
    withManifest((value) => {
      delete value.pages[0]?.description;
    }),
  );
  expect(found).toEqual(['docs/site.json:4: missing key "description"']);
});

test("a manifest schema other than 1 is refused", () => {
  const found = check(
    withManifest((value) => {
      value.schema = 2;
    }),
  );
  expect(found).toEqual(['docs/site.json:2: "schema" must be 1']);
});

test("duplicate page ids and paths point at the second entry", () => {
  const found = check(
    withManifest((value) => {
      value.pages[2] = { ...value.pages[0], title: "Using" };
    }),
  );
  expect(found).toEqual(
    expect.arrayContaining([
      'docs/site.json:17: duplicate page id "setup"',
      'docs/site.json:18: duplicate page path "setup.md"',
    ]),
  );
});

test("a page path with a parent segment or leading slash is refused", () => {
  const found = check(
    withManifest((value) => {
      value.pages[1] = { ...value.pages[1], path: "../a.md" };
      value.pages[2] = { ...value.pages[2], path: "/usage.md" };
    }),
  );
  expect(found).toEqual(
    expect.arrayContaining([
      'docs/site.json:12: "path" must not contain a ".." segment',
      'docs/site.json:18: "path" must not start with /',
    ]),
  );
});

test("a description over 160 characters, without a period, or with a line break is refused", () => {
  const long = check(
    withManifest((value) => {
      value.pages[0] = { ...value.pages[0], description: `${"x".repeat(160)}.` };
    }),
  );
  expect(long).toEqual(['docs/site.json:8: "description" must be 1 to 160 characters, not 161']);
  const noPeriod = check(
    withManifest((value) => {
      value.pages[0] = { ...value.pages[0], description: "No period" };
    }),
  );
  expect(noPeriod).toEqual(['docs/site.json:8: "description" must end with a period']);
  const broken = check(
    withManifest((value) => {
      value.pages[0] = { ...value.pages[0], description: "Two\nlines." };
    }),
  );
  expect(broken).toEqual(['docs/site.json:8: "description" must not contain a line break']);
});

test("a screenshot whose file name does not match view, device and theme is refused", () => {
  const found = check(
    withManifest((value) => {
      value.screenshots[0] = { ...value.screenshots[0], theme: "light" };
    }),
  );
  expect(found).toEqual(["docs/site.json:25: the file name must be review-desktop-light.png for this entry"]);
});

test("a screenshot with a bad device or a non-integer size is refused", () => {
  const found = check(
    withManifest((value) => {
      value.screenshots[0] = { ...value.screenshots[0], device: "tablet", width: 1.5 };
    }),
  );
  expect(found).toEqual(
    expect.arrayContaining([
      'docs/site.json:27: "device" must be "desktop" or "phone"',
      'docs/site.json:29: "width" must be a positive integer',
    ]),
  );
});

test("a public page that the manifest does not list is reported", () => {
  const found = check(put("docs/setup/b.md", "# B\n\nLead.\n"));
  expect(found).toEqual(["docs/site.json:3: docs/setup/b.md is a public page but is not listed"]);
});

test("a listed page that does not exist is reported at its manifest entry", () => {
  const found = check(drop("docs/usage.md"));
  expect(found).toEqual(expect.arrayContaining(["docs/site.json:18: the listed page docs/usage.md does not exist"]));
});

test("front matter is refused", () => {
  const found = check(page("docs/usage.md", (text) => `---\ntitle: x\n---\n${text}`));
  expect(found).toEqual(expect.arrayContaining(["docs/usage.md:1: a public page has no front matter"]));
});

test("a page whose first line is not the H1 is refused", () => {
  const found = check(page("docs/usage.md", (text) => `Intro\n\n${text}`));
  expect(found).toEqual(
    expect.arrayContaining(["docs/usage.md:1: line 1 must be the page's H1, written as # <title>"]),
  );
});

test("a second H1 is refused at its line", () => {
  const found = check(page("docs/usage.md", (text) => `${text}\n# Again\n`));
  expect(found).toEqual(["docs/usage.md:7: a page has only one H1, on its first line"]);
});

test("an H1 that differs from the manifest title is refused", () => {
  const found = check(edit("docs/usage.md", "# Using", "# Using it"));
  expect(found).toEqual(['docs/usage.md:1: the H1 "Using it" must equal the manifest title "Using"']);
});

test("a page without a lead paragraph is refused", () => {
  const found = check(edit("docs/usage.md", "Lead.\n\n## Themes", "## Themes"));
  expect(found).toEqual(["docs/usage.md:3: a paragraph, the lead, must follow the H1"]);
});

test("two headings with the same GitHub slug are refused at the second", () => {
  const found = check(page("docs/usage.md", (text) => `${text}\n## Themes\n`));
  expect(found).toEqual(["docs/usage.md:7: the heading anchor #themes is already used by an earlier heading"]);
});

test("a repeated slug stays refused even when a numbered link would resolve", () => {
  const found = check(page("docs/usage.md", (text) => `${text}\n## Themes\n\nSee [again](#themes-1).\n`));
  expect(found).toEqual(["docs/usage.md:7: the heading anchor #themes is already used by an earlier heading"]);
});

test("a relative link to a missing file is refused", () => {
  const found = check(edit("docs/setup.md", "(usage.md)", "(missing.md)"));
  expect(found).toEqual([
    'docs/setup.md:3: the link "missing.md" does not resolve to a file or folder in the repository',
  ]);
});

test("a link with a leading slash is refused", () => {
  const found = check(edit("docs/setup.md", "(usage.md)", "(/docs/usage.md)"));
  expect(found).toEqual(['docs/setup.md:3: the link "/docs/usage.md" must be relative, not start with /']);
});

test("a link fragment without a matching heading is refused", () => {
  const found = check(edit("docs/setup.md", "setup/a.md#undo", "setup/a.md#nowhere"));
  expect(found).toEqual([
    'docs/setup.md:3: the link "setup/a.md#nowhere" has no matching heading anchor in docs/setup/a.md',
  ]);
});

test("a fragment link into the page itself must match a heading", () => {
  const found = check(edit("docs/setup/a.md", "(#undo)", "(#gone)"));
  expect(found).toEqual(['docs/setup/a.md:3: the link "#gone" has no matching heading anchor in docs/setup/a.md']);
});

test("a link that leaves the repository is refused", () => {
  const found = check(edit("docs/setup.md", "(usage.md)", "(../../outside.md)"));
  expect(found).toEqual([
    'docs/setup.md:3: the link "../../outside.md" does not resolve to a file or folder in the repository',
  ]);
});

test("absolute URLs and mailto links are not checked", () => {
  const found = check(edit("docs/setup.md", "(usage.md)", "(https://example.com/x#y) or <mailto:a@example.com>"));
  expect(found).toEqual([]);
});

test("a code block without an info string is refused", () => {
  const found = check(page("docs/usage.md", (text) => `${text}\n${fence}\nplain\n${fence}\n`));
  expect(found).toEqual(["docs/usage.md:7: every code block needs an info string"]);
});

test("an indented code block is refused", () => {
  const found = check(page("docs/usage.md", (text) => `${text}\n    indented\n`));
  expect(found).toEqual(["docs/usage.md:7: every code block needs an info string"]);
});

test("prompt in an info string must be exactly text prompt", () => {
  const found = check(edit("docs/setup/a.md", "```text prompt", "```sh prompt"));
  expect(found).toEqual(['docs/setup/a.md:7: the info string "sh prompt" must be exactly "text prompt" for a prompt']);
});

test("a text fence that starts with Rules: must be text prompt", () => {
  const found = check(edit("docs/setup/a.md", "```text prompt", "```text"));
  expect(found).toEqual(['docs/setup/a.md:7: a prompt starting with "Rules:" must use the info string "text prompt"']);
});

test("an sh fence line that starts with a dollar prompt is refused", () => {
  const found = check(edit("docs/setup/a.md", "recense stop", "  $ recense stop"));
  expect(found).toEqual(["docs/setup/a.md:14: an sh command line must not start with a $ prompt"]);
});

test("raw HTML comments, other elements and loose text are refused", () => {
  const comment = check(page("docs/usage.md", (text) => `${text}\n<!-- note -->\n`));
  expect(comment).toEqual(["docs/usage.md:7: raw HTML may not hold comments"]);
  const element = check(page("docs/usage.md", (text) => `${text}\n<div>x</div>\n`));
  expect(element).toEqual(["docs/usage.md:7: raw HTML may not use the element div"]);
  const attribute = check(page("docs/usage.md", (text) => `${text}\n<p class="x">y</p>\n`));
  expect(attribute).toEqual(
    expect.arrayContaining([
      "docs/usage.md:7: a p element may not have attributes",
      "docs/usage.md:7: raw HTML may hold only p and img elements, not text",
    ]),
  );
});

test("an img element may only have src, alt and width", () => {
  const found = check(edit("docs/setup/a.md", 'width="300"', 'height="300"'));
  expect(found).toEqual(["docs/setup/a.md:17: an img element may not have the attribute height"]);
});

test("an img element without alt is refused", () => {
  const found = check(edit("docs/setup/a.md", ' alt="Review"', ""));
  expect(found).toEqual(
    expect.arrayContaining([
      "docs/setup/a.md:17: an img element needs src and alt",
      "docs/setup/a.md:17: an image needs alt text",
    ]),
  );
});

test("a Markdown image without alt text is refused", () => {
  const found = check(edit("docs/setup.md", "![Review screen]", "![ ]"));
  expect(found).toEqual(["docs/setup.md:7: an image needs alt text"]);
});

test("an image outside docs/images or that is not a PNG is refused", () => {
  const found = check((files) => {
    files["docs/setup.md"] = String(files["docs/setup.md"]).replace("images/review-desktop.png", "usage.md");
  });
  expect(found).toEqual(['docs/setup.md:7: the image "usage.md" must be a .png file in docs/images/']);
});

test("an image that does not exist is refused", () => {
  const found = check(edit("docs/setup.md", "images/review-desktop.png", "images/gone.png"));
  expect(found).toEqual([
    'docs/setup.md:7: the link "images/gone.png" does not resolve to a file or folder in the repository',
  ]);
});

test("a screenshot whose size differs from the manifest is refused", () => {
  const found = check(put("docs/images/review-desktop.png", png(101, 49)));
  expect(found).toEqual([
    "docs/site.json:29: docs/images/review-desktop.png is 101 pixels wide, the manifest says 100",
    "docs/site.json:30: docs/images/review-desktop.png is 49 pixels high, the manifest says 50",
  ]);
});

test("a screenshot that is not a PNG is refused", () => {
  const found = check(put("docs/images/review-desktop.png", Buffer.alloc(40)));
  expect(found).toEqual(["docs/site.json:25: docs/images/review-desktop.png is not a PNG file (bad signature)"]);
});

test("a screenshot file that does not exist is refused", () => {
  const found = check(drop("docs/images/review-desktop.png"));
  expect(found).toEqual(
    expect.arrayContaining(["docs/site.json:25: the screenshot docs/images/review-desktop.png does not exist"]),
  );
});
