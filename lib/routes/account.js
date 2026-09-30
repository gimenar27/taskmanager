// Sign up, log in, log out and profile settings.
const { isValidTimeZone } = require('../time');
const { LANGS, langOf } = require('../messages');

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

module.exports = function accountRoutes(api, ctx) {
  const { db, q, auth, mailer, vapid, options } = ctx;

  api.get('/health', c => c.json({ ok: true }));

  api.get('/config', c => c.json({ vapidPublicKey: vapid.publicKey, emailEnabled: !!mailer }));

  api.post('/signup', ctx.limitAuth, async c => {
    const b = await ctx.readJson(c);
    const name = String(b.name || '').trim().slice(0, 80);
    const email = String(b.email || '').trim().toLowerCase();
    const password = String(b.password || '');
    if (!name || !email || !password) return c.json({ error: ctx.t(c, 'fill_all') }, 400);
    if (!EMAIL_RE.test(email)) return c.json({ error: ctx.t(c, 'bad_email') }, 400);
    if (password.length < 6) return c.json({ error: ctx.t(c, 'short_password') }, 400);
    if (q.userByEmail.get(email)) return c.json({ error: ctx.t(c, 'email_taken') }, 409);
    const tz = isValidTimeZone(b.timezone) ? b.timezone : 'UTC';
    const language = langOf(LANGS.includes(b.language) ? b.language : c.get('lang'));
    const { id } = q.insertUser.get(name, email, await auth.hashPassword(password), tz, language);
    const user = q.userById.get(id);
    ctx.acceptInvites(user);
    return c.json({ token: await ctx.startSession(user), user: ctx.publicUser(user) });
  });

  api.post('/login', ctx.limitAuth, async c => {
    const b = await ctx.readJson(c);
    const email = String(b.email || '').trim();
    const password = String(b.password || '');
    const user = email && q.userByEmail.get(email);
    let ok = false;
    if (user && user.password_hash && user.password_hash.startsWith('pbkdf2$')) {
      ok = await auth.verifyPassword(password, user.password_hash);
    } else if (user && user.password_hash && options.verifyLegacyHash) {
      ok = await options.verifyLegacyHash(password, user.password_hash); // older hash format, upgraded below
    } else if (user && !user.password_hash) {
      ok = auth.matchesLegacyPassword(password, user.password); // first version stored plain text
    }
    if (!ok) return c.json({ error: ctx.t(c, 'wrong_login') }, 401);
    if (!user.password_hash || !user.password_hash.startsWith('pbkdf2$')) {
      q.upgradePassword.run(await auth.hashPassword(password), user.id);
    }
    if (isValidTimeZone(b.timezone)) q.setTimezone.run(b.timezone, user.id);
    if (LANGS.includes(b.language)) q.setLanguage.run(b.language, user.id);
    ctx.acceptInvites(user);
    return c.json({ token: await ctx.startSession(user), user: ctx.publicUser(q.userById.get(user.id)) });
  });

  api.post('/logout', ctx.requireUser, async c => {
    const b = await ctx.readJson(c);
    q.deleteSession.run(await auth.sha256(c.get('token')));
    if (b.endpoint) q.deleteSub.run(String(b.endpoint));
    return c.json({ ok: true });
  });

  api.get('/me', ctx.requireUser, c => c.json({ user: ctx.publicUser(c.get('user')) }));

  api.patch('/me', ctx.requireUser, async c => {
    const b = await ctx.readJson(c);
    const u = c.get('user');
    const name = b.name !== undefined ? String(b.name).trim().slice(0, 80) || u.name : u.name;
    const tz = isValidTimeZone(b.timezone) ? b.timezone : u.timezone;
    const emailReminders = b.email_reminders !== undefined ? (b.email_reminders ? 1 : 0) : u.email_reminders;
    const language = LANGS.includes(b.language) ? b.language : langOf(u.language);
    db.prepare('UPDATE users SET name = ?, timezone = ?, email_reminders = ?, language = ? WHERE id = ?').run(name, tz, emailReminders, language, u.id);
    return c.json({ user: ctx.publicUser(q.userById.get(u.id)) });
  });
};

module.exports.EMAIL_RE = EMAIL_RE;
