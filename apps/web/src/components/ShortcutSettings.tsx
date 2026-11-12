import {
  type KeyBinding,
  type KeySetting,
  type KeysSetting,
  SettingsView,
  type ShortcutCommand,
} from "@emend/contract";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useId, useState } from "react";
import { patch } from "../api/client.ts";
import { captureShortcut, keyLabel, shortcutCommands, shortcutGroups, shortcutLabels } from "../lib/shortcuts.ts";
import { Button } from "./ui/Button.tsx";
import { Kbd } from "./ui/Kbd.tsx";

function ShortcutSetting({
  command,
  setting,
  keys,
}: {
  command: ShortcutCommand;
  setting: KeySetting;
  keys: KeysSetting;
}) {
  const client = useQueryClient();
  const id = useId();
  const [capturing, setCapturing] = useState(false);
  const [error, setError] = useState<string>();
  const mutation = useMutation({
    scope: { id: "settings" },
    mutationFn: (binding: { key: KeyBinding } | null) =>
      patch("/api/v1/settings", { keys: { [command]: binding } }, SettingsView),
    onSuccess: async (view) => {
      await client.cancelQueries({ queryKey: ["settings"] });
      client.setQueryData(["settings"], view);
      setError(undefined);
    },
  });
  return (
    <fieldset aria-labelledby={`${id}-label`} className="border-b border-line-1 py-3">
      <div className="flex flex-wrap items-center gap-3">
        <span id={`${id}-label`} className="min-w-0 flex-1 text-14">
          {shortcutLabels[command]}
        </span>
        {setting.value === null ? <span className="text-14">Off</span> : <Kbd>{keyLabel(setting.value)}</Kbd>}
        <Button
          disabled={mutation.isPending}
          aria-describedby={`${id}-source`}
          onClick={(event) => {
            event.currentTarget.focus();
            setCapturing(true);
            setError(undefined);
          }}
          onBlur={() => {
            setCapturing(false);
            setError(undefined);
          }}
          onKeyDown={(event) => {
            if (!capturing) return;
            if (event.key === "Tab") {
              setCapturing(false);
              setError(undefined);
              return;
            }
            event.preventDefault();
            if (event.key === "Escape") {
              setCapturing(false);
              setError(undefined);
              return;
            }
            if (event.repeat || event.nativeEvent.isComposing || event.keyCode === 229) return;
            const captured = captureShortcut(event);
            if (captured.error) {
              setError(captured.error);
              return;
            }
            if (captured.key === undefined) return;
            const clash = shortcutCommands.find(
              (other) => other !== command && keys.commands[other].value === captured.key,
            );
            if (clash) {
              setError(`Already used by ${shortcutLabels[clash]}.`);
              return;
            }
            setCapturing(false);
            setError(undefined);
            mutation.mutate({ key: captured.key });
          }}
        >
          {capturing ? "Press a key…" : "Change"}
        </Button>
        {setting.value !== null && (
          <Button disabled={mutation.isPending} onClick={() => mutation.mutate({ key: null })}>
            Turn off
          </Button>
        )}
        {setting.override !== undefined && (
          <Button disabled={mutation.isPending} onClick={() => mutation.mutate(null)}>
            Reset
          </Button>
        )}
      </div>
      <div id={`${id}-source`} className="mt-2 text-14 text-fg-3">
        <p>
          {setting.source === "default"
            ? "Default."
            : setting.source === "file"
              ? "From the config file."
              : "Set here."}
        </p>
        {setting.override !== undefined && setting.file !== undefined && (
          <p>
            {setting.file === null ? (
              "The config file turns it off."
            ) : (
              <>
                The config file says <Kbd>{keyLabel(setting.file)}</Kbd>.
              </>
            )}
          </p>
        )}
        {setting.fileError && <p>The config file's key can't be used, so it is ignored.</p>}
        {setting.clashWith && <p>Its key is used by {shortcutLabels[setting.clashWith]}.</p>}
      </div>
      {error && (
        <p role="alert" className="mt-2 text-14 text-fg-3">
          {error}
        </p>
      )}
      {mutation.isError && (
        <p role="alert" className="mt-2 text-14 text-fg-3">
          Could not save settings. Try again.
        </p>
      )}
    </fieldset>
  );
}

export function ShortcutSettings({ keys }: { keys: KeysSetting }) {
  return (
    <section aria-labelledby="keyboard-settings" className="mt-10">
      <h2 id="keyboard-settings" className="mb-4 text-16 font-semibold">
        Keyboard shortcuts
      </h2>
      {keys.fileError && (
        <p className="text-14 text-fg-3">Some keys in the config file can't be used, so they are ignored.</p>
      )}
      {shortcutGroups.map((group) => (
        <section key={group.label} className="mt-4">
          <h3 className="text-14 font-semibold">{group.label}</h3>
          {group.commands.map((command) => (
            <ShortcutSetting key={command} command={command} setting={keys.commands[command]} keys={keys} />
          ))}
        </section>
      ))}
    </section>
  );
}
