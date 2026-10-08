/**
 * Key/value access to the `settings` table, behind an interface so services
 * that only need a few flags (the edition) can be unit tested without drizzle.
 */
import { eq } from "drizzle-orm";
import type { Db } from "../db";
import { schemaDialect, settings } from "../db/schema";

type SqliteUpsert = {
  onConflictDoUpdate(cfg: { target: typeof settings.key; set: { value: string } }): Promise<unknown>;
};

export interface SettingsStore {
  get(key: string): Promise<string | null>;
  set(key: string, value: string): Promise<void>;
  delete(key: string): Promise<void>;
}

export class DrizzleSettingsStore implements SettingsStore {
  constructor(private readonly db: Db) {}

  async get(key: string): Promise<string | null> {
    const rows = await this.db.select().from(settings).where(eq(settings.key, key)).limit(1);
    const value = rows[0]?.value;
    return value === undefined || value === "" ? null : value;
  }

  /**
   * The only dialect-specific write in the server: an upsert is
   * `ON DUPLICATE KEY UPDATE` on MySQL and `ON CONFLICT DO UPDATE` on SQLite.
   * `Db` is typed as MySQL for both, hence the explicit check.
   */
  async set(key: string, value: string): Promise<void> {
    if (schemaDialect() === "sqlite") {
      const insert = this.db.insert(settings).values({ key, value }) as unknown as SqliteUpsert;
      await insert.onConflictDoUpdate({ target: settings.key, set: { value } });
      return;
    }
    await this.db.insert(settings).values({ key, value }).onDuplicateKeyUpdate({ set: { value } });
  }

  async delete(key: string): Promise<void> {
    await this.db.delete(settings).where(eq(settings.key, key));
  }
}

/** In-memory store for tests. */
export class MemorySettingsStore implements SettingsStore {
  readonly map = new Map<string, string>();
  async get(key: string): Promise<string | null> {
    return this.map.get(key) ?? null;
  }
  async set(key: string, value: string): Promise<void> {
    this.map.set(key, value);
  }
  async delete(key: string): Promise<void> {
    this.map.delete(key);
  }
}
