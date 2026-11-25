# API v1

The versioned API lives under `/api/v1`. `@recense/contract` exports its zod schemas and inferred
TypeScript types under the same names, with `CONTRACT_VERSION = 1`. It is a workspace package in
this repository and is not published to npm: never install an `@recense/*` package from the registry. All API timestamps are
ISO 8601 UTC strings (for example `2026-01-01T00:10:00.000Z`). Object schemas strip unknown
keys at every level. Additive fields stay in v1; breaking changes require `/api/v2`.

This is the v1 contract and endpoint inventory. Routes are implemented incrementally. Each later
task adds its request and response schemas to `packages/contract/src/api.ts` and documents them
here **before** writing the route. This includes `PublishRequest` (plan task 1.6), `InboxItem`,
`ReviewView`, `RevisionView`, `FileView` and `ThreadView` (plan task 1.9), and `ImportBundle`
(plan task 1.14).

## Credentials and headers

- CLI and MCP requests carry `Authorization: Bearer <token>`. Admin and agent tokens have separate
  scopes. A reviewer credential is accepted only from the session cookie, never as a bearer token.
- The CLI sends `X-Recense-Client: cli/<semver>` and, for hubs from before the rename, the same value
  as `X-Emend-Client`. The server reads `X-Recense-Client` first, then `X-Emend-Client`. The minimum
  supported client version is `0.1.0`; older clients receive `426 client_outdated`. Other header
  values are `400 invalid_request`.
- Before sending a bearer, the CLI authenticates the discovered server with public
  `GET /api/v1/capabilities` and `X-Recense-Challenge` (`SERVER_CHALLENGE_HEADER`; the CLI also sends the
  same value as `X-Emend-Challenge`, and the server reads either, the first name first). `ServerChallenge`
  is 32 fresh random bytes encoded as canonical unpadded base64url (43 characters). The server
  answers `X-Recense-Proof` (`SERVER_PROOF_HEADER`, schema `ServerProof`; the same value also goes out as
  `X-Emend-Proof`, and the CLI accepts either) with HMAC-SHA256 over the
  challenge's ASCII text, using the decoded 32-byte key stored in private `server.json`, encoded
  as canonical unpadded base64url. The CLI compares the digest in constant time. A missing,
  malformed or wrong proof prevents credential transmission. No challenge means no proof;
  a malformed challenge returns `400 invalid_request`. Capabilities remains public, and its
  proof reveals nothing about the key. Neither header carries a bearer or the server key.
- Browsers use `recense_session`, with `HttpOnly`, `SameSite=Strict`, `Path=/`,
  `Max-Age=2592000` (30 days), and `Secure` on HTTPS. Sessions renew at most once daily. A request
  that carries only a valid `emend_session` (the name before the rename) is authenticated too; its
  response sets `recense_session` with the same attributes and expires `emend_session`.
  With a configured public HTTPS origin, a GET or HEAD renews the cookie only on that origin's Host.
- JSON bodies use `Content-Type: application/json`. Routes reject bodies over their JSON byte
  limit with `413 too_large` before parsing, then validate with the contract schemas:
  `POST /api/v1/publish` and `POST /api/v1/import` permit at most `publishJsonBytes` (8388608 bytes); `POST /session` and
  `POST /machines` permit `publicJsonBytes` (4096 bytes); other JSON routes permit at most
  `requestJsonBytes` (1048576 bytes).
- Every request checks `Host` against `127.0.0.1:<port>`, `localhost:<port>`, `[::1]:<port>`, and
  the listener's actual concrete address, and the tailnet name only when configured with
  `--tailscale` (with `--tailscale-port <n>`, the name and that port, `<name>:<n>`), or the
  `--public-url` origin's host (with its port when not 443). Other hosts receive `403 bad_host`.
  Every non-GET/HEAD request with an Origin must name an allowed app origin. That Origin's host
  must equal the request's Host, including its port, compared in lowercase. An invalid Origin or
  a mismatch receives `403 bad_origin`. Outside `/content/`, a non-GET/HEAD request carrying a
  session cookie must carry that Origin; a missing or disallowed origin receives `403 bad_origin`.

Guards run in this order: Host, client version, Origin, declared Content-Length limit,
credential and scope, bounded body streaming, then handler and schema parsing. An unauthorized
request never reads its body. Every API response carries `Cache-Control: no-store`.
Unimplemented listed routes still enforce their scope before `404 not_found`. Unlisted API
paths require a credential before returning `404 not_found`. HEAD inherits the corresponding
GET route's scope unless it has an explicit endpoint entry. Every `/content/` response, including
errors, carries the content isolation headers described below.

Local discovery and the default pairing URL use the listener's numeric address, with IPv6
literals in brackets and wildcard listeners represented by their corresponding loopback address.
An explicit public origin still overrides the pairing URL. The raw HTTP Host guard runs before
the adapter, so malformed hosts receive the same `403 bad_host` JSON body and headers; adapter
request-construction failures receive `400 invalid_request` with the same response contract.

All API requests require credentials except capabilities, session creation and machine registration.
The content path uses its capability key and never reads cookies. The server binds
`127.0.0.1:3636` by default; only `--host` or `--tailscale` widens it. `--public-url` widens no
bind. There is no telemetry.

| Token kind | Scopes |
| --- | --- |
| `admin` | `pairings:create`, `devices:manage`, `server:stop` |
| `agent` | `publish`, `take`, `reply` |
| `reviewer` | `read`, `comment`, `send`, `pairings:create`, `devices:manage`, `settings:manage` |

`Scope` is the enum of all ten scope strings; `SCOPES_BY_KIND` is typed against it.

Only the reviewer session creates user comments, Sends and approvals. An agent reply cannot resolve
a thread or count as a Send. Every query filters the authenticated principal's `owner_id`.
A review id that is missing, belongs to another owner, or belongs to another instance for a machine
token returns the same `404 unknown_review`. Every other missing or foreign id returns
`404 not_found`. `403 forbidden` depends only on the principal's kind and scopes and is decided
before any id lookup. The origin instance comes from the agent token, never the request body;
a machine token reaches only reviews from its own instance.

## Endpoints

| Method | Path | Who | Purpose |
| --- | --- | --- | --- |
| GET | `/api/v1/capabilities` | Anyone | API version, app version and supported features. |
| POST | `/api/v1/server/stop` | Admin | Stop the server; return `ServerStopping = { stopping: true }` (202). No body or an empty `ServerStopRequest = {}`. |
| POST | `/api/v1/session` | Browser, no existing credential required | Exchange `SessionRequest` for a reviewer session (204); refuses machine pairings. |
| DELETE | `/api/v1/session` | Reviewer | End the current browser session. |
| POST | `/api/v1/pairings` | Admin, reviewer | Create from `PairingRequest`; return `PairingCreated` (201). |
| GET | `/api/v1/devices` | Admin, reviewer | Return `DeviceList` (200); live devices owned by the principal, newest first. |
| GET | `/api/v1/settings` | Reviewer | Return `SettingsView` (200); requires `read`. |
| GET | `/api/v1/sample` | Reviewer | Return `SampleView` (200); requires `read`. |
| GET | `/api/v1/themes` | Reviewer | Return `ThemeList` (200); requires `read`. |
| GET | `/api/v1/themes/:name/fonts/:file` | Reviewer | Return a font file named by a valid theme (200); requires `read`. |
| PATCH | `/api/v1/settings` | Reviewer | Apply `SettingsUpdate` and return `SettingsView` (200); requires `settings:manage`. |
| DELETE | `/api/v1/devices/:id` | Admin, reviewer | Revoke the device and every bound token atomically (204); missing, foreign or revoked is 404. |
| POST | `/api/v1/machines` | Anyone with a pairing secret or code | Register `MachineRegistration`; return `MachineRegistered` (201); refuses device pairings. |
| DELETE | `/api/v1/machines/self` | Agent | Revoke the current machine device and all its tokens (204); local agents get 404. |
| HEAD | `/api/v1/blobs/:sha256` | Agent | Check whether the owner's blob exists and is stored whole. |
| PUT | `/api/v1/blobs/:sha256` | Agent | Upload a blob; verify its size and hash. |
| POST | `/api/v1/publish` | Agent | Create a review or add a revision. |
| POST | `/api/v1/import` | Agent | Copy one `ImportBundle`; return `ImportResult` (201, or 200 when skipped); machine tokens only. |
| GET | `/api/v1/reviews` | Reviewer | List reviews in the inbox. |
| POST | `/api/v1/groups` | Reviewer | Create a named inbox group (201 `InboxGroup`). |
| PATCH | `/api/v1/groups/:id` | Reviewer | Rename an inbox group (200 `InboxGroup`). |
| DELETE | `/api/v1/groups/:id` | Reviewer | Delete a group, returning its items to their normal lists (204). |
| PUT | `/api/v1/reviews/:id/group` | Reviewer | Move a review or pub into a group, or remove it (204). |
| PUT | `/api/v1/reviews/:id/pin` | Reviewer | Pin or unpin a review or pub (204). |
| PUT | `/api/v1/reviews/:id/pin/place` | Reviewer | Move a pin directly before or after another pin (204). |
| GET | `/api/v1/agent/reviews` | Agent | List the token's own instance's reviews, newest first, as `AgentReviewList`; `?head=<sha>` keeps those whose approved or newest revision has that head; `?key=<key>` keeps the review with that stored review key. |
| GET | `/api/v1/reviews/:id` | Reviewer | Read a review. |
| GET | `/api/v1/reviews/:id/revisions/:seq` | Reviewer | Read one revision. |
| GET | `/api/v1/reviews/:id/revisions/:seq/download` | Reviewer | Download one offline HTML file, or a ZIP with docs selected by repeated `doc` parameters. Optional `comments=1` adds sent comments and replies; an HTML pub with comments downloads as a ZIP. Optional `diff=1` adds the code diff after the writeup. Optional `theme=dark`, `theme=light` or `theme=<name>` sets the look of files recense draws. |
| PUT | `/api/v1/reviews/:id/viewed` | Reviewer | Mark or unmark diff files as viewed; return 204. |
| GET | `/api/v1/files/:fileId/old` | Reviewer | Read the old file side. |
| GET | `/api/v1/files/:fileId/new` | Reviewer | Read the new file side. |
| GET, HEAD | `/api/v1/files/:fileId/old/image` | Reviewer | Read the old image side. |
| GET, HEAD | `/api/v1/files/:fileId/new/image` | Reviewer | Read the new image side. |
| GET | `/api/v1/media/:sha256` | Reviewer | Read a writeup or Markdown doc image by content hash. |
| GET | `/api/v1/events` | Reviewer | Subscribe to owner-wide review events using SSE. |
| GET | `/api/v1/reviews/:id/events` | Reviewer | Subscribe to review events using SSE. |
| POST | `/api/v1/reviews/:id/threads` | Reviewer | Create a thread and user comment. |
| POST | `/api/v1/threads/:id/comments` | Reviewer | Add a user comment to a thread. |
| PATCH | `/api/v1/comments/:id` | Reviewer | Edit an unsent user comment. |
| DELETE | `/api/v1/comments/:id` | Reviewer | Delete an unsent user comment. |
| POST | `/api/v1/threads/:id/resolve` | Reviewer | Resolve a thread. |
| POST | `/api/v1/threads/:id/reopen` | Reviewer | Reopen a thread. |
| POST | `/api/v1/reviews/:id/sends` | Reviewer | Send feedback or approve the revision on screen. |
| POST | `/api/v1/reviews/:id/snooze` | Reviewer | Move an open review to Snoozed (204); see "Snooze, retire, delete and the bin". |
| POST | `/api/v1/reviews/:id/unsnooze` | Reviewer | End a snooze (204). |
| POST | `/api/v1/reviews/:id/retire` | Reviewer | Mark an open review done without an approval (204). |
| POST | `/api/v1/reviews/:id/reopen` | Reviewer | Reopen a retired review (204). |
| DELETE | `/api/v1/reviews/:id` | Reviewer | Delete the review and its records for good (204), in the bin or not. |
| POST | `/api/v1/reviews/:id/bin` | Reviewer | Move the review to the bin (204); see "Snooze, retire, delete and the bin". |
| POST | `/api/v1/reviews/:id/restore` | Reviewer | Take the review out of the bin (204). |
| GET | `/api/v1/bin` | Reviewer | Page through binned reviews as `BinView` (200), with optional `beforeAt` and `beforeId` together. |
| DELETE | `/api/v1/bin` | Reviewer | Delete the confirmed bin if its version matches `EmptyBinRequest.version` (204). |
| DELETE | `/api/v1/bin/:id` | Reviewer | Delete a review for good only while it is still in the bin (204). |
| POST | `/api/v1/reviews/:id/take` | Agent | Claim a delivery with `{waitSeconds?: 0..25, maxBytes?: 65536..16777216, accepts?: ["closed"]}`. |
| POST | `/api/v1/deliveries/:id/confirm` | Agent | Confirm receipt of a claimed delivery. |
| POST | `/api/v1/comments/:id/reply` | Agent | Answer a comment with an outcome. |
| GET | `/content/:contentKey/*` | Holder of the key | Read isolated HTML docs and assets from a revision. The sole exception is `/content/sample/sample.html`: only the fixed synthetic sample doc, with the same look, bridge and headers; every other `/content/sample/` path is 404. |

Only an admin bearer with `server:stop` may call `/api/v1/server/stop`. The server sends its
202 response before shutting down through the same cleanup as SIGTERM and exiting 0. Repeated
requests while stopping return 202 without starting another shutdown. Capabilities advertises
`server-stop` only when a stop handler is available; otherwise the route returns `404 not_found`.

## Theme sample

`GET /api/v1/sample` requires a credential with scope `read` and returns
`SampleView = { revision: RevisionView, fileTexts: Record<UUID, { old: string, new: string }> }`.
Only GET (and its HEAD equivalent) is supported. The fixed synthetic content is rendered lazily
and a successful render is cached for the life of the process; a failed render is retried on the
next request. It is never stored, never enters the inbox, and has no mutation endpoints.
The browser displays it read-only at `/settings/sample`, using the non-UUID review id `theme-sample`.

`/content/sample/sample.html` serves the one synthetic HTML doc without reading cookies. It uses
the same look injection, optional `?theme=dark|light`, bridge, CSP and content headers as stored
HTML docs. Every other path under `/content/sample/` returns `404 not_found`.

The sample's fixed SVG is available through `/api/v1/media/<sha256>` for exactly the hash of its
bundled bytes, with the media route's restrictive headers. This exception accepts no uploaded SVG;
all other hashes retain the existing owner-filtered image lookup.

## Schemas

### Diff file sides

`GET /api/v1/files/:fileId/old` and `/new` return `200` with the stored bytes
unchanged, `Content-Type: text/plain; charset=utf-8`, the app response headers
(including `X-Content-Type-Options: nosniff`), `Cache-Control: no-store`, and
`Cross-Origin-Resource-Policy: same-origin`. Only role-`diff` files are served.
An unknown or foreign file, a doc or asset, a flagged file, or an absent side
(`hasOld`/`hasNew` false) returns `404 not_found`. A missing stored blob also
returns `404 not_found`. `HEAD` applies the same authorization and headers, with
no response body. File and blob lookups filter the authenticated owner's id;
the number of queries is bounded independently of revision size.

### Diff file images

A reviewer session can read the old or new image of a diff file by file UUID.
The old side uses the extension of `oldPath ?? path`, the new side that of `path`.
PNG, JPG/JPEG, GIF, WebP, AVIF and SVG map to `image/png`, `image/jpeg`, `image/gif`,
`image/webp`, `image/avif` and `image/svg+xml`, case-insensitively. An unknown, malformed
or foreign file id, another role, or an absent or oversized side gives `404 not_found`.
For a matching row, a binned, unmoved review gives `409 review_in_bin`. Next, an unsupported
extension gives `404 not_found`. For SVG, the server then checks `Sec-Fetch-Dest` and returns
`404 not_found` for any value other than `image`. Requests without the header can load SVG.
Raster images accept any destination. Missing blob bytes give `404 not_found`.

`GET` streams the stored bytes with that `Content-Type`, `Content-Length`,
`Cache-Control: no-store`, `Cross-Origin-Resource-Policy: same-origin` and
`X-Content-Type-Options: nosniff`. SVG responses carry `Content-Disposition: attachment`
so a direct navigation without a destination header downloads the file. Raster responses carry
`Content-Disposition: inline`. The image response replaces the app CSP with
`sandbox; default-src 'none'; style-src 'unsafe-inline'; img-src data:; font-src data:`
and retains the other app headers including `X-Frame-Options: DENY`. This disables SVG
scripts and event handlers even on direct navigation. `HEAD` returns the same status
and headers with an empty body. For sides within the size limit the CLI checks raster
signatures and accepts SVG only as valid UTF-8 with an SVG start tag and no NUL byte.
Symlinks, submodules and unrecognized sides cause the CLI to omit the image for the file.

### Writeup and Markdown doc media

`GET /api/v1/media/:sha256` serves one writeup or Markdown doc image. A parameter that is not 64
lowercase hex characters returns `404 not_found`. The server looks up one file of the
authenticated owner with `role` `asset`, `newBlob` equal to the hash and a
stored media type of `image/png`, `image/jpeg`, `image/gif`, `image/webp` or `image/avif`. No such
row, a diff side, an SVG, an asset listed only by HTML docs, a foreign owner's row, a
missing stored blob, or one whose size or bytes do not match its hash returns `404 not_found`
before any byte is sent.
The asset must have no parent doc, or a `doc_assets` row must link it to a `text/markdown` doc
of the same owner and revision. Every joined row is filtered by owner.
An image used only by reviews in the bin also returns `404 not_found`. Media is addressed by
hash and may be shared, so it never answers `review_in_bin`; another readable review using the
same image keeps it available, and Restore makes it available again. A moved local copy remains
readable even if it was binned before the move.
Otherwise it returns `200` with the stored bytes, `Content-Length`, `Content-Type` set to the
row's stored media type, `X-Content-Type-Options: nosniff`, `Cross-Origin-Resource-Policy: same-origin`,
`Cache-Control: no-store`, `Content-Disposition: inline` and
`Content-Security-Policy: sandbox; default-src 'none'`. That CSP replaces the app CSP on this
route only. `HEAD` applies the same authorization and headers, with no body.

An image keeps a source only when it names a declared media path of the same revision.
Publish refuses a writeup image whose path normalizes as below but is not listed; see
[Publish](#manifest-and-topics). A writeup image whose path the renderer refuses, and Markdown-doc
and comment images with any other source, are still dropped silently.
Remote writeup images are dropped too. A declared
path never contains a colon. The renderer drops any query or fragment, strips a leading `./`, percent-decodes, and refuses a
result with a `..` segment, a leading `/`, a scheme, a backslash, a control character or an
invalid or encoded-slash escape. A match becomes
`<span class="recense-media"><img src="/api/v1/media/<sha256>" alt loading="lazy" decoding="async" width height><span class="recense-media-caption">…</span></span>`;
the caption is the alt text, or the file name when the alt text is empty. `width` and `height` are
the image's displayed pixel size, read by the server from the stored bytes at publish (JPEG EXIF
orientation applied); they are absent when the server cannot read the size. The wrapper span also has
the class `recense-media-sized` exactly when the server sent `width` and `height`. On a declared media image,
author-written width and height are always dropped. A paragraph holding only
such images also has the class `recense-media-row`.
A paragraph with exactly two media spans gets `recense-media-row recense-media-pair` when their trimmed
alts match `^before\b` and `^after\b`, case-insensitively, in that order.
A paragraph with exactly three media spans whose trimmed alts match `^before\b`, `^after\b` and
`^diff\b`, case-insensitively, in that order, is a pair too. It also gets `recense-media-pair-diff`,
and its third span also gets `recense-media-diff`.
Only whitespace may precede or separate the images.
An optional effect follows the last image after a newline in leading text whitespace or a `br`.
Its content, including inline elements, goes in one `span.recense-media-effect` through the paragraph's end.
The span starts at the first non-whitespace content; preceding whitespace and breaks stay outside it.
Other text before the images or on the last image's line prevents a pair.
The effect wrapper changes neither text nor block ids. Author classes keep the `user-content-`
prefix, so they never match the generated classes. A block's id covers each image's alt text, path
and SHA-256, so a re-shot image at the same path shows as changed. Markdown docs render their listed
image assets with the same markup, resolved relative to the doc's folder. Remote images stay dropped.
Markdown docs get the same pair and effect markup because they share the renderer.

Only a writeup topic's Example turns labelled Before/After lines into aligned rows.
The paragraph gets `recense-example-rows`; each labelled line gets `recense-example-row`.
Its label through the colon gets `recense-example-label`, and its value gets `recense-example-value`.
Introductory lines get `recense-example-line`; unlabelled lines after a label continue its value.
Whitespace after a label stays in its value. Only separators before labelled lines stay between rows.
Paragraphs containing media spans keep their media markup. Text and block ids stay unchanged.

A top-level quote whose first child is a paragraph that starts with a GitHub alert marker
becomes a callout in the writeup, Markdown docs and comment HTML. The marker is `[!NOTE]`,
`[!TIP]`, `[!IMPORTANT]`, `[!WARNING]` or `[!CAUTION]`, in any case, alone on its line, and
non-whitespace text or an element other than a line break must follow it in the quote. The
`blockquote` gets `recense-callout recense-callout-<type>`, and the marker's own text goes in
`span.recense-callout-marker`. A line break that ends the marker line gets
`recense-callout-marker-break`, and a first paragraph that holds only the marker gets
`recense-callout-marker-line`. The app hides these and draws the type's label; the label is not
text. Glossary terms and example rows skip the marker. A quote inside another element, or one
that holds a Mermaid diagram or chart block, stays a plain quote. Text and block ids stay unchanged.

### Charts

A `chart` fence in a writeup or Markdown doc holds a JSON object of up to 4000 characters.

```chart
{
  "type": "bar",
  "title": "Search time",
  "unit": "ms",
  "labels": ["Cold start", "Warm cache"],
  "series": [
    { "name": "Before", "values": [420, 95] },
    { "name": "After", "values": [180, 40] }
  ]
}
```

`type` is `bar`, `line` or `sparkline`.
`labels` holds 1 to 12 labels for bars and 2 to 24 for lines.
A sparkline holds 2 to 60 values per series and may omit its labels.
`series` holds 1 to 4 objects with distinct names.
Each series has a `name` and an array of numeric `values` from 0 through 1,000,000,000,000.
All series have the same length and one value per label when labels are present.
Labels and series names have up to 32 characters.
The optional `title` has up to 80 characters and the optional `unit` up to 8.
Each text field must contain a non-whitespace character.
Unknown keys are refused, including keys on a series.
An invalid spec stays a code block showing its source.
The app draws the SVG with React elements and treats spec text as text throughout.
Colours come from the app. The spec has no colour field.
Comment HTML displays chart fences as code.

### Downloads

`GET /api/v1/reviews/:id/revisions/:seq/download` requires a reviewer session with `read` scope.
A bearer token gets `403`, like other reviewer routes. Missing credentials get `401`.
It follows the revision route's `404` and `review_in_bin` rules.
`HEAD` checks the same access and revision rules and returns the download headers without
building a file or reading blobs. It never waits for a download slot.
One download builds at a time per owner in this server process. Up to two more requests wait
in order. A further request gets `429 rate_limited` with the `download_busy` message:
"A download is already building. Try again when it finishes."
The slot is released after success or failure.

Optional repeated `doc` query parameters select up to 50 distinct UUID file ids from this
revision's `RevisionView.files` rows with role `doc`. Invalid UUIDs, duplicates or more than
50 ids get `400 invalid_request`, before waiting for a slot. A missing id, another owner's id,
another revision's id or a non-doc id gets `404 not_found`. `HEAD` checks the ids too and returns
ZIP headers when docs are selected, without reading blobs or building the archive.
Rendered and source views of one path have distinct file ids. A source doc's file row has
`view: "source"`; a rendered doc's row has no `view`.

An optional `comments=1` query parameter adds comments and replies (see below). Any other
value or a repeat gets `400 invalid_request`, before waiting for a slot, also on `HEAD`.
An HTML pub with `comments=1` downloads as a ZIP, even with no docs selected. `HEAD` returns
the same headers, using only the revision and doc metadata to identify the base doc.

An optional `diff=1` query parameter adds the code diff after the writeup in the base file.
Any other value or a repeat gets `400 invalid_request` before waiting for a slot, also on `HEAD`.
It changes no headers, filename or ZIP decision. The choice is off by default.

An optional `theme=dark`, `theme=light` or `theme=<name>` query parameter sets the look of the files recense
draws: the writeup, Markdown docs, docs shown as source, the comments file and the omitted-content
note page. Without it, they follow the reader's colour scheme. A custom HTML page keeps its own
look. An HTML page in recense's look downloads with recense's stylesheet and its default fonts.
`theme=dark|light` fixes its mode; a theme name fixes its base mode and adds its colours.
A light-only page stays light and takes a theme's colours only from a light-base theme.
Without `theme`, the page follows the reader's mode. For the files recense draws, a theme name uses
that theme’s resolved colours, including syntax colours for code blocks and docs shown as source;
fonts stay unchanged. Revisions published before #136 keep their stored GitHub code colours.
An invalid value, a repeat, or a missing or refused theme gets `400 invalid_request` before waiting
for a slot, also on `HEAD`.
It changes no headers, filename or ZIP decision.

A code review's file holds the review title and that revision's writeup: sections, topics, text,
code blocks and images with captions. The base file holds no docs, no diff unless `diff=1` is set,
and no comments unless `comments=1` is set. A revision
is a pub when `writeupEmpty` is true and `base` is null. A pub's base file holds one doc:
the first doc row in file order whose path equals `main`, else the first doc row. The order
includes both rendered and source views of a path. Markdown uses its stored rendered
blocks and builds in its listed images like writeup images. Source uses its stored highlighted
tokens. Code reviews and Markdown and source pubs get the recense header with the review title,
project, branch and publish links. An HTML pub keeps
the agent's HTML layout, with no recense header. Its listed assets are built in after filtering.
Mermaid diagrams and charts show as labelled source text. Links to other docs become plain text.
Absolute HTTP, HTTPS and mailto links keep working on `a` and `area` elements.
Only SVG `image` and `feImage` hrefs follow the resource rules. Other elements, including SVG
`use` and MathML elements, keep only same-document fragments in hrefs. These rules also apply
to `xlink:href`. SMIL `set`, `animate`, `animateMotion` and `animateTransform` elements targeting
an href are removed.

The response is `200` with `Content-Type: text/html; charset=utf-8`,
`Content-Disposition: attachment; filename="<name>"`, `X-Content-Type-Options: nosniff`,
`Cache-Control: no-store` and `Cross-Origin-Resource-Policy: same-origin`.
The filename is the lowercase title, with runs outside `[a-z0-9]` replaced by `-`, trimmed,
cut to 60 characters and trimmed again. An empty name becomes `recense`. It ends in `-r<seq>.html`.
`Content-Security-Policy: sandbox; default-src 'none'; img-src data:; style-src 'unsafe-inline'; font-src data:; media-src data:; base-uri 'none'; form-action 'none'`
replaces the app CSP for this route. Every file starts with a UTF-8 byte order mark.
The file also has a CSP meta with the same policy without `sandbox`.
It opens offline with no scripts or network requests.

With no `doc` parameter, the response is a single HTML file unless it is an HTML pub with
`comments=1`. With any docs selected, or with comments on an HTML pub, the
response is `application/zip`, with attachment filename `<slug>-r<seq>.zip` and the same CSP,
nosniff, no-store and same-origin headers. The ZIP starts with the base file at the root under
its single-download name. For an HTML pub with `comments=1`, `comments.html` follows at the
root. Selected docs follow under `docs/`, in revision file order (`ord`, then `id`). Each doc
is an offline HTML file using the same rendering and filtering rules.
Markdown and source docs get their title or path and the base file's project, branch, revision
and publication time; publish links stay in the base file. Missing or invalid Markdown rendering
shows empty content. Missing or invalid source rendering says "This file could not be shown."
A missing HTML doc blob gets `404 not_found`.

With `comments=1`, each file shows the threads of this review at their place, with their replies.
Only threads made on this revision or an earlier one are included. Later replies on those
threads stay. Only sent reviewer comments and all agent replies are included. A thread with no
comment left is left out. Unsent comments never reach the file. Each thread shows its state (Open, Sent,
Answered or Resolved), the quoted text or the diff lines it was made on, and its comments,
labelled "Reviewer" or "Agent", with an agent's outcome and the time in UTC. Comment bodies
are shown as recense renders them in the app and pass the same filtering as the rest of the file:
scripts, styles, frames, event handlers and remote images are removed. An image in a comment
that cannot be shown leaves its alt text. A body that cannot be rendered shows as plain text.
A body with no text or image after filtering also shows as escaped plain text.
No thread id, comment id or address is in the file.
For a copied review, each file that shows a thread card has a note before its threads:
"This review was copied from another machine on YYYY-MM-DD HH:MM UTC. Comments, Sends and
approvals before then were made there." No machine name, host or id is included.
A thread shows once, in the first file that holds its doc (the base file first). HTML docs never
hold comments. Their threads go to the "Other comments" list, with the path and quote.
For an HTML pub, `comments.html` holds whole-review threads and "Other comments". It has
the review title followed by " — comments", the same meta line and no publish links.
With no sent comments it says "No sent comments." When all comments are in selected doc files,
it says "The comments are in the doc files of this download."
Where a thread goes, by its placement on this revision:

- Whole-review threads: a list at the top of the base file, or in `comments.html` for an HTML pub.
- Topic threads: in the topic's section of a code review's writeup.
- Writeup threads: right after their block in the writeup.
- Markdown doc threads: right after their block, in the file of that doc when it is selected
  (or is the pub's base doc).
- Source doc threads: after their last line, in the file of that doc when it is selected (or
  is the pub's base doc).
- Threads placed on a doc in the download whose block or line cannot be found in that file:
  an "Other comments" list at the end of that doc's own file.
- With `diff=1`, diff threads matched to a unique file: whole-file threads after its header;
  line threads after their end line on the old or new side. With `comments=1`, the diff also
  shows each placed line comment's lines with up to three lines around them, like the app,
  so the card follows its end line. Threads whose lines cannot be shown, or on a file whose
  body is not shown, follow that file's body with their path and lines.
- Everything else, including diff threads without `diff=1` or without a unique file match,
  threads that have no place on this revision (with the
  reason and the revision they were made on), and threads whose file is not in the
  download: an "Other comments" list at the end of the base file, or in `comments.html` for an
  HTML pub, with the path and lines.

A selected Markdown or source doc replaced by the left-out page keeps its threads after the
note, in a "Comments on this doc" list with where labels. Each thread card counts its final UTF-8
bytes against a separate 32 MiB comment budget shared by all files of a download. Built-in images
inside comments also count against the 128 MiB budget. A card that does not fit is replaced by a
line saying a comment thread was left out, and the size note shows.
Without `diff=1` the diff is never in the download. A pub ignores `diff=1`.

The code diff groups files by topic in ascending importance order, stable for equal importance.
Files within a topic follow file order (`ord`, then `id`). Empty topics are omitted. Files with
no topic or an unknown topic go under "Other changes", always last. Each file shows its path
(old → new for a rename), its status (Added, Modified, Deleted, Renamed or Mode changed) and
`+A −D` counts from the shown hunks, or stored counts when both exist and the body is not shown.
Hunks are unified plain text with old and new line numbers and four context lines, like the app.
Code, including HTML and scripts, is escaped text. The same offline CSP and no-script rules apply.
Within diff lines, carriage returns (except one trailing CR), U+2028, U+2029 and bidi controls
(U+061C, U+200E, U+200F, U+202A–U+202E, U+2066–U+2069) show as `[U+XXXX]`.
Binary files say "Binary file. Its changes are not shown." Oversized files say "This file is too
large to show." Lock files say "Lock file. Its changes are left out." Missing blobs say "This file
could not be shown." Identical text says "No changes to the text."

At most 100,000 diff hunk lines are shown per download, including no-newline markers. The worker
stops mapping hunks as soon as their total line count passes the remaining allowance. Diff markup
has a separate 32 MiB output budget: the exact final UTF-8 bytes of the hunk `pre` elements,
excluding thread cards. This budget is shared by all diff files and is separate from the 128 MiB
built-in content budget and the 32 MiB comment budget. A file that does not fit either the line
or diff output budget and all later text files are omitted rather than partly shown.

Diff blob reads share the 128 MiB read budget below and are charged on each read attempt by
stored size, including a read that fails verification, without caching. Computing hunks runs in
a worker with a per-job timeout. A shared 20-second budget is checked before each read and before
each computation; reads are not interrupted, and a running computation is cut off at the remaining
budget. A file that passes a line, diff output, read or processing limit, or whose worker fails,
says "Left out because it passed a size or processing limit." The top left-out note also shows.

Doc entry names use the doc path split on `/`. Each segment replaces runs outside `[A-Za-z0-9._-]`
with `-`, strips leading dots, trims trailing dots and hyphens, cuts to 80 characters and trims
again. An empty segment becomes `_`. If the stem before its first dot is `CON`, `PRN`, `AUX`,
`NUL`, `COM0`–`COM9` or `LPT0`–`LPT9`, ignoring case, it gains `_`, for folders and files alike.
The last segment gains `.html` unless it already ends in
`.html`, ignoring case. Name and folder conflicts are compared without case; suffixes `-2`,
`-3`, and so on before `.html` disambiguate them. Ordinary folders may be shared. If a folder
would replace an earlier file, suffix that folder segment too. Names are ASCII, relative, and
contain no backslash, empty, `.` or `..` segment. Links between the files stay plain text.

At most 128 MiB of built-in content is emitted. Every copy of a data URL and every inlined CSS
text counts its final UTF-8 bytes each time it is emitted. The server also reads at most
128 MiB of stored assets, selected doc bodies (HTML blobs and Markdown/source rendered blobs),
and diff blobs when selected.
It checks their stored sizes before reading them and charges each read attempt by stored size,
including a read that fails verification. Assets are cached and charged once; selected doc bodies
are charged on each read and released after building their file.
Both budgets are shared by all files in a ZIP. Each later builder's emitted budget is reduced
by the full UTF-8 size of every file already built. A selected doc that does not fit the remaining
read budget, or comes after the emitted budget is spent, is left unread. Its file is a page with
the title, reading styles and only the left-out note in its body. Without the diff, the base file's
read paths stay unchanged. Each ZIP entry is compressed before building the next file.
At most 64 stylesheet occurrences are inlined per file, across imports and stylesheet links. Repeated
paths count each time and keep their own conditions. Imports stop at depth 4 and never repeat
a path in the same chain. All files of a download share one 64 MiB CSS work budget. Each rewrite charges its input
bytes. The final output check charges the written bytes too, with imports joined in.
Dropped output does not refund spent work. When that budget is spent,
remaining styles, style attributes and stylesheets are left out.
HTML parsing stops at nesting depth 512 or 200,000 elements. An over-limit Markdown or writeup
block is left out. An over-limit HTML doc becomes a page with the title, reading styles and
only the note in its body. When any size or processing limit omits content, one visible note says:
"Some content was left out of this download because it passed a size or processing limit."
The server yields between steps while building, including CSS, element walks, references and
base64 chunks. The final HTML serialization runs in one step.

The file holds no server address, recense link, sign-in link, token or machine name.
HTML docs lose scripts, event handlers, frames, embeds, `<base>`, `<noscript>`, `<meta http-equiv>`
and unlisted resource references. Forms are unwrapped, keeping their content.
Listed image, audio, video and font assets and `text/vtt` captions may be built in.
CSS assets are used only as stylesheets. Other asset media types are left out.
Writeup and Markdown images allow only PNG, JPEG, GIF, WebP and AVIF.
Author data URLs for images, audio, video and VTT captions may stay in resource attributes.
CSS may retain data URLs and local fragments. Asset references keep their fragments.
SVG presentation and animation attributes that reference anything but a fragment are removed.
CSS is read with a CSS Syntax Level 3 tokenizer. Escaped names count as their decoded spelling.
Written CSS never holds an `&` that could start a character reference.
Written CSS is tokenized again and checked once, after imports and HTML escaping.
CSS that still holds a resource reference other
than a data URL or a fragment is left out with the note. The file's CSP blocks any network load
in any case.
An `@import` prelude is limited to 64 tokens and 4 KiB of source. Longer imports are left out.
An invalid `@import … {…}` rule is dropped together with its block.
Inlined imports keep their layer, supports and media conditions. Alternate and disabled
stylesheets are left out. `@charset` is removed. A top-level stylesheet `@namespace` prelude
is kept; its URL is not fetched. It ends at `;`, `{` or `}` outside nested brackets and functions.
Inside blocks and style attributes, its references are rewritten.
Unfinished strings and comments are closed before joining sheets. Imports with unfinished
or invalid strings or URLs in their prelude are left out.
A nested `image-set()` becomes `none`. Image functions containing `var()`, `env()` or `attr()`
at any depth also become `none`.

### Viewed files

`PUT /api/v1/reviews/:id/viewed` accepts `ViewedRequest = { revision, paths, viewed }` and returns
204. Only a reviewer session may call it, using the same `comment` scope as user comments.
Agent and admin bearers receive `403 forbidden`; a reviewer credential used as a bearer is
refused with `401 unauthorized`. Cookie writes require the allowed Origin as usual.

`revision` is a positive safe integer sequence belonging to this review, including an older
revision. `paths` contains 1 through `filesPerRevision` (10000) validated `FilePath` values;
the normal `requestJsonBytes` (1048576 bytes) body limit also applies. Duplicate paths are
applied once. A missing or foreign review gives `404 unknown_review`, and a revision absent
from that review gives `404 not_found`. A path not in that revision's diff files gives
`400 invalid_request`, like invalid targets when creating comments; the entire batch is refused.
Invalid bodies give `400 invalid_request`; oversized bodies give `413 too_large` before parsing.
As with comment writes, a moved review gives `409 review_moved`.

Marking upserts the owner's mark for each review/path with that revision's old/new blob pair
and sequence. Unmarking deletes it. For tracked text files, matching blob pairs and rename
sources (`oldPath`) stay viewed across revisions; a different pair or rename source is stale
and does not count as viewed. If either the marked revision's file or the shown file is flagged
binary or oversized, content is not fully tracked:
the mark is viewed only on the sequence where it was made, and stale on every other sequence,
even with equal or null blob pairs. An absent side of an unflagged added/deleted text file is
not untracked content and still uses the blob-pair rule. The stale indicator says “changed”
and identifies the revision where it was viewed, without claiming when it changed.
Viewed marks are reviewer state and are excluded from export and import. A successful PUT
emits `viewed` with `{ reviewId }` only on the owner's event bus after the transaction commits.
Clients batch invalidation of that review's revision queries through the existing live event
stream, including other tabs and devices. Only revision fetches write the revision cache.
The initiating page overlays pending marks and successful writes until a fetch that started
after the write settled resolves. Each settled write requests a refresh through the same
batch as events. Errors drop their optimistic entry immediately and remain visible until
dismissed or their affected paths are successfully marked again. Revision queries retain
their normal focus behavior; no unconditional focus refetch is required.

### Settings

`ApprovedActiveHours` is an integer from 0 to `MAX_APPROVED_ACTIVE_HOURS` (720).
`ApprovedActiveLimit` is an integer from 0 to `MAX_APPROVED_ACTIVE_LIMIT` (200, the Active list's cap).
`SettingSource = "default" | "file" | "override"`.
`HoursSetting = { value: ApprovedActiveHours, source: SettingSource, default: ApprovedActiveHours,
file: ApprovedActiveHours | null, override: ApprovedActiveHours | null, fileError: boolean }`.
`LimitSetting` has the same shape as `HoursSetting`, with `ApprovedActiveLimit` values.
`KeyBinding = ShortcutKey | null`; null turns a shortcut off.
`KeySetting = { value: KeyBinding, source: SettingSource, default: ShortcutKey, file?: KeyBinding,
override?: KeyBinding, fileError: boolean, clashWith: ShortcutCommand | null }`.
`KeysSetting = { commands: Record<ShortcutCommand, KeySetting>, fileError: boolean }`; every command is present.
`SettingsView = { approvedActiveHours: HoursSetting, approvedActiveLimit: LimitSetting,
keys: KeysSetting, serverTime: string }`. `serverTime` is the server's clock (ISO 8601) when it
answered; a client compares it with `InboxList.serverTime` to tell which window and cap are newer.
`SettingsUpdate = { approvedActiveHours?: ApprovedActiveHours | null, approvedActiveLimit?: ApprovedActiveLimit | null,
keys?: Partial<Record<ShortcutCommand, { key: KeyBinding } | null>> }` is strict, including each
`{ key }` object; extra keys, unknown commands and non-normalized keys are refused (400).
An empty update is accepted. Omitted settings stay unchanged. Updates to all settings share one transaction.

The effective `value` uses the owner's database override, then the config file, then
`APPROVED_ACTIVE_HOURS` (12) for the window and `APPROVED_ACTIVE_LIMIT` (5) for the cap.
The file keys are `approvedActiveHours` and `approvedActiveLimit`. Zero hours moves an approved
review out of Active at once; a cap of 0 shows no approved review in Active.
PATCH stores an override on this server; null clears it. Only a reviewer session can change it.
Each server reads its own global config file on every settings or review read. It never writes
or migrates that file. `file` is its usable value, or null when absent or invalid.
`fileError` is true when the file cannot be read, is not a JSON object, or contains an unusable
`approvedActiveHours` or `approvedActiveLimit` value. Each numeric setting has its own `fileError`;
an unreadable or non-object file sets every `fileError`. An invalid file does not prevent the
default or override from working.
A missing file or absent key is not an error. `docRoots` and `openBrowser` are not settings in this API.

`ShortcutKey` is a normalized string: one lowercase ASCII letter, one ASCII digit, one printable
ASCII punctuation character (0x21–0x7E excluding letters and digits), `shift+`, `mod+` or
`mod+shift+` followed by one lowercase ASCII letter, or `alt+` or `mod+` followed by one ASCII digit.
`mod` means Ctrl, or ⌘ on a Mac; a client accepts either one, but not both together.
`alt` means Alt (⌥ Option on a Mac), and a client matches `alt+` and `mod+` digit keys by the
physical digit-row key, so Option symbols on a Mac and layouts where digits need Shift still match.
Spaces, named keys (including Escape, Tab, Enter, arrows, PageUp/PageDown, Home, End and F-keys),
spelled-out `ctrl+`, `cmd+` and `meta+` modifiers, `shift+` before a non-letter, `mod+` before
anything but a letter or digit, `alt+` before anything but a digit, and `alt+` combined with
another modifier are refused. The config file alone also accepts uppercase letters (`A` becomes
`shift+a`), case-insensitive shift-letter combinations (`SHIFT+A` becomes `shift+a`) and
case-insensitive mod and alt forms (`Mod+K` becomes `mod+k`, `MOD+SHIFT+P` becomes `mod+shift+p`,
`Alt+1` becomes `alt+1` and `Mod+1` becomes `mod+1`). Shift must be spelled out for mod bindings with letters.
`inbox.jump1` to `inbox.jump10` open the first to tenth row the client numbers: the rows of every
open inbox section from the top, an item shown twice counted once.
When no level sets `inbox.jump10`, it follows the highest level (override, then file) that sets
all of `inbox.jump1` to `inbox.jump9` as one group: all off or `mod+1` to `mod+9` set
`inbox.jump10` off at that level, and `alt+1` to `alt+9` leave it at its default `alt+0`, which
loses a clash to any saved or file key. A level with an incomplete or mixed set decides nothing.
An unusable `inbox.jump10` file entry counts as absent. The filled off value appears in that
level's `override` or `file` field.

The global config file format is `"keys": { "<command>": "<key>" | null }`. It is read once
alongside `approvedActiveHours` and `approvedActiveLimit`. An absent `file` or `override` in a
`KeySetting` means that
source sets nothing usable; a present null explicitly turns the command off. An unusable file
entry is ignored and sets that command's `fileError`. `keys.fileError` is true if the file
cannot be read, is not a JSON object, its `keys` is present but not a plain object, or it names
an unknown command. Unknown entries are ignored; other usable entries still apply. A missing
file or absent `keys` is not an error.

PATCH `keys` merges commands into one stored object per owner: `{ key: "j" }` stores an override,
`{ key: null }` stores off, and null removes the override. Unmentioned commands stay unchanged;
removing the last override deletes the stored row. Corrupt stored objects and invalid or unknown
entries are ignored. Only a reviewer session can PATCH keys. The `readSettings` path
reads the approval window and the approval cap on review reads, still without querying shortcut overrides.

`ShortcutCommand` and `SHORTCUT_DEFAULTS` use this order:

| Command | Default key |
| --- | --- |
| `inbox.next` | `j` |
| `inbox.previous` | `k` |
| `inbox.filter` | `f` |
| `inbox.search` | `/` |
| `inbox.back` | `u` |
| `inbox.jump1` | `alt+1` |
| `inbox.jump2` | `alt+2` |
| `inbox.jump3` | `alt+3` |
| `inbox.jump4` | `alt+4` |
| `inbox.jump5` | `alt+5` |
| `inbox.jump6` | `alt+6` |
| `inbox.jump7` | `alt+7` |
| `inbox.jump8` | `alt+8` |
| `inbox.jump9` | `alt+9` |
| `inbox.jump10` | `alt+0` |
| `tab.writeup` | `1` |
| `tab.files` | `2` |
| `tab.docs` | `3` |
| `tab.comments` | `4` |
| `tab.diff` | `5` |
| `file.next` | `n` |
| `file.previous` | `p` |
| `file.toggleViewed` | `v` |
| `thread.next` | `.` |
| `thread.previous` | `,` |
| `review.instructions` | `s` |
| `review.approve` | `shift+a` |
| `review.snooze` | `z` |
| `review.pin` | `shift+p` |
| `shortcuts.show` | `?` |
| `palette.open` | `mod+shift+p` |

Each command tries its override (level 2), file entry (level 1), then default (level 0), skipping
absent candidates. Off never clashes. For each group holding the same non-null key, the highest
level wins over lower levels: each lower command advances and records `clashWith` as the first
command at the highest level in the order above. If multiple commands tie at the highest level,
all of them advance too, each recording the first other command at that level. Repeat until
keys are unique. A command losing its default ends off with source `default`. Otherwise `value`
and `source` name its final candidate. `clashWith` records the last clash, or null if there was
none; `default`, `file`, `override` and `fileError` describe the inputs even after a clash.

### Themes

`GET /api/v1/themes` requires a reviewer session with `read` scope. It reads the `themes` folder
beside the global `config.json`, without a repository check, like the server's reads of `keys`
and `approvedActiveHours`. The CLI commands `recense theme list`, `copy` and `check` refuse a folder
whose path, real path or any symlink hop lies inside a repository holding the working directory,
with the same home-rooted dotfiles exception as `recense config`.
There is one running read and at most one queued read per folder and per theme;
each caller gets a read that started after its request. Settled results are not cached.
Each theme is `<configDir>/themes/<name>/theme.json`. The folder name is the theme name.
Names match `/^[a-z0-9](?:[a-z0-9-]{0,38}[a-z0-9])?$/` and cannot be `system`,
`dark`, `light` or `fonts`. The shared `fonts` entry, top-level files and dot entries are skipped. A symlink counts only when it points
to a folder; links to files, dangling links and link loops are skipped like top-level files.
Invalid names are refused if the displayed name is
1–80 characters with no Unicode control or format characters (`\p{C}`); otherwise they are skipped.
At most 50 themes are listed, sorted by name. Each `theme.json` is at most 32 KiB. Folder enumeration uses
`opendir` with its default buffer size and caps processing at 1000 entries, counting skipped entries too, with one overflow
probe. A folder with more than 1000 entries returns an empty list and `folderError: true`.

`recense theme copy <source> <name>` copies `dark`, `light` or a valid custom theme.
It creates `themes/` if missing and a new `<name>/` folder, both with mode `0700`.
An existing destination folder or file refuses with one stderr line naming the theme and nothing written.
It writes `theme.json` with flag `wx` and mode `0600`, then prints `recense: wrote <escaped path of theme.json>`.
If writing fails, it removes the `theme.json` it created and then its own folder when empty, and reports the error.
A failure creating the `themes` folder reports `cannot write theme <path>`, with the escaped path of `theme.json`.

A file is a JSON object with `version: 1`, `base: "dark" | "light"` and optional `density`, `fonts`, `scales`
and `tokens`. Other keys are refused. For example:

```json
{
  "version": 1,
  "base": "dark",
  "density": "regular",
  "fonts": { "text": "Geist", "code": "JetBrains Mono" },
  "scales": { "n-950": "oklch(0.18 0.004 260)" },
  "tokens": { "bg-reading": "n-950" }
}
```

`density` accepts `"compact"`, `"regular"` or `"roomy"`, with `"regular"` as the default.
It scales app spacing (padding, gaps and row heights), never text size; on touch screens compact
keeps regular spacing so tap targets never shrink. HTML doc contents inside sandboxed frames keep
their own spacing. `recense theme copy` always writes the source density, or `"regular"` when absent.

`scales` accepts every neutral, ochre, green, blue, violet, teal and red scale step, and the
16 origin tints, in `THEME_SCALE_STEPS`. `tokens` accepts every semantic colour in `THEME_TOKENS`,
including `focus-color`. Names are the CSS custom properties without `--`. A scale value is a
colour. A token value is a colour or a scale step name, never another token name. Omitted values
come from the base. Changing a scale step recolours tokens built on it unless a token sets a colour.

Colours accept hex `#rgb`, `#rgba`, `#rrggbb`, `#rrggbbaa` in either case, or `oklch(L C H)` with
optional ` / A` before `)`. Components are separated by whitespace. L is 0–1 or 0%–100%; C is
0–0.5; H is finite, optionally followed by `deg`, and wraps to 0–360; A is 0–1 or 0%–100%.
Numbers are plain decimals, with no exponent or sign except a minus on H. Inputs are at most
64 characters. Names, other colour functions, URLs, CSS expressions, comments and quotes are refused.
`ThemeColor` accepts only the normalized output: lowercase six- or eight-digit hex, or oklch
with single spaces, numbers rounded to at most six decimals, no trailing zeros, a leading zero
before the point, hue below 360 and alpha omitted when 1.

`fonts` accepts optional `text` and `code` names matching
`/^[\p{L}\p{N}](?:[\p{L}\p{N} _-]{0,62}[\p{L}\p{N}])?$/u`, and an optional `files` list. CSS is not accepted.
The named family precedes recense's default stack. When the theme names files for that font, the
faces from those files precede recense's default stack instead and the name is not used.
`DEFAULT_THEME_FONTS` is
`{ text: "Geist", code: "JetBrains Mono" }`.
The other built-in families, Inter, Roboto, Atkinson Hyperlegible Next, Geist Mono, Roboto Mono
and Fira Code, load from the app's own origin only when a theme names them.
Built-in names use recense's copy even when that font is installed.
The built-in files cover Latin and most Latin Extended letters in upright text.
Italic files cover basic Latin and Latin-1 only.
Most Vietnamese letters with tone marks and other scripts fall back to a system font.

Font files live directly in `<configDir>/themes/fonts/`, shared by all themes. For example:

```json
"fonts": {
  "text": "Literata",
  "code": "Iosevka",
  "files": [
    { "font": "text", "file": "Literata-Variable.woff2", "weight": [200, 900] },
    { "font": "text", "file": "Literata-Italic-Variable.woff2", "weight": [200, 900], "style": "italic" },
    { "font": "code", "file": "Iosevka-Regular.woff2" },
    { "font": "code", "file": "Iosevka-Bold.woff2", "weight": 700 }
  ]
}
```

`files` holds at most `LIMITS.themeFontFiles` (16) entries. Each entry has `font: "text" | "code"`
and a `file` name; its corresponding family must be set in `fonts.text` or `fonts.code`.
`ThemeFontFileName` accepts at most 100 characters matching
`/^[A-Za-z0-9][A-Za-z0-9._-]*\.(?:woff2|woff|ttf|otf)$/i`, with no `..` anywhere and no trailing
control characters. No subfolders, slashes, backslashes or leading dot are allowed.
Optional `weight` is an integer from 1 to 1000 or two such integers `[min, max]`, lowest first,
for a variable font. Its default is 400. Optional `style` is `"normal"` (the default) or `"italic"`.
Unknown entry keys in `theme.json` refuse the theme. The API's `ThemeFontFile` schema strips
unknown keys in responses so additive fields stay in v1.
`recense theme copy` keeps the source's `files` list unchanged.

`GET /api/v1/themes/:name/fonts/:file` requires a reviewer session with `read` scope, like the
list route. Without a valid credential it answers `401 unauthorized`; agent and admin bearers
receive `403 forbidden`, and a reviewer credential used as a bearer is refused with
`401 unauthorized`.
The theme name and file name must pass their contract schemas, the theme must be valid, and its
`fonts.files` must name the file exactly.
A file is at most `LIMITS.themeFontBytes` (4194304 bytes, 4 MiB) and must be a regular file
directly inside the real `fonts` folder. The folder itself may be a symlink; a file link may
point to another file directly in that same real folder, but never outside it or into a subfolder.
The reader checks the opened file's identity and bounds the read. Missing or refused files and
invalid, unknown or unreferencing themes all return 404 without disclosing the reason.
Success sends a server-chosen `Content-Type` (`font/woff2`, `font/woff`, `font/ttf` or `font/otf`,
using the lowercased extension), `X-Content-Type-Options: nosniff`, `Cache-Control: no-store`,
`Cross-Origin-Resource-Policy: same-origin`, `Content-Security-Policy: sandbox; default-src 'none'`
and `Content-Length`. HEAD sends the same headers without the body.
The app CSP stays unchanged: `font-src 'self'`. The browser registers the picked theme's files
with `FontFace` under the aliases `_recense-theme-text` and `_recense-theme-code`, using
`display: "swap"`; missing or refused files fall back to recense's fonts.
The Download continues to use system fonts.

For a valid theme, `recense theme check <name>` checks each distinct font file. With no problems it
prints `recense: <name> is valid` and exits 0. Otherwise it prints one escaped
`recense: <name>: font file <file> <reason>; the theme uses recense's font instead.` line per file
and exits 1, without the valid line. The reasons are `is missing`,
`is not a regular file directly in the fonts folder`, `is larger than 4 MiB` and `cannot be read`.
`recense theme list` continues to report document validity only.

`ThemeList = { themes: ThemeEntry[], folderError: boolean }`. A missing folder gives an empty
list. `folderError` is true when an existing folder cannot be listed or exceeds the folder cap.
Each entry is one of:

- `ThemeValid = { valid: true, name, base, density?, fonts: { text?, code?, files? }, scales, tokens, themeColor }`.
  `files` is additive; older clients strip it.
  `density` is included only when the file sets it; older servers and saved copies may omit it.
  The records hold only the file's overrides, normalized. Record keys match `/^[a-z0-9-]{1,40}$/`
  so older clients can read newer servers; clients apply only names they know. Scale values are
  `ThemeColor`; token values are `ThemeColor` or a known scale step name. `themeColor` is
  the resolved, opaque `bg-app` as `#rrggbb`, for the browser's theme-colour meta tag.
- `ThemeRefused = { valid: false, name, base: "dark" | "light" | null, problems }`.
  There are 1–20 problems, each at most 200 characters. The last may say `…and N more problems.`

Any document validation problem refuses the whole theme. Font file read problems only prevent
serving that font; they do not refuse an otherwise valid theme. Reasons use fixed text, known names and numbers. An unknown
key is named only if it matches `/^[a-z0-9]+(?:-[a-z0-9]+)*$/` and is at most 24 characters;
otherwise it is called `an unknown name`. Reasons include `The folder has no theme.json.`,
`theme.json cannot be read.`, `theme.json is larger than 32 KiB.`, `theme.json is not valid JSON.`,
`The file must hold a JSON object.`, `version must be 1.`, `base must be "dark" or "light".`,
`density must be "compact", "regular" or "roomy".`,
`Unknown entry: colours.`, `scales has an unknown name: n-26.`,
`scales.n-25 is not a colour. Use hex (#rrggbb) or oklch(L C H).` and
`tokens.fg-1 is not a colour or a scale step name.` Invalid folder names say
`The folder name must use lowercase letters, digits and hyphens, at most 40, and not system, dark, light or fonts.`
A missing theme folder or a name whose entry is not a folder is an unknown name.
An existing folder without `theme.json` is refused.
Invalid fonts say `fonts.text must be a plain font name: letters, digits, spaces, hyphens and underscores.`
(`fonts.code` for the code font). A non-object section says `fonts must be a JSON object.`
(or `scales` or `tokens`); unknown font or token keys use the same `has an unknown name` wording.
Font file entries use their zero-based index in fixed reasons, never the unchecked file name:

- `fonts.files must be a list.`
- `fonts.files has more than 16 entries.`
- `fonts.files[0] must be a JSON object.`
- `fonts.files[0] has an unknown name: extra.` (unknown keys use the name rule above).
- `fonts.files[0].font must be "text" or "code".`
- `fonts.files[0].file must be a .woff2, .woff, .ttf or .otf file name: letters, digits, dots, hyphens and underscores.`
- `fonts.files[0].weight must be a whole number from 1 to 1000, or two of them in a list, lowest first.`
- `fonts.files[0].style must be "normal" or "italic".`
- `fonts.files[0] is for the text font, but fonts.text is not set.` (or `code`).

Readability uses WCAG contrast after clipping linear sRGB channels to 0–1 and compositing in
sRGB. Foregrounds composite over their background. Translucent backgrounds use `bg-surface`
unless an `over` surface is specified. `diff-add-word` composites over `diff-add-bg`, and
`diff-del-word` over `diff-del-bg`; each line background composites over `bg-surface` in the app.
Download diff lines composite over `bg-sunken` instead, as specified in the pairs below.
The seven surfaces `bg-app`, `bg-surface`, `bg-sunken`, `bg-raised`, `bg-reading`, `bg-reading-card`
and `bg-inverse` must resolve to alpha 1: the page stacks them on nested elements. Diagram text
colours `fg-1`, `fg-2` and `fg-3` must also resolve to alpha 1, including through scale references:
the frame receives one colour per Mermaid variable, and Mermaid draws it on several backgrounds.
A translucent colour in either group is refused with
`bg-app must be opaque: its colour has transparency.` (the token name varies).
Compare the unrounded ratio and report two decimals, for example
`fg-1 on bg-app: 2.10 to 1, needs 4.5 to 1.` These pairs require 4.5 to 1:

- `fg-1`, `fg-2`, `fg-3`, `fg-link`, `accent-text` on `bg-app`, `bg-surface`, `bg-sunken`, `bg-raised`.
- `fg-inverse` on `bg-inverse`; `fg-reading`, `fg-reading-strong`, `fg-reading-muted` on `bg-reading`
  and `bg-reading-card`; `fg-link` on `bg-reading`.
- For the Download: `fg-reading` and `fg-reading-strong` on `bg-sunken`, `diff-add-bg` over
  `bg-sunken`, and `diff-del-bg` over `bg-sunken`.
- `fg-1` on `bg-selected`, `bg-hover`, `bg-active`, `accent-tint`, `mark-bg`, `mark-bg-active`, `topic-bg-2`;
  `fg-reading` on `mark-bg` over `bg-reading`.
- For diagram notes: `fg-1` on `topic-bg-2` over `bg-sunken`, in addition to the pair over
  `bg-surface` above. Diagram text also uses the existing `fg-1`, `fg-2` and `fg-3` pairs on
  `bg-surface` and `bg-sunken`. Mermaid draws edge-label and state-label boxes at half opacity
  over the diagram background; no pair checks that blend yet.
- `accent-fg` on `accent`, `accent-hover`, `accent-press`.
- `success-fg`, `info-fg`, `warning-fg`, `danger-fg` on their own `-bg` and on `bg-surface`.
- `state-{open,approved,settled,snoozed}-fg`, `outcome-{fixed,explained,held,declined}-fg` and
  `changed-fg` on their own `-bg`; `topic-fg` on `topic-bg`, `topic-bg-2`, `bg-surface`;
  `topic-on-solid` on `topic-solid`; `origin-N-fg` on `origin-N-bg` for N = 1–8.
- `syn-plain` on `bg-surface`, `bg-sunken`, `bg-hover`, `diff-add-bg`, `diff-del-bg`;
  `diff-add-fg` on `diff-add-bg`; `diff-del-fg` on `diff-del-bg`; `fg-3` on `diff-gutter`;
  `fg-1`, `fg-2` on `diff-hunk-bg`; `fg-1` on `diff-select-bg`.
- `syn-plain` on `diff-add-word` (over `diff-add-bg`), `diff-del-word` (over `diff-del-bg`),
  `diff-add-hover`, `diff-del-hover` and `diff-select-bg`.
- For docs shown as source: `syn-plain` on `bg-reading`, `mark-bg` over `bg-reading`, and
  `accent-tint` over `bg-reading`.

These pairs require 3 to 1:

- `syn-keyword`, `syn-type`, `syn-function`, `syn-string`, `syn-number`, `syn-comment` and
  `syn-punct` on `bg-surface`, `bg-sunken`, `bg-hover`, `diff-add-bg`, `diff-del-bg`,
  `diff-add-word` (over `diff-add-bg`), `diff-del-word` (over `diff-del-bg`), `diff-add-hover`,
  `diff-del-hover` and `diff-select-bg`.
- `diff-add-fg` and `diff-del-fg` on `bg-sunken` for inserted and deleted code tokens.
- For docs shown as source: the seven syntax highlight colours above, `diff-add-fg` and
  `diff-del-fg` on `bg-reading`, `mark-bg` over `bg-reading`, and `accent-tint` over `bg-reading`.
- For the Download: `fg-reading-muted` on `bg-sunken`, on `diff-add-bg` over `bg-sunken` and on
  `diff-del-bg` over `bg-sunken`.

Hovered context lines use `bg-hover` composited over `bg-surface`. Disabled text is exempt.
Both built-in bases pass all 196 pairs.

Before the HTTP server listens, `startServer` awaits `watchThemes`, which waits at most
`baselineWaitMs` (default 1000 ms) for its first fingerprint. In time, it becomes the baseline without an event. After
the limit, the server listens while that fingerprint keeps running. When it finishes, it becomes
the baseline and broadcasts one `{ type: "themes" }`. Stopping the watcher prevents that late
event. The wait timer uses the injected clock, is unref'd and is cleared when the wait ends.

Every two seconds after that wait, regardless of open streams, the watcher fingerprints each
listed folder's `theme.json`, using size, mtime, ctime and inode. It uses the same capped, sorted listing.
Missing or unreadable `theme.json` files have distinct markers.
Missing and too-full folders have distinct, stable fingerprints. Each change emits
`{ type: "themes" }` only on global `/api/v1/events` streams, to every owner. Ticks skip while a
fingerprint is running. A fingerprint that never finishes leaves the watcher idle; the server can
still start and stop. The interval timer is unref'd and stops with the server.

Open pages refresh within a few seconds. A page using a refused or removed theme keeps its last
valid version and shows the reason in Settings. The choice stays per device. Each tab holds its
own last valid version in memory. Other tabs' saved copies of a theme it already holds are
ignored. A bare `ThemeValid` in `recense.theme.custom` seeds a tab at load or when it switches to a
name it does not hold, only if the saved name matches. The tab parses that text only when it needs
a seed and the text or picked name changed since the last parse. Identical writes are skipped.
Storage events notify listeners only when the state changed.

The root starts one sync loop per tab, outside React Query, with no clocks or timers. It fetches
on start, a picked name change (including another tab's storage event), a `themes` event, and a
stream open. It runs one fetch at a time. Triggers during a fetch queue exactly one more fetch
after it ends. A stopped loop or a pick without a custom name fetches nothing. Stopping aborts
the pending fetch and ignores its result; starting again works. An error changes nothing and
waits for another trigger.

A result counts only for the name still picked when the fetch ends. It records whether that name
is valid. A valid entry replaces the tab's held version when its JSON differs and writes the saved
copy when the stored text differs, even when the held version is unchanged. Missing or refused
entries keep the held version. Listeners are notified and CSS reapplied only when the held version
or checked validity changed. There is no timestamp ordering between tabs' writes.

Settings uses the `["themes"]` query for its list only. Selecting an entry keeps a version this
tab already holds for that name, else adopts a matching saved copy, else uses the selected entry.
It saves that version before writing the pick, skipping identical writes, so other tabs following
the pick can seed it. The pick change triggers the loop. A `themes` event cancels any pending fetch
of Settings' list before refreshing it; stream open keeps the existing refresh of queries older than the open.

Download links read only the store. System passes no theme; Dark and Light pass themselves. For
`theme:N`, a check of N that found it valid passes N. Otherwise the link passes the held version's
base if the tab holds N, or no theme if it does not.

### Review read views

`ReviewState = "open" | "approved" | "settled"`. `settled` is the stored and wire value for a
retired review; clients label it "Retired".
`InboxItem = { id, title, origin: { id, name }, repo: string | null, project: string | null, branch: string | null,
state: ReviewState, newestRevision, unsentCount, openThreads, agentWaiting, pendingSend,
updatedAt, movedTo: string | null, list: "active" | "snoozed" | "done", snoozed: boolean,
snoozedUntil: string | null, activeUntil: string | null, releasedAt: string | null, pickedUpAt: string | null,
kind: "review" | "publish", groupId: string | null, pinnedAt: string | null, pinOrder: number | null }`.
`groupId` is the inbox group UUID, null when ungrouped (the default when omitted).
`pinnedAt` is when the reviewer pinned it, as an ISO 8601 UTC string, null when unpinned or moved
(the default when omitted).
`pinOrder` is the pin's place key, a nonnegative integer, null when unpinned or moved (the default when omitted).
`repo` is the repository key, and
`movedTo` is the review's destination URL. `list` places the review: `done` for `settled`, and for
`approved` once the effective `approvedActiveHours` have passed since approval or it does not fit
Active's approval cap or total cap; an approved review is `active` until then if it has a place.
An open review is
`snoozed` while its snooze is in effect, `active` otherwise.
`project` is the name the review's newest publish sent with its `repo`; for any review not published
since this field was added, it falls back to its repository row's name unless that is `.git`; it is null when none.
`activeUntil` is when an approved review in Active moves to Done; it is null otherwise. The server
sends no event when an approval's window ends. A client estimates the server's clock from
`serverTime` and the time elapsed since the response, refetches when `activeUntil` passes on that
clock, and may show the row under Done from that moment.
The approval time is recorded when the review is approved; a later comment, reply or Send does
not move it. A new revision clears it when it reopens the review. A review approved before this
version or copied in by attach has no approval time and is in Done.
`snoozed` is true while a snooze is in effect; `snoozedUntil` is its wake time, null for a snooze
that lasts until the next revision (and null when not snoozed). `releasedAt` is the last time an
agent confirmed a `closed` answer, so recense ended a wait; it is null when that never happened. Timestamps are ISO 8601 UTC strings; sequences are positive integers.
`unsentCount` counts user comments without a Send; `openThreads` counts all unresolved threads.
`pendingSend` means a Send is neither confirmed delivered nor set aside (an unconfirmed lease
is still pending). `pickedUpAt` is the time an agent's CLI last confirmed a delivery that carried a
live Send (a `go` or an approval) made on the review's newest revision, so recense saw the feedback
reach the agent's stdout; it never says the agent works on it. A Send is live while it is not set
aside. Only a delivery with `confirmed_at` set counts, so a claimed but unconfirmed lease does not,
and a delivery without a Send (the `closed` answer) never counts. A Send names the revision on
screen and a stale revision is refused, so a Send belongs to one revision: among the deliveries that
carry a live Send of the newest revision, the latest `confirmed_at` wins. It is null when there is
none. Publishing a newer revision therefore clears it, even when the confirmation arrives after the
publish; no clock comparison between a revision and a confirmation is involved. `ReviewView` carries
the same field, since it extends `InboxItem`. Clients show one state, by priority: approved;
Agent waiting (`agentWaiting`); Not picked up yet (`pendingSend`); Picked up (`pickedUpAt`); none.

`kind` is `"publish"` when the newest revision has an empty writeup and no diff (no `base`), as
`recense publish <path>` produces; otherwise `"review"`. It follows the newest revision, so a later
revision can change it. Both views carry it.

`agentWaiting` is true for a server-held wait (including its 35-second grace
period) or an unexpired direct-wait row for the same owner and review. Direct waits renew a
30-second expiry every 10 seconds and delete their row when they end. They emit no live event;
views reflect direct writes on their next load.

`GET /api/v1/reviews` returns `InboxList = { items: InboxItem[], groups: InboxListGroup[], serverTime: string,
approvedActiveHours: ApprovedActiveHours, approvedActiveLimit: ApprovedActiveLimit }`.
`approvedActiveHours` and `approvedActiveLimit` are the effective window and approval cap used
for this response. `groups` contains all of the owner's groups, ordered by name then id,
and defaults to `[]` when omitted. Each `InboxListGroup` is `{ id, name, members }`, where `members`
is the nonnegative integer count of that owner's member reviews and pubs not in the bin,
including members beyond the grouped block's row cap. Groups without members have `members: 0`.
Reviews in the bin are in none of the lists.
`serverTime` is the server's clock when it built the list, as an ISO 8601 UTC string.
The Active list holds ungrouped open reviews whose snooze is not in effect, selected by newest activity,
then id ascending, up to `inboxItems` (200). Open reviews take the places first. Approved reviews
qualify only inside the approval window (12 hours by default), up to `approvedActiveLimit`
(5 by default) or the number of remaining Active places, whichever is smaller. These places go
to the newest approvals by approval time, then id ascending, regardless of later activity.
Every other ungrouped approved review is in Done with `activeUntil: null`. Because every approval has the
same window length, a window ending cannot bring an older approval back into Active.

Active is ordered by priority, first match wins: open with an agent waiting; open with unsent
comments; open without a live Send on its newest revision (To review); open reviews with such a Send
(Answered); approved. A pub (`kind: "publish"`) with such a Send stays in To review. A live Send
is not set aside, whether its delivery is pending or confirmed.
The priority is not a wire field. Within each priority, newest activity comes first: an open review uses
`updatedAt`, or the wake time of a timed snooze that has passed when that is later; an approved
review uses `updatedAt`. Id ascending breaks ties. Approved reviews always follow every open review.
Next is Snoozed (soonest wake first, a snooze until the next revision last), then the grouped
block, then Done (retired reviews and approvals without an Active place, newest `updatedAt`
first). Grouped reviews are in none of Active, Snoozed or Done and take no Active place or
approval-cap place. Their block is newest activity first: an open review uses the later of
`updatedAt` and the wake time of a timed snooze that has passed; others use `updatedAt`.
Id ascending breaks ties in every block. Each block has a row cap of `inboxItems` (200).
A pinned review is placed exactly like an unpinned one. It takes an Active place and an
approval-cap place when it qualifies. Each of the Active, Snoozed, grouped and Done blocks
also carries its pinned reviews beyond its row cap, after its capped rows and in its own order.
These rows are at most `pins` (50) in all, shared across the blocks in block order.
Every pinned review outside the bin, except moved reviews, is in the response while the owner
has at most `pins` (50) live pins.
The approval cap still applies: a pinned approval without an Active place is in Done.
Moved reviews show as unpinned. The response carries each review once, at most 850 rows in all.
Clients show a pinned review in Pinned, and also in its own section unless that section is Active.
Pinned is ordered by `pinOrder`, then pin time, then id ascending.
Pins made before `pinOrder` existed have 0 and keep oldest first above later pins.
A grouped review's `list` and `activeUntil` follow the single-review rule below
(approval window alone, no caps); clients place it by `groupId`.
`GET /api/v1/reviews/:id` returns `ReviewView = InboxItem & { revisions: { seq, createdAt }[], importedAt: string | null, related: RelatedReview[] }`,
with revisions ascending by sequence. `related` defaults to `[]` for older servers; each
`RelatedReview` has `{ id: UUID, role: "intent" | "code", title, state }`, with the same title and
state schemas as `InboxItem`. See "Intent reviews" below. It places an approved review by the effective approval
window alone, without Active's caps.
Both are reviewer-only, as is the revision endpoint below.

`GET /api/v1/reviews/:id/revisions/:seq` returns `RevisionView = { seq, base, head, main, writeupEmpty,
topics: TopicMeta[], files: FileView[], writeup: RenderedWriteup, links: PublishLink[],
repoUrl: string | null, issueRefs: IssueRef[], docs, threads: ThreadView[],
changedBlocks: { blockId: BlockId, revision: number }[], changedSince?: number }`.
An HTML doc optionally includes `changes: { parts: number, marks: { index: number, revision: number }[] }`.
`parts` is the number of parts found by the server, at most `htmlPartsPerDoc` (10000).
`marks` lists, in part order, the indexes whose IDs occur in `changedBlocks`, with each block's
revision. Indexes are unique and less than `parts`. Revisions without stored parts omit `changes`.
Parts are HTML-namespace address, article, aside, blockquote, caption, dd, details, dialog, div,
dt, fieldset, figcaption, figure, footer, h1–h6, header, hgroup, legend, li, main, nav, p, pre,
section, summary, td and th elements below body, in element start order. Each part owns text
whose nearest enclosing part is that element; nested parts' text and text directly in body do
not count. Script, style, template and noscript subtrees are skipped in every namespace.
Text is NFC-normalized, Unicode whitespace collapsed and trimmed; empty parts are dropped,
then only the first 10000 remain. Part hashes use the normalized own text, with duplicate hashes
suffixed `-2`, `-3`, and so on in occurrence order.
Across a revision, at most `htmlPartsPerRevision` (100000) parts are stored, counted per path
even when paths share a blob. In manifest order, the first HTML doc that would exceed the cap
and every later HTML doc store no parts. They still render and are served, but show no marks;
their null parts also suppress marks in the next revision's comparison.
Across an import, at most `htmlPartsPerImport` (1000000) parts are stored, counted the same way
in revision order. The first HTML doc that would exceed this cap and every later HTML doc in
that or later revisions store no parts; they still render, show no marks, and their null parts
suppress marks in the next comparison.
`links`, `repoUrl` and `issueRefs` are the revision's publish-level fields (see "Links and repoUrl" below);
all three are optional in the view, and revisions published before they existed omit them.
`RenderedWriteup.area?: WriteupArea` is the plain-text area, with whitespace collapsed and trimmed.
An invalid stored area is omitted.
`RenderedWriteup.newInRevision?` holds 1–12 entries `{ topic?: TopicSlug, section?: NewInRevisionSection, blockId?: BlockId, blockIds: BlockId[] }`.
Each entry's `blockIds` lists its rendered blocks in order; every id must have the `newInRevision-` prefix.
The optional `blockId` names the block matched by the input quote; `newInRevision-` and `doc-`
prefixes are refused. The quote itself is never stored in the rendered writeup.
Items whose text renders no block are dropped from both the section and metadata. With none
left, or an empty input list, the field is the same as an absent one: no section and no metadata.
The app also ignores stored entries with no blocks and shows no card when none remain. Invalid stored
metadata, including an empty list, is omitted without refusing the revision. From revision 2,
the app shows a "New in this revision" card after TL;DR and before Needs you and Facts: four
lines show, with the rest under "and N more". While the card shows, the Changed (Since) fact
keeps only changed Markdown docs and the count of viewed files that changed, in the existing
"Since revision N: ..." wording; it omits changed writeup section names and the no-new-text
sentence, and disappears when neither docs nor viewed files changed.
A usable `blockId` jumps straight to that block of a shown writeup section. The label is the
item's topic title or section name, or, for a quote alone, the containing topic's title or
section name. An unknown or hidden block falls back to the topic or section jump.
A topic jump uses its first changed writeup block, or its topic group (else diff topic);
a section jump uses its first changed block, or its first block. Changed means since the
reviewer's last Send, through this revision. Missing targets have no jump.
`RenderedWriteup.needsYou?` holds at most 4 entries `{ kind: NeedsYouKind, topic?: TopicSlug, blockIds: BlockId[] }`.
Each entry lists its rendered blocks in order; every id must belong to the `needsYou` section.
An empty input list stays `[]` with no section; an absent field stays absent. An invalid stored
list is omitted without refusing the revision. The app shows a Needs you card under the TL;DR
and a status line: "N decisions" ("1 decision"), or "Nothing needs a decision. Approve on the proof."
for `[]`. An absent field shows neither.
`RenderedWriteup.terms?: GlossaryTerm[]` holds at most 50 entries `{ term, definition, blockId }`
for a list glossary. `term` is normalized plain text (1–100 characters), `definition` is plain
text from sanitized glossary blocks (0–2000 characters, ending in `…` when cut), and `blockId`
names the entry's first glossary block. Old revisions, empty lists and Markdown glossaries omit it.
Base/head are nullable full commit hashes; head also permits `worktree`.
`main` is `"writeup" | FilePath | null`: the manifest's main page, or null when omitted.
`writeupEmpty` is a boolean computed at publish from the source Markdown, before rendering:
true only when overview, tldr, whyItMatters, every newInRevision and needsYou item's text, checked, notChecked, outOfScope,
whereToLook, context, deviations, decisions, glossary, and every topic's why, example and body are missing or
whitespace only. A `review` verdict does not count because it is never shown.
The plain-text area does not make a writeup non-empty. Both fields are stored
on the revision; revisions predating these fields read as `main: null`, `writeupEmpty: false` and keep opening on Writeup.
Without an explicit visible `tab` in the URL, the app opens the main page when set; otherwise
it opens Writeup if it has text, the first doc in manifest order, Diff if any file has role
`diff`, or Writeup when there is nothing. A main doc opens Docs scrolled to that document.
`FileView = { id, path, oldPath, role, status, topic, order, mediaType, flag, hasOld, hasNew, counts?, viewed?, viewedOn?, notes?, image?, view?: "source" }`.

On a diff file, `image` contains `old` and `new`. Each present side has its own
`mediaType` and a `flag` of null or `"oversized"`. An absent side is null.
`image.unchanged: true` appears only when both sides share a stored blob.
Reviews published before this change have no image data.

`counts` is `{ additions, deletions }` lines, counted at publish with the same line diff the app uses.
It is absent for flagged files, for docs, for a file whose diff exceeded the per-file time limit
or the revision's counting budget, and for revisions published before the field existed.
The app also uses counts from diffs it has loaded. It marks a total as partial while a changed
text file has neither server nor loaded counts; the mark goes once every such file has loaded.

`notes` is present only for files with agent notes. Each `AgentNoteView` adds a UUID `id` to
`AgentNote` below. Notes are read-only revision content, separate from reviewer comments.
`oldPath`, `status`, `topic` and `flag` are nullable. Files are in their stored order; assets
are omitted. `hasOld` and `hasNew` indicate stored sides, without exposing blob hashes.
For tracked diff files, `viewed` is `"viewed"` when the marked old/new blob pair and rename
source match the shown revision, or `"stale"` when either differs. Flagged files use the
revision-only rule above.
`viewedOn` is the positive revision sequence when marked.
Both are absent without a mark. Marks follow the current path, including for renames.

`RenderedBlock = { id: BlockId, section, kind, html, text, source? }` mirrors core's `Block`.
Kinds are `heading | paragraph | item | code | table | quote | diagram | chart`. Diagram and chart source is optional.
A chart block has empty `html` and its fence text in `source`.
`RenderedWriteup = { area?: WriteupArea, newInRevision?: { topic?: TopicSlug, section?: NewInRevisionSection, blockId?: BlockId, blockIds: BlockId[] }[], needsYou?: { kind: NeedsYouKind, topic?: TopicSlug, blockIds: BlockId[] }[], terms?: GlossaryTerm[], sections: { key, label, topic: string | null, blocks: RenderedBlock[] }[] }`
mirrors core's rendered writeup. These are server-rendered blocks, never browser-rendered Markdown.
Markdown docs are `{ path, kind: "markdown", title?, headings?, terms?: GlossaryTerm[], blocks: RenderedBlock[] }`
(`blocks` empty if unrendered). `terms` holds at most 50 entries `{ term, definition, blockId }` and
is present only when the doc declares a glossary (see "Glossary in a Markdown doc"); `blockId` names
the block that holds the entry in that doc.
HTML docs are `{ path, kind: "html", contentUrl, look?: "emend" | "custom", colorScheme?: "light", images?: FilePath[] }`.
On the /api/v1 wire the recense look is spelled `"emend"`, as it was before the rename: every response
(this view, `htmlLooks` of a publish response) and every request a CLI sends to a hub (the import bundle
of attach, publish) carries `"emend"` or `"custom"`, so a 0.17 client or hub reads it. Wherever a `look`
is read as input, `"recense"` and `"emend"` are both accepted and mean the recense look. Inside recense
the look is `"recense"`; the mapping happens at the boundary (`wireHtmlLook` in `packages/contract`).
The optional `images` lists the doc's own raster image assets linked through `doc_assets`,
sorted by path, with at most `LIMITS.filesPerRevision` entries. Only `image/png`, `image/jpeg`,
`image/gif`, `image/webp` and `image/avif` qualify. SVG, ICO and BMP assets stay in the frame;
they cannot open in the lightbox. HTML docs without qualifying assets get `images: []`.
The optional `look` is recorded at publish time: `recense` adds recense's layered pub stylesheet, and `custom`
keeps the page's own look. A page gets `custom` only when its head carries
`<meta name="recense-look" content="custom">`. Every other page gets `recense`, with or without its own
styles. The marks `<meta name="emend-look" ...>` and `content="emend"`, as written before the rename, still count; `content="recense"` is accepted and changes nothing. A revision keeps the look
stored with it: a page with its own styles published before this rule stays `custom`. An absent
`look` (a revision published before this field existed, or metadata that failed) shows as a custom
page.
The optional `colorScheme: "light"` is recorded at publish time too, only with `look: "recense"`. It
marks a page whose own styles set colours but have no dark-mode rule. recense shows that page in light
mode, also while recense is dark, so its text stays readable. Without the field the page follows
recense's mode. A page sets colours when:

- a `style` element or a `style` attribute declares `color`, `background`, `fill`, `stroke` or a
  property ending in `-color`, with a value other than `inherit`, `initial`, `unset`, `revert`,
  `revert-layer`, `currentcolor`, `transparent` or `none`;
- an HTML element carries `bgcolor`, `color`, `text`, `link`, `vlink` or `alink`;
- an SVG element carries `fill`, `stroke`, `color`, `stop-color`, `flood-color` or `lighting-color`
  with a value other than those keywords;
- it links a stylesheet, or a style element uses `@import`. recense does not read those files.

A dark-mode rule is `prefers-color-scheme` or `light-dark(` in a style element, `light-dark(` in a
`style` attribute or an SVG colour attribute, or `prefers-color-scheme` in the `media` attribute of
a style element or a stylesheet link. Both checks read CSS outside comments, strings and `url()`
values, and cover declarative shadow roots, not inert templates.
The leading copy `recense look` writes counts for neither check, nor as the page’s own styles,
when recognised exactly as written: `<meta charset="utf-8"><style data-recense-look>` at the start
of the page, after a doctype and comments, optionally after `<html data-theme="light">`, ending
at the first `</`, which must be exactly `</style>`. Any other `style` element counts as usual,
including one carrying `data-recense-look`.

The URL is
`/content/<docKey>/<path>` with each path segment percent-encoded. The doc key is the revision's
43-character base64url `contentKey` followed by that doc's file UUID with dashes removed (32
lowercase hex characters); its exact shape is `^[A-Za-z0-9_-]{43}[0-9a-f]{32}$`.
The sole exception is `/content/sample/sample.html`, which serves only the fixed synthetic sample
doc with the same look, bridge and headers. Every other `/content/sample/` path receives 404.
For revision content, GET and HEAD serve only that HTML doc and the assets it lists in the same
owner and revision.
The key is the capability: neither cookies nor Authorization are read, and the owner comes from
the revision. Wrong keys, missing files, other docs, diff files, unlisted assets and invalid paths
receive 404, and so does a stored blob whose size or bytes do not match its hash, before any byte
is sent. The doc receives an inline selection/highlight bridge; assets retain their bytes and send
`Content-Length`.
Content-Type is the stored media type, with `; charset=utf-8` for `text/*`, `application/json`
and `image/svg+xml`; the doc is `text/html; charset=utf-8`.

The bridge also inserts one style element first in the doc's head, in the cascade layer
`recense-fallback`: `pre { overflow-x: auto; }`. Declared first and layered, it loses to every
document-level rule of the doc's own CSS, so a code block the doc leaves unstyled scrolls inside its
own box instead of widening the doc. A `::slotted(pre)` rule in a shadow root does not override it:
the cascade ranks the outer document's rules above a shadow tree's.

A doc whose `look` is `recense` also receives recense's pub stylesheet as one style element, placed
after any leading byte order mark, whitespace, comments and doctype, so the doc never falls into
quirks mode. The route first removes the leading copy `recense look` writes (recognised as described
under the colour checks), so the frame shows the page the Download shows.
The stylesheet is `pub-frame.css` from the web build: recense's tokens and element
styles in the cascade layer `recense`, with its fonts as `data:` URLs. It contains no `</`, backslash,
`@import`, `image-set(` or `src(`. Every `url(` must use `data:`. The build and every server read
check these rules and the `pubStylesheetBytes` limit. A missing or rejected sheet falls back to a
minimal light and dark sheet with system colours.
The stylesheet declares `@layer recense-file, recense;`, so page CSS in the layer `recense-file` never
overrides recense's look.
Every unlayered rule of the doc's own CSS wins over it. The doc's headers stay exactly as above.
A doc whose `colorScheme` is `light` also gets the fixed start tag `<html data-theme="light">` right
before that style element, regardless of the query. Other docs in recense's look accept an optional
`theme=light` or `theme=dark` query, adding the matching fixed start tag (`<html data-theme="light">`
or `<html data-theme="dark">`) there for the first paint. All other values, including an empty value,
are ignored; custom and legacy looks ignore the query entirely. The raw query is never emitted.
The HTML parser gives the root element this attribute first, and a later `html` tag of the doc only
adds attributes the root lacks, so the doc cannot change it. The sheet's dark colours and the
fallback's dark scheme apply with `data-theme="dark"`, or when the browser prefers dark and the
root has no `data-theme="light"`. An explicit light or dark root uses that `color-scheme`.

A doc in recense's look also gets code colours, the same as in a Markdown doc. The route colours an
HTML-namespace `code` that is a direct child of an HTML-namespace `pre` without the `mermaid`
class token. The `code`'s first class token that starts with `language-` must name a language the
Markdown renderer colours. Both its tags must appear in the source, and the source between them
must be its own text nodes and nothing else: no tag, end tag, comment or other markup. A block
whose text holds a carriage return stays plain. Markdown's limits apply per doc: at most 16,384
UTF-8 bytes per block and 65,536 in all, and lines over 400 characters stay plain. A doc over
1,048,576 UTF-8 bytes, or one that parses into more than 200,000 elements, stays plain. The route
replaces only the bytes between that `code`'s start and end tags. It writes the same text, escaped,
in `span` elements whose only attribute is the `style` Shiki gives that token in a Markdown doc.
With recense's syntax theme the colours are the `--syn-*` variables, so they follow the mode and an
applied theme. Every other byte stays as stored, and so does the text that quotes and placement
read. Any other block stays plain. Custom and legacy looks, Downloads and `recense look` keep code
plain.

The server never parses the doc on its request thread. A doc without a `<code` tag gets no
colours and no parse. Otherwise one shared worker computes the colours, one doc at a time, for at
most 5 seconds each, with at most 16 docs waiting. A load waits at most 3 seconds and is served plain
when the colours are not ready; a job that finishes later serves the next load. A doc whose job
failed or ran out of time is served plain for 10 minutes before it is tried again. The server keeps
the colours of at most 64 docs and 16 MiB, so a reload does not compute them again.

Asset and error responses under `/content/` send:

```
Content-Security-Policy: sandbox allow-scripts; default-src 'none'; script-src 'none'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self' data:; media-src 'self'; connect-src 'none'; form-action 'none'; frame-src 'none'; frame-ancestors 'self'
X-Content-Type-Options: nosniff
Referrer-Policy: no-referrer
Cache-Control: no-store
```

Successful doc responses have the same headers, with only `script-src` replaced by
`script-src 'sha256-<base64 SHA-256 of the bridge script text>'`. The server computes that hash
once from the bridge constant and injects exactly that text, byte for byte. Only recense's bridge
runs: a doc's own inline scripts, event handlers, `javascript:` URLs and script files never run.
Script files may still be published and served, but never execute in the frame. Assets, including
SVG opened as a document, and errors allow no scripts. The bridge's body text model equals the
server's `docText`; author scripts cannot change the text after load.

`frame-ancestors 'self'` permits framing only by the app at the content response's own origin,
including when the reviewer uses an IPv6 literal host. A different app hostname is a different origin.
Cross-Origin-Resource-Policy is `same-origin` for the doc and errors, and `cross-origin` for
assets so the opaque-origin frame can load them. Asset responses also send
`Access-Control-Allow-Origin: *`, allowing file fonts requested with `Origin: null` to load;
docs and error responses do not send that header. Data fonts also work. No content response sends
X-Frame-Options. App-page headers are unchanged.

The app displays HTML in an iframe with `sandbox="allow-scripts"` and `referrerPolicy="no-referrer"`.
Relative asset URLs resolve within the doc key. Primary clicks without modifiers on links to
another HTML or Markdown doc under this doc key send
`{ type: "recense:navigate", path: FilePath, fragment: string }` to the parent. The path and fragment
are decoded; the fragment excludes `#` and is at most 1024 characters. The parent accepts this
strict message only from the current trusted frame and only for another doc in the same revision.
It opens that doc as a new history entry. Every frame src is the doc's own content URL; for a doc in
recense's look that is not light-only, it adds `?theme=` and the mode the app shows at that moment. For
an HTML target with a fragment, the newly mounted frame's src then adds `#` and the percent-encoded
fragment. Same-doc HTML `a` and `area` links and SVG
`a` links (`href` or `xlink:href`), in the document or an open shadow root, are handled by the bridge
without changing `location` or browser history. It prevents browser navigation even when the
resolver refuses the href: accepted fragments scroll to their targets, empty or absent fragments
scroll to the top, and refused fragments or missing targets do nothing. A fragment matches a
document id, then an id in the link's shadow root, then the first HTML anchor with that exact
`name` (in the document before the shadow root). These link elements also use bridge handling for
cross-doc navigation. Links in closed shadow roots, SVG links shown through `<use>`, and
`<meta http-equiv="refresh">` fall back to the browser. Fragment and Contents targets open ancestor
`details`, following assigned slots in open shadow roots and shadow hosts. Slots in closed shadow
roots are not exposed to the bridge.
The app's `frame-src 'self'` blocks a clicked external link or a meta
refresh to an outside URL; the frame then shows `This doc navigated away.` with Reload. An asset
link opens the asset in the frame and triggers the same state.

A parent-initiated src change or Reload mounts a fresh frame generation. A further unexpected
load or a second `recense:ready` in that generation disables the frame's bridge and shows
`This doc navigated away.` with Reload. The second ready locks it immediately, before load;
no further messages or commands are accepted until a parent-initiated reload or navigation. Directly
navigating to another doc under the current doc's key still returns 404 and triggers that state.
Other frame messages carry ready notifications, proposed quotes, quote highlights and thread
scroll requests; saving a comment requires the reviewer's explicit action.
When its selection can no longer take a comment, the frame sends the strict message
`{ type: "recense:deselect" }` with no other fields, and the parent hides the Comment on selection button.
The parent hides the button and sends the strict message `{ type: "recense:clear-selection" }` with no
other fields when the reviewer presses or taps the app outside both the doc frame and the Comment on
selection button (even before the frame's first quote arrives), moves focus to a text field in the app,
or selects text in the app while the button shows. The bridge removes the frame's selection on receipt,
and a touch scroll sends nothing.

After each `recense:ready`, the parent sends `recense:layout` first, before highlights, doc paths or
position restore. The message schema accepts exactly two strict shapes, with no extra fields:

- `{ type: "recense:layout", wide: boolean }`
- `{ type: "recense:layout", wide: boolean, width: "comfortable" | "wide" | "narrow", prose: 15 | 16 | 17 | 18, code: 12 | 13 | 14 | 15 }`

The parent adds the View menu's width and sizes only for a frame in recense's look. It sends layout
again whenever the app crosses its 768px breakpoint, or those preferences change for recense's look,
without reloading the frame. Custom and legacy frames receive only `wide`.
The bridge accepts layout only from its parent. When `width`, `prose` or `code` is present, all
three must be present and valid; otherwise it ignores the whole message, `wide` included. It
sets `data-recense-layout` to `wide` or `narrow` on the root element and, when supplied, sets
`data-recense-width` to the width name, `data-recense-prose` and `data-recense-code` to the size strings. It sets the same four values under the names from before the rename too (`data-emend-layout`, `-width`, `-prose`, `-code`), because pages that `emend look` styled key their layout rules to them.
A message without preferences leaves the earlier width and size attributes alone. When these
attributes change while a pinned position still holds, or any container on the reading heading's
rendered path is scrolled (a nonzero `scrollTop`), the bridge returns to the same heading and
fraction. Every `recense:goto` pins its target (a restore, a Contents pick or a `#h-` link), and so
does the bridge's own return after a layout change; the pin holds until the view moves away from
where it landed. This includes nested scrollers and a pinned position temporarily clamped to the
top because the doc fits. A doc with nothing scrolled and no pin stays where it is. recense's look uses these attributes
to match the Markdown reader's layout and sizes. On phones the measure stays 68ch; sizes still
apply. Until layout arrives, the frame's own width decides.

For a frame in recense's look, the parent sends the strict message
`{ type: "recense:theme", mode: "dark" | "light", scales: Record<string, ThemeColor>, tokens: Record<string, ThemeColor | ThemeScaleStep> }`
after `recense:layout` on each ready. It sends it again whenever the pick, the OS mode under System,
or the custom theme's colours change, without reloading. Only supported scale and token names are
sent; fonts are excluded. A light-only doc always receives `light`, with colours only from a
light-based custom theme. Otherwise the resolved mode and the selected custom theme's colours are
sent, or empty maps when no custom theme is selected.

The bridge accepts theme messages only from its parent and validates the whole message before
changing anything: mode must be exactly `dark` or `light`; both maps must be non-null, non-array
objects with at most 256 own entries each. Keys in both maps and token step values are names of
lowercase letters and digits in dash-separated parts, at most 40 characters, matching
`^[a-z0-9]+(?:-[a-z0-9]+)*$`. The bridge accepts any such name; the parent sends only recense's own
scale-step and token names. Scale values must be colours; token values may also be step names.
Colours match `^#[0-9a-f]{6}(?:[0-9a-f]{2})?$` or `^oklch\(N N N(?: / N)?\)$`, where each `N` is
`(?:0|[1-9][0-9]{0,2})(?:\.[0-9]{0,5}[1-9])?`. Range checks stay with the contract.
Any invalid entry rejects the whole message. The bridge sets only the root's `data-theme` and
replaces the text of one constructed stylesheet, created and adopted once, with
`@layer recense{:root:root:root{--<key>:<value>;...}}`; token steps become `var(--<step>)`.
Empty maps clear the sheet. The layer lets the doc's unlayered CSS win, while the selector beats
recense's default colour rules. Without constructed stylesheets, only `data-theme` is set. Theme
messages do not scroll or change other attributes. An applied theme can request diagrams again
when their computed text colour changes mode, as described below.

Custom and legacy pubs receive no theme message. Their frames inherit the app's `color-scheme`,
which current Chromium and Firefox pass to the frame's `prefers-color-scheme`, so a custom pub
with its own dark rules follows the pick in those browsers.

After `recense:ready`, the parent sends `{ type: "recense:docs", paths: FilePath[] }`, the exact doc
paths in this revision. Bridge links resolve against the existing document base, decode each
segment once, and use the same rejection rules as the core resolver. The parent validates the
destination again before navigating.

After ready, before highlights, the parent sends `{ type: "recense:repo", url: RepoUrl }` when a
repository URL is available. The bridge validates it and accepts only the first valid message;
it links `#123` text, skipping existing links, code and preformatted text, form controls,
script/style/template/noscript, non-HTML elements and shadow roots. A click on a bridge link,
including a modified click or a middle click, sends
`{ type: "recense:issue", number }` with only an integer from 1 through 9999999. The parent opens
its own `repoUrl/issues/<number>` in a new tab with `noopener,noreferrer`.

After ready and whenever an HTML doc's `changes` differs, the parent sends
`{ type: "recense:changed", parts: number, marks: { index: number, revision: number }[] }`.
Absent `changes` sends nothing. The bridge accepts only its parent and exactly these keys;
`parts` must be an integer from 0 through 10000, and `marks` an array of at most `parts` plain
objects with exactly `index` and `revision`. Indexes must be integers in `[0, parts)`, strictly
increasing; revisions must be positive safe integers. An invalid message is ignored whole.
A count different from the bridge's own part count clears all marks. Otherwise marks replace
the previous ones, preserving reading position. Each marked part gets a violet left line;
each run of consecutive parts with the same revision starts with `Changed in rev N`.
Labels live in closed shadow roots and never enter quotes or headings. Diagram marks follow
the visible diagram host. Both looks show marks with a fixed palette from the last applied
`recense:theme` mode, defaulting to light (also for custom pages and light-only docs). Light uses
line `#8b5cf6`, label background `#f5f3ff` and text `#6d28d9`; dark uses line `#a78bfa`,
background `rgba(139, 92, 246, 0.16)` and text `#c4b5fd`. The line and label use inline important
styles with a fixed palette. A doc's own CSS or markup can still hide marks or show look-alike
ones, so marks are a reading aid, not proof.

HTML diagrams use `<pre class="mermaid">` in both recense's look and custom pages. Only
HTML-namespace `pre` elements qualify. A `pre` qualifies with the exact `mermaid` class token
(split on ASCII whitespace). It also qualifies when its only element child is an HTML-namespace
`code` with the exact `language-mermaid` class token, split on ASCII whitespace. The `pre`'s other
child nodes must be ASCII-whitespace text or comments. This is the form a Markdown fence becomes.
The bridge walks light DOM in document order, skipping script, style, template and noscript
subtrees, and any `pre` inside an earlier diagram `pre`. Nested `code` contributes text;
`div.mermaid` and `code.language-mermaid` outside such a `pre` do not qualify.
Source is the `pre`'s unchanged `textContent`, read through `Node.prototype`.
Markup inside the `pre` is not part of the source,
so authors escape `<` as `&lt;` and `&` as `&amp;`. Empty-after-trimming sources and sources over
50,000 characters stay as text. The scan keeps at most 50 diagrams and stops before the sum of
source lengths would exceed 1,000,000.

Immediately after `recense:ready`, a nonempty scan sends the strict message
`{ type: "recense:diagrams", request: number, diagrams: { source: string, mode: "light" | "dark", width: number }[] }`.
`request` is an integer from 1 through 2147483647, starting at 1 and increasing on every post.
There are 1..50 entries; sources are well-formed strings of 1..50000 characters, with a total
of at most 1,000,000. Width is the host's bounding rectangle width once placed, otherwise the
`pre`'s, rounded and clamped to 1..10000.
Mode comes from the computed `color` of the `pre`'s parent (or the document element): a 1x1
sRGB canvas converts it to unpremultiplied RGB bytes, ignoring alpha. Linearised sRGB relative
luminance uses weights 0.2126, 0.7152 and 0.0722; a value above 0.179 means light text and mode
`dark`, otherwise `light`. Any conversion failure means `light`. The bridge captures
`getComputedStyle` at startup and uses prototype calls for DOM, CSSOM and canvas access.
After an applied theme message, on `prefers-color-scheme: dark` changes, and at the end or cancel of any
transition or animation on an element that holds a diagram, it checks modes again.
Only a changed mode sends the next request, containing all diagrams with current modes
and widths. Rejected theme messages and width changes alone send nothing.

Only a ready content frame that has not navigated away can submit a job. The parent renders
its latest job sequentially in one hidden, laid-out `/mermaid-frame.html` iframe with only
`sandbox="allow-scripts"`, `aria-hidden`, `tabIndex=-1`, a title and no lazy loading. It is fixed
outside the reading flow, invisible and noninteractive, with width clamped to 240..2400 px.
On load, and after each answer, it sends `{ type: "render", source, theme: mode, reply: "svg", colors? }`.
Source drops leading and trailing blank lines and the common leading whitespace of nonblank
lines. Colours come from `readMermaidColors()` only in recense's look when the diagram mode matches
the app's resolved mode; otherwise the frame uses its built-in palette. A new request, app theme
key or resolved mode restarts the whole job with a fresh frame. Each diagram gets
`DIAGRAM_DRAW_TIMEOUT_MS` (20000 ms); a timeout reports failure, replaces the render frame and
continues. A new content generation, Reload, navigation away or unmount drops the job.

The Mermaid frame answers only when `reply` is exactly `"svg"`. After `sanitizeSvg` and
`restoreCodes`, it serialises the SVG with `XMLSerializer`, setting width and height attributes
to `naturalSize`, and posts the strict shape `{ type: "svg", svg: string, width: number, height: number }`.
An unknown natural size or a fallback (too large or undrawable) posts `{ type: "svg", svg: null }`.
The frame also answers `svg: null` when its serialised SVG holds a character XML forbids or does
not parse as SVG.
Existing `size` messages continue; without `reply: "svg"`, behaviour is unchanged. The parent
accepts answers only from its render frame's current window. The SVG must be well-formed,
1..4000000 characters, and start with `<svg`; dimensions must be integers in 1..10000. Extra
keys, `size` messages and other invalid replies are ignored.

The parent relays only through its existing guarded content-frame post:
`{ type: "recense:diagram", request, index, svg, width, height }` or
`{ type: "recense:diagram", request, index, svg: null }`. Both shapes are strict. The same request,
SVG and dimension limits apply, and `index` is an integer in 0..49. The bridge accepts only its
parent, the current request and an index within its current list; any invalid field rejects the
whole message. For a string SVG it inserts a `div` with empty `data-recense-diagram` directly
before the `pre`, with a closed shadow root containing one `img`. The image has `alt="Diagram"`,
the supplied width and height, and CSSOM-set `display: block; max-width: 100%; height: auto`.
Its last-set attribute is `src`, containing `data:image/svg+xml;charset=utf-8,` plus the encoded
SVG. Later answers update only image dimensions and source. No doc attributes are copied.
The bridge remembers the `pre`'s inline display value and priority, then hides it with
`display: none !important` unless a current comment highlight intersects it. While a comment's
quote lies in the source, it shows below the image with its original inline display restored;
when no highlight intersects it, it is hidden again. A null answer removes the host and restores
display exactly, removing the property if originally absent. It never changes the `pre`'s children.
Quote text, highlight anchors and headings remain intact, and diagram images never enter the image gallery.
Placement, removal and source visibility changes hold reading position with the same pin and
scroll-path rules as layout.
Only recense's look gives the host the margin, padding, border, radius, sunken background and
overflow of a code block. Custom pages receive no host styles.

The app never inserts this SVG into its own DOM. Mermaid still uses `securityLevel: "strict"`
and its existing sandbox and headers. The content frame shows SVG only as an image, which runs
no scripts, fetches no resources and takes no input. Content CSP still has `frame-src 'none'`,
`connect-src 'none'` and only the bridge's script hash. No sandbox, header or sanitize schema
changes. Download and files opened outside recense, including after `recense look`, show source.

A primary click or tap without modifiers on a qualifying image sends
`{ type: "recense:image", images: { path: string, caption: string }[], index: number }`.
Both objects are strict. Each path is a well-formed string of at most `LIMITS.pathChars` (4096)
characters; the message schema does not require it to be a `FilePath`. Exact membership in
the doc's server-supplied `images` (all valid `FilePath`s) determines which entries may open.
The gallery contains 1 through `LIMITS.filesPerRevision` (10000) images
in flat-tree rendered order, including open shadow roots and slotted images. An open shadow
root replaces its host's light children in the walk; a slot contributes its assigned nodes,
or its fallback children when none are assigned. Script, style, template and noscript subtrees
are skipped. The clicked image comes from the event's composed path, so shadow retargeting does
not hide it. `index` is an integer in the gallery's bounds.
Captions are well-formed strings of at most `LIMITS.quoteChars` (2000) characters, taken from
the nearest enclosing figure's direct `figcaption`. An absent or cleaned-empty caption falls
back to the image's cleaned alt text, then to empty. Each figure's caption is computed only
once per gallery build. All caption text walks share a budget of 1,000,000 node visits per
gallery, including omitted nodes. When it is exhausted, unfinished and later captions count
as empty. Figure and interactive-ancestor lookups follow rendered parents,
including slots and shadow hosts. Images inside links or HTML `summary`, `label` or `button`
elements are excluded from the gallery. Clicking those images preserves link handling or the
control's default action, including toggling a summary.
Only visible HTML images under the current doc key qualify. Image visibility checks include
CSS visibility and opacity when `checkVisibility` is available; otherwise they require client
rects. Loaded images smaller than 48 pixels in both dimensions, including broken images, are
excluded. Queries and fragments are ignored. A decoded path longer than `LIMITS.pathChars`
(4096) characters is skipped; a path of exactly 4096 characters can qualify.
The bridge uses `currentSrc` when available. For a pending responsive image, it approximates
the browser's choice: in a `picture`, use the first preceding HTML `source` whose media query
is absent or matches and whose type is absent or a supported raster media type. The type is
the part before the first `;`, trimmed and lowercased, so case and MIME parameters do not
affect matching. A `media` attribute longer than 1024 characters counts as not matching,
without calling `matchMedia`. Each source's choice is evaluated once per gallery build and
cached, including empty choices for media mismatches, unsupported types and empty source sets.
Each visit still consumes a gallery step. Sources whose
`srcset` yields no candidates are skipped in favour of the next source. Otherwise use
the image's own `srcset`, then its `src` when `srcset` is absent or yields no candidates.
The picture scan examines at most 64 child nodes before reaching the image, counting text
and comments as well as elements. Sources beyond that limit are ignored; selection falls
back to the image's own `srcset`, then `src`.
A `srcset` longer than 16384 characters is treated as having no candidates. From a source's or image's
`srcset`, choose the largest `w` or `x` descriptor (a missing descriptor counts as `1x`);
on parse trouble, including a descriptor longer than 32 characters, use the first candidate.
Parsing uses linear scans within these limits. Resolve the choice against the document base URI,
then apply the same origin and content-path checks.
Each gallery build also has a shared budget of 1,000,000 steps, separate from the caption
text-walk budget. Every image examined, including rejected images and the clicked image's
initial check, costs one step. Every ancestor step for image qualification or caption lookup
and every child visited by the picture source scan also costs one step. Collection stops when
this budget is spent. A click on an image not yet collected posts nothing.
The gallery is built in two passes. First, qualifying paths are collected in page order,
stopping before their combined length would exceed 1,000,000 characters, at 10000 images,
or when the step budget is spent. If the clicked image is outside that collected prefix,
no message is sent. Second, captions are computed in page order using the remaining budgets.
All collected paths' lengths are reserved before adding any captions: a caption is added
only if that total plus the captions already added and this caption stays at most 1,000,000
characters. Otherwise its caption is empty and the pass continues. When the caption node
or step budget is exhausted, unfinished and remaining captions are empty and no further
captions are computed. This second pass never removes an image. The parent independently
rejects a message above the same
1,000,000-character total, before filtering unknown paths.
The parent accepts this message only from the current trusted frame after its ready. It opens
only paths in that doc's `images`: an unknown clicked path opens nothing, and other unknown
entries are dropped while preserving order and the clicked entry. The parent builds each URL
from the doc's own `/content/<docKey>/` prefix plus the path with each segment percent-encoded.
The parent uses the label "Screenshot" when an image's caption is empty. The app's lightbox
shows the gallery without a comment action, leaving the frame mounted and
its reading position unchanged on close. A new frame generation or navigation away closes it.

HTML Contents addresses the server's h2/h3 list by zero-based index. The parent sends
`{ type: "recense:goto", heading: number, label: string }` for a pick; a restore also includes
`fraction: number`, including when it is zero. Messages go only to the current ready frame. The
bridge checks an integer index in its matching heading list, the server-cleaned label, and, when
present, a finite fraction in [0, 1]. It scrolls without changing location. Position is measured
against a reading line at one quarter of the frame's viewport height, rounded to a whole pixel
and read once per measurement. The current heading is the last laid-out heading whose viewport top
is at or above that line. Its fraction is `(line - heading top) / span`, where the span runs to the
next laid-out heading or to the document's end as seen from the viewport. The section distance has a
1px minimum for degenerate layouts, and the fraction is clamped to [0, 1].
Picks and restores first scroll the heading into view. A pick makes no further move. A restore
makes up to sixteen measured passes, searching in total distance moved from that landing. It keeps
the largest measured distance below the saved fraction and the smallest above it as a bracket.
The first move targets `line - fraction * span`; later proposals use the slope between the last two
measurements (a secant step). With both bounds known, a proposal outside the open bracket or a
non-positive slope uses the bracket's midpoint instead. Until an upper bound is found, the next
step doubles; if only an upper bound exists and the secant cannot advance toward the target, the
step doubles backwards to find a lower bound. Each move is the difference between the proposed
total distance and the current measured total.
New movement walks rendered ancestors from the inside out, then the document scroller. Each takes
what it can, passing the remainder outward based on the heading's actual movement. Backtracking
undoes earlier moves in reverse order, so a total distance stays on the same scroll path.
Ineffective attempts are undone. Passes stop when the measured heading matches and its fraction
differs by 0.002 or less, when a pass moves nothing, or after the sixteenth pass. A restore that
stops without reaching the tolerance can leave a larger error. Movement can be negative; browsers
clamp at scroll limits.
All moves use instant behavior that ignores smooth-scroll CSS; measurement never guesses the scroller.
After a goto lands (its last restore pass), the bridge takes one measurement and keeps it as the
landing measurement. Until the view moves, reports carry the requested heading and fraction (zero
for a pick). The pin ends at the first measurement that differs from the landing measurement (another
heading, or a fraction more than 0.002 away), whatever moved the view: a wheel, a scrollbar drag,
find-in-page, `recense:scroll` or a link scroll. `recense:scroll` and the bridge's own link scrolls also
end it explicitly. Input events alone, and clicks that move nothing, do not end the pin. A same-doc
fragment link with no matching target does not scroll or end the pin.
The bridge throttles `{ type: "recense:position", heading: number, fraction: number }` to one message
per 200 ms and posts only when the reported position differs from the last one posted (same heading
and a fraction within 0.002 is not a change). Window resize and composed `wheel`, `touchmove`,
`touchend`, `keydown`, `pointerdown` and `pointerup` events start up to five samples. A `scroll`
event (window or captured document scroll) starts sampling only when the measured position moved
since the last sample, and restarts the budget of a running chain only when a check sees such a
move. Posts stop when the position stops changing, and momentum scrolling still reports its final
position. An element that keeps changing height between the current heading and the reading line
changes the position and can keep posting at most five times a second while it does. There are at
most five samples after the latest trigger, stopping early when a trailing check sees no movement,
to cover momentum and scrolls inside open shadow roots. A hidden document
element (native prototype `checkVisibility()` is false, or no client rects in the fallback) skips
measurement and posting, preserving the parent's saved position; the bridge then forgets its last
posted position, so the next visible measurement reports again. Scrolling inside a closed shadow root that
no input event reaches may not report. The parent validates it with the message schema and the open
doc's list, only after ready and before any unexpected load. Labels and quote text never enter position storage.
When no laid-out heading has reached the reading line, the bridge instead sends
`{ type: "recense:position", heading: null, fraction: 0 }`. This strict shape clears the stored
position and current Contents marker; it never stores a pseudo-heading. Back and reload return
to the document's top. A heading is laid out when the native `checkVisibility()` returns true;
where that method is unavailable, the bridge falls back to having client rects. Each measurement
visits the heading list once and reads each laid-out heading's viewport rect once.
HTML positions use `h-<decimal index>` plus the fraction in the existing position store; restoration
checks that index against the current doc's declared list before sending the freshly looked-up label.

The app's optional `view` search parameter accepts `reading` or `original`; other values are ignored.
Doc positions are keyed by review, doc, revision and view. Without `view`, HTML uses `original` and
Markdown uses `reading`. In slice A, HTML always renders Original layout and Markdown renders its
blocks, regardless of the requested view. The link hardener never emits `view`.

`ThreadView = { id, target: Target, state: ThreadState, placement: Placement, createdOn,
comments: { id, author: "user" | "agent", body, html?: string | null, outcome?: Outcome, sent: boolean,
sentOn: number | null }[] }`.
`html` is the comment `body`, a Markdown source, rendered on the server on every read through the same
sanitize pipeline as docs (including `hardenLinks`, so absolute web links carry `target="_blank"` and
`rel`, and `#123` links when the revision has a `repoUrl`), but without Shiki: a fence stays plain
`<pre><code>`, and a `mermaid` fence is a plain code block, not a diagram. It is never stored. It is `null`
(or absent) when the response's HTML budget is spent, when the comment is not rendered because the
response's uncached source budget is spent, or when rendering failed or took longer than about 2 seconds.
A comment that failed stays `null` for 10 minutes and is not retried on every read, and one failed
comment never blanks the others. A client then shows `body` as plain text. `#123` in a comment links to
the issue of the viewed revision's `repoUrl`. Unlike docs and the writeup, a comment keeps a single line
break inside a paragraph as a line break, as GitHub comments do; fences, inline code and raw HTML are
unchanged. `html` appears only here: hand-offs, `recense wait` and `recense feedback` output, MCP tools, export,
import and attach bundles keep the raw Markdown `body` and carry no `html`, and comment inputs are
unchanged. Budgets per response: 1 MiB of HTML in all, and 256 KiB of Markdown that is not already in
the server's cache. One comment's HTML is also capped at 256 Ki characters (a body that expands past it is
`null`, as a failure), and a body whose link and image references resolve to more than 32 Ki characters of
URL and title text in all is `null` too, before it is converted. One read waits at most 2.5 seconds for comment rendering; comments not done by then
are `null` in that response and fill the cache for the next read, and at most 64 renders wait in the
queue. The server keeps an in-process cache of at most 2000 rendered comments and 16 MiB
(each character counts as two bytes), keyed by the owner, the body and the `repoUrl`, and never writes it to disk.
`createdOn` is the creation revision's sequence. Placement belongs to the requested revision;
an absent placement is `unplaced/not-placed`. Comments are in durable insertion order,
regardless of clock changes. `sent` means the comment has a Send; agent replies retain their outcome.
`sentOn` is the positive revision sequence named by that comment's Send, derived from the stored
Send/revision relationship, never from timestamps. It is `null` for unsent comments and agent
replies, and stays the same when reading another revision.
`changedSince` is an optional positive revision sequence: the newest Send's revision, or 1
without a Send. It is the exclusive lower bound used by `changedBlocks`.
`changedBlocks` contains each block once, paired with the newest positive revision sequence in
which it changed after the reviewer's most recent Send's revision and through the requested revision.
This includes HTML part IDs `doc-<path hash>-<part hash>`. HTML docs' `changes` projects these
entries onto their stored parts in index order, carrying each entry's revision. A previous
revision without stored parts suppresses changes for that doc in the next comparison.
For example, a block changed in revisions 2 and 3 after a Send on revision 1 appears once with
`revision: 3` when reading revision 3, and with `revision: 2` when reading revision 2.
Blocks changed only at or before that Send are absent; before any Send changes start at revision 1.
The most recent Send is determined by insertion order, including approvals and set-aside Sends.
A requested revision at or before that Send has no changed blocks.
Every query is owner-scoped. Missing/foreign reviews return `404 unknown_review`; missing or
invalid sequences of an owned review return `404 not_found`. Agent tokens receive `403 forbidden`.

`GET /api/v1/agent/reviews` returns `AgentReviewList = { items: AgentReviewItem[] }` with
`AgentReviewItem = { id, title, branch, state: ReviewState, turn, newest, approved, updatedAt, url }`.
`branch` is the review's stored branch, `null` when the publish named none. `newest` is
`{ revision, head }` for the review's newest revision (highest `seq`), or `null` for a review that
has no revision. `approved` is `null` while no revision is approved, else `{ revision, head }` of the
revision the approval points at. On an open review, `turn` is `agent` when a Send that is not set
aside was made on the newest revision, else `reviewer`. It is `null` when the review is approved
or settled, or has no revision. This matches the inbox's Answered group: a Send on the newest
revision passes the turn to the agent; a new revision passes it back. The schema defaults a
missing `turn` to `null`, so clients can read lists from older servers or hubs.
`head` is the revision's stored head, unchanged: a full commit
id (40 or 64 lowercase hex characters), `"worktree"` or `null`. It needs the agent `publish`
scope and lists only the principal owner's reviews whose origin is the token's own instance, so a
machine token never sees another instance's or another owner's reviews. Items run newest
`updatedAt` first, review id as the stable tie breaker, at most `agentReviews` (100) rows, with no
pagination. Binned reviews are left out. The list has no other inbox filter: snoozed, approved and retired reviews appear with their
stored `state` (`open`, `approved` or `settled`). `updatedAt` is an ISO 8601 UTC string. `url` is
the review's address on this server. The list carries no comment bodies,
writeup text, doc content, tokens or other ids. A reviewer session receives `403 forbidden`.

The optional query `?head=<sha>` (`AgentReviewQuery = { head?: commit, key?: sha256 }`) keeps only reviews whose
approved revision's head equals `<sha>` or whose newest revision's head equals `<sha>`. The match
is exact and case-sensitive on the stored value; an older, superseded revision's head does not
match. `<sha>` is a full object id of exactly 40 or 64 lowercase hex characters: no prefix and no
`worktree`. The filter is applied together with the owner and origin-instance conditions, before the
ordering and the 100-row cap, so the cap counts matches. A malformed or repeated `head` is
`400 invalid_request`.

`?key=<key>` keeps only reviews whose stored review key equals the value exactly: 64 lowercase
hex characters, the `reviewKey` the publisher sent. For a code review, `recense publish` derives it
from the instance, the worktree root and the branch. With both `key` and `head`, both must match.
The key filter applies with the owner and origin-instance conditions, before the ordering and
the cap. A malformed or repeated `key` is `400 invalid_request`. Capabilities lists
`agent-review-key` when the server applies `key`; an older server ignores `key` and returns the
whole list, so a client checks that feature before it relies on the filter.

`head` and `branch` are the values the publisher sent; the server stores them unverified, and a
review without code files (docs or a plan only) shows the reviewer no diff of that commit. So
`approved.head === sha` means the reviewer approved a revision that its publisher labelled with that
commit, not that recense verified the commit's content was shown. A caller that gates on an approval
should require all of: `approved` is not null, `approved.head === sha`,
`approved.revision === newest.revision` (an import can carry an approval for an older revision) and
the expected `branch`; it should also make sure itself that the approved review carried the commit's
diff. `newest.head === sha` with `approved: null` means the commit is published but not approved.

This stays on the agent `publish` scope; it adds no scope. The new fields are metadata the same
instance's agent published itself (branch, head, revision number) plus the approval pointer, which
the agent already learns through the `approve` result of `wait`. The response still carries no
comments, writeups or docs, keeps the owner and origin-instance filter, and the call is a
read-only GET: it takes and confirms no delivery and writes no row.

Read-view bounds follow the write-side validators and rendering budgets; no history is truncated
to make a read fit a per-Send or per-revision limit. The limits below apply to the schemas above.

| Field | Bound and write-side source |
| --- | --- |
| `InboxList.items` | `inboxItems` × 4 + `pins` (850), the four inbox blocks plus each block's pinned rows beyond its cap |
| `AgentReviewList.items` | `agentReviews` (100), the agent list query limit |
| `AgentReviewItem.title` | `titleChars` (200), as in `InboxItem.title` |
| `AgentReviewItem.branch` | As `InboxItem.branch`: the stored branch or `null` |
| `AgentReviewItem.turn` | `reviewer`, `agent` or `null`; defaults to `null` when omitted |
| `AgentReviewItem.newest`, `.approved` | `{ revision, head }`: `revision` a positive integer, `head` a full commit id, `"worktree"` or `null` (as `RevisionView.head`); `newest` is `null` without any revision, `approved` while nothing is approved |
| `AgentReviewQuery.head` | Optional; exactly 40 or 64 lowercase hex characters, else `400 invalid_request` |
| `AgentReviewQuery.key` | Optional; exactly 64 lowercase hex characters, else `400 invalid_request` |
| `AgentReviewItem.updatedAt` | ISO 8601 UTC datetime string (`z.iso.datetime()`) |
| `AgentReviewItem.url` | HTTP(S) URL of at most `pathChars` (4096) characters |
| `InboxItem.title` | `titleChars` (200), including publish's nonblank requirement |
| `InboxItem.repo` | Nullable `Sha256`: exactly 64 lowercase hex characters, the published repository key, not the repository name |
| `InboxItem.project` | Nullable, otherwise 1 through `titleChars` (200) characters |
| `InboxItem.branch` | Nullable, otherwise 1 through `pathChars` (4096) characters, as in `PublishRequest` |
| `RevisionView.topics` | `topicsPerReview + 1` (201): up to 200 declared topics plus the reserved Other changes entry, as in publish |
| `RevisionView.files`, `RevisionView.docs` | Each at most `filesPerRevision` (10000), the publish file limit |
| `FileView.order` | Zero through `filesPerRevision - 1` (9999), the publisher's zero-based file-array index |
| `RenderedWriteup.sections` | At most `13 + 3 * topicsPerReview` (613): thirteen fixed sections and Why/Example/Details for each writeup topic |
| `RenderedWriteup.newInRevision` | Optional array of 1–`newInRevisionItems` (12) entries; each has optional `TopicSlug`, `NewInRevisionSection` and destination `blockId: BlockId` (neither `newInRevision-` nor `doc-`), and at most `blocksPerRevision` validated `newInRevision-` block IDs. Invalid stored values are omitted |
| `RenderedWriteup.needsYou` | Optional array of at most `needsYouItems` (4) entries; each has a `NeedsYouKind`, optional `TopicSlug`, and at most `blocksPerRevision` validated `needsYou-` block IDs. Invalid stored values are omitted |
| `RenderedWriteup.terms` | Optional array of at most `glossaryTerms` (50) entries: `term` 1–`glossaryTermChars` (100) characters, plain-text `definition` 0–`glossaryDefinitionChars` (2000) characters, and a validated `blockId: BlockId` |
| `RenderedWriteup.sections[].key`, `RenderedBlock.section` | Renderer-generated keys: overview, tldr, whyItMatters, newInRevision, needsYou, review, checked, notChecked, outOfScope, whereToLook, context, deviations, decisions, glossary or `t-<TopicSlug>-why/example/body`; block sections also allow `doc-<hash8>`. TopicSlug permits 1–64 characters, so the longest topic section key is 74 characters |
| `RenderedWriteup.sections[].label` | `titleChars + " — Example".length` (210), the longest renderer suffix appended to a topic title |
| Section `blocks` and Markdown doc `blocks` | Each at most `blocksPerRevision` (100000); the same limit also applies to all writeup blocks combined and to writeup plus doc blocks combined |
| `RenderedBlock.html`, `text`, `source` | Each bounded by `renderedBytesPerRevision` (268435456) UTF-8 bytes, the stored renderer output budget; source is optional |
| `RenderedWriteup`, Markdown doc block arrays, and revision rendered content | Serialized UTF-8 JSON must fit `renderedBytesPerRevision`, including escaping and structure. The revision budget combines the writeup, present doc title/heading metadata and nonempty Markdown doc block arrays; empty arrays can represent docs without stored rendered data and add no bytes to that combined read check |
| File/doc paths, `oldPath`, block IDs and `changedBlocks[].blockId` | Reuse `FilePath`/`BlockId`, including `pathChars` (4096), path segments of at most `pathSegmentChars` (255), and the existing format checks |
| Topics and section/file topic references | Reuse `TopicMeta`/`TopicSlug`: 64-character slugs, `titleChars`, `summaryChars`, `blastScopeChars` and `blastNoteChars` limits and their existing value checks |
| `ThreadView.comments[].body` | Reuses `CommentBody`: `commentBodyChars` (20000), nonblank, well-formed UTF-16 |
| `RevisionView.changedBlocks[].revision`, `ThreadView.comments[].sentOn` | Positive safe integer revision sequences; `sentOn` also accepts `null` |
| Thread targets and placements | Reuse `Target` and `Placement`, including their quote, context and line limits |
| IDs, sequences, counts, order, timestamps, states, flags, outcomes, base/head | UUIDs, safe integers, ISO UTC datetimes, finite enums/booleans and full 40/64-character commit hashes as specified above; head additionally accepts `worktree` |

These fields deliberately remain unbounded because their write side has no matching cap:

- `InboxItem.origin.name`: instance loading validates a string without a length limit; machine
  registration now requires 1–200 characters. Legacy local names remain unbounded.
- `InboxItem.movedTo`: the stored moved-to URL has no write-side length cap yet; its HTTP(S) URL
  format is still validated. HTML `contentUrl` has no independent URL-length cap; its decoded doc
  path uses `FilePath`, each segment must be canonically encoded, and the stored content key has no
  length validator. Applying `pathChars` to an encoded URL could reject valid non-ASCII paths.
- `FileView.mediaType`: the server chooses the media type from its mapping; no length validator
  exists at the storage boundary. It remains a string rather than acquiring an arbitrary new cap.
- `ReviewView.revisions`: publication is append-only with no lifetime revision-count cap.
- `RevisionView.threads`: thread creation has no per-review count cap. A per-Send comment limit
  does not bound the review's thread history.
- `ThreadView.comments`: neither cumulative user comments nor agent replies per thread are capped.
  Agent-reply retention is an open owner item; handoff/history limits restrict deliveries, not storage.
- `RevisionView.changedBlocks`: it unions changes across potentially unbounded revision history
  after the last Send. `blocksPerRevision` limits one revision and cannot cap this accumulated union.

Browser startup calls `configureBrowserValidation()` from the schema-free `@recense/contract/browser`
entry before dynamically loading the app and its schemas. It sets Zod's `jitless` option before
object construction (when Zod captures this setting), so validation never probes or compiles
`Function` under the app CSP. The normal contract index also exports the function.

`Capabilities = { api: 1, version: string, features: string[] }`. The current feature list is
`["attach", "html-docs", "mcp", "review-lifecycle", "review-bin", "review-groups", "review-pins", "review-pin-order", "agent-review-key", "diff-images"]`,
plus `server-stop` when the server supports stopping through the API; clients accept additional feature strings.

`PairingPurpose = "device" | "machine"`. `PairingRequest = { purpose? }` defaults to `"device"`.
`PairingCreated = { url, code, expiresAt }`: the HTTP(S) URL ends in `/pair#<secret>` with no query,
the code is eight canonical Crockford characters displayed as `XXXX-XXXX`, and the expiry is UTC.
`SessionRequest` accepts exactly one of `{ secret }` and `{ code }`. Codes accept lower case and
an optional middle hyphen, normalizing `I`/`L` to `1` and `O` to `0`. Secrets match
`^emp_[A-Za-z0-9_-]{43}$`. Unknown, used, expired and wrong-purpose pairings all return the same
`401 unauthorized`; session redemption accepts only `device`, machine registration only `machine`.
Redemption creates a browser device and reviewer token atomically. Revoked tokens or devices and
expired sessions are unauthorized. Session deletion revokes both and clears the cookie.
If a code matches multiple live device pairings, redemption is unauthorized and consumes none;
the individual secret links remain usable.

`PublishResponse = { reviewId, revision, url, placed, unplaced, unrendered: FilePath[], htmlLooks? }`.
An omitted `unrendered` field defaults to `[]`.
`htmlLooks` is an optional array of `{ path: FilePath, look: "emend" | "custom", colorScheme?: "light" }` (`"emend"` is the recense look on the wire, see "HTML docs"),
with at most `filesPerRevision` entries. It lists every rendered HTML doc's look in the new revision,
using the same metadata stored for that revision, including unchanged re-publishes. A null stored
look means `custom`. `colorScheme` is present only when that doc is stored as light-only, as in the
HTML doc view. HTML docs whose metadata work failed are in `unrendered` instead and are not listed.
New servers include `htmlLooks` even when empty. Older servers omit it; it has no default.
Without it, the CLI prints no HTML look or outside-elements notes. With it, the CLI reports the
server's look, and a light-mode note when the server stored the doc as light-only. It adds a local
reason and outside-elements advice only when its look and light-mode classification agree with the
server's.
HTML doc entries include `assets: FilePath[]`; rendered Markdown docs may include image assets.
Each listed path must be an asset in the request inside that doc's folder. The doc source plus its
own listed assets must fit `htmlDocWithAssetsBytes`; shared assets count for every doc listing them. Asset rows retain
their first parent, and their blob bytes count once toward the revision byte budget. Every rendered
doc's full asset list is stored, so a shared asset loads under each doc that lists it. Existing
revisions migrate their parent associations and retain parent-only asset access.
`unrendered` lists Markdown docs whose rendering failed, timed out or exceeded rendered-output budgets,
and HTML docs whose metadata work (title, Contents headings, look) failed or timed out
(at most `filesPerRevision`). Such an HTML doc still shows, as a custom page.
Rendered blocks and JSON bytes count every path, including the writeup.
Docs render in manifest order; once a doc exceeds either budget it and all later Markdown docs
remain unrendered. A writeup alone exceeding either budget returns 413 `too_large` with
"The writeup has too many blocks."
The CLI warns `recense: could not render <path>` for Markdown docs. When `htmlLooks` is present,
it reports only that a failed HTML doc shows as custom because recense could not read its structure.
The publish still succeeds.
The URL is `<baseUrl>/r/<reviewId>` (HTTP or HTTPS);
it is bounded by `pathChars` (4096 characters). At each start the local server saves its listening URL in `server-url.json` in the state
directory, mode 0600. With Tailscale, it replaces that value with the public origin only after
Serve setup succeeds; a failed startup keeps the loopback URL. With `--public-url`, it saves that
origin after the listener starts, without contacting the address. A successful start leaves its
confirmed base URL there on close. Direct publish uses that saved HTTP(S) origin;
a missing or invalid JSON record, credentials, path, query or fragment falls back to
`http://127.0.0.1:3636`. An attached machine publishes to the hub using its machine credential.
`revision` is a positive integer sequence, and the placement counts are nonnegative integers.

### Machines and import

`recense attach` refuses a hub whose capabilities lack `review-bin` while this machine holds an
unmoved binned review originating on this machine. It refuses before registering or copying
anything. A review binned during the copy is skipped when that hub lacks `review-bin`, including
on a resend, and stays in the local bin without being marked as moved.

`POST /machines` accepts `MachineRegistration`: exactly one of `secret` and `code`, with
`instance: { id: UUID, name: string }` (1–200 characters). Secret and code formats and
normalization match `SessionRequest`. Machine names must use the browser device-name allowlist: ASCII letters, digits, spaces and
`._()/;-`. Other characters are rejected with `400 invalid_request`. Names are then trimmed
and must contain 1–200 characters; blank names are rejected. Only a live unused machine pairing can redeem it;
wrong-purpose, expired, used and unknown pairings all return `401 unauthorized`. Code entry
shares the session endpoint's serialized server-wide lockout. Secret redemption remains available.
The current or any earlier self instance gives `400 wrong_origin`. An instance with a live
machine device gives `409 instance_attached`, with exactly: "This machine is already attached.
Revoke it in the hub's devices, or run recense detach on it." Neither refusal consumes the pairing.
Consumption, instance insertion (or name/attachedAt update), machine device creation and its
instance-bound agent token creation are one transaction. `201 MachineRegistered = { token,
hub: { id, name, url } }` returns the token once and the hub's self identity and pairing-link base URL.

`DELETE /machines/self` atomically revokes the calling machine's device and all its live bound
tokens, returning 204. Other agent tokens receive `404 not_found`. The instance and reviews remain.

`POST /import` accepts one `ImportBundle`, bounded by `publishJsonBytes`. Only a live machine
agent token may import; other agents receive `404 not_found`. Owner comes from that token and
`review.originInstanceId` must match it (`400 wrong_origin`). A review id already held by that
owner and origin returns `200 ImportResult = { skipped: true }` without writing. Any other owner
or origin holding that id gives the identical `400 wrong_origin`. A new copy returns
`201 { skipped: false }`. The copy uses the publish database writer lock and one transaction. Imports have their own
one-at-a-time validation/rendering slot, independent of publishing and reviewer thread creation.
A concurrent import receives `429 rate_limited` immediately with "The server is busy importing;
try again." Connection aborts stop rendering, release the slot, and prevent any review commit,
with the message "The import was cancelled." Inserts use batches of at most 500 rows and
check cancellation between batches.

Import-only count ceilings are `importRevisions` (1000), `importThreads` (1000),
`importComments` (10000), `importSends` (1000), and `importDeliveries` (1000). Writeups are limited to one per revision (at most 1000).
Over a count ceiling is `400 invalid_request`; the existing JSON byte ceiling still rejects
oversized bodies first with `413 too_large`. These bound one atomic import, not local review
lifetimes, which remain unbounded; histories exceeding these import ceilings cannot be attached
through this endpoint and stay local (part B reports this). There is no pagination or truncation of reviewer history.
`importRows` (50000) bounds all inserted rows, including the review, any repo and generated blob
metadata, revisions, topics, files, agent notes, doc assets, writeups, threads, hub-computed placements and
changed blocks, comments, Sends and retained deliveries. Potential repo/blob inserts are counted
conservatively even when already present. An excess is `400 invalid_request` before the writer
transaction starts. `importRenderedBytes` (1073741824, 1 GiB) bounds cumulative rendered writeup
and Markdown output plus doc title/heading metadata, counting each rendering even when content hashes repeat. Exceeding it stops
the import with `413 too_large`, without database rows; immutable files already staged may remain.
`htmlPartsPerImport` (1000000) bounds stored HTML part hashes across the import.

`importDerivedBytes` (67108864, 64 MiB) bounds the bytes of the hub-derived placement and
changed-block rows as stored: the UTF-8 byte lengths of every text and serialized JSON column
value, including ids, renamed paths and JSON escaping, plus 64 bytes per row. That allowance
excludes SQLite's index overhead. The hub counts
these values as each revision's rows are computed and stops immediately on excess with
`413 too_large`, before the writer transaction and without database rows. The pure contract
helper `importRowCount(bundle)` accepts a validated bundle and gives the known row count
(including derived placements) for CLI preflight. The hub adds generated blob metadata and
changed-block rows after rendering; derived storage bytes require the hub's computed rows.

`importPlacementBytes` (1073741824, 1 GiB) bounds placement inputs and repeated text work.
Document and writeup input bytes are charged each time they are parsed, plus their text's UTF-8
bytes once per relevant span thread per revision, including cache hits. Markdown and writeup
placement parse hub-rendered blocks and count their combined text; HTML uses source bytes and
extracted text. Parsed content is reused by format and blob hash, retaining at most content used
by the current and previous revision. Each lines thread charges the UTF-8 bytes of its next
side on every revision, and its previous side only when the two hashes differ, matching the
equal-hash placement shortcut. Each unique side buffer read/transferred per revision is also
charged. Each topic-quote thread charges its topic's title and summary UTF-8 bytes once per
revision, when the topic exists. The worker encodes parsed docs/writeups as bytes and reports
their encoded and text sizes; the hub keeps those bytes and sends transferred copies for placement.
Each shared parsed payload's encoded size is charged once per job that sends it, including cache hits.
Other worker metadata is counted incrementally as each string's UTF-8 length, plus fixed
overhead per object (16 bytes), entry (8 bytes) and scalar (8 bytes), including field names,
targets, anchors, carried paths, rename maps, file paths/hashes, topic slugs, document paths and,
when a topic quote is placed, topic titles and summaries.
Shared objects are counted once per job, as structured clone sends them; accounting never
builds the job's JSON or parses its content on the main thread. Raw buffers are counted
separately. Each addition checks the remaining budget first; excess stops with `413 too_large`
and no database rows.

Bundle fields are required arrays (empty where appropriate), except the additive `agentNotes`
and `diffImages` arrays, which may be omitted by older exports. UUID row ids are kept. All dates
are ISO UTC strings; nullable fields are explicitly null. Arrays preserve durable insertion order
for comments, threads and Sends; revisions are complete and ordered by sequence starting at 1.
Unknown keys, including owner ids, moved-to URLs, content keys, media types, `placements` and
`changedBlocks`, are stripped. Placements and changed blocks are derived by the hub, not supplied.

| Bundle field | Row fields |
| --- | --- |
| `review` | `id, originInstanceId, reviewKey: Sha256, repo: {key: Sha256, name} or null, project?: string or null, branch, title, state, approvedRevision: UUID or null, intentReviewId?: UUID or null, createdAt, updatedAt` |
| `revisions` | `id, reviewId, seq, base, head, main, writeupEmpty, createdAt` |
| `topics` | `id, revisionId` plus `TopicMeta` (optional door and blastRadius) |
| `files` | `id, revisionId, path, oldPath, role, status, topicSlug, ord, oldBlob, newBlob, renderedBlob, flag, parentDocId, title?, view?: DocView, look?: "recense" \| "custom" \| null, colorScheme?: "light" \| null`; nullable sides, status, topic, flag, parent |
| `docAssets` | `revisionId, docId, assetId` |
| `diffImages` | `fileId, side, blob, flag` per image side of a diff row in `files`. Each old or new side occurs once per file and carries either a SHA-256 blob or the oversized flag, with the other field null. |
| `agentNotes` | `id, fileId, ord` plus `AgentNote`; optional array, ordered per file, at most 8 per file and 64 per revision |
| `writeups` | `id, revisionId, sourceBlob, renderedBlob` |
| `threads` | `id, reviewId, target, state, createdRevisionId, createdAt, updatedAt` |
| `comments` | `id, reviewId, threadId, author, body, outcome, sendId, createdAt, updatedAt`; user outcome is null; agent outcome is required and sendId null |
| `sends` | `id, reviewId, revisionId, kind, mode, instruction, deliveryId, setAsideAt, createdAt`; Go requires mode; Approve has null mode/instruction |
| `deliveries` | `id, reviewId, leaseUntil, confirmedAt, createdAt` |

`review.project` is optional and nullable, otherwise 1 through `titleChars` (200) characters.
The hub keeps it when non-null; null or absent values fall back to `review.repo.name`, except `.git`, or null.
This value is stored on the copied review; a copy whose stored project is null links no repository row.

All ids are unique across the bundle and all references except `review.intentReviewId` stay within it. The hub computes each
thread’s creation placement from its target, refusing an unplaceable original target with
`400 invalid_request`, then carries it through every later revision as publish does. Changed
blocks are computed from consecutive hub renderings, with fresh row ids. Asset parent ids must name an HTML doc in the same revision.
A diff never receives a rendered doc blob even when its path matches a Markdown doc. Existing non-review ids
anywhere on the hub give `400 invalid_request`; no partial copy is written. Paths, topics, files,
writeup source, comment bodies, instructions, blocks and content sizes use the existing publish
and comment limits. Each revision has exactly one writeup. Blob references are owner-scoped:
upload them first using HEAD/PUT blobs. A missing reference gives `400 blob_missing` without writing.
Media types are chosen on the hub. Rendered writeup and Markdown blobs are untrusted derived
content: the hub regenerates them from source through the normal sanitizer and rendering budgets.
A file row that carries `look` keeps the stored look on the hub, null included, so a pub keeps the
look it was published with; `colorScheme` is kept only with `look: "recense"`. Both apply only to a
rendered HTML doc and are null on every other row. A row without `look` comes from an exporter
older than the default look, so its pub was published under the earlier rule, and the hub applies
that rule to the doc's source: the `recense-look` mark decides, else a page with its own styles is
`custom`, else `recense`. Such a row never gets `colorScheme`.
HTML content capability keys are freshly minted. `agent_waiters` and event state are not copied.
Confirmed deliveries are retained; unconfirmed deliveries are dropped and their Sends have both
`deliveryId` and `setAsideAt` cleared, making them available to the next take.

All imported timestamps are clamped to at most the hub clock at commit; historical values remain
unchanged. A different review id with the same owner/origin/review key is `400 invalid_request`
before rendering. Placement timeouts are `413 too_large`; other placement worker failures are
`400 invalid_request`, matching publish. Each writeup source is decoded, parsed and validated as
`WriteupInput` in the worker, once per source hash while it stays in use; a malformed or invalid
source, a worker failure or a timeout of that step is `400 invalid_request`. Generated immutable bytes are written as produced; only
hashes/sizes and one revision’s rendered buffers remain in memory, and owner blob references commit
with the review. Failed imports may leave unreferenced immutable bytes, as publishing does.

`ImportResult = { skipped, deleted? }`. A review the owner deleted on the hub is answered
`{ skipped: true, deleted: true }` (200): the hub keeps a tombstone by review id, so a repeated
`recense attach` never brings it back. A retired review is exported with its `settled` state; the
snooze is not part of the bundle. `review.binnedAt` is optional and nullable (an ISO timestamp,
clamped to at most the hub clock like the other timestamps); a review exported from the bin lands
in the hub's bin, and a bundle without it is not binned. A review the hub already holds, in its
bin or not, is skipped like any existing review and never restored by a repeated attach.

The hub records its copy time in nullable `ReviewView.importedAt`; ordinary local reviews use
null (older responses lacking this additive field parse as null). Imported `movedTo` is ignored.
The review page displays: "Copied from <origin name> on <date>. Comments, Sends and approvals
before then were made there." Machine import copies existing reviewer records; it does not grant
agent tokens the ability to create new user comments, Sends or approvals through ordinary routes.

### Devices

`DeviceList = { items: DeviceView[] }`, where `DeviceView = { id, kind, name, createdAt,
lastSeenAt, current }`. `id` is a UUID; `kind` is `"browser"` or `"machine"`; `name` is a string.
`createdAt` and non-null `lastSeenAt` are ISO 8601 UTC strings; `lastSeenAt` may be `null`.
Only non-revoked devices belonging to the authenticated owner appear, newest first. `current`
is true for the requesting reviewer's device; admin requests see false for every device.
Device activity timestamps retain their existing update policy.

Revocation is allowed for the current device: its next cookie-authenticated request is 401.
The device and its still-live bound tokens are revoked in one transaction; earlier token
revocation timestamps are preserved. An agent token has no
`devices:manage` scope and receives 403 for both device endpoints.

With `recense serve --tailscale`, pairing URLs use the configured Tailscale HTTPS origin (with
`--tailscale-port <n>`, that origin includes `:<n>`). With `recense serve --public-url <url>`, they
use the given HTTPS origin instead, including its port when not 443. The secret remains
exclusively in the fragment. Only the configured origin's Host is added to the allowlist.
Session cookies use `Secure` when that Host is requested, including renewal
and sign-out; loopback HTTP on the same server receives cookies without `Secure`.

### Manifest and topics

`PublishRequest = { reviewId?, reviewKey, repo: { key, name } | null, branch: string | null,
title, base: commit | null, head: commit | "worktree" | null, main?, topics, writeup, links?, repoUrl?, issueRefs?,
intentReview?, files }`.
The CLI sends `repo` for pubs too: the repository holding the working directory, or the
`--project` name. A publish with a non-null `repo` sets the review's project to `repo.name`;
a null `repo` keeps its current project. The repository row is linked once when the review
is created, and a publish never renames a repository row.
`main` follows the manifest's type and doc-membership validation below; the CLI carries it unchanged.
The keys are lowercase 64-character SHA-256 hex; `reviewId` is a UUID. Repo names obey
`titleChars`, branches `pathChars`, and title, commits and writeup obey the manifest limits.
There are at most `topicsPerReview` declared topics plus the optional generated Other changes
topic (importance 100, last); at most `filesPerRevision` files. Base and head are null together.
`PublishFile = { path, oldPath: FilePath | null, role, status?, topic?, title?, view?: DocView, oldBlob: sha256 | null,
newBlob: sha256 | null, flag: FileFlag | null, parent?: FilePath, assets?: FilePath[], notes?: AgentNote[], image?: DiffImage }`.
Only a diff file with a status may carry `image: { old, new }`. The old side is null exactly for
an addition, the new side exactly for a deletion. Each present side requires a supported extension
on its own path and contains either `{ blob: sha256 }` or `{ flag: "oversized" }`. Image blobs
are limited to `assetBytes` (25 MiB) each and count once per distinct hash across all inputs
toward `revisionBytes`. When a side also has a text blob, its image must carry the same hash.
The text side keeps its 1 MiB limit. For HTTP publish and attach, the destination must advertise
`diff-images` to receive `image` fields or `diffImages` rows. Otherwise the CLI omits them and
uploads only blobs referenced by the remaining fields. Direct publish keeps image sides.
Paths and topic slugs are
unique within their namespaces (diffs; rendered docs and assets; source docs); file, writeup,
newInRevision and needsYou topics must be declared. Verdict topics are not checked against them.
`assets` is required for rendered HTML docs (including an empty array), optional for rendered Markdown
docs, and absent on other files, including source-view docs. Lists contain no duplicates, and each
path names a request asset inside the doc's folder. Markdown lists allow only png, jpg, jpeg, gif,
webp and avif (case insensitive), with no hidden segments.
Assets name a declared rendered HTML or Markdown doc in `parent`, stay inside its folder and have
no hidden or dot segments. A Markdown parent's assets allow only those image extensions. HTML asset
extensions are js, mjs, css, png, jpg, jpeg, gif, svg, webp, avif, ico, bmp,
woff, woff2, ttf, otf, mp4, webm, ogg, mp3, wav and m4a (case insensitive). Shared assets are
published once, with the first doc as parent. Diff rows always have media type `text/plain`.
An asset with no `parent` is writeup media. Its extension is png, jpg, jpeg, gif, webp or avif
(case insensitive), no segment starts with `.`, and it has no `topic`, `assets` or `notes`. No
HTML doc lists it in `assets`; Markdown docs may list the same row without duplicating it.
A request holds at most `mediaPerRevision` (50) of them. Media have
no `FileRole` of their own; they use `role: "asset"` and never appear in file lists, counts or
viewed progress. Only assets have parents. Docs and assets have a new blob, no old side and no flag; flagged
diffs have null text blobs. Source filenames never leave the CLI.

`HEAD /api/v1/blobs/:sha256` returns 204 for an owner's blob whose content is stored at the recorded
size, otherwise 404 `not_found` (a row without its file counts as missing, so the client uploads it again).
`PUT` takes raw bytes with a required nonnegative integer `Content-Length`, at most `assetBytes`,
the largest limit for a doc, asset or diff side, and returns 204. Missing/malformed length or hash is
400 `invalid_request`; hash or actual length mismatch is 400 `blob_mismatch`; excess size is 413 `too_large`.
Content-Length is checked first; credentials and scope are checked before reading any body bytes.
Blob lookups never expose another owner's content.

Publish resolves an explicit id only for the authenticated owner and origin instance, otherwise
404 `unknown_review`. A moved review returns 409 `review_moved`, and a review in the bin 409 `review_in_bin`. Without an id the server
atomically finds or creates by owner, token instance and review key. Missing referenced blobs
return 400 `blob_missing`. Each successful publish adds a revision, reopens the review, and
reports placement counts for that revision. Media types and role size limits are server enforced.
Publish refuses a writeup image path that normalizes (see Writeup and Markdown doc media) but is not listed under
`media` (a parentless asset in the request), with 400 `invalid_request` and "A writeup image path
is not listed under media."
No review, revision, file or writeup row is stored. Remote images are still dropped.
Import continues to accept previously published writeups with unlisted image paths.
Rendering and placement run in a worker: failed or timed-out Markdown docs have no rendered
blocks; failed writeups return 400 `invalid_request` with "The writeup could not be rendered."
A writeup exceeding 10 seconds returns 413 `too_large` with "The writeup rendering timed out."
At most two publishes compute at once per server process. Further publishes wait up to 30 seconds,
then receive 429 `rate_limited`, "The server is busy publishing; try again." Conflicting attempts
reuse rendered results and retry snapshot/placement at most three times. A disconnected request
is abandoned before commit and its workers are stopped. The CLI publish deadline is 30 seconds
for a slot, plus 15 seconds, plus 10 seconds per writeup/Markdown/source doc, plus three 30-second
placement attempts. A timeout reports "the server did not answer in time; nothing was published".
Each blob upload of a CLI publish allows 5 seconds plus 1 second per MiB, rounded up (30 seconds for a
25 MiB asset); an attach copy allows 30 seconds per blob.
Placement exceeding 30 seconds returns 413 `too_large` with "The placement timed out."
Other placement failures return 400 `invalid_request` with "The comments could not be placed."
These failures never leave a partial revision.

`PublishManifest = { version: 1, title, base?, head?, main?, topics: TopicMeta[], files, media?, writeup,
links?, issueRefs?, intentReview?, repoUrl? }`. `links`, `repoUrl` and `issueRefs` are described under "Links and repoUrl" at the end of
this section.

`main?: "writeup" | FilePath` declares the opening page. A path must name a file of this
manifest with `role: "doc"`; otherwise validation issues `["main"]` with the message
`main is not a doc of this revision`. `"writeup"` opens Writeup even if its Markdown is empty.
`base` and `head` appear together or neither appears. Commits are fully resolved lowercase hex
object ids (40 characters for SHA-1 or 64 for SHA-256); `head` also accepts `"worktree"`.
Docs-only reviews can omit both. Manifest files are `{ path, role: "diff" | "doc", topic?, source?, title?, view?: DocView, notes?: AgentNote[], prepared? }`;
`source` is a non-empty local filename from which the CLI reads a doc, separate from its published
path. It may be absolute or relative, has at most `pathChars` characters, must be well-formed UTF-16,
and cannot contain NUL, C0 controls or DEL.

`recense prepare --base <commit> --head <commit|worktree> --dir <folder>` creates `review.json` in an existing
private folder outside the worktree and its git folders, with a title, the range, empty topics and writeup, and one diff per changed path.
Only a diff accepts `prepared: { status: FileStatus, oldPath?: FilePath, added?, removed?, flag?: FileFlag, lockfile?: true, doc?, docRefusal?: string }`.
Renames carry the old path. Line counts are nonnegative integers up to `diffSideBytes` and are omitted for flagged
files, a count failure or an exhausted count budget. Only Markdown and HTML paths carry `doc`.
An `included` doc follows its diff as a separate file entry. A `deleted` doc has no new side.
`differs-from-head` means the disk copy is missing, is not a regular file, or differs from the head commit;
with a worktree head, the copy changed while prepare ran.
Only `refused` may carry `docRefusal`, a one-line reason of at most 1000 characters.
Publish ignores `prepared` and omits it from the request.

`media?: { path: FilePath, source? }[]` lists images that the writeup embeds, at most
`mediaPerRevision` (50). A `path` ends in png, jpg, jpeg, gif, webp or avif (case insensitive;
SVG and video are refused), has no segment starting with `.`, is unique among media, and never
equals a doc's path. `source` follows the doc `source` rules. The CLI resolves `source ?? path`
exactly like a doc source (the worktree or a `docRoots` folder, regular files only, no symlink
out, none in the git folder), and reads at most `assetBytes` (25 MiB) from each. The real source's
extension must equal the path's extension, ignoring case. Each image is published as a
parentless `asset` file and counts toward `filesPerRevision` and `revisionBytes`. A media path
that equals an HTML doc's asset path is refused; a rendered Markdown doc may list that same
media row as an image asset. The writeup embeds an image with
`![Alt](path)`.

Only a `diff` entry accepts `notes`; docs and assets reject the field, even an empty array.
`AgentNote = { side: "old" | "new", start, end, summary, rationale?, ref? }` uses positive integer
line numbers, with `end >= start`. `summary` is 1–160 characters on one line; `rationale` is at
most 1200 characters. Neither summary nor a present rationale may be blank (whitespace only).
Both are plain text, never rendered as Markdown or HTML. `ref` is one
capital ASCII letter (`A`–`Z`), unique within the file's topic in that revision, including Other
changes. There are at most `agentNotesPerFile` (8) per file and `agentNotesPerRevision` (64) per
revision. The CLI carries notes unchanged into publish.

Publish and import check every note against the stored side: every line in `start..end` must
exist, from 1 through that side's line count. Unchanged lines within a file with changed content
are valid and the diff opens collapsed context around notes. Equal old and new blobs (a pure
rename or mode-only change) refuse notes with "the file's content does not change" and the file
and zero-based note index. A missing side, a flagged file (binary or oversized), or an
out-of-bounds range is refused with `400 invalid_request`, naming the file and zero-based note
index. Notes are never silently dropped. They are immutable revision content: publishing again
adds new rows, and export/import carry them with their ids and order. There is no note-edit API.
A topic writeup may cite a note with `<span class="ref">ref A</span>`; matching refs navigate to
the note in that topic, while unmatched refs remain text. Chips are offered only for notes on
files with a topic; refs remain unique among files without a topic (shown as "Other files").

The CLI resolves `source` with `realpath` and reads it only when the resolved result is a regular
file inside the repository's worktree root or inside a folder the reviewer listed in their own
global recense configuration (`docRoots`). Neither the repository nor the manifest can name an allowed
folder. The worktree root follows the rules `docRoots` follow: the CLI refuses to publish from a
repository whose root is the filesystem root, the home folder or a folder that holds it, or a
folder that holds recense's state folder or sits inside it. A symlink leading outside these roots is
refused. The role's size limit applies.
Plan task 1.6 implements and tests these checks. Assets are collected during publish.
Markdown image discovery runs in a worker under the render timeout (10 seconds), for both
path and `--manifest` publishing. Distinct references keep their first-seen order and total at
most `markdownDocBytes` UTF-8 bytes; discovery stops when the next reference would exceed it.
At that cap, the CLI warns once for the doc: `some images left out: too many image references`.
If discovery fails or times out, the CLI warns once with an escaped argument or review path
and the fixed reason `published without images: image discovery failed or timed out`.
The doc still publishes, with no images.
Markdown image references must pass the renderer's local-path normalization and every CLI
asset path check. A leading `./` is allowed; encoded separators such as `%2F` are skipped.
Image filenames that look secret-like are skipped as "may hold a secret", including
secret-looking names such as `api-key.png`. HTML discovery is unchanged.

The general `FileRole` vocabulary is `diff`, `doc`, `asset`; `FileStatus` is `added`, `modified`,
`deleted`, `renamed`, `mode-changed`; `FileFlag` is `binary` or `oversized`.
`FilePath` also rejects a segment equal to `.git` or `git~1` after lowercasing and removing
trailing dots/spaces, and rejects HFS-ignorable code points U+206A–U+206F.

`TopicMeta = { slug, title, importance, summary, attention?, door?, blastRadius? }`. A slug matches
`^[a-z0-9][a-z0-9-]{0,63}$`. Importance is a number from 0 through 100; lower sorts first.
Attention is optional and holds the topic's risk. The app shows `critical` as High (data loss,
a security hole, money, or an outage), `review` as Medium (a common path can break, and users
notice) and `skim` as Low (a rare path that tests cover, or a mechanical change). The words carry
no colored fill; High is the only red one.
Skim topics start folded in the writeup. Attention never changes order: `importance` alone sorts.
When absent, attention stays absent in views and export/import, and the topic starts open.
Door is `one-way` or `two-way`. The app shows it only as an Undo sentence: `two-way` as "Undo: a
revert", `one-way` as "Undo: a revert is not enough". The recense-review skill no longer sets it; a
topic names a repair or a step that cannot be undone in an **Undo:** line of its `why`.
Blast radius is `{ scope, note }`: scope is one non-whitespace word, and note must contain
non-whitespace text. The skill uses scope as a plain sensitivity tag (`auth`, `data`, `money`,
`privacy`, `network`) or names who is affected. The fallback is `{ slug: "other", title: "Other changes" }`;
declaring that slug in a manifest fails with `topic slug other is reserved`. It remains a valid
target for automatically grouped changes.

Topic slugs and file paths within each role must be unique within a manifest. A file's topic and every writeup topic
key must name a declared topic. A topic may omit its writeup entry. Titles must contain non-whitespace
text. There are at most `topicsPerReview` declared topics and writeup topic keys. Summaries,
blast-radius scopes and notes obey `summaryChars`, `blastScopeChars` and `blastNoteChars`.
Markdown strings are preserved exactly; the schema does not render or sanitize them.

`WriteupInput = { overview, tldr, whyItMatters?, newInRevision?: NewInRevisionItem[], needsYou?: NeedsYouItem[], area?, review?, checked?, notChecked?, outOfScope?, whereToLook?, context?, deviations?, decisions: string | null, glossary?, topics }`.
Sections are Markdown strings, except `newInRevision?: NewInRevisionItem[]`, `needsYou?: NeedsYouItem[]`, `area?: WriteupArea`, `glossary?: string | GlossaryEntry[]` and `review?: ReviewVerdict`;
`topics` maps slugs to `{ why, example?, body? }`, also Markdown. Decisions is
required, with `null` representing no decisions section.
`whyItMatters` is nonblank Markdown: what the change gives the product or prepares for.
`newInRevision` is optional and additive under `/api/v1`, holding at most `newInRevisionItems` (12) items.
`NewInRevisionSection = "overview" | "tldr" | "whyItMatters" | "checked" | "notChecked" | "outOfScope" | "whereToLook" | "context" | "deviations" | "decisions" | "glossary"`.
`NewInRevisionItem = { text: string, topic?: TopicSlug, section?: NewInRevisionSection, quote?: string }`: text is nonblank,
well-formed UTF-16 Markdown of 1–`newInRevisionChars` (300) characters on one line. Blank text is
refused with `newInRevision text must not be blank`; malformed UTF-16 with
`newInRevision text must be well-formed UTF-16`; CR, LF, U+2028 and U+2029 with
`newInRevision text must be one line`. Naming both topic and section is refused at `section`
with `a newInRevision item names a topic or a section, not both`. A topic must be declared;
both publish schemas report `newInRevision topic is not declared` at `writeup.newInRevision.<index>.topic`.
An optional `quote` names a few words from one block and may stand alone or accompany a topic
or section. It is 1–`newInRevisionQuoteChars` (120) characters, nonblank, well-formed UTF-16 and
one line; the refinement errors are `newInRevision quote must not be blank`,
`newInRevision quote must be well-formed UTF-16` and `newInRevision quote must be one line`
(CR, LF, U+2028 and U+2029 are refused). A quote containing only whitespace, `*`, `_` and
backtick characters is refused with `newInRevision quote must contain text`.
After rendering all sections, the renderer searches only `t-<slug>-why`, `-example` and `-body`
for a topic, only the named section for a section, or every writeup section except
`newInRevision` and `needsYou` for a quote alone. Matching makes two passes over the
same scope and section order. The first normalizes both quote and block text to NFC, collapses
whitespace runs to one space and trims the ends, preserving all other characters. Both passes
compare block text as rendered, without removing literal `*`, `_` or backtick characters.
Only if the first pass finds no match, the second reads the quote as Markdown with GFM: it joins
text and inline-code values in document order, uses a space for a hard line break and ignores
HTML nodes, then applies the same NFC and whitespace normalization to that plain text.
Each pass skips an empty normalized quote; the first block whose normalized text contains the
normalized quote wins, case-sensitively. No match emits no `blockId`, leaving the usual topic or
section fallback (and no jump for an unmatched quote alone). Quotes are matching hints, not
rendered Markdown, and do not contribute to `writeupEmpty` or the Markdown byte sums.
A thirteenth item is refused with `at most 12 newInRevision items`; the CLI reports
`invalid publish manifest: writeup.newInRevision (at most 12 items)`.
For an invalid section the CLI reports `writeup.newInRevision.<index>.section (overview, tldr, whyItMatters, checked, notChecked, outOfScope, whereToLook, context, deviations, decisions or glossary)`.
For an invalid topic slug it reports `writeup.newInRevision.<index>.topic (topic slug: lowercase letters, digits and -, at most 64)`;
for an undeclared topic, `writeup.newInRevision.<index>.topic (newInRevision topic is not declared)`.
These forms follow `invalid publish manifest: `. The endpoint refuses an invalid list with
`400 invalid_request` before storing a revision. An empty list gives no section or metadata.
The app shows the card only from revision 2; a first publish leaves the field out.
`needsYou` is optional and holds at most `needsYouItems` (4) items.
`NeedsYouKind = "decide" | "accept" | "confirm-drift" | "answer"`.
`NeedsYouItem = { kind: NeedsYouKind, text: string, topic?: TopicSlug }`: text is nonblank,
well-formed UTF-16 Markdown of 1–`needsYouChars` (300) characters on one line. CR, LF, U+2028
and U+2029 are refused with `needsYou text must be one line`. A topic must be declared;
both publish schemas report `needsYou topic is not declared` at `writeup.needsYou.<index>.topic`.
A fifth item is refused with `at most 4 needsYou items`; the CLI reports
`invalid publish manifest: writeup.needsYou (at most 4 items)`. The publish endpoint refuses
an invalid list with `400 invalid_request` before storing a revision.
`area` is plain text, never Markdown. `WriteupArea` accepts 1–`areaChars` (60) characters,
with non-whitespace text, well-formed UTF-16, no control or format characters (`Cc` or `Cf`),
no U+2028 or U+2029, and no filler characters U+115F, U+1160, U+3164, U+FFA0 or U+2800.
These opening fields are optional and additive under `/api/v1`.
The fields `outOfScope`, `whereToLook`, `context`, `review`, `checked` and `notChecked` are optional, additive fields under `/api/v1`.
`ReviewVerdict = { level: "skim" | "topics" | "everything", topics?: TopicSlug[], reason }` is
accepted as `review` from older agents and not shown. Its shape is still checked: `topics` is
required for level `topics` and refused for the other levels; it holds 1–`topicsPerReview` unique
topic slugs. `reason` is Markdown with non-whitespace text and counts toward the byte limits.
recense no longer checks it against the declared topics or their attention, renders no Review
section for it, and leaves out the Review section an older revision stored, in the app and in
the writeup download.
`checked` (what the agent ran or verified) and `notChecked` (what it did not) are Markdown with
non-whitespace text.
When any of these fields or `whyItMatters` or `area` is present (`outOfScope`, `whereToLook` and
`context` count even as an empty string), sections render as TL;DR, Why it matters, Checked,
Not checked, Overview, Out of scope, Where to look, Context, Decisions and drift, Glossary, then
topics; absent optional fields emit no section.
Without them, the existing order stays Overview, TL;DR, Decisions and drift, Glossary, then topics,
including when an import re-renders stored source.
Nonempty `newInRevision` and `needsYou` lists add New in this revision and Needs you sections,
in that order: after Why it matters and before Checked in the new order, or after TL;DR and
before Decisions in the old order. Neither field selects the new layout by itself. Each item's
text renders separately through the same sanitizer, link hardener and Shiki pipeline, with
unique block IDs across its list (`-2`, `-3` suffixes for repeats). The download includes New in
this revision as an h2 followed by the items' blocks in order, only from revision 2. Like the
app, the writeup download skips this section on revision 1.
Every Markdown string is limited to `writeupSectionBytes` UTF-8 bytes; the sum of all present
`overview`, `tldr`, `whyItMatters`, `outOfScope`, `whereToLook`, `context`, `deviations`, `decisions`, `glossary`, `why`, `example`
and `body` strings, including every list glossary term, definition and alias, is limited to
`writeupBytes`. Each `newInRevision` and `needsYou` item's `text`, the verdict's `reason`, `checked` and `notChecked` count toward both limits too.
These limits measure UTF-8 bytes, not character count. Parsed `topics` has a null
prototype: an absent `topics["constructor"]` is `undefined`, while an explicitly declared
`constructor` topic remains accessible and serializes normally.

A list glossary holds at most `glossaryTerms` (50) entries. `GlossaryEntry` is
`{ term: string, definition: string, aliases?: string[] }`. Terms and aliases are nonblank,
well-formed UTF-16 strings of 1–`glossaryTermChars` (100) characters, with no code points below 32,
127–159, U+2028 or U+2029. The character limit also applies after NFC normalization, collapsing
whitespace runs to one space and trimming; an overlong normalized form produces
`glossary term exceeds the character limit after normalization`.
Each entry has at most `glossaryAliases` (8) aliases. A definition is
nonblank Markdown of 1–`glossaryDefinitionChars` (2000) characters. All terms and aliases must
be distinct after NFC normalization, collapsing whitespace runs to one space, trimming and
`toLowerCase()`; duplicates produce `duplicate glossary term` at the entry's term or alias index.

Only the review writeup marks terms: the first use of each entry in each section, including
separate topic Why, Example and Details sections. Matches stay within a text node, skip headings,
links (including issue links), code, pre, kbd, samp, images and their captions, diagrams and existing
marks, and require whole-word boundaries (no adjacent Unicode letter, mark, digit or underscore).
Forms match without regard to case, except forms with no lowercase and at least two uppercase
letters, which require exact case. A trailing `s` or `es` also matches; aliases supply other forms.
Spaces match whitespace runs; the longest form wins at the same position. Marks have a dotted
underline and show a definition card on hover, focus or tap, with a link to the glossary entry.
The glossary starts folded even when changed; navigation to an entry opens it. Old Markdown
glossaries render as before and get no marks. HTML docs declare their own glossary; see "Glossary in an
HTML doc".

#### Glossary in a Markdown doc

A Markdown doc (a published doc, or a code review's doc) declares its own glossary inside the doc:

```
## Glossary

- **Budget** (also: allowance, quota):
  Attempts a worker may spend.
- **Hub:** The machine the phone reaches.
```

The glossary is the first top-level heading (any level) whose text, trimmed with whitespace
collapsed, equals "Glossary" ignoring case, followed directly by one list (`-`, `*` or `1.`). Only
that first heading counts. Each list item starts with a bold term. The term is followed by `:`
inside the bold text (`**Hub:**`), or by an optional `(also: a, b)` group and then `:` after it
(`**Budget** (also: a, b):`). The same group may sit inside the bold text (`**Budget (also: a):**`).
The definition is the rest of the item, nested lists and later paragraphs included, as plain text,
whitespace-normalized and cut to `glossaryDefinitionChars` with a closing `…`, as in a list glossary.
An item that does not fit this shape, has a blank definition or an invalid or repeated term is
skipped. An invalid or repeated alias is dropped. Terms and aliases follow the manifest glossary's
rules (`GlossaryForm`, with whitespace collapsed first, so a line break inside a term reads as one
space; duplicates compared case-insensitively after normalization). At most
`glossaryTerms` entries and `glossaryAliases` aliases per entry count; later ones are ignored.

The renderer marks the first use of each term and alias elsewhere in the doc, with the same rules
as the writeup, and never inside the glossary list or headings. Marking in a doc walks a prefix tree
of the terms and aliases and stops after 10,000,000 steps. A step is charged for each tree lookup per
character compared, each whitespace character a space in a term consumes, each start position tried,
each form that ends on the way, each character of the `s`/`es` suffix check and each character of an
acronym's exact check. The first time a character is case-folded and the first time it is classified
as a word character cost 32 steps each. A text node that must be split into graphemes costs 256 steps
plus 32 steps per character; ordinary ASCII text does not need that split, but a match with a
non-ASCII character at its edge does, and a Markdown text node that is not in NFC is charged the same
up front, even without a match. Ordinary English prose costs about 1.2 to 2 steps per character (1.2
when few words start a term, about 1.9 against 50 terms made of common words), so the budget covers
about 5,000,000 to 8,000,000 characters of it. Non-ASCII prose in paragraphs of about 1,000 characters
that each hold a match with a non-ASCII edge costs about 33 steps per character, so the budget covers
about 300,000 characters of it. Spending the budget takes about 0.25 s or less on every shape measured
(median of five runs). Not charged, each linear in the text: building the tree (3 to 6 ms for 450
forms), the check for a run of more than 30 combining marks (about 20 ns per byte on one two-byte
mark after each ASCII character, so 21 ms for a 1 MiB doc and 0.17 s for 8 MiB) and normalizing each
text node to NFC. The 30-mark rule keeps every reordered run to at most 63 non-starters, so that cost
stays linear: an input built to need the most reordering (U+1F82, then 13 × U+0344, 9 × U+0F75 and
8 × U+0F73, repeated) takes about 55 ns per byte, which is 58 ms at 1 MiB and 0.46 s at 8 MiB.
A text node with a run of more than 30 combining marks in a row gets no marks, and a glossary item
whose term or definition has such a run is skipped (an alias with one is dropped): normalizing a
longer run in the wrong order takes quadratic time, and real text never has one. When the budget
is spent, marking stops for the rest of the doc: the text node being read gets no marks, earlier
text nodes keep theirs, and later first uses stay unmarked. `RevisionView.docs[].terms` lists
the entries in marking order; the app opens the same card as the writeup's, whose "Glossary" link
jumps to the entry's block. A doc without such a section has no `terms` and no marks. Terms are
stored beside the doc row, are not part of the export bundle, and the import re-renders them from
the doc source.

#### Glossary in an HTML doc

An HTML doc (a pub, or a code review's doc) declares its own glossary inside the doc:

```
<h2>Glossary</h2>
<dl>
  <dt>Budget</dt>
  <dt>allowance</dt>
  <dd>Attempts a worker may spend.</dd>
  <dt>Hub</dt>
  <dd>The machine the phone reaches.</dd>
</dl>
```

The glossary is the first `<dl>` after the first `h1`-`h6` heading whose text, whitespace collapsed
and trimmed, equals "Glossary" ignoring case. A `<dl>` may group its `dt` and `dd` in `div` children.
A run of `dt` followed by one or more `dd` is one entry: the first `dt` is the term, each further `dt` an
alias, and the `dd` texts joined with a space the definition, as plain text, whitespace-normalized
and cut to `glossaryDefinitionChars` with a closing `…`. Terms and aliases follow the manifest
glossary's rules (`GlossaryForm`, with whitespace collapsed first). An entry with a blank definition
or an invalid or repeated term is skipped; an invalid or repeated alias is dropped; at most
`glossaryTerms` entries and `glossaryAliases` aliases per entry count.

The bridge checks only the first 1,024 `h1`-`h6` headings, the Glossary heading included, so a doc
with more headings before its Glossary heading gets no glossary. Its other limits:

- 10,000 `dt`/`dd` items.
- A walk of 100,000 nodes.
- Only the first 800 raw characters of each heading's text are read, and the read also stops after
  6,400 nodes. "Glossary" must end within those 800 characters, so a heading with 793 or more
  characters before the word gets no glossary, and text after those 800 characters is ignored.
- Each `dt` and each `dd` yields at most 20,000 characters of text, read from at most 20,000 nodes.
- The same 10,000,000-step marking budget as a Markdown doc, with the same charges. The checks that are
  not charged cost about 0.17 s (mark runs) and 0.46 s (NFC) at the 8 MiB HTML limit, from about 20 and
  55 ns per byte on the inputs named in the Markdown section above.
- A text node with a run of more than 30 combining marks in a row gets no marks, and a `dt` or `dd`
  with such a run makes its entry invalid (an alias with one is dropped), as in a Markdown doc.

The bridge inside the frame does all of the work. At ready it reads the glossary, marks the first use
of each term and alias in its own spans (dotted underline, focusable, never inside the glossary, a
heading, `a`, `code`, `pre`, `kbd`, `samp`, `textarea`, `title`, `button`, `select`, `option`,
scripts, styles or non-HTML elements), and opens the same short card as the writeup on hover (after
500 ms), focus, tap and Enter or Space, with a "Glossary" control that scrolls to the entry's first
`dt`. Marking follows the writeup's rules per text node; it can differ on text that is not NFC and
across inline elements. The card is plain text in a closed shadow root. No frame message carries the
glossary, and the parent app does not change. A doc without such a `<dl>` looks as it did.

#### Links and repoUrl

`links?: PublishLink[]` holds at most 8 entries `{ url, label, kind?: "pr" | "issue" | "other" }`.
`url` is an absolute `https:` URL of at most 2048 characters, without credentials, whitespace or
control characters. `label` is 1 through 60 characters of visible text, without control or format
characters. An invalid link refuses the request (`400 invalid_request`). Links are not Markdown, they
are never counted in `writeupEmpty`, and so a docs-only publish with links stays `kind: "publish"`.

`repoUrl?` is exactly `https://host/owner/name`: a lowercase ASCII host with an optional port, and two
path segments of `A-Za-z0-9._-` (not `.` or `..`), with no userinfo, query or fragment. The CLI derives
it for code reviews and pubs published from inside a repository, except pubs named with `--project`;
pubs outside any repository get none. It uses `remote.origin.url` (SSH, scp-style and `git://` remotes
become https, a trailing `.git` goes away; a path, a `file:` URL, `http:`, a remote with credentials,
or a remote host without a dot, such as an ssh alias, gives none). A manifest's own `repoUrl` wins
when it is valid; an invalid string in a manifest is dropped and the derived one is used, but one in a `PublishRequest` is refused. A manifest
may set `"repoUrl": null` to opt out: the CLI then sends no `repoUrl` and no `#123` links render. With a
`repoUrl`, the server turns `#123` in rendered writeup and Markdown doc text into a link
to `<repoUrl>/issues/123`, never inside code, a fence, a diagram or an existing link. A number is 1
through 7 digits and must follow a non-word character. In HTML docs, the bridge links `#123` text
after the parent's `recense:repo`; clicks follow the `recense:issue` flow in the HTML frame section.

`issueRefs?: IssueRef[]` holds at most 64 entries `{ number, title, state: "open" | "closed" | "merged" }`,
one for each issue or pull request number the writeup names as `#123`. `number` is an integer from 1
through 9999999, and each number appears at most once. `title` is 1 through 256 characters of visible
text, not blank and without control characters (`Cc`), format characters (`Cf`), default-ignorable
code points (Unicode `Default_Ignorable_Code_Point`: fillers such as U+3164, variation selectors, tag
characters) or U+2800. An invalid entry in a `PublishRequest`
refuses it (`400 invalid_request`). A manifest cleans each title first: each run of whitespace and
control characters becomes one space, format characters, default-ignorable code points and U+2800 go,
spaces collapse, and the result is trimmed and cut to at
most 256 UTF-16 code units without splitting a surrogate pair. An entry still invalid after that (a
blank title, a bad number or state, a repeated number) fails the manifest, like an invalid link.
Markup in a title stays literal text. The server never calls GitHub: the agent reads titles and
states and sends them. A revision view returns `issueRefs`, empty when none were sent. The server's
`#123` anchors carry `data-recense-issue="<number>"`; sanitize drops author `data-*` first, so only
server-made anchors have it. The CLI sends `issueRefs` only with a `repoUrl`. A number without an entry stays a plain link. Clients show a title as
plain text, never as HTML. Downloads show no title.

`links`, `repoUrl` and `issueRefs` ride in the writeup's source and rendered blobs, so an import or export keeps them; no table
changes. Every absolute `http:` or `https:` link in rendered Markdown carries `target="_blank"` and
`rel="noopener noreferrer nofollow"`, including an absolute link back to the same recense review. Clients
open `links` the same way, after checking again that each URL is https, and show each link's host
(punycode for a non-ASCII host) beside its label, with the full URL as the title.

#### Intent reviews

A manifest and a `PublishRequest` may set `intentReview`: the id of the review that holds the
approved intent for this change. It and `writeup.deviations` come together; either one alone is
refused (`400 invalid_request`), and so is a request whose `reviewId` equals its `intentReview`.

The server accepts only a review of the same owner and the same origin instance as the publishing
token, not in the bin and not moved. Anything else is `404 unknown_intent_review`, so a missing and
a foreign id look the same. A code review found by its key that names itself is `400 invalid_request`.
Each publish sets the review's intent review to the request's value, or clears it when the request
has none. The relation belongs to the review, not to one revision.

`GET /api/v1/reviews/:id` returns `related`: the intent review this review names (role `intent`),
then the reviews that name this one (role `code`), newest update first, at most `relatedReviews` (8).
Id ascending breaks ties. Each entry has `id`, `role`, `title` and `state`. Reviews in the bin, moved
reviews, reviews of another origin instance and ids that name no review of this owner are left out.
A review never lists itself. The relation is never checked against approval; the app shows the state.

`writeup.deviations` is nonblank Markdown and renders as the section "Deviations from the approved
intent", right before "Decisions and drift", through the same sanitize pipeline as every writeup
section. It does not select the new layout by itself.

An import bundle carries `review.intentReviewId`, an optional nullable UUID. A bundle whose
`review.intentReviewId` equals `review.id` is refused with `400 invalid_request`. An id that names no
review on the receiving server resolves to nothing until that review arrives. Attach copies it the
same way; an absent field imports as null.

### Targets and placement

`Target` is discriminated by `kind`:

| Kind | Fields |
| --- | --- |
| `writeup-span` | `blockId`, `quote`, `prefix`, `suffix` |
| `doc-span` | `path`, `blockId`, `quote`, `prefix`, `suffix` |
| `html-span` | `path`, `quote`, `prefix`, `suffix` |
| `lines` | `path`, `side: "old" | "new"`, `start`, `end`, `lines`, `before`, `after` |
| `source-lines` | `path`, `start`, `end`, `lines`, `before`, `after` |
| `file` | `path` |
| `topic` | `slug`; for a quote on the title or summary also `part: "title" \| "summary"`, `quote`, `prefix`, `suffix` (all four or none) |
| `review` | No additional fields. |

Every span quote is non-empty; prefix and suffix may be empty. Line numbers are positive integers,
1-based and inclusive: `end >= start`, and `lines.length === end - start + 1`. Blank lines are valid
entries. Both context arrays are required and hold at most three strings each.
There are at most `targetLines` quoted lines. Each `before` and `after` entry has at most
`contextLineChars` characters. The combined UTF-16 length of all `lines`, `before` and `after`
entries must not exceed `targetTextChars`; an excess is a validation issue on `lines`.
No text is truncated: placement on later revisions requires the exact original text.

Published and target paths are relative, slash-separated paths. Empty components, `.` and `..`
components, absolute paths (including drive prefixes), backslashes, NUL, ASCII controls and DEL
are rejected, as are C1 controls U+0080–U+009F, bidi controls U+061C, U+200E–U+200F,
U+202A–U+202E, U+2066–U+2069 and zero-width U+200B–U+200D, U+2060, U+FEFF.
Paths must be well-formed UTF-16, with at most `pathChars` characters overall and
`pathSegmentChars` characters per slash-separated segment. These schemas do not perform
filesystem access.

`Placement` is `{ status: "placed", location: PlacementLocation }` or
`{ status: "unplaced", reason }`. Reasons are `block-gone`, `ambiguous`, `topic-gone`, `file-gone`
and `lines-gone`, plus `not-placed`: the server holds no placement for this revision.
Missing placement rows are delivered as `unplaced` with `not-placed` and the original target.
Locations use the target's `kind`. Span locations contain `start` and `end`
instead of quote/context; offsets are zero-based UTF-16 indices with an exclusive end greater than
start, within the normalized block text or HTML document text. Writeup spans retain `blockId`;
doc spans retain `path` and `blockId`; HTML spans retain `path`. Line locations contain `path`,
`side`, `start`, `end`, using the same 1-based inclusive convention. Source-line locations omit `side`.
Topic locations carry `slug`, plus `part`, `start`, `end` for a quote, with span offsets within the
normalized title or summary text. File and review locations use the same fields as their targets.
Placement describes the newest revision; a thread keeps its original target separately.
A topic quote follows the writeup-span rules, with the topic's title and summary as its blocks.
The part it was last placed on is the same block only while its normalized text is unchanged.
There the quote alone places it when it occurs once, otherwise the quote with its prefix and
suffix when they occur once in that part. Otherwise the quote with its prefix and suffix must
occur exactly once across the title and summary. A whole-title or whole-summary quote has an
empty prefix and suffix. Otherwise it is unplaced as `ambiguous` or `block-gone`; a gone topic
is `topic-gone`.

### Snooze, retire, delete and the bin

All ten routes (the five below, bin, restore and the three `/bin` routes) are reviewer-only (scope `send`): an agent or admin bearer, or a reviewer token
sent as a bearer, is refused before any lookup. A missing or foreign review is `404 unknown_review`.
Each runs in one transaction and emits its event after the commit. A wrong state is `409 invalid_state`.
Capabilities lists the features `review-lifecycle` and `review-bin`.

- `POST /reviews/:id/snooze`, body `SnoozeRequest = { until: datetime } | { untilRevision: true }`
  (strict, exactly one). `until` must lie in the future and at most `MAX_SNOOZE_DAYS` (366) days
  out, else `400 invalid_request`. Only an `open` review may be snoozed. A snooze ends at its time
  (computed on read, with no timer), on `unsnooze`, and when a new revision is published. A Send
  does not end it. Snoozing a snoozed review replaces the snooze. Returns 204; emits `snooze`.
- `POST /reviews/:id/unsnooze` clears the snooze and sets `updatedAt` to now, so the review sorts as
  just updated; it is idempotent. Returns 204; emits `unsnooze`.
- `POST /reviews/:id/retire`, body `RetireRequest = { discardUnsent?: boolean }` (a missing body means
  `{}`). Only an `open` review may be retired. Unsent user comments give `409 unsent_comments`
  unless `discardUnsent` is true; then they are deleted, with every thread left without comments.
  It sets `state` to `settled` and clears the snooze. It does not set `releasedAt`. A Send or
  Approve on a retired review is `409 invalid_state`. A publish adds a revision and reopens it.
  Returns 204; emits `retire`.
- `POST /reviews/:id/reopen` sets a `settled` review to `open`; any other state is `invalid_state`.
  Returns 204; emits `reopen`.
- `DELETE /reviews/:id` removes the review's revisions, topics, files, notes, writeups, threads,
  comments, placements, viewed marks, Sends, deliveries and waiter rows in one transaction, and
  records a tombstone `{ ownerId, reviewId, deletedAt }`. The same transaction drops the review's
  repository row when no remaining review of the owner references it. Returns 204 once that
  transaction commits; emits `delete` (its `revision` is the newest one before the delete). After
  the response, each blob that no remaining row of the owner references is removed, in batches. A
  failure there is logged and never changes the response. A later take on the id is `404 unknown_review`. A publish with
  the same key creates a new review with a new id and URL.

- `POST /reviews/:id/bin` moves a review to the bin. It sets `binnedAt` to now and changes nothing
  else: state, snooze, approval, `updatedAt`, revisions, threads, comments, Sends, deliveries and
  viewed marks stay. A moved review is `409 review_moved`; a review already in the bin is
  `409 review_in_bin`. Returns 204; emits `bin` (its `revision` is the newest). Nothing leaves the
  bin on its own: no timer or purge removes a binned review.
- `POST /reviews/:id/restore` clears `binnedAt` and nothing else, so the review returns to the list
  and place it had. A review that is not in the bin is `409 invalid_state`. Returns 204; emits
  `restore`.
- `GET /bin` returns `BinView = { items: BinItem[], total: number, more: boolean, version: string }` with
  `BinItem = { id, title, machine, binnedAt }`. `machine` is the name of the review's origin
  instance. Items run in `binnedAt` descending, `id` ascending order, at most `binItems` (200)
  rows per page. Optional query parameters `beforeAt` (ISO datetime) and `beforeId` (UUID)
  continue strictly after that item in this order. Give both or neither; one alone or an invalid
  value is `400 invalid_request`. `more` is true when items remain after this page; `total` counts
  every binned review of the owner, across all pages. Moved local copies are not listed or counted
  in the local bin: the hub's copy is the live one in the hub's bin. `version` is the SHA-256,
  encoded as 64 lowercase hex characters, of the sorted ids of every binned, unmoved review of
  the owner, joined by `\n`. Items, `total`, `more` and `version` come from one SQL snapshot; every page of
  an unchanged bin carries the same version. Any bin, restore, import, move mark or delete that
  changes this membership changes the version, regardless of timestamps or clock adjustments.
- `DELETE /bin/:id` deletes the review exactly like `DELETE /reviews/:id`, but checks inside the
  delete transaction that it is still in the bin. Otherwise it returns `409 invalid_state`.
  A missing, foreign or other-owner review is `404 unknown_review`; a moved local copy is
  `409 review_moved`.
- `DELETE /bin` requires `EmptyBinRequest = { version: string }` (strict), with 64 lowercase hex
  characters; a missing or invalid body is `400 invalid_request`. The web sends the `version`
  from its first loaded page, frozen with the displayed `total` when the confirmation dialog
  opens. Before deleting anything, the server reads the owner's current binned, unmoved ids and
  their version in one read. If the version differs, it returns `409 invalid_state` with
  `bin_changed` detail and deletes nothing. The web closes the dialog, refreshes the bin and shows
  the server's message. Empty bin selects exactly the confirmed set or deletes nothing; each selected review
  is deleted exactly like `DELETE /reviews/:id`: its own transaction, its tombstone, its
  repository cleanup and its `delete` event after the commit, and blob cleanup after the response.
  Each transaction checks again that the review is still in the bin, so a review restored
  meanwhile stays. A review binned or imported after the version read is outside the selected
  ids and stays. The loop yields between reviews. Returns 204. If a later delete fails, earlier
  deletes stay committed and their blob cleanup still runs; the request returns the delete error.
- `DELETE /reviews/:id` keeps working on a binned review and deletes it for good.

A binned review acts as deleted for agents and leaves every list. A take (`recense wait`,
`recense feedback`, the MCP tools), a waiter, an agent reply, a publish to it by id or by key, and
every reviewer read or write of the review, its revisions, files, threads, comments, Sends, viewed
marks, snooze, retire and reopen answer `409 review_in_bin`. `/media/:sha256` is the exception:
an image used only by binned reviews answers `404 not_found`, as described under Writeup media.
A moved local copy takes precedence over the bin: reads by id return the normal view with
`movedTo`, and its revisions, files and media remain readable. Mutations still answer
`409 review_moved`, including bin and restore. Confirming or releasing a delivery that
was claimed before the review was binned stays available. The inbox, its counts and the agent list
leave binned reviews out. The content path is unchanged. A missing, foreign or other-origin review
stays `404 unknown_review`. A publish that is refused with `review_in_bin` adds no review and no
revision; blobs uploaded before it stay unreferenced, as after any failed publish. Bin ends a
waiting take at once, like retire and delete.

A take that finds no deliverable Send, on a review that is retired or snoozed, answers
`closed` (below) when the request lists `"closed"` in `accepts`, and `409 review_closed`
otherwise, so a client that does not know `closed` stops instead of waiting. A pending Send is
delivered first. `closed` is a status answer, not a hand-off: it repeats on every later take while
the review stays retired or snoozed. Retire, snooze, bin and delete end a waiting take at once; `unsnooze`
and `reopen` never end one.

### Inbox groups

All four routes use `/api/v1` and scope `send`, reviewer-only: an agent or admin bearer,
or a reviewer token sent as a bearer, is refused before any lookup. Groups belong to the
reviewer's owner on this server and are shared across that owner's devices. A missing or foreign
group is `404 not_found`; a missing or foreign review is `404 unknown_review`. A malformed path
UUID is 404. Each write runs in one transaction and emits its `groups` event after commit.

- `POST /groups`, body `GroupRequest = { name: GroupName }`, returns 201 `InboxGroup = { id, name }`.
- `PATCH /groups/:id`, the same body, returns 200 `InboxGroup`. Renaming to its own name is allowed.
- `DELETE /groups/:id` returns 204. It removes membership and the group; its items return to
  Active, Snoozed or Done according to their state and the normal caps.
- `PUT /reviews/:id/group`, body `ReviewGroupRequest = { groupId: UUID | null }`, returns 204.
  A UUID moves the review or pub to that group, replacing its previous membership; null removes
  it from its group. A binned review is `409 review_in_bin`; a moved review is `409 review_moved`.

Bodies are strict (unknown fields give `400 invalid_request`). `GroupName` trims surrounding
whitespace and requires 1–`groupNameChars` (80) characters after trimming, with no Unicode `Cc`
control characters or line/paragraph separators. Invalid names give `400 invalid_request`.
Names also refuse bidi controls U+202A–U+202E and U+2066–U+2069; other format characters, including U+200D, are allowed.
Names are unique per owner by exact match. A duplicate name gives `409 invalid_state` with the
message "A group with this name exists.". Creating beyond `groups` (50) gives `409 invalid_state`
with the message "You have the most groups allowed. Delete one first.".

Membership changes nothing on the review: no state, snooze, approval or `updatedAt` change.
The membership's `created_at` uses the server clock on both insertion and reassignment.
It survives new revisions, snooze, retire, approve, reopen and the bin; restore brings the item
back to its group. A hard delete removes membership. Attach/import copies no groups or membership.
The agent list (`GET /api/v1/agent/reviews`), CLI, MCP and skills do not show groups.
The move event carries `{ reviewId }`; create, rename and delete carry `{}`. Owner-wide streams
receive both forms; per-review streams receive only events naming that review.
Capabilities lists `review-groups` (`REVIEW_GROUPS_FEATURE`).

### Inbox pins

`PUT /reviews/:id/pin` uses `/api/v1` and scope `send`, reviewer-only: an agent or admin
bearer, or a reviewer token sent as a bearer, is refused before any lookup. Pins belong to the
reviewer's owner on this server and are shared across that owner's devices.
The body `ReviewPinRequest = { pinned: boolean }` is strict (unknown fields give
`400 invalid_request`); success returns 204.
`pinned: true` gives a new pin the next `pinOrder` after every pin the owner has, bin and moved
pins included, so it joins at the bottom of Pinned.
Pinning a pinned review keeps its pin time and `pinOrder`.
`pinned: false` removes the pin.
Unpinning an unpinned review is a 204 no-op.

A missing or foreign review is `404 unknown_review`; a malformed path UUID is 404.
A binned review is `409 review_in_bin`. Pin and unpin of a moved review are `409 review_moved`.
Pinning beyond `pins` (50, counting pinned reviews in the bin but not moved reviews) gives `409 invalid_state`
with the message "You have the most pins allowed, pins in the bin included. Unpin one first.".
Each write runs in one transaction and emits a `pins` event `{ reviewId }` after commit;
owner-wide streams and that review's streams receive it.

`PUT /reviews/:id/pin/place` uses `/api/v1` and scope `send`, reviewer-only.
An agent or admin bearer, or a reviewer token sent as a bearer, is refused before any lookup.
The body `ReviewPinPlaceRequest = { before: string } | { after: string }` is strict and names a review UUID.
Both keys, neither key, an extra key or a non-UUID value give `400 invalid_request`.
It moves the pin directly before or after that other pin and renumbers the owner's pins 1..n in the new order.
Bin and moved pins are included and keep their relative places.
An anchor equal to the review itself is a 204 no-op with nothing written.
Success returns 204.
A malformed path UUID is `404 not_found`.
A missing or foreign review is `404 unknown_review`.
A binned review is `409 review_in_bin`.
A moved review is `409 review_moved`.
A missing or foreign anchor gives `404 not_found`, with the same response for both.
A review that is not pinned, or an owned anchor that is unpinned, binned or moved, gives `409 invalid_state`
with the message "The pins changed. Check them and try again.".
Each move runs in one transaction and emits a `pins` event `{ reviewId }` after commit.
A move changes neither `pinnedAt` nor anything on the review, including its state and `updatedAt`.

A pin changes nothing on the review: no state, snooze, approval or `updatedAt` change.
It survives new revisions, snooze, retire, approve, reopen, a move to a group and the bin.
A binned review is in no list.
Restore brings it back pinned with its old pin time and `pinOrder`.
A moved review shows `pinnedAt: null` and `pinOrder: null` in the list and single-review view and is in no Pinned section.
It keeps its pin row but does not count toward `pins`.
A hard delete removes the pin. Attach/import copies no pins.
The agent list (`GET /api/v1/agent/reviews`), CLI, MCP and skills do not show pins.
Capabilities lists `review-pins` (`REVIEW_PINS_FEATURE`).
Capabilities lists `review-pin-order` (`REVIEW_PIN_ORDER_FEATURE`).

### Sends, replies and waiting

`CreateThreadRequest = { revision, target: Target, body: CommentBody }` creates a thread
and its first user comment (201 `ThreadCreated = { threadId, commentId }`). The target must
place at the same location on the named revision or receive `400 invalid_target`; it is also
placed on every newer revision. Concurrent publication retries placement up to three attempts,
then returns `409 publish_conflict` without creating anything.
`AddCommentRequest = { body }` returns 201 `CommentCreated = { commentId }`.
`EditCommentRequest = { body }` returns 204. Deletion, resolve and reopen return 204.
Editing or deleting a sent user comment returns `409 comment_frozen`; an agent comment returns
`404 not_found`. Deleting the last comment deletes the thread and its placements.
Adding a user comment sets its thread to `open`, including from sent, answered, or resolved.
Mutations on a moved review return `409 review_moved`, except confirmation of an existing
delivery, which remains available so receipt can be recorded. Foreign or missing thread,
comment and delivery ids return `404 not_found`,
including ids from another origin instance for an agent.

`TakeRequest = { waitSeconds?, maxBytes?, accepts? }`: `accepts` lists result kinds the client can
parse beyond Go, Approve and Pending; today only `"closed"`, default none. `waitSeconds` defaults to 0; finite values from 0 through
`MAX_TAKE_WAIT_SECONDS` (25), including fractions, are accepted. Optional `maxBytes` is an integer
from 65536 through `handoffBytes` (16777216); out-of-range or non-integer values return
`400 invalid_request`. It narrows both the claim's byte window and history trimming to
`min(maxBytes, handoffBytes)`. Omitting it keeps the full handoff budget. Leading approvals and
the first queued Go form one unit: if that unit cannot fit, the take returns `413 too_large`
and claims nothing. An approval without a queued Go remains deliverable. A window already
containing a Go still sets aside included approvals and leaves later oversized Sends queued.
On this route only, a missing or zero-length body means `{}` even without Content-Type.
A nonempty body must be JSON.
A take returns 200 `WaitResult`. Each owner may have `waitingTakesPerOwner` (32) waiting takes;
additional waits receive `429 rate_limited`. Before a waiting take retries and before returning,
its token is rechecked through the committed-read connection. Revoked or expired credentials
receive `401 unauthorized` and leave no delivery claimed by that request.
Confirm takes no body and returns 204, with no JSON response. Only a live unconfirmed lease can
be confirmed: a late or repeated confirm returns `404 not_found`.

`GET /api/v1/events` delivers every event for every review owned by the authenticated
reviewer's owner, with no review lookup. `GET /api/v1/reviews/:id/events` stays for
compatibility and delivers only that owned review's events. Both require the same reviewer
principal and scope; `HEAD` returns headers only and allocates no stream. Both SSE
endpoints use `text/event-stream`, `Cache-Control: no-store` and a keepalive every
25 seconds. The keepalive is an SSE event named `ping` with the data `{}`: it carries no review
data and is not a `ReviewEvent`. (A comment line would fire no browser event, and an event with
an empty data buffer is never dispatched.) A client may treat about 40 seconds without any frame
(`ping` or review event) as a dead stream and reconnect. `ReviewEventName` is
`publish | send | thread | waiting | claimed | confirmed | viewed | snooze | unsnooze | retire | reopen | delete | bin | restore | groups | pins | themes`. `ReviewEvent` has a `type`
discriminator and the same fields as its SSE payload. The SSE `event` line supplies
`type`; the JSON `data` is:

| Event | Payload |
| --- | --- |
| `publish` | `{ reviewId, revision }` |
| `send` | `{ reviewId, revision, sendId }` |
| `thread` | `{ reviewId, revision, threadId, commentId? }` |
| `waiting` | `{ reviewId, revision }` |
| `claimed` | `{ reviewId, revision }` |
| `confirmed` | `{ reviewId, revision, deliveryId }` |
| `viewed` | `{ reviewId }` |
| `groups` | `{ reviewId? }` |
| `pins` | `{ reviewId }` |
| `themes` | `{}`; global streams only, to every owner |
| `snooze`, `unsnooze`, `retire`, `reopen`, `delete`, `bin`, `restore` | `{ reviewId, revision }` |

Review events contain ids and, except for `viewed`, `groups` and `pins`, a positive revision sequence only,
never paths, text bodies or instructions. `themes` carries no fields and goes only to global streams.
`claimed` follows a successful take; `confirmed` follows a successful
delivery confirmation. `viewed` follows a successful viewed-mark PUT and invalidates that
review's revision queries. These events are emitted after the transaction commits. Events have no
replay ids; clients refresh their cached state on every connection, including the first.
The waiting event signals a change: `agentWaiting(ownerId, reviewId)` is true while a take waits
for a Send, from the moment its first read finds nothing to return, and for 35 seconds after the
last waiting take ends without a result. That grace bridges the gap between take rounds. A take
that returns a Send or `closed` ends the waiting state at once, grace included, unless another
take on the same review is still waiting. Views also include
unexpired direct waits, which do not emit waiting events. Each owner may open 32 streams
across both endpoints combined; additional streams return `429 rate_limited`. A stream
buffering over 100 events is closed. Device revocation and session logout close that
device's session streams immediately after the revocation commits, across both endpoints.
Other sessions remain open. The session is also rechecked when a stream starts and at each
25-second `ping`; expiry or revocation outside these routes closes the stream at that
check.

`ThreadState` is `open`, `sent`, `answered` or `resolved`. `Outcome` is `fixed`, `explained`,
`held` or `declined`; `resolved` is never an agent outcome.

| Go mode | Exact label |
| --- | --- |
| `fix-clear` (default) | Fix what's clear, ask about the rest |
| `explain` | Explain only, change nothing |
| `fix-all` | Fix everything |

`SendRequest = { revision, kind: "go" | "approve", mode?, instruction? }`.
Only a Go accepts mode and instruction; an Approve supplying either is rejected. An omitted mode
stays omitted during parsing; the Send handler applies `DEFAULT_MODE = "fix-clear"`. A Go may have
an empty instruction when comments supply the feedback. The handler refuses a Go with no unsent
comments and no instruction (`empty_send`), and an Approve with unsent comments (`unsent_comments`).
Both name the newest revision or fail with `stale_revision`. Each Send owns the comments it sends;
comments saved afterwards wait for the next Send.
Creation returns 201 `SendCreated = { sendId }`. A Go that would bind more than
`commentsPerHandoff` comments, or whose own content exceeds `handoffBytes` in serialized JSON,
returns `413 too_large`, binding none. The byte check includes the response envelope, comment
metadata and space for placement and truncation metadata, so removing history always suffices
to deliver an accepted Send. Blank instructions do not supply feedback.
Comment bodies and Send instructions must be well-formed UTF-16. Lone surrogates are
`400 invalid_request`; valid surrogate pairs are preserved.

`ReplyRequest = { outcome: Outcome, body }`. Bodies must contain non-whitespace text and are
preserved without trimming. Sent user comments are frozen. Only the reviewer resolves or reopens
threads; an agent reply leaves a resolved thread resolved, and other states become answered.
Replies must target a sent user comment; a draft or an agent comment returns `404 not_found`.
`POST /comments/:id/reply` returns 201 `ReplyCreated = { commentId, threadId, state: ThreadState }`,
where `state` is the thread's state after the reply. It creates neither a Send nor a delivery.

`WaitResult` has four variants:

- Go: `{ kind: "go", reviewId, deliveryId, revision, sentOn, mode, modeLabel, instructions: string[],
  approvalSetAside: boolean, comments: HandoffComment[] }`.
- Approve: `{ kind: "approve", reviewId, deliveryId, revision }`.
- Closed: `{ kind: "closed", reviewId, deliveryId, revision, reason: "retired" | "snoozed", until: string | null }`.
  Sent only to a client that lists `"closed"` in `accepts`. `until` is the snooze's wake time, null
  when `reason` is `retired` or the snooze lasts until the next revision. The `deliveryId` names a
  delivery without Sends, confirmed like any other; until it is confirmed and while its lease runs,
  later takes on the same review reuse it. Confirming that delivery sets the review's `releasedAt`
  and `releasedReason` (and emits `confirmed`); taking it does not. Each take keeps at most one
  confirmed delivery without Sends for the review. A wait started on a retired or still-snoozed
  review gets `closed` at once. A Send that arrives first is delivered instead.
- Pending: `{ kind: "pending", reviewId, waitedSeconds }`.

For Go, `revision` is the newest revision used for placement, and `sentOn` is the revision sequence
of the newest Go included in the delivery; `sentOn <= revision`. The mode comes from that newest
Go and `modeLabel` must exactly match it. Instructions are merged in creation order, each subject
to the instruction limit. `waitedSeconds` is a finite nonnegative number, permits fractional elapsed
seconds, and is not capped by the per-request take limit. The CLI's default total timeout is 540 s.

`HandoffComment = { id, threadId, target: Target, placement: Placement, body, history, historyTrimmed? }`.
History entries are `{ author: "user" | "agent", body, outcome?: Outcome }`. Every body has the
comment limit. The original target and current placement remain separate, including when unplaced.
Each comment carries at most `historyPerComment` history entries. A Go carries at most
`commentsPerHandoff` comments and `instructionsPerHandoff` instructions.
History contains the newest `historyPerComment` eligible entries below that comment's own
rowid, returned oldest first in durable insertion order. Eligible entries are earlier agent
replies and sent user comments in that thread. Drafts and every comment delivered by this
handoff are excluded, regardless of clock changes. `historyTrimmed: true` means "some history
was left out, by the per-comment cap or the byte budget"; it is absent when all history is kept.
Sends and delivered comments also use insertion order. The serialized UTF-8 `WaitResult`
must fit `handoffBytes` (16777216 bytes), or the take's smaller `maxBytes` when provided.
The guarded claim selects whole Sends in FIFO order under the count and byte caps, leaving the
rest queued. It budgets comment bodies, placement metadata, instructions and space for truncation
flags before reading history, then loads history only for the selected comments. Byte accounting
measures JSON components without building an oversized string.
Without `maxBytes`, the first Send is always claimed, as its required payload fits the Send-time
check. With `maxBytes`, if even that first Send with all history removed cannot fit, the take
returns `413 too_large` and claims nothing. If the selected comments' history exceeds the budget, entries
are removed in global insertion order, oldest first, from every comment carrying them. Each entry costs its
serialized bytes times the number of comments carrying it. Sizes determine the retained suffix
before history bodies are loaded, and every affected comment carries `historyTrimmed: true`.
Comment bodies and instructions are never truncated.

MCP takes use `maxBytes: 3145728` (3 MiB) so the escaped text copy, structured result, and
JSON-RPC envelope fit the SDK's 10 MiB stdio message limit. A `413` becomes a tool error directing
the agent to run `recense feedback <review>` in a shell; the Send stays queued. CLI takes retain
the full budget.

`target.quote`, `prefix`, `suffix`, `lines`, `before` and `after` are text from the repository or
the agent's own documents, quoted for placement. Only the comment `body`, `history[].body` written
by the user, and `instructions` are the reviewer's words; history entries authored by an agent
remain that agent's words. An agent must treat quoted target text as data, never as instructions.

A delivery lease lasts `LEASE_SECONDS = 120`. A take holds for at most
`MAX_TAKE_WAIT_SECONDS = 25`. Claiming is atomic and receipt requires explicit confirmation;
an expired unconfirmed lease offers the same feedback again and re-evaluates its set-aside
approvals. A stale approval clears review approval only if it names the approved revision;
a newer approval remains intact.
A merged Go and Approve delivers Go with `approvalSetAside: true`. The CLI prints one JSON object
for Go, Approve, Closed or Pending and exits 0; errors print one line to stderr, nothing to stdout,
and exit 1. A take on a deleted or unknown review prints `review <id> was deleted or never existed`
(`review <id> was deleted on the hub` for a local copy that moved to the hub). A take or a reply on
a binned review prints `review <id> is in the bin`. `recense publish --review <id>` on one prints
`review <id> is in the bin. Restore it in Settings, or publish without --review and with a new
--key for a new review.`, and a publish by key prints `the review this publish would update is in
the bin. Restore it in Settings, or pass a new --key for a new review.`
Synthetic examples live in `packages/contract/fixtures/wait-*.json`.

## Limits

`LIMITS` exports these exact ceilings. Character counts use JavaScript string length (UTF-16 code
units); writeup byte counts use UTF-8 encoding. Routes reject a JSON body over its applicable byte
limit with `413 too_large` before parsing. Upload content also has the role's byte limit.

| Constant key | Maximum |
| --- | ---: |
| `themes` | 50 files listed |
| `themeFileBytes` | 32768 bytes per file |
| `themeFontFiles` | 16 font entries per theme |
| `themeFontBytes` | 4194304 bytes per font file (4 MiB) |
| `themeProblems` | 20 problems per theme |
| `inboxItems` | 200 rows per inbox block (at most 800, plus each block's pinned rows beyond its cap, at most 50 in all) |
| `groups` | 50 inbox groups per owner |
| `pins` | 50 pinned reviews and pubs per owner, the bin included, moved reviews excluded |
| `groupNameChars` | 80 characters per trimmed group name |
| `agentReviews` | 100 reviews returned in the agent list |
| `relatedReviews` | 8 code reviews related to one intent review |
| `binItems` | 200 reviews returned in the bin list |
| `importRevisions` | 1000 revisions per import |
| `importThreads` | 1000 threads per import |
| `importComments` | 10000 comments per import |
| `importSends` | 1000 Sends per import |
| `importDeliveries` | 1000 deliveries per import |
| `importRows` | 50000 inserted rows per import, including derived rows |
| `importRenderedBytes` | 1073741824 bytes cumulative rendered output per import |
| `importDerivedBytes` | 67108864 stored text/JSON bytes plus row overhead for hub-derived rows per import |
| `importPlacementBytes` | 1073741824 placement input and repeated text-work bytes per import |
| `publicJsonBytes` | 4096 bytes per public session or machine registration JSON request body |
| `commentBodyChars` | 20000 characters |
| `instructionChars` | 4000 characters |
| `quoteChars` | 2000 characters, non-empty |
| `prefixSuffixChars` | 32 characters each |
| `diffContextLines` | 3 lines per side |
| `titleChars` | 200 characters |
| `headingsPerDoc` | 1024 h2/h3 entries per doc |
| `htmlPartsPerDoc` | 10000 nonempty own-text parts per HTML doc |
| `htmlPartsPerRevision` | 100000 HTML parts across doc paths; the first doc that would exceed this and every later HTML doc store no parts |
| `htmlPartsPerImport` | 1000000 HTML parts across imported revisions; the first doc that would exceed this and every later HTML doc store no parts |
| `headingTextChars` | 200 characters per cleaned heading label |
| `headingIdChars` | 256 characters per declared Markdown heading ID, including its prefix |
| `headingLookupBytesPerRevision` | 33554432 bytes (32 MiB) across distinct heading lookup maps: UTF-8 name and target ID bytes plus 32 bytes per entry |
| `diffSideBytes` | 1048576 bytes per text diff side |
| `markdownDocBytes` | 1048576 bytes |
| `htmlDocBytes` | 8388608 bytes |
| `pubStylesheetBytes` | 1048576 UTF-8 bytes for the built-in HTML pub stylesheet |
| `downloadInlineBytes` | 134217728 bytes (128 MiB) of emitted built-in content per download, and the same read budget for stored assets, selected doc bodies and selected diff blobs; both shared by all files of a ZIP |
| `downloadCommentBytes` | 32 MiB of thread cards per download, shared by all files of a ZIP, separate from the built-in content budget |
| `downloadDocs` | 50 docs added to one download |
| `assetBytes` | 26214400 bytes per asset or diff image side |
| `htmlDocWithAssetsBytes` | 52428800 bytes per HTML or Markdown doc plus its listed assets |
| `revisionBytes` | 268435456 bytes for writeup source JSON and unique referenced blobs; checked before reading content |
| `blocksPerRevision` | 100000 rendered blocks across every path, including the writeup |
| `renderedBytesPerRevision` | 268435456 rendered JSON bytes across every path, including the writeup |
| `filesPerRevision` | 10000 files, including HTML assets and Markdown doc images; parented doc images do not count toward `mediaPerRevision` |
| `mediaPerRevision` | 50 writeup images (counted in `filesPerRevision`; each at most `assetBytes`) |
| `agentNotesPerFile` | 8 notes |
| `agentNotesPerRevision` | 64 notes |
| `areaChars` | 60 characters of plain text in a writeup area |
| `newInRevisionItems` | 12 items per writeup |
| `newInRevisionChars` | 300 characters per item, on one line |
| `newInRevisionQuoteChars` | 120 characters per quote, on one line |
| `needsYouItems` | 4 items per writeup |
| `needsYouChars` | 300 characters per item, on one line |
| `pathChars` | 4096 characters per path or source; also per publish URL or block id |
| `pathSegmentChars` | 255 characters per published path segment |
| `topicsPerReview` | 200 declared topics or writeup topic keys |
| `summaryChars` | 2000 characters per topic summary |
| `glossaryTerms` | 50 entries per glossary list |
| `glossaryTermChars` | 100 characters per term or alias |
| `glossaryAliases` | 8 aliases per glossary entry |
| `glossaryDefinitionChars` | 2000 characters per glossary definition |
| `blastScopeChars` | 32 characters per blast-radius scope |
| `blastNoteChars` | 2000 characters per blast-radius note |
| `writeupSectionBytes` | 1048576 UTF-8 bytes per Markdown string |
| `writeupBytes` | 2097152 UTF-8 bytes across all writeup strings |
| `targetLines` | 1000 quoted lines per line target |
| `targetTextChars` | 65536 characters across one target's lines and both context arrays |
| `contextLineChars` | 2000 characters per before/after context entry |
| `commentsPerHandoff` | 5000 comments per Go |
| `handoffBytes` | 16777216 UTF-8 bytes per serialized WaitResult |
| `waitingTakesPerOwner` | 32 waiting takes per owner |
| `historyPerComment` | 500 history entries per comment |
| `instructionsPerHandoff` | 100 instructions per Go |
| `versionChars` | 64 characters per capabilities version |
| `featuresCount` | 64 capability features |
| `featureChars` | 64 characters per capability feature |
| `errorMessageChars` | 1000 characters per error message |
| `publishJsonBytes` | 8388608 bytes per publish or import JSON request body |
| `requestJsonBytes` | 1048576 bytes per other JSON request body |

Binary and oversized text diffs show their reason in place of the text. A diff file with
recognised image sides shows pictures. The CLI allocates the revision budget in topic
importance order, with Other changes last. When text exceeds the remaining budget, the
file is marked oversized and its text blobs are omitted. When the pictures do not fit,
the CLI omits the file’s image sides and the reviewer sees its usual text diff or flagged summary.

## Identifiers and secrets

- Every row id is a UUID generated by `crypto.randomUUID()`. Revision `seq` is additionally a
  positive integer starting at 1 and increasing per review. API fields called `revision` use that
  sequence, not the revision row's UUID.
- Blob hashes are lowercase 64-character hex SHA-256 digests, addressed per owner.
- Block ids are `<section>-<hash8>`. `hash8` is the first eight lowercase hex characters of SHA-256
  over block text normalized to NFC, whitespace runs collapsed to one space, and trimmed. Repeats
  within a section append `-2`, `-3`, and so on. Section keys are `overview`, `tldr`, `whyItMatters`,
  `newInRevision`, `needsYou`, `review` (stored by older revisions only), `checked`, `notChecked`,
  `outOfScope`, `whereToLook`, `context`, `deviations`, `decisions`, `glossary`,
  `t-<slug>-why`, `t-<slug>-example`, `t-<slug>-body`, and
  `doc-<hash8 of the doc path>`. The complete block id is bounded by `pathChars`.
- Bearer tokens are `em_`, reviewer session secrets `ems_`, and pairing secrets `emp_`, followed
  by 32 random bytes encoded as unpadded base64url (43 encoded characters). Only SHA-256 hex
  digests are stored, including for normalized codes. Never log tokens or pairing secrets.
- Pairings are single-use and expire after 10 minutes. A link carries its secret only in the URL
  fragment, `/pair#<secret>`, never a query. The alternative code is `XXXX-XXXX` in Crockford base32;
  five wrong codes within 10 minutes lock code entry server-wide for 10 minutes
  (`429 rate_limited`, including the fifth failure). Malformed codes do not count; secret
  redemption remains available while code entry is locked.
- A content capability key is random and specific to a revision; it permits access to that
  revision's isolated content path without a session cookie.

## Errors

All errors use `ErrorBody`, with no stack traces or another owner's ids:

```json
{"error":{"code":"invalid_request","message":"The request is invalid."}}
```

`ERROR_STATUS` is the single exported code-to-status map; `ErrorCode` is derived from its keys.
Publish and import may return `invalid_request` with a message naming the file and zero-based
agent note index when a note is refused. These catalogue-built messages are bounded by
`errorMessageChars`; long file names may be abbreviated. The CLI prints the message as one
escaped line on stderr.

| Error code | HTTP status | When |
| --- | ---: | --- |
| `internal` | 500 | An unexpected server error; response and log contain no request or internal details. |
| `unauthorized` | 401 | A required credential is missing, invalid, revoked or expired. |
| `forbidden` | 403 | The principal's kind or scopes forbid the operation; decided before any id lookup. |
| `bad_host` | 403 | The Host header is outside the configured allowlist. |
| `bad_origin` | 403 | A non-GET/HEAD request has a disallowed Origin, or carries a session cookie without Origin. |
| `not_found` | 404 | Any id other than a review id is missing or belongs to another owner. |
| `unknown_review` | 404 | The review id is missing, belongs to another owner, or belongs to another instance for a machine token; identical in all three cases. |
| `unknown_intent_review` | 404 | The intent review was not found. |
| `invalid_request` | 400 | The request is malformed or violates its contract schema. |
| `invalid_target` | 400 | The comment target cannot be placed on the named revision. |
| `empty_send` | 400 | A Go has no unsent comments and no instruction. |
| `blob_mismatch` | 400 | Uploaded content does not match the supplied blob hash. |
| `blob_missing` | 400 | A referenced blob is absent from the owner's blob store. |
| `wrong_origin` | 400 | Origin metadata conflicts with the authenticated instance, or an import review id belongs to another owner/origin; ordinary review-id lookups use `unknown_review`. |
| `stale_revision` | 409 | A Send or Approve names a revision older than the newest. |
| `comment_frozen` | 409 | An edit or deletion targets a user comment already bound to a Send. |
| `unsent_comments` | 409 | An Approve is attempted while unsent comments remain. |
| `instance_attached` | 409 | The instance already has a live machine device; the pairing remains usable. |
| `review_moved` | 409 | A mutation targets a local review moved to a hub. |
| `review_in_bin` | 409 | The review is in the bin and the operation is not restore, delete for good or the settling of a delivery claimed before. |
| `review_closed` | 409 | A take finds the review retired or snoozed and the client did not list `closed` in `accepts`. |
| `invalid_state` | 409 | A lifecycle action does not fit the review's state, or a Send targets a retired review. |
| `publish_conflict` | 409 | The revision or thread set changed during publish computation on three attempts; retry publishing. |
| `too_large` | 413 | A JSON request body or uploaded content exceeds its byte limit; reject before parsing. |
| `client_outdated` | 426 | The CLI version is below the minimum supported version. |
| `rate_limited` | 429 | Pairing code entry is locked for 10 minutes after five wrong attempts. |

### Document metadata and links

`PublishManifest.files[].title` and `PublishRequest.files[].title` are optional strings, nonblank
and at most `LIMITS.titleChars` (200), allowed only on files whose role is `doc`; other roles reject
a title. At publish the server applies `cleanDocTitle`; an empty result is ignored. Doc titles
fall back to the document's own title, then its filename. HTML uses only `head > title`, then the
first HTML-namespace `h1` in the body. Both are read after the leading copy `recense look` writes is
removed. Markdown uses the first rendered `h1` heading block, so removed raw HTML cannot supply a
title. CLI inferred review titles use the same extraction. Titles and heading labels are plain
cleaned text.

Each `RevisionView.docs[]` optionally includes `title: string` and
`headings: { level: 2 | 3; text: string; id?: string }[]`. Older revisions without either field
remain valid. Markdown heading IDs name the rendered heading's anchor. HTML headings carry no `id`;
their list index addresses them in document order, including entries with empty cleaned labels.
The HTML parser uses scripting enabled, a nesting limit of 512, and the same skipped elements as
`docText`. Unreadable HTML has an empty heading list.

`LIMITS.headingsPerDoc` is 1024 and `LIMITS.headingTextChars` is 200. Heading IDs are bounded by
`LIMITS.headingIdChars` (256), including the prefix. An author's sanitized `user-content-` ID is
kept only if unique among all element IDs in the doc; otherwise the heading gets a generated
`heading-<hash>` ID. Declared heading IDs are unique.
Present title/heading metadata counts toward the existing revision rendered-byte budget and the
import rendered-byte budget. Absent metadata adds no bytes for older revisions.
Export and import file rows optionally carry nullable `title`, never heading lists; the import
schema discards supplied `headings`. The hub cleans titles and recomputes headings from source
when rendering, preserving compatibility with older exports.

After sanitize, writeup and Markdown links that resolve to a doc in the revision become
`?tab=docs&doc=<manifest path>` using `URLSearchParams`. A once-decoded fragment is looked up
exactly among the target's declared h2/h3 headings: author IDs (without `user-content-`) first,
then hunk-review slugs, then GitHub slugs; first match wins. A match emits only
`#h-<URL-encoded declared ID>`. A fragment is never compared with a declared ID directly.
Hunk-review slugs lowercase text, replace runs outside ASCII letters/digits with `-`, trim edge
hyphens and number repeats from `-2`. GitHub slugs lowercase text, retain only Unicode letters,
marks, numbers, hyphens, underscores and ASCII spaces, replace each space with `-`, and number
repeats from `-1`. Each kind skips previously taken names independently. Neither normalizes Unicode.
Lookup names come from cleaned, capped heading text. Empty names and names over
`LIMITS.headingIdChars` are skipped; at most one name per kind per declared heading is registered.
Maps are built once per distinct heading list, yielding after each doc. Each entry counts the UTF-8
bytes of its name and target ID plus 32 bytes of overhead, once per distinct list, against
`LIMITS.headingLookupBytesPerRevision` (32 MiB, below the publish worker's 256 MiB heap).
Overflow fails with `too_large` before rendering the writeup. This separate budget does not change
the stored rendered-byte total. Names are never stored or emitted.
Author queries and undeclared fragments are discarded. Links to HTML docs keep
no fragment. Markdown docs that fail rendering or exceed its budget declare no headings, but
keep their title. Links into such a doc may keep a fragment, which the app then ignores.
The shared resolver decodes each segment once and rejects encoded separators, controls, schemes,
network or root-relative paths, queries and traversal above the manifest root. Writeup paths
start at that root; doc paths start at the linking doc's directory. Paths match exactly.
Other relative links retain no href. Comment HTML receives no doc context and stays unchanged.

### Source docs

Manifest and publish file entries accept `view?: "rendered" | "source"` on doc rows only.
Markdown (`.md`, `.markdown`) and HTML (`.html`, `.htm`), case-insensitively, default to rendered;
other paths default to source. `DocView` is `"rendered" | "source"`. Explicit rendered is refused for other extensions. One path can
appear once in each doc view and once as a diff. `main` continues to name a doc path.
Source docs have their own path namespace; rendered docs and assets share the existing namespace.
Source docs cannot list assets or parent assets, and media cannot collide with either doc view.

Source bytes must be valid UTF-8 without NUL, otherwise publishing/import refuses them with
`invalid_request`. Decoding strips one leading UTF-8 BOM consistently for rendering and placement.
For a CLI source alias, its extension must match the doc path case-insensitively, including no extension.
The size limit is `LIMITS.markdownDocBytes` (1048576 bytes, 1 MiB). The server stores source docs
as role `doc`, media type `text/plain`; source HTML never has a content URL or content-route access.

`RevisionView.docs[]` includes `{ path, kind: "source", title?, language, lines, unrendered?: true }`, where `lines`
is `SourceToken[][]` and a token is `{ text: string, syntax?: SyntaxRole, light?: Color, dark?: Color }`.
New renders carry `syntax`: `plain`, `keyword`, `type`, `function`, `string`, `number`, `comment`,
`punct`, `inserted` or `deleted`; absent means plain. These roles use the reader's theme colours.
The optional `light`/`dark` colours remain accepted for revisions published earlier and strictly
match `^#[0-9a-fA-F]{3,8}$`. Text is raw data, never HTML. `language` is a loaded Shiki language id
(`ts`, `tsx`, `js`, `jsx`, `json`, `css`, `html`, `md`, `yaml`, `sh`, `go`, `py`, `sql`, `diff`), or
`text` for unknown extensions, files above the 256 KiB highlighting budget, or docs past the
1 MiB per-revision highlighting budget. Highlighting also
caps each line at 400 characters; longer lines retain their text. Each array is bounded by
`markdownDocBytes`; serialized source content counts against the revision rendered-byte budget.
Lines are numbered from 1, CRLF is treated as LF, a terminal newline adds no line, and empty files
have zero lines and omit `unrendered`. Source doc rows together are limited to
`LIMITS.sourceLinesPerRevision` (200000 lines) and `LIMITS.sourceBytesPerRevision`
(16777216 bytes, 16 MiB), which counts the UTF-8 byte length of decoded source text, not its
token JSON. Stored source token JSON, including escaping and structure, counts against
`LIMITS.renderedBytesPerRevision`. Aliases count once per row against these source limits
and the rendered-byte budget. A doc that would exceed either source budget is unrendered.
Unrendered source docs, including missing or invalid rendered content, have `unrendered: true`,
language `text` and empty lines; publish lists rendering failures in its `unrendered` array. Source titles use the manifest title or the cleaned filename, with no headings.
Source docs are excluded from navigable doc links; a rendered view of the same path remains navigable.
`FileView.view?: "source"` is set only on source doc rows, distinguishing two doc rows of the same path.

`SourceLinesTarget = { kind: "source-lines", path, start, end, lines, before, after }` has exactly
the line target's inclusive range, array, context and combined character limits, without a diff side.
Its placement location is `{ kind: "source-lines", path, start, end }`, with positive line numbers
and `end >= start`. It follows renames and surviving text using the same line placement tiers;
unplaced reasons are `file-gone`, `lines-gone` or `ambiguous`. New targets must name a source doc.
Hand-offs retain the target's path, range and quoted lines; wait/feedback JSON remains additive.

Import/export file rows accept `view?: "rendered" | "source"` on docs only. Export sets `source`
on source rows; absent retains the extension-based default. Import carries the view into publish
validation, revalidates raw text and re-renders tokens and source-line placements.
