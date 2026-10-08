/**
 * The tables every service imports. Which dialect's tables these are is decided
 * once, at boot, by createDatabase() calling useSchema().
 *
 * WHY LIVE BINDINGS AND NOT A PARAMETER: services write
 * `this.db.select().from(users)` against ~70 call sites. Drizzle builds SQL
 * from the TABLE object (a MySQL table renders backticks and refuses to join a
 * SQLite query), so the table must match the database. ES module exports are
 * live: reassigning these `let`s is seen by every importer on its next call,
 * which keeps the services dialect-blind without threading a schema through
 * every constructor. Nothing may capture a table at module load — the
 * SQLite integration suite fails if something does.
 *
 * The declared types are the MySQL ones on purpose: schema.sqlite.ts asserts
 * its row/insert types are identical, so the cast in useSchema() is sound for
 * everything the services do with them (select/insert/update/delete/where).
 */
import * as mysqlSchema from "./schema.mysql";
import * as sqliteSchema from "./schema.sqlite";

export type Dialect = "mysql" | "sqlite";

export let users = mysqlSchema.users;
export let sessions = mysqlSchema.sessions;
export let ssoProviders = mysqlSchema.ssoProviders;
export let connections = mysqlSchema.connections;
export let folders = mysqlSchema.folders;
export let folderQueues = mysqlSchema.folderQueues;
export let hiddenQueues = mysqlSchema.hiddenQueues;
export let alerts = mysqlSchema.alerts;
export let alertEvents = mysqlSchema.alertEvents;
export let auditLog = mysqlSchema.auditLog;
export let flowEdges = mysqlSchema.flowEdges;
export let settings = mysqlSchema.settings;
export let mcpClients = mysqlSchema.mcpClients;
export let mcpAuthCodes = mysqlSchema.mcpAuthCodes;
export let mcpGrants = mysqlSchema.mcpGrants;
export let flowMaps = mysqlSchema.flowMaps;
export let flowMapNodes = mysqlSchema.flowMapNodes;
export let flowMapEdges = mysqlSchema.flowMapEdges;

let current: Dialect = "mysql";

export function schemaDialect(): Dialect {
  return current;
}

export function useSchema(dialect: Dialect): void {
  const s = (dialect === "sqlite" ? sqliteSchema : mysqlSchema) as unknown as typeof mysqlSchema;
  users = s.users;
  sessions = s.sessions;
  ssoProviders = s.ssoProviders;
  connections = s.connections;
  folders = s.folders;
  folderQueues = s.folderQueues;
  hiddenQueues = s.hiddenQueues;
  alerts = s.alerts;
  alertEvents = s.alertEvents;
  auditLog = s.auditLog;
  flowEdges = s.flowEdges;
  settings = s.settings;
  mcpClients = s.mcpClients;
  mcpAuthCodes = s.mcpAuthCodes;
  mcpGrants = s.mcpGrants;
  flowMaps = s.flowMaps;
  flowMapNodes = s.flowMapNodes;
  flowMapEdges = s.flowMapEdges;
  current = dialect;
}

export type {
  AlertEventRow,
  AlertRow,
  AuditLogRow,
  ConnectionRow,
  FlowEdgeRow,
  FlowMapEdgeRow,
  FlowMapNodeRow,
  FlowMapRow,
  FolderQueueRow,
  FolderRow,
  HiddenQueueRow,
  McpAuthCodeRow,
  McpClientRow,
  McpGrantRow,
  SessionRow,
  SsoProviderRow,
  UserRow,
} from "./schema.mysql";
