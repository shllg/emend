import {
  type KeyBinding,
  type KeySetting,
  type KeysSetting,
  type SettingsUpdate,
  SettingsView,
  type ShortcutCommand,
} from "@emend/contract";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useId, useState } from "react";
import { patch } from "../api/client.ts";
import {
  captureShortcut,
  jumpCommands,
  jumpKeysLabel,
  keyLabel,
  shortcutCommands,
  shortcutGroups,
  shortcutLabels,
} from "../lib/shortcuts.ts";
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

function JumpShortcutSetting({ keys }: { keys: KeysSetting }) {
  const client = useQueryClient();
  const id = useId();
  const [capturing, setCapturing] = useState(false);
  const [error, setError] = useState<string>();
  const settings = jumpCommands.map((command) => keys.commands[command]);
  const label = jumpKeysLabel(settings.map((setting) => setting.value));
  const clash = settings.find((setting) => setting.clashWith)?.clashWith;
  const mutation = useMutation({
    scope: { id: "settings" },
    mutationFn: (keys: SettingsUpdate["keys"]) => patch("/api/v1/settings", { keys }, SettingsView),
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
          Open Active row 1 to 9
        </span>
        {label === "Off" ? <span className="text-14">Off</span> : <Kbd>{label}</Kbd>}
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
            if (captured.key === undefined && !captured.error) return;
            if (!captured.key || !/^(alt|mod)\+[0-9]$/.test(captured.key)) {
              setError(
                /Mac|iPhone|iPad|iPod/.test(navigator.platform)
                  ? "Hold ⌥ or ⌘ and press a digit."
                  : "Hold Alt or Ctrl and press a digit.",
              );
              return;
            }
            const modifier = captured.key.slice(0, 3);
            const values = jumpCommands.map((_, index) => `${modifier}+${index + 1}`);
            const clash = shortcutCommands.find((command) => {
              const value = keys.commands[command].value;
              return !jumpCommands.includes(command) && value !== null && values.includes(value);
            });
            if (clash) {
              setError(`Already used by ${shortcutLabels[clash]}.`);
              return;
            }
            setCapturing(false);
            setError(undefined);
            mutation.mutate(
              Object.fromEntries(jumpCommands.map((command, index) => [command, { key: values[index] }])),
            );
          }}
        >
          {capturing ? "Press a modifier and a digit…" : "Change"}
        </Button>
        {settings.some((setting) => setting.value !== null) && (
          <Button
            disabled={mutation.isPending}
            onClick={() => mutation.mutate(Object.fromEntries(jumpCommands.map((command) => [command, { key: null }])))}
          >
            Turn off
          </Button>
        )}
        {settings.some((setting) => setting.override !== undefined) && (
          <Button
            disabled={mutation.isPending}
            onClick={() => mutation.mutate(Object.fromEntries(jumpCommands.map((command) => [command, null])))}
          >
            Reset
          </Button>
        )}
      </div>
      <div id={`${id}-source`} className="mt-2 text-14 text-fg-3">
        <p>
          {settings.some((setting) => setting.source === "override")
            ? "Set here."
            : settings.some((setting) => setting.source === "file")
              ? "From the config file."
              : "Default."}
        </p>
        {settings.some((setting) => setting.fileError) && (
          <p>Some config file keys can't be used, so they are ignored.</p>
        )}
        {clash && <p>Some of its keys are used by {shortcutLabels[clash]}.</p>}
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
          {group.jump && <JumpShortcutSetting keys={keys} />}
        </section>
      ))}
    </section>
  );
}
