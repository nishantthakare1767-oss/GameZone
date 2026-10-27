import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PGlite } from '@electric-sql/pglite';
import { drizzle as drizzlePglite } from 'drizzle-orm/pglite';
import { migrate as migratePglite } from 'drizzle-orm/pglite/migrator';
import { drizzle as drizzleNode } from 'drizzle-orm/node-postgres';
import { migrate as migrateNode } from 'drizzle-orm/node-postgres/migrator';
import type { PgDatabase } from 'drizzle-orm/pg-core';
import pg from 'pg';
import { env } from '../env.js';
import { logger } from '../lib/logger.js';
import * as schema from './schema.js';

/**
 * One query API for both deployments:
 *  - `pglite:` / empty DATABASE_URL -> embedded PostgreSQL (WASM) for local dev + tests
 *  - `postgres://`                  -> a real PostgreSQL server for the cafe box
 * Both speak PostgreSQL, share this schema and the same SQL migrations.
 */
export type Db = PgDatabase<any, typeof schema>;

export interface Database {
  db: Db;
  kind: 'pglite' | 'postgres';
  close(): Promise<void>;
}

const migrationsFolder = (() => {
  const here = path.dirname(fileURLToPath(import.meta.url));
  // src/db -> server/drizzle (dev) ; dist/db -> server/drizzle (build)
  return path.resolve(here, '../../drizzle');
})();

export interface CreateDatabaseOptions {
  /** Overrides DATABASE_URL. Use `memory://` for an ephemeral database (tests). */
  url?: string;
  runMigrations?: boolean;
}

/**
 * Embedded PostgreSQL is a single-process engine. Two processes opening the same
 * data directory makes PGlite abort inside WASM with an unreadable error, so we
 * hold an explicit lock file and fail fast with an actionable message instead.
 */
function acquireLock(dataDir: string): () => void {
  const lockPath = path.join(dataDir, 'gamehub.lock');
  // PGlite refuses to open a directory that still contains its own pid marker, which
  // is exactly what a hard kill (or a crashed worker) leaves behind. A live GameHub
  // owner is detected through gamehub.lock, so anything else is safe to clean up.
  const pgPidPath = path.join(dataDir, 'postmaster.pid');
  const write = () => fs.writeFileSync(lockPath, JSON.stringify({ pid: process.pid, at: new Date().toISOString() }));

  const existing = fs.existsSync(lockPath) ? fs.readFileSync(lockPath, 'utf8') : null;
  if (existing) {
    let pid = 0;
    try {
      pid = Number((JSON.parse(existing) as { pid?: number }).pid ?? 0);
    } catch {
      pid = 0;
    }
    const alive = pid > 0 && pid !== process.pid && (() => {
      try {
        process.kill(pid, 0);
        return true;
      } catch {
        return false;
      }
    })();
    if (alive) {
      throw new Error(
        `The embedded database in ${dataDir} is already in use by PID ${pid}. ` +
          'Stop that process (or the server) before running migrations, seeding, backup or restore. ' +
          'Use PostgreSQL via DATABASE_URL if you need concurrent access.',
      );
    }
    // Stale lock from a crashed process: take it over.
  }

  if (fs.existsSync(pgPidPath)) {
    fs.rmSync(pgPidPath, { force: true });
    logger.warn('db.stale_pg_lock_removed', { dataDir });
  }

  write();
  return () => {
    try {
      if (fs.existsSync(lockPath)) fs.unlinkSync(lockPath);
    } catch {
      /* best effort */
    }
  };
}

export async function createDatabase(options: CreateDatabaseOptions = {}): Promise<Database> {
  const url = options.url ?? env.databaseUrl;
  const isPostgres = url.startsWith('postgres://') || url.startsWith('postgresql://');

  if (isPostgres) {
    const pool = new pg.Pool({ connectionString: url, max: 10 });
    const db = drizzleNode(pool, { schema });
    if (options.runMigrations !== false) {
      await migrateNode(db, { migrationsFolder });
    }
    return {
      db: db as unknown as Db,
      kind: 'postgres',
      close: async () => {
        await pool.end();
      },
    };
  }

  let dataDir: string;
  if (url === 'memory://' || url === 'pglite:memory' || url === 'pglite:memory://') {
    dataDir = 'memory://';
  } else if (url.startsWith('pglite:')) {
    const target = url.slice('pglite:'.length);
    dataDir = path.isAbsolute(target) ? target : path.resolve(process.cwd(), target);
  } else {
    // No DATABASE_URL: keep an embedded PostgreSQL cluster inside DATA_DIR so it
    // survives restarts (the default for a single-box cafe server).
    dataDir = path.join(env.dataDir, 'pglite');
  }
  if (dataDir !== 'memory://') fs.mkdirSync(dataDir, { recursive: true });
  const releaseLock = dataDir === 'memory://' ? () => {} : acquireLock(dataDir);

  let client: PGlite;
  try {
    client = await PGlite.create(dataDir);
    const db = drizzlePglite(client, { schema });
    if (options.runMigrations !== false) {
      await migratePglite(db, { migrationsFolder });
    }
    return {
      db: db as unknown as Db,
      kind: 'pglite',
      close: async () => {
        try {
          await client.close();
        } finally {
          releaseLock();
        }
      },
    };
  } catch (error) {
    releaseLock();
    throw new Error(
      `Could not open the embedded database at ${dataDir}. ` +
        'Either another GameHub process is using it (stop it first), or the database was not shut ' +
        'down cleanly (for example a forced kill or power loss) and needs recovery. ' +
        'Restore a backup with `npm run restore -- <file>`, or start over with `npm run db:migrate` ' +
        'and `npm run db:seed` on an empty DATA_DIR. PostgreSQL via DATABASE_URL is recommended ' +
        `for production. Original error: ${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    );
  }
}

export { schema };
