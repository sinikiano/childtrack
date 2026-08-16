import { test } from 'node:test';
import assert from 'node:assert/strict';
import { hashPassword, verifyPassword, newToken } from '../src/auth.js';

test('hash/verify roundtrip', () => {
  const { hash, salt } = hashPassword('hunter2');
  assert.equal(verifyPassword('hunter2', hash, salt), true);
  assert.equal(verifyPassword('wrong', hash, salt), false);
});

test('same password, different salts -> different hashes', () => {
  const a = hashPassword('pw');
  const b = hashPassword('pw');
  assert.notEqual(a.salt, b.salt);
  assert.notEqual(a.hash, b.hash);
});

test('wrong-length hash fails safely', () => {
  assert.equal(verifyPassword('x', 'abc', 'salt'), false);
});

test('newToken is long and unique', () => {
  const a = newToken(), b = newToken();
  assert.equal(a.length, 64);
  assert.notEqual(a, b);
  const short = newToken(16);
  assert.equal(short.length, 32);
});
