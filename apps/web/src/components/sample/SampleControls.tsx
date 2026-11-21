import { Info } from "lucide-react";
import { useState } from "react";
import { ViewedMark } from "../files/ViewedMark.tsx";
import { Banner } from "../ui/Banner.tsx";
import { Button } from "../ui/Button.tsx";
import { Checkbox } from "../ui/Checkbox.tsx";
import { IconButton } from "../ui/IconButton.tsx";
import { Kbd } from "../ui/Kbd.tsx";
import { Menu } from "../ui/Menu.tsx";
import { RadioGroup } from "../ui/RadioGroup.tsx";
import { SegmentedControl } from "../ui/SegmentedControl.tsx";
import { Select } from "../ui/Select.tsx";
import { Textarea } from "../ui/Textarea.tsx";
import { TextField } from "../ui/TextField.tsx";
import { Tooltip } from "../ui/Tooltip.tsx";

export function SampleControls() {
  const [size, setSize] = useState("small");
  const options = [
    { value: "small", label: "Small" },
    { value: "large", label: "Large" },
  ];
  return (
    <div className="space-y-5 p-4">
      {(["primary", "secondary", "ghost", "approve", "danger"] as const).map((variant) => (
        <div key={variant} className="flex flex-wrap items-center gap-2">
          {(["sm", "md", "lg"] as const).map((size) => (
            <Button key={size} variant={variant} size={size}>
              {variant} · {size}
            </Button>
          ))}
          <Button variant={variant} disabled>
            Disabled
          </Button>
          <Button variant={variant} loading>
            Loading
          </Button>
        </div>
      ))}
      <div className="flex flex-wrap items-center gap-3">
        <Tooltip content="A little more detail" open>
          <IconButton icon={Info} label="Sample information" tooltip={false} />
        </Tooltip>
        <Kbd>Ctrl K</Kbd>
        <Button kbd="P">Preview</Button>
        <Menu
          label="Sample menu"
          items={[
            { heading: "Parcel" },
            { label: "Small", kbd: "S" },
            { separator: true },
            { label: "Unavailable", disabled: true },
          ]}
        />
        <ViewedMark label="sample file" state="viewed" showLabel onToggle={() => {}} />
        <ViewedMark label="changed sample file" state="stale" viewedOn={1} showLabel onToggle={() => {}} />
      </div>
      <div className="grid gap-4 md:grid-cols-2">
        <TextField label="Label" placeholder="Small parcel" hint="Preview text only." />
        <TextField label="Invalid label" defaultValue="" error="Enter a label." />
        <TextField label="Disabled field" disabled defaultValue="Unavailable" />
        <Textarea label="Description" defaultValue="A small parcel with a clear label." />
        <Select label="Parcel size" options={options} value={size} onChange={(event) => setSize(event.target.value)} />
        <Checkbox label="Label checked" defaultChecked description="This choice is not saved." />
        <RadioGroup label="Box size" options={options} value={size} onChange={setSize} />
        <SegmentedControl label="Size preview" options={options} value={size} onChange={setSize} />
      </div>
      {(["info", "warning", "danger", "neutral"] as const).map((tone) => (
        <Banner key={tone} tone={tone} inline>
          {tone}: a sample message.
        </Banner>
      ))}
    </div>
  );
}
