import crypto from 'node:crypto';

const N = 16384, r = 8, p = 1, KEYLEN = 64;

export function hashPassword(password, salt = crypto.randomBytes(16).toString('hex')) {
  const hash = crypto.scryptSync(password, salt, KEYLEN, { N, r, p }).toString('hex');
  return { hash, salt };
}

export function verifyPassword(password, hash, salt) {
  const test = crypto.scryptSync(password, salt, KEYLEN, { N, r, p });
  const a = Buffer.from(hash, 'hex');
  if (a.length !== test.length) return false;
  return crypto.timingSafeEqual(a, test);
}

export function newToken(bytes = 32) {
  return crypto.randomBytes(bytes).toString('hex');
}
