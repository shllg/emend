import type { Browser, Page, Viewport } from "../screenshots/browser.ts";
import { PHONE } from "../screenshots/browser.ts";
import { distribution, NetworkMeasurement, REPETITIONS } from "./metrics.ts";
import type { Seeded } from "./seed.ts";

export const LAPTOP: Viewport = { width: 1440, height: 900, scale: 2, mobile: false };
export const JOURNEYS = ["inbox", "review", "file", "composer", "pub"] as const;
type Journey = (typeof JOURNEYS)[number];
export type Temperature = "cold" | "warm";
export interface Measurement {
  journey: Journey;
  viewport: string;
  temperature: Temperature;
  readiness: string;
  samples: Sample[];
  metrics: Record<string, ReturnType<typeof distribution>>;
}
interface Sample {
  timeMs: number;
  openMs?: number;
  switchMs?: number;
  longTasks: { count: number; totalMs: number };
  traffic: ReturnType<NetworkMeasurement["finish"]>;
}

const fileSelector = (n: string) => `[data-diff-file][aria-label="File src/module-${n}.ts"]`;
const fileReady = (n: string) => `(() => { const file = document.querySelector(${JSON.stringify(fileSelector(n))});
  if (!file || !file.getBoundingClientRect().height || file.hasAttribute('data-diff-loading')) return false;
  return [...file.querySelectorAll('*')].some(el => el.shadowRoot?.querySelector('[data-line]')); })()`;
export const READINESS: Record<Journey, string> = {
  inbox: "A rendered review link in the inbox",
  review: "First file visible, diff loading finished, and a diff line rendered in its shadow root",
  file: "Second file rendered and its scroll container moved after selecting it from Files. On phone, opening the file mounts the diff pane again.",
  composer: "File comment composer visible and the full 100-character input reflected in its textarea",
  pub: "First document heading rendered, then the second document heading rendered after the Docs selection",
};
const readyInbox = "!!document.querySelector('a[href^=\"/r/\"]')";
const docReady = (n: string) =>
  `[...document.querySelectorAll('[data-reading-scroll] h1')].some(el => el.textContent.trim() === 'Handbook ${n}' && el.getBoundingClientRect().height > 0)`;
const text =
  "Please explain how this synthetic change handles repeated inputs and preserves the expected behavior.".padEnd(
    100,
    " ",
  );

// This observer is installed before navigation. In-app measurements use its timestamped entries.
export const OBSERVER = `(() => {
  window.__perfTasks = [];
  window.__perfObserver = new PerformanceObserver(list => {
    window.__perfTasks.push(...list.getEntries().map(entry => ({ start: entry.startTime, duration: entry.duration })));
  });
  window.__perfObserver.observe({ type: 'longtask', buffered: true });
})();`;
function watch(condition: string, start: string) {
  return `window.__perfReady = null; window.__perfStart = ${start};
    (() => { const check = () => { if (${condition}) window.__perfReady = performance.now(); else requestAnimationFrame(check); }; requestAnimationFrame(check); })();`;
}
async function timing(page: Page): Promise<number> {
  await page.waitFor(
    "window.__perfReady !== null && Number.isFinite(window.__perfReady)",
    "the journey readiness condition",
  );
  return page.eval<number>("window.__perfReady - window.__perfStart");
}
async function navigate(page: Page, url: string, condition: string) {
  const { identifier } = (await page.send("Page.addScriptToEvaluateOnNewDocument", {
    source: watch(condition, "0"),
  })) as { identifier: string };
  try {
    await page.eval("window.__perfReady = null");
    await page.goto(url);
    return await timing(page);
  } finally {
    await page.send("Page.removeScriptToEvaluateOnNewDocument", { identifier });
  }
}
async function input(page: Page, action: string, condition: string) {
  await page.eval(`(() => { ${watch(condition, "performance.now()")} ${action} })()`);
  return timing(page);
}
async function click(page: Page, selector: string, label: string) {
  await page.waitFor(`document.querySelector(${JSON.stringify(selector)})`, label);
  await page.eval(`document.querySelector(${JSON.stringify(selector)}).click()`);
}

async function prepare(page: Page, journey: Journey, seeded: Seeded, origin: string) {
  if (journey !== "file" && journey !== "composer") return;
  if (!seeded.largeId) throw new Error("Large review could not be seeded");
  await page.goto(`${origin}/r/${seeded.largeId}?tab=diff`);
  await page.waitFor(fileReady("000"), "the first file");
  if (journey === "file") {
    await page.settle("the loaded review", 45_000);
    await click(page, '[role="tab"][id$="-files"], nav[aria-label="Review tabs"] a[href*="tab=files"]', "the Files tab");
    await page.waitFor(
      "document.querySelector('button[aria-label^=\"Open diff for src/module-001.ts\"]')",
      "the second file in Files",
    );
  }
  await page.settleWorkers("the diff workers");
  await page.settle("the journey setup");
}
async function perform(
  page: Page,
  journey: Journey,
  seeded: Seeded,
  origin: string,
): Promise<{ timeMs: number; openMs?: number; switchMs?: number }> {
  if (journey === "inbox") return { timeMs: await navigate(page, `${origin}/`, readyInbox) };
  if (journey === "review") {
    if (!seeded.largeId) throw new Error("Large review could not be seeded");
    return { timeMs: await navigate(page, `${origin}/r/${seeded.largeId}?tab=diff`, fileReady("000")) };
  }
  if (journey === "file") {
    return {
      timeMs: await input(
        page,
        `
      document.querySelector('button[aria-label^="Open diff for src/module-001.ts"]').click();
      window.__perfScrolled = false;
      const scroll = () => {
        if (!(${fileReady("001")})) { requestAnimationFrame(scroll); return; }
        const file = document.querySelector(${JSON.stringify(fileSelector("001"))});
        const pane = file.closest('[data-diff-scroll]');
        const before = pane.scrollTop; pane.scrollBy(0, 300);
        requestAnimationFrame(() => { window.__perfScrolled = pane.scrollTop !== before; });
      }; requestAnimationFrame(scroll);`,
        `window.__perfScrolled && (${fileReady("001")})`,
      ),
    };
  }
  if (journey === "composer") {
    // Start at the opening input, then type through CDP's input domain, not a value assignment.
    await page.eval(`(() => { ${watch(`document.querySelector('textarea')?.value === ${JSON.stringify(text)}`, "performance.now()")}
      document.querySelector(${JSON.stringify(`${fileSelector("000")} button[aria-label="Comment on file"]`)}).click(); })()`);
    await page.waitFor(
      "document.querySelector('textarea')?.getBoundingClientRect().height > 0",
      "the comment composer",
    );
    await page.eval("document.querySelector('textarea').focus(); document.querySelector('textarea').select()");
    await page.send("Input.insertText", { text });
    return { timeMs: await timing(page) };
  }
  if (!seeded.pubId) throw new Error("Publication could not be seeded");
  const openMs = await navigate(page, `${origin}/r/${seeded.pubId}?tab=docs&doc=doc-000.md`, docReady("000"));
  await page.settle("the first publication document", 45_000);
  const switchMs = await input(
    page,
    `
    const menu = document.querySelector('button[aria-label="Docs"]');
    if (!menu) throw new Error('Docs menu unavailable');
    menu.click();
    const pick = () => { const option = [...document.querySelectorAll('.em-doc-options button')].find(el => el.textContent.includes('Handbook 001'));
      if (option) option.click(); else requestAnimationFrame(pick); }; requestAnimationFrame(pick);`,
    docReady("001"),
  );
  return { timeMs: openMs + switchMs, openMs, switchMs };
}

export async function sample(page: Page, journey: Journey, temperature: Temperature, seeded: Seeded, dist: string): Promise<Sample> {
  await prepare(page, journey, seeded, page.browser.origin);
  const traffic = new NetworkMeasurement(dist, page.browser.origin);
  const remove = page.browser.on((event, session) => traffic.event(event, session, page.browser.sessionType(session)));
  let start = 0;
  try {
    const times = await perform(page, journey, seeded, page.browser.origin);
    if (journey === "file" || journey === "composer") start = await page.eval<number>("window.__perfStart");
    const end = await page.eval<number>("window.__perfReady");
    // Complete requests triggered by the action, including lazy chunks, before counting assets.
    await page.settle("the measured journey", 45_000);
    if (temperature === "cold") {
      const registered = await page.eval<boolean>(
        "navigator.serviceWorker ? navigator.serviceWorker.getRegistrations().then(registrations => { " +
          "window.__perfRegistrations = registrations; return registrations.length > 0; }) : false",
      );
      if (registered) {
        // Activation follows install/precache. Keep recording its fetches, outside the timing window.
        await page.waitFor(
          "window.__perfRegistrations.every(registration => registration.active?.state === 'activated')",
          "service worker activation",
          45_000,
        );
        await page.settle("the activated service worker", 45_000);
      }
    }
    const longTasks = await page.eval<{ count: number; totalMs: number }>(`(() => {
      window.__perfTasks.push(...window.__perfObserver.takeRecords().map(entry => ({ start: entry.startTime, duration: entry.duration })));
      const tasks = window.__perfTasks.filter(task => task.start >= ${journey === "file" || journey === "composer" ? start : 0} && task.start < ${end});
      return { count: tasks.length, totalMs: tasks.reduce((sum, task) => sum + task.duration, 0) };
    })()`);
    page.browser.check();
    return { ...times, longTasks, traffic: traffic.finish() };
  } finally {
    remove();
  }
}

export function sampleMetrics(sample: Sample): Record<string, number> {
  const metrics: Record<string, number> = {
    timeMs: sample.timeMs,
    "longTasks.count": sample.longTasks.count,
    "longTasks.totalMs": sample.longTasks.totalMs,
  };
  if (sample.openMs !== undefined) metrics.openMs = sample.openMs;
  if (sample.switchMs !== undefined) metrics.switchMs = sample.switchMs;
  for (const kind of ["js", "css", "worker"] as const)
    for (const source of ["loaded", "transferred"] as const)
      for (const unit of ["raw", "gzip"] as const)
        metrics[`${kind}.${source}.${unit}`] = sample.traffic[kind][source][unit];
  for (const kind of ["network", "sw"] as const)
    for (const field of ["files", "raw", "gzip"] as const) metrics[`${kind}.${field}`] = sample.traffic[kind][field];
  for (const route of sample.traffic.api)
    for (const stat of ["count", "median", "max"] as const) metrics[`api ${route.route} ${stat}`] = route[stat];
  return metrics;
}

async function warmReady(page: Page) {
  // Older builds have no worker. If they registered one, wait for actual page control.
  const registered = await page.eval<boolean>(
    "navigator.serviceWorker ? navigator.serviceWorker.getRegistrations().then(rs => rs.length > 0) : false",
  );
  if (registered) {
    await page.eval("navigator.serviceWorker.ready");
    if (!(await page.eval<boolean>("!!navigator.serviceWorker.controller"))) await page.send("Page.reload");
    await page.waitFor("navigator.serviceWorker.controller !== null", "service worker control", 45_000);
    await page.settle("the warm profile");
  }
}

export async function measureJourneys(
  browser: Browser,
  seeded: Seeded,
  dist: string,
  skip: (step: string, error: unknown) => void,
): Promise<Measurement[]> {
  const results: Measurement[] = [];
  for (const [name, viewport] of [
    ["laptop", LAPTOP],
    ["phone", PHONE],
  ] as const) {
    for (const journey of JOURNEYS) {
      console.log(`- measuring ${name}/${journey}`);
      const collected: Record<Temperature, Sample[]> = { cold: [], warm: [] };
      for (let repeat = 0; repeat < REPETITIONS; repeat++) {
        const context = await browser.freshContext();
        try {
          const page = await browser.newPage(viewport, context);
          await page.send("Page.addScriptToEvaluateOnNewDocument", { source: OBSERVER });
          // about:blank also needs the observer for prerequisite-free setup instrumentation.
          await page.eval(OBSERVER);
          let coldSucceeded = false;
          for (const temperature of ["cold", "warm"] as const) {
            try {
              if (temperature === "warm") {
                if (!coldSucceeded) throw new Error("Cold journey did not finish; no warm baseline");
                await warmReady(page);
                if (journey === "composer") {
                  // Reset only the input; retain HTTP cache, SW and the rest of the profile.
                  await page.eval(
                    "document.querySelector('textarea').focus(); document.querySelector('textarea').select()",
                  );
                  await page.send("Input.insertText", { text: "" });
                }
              }
              collected[temperature].push(await sample(page, journey, temperature, seeded, dist));
              if (temperature === "cold") coldSucceeded = true;
            } catch (error) {
              browser.check();
              skip(`${name}/${journey}/${temperature}/${repeat + 1}`, error);
            }
          }
        } finally {
          await browser.disposeContext(context);
        }
      }
      for (const temperature of ["cold", "warm"] as const) {
        const samples = collected[temperature];
        if (!samples.length) continue;
        const metrics = samples.map(sampleMetrics);
        const keys = new Set(metrics.flatMap(Object.keys));
        results.push({
          journey,
          viewport: name,
          temperature,
          readiness: READINESS[journey],
          samples,
          metrics: Object.fromEntries(
            [...keys].map((key) => [key, distribution(metrics.flatMap((m) => (key in m ? [m[key]] : [])))]),
          ),
        });
      }
    }
  }
  return results;
}
