import { mkdirSync } from "node:fs";
import path from "node:path";
import { type Client as LibsqlClient, createClient } from "@libsql/client";
import { drizzle as drizzleMysql, type MySql2Database } from "drizzle-orm/mysql2";
import { drizzle as drizzleSqlite } from "drizzle-orm/libsql";
import mysql from "mysql2/promise";
import * as mysqlSchema from "./schema.mysql";
import * as sqliteSchema from "./schema.sqlite";
import { type Dialect, useSchema } from "./schema";

/**
 * The handle every service codes against. Typed as the MySQL flavour on both
 * dialects: the query-builder surface the services use (select/insert/update/
 * delete/transaction/where) is the same, and the one dialect-specific write —
 * an upsert — branches explicitly (see SettingsStore.set).
 */
export type Db = MySql2Database<typeof mysqlSchema>;

/**
 * Where the dashboard keeps its own data. Nothing set → SQLite in a local file,
 * so `docker run` needs no database at all. DATABASE_URL=mysql://… → MySQL,
 * which is what you want for more than one replica (SQLite is one file on one
 * disk: two instances would each see their own users and sessions).
 */
export type DatabaseConfig = { dialect: "mysql"; url: string } | { dialect: "sqlite"; path: string };

export interface Database {
  dialect: Dialect;
  db: Db;
  /** Runs one raw statement (migrations). */
  exec(sql: string, params?: unknown[]): Promise<void>;
  /** Runs one raw SELECT and returns plain rows (migrations). */
  rows(sql: string): Promise<Record<string, unknown>[]>;
  close(): Promise<void>;
}

export function createDatabase(cfg: DatabaseConfig): Database {
  return cfg.dialect === "sqlite" ? createSqlite(cfg.path) : createMysql(cfg.url);
}

function createMysql(databaseUrl: string): Database {
  useSchema("mysql");
  const pool = mysql.createPool({
    uri: databaseUrl,
    connectionLimit: 10,
    waitForConnections: true,
    timezone: "Z",
    supportBigNumbers: true,
    charset: "utf8mb4",
  });
  const db = drizzleMysql(pool, { schema: mysqlSchema, mode: "default" });
  return {
    dialect: "mysql",
    db,
    exec: async (sql, params) => {
      await pool.query(sql, params);
    },
    rows: async (sql) => {
      const [rows] = await pool.query<mysql.RowDataPacket[]>(sql);
      return rows;
    },
    close: () => pool.end(),
  };
}

/**
 * `:memory:` is accepted for tests. A memory database lives on one connection,
 * so libsql caps it at one and an open transaction blocks every other query —
 * fine for a test, never for the server.
 */
function createSqlite(file: string): Database {
  useSchema("sqlite");
  const inMemory = file === ":memory:";
  if (!inMemory) mkdirSync(path.dirname(path.resolve(file)), { recursive: true });
  const client: LibsqlClient = createClient({
    url: inMemory ? ":memory:" : `file:${path.resolve(file)}`,
    // Busy timeout. Writes are rare (a click, an alert tick) and short, but the
    // alerts engine and a request can still collide; wait instead of failing.
    timeout: 5_000,
  });
  const db = drizzleSqlite(client, { schema: sqliteSchema }) as unknown as Db;
  return {
    dialect: "sqlite",
    db,
    exec: async (sql, params) => {
      await client.execute({ sql, args: (params ?? []) as never });
    },
    rows: async (sql) => {
      const rs = await client.execute(sql);
      return rs.rows.map((r) => ({ ...r }));
    },
    close: async () => client.close(),
  };
}

export interface WaitLogger {
  info(msg: string): void;
  warn(msg: string): void;
}

/**
 * docker compose starts MySQL slowly. Retry the handshake for up to
 * `timeoutMs` (60 s), logging once every `intervalMs` (2 s). SQLite is a local
 * file that createDatabase() already opened, so this is a single probe there.
 */
export async function waitForDatabase(
  database: Pick<Database, "dialect" | "exec">,
  log: WaitLogger,
  opts: { timeoutMs?: number; intervalMs?: number } = {},
): Promise<void> {
  const timeoutMs = opts.timeoutMs ?? 60_000;
  const intervalMs = opts.intervalMs ?? 2_000;
  const name = database.dialect === "sqlite" ? "SQLite" : "MySQL";
  const startedAt = Date.now();
  let lastError: unknown = null;
  while (Date.now() - startedAt < timeoutMs) {
    try {
      await database.exec("SELECT 1");
      return;
    } catch (err) {
      lastError = err;
      if (database.dialect === "sqlite") break;
      const elapsed = Math.round((Date.now() - startedAt) / 1000);
      log.info(`${name} not reachable yet (${elapsed}s): ${errorMessage(err)}. Retrying in ${intervalMs / 1000}s...`);
      await new Promise((r) => setTimeout(r, intervalMs));
    }
  }
  throw new Error(`${name} did not become reachable within ${timeoutMs / 1000}s: ${errorMessage(lastError)}`);
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
