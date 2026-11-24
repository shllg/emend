import { GoMode, MODE_LABELS } from "@recense/contract";
import { RadioGroup } from "../ui/RadioGroup.tsx";
import { Select } from "../ui/Select.tsx";

const options = GoMode.options.map((mode) => ({ value: mode, label: MODE_LABELS[mode] }));

export function ModePicker({
  value,
  onChange,
  disabled,
  cards = false,
}: {
  value: GoMode;
  onChange: (mode: GoMode) => void;
  disabled?: boolean;
  cards?: boolean;
}) {
  if (cards)
    return (
      <fieldset disabled={disabled} className="m-0 min-w-0 border-0 p-0">
        <RadioGroup
          label="Mode"
          variant="cards"
          value={value}
          onChange={(value) => onChange(GoMode.parse(value))}
          options={options}
        />
      </fieldset>
    );
  return (
    <Select
      aria-label="Mode"
      size="sm"
      options={options}
      disabled={disabled}
      value={value}
      onChange={(event) => onChange(GoMode.parse(event.target.value))}
    />
  );
}
