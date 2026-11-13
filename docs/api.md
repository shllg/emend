# API v1

The versioned API lives under `/api/v1`. `@emend/contract` exports its zod schemas and inferred
TypeScript types under the same names, with `CONTRACT_VERSION = 1`. It is a workspace package in
this repository and is not published to npm: never install an `@emend/*` package from the registry. All API timestamps are
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
- The CLI sends `X-Emend-Client: cli/<semver>`. The minimum supported client version is `0.1.0`;
  older clients receive `426 client_outdated`. Other header values are `400 invalid_request`.
- Before sending a bearer, the CLI authenticates the discovered server with public
  `GET /api/v1/capabilities` and `X-Emend-Challenge` (`SERVER_CHALLENGE_HEADER`). `ServerChallenge`
  is 32 fresh random bytes encoded as canonical unpadded base64url (43 characters). The server
  answers `X-Emend-Proof` (`SERVER_PROOF_HEADER`, schema `ServerProof`) with HMAC-SHA256 over the
  challenge's ASCII text, using the decoded 32-byte key stored in private `server.json`, encoded
  as canonical unpadded base64url. The CLI compares the digest in constant time. A missing,
  malformed or wrong proof prevents credential transmission. No challenge means no proof;
  a malformed challenge returns `400 invalid_request`. Capabilities remains public, and its
  proof reveals nothing about the key. Neither header carries a bearer or the server key.
- Browsers use `emend_session`, with `HttpOnly`, `SameSite=Strict`, `Path=/`,
  `Max-Age=2592000` (30 days), and `Secure` on HTTPS. Sessions renew at most once daily.
- JSON bodies use `Content-Type: application/json`. Routes reject bodies over their JSON byte
  limit with `413 too_large` before parsing, then validate with the contract schemas:
  `POST /api/v1/publish` and `POST /api/v1/import` permit at most `publishJsonBytes` (8388608 bytes); `POST /session` and
  `POST /machines` permit `publicJsonBytes` (4096 bytes); other JSON routes permit at most
  `requestJsonBytes` (1048576 bytes).
- Every request checks `Host` against `127.0.0.1:<port>`, `localhost:<port>`, `[::1]:<port>`, and
  the listener's actual concrete address, and the tailnet name only when configured with
  `--tailscale` (with `--tailscale-port <n>`, the name and that port, `<name>:<n>`). Other hosts receive `403 bad_host`. Every non-GET/HEAD request with an Origin
  must name an allowed app origin. A non-GET/HEAD request carrying a session cookie must carry
  that Origin; a missing or disallowed origin receives `403 bad_origin`.

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
`127.0.0.1:3636` by default; only `--host` or `--tailscale` widens it. There is no telemetry.

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
| PATCH | `/api/v1/settings` | Reviewer | Apply `SettingsUpdate` and return `SettingsView` (200); requires `settings:manage`. |
| DELETE | `/api/v1/devices/:id` | Admin, reviewer | Revoke the device and every bound token atomically (204); missing, foreign or revoked is 404. |
| POST | `/api/v1/machines` | Anyone with a pairing secret or code | Register `MachineRegistration`; return `MachineRegistered` (201); refuses device pairings. |
| DELETE | `/api/v1/machines/self` | Agent | Revoke the current machine device and all its tokens (204); local agents get 404. |
| HEAD | `/api/v1/blobs/:sha256` | Agent | Check whether the owner's blob exists and is stored whole. |
| PUT | `/api/v1/blobs/:sha256` | Agent | Upload a blob; verify its size and hash. |
| POST | `/api/v1/publish` | Agent | Create a review or add a revision. |
| POST | `/api/v1/import` | Agent | Copy one `ImportBundle`; return `ImportResult` (201, or 200 when skipped); machine tokens only. |
| GET | `/api/v1/reviews` | Reviewer | List reviews in the inbox. |
| GET | `/api/v1/agent/reviews` | Agent | List the token's own instance's reviews, newest first, as `AgentReviewList`; `?head=<sha>` keeps those whose approved or newest revision has that head. |
| GET | `/api/v1/reviews/:id` | Reviewer | Read a review. |
| GET | `/api/v1/reviews/:id/revisions/:seq` | Reviewer | Read one revision. |
| GET | `/api/v1/reviews/:id/revisions/:seq/download` | Reviewer | Download one offline HTML file, or a ZIP with docs selected by repeated `doc` query parameters. |
| PUT | `/api/v1/reviews/:id/viewed` | Reviewer | Mark or unmark diff files as viewed; return 204. |
| GET | `/api/v1/files/:fileId/old` | Reviewer | Read the old file side. |
| GET | `/api/v1/files/:fileId/new` | Reviewer | Read the new file side. |
| GET | `/api/v1/media/:sha256` | Reviewer | Read a writeup image by content hash. |
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
| GET | `/content/:contentKey/*` | Holder of the key | Read isolated HTML docs and assets from a revision. |

Only an admin bearer with `server:stop` may call `/api/v1/server/stop`. The server sends its
202 response before shutting down through the same cleanup as SIGTERM and exiting 0. Repeated
requests while stopping return 202 without starting another shutdown. Capabilities advertises
`server-stop` only when a stop handler is available; otherwise the route returns `404 not_found`.

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

### Writeup media

`GET /api/v1/media/:sha256` serves one image that a writeup embeds. A parameter that is not 64
lowercase hex characters returns `404 not_found`. The server looks up one file of the
authenticated owner with `role` `asset` and no parent doc, `newBlob` equal to the hash and a
stored media type of `image/png`, `image/jpeg`, `image/gif`, `image/webp` or `image/avif`. No such
row, a diff side, an SVG, an HTML doc's own asset or any other asset, a foreign owner's row, a
missing stored blob, or one whose size or bytes do not match its hash returns `404 not_found`
before any byte is sent.
An image used only by reviews in the bin also returns `404 not_found`. Media is addressed by
hash and may be shared, so it never answers `review_in_bin`; another readable review using the
same image keeps it available, and Restore makes it available again. A moved local copy remains
readable even if it was binned before the move.
Otherwise it returns `200` with the stored bytes, `Content-Length`, `Content-Type` set to the
row's stored media type, `X-Content-Type-Options: nosniff`, `Cross-Origin-Resource-Policy: same-origin`,
`Cache-Control: no-store`, `Content-Disposition: inline` and
`Content-Security-Policy: sandbox; default-src 'none'`. That CSP replaces the app CSP on this
route only. `HEAD` applies the same authorization and headers, with no body.

An image keeps a source only when it names a declared media path of the same revision. Every other
image source, relative or absolute, is dropped, in writeups, Markdown docs and comments alike. A declared
path never contains a colon. The renderer drops any query or fragment, strips a leading `./`, percent-decodes, and refuses a
result with a `..` segment, a leading `/`, a scheme, a backslash, a control character or an
invalid or encoded-slash escape. A match becomes
`<span class="emend-media"><img src="/api/v1/media/<sha256>" alt loading="lazy" decoding="async" width height><span class="emend-media-caption">…</span></span>`;
the caption is the alt text, or the file name when the alt text is empty. `width` and `height` are
the image's displayed pixel size, read by the server from the stored bytes at publish (JPEG EXIF
orientation applied); they are absent when the server cannot read the size. The wrapper span also has
the class `emend-media-sized` exactly when the server sent `width` and `height`. On a writeup media image,
author-written width and height are always dropped. A paragraph holding only
such images also has the class `emend-media-row`. Author classes keep the `user-content-`
prefix, so they never match the generated classes. A block's id covers each image's alt text, path
and SHA-256, so a re-shot image at the same path shows as changed. Markdown docs render no
local images.

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

A code review's file holds the review title and that revision's writeup: sections, topics, text,
code blocks and images with captions. The base file holds no docs, comments or diff. A revision
is a pub when `writeupEmpty` is true and `base` is null. A pub's base file holds one doc:
the first doc row in file order whose path equals `main`, else the first doc row. The order
includes both rendered and source views of a path. Markdown uses its stored rendered
blocks. Source uses its stored highlighted tokens. Code reviews and Markdown and source pubs
get the emend header with the review title, project, branch and publish links. An HTML pub keeps
the agent's HTML layout, with no emend header. Its listed assets are built in after filtering.
Mermaid diagrams show as labelled source text. Links to other docs become plain text.
Absolute HTTP, HTTPS and mailto links keep working on `a` and `area` elements.
Only SVG `image` and `feImage` hrefs follow the resource rules. Other elements, including SVG
`use` and MathML elements, keep only same-document fragments in hrefs. These rules also apply
to `xlink:href`. SMIL `set`, `animate`, `animateMotion` and `animateTransform` elements targeting
an href are removed.

The response is `200` with `Content-Type: text/html; charset=utf-8`,
`Content-Disposition: attachment; filename="<name>"`, `X-Content-Type-Options: nosniff`,
`Cache-Control: no-store` and `Cross-Origin-Resource-Policy: same-origin`.
The filename is the lowercase title, with runs outside `[a-z0-9]` replaced by `-`, trimmed,
cut to 60 characters and trimmed again. An empty name becomes `emend`. It ends in `-r<seq>.html`.
`Content-Security-Policy: sandbox; default-src 'none'; img-src data:; style-src 'unsafe-inline'; font-src data:; media-src data:; base-uri 'none'; form-action 'none'`
replaces the app CSP for this route. Every file starts with a UTF-8 byte order mark.
The file also has a CSP meta with the same policy without `sandbox`.
It opens offline with no scripts or network requests.

With no `doc` parameter, the single HTML response is unchanged. With any docs selected, the
response is `application/zip`, with attachment filename `<slug>-r<seq>.zip` and the same CSP,
nosniff, no-store and same-origin headers. The ZIP starts with the base file at the root under
its single-download name, then the selected docs under `docs/`, in revision file order (`ord`,
then `id`). Each doc is an offline HTML file using the same rendering and filtering rules.
Markdown and source docs get their title or path and the base file's project, branch, revision
and publication time; publish links stay in the base file. Missing or invalid Markdown rendering
shows empty content. Missing or invalid source rendering says "This file could not be shown."
A missing HTML doc blob gets `404 not_found`.

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
128 MiB of stored assets and selected doc bodies: HTML blobs and Markdown/source rendered blobs.
It checks their stored sizes before reading them. Assets are cached and charged once; selected
doc bodies are charged on each read and released after building their file.
Both budgets are shared by all files in a ZIP. Each later builder's emitted budget is reduced
by the full UTF-8 size of every file already built. A selected doc that does not fit the remaining
read budget, or comes after the emitted budget is spent, is left unread. Its file is a page with
the title, reading styles and only the left-out note in its body. The base file's read paths stay
unchanged. Each ZIP entry is compressed before building the next file.
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

The file holds no server address, emend link, sign-in link, token or machine name.
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
`SettingSource = "default" | "file" | "override"`.
`HoursSetting = { value: ApprovedActiveHours, source: SettingSource, default: ApprovedActiveHours,
file: ApprovedActiveHours | null, override: ApprovedActiveHours | null, fileError: boolean }`.
`KeyBinding = ShortcutKey | null`; null turns a shortcut off.
`KeySetting = { value: KeyBinding, source: SettingSource, default: ShortcutKey, file?: KeyBinding,
override?: KeyBinding, fileError: boolean, clashWith: ShortcutCommand | null }`.
`KeysSetting = { commands: Record<ShortcutCommand, KeySetting>, fileError: boolean }`; every command is present.
`SettingsView = { approvedActiveHours: HoursSetting, keys: KeysSetting, serverTime: string }`. `serverTime` is the server's clock (ISO
8601) when it answered; a client compares it with `InboxList.serverTime` to tell which window is newer.
`SettingsUpdate = { approvedActiveHours?: ApprovedActiveHours | null,
keys?: Partial<Record<ShortcutCommand, { key: KeyBinding } | null>> }` is strict, including each
`{ key }` object; extra keys, unknown commands and non-normalized keys are refused (400).
An empty update is accepted. Omitted settings stay unchanged. Updates to both settings share one transaction.

The effective `value` uses the owner's database override, then the config file, then
`APPROVED_ACTIVE_HOURS` (12). Zero moves an approved review out of Active at once.
PATCH stores an override on this server; null clears it. Only a reviewer session can change it.
Each server reads its own global config file on every settings or review read. It never writes
or migrates that file. `file` is its usable value, or null when absent or invalid.
`fileError` is true when the file cannot be read, is not a JSON object, or contains an unusable
`approvedActiveHours` value. An invalid file does not prevent the default or override from working.
A missing file or absent key is not an error. `docRoots` and `openBrowser` are not settings in this API.

`ShortcutKey` is a normalized string: one lowercase ASCII letter, `shift+` followed by one
lowercase ASCII letter, `mod+` or `mod+shift+` followed by one lowercase ASCII letter,
one ASCII digit, or one printable ASCII punctuation character (0x21–0x7E excluding letters
and digits). `mod` means Ctrl, or ⌘ on a Mac; a client accepts either one, but not both together.
Spaces, named keys (including Escape, Tab, Enter, arrows, PageUp/PageDown, Home, End and F-keys),
spelled-out `ctrl+`, `cmd+`, `meta+` and `alt+` modifiers, and `shift+` or `mod+` before a
non-letter are refused. The config file alone also accepts uppercase letters (`A` becomes
`shift+a`), case-insensitive shift-letter combinations (`SHIFT+A` becomes `shift+a`) and
case-insensitive mod forms (`Mod+K` becomes `mod+k`, `MOD+SHIFT+P` becomes `mod+shift+p`).
Shift must be spelled out in mod forms.

The global config file format is `"keys": { "<command>": "<key>" | null }`. It is read once
alongside `approvedActiveHours`. An absent `file` or `override` in a `KeySetting` means that
source sets nothing usable; a present null explicitly turns the command off. An unusable file
entry is ignored and sets that command's `fileError`. `keys.fileError` is true if the file
cannot be read, is not a JSON object, its `keys` is present but not a plain object, or it names
an unknown command. Unknown entries are ignored; other usable entries still apply. A missing
file or absent `keys` is not an error.

PATCH `keys` merges commands into one stored object per owner: `{ key: "j" }` stores an override,
`{ key: null }` stores off, and null removes the override. Unmentioned commands stay unchanged;
removing the last override deletes the stored row. Corrupt stored objects and invalid or unknown
entries are ignored. Only a reviewer session can PATCH keys. The `readSettings` path on review
reads is unchanged: it reads only the approved-hours setting, without querying shortcut overrides.

`ShortcutCommand` and `SHORTCUT_DEFAULTS` use this order:

| Command | Default key |
| --- | --- |
| `inbox.next` | `j` |
| `inbox.previous` | `k` |
| `inbox.filter` | `f` |
| `inbox.search` | `/` |
| `inbox.back` | `u` |
| `tab.writeup` | `1` |
| `tab.files` | `2` |
| `tab.docs` | `3` |
| `tab.comments` | `4` |
| `tab.diff` | `5` |
| `file.next` | `n` |
| `file.previous` | `p` |
| `file.toggleViewed` | `v` |
| `review.instructions` | `s` |
| `review.approve` | `shift+a` |
| `review.snooze` | `z` |
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

### Review read views

`ReviewState = "open" | "approved" | "settled"`. `settled` is the stored and wire value for a
retired review; clients label it "Retired".
`InboxItem = { id, title, origin: { id, name }, repo: string | null, project: string | null, branch: string | null,
state: ReviewState, newestRevision, unsentCount, openThreads, agentWaiting, pendingSend,
updatedAt, movedTo: string | null, list: "active" | "snoozed" | "done", snoozed: boolean,
snoozedUntil: string | null, activeUntil: string | null, releasedAt: string | null, pickedUpAt: string | null,
kind: "review" | "publish" }`. `repo` is the repository key, and
`movedTo` is the review's destination URL. `list` places the review: `done` for `settled`, and for
`approved` once the effective `approvedActiveHours` have passed since approval or it does not fit
Active's cap; an approved review is `active` until then if it has a place. An open review is
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
agent confirmed a `closed` answer, so emend ended a wait; it is null when that never happened. Timestamps are ISO 8601 UTC strings; sequences are positive integers.
`unsentCount` counts user comments without a Send; `openThreads` counts all unresolved threads.
`pendingSend` means a Send is neither confirmed delivered nor set aside (an unconfirmed lease
is still pending). `pickedUpAt` is the time an agent's CLI last confirmed a delivery that carried a
live Send (a `go` or an approval) made on the review's newest revision, so emend saw the feedback
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
`emend publish <path>` produces; otherwise `"review"`. It follows the newest revision, so a later
revision can change it. Both views carry it.

`agentWaiting` is true for a server-held wait (including its 35-second grace
period) or an unexpired direct-wait row for the same owner and review. Direct waits renew a
30-second expiry every 10 seconds and delete their row when they end. They emit no live event;
views reflect direct writes on their next load.

`GET /api/v1/reviews` returns `InboxList = { items: InboxItem[], serverTime: string, approvedActiveHours: ApprovedActiveHours }`.
`approvedActiveHours` is the effective window used for this response. Reviews in the bin are in none of the lists.
`serverTime` is the server's clock when it built the list, as an ISO 8601 UTC string.
The Active list holds open reviews
whose snooze is not in effect and reviews approved within that window (12 hours by default). A review with a waiting
agent comes first, then newest activity: an open review uses `updatedAt`, or the wake time of a
timed snooze that has passed when that is later; an approved review sorts by `updatedAt`.
Next is the Snoozed list (soonest wake first, a snooze until the next revision last), then the Done
list (retired reviews and approvals outside that window, with no approval time, or without an Active place, newest
`updatedAt` first). Review id is the
stable tie breaker in each. At most `inboxItems` (200) rows per list, so at most 600 in all.
When more reviews qualify for Active than its cap, open reviews take the places first and approvals
that do not fit are listed in Done with `activeUntil: null`.
`GET /api/v1/reviews/:id` returns `ReviewView = InboxItem & { revisions: { seq, createdAt }[], importedAt: string | null }`,
with revisions ascending by sequence. It places an approved review by the 12-hour rule alone.
Both are reviewer-only, as is the revision endpoint below.

`GET /api/v1/reviews/:id/revisions/:seq` returns `RevisionView = { seq, base, head, main, writeupEmpty,
topics: TopicMeta[], files: FileView[], writeup: RenderedWriteup, links: PublishLink[],
repoUrl: string | null, docs, threads: ThreadView[],
changedBlocks: { blockId: BlockId, revision: number }[] }`.
`links` and `repoUrl` are the revision's publish-level links (see "Links and repoUrl" below);
both fields are optional in the view, and revisions published before they existed omit them.
Base/head are nullable full commit hashes; head also permits `worktree`.
`main` is `"writeup" | FilePath | null`: the manifest's main page, or null when omitted.
`writeupEmpty` is a boolean computed at publish from the source Markdown, before rendering:
true only when overview, tldr, outOfScope, whereToLook, context, decisions, glossary, and every
topic's why, example and body are missing or whitespace only. Both fields are stored on the revision; revisions predating
these fields read as `main: null`, `writeupEmpty: false` and keep opening on Writeup.
Without an explicit visible `tab` in the URL, the app opens the main page when set; otherwise
it opens Writeup if it has text, the first doc in manifest order, Diff if any file has role
`diff`, or Writeup when there is nothing. A main doc opens Docs scrolled to that document.
`FileView = { id, path, oldPath, role, status, topic, order, mediaType, flag, hasOld, hasNew, counts?, viewed?, viewedOn?, notes?, view?: "source" }`.

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
Kinds are `heading | paragraph | item | code | table | quote | diagram`; diagram source is optional.
`RenderedWriteup = { sections: { key, label, topic: string | null, blocks: RenderedBlock[] }[] }`
mirrors core's rendered writeup. These are server-rendered blocks, never browser-rendered Markdown.
Markdown docs are `{ path, kind: "markdown", blocks: RenderedBlock[] }` (empty if unrendered).
HTML docs are `{ path, kind: "html", contentUrl }`, where the URL is
`/content/<docKey>/<path>` with each path segment percent-encoded. The doc key is the revision's
43-character base64url `contentKey` followed by that doc's file UUID with dashes removed (32
lowercase hex characters); its exact shape is `^[A-Za-z0-9_-]{43}[0-9a-f]{32}$`.
GET and HEAD serve only that HTML doc and the assets it lists in the same owner and revision.
The key is the capability: neither cookies nor Authorization are read, and the owner comes from
the revision. Wrong keys, missing files, other docs, diff files, unlisted assets and invalid paths
receive 404, and so does a stored blob whose size or bytes do not match its hash, before any byte
is sent. The doc receives an inline selection/highlight bridge; assets retain their bytes and send
`Content-Length`.
Content-Type is the stored media type, with `; charset=utf-8` for `text/*`, `application/json`
and `image/svg+xml`; the doc is `text/html; charset=utf-8`.

The bridge also inserts one style element first in the doc's head, in the cascade layer
`emend-fallback`: `pre { overflow-x: auto; }`. Declared first and layered, it loses to every
document-level rule of the doc's own CSS, so a code block the doc leaves unstyled scrolls inside its
own box instead of widening the doc. A `::slotted(pre)` rule in a shadow root does not override it:
the cascade ranks the outer document's rules above a shadow tree's.

Asset and error responses under `/content/` send:

```
Content-Security-Policy: sandbox allow-scripts; default-src 'none'; script-src 'none'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self' data:; media-src 'self'; connect-src 'none'; form-action 'none'; frame-src 'none'; frame-ancestors 'self'
X-Content-Type-Options: nosniff
Referrer-Policy: no-referrer
Cache-Control: no-store
```

Successful doc responses have the same headers, with only `script-src` replaced by
`script-src 'sha256-<base64 SHA-256 of the bridge script text>'`. The server computes that hash
once from the bridge constant and injects exactly that text, byte for byte. Only emend's bridge
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
`{ type: "emend:navigate", path: FilePath, fragment: string }` to the parent. The path and fragment
are decoded; the fragment excludes `#` and is at most 1024 characters. The parent accepts this
strict message only from the current trusted frame and only for another doc in the same revision.
It opens that doc as a new history entry. For an HTML target with a fragment, the newly mounted frame's src is its own
content URL plus `#` and the percent-encoded fragment. Same-doc HTML `a` and `area` links and SVG
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
load or a second `emend:ready` in that generation disables the frame's bridge and shows
`This doc navigated away.` with Reload. The second ready locks it immediately, before load;
no further messages or commands are accepted until a parent-initiated reload or navigation. Directly
navigating to another doc under the current doc's key still returns 404 and triggers that state.
Other frame messages carry ready notifications, proposed quotes, quote highlights and thread
scroll requests; saving a comment requires the reviewer's explicit action.

After `emend:ready`, the parent sends `{ type: "emend:docs", paths: FilePath[] }`, the exact doc
paths in this revision. Bridge links resolve against the existing document base, decode each
segment once, and use the same rejection rules as the core resolver. The parent validates the
destination again before navigating.

HTML Contents addresses the server's h2/h3 list by zero-based index. The parent sends
`{ type: "emend:goto", heading: number, label: string }` for a pick; a restore also includes
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
find-in-page, `emend:scroll` or a link scroll. `emend:scroll` and the bridge's own link scrolls also
end it explicitly. Input events alone, and clicks that move nothing, do not end the pin. A same-doc
fragment link with no matching target does not scroll or end the pin.
The bridge throttles `{ type: "emend:position", heading: number, fraction: number }` to one message
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
`{ type: "emend:position", heading: null, fraction: 0 }`. This strict shape clears the stored
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
unchanged. `html` appears only here: hand-offs, `emend wait` and `emend feedback` output, MCP tools, export,
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
`changedBlocks` contains each block once, paired with the newest positive revision sequence in
which it changed after the reviewer's most recent Send's revision and through the requested revision.
For example, a block changed in revisions 2 and 3 after a Send on revision 1 appears once with
`revision: 3` when reading revision 3, and with `revision: 2` when reading revision 2.
Blocks changed only at or before that Send are absent; before any Send changes start at revision 1.
The most recent Send is determined by insertion order, including approvals and set-aside Sends.
A requested revision at or before that Send has no changed blocks.
Every query is owner-scoped. Missing/foreign reviews return `404 unknown_review`; missing or
invalid sequences of an owned review return `404 not_found`. Agent tokens receive `403 forbidden`.

`GET /api/v1/agent/reviews` returns `AgentReviewList = { items: AgentReviewItem[] }` with
`AgentReviewItem = { id, title, branch, state: ReviewState, newest, approved, updatedAt, url }`.
`branch` is the review's stored branch, `null` when the publish named none. `newest` is
`{ revision, head }` for the review's newest revision (highest `seq`), or `null` for a review that
has no revision. `approved` is `null` while no revision is approved, else `{ revision, head }` of the
revision the approval points at. `head` is the revision's stored head, unchanged: a full commit
id (40 or 64 lowercase hex characters), `"worktree"` or `null`. It needs the agent `publish`
scope and lists only the principal owner's reviews whose origin is the token's own instance, so a
machine token never sees another instance's or another owner's reviews. Items run newest
`updatedAt` first, review id as the stable tie breaker, at most `agentReviews` (100) rows, with no
pagination. Binned reviews are left out. The list has no other inbox filter: snoozed, approved and retired reviews appear with their
stored `state` (`open`, `approved` or `settled`). `updatedAt` is an ISO 8601 UTC string. `url` is
the review's address on this server. The list carries no comment bodies,
writeup text, doc content, tokens or other ids. A reviewer session receives `403 forbidden`.

The optional query `?head=<sha>` (`AgentReviewQuery = { head?: commit }`) keeps only reviews whose
approved revision's head equals `<sha>` or whose newest revision's head equals `<sha>`. The match
is exact and case-sensitive on the stored value; an older, superseded revision's head does not
match. `<sha>` is a full object id of exactly 40 or 64 lowercase hex characters: no prefix and no
`worktree`. The filter is applied together with the owner and origin-instance conditions, before the
ordering and the 100-row cap, so the cap counts matches. A malformed or repeated `head` is
`400 invalid_request`.

`head` and `branch` are the values the publisher sent; the server stores them unverified, and a
review without code files (docs or a plan only) shows the reviewer no diff of that commit. So
`approved.head === sha` means the reviewer approved a revision that its publisher labelled with that
commit, not that emend verified the commit's content was shown. A caller that gates on an approval
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
| `InboxList.items` | `inboxItems` (200), the inbox query limit |
| `AgentReviewList.items` | `agentReviews` (100), the agent list query limit |
| `AgentReviewItem.title` | `titleChars` (200), as in `InboxItem.title` |
| `AgentReviewItem.branch` | As `InboxItem.branch`: the stored branch or `null` |
| `AgentReviewItem.newest`, `.approved` | `{ revision, head }`: `revision` a positive integer, `head` a full commit id, `"worktree"` or `null` (as `RevisionView.head`); `newest` is `null` without any revision, `approved` while nothing is approved |
| `AgentReviewQuery.head` | Optional; exactly 40 or 64 lowercase hex characters, else `400 invalid_request` |
| `AgentReviewItem.updatedAt` | ISO 8601 UTC datetime string (`z.iso.datetime()`) |
| `AgentReviewItem.url` | HTTP(S) URL of at most `pathChars` (4096) characters |
| `InboxItem.title` | `titleChars` (200), including publish's nonblank requirement |
| `InboxItem.repo` | Nullable `Sha256`: exactly 64 lowercase hex characters, the published repository key, not the repository name |
| `InboxItem.project` | Nullable, otherwise 1 through `titleChars` (200) characters |
| `InboxItem.branch` | Nullable, otherwise 1 through `pathChars` (4096) characters, as in `PublishRequest` |
| `RevisionView.topics` | `topicsPerReview + 1` (201): up to 200 declared topics plus the reserved Other changes entry, as in publish |
| `RevisionView.files`, `RevisionView.docs` | Each at most `filesPerRevision` (10000), the publish file limit |
| `FileView.order` | Zero through `filesPerRevision - 1` (9999), the publisher's zero-based file-array index |
| `RenderedWriteup.sections` | At most `7 + 3 * topicsPerReview` (607): seven fixed sections and Why/Example/Details for each writeup topic |
| `RenderedWriteup.sections[].key`, `RenderedBlock.section` | Renderer-generated keys: overview, tldr, outOfScope, whereToLook, context, decisions, glossary or `t-<TopicSlug>-why/example/body`; block sections also allow `doc-<hash8>`. TopicSlug permits 1–64 characters, so the longest topic section key is 74 characters |
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

Browser startup calls `configureBrowserValidation()` from the schema-free `@emend/contract/browser`
entry before dynamically loading the app and its schemas. It sets Zod's `jitless` option before
object construction (when Zod captures this setting), so validation never probes or compiles
`Function` under the app CSP. The normal contract index also exports the function.

`Capabilities = { api: 1, version: string, features: string[] }`. The first feature list is
`["attach", "html-docs", "mcp"]`; clients accept additional feature strings.

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

`PublishResponse = { reviewId, revision, url, placed, unplaced, unrendered: FilePath[] }`.
An omitted `unrendered` field defaults to `[]`.
HTML doc entries include `assets: FilePath[]`. Each listed path must be an asset in the request
inside that doc's folder. The HTML source plus its own listed assets must fit
`htmlDocWithAssetsBytes`; shared assets count for every doc listing them. Asset rows retain
their first parent, and their blob bytes count once toward the revision byte budget. Every HTML
doc's full asset list is stored, so a shared asset loads under each doc that lists it. Existing
revisions migrate their parent associations and retain parent-only asset access.
`unrendered` lists Markdown docs whose rendering failed, timed out or exceeded rendered-output budgets
(at most `filesPerRevision`). Rendered blocks and JSON bytes count every path, including the writeup.
Docs render in manifest order; once a doc exceeds either budget it and all later Markdown docs
remain unrendered. A writeup alone exceeding either budget returns 413 `too_large` with
"The writeup has too many blocks."
The CLI warns `emend: could not render <path>` for each; the publish still succeeds.
The URL is `<baseUrl>/r/<reviewId>` (HTTP or HTTPS);
it is bounded by `pathChars` (4096 characters). At each start the local server saves its listening URL in `server-url.json` in the state
directory, mode 0600. With Tailscale, it replaces that value with the public origin only after
Serve setup succeeds; a failed startup keeps the loopback URL. A successful start leaves its
confirmed base URL there on close. Direct publish uses that saved HTTP(S) origin;
a missing or invalid JSON record, credentials, path, query or fragment falls back to
`http://127.0.0.1:3636`. An attached machine publishes to the hub using its machine credential.
`revision` is a positive integer sequence, and the placement counts are nonnegative integers.

### Machines and import

`emend attach` refuses a hub whose capabilities lack `review-bin` while this machine holds an
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
Revoke it in the hub's devices, or run emend detach on it." Neither refusal consumes the pairing.
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
array, which may be omitted by older exports. UUID row ids are kept. All dates
are ISO UTC strings; nullable fields are explicitly null. Arrays preserve durable insertion order
for comments, threads and Sends; revisions are complete and ordered by sequence starting at 1.
Unknown keys, including owner ids, moved-to URLs, content keys, media types, `placements` and
`changedBlocks`, are stripped. Placements and changed blocks are derived by the hub, not supplied.

| Bundle field | Row fields |
| --- | --- |
| `review` | `id, originInstanceId, reviewKey: Sha256, repo: {key: Sha256, name} or null, project?: string or null, branch, title, state, approvedRevision: UUID or null, createdAt, updatedAt` |
| `revisions` | `id, reviewId, seq, base, head, main, writeupEmpty, createdAt` |
| `topics` | `id, revisionId` plus `TopicMeta` (optional door and blastRadius) |
| `files` | `id, revisionId, path, oldPath, role, status, topicSlug, ord, oldBlob, newBlob, renderedBlob, flag, parentDocId, title?, view?: DocView`; nullable sides, status, topic, flag, parent |
| `docAssets` | `revisionId, docId, assetId` |
| `agentNotes` | `id, fileId, ord` plus `AgentNote`; optional array, ordered per file, at most 8 per file and 64 per revision |
| `writeups` | `id, revisionId, sourceBlob, renderedBlob` |
| `threads` | `id, reviewId, target, state, createdRevisionId, createdAt, updatedAt` |
| `comments` | `id, reviewId, threadId, author, body, outcome, sendId, createdAt, updatedAt`; user outcome is null; agent outcome is required and sendId null |
| `sends` | `id, reviewId, revisionId, kind, mode, instruction, deliveryId, setAsideAt, createdAt`; Go requires mode; Approve has null mode/instruction |
| `deliveries` | `id, reviewId, leaseUntil, confirmedAt, createdAt` |

`review.project` is optional and nullable, otherwise 1 through `titleChars` (200) characters.
The hub keeps it when non-null; null or absent values fall back to `review.repo.name`, except `.git`, or null.
This value is stored on the copied review; a copy whose stored project is null links no repository row.

All ids are unique across the bundle and all references stay within it. The hub computes each
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
`emend attach` never brings it back. A retired review is exported with its `settled` state; the
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

With `emend serve --tailscale`, pairing URLs use the configured Tailscale HTTPS origin (with
`--tailscale-port <n>`, that origin includes `:<n>`); the
secret remains exclusively in the fragment. Only that configured tailnet Host is added to
the allowlist. Session cookies use `Secure` when that Host is requested, including renewal
and sign-out; loopback HTTP on the same server receives cookies without `Secure`.

### Manifest and topics

`PublishRequest = { reviewId?, reviewKey, repo: { key, name } | null, branch: string | null,
title, base: commit | null, head: commit | "worktree" | null, main?, topics, writeup, links?, repoUrl?,
files }`.
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
newBlob: sha256 | null, flag: FileFlag | null, parent?: FilePath, assets?: FilePath[], notes?: AgentNote[] }`. Paths and topic slugs are
unique within their namespaces (diffs; rendered docs and assets; source docs); file and writeup topics must be declared.
`assets` is required for rendered HTML docs (including an empty array) and must be absent on all other files.
Assets name a declared HTML doc in `parent`, stay inside its folder and have no hidden or dot
segments. Allowed extensions are js, mjs, css, png, jpg, jpeg, gif, svg, webp, avif, ico, bmp,
woff, woff2, ttf, otf, mp4, webm, ogg, mp3, wav and m4a (case insensitive). Shared assets are
published once, with the first doc as parent. Diff rows always have media type `text/plain`.
An asset with no `parent` is writeup media. Its extension is png, jpg, jpeg, gif, webp or avif
(case insensitive), no segment starts with `.`, and it has no `topic`, `assets` or `notes`. No
HTML doc lists it in `assets`. A request holds at most `mediaPerRevision` (50) of them. Media have
no `FileRole` of their own; they use `role: "asset"` and never appear in file lists, counts or
viewed progress. Only assets have parents. Docs and assets have a new blob, no old side and no flag; flagged
diffs have no blobs. Source filenames never leave the CLI.

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
links?, repoUrl? }`. `links` and `repoUrl` are described under "Links and repoUrl" at the end of
this section.

`main?: "writeup" | FilePath` declares the opening page. A path must name a file of this
manifest with `role: "doc"`; otherwise validation issues `["main"]` with the message
`main is not a doc of this revision`. `"writeup"` opens Writeup even if its Markdown is empty.
`base` and `head` appear together or neither appears. Commits are fully resolved lowercase hex
object ids (40 characters for SHA-1 or 64 for SHA-256); `head` also accepts `"worktree"`.
Docs-only reviews can omit both. Manifest files are `{ path, role: "diff" | "doc", topic?, source?, title?, view?: DocView, notes?: AgentNote[] }`;
`source` is a non-empty local filename from which the CLI reads a doc, separate from its published
path. It may be absolute or relative, has at most `pathChars` characters, must be well-formed UTF-16,
and cannot contain NUL, C0 controls or DEL.

`media?: { path: FilePath, source? }[]` lists images that the writeup embeds, at most
`mediaPerRevision` (50). A `path` ends in png, jpg, jpeg, gif, webp or avif (case insensitive;
SVG and video are refused), has no segment starting with `.`, is unique among media, and never
equals a doc's path. `source` follows the doc `source` rules. The CLI resolves `source ?? path`
exactly like a doc source (the worktree or a `docRoots` folder, regular files only, no symlink
out, none in the git folder), and reads at most `assetBytes` (25 MiB) from each. The real source's
extension must equal the path's extension, ignoring case. Each image is published as a
parentless `asset` file and counts toward `filesPerRevision` and `revisionBytes`. A media path
that equals an HTML doc's asset path is refused. The writeup embeds an image with
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
global emend configuration (`docRoots`). Neither the repository nor the manifest can name an allowed
folder. The worktree root follows the rules `docRoots` follow: the CLI refuses to publish from a
repository whose root is the filesystem root, the home folder or a folder that holds it, or a
folder that holds emend's state folder or sits inside it. A symlink leading outside these roots is
refused. The role's size limit applies.
Plan task 1.6 implements and tests these checks. Assets are collected during publish.

The general `FileRole` vocabulary is `diff`, `doc`, `asset`; `FileStatus` is `added`, `modified`,
`deleted`, `renamed`, `mode-changed`; `FileFlag` is `binary` or `oversized`.
`FilePath` also rejects a segment equal to `.git` or `git~1` after lowercasing and removing
trailing dots/spaces, and rejects HFS-ignorable code points U+206A–U+206F.

`TopicMeta = { slug, title, importance, summary, attention?, door?, blastRadius? }`. A slug matches
`^[a-z0-9][a-z0-9-]{0,63}$`. Importance is a number from 0 through 100; lower sorts first.
Attention is optional: `critical` marks a security boundary, an irreversible effect, data loss,
or a decision only the reviewer can make; `review` marks behaviour worth reading line by line;
`skim` marks mechanical changes, renames, tests that only follow the code, or wording.
Skim topics start folded in the writeup. Attention never changes order: `importance` alone sorts.
When absent, attention stays absent in views and export/import, and the topic starts open.
Door is `one-way` or `two-way`. Blast radius is `{ scope, note }`: scope is one non-whitespace word,
and note must contain non-whitespace text. The fallback is `{ slug: "other", title: "Other changes" }`;
declaring that slug in a manifest fails with `topic slug other is reserved`. It remains a valid
target for automatically grouped changes.

Topic slugs and file paths within each role must be unique within a manifest. A file's topic and every writeup topic
key must name a declared topic. A topic may omit its writeup entry. Titles must contain non-whitespace
text. There are at most `topicsPerReview` declared topics and writeup topic keys. Summaries,
blast-radius scopes and notes obey `summaryChars`, `blastScopeChars` and `blastNoteChars`.
Markdown strings are preserved exactly; the schema does not render or sanitize them.

`WriteupInput = { overview, tldr, outOfScope?, whereToLook?, context?, decisions: string | null, glossary?, topics }`.
Sections are Markdown strings; `topics` maps slugs to `{ why, example?, body? }`, also Markdown. Decisions is
required, with `null` representing no decisions section.
The three new fields `outOfScope`, `whereToLook` and `context` are optional, additive fields under `/api/v1`.
When any is present, even as an empty string, sections render as TL;DR, Overview, Out of scope,
Where to look, Context, Decisions and drift, Glossary, then topics; absent optional fields emit no section.
Without them, the existing order stays Overview, TL;DR, Decisions and drift, Glossary, then topics,
including when an import re-renders stored source.
Every Markdown string is limited to `writeupSectionBytes` UTF-8 bytes; the sum of all present
`overview`, `tldr`, `outOfScope`, `whereToLook`, `context`, `decisions`, `glossary`, `why`, `example`
and `body` strings is limited to `writeupBytes`. These limits measure UTF-8 bytes, not character count. Parsed `topics` has a null
prototype: an absent `topics["constructor"]` is `undefined`, while an explicitly declared
`constructor` topic remains accessible and serializes normally.

#### Links and repoUrl

`links?: PublishLink[]` holds at most 8 entries `{ url, label, kind?: "pr" | "issue" | "other" }`.
`url` is an absolute `https:` URL of at most 2048 characters, without credentials, whitespace or
control characters. `label` is 1 through 60 characters of visible text, without control or format
characters. An invalid link refuses the request (`400 invalid_request`). Links are not Markdown, they
are never counted in `writeupEmpty`, and so a docs-only publish with links stays `kind: "publish"`.

`repoUrl?` is exactly `https://host/owner/name`: a lowercase ASCII host with an optional port, and two
path segments of `A-Za-z0-9._-` (not `.` or `..`), with no userinfo, query or fragment. The CLI derives
it from the repository's `remote.origin.url` (SSH, scp-style and `git://` remotes become https, a trailing
`.git` goes away; a path, a `file:` URL, `http:`, a remote with credentials, or a remote host without a
dot, such as an ssh alias, gives none). A manifest's own `repoUrl` wins when it is valid; an invalid string
in a manifest is dropped and the derived one is used, but one in a `PublishRequest` is refused. A manifest
may set `"repoUrl": null` to opt out: the CLI then sends no `repoUrl` and no `#123` links render. With a
`repoUrl`, the server turns `#123` in rendered writeup and Markdown doc text into a link
to `<repoUrl>/issues/123`, never inside code, a fence, a diagram or an existing link. A number is 1
through 7 digits and must follow a non-word character.

Both ride in the writeup's source and rendered blobs, so an import or export keeps them; no table
changes. Every absolute `http:` or `https:` link in rendered Markdown carries `target="_blank"` and
`rel="noopener noreferrer nofollow"`, including an absolute link back to the same emend review. Clients
open `links` the same way, after checking again that each URL is https, and show each link's host
(punycode for a non-ASCII host) beside its label, with the full URL as the title.

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
A topic quote matches with its prefix and suffix, never the quote alone: first in the part it was
last placed on (or the target's part), when the context match occurs exactly once there; otherwise
when it occurs exactly once across the topic's title and summary. Otherwise it is unplaced as
`ambiguous` or `block-gone`; a gone topic is `topic-gone`.

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

A binned review acts as deleted for agents and leaves every list. A take (`emend wait`,
`emend feedback`, the MCP tools), a waiter, an agent reply, a publish to it by id or by key, and
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
`publish | send | thread | waiting | claimed | confirmed | viewed | snooze | unsnooze | retire | reopen | delete | bin | restore`. `ReviewEvent` has a `type`
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
| `snooze`, `unsnooze`, `retire`, `reopen`, `delete`, `bin`, `restore` | `{ reviewId, revision }` |

Events contain ids and, except for `viewed`, a positive revision sequence only, never paths, text bodies or
instructions. `claimed` follows a successful take; `confirmed` follows a successful
delivery confirmation. `viewed` follows a successful viewed-mark PUT and invalidates that
review's revision queries. These events are emitted after the transaction commits. Events have no
replay ids; clients refresh their cached state on every connection, including the first.
The waiting event signals a change: `agentWaiting(ownerId, reviewId)` stays true during an
open take and for 35 seconds after the last waiting take ends. Views also include
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
the agent to run `emend feedback <review>` in a shell; the Send stays queued. CLI takes retain
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
a binned review prints `review <id> is in the bin`. `emend publish --review <id>` on one prints
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
| `inboxItems` | 200 reviews returned in the inbox |
| `agentReviews` | 100 reviews returned in the agent list |
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
| `headingTextChars` | 200 characters per cleaned heading label |
| `headingIdChars` | 256 characters per declared Markdown heading ID, including its prefix |
| `headingLookupBytesPerRevision` | 33554432 bytes (32 MiB) across distinct heading lookup maps: UTF-8 name and target ID bytes plus 32 bytes per entry |
| `diffSideBytes` | 1048576 bytes shown per side |
| `markdownDocBytes` | 1048576 bytes |
| `htmlDocBytes` | 8388608 bytes |
| `downloadInlineBytes` | 134217728 bytes (128 MiB) of emitted built-in content per download, and the same read budget for stored assets and selected doc bodies; both shared by all files of a ZIP |
| `downloadDocs` | 50 docs added to one download |
| `assetBytes` | 26214400 bytes per asset |
| `htmlDocWithAssetsBytes` | 52428800 bytes combined |
| `revisionBytes` | 268435456 bytes for writeup source JSON and unique referenced blobs; checked before reading content |
| `blocksPerRevision` | 100000 rendered blocks across every path, including the writeup |
| `renderedBytesPerRevision` | 268435456 rendered JSON bytes across every path, including the writeup |
| `filesPerRevision` | 10000 files |
| `mediaPerRevision` | 50 writeup images (counted in `filesPerRevision`; each at most `assetBytes`) |
| `agentNotesPerFile` | 8 notes |
| `agentNotesPerRevision` | 64 notes |
| `pathChars` | 4096 characters per path or source; also per publish URL or block id |
| `pathSegmentChars` | 255 characters per published path segment |
| `topicsPerReview` | 200 declared topics or writeup topic keys |
| `summaryChars` | 2000 characters per topic summary |
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

Binary and oversized diff sides are listed as not shown; publishing still succeeds. The CLI
allocates the revision budget in topic importance order, with Other changes last. Diff sides
that exceed the remaining budget are listed as oversized without uploading their blobs.

## Identifiers and secrets

- Every row id is a UUID generated by `crypto.randomUUID()`. Revision `seq` is additionally a
  positive integer starting at 1 and increasing per review. API fields called `revision` use that
  sequence, not the revision row's UUID.
- Blob hashes are lowercase 64-character hex SHA-256 digests, addressed per owner.
- Block ids are `<section>-<hash8>`. `hash8` is the first eight lowercase hex characters of SHA-256
  over block text normalized to NFC, whitespace runs collapsed to one space, and trimmed. Repeats
  within a section append `-2`, `-3`, and so on. Section keys are `overview`, `tldr`, `outOfScope`,
  `whereToLook`, `context`, `decisions`, `glossary`, `t-<slug>-why`, `t-<slug>-example`, `t-<slug>-body`, and
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
fall back to the document's own title, then its filename. HTML uses
only `head > title`, then the first HTML-namespace `h1` in the body. Markdown uses the first
rendered `h1` heading block, so removed raw HTML cannot supply a title. CLI inferred review titles
use the same extraction. Titles and heading labels are plain cleaned text.

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
is `SourceToken[][]` and a token is `{ text: string, light?: Color, dark?: Color }`. Colors strictly
match `^#[0-9a-fA-F]{3,8}$`; light/dark come from github-light/github-dark. Text is raw data, never HTML. `language` is a loaded Shiki language id
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
