const test = require('node:test');
const assert = require('node:assert/strict');
const S = require('../public/js/schedule');
const { wallToUtc, todayIn } = require('../lib/time');

const d = S.toDay;
const fires = (r, from, to) => S.fireTimes(r, d(from), d(to)).map(f => `${f.date} ${f.time} ${f.type}${f.type === 'alert' ? f.offset : f.n}`);

test('credit card: monthly, a day before and on the day', () => {
  const card = { title: 'Credit card', kind: 'bill', repeat: 'monthly', start_date: '2026-10-15', time: '09:00', alerts: [1, 0] };
  assert.deepEqual(fires(card, '2026-10-01', '2026-11-30'), [
    '2026-10-14 09:00 alert1',
    '2026-10-15 09:00 alert0',
    '2026-11-14 09:00 alert1',
    '2026-11-15 09:00 alert0',
  ]);
});

test('monthly on the 31st falls back to the last day of shorter months', () => {
  const rent = { repeat: 'monthly', start_date: '2026-01-31', alerts: [0] };
  assert.deepEqual(S.occurrencesBetween(rent, '2026-01-01', '2026-05-31'),
    ['2026-01-31', '2026-02-28', '2026-03-31', '2026-04-30', '2026-05-31']);
});

test('a day-before alert can land in the previous month', () => {
  const bill = { repeat: 'monthly', start_date: '2026-10-01', alerts: [1], time: '08:30' };
  assert.deepEqual(fires(bill, '2026-10-25', '2026-11-05'), ['2026-10-31 08:30 alert1']);
});

test('yearly on Feb 29 uses Feb 28 in non-leap years', () => {
  const r = { repeat: 'yearly', start_date: '2028-02-29', alerts: [0] };
  assert.deepEqual(S.occurrencesBetween(r, '2028-01-01', '2030-12-31'), ['2028-02-29', '2029-02-28', '2030-02-28']);
});

test('weekly and daily repeats', () => {
  assert.deepEqual(S.occurrencesBetween({ repeat: 'weekly', start_date: '2026-09-29' }, '2026-10-01', '2026-10-20'),
    ['2026-10-06', '2026-10-13', '2026-10-20']);
  assert.equal(S.occurrencesBetween({ repeat: 'daily', start_date: '2026-09-29' }, '2026-09-01', '2026-10-02').length, 4);
});

test('nag: N evenly spaced reminders a day until done', () => {
  const task = { title: 'Finish essay', repeat: 'none', nag_per_day: 3, nag_start: '09:00', nag_end: '21:00', nag_from: '2026-09-27' };
  assert.deepEqual(S.nagTimes(task), ['09:00', '15:00', '21:00']);
  assert.deepEqual(fires(task, '2026-09-26', '2026-09-28'), [
    '2026-09-27 09:00 nag1', '2026-09-27 15:00 nag2', '2026-09-27 21:00 nag3',
    '2026-09-28 09:00 nag1', '2026-09-28 15:00 nag2', '2026-09-28 21:00 nag3',
  ]);
  assert.deepEqual(fires({ ...task, done: true }, '2026-09-27', '2026-09-28'), []);
});

test('nag and due-date alerts together; same-minute duplicates collapse', () => {
  const task = { repeat: 'none', start_date: '2026-09-28', time: '09:00', alerts: [0], nag_per_day: 2, nag_start: '09:00', nag_end: '18:00', nag_from: '2026-09-28' };
  assert.deepEqual(fires(task, '2026-09-28', '2026-09-28'), ['2026-09-28 09:00 alert0', '2026-09-28 18:00 nag2']);
});

test('repeating nag runs from the due date until marked done', () => {
  const bill = { repeat: 'monthly', start_date: '2026-10-15', alerts: [], nag_per_day: 1, nag_start: '10:00', nag_end: '10:00' };
  assert.deepEqual(fires(bill, '2026-10-14', '2026-10-17'), ['2026-10-15 10:00 nag1', '2026-10-16 10:00 nag1', '2026-10-17 10:00 nag1']);
  const paid = { ...bill, completed_through: '2026-10-15' };
  assert.deepEqual(fires(paid, '2026-10-14', '2026-10-17'), []);
  assert.deepEqual(fires(paid, '2026-11-15', '2026-11-15'), ['2026-11-15 10:00 nag1']);
});

test('marking a month done skips its alerts but keeps next month', () => {
  const card = { repeat: 'monthly', start_date: '2026-10-15', alerts: [1, 0], completed_through: '2026-10-15' };
  assert.deepEqual(fires(card, '2026-10-01', '2026-11-30'), ['2026-11-14 09:00 alert1', '2026-11-15 09:00 alert0']);
});

test('current occurrence and status for repeating items', () => {
  const card = { repeat: 'monthly', start_date: '2026-01-15' };
  assert.equal(S.currentOccurrence(card, '2026-09-27'), '2026-09-15');           // September not paid yet
  assert.equal(S.status(card, '2026-09-27'), 'overdue');
  const paid = { ...card, completed_through: '2026-09-15' };
  assert.equal(S.currentOccurrence(paid, '2026-09-27'), '2026-10-15');
  assert.equal(S.status(paid, '2026-09-27'), 'upcoming');
  const paidEarly = { ...card, completed_through: '2026-10-15' };                  // paid October early
  assert.equal(S.currentOccurrence(paidEarly, '2026-09-27'), '2026-11-15');
  assert.equal(S.previousOccurrence(card, '2026-10-15'), '2026-09-15');
  assert.equal(S.status({ repeat: 'monthly', start_date: '2026-09-27' }, '2026-09-27'), 'today');
});

test('status for one-time to-dos', () => {
  assert.equal(S.status({ repeat: 'none' }, '2026-09-27'), 'nodate');
  assert.equal(S.status({ repeat: 'none', start_date: '2026-09-26' }, '2026-09-27'), 'overdue');
  assert.equal(S.status({ repeat: 'none', start_date: '2026-09-30', done: true }, '2026-09-27'), 'done');
});

test('upcoming() returns the next notifications after now', () => {
  const card = { repeat: 'monthly', start_date: '2026-10-15', time: '09:00', alerts: [1, 0] };
  const local = (date, time) => Date.parse(`${date}T${time}:00Z`);
  const next = S.upcoming(card, local('2026-10-14', '12:00'), '2026-10-14', 3, local);
  assert.deepEqual(next.map(f => f.date), ['2026-10-15', '2026-11-14', '2026-11-15']);
});

test('human-friendly text', () => {
  assert.equal(S.repeatSummary({ repeat: 'monthly', start_date: '2026-10-15' }), 'Every month on the 15th');
  assert.equal(S.alertSummary({ start_date: '2026-10-15', alerts: [0, 1], time: '09:00' }), '1 day before and on the day at 9 AM');
  assert.equal(S.alertSummary({ nag_per_day: 3, nag_start: '09:00', nag_end: '21:00' }), '3× a day (9 AM–9 PM) until done');
  const card = { title: 'Visa', kind: 'bill', amount: '$250' };
  assert.deepEqual(S.describeFire(card, { type: 'alert', offset: 1, occ: '2026-10-15' }), { title: '💳 Visa', body: 'Due tomorrow · $250' });
  assert.equal(S.describeFire(card, { type: 'nag', n: 2, of: 3, occ: '2026-10-15', date: '2026-10-16' }, '2026-10-16').body,
    'Overdue — Reminder 2 of 3 today. Tap when it\'s done.');
});

test('time zones: 9 AM in Los Angeles, including across daylight saving', () => {
  assert.equal(new Date(wallToUtc('2026-10-15', '09:00', 'America/Los_Angeles')).toISOString(), '2026-10-15T16:00:00.000Z');
  assert.equal(new Date(wallToUtc('2026-12-15', '09:00', 'America/Los_Angeles')).toISOString(), '2026-12-15T17:00:00.000Z');
  assert.equal(new Date(wallToUtc('2026-11-01', '09:00', 'America/Los_Angeles')).toISOString(), '2026-11-01T17:00:00.000Z');
  assert.equal(todayIn('America/Los_Angeles', Date.parse('2026-09-28T05:00:00Z')), '2026-09-27');
  assert.equal(todayIn('Asia/Tokyo', Date.parse('2026-09-28T05:00:00Z')), '2026-09-28');
});

test('Spanish wording for dates, repeats, alerts and notifications', () => {
  assert.equal(S.formatDate('2026-10-15', true, 'es'), 'jue, 15 oct');
  assert.equal(S.formatTime('09:00', 'es'), '9 a. m.');
  assert.equal(S.formatTime('13:30', 'es'), '1:30 p. m.');
  assert.equal(S.atTime('13:00', 'es'), 'a la 1 p. m.');
  assert.equal(S.relativeDay('2026-10-16', '2026-10-15', 'es'), 'mañana');
  assert.equal(S.relativeDay('2026-10-19', '2026-10-15', 'es'), 'el lunes');
  assert.equal(S.repeatSummary({ repeat: 'monthly', start_date: '2026-10-15' }, 'es'), 'Cada mes el día 15');
  assert.equal(S.repeatSummary({ repeat: 'weekly', start_date: '2026-10-17' }, 'es'), 'Todos los sábados');
  assert.equal(S.repeatSummary({ repeat: 'yearly', start_date: '2026-10-15' }, 'es'), 'Cada año el 15 de octubre');
  assert.equal(S.alertSummary({ start_date: '2026-10-15', alerts: [0, 1], time: '09:00' }, 'es'), '1 día antes y el mismo día a las 9 a. m.');
  assert.equal(S.alertSummary({ nag_per_day: 3, nag_start: '09:00', nag_end: '21:00' }, 'es'), '3 veces al día (9 a. m.–9 p. m.) hasta terminar');
  assert.equal(S.kindLabel('bill', 'es'), 'Pago');
  const card = { title: 'Visa', kind: 'bill', amount: '$250' };
  assert.equal(S.describeFire(card, { type: 'alert', offset: 1, occ: '2026-10-15' }, '2026-10-14', 'es').body, 'Vence mañana · $250');
  assert.equal(S.describeFire(card, { type: 'alert', offset: 3, occ: '2026-10-15' }, '2026-10-12', 'es').body, 'Vence en 3 días (jue, 15 oct) · $250');
  assert.equal(S.describeFire(card, { type: 'nag', n: 1, of: 2, occ: '2026-10-15', date: '2026-10-15' }, '2026-10-15', 'es').body,
    'Recordatorio 1 de 2 de hoy. Tócalo cuando esté hecho.');
});
