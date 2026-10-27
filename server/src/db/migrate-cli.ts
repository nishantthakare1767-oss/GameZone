import { createDatabase } from './index.js';
import { env } from '../env.js';
import { logger } from '../lib/logger.js';

async function main() {
  const database = await createDatabase({ runMigrations: true });
  logger.info('migrations.applied', {
    database: database.kind,
    target: env.databaseUrl.startsWith('postgres') ? 'postgres' : 'embedded PostgreSQL (PGlite)',
  });
  await database.close();
}

main().catch((error) => {
  logger.error('migrations.failed', { error: error instanceof Error ? error.stack : String(error) });
  process.exit(1);
});
