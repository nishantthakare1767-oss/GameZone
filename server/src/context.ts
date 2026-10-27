import type { Db } from './db/index.js';
import type { Clock } from './lib/clock.js';
import type { RealtimeBus } from './realtime.js';
import type { SettingsService } from './services/settings.js';

/** Everything the domain services need. Constructed once per process (or per test). */
export interface Ctx {
  db: Db;
  clock: Clock;
  realtime: RealtimeBus;
  settings: SettingsService;
}

export interface Actor {
  id: string;
  username: string;
  displayName: string;
  role: 'ADMIN' | 'STAFF';
}
