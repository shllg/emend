import { describe, expect, test } from "vitest";
import { renderMarkdown } from "./markdown.ts";

const repo = "https://github.com/owner/name";
const html = async (markdown: string, repoUrl: string | undefined = repo) =>
  (await renderMarkdown(markdown, "overview", repoUrl)).map((block) => block.html).join("\n");
const anchor = (n: number) =>
  `<a href="${repo}/issues/${n}" data-recense-issue="${n}" rel="noopener noreferrer nofollow" target="_blank">#${n}</a>`;

describe("issue references", () => {
  test("link in plain text, lists, headings and emphasis", async () => {
    const out = await html("Fixes #123 and (#45).");
    expect(out).toContain(anchor(123));
    expect(out).toContain(anchor(45));
    expect(await html("- see #7\n- also **#8**")).toContain(anchor(8));
    expect(await html("# Heading #9")).toContain(anchor(9));
  });

  test("do nothing without a repoUrl, or with an invalid one", async () => {
    const plain = await renderMarkdown("Fixes #123", "overview");
    expect(plain.map((block) => block.html).join("")).not.toContain("<a ");
    expect(await html("Fixes #123", "javascript:alert(1)")).not.toContain("<a ");
    expect(await html("Fixes #123", "http://github.com/o/r")).not.toContain("<a ");
  });

  test("stay plain in inline code, a fence and a Mermaid block", async () => {
    expect(await html("`#123`")).not.toContain("<a ");
    expect(await html("```\n#123\n```")).not.toContain("<a ");
    expect(await html("```ts\nconst a = 1; // #123\n```")).not.toContain("<a ");
    const diagram = await renderMarkdown("```mermaid\ngraph TD\n  A[#12] --> B\n```", "overview", repo);
    expect(diagram.map((block) => block.html).join("")).not.toContain("issues/12");
  });

  test("link each number of a list, in a table cell and inside emphasis and strikethrough", async () => {
    const list = await html("See #12,#13.");
    expect(list).toContain(anchor(12));
    expect(list).toContain(anchor(13));
    expect(await html("| a | b |\n| - | - |\n| #21 | x |")).toContain(anchor(21));
    expect(await html("*#31* and _#32_ and ~~#33~~")).toContain(anchor(31));
    const marked = await html("*#31* and _#32_ and ~~#33~~");
    expect(marked).toContain(anchor(32));
    expect(marked).toContain(anchor(33));
  });

  test("a www autolink holding #12 gets no second link", async () => {
    const out = await html("see www.example.test/page#12 now");
    expect(out.match(/<a /g)).toHaveLength(1);
    expect(out).not.toContain("issues/12");
  });

  test("stay plain inside an existing link and keep its own href", async () => {
    const out = await html("[see #123](https://example.test/page)");
    expect(out).toContain('href="https://example.test/page"');
    expect(out).not.toContain("issues/123");
    expect(await html("<https://example.test/#123>")).not.toContain("issues/123");
  });

  test.each([
    "page#12",
    "https://example.test/page#12",
    "a/#12",
    "&#123;",
    "&amp;#123",
    "#0",
    "#012",
    "#12345678",
    "#12a",
    "x#1",
    "##5",
  ])("leave %j plain", async (text) => {
    expect(await html(text)).not.toContain("issues/");
  });

  test("keep block ids and text identical with and without a repoUrl", async () => {
    const withRepo = await renderMarkdown("Fixes #123 here.\n\n- also #4", "overview", repo);
    const without = await renderMarkdown("Fixes #123 here.\n\n- also #4", "overview");
    expect(withRepo.map((block) => [block.id, block.text])).toEqual(without.map((block) => [block.id, block.text]));
  });

  test("build the URL from the digits only, never from markup", async () => {
    const out = await html('#1<script>alert(1)</script> #2"onmouseover="x');
    expect(out).not.toContain("<script");
    // The quote stays text outside any tag.
    expect(out).not.toMatch(/<[^>]*onmouseover/);
    expect(out).toContain(anchor(1));
    expect(out).toContain(anchor(2));
  });
});

describe("external links open in a new tab", () => {
  test("every absolute http and https link carries target and rel", async () => {
    const out = await html("[a](https://example.test/a) [b](http://example.test/b) <https://example.test/c>");
    expect(out.match(/target="_blank"/g)).toHaveLength(3);
    expect(out.match(/rel="noopener noreferrer nofollow"/g)).toHaveLength(3);
  });

  test("a relative link, a mailto link and an author-written target get none", async () => {
    expect(await html("[r](other.md)")).not.toContain("target=");
    expect(await html("[m](mailto:a@example.test)")).not.toContain("target=");
    const raw = await html('<a href="https://example.test/x" target="_self">x</a>');
    expect(raw).toContain('target="_blank"');
    expect(raw).not.toContain("_self");
  });
});

describe("issue anchors carry the number marker", () => {
  test("only the server-made anchor has data-recense-issue; an author's is dropped", async () => {
    const out = await html(
      'See #12 <a href="https://example.test" data-recense-issue="99">x</a> [y](https://example.test/y)',
    );
    expect(out).toContain('data-recense-issue="12"');
    expect(out).not.toContain('data-recense-issue="99"');
    expect(out.match(/data-recense-issue/g)).toHaveLength(1);
    const raw = await html('<span data-recense-issue="5">five</span> and #6');
    expect(raw).not.toContain('data-recense-issue="5"');
    expect(raw.match(/data-recense-issue/g)).toHaveLength(1);
    expect(raw).toContain('data-recense-issue="6"');
  });

  test("hostile input beside a number stays neutralised", async () => {
    const out = await html("#12 <script>alert(1)</script> <img src=x onerror=alert(1)> [x](javascript:alert(1))");
    expect(out).not.toContain("<script");
    expect(out).not.toMatch(/<[^>]*onerror/);
    expect(out).not.toContain("javascript:");
    expect(out).toContain(anchor(12));
  });
});
