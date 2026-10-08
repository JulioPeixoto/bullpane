/**
 * Tiny SQL migrator. Applies migrations/<dialect>/*.sql in filename order, once
 * each, tracked in `_migrations`. Statements are split on ";\n".
 *
 * The two dialects keep separate histories on purpose. MySQL's files are what
 * existing installs already ran (names are recorded without the directory, so
 * moving them under mysql/ was invisible to those installs). SQLite started at
 * the current schema, so its 0001 is the whole schema at once; from there on a
 * schema change is one file in EACH directory.
 */
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import type { Database, WaitLogger } from "./index";
import { SERVER_ROOT } from "../config";

export const MIGRATIONS_DIR = path.resolve(SERVER_ROOT, "migrations");

export function splitStatements(sql: string): string[] {
  const withoutComments = sql
    .split("\n")
    .filter((line) => !line.trimStart().startsWith("--"))
    .join("\n");
  return withoutComments
    .split(/;\s*\n/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

export async function runMigrations(
  database: Pick<Database, "dialect" | "exec" | "rows">,
  log: WaitLogger,
  dir: string = path.join(MIGRATIONS_DIR, database.dialect),
): Promise<{ applied: string[] }> {
  if (database.dialect === "sqlite") {
    // WAL lets the dashboard read while the alerts engine writes. It is a
    // property of the file, so setting it on every boot is a no-op after the first.
    await database.exec("PRAGMA journal_mode=WAL");
    await database.exec(
      "CREATE TABLE IF NOT EXISTS _migrations (" +
        "name TEXT NOT NULL PRIMARY KEY, " +
        "applied_at INTEGER NOT NULL DEFAULT (CAST(unixepoch('subsec') * 1000 AS INTEGER)))",
    );
  } else {
    await database.exec(
      "CREATE TABLE IF NOT EXISTS _migrations (" +
        "name VARCHAR(255) NOT NULL PRIMARY KEY, " +
        "applied_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3)" +
        ") ENGINE=InnoDB DEFAULT CHARSET=utf8mb4",
    );
  }
  const rows = await database.rows("SELECT name FROM _migrations");
  const done = new Set(rows.map((r) => String(r.name)));

  const files = (await readdir(dir)).filter((f) => f.endsWith(".sql")).sort();
  const applied: string[] = [];
  for (const file of files) {
    if (done.has(file)) continue;
    const sql = await readFile(path.join(dir, file), "utf8");
    log.info(`Applying migration ${file}`);
    for (const statement of splitStatements(sql)) {
      await database.exec(statement);
    }
    await database.exec("INSERT INTO _migrations (name) VALUES (?)", [file]);
    applied.push(file);
  }
  return { applied };
}
