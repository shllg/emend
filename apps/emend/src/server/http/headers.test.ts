import { expect, test } from "vitest";
import { APP_CSP, HTML_DOC_CSP, headersForPath } from "./headers.ts";

test("content paths default to the exact script-free CSP until a doc is served", () => {
  for (const path of ["/content/key/doc.html", "/content/key/font.woff2", "/content/missing"])
    expect(headersForPath(path)).toEqual({
      "Content-Security-Policy":
        "sandbox allow-scripts; default-src 'none'; script-src 'none'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self' data:; media-src 'self'; connect-src 'none'; form-action 'none'; frame-src 'none'; frame-ancestors 'self'",
      "X-Content-Type-Options": "nosniff",
      "Referrer-Policy": "no-referrer",
      "Cross-Origin-Resource-Policy": "same-origin",
      "Cache-Control": "no-store",
    });
});

test("only the exact Mermaid frame path gets the frame CSP and SAMEORIGIN", () => {
  const shared = {
    "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "no-referrer",
    "Cross-Origin-Opener-Policy": "same-origin",
  };
  expect(headersForPath("/mermaid-frame.html")).toEqual({
    ...shared,
    "Content-Security-Policy": "default-src 'none'; script-src 'self'; style-src 'unsafe-inline'; img-src data:",
    "X-Frame-Options": "SAMEORIGIN",
  });
  expect(HTML_DOC_CSP).toContain("frame-src 'none'");
  expect(HTML_DOC_CSP).toContain("connect-src 'none'");
  expect(HTML_DOC_CSP.match(/'sha256-[^']+'/g)).toHaveLength(1);
  for (const path of ["/", "/r/synthetic", "/assets/mermaid.js", "/mermaid-frame.html/", "/another/mermaid-frame.html"])
    expect(headersForPath(path)).toEqual({ ...shared, "Content-Security-Policy": APP_CSP, "X-Frame-Options": "DENY" });
  expect(headersForPath("/api/v1/reviews")).toEqual({
    ...shared,
    "Content-Security-Policy": APP_CSP,
    "X-Frame-Options": "DENY",
    "Cache-Control": "no-store",
  });
});
