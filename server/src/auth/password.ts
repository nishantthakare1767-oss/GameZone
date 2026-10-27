import { randomBytes, scrypt as scryptCb, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';

const scrypt = promisify(scryptCb) as (
  password: string | Buffer,
  salt: string | Buffer,
  keylen: number,
  options: { N: number; r: number; p: number; maxmem: number },
) => Promise<Buffer>;

const N = 16384;
const R = 8;
const P = 1;
const KEYLEN = 64;

/** Format: scrypt$N$r$p$saltHex$hashHex */
export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const hash = await scrypt(password, salt, KEYLEN, { N, r: R, p: P, maxmem: 64 * 1024 * 1024 });
  return `scrypt$${N}$${R}$${P}$${salt.toString('hex')}$${hash.toString('hex')}`;
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const parts = stored.split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt') return false;
  const [, nStr, rStr, pStr, saltHex, hashHex] = parts;
  const params = { N: Number(nStr), r: Number(rStr), p: Number(pStr), maxmem: 64 * 1024 * 1024 };
  if (!Number.isFinite(params.N) || !Number.isFinite(params.r) || !Number.isFinite(params.p)) {
    return false;
  }
  const expected = Buffer.from(hashHex!, 'hex');
  const actual = await scrypt(password, Buffer.from(saltHex!, 'hex'), expected.length, params);
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}

export interface PasswordPolicyResult {
  ok: boolean;
  message?: string;
}

export function checkPasswordPolicy(password: string): PasswordPolicyResult {
  if (password.length < 10) return { ok: false, message: 'Password must be at least 10 characters' };
  if (!/[a-z]/.test(password)) return { ok: false, message: 'Password must contain a lowercase letter' };
  if (!/[A-Z]/.test(password)) return { ok: false, message: 'Password must contain an uppercase letter' };
  if (!/[0-9]/.test(password)) return { ok: false, message: 'Password must contain a number' };
  return { ok: true };
}
