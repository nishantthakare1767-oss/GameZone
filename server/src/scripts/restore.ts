import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { getTableColumns } from 'drizzle-orm';
import { createDatabase, type Db } from '../db/index.js';
import { env } from '../env.js';
import { logger } from '../lib/logger.js';
import { TABLE_ORDER, tableInsertableValue } from './backup.js';

interface BackupFile {
  version: number;
  createdAt: string;
  tables: Record<string, Record<string, unknown>[]>;
}

export async function restoreDatabase(
  file: string,
  options: { database?: { db: Db; close(): Promise<void> } } = {},
): Promise<{ tables: number; rows: number }> {
  const absolute = path.resolve(file);
  if (!fs.existsSync(absolute)) throw new Error(`Backup not found: ${absolute}`);

  const raw = absolute.endsWith('.gz')
    ? zlib.gunzipSync(fs.readFileSync(absolute)).toString('utf8')
    : fs.readFileSync(absolute, 'utf8');
  const backup = JSON.parse(raw) as BackupFile;
  if (backup.version !== 1) throw new Error(`Unsupported backup version: ${backup.version}`);

  const owned = options.database ? null : await createDatabase({ runMigrations: true });
  const database = options.database ?? owned!;
  let inserted = 0;

  try {
    // Children first so foreign keys never block the wipe.
    for (const { table } of [...TABLE_ORDER].reverse()) {
      await database.db.delete(table);
    }

    for (const { table, key } of TABLE_ORDER) {
      const rows = backup.tables[key] ?? [];
      if (rows.length === 0) continue;
      const columns = getTableColumns(table);
      const prepared = rows.map((row) => {
        const mapped: Record<string, unknown> = {};
        for (const columnKey of Object.keys(columns)) {
          mapped[columnKey] = tableInsertableValue(table, columnKey, row[columnKey]);
        }
        return mapped;
      });
      // Batched to keep parameter counts sane.
      for (let i = 0; i < prepared.length; i += 200) {
        const chunk = prepared.slice(i, i + 200);
        await database.db.insert(table).values(chunk as never);
        inserted += chunk.length;
      }
    }
  } finally {
    if (owned) await owned.close();
  }

  logger.info('restore.complete', { file: absolute, rows: inserted, database: env.databaseUrl ? 'configured' : 'pglite' });
  return { tables: TABLE_ORDER.length, rows: inserted };
}

const isDirectRun = process.argv[1]?.replace(/\\/g, '/').endsWith('/restore.ts');
if (isDirectRun) {
  const file = process.argv[2];
  if (!file) {
    // eslint-disable-next-line no-console
    console.error('Usage: npm run restore -- <path-to-backup.json.gz>');
    process.exit(1);
  }
  restoreDatabase(file)
    .then((result) => {
      // eslint-disable-next-line no-console
      console.log(`Restored ${result.rows} rows across ${result.tables} tables`);
      process.exit(0);
    })
    .catch((error) => {
      logger.error('restore.failed', { error: error instanceof Error ? error.stack : String(error) });
      process.exit(1);
    });
}
