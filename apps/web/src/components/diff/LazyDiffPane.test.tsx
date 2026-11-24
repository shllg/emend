import type { RevisionView } from "@recense/contract";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import { LazyDiffPane } from "./LazyDiffPane.tsx";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});
test("a rejected import stays in the pane and Retry imports a new lazy component", async () => {
  vi.spyOn(console, "error").mockImplementation(() => {});
  const loader = vi
    .fn()
    .mockRejectedValueOnce(new Error("Synthetic chunk outage"))
    .mockResolvedValue({ default: () => <p>Loaded diff</p> });
  render(
    <>
      <h1>Review header</h1>
      <section>Reading pane</section>
      <LazyDiffPane load={loader} reviewId="synthetic" revision={{ seq: 1 } as RevisionView} />
      <button type="button">Send</button>
    </>,
  );
  expect(await screen.findByText("Could not load the diff.")).toBeTruthy();
  expect(screen.getByText("Reading pane")).toBeTruthy();
  expect(screen.getByRole("button", { name: "Send" })).toBeTruthy();
  expect(screen.getByRole("heading", { name: "Review header" })).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Retry" }));
  expect(await screen.findByText("Loaded diff")).toBeTruthy();
  expect(loader).toHaveBeenCalledTimes(2);
});
test("a cached native module evaluation failure offers Reload after Retry fails", async () => {
  vi.spyOn(console, "error").mockImplementation(() => {});
  const reload = vi.spyOn(window.location, "reload").mockImplementation(() => {});
  const url = `data:text/javascript,${encodeURIComponent('throw new Error("Synthetic native module failure"); export default function Pane() {}')}`;
  const errors: unknown[] = [];
  const load = () =>
    import(/* @vite-ignore */ url).catch((error) => {
      errors.push(error);
      throw error;
    });
  render(<LazyDiffPane load={load} reviewId="synthetic" revision={{ seq: 1 } as RevisionView} />);
  await screen.findByText("Could not load the diff.");
  expect(screen.queryByRole("button", { name: "Reload the page" })).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Retry" }));
  fireEvent.click(await screen.findByRole("button", { name: "Reload the page" }));
  expect(reload).toHaveBeenCalledOnce();
  expect(errors).toHaveLength(2);
  expect(errors[0]).toBe(errors[1]);
});
