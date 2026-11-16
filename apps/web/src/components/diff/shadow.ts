export const diffShadowCSS = `
/* Trusted app CSS passed to Pierre's shadow root; never derived from reviewed text. */
[data-column-number] {
  font-size: calc(var(--diffs-font-size) - 1px);
}
[data-line-type="change-addition"] {
  --diffs-computed-diff-line-bg: var(--diff-add-bg);
}
[data-line-type="change-deletion"] {
  --diffs-computed-diff-line-bg: var(--diff-del-bg);
}
[data-overflow="scroll"] [data-gutter] {
  background: var(--bg-surface);
}
[data-content-buffer],
[data-gutter-buffer="buffer"] {
  background: var(--bg-sunken);
}
[data-separator="line-info"] {
  margin-block: 0;
  background: var(--diff-hunk-bg);
}
[data-separator="line-info"],
[data-separator="line-info"] [data-separator-wrapper],
[data-separator="line-info"] [data-separator-content],
[data-separator="line-info"] [data-expand-button] {
  border: 0;
  border-radius: 0;
  color: var(--fg-3);
  font-family: var(--font-mono);
  font-feature-settings: var(--mono-features);
}
[data-separator="line-info"] [data-separator-wrapper],
[data-separator="line-info"] [data-separator-content],
[data-separator="line-info"] [data-expand-button] {
  background: transparent;
}
[data-separator="line-info"] [data-expand-button] {
  color: var(--fg-2);
}
[data-separator="line-info"] [data-expand-button]:hover {
  color: var(--fg-1);
}
[data-line][data-hovered] {
  --diffs-computed-hovered-line-bg: var(--bg-hover);
}
[data-line][data-hovered][data-line-type="change-addition"] {
  --diffs-computed-hovered-line-bg: var(--diff-add-hover);
}
[data-line][data-hovered][data-line-type="change-deletion"] {
  --diffs-computed-hovered-line-bg: var(--diff-del-hover);
}
[data-column-number][data-hovered] {
  --diffs-computed-hovered-line-bg: var(--diff-select-bg);
  color: var(--fg-1);
}
[data-column-number][data-comment-active] {
  box-shadow: inset 2px 0 0 var(--accent);
}
[data-gutter-utility-slot] {
  z-index: 4;
  right: -20px;
  width: 18px;
  align-items: start;
}
[data-indicators="classic"] [data-line] {
  padding-inline-start: max(2ch, 22px);
}
[data-column-number]:not([data-hovered]) [data-gutter-utility-slot] {
  display: none;
}
[data-line] span[style*="--diffs-token-heading"] {
  /* TextMate supports bold, but not semibold. */
  font-weight: 600 !important;
}
`;
