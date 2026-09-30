// Web Push with the Web Crypto API: encrypts each message for the phone (RFC 8291) and signs
// the request with the server's VAPID key (RFC 8292). Works in Node 20+ and on Cloudflare.
const { randomBytes, toB64url, fromB64url, concat } = require('./bytes');

const subtle = globalThis.crypto.subtle;
const enc = new TextEncoder();
const RECORD_SIZE = 4096;

/** New VAPID key pair in the usual base64url format (65-byte public point, 32-byte private scalar). */
async function generateVapidKeys() {
  const pair = await subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
  const jwk = await subtle.exportKey('jwk', pair.privateKey);
  const publicKey = new Uint8Array(await subtle.exportKey('raw', pair.publicKey));
  return { publicKey: toB64url(publicKey), privateKey: jwk.d };
}

async function hkdf(ikm, salt, info, length) {
  const key = await subtle.importKey('raw', ikm, 'HKDF', false, ['deriveBits']);
  return new Uint8Array(await subtle.deriveBits({ name: 'HKDF', hash: 'SHA-256', salt, info }, key, length * 8));
}

async function encrypt(subscription, payload) {
  const phonePublic = fromB64url(subscription.keys.p256dh);
  const authSecret = fromB64url(subscription.keys.auth);
  const ours = await subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']);
  const ourPublic = new Uint8Array(await subtle.exportKey('raw', ours.publicKey));
  const phoneKey = await subtle.importKey('raw', phonePublic, { name: 'ECDH', namedCurve: 'P-256' }, false, []);
  const shared = new Uint8Array(await subtle.deriveBits({ name: 'ECDH', public: phoneKey }, ours.privateKey, 256));

  const ikm = await hkdf(shared, authSecret, concat(enc.encode('WebPush: info\0'), phonePublic, ourPublic), 32);
  const salt = randomBytes(16);
  const cek = await hkdf(ikm, salt, enc.encode('Content-Encoding: aes128gcm\0'), 16);
  const nonce = await hkdf(ikm, salt, enc.encode('Content-Encoding: nonce\0'), 12);
  const key = await subtle.importKey('raw', cek, 'AES-GCM', false, ['encrypt']);
  const record = concat(enc.encode(payload), new Uint8Array([2])); // 2 = last (and only) record
  const cipher = new Uint8Array(await subtle.encrypt({ name: 'AES-GCM', iv: nonce, tagLength: 128 }, key, record));

  const header = new Uint8Array(21 + ourPublic.length);
  header.set(salt, 0);
  new DataView(header.buffer).setUint32(16, RECORD_SIZE);
  header[20] = ourPublic.length;
  header.set(ourPublic, 21);
  return concat(header, cipher);
}

async function vapidToken(endpoint, { subject, publicKey, privateKey }, nowMs) {
  const json = obj => toB64url(enc.encode(JSON.stringify(obj)));
  const unsigned = `${json({ typ: 'JWT', alg: 'ES256' })}.${json({
    aud: new URL(endpoint).origin,
    exp: Math.floor(nowMs / 1000) + 12 * 3600,
    sub: subject,
  })}`;
  const pub = fromB64url(publicKey);
  const key = await subtle.importKey('jwk', {
    kty: 'EC', crv: 'P-256', d: privateKey, x: toB64url(pub.slice(1, 33)), y: toB64url(pub.slice(33, 65)),
  }, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign']);
  const signature = new Uint8Array(await subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, key, enc.encode(unsigned)));
  return `${unsigned}.${toB64url(signature)}`;
}

/**
 * Sends one push message. Throws an error with `statusCode` if the push service refuses it
 * (404/410 mean the phone unsubscribed).
 */
async function sendNotification(subscription, payload, options) {
  const { vapidDetails, TTL = 12 * 3600, urgency = 'high', now = Date.now() } = options;
  const fetchImpl = options.fetch || globalThis.fetch;
  if (enc.encode(payload).length > 3000) throw new Error('Push message is too long');
  const body = await encrypt(subscription, payload);
  const jwt = await vapidToken(subscription.endpoint, vapidDetails, now);
  const res = await fetchImpl(subscription.endpoint, {
    method: 'POST',
    headers: {
      TTL: String(TTL),
      Urgency: urgency,
      'Content-Encoding': 'aes128gcm',
      'Content-Type': 'application/octet-stream',
      Authorization: `vapid t=${jwt}, k=${vapidDetails.publicKey}`,
    },
    body,
  });
  if (!res.ok) {
    const err = new Error(`Push service answered ${res.status}`);
    err.statusCode = res.status;
    err.body = await res.text().catch(() => '');
    throw err;
  }
  return { statusCode: res.status };
}

module.exports = { generateVapidKeys, sendNotification };
