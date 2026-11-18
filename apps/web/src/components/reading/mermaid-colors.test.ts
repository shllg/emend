import { afterEach, expect, test, vi } from "vitest";
import { readMermaidColors } from "./mermaid-colors.ts";

afterEach(() => vi.restoreAllMocks());

const values = {
  "--bg-sunken": "oklch(0.5 0.1 200)",
  "--bg-surface": "#ABCDEF",
  "--fg-1": "#ffffff",
  "--fg-2": "rgba(255, 255, 255, 0.5)",
  "--fg-3": "#123456",
  "--border-2": "#010203",
  "--topic-bg-2": "#040506",
  "--topic-solid": "#abcdef",
};

function mockCanvas(tokens: Record<string, string> = values) {
  vi.spyOn(window, "getComputedStyle").mockReturnValue({
    getPropertyValue: (key: string) => tokens[key] ?? "",
  } as CSSStyleDeclaration);
  const rgba = (value: string): number[] | undefined => {
    if (value === values["--bg-sunken"]) return [32, 64, 96, 1];
    if (value === "rgba(32, 64, 96, 0.5)") return [32, 64, 96, 0.5];
    if (value === values["--fg-2"]) return [255, 255, 255, 0.5];
    if (/^#[0-9a-f]{6}([0-9a-f]{2})?$/i.test(value))
      return [1, 3, 5]
        .map((i) => Number.parseInt(value.slice(i, i + 2), 16))
        .concat(value.length === 9 ? Number.parseInt(value.slice(7), 16) / 255 : 1);
    return;
  };
  let fillStyle = "#000000";
  let pixel = [0, 0, 0];
  const context = {
    get fillStyle() {
      return fillStyle;
    },
    set fillStyle(value: string) {
      if (rgba(value)) fillStyle = value.toLowerCase();
    },
    fillRect: vi.fn(() => {
      const color = rgba(fillStyle);
      if (!color) throw new Error("Invalid mock colour");
      const alpha = color[3] ?? 1;
      pixel = pixel.map((old, i) => Math.round((color[i] ?? 0) * alpha + old * (1 - alpha)));
    }),
    getImageData: vi.fn(() => ({ data: new Uint8ClampedArray([...pixel, 255]) })),
  };
  const getContext = vi
    .spyOn(HTMLCanvasElement.prototype, "getContext")
    .mockReturnValue(context as unknown as CanvasRenderingContext2D);
  return { context, getContext };
}

test("reads applied tokens and converts to opaque lowercase sRGB, compositing over the background", () => {
  const { getContext, context } = mockCanvas();
  expect(readMermaidColors()).toEqual({
    background: "#204060",
    surface: "#abcdef",
    text: "#ffffff",
    text2: "#90a0b0",
    line: "#123456",
    border: "#010203",
    accentBg: "#040506",
    accent: "#abcdef",
    nodeText: "#ffffff",
    noteText: "#ffffff",
  });
  expect(getContext).toHaveBeenCalledExactlyOnceWith("2d", { colorSpace: "srgb", alpha: false });
  expect(getContext.mock.instances[0]).toMatchObject({ width: 1, height: 1 });
  expect(window.getComputedStyle).toHaveBeenCalledExactlyOnceWith(document.documentElement);
  expect(context.getImageData).toHaveBeenCalledWith(0, 0, 1, 1);
});

test.each(["", "var(--missing)", "url(x)", "not-a-colour"])(
  "omits the entire palette if one token cannot convert: %s",
  (value) => {
    mockCanvas({ ...values, "--topic-solid": value });
    expect(readMermaidColors()).toBeUndefined();
  },
);

test("a translucent background is made opaque once before compositing the other tokens", () => {
  mockCanvas({ ...values, "--bg-sunken": "rgba(32, 64, 96, 0.5)" });
  expect(readMermaidColors()).toMatchObject({ background: "#102030", text2: "#889098" });
});

test("translucent text composites over its node, note and diagram backgrounds", () => {
  mockCanvas({
    ...values,
    "--bg-sunken": "#000000",
    "--bg-surface": "#303030",
    "--fg-1": "#ffffff80",
    "--topic-bg-2": "#20406080",
  });
  expect(readMermaidColors()).toMatchObject({
    background: "#000000",
    surface: "#303030",
    accentBg: "#102030",
    text: "#808080",
    nodeText: "#989898",
    noteText: "#889098",
  });
});

test("omits colours without a canvas or readable pixels", () => {
  const { getContext, context } = mockCanvas();
  context.getImageData.mockImplementation(() => {
    throw new Error("Unavailable pixels");
  });
  expect(readMermaidColors()).toBeUndefined();
  getContext.mockReturnValue(null);
  expect(readMermaidColors()).toBeUndefined();
  getContext.mockImplementation(() => {
    throw new Error("Unavailable canvas");
  });
  expect(readMermaidColors()).toBeUndefined();
});
