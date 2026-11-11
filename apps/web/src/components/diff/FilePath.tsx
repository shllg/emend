import { Fragment } from "react";
import { CopyTextMenu } from "../ui/CopyTextMenu.tsx";

export function Path({ path }: { path: string }) {
  const segments = path.split("/");
  return (
    <bdi dir="ltr">
      {segments.map((segment, index) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: Static path segments may repeat names.
        <Fragment key={index}>
          <span className={index === segments.length - 1 ? "font-medium text-fg-1" : "text-fg-3"}>
            {segment}
            {index < segments.length - 1 ? "/" : ""}
          </span>
          {index < segments.length - 1 && <wbr />}
        </Fragment>
      ))}
    </bdi>
  );
}

export function FilePathMenu({ path, oldPath }: { path: string; oldPath?: string | null }) {
  return (
    <CopyTextMenu
      text={path}
      noun="path"
      heading={{ as: "h4", className: "em-file-path", title: path, "aria-label": path }}
      trigger={{ className: "em-file-path-button", "aria-label": path, children: <Path path={path} /> }}
      blocks={[
        {
          content: <Path path={path} />,
          className:
            "px-2.5 pt-2 pb-1 font-stretch-mono whitespace-pre-wrap text-fg-1 [font:var(--type-path)] [overflow-wrap:anywhere] select-text",
        },
        ...(oldPath
          ? [
              {
                content: (
                  <>
                    Renamed from <Path path={oldPath} />
                  </>
                ),
                className:
                  "px-2.5 pb-1 font-stretch-mono whitespace-pre-wrap text-fg-3 [font:var(--type-path)] [overflow-wrap:anywhere] select-text",
              },
            ]
          : []),
      ]}
    />
  );
}
