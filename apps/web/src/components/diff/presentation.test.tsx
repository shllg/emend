import { cleanup, fireEvent, render } from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import { diffHoldMaxMs, diffHoldQuietMs, holdDiffTarget, scrollDiffTarget } from "./presentation.ts";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.useRealTimers();
});
function scene(height: number, contentHeight: number, targetTop: number, targetHeight: number) {
  const { container } = render(
    <section data-diff-scroll>
      <div data-diff-toolbar />
      <section data-topic="first">
        <header data-topic-header>
          <button type="button">Comment on topic</button>
        </header>
        <article data-thread-card />
      </section>
    </section>,
  );
  const pane = container.querySelector<HTMLElement>("[data-diff-scroll]") as HTMLElement;
  const toolbar = pane.querySelector<HTMLElement>("[data-diff-toolbar]") as HTMLElement;
  const topic = pane.querySelector<HTMLElement>("[data-topic]") as HTMLElement;
  const heading = pane.querySelector<HTMLElement>("[data-topic-header]") as HTMLElement;
  const card = pane.querySelector<HTMLElement>("article") as HTMLElement;
  Object.defineProperties(pane, { clientHeight: { value: height }, scrollHeight: { get: () => contentHeight } });
  vi.spyOn(pane, "getBoundingClientRect").mockReturnValue(new DOMRect(0, 100, 500, height));
  vi.spyOn(toolbar, "getBoundingClientRect").mockReturnValue(new DOMRect(0, 100, 500, 41));
  vi.spyOn(heading, "getBoundingClientRect").mockReturnValue(new DOMRect(0, 141, 500, 100));
  vi.spyOn(card, "getBoundingClientRect").mockImplementation(
    () => new DOMRect(0, 100 + targetTop - pane.scrollTop, 500, targetHeight),
  );
  vi.spyOn(topic, "getBoundingClientRect").mockReturnValue(new DOMRect(0, 800, 500, 1000));
  const into = vi.spyOn(pane, "scrollIntoView");
  const by = vi.spyOn(pane, "scrollBy");
  const scroll = vi.spyOn(pane, "scrollTo").mockImplementation((options?: ScrollToOptions | number) => {
    if (options && typeof options === "object") pane.scrollTop = options.top ?? 0;
  });
  return {
    pane,
    card,
    topic,
    toolbar,
    scroll,
    into,
    by,
    shift: (delta: number) => {
      targetTop += delta;
      contentHeight += delta;
    },
    grow: (delta: number) => {
      contentHeight += delta;
    },
  };
}

test("a short last file clamps once at the end of the pane and stays inside the viewport", () => {
  const { pane, card, scroll, into, by } = scene(600, 3000, 2900, 40);
  scrollDiffTarget(card);
  expect(scroll).toHaveBeenCalledExactlyOnceWith({ top: 2400, behavior: "instant" });
  expect(card.getBoundingClientRect().top - pane.getBoundingClientRect().top).toBe(500);
  expect(card.getBoundingClientRect().bottom).toBeLessThanOrEqual(pane.getBoundingClientRect().bottom);
  expect(into).not.toHaveBeenCalled();
  expect(by).not.toHaveBeenCalled();
});

test.each([320, 700])(
  "a %s px card keeps its top visible in a 500 px pane below a measured 141 px stack",
  (cardHeight) => {
    const { pane, card, scroll } = scene(500, 3000, 1300, cardHeight);
    pane.scrollTop = 500;
    scrollDiffTarget(card);
    expect(scroll).toHaveBeenCalledExactlyOnceWith({ top: 1151, behavior: "instant" });
    expect(card.getBoundingClientRect().top - pane.getBoundingClientRect().top).toBe(149);
  },
);

test("a topic destination counts only the toolbar above its own header", () => {
  const { topic, scroll } = scene(500, 3000, 1300, 320);
  scrollDiffTarget(topic);
  expect(scroll).toHaveBeenCalledExactlyOnceWith({ top: 651, behavior: "instant" });
});

test("a button inside the topic header excludes its own header from the sticky stack", () => {
  const { pane, topic, scroll } = scene(500, 3000, 1300, 320);
  pane.scrollTop = 500;
  const button = topic.querySelector("button") as HTMLButtonElement;
  vi.spyOn(button, "getBoundingClientRect").mockReturnValue(new DOMRect(0, 155, 100, 30));
  scrollDiffTarget(button);
  expect(scroll).toHaveBeenCalledExactlyOnceWith({ top: 506, behavior: "instant" });
});

test("phone scroll uses only its topic header and clamps negative destinations to zero", () => {
  const { toolbar, card, scroll } = scene(500, 3000, 30, 320);
  toolbar.remove();
  scrollDiffTarget(card);
  expect(scroll).toHaveBeenCalledExactlyOnceWith({ top: 0, behavior: "instant" });
});

function fileScene(phone: boolean) {
  const { container } = render(
    <section data-diff-scroll>
      <div data-diff-toolbar />
      <section data-topic="first" data-phone={phone || undefined}>
        <header data-topic-header />
        <section data-diff-file>
          <header data-file-header />
          <article data-thread-card />
        </section>
      </section>
    </section>,
  );
  const pane = container.querySelector<HTMLElement>("[data-diff-scroll]") as HTMLElement;
  const rects: [string, number, number][] = [
    ["[data-diff-toolbar]", 100, 41],
    ["[data-topic-header]", 141, 100],
  ];
  for (const [selector, top, height] of rects)
    vi.spyOn(pane.querySelector(selector) as HTMLElement, "getBoundingClientRect").mockReturnValue(
      new DOMRect(0, top, 500, height),
    );
  const card = pane.querySelector<HTMLElement>("article") as HTMLElement;
  const file = pane.querySelector<HTMLElement>("[data-diff-file]") as HTMLElement;
  const header = pane.querySelector<HTMLElement>("[data-file-header]") as HTMLElement;
  Object.defineProperties(pane, { clientHeight: { value: 500 }, scrollHeight: { value: 3000 } });
  vi.spyOn(pane, "getBoundingClientRect").mockReturnValue(new DOMRect(0, 100, 500, 500));
  vi.spyOn(file, "getBoundingClientRect").mockImplementation(
    () => new DOMRect(0, 100 + 1300 - pane.scrollTop, 500, 1700),
  );
  vi.spyOn(header, "getBoundingClientRect").mockImplementation(
    () => new DOMRect(0, Math.max(phone ? 141 : 241, file.getBoundingClientRect().top), 500, 40),
  );
  vi.spyOn(card, "getBoundingClientRect").mockImplementation(
    () => new DOMRect(0, 100 + 1300 - pane.scrollTop, 500, 100),
  );
  const scroll = vi.spyOn(pane, "scrollTo").mockImplementation((options?: ScrollToOptions | number) => {
    if (options && typeof options === "object") pane.scrollTop = options.top ?? 0;
  });
  return { pane, card, file, header, scroll };
}

test("a line or thread inside a file also clears that file's sticky header", () => {
  const { card, scroll } = fileScene(false);
  scrollDiffTarget(card);
  // 1300 - toolbar 41 - topic 100 - file header 40 - 8
  expect(scroll).toHaveBeenCalledExactlyOnceWith({ top: 1111, behavior: "instant" });
});

test("on the phone the topic header scrolls away, so only the file header counts", () => {
  const { card, scroll } = fileScene(true);
  scrollDiffTarget(card);
  // 1300 - toolbar 41 - file header 40 - 8
  expect(scroll).toHaveBeenCalledExactlyOnceWith({ top: 1211, behavior: "instant" });
});

test("a file header destination does not count its own header", () => {
  const { header, scroll } = fileScene(false);
  scrollDiffTarget(header);
  // 1300 - toolbar 41 - topic 100 - 8
  expect(scroll).toHaveBeenCalledExactlyOnceWith({ top: 1151, behavior: "instant" });
});

test.each([false, true])("a stuck file header jumps to its section's start in one scroll (phone=%s)", (phone) => {
  const { pane, file, header, scroll } = fileScene(phone);
  pane.scrollTop = 2200;
  const stack = phone ? 41 : 141;
  expect(header.getBoundingClientRect().top).toBe(100 + stack);
  scrollDiffTarget(header);
  expect(scroll).toHaveBeenCalledExactlyOnceWith({ top: 1300 - stack - 8, behavior: "instant" });
  expect(file.getBoundingClientRect().top - pane.getBoundingClientRect().top).toBe(stack + 8);
});

test.each([false, true])("holding a stuck file header reaches its section without creeping (phone=%s)", (phone) => {
  vi.useFakeTimers({ toFake: ["requestAnimationFrame", "cancelAnimationFrame", "performance"] });
  const { pane, header, scroll } = fileScene(phone);
  pane.scrollTop = 2200;
  const cancel = holdDiffTarget(header);
  const top = 1300 - (phone ? 41 : 141) - 8;
  expect(scroll).toHaveBeenCalledExactlyOnceWith({ top, behavior: "instant" });
  vi.advanceTimersByTime(1000);
  expect(pane.scrollTop).toBe(top);
  expect(scroll).toHaveBeenCalledTimes(1);
  cancel();
});

function holdScene(phone = false) {
  vi.useFakeTimers({ toFake: ["requestAnimationFrame", "cancelAnimationFrame", "performance"] });
  const value = scene(500, 5000, 1300, 320);
  if (phone) value.topic.setAttribute("data-phone", "");
  return value;
}

test.each([false, true])("a held target follows layout growth below the sticky stack (phone=%s)", (phone) => {
  const { pane, card, scroll, shift } = holdScene(phone);
  const cancel = holdDiffTarget(card);
  const inset = (phone ? 41 : 141) + 8;
  expect(card.getBoundingClientRect().top - pane.getBoundingClientRect().top).toBe(inset);
  shift(1800);
  vi.advanceTimersToNextFrame();
  expect(card.getBoundingClientRect().top - pane.getBoundingClientRect().top).toBe(inset);
  expect(scroll).toHaveBeenCalledTimes(2);
  expect(scroll).toHaveBeenLastCalledWith({ top: 3100 - inset, behavior: "instant" });
  vi.advanceTimersToNextFrame();
  expect(scroll).toHaveBeenCalledTimes(2);
  cancel();
  shift(300);
  vi.advanceTimersToNextFrame();
  expect(scroll).toHaveBeenCalledTimes(2);
});

test.each([1, 250, -250])("an outside scroll of %s px stops the hold without a correction", (delta) => {
  const { pane, card, scroll, shift } = holdScene();
  holdDiffTarget(card);
  const top = pane.scrollTop + delta;
  pane.scrollTop = top;
  vi.advanceTimersToNextFrame();
  expect(scroll).toHaveBeenCalledTimes(1);
  expect(vi.getTimerCount()).toBe(0);
  shift(500);
  vi.advanceTimersByTime(500);
  expect(pane.scrollTop).toBe(top);
  expect(scroll).toHaveBeenCalledTimes(1);
});

test.each([200, 500])("layout growth with %s px of scroll anchoring keeps the hold", (anchored) => {
  const { pane, card, scroll, shift } = holdScene();
  const cancel = holdDiffTarget(card);
  shift(500);
  pane.scrollTop += anchored;
  vi.advanceTimersToNextFrame();
  expect(pane.scrollTop).toBe(1651);
  expect(scroll).toHaveBeenCalledTimes(anchored === 500 ? 1 : 2);
  shift(300);
  vi.advanceTimersToNextFrame();
  expect(scroll).toHaveBeenLastCalledWith({ top: 1951, behavior: "instant" });
  cancel();
});

test("focus with preventScroll keeps the hold", () => {
  const { pane, card, scroll, shift } = holdScene();
  const input = document.createElement("textarea");
  pane.append(input);
  const cancel = holdDiffTarget(card);
  input.focus({ preventScroll: true });
  expect(document.activeElement).toBe(input);
  vi.advanceTimersToNextFrame();
  shift(500);
  vi.advanceTimersToNextFrame();
  expect(scroll).toHaveBeenCalledTimes(2);
  expect(scroll).toHaveBeenLastCalledWith({ top: 1651, behavior: "instant" });
  cancel();
});

test.each(["wheel", "touchstart", "touchmove", "pointerdown", "keydown"])(
  "%s on the diff pane stops corrections before the next frame",
  (type) => {
    const { pane, card, scroll, shift } = holdScene();
    holdDiffTarget(card);
    if (type === "keydown") fireEvent.keyDown(pane, { key: "PageDown" });
    else fireEvent(pane, new Event(type, { bubbles: true }));
    shift(1800);
    vi.advanceTimersToNextFrame();
    expect(scroll).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  },
);

test("scroll keys elsewhere, typing and prevented keys leave a hold running", () => {
  const { pane, card, scroll, shift } = holdScene();
  const other = document.createElement("button");
  document.body.append(other);
  const input = document.createElement("textarea");
  pane.append(input);
  const cancel = holdDiffTarget(card);
  fireEvent.keyDown(other, { key: "PageDown" });
  fireEvent.keyDown(input, { key: "ArrowDown" });
  fireEvent.keyDown(pane, { key: "a" });
  const prevented = new KeyboardEvent("keydown", { key: "PageDown", bubbles: true, cancelable: true });
  prevented.preventDefault();
  fireEvent(pane, prevented);
  shift(500);
  vi.advanceTimersToNextFrame();
  expect(scroll).toHaveBeenCalledTimes(2);
  fireEvent.keyDown(document.body, { key: " " });
  shift(500);
  vi.advanceTimersToNextFrame();
  expect(scroll).toHaveBeenCalledTimes(2);
  cancel();
  other.remove();
});

test("a newer hold replaces the old target on the same pane", () => {
  const { pane, card, topic, scroll, shift } = holdScene();
  const cancelOld = holdDiffTarget(card);
  const reads = vi.mocked(card.getBoundingClientRect);
  reads.mockClear();
  let topicTop = 800;
  vi.spyOn(topic, "getBoundingClientRect").mockImplementation(
    () => new DOMRect(0, 100 + topicTop - pane.scrollTop, 500, 1000),
  );
  const cancelNew = holdDiffTarget(topic);
  cancelOld();
  shift(1500);
  topicTop += 300;
  vi.advanceTimersToNextFrame();
  expect(reads).not.toHaveBeenCalled();
  expect(scroll).toHaveBeenLastCalledWith({ top: 1051, behavior: "instant" });
  cancelNew();
});

test("a hold ends after two quiet seconds", () => {
  const { card, scroll, shift } = holdScene();
  holdDiffTarget(card);
  vi.advanceTimersByTime(diffHoldQuietMs);
  expect(vi.getTimerCount()).toBe(0);
  shift(1000);
  vi.advanceTimersToNextFrame();
  expect(scroll).toHaveBeenCalledTimes(1);
});

test("loading keeps the hold through late growth, then the quiet window ends it", () => {
  const { pane, card, scroll, shift } = holdScene();
  const loading = document.createElement("section");
  loading.setAttribute("data-diff-loading", "");
  pane.prepend(loading);
  holdDiffTarget(card);
  vi.advanceTimersByTime(2500);
  expect(vi.getTimerCount()).toBe(1);
  shift(500);
  vi.advanceTimersToNextFrame();
  expect(scroll).toHaveBeenLastCalledWith({ top: 1651, behavior: "instant" });
  loading.removeAttribute("data-diff-loading");
  vi.advanceTimersByTime(diffHoldQuietMs - 100);
  expect(vi.getTimerCount()).toBe(1);
  vi.advanceTimersByTime(100);
  expect(vi.getTimerCount()).toBe(0);
  shift(500);
  vi.advanceTimersToNextFrame();
  expect(scroll).toHaveBeenCalledTimes(2);
});

test("the ten second cap ends a hold even while a file keeps loading", () => {
  const { pane, card, scroll, shift } = holdScene();
  const loading = document.createElement("section");
  loading.setAttribute("data-diff-loading", "");
  pane.prepend(loading);
  holdDiffTarget(card);
  vi.advanceTimersByTime(diffHoldMaxMs - 16);
  expect(vi.getTimerCount()).toBe(1);
  vi.advanceTimersToNextFrame();
  expect(vi.getTimerCount()).toBe(0);
  shift(500);
  vi.advanceTimersToNextFrame();
  expect(scroll).toHaveBeenCalledTimes(1);
});

test.each(["correction", "height"])("a %s restarts the quiet window", (change) => {
  const { card, scroll, shift, grow } = holdScene();
  holdDiffTarget(card);
  vi.advanceTimersByTime(diffHoldQuietMs - 500);
  if (change === "correction") shift(500);
  else grow(500);
  vi.advanceTimersToNextFrame();
  vi.advanceTimersByTime(600);
  shift(500);
  vi.advanceTimersToNextFrame();
  expect(scroll).toHaveBeenCalledTimes(change === "correction" ? 3 : 2);
  vi.advanceTimersByTime(diffHoldQuietMs);
  expect(vi.getTimerCount()).toBe(0);
});

test("the ten second cap ends a hold even while layout keeps moving", () => {
  const { card, scroll, shift } = holdScene();
  holdDiffTarget(card);
  for (let elapsed = 1000; elapsed < diffHoldMaxMs; elapsed += 1000) {
    shift(100);
    vi.advanceTimersByTime(1000);
  }
  expect(scroll).toHaveBeenCalledTimes(10);
  vi.advanceTimersByTime(1000);
  expect(vi.getTimerCount()).toBe(0);
  shift(1000);
  vi.advanceTimersToNextFrame();
  expect(scroll).toHaveBeenCalledTimes(10);
});

test.each(["removed", "hidden"])("a %s target ends the hold", (state) => {
  const { card, topic, scroll, shift } = holdScene();
  holdDiffTarget(card);
  if (state === "removed") card.remove();
  else topic.hidden = true;
  shift(1000);
  vi.advanceTimersToNextFrame();
  expect(scroll).toHaveBeenCalledTimes(1);
  expect(vi.getTimerCount()).toBe(0);
});
