import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { getTableColumns, getTableName, type Table } from 'drizzle-orm';
import { createDatabase, type Db } from '../db/index.js';
import * as schema from '../db/schema.js';
import { env } from '../env.js';
import { logger } from '../lib/logger.js';

/**
 * Restore order matters because of foreign keys.
 * Backup is written in this order, restore replays it forwards and deletes backwards.
 */
export const TABLE_ORDER: { table: Table; key: string }[] = [
  { table: schema.users, key: 'users' },
  { table: schema.devices, key: 'devices' },
  { table: schema.deviceCredentials, key: 'device_credentials' },
  { table: schema.sessions, key: 'sessions' },
  { table: schema.sessionExtensions, key: 'session_extensions' },
  { table: schema.sessionEvents, key: 'session_events' },
  { table: schema.notifications, key: 'notifications' },
  { table: schema.deviceEvents, key: 'device_events' },
  { table: schema.accessControlEvents, key: 'access_control_events' },
  { table: schema.auditLogs, key: 'audit_logs' },
  { table: schema.cafeSettings, key: 'cafe_settings' },
  { table: schema.idempotencyKeys, key: 'idempotency_keys' },
  { table: schema.integrations, key: 'integrations' },
  { table: schema.workerRuns, key: 'worker_runs' },
  { table: schema.authSessions, key: 'auth_sessions' },
];

export interface BackupResult {
  file: string;
  tables: number;
  rows: number;
}

export interface BackupOptions {
  backupDir?: string;
  /** Inject an existing connection (tests); otherwise one is created and closed. */
  database?: { db: Db; close(): Promise<void> };
}

export async function backupDatabase(options: BackupOptions = {}): Promise<BackupResult> {
  const backupDir = options.backupDir ?? path.resolve(env.dataDir, '../backups');
  const owned = options.database ? null : await createDatabase({ runMigrations: false });
  const database = options.database ?? owned!;
  fs.mkdirSync(backupDir, { recursive: true });

  const tables: Record<string, unknown[]> = {};
  let rows = 0;

  try {
    for (const { table, key } of TABLE_ORDER) {
      const data = await database.db.select().from(table);
      tables[key] = data;
      rows += data.length;
    }
  } finally {
    if (owned) await owned.close();
  }

  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const file = path.join(backupDir, `gamehub-${stamp}.json.gz`);
  const payload = JSON.stringify({ version: 1, createdAt: new Date().toISOString(), tables });
  fs.writeFileSync(file, zlib.gzipSync(Buffer.from(payload, 'utf8')));

  logger.info('backup.complete', { file, rows });
  return { file, tables: TABLE_ORDER.length, rows };
}

export function tableInsertableValue(table: Table, key: string, value: unknown) {
  const columns = getTableColumns(table);
  const column = columns[key as keyof typeof columns];
  if (!column) return value;
  if (column.dataType === 'date' && typeof value === 'string') return new Date(value);
  return value;
}

export { getTableName };

const isDirectRun = process.argv[1]?.replace(/\\/g, '/').endsWith('/backup.ts');
if (isDirectRun) {
  backupDatabase()
    .then((result) => {
      // eslint-disable-next-line no-console
      console.log(`Backup written to ${result.file} (${result.rows} rows from ${result.tables} tables)`);
      process.exit(0);
    })
    .catch((error) => {
      logger.error('backup.failed', { error: error instanceof Error ? error.stack : String(error) });
      process.exit(1);
    });
}
