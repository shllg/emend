---
paths:
  - "apps/emend/src/cli/commands/look.ts"
  - "apps/emend/src/cli/commands/look.test.ts"
  - "packages/core/src/html-look-file.ts"
  - "packages/core/src/html-look.ts"
---

# emend look

`emend look` rewrites HTML files inside repos under review. `cli.md` and `cli-runtime.md` apply too.

- It reads and rewrites only the files it names, never a folder: a regular file named `.html` or
  `.htm`, UTF-8 without NUL, at most `htmlDocBytes` before and after the change. Only the last
  path part is checked for a symlink; a symlinked folder on the way is followed.
- It opens the file with `O_NOFOLLOW` and checks device and inode against `lstat`. It writes a new
  file beside it, created with mode `0o600`, gives it the original group, then the original mode,
  and renames it over the original only while the path still names the same device and inode.
- It refuses a file another user owns, or one without owner write permission.
- It runs no git. Its themes come only from the config folder.
- It adds only emend's checked page stylesheet and checked theme colours; a page marked custom
  stays unchanged. It replaces only a leading copy of the exact shape it writes, and every other
  byte of the page stays as it was.
- `stripHtmlLook` removes exactly that leading copy and nothing else. The content route, the
  Download, doc metadata and `htmlLook` all read the stripped page, so the frame, the Download and
  the classification agree. Change the strip and `applyHtmlLook`'s chunk only together.
