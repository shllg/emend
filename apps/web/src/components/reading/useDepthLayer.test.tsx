import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { useRef } from "react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { DepthMarker } from "./DepthMarker.tsx";
import { type DepthLayer, depthLayers, useDepthLayer } from "./useDepthLayer.ts";

let positions: Map<string, number>;
let frames: Map<number, FrameRequestCallback>;
let resizes: { report: () => void; observe: ReturnType<typeof vi.fn>; disconnect: ReturnType<typeof vi.fn> }[];

beforeEach(() => {
  positions = new Map([
    ["decide", 20],
    ["frame", 200],
    ["topics", 600],
    ["trail", 900],
  ]);
  frames = new Map();
  resizes = [];
  let id = 0;
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
    frames.set(++id, callback);
    return id;
  });
  vi.stubGlobal("cancelAnimationFrame", (id: number) => frames.delete(id));
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe = vi.fn();
      disconnect = vi.fn();
      constructor(report: () => void) {
        resizes.push({ report, observe: this.observe, disconnect: this.disconnect });
      }
    },
  );
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
    if (this.hasAttribute("data-reading-scroll")) return new DOMRect(0, 10, 600, 400);
    if (this.classList.contains("em-review-tabs")) return new DOMRect(0, 10, 600, 40);
    return new DOMRect(0, positions.get(this.id) ?? 1000, 600, 15);
  });
  vi.spyOn(HTMLElement.prototype, "clientHeight", "get").mockReturnValue(400);
  vi.spyOn(HTMLElement.prototype, "scrollHeight", "get").mockReturnValue(1200);
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function Reader({
  visible = true,
  hidden = false,
  layers = depthLayers,
  tabs = true,
}: {
  visible?: boolean;
  hidden?: boolean;
  layers?: readonly DepthLayer[];
  tabs?: boolean;
}) {
  const root = useRef<HTMLDivElement>(null);
  const laterLayer = layers.includes("frame") ? "frame" : undefined;
  const layout = [...layers, `frame-later:${laterLayer ?? ""}`].join("|");
  const depth = useDepthLayer(root, visible, layout);
  return (
    <div hidden={hidden}>
      <div data-reading-scroll data-testid="scroll">
        {tabs && <div className="em-review-tabs" />}
        <div ref={root} data-testid="root">
          {layers.map((layer) => (
            <section key={layer} id={layer} data-depth-layer={layer}>
              {layer}
            </section>
          ))}
          <section id="frame-later" data-depth-layer={laterLayer}>
            More frame
          </section>
        </div>
      </div>
      <output data-testid="depth" data-present={depth.present.join(",")}>
        {depth.current}
      </output>
    </div>
  );
}
function flush() {
  act(() => {
    const callbacks = [...frames.values()];
    frames.clear();
    for (const callback of callbacks) callback(0);
  });
}
const current = () => screen.getByTestId("depth").textContent;

test("tracks each layer's first section at the tab row plus 96px reading edge", () => {
  render(<Reader />);
  expect(current()).toBe("decide");
  expect(screen.getByTestId("depth").getAttribute("data-present")).toBe("decide,frame,topics,trail");
  const scroll = screen.getByTestId("scroll");
  positions.set("frame", 146);
  fireEvent.scroll(scroll);
  fireEvent.scroll(scroll);
  expect(frames.size).toBe(1);
  expect(current()).toBe("decide");
  flush();
  expect(current()).toBe("frame");
  positions.set("topics", 145);
  fireEvent.scroll(scroll);
  flush();
  expect(current()).toBe("topics");
  positions.set("trail", 140);
  fireEvent.scroll(scroll);
  flush();
  expect(current()).toBe("trail");
  positions.set("frame", 200).set("topics", 600).set("trail", 900);
  fireEvent.scroll(scroll);
  flush();
  expect(current()).toBe("decide");
});

test("uses the same edge without a tab row on phones", () => {
  positions.set("frame", 120);
  render(<Reader tabs={false} />);
  expect(current()).toBe("decide");
  positions.set("frame", 106);
  fireEvent.scroll(screen.getByTestId("scroll"));
  flush();
  expect(current()).toBe("frame");
});

test("the last visible layer wins at the bottom even when a short Trail never reaches the edge", () => {
  positions.set("decide", -600).set("frame", -400).set("topics", -100).set("trail", 385);
  render(<Reader />);
  expect(current()).toBe("topics");
  const scroll = screen.getByTestId("scroll");
  scroll.scrollTop = 799;
  fireEvent.scroll(scroll);
  flush();
  expect(current()).toBe("trail");
  // A layer below the viewport must not become current merely because scrollTop is at the bottom.
  positions.set("trail", 410);
  fireEvent.scroll(scroll);
  flush();
  expect(current()).toBe("topics");
});

test("a writeup that fits the pane follows the reading edge instead of the last visible layer", () => {
  vi.spyOn(HTMLElement.prototype, "scrollHeight", "get").mockReturnValue(400);
  positions.set("decide", 60).set("frame", 200).set("topics", 270).set("trail", 350).set("frame-later", 385);
  render(<Reader />);
  expect(current()).toBe("decide");
  fireEvent.scroll(screen.getByTestId("scroll"));
  flush();
  expect(current()).toBe("decide");
  positions.set("frame", 140);
  act(() => resizes[0]?.report());
  flush();
  expect(current()).toBe("frame");
});

test("follows a change in the rendered layers when no size or scroll changes", () => {
  positions.set("frame", 60).set("topics", 100).set("trail", 140);
  const view = render(<Reader layers={["frame", "topics"]} />);
  const depth = screen.getByTestId("depth");
  expect(depth.getAttribute("data-present")).toBe("frame,topics");
  expect(current()).toBe("topics");
  view.rerender(<Reader layers={["frame", "topics", "trail"]} />);
  expect(depth.getAttribute("data-present")).toBe("frame,topics,trail");
  expect(current()).toBe("trail");
  view.rerender(<Reader layers={["frame", "topics"]} />);
  expect(depth.getAttribute("data-present")).toBe("frame,topics");
  expect(current()).toBe("topics");
});

test("observes both root and scroller, remeasures the current layer on resize, and cleans up", () => {
  const view = render(<Reader layers={["frame", "topics"]} />);
  expect(current()).toBe("frame");
  expect(screen.getByTestId("depth").getAttribute("data-present")).toBe("frame,topics");
  const resize = resizes[0];
  expect(resize?.observe).toHaveBeenCalledWith(screen.getByTestId("root"));
  expect(resize?.observe).toHaveBeenCalledWith(screen.getByTestId("scroll"));
  positions.set("topics", 100);
  act(() => resize?.report());
  flush();
  expect(current()).toBe("topics");
  const scroll = screen.getByTestId("scroll");
  fireEvent.scroll(scroll);
  expect(frames.size).toBe(1);
  view.unmount();
  expect(resize?.disconnect).toHaveBeenCalledOnce();
  expect(frames.size).toBe(0);
  fireEvent.scroll(scroll);
  act(() => resize?.report());
  expect(frames.size).toBe(0);
});

test.each([{ visible: false }, { hidden: true }])("suspends while hidden: %j", (props) => {
  const view = render(<Reader {...props} />);
  expect(current()).toBe("decide");
  expect(resizes).toHaveLength(0);
  fireEvent.scroll(screen.getByTestId("scroll"));
  expect(frames.size).toBe(0);
  view.rerender(<Reader visible={false} />);
  positions.set("frame", 100);
  view.rerender(<Reader />);
  expect(current()).toBe("frame");
  const scroll = screen.getByTestId("scroll");
  view.rerender(<Reader hidden />);
  positions.set("topics", 90);
  fireEvent.scroll(scroll);
  act(() => resizes[0]?.report());
  expect(frames.size).toBe(0);
  expect(current()).toBe("frame");
});

test.each([false, true])("depth marker keeps absent layers dim and never current (compact=%s)", (compact) => {
  const { container } = render(<DepthMarker current="decide" present={["frame", "trail"]} compact={compact} />);
  const marker = screen.getByRole("list", { name: "Writeup depth" });
  expect(marker.getAttribute("aria-live")).toBeNull();
  expect(marker.querySelector('[aria-current="step"]')?.textContent).toBe("Frame");
  expect(marker.querySelectorAll('[data-present="false"]')).toHaveLength(2);
  expect(marker.querySelectorAll('[data-filled="true"]')).toHaveLength(1);
  expect(marker.querySelector('[data-present="false"][aria-current]')).toBeNull();
  expect(container.querySelectorAll(".sr-only")).toHaveLength(compact ? 3 : 0);
});

test("disabling tracking cancels pending work and stops measurements", () => {
  const view = render(<Reader />);
  fireEvent.scroll(screen.getByTestId("scroll"));
  expect(frames.size).toBe(1);
  view.rerender(<Reader visible={false} />);
  expect(frames.size).toBe(0);
  expect(resizes[0]?.disconnect).toHaveBeenCalledOnce();
  const bounds = vi.mocked(HTMLElement.prototype.getBoundingClientRect);
  bounds.mockClear();
  fireEvent.scroll(screen.getByTestId("scroll"));
  act(() => resizes[0]?.report());
  flush();
  expect(bounds).not.toHaveBeenCalled();
});

test("a compact marker fills through the current layer and exposes only its current word visually", () => {
  render(<DepthMarker current="topics" present={depthLayers} compact />);
  const marker = screen.getByRole("list", { name: "Writeup depth" });
  expect(marker.querySelector('[aria-current="step"]')?.textContent).toBe("Topics");
  expect(marker.querySelectorAll('[data-filled="true"]')).toHaveLength(3);
  expect([...marker.querySelectorAll(".em-depth-label:not(.sr-only)")].map((label) => label.textContent)).toEqual([
    "Topics",
  ]);
});
