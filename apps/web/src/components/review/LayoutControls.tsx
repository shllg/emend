import { Columns2, Files, PanelsTopLeft } from "lucide-react";
import { useLayout } from "../../lib/layout.ts";
import { type LayoutPreferences, layoutStore, useLayoutPreferences } from "../../lib/layout-store.ts";
import { Icon } from "../ui/Icon.tsx";
import { IconButton } from "../ui/IconButton.tsx";
import { Menu, type MenuItem } from "../ui/Menu.tsx";

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

export function paneItems(preferences: LayoutPreferences, layout: "tablet" | "desktop"): MenuItem[] {
  return [
    { heading: "Panes" },
    {
      radioGroup: {
        label: "Panes",
        segmented: true,
        value: preferences.pane[layout],
        onValueChange: (value) => {
          if (value === "split" || value === "tabs")
            layoutStore.update({ pane: { ...preferences.pane, [layout]: value } });
        },
        items: [
          {
            value: "split",
            label: (
              <>
                <Icon icon={Columns2} size={14} />
                Split
              </>
            ),
          },
          {
            value: "tabs",
            label: (
              <>
                <Icon icon={Files} size={14} />
                Tabs
              </>
            ),
          },
        ],
      },
    },
  ];
}

export function ViewMenu() {
  const layout = useLayout();
  const preferences = useLayoutPreferences();
  if (layout === "phone") return null;
  return (
    <Menu
      label="View"
      trigger={<IconButton label="View" icon={PanelsTopLeft} />}
      items={[...paneItems(preferences, layout), ...readingWidthItems(preferences), ...textSizeItems(preferences)]}
    />
  );
}
