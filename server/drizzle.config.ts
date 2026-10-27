import { defineConfig } from 'drizzle-kit';

export default defineConfig({
  dialect: 'postgresql',
  schema: './src/db/schema.ts',
  out: './drizzle',
  // Used only by drizzle-kit push / studio. The app migrates through the
  // embedded PGlite engine or node-postgres at boot (see src/db/index.ts).
  dbCredentials: {
    url: process.env.DATABASE_URL?.startsWith('postgres')
      ? process.env.DATABASE_URL
      : 'postgres://postgres@127.0.0.1:5432/placeholder',
  },
  strict: true,
  verbose: true,
});
