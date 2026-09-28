/*
 * TaskFlow reminder schedule.
 * Shared by the app (browser) and the server (Node) so both agree on exactly
 * when every notification fires.
 *
 * All calendar math uses "day numbers" (days since 1970-01-01) and "HH:MM"
 * strings, so it never depends on the time zone of the machine running it.
 * Turning a (date, time) pair into a real instant is left to the caller.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.Schedule = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  const DAY_MS = 86400000;
  const REPEATS = ['none', 'daily', 'weekly', 'monthly', 'yearly'];
  const KINDS = {
    task:   { icon: '✅', label: 'To-do' },
    bill:   { icon: '💳', label: 'Bill' },
    repeat: { icon: '🔁', label: 'Repeating' },
  };
  const ALERT_OPTIONS = [
    { value: 7, label: '1 week before' },
    { value: 3, label: '3 days before' },
    { value: 2, label: '2 days before' },
    { value: 1, label: '1 day before' },
    { value: 0, label: 'On the day' },
  ];
  const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

  // ─── date helpers ───
  function toDay(ymd) {
    const [y, m, d] = ymd.split('-').map(Number);
    return Math.floor(Date.UTC(y, m - 1, d) / DAY_MS);
  }
  function toYMD(day) { return new Date(day * DAY_MS).toISOString().slice(0, 10); }
  function parts(day) {
    const dt = new Date(day * DAY_MS);
    return { y: dt.getUTCFullYear(), m: dt.getUTCMonth(), d: dt.getUTCDate(), wd: dt.getUTCDay() };
  }
  function daysInMonth(y, m) { return new Date(Date.UTC(y, m + 1, 0)).getUTCDate(); }
  // Day `anchor` of month (y, m), clamped to the month's length (the 31st becomes the 30th in April).
  function clampedDay(y, m, anchor) {
    const first = new Date(Date.UTC(y, m, 1));
    const yy = first.getUTCFullYear(), mm = first.getUTCMonth();
    return Math.floor(Date.UTC(yy, mm, Math.min(anchor, daysInMonth(yy, mm))) / DAY_MS);
  }
  function toMinutes(hm) {
    const [h, m] = String(hm || '09:00').split(':').map(Number);
    return h * 60 + (m || 0);
  }
  function toHM(min) {
    return String(Math.floor(min / 60)).padStart(2, '0') + ':' + String(min % 60).padStart(2, '0');
  }
  function isValidYMD(s) {
    if (typeof s !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
    return toYMD(toDay(s)) === s;
  }
  function isValidHM(s) { return typeof s === 'string' && /^([01]\d|2[0-3]):[0-5]\d$/.test(s); }

  // ─── occurrences of repeating items ───
  function isRepeating(r) { return !!(r.repeat && r.repeat !== 'none' && r.start_date); }

  function nthOccurrence(r, n) {
    const start = toDay(r.start_date);
    const p = parts(start);
    switch (r.repeat) {
      case 'daily': return start + n;
      case 'weekly': return start + 7 * n;
      case 'monthly': return clampedDay(p.y, p.m + n, p.d);
      case 'yearly': return clampedDay(p.y + n, p.m, p.d);
      default: return n === 0 ? start : null;
    }
  }

  // Index of the last occurrence on or before `day`, or -1 if the series hasn't started.
  function indexAtOrBefore(r, day) {
    const start = toDay(r.start_date);
    if (day < start) return -1;
    const a = parts(start), b = parts(day);
    let n;
    switch (r.repeat) {
      case 'daily': return day - start;
      case 'weekly': return Math.floor((day - start) / 7);
      case 'monthly': n = (b.y - a.y) * 12 + (b.m - a.m); break;
      case 'yearly': n = b.y - a.y; break;
      default: return 0;
    }
    if (nthOccurrence(r, n) > day) n--;
    return n;
  }

  /**
   * The due date the item is "about" right now (YYYY-MM-DD), or null if it has no date.
   * For repeating items: the most recent occurrence if it hasn't been marked done
   * (due today / overdue), otherwise the next one.
   */
  function currentOccurrence(r, todayYMD) {
    if (!r.start_date) return null;
    if (!isRepeating(r)) return r.start_date;
    const today = toDay(todayYMD);
    const doneThrough = r.completed_through ? toDay(r.completed_through) : -Infinity;
    const i = indexAtOrBefore(r, today);
    if (i >= 0 && nthOccurrence(r, i) > doneThrough) return toYMD(nthOccurrence(r, i));
    const j = indexAtOrBefore(r, Math.max(today, doneThrough)) + 1;
    return toYMD(nthOccurrence(r, j));
  }

  function previousOccurrence(r, ymd) {
    if (!isRepeating(r)) return null;
    const i = indexAtOrBefore(r, toDay(ymd) - 1);
    return i >= 0 ? toYMD(nthOccurrence(r, i)) : null;
  }

  /** 'done' | 'overdue' | 'today' | 'upcoming' | 'nodate' */
  function status(r, todayYMD) {
    if (r.done) return 'done';
    const occ = currentOccurrence(r, todayYMD);
    if (!occ) return 'nodate';
    if (occ < todayYMD) return 'overdue';
    if (occ === todayYMD) return 'today';
    return 'upcoming';
  }

  /** All occurrence dates (YYYY-MM-DD) that fall between two dates, inclusive. */
  function occurrencesBetween(r, fromYMD, toYMD_) {
    if (!r.start_date) return [];
    const from = toDay(fromYMD), to = toDay(toYMD_);
    if (!isRepeating(r)) {
      const d = toDay(r.start_date);
      return d >= from && d <= to ? [r.start_date] : [];
    }
    const out = [];
    for (let i = Math.max(0, indexAtOrBefore(r, from - 1) + 1), guard = 0; guard < 2000; i++, guard++) {
      const d = nthOccurrence(r, i);
      if (d > to) break;
      if (d >= from) out.push(toYMD(d));
    }
    return out;
  }

  // Evenly spaced times between start and end (inclusive), e.g. 3 × 09:00–21:00 → 09:00, 15:00, 21:00.
  function nagTimes(r) {
    const n = Math.max(0, Math.min(24, r.nag_per_day | 0));
    if (!n) return [];
    const start = toMinutes(r.nag_start || '09:00');
    const end = Math.max(start, toMinutes(r.nag_end || '21:00'));
    if (n === 1) return [toHM(start)];
    const step = (end - start) / (n - 1);
    const times = [];
    for (let k = 0; k < n; k++) times.push(toHM(Math.round(start + k * step)));
    return [...new Set(times)];
  }

  /**
   * Every notification the item should fire on days fromDay..toDay (day numbers, inclusive).
   * Returns [{ date, time, type: 'alert'|'nag', occ, offset?, n?, of? }] sorted by date/time.
   */
  function fireTimes(r, fromDay, toDay_) {
    if (r.done || fromDay > toDay_) return [];
    const out = [];
    const alerts = Array.isArray(r.alerts) ? r.alerts : [];
    const time = r.time || '09:00';
    const doneThrough = r.completed_through ? toDay(r.completed_through) : -Infinity;
    const nags = nagTimes(r);

    if (r.start_date && alerts.length) {
      const maxOffset = Math.max(...alerts);
      const occs = isRepeating(r)
        ? occurrencesBetween(r, toYMD(fromDay), toYMD(toDay_ + maxOffset))
        : [r.start_date];
      for (const occ of occs) {
        const occDay = toDay(occ);
        if (occDay <= doneThrough) continue;
        for (const offset of alerts) {
          const day = occDay - offset;
          if (day >= fromDay && day <= toDay_) out.push({ date: toYMD(day), time, type: 'alert', occ, offset });
        }
      }
    }

    if (nags.length) {
      const pushNags = (day, occ) => {
        nags.forEach((t, k) => out.push({ date: toYMD(day), time: t, type: 'nag', occ, n: k + 1, of: nags.length }));
      };
      if (isRepeating(r)) {
        // Nag from each due date until it's marked done (or the next one comes around).
        const first = Math.max(0, indexAtOrBefore(r, fromDay));
        for (let i = first, guard = 0; guard < 2000; i++, guard++) {
          const occDay = nthOccurrence(r, i);
          if (occDay > toDay_) break;
          if (occDay <= doneThrough) continue;
          const nextDay = nthOccurrence(r, i + 1);
          for (let d = Math.max(occDay, fromDay); d < nextDay && d <= toDay_; d++) pushNags(d, toYMD(occDay));
        }
      } else {
        // One-time to-do: nag every day from when it was switched on until it's done.
        const startNag = toDay(r.nag_from || r.start_date || toYMD(fromDay));
        for (let d = Math.max(startNag, fromDay); d <= toDay_; d++) pushNags(d, r.start_date);
      }
    }

    // If a nag and an alert land on the same minute, keep the (more specific) alert.
    const seen = new Set();
    return out
      .sort((a, b) => (a.date + a.time).localeCompare(b.date + b.time) || (a.type === 'alert' ? -1 : 1))
      .filter(f => {
        const key = f.date + ' ' + f.time;
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      });
  }

  /**
   * The next `count` notifications after `nowMs`, as [{ ...fire, at }].
   * `toInstant(date, time)` converts a wall-clock pair into epoch ms.
   */
  function upcoming(r, nowMs, todayYMD, count, toInstant) {
    const today = toDay(todayYMD);
    for (const horizon of [14, 120, 800]) {
      const list = fireTimes(r, today, today + horizon)
        .map(f => ({ ...f, at: toInstant(f.date, f.time) }))
        .filter(f => f.at > nowMs);
      if (list.length >= count || horizon === 800) return list.slice(0, count);
    }
    return [];
  }

  // ─── human-friendly text ───
  function ordinal(n) {
    const s = ['th', 'st', 'nd', 'rd'], v = n % 100;
    return n + (s[(v - 20) % 10] || s[v] || s[0]);
  }
  function formatTime(hm) {
    const min = toMinutes(hm);
    const h = Math.floor(min / 60), m = min % 60;
    const ampm = h < 12 ? 'AM' : 'PM';
    const h12 = h % 12 === 0 ? 12 : h % 12;
    return m ? `${h12}:${String(m).padStart(2, '0')} ${ampm}` : `${h12} ${ampm}`;
  }
  function formatDate(ymd, withWeekday) {
    const p = parts(toDay(ymd));
    const base = `${MONTHS[p.m]} ${p.d}`;
    return withWeekday ? `${WEEKDAYS[p.wd].slice(0, 3)}, ${base}` : base;
  }
  function relativeDay(ymd, todayYMD) {
    const diff = toDay(ymd) - toDay(todayYMD);
    if (diff === 0) return 'today';
    if (diff === 1) return 'tomorrow';
    if (diff === -1) return 'yesterday';
    if (diff > 1 && diff < 7) return 'on ' + WEEKDAYS[parts(toDay(ymd)).wd];
    if (diff < -1) return `${-diff} days ago`;
    return 'on ' + formatDate(ymd);
  }

  function repeatSummary(r) {
    if (!isRepeating(r)) return '';
    const p = parts(toDay(r.start_date));
    switch (r.repeat) {
      case 'daily': return 'Every day';
      case 'weekly': return 'Every ' + WEEKDAYS[p.wd];
      case 'monthly': return `Every month on the ${ordinal(p.d)}`;
      case 'yearly': return `Every year on ${MONTHS[p.m]} ${p.d}`;
    }
    return '';
  }

  function alertSummary(r) {
    const alerts = (Array.isArray(r.alerts) ? r.alerts : []).slice().sort((a, b) => b - a);
    const bits = [];
    if (r.start_date && alerts.length) {
      const labels = alerts.map(a => {
        const opt = ALERT_OPTIONS.find(o => o.value === a);
        return opt ? opt.label.toLowerCase() : `${a} days before`;
      });
      bits.push(`${joinWords(labels)} at ${formatTime(r.time || '09:00')}`);
    }
    const nags = nagTimes(r);
    if (nags.length) {
      const span = nags.length === 1
        ? `at ${formatTime(nags[0])}`
        : `${formatTime(nags[0])}–${formatTime(nags[nags.length - 1])}`;
      bits.push(`${nags.length}× a day (${span}) until done`);
    }
    return bits.length ? capitalize(bits.join(', plus ')) : 'No notifications';
  }

  function joinWords(list) {
    if (list.length <= 1) return list.join('');
    return list.slice(0, -1).join(', ') + ' and ' + list[list.length - 1];
  }
  function capitalize(s) { return s ? s[0].toUpperCase() + s.slice(1) : s; }

  /** Notification title + body for one fire (used by the server's push sender and the app preview). */
  function describeFire(r, f, todayYMD) {
    const kind = KINDS[r.kind] || KINDS.task;
    const title = `${kind.icon} ${r.title}`;
    const amount = r.amount ? ` · ${r.amount}` : '';
    let body;
    if (f.type === 'alert') {
      if (f.offset === 0) body = r.kind === 'bill' ? 'Due today' : 'Today';
      else if (f.offset === 1) body = 'Due tomorrow';
      else if (f.offset === 7) body = 'Due in 1 week';
      else body = `Due in ${f.offset} days`;
      if (f.offset > 1) body += ` (${formatDate(f.occ, true)})`;
      body += amount;
    } else if (f.type === 'nag') {
      const overdue = f.occ && f.occ < (todayYMD || f.date);
      body = `${overdue ? 'Overdue — ' : ''}Reminder ${f.n} of ${f.of} today. Tap when it's done.`;
    } else {
      body = `Snoozed reminder${amount}`;
    }
    return { title, body };
  }

  return {
    REPEATS, KINDS, ALERT_OPTIONS, DAY_MS,
    toDay, toYMD, isValidYMD, isValidHM, toMinutes, toHM,
    isRepeating, nthOccurrence, currentOccurrence, previousOccurrence, occurrencesBetween, status,
    nagTimes, fireTimes, upcoming,
    formatTime, formatDate, relativeDay, repeatSummary, alertSummary, describeFire, ordinal,
  };
});
