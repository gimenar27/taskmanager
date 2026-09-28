// Checks every 30 seconds for reminders that are due and sends them to everyone involved.
const Schedule = require('../public/js/schedule');
const { wallToUtc, todayIn, zonedParts } = require('./time');
const { parseReminder } = require('./reminders');

// If the server was briefly down, still send anything that came due in the last 15 minutes.
const GRACE_MS = 15 * 60000;

function createScheduler({ db, notify, now = () => Date.now(), log = console }) {
  const claim = db.prepare('INSERT OR IGNORE INTO sent_log (reminder_id, user_id, fire_key, sent_at) VALUES (?, ?, ?, ?)');
  const usersToNotify = db.prepare(`
    SELECT * FROM users u
    WHERE EXISTS (SELECT 1 FROM push_subscriptions p WHERE p.user_id = u.id) OR u.email_reminders = 1`);
  const remindersFor = db.prepare(`
    SELECT * FROM reminders
    WHERE done = 0 AND (owner_id = :uid OR id IN (SELECT reminder_id FROM shares WHERE user_id = :uid))`);
  const dueSnoozes = db.prepare('SELECT * FROM snoozes WHERE fire_at <= ?');
  const deleteSnooze = db.prepare('DELETE FROM snoozes WHERE id = ?');
  const canSee = db.prepare(`
    SELECT r.* FROM reminders r
    WHERE r.id = :rid AND r.done = 0 AND (r.owner_id = :uid OR r.id IN (SELECT reminder_id FROM shares WHERE user_id = :uid))`);
  const userById = db.prepare('SELECT * FROM users WHERE id = ?');
  const cleanup = db.prepare('DELETE FROM sent_log WHERE sent_at < ?');

  let running = false;
  let lastCleanup = 0;
  let timer = null;

  async function tick() {
    if (running) return { sent: 0 };
    running = true;
    const jobs = [];
    try {
      const t = now();
      for (const user of usersToNotify.all()) {
        const tz = user.timezone || 'UTC';
        const today = Schedule.toDay(todayIn(tz, t));
        for (const row of remindersFor.all({ uid: user.id })) {
          const r = parseReminder(row);
          for (const fire of Schedule.fireTimes(r, today - 1, today + 1)) {
            const at = wallToUtc(fire.date, fire.time, tz);
            if (at > t || at <= t - GRACE_MS) continue;
            const key = `${fire.type}:${fire.date}:${fire.time}`;
            if (claim.run(r.id, user.id, key, t).changes === 0) continue;
            jobs.push(notify(user, r, fire));
          }
        }
      }

      for (const snooze of dueSnoozes.all(t)) {
        deleteSnooze.run(snooze.id);
        const user = userById.get(snooze.user_id);
        const row = user && canSee.get({ rid: snooze.reminder_id, uid: user.id });
        if (!row) continue;
        const r = parseReminder(row);
        const tz = user.timezone || 'UTC';
        const p = zonedParts(t, tz);
        const today = todayIn(tz, t);
        jobs.push(notify(user, r, {
          type: 'snooze', date: today,
          time: `${String(p.h).padStart(2, '0')}:${String(p.mi).padStart(2, '0')}`,
          occ: Schedule.currentOccurrence(r, today),
        }));
      }

      if (t - lastCleanup > 3600000) {
        cleanup.run(t - 3 * 86400000);
        lastCleanup = t;
      }
    } catch (err) {
      log.error('Scheduler error:', err);
    } finally {
      running = false;
    }
    const results = await Promise.allSettled(jobs);
    for (const r of results) if (r.status === 'rejected') log.error('Notification failed:', r.reason);
    return { sent: jobs.length };
  }

  return {
    tick,
    start(intervalMs = 30000) {
      tick();
      timer = setInterval(tick, intervalMs);
      timer.unref?.();
    },
    stop() { clearInterval(timer); },
  };
}

module.exports = { createScheduler };
