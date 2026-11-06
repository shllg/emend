import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { and, eq, inArray, isNull, ne } from "drizzle-orm";
import { type Db, openDb } from "../db/client.ts";
import { migrate } from "../db/migrate.ts";
import { instances, owners, tokens } from "../db/schema.ts";
import { ensureStateDir, StateFolderWriteError, writeSecretFile } from "../state/files.ts";
import { loadOrCreateInstance } from "../state/instance.ts";
import { readTokenFile } from "../state/token-file.ts";
import { BlobStore } from "../store/blobs.ts";
import { BEARER_SHAPE, liveToken, rotateLocalToken } from "./auth/tokens.ts";

export async function initializeServerState(stateDir: string, options: { tokens?: boolean } = {}) {
  let db: Db | undefined;
  try {
    ensureStateDir(stateDir);
    db = openDb(join(stateDir, "emend.db"));
    await migrate(db, { offThread: true });
    const instance = await loadOrCreateInstance(stateDir);
    const setup = await db.transaction(
      async (q) => {
        await q
          .insert(instances)
          .values({ ...instance, isSelf: true, wasSelf: true })
          .onConflictDoUpdate({ target: instances.id, set: { name: instance.name, isSelf: true, wasSelf: true } });
        // Bootstrap has no principal yet; the local server has one owner.
        const owner = (await q.select().from(owners).get()) ?? (await q.insert(owners).values({}).returning().get());
        if (!owner) throw new Error("Could not initialize server state.");
        const ownerId = owner.id;
        if (options.tokens === false) return { ownerId };
        const now = Date.now();
        const earlierSelf = and(eq(instances.isSelf, true), ne(instances.id, instance.id));
        // Retire all earlier local identities; attached instances retain their credentials.
        await q
          .update(tokens)
          .set({ revokedAt: now })
          .where(
            and(
              eq(tokens.ownerId, ownerId),
              inArray(tokens.kind, ["admin", "agent"]),
              inArray(tokens.instanceId, q.select({ id: instances.id }).from(instances).where(earlierSelf)),
              isNull(tokens.revokedAt),
            ),
          );
        await q.update(instances).set({ isSelf: false }).where(earlierSelf);
        // Adopt local admin credentials created before admin tokens carried an instance id.
        await q
          .update(tokens)
          .set({ instanceId: instance.id })
          .where(and(eq(tokens.ownerId, ownerId), eq(tokens.kind, "admin"), isNull(tokens.instanceId)));
        for (const kind of ["admin", "agent"] as const) {
          const path = join(stateDir, `${kind}.token`);
          const secret = await readTokenFile(path, { tighten: true });
          const token = secret && BEARER_SHAPE.test(secret) ? await liveToken(q, secret, now) : null;
          if (!token || token.ownerId !== ownerId || token.kind !== kind || token.instanceId !== instance.id) {
            const replacement =
              kind === "admin"
                ? await rotateLocalToken(q, ownerId, "admin", instance.id, now)
                : await rotateLocalToken(q, ownerId, "agent", instance.id, now);
            // Keep the file and database decision under the same writer lock.
            writeSecretFile(path, replacement.secret, stateDir);
          }
        }
        return { ownerId };
      },
      { offThread: true },
    );
    return { db, instance, ownerId: setup.ownerId, blobs: new BlobStore(db, stateDir) };
  } catch (error) {
    await db?.close();
    const { code, path } = error as NodeJS.ErrnoException;
    const contains = (parent: string, child: string) => {
      const suffix = relative(resolve(parent), resolve(child));
      return suffix !== ".." && !suffix.startsWith(`..${sep}`) && !isAbsolute(suffix);
    };
    if (
      ["EACCES", "EPERM", "EROFS", "ENOENT"].includes(code ?? "") &&
      typeof path === "string" &&
      (contains(stateDir, path) || contains(path, stateDir))
    )
      throw new StateFolderWriteError(stateDir);
    throw error;
  }
}
