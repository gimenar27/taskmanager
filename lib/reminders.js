// Reminder validation, loading (with sharing info) and calendar (.ics) export.
const Schedule = require('../public/js/schedule');
const { t } = require('./messages');

const PRIORITIES = ['Low', 'Medium', 'High'];

function parseReminder(row) {
  let alerts = [];
  try { alerts = JSON.parse(row.alerts || '[]'); } catch { alerts = []; }
  return { ...row, alerts, done: !!row.done, starred: !!row.starred };
}

// Thrown for bad input; `key` is a message from lib/messages.js, shown in the person's language.
class ValidationError extends Error {
  constructor(key, vars = {}) {
    super(key);
    this.key = key;
    this.vars = vars;
  }
}

/**
 * Turn request input into clean column values. `existing` is the current row when editing,
 * so partial updates keep fields that weren't sent.
 */
function cleanReminderInput(body, existing, todayYMD) {
  const src = { ...(existing || {}), ...(body || {}) };
  const out = {};

  out.title = String(src.title ?? '').trim().slice(0, 200);
  if (!out.title) throw new ValidationError('name_required');
  out.notes = String(src.notes ?? '').slice(0, 2000);
  out.kind = Schedule.KINDS[src.kind] ? src.kind : 'task';
  out.priority = PRIORITIES.includes(src.priority) ? src.priority : 'Medium';
  out.amount = String(src.amount ?? '').trim().slice(0, 30);
  out.repeat = Schedule.REPEATS.includes(src.repeat) ? src.repeat : 'none';

  out.start_date = src.start_date ? String(src.start_date) : null;
  if (out.start_date && !Schedule.isValidYMD(out.start_date)) throw new ValidationError('bad_date');
  if (out.repeat !== 'none' && !out.start_date) throw new ValidationError('repeat_needs_date');

  out.time = src.time ? String(src.time) : '09:00';
  if (!Schedule.isValidHM(out.time)) throw new ValidationError('bad_time');

  let alerts = src.alerts;
  if (typeof alerts === 'string') { try { alerts = JSON.parse(alerts); } catch { alerts = []; } }
  if (!Array.isArray(alerts)) alerts = [];
  alerts = [...new Set(alerts.map(Number).filter(n => Number.isInteger(n) && n >= 0 && n <= 60))]
    .sort((a, b) => b - a).slice(0, 8);
  out.alerts = JSON.stringify(alerts);

  out.nag_per_day = Math.max(0, Math.min(24, parseInt(src.nag_per_day, 10) || 0));
  out.nag_start = Schedule.isValidHM(src.nag_start) ? src.nag_start : '09:00';
  out.nag_end = Schedule.isValidHM(src.nag_end) ? src.nag_end : '21:00';
  if (out.nag_per_day > 1 && Schedule.toMinutes(out.nag_end) <= Schedule.toMinutes(out.nag_start)) {
    throw new ValidationError('until_after_from');
  }
  // Nagging for one-time to-dos starts on the day it is switched on.
  const wasNagging = existing && existing.nag_per_day > 0;
  if (!out.nag_per_day) out.nag_from = null;
  else if (src.nag_from && Schedule.isValidYMD(src.nag_from)) out.nag_from = src.nag_from;
  else out.nag_from = wasNagging && existing.nag_from ? existing.nag_from : todayYMD;

  out.starred = src.starred ? 1 : 0;

  // Changing when something repeats resets which occurrences count as done.
  if (existing && (existing.start_date !== out.start_date || existing.repeat !== out.repeat)) {
    out.completed_through = null;
  } else {
    out.completed_through = existing ? existing.completed_through : null;
  }
  return out;
}

function createStore(db) {
  const visibleSql = `
    SELECT r.*, o.name AS owner_name, o.email AS owner_email
    FROM reminders r JOIN users o ON o.id = r.owner_id
    WHERE r.owner_id = ? OR r.id IN (SELECT reminder_id FROM shares WHERE user_id = ?)`;
  const listStmt = db.prepare(`${visibleSql} ORDER BY r.id DESC`);
  const oneStmt = db.prepare(`SELECT * FROM (${visibleSql}) WHERE id = ?`);
  const peopleStmt = db.prepare(`
    SELECT s.reminder_id, u.id, u.name, u.email FROM shares s JOIN users u ON u.id = s.user_id
    WHERE s.reminder_id IN (SELECT value FROM json_each(?)) ORDER BY s.created_at`);
  const invitesStmt = db.prepare(`
    SELECT reminder_id, email FROM invites WHERE reminder_id IN (SELECT value FROM json_each(?)) ORDER BY created_at`);

  function decorate(rows, uid) {
    const ids = JSON.stringify(rows.map(r => r.id));
    const people = peopleStmt.all(ids);
    const invites = invitesStmt.all(ids);
    return rows.map(row => {
      const r = parseReminder(row);
      return {
        ...r,
        is_owner: r.owner_id === uid,
        owner: { id: r.owner_id, name: r.owner_name, email: r.owner_email },
        shared_with: people.filter(p => p.reminder_id === r.id).map(({ id, name, email }) => ({ id, name, email })),
        invites: invites.filter(i => i.reminder_id === r.id).map(i => i.email),
      };
    });
  }

  return {
    list(uid) { return decorate(listStmt.all(uid, uid), uid); },
    get(uid, id) {
      const row = oneStmt.get(uid, uid, Number(id));
      return row ? decorate([row], uid)[0] : null;
    },
    // Everyone who should be notified about a reminder.
    participants(reminderId) {
      return db.prepare(`
        SELECT u.* FROM users u WHERE u.id = (SELECT owner_id FROM reminders WHERE id = ?)
        UNION SELECT u.* FROM users u JOIN shares s ON s.user_id = u.id WHERE s.reminder_id = ?`).all(reminderId, reminderId);
    },
  };
}

// ─── calendar export ───
function icsEscape(s) {
  return String(s).replace(/\\/g, '\\\\').replace(/;/g, '\\;').replace(/,/g, '\\,').replace(/\r?\n/g, '\\n');
}

// iCalendar lines must be folded at 75 octets.
const utf8 = new TextEncoder();
const fromUtf8 = new TextDecoder();
function fold(line) {
  const bytes = utf8.encode(line);
  if (bytes.length <= 75) return line;
  const chunks = [];
  let start = 0, limit = 75;
  while (start < bytes.length) {
    let end = Math.min(start + limit, bytes.length);
    while (end < bytes.length && (bytes[end] & 0xc0) === 0x80) end--; // don't split a UTF-8 character
    chunks.push(fromUtf8.decode(bytes.subarray(start, end)));
    start = end;
    limit = 74;
  }
  return chunks.join('\r\n ');
}

function toIcs(r, todayYMD, lang) {
  const occ = Schedule.currentOccurrence(r, todayYMD) || r.start_date;
  if (!occ) return null;
  const [hh, mm] = (r.time || '09:00').split(':');
  const dt = occ.replace(/-/g, '') + `T${hh}${mm}00`;
  const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d+/, '');
  const kind = Schedule.KINDS[r.kind] || Schedule.KINDS.task;
  const lines = [
    'BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//TaskFlow//Reminders//EN', 'CALSCALE:GREGORIAN', 'METHOD:PUBLISH',
    'BEGIN:VEVENT',
    `UID:taskflow-${r.id}@taskflow.app`,
    `DTSTAMP:${stamp}`,
    `DTSTART:${dt}`,
    'DURATION:PT15M',
    `SUMMARY:${icsEscape(`${kind.icon} ${r.title}`)}`,
  ];
  const desc = [r.amount ? `${t(lang, 'amount')}: ${r.amount}` : '', r.notes || ''].filter(Boolean).join('\n');
  if (desc) lines.push(`DESCRIPTION:${icsEscape(desc)}`);

  if (Schedule.isRepeating(r)) {
    const [, m, d] = r.start_date.split('-').map(Number);
    const byDay = d > 28 ? `BYMONTHDAY=${d},-1;BYSETPOS=1` : `BYMONTHDAY=${d}`;
    const rule = {
      daily: 'FREQ=DAILY',
      weekly: 'FREQ=WEEKLY',
      monthly: `FREQ=MONTHLY;${byDay}`,
      yearly: `FREQ=YEARLY;BYMONTH=${m};${byDay}`,
    }[r.repeat];
    lines.push(`RRULE:${rule}`);
  }
  for (const offset of r.alerts || []) {
    lines.push('BEGIN:VALARM', 'ACTION:DISPLAY', `DESCRIPTION:${icsEscape(r.title)}`,
      `TRIGGER:${offset === 0 ? 'PT0M' : `-P${offset}D`}`, 'END:VALARM');
  }
  lines.push('END:VEVENT', 'END:VCALENDAR');
  return lines.map(fold).join('\r\n') + '\r\n';
}

module.exports = { parseReminder, cleanReminderInput, createStore, toIcs, ValidationError };
