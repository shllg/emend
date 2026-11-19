---
paths:
  - "apps/emend/src/cli/commands/look.ts"
  - "apps/emend/src/cli/commands/look.test.ts"
---

# emend look

`emend look` rewrites HTML files inside repos under review. `cli.md` and `cli-runtime.md` apply too.

- It reads and rewrites only the files it names, never a folder: a regular file, not a symlink,
  named `.html` or `.htm`, UTF-8 without NUL, at most `htmlDocBytes` before and after the change.
- It opens the file with `O_NOFOLLOW` and checks device and inode against `lstat`. It writes a new
  file beside it and renames that over the original after checking the original is unchanged,
  keeping its mode and group.
- It refuses a file another user owns, or one without owner write permission.
- It runs no git. Its themes come only from the config folder.
- It adds only emend's checked page stylesheet and checked theme colours. It never removes or
  rewrites the page's own markup, and a page marked custom stays unchanged.
