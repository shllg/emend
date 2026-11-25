// pnpm screenshots: a sealed demo review round that captures the README and tour screenshots.
//
// Everything runs under one throwaway root: a server from this checkout's build, fixture git repos,
// the CLI, and a Chromium profile. No child inherits the parent environment, the browser reaches
// only the sealed origin, and the real recense server and state are never touched. The guards live in
// ./screenshots/safety.ts and are covered by scripts/screenshots.test.ts.
import { existsSync, mkdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { writeImages } from "./screenshots/images.ts";
import { type Page, PHONE } from "./screenshots/browser.ts";
import { type ScreenshotDemo, startSealedDemo } from "./screenshots/demo.ts";
import { assertOutputFolder, canonicalPath, filterPng } from "./screenshots/safety.ts";

const here = dirname(fileURLToPath(import.meta.url));
const checkout = resolve(here, "..");
const entry = join(checkout, "apps", "recense", "dist", "recense.mjs");

interface Options {
  keep: boolean;
  out: string;
  chromium: string | undefined;
}

function parseArgs(argv: string[]): Options {
  const options: Options = { keep: false, out: join(checkout, "docs", "images"), chromium: undefined };
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    if (flag === "--keep") options.keep = true;
    else if (flag === "--out" && argv[i + 1]) options.out = resolve(argv[++i] as string);
    else if (flag === "--chromium" && argv[i + 1]) options.chromium = resolve(argv[++i] as string);
    else throw new Error("Usage: node scripts/screenshots.ts [--keep] [--out <dir>] [--chromium <path>]");
  }
  return options;
}

const step = (text: string) => console.log(`- ${text}`);

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  if (!existsSync(entry)) throw new Error("The CLI is not built. Run pnpm build first (pnpm screenshots does).");
  const shots: Record<string, Buffer> = {};
  const demo = await startSealedDemo({
    ...options, entry,
    beforeSend: async (desktop) => { shots["send-desktop.png"] = await desktop.screenshot(); },
  });
  try {
    await capture(demo, shots, options.out);
  } finally {
    await demo.stop();
  }
}

async function capture(
  { browser, desktop, reviewUrl, planPath, origin, realStateDirs }: ScreenshotDemo,
  shots: Record<string, Buffer>,
  out: string,
): Promise<void> {
  // ---- Screenshots ------------------------------------------------------------------------
  // The Done group starts folded; open it so all six reviews show.
  const showDone = async (page: Page) => {
    await page.settle("the inbox");
    await page.eval(
      "(() => { const toggle = [...document.querySelectorAll('button, summary, [role=\"button\"]')]" +
        ".find((element) => /^done/i.test(element.textContent.trim())); " +
        "if (toggle && toggle.getAttribute('aria-expanded') !== 'true') toggle.click(); })()",
    );
    await page.waitFor("document.body.innerText.includes('Troubleshooting: service install on macOS')", "the Done group");
  };

  step("capturing the inbox");
  await desktop.goto(`${origin}/`);
  await desktop.waitFor("document.body.innerText.includes('Release notes for 0.9')", "the inbox rows");
  await showDone(desktop);
  await desktop.settle("the inbox");
  shots["inbox-desktop.png"] = await desktop.screenshot();

  const phone = await browser.newPage(PHONE);
  await phone.goto(`${origin}/`);
  await phone.waitFor("document.body.innerText.includes('Release notes for 0.9')", "the phone inbox rows");
  await showDone(phone);
  await phone.settle("the phone inbox");
  shots["inbox-phone.png"] = await phone.screenshot();

  // Scroll a pane until the element found by `find` (a page expression) sits just below the pane's
  // sticky headers. The header height is measured in the page, never assumed.
  const revealBelowHeaders = async (page: Page, scope: string, find: string, what: string, gap: number) => {
    const root = `document.querySelector(${JSON.stringify(scope)})`;
    const stickyBottom =
      `(() => { const pane = ${root}; const paneTop = pane.getBoundingClientRect().top; let bottom = paneTop; ` +
      "for (const el of pane.querySelectorAll('*')) { if (getComputedStyle(el).position !== 'sticky') continue; " +
      "const rect = el.getBoundingClientRect(); if (rect.top <= paneTop + 400 && rect.bottom > bottom) bottom = rect.bottom; } return bottom; })()";
    await page.waitFor(find, `${what} in its pane`);
    // Diffs above the target load as they scroll into range and move it; repeat until it stays put.
    for (let attempt = 0; attempt < 8; attempt++) {
      const offset = await page.eval<number>(
        `(() => { const delta = (${find}).getBoundingClientRect().top - (${stickyBottom} + ${gap}); ${root}.scrollBy(0, delta); return delta; })()`,
      );
      await page.settle(`${what} in place`);
      if (Math.abs(offset) < 4) return;
    }
    throw new Error(`Could not keep ${what} in place`);
  };
  const withText = (scope: string, selector: string, text: string) =>
    `(() => { const root = document.querySelector(${JSON.stringify(scope)}); if (!root) return null; ` +
    `return [...root.querySelectorAll(${JSON.stringify(selector)})].find((el) => el.textContent.includes(${JSON.stringify(text)})) ?? null; })()`;
  // The deepest element of a pane that shows this text.
  const leafWithText = (scope: string, text: string) =>
    `(() => { const root = document.querySelector(${JSON.stringify(scope)}); if (!root) return null; ` +
    `return [...root.querySelectorAll('*')].find((el) => el.textContent.includes(${JSON.stringify(text)}) && ` +
    `![...el.children].some((child) => child.textContent.includes(${JSON.stringify(text)}))) ?? null; })()`;

  step("capturing the review");
  // Desktop reviews open in Tabs. Store the reader's Split choice as the View menu does
  // so the screenshot shows the writeup next to the diff.
  await desktop.eval(`(() => {
    const LAYOUT_KEY = "recense.layout.v1";
    const TABS_DEFAULT_KEY = "recense.layout.tabs-default";
    const layout = JSON.parse(localStorage.getItem(LAYOUT_KEY) ?? "{}");
    layout.pane = { ...(layout.pane ?? {}), desktop: "split" };
    localStorage.setItem(LAYOUT_KEY, JSON.stringify(layout));
    localStorage.setItem(TABS_DEFAULT_KEY, "1");
  })()`);
  await desktop.goto(reviewUrl("?rev=2"));
  await desktop.settle("the desktop review");
  // The agent note above the thread must clear the sticky file header, with the thread below it.
  await revealBelowHeaders(
    desktop,
    "[data-diff-scroll]",
    withText("[data-diff-scroll]", "article[data-agent-note]", "Retire and approve share this one update."),
    "the agent note",
    0,
  );
  // The README shot must show every opening card.
  const overflow = await desktop.eval<number>(`(() => {
    const pane = document.querySelector("[data-reading-scroll]");
    if (!pane) throw new Error("The writeup pane is missing from the review shot");
    const list = pane.querySelector("dl.em-needs-you");
    if (!list) throw new Error("The Needs you list is missing from the writeup pane");
    return Math.max(0, list.getBoundingClientRect().bottom - pane.getBoundingClientRect().bottom);
  })()`);
  if (overflow > 0) {
    throw new Error(`The Needs you card ends ${Math.ceil(overflow)} px below the writeup pane in the review shot`);
  }
  shots["review-desktop.png"] = await desktop.screenshot();

  await phone.goto(reviewUrl("?rev=2&tab=comments"));
  await phone.settle("the phone review");
  shots["review-phone.png"] = await phone.screenshot();

  step("capturing the plan doc");
  await desktop.goto(reviewUrl(`?rev=2&tab=docs&doc=${encodeURIComponent(planPath)}`));
  await desktop.settle("the plan doc");
  await revealBelowHeaders(
    desktop,
    "[data-reading-scroll]",
    leafWithText("[data-reading-scroll]", "Behaviour"),
    "the Behaviour heading",
    8,
  );
  shots["doc-desktop.png"] = await desktop.screenshot();

  browser.check();
  // Filter every picture first, then replace the whole set or nothing (see images.ts).
  const filtered = Object.entries(shots).map(([name, bytes]) => [name, filterPng(bytes)] as const);
  assertOutputFolder(out, realStateDirs, canonicalPath);
  mkdirSync(out, { recursive: true });
  assertOutputFolder(out, realStateDirs, canonicalPath);
  writeImages(out, filtered);
  console.log(`Wrote ${Object.keys(shots).length} screenshots to ${out}`);
  await browser.close();
}

try {
  await main();
} catch (error) {
  console.error(`screenshots: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
}
