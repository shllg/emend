import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { Check, ChevronRight, Search } from "lucide-react";
import { createRef, type ReactNode, useState } from "react";
import { afterEach, expect, test, vi } from "vitest";
import { Banner } from "./Banner.tsx";
import { Button } from "./Button.tsx";
import { Checkbox } from "./Checkbox.tsx";
import { Dialog } from "./Dialog.tsx";
import { Icon } from "./Icon.tsx";
import { IconButton } from "./IconButton.tsx";
import { Menu } from "./Menu.tsx";
import { PairingCodeInput } from "./PairingCodeInput.tsx";
import { RadioGroup } from "./RadioGroup.tsx";
import { SegmentedControl } from "./SegmentedControl.tsx";
import { Select } from "./Select.tsx";
import { Sheet } from "./Sheet.tsx";
import { Tabs } from "./Tabs.tsx";
import { Textarea } from "./Textarea.tsx";
import { TextField } from "./TextField.tsx";
import { ToastProvider, useToast } from "./Toast.tsx";
import { Tooltip, TooltipProvider } from "./Tooltip.tsx";
import { cn } from "./utils.ts";

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});
function mount(children: ReactNode) {
  return render(children, { wrapper: TooltipProvider });
}

test("class merging keeps numeric type sizes, text colors, mono stretch and the custom shadow scale distinct", () => {
  expect(cn("text-13 text-fg-1", "text-12 text-success-fg")).toBe("text-12 text-success-fg");
  expect(cn("font-sans", "font-mono font-stretch-mono")).toBe("font-mono font-stretch-mono");
  expect(cn("shadow-1", "shadow-3")).toBe("shadow-3");
  expect(cn("shadow-inset", "shadow-none")).toBe("shadow-none");
});

test.each(["sm", "md", "lg"] as const)("primary Button retains ink text and the %s type size", (size) => {
  mount(
    <Button variant="primary" size={size}>
      Save
    </Button>,
  );
  const classes = screen.getByRole("button", { name: "Save" }).classList;
  expect(classes.contains("text-accent-fg")).toBe(true);
  expect(classes.contains(size === "sm" ? "text-12" : size === "lg" ? "text-14" : "text-13")).toBe(true);
  expect(classes.contains("leading-(--lh-snug)")).toBe(true);
});

test("icons are decorative by default and labelled icons have an image role", () => {
  const { container, rerender } = render(<Icon icon={Check} />);
  const svg = container.querySelector("svg");
  expect(svg?.getAttribute("aria-hidden")).toBe("true");
  expect(svg?.getAttribute("width")).toBe("16");
  expect(svg?.getAttribute("stroke-width")).toBe("1.75");
  rerender(<Icon icon={Check} label="Approved" size={18} />);
  expect(screen.getByRole("img", { name: "Approved" }).getAttribute("aria-hidden")).toBeNull();
});

test("Button defaults to type button, supports submit, and loading disables activation", () => {
  const onClick = vi.fn();
  const { rerender } = mount(<Button onClick={onClick}>Save</Button>);
  const button = screen.getByRole("button", { name: "Save" }) as HTMLButtonElement;
  expect(button.type).toBe("button");
  fireEvent.click(button);
  expect(onClick).toHaveBeenCalledOnce();
  rerender(
    <Button loading type="submit" onClick={onClick}>
      Save
    </Button>,
  );
  expect(button.type).toBe("submit");
  expect(button.disabled).toBe(true);
  expect(button.getAttribute("aria-busy")).toBe("true");
  fireEvent.click(button);
  expect(onClick).toHaveBeenCalledOnce();
});

test("Button asChild decorates a link, including icons and shortcut, and blocks loading links", () => {
  const onClick = vi.fn((event) => event.preventDefault());
  const { rerender } = mount(
    <Button asChild icon={Check} iconRight={ChevronRight} kbd="J">
      <a href="/devices" onClick={onClick}>
        Devices
      </a>
    </Button>,
  );
  const link = screen.getByRole("link", { name: "Devices J" });
  expect(link.className).toContain("inline-flex");
  expect(link.querySelectorAll("svg")).toHaveLength(2);
  expect(link.getAttribute("type")).toBeNull();
  fireEvent.click(link);
  expect(onClick).toHaveBeenCalledOnce();
  rerender(
    <Button asChild loading>
      <a href="/devices" onClick={onClick}>
        Devices
      </a>
    </Button>,
  );
  expect(link.getAttribute("aria-busy")).toBe("true");
  expect(link.getAttribute("aria-disabled")).toBe("true");
  expect(link.tabIndex).toBe(-1);
  fireEvent.click(link);
  expect(onClick).toHaveBeenCalledOnce();
});

test("IconButton uses its label and toggle state, and forwards its ref through Tooltip", () => {
  const ref = createRef<HTMLButtonElement>();
  mount(<IconButton ref={ref} icon={Check} label="Show inbox" pressed badge={3} />);
  const button = screen.getByRole("button", { name: "Show inbox, 3" });
  expect(button.getAttribute("aria-label")).toBe("Show inbox");
  expect(button.getAttribute("aria-pressed")).toBe("true");
  expect(ref.current).toBe(button);
  expect(within(button).getByText("3").getAttribute("aria-hidden")).toBe("true");
});

test("IconButton asChild preserves the link and supplies its icon", () => {
  mount(
    <IconButton asChild icon={Check} label="Inbox">
      <a href="/">Inbox</a>
    </IconButton>,
  );
  expect(screen.getByRole("link", { name: "Inbox" }).querySelector("svg")).toBeTruthy();
});

test("IconButton keeps caller label ids alongside its badge label", () => {
  mount(
    <>
      <span id="review-name">Review</span>
      <span id="review-number">2</span>
      <IconButton icon={Check} label="Comments" badge={3} aria-labelledby="review-name review-number" />
    </>,
  );
  const button = screen.getByRole("button", { name: "Review 2 Comments, 3" });
  const ids = button.getAttribute("aria-labelledby")?.split(" ");
  expect(ids?.slice(0, 2)).toEqual(["review-name", "review-number"]);
  expect(ids).toHaveLength(3);
  expect(ids?.[2] && document.getElementById(ids[2])?.textContent).toBe("Comments, 3");
});

test("Tooltip shows its content and key cap on keyboard focus", async () => {
  mount(
    <Tooltip content="Next file" kbd="J">
      <Button>Next</Button>
    </Tooltip>,
  );
  act(() => screen.getByRole("button", { name: "Next" }).focus());
  const tooltip = await screen.findByRole("tooltip");
  expect(tooltip.textContent).toBe("Next fileJ");
});

test("IconButton works without a TooltipProvider", async () => {
  const onClick = vi.fn();
  render(<IconButton icon={Check} label="Approve" onClick={onClick} />);
  const button = screen.getByRole("button", { name: "Approve" });
  act(() => button.focus());
  expect((await screen.findByRole("tooltip")).textContent).toBe("Approve");
  fireEvent.click(button);
  expect(onClick).toHaveBeenCalledOnce();
});

test("Sheet works without a TooltipProvider and one Escape closes it with Close focused", async () => {
  render(
    <Sheet title="Inbox" trigger={<Button>Open inbox</Button>}>
      Reviews
    </Sheet>,
  );
  fireEvent.click(screen.getByRole("button", { name: "Open inbox" }));
  expect(screen.getByRole("dialog", { name: "Inbox" })).toBeTruthy();
  const close = screen.getByRole("button", { name: "Close" });
  act(() => close.focus());
  expect(screen.queryByRole("tooltip")).toBeNull();
  fireEvent.keyDown(close, { key: "Escape" });
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
});

test("Menu works without a TooltipProvider", async () => {
  const onSelect = vi.fn();
  render(<Menu label="More" items={[{ label: "Copy link", onSelect }]} />);
  fireEvent.keyDown(screen.getByRole("button", { name: "More" }), { key: "ArrowDown" });
  const item = await screen.findByRole("menuitem", { name: "Copy link" });
  fireEvent.click(item);
  expect(onSelect).toHaveBeenCalledOnce();
  await waitFor(() => expect(screen.queryByRole("menu")).toBeNull());
});

function RadioMenuExample({ onValueChange }: { onValueChange: (value: string) => void }) {
  const [value, setValue] = useState("one");
  return (
    <Menu
      label="Choose revision"
      items={[
        {
          radioGroup: {
            value,
            onValueChange: (next) => {
              setValue(next);
              onValueChange(next);
            },
            items: [
              { value: "one", label: "First", hint: "Earlier" },
              { value: "two", label: "Second", hint: "Newest" },
            ],
          },
        },
      ]}
    />
  );
}

test("Menu radio groups expose checked items with hints and select by keyboard", async () => {
  const onValueChange = vi.fn();
  mount(<RadioMenuExample onValueChange={onValueChange} />);
  const trigger = screen.getByRole("button", { name: "Choose revision" });
  fireEvent.keyDown(trigger, { key: "ArrowDown" });
  const first = await screen.findByRole("menuitemradio", { name: "First Earlier" });
  const second = screen.getByRole("menuitemradio", { name: "Second Newest" });
  expect(first.getAttribute("aria-checked")).toBe("true");
  expect(second.getAttribute("aria-checked")).toBe("false");
  act(() => second.focus());
  fireEvent.keyDown(second, { key: "Enter" });
  expect(onValueChange).toHaveBeenCalledExactlyOnceWith("two");
  await waitFor(() => expect(screen.queryByRole("menu")).toBeNull());
  fireEvent.keyDown(trigger, { key: "ArrowDown" });
  expect((await screen.findByRole("menuitemradio", { name: "Second Newest" })).getAttribute("aria-checked")).toBe(
    "true",
  );
  expect(screen.getByRole("menuitemradio", { name: "First Earlier" }).getAttribute("aria-checked")).toBe("false");
});

test("neighbouring tooltips retain their shared provider skip delay", () => {
  vi.useFakeTimers();
  mount(
    <>
      <IconButton label="First" icon={Check} />
      <IconButton label="Second" icon={Check} />
    </>,
  );
  fireEvent.pointerMove(screen.getByRole("button", { name: "First" }), { pointerType: "mouse" });
  act(() => vi.advanceTimersByTime(349));
  expect(screen.queryByRole("tooltip")).toBeNull();
  act(() => vi.advanceTimersByTime(1));
  expect(screen.getByRole("tooltip").textContent).toBe("First");
  fireEvent.pointerMove(screen.getByRole("button", { name: "Second" }), { pointerType: "mouse" });
  expect(screen.getByRole("tooltip").textContent).toBe("Second");
});

function TabsExample({ onChange }: { onChange: (value: string) => void }) {
  const [value, setValue] = useState("writeup");
  return (
    <Tabs
      label="Reading pane"
      value={value}
      onChange={(next) => {
        onChange(next);
        setValue(next);
      }}
      items={[
        { id: "writeup", label: "Writeup", count: 0, "aria-controls": "writeup-panel" },
        { id: "docs", label: "Docs", hidden: true },
        { id: "diff", label: "Diff", count: 2 },
        { id: "comments", label: "Comments", count: 3, accent: true },
      ]}
    />
  );
}

test("Tabs select and focus with arrows, wrap, Home and End, skipping hidden items", () => {
  const onChange = vi.fn();
  mount(<TabsExample onChange={onChange} />);
  const tabs = screen.getAllByRole("tab");
  expect(screen.queryByRole("tab", { name: "Docs" })).toBeNull();
  expect(screen.queryByText("0")).toBeNull();
  expect(tabs[0]?.getAttribute("aria-controls")).toBe("writeup-panel");
  expect(tabs.map((tab) => tab.tabIndex)).toEqual([0, -1, -1]);
  const steps = [
    ["ArrowRight", 1, "diff"],
    ["ArrowRight", 2, "comments"],
    ["ArrowRight", 0, "writeup"],
    ["ArrowLeft", 2, "comments"],
    ["Home", 0, "writeup"],
    ["End", 2, "comments"],
  ] as const;
  act(() => tabs[0]?.focus());
  for (const [key, index, value] of steps) {
    fireEvent.keyDown(document.activeElement ?? document.body, { key });
    expect(onChange).toHaveBeenLastCalledWith(value);
    expect(document.activeElement).toBe(tabs[index]);
    expect(tabs[index]?.getAttribute("aria-selected")).toBe("true");
    expect(tabs.filter((tab) => tab.tabIndex === 0)).toEqual([tabs[index]]);
  }
});

test("Tabs generate unique ids across multiple panes", () => {
  const items = [{ id: "writeup", label: "Writeup" }];
  mount(
    <>
      <Tabs label="First" value="writeup" items={items} />
      <Tabs label="Second" value="writeup" items={items} />
    </>,
  );
  const ids = screen.getAllByRole("tab").map((tab) => tab.id);
  expect(ids.every(Boolean)).toBe(true);
  expect(new Set(ids).size).toBe(2);
});

test("Tabs describe a text count with a tooltip and keep numeric counts unchanged", async () => {
  const description = "2 unsent, 5 not resolved, 9 threads in all";
  mount(
    <Tabs
      label="Reading pane"
      value="comments"
      items={[
        { id: "docs", label: "Docs", count: 2 },
        { id: "comments", label: "Comments", count: "2 / 5 / 9", countLabel: description, accent: true },
      ]}
    />,
  );
  const docs = screen.getByRole("tab", { name: "Docs 2" });
  const numeric = within(docs).getByText("2");
  expect(numeric.hasAttribute("aria-hidden")).toBe(false);
  expect(numeric.className).toContain("bg-active");
  const comments = screen.getByRole("tab", { name: `Comments ${description}` });
  const bubble = within(comments).getByText("2 / 5 / 9");
  expect(bubble.getAttribute("aria-hidden")).toBe("true");
  expect(bubble.className).toContain("bg-accent");
  fireEvent.pointerMove(bubble, { pointerType: "mouse" });
  expect((await screen.findByRole("tooltip")).textContent).toBe(description);
  expect(screen.getByRole("tab", { name: `Comments ${description}` })).toBe(comments);
});

test.each(["missing", "docs"])("Tabs keep a visible tab stop when value %s is not visible", (value) => {
  mount(
    <Tabs
      label="Reading pane"
      value={value}
      items={[
        { id: "docs", label: "Docs", hidden: true },
        { id: "writeup", label: "Writeup" },
        { id: "diff", label: "Diff" },
      ]}
    />,
  );
  expect(screen.getAllByRole("tab").map((tab) => tab.tabIndex)).toEqual([0, -1]);
  expect(screen.getByRole("tab", { name: "Writeup" }).getAttribute("aria-selected")).toBe("false");
});

function SegmentedExample({ onChange }: { onChange: (value: string) => void }) {
  const [value, setValue] = useState("split");
  return (
    <SegmentedControl
      label="Diff layout"
      value={value}
      onChange={(next) => {
        setValue(next);
        onChange(next);
      }}
      options={[
        { value: "split", label: "Split" },
        { value: "unified", label: "Unified" },
      ]}
    />
  );
}

test("SegmentedControl follows value and changes selection and focus with all arrows", () => {
  const onChange = vi.fn();
  mount(<SegmentedExample onChange={onChange} />);
  const split = screen.getByRole("radio", { name: "Split" });
  const unified = screen.getByRole("radio", { name: "Unified" });
  expect(split.getAttribute("aria-checked")).toBe("true");
  for (const key of ["ArrowRight", "ArrowDown"]) {
    fireEvent.keyDown(split, { key });
    expect(onChange).toHaveBeenLastCalledWith("unified");
    expect(document.activeElement).toBe(unified);
    expect(unified.getAttribute("aria-checked")).toBe("true");
    fireEvent.keyDown(unified, { key });
    expect(onChange).toHaveBeenLastCalledWith("split");
  }
  for (const key of ["ArrowLeft", "ArrowUp"]) {
    fireEvent.keyDown(split, { key });
    expect(onChange).toHaveBeenLastCalledWith("unified");
    fireEvent.keyDown(unified, { key });
    expect(onChange).toHaveBeenLastCalledWith("split");
  }
});

test("SegmentedControl skips disabled segments and still calls onChange for selected Home/End", () => {
  const onChange = vi.fn();
  const { rerender } = mount(
    <SegmentedControl
      label="Layout"
      value="first"
      onChange={onChange}
      options={[
        { value: "first", label: "First" },
        { value: "disabled", label: "Disabled", disabled: true },
        { value: "last", label: "Last" },
      ]}
    />,
  );
  const first = screen.getByRole("radio", { name: "First" });
  const disabled = screen.getByRole<HTMLButtonElement>("radio", { name: "Disabled" });
  const last = screen.getByRole("radio", { name: "Last" });
  expect([first.tabIndex, disabled.tabIndex, last.tabIndex]).toEqual([0, -1, -1]);
  expect(disabled.disabled).toBe(true);
  expect(disabled.classList.contains("disabled:hover:text-fg-3")).toBe(true);
  fireEvent.keyDown(first, { key: "Home" });
  expect(onChange).toHaveBeenLastCalledWith("first");
  fireEvent.keyDown(first, { key: "ArrowRight" });
  expect(document.activeElement).toBe(last);
  expect(onChange).toHaveBeenLastCalledWith("last");
  fireEvent.keyDown(last, { key: "ArrowLeft" });
  expect(document.activeElement).toBe(first);
  rerender(
    <SegmentedControl
      label="Layout"
      value="last"
      onChange={onChange}
      options={[
        { value: "first", label: "First" },
        { value: "last", label: "Last" },
      ]}
    />,
  );
  onChange.mockClear();
  fireEvent.keyDown(screen.getByRole("radio", { name: "Last" }), { key: "End" });
  expect(onChange).toHaveBeenCalledExactlyOnceWith("last");
});

test("Menu opens from the keyboard, skips headings, separators and disabled items, and selects", async () => {
  const onSelect = vi.fn();
  mount(
    <Menu
      label="More"
      items={[
        { heading: "Review" },
        { label: "Unavailable", disabled: true },
        { label: "Copy link", icon: Check, onSelect },
        { separator: true },
        { label: "Devices" },
      ]}
    />,
  );
  fireEvent.keyDown(screen.getByRole("button", { name: "More" }), { key: "ArrowDown" });
  const menu = await screen.findByRole("menu");
  expect(within(menu).getAllByRole("menuitem")).toHaveLength(3);
  expect(within(menu).getByRole("separator")).toBeTruthy();
  expect(within(menu).getByText("Review").hasAttribute("tabindex")).toBe(false);
  const copy = within(menu).getByRole("menuitem", { name: "Copy link" });
  await waitFor(() => expect(document.activeElement).toBe(copy));
  fireEvent.keyDown(copy, { key: "Enter" });
  expect(onSelect).toHaveBeenCalledOnce();
  await waitFor(() => expect(screen.queryByRole("menu")).toBeNull());
});

test("Menu asChild navigation retains the link and its decorations", async () => {
  const onClick = vi.fn((event) => event.preventDefault());
  mount(
    <Menu
      label="Navigate"
      defaultOpen
      items={[
        {
          label: "Devices",
          icon: Check,
          hint: "Manage",
          asChild: true,
          children: (
            <a href="/devices" onClick={onClick}>
              Devices
            </a>
          ),
        },
      ]}
    />,
  );
  const item = await screen.findByRole("menuitem", { name: "Devices Manage" });
  expect(item.tagName).toBe("A");
  expect(item.getAttribute("href")).toBe("/devices");
  expect(item.querySelector("svg")).toBeTruthy();
  fireEvent.click(item);
  expect(onClick).toHaveBeenCalledOnce();
});

test("Menu opened inside a Sheet is above the modal content", async () => {
  mount(
    <Sheet open title="Inbox">
      <Menu label="More" items={[{ label: "Open" }]} />
    </Sheet>,
  );
  fireEvent.keyDown(screen.getByRole("button", { name: "More" }), { key: "ArrowDown" });
  expect((await screen.findByRole("menu")).classList.contains("z-[calc(var(--z-sheet)+2)]")).toBe(true);
});

test("Menu supports duplicate item and heading labels with distinct keys", async () => {
  const error = vi.spyOn(console, "error").mockImplementation(() => {});
  try {
    mount(
      <Menu
        label="More"
        defaultOpen
        items={[
          { heading: "Files" },
          { label: "Open" },
          { separator: true },
          { heading: "Files" },
          { label: "Open" },
          { separator: true },
        ]}
      />,
    );
    expect(await screen.findAllByRole("menuitem", { name: "Open" })).toHaveLength(2);
    expect(screen.getAllByText("Files")).toHaveLength(2);
    expect(screen.getAllByRole("separator")).toHaveLength(2);
    expect(error).not.toHaveBeenCalled();
  } finally {
    error.mockRestore();
  }
});

test("controlled bottom Sheet has a labelled dialog, description and grab handle; Escape closes it", () => {
  const onOpenChange = vi.fn();
  mount(
    <Sheet
      open
      onOpenChange={onOpenChange}
      side="bottom"
      title="Send feedback"
      description="Review the instructions."
      footer={<Button>Continue</Button>}
    >
      Contents
    </Sheet>,
  );
  const dialog = screen.getByRole("dialog", { name: "Send feedback" });
  expect(dialog.querySelector("[data-sheet-grab]")).toBeTruthy();
  const descriptionId = dialog.getAttribute("aria-describedby");
  expect(descriptionId && document.getElementById(descriptionId)?.textContent).toBe("Review the instructions.");
  expect(within(dialog).getByRole("button", { name: "Continue" })).toBeTruthy();
  fireEvent.keyDown(dialog, { key: "Escape" });
  expect(onOpenChange).toHaveBeenCalledWith(false);
});

test("Sheet keeps its uncontrolled trigger API and restores focus on close", async () => {
  mount(
    <Sheet title="Inbox" trigger={<Button>Open inbox</Button>}>
      Reviews
    </Sheet>,
  );
  const trigger = screen.getByRole("button", { name: "Open inbox" });
  fireEvent.click(trigger);
  expect(screen.getByRole("dialog", { name: "Inbox" })).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Close" }));
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  await waitFor(() => expect(document.activeElement).toBe(trigger));
});

test("Sheet closes from an overlay pointer interaction", async () => {
  const onOpenChange = vi.fn();
  mount(
    <Sheet open onOpenChange={onOpenChange} title="Inbox">
      Reviews
    </Sheet>,
  );
  // Radix registers outside pointer listeners on the next task.
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
  const overlay = document.querySelector(".bg-overlay");
  expect(overlay).toBeTruthy();
  if (overlay) {
    fireEvent.pointerDown(overlay, { button: 0, pointerType: "mouse" });
    fireEvent.pointerUp(overlay, { button: 0, pointerType: "mouse" });
    fireEvent.click(overlay);
  }
  expect(onOpenChange).toHaveBeenCalledWith(false);
});

test("Dialog exposes alertdialog, title and description", () => {
  mount(
    <Dialog
      open
      onOpenChange={vi.fn()}
      title="Revoke this phone?"
      description="It will need a new code."
      actions={<Button>Cancel</Button>}
    />,
  );
  const dialog = screen.getByRole("alertdialog", { name: "Revoke this phone?" });
  const id = dialog.getAttribute("aria-describedby");
  expect(id && document.getElementById(id)?.textContent).toBe("It will need a new code.");
});

function ControlledModalExample({
  kind,
  markCancel = false,
  removeOpener = false,
}: {
  kind: "sheet" | "dialog";
  markCancel?: boolean;
  removeOpener?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [showOpener, setShowOpener] = useState(true);
  const remove = removeOpener && <Button onClick={() => setShowOpener(false)}>Remove opener</Button>;
  return (
    <>
      {showOpener && <Button onClick={() => setOpen(true)}>Open modal</Button>}
      {kind === "sheet" ? (
        <Sheet open={open} onOpenChange={setOpen} title="Inbox">
          Reviews
          {remove}
        </Sheet>
      ) : (
        <Dialog
          open={open}
          onOpenChange={setOpen}
          title="Revoke this phone?"
          description="It will need a new code."
          actions={
            <>
              <Button variant="danger">Revoke</Button>
              <Button data-autofocus={markCancel ? "" : undefined} onClick={() => setOpen(false)}>
                Cancel
              </Button>
            </>
          }
        >
          {remove}
        </Dialog>
      )}
    </>
  );
}

test.each(["sheet", "dialog"] as const)("controlled %s restores opener focus after Escape", async (kind) => {
  mount(<ControlledModalExample kind={kind} />);
  const opener = screen.getByRole("button", { name: "Open modal" });
  act(() => opener.focus());
  fireEvent.click(opener);
  const modal = screen.getByRole(kind === "sheet" ? "dialog" : "alertdialog");
  fireEvent.keyDown(modal, { key: "Escape" });
  await waitFor(() => expect(screen.queryByRole(kind === "sheet" ? "dialog" : "alertdialog")).toBeNull());
  await waitFor(() => expect(document.activeElement).toBe(opener));
});

test.each(["sheet", "dialog"] as const)("controlled %s falls back when its opener was removed", async (kind) => {
  mount(<ControlledModalExample kind={kind} removeOpener />);
  const opener = screen.getByRole("button", { name: "Open modal" });
  act(() => opener.focus());
  fireEvent.click(opener);
  const modal = screen.getByRole(kind === "sheet" ? "dialog" : "alertdialog");
  fireEvent.click(screen.getByRole("button", { name: "Remove opener" }));
  expect(opener.isConnected).toBe(false);
  fireEvent.keyDown(modal, { key: "Escape" });
  await waitFor(() => expect(screen.queryByRole(kind === "sheet" ? "dialog" : "alertdialog")).toBeNull());
  await waitFor(() => expect(document.activeElement).toBe(document.body));
});

test("Dialog initially focuses the marked Cancel action", async () => {
  mount(<ControlledModalExample kind="dialog" markCancel />);
  fireEvent.click(screen.getByRole("button", { name: "Open modal" }));
  await waitFor(() => expect(document.activeElement).toBe(screen.getByRole("button", { name: "Cancel" })));
});

test("Dialog keeps Radix's default initial focus when no action is marked", async () => {
  mount(<ControlledModalExample kind="dialog" />);
  fireEvent.click(screen.getByRole("button", { name: "Open modal" }));
  await waitFor(() => expect(document.activeElement).toBe(screen.getByRole("button", { name: "Revoke" })));
});

function ToastExample() {
  const { show } = useToast();
  return (
    <>
      <Button onClick={() => show({ title: "Link copied", tone: "success" })}>Notify</Button>
      <Button onClick={() => show({ title: "Saved", description: "Draft saved" })}>Replace</Button>
    </>
  );
}

test("Toast updates a persistent status region and expires after exactly 3.2 seconds", () => {
  vi.useFakeTimers();
  mount(
    <ToastProvider>
      <ToastExample />
    </ToastProvider>,
  );
  const region = screen.getByRole("status");
  expect(region.textContent).toBe("");
  expect(region.classList.contains("pointer-events-auto")).toBe(true);
  fireEvent.click(screen.getByRole("button", { name: "Notify" }));
  expect(screen.getByRole("status")).toBe(region);
  expect(region.textContent).toContain("Link copied");
  act(() => vi.advanceTimersByTime(3199));
  expect(screen.getByRole("status")).toBeTruthy();
  act(() => vi.advanceTimersByTime(1));
  expect(screen.getByRole("status")).toBe(region);
  expect(region.textContent).toBe("");
});

test("Toast replaces the previous toast, restarts expiry, and can be dismissed", () => {
  vi.useFakeTimers();
  mount(
    <ToastProvider>
      <ToastExample />
    </ToastProvider>,
  );
  fireEvent.click(screen.getByRole("button", { name: "Notify" }));
  act(() => vi.advanceTimersByTime(3000));
  fireEvent.click(screen.getByRole("button", { name: "Replace" }));
  expect(screen.getAllByRole("status")).toHaveLength(1);
  act(() => vi.advanceTimersByTime(200));
  expect(screen.getByRole("status").textContent).toContain("Draft saved");
  fireEvent.click(screen.getByRole("button", { name: "Dismiss" }));
  expect(screen.getByRole("status").textContent).toBe("");
});

function ToastModalExample({
  kind,
  onInteractOutside,
}: {
  kind: "sheet" | "dialog";
  onInteractOutside?: (event: Event) => void;
}) {
  const [open, setOpen] = useState(true);
  return kind === "sheet" ? (
    <Sheet open={open} onOpenChange={setOpen} onInteractOutside={onInteractOutside} title="Inbox">
      <ToastExample />
    </Sheet>
  ) : (
    <Dialog
      open={open}
      onOpenChange={setOpen}
      onInteractOutside={onInteractOutside}
      title="Revoke this phone?"
      description="It will need a new code."
      actions={<Button>Cancel</Button>}
    >
      <ToastExample />
    </Dialog>
  );
}

test.each(["sheet", "dialog"] as const)("Toast Dismiss pointer sequence leaves the modal %s open", async (kind) => {
  const onInteractOutside = vi.fn();
  mount(
    <ToastProvider>
      <ToastModalExample kind={kind} onInteractOutside={onInteractOutside} />
    </ToastProvider>,
  );
  // Radix installs outside-interaction listeners on the next task.
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
  fireEvent.click(screen.getByRole("button", { name: "Notify" }));
  const region = screen.getByRole("status");
  expect(region.textContent).toContain("Link copied");
  expect(document.body.style.pointerEvents).toBe("none");
  expect(region.classList.contains("pointer-events-auto")).toBe(true);
  const dismiss = screen.getByRole("button", { name: "Dismiss" });
  fireEvent.pointerDown(dismiss, { button: 0, pointerType: "mouse" });
  fireEvent.pointerUp(dismiss, { button: 0, pointerType: "mouse" });
  fireEvent.click(dismiss);
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
  expect(region.textContent).toBe("");
  expect(onInteractOutside).not.toHaveBeenCalled();
  expect(screen.getByRole(kind === "sheet" ? "dialog" : "alertdialog")).toBeTruthy();
  const overlay = document.querySelector(".bg-overlay");
  expect(overlay).toBeTruthy();
  if (overlay) {
    fireEvent.pointerDown(overlay, { button: 0, pointerType: "mouse" });
    fireEvent.pointerUp(overlay, { button: 0, pointerType: "mouse" });
    fireEvent.click(overlay);
  }
  await waitFor(() => expect(screen.queryByRole(kind === "sheet" ? "dialog" : "alertdialog")).toBeNull());
  expect(onInteractOutside).toHaveBeenCalledOnce();
});

test.each(["sheet", "dialog"] as const)("modal %s excludes toast focus but forwards other outside focus", (kind) => {
  const onInteractOutside = vi.fn();
  mount(
    <ToastProvider>
      <ToastModalExample kind={kind} onInteractOutside={onInteractOutside} />
    </ToastProvider>,
  );
  fireEvent.click(screen.getByRole("button", { name: "Notify" }));
  const modal = screen.getByRole(kind === "sheet" ? "dialog" : "alertdialog");
  fireEvent.focusOut(modal);
  fireEvent.focusIn(screen.getByRole("button", { name: "Dismiss" }));
  expect(onInteractOutside).not.toHaveBeenCalled();
  expect(screen.getByRole(kind === "sheet" ? "dialog" : "alertdialog")).toBeTruthy();
  fireEvent.focusOut(modal);
  fireEvent.focusIn(document.body);
  expect(onInteractOutside).toHaveBeenCalledOnce();
});

test("Banner danger is persistent and its action runs", () => {
  const onAction = vi.fn();
  mount(
    <Banner tone="danger" actionLabel="Retry" onAction={onAction}>
      Could not save.
    </Banner>,
  );
  expect(screen.getByRole("alert").textContent).toContain("Could not save.");
  fireEvent.click(screen.getByRole("button", { name: "Retry" }));
  expect(onAction).toHaveBeenCalledOnce();
});

test("TextField forwards input props and ref and associates its label, hint and error", () => {
  const ref = createRef<HTMLInputElement>();
  const { rerender } = mount(
    <TextField label="Device name" hint="Shown on the devices page" ref={ref} name="device" icon={Search} />,
  );
  const input = screen.getByRole("textbox", { name: "Device name" });
  expect(ref.current).toBe(input);
  expect(input.getAttribute("name")).toBe("device");
  expect(document.getElementById(input.getAttribute("aria-describedby") ?? "")?.textContent).toBe(
    "Shown on the devices page",
  );
  rerender(<TextField label="Device name" error="Enter a name." />);
  expect(input.getAttribute("aria-invalid")).toBe("true");
  expect(document.getElementById(input.getAttribute("aria-describedby") ?? "")?.textContent).toBe("Enter a name.");
});

test("Textarea counts controlled input and only announces near its soft limit", () => {
  const { rerender } = mount(<Textarea label="Instructions" maxLength={4000} value={"x".repeat(120)} readOnly />);
  expect(screen.getByText("120 / 4000").getAttribute("aria-live")).toBe("off");
  rerender(<Textarea label="Instructions" maxLength={4000} value={"x".repeat(3600)} readOnly />);
  expect(screen.getByText("3600 / 4000").getAttribute("aria-live")).toBe("polite");
  rerender(<Textarea label="Instructions" maxLength={4000} value={"x".repeat(4001)} readOnly />);
  expect(screen.getByRole("textbox").getAttribute("aria-invalid")).toBe("true");
  expect(screen.getByText("4001 / 4000")).toBeTruthy();
});

test("Textarea forwards ref and input events and counts uncontrolled changes", () => {
  const ref = createRef<HTMLTextAreaElement>();
  const onChange = vi.fn();
  mount(<Textarea label="Instructions" ref={ref} defaultValue="abc" maxLength={10} onChange={onChange} />);
  const input = screen.getByRole("textbox");
  expect(ref.current).toBe(input);
  expect(screen.getByText("3 / 10")).toBeTruthy();
  fireEvent.change(input, { target: { value: "abcdefghi" } });
  expect(screen.getByText("9 / 10").getAttribute("aria-live")).toBe("polite");
  expect(onChange).toHaveBeenCalledOnce();
});

test("uncontrolled Textarea re-reads its value after form reset and removes the listener on unmount", async () => {
  const { unmount } = mount(
    <form aria-label="Instructions form">
      <Textarea label="Instructions" defaultValue="abc" maxLength={5} />
      <Button type="reset">Reset</Button>
    </form>,
  );
  const input = screen.getByRole("textbox") as HTMLTextAreaElement;
  const form = screen.getByRole("form", { name: "Instructions form" }) as HTMLFormElement;
  const removeListener = vi.spyOn(form, "removeEventListener");
  expect(input.hasAttribute("maxlength")).toBe(false);
  fireEvent.change(input, { target: { value: "abcdef" } });
  expect(screen.getByText("6 / 5")).toBeTruthy();
  expect(input.getAttribute("aria-invalid")).toBe("true");
  act(() => form.reset());
  await waitFor(() => expect(screen.getByText("3 / 5")).toBeTruthy());
  expect(input.value).toBe("abc");
  expect(input.getAttribute("aria-invalid")).toBeNull();
  unmount();
  expect(removeListener).toHaveBeenCalledWith("reset", expect.any(Function));
  removeListener.mockRestore();
});

test.each(["sm", "md", "lg"] as const)("fields retain the correct %s line height after size overrides", (size) => {
  mount(
    <>
      <TextField label="Name" size={size} />
      <TextField label="Path" size={size} mono />
      <Select label="Layout" size={size} options={["Split"]} />
    </>,
  );
  expect(screen.getByRole("textbox", { name: "Name" }).classList.contains("leading-(--lh-body)")).toBe(true);
  expect(screen.getByRole("textbox", { name: "Path" }).classList.contains("leading-[1.6]")).toBe(true);
  expect(screen.getByRole("combobox", { name: "Layout" }).classList.contains("leading-(--lh-snug)")).toBe(true);
});

test("Select is native, supports string and object options, and keeps disabled options", () => {
  mount(<Select label="Layout" options={["Split", { value: "unified", label: "Unified", disabled: true }]} />);
  expect(screen.getByRole("combobox", { name: "Layout" }).tagName).toBe("SELECT");
  expect((screen.getByRole("option", { name: "Unified" }) as HTMLOptionElement).disabled).toBe(true);
});

test("Checkbox and RadioGroup keep native form semantics and descriptions", () => {
  const onChange = vi.fn();
  mount(
    <>
      <Checkbox label="Hide resolved" description="Keep open threads visible" />
      <RadioGroup
        label="Layout"
        value="split"
        onChange={onChange}
        options={[
          { value: "split", label: "Split", description: "Two panes" },
          { value: "unified", label: "Unified" },
        ]}
      />
    </>,
  );
  const checkbox = screen.getByRole("checkbox", { name: /Hide resolved/ }) as HTMLInputElement;
  fireEvent.click(checkbox);
  expect(checkbox.checked).toBe(true);
  const group = screen.getByRole("group", { name: "Layout" });
  expect(group.tagName).toBe("FIELDSET");
  expect((within(group).getByRole("radio", { name: /Split/ }) as HTMLInputElement).checked).toBe(true);
  fireEvent.click(within(group).getByRole("radio", { name: "Unified" }));
  expect(onChange).toHaveBeenLastCalledWith("unified");
});

test.each([
  ["k7qp2mxd", "K7QP-2MXD"],
  ["oIlO1234", "0110-1234"],
  ["!u@k-7 q/p+2mxd?", "K7QP-2MXD"],
  ["123456789ABCDEFG", "1234-5678"],
])("PairingCodeInput formats %s as %s", (raw, expected) => {
  const onChange = vi.fn();
  mount(<PairingCodeInput onChange={onChange} />);
  const input = screen.getByRole("textbox", { name: "Pairing code" }) as HTMLInputElement;
  fireEvent.change(input, { target: { value: raw } });
  expect(input.value).toBe(expected);
  expect(onChange).toHaveBeenLastCalledWith(expected);
  expect(input.value.length).toBeLessThanOrEqual(9);
  expect(input.maxLength).toBe(9);
  expect(new RegExp(`^${input.pattern}$`).test(input.value)).toBe(true);
  expect(input.autocomplete).toBe("one-time-code");
});

function PairingExample() {
  const [value, setValue] = useState("");
  return <PairingCodeInput value={value} onChange={setValue} error="Code expired." />;
}

test("PairingCodeInput formats controlled typing, partial codes and pasted text before length truncation", () => {
  mount(<PairingExample />);
  const input = screen.getByRole("textbox") as HTMLInputElement;
  for (const character of "k7qp2mxd") fireEvent.change(input, { target: { value: input.value + character } });
  expect(input.value).toBe("K7QP-2MXD");
  input.setSelectionRange(0, input.value.length);
  fireEvent.paste(input, { clipboardData: { getData: () => "  oi l0-12 34  " } });
  expect(input.value).toBe("0110-1234");
  expect(input.getAttribute("aria-invalid")).toBe("true");
  expect(document.getElementById(input.getAttribute("aria-describedby") ?? "")?.textContent).toBe("Code expired.");
  fireEvent.change(input, { target: { value: "abcd" } });
  expect(input.value).toBe("ABCD");
  expect(new RegExp(`^${input.pattern}$`).test(input.value)).toBe(false);
});

test("controlled PairingCodeInput keeps its value after repeated rejected paste and typing", () => {
  const onChange = vi.fn();
  mount(<PairingCodeInput value="1234-5678" onChange={onChange} />);
  const input = screen.getByRole("textbox") as HTMLInputElement;
  for (let i = 0; i < 2; i++) {
    input.setSelectionRange(0, input.value.length);
    fireEvent.paste(input, { clipboardData: { getData: () => "ABCD-EFGH" } });
    expect(input.value).toBe("1234-5678");
  }
  expect(onChange).toHaveBeenCalledTimes(2);
  expect(onChange).toHaveBeenLastCalledWith("ABCD-EFGH");
  fireEvent.change(input, { target: { value: "1234-567" } });
  expect(input.value).toBe("1234-5678");
});

test.each(["readOnly", "disabled"] as const)("PairingCodeInput ignores paste and typing when %s", (flag) => {
  const onChange = vi.fn();
  mount(<PairingCodeInput defaultValue="1234-5678" onChange={onChange} {...{ [flag]: true }} />);
  const input = screen.getByRole("textbox") as HTMLInputElement;
  input.setSelectionRange(0, input.value.length);
  fireEvent.paste(input, { clipboardData: { getData: () => "ABCD-EFGH" } });
  expect(input.value).toBe("1234-5678");
  fireEvent.change(input, { target: { value: "ABCD-EFGH" } });
  expect(input.value).toBe("1234-5678");
  expect(onChange).not.toHaveBeenCalled();
});

test("PairingCodeInput restores the caret after an accepted controlled edit", () => {
  mount(<PairingExample />);
  const input = screen.getByRole("textbox") as HTMLInputElement;
  fireEvent.change(input, { target: { value: "k7qp2mxd", selectionStart: 3 } });
  expect(input.value).toBe("K7QP-2MXD");
  expect(input.selectionStart).toBe(3);
  input.setSelectionRange(2, 3);
  fireEvent.paste(input, { clipboardData: { getData: () => "z" } });
  expect(input.value).toBe("K7ZP-2MXD");
  expect(input.selectionStart).toBe(3);
  expect(input.selectionEnd).toBe(3);
});

test("PairingCodeInput drops a rejected edit's caret before an unrelated owner update", async () => {
  const onChange = vi.fn();
  const { rerender } = mount(<PairingCodeInput value="1234-5678" onChange={onChange} />);
  const input = screen.getByRole("textbox") as HTMLInputElement;
  input.setSelectionRange(1, 2);
  fireEvent.paste(input, { clipboardData: { getData: () => "A" } });
  expect(onChange).toHaveBeenCalledWith("1A34-5678");
  expect(input.value).toBe("1234-5678");
  await act(async () => {
    await Promise.resolve();
  });
  input.setSelectionRange(5, 5);
  const selection = vi.spyOn(input, "setSelectionRange");
  try {
    rerender(<PairingCodeInput value="1A34-5678" onChange={onChange} />);
    expect(input.value).toBe("1A34-5678");
    expect(selection).not.toHaveBeenCalled();
  } finally {
    selection.mockRestore();
  }
});

test.each([false, true])("long menus use available height and scroll vertically (radio %s)", (radio) => {
  const entries = Array.from({ length: 150 }, (_, n) => ({ value: String(n), label: `Revision ${n}` }));
  mount(
    <Menu
      label="Long menu"
      defaultOpen
      items={radio ? [{ radioGroup: { value: "0", onValueChange: vi.fn(), items: entries } }] : entries}
    />,
  );
  const menu = screen.getByRole("menu");
  expect(menu.classList.contains("max-h-(--radix-dropdown-menu-content-available-height)")).toBe(true);
  expect(menu.classList.contains("overflow-y-auto")).toBe(true);
  expect(menu.classList.contains("relative")).toBe(true);
  expect(within(menu).getAllByRole(radio ? "menuitemradio" : "menuitem")).toHaveLength(150);
});

function TextSizeMenuExample() {
  const [prose, setProse] = useState("16");
  const [code, setCode] = useState("13");
  return (
    <Menu
      label="Text size"
      items={[
        { heading: "Writeup and docs" },
        {
          radioGroup: {
            segmented: true,
            label: "Writeup and docs",
            value: prose,
            onValueChange: setProse,
            items: [15, 16, 17, 18].map((size) => ({ value: String(size), label: `${size} px` })),
          },
        },
        { heading: "Code in diffs" },
        {
          radioGroup: {
            segmented: true,
            label: "Code in diffs",
            value: code,
            onValueChange: setCode,
            items: [11, 12, 13, 14].map((size) => ({ value: String(size), label: `${size} px` })),
          },
        },
      ]}
    />
  );
}

test("text menu row navigation keeps focus after deferred Radix handlers and starts from the focused option", async () => {
  mount(<TextSizeMenuExample />);
  fireEvent.keyDown(screen.getByRole("button", { name: "Text size" }), { key: "ArrowDown" });
  await screen.findByRole("menu");
  vi.useFakeTimers();
  const option = (size: number) => screen.getByRole("menuitemradio", { name: `${size} px` });
  // Focus and selection differ when moving through the menu without choosing a value.
  act(() => option(15).focus());
  fireEvent.keyDown(option(15), { key: "ArrowRight" });
  await act(() => vi.advanceTimersByTimeAsync(1));
  expect(document.activeElement).toBe(option(16));
  expect(option(16).getAttribute("aria-checked")).toBe("true");
  fireEvent.keyDown(option(16), { key: "End" });
  await act(() => vi.advanceTimersByTimeAsync(1));
  expect(document.activeElement).toBe(option(18));
  expect(option(18).getAttribute("aria-checked")).toBe("true");
  fireEvent.keyDown(option(18), { key: "Home" });
  await act(() => vi.advanceTimersByTimeAsync(1));
  expect(document.activeElement).toBe(option(15));
  fireEvent.keyDown(option(15), { key: "ArrowLeft" });
  await act(() => vi.advanceTimersByTimeAsync(1));
  expect(document.activeElement).toBe(option(18));
  expect(option(13).getAttribute("aria-checked")).toBe("true");
});
