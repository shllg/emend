// Classic, blocking head script. Keep the key and colours in sync with src/lib/theme.ts.
(() => {
  let pick;
  try {
    pick = localStorage.getItem("emend.theme");
  } catch {}
  if (pick !== "dark" && pick !== "light") pick = undefined;
  if (pick) document.documentElement.dataset.theme = pick;
  else delete document.documentElement.dataset.theme;
  for (const scheme of ["light", "dark"]) {
    const meta = document.querySelector(`meta[name="theme-color"][media="(prefers-color-scheme: ${scheme})"]`);
    if (meta) meta.content = (pick || scheme) === "dark" ? "#171717" : "#fafafb";
  }
})();
