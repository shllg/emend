---
paths:
  - "apps/recense/src/db/**"
  - "apps/recense/drizzle/**"
  - "apps/recense/drizzle.config.ts"
---

# Database

- The schema lives in `apps/recense/src/db/schema.ts`. Generate migrations with `pnpm db:generate`;
  recense applies them itself when it opens its database.
- Never edit, rename or delete a committed migration. Add a new one.
- Never run `drizzle-kit push`, `drizzle-kit migrate` or `drizzle-kit studio`.
- Every owned table has a non-null, indexed `owner_id`, and every repo function takes `ownerId`
  first.
- Ids are `crypto.randomUUID()`. A revision also carries `seq` per review.
- A re-publish adds rows and blobs. It never overwrites or deletes an earlier revision.
- The pragmas are `journal_mode = WAL`, `busy_timeout = 5000` and `foreign_keys = ON`.
- Tests open databases in temporary `RECENSE_HOME` folders, never in the real state directory.
- A migration that drops or rewrites data needs the owner's explicit approval in its task.
