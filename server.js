// TaskFlow server: accounts, reminders, sharing and push notifications.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const express = require('express');
const webpush = require('web-push');

const Schedule = require('./public/js/schedule');
const { openDatabase, getMeta, setMeta } = require('./lib/db');
const auth = require('./lib/auth');
const { isValidTimeZone, todayIn } = require('./lib/time');
const { cleanReminderInput, createStore, parseReminder, toIcs, ValidationError } = require('./lib/reminders');
const { createScheduler } = require('./lib/scheduler');

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function createMailer(env) {
  if (!env.SMTP_USER || !env.SMTP_PASS) return null;
  const nodemailer = require('nodemailer');
  const transport = nodemailer.createTransport(env.SMTP_HOST
    ? { host: env.SMTP_HOST, port: Number(env.SMTP_PORT || 587), secure: env.SMTP_PORT === '465', auth: { user: env.SMTP_USER, pass: env.SMTP_PASS } }
    : { service: env.SMTP_SERVICE || 'gmail', auth: { user: env.SMTP_USER, pass: env.SMTP_PASS } });
  const from = env.MAIL_FROM || `TaskFlow <${env.SMTP_USER}>`;
  return { send: (to, subject, text) => transport.sendMail({ from, to, subject, text }) };
}

function createApp(options = {}) {
  const env = options.env || process.env;
  const now = options.now || (() => Date.now());
  const log = options.log || console;
  const db = options.db || openDatabase(options.dbFile);
  const store = createStore(db);
  const mailer = options.mailer !== undefined ? options.mailer : createMailer(env);

  // Secrets are generated once and kept in the database unless provided by the environment.
  let secret = env.APP_SECRET || getMeta(db, 'app_secret');
  if (!secret) { secret = crypto.randomBytes(32).toString('hex'); setMeta(db, 'app_secret', secret); }

  let vapid = env.VAPID_PUBLIC_KEY && env.VAPID_PRIVATE_KEY
    ? { publicKey: env.VAPID_PUBLIC_KEY, privateKey: env.VAPID_PRIVATE_KEY }
    : JSON.parse(getMeta(db, 'vapid') || 'null');
  if (!vapid) { vapid = webpush.generateVAPIDKeys(); setMeta(db, 'vapid', JSON.stringify(vapid)); }

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
  function rememberOrigin(req) {
    const host = String(req.host || '').toLowerCase();
    const hostname = host.replace(/:\d+$/, '');
    const looksPublic = hostname.includes('.') && !/^[\d.]+$/.test(hostname) && !/\.(local|localhost|test|invalid|example)$/.test(hostname);
    if (req.protocol !== 'https' || !looksPublic || env.APP_URL) return;
    const origin = `https://${host}`;
    if (origin !== publicOrigin) { publicOrigin = origin; setMeta(db, 'public_origin', origin); }
  }
  const pushOptions = () => ({
    TTL: 12 * 3600,
    urgency: 'high',
    vapidDetails: { subject: vapidSubject(), publicKey: vapid.publicKey, privateKey: vapid.privateKey },
  });
  const sendPush = options.sendPush || ((sub, payload, opts) => webpush.sendNotification(sub, payload, opts));

  const q = {
    userByEmail: db.prepare('SELECT * FROM users WHERE lower(email) = lower(?)'),
    userById: db.prepare('SELECT * FROM users WHERE id = ?'),
    insertUser: db.prepare("INSERT INTO users (name, email, password_hash, timezone, created_at) VALUES (?, ?, ?, ?, datetime('now'))"),
    upgradePassword: db.prepare('UPDATE users SET password_hash = ?, password = NULL WHERE id = ?'),
    insertSession: db.prepare("INSERT INTO sessions (token_hash, user_id, last_used_at) VALUES (?, ?, datetime('now'))"),
    sessionUser: db.prepare('SELECT u.* FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token_hash = ?'),
    deleteSession: db.prepare('DELETE FROM sessions WHERE token_hash = ?'),
    setTimezone: db.prepare('UPDATE users SET timezone = ? WHERE id = ?'),
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
    const today = todayIn(user.timezone || 'UTC', now());
    const { title, body } = Schedule.describeFire(r, fire, today);
    const token = auth.sign(secret, { u: user.id, r: r.id, o: fire.occ || null, exp: now() + 7 * 86400000 });
    await pushToUser(user, { title, body, tag: `reminder-${r.id}`, url: `/?item=${r.id}`, token });
    if (mailer && user.email_reminders && fire.type !== 'nag') {
      await mailer.send(user.email, title.replace(/^\S+\s/, ''), `${body}\n\n${r.notes || ''}`.trim());
    }
  }

  const scheduler = createScheduler({ db, notify, now, log });

  // ─── helpers ───
  function startSession(user) {
    const token = auth.newToken();
    q.insertSession.run(auth.sha256(token), user.id);
    return token;
  }

  function publicUser(u) {
    return { id: u.id, name: u.name, email: u.email, timezone: u.timezone, email_reminders: !!u.email_reminders };
  }

  function withLinks(r) {
    if (!r) return r;
    return { ...r, ics_url: `/api/reminders/${r.id}/calendar.ics?sig=${auth.sign(secret, { ics: r.id })}` };
  }

  function today(user) { return todayIn(user.timezone || 'UTC', now()); }

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

  // ─── app ───
  const app = express();
  app.set('trust proxy', 1);
  app.disable('x-powered-by');
  app.use(express.json({ limit: '100kb' }));

  app.use(express.static(path.join(__dirname, 'public'), {
    setHeaders(res, file) {
      if (/\.(html|webmanifest)$/.test(file) || file.endsWith('sw.js')) res.setHeader('Cache-Control', 'no-cache');
    },
  }));

  const api = express.Router();
  app.use('/api', api);

  const requireUser = (req, res, next) => {
    const header = req.get('authorization') || '';
    const token = header.startsWith('Bearer ') ? header.slice(7) : null;
    const user = token && q.sessionUser.get(auth.sha256(token));
    if (!user) return res.status(401).json({ error: 'Please log in again.' });
    req.user = user;
    req.token = token;
    next();
  };

  const loadReminder = (req, res, next) => {
    const r = store.get(req.user.id, req.params.id);
    if (!r) return res.status(404).json({ error: 'That reminder no longer exists.' });
    req.reminder = r;
    next();
  };

  const limitAuth = auth.rateLimiter({ windowMs: 15 * 60000, max: 30 });

  api.get('/health', (req, res) => res.json({ ok: true }));

  api.get('/config', (req, res) => {
    res.json({ vapidPublicKey: vapid.publicKey, emailEnabled: !!mailer });
  });

  api.post('/signup', limitAuth, (req, res) => {
    const name = String(req.body.name || '').trim().slice(0, 80);
    const email = String(req.body.email || '').trim().toLowerCase();
    const password = String(req.body.password || '');
    if (!name || !email || !password) return res.status(400).json({ error: 'Please fill out every field.' });
    if (!EMAIL_RE.test(email)) return res.status(400).json({ error: 'That email doesn’t look right.' });
    if (password.length < 6) return res.status(400).json({ error: 'Use at least 6 characters for your password.' });
    if (q.userByEmail.get(email)) return res.status(409).json({ error: 'An account with that email already exists. Try logging in.' });
    const tz = isValidTimeZone(req.body.timezone) ? req.body.timezone : 'UTC';
    const { lastInsertRowid } = q.insertUser.run(name, email, auth.hashPassword(password), tz);
    const user = q.userById.get(lastInsertRowid);
    acceptInvites(user);
    res.json({ token: startSession(user), user: publicUser(user) });
  });

  api.post('/login', limitAuth, (req, res) => {
    const email = String(req.body.email || '').trim();
    const password = String(req.body.password || '');
    const user = email && q.userByEmail.get(email);
    let ok = false;
    if (user && user.password_hash) ok = auth.verifyPassword(password, user.password_hash);
    else if (user && auth.matchesLegacyPassword(password, user.password)) {
      q.upgradePassword.run(auth.hashPassword(password), user.id);
      ok = true;
    }
    if (!ok) return res.status(401).json({ error: 'Wrong email or password.' });
    if (isValidTimeZone(req.body.timezone)) q.setTimezone.run(req.body.timezone, user.id);
    acceptInvites(user);
    res.json({ token: startSession(user), user: publicUser(q.userById.get(user.id)) });
  });

  api.post('/logout', requireUser, (req, res) => {
    q.deleteSession.run(auth.sha256(req.token));
    if (req.body.endpoint) q.deleteSub.run(String(req.body.endpoint));
    res.json({ ok: true });
  });

  api.get('/me', requireUser, (req, res) => res.json({ user: publicUser(req.user) }));

  api.patch('/me', requireUser, (req, res) => {
    const u = req.user;
    const name = req.body.name !== undefined ? String(req.body.name).trim().slice(0, 80) || u.name : u.name;
    const tz = isValidTimeZone(req.body.timezone) ? req.body.timezone : u.timezone;
    const emailReminders = req.body.email_reminders !== undefined ? (req.body.email_reminders ? 1 : 0) : u.email_reminders;
    db.prepare('UPDATE users SET name = ?, timezone = ?, email_reminders = ? WHERE id = ?').run(name, tz, emailReminders, u.id);
    res.json({ user: publicUser(q.userById.get(u.id)) });
  });

  // ─── reminders ───
  api.get('/reminders', requireUser, (req, res) => {
    res.json({ reminders: store.list(req.user.id).map(withLinks), today: today(req.user) });
  });

  api.post('/reminders', requireUser, async (req, res) => {
    const v = cleanReminderInput(req.body, null, today(req.user));
    const { lastInsertRowid } = db.prepare(`
      INSERT INTO reminders (owner_id, title, notes, kind, priority, amount, start_date, time, repeat, alerts,
        nag_per_day, nag_start, nag_end, nag_from, starred)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
      req.user.id, v.title, v.notes, v.kind, v.priority, v.amount, v.start_date, v.time, v.repeat, v.alerts,
      v.nag_per_day, v.nag_start, v.nag_end, v.nag_from, v.starred);
    const emails = Array.isArray(req.body.share_with) ? req.body.share_with.slice(0, 20) : [];
    const results = [];
    for (const email of emails) results.push(await shareWith(Number(lastInsertRowid), req.user, email).catch(e => ({ email, error: e.message })));
    res.status(201).json({ reminder: withLinks(store.get(req.user.id, lastInsertRowid)), shares: results });
  });

  api.get('/reminders/:id', requireUser, loadReminder, (req, res) => res.json({ reminder: withLinks(req.reminder) }));

  api.patch('/reminders/:id', requireUser, loadReminder, (req, res) => {
    const v = cleanReminderInput(req.body, req.reminder, today(req.user));
    db.prepare(`
      UPDATE reminders SET title = ?, notes = ?, kind = ?, priority = ?, amount = ?, start_date = ?, time = ?, repeat = ?,
        alerts = ?, nag_per_day = ?, nag_start = ?, nag_end = ?, nag_from = ?, starred = ?, completed_through = ?,
        updated_at = datetime('now')
      WHERE id = ?`).run(
      v.title, v.notes, v.kind, v.priority, v.amount, v.start_date, v.time, v.repeat, v.alerts,
      v.nag_per_day, v.nag_start, v.nag_end, v.nag_from, v.starred, v.completed_through, req.reminder.id);
    res.json({ reminder: withLinks(store.get(req.user.id, req.reminder.id)) });
  });

  // The owner deletes it for everyone; anyone else just leaves it.
  api.delete('/reminders/:id', requireUser, loadReminder, (req, res) => {
    if (req.reminder.is_owner) db.prepare('DELETE FROM reminders WHERE id = ?').run(req.reminder.id);
    else q.deleteShare.run(req.reminder.id, req.user.id);
    res.json({ ok: true, left: !req.reminder.is_owner });
  });

  api.post('/reminders/:id/done', requireUser, loadReminder, (req, res) => {
    markDone(req.reminder, req.user, req.body.occ);
    res.json({ reminder: withLinks(store.get(req.user.id, req.reminder.id)) });
  });

  api.post('/reminders/:id/undo', requireUser, loadReminder, (req, res) => {
    const r = req.reminder;
    if (Schedule.isRepeating(r)) {
      const prev = r.completed_through ? Schedule.previousOccurrence(r, r.completed_through) : null;
      db.prepare("UPDATE reminders SET completed_through = ?, done_at = NULL, done_by = NULL, updated_at = datetime('now') WHERE id = ?").run(prev, r.id);
    } else {
      db.prepare("UPDATE reminders SET done = 0, done_at = NULL, done_by = NULL, updated_at = datetime('now') WHERE id = ?").run(r.id);
    }
    res.json({ reminder: withLinks(store.get(req.user.id, r.id)) });
  });

  api.post('/reminders/:id/snooze', requireUser, loadReminder, (req, res) => {
    const minutes = snooze(req.reminder, req.user, req.body.minutes);
    res.json({ ok: true, minutes });
  });

  async function shareWith(reminderId, fromUser, rawEmail) {
    const email = String(rawEmail || '').trim().toLowerCase();
    if (!EMAIL_RE.test(email)) throw new ValidationError('Enter a valid email address.');
    if (email === String(fromUser.email).toLowerCase()) throw new ValidationError('That’s your own email 🙂');
    const reminder = store.get(fromUser.id, reminderId);
    const target = q.userByEmail.get(email);
    if (target) {
      if (target.id === reminder.owner_id) throw new ValidationError(`${target.name} already owns this reminder.`);
      q.insertShare.run(reminderId, target.id, fromUser.id);
      pushToUser(target, {
        title: '🤝 New shared reminder',
        body: `${fromUser.name} shared “${reminder.title}” with you`,
        tag: `share-${reminderId}`, url: `/?item=${reminderId}`,
      }).catch(() => {});
      return { email, status: 'shared', name: target.name };
    }
    q.insertInvite.run(reminderId, email, fromUser.id);
    if (mailer) {
      const appUrl = env.APP_URL || '';
      mailer.send(email, `${fromUser.name} shared a reminder with you`,
        `${fromUser.name} shared “${reminder.title}” with you on TaskFlow.\n\n` +
        `Create a free account with this email address (${email}) to see it and get reminders:\n${appUrl}`)
        .catch(err => log.error('Invite email failed:', err.message));
    }
    return { email, status: 'invited' };
  }

  api.post('/reminders/:id/share', requireUser, loadReminder, async (req, res) => {
    const result = await shareWith(req.reminder.id, req.user, req.body.email);
    res.json({ ...result, reminder: withLinks(store.get(req.user.id, req.reminder.id)) });
  });

  api.delete('/reminders/:id/share/:userId', requireUser, loadReminder, (req, res) => {
    const userId = Number(req.params.userId);
    if (!req.reminder.is_owner && userId !== req.user.id) {
      return res.status(403).json({ error: 'Only the owner can remove other people.' });
    }
    q.deleteShare.run(req.reminder.id, userId);
    res.json({ reminder: withLinks(store.get(req.user.id, req.reminder.id)) });
  });

  api.delete('/reminders/:id/invites/:email', requireUser, loadReminder, (req, res) => {
    q.deleteInvite.run(req.reminder.id, req.params.email);
    res.json({ reminder: withLinks(store.get(req.user.id, req.reminder.id)) });
  });

  // Signed link so it can be opened by the phone's calendar or sent to someone without the app.
  api.get('/reminders/:id/calendar.ics', (req, res) => {
    const payload = auth.verify(secret, req.query.sig);
    const id = Number(req.params.id);
    if (!payload || payload.ics !== id) return res.status(403).send('This link is not valid.');
    const row = db.prepare('SELECT r.*, u.timezone FROM reminders r JOIN users u ON u.id = r.owner_id WHERE r.id = ?').get(id);
    if (!row) return res.status(404).send('This reminder no longer exists.');
    const r = parseReminder(row);
    const ics = toIcs(r, todayIn(row.timezone || 'UTC', now()));
    if (!ics) return res.status(400).send('Add a date to this reminder first.');
    const filename = r.title.replace(/[^\w\- ]+/g, '').trim().slice(0, 40) || 'reminder';
    res.set('Content-Type', 'text/calendar; charset=utf-8');
    res.set('Content-Disposition', `inline; filename="${filename}.ics"`);
    res.send(ics);
  });

  // ─── push subscriptions ───
  api.get('/push/key', (req, res) => res.json({ key: vapid.publicKey }));

  api.post('/push/subscribe', requireUser, (req, res) => {
    const sub = req.body.subscription || {};
    if (!sub.endpoint || !/^https:\/\//.test(sub.endpoint) || !sub.keys || !sub.keys.p256dh || !sub.keys.auth) {
      return res.status(400).json({ error: 'Invalid push subscription.' });
    }
    rememberOrigin(req);
    q.upsertSub.run(req.user.id, sub.endpoint, sub.keys.p256dh, sub.keys.auth, String(req.get('user-agent') || '').slice(0, 200));
    res.json({ ok: true });
  });

  api.post('/push/unsubscribe', requireUser, (req, res) => {
    if (req.body.endpoint) q.deleteSub.run(String(req.body.endpoint));
    res.json({ ok: true });
  });

  api.post('/push/test', requireUser, async (req, res) => {
    const devices = await pushToUser(req.user, {
      title: '🔔 TaskFlow notifications work!',
      body: 'This is how your reminders will show up.',
      tag: 'test', url: '/',
    });
    res.json({ ok: true, devices });
  });

  // Buttons on a notification ("Done", "1 hour") call this without a login, using the signed token.
  api.post('/action', (req, res) => {
    const payload = auth.verify(secret, req.body.token);
    if (!payload || !payload.u || !payload.r) return res.status(403).json({ error: 'This action has expired.' });
    const user = q.userById.get(payload.u);
    const r = user && store.get(user.id, payload.r);
    if (!r) return res.status(404).json({ error: 'That reminder no longer exists.' });
    if (req.body.action === 'done') markDone(r, user, payload.o);
    else if (req.body.action === 'snooze') snooze(r, user, req.body.minutes || 60);
    else return res.status(400).json({ error: 'Unknown action.' });
    res.json({ ok: true });
  });

  api.use((req, res) => res.status(404).json({ error: 'Not found' }));

  app.use((err, req, res, next) => {
    if (err instanceof ValidationError) return res.status(400).json({ error: err.message });
    if (err.type === 'entity.parse.failed') return res.status(400).json({ error: 'Invalid request.' });
    log.error(err);
    res.status(500).json({ error: 'Something went wrong on our side. Please try again.' });
  });

  return { app, db, scheduler, vapid, pushOptions };
}

if (require.main === module) {
  const dataDir = process.env.DATA_DIR || path.join(__dirname, 'data');
  const dbFile = process.env.DB_PATH || path.join(dataDir, 'taskflow.db');
  // Bring along the database from the first version of the app if it is still next to this file.
  const legacy = path.join(__dirname, 'database.db');
  if (!fs.existsSync(dbFile) && fs.existsSync(legacy)) {
    fs.mkdirSync(path.dirname(dbFile), { recursive: true });
    fs.copyFileSync(legacy, dbFile);
  }
  const { app, scheduler } = createApp({ dbFile });
  const port = Number(process.env.PORT || 3000);
  app.listen(port, () => {
    console.log(`TaskFlow running on http://localhost:${port}`);
    scheduler.start();
  });
}

module.exports = { createApp };
