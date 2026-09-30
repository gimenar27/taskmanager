// TaskFlow API: accounts, reminders, sharing and push notifications.
// The same code runs on Node (server.js) and on Cloudflare (worker.js).
const { Hono } = require('hono');
const Schedule = require('../public/js/schedule');
const { getMeta, setMeta } = require('./schema');
const auth = require('./auth');
const webpush = require('./webpush');
const { todayIn } = require('./time');
const { createStore, ValidationError } = require('./reminders');
const { createScheduler } = require('./scheduler');
const { t, langOf } = require('./messages');

/**
 * options: { db, env, now, log, mailer, sendPush, fetch, verifyLegacyHash }
 * Returns { app, tick, vapid, pushOptions }.
 */
async function createApp(options) {
  const db = options.db;
  const env = options.env || {};
  const now = options.now || (() => Date.now());
  const log = options.log || console;
  const mailer = options.mailer || null;
  const store = createStore(db);

  // Secrets are generated once and kept in the database unless provided by the environment.
  let secret = env.APP_SECRET || getMeta(db, 'app_secret');
  if (!secret) { secret = auth.randomHex(32); setMeta(db, 'app_secret', secret); }
  let vapid = env.VAPID_PUBLIC_KEY && env.VAPID_PRIVATE_KEY
    ? { publicKey: env.VAPID_PUBLIC_KEY, privateKey: env.VAPID_PRIVATE_KEY }
    : JSON.parse(getMeta(db, 'vapid') || 'null');
  if (!vapid) { vapid = await webpush.generateVapidKeys(); setMeta(db, 'vapid', JSON.stringify(vapid)); }

  // Apple only delivers pushes whose VAPID "subject" is a real mailto: address or https:// URL
  // (it rejects localhost and reserved domains). Unless one is configured, use the app's own
  // public https address, which is recorded the first time a phone subscribes over https.
  let publicOrigin = /^https:\/\//.test(env.APP_URL || '') ? env.APP_URL.replace(/\/+$/, '') : getMeta(db, 'public_origin');
  function vapidSubject() {
    const configured = String(env.VAPID_SUBJECT || '').trim();
    if (/^(mailto:|https:\/\/)/.test(configured)) return configured;
    if (configured.includes('@')) return `mailto:${configured}`;
    return publicOrigin || 'mailto:taskflow@example.com';
  }
  function rememberOrigin(c) {
    if (env.APP_URL) return;
    const url = new URL(c.req.url);
    // On a local server behind a tunnel or proxy, the public address comes from forwarded headers.
    const behindProxy = url.protocol === 'http:';
    const first = v => String(v || '').split(',')[0].trim();
    const proto = behindProxy ? first(c.req.header('x-forwarded-proto')) : 'https';
    const host = (behindProxy ? first(c.req.header('x-forwarded-host')) || first(c.req.header('host')) : url.host).toLowerCase();
    const hostname = host.replace(/:\d+$/, '');
    const looksPublic = hostname.includes('.') && !/^[\d.]+$/.test(hostname) && !/\.(local|localhost|test|invalid|example)$/.test(hostname);
    if (proto !== 'https' || !looksPublic) return;
    const origin = `https://${host}`;
    if (origin !== publicOrigin) { publicOrigin = origin; setMeta(db, 'public_origin', origin); }
  }
  const pushOptions = () => ({
    TTL: 12 * 3600,
    urgency: 'high',
    vapidDetails: { subject: vapidSubject(), publicKey: vapid.publicKey, privateKey: vapid.privateKey },
  });
  const sendPush = options.sendPush
    || ((sub, payload, opts) => webpush.sendNotification(sub, payload, { ...opts, fetch: options.fetch, now: now() }));

  const q = {
    userByEmail: db.prepare('SELECT * FROM users WHERE lower(email) = lower(?)'),
    userById: db.prepare('SELECT * FROM users WHERE id = ?'),
    insertUser: db.prepare("INSERT INTO users (name, email, password_hash, timezone, language, created_at) VALUES (?, ?, ?, ?, ?, datetime('now')) RETURNING id"),
    upgradePassword: db.prepare('UPDATE users SET password_hash = ?, password = NULL WHERE id = ?'),
    insertSession: db.prepare("INSERT INTO sessions (token_hash, user_id, last_used_at) VALUES (?, ?, datetime('now'))"),
    sessionUser: db.prepare('SELECT u.* FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token_hash = ?'),
    deleteSession: db.prepare('DELETE FROM sessions WHERE token_hash = ?'),
    setTimezone: db.prepare('UPDATE users SET timezone = ? WHERE id = ?'),
    setLanguage: db.prepare('UPDATE users SET language = ? WHERE id = ?'),
    subsFor: db.prepare('SELECT * FROM push_subscriptions WHERE user_id = ?'),
    deleteSub: db.prepare('DELETE FROM push_subscriptions WHERE endpoint = ?'),
    upsertSub: db.prepare(`
      INSERT INTO push_subscriptions (user_id, endpoint, p256dh, auth, user_agent) VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(endpoint) DO UPDATE SET user_id = excluded.user_id, p256dh = excluded.p256dh, auth = excluded.auth, user_agent = excluded.user_agent`),
    invitesFor: db.prepare('SELECT * FROM invites WHERE lower(email) = lower(?)'),
    insertShare: db.prepare('INSERT OR IGNORE INTO shares (reminder_id, user_id, shared_by) VALUES (?, ?, ?)'),
    deleteInvite: db.prepare('DELETE FROM invites WHERE reminder_id = ? AND lower(email) = lower(?)'),
    insertInvite: db.prepare('INSERT OR IGNORE INTO invites (reminder_id, email, invited_by) VALUES (?, ?, ?)'),
    deleteShare: db.prepare('DELETE FROM shares WHERE reminder_id = ? AND user_id = ?'),
    clearSnoozes: db.prepare('DELETE FROM snoozes WHERE reminder_id = ?'),
    insertSnooze: db.prepare('INSERT INTO snoozes (reminder_id, user_id, fire_at) VALUES (?, ?, ?)'),
  };

  // ─── notifications ───
  async function pushToUser(user, payload) {
    const subs = q.subsFor.all(user.id);
    await Promise.all(subs.map(async s => {
      try {
        await sendPush({ endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } }, JSON.stringify(payload), pushOptions());
      } catch (err) {
        if (err.statusCode === 404 || err.statusCode === 410) q.deleteSub.run(s.endpoint); // device unsubscribed
        else log.error('Push failed:', err.statusCode || '', err.body || err.message);
      }
    }));
    return subs.length;
  }

  async function notify(user, r, fire) {
    const lang = langOf(user.language);
    const { title, body } = Schedule.describeFire(r, fire, today(user), lang);
    const token = await auth.sign(secret, { u: user.id, r: r.id, o: fire.occ || null, exp: now() + 7 * 86400000 });
    const actions = [{ action: 'done', title: t(lang, 'action_done') }, { action: 'snooze', title: t(lang, 'action_snooze') }];
    await pushToUser(user, { title, body, tag: `reminder-${r.id}`, url: `/?item=${r.id}`, token, actions });
    if (mailer && user.email_reminders && fire.type !== 'nag') {
      await mailer.send(user.email, title.replace(/^\S+\s/, ''), `${body}\n\n${r.notes || ''}`.trim());
    }
  }

  const scheduler = createScheduler({ db, notify, now, log });

  // ─── helpers shared by the routes ───
  function today(user) { return todayIn(user.timezone || 'UTC', now()); }

  async function startSession(user) {
    const token = auth.newToken();
    q.insertSession.run(await auth.sha256(token), user.id);
    return token;
  }

  function publicUser(u) {
    return { id: u.id, name: u.name, email: u.email, timezone: u.timezone, language: langOf(u.language), email_reminders: !!u.email_reminders };
  }

  async function withLinks(r) {
    if (!r) return r;
    return { ...r, ics_url: `/api/reminders/${r.id}/calendar.ics?sig=${await auth.sign(secret, { ics: r.id })}` };
  }

  function acceptInvites(user) {
    for (const inv of q.invitesFor.all(user.email)) {
      q.insertShare.run(inv.reminder_id, user.id, inv.invited_by);
      q.deleteInvite.run(inv.reminder_id, inv.email);
    }
  }

  function markDone(r, user, occ) {
    if (Schedule.isRepeating(r)) {
      const target = occ && Schedule.isValidYMD(occ) ? occ : Schedule.currentOccurrence(r, today(user));
      const through = r.completed_through && r.completed_through > target ? r.completed_through : target;
      db.prepare("UPDATE reminders SET completed_through = ?, done_at = datetime('now'), done_by = ?, updated_at = datetime('now') WHERE id = ?")
        .run(through, user.id, r.id);
    } else {
      db.prepare("UPDATE reminders SET done = 1, done_at = datetime('now'), done_by = ?, updated_at = datetime('now') WHERE id = ?")
        .run(user.id, r.id);
    }
    q.clearSnoozes.run(r.id);
  }

  function snooze(r, user, minutes) {
    const mins = Math.max(5, Math.min(7 * 24 * 60, Math.round(Number(minutes) || 60)));
    q.insertSnooze.run(r.id, user.id, now() + mins * 60000);
    return mins;
  }

  // ─── HTTP ───
  const limiter = auth.createRateLimiter({ windowMs: 15 * 60000, max: 30 });
  const clientIp = c => c.req.header('cf-connecting-ip')
    || String(c.req.header('x-forwarded-for') || '').split(',')[0].trim()
    || (c.env && c.env.incoming && c.env.incoming.socket && c.env.incoming.socket.remoteAddress) || 'local';

  const ctx = {
    db, env, now, log, mailer, secret, vapid, q, store, auth, options,
    today, startSession, publicUser, withLinks, acceptInvites, markDone, snooze, pushToUser, rememberOrigin,
    // Message in the language of this request (the person's saved language once they're logged in).
    t: (c, key, vars) => t(c.get('lang'), key, vars),
    async readJson(c) {
      try { const body = await c.req.json(); return body && typeof body === 'object' ? body : {}; } catch { return {}; }
    },
    async requireUser(c, next) {
      const header = c.req.header('authorization') || '';
      const token = header.startsWith('Bearer ') ? header.slice(7) : null;
      const user = token && q.sessionUser.get(await auth.sha256(token));
      if (!user) return c.json({ error: t(c.get('lang'), 'please_log_in') }, 401);
      c.set('user', user);
      c.set('lang', langOf(user.language));
      c.set('token', token);
      await next();
    },
    async loadReminder(c, next) {
      const r = store.get(c.get('user').id, c.req.param('id'));
      if (!r) return c.json({ error: t(c.get('lang'), 'reminder_gone') }, 404);
      c.set('reminder', r);
      await next();
    },
    async limitAuth(c, next) {
      if (!limiter(clientIp(c), now())) return c.json({ error: t(c.get('lang'), 'too_many') }, 429);
      await next();
    },
  };

  const onError = (err, c) => {
    if (err instanceof ValidationError) return c.json({ error: t(c.get('lang'), err.key, err.vars) }, 400);
    log.error(err);
    return c.json({ error: t(c.get('lang'), 'server_error') }, 500);
  };
  const api = new Hono();
  api.onError(onError);
  // The app says which language it's showing, for messages before someone logs in.
  api.use('*', async (c, next) => {
    c.set('lang', langOf(c.req.header('x-lang')));
    await next();
  });
  require('./routes/account')(api, ctx);
  require('./routes/reminders')(api, ctx);
  require('./routes/push')(api, ctx);
  api.all('*', c => c.json({ error: t(c.get('lang'), 'not_found') }, 404));

  const app = new Hono();
  app.onError(onError);
  app.route('/api', api);

  return { app, tick: scheduler.tick, scheduler, vapid, pushOptions, db };
}

module.exports = { createApp };
