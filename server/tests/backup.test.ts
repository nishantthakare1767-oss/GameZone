import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { createHarness, createDevice, startSession, type Harness } from './helpers.js';
import { backupDatabase } from '../src/scripts/backup.js';
import { restoreDatabase } from '../src/scripts/restore.js';
import { devices, sessions, users } from '../src/db/schema.js';

describe('backup and restore', () => {
  let h: Harness;
  let dir: string;

  beforeEach(async () => {
    h = await createHarness();
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gamehub-backup-'));
  });

  afterEach(async () => {
    await h.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('writes a backup and restores it faithfully', async () => {
    const device = await createDevice(h, { name: 'PC-01' });
    const session = await startSession(h, device.id, 45);

    const backup = await backupDatabase({ backupDir: dir, database: h.database });
    expect(fs.existsSync(backup.file)).toBe(true);
    expect(backup.rows).toBeGreaterThan(0);

    // Diverge from the backup.
    await createDevice(h, { name: 'PC-02' });
    await h.db.delete(sessions).where(eq(sessions.id, session.id));

    expect(await h.db.select().from(devices)).toHaveLength(2);

    const result = await restoreDatabase(backup.file, { database: h.database });
    expect(result.rows).toBe(backup.rows);

    const restoredDevices = await h.db.select().from(devices);
    const restoredSessions = await h.db.select().from(sessions);
    const restoredUsers = await h.db.select().from(users);

    expect(restoredDevices).toHaveLength(1);
    expect(restoredDevices[0]!.name).toBe('PC-01');
    expect(restoredSessions).toHaveLength(1);
    expect(restoredSessions[0]!.id).toBe(session.id);
    // Timestamps survive the JSON round trip as real dates.
    expect(restoredSessions[0]!.expiresAt).toBeInstanceOf(Date);
    expect(restoredSessions[0]!.expiresAt.getTime()).toBe(new Date(session.expiresAt).getTime());
    expect(restoredUsers).toHaveLength(2);
  });

  it('rejects a missing backup file', async () => {
    await expect(
      restoreDatabase(path.join(dir, 'nope.json.gz'), { database: h.database }),
    ).rejects.toThrow(/not found/i);
  });
});
