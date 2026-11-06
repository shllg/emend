---
paths:
  - "packages/core/src/render/**"
  - "apps/web/src/**"
  - "apps/web/public/**"
  - "apps/web/mermaid-frame.*"
  - "apps/emend/src/server/content/**"
  - "apps/emend/src/server/http/headers.ts"
---

# Content isolation

Writeups, docs, glossary entries, diffs and comment bodies are written by an agent, come from a
repo under review or are pasted in from elsewhere. Treat every byte as hostile. A script that runs
with the reviewer's session can send instructions to the waiting agent in the reviewer's name.

- Markdown renders on the server only: remark-parse → remark-gfm → remark-rehype →
  rehype-sanitize → link hardener → Shiki → rehype-stringify. Never skip rehype-sanitize. Shiki
  runs after sanitize and is the only source of `style` attributes. Comments add only two steps
  before remark-rehype: a size check that rejects a body whose references expand too far, and a
  line-break step that emits only `text` and `break` nodes. Any other step before sanitize needs
  `emend-security-reviewer`.
- Never widen the sanitize schema to allow `script`, `style`, `iframe`, `object`, `embed`, `form`,
  `svg`, `on*` attributes, author `style` attributes, or `javascript:`, `data:` or `vbscript:`
  URLs. Author `id`, `class` and `name` get the `user-content-` prefix; `data-*` is dropped.
- `dangerouslySetInnerHTML` takes only server-rendered HTML, and only in `BlockView.tsx`: blocks
  from the pipeline above, and comment `html` from the same pipeline through the link hardener,
  without Shiki. Client code never sets `innerHTML`, `outerHTML` or `insertAdjacentHTML`.
- A doc shown as source never becomes HTML. The server turns it into Shiki tokens (raw text plus
  light and dark colors the contract checks as hex); the web renders each token as React text whose
  only style is `--shiki-light` and `--shiki-dark` from those colors. Its row is a `text/plain` doc
  that the content path never serves, also when its path ends in `.html`.
- Never serve agent-written HTML, JS or CSS on the app origin. HTML docs and their assets load
  only from `/content/<doc key>/…` with `Content-Security-Policy: sandbox allow-scripts; …` (plan,
  Global Constraints), in an iframe with `sandbox="allow-scripts"` and nothing else. Never add
  `allow-same-origin`, `allow-top-navigation`, `allow-popups` or `allow-forms`.
- The content path never reads cookies. Its key names one HTML doc of one revision, and it serves
  only that doc and the assets that doc lists.
- Frame messages: the parent accepts a message only when `event.source` is that frame's
  `contentWindow` and it parses with the contract's limits. A proposed anchor is shown to the
  reviewer and saved only by the reviewer. The parent posts only that doc's quotes into the
  frame, never comment bodies. A link to another doc arrives as `emend:navigate`; the parent opens
  only a doc of the same revision, in that doc's own section. No doc script runs, so only emend's
  own code can send. After a load the parent did not cause, the parent accepts nothing from the
  frame until it reloads it. `doc-navigation.md` adds `emend:goto` and `emend:position`.
- A doc's own scripts never run: no inline script, event handler, `javascript:` URL or script
  file. Only emend's bridge runs, allowed by its hash. WebRTC reaches the network and no CSP stops
  it, so never allow a doc's own script.
- Links: only `http:`, `https:` and `mailto:`, with `rel="noopener noreferrer nofollow"`. Relative
  links keep no `href`, except links between docs as `doc-navigation.md` defines them.
- Mermaid: one frame per diagram from `/mermaid-frame.html` (built from
  `apps/web/mermaid-frame.html` and `mermaid-frame.ts`), `sandbox="allow-scripts"`
  without `allow-same-origin`, a bundled and pinned Mermaid (never a CDN), `securityLevel:
  "strict"`, `startOnLoad: false`. The frame accepts messages only from its parent. A diagram is
  commented on as a whole block.
- Block ids are `<section>-<hash8>` over the normalized text. Never derive an id from position.
- Diff text renders as text through `@pierre/diffs`, never as HTML.
- App pages: `Content-Security-Policy: default-src 'self'; script-src 'self'; style-src 'self'
  'unsafe-inline'; img-src 'self' data: blob:; font-src 'self'; connect-src 'self'; frame-src
  'self'; worker-src 'self'; manifest-src 'self'; object-src 'none'; base-uri 'none'; form-action
  'self'; frame-ancestors 'none'`, `X-Frame-Options: DENY`, `X-Content-Type-Options: nosniff`,
  `Referrer-Policy: no-referrer`, `Cross-Origin-Opener-Policy: same-origin`.
- Content path: `Content-Security-Policy: sandbox allow-scripts; default-src 'none'; script-src
  'sha256-<bridge>'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self'
  data:; media-src 'self'; connect-src 'none'; form-action 'none'; frame-src 'none';
  frame-ancestors 'self'` on the doc, where `<bridge>` is the hash of the injected bridge script;
  asset and error responses use `script-src 'none'`. Plus `X-Content-Type-Options: nosniff`,
  `Referrer-Policy: no-referrer` and `Cache-Control: no-store`. The doc and error responses send
  `Cross-Origin-Resource-Policy: same-origin`; asset responses send `cross-origin` and
  `Access-Control-Allow-Origin: *`, because the frame's opaque origin makes every asset load
  cross-origin and every font a CORS request. `sandbox allow-scripts` is there for the bridge
  alone; `connect-src 'none'` keeps the bridge off the network.
- Mermaid frame: `default-src 'none'; script-src 'self'; style-src 'unsafe-inline'; img-src
  data:`, plus `X-Frame-Options: SAMEORIGIN` on that path only, so the app page can frame it.
- Never weaken the app CSP, `X-Frame-Options: DENY`, the content path's CSP or the frame
  sandbox. Any change to headers, sandbox attributes, the bridge or the sanitize schema needs
  `emend-security-reviewer`.
- Each renderer change adds hostile-input tests: `<script>`, `<img onerror>`, `javascript:`
  links, raw HTML in Markdown and the glossary, SVG, a Mermaid `click` directive.
