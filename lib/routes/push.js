// Push subscriptions, test notifications and the buttons on notifications.
const { t, langOf } = require('../messages');
module.exports = function pushRoutes(api, ctx) {
  const { q, store, auth, vapid, secret, now } = ctx;

  api.get('/push/key', c => c.json({ key: vapid.publicKey }));

  api.post('/push/subscribe', ctx.requireUser, async c => {
    const b = await ctx.readJson(c);
    const sub = b.subscription || {};
    if (!sub.endpoint || !/^https:\/\//.test(sub.endpoint) || !sub.keys || !sub.keys.p256dh || !sub.keys.auth) {
      return c.json({ error: ctx.t(c, 'bad_subscription') }, 400);
    }
    ctx.rememberOrigin(c);
    q.upsertSub.run(c.get('user').id, sub.endpoint, sub.keys.p256dh, sub.keys.auth, String(c.req.header('user-agent') || '').slice(0, 200));
    return c.json({ ok: true });
  });

  api.post('/push/unsubscribe', ctx.requireUser, async c => {
    const b = await ctx.readJson(c);
    if (b.endpoint) q.deleteSub.run(String(b.endpoint));
    return c.json({ ok: true });
  });

  api.post('/push/test', ctx.requireUser, async c => {
    const user = c.get('user');
    const lang = langOf(user.language);
    const devices = await ctx.pushToUser(user, { title: t(lang, 'test_title'), body: t(lang, 'test_body'), tag: 'test', url: '/' });
    return c.json({ ok: true, devices });
  });

  // Buttons on a notification ("Done", "1 hour") call this without a login, using the signed token.
  api.post('/action', async c => {
    const b = await ctx.readJson(c);
    const payload = await auth.verify(secret, b.token, now());
    if (!payload || !payload.u || !payload.r) return c.json({ error: ctx.t(c, 'action_expired') }, 403);
    const user = q.userById.get(payload.u);
    const r = user && store.get(user.id, payload.r);
    if (!r) return c.json({ error: ctx.t(c, 'reminder_gone') }, 404);
    if (b.action === 'done') ctx.markDone(r, user, payload.o);
    else if (b.action === 'snooze') ctx.snooze(r, user, b.minutes || 60);
    else return c.json({ error: ctx.t(c, 'unknown_action') }, 400);
    return c.json({ ok: true });
  });
};
