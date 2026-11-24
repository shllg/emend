function disabled() {
  throw new Error("This diff backend is disabled. recense uses shiki-js.");
}

export {
  disabled as createOnigurumaEngine,
  disabled as HighlightsHighlighter,
  disabled as themes,
  disabled as default,
};

disabled();
