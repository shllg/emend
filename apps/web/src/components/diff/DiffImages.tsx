import { type FileView, LIMITS } from "@recense/contract";
import { useQuery } from "@tanstack/react-query";
import { useCallback, useState } from "react";
import { Lightbox } from "../reading/Lightbox.tsx";
import type { LightboxSubject } from "../reading/screenshots.ts";
import { Button } from "../ui/Button.tsx";
import { cn, focusRing } from "../ui/utils.ts";
import { fileSideQuery, useFileTexts } from "./file-texts.ts";
import { scanSvg, uncheckedSvg } from "./svg-active.ts";

const comparisonModes = ["Before", "After", "Side by side"] as const;
const formats = ["Pictures", "Text"] as const;
export type DiffImageMode = { comparison: (typeof comparisonModes)[number]; format: (typeof formats)[number] };

function ModeGroup<T extends string>({
  label,
  choices,
  value,
  onChange,
  className,
}: {
  label: string;
  choices: readonly T[];
  value: T;
  onChange: (choice: T) => void;
  className?: string;
}) {
  return (
    // biome-ignore lint/a11y/useSemanticElements: These view buttons form an ARIA group.
    <div
      role="group"
      aria-label={label}
      className={cn(
        "em-pair-modes inline-flex select-none gap-0.5 rounded-md border border-line-1 bg-sunken p-0.5",
        className,
      )}
    >
      {choices.map((choice) => (
        <Button
          key={choice}
          variant="ghost"
          size="sm"
          className="aria-pressed:bg-raised aria-pressed:text-fg-1 aria-pressed:shadow-1"
          aria-pressed={value === choice}
          onClick={() => onChange(choice)}
        >
          {choice}
        </Button>
      ))}
    </div>
  );
}

type Picture = Extract<LightboxSubject, { kind: "image" }> & { label: "Before" | "After"; flag: "oversized" | null };

function ImageSide({ picture, label, onOpen }: { picture: Picture; label: string; onOpen: () => void }) {
  const [failed, setFailed] = useState(false);
  const message = picture.flag
    ? `Not shown: larger than ${LIMITS.assetBytes / 1048576} MiB`
    : failed
      ? "Not shown: the image could not be loaded"
      : undefined;
  return (
    <figure>
      <figcaption>{label}</figcaption>
      {message ? (
        <div className="em-diff-image-frame">
          <p className="em-diff-summary">{message}</p>
        </div>
      ) : (
        <button
          type="button"
          aria-label={`Open ${picture.label} image`}
          aria-haspopup="dialog"
          className={cn("em-diff-image-frame", focusRing)}
          onClick={onOpen}
        >
          <img src={picture.src} alt={picture.label} loading="lazy" decoding="async" onError={() => setFailed(true)} />
        </button>
      )}
    </figure>
  );
}

const list = new Intl.ListFormat("en", { type: "conjunction" });

function useSvgScan(file: FileView, side: "old" | "new", near: boolean) {
  const source = useFileTexts();
  const svg = file.image?.[side]?.mediaType === "image/svg+xml";
  const readable = svg && !file.flag && (side === "old" ? file.hasOld : file.hasNew);
  const query = useQuery({
    ...fileSideQuery(file.id, side, source),
    enabled: near && readable,
    select: readable ? scanSvg : () => uncheckedSvg,
  });
  if (!svg) return undefined;
  return !readable || query.isError ? uncheckedSvg : query.data;
}

function sideLabel(before: boolean, after: boolean) {
  if (before && after) return "Before and After";
  return before ? "Before" : after ? "After" : undefined;
}

function SvgNotice({ file, near }: { file: FileView; near: boolean }) {
  const before = useSvgScan(file, "old", near);
  const after = useSvgScan(file, "new", near);
  const active = sideLabel(!!before?.kinds.length, !!after?.kinds.length);
  const unchecked = sideLabel(!!before?.unchecked, !!after?.unchecked);
  if (!active && !unchecked) return null;
  const found = new Set([...(before?.kinds ?? []), ...(after?.kinds ?? [])]);
  return (
    <div className="bg-warning-bg px-3 py-2 text-warning-fg [font:var(--type-meta)]">
      {active && (
        <p>
          The {active} {active === "Before and After" ? "SVGs hold" : "SVG holds"} {list.format(found)}. The picture
          never runs {found.size === 1 ? "it" : "them"}. Text shows the source.
        </p>
      )}
      {unchecked && (
        <p>
          The {unchecked} SVG {unchecked === "Before and After" ? "sources were" : "source was"} not checked for scripts
          or links. The picture never runs scripts.
        </p>
      )}
    </div>
  );
}

export function DiffImages({
  file,
  near,
  mode,
  onModeChange,
}: {
  file: FileView;
  near: boolean;
  mode: DiffImageMode;
  onModeChange: (mode: DiffImageMode) => void;
}) {
  const [gallery, setGallery] = useState<{ items: Picture[]; index: number } | null>(null);
  const closeGallery = useCallback(() => setGallery(null), []);
  const { image } = file;
  if (!image) return null;
  const pair = !!(image.old && image.new && !image.unchanged);
  const svg = image.old?.mediaType === "image/svg+xml" || image.new?.mediaType === "image/svg+xml";
  const sides = (["old", "new"] as const).flatMap<Picture>((side) => {
    const metadata = image[side];
    if (!metadata) return [];
    const label = side === "old" ? "Before" : "After";
    return [
      {
        kind: "image",
        label,
        flag: metadata.flag,
        src: `/api/v1/files/${encodeURIComponent(file.id)}/${side}/image`,
        caption: `${label} · ${side === "old" ? (file.oldPath ?? file.path) : file.path}`,
      },
    ];
  });
  const visible = sides.filter(({ label }) =>
    image.unchanged ? label === "After" : !pair || mode.comparison === "Side by side" || label === mode.comparison,
  );
  function open(picture: Picture) {
    const items = sides.filter((side) => !side.flag);
    setGallery({ items, index: items.indexOf(picture) });
  }
  return (
    <>
      {(pair || svg) && (
        <div className="em-diff-image-toolbar">
          {pair && (
            <ModeGroup
              label="Compare images"
              choices={comparisonModes}
              value={mode.comparison}
              onChange={(comparison) => onModeChange({ comparison, format: "Pictures" })}
            />
          )}
          {svg && (
            <ModeGroup
              className="ms-auto"
              label="Show as"
              choices={formats}
              value={mode.format}
              onChange={(format) => onModeChange({ ...mode, format })}
            />
          )}
        </div>
      )}
      {svg && <SvgNotice file={file} near={near} />}
      {mode.format === "Pictures" && (
        <div className="em-diff-images" data-pair={visible.length === 2 || undefined}>
          {visible.map((picture) => (
            <ImageSide
              key={picture.src}
              picture={picture}
              label={image.unchanged ? "Unchanged image" : picture.label}
              onOpen={() => open(picture)}
            />
          ))}
        </div>
      )}
      {gallery && <Lightbox gallery={gallery} imageNoun="image" onClose={closeGallery} />}
    </>
  );
}
