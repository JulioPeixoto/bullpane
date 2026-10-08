/**
 * BullMQ Pro's own API, when the customer installed it next to Bullpane.
 *
 * Core bullmq does not know about groups. Its promote, retry and add put a grouped
 * job in the queue-wide wait list, where a Pro worker runs it outside its group:
 * no group concurrency, no group rate limit, even while the group is paused. Its
 * remove deletes a waiting job's hash and leaves the id in the group's list. Pro
 * ships its own scripts for all of these (promote-9.lua calls addToGroup,
 * removeJob-4.lua removes "from any state or group", verified in 7.38.5), and the
 * group operations (deleteGroup, pauseGroup, resumeGroup) only exist there.
 *
 * Bullpane cannot bundle Pro: it is a commercial package behind a private
 * registry. So it is optional. When `@taskforcesh/bullmq-pro` resolves, writes on
 * Pro queues go through QueuePro / JobPro; when it does not, the writes core
 * bullmq would get wrong on a group are refused (see RedisInspector) and every
 * read keeps working. See docs/BULLMQ-PRO.md.
 */
import { createRequire } from "node:module";
import path from "node:path";
import { pathToFileURL } from "node:url";
import type { Queue, QueueOptions } from "bullmq";

const PACKAGE = "@taskforcesh/bullmq-pro";

/** The part of QueuePro Bullpane calls. Typed here because the package is never a dependency. */
export interface BullmqProQueue extends Queue {
  deleteGroup(groupId: string): Promise<void>;
  deleteGroups(): Promise<void>;
  pauseGroup(groupId: string): Promise<boolean>;
  resumeGroup(groupId: string): Promise<boolean>;
}

export interface BullmqProModule {
  QueuePro: new (name: string, opts: QueueOptions) => BullmqProQueue;
}

export interface LoadedBullmqPro {
  module: BullmqProModule;
  version: string | null;
}

/**
 * Resolves the package from `dir` (a folder where it was `npm install`ed, the
 * Docker recipe) or else from Bullpane's own node_modules. null when it is not
 * installed; any other failure (a broken install) is thrown so the boot says so.
 */
export async function loadBullmqPro(dir?: string): Promise<LoadedBullmqPro | null> {
  const base = dir ? path.join(path.resolve(dir), "package.json") : import.meta.url;
  const require = createRequire(base);
  let entry: string;
  try {
    entry = require.resolve(PACKAGE);
  } catch {
    return null;
  }
  const mod = (await import(pathToFileURL(entry).href)) as Partial<BullmqProModule> & { default?: Partial<BullmqProModule> };
  const QueuePro = mod.QueuePro ?? mod.default?.QueuePro;
  if (typeof QueuePro !== "function") throw new Error(`${PACKAGE} at ${entry} does not export QueuePro`);
  let version: string | null = null;
  try {
    version = (require(`${PACKAGE}/package.json`) as { version?: string }).version ?? null;
  } catch {
    // the package may not export its package.json; the version is only for the boot banner
  }
  return { module: { QueuePro }, version };
}
