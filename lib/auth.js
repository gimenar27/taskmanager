// Passwords, login sessions and signed links, built on the Web Crypto API so the same code
// runs in Node and on Cloudflare.
const { randomBytes, toB64url, fromB64url, toHex, timingSafeEqual } = require('./bytes');

const subtle = globalThis.crypto.subtle;
const enc = new TextEncoder();
const PBKDF2_ITERATIONS = 100000; // the highest count Cloudflare Workers accepts

async function pbkdf2(password, salt, iterations) {
  const key = await subtle.importKey('raw', enc.encode(password), 'PBKDF2', false, ['deriveBits']);
  return new Uint8Array(await subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt, iterations }, key, 256));
}

async function hashPassword(password) {
  const salt = randomBytes(16);
  const hash = await pbkdf2(password, salt, PBKDF2_ITERATIONS);
  return `pbkdf2$${PBKDF2_ITERATIONS}$${toB64url(salt)}$${toB64url(hash)}`;
}

async function verifyPassword(password, stored) {
  if (typeof stored !== 'string' || !stored.startsWith('pbkdf2$')) return false;
  const [, iterations, salt, hash] = stored.split('$');
  const actual = await pbkdf2(password, fromB64url(salt), Number(iterations));
  return timingSafeEqual(actual, fromB64url(hash));
}

// Accounts created by the first version stored the password as plain text.
function matchesLegacyPassword(password, legacy) {
  if (typeof legacy !== 'string' || !legacy) return false;
  return timingSafeEqual(enc.encode(password), enc.encode(legacy));
}

function newToken() { return toB64url(randomBytes(32)); }
function randomHex(bytes) { return toHex(randomBytes(bytes)); }

async function sha256(value) {
  return toHex(new Uint8Array(await subtle.digest('SHA-256', enc.encode(value))));
}

const hmacKeys = new Map();
async function hmac(secret, data) {
  let key = hmacKeys.get(secret);
  if (!key) {
    key = await subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
    hmacKeys.set(secret, key);
  }
  return new Uint8Array(await subtle.sign('HMAC', key, enc.encode(data)));
}

// Small signed tokens for notification buttons and calendar links (no login needed to use them).
async function sign(secret, payload) {
  const body = toB64url(enc.encode(JSON.stringify(payload)));
  return `${body}.${toB64url(await hmac(secret, body))}`;
}

async function verify(secret, token, nowMs = Date.now()) {
  if (typeof token !== 'string' || !token.includes('.')) return null;
  const [body, mac] = token.split('.');
  try {
    if (!timingSafeEqual(fromB64url(mac), await hmac(secret, body))) return null;
    const payload = JSON.parse(new TextDecoder().decode(fromB64url(body)));
    if (payload.exp && nowMs > payload.exp) return null;
    return payload;
  } catch {
    return null;
  }
}

// Very small in-memory rate limiter: returns false once a key goes over `max` hits in the window.
function createRateLimiter({ windowMs, max }) {
  const hits = new Map();
  return function allow(key, now = Date.now()) {
    if (hits.size > 10000) {
      for (const [k, v] of hits) if (now - v.start > windowMs) hits.delete(k);
    }
    const entry = hits.get(key);
    if (!entry || now - entry.start > windowMs) {
      hits.set(key, { start: now, count: 1 });
      return true;
    }
    return ++entry.count <= max;
  };
}

module.exports = {
  hashPassword, verifyPassword, matchesLegacyPassword, newToken, randomHex, sha256, sign, verify, createRateLimiter,
};
