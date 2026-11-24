import { expect, test } from "vitest";
import { splitMigrationStatements } from "./migration-sql.ts";

test("embedding rejects multiple SQL statements within one breakpoint chunk", () => {
  expect(() => splitMigrationStatements("CREATE TABLE a (id text); /* separator */ CREATE TABLE b (id text);")).toThrow(
    /statement-breakpoint/,
  );
  expect(() => splitMigrationStatements("SELECT 1; -- comment\nSELECT 2;")).toThrow(/statement-breakpoint/);
  expect(
    splitMigrationStatements("CREATE TABLE a (id text);--> statement-breakpoint\nCREATE TABLE b (id text);"),
  ).toHaveLength(2);
});

test("the embed check ignores semicolons in strings, quoted identifiers and comments", () => {
  for (const chunk of [
    "SELECT 'it''s; synthetic'; -- trailing SQL-looking text; ignored\n",
    'CREATE TABLE "a;""b" (`c;d` text, [e;f] text); /* ignored; text */',
    "/* before; */ SELECT 1 /* inside; */; /* after; */",
  ])
    expect(splitMigrationStatements(chunk)).toEqual([chunk.trim()]);
});
