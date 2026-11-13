import { Columns2, Files, MoveHorizontal, Type } from "lucide-react";
import { useLayout } from "../../lib/layout.ts";
import { type LayoutPreferences, layoutStore, useLayoutPreferences } from "../../lib/layout-store.ts";
import { Button } from "../ui/Button.tsx";
import { Menu, type MenuItem } from "../ui/Menu.tsx";
import { SegmentedControl } from "../ui/SegmentedControl.tsx";

export function textSizeItems(preferences: LayoutPreferences): MenuItem[] {
  return [
    { heading: "Writeup and docs" },
    {
      radioGroup: {
        label: "Writeup and docs",
        segmented: true,
        value: String(preferences.proseSize),
        onValueChange: (value) => {
          const proseSize = Number(value);
          if (proseSize === 15 || proseSize === 16 || proseSize === 17 || proseSize === 18)
            layoutStore.update({ proseSize });
        },
        items: [15, 16, 17, 18].map((size) => ({ value: String(size), label: `${size} px` })),
      },
    },
    { heading: "Code in diffs" },
    {
      radioGroup: {
        label: "Code in diffs",
        segmented: true,
        value: String(preferences.codeSize),
        onValueChange: (value) => {
          const codeSize = Number(value);
          if (codeSize === 11 || codeSize === 12 || codeSize === 13 || codeSize === 14)
            layoutStore.update({ codeSize });
        },
        items: [11, 12, 13, 14].map((size) => ({ value: String(size), label: `${size} px` })),
      },
    },
  ];
}

export function readingWidthItems(preferences: LayoutPreferences): MenuItem[] {
  return [
    { heading: "Reading width" },
    {
      radioGroup: {
        label: "Reading width",
        value: preferences.readingWidth,
        onValueChange: (readingWidth) => {
          if (readingWidth === "comfortable" || readingWidth === "wide" || readingWidth === "narrow")
            layoutStore.update({ readingWidth });
        },
        items: [
          { value: "comfortable", label: "Comfortable 1024px" },
          { value: "wide", label: "Wide 1248px" },
          { value: "narrow", label: "Narrow 68ch" },
        ],
      },
    },
  ];
}

export function LayoutControls() {
  const layout = useLayout();
  const preferences = useLayoutPreferences();
  if (layout === "phone") return null;
  return (
    <div className="ml-auto flex flex-wrap items-center gap-2">
      <SegmentedControl
        label="Panes"
        size="sm"
        value={preferences.pane[layout]}
        options={[
          { value: "split", label: "Split", icon: Columns2 },
          { value: "tabs", label: "Tabs", icon: Files },
        ]}
        onChange={(value) => {
          if (value === "split" || value === "tabs")
            layoutStore.update({ pane: { ...preferences.pane, [layout]: value } });
        }}
      />
      <Menu
        label="Reading width"
        trigger={
          <Button variant="ghost" size="sm" icon={MoveHorizontal}>
            Width
          </Button>
        }
        items={readingWidthItems(preferences)}
      />
      <Menu
        label="Text size"
        trigger={
          <Button variant="ghost" size="sm" icon={Type}>
            Text
          </Button>
        }
        items={textSizeItems(preferences)}
      />
    </div>
  );
}
