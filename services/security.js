// services/security.js — password hashing using Node crypto (no deps)
'use strict';

const crypto = require('crypto');

const ITER = 120_000;
const KEYLEN = 32;
const DIGEST = 'sha256';

function makeSalt() {
  return crypto.randomBytes(16).toString('hex');
}

function hashPassword(password, salt) {
  const s = salt || makeSalt();
  const hash = crypto.pbkdf2Sync(String(password), s, ITER, KEYLEN, DIGEST).toString('hex');
  return { salt: s, hash, algo: `pbkdf2:${DIGEST}:${ITER}:${KEYLEN}` };
}

function safeEq(a, b) {
  try {
    const A = Buffer.from(String(a), 'hex');
    const B = Buffer.from(String(b), 'hex');
    if (A.length !== B.length) return false;
    return crypto.timingSafeEqual(A, B);
  } catch {
    return false;
  }
}

function verifyPassword(password, salt, hash) {
  const calc = crypto.pbkdf2Sync(String(password), String(salt), ITER, KEYLEN, DIGEST).toString('hex');
  return safeEq(calc, hash);
}

module.exports = {
  makeSalt,
  hashPassword,
  verifyPassword,
};
