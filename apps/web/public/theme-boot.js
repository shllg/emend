// Classic, blocking head script. Keep keys, names and colours in sync with src/lib/theme.ts.
(() => {
  let pick;
  let color;
  try {
    pick = localStorage.getItem("emend.theme");
    if (pick?.startsWith("theme:")) {
      const name = pick.slice(6);
      const cached = JSON.parse(localStorage.getItem("emend.theme.custom") || "null");
      if (
        /^[a-z0-9](?:[a-z0-9-]{0,38}[a-z0-9])?$(?![\s\S])/.test(name) &&
        !["system", "dark", "light", "fonts"].includes(name) &&
        cached?.valid === true &&
        cached.name === name &&
        (cached.base === "dark" || cached.base === "light")
      ) {
        pick = cached.base;
        if (typeof cached.themeColor === "string" && /^#[0-9a-f]{6}$(?![\s\S])/i.test(cached.themeColor))
          color = cached.themeColor;
      }
    }
  } catch {}
  if (pick !== "dark" && pick !== "light") pick = undefined;
  if (pick) document.documentElement.dataset.theme = pick;
  else delete document.documentElement.dataset.theme;
  for (const scheme of ["light", "dark"]) {
    const meta = document.querySelector(`meta[name="theme-color"][media="(prefers-color-scheme: ${scheme})"]`);
    if (meta) meta.content = color || ((pick || scheme) === "dark" ? "#171717" : "#fafafb");
  }
})();
