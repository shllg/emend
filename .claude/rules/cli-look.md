---
paths:
  - "apps/recense/src/cli/commands/look.ts"
  - "apps/recense/src/cli/commands/look.test.ts"
  - "packages/core/src/html-look*.ts"
---

# recense look

`recense look` rewrites HTML files inside repos under review. `cli.md` and `cli-runtime.md` apply too.

- It reads and rewrites only the files it names, never a folder: a regular file named `.html` or
  `.htm`, UTF-8 without NUL, at most `htmlDocBytes` before and after the change. Only the last
  path part is checked for a symlink; a symlinked folder on the way is followed.
- It opens the file with `O_NOFOLLOW | O_NONBLOCK`, checks device and inode against `lstat`, and
  reads exactly the size the descriptor reports; a file that grows or shrinks meanwhile is refused.
- It writes a new file beside it, created with mode `0o600`, gives it the original group, then the
  original mode. Right before the rename the path must still name the same device and inode, with
  the size, mtime and ctime the descriptor had before the read. A change after that check is not
  caught: `rename` cannot compare and swap.
- It refuses a file another user owns, or one without owner write permission.
- It runs no git. Its themes come only from the config folder.
- It adds only recense's checked page stylesheet and checked theme colours; a page marked custom
  stays unchanged. It replaces only the leading copy described below, and every other byte of the
  page stays as it was.
- `stripHtmlLook` removes, at `htmlLookInsertAt`, a `<meta charset="utf-8"><style data-recense-look>`
  element, after an optional `<html data-theme="light">`, that ends at the first `</`, which must be
  `</style>`, whatever CSS it holds. Doc metadata (look, title, headings) and `htmlLook` always
  read the stripped page; the content route and the Download strip it for pages in recense's look.
  Change the strip and `applyHtmlLook`'s chunk only together.
