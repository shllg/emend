import { SAMPLE_REVIEW_ID, type SampleView } from "@recense/contract";
import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { useCallback, useRef, useState } from "react";
import { sampleQuery, themesQuery } from "../api/queries.ts";
import { FileTextsContext } from "../components/diff/file-texts.ts";
import { LazyDiffPane } from "../components/diff/LazyDiffPane.tsx";
import { AppFrame } from "../components/layout/AppFrame.tsx";
import type { ReaderProps } from "../components/reading/BlockReader.tsx";
import { DocView } from "../components/reading/DocView.tsx";
import { Writeup } from "../components/reading/Writeup.tsx";
import { SampleBadges } from "../components/sample/SampleBadges.tsx";
import { SampleControls } from "../components/sample/SampleControls.tsx";
import { SendBar } from "../components/send/SendBar.tsx";
import { ThreadCard } from "../components/threads/ThreadCard.tsx";
import { Select } from "../components/ui/Select.tsx";
import { docHeading } from "../lib/doc-navigation.ts";
import { useLayout } from "../lib/layout.ts";
import { ReadOnlyReview } from "../lib/read-only-review.ts";
import { selectCustomTheme, setThemePick, useThemeState } from "../lib/theme.ts";

function ThemeSwitch() {
  const { pick } = useThemeState();
  const themes = useQuery(themesQuery());
  return (
    <div className="sticky top-0 z-[calc(var(--z-sticky)+5)] flex flex-wrap items-end justify-between gap-3 border-b border-line-1 bg-surface px-4 py-3">
      <div>
        <h1 className="text-20 font-semibold">Theme sample</h1>
        <Link to="/settings">Settings</Link>
      </div>
      <Select
        label="Theme on this device"
        className="max-w-full"
        value={pick}
        options={[
          { value: "system", label: "System" },
          { value: "dark", label: "Dark" },
          { value: "light", label: "Light" },
          ...(themes.data?.themes.flatMap((theme) =>
            theme.valid ? [{ value: `theme:${theme.name}`, label: theme.name }] : [],
          ) ?? []),
        ]}
        onChange={(event) => {
          const value = event.target.value;
          if (value === "system" || value === "dark" || value === "light") setThemePick(value);
          else {
            const theme = themes.data?.themes.find((theme) => `theme:${theme.name}` === value);
            if (theme?.valid) selectCustomTheme(theme);
          }
        }}
      />
      {themes.isError && <p role="alert">Could not load custom themes.</p>}
    </div>
  );
}

function SampleDoc({ doc, ...reader }: ReaderProps & { doc: SampleView["revision"]["docs"][number] }) {
  const root = useRef<HTMLDivElement>(null);
  return (
    <div ref={root} data-reading-scroll className={doc.kind === "html" ? "flex h-[650px] flex-col" : undefined}>
      <DocView
        {...reader}
        docs={[doc]}
        openDoc={doc}
        search={{}}
        targeted={false}
        onOpenDoc={() => {}}
        onHeading={(id) => {
          if (root.current && doc.kind === "markdown")
            docHeading(root.current, doc, id)?.scrollIntoView({ block: "start" });
        }}
      />
    </div>
  );
}

function SampleContent({ sample }: { sample: SampleView }) {
  const phone = useLayout() === "phone";
  const { revision } = sample;
  const [currentTopic, setCurrentTopic] = useState<string>();
  const texts = useCallback(
    async (id: string, side: "old" | "new") => {
      const file = sample.fileTexts[id];
      if (!file) throw new Error("Unknown sample file");
      return file[side];
    },
    [sample.fileTexts],
  );
  const reader = {
    reviewId: SAMPLE_REVIEW_ID,
    revision: revision.seq,
    threads: revision.threads,
    changedBlocks: revision.changedBlocks,
    topics: revision.topics,
  };
  return (
    <FileTextsContext value={{ scope: "sample", read: texts }}>
      <div className="mx-auto w-full max-w-[1200px] space-y-8 pb-10">
        <p className="px-4 pt-5 text-fg-3">Fixed sample content. Nothing can be commented on, sent or approved.</p>
        <section aria-label="Sample writeup" className="bg-reading" data-reading-scroll>
          <Writeup
            {...reader}
            writeup={revision.writeup}
            files={revision.files}
            docs={revision.docs}
            changedSince={revision.changedSince}
            phone={phone}
            onCurrentTopic={setCurrentTopic}
          />
        </section>
        <section aria-label="Sample documents" className="space-y-6 bg-reading">
          {revision.docs.map((doc) => (
            <SampleDoc key={doc.path} {...reader} doc={doc} />
          ))}
        </section>
        <section
          aria-label="Sample diff"
          data-diff-scroll
          className="relative h-[70dvh] min-w-0 overflow-y-auto bg-surface"
        >
          <LazyDiffPane reviewId={SAMPLE_REVIEW_ID} revision={revision} currentTopic={currentTopic} />
        </section>
        <section aria-label="Sample comment threads" className="space-y-3 px-4">
          <h2 className="text-20 font-semibold">Comment threads</h2>
          {revision.threads.map((thread) => (
            <ThreadCard key={thread.id} {...reader} thread={thread} />
          ))}
        </section>
        <section aria-label="Sample badges">
          <h2 className="px-4 text-20 font-semibold">Status badges</h2>
          <SampleBadges />
        </section>
        <section aria-label="Sample controls">
          <h2 className="px-4 text-20 font-semibold">Controls</h2>
          <SampleControls />
        </section>
        <SendBar
          reviewId={SAMPLE_REVIEW_ID}
          revision={revision.seq}
          newestRevision={revision.seq}
          unsentCount={1}
          phone={phone}
        />
      </div>
    </FileTextsContext>
  );
}

export function ThemeSamplePage() {
  const sample = useQuery(sampleQuery());
  return (
    <ReadOnlyReview value={true}>
      <AppFrame>
        <main className="relative min-h-0 flex-1 overflow-y-auto">
          <ThemeSwitch />
          {sample.isPending && (
            <p role="status" className="p-4">
              Loading sample…
            </p>
          )}
          {sample.isError && (
            <p role="alert" className="p-4">
              Could not load the sample. Refresh to try again.
            </p>
          )}
          {sample.data && <SampleContent sample={sample.data} />}
        </main>
      </AppFrame>
    </ReadOnlyReview>
  );
}
