const test = require('node:test');
const assert = require('node:assert/strict');
const { createApp } = require('../lib/app');
const { openNodeDatabase } = require('../lib/db-node');
const auth = require('../lib/auth');
const { verifyScrypt } = require('../server');

async function setup(startIso = '2026-10-14T15:59:00Z', overrides = {}) {
  let clock = Date.parse(startIso);
  const pushes = [];
  const silent = { error() {}, log() {} };
  const db = openNodeDatabase(':memory:');
  const core = await createApp({
    db,
    env: {},
    now: () => clock,
    log: silent,
    sendPush: async (sub, payload) => { pushes.push({ endpoint: sub.endpoint, ...JSON.parse(payload) }); },
    ...overrides,
  });

  // Calls the API directly (no network), exactly like a request from the app.
  async function call(method, path, body, token, headers = {}) {
    const res = await core.app.fetch(new Request(`http://taskflow.test/api${path}`, {
      method,
      headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}), ...headers },
      body: body ? JSON.stringify(body) : undefined,
    }));
    const text = await res.text();
    let data; try { data = JSON.parse(text); } catch { data = text; }
    return { status: res.status, data };
  }

  async function signup(name, email) {
    const { data } = await call('POST', '/signup', { name, email, password: 'secret123', timezone: 'America/Los_Angeles' });
    await call('POST', '/push/subscribe', { subscription: { endpoint: `https://push.example/${email}`, keys: { p256dh: 'k', auth: 'a' } } }, data.token);
    return data.token;
  }

  return {
    call, signup, db, pushes,
    scheduler: { tick: core.tick },
    setClock: iso => { clock = Date.parse(iso); },
    close: () => db.close(),
  };
}

test('sign up, log in, and reject bad passwords', async t => {
  const s = await setup(); t.after(s.close);
  const token = await s.signup('Gimena', 'Gimena@Example.com');
  assert.ok(token);
  assert.equal((await s.call('POST', '/login', { email: 'gimena@example.com', password: 'nope' })).status, 401);
  const ok = await s.call('POST', '/login', { email: 'gimena@example.com', password: 'secret123' });
  assert.equal(ok.status, 200);
  assert.equal(ok.data.user.name, 'Gimena');
  assert.equal((await s.call('GET', '/reminders')).status, 401);
  assert.equal((await s.call('POST', '/signup', { name: 'X', email: 'gimena@example.com', password: 'secret123' })).status, 409);
});

test('old plain-text passwords still work and get upgraded', async t => {
  const s = await setup(); t.after(s.close);
  s.db.prepare("INSERT INTO users (name, email, password) VALUES ('Old', 'old@example.com', 'hunter2')").run();
  const res = await s.call('POST', '/login', { email: 'old@example.com', password: 'hunter2' });
  assert.equal(res.status, 200);
  const row = s.db.prepare("SELECT password, password_hash FROM users WHERE email = 'old@example.com'").get();
  assert.equal(row.password, null);
  assert.ok(await auth.verifyPassword('hunter2', row.password_hash));
});

test('credit card reminder is pushed the day before and on the day at 9 AM local time', async t => {
  const s = await setup('2026-10-14T15:58:00Z'); t.after(s.close);   // 8:58 AM in Los Angeles
  const token = await s.signup('Gimena', 'g@example.com');
  const created = await s.call('POST', '/reminders', {
    title: 'Credit card', kind: 'bill', amount: '$250', repeat: 'monthly', start_date: '2026-10-15', time: '09:00', alerts: [1, 0],
  }, token);
  assert.equal(created.status, 201);
  assert.match(created.data.reminder.ics_url, /calendar\.ics\?sig=/);

  await s.scheduler.tick();
  assert.equal(s.pushes.length, 0, 'nothing before 9 AM');

  s.setClock('2026-10-14T16:00:30Z');                          // 9:00 AM LA
  await s.scheduler.tick();
  await s.scheduler.tick();                                     // a second tick must not resend
  assert.equal(s.pushes.length, 1);
  assert.equal(s.pushes[0].title, '💳 Credit card');
  assert.equal(s.pushes[0].body, 'Due tomorrow · $250');

  s.setClock('2026-10-15T16:01:00Z');
  await s.scheduler.tick();
  assert.equal(s.pushes.length, 2);
  assert.equal(s.pushes[1].body, 'Due today · $250');
});

test('marking this month paid (from the notification button) skips the rest of this month', async t => {
  const s = await setup('2026-10-14T16:00:30Z'); t.after(s.close);
  const token = await s.signup('Gimena', 'g@example.com');
  await s.call('POST', '/reminders', { title: 'Visa', kind: 'bill', repeat: 'monthly', start_date: '2026-10-15', alerts: [1, 0] }, token);
  await s.scheduler.tick();
  assert.equal(s.pushes.length, 1);

  const action = await s.call('POST', '/action', { token: s.pushes[0].token, action: 'done' });
  assert.equal(action.status, 200);
  const { data } = await s.call('GET', '/reminders', null, token);
  assert.equal(data.reminders[0].completed_through, '2026-10-15');

  s.setClock('2026-10-15T16:01:00Z');
  await s.scheduler.tick();
  assert.equal(s.pushes.length, 1, 'no "due today" after paying');

  s.setClock('2026-11-14T17:00:30Z');                          // 9 AM LA after DST ends
  await s.scheduler.tick();
  assert.equal(s.pushes.length, 2);
  assert.equal(s.pushes[1].body, 'Due tomorrow');

  assert.equal((await s.call('POST', '/action', { token: 'forged.token', action: 'done' })).status, 403);
});

test('to-do nags N times a day until done', async t => {
  const s = await setup('2026-09-27T15:00:00Z'); t.after(s.close);   // 8 AM LA
  const token = await s.signup('Gimena', 'g@example.com');
  const { data } = await s.call('POST', '/reminders', { title: 'Finish essay', nag_per_day: 3, nag_start: '09:00', nag_end: '21:00' }, token);
  assert.equal(data.reminder.nag_from, '2026-09-27');

  for (const iso of ['2026-09-27T16:00:10Z', '2026-09-27T22:00:10Z', '2026-09-28T04:00:10Z']) {
    s.setClock(iso);
    await s.scheduler.tick();
  }
  assert.deepEqual(s.pushes.map(p => p.body.slice(0, 19)), ['Reminder 1 of 3 tod', 'Reminder 2 of 3 tod', 'Reminder 3 of 3 tod']);

  await s.call('POST', `/reminders/${data.reminder.id}/done`, {}, token);
  s.setClock('2026-09-28T16:00:10Z');
  await s.scheduler.tick();
  assert.equal(s.pushes.length, 3, 'stops after done');
});

test('sharing: both people get notified, invites become shares on sign-up', async t => {
  const s = await setup('2026-10-14T15:00:00Z'); t.after(s.close);
  const me = await s.signup('Gimena', 'g@example.com');
  const ryan = await s.signup('Ryan', 'ryan@example.com');
  const { data } = await s.call('POST', '/reminders', {
    title: 'Rent', kind: 'bill', repeat: 'monthly', start_date: '2026-10-15', alerts: [1], share_with: ['ryan@example.com', 'new@example.com'],
  }, me);
  assert.deepEqual(data.shares.map(x => x.status), ['shared', 'invited']);
  assert.equal(s.pushes.filter(p => p.title === '🤝 New shared reminder').length, 1);

  const theirs = await s.call('GET', '/reminders', null, ryan);
  assert.equal(theirs.data.reminders.length, 1);
  assert.equal(theirs.data.reminders[0].is_owner, false);
  assert.equal(theirs.data.reminders[0].owner.name, 'Gimena');

  s.pushes.length = 0;
  s.setClock('2026-10-14T16:00:30Z');
  await s.scheduler.tick();
  assert.deepEqual(s.pushes.map(p => p.endpoint).sort(), ['https://push.example/g@example.com', 'https://push.example/ryan@example.com']);

  const newbie = await s.signup('Newbie', 'new@example.com');
  assert.equal((await s.call('GET', '/reminders', null, newbie)).data.reminders.length, 1);

  // Ryan can't remove others, but can leave; only the owner deletes for everyone.
  const id = data.reminder.id;
  const newbieId = s.db.prepare("SELECT id FROM users WHERE email = 'new@example.com'").get().id;
  assert.equal((await s.call('DELETE', `/reminders/${id}/share/${newbieId}`, null, ryan)).status, 403);
  assert.equal((await s.call('DELETE', `/reminders/${id}`, null, ryan)).data.left, true);
  assert.equal((await s.call('GET', '/reminders', null, me)).data.reminders.length, 1);
  assert.equal((await s.call('GET', '/reminders', null, ryan)).data.reminders.length, 0);
});

test('people cannot see or change reminders that are not theirs', async t => {
  const s = await setup(); t.after(s.close);
  const me = await s.signup('Gimena', 'g@example.com');
  const other = await s.signup('Other', 'o@example.com');
  const { data } = await s.call('POST', '/reminders', { title: 'Private' }, me);
  assert.equal((await s.call('GET', `/reminders/${data.reminder.id}`, null, other)).status, 404);
  assert.equal((await s.call('PATCH', `/reminders/${data.reminder.id}`, { title: 'hacked' }, other)).status, 404);
  assert.equal((await s.call('DELETE', `/reminders/${data.reminder.id}`, null, other)).status, 404);
});

test('validation and calendar export', async t => {
  const s = await setup(); t.after(s.close);
  const me = await s.signup('Gimena', 'g@example.com');
  assert.equal((await s.call('POST', '/reminders', { title: '' }, me)).status, 400);
  assert.equal((await s.call('POST', '/reminders', { title: 'x', repeat: 'monthly' }, me)).status, 400);
  assert.equal((await s.call('POST', '/reminders', { title: 'x', nag_per_day: 3, nag_start: '18:00', nag_end: '09:00' }, me)).status, 400);

  const { data } = await s.call('POST', '/reminders', { title: 'Rent', repeat: 'monthly', start_date: '2026-01-31', alerts: [1, 0] }, me);
  const ics = await s.call('GET', data.reminder.ics_url.replace('/api', ''));
  assert.equal(ics.status, 200);
  assert.match(ics.data, /RRULE:FREQ=MONTHLY;BYMONTHDAY=31,-1;BYSETPOS=1/);
  assert.match(ics.data, /TRIGGER:-P1D/);
  assert.equal((await s.call('GET', `/reminders/${data.reminder.id}/calendar.ics?sig=bad`)).status, 403);
});

test('snooze sends the reminder again later', async t => {
  const s = await setup('2026-10-14T16:00:00Z'); t.after(s.close);
  const me = await s.signup('Gimena', 'g@example.com');
  const { data } = await s.call('POST', '/reminders', { title: 'Call mom' }, me);
  await s.call('POST', `/reminders/${data.reminder.id}/snooze`, { minutes: 60 }, me);
  await s.scheduler.tick();
  assert.equal(s.pushes.length, 0);
  s.setClock('2026-10-14T17:00:30Z');
  await s.scheduler.tick();
  assert.equal(s.pushes.length, 1);
  assert.equal(s.pushes[0].body, 'Snoozed reminder');
});

test('tasks from the first version of the app are carried over', () => {
  const { DatabaseSync } = require('node:sqlite');
  const fs = require('fs'); const os = require('os'); const path = require('path');
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'tf-')), 'old.db');
  const old = new DatabaseSync(file);
  old.exec(`CREATE TABLE users (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT, email TEXT UNIQUE, password TEXT);
    CREATE TABLE tasks (id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER, title TEXT, desc TEXT, priority TEXT, reminder TEXT, due_date TEXT, completed INTEGER DEFAULT 0);
    INSERT INTO users (name, email, password) VALUES ('G', 'g@x.com', 'pw');
    INSERT INTO tasks (user_id, title, desc, priority, reminder, due_date, completed) VALUES (1, 'card', 'pay it', 'High', 'daily', '2026-05-06', 0);`);
  old.close();
  const db = openNodeDatabase(file);
  const rows = db.prepare('SELECT * FROM reminders').all();
  assert.equal(rows.length, 1);
  assert.equal(rows[0].title, 'card');
  assert.equal(rows[0].start_date, '2026-05-06');
  openNodeDatabase(file); // running again must not duplicate
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM reminders').get().n, 1);
});

test('real Web Push request to an iPhone: payload decrypts and the VAPID signature verifies', async t => {
  const crypto = require('crypto');
  // Keys a phone's browser would create for its subscription.
  const phone = crypto.createECDH('prime256v1');
  phone.generateKeys();
  const phonePublic = phone.getPublicKey();
  const authSecret = crypto.randomBytes(16);
  const requests = [];
  // Use the real sender, but capture the HTTPS request instead of sending it to Apple.
  const s = await setup('2026-10-14T16:00:30Z', {
    sendPush: undefined,
    fetch: async (url, init) => { requests.push({ url, ...init }); return new Response(null, { status: 201 }); },
  });
  t.after(s.close);

  const { data: { token } } = await s.call('POST', '/signup', { name: 'G', email: 'g@example.com', password: 'secret123', timezone: 'America/Los_Angeles' });
  // The phone reaches the app through the host's https proxy.
  await s.call('POST', '/push/subscribe', { subscription: {
    endpoint: 'https://web.push.apple.com/QGxyz-device-token',
    keys: { p256dh: phonePublic.toString('base64url'), auth: authSecret.toString('base64url') },
  } }, token, { 'X-Forwarded-Proto': 'https', 'X-Forwarded-Host': 'taskflow-demo.up.railway.app' });
  await s.call('POST', '/reminders', { title: 'Credit card', kind: 'bill', amount: '$250', repeat: 'monthly', start_date: '2026-10-15', alerts: [1] }, token);
  await s.scheduler.tick();
  assert.equal(requests.length, 1);
  const req = requests[0];
  assert.equal(req.url, 'https://web.push.apple.com/QGxyz-device-token');
  assert.equal(req.headers['Content-Encoding'], 'aes128gcm');

  // VAPID: signed by the server's key, for Apple's push service.
  const { data: config } = await s.call('GET', '/config');
  const [, jwt, k] = req.headers.Authorization.match(/^vapid t=([^,]+), k=(.+)$/);
  assert.equal(k, config.vapidPublicKey);
  const [h, p, sig] = jwt.split('.');
  const serverKey = Buffer.from(k, 'base64url');
  const publicKey = crypto.createPublicKey({ key: { kty: 'EC', crv: 'P-256', x: serverKey.subarray(1, 33).toString('base64url'), y: serverKey.subarray(33).toString('base64url') }, format: 'jwk' });
  assert.ok(crypto.verify('sha256', Buffer.from(`${h}.${p}`), { key: publicKey, dsaEncoding: 'ieee-p1363' }, Buffer.from(sig, 'base64url')));
  const claims = JSON.parse(Buffer.from(p, 'base64url'));
  assert.equal(claims.aud, 'https://web.push.apple.com');
  assert.equal(claims.sub, 'https://taskflow-demo.up.railway.app', 'Apple needs a real https/mailto subject');

  // Decrypt exactly like the phone does (RFC 8291).
  const body = Buffer.from(req.body);
  const salt = body.subarray(0, 16);
  const idLen = body[20];
  const serverPublic = body.subarray(21, 21 + idLen);
  const cipher = body.subarray(21 + idLen);
  const shared = phone.computeSecret(serverPublic);
  const ikm = Buffer.from(crypto.hkdfSync('sha256', shared, authSecret, Buffer.concat([Buffer.from('WebPush: info\0'), phonePublic, serverPublic]), 32));
  const cek = Buffer.from(crypto.hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: aes128gcm\0'), 16));
  const nonce = Buffer.from(crypto.hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: nonce\0'), 12));
  const decipher = crypto.createDecipheriv('aes-128-gcm', cek, nonce);
  decipher.setAuthTag(cipher.subarray(cipher.length - 16));
  const plain = Buffer.concat([decipher.update(cipher.subarray(0, cipher.length - 16)), decipher.final()]);
  const message = JSON.parse(plain.subarray(0, plain.lastIndexOf(2)).toString());
  assert.equal(message.title, '💳 Credit card');
  assert.equal(message.body, 'Due tomorrow · $250');
  assert.match(message.url, /^\/\?item=\d+$/);
  assert.ok(message.token);
});

test('accounts from the earlier scrypt format still log in and get upgraded', async t => {
  const crypto = require('crypto');
  const s = await setup('2026-10-14T16:00:00Z', { verifyLegacyHash: verifyScrypt });
  t.after(s.close);
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync('oldpass1', salt, 32, { N: 16384, r: 8, p: 1 });
  s.db.prepare("INSERT INTO users (name, email, password_hash) VALUES ('Early', 'early@example.com', ?)")
    .run(`scrypt$${salt.toString('base64')}$${hash.toString('base64')}`);
  assert.equal((await s.call('POST', '/login', { email: 'early@example.com', password: 'wrong' })).status, 401);
  assert.equal((await s.call('POST', '/login', { email: 'early@example.com', password: 'oldpass1' })).status, 200);
  const row = s.db.prepare("SELECT password_hash FROM users WHERE email = 'early@example.com'").get();
  assert.match(row.password_hash, /^pbkdf2\$/);
  assert.equal((await s.call('POST', '/login', { email: 'early@example.com', password: 'oldpass1' })).status, 200);
});

test('invites can be cancelled', async t => {
  const s = await setup();
  t.after(s.close);
  const me = await s.signup('Gimena', 'g@example.com');
  const { data } = await s.call('POST', '/reminders', { title: 'Rent', share_with: ['mom@example.com'] }, me);
  assert.deepEqual(data.reminder.invites, ['mom@example.com']);
  const res = await s.call('DELETE', `/reminders/${data.reminder.id}/invites/${encodeURIComponent('mom@example.com')}`, null, me);
  assert.deepEqual(res.data.reminder.invites, []);
});

test('Spanish: notifications, buttons and messages follow each person’s language', async t => {
  const s = await setup('2026-10-14T15:59:00Z');
  t.after(s.close);
  const bad = await s.call('POST', '/signup', { name: 'Ana', email: 'nope', password: 'secret123' }, null, { 'X-Lang': 'es' });
  assert.equal(bad.data.error, 'Ese correo no parece correcto.');

  const { data } = await s.call('POST', '/signup', { name: 'Ana', email: 'ana@example.com', password: 'secret123', timezone: 'America/Los_Angeles', language: 'es' });
  assert.equal(data.user.language, 'es');
  const token = data.token;
  await s.call('POST', '/push/subscribe', { subscription: { endpoint: 'https://push.example/ana', keys: { p256dh: 'k', auth: 'a' } } }, token);
  assert.equal((await s.call('POST', '/reminders', { title: '' }, token)).data.error, 'Ponle un nombre.');
  await s.call('POST', '/reminders', { title: 'Tarjeta', kind: 'bill', amount: '$250', repeat: 'monthly', start_date: '2026-10-15', alerts: [1] }, token);

  s.setClock('2026-10-14T16:00:30Z');
  await s.scheduler.tick();
  assert.equal(s.pushes.length, 1);
  assert.equal(s.pushes[0].body, 'Vence mañana · $250');
  assert.deepEqual(s.pushes[0].actions.map(a => a.title), ['✓ Hecho', '⏰ En 1 hora']);

  const me = await s.call('PATCH', '/me', { language: 'en' }, token);
  assert.equal(me.data.user.language, 'en');
  assert.equal((await s.call('POST', '/reminders', { title: '' }, token)).data.error, 'Please give it a name.');
});
