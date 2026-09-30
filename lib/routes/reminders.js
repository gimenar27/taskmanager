// Reminders: create, edit, check off, snooze, share and calendar export.
const Schedule = require('../../public/js/schedule');
const { todayIn } = require('../time');
const { cleanReminderInput, parseReminder, toIcs, ValidationError } = require('../reminders');
const { EMAIL_RE } = require('./account');
const { t, langOf } = require('../messages');

module.exports = function reminderRoutes(api, ctx) {
  const { db, q, store, auth, env, log, mailer, now, secret } = ctx;
  const { requireUser, loadReminder } = ctx;
  const fresh = async (c, id) => ctx.withLinks(store.get(c.get('user').id, id));

  async function shareWith(reminderId, fromUser, rawEmail) {
    const email = String(rawEmail || '').trim().toLowerCase();
    if (!EMAIL_RE.test(email)) throw new ValidationError('enter_valid_email');
    if (email === String(fromUser.email).toLowerCase()) throw new ValidationError('own_email');
    const reminder = store.get(fromUser.id, reminderId);
    const target = q.userByEmail.get(email);
    if (target) {
      if (target.id === reminder.owner_id) throw new ValidationError('already_owner', { name: target.name });
      q.insertShare.run(reminderId, target.id, fromUser.id);
      const lang = langOf(target.language);
      await ctx.pushToUser(target, {
        title: t(lang, 'share_title'),
        body: t(lang, 'share_body', { name: fromUser.name, title: reminder.title }),
        tag: `share-${reminderId}`, url: `/?item=${reminderId}`,
      }).catch(() => {});
      return { email, status: 'shared', name: target.name };
    }
    q.insertInvite.run(reminderId, email, fromUser.id);
    if (mailer) {
      const lang = langOf(fromUser.language);
      await mailer.send(email, t(lang, 'invite_subject', { name: fromUser.name }),
        t(lang, 'invite_body', { name: fromUser.name, title: reminder.title, email, url: env.APP_URL || '' }))
        .catch(err => log.error('Invite email failed:', err.message));
    }
    return { email, status: 'invited' };
  }

  api.get('/reminders', requireUser, async c => {
    const user = c.get('user');
    const reminders = await Promise.all(store.list(user.id).map(ctx.withLinks));
    return c.json({ reminders, today: ctx.today(user) });
  });

  api.post('/reminders', requireUser, async c => {
    const b = await ctx.readJson(c);
    const user = c.get('user');
    const v = cleanReminderInput(b, null, ctx.today(user));
    const { id } = db.prepare(`
      INSERT INTO reminders (owner_id, title, notes, kind, priority, amount, start_date, time, repeat, alerts,
        nag_per_day, nag_start, nag_end, nag_from, starred)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING id`).get(
      user.id, v.title, v.notes, v.kind, v.priority, v.amount, v.start_date, v.time, v.repeat, v.alerts,
      v.nag_per_day, v.nag_start, v.nag_end, v.nag_from, v.starred);
    const emails = Array.isArray(b.share_with) ? b.share_with.slice(0, 20) : [];
    const shares = [];
    for (const email of emails) shares.push(await shareWith(id, user, email).catch(e => ({ email, error: e.message })));
    return c.json({ reminder: await fresh(c, id), shares }, 201);
  });

  api.get('/reminders/:id', requireUser, loadReminder, async c => c.json({ reminder: await ctx.withLinks(c.get('reminder')) }));

  api.patch('/reminders/:id', requireUser, loadReminder, async c => {
    const r = c.get('reminder');
    const v = cleanReminderInput(await ctx.readJson(c), r, ctx.today(c.get('user')));
    db.prepare(`
      UPDATE reminders SET title = ?, notes = ?, kind = ?, priority = ?, amount = ?, start_date = ?, time = ?, repeat = ?,
        alerts = ?, nag_per_day = ?, nag_start = ?, nag_end = ?, nag_from = ?, starred = ?, completed_through = ?,
        updated_at = datetime('now')
      WHERE id = ?`).run(
      v.title, v.notes, v.kind, v.priority, v.amount, v.start_date, v.time, v.repeat, v.alerts,
      v.nag_per_day, v.nag_start, v.nag_end, v.nag_from, v.starred, v.completed_through, r.id);
    return c.json({ reminder: await fresh(c, r.id) });
  });

  // The owner deletes it for everyone; anyone else just leaves it.
  api.delete('/reminders/:id', requireUser, loadReminder, c => {
    const r = c.get('reminder');
    if (r.is_owner) {
      for (const table of ['shares', 'invites', 'snoozes']) db.prepare(`DELETE FROM ${table} WHERE reminder_id = ?`).run(r.id);
      db.prepare('DELETE FROM reminders WHERE id = ?').run(r.id);
    } else {
      q.deleteShare.run(r.id, c.get('user').id);
    }
    return c.json({ ok: true, left: !r.is_owner });
  });

  api.post('/reminders/:id/done', requireUser, loadReminder, async c => {
    const b = await ctx.readJson(c);
    ctx.markDone(c.get('reminder'), c.get('user'), b.occ);
    return c.json({ reminder: await fresh(c, c.get('reminder').id) });
  });

  api.post('/reminders/:id/undo', requireUser, loadReminder, async c => {
    const r = c.get('reminder');
    if (Schedule.isRepeating(r)) {
      const prev = r.completed_through ? Schedule.previousOccurrence(r, r.completed_through) : null;
      db.prepare("UPDATE reminders SET completed_through = ?, done_at = NULL, done_by = NULL, updated_at = datetime('now') WHERE id = ?").run(prev, r.id);
    } else {
      db.prepare("UPDATE reminders SET done = 0, done_at = NULL, done_by = NULL, updated_at = datetime('now') WHERE id = ?").run(r.id);
    }
    return c.json({ reminder: await fresh(c, r.id) });
  });

  api.post('/reminders/:id/snooze', requireUser, loadReminder, async c => {
    const b = await ctx.readJson(c);
    return c.json({ ok: true, minutes: ctx.snooze(c.get('reminder'), c.get('user'), b.minutes) });
  });

  api.post('/reminders/:id/share', requireUser, loadReminder, async c => {
    const b = await ctx.readJson(c);
    const r = c.get('reminder');
    const result = await shareWith(r.id, c.get('user'), b.email);
    return c.json({ ...result, reminder: await fresh(c, r.id) });
  });

  api.delete('/reminders/:id/share/:userId', requireUser, loadReminder, async c => {
    const r = c.get('reminder');
    const userId = Number(c.req.param('userId'));
    if (!r.is_owner && userId !== c.get('user').id) return c.json({ error: ctx.t(c, 'owner_only_remove') }, 403);
    q.deleteShare.run(r.id, userId);
    return c.json({ reminder: await fresh(c, r.id) });
  });

  api.delete('/reminders/:id/invites/:email', requireUser, loadReminder, async c => {
    const r = c.get('reminder');
    q.deleteInvite.run(r.id, c.req.param('email'));
    return c.json({ reminder: await fresh(c, r.id) });
  });

  // Signed link so it can be opened by the phone's calendar or sent to someone without the app.
  api.get('/reminders/:id/calendar.ics', async c => {
    const id = Number(c.req.param('id'));
    const payload = await auth.verify(secret, c.req.query('sig'), now());
    if (!payload || payload.ics !== id) return c.text(ctx.t(c, 'link_invalid'), 403);
    const row = db.prepare('SELECT r.*, u.timezone, u.language FROM reminders r JOIN users u ON u.id = r.owner_id WHERE r.id = ?').get(id);
    if (!row) return c.text(ctx.t(c, 'reminder_gone'), 404);
    const r = parseReminder(row);
    const ics = toIcs(r, todayIn(row.timezone || 'UTC', now()), row.language);
    if (!ics) return c.text(t(row.language, 'add_date_first'), 400);
    const filename = r.title.replace(/[^\w\- ]+/g, '').trim().slice(0, 40) || 'reminder';
    return c.body(ics, 200, {
      'Content-Type': 'text/calendar; charset=utf-8',
      'Content-Disposition': `inline; filename="${filename}.ics"`,
    });
  });
};
