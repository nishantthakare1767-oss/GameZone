import 'dotenv/config';
import path from 'node:path';

function bool(value: string | undefined, fallback: boolean): boolean {
  if (value === undefined || value === '') return fallback;
  return ['1', 'true', 'yes', 'on'].includes(value.toLowerCase());
}

function num(value: string | undefined, fallback: number): number {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

/** Port 0 is rejected: some shells export PORT=0, which would pick a random port. */
function port(value: string | undefined, fallback: number): number {
  const n = num(value, fallback);
  return Number.isInteger(n) && n > 0 && n < 65536 ? n : fallback;
}

const nodeEnv = process.env.NODE_ENV ?? 'development';

export const env = {
  nodeEnv,
  isProduction: nodeEnv === 'production',
  isTest: nodeEnv === 'test',
  port: port(process.env.PORT, 4000),
  /** postgres://… for the cafe server; pglite:<dir> (or empty) for embedded Postgres. */
  databaseUrl: process.env.DATABASE_URL?.trim() || '',
  dataDir: path.resolve(process.env.DATA_DIR ?? './data'),
  /** Comma separated list of allowed dashboard origins. */
  corsOrigins: (process.env.CORS_ORIGIN ?? 'http://localhost:5173,http://127.0.0.1:5173')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean),
  sessionTtlHours: num(process.env.SESSION_TTL_HOURS, 12),
  cookieName: process.env.SESSION_COOKIE_NAME ?? 'gamehub_session',
  cookieSecure: bool(process.env.COOKIE_SECURE, nodeEnv === 'production'),
  /** Only enable behind a TLS-terminating reverse proxy / VPN. */
  trustProxy: bool(process.env.TRUST_PROXY, false),
  loginRateLimit: num(process.env.LOGIN_RATE_LIMIT, 20),
  /** How often the expiry worker scans. */
  expiryScanIntervalMs: num(process.env.EXPIRY_SCAN_INTERVAL_MS, 5000),
  /** Disable background timers in tests; the worker is driven manually. */
  runWorkers: bool(process.env.RUN_WORKERS, nodeEnv !== 'test'),
  seedOnStart: bool(process.env.SEED_ON_START, false),
  logLevel: process.env.LOG_LEVEL ?? (nodeEnv === 'test' ? 'silent' : 'info'),
} as const;

export type Env = typeof env;
