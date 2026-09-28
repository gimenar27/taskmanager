'use strict';
(function () {
  const S = window.Schedule;
  const $ = (sel, el = document) => el.querySelector(sel);
  const $$ = (sel, el = document) => [...el.querySelectorAll(sel)];
  const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const pad = n => String(n).padStart(2, '0');
  const wait = ms => new Promise(r => setTimeout(r, ms));

  // localStorage can be unavailable (private mode), so every access is guarded.
  const local = {
    get(key, fallback) { try { const v = localStorage.getItem(key); return v === null ? fallback : JSON.parse(v); } catch { return fallback; } },
    set(key, value) { try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* ignore */ } },
    remove(key) { try { localStorage.removeItem(key); } catch { /* ignore */ } },
  };

  const TZ = (() => { try { return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'; } catch { return 'UTC'; } })();
  const isAndroid = /android/i.test(navigator.userAgent);
  // iPads report themselves as a Mac with a touch screen.
  const isIOS = !isAndroid && (/iphone|ipad|ipod/i.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1));
  const isStandalone = () => matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;
  const pushSupported = () => 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;

  const todayYMD = () => ymdOf(new Date());
  const ymdOf = d => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  const sqlToDate = s => (s ? new Date(s.replace(' ', 'T') + 'Z') : null); // SQLite datetime('now') is UTC
  function localInstant(date, time) {
    const [y, m, d] = date.split('-').map(Number);
    const [h, mi] = time.split(':').map(Number);
    return new Date(y, m - 1, d, h, mi).getTime();
  }
  const firstName = name => String(name || '').trim().split(/\s+/)[0] || '';

  const QUOTES = [
    { text: 'The secret of getting ahead is getting started.', author: 'Mark Twain' },
    { text: 'It always seems impossible until it’s done.', author: 'Nelson Mandela' },
    { text: 'You don’t have to be great to start, but you have to start to be great.', author: 'Zig Ziglar' },
    { text: 'Small steps every day lead to big changes.', author: 'Unknown' },
    { text: 'Focus on progress, not perfection.', author: 'Unknown' },
    { text: 'Done is better than perfect.', author: 'Sheryl Sandberg' },
    { text: 'One task at a time. One day at a time.', author: 'Unknown' },
  ];
  const REPEAT_LABELS = { none: 'Never', daily: 'Daily', weekly: 'Weekly', monthly: 'Monthly', yearly: 'Yearly' };
  const TITLE_PLACEHOLDERS = { task: 'What do you need to do?', bill: 'e.g. Credit card, Rent, Phone bill', repeat: 'e.g. Water the plants' };
  const AVATAR_COLORS = ['#e76f51', '#d98a3d', '#2a9d8f', '#6d597a', '#457b9d', '#bc6c25', '#b5838d', '#588157'];

  const ICON = {
    check: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3.2" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12.5l4.5 4.5L19 7.5"/></svg>',
    search: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/></svg>',
    close: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"><path d="M6 6l12 12M18 6 6 18"/></svg>',
    chevL: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="m15 5-7 7 7 7"/></svg>',
    chevR: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="m9 5 7 7-7 7"/></svg>',
    iosShare: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3v12M7.5 7.5 12 3l4.5 4.5"/><path d="M6 11H5a1 1 0 0 0-1 1v8a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1v-8a1 1 0 0 0-1-1h-1"/></svg>',
    iosAdd: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><rect x="3.5" y="3.5" width="17" height="17" rx="4"/><path d="M12 8v8M8 12h8"/></svg>',
  };

  const state = {
    token: local.get('tf_token', null),
    user: local.get('tf_user', null),
    reminders: local.get('tf_cache', []),
    loaded: false,
    tab: 'home',
    search: '',
    searchOpen: false,
    showDone: false,
    cal: { y: new Date().getFullYear(), m: new Date().getMonth(), sel: todayYMD() },
    config: null,
    installPrompt: null,
    authMode: 'signup',
    sheet: null,
    form: null,
  };

  // ─── API ───
  async function api(path, { method = 'GET', body } = {}) {
    let res;
    try {
      res = await fetch('/api' + path, {
        method,
        headers: { 'Content-Type': 'application/json', ...(state.token ? { Authorization: 'Bearer ' + state.token } : {}) },
        body: body ? JSON.stringify(body) : undefined,
      });
    } catch {
      throw new Error(navigator.onLine ? 'Can’t reach TaskFlow right now. Try again in a moment.' : 'You’re offline. Connect to the internet and try again.');
    }
    const data = await res.json().catch(() => ({}));
    if (res.status === 401 && state.token && path !== '/login') {
      signOut(true);
      throw new Error(data.error || 'Please log in again.');
    }
    if (!res.ok) throw new Error(data.error || 'Something went wrong.');
    return data;
  }

  function saveCache() { local.set('tf_cache', state.reminders); }
  function upsert(r) {
    const i = state.reminders.findIndex(x => x.id === r.id);
    if (i >= 0) state.reminders[i] = r; else state.reminders.unshift(r);
    saveCache();
  }
  function byId(id) { return state.reminders.find(r => r.id === Number(id)); }

  async function refresh({ quiet = true } = {}) {
    if (!state.token) return;
    try {
      const data = await api('/reminders');
      state.reminders = data.reminders;
      saveCache();
    } catch (e) {
      if (!quiet) toast(e.message, 'error');
    }
    state.loaded = true;
    if (state.token) render();
  }

  // ─── Toasts ───
  function toast(msg, type = '', action) {
    const el = document.createElement('div');
    el.className = `toast ${type}`;
    el.innerHTML = `<span>${esc(msg)}</span>`;
    if (action) {
      const b = document.createElement('button');
      b.type = 'button';
      b.textContent = action.label;
      b.onclick = () => { el.remove(); action.run(); };
      el.appendChild(b);
    }
    const box = $('#toasts');
    while (box.children.length > 2) box.firstChild.remove();
    box.appendChild(el);
    setTimeout(() => el.remove(), action ? 6000 : 3200);
  }

  // ─── Theme ───
  function applyTheme() {
    const t = local.get('tf_theme', 'auto');
    if (t === 'auto') delete document.documentElement.dataset.theme;
    else document.documentElement.dataset.theme = t;
    const dark = t === 'dark' || (t === 'auto' && matchMedia('(prefers-color-scheme: dark)').matches);
    $('meta[name="theme-color"]').setAttribute('content', dark ? '#19110c' : '#fff7ef');
  }

  // ─── Notifications (Web Push) ───
  function notifState() {
    if (isIOS && !isStandalone() && !pushSupported()) return 'needs-install';
    if (!pushSupported()) return 'unsupported';
    if (Notification.permission === 'denied') return 'denied';
    if (Notification.permission === 'granted' && local.get('tf_push_ok', false)) return 'on';
    return 'off';
  }

  function b64ToBytes(b64) {
    const padded = b64 + '='.repeat((4 - (b64.length % 4)) % 4);
    const raw = atob(padded.replace(/-/g, '+').replace(/_/g, '/'));
    return Uint8Array.from(raw, c => c.charCodeAt(0));
  }
  function bytesToB64(bytes) {
    return btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  }

  async function currentSubscription() {
    if (!pushSupported()) return null;
    const reg = await navigator.serviceWorker.getRegistration();
    return reg ? reg.pushManager.getSubscription() : null;
  }

  async function subscribePush() {
    const reg = await navigator.serviceWorker.ready;
    const key = (state.config && state.config.vapidPublicKey) || (await api('/push/key')).key;
    let sub = await reg.pushManager.getSubscription();
    const subKey = sub && sub.options && sub.options.applicationServerKey;
    if (sub && subKey && bytesToB64(new Uint8Array(subKey)) !== key.replace(/=+$/, '')) {
      await sub.unsubscribe();
      sub = null;
    }
    if (!sub) sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: b64ToBytes(key) });
    await api('/push/subscribe', { method: 'POST', body: { subscription: sub.toJSON() } });
    local.set('tf_push_ok', true);
  }

  async function enableNotifications() {
    const st = notifState();
    if (st === 'needs-install') return openInstallGuide();
    if (st === 'unsupported') return toast('This browser can’t show notifications. Use Safari on iPhone or Chrome on Android.', 'error');
    try {
      const perm = await Notification.requestPermission();
      if (perm !== 'granted') {
        render();
        return toast(perm === 'denied' ? 'Notifications are blocked. You can allow them in Settings.' : 'Notifications are still off.', 'error');
      }
      await subscribePush();
      if (state.sheet && state.sheet.type === 'onboard') closeSheet();
      toast('Notifications are on 🎉', 'success');
    } catch (e) {
      toast('Couldn’t turn on notifications: ' + e.message, 'error');
    }
    render();
  }

  async function disableNotifications() {
    try {
      const sub = await currentSubscription();
      if (sub) {
        await api('/push/unsubscribe', { method: 'POST', body: { endpoint: sub.endpoint } }).catch(() => {});
        await sub.unsubscribe();
      }
    } finally {
      local.set('tf_push_ok', false);
      render();
      toast('Notifications turned off for this device');
    }
  }

  async function testPush() {
    try {
      const { devices } = await api('/push/test', { method: 'POST' });
      toast(devices ? 'Test sent! It should pop up in a few seconds.' : 'No devices registered. Turn notifications on first.', devices ? 'success' : 'error');
    } catch (e) { toast(e.message, 'error'); }
  }

  function updateBadge() {
    if (!('setAppBadge' in navigator)) return;
    const today = todayYMD();
    const n = state.reminders.filter(r => ['overdue', 'today'].includes(S.status(r, today))).length;
    (n ? navigator.setAppBadge(n) : navigator.clearAppBadge()).catch(() => {});
  }

  // ─── Shared rendering helpers ───
  function avatar(person, cls = '') {
    const name = (person && (person.name || person.email)) || '?';
    let h = 0;
    for (const c of name) h = (h * 31 + c.charCodeAt(0)) >>> 0;
    return `<span class="avatar ${cls}" style="background:${AVATAR_COLORS[h % AVATAR_COLORS.length]}" title="${esc(name)}">${esc(name.trim()[0]?.toUpperCase() || '?')}</span>`;
  }

  function annotate(r, today) { return { r, st: S.status(r, today), occ: S.currentOccurrence(r, today) }; }
  const PRIO = { High: 0, Medium: 1, Low: 2 };
  function sortItems(list) {
    return list.sort((a, b) => (a.occ || '9999').localeCompare(b.occ || '9999')
      || (PRIO[a.r.priority] ?? 1) - (PRIO[b.r.priority] ?? 1)
      || (b.r.starred - a.r.starred) || b.r.id - a.r.id);
  }

  function dueLabel(x, today) {
    const { r, st, occ } = x;
    if (st === 'done') {
      const d = sqlToDate(r.done_at);
      return d ? `Done ${S.relativeDay(ymdOf(d), today)}` : 'Done';
    }
    if (!occ) return '';
    if (st === 'overdue') return `<span class="due-overdue">Overdue · ${S.formatDate(occ)}</span>`;
    if (st === 'today') {
      const at = r.alerts && r.alerts.length ? ` · ${S.formatTime(r.time)}` : '';
      return `<span class="due-today">${r.kind === 'bill' ? 'Due today' : 'Today'}${at}</span>`;
    }
    return `Due ${S.relativeDay(occ, today).replace(/^on /, '')}`;
  }

  function peopleOf(r) {
    const me = state.user && state.user.id;
    return [...(r.is_owner ? [] : [r.owner]), ...r.shared_with.filter(p => p.id !== me)];
  }

  function rowHTML(x, today, { check = true } = {}) {
    const { r, st } = x;
    const kind = S.KINDS[r.kind] || S.KINDS.task;
    const bits = [dueLabel(x, today)];
    if (r.amount) bits.push(esc(r.amount));
    if (S.isRepeating(r)) bits.push('🔁 ' + REPEAT_LABELS[r.repeat]);
    if (r.nag_per_day && st !== 'done') bits.push(`🔔 ${r.nag_per_day}×/day`);
    const people = peopleOf(r);
    const checkHtml = check
      ? `<button type="button" class="check ${st === 'done' ? 'checked' : ''}" data-action="toggle" data-id="${r.id}" aria-label="${st === 'done' ? 'Mark as not done' : 'Mark as done'}">${ICON.check}</button>`
      : `<span class="check ${st === 'done' ? 'checked' : ''}" aria-hidden="true">${ICON.check}</span>`;
    return `
      <div class="row ${st} prio-${String(r.priority || 'Medium').toLowerCase()}" role="button" tabindex="0" data-action="open" data-id="${r.id}">
        ${checkHtml}
        <div class="row-main">
          <div class="row-title">${kind.icon} ${esc(r.title)}</div>
          <div class="row-sub">${bits.filter(Boolean).map(b => `<span>${b}</span>`).join('<span aria-hidden="true">·</span>')}</div>
        </div>
        <div class="row-end">
          ${people.length ? `<span class="avatars">${people.slice(0, 3).map(p => avatar(p)).join('')}</span>` : ''}
          ${r.starred ? '<span class="star" aria-label="Starred">★</span>' : ''}
        </div>
      </div>`;
  }

  function section(key, label, list, today) {
    return `<div class="section ${key}"><div class="section-head"><h2>${label}</h2><span class="count">${list.length}</span></div>
      <div class="list">${list.map(x => rowHTML(x, today)).join('')}</div></div>`;
  }

  function banner(icon, title, text, button, action, dismissible = true) {
    return `<div class="banner"><span class="b-icon">${icon}</span><div class="b-text"><strong>${title}</strong>${text}</div>
      ${button ? `<button type="button" class="btn btn-primary btn-sm" data-action="${action}">${button}</button>` : ''}
      ${dismissible ? `<button type="button" class="link-btn" data-action="dismiss-banner" aria-label="Hide">${ICON.close.replace('<svg', '<svg width="18" height="18"')}</button>` : ''}</div>`;
  }

  function notificationBanner() {
    const st = notifState();
    if (st === 'on' || local.get('tf_banner_hidden_until', 0) > Date.now()) return '';
    if (st === 'needs-install') return banner('📲', 'Get reminders on your iPhone', 'Add TaskFlow to your Home Screen first. It takes 10 seconds.', 'Show me', 'install-guide');
    if (st === 'off') return banner('🔔', 'Turn on notifications', 'So reminders reach you even when the app is closed.', 'Turn on', 'enable-push');
    if (st === 'denied') return banner('🔕', 'Notifications are blocked', isIOS ? 'Open Settings › Notifications › TaskFlow to allow them.' : 'Allow notifications for this site in your browser settings.');
    return banner('ℹ️', 'No notifications in this browser', isIOS ? 'Open TaskFlow in Safari and add it to your Home Screen.' : 'Use Chrome on Android or Safari on iPhone to get notifications.');
  }

  function topbar(html) { $('#topbar').innerHTML = html; }
  function view(html) { $('#view').innerHTML = html; }

  // ─── Home ───
  function renderHome() {
    const hour = new Date().getHours();
    const greet = hour < 12 ? 'Good morning' : hour < 18 ? 'Good afternoon' : 'Good evening';
    const dateLine = new Date().toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' });
    topbar(`
      <div class="tb-title"><div class="tb-sub">${greet} · ${esc(dateLine)}</div><h1>Hi${state.user ? ', ' + esc(firstName(state.user.name)) : ''}</h1></div>
      <button type="button" class="icon-btn" data-action="toggle-search" aria-label="Search">${ICON.search}</button>
      <button type="button" class="icon-btn" data-action="assistant" aria-label="Assistant">✦</button>`);

    let html = '';
    if (state.searchOpen) {
      html += `<div class="search">${ICON.search}<input class="input" id="searchInput" type="search" placeholder="Search reminders" value="${esc(state.search)}" autocomplete="off"></div>`;
    }
    html += notificationBanner();
    if (!state.searchOpen) html += progressCard(todayYMD());
    html += '<div id="homeList"></div>';
    view(html);
    renderHomeList();
  }

  function renderHomeList() {
    const box = $('#homeList');
    if (!box) return;
    const today = todayYMD();
    const t = S.toDay(today);
    const all = state.reminders.map(r => annotate(r, today));
    const q = state.search.trim().toLowerCase();
    const items = q ? all.filter(x => `${x.r.title} ${x.r.notes} ${x.r.amount}`.toLowerCase().includes(q)) : all;

    if (!state.loaded && !all.length) { box.innerHTML = '<div class="spinner" aria-label="Loading"></div>'; return; }
    if (!all.length) {
      box.innerHTML = `<div class="empty"><div class="e-icon">🌤️</div><h3>You’re all clear</h3>
        <p>Add your first reminder. Try a bill like your credit card, or something you need to get done.</p>
        <div class="quick"><button type="button" class="btn btn-primary" data-action="new" data-kind="bill">💳 Add a bill</button>
        <button type="button" class="btn btn-outline" data-action="new" data-kind="task">✅ Add a to-do</button></div></div>`;
      return;
    }
    const groups = [
      ['overdue', 'Overdue', items.filter(x => x.st === 'overdue')],
      ['today', 'Today', items.filter(x => x.st === 'today')],
      ['soon', 'Next 7 days', items.filter(x => x.st === 'upcoming' && S.toDay(x.occ) - t <= 7)],
      ['later', 'Later', items.filter(x => x.st === 'upcoming' && S.toDay(x.occ) - t > 7)],
      ['nodate', 'To-dos', items.filter(x => x.st === 'nodate')],
    ];
    const done = items.filter(x => x.st === 'done').sort((a, b) => String(b.r.done_at).localeCompare(String(a.r.done_at)));
    let html = groups.filter(g => g[2].length).map(([key, label, list]) => section(key, label, sortItems(list), today)).join('');
    if (q && !items.length) html += `<div class="empty"><p>No reminders match “${esc(state.search)}”.</p></div>`;
    if (done.length) {
      html += `<div class="section"><div class="section-head"><h2>Completed</h2>
        <button type="button" class="link-btn" data-action="toggle-done">${state.showDone ? 'Hide' : `Show ${done.length}`}</button></div>
        ${state.showDone ? `<div class="list">${done.slice(0, 60).map(x => rowHTML(x, today)).join('')}</div>` : ''}</div>`;
    }
    box.innerHTML = html;
  }

  function progressCard(today) {
    const all = state.reminders.map(r => annotate(r, today));
    const doneToday = all.filter(x => { const d = sqlToDate(x.r.done_at); return d && ymdOf(d) === today; }).length;
    const due = all.filter(x => x.st === 'overdue' || x.st === 'today').length;
    const total = doneToday + due;
    const pct = total ? Math.round((doneToday / total) * 100) : 100;
    const C = 2 * Math.PI * 26;
    const quote = QUOTES[new Date().getDate() % QUOTES.length];
    const title = total === 0 ? 'Nothing due today' : due === 0 ? 'All done for today 🎉' : `${doneToday} of ${total} done today`;
    return `<div class="card progress-card">
      <svg class="ring" viewBox="0 0 64 64" aria-hidden="true">
        <circle class="ring-bg" cx="32" cy="32" r="26"/>
        <circle class="ring-fg" cx="32" cy="32" r="26" transform="rotate(-90 32 32)" stroke-dasharray="${C.toFixed(1)}" stroke-dashoffset="${(C * (1 - pct / 100)).toFixed(1)}"/>
        <text x="32" y="37" text-anchor="middle">${total ? pct + '%' : '☀︎'}</text>
      </svg>
      <div class="pc-text"><div class="pc-title">${title}</div><div class="quote">“${esc(quote.text)}” — ${esc(quote.author)}</div></div>
    </div>`;
  }

  // ─── Calendar ───
  function occDone(r, ymd) { return r.done || (r.completed_through && ymd <= r.completed_through); }

  function renderCalendar() {
    const { y, m, sel } = state.cal;
    const today = todayYMD();
    const days = new Date(y, m + 1, 0).getDate();
    const start = `${y}-${pad(m + 1)}-01`;
    const end = `${y}-${pad(m + 1)}-${pad(days)}`;
    const byDate = {};
    for (const r of state.reminders) for (const d of S.occurrencesBetween(r, start, end)) (byDate[d] = byDate[d] || []).push(r);

    topbar(`<div class="tb-title"><h1>Calendar</h1></div><button type="button" class="btn btn-sm btn-outline" data-action="cal-today">Today</button>`);
    let grid = ['S', 'M', 'T', 'W', 'T', 'F', 'S'].map(d => `<div class="cal-head" aria-hidden="true">${d}</div>`).join('');
    for (let i = 0; i < new Date(y, m, 1).getDay(); i++) grid += '<div class="cal-day other"></div>';
    for (let d = 1; d <= days; d++) {
      const ymd = `${y}-${pad(m + 1)}-${pad(d)}`;
      const list = byDate[ymd] || [];
      const dots = list.slice(0, 3).map(r => `<i class="k-${esc(r.kind)} ${occDone(r, ymd) ? 'done' : ''}"></i>`).join('');
      grid += `<button type="button" class="cal-day ${ymd === today ? 'today' : ''} ${ymd === sel ? 'selected' : ''}" data-action="cal-select" data-date="${ymd}"
        aria-label="${S.formatDate(ymd, true)}${list.length ? `, ${list.length} due` : ''}"><span class="num">${d}</span><span class="cal-dots">${dots}</span></button>`;
    }
    const monthName = new Date(y, m, 1).toLocaleDateString(undefined, { month: 'long', year: 'numeric' });
    const selItems = state.reminders.filter(r => S.occurrencesBetween(r, sel, sel).length).map(r => {
      const st = occDone(r, sel) ? 'done' : sel < today ? 'overdue' : sel === today ? 'today' : 'upcoming';
      return { r, st, occ: sel, current: S.currentOccurrence(r, today) === sel };
    });
    const selTitle = sel === today ? 'Today' : S.formatDate(sel, true);
    view(`
      <div class="card">
        <div class="cal-nav">
          <button type="button" class="icon-btn" data-action="cal-move" data-dir="-1" aria-label="Previous month">${ICON.chevL}</button>
          <h2>${esc(monthName)}</h2>
          <button type="button" class="icon-btn" data-action="cal-move" data-dir="1" aria-label="Next month">${ICON.chevR}</button>
        </div>
        <div class="cal-grid">${grid}</div>
      </div>
      <div class="section"><div class="section-head"><h2>${esc(selTitle)}</h2>
        <button type="button" class="link-btn" data-action="new" data-date="${sel}">+ Add</button></div>
        ${selItems.length
          ? `<div class="list">${selItems.map(x => rowHTML(x, today, { check: x.current && x.st !== 'done' })).join('')}</div>`
          : '<div class="card"><p>Nothing due this day.</p></div>'}
      </div>`);
  }

  // ─── Shared ───
  function renderShared() {
    topbar('<div class="tb-title"><h1>Shared</h1><div class="tb-sub">Reminders you share with other people</div></div>');
    const today = todayYMD();
    const withMe = state.reminders.filter(r => !r.is_owner).map(r => annotate(r, today));
    const byMe = state.reminders.filter(r => r.is_owner && (r.shared_with.length || r.invites.length)).map(r => annotate(r, today));
    let html = `<div class="card"><h3>🤝 Share the load</h3>
      <p>Share bills and to-dos with family, roommates or your partner. Everyone gets the same notifications, and anyone can check it off.</p>
      <button type="button" class="btn btn-primary btn-sm mt" data-action="share-pick">Share a reminder</button></div>`;
    if (withMe.length) html += section('with-me', 'Shared with me', sortItems(withMe), today);
    if (byMe.length) html += section('by-me', 'I’m sharing', sortItems(byMe), today);
    if (!withMe.length && !byMe.length) {
      html += `<div class="empty"><div class="e-icon">💌</div><h3>Nothing shared yet</h3>
        <p>Open any reminder and tap <strong>Share</strong>, or add people when you create one.</p></div>`;
    }
    view(html);
  }

  // ─── Me ───
  function renderMe() {
    topbar('<div class="tb-title"><h1>Me</h1></div>');
    const u = state.user || {};
    const st = notifState();
    const theme = local.get('tf_theme', 'auto');
    const notifBody = {
      on: `<p>✅ Notifications are on for this device.</p>
        <div class="snooze-row mt"><button type="button" class="btn btn-primary btn-sm" data-action="test-push">Send a test</button>
        <button type="button" class="btn btn-ghost btn-sm" data-action="disable-push">Turn off</button></div>`,
      off: `<p>Turn them on so reminders reach you even when TaskFlow is closed.</p>
        <button type="button" class="btn btn-primary btn-block mt" data-action="enable-push">🔔 Turn on notifications</button>`,
      'needs-install': `<p>On iPhone, notifications work after you add TaskFlow to your Home Screen.</p>
        <button type="button" class="btn btn-primary btn-block mt" data-action="install-guide">📲 Show me how</button>`,
      denied: `<p>Notifications are blocked. ${isIOS ? 'Open <strong>Settings › Notifications › TaskFlow</strong> and allow them.' : 'Allow notifications for this site in your browser’s settings, then come back.'}</p>`,
      unsupported: `<p>This browser can’t show notifications. Use <strong>Safari</strong> on iPhone or <strong>Chrome</strong> on Android.</p>`,
    }[st];

    let installCard = '';
    if (!isStandalone()) {
      installCard = `<div class="card"><h3>📲 Add TaskFlow to your phone</h3>
        <p>${isIOS || isAndroid ? 'Put TaskFlow on your Home Screen so it opens like an app.' : 'Open TaskFlow on your phone and add it to your Home Screen.'}</p>
        <button type="button" class="btn btn-outline btn-block mt" data-action="${state.installPrompt ? 'install-app' : 'install-guide'}">${state.installPrompt ? 'Install app' : 'Show me how'}</button></div>`;
    }

    const emailRow = state.config && state.config.emailEnabled
      ? `<label class="switch-row"><span><span class="sr-text">Email me too</span><br><span class="sr-sub">Get due-date reminders by email as well</span></span>
          <span class="switch"><input type="checkbox" id="emailToggle" aria-label="Email me too" ${u.email_reminders ? 'checked' : ''}><span></span></span></label>`
      : '';

    view(`
      <div class="card" style="display:flex;gap:14px;align-items:center">${avatar(u, 'lg')}
        <div style="min-width:0"><div style="font-weight:700;font-size:18px">${esc(u.name)}</div><div class="muted" style="font-size:14px;overflow:hidden;text-overflow:ellipsis">${esc(u.email)}</div></div></div>
      <div class="card"><h3>🔔 Notifications</h3>${notifBody}</div>
      ${installCard}
      <div class="card"><h3>⚙️ Settings</h3>
        <div class="field mt"><span class="label">Appearance</span>
          <div class="seg">${['auto', 'light', 'dark'].map(t => `<button type="button" class="${theme === t ? 'active' : ''}" data-action="theme" data-theme="${t}">${{ auto: 'Automatic', light: 'Light', dark: 'Dark' }[t]}</button>`).join('')}</div></div>
        ${emailRow}
        <p class="hint">Time zone: ${esc(TZ)}</p>
      </div>
      <div class="card"><h3>✦ Assistant</h3><p>Break a big goal into small to-dos.</p>
        <button type="button" class="btn btn-outline btn-block mt" data-action="assistant">Open assistant</button></div>
      <button type="button" class="btn btn-danger btn-block" data-action="logout">Log out</button>
      <p class="center muted mt" style="font-size:13px">TaskFlow · Created by Gimena Rios Moreno</p>`);
  }

  // ─── Sheets ───
  function openSheet(inner, meta = {}) {
    const root = $('#sheet-root');
    const alreadyOpen = !!state.sheet;
    // Re-rendering the same sheet (e.g. after sharing) keeps your place instead of jumping to the top.
    const sameSheet = alreadyOpen && state.sheet.type === meta.type && state.sheet.id === meta.id;
    const oldBody = $('.sheet-body', root);
    const scrollTop = sameSheet && oldBody ? oldBody.scrollTop : 0;
    root.innerHTML = `<div class="sheet-backdrop" data-action="close-sheet"></div>
      <div class="sheet" role="dialog" aria-modal="true"><div class="sheet-handle"></div>${inner}</div>`;
    root.classList.add('open');
    document.body.classList.add('sheet-open');
    if (sameSheet) {
      $('.sheet', root).style.animation = 'none';
      const body = $('.sheet-body', root);
      if (body) body.scrollTop = scrollTop;
    }
    state.sheet = meta;
    if (!alreadyOpen) history.pushState({ tfSheet: true }, '');
  }

  function closeSheet(fromPop = false) {
    if (!state.sheet) return;
    state.sheet = null;
    state.form = null;
    const root = $('#sheet-root');
    root.classList.remove('open');
    root.innerHTML = '';
    document.body.classList.remove('sheet-open');
    if (!fromPop && history.state && history.state.tfSheet) history.back();
  }

  function sheetHead(title, extra = '') {
    return `<div class="sheet-head"><h2>${title}</h2>${extra}
      <button type="button" class="icon-btn" data-action="close-sheet" aria-label="Close">${ICON.close}</button></div>`;
  }

  // ─── Detail ───
  function fireWhen(f, today) {
    const rel = S.relativeDay(f.date, today);
    const day = rel === 'today' ? 'Today' : rel === 'tomorrow' ? 'Tomorrow' : S.formatDate(f.date, true);
    return `${day} · ${S.formatTime(f.time)}`;
  }
  function fireLabel(f) {
    if (f.type === 'nag') return `Nudge ${f.n} of ${f.of}`;
    if (f.offset === 0) return 'On the day';
    if (f.offset === 1) return '1 day before';
    if (f.offset === 7) return '1 week before';
    return `${f.offset} days before`;
  }
  function nameOf(r, userId) {
    if (state.user && userId === state.user.id) return 'you';
    const p = [r.owner, ...r.shared_with].find(x => x && x.id === userId);
    return p ? firstName(p.name) : '';
  }

  function openDetail(id, opts = {}) {
    const r = byId(id);
    if (!r) return toast('That reminder no longer exists.', 'error');
    renderDetail(r);
    if (opts.focusShare) setTimeout(() => { const el = $('#shareEmail'); if (el) { el.scrollIntoView({ block: 'center' }); el.focus(); } }, 350);
  }

  function renderDetail(r) {
    const today = todayYMD();
    const x = annotate(r, today);
    const kind = S.KINDS[r.kind] || S.KINDS.task;
    const repeating = S.isRepeating(r);
    const me = state.user ? state.user.id : null;

    let main, sub;
    if (x.st === 'done') {
      const d = sqlToDate(r.done_at);
      const by = r.done_by ? nameOf(r, r.done_by) : '';
      main = '✅ Done';
      sub = d ? `Checked off ${S.relativeDay(ymdOf(d), today)}${by ? ' by ' + esc(by) : ''}` : '';
    } else if (!x.occ) {
      main = 'No due date';
      sub = r.nag_per_day ? 'Reminding you until it’s done' : 'It’s in your To-dos';
    } else {
      main = x.st === 'overdue' ? `Overdue since ${S.formatDate(x.occ, true)}` : `Due ${S.relativeDay(x.occ, today)}`;
      sub = [S.formatDate(x.occ, true) + (r.alerts.length ? ` at ${S.formatTime(r.time)}` : ''), repeating ? S.repeatSummary(r) : ''].filter(Boolean).join(' · ');
    }
    if (r.amount) main += ` · ${esc(r.amount)}`;

    const doneLabel = x.st === 'done' ? '↺ Mark as not done'
      : repeating ? `✓ Mark ${S.formatDate(x.occ)} as ${r.kind === 'bill' ? 'paid' : 'done'}`
      : '✓ Mark as done';
    const lastDone = repeating && r.completed_through
      ? `<p class="hint center">Last checked off: ${S.formatDate(r.completed_through)}${r.done_by ? ' by ' + esc(nameOf(r, r.done_by)) : ''} ·
         <button type="button" class="link-btn" data-action="undo" data-id="${r.id}">Undo</button></p>` : '';

    const next = S.upcoming(r, Date.now(), today, 5, localInstant);
    const nextHtml = next.length
      ? `<ul class="next-list">${next.map(f => `<li><span>${esc(fireWhen(f, today))}</span><span>${esc(fireLabel(f))}</span></li>`).join('')}</ul>`
      : '<p class="muted" style="font-size:14px">No notifications scheduled.</p>';

    const people = [{ ...r.owner, owner: true }, ...r.shared_with];
    const peopleHtml = people.map(p => {
      const isMe = p.id === me;
      let btn = '';
      if (!p.owner && r.is_owner) btn = `<button type="button" class="btn btn-ghost btn-sm" data-action="unshare" data-id="${r.id}" data-user="${p.id}">Remove</button>`;
      else if (isMe && !r.is_owner) btn = `<button type="button" class="btn btn-ghost btn-sm" data-action="unshare" data-id="${r.id}" data-user="${p.id}">Leave</button>`;
      return `<div class="person">${avatar(p, 'md')}<div class="p-text"><div class="p-name">${esc(p.name)}${isMe ? ' (you)' : ''}</div>
        <div class="p-sub">${p.owner ? 'Owner · ' : ''}${esc(p.email)}</div></div>${btn}</div>`;
    }).join('') + r.invites.map(email => `<div class="person"><span class="avatar md" style="background:#b9a393">✉</span>
        <div class="p-text"><div class="p-name">${esc(email)}</div><div class="p-sub">Invited · sees it after signing up</div></div>
        <button type="button" class="btn btn-ghost btn-sm" data-action="send-invite" data-id="${r.id}" data-email="${esc(email)}">Remind</button>
        <button type="button" class="link-btn" data-action="cancel-invite" data-id="${r.id}" data-email="${esc(email)}" aria-label="Cancel invite">✕</button></div>`).join('');

    const canSnooze = x.st !== 'done';
    const tomorrow9 = new Date(); tomorrow9.setDate(tomorrow9.getDate() + 1); tomorrow9.setHours(9, 0, 0, 0);
    const minsToTomorrow = Math.round((tomorrow9 - Date.now()) / 60000);

    const badges = [
      `<span class="badge badge-kind">${kind.icon} ${kind.label}</span>`,
      `<span class="badge badge-${String(r.priority).toLowerCase()}">${esc(r.priority)} priority</span>`,
      !r.is_owner ? `<span class="badge badge-shared">Shared by ${esc(firstName(r.owner.name))}</span>` : '',
      x.st === 'overdue' ? '<span class="badge badge-overdue">Overdue</span>' : '',
    ].join('');

    openSheet(`
      ${sheetHead('', `<button type="button" class="icon-btn" data-action="star" data-id="${r.id}" aria-label="${r.starred ? 'Unstar' : 'Star'}" style="color:var(--accent)">${r.starred ? '★' : '☆'}</button>
        <button type="button" class="btn btn-outline btn-sm" data-action="edit" data-id="${r.id}">Edit</button>`)}
      <div class="sheet-body">
        <h2 class="detail-title">${esc(r.title)}</h2>
        <div class="detail-badges">${badges}</div>
        <div class="due-box"><div class="db-main">${main}</div>${sub ? `<div class="db-sub">${sub}</div>` : ''}</div>
        <button type="button" class="btn ${x.st === 'done' ? 'btn-outline' : 'btn-success'} btn-block" data-action="toggle" data-id="${r.id}">${doneLabel}</button>
        ${lastDone}
        ${canSnooze ? `<div class="field mt"><span class="label">Remind me again</span><div class="snooze-row">
          <button type="button" class="chip" data-action="snooze" data-id="${r.id}" data-minutes="60">In 1 hour</button>
          <button type="button" class="chip" data-action="snooze" data-id="${r.id}" data-minutes="180">In 3 hours</button>
          <button type="button" class="chip" data-action="snooze" data-id="${r.id}" data-minutes="${minsToTomorrow}">Tomorrow 9 AM</button></div></div>` : ''}
        ${r.notes ? `<div class="card mt"><p style="white-space:pre-wrap;color:var(--text)">${esc(r.notes)}</p></div>` : ''}
        <div class="card mt">
          <div class="kv"><span class="kv-icon">🔔</span><div class="kv-text">${esc(S.alertSummary(r))}<small>Notifications go to everyone on this reminder</small></div></div>
          <div class="kv"><span class="kv-icon">🗓️</span><div class="kv-text"><strong style="font-size:14px">Coming up</strong>${nextHtml}</div></div>
        </div>
        <div class="card">
          <h3>🤝 People</h3>
          ${peopleHtml}
          <div class="share-add"><input class="input" id="shareEmail" type="email" inputmode="email" autocapitalize="off" autocomplete="email" placeholder="Share with (email)" enterkeyhint="send">
            <button type="button" class="btn btn-primary" data-action="share" data-id="${r.id}">Share</button></div>
          <p class="hint">They get the same notifications and can check it off too.</p>
        </div>
        <div class="actions-grid">
          ${r.start_date ? `<a class="btn btn-outline" href="${esc(r.ics_url)}" target="_blank" rel="noopener">📅 Add to Calendar</a>
            <button type="button" class="btn btn-outline" data-action="send-ics" data-id="${r.id}">📤 Send invite</button>` : ''}
          <button type="button" class="btn btn-danger" data-action="delete" data-id="${r.id}" style="grid-column:1/-1">${r.is_owner ? '🗑 Delete' : 'Remove from my list'}</button>
        </div>
      </div>`, { type: 'detail', id: r.id });
  }

  // ─── New / edit form ───
  function kindDefaults(kind, today) {
    if (kind === 'bill') return { kind, repeat: 'monthly', alerts: [1, 0] };
    if (kind === 'repeat') return { kind, repeat: 'weekly', alerts: [0], start_date: today };
    return { kind: 'task', repeat: 'none', alerts: [0] };
  }

  function openForm(r, preset = {}) {
    const today = todayYMD();
    const editing = !!r;
    const f = editing
      ? {
          id: r.id, kind: r.kind, title: r.title, amount: r.amount, start_date: r.start_date || '', time: r.time,
          repeat: r.repeat, alerts: [...r.alerts], nag_per_day: r.nag_per_day, nag_start: r.nag_start, nag_end: r.nag_end,
          nag_from: r.nag_from, priority: r.priority, notes: r.notes, starred: r.starred,
          completed_through: r.completed_through, orig: { start_date: r.start_date || '', repeat: r.repeat }, share: [],
        }
      : {
          kind: 'task', title: '', amount: '', start_date: '', time: '09:00', repeat: 'none', alerts: [0],
          nag_per_day: 0, nag_start: '09:00', nag_end: '21:00', nag_from: null, priority: 'Medium', notes: '', starred: false, share: [],
          ...kindDefaults(preset.kind || 'task', today),
        };
    if (!editing && preset.date) f.start_date = preset.date;
    state.form = { f, editing };

    openSheet(`
      ${sheetHead(editing ? 'Edit reminder' : 'New reminder')}
      <div class="sheet-body">
        <form id="reminderForm" novalidate autocomplete="off">
          <div class="kinds" id="fKinds">${Object.keys(S.KINDS).map(k => `<button type="button" data-kind="${k}"><span class="k-icon">${S.KINDS[k].icon}</span>${S.KINDS[k].label}</button>`).join('')}</div>
          <div class="field"><label for="fTitle" class="label">Name</label><input class="input input-title" id="fTitle" maxlength="200" value="${esc(f.title)}" enterkeyhint="done"></div>
          <div class="field" id="fAmountField"><label for="fAmount">Amount (optional)</label><input class="input" id="fAmount" inputmode="decimal" placeholder="$0.00" maxlength="30" value="${esc(f.amount)}"></div>
          <div class="row2">
            <div class="field"><label for="fDate" id="fDateLabel">Date</label><input class="input" type="date" id="fDate" value="${esc(f.start_date)}"></div>
            <div class="field"><label for="fTime">Time</label><input class="input" type="time" id="fTime" value="${esc(f.time)}"></div>
          </div>
          <p class="hint" id="fDateHint" style="margin-top:-8px;margin-bottom:14px"></p>
          <div class="field"><span class="label">Repeat</span><div class="seg" id="fRepeat">${S.REPEATS.map(v => `<button type="button" data-repeat="${v}">${REPEAT_LABELS[v]}</button>`).join('')}</div></div>
          <div class="field"><span class="label">Remind me</span>
            <div class="chips" id="fAlerts">${S.ALERT_OPTIONS.slice().reverse().map(o => `<button type="button" class="chip" data-alert="${o.value}">${o.label}</button>`).join('')}</div>
            <p class="hint" id="fAlertHint"></p></div>
          <div class="card" style="padding:10px 14px">
            <label class="switch-row"><span><span class="sr-text">Keep reminding me until it’s done</span><br><span class="sr-sub">Several nudges a day, you pick how many</span></span>
              <span class="switch"><input type="checkbox" id="fNag" aria-label="Keep reminding me until it’s done"><span></span></span></label>
            <div id="fNagPanel" class="panel">
              <div class="nag-line"><span class="stepper"><button type="button" data-step="-1" aria-label="Fewer">−</button><output id="fNagCount"></output><button type="button" data-step="1" aria-label="More">+</button></span> times a day</div>
              <div class="row2 mt">
                <div class="field"><label for="fNagStart">From</label><input class="input" type="time" id="fNagStart" value="${esc(f.nag_start)}"></div>
                <div class="field"><label for="fNagEnd">Until</label><input class="input" type="time" id="fNagEnd" value="${esc(f.nag_end)}"></div>
              </div>
              <p class="hint" id="fNagHint" style="margin-top:0"></p>
            </div>
          </div>
          <div class="field"><span class="label">Priority</span><div class="seg" id="fPriority">${['Low', 'Medium', 'High'].map(p => `<button type="button" data-priority="${p}">${{ Low: '🟢 Low', Medium: '🟡 Medium', High: '🔴 High' }[p]}</button>`).join('')}</div></div>
          <div class="field"><label for="fNotes">Notes</label><textarea class="input" id="fNotes" maxlength="2000" placeholder="Anything to remember…">${esc(f.notes)}</textarea></div>
          ${editing ? '' : `<div class="field"><label for="fShare">Share with (optional)</label>
            <div class="share-add"><input class="input" id="fShare" type="email" inputmode="email" autocapitalize="off" placeholder="friend@email.com" enterkeyhint="done">
            <button type="button" class="btn btn-outline" data-action="form-add-share">Add</button></div>
            <div class="chips mt" id="fShareList"></div></div>`}
          <div class="card" id="fPreview"></div>
        </form>
      </div>
      <div class="sheet-foot"><button type="button" class="btn btn-primary btn-block" data-action="save-form" id="fSave">${editing ? 'Save changes' : 'Add reminder'}</button></div>`,
      { type: 'form', id: editing ? r.id : null });

    bindForm();
    updateForm();
    if (!editing) setTimeout(() => { const t = $('#fTitle'); if (t && !t.value) t.focus(); }, 320);
  }

  function bindForm() {
    const { f, editing } = state.form;
    const today = todayYMD();
    $('#fKinds').addEventListener('click', e => {
      const b = e.target.closest('[data-kind]');
      if (!b) return;
      const d = kindDefaults(b.dataset.kind, today);
      f.kind = d.kind;
      if (!editing || f.repeat === 'none' || d.repeat !== 'none') { f.repeat = d.repeat; f.alerts = d.alerts; }
      if (d.start_date && !f.start_date) { f.start_date = d.start_date; $('#fDate').value = f.start_date; }
      updateForm();
    });
    $('#fRepeat').addEventListener('click', e => {
      const b = e.target.closest('[data-repeat]');
      if (!b) return;
      f.repeat = b.dataset.repeat;
      if (f.repeat !== 'none' && !f.start_date) { f.start_date = today; $('#fDate').value = today; }
      updateForm();
    });
    $('#fAlerts').addEventListener('click', e => {
      const b = e.target.closest('[data-alert]');
      if (!b || b.disabled) return;
      const v = Number(b.dataset.alert);
      f.alerts = f.alerts.includes(v) ? f.alerts.filter(a => a !== v) : [...f.alerts, v];
      updateForm();
    });
    $('#fPriority').addEventListener('click', e => {
      const b = e.target.closest('[data-priority]');
      if (b) { f.priority = b.dataset.priority; updateForm(); }
    });
    $('#fNag').addEventListener('change', e => {
      f.nag_per_day = e.target.checked ? (f.nag_per_day || 3) : 0;
      updateForm();
    });
    $('#fNagPanel').addEventListener('click', e => {
      const b = e.target.closest('[data-step]');
      if (!b) return;
      f.nag_per_day = Math.max(1, Math.min(12, f.nag_per_day + Number(b.dataset.step)));
      updateForm();
    });
    const inputs = { fTitle: 'title', fAmount: 'amount', fDate: 'start_date', fTime: 'time', fNagStart: 'nag_start', fNagEnd: 'nag_end', fNotes: 'notes' };
    for (const [id, key] of Object.entries(inputs)) {
      const el = $('#' + id);
      el.addEventListener('input', () => { f[key] = el.value; if (key !== 'title' && key !== 'notes' && key !== 'amount') updateForm(); });
      el.addEventListener('change', () => { f[key] = el.value; updateForm(); });
    }
    const share = $('#fShare');
    if (share) share.addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); addFormShare(); } });
    $('#fTitle').addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); e.target.blur(); } });
  }

  function formReminder() {
    const { f, editing } = state.form;
    const today = todayYMD();
    const unchanged = editing && f.orig.start_date === f.start_date && f.orig.repeat === f.repeat;
    return {
      ...f,
      start_date: f.start_date || null,
      done: false,
      nag_from: f.nag_per_day ? (f.nag_from || today) : null,
      completed_through: unchanged ? f.completed_through : null,
    };
  }

  function updateForm() {
    if (!state.form) return;
    const { f } = state.form;
    const today = todayYMD();
    const hasDate = !!f.start_date;
    const repeating = f.repeat !== 'none';

    $$('#fKinds [data-kind]').forEach(b => b.classList.toggle('active', b.dataset.kind === f.kind));
    $('#fTitle').placeholder = TITLE_PLACEHOLDERS[f.kind];
    $('#fAmountField').hidden = f.kind !== 'bill' && !f.amount;
    $('#fDateLabel').textContent = f.kind === 'bill' ? (repeating ? 'Next due date' : 'Due date') : repeating ? 'Starts on' : 'Due date (optional)';

    const r = formReminder();
    let dateHint = '';
    if (repeating && hasDate) dateHint = `🔁 ${S.repeatSummary(r)}`;
    else if (!hasDate) dateHint = f.kind === 'bill' ? 'Pick the date it’s due.' : 'No date? That’s fine, it goes in your To-dos.';
    else dateHint = `<button type="button" class="link-btn" id="fClearDate">Clear date</button>`;
    $('#fDateHint').innerHTML = dateHint;
    const clear = $('#fClearDate');
    if (clear) clear.onclick = () => { f.start_date = ''; $('#fDate').value = ''; updateForm(); };

    $$('#fRepeat [data-repeat]').forEach(b => b.classList.toggle('active', b.dataset.repeat === f.repeat));
    $$('#fAlerts [data-alert]').forEach(b => {
      b.classList.toggle('active', hasDate && f.alerts.includes(Number(b.dataset.alert)));
      b.disabled = !hasDate;
    });
    $('#fAlertHint').textContent = hasDate ? `At ${S.formatTime(f.time || '09:00')} on each of these days.` : 'Pick a date to get these reminders.';

    $('#fNag').checked = f.nag_per_day > 0;
    $('#fNagPanel').hidden = !f.nag_per_day;
    $('#fNagCount').textContent = f.nag_per_day;
    if (f.nag_per_day) {
      const times = S.nagTimes(r).map(S.formatTime);
      const list = times.length > 4 ? `${times.length} times between ${times[0]} and ${times[times.length - 1]}` : `at ${joinList(times)}`;
      $('#fNagHint').textContent = `You’ll get nudged ${list} ${repeating ? 'on each due date' : 'every day, starting today,'} until you check it off.`;
    }
    $$('#fPriority [data-priority]').forEach(b => b.classList.toggle('active', b.dataset.priority === f.priority));

    const shareList = $('#fShareList');
    if (shareList) shareList.innerHTML = f.share.map((e, i) => `<span class="chip active">${esc(e)} <button type="button" class="link-btn" style="color:#fff;padding:0" data-action="remove-form-share" data-i="${i}" aria-label="Remove">✕</button></span>`).join('');

    let next = [];
    try { next = S.upcoming(r, Date.now(), today, 4, localInstant); } catch { next = []; }
    $('#fPreview').innerHTML = `<h3 style="font-size:16px">🔔 You’ll be notified</h3>` + (next.length
      ? `<ul class="next-list">${next.map(x => `<li><span>${esc(fireWhen(x, today))}</span><span>${esc(fireLabel(x))}</span></li>`).join('')}</ul>`
      : '<p>Not yet. Add a date or turn on “Keep reminding me”.</p>');
  }

  function joinList(list) {
    return list.length <= 1 ? list.join('') : list.slice(0, -1).join(', ') + ' and ' + list[list.length - 1];
  }

  function addFormShare() {
    const input = $('#fShare');
    const email = input.value.trim().toLowerCase();
    if (!email) return input.focus();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return toast('That email doesn’t look right.', 'error');
    if (!state.form.f.share.includes(email)) state.form.f.share.push(email);
    input.value = '';
    updateForm();
  }

  async function saveForm() {
    const { f, editing } = state.form;
    f.title = $('#fTitle').value.trim();
    const pendingShare = $('#fShare') && $('#fShare').value.trim();
    if (pendingShare) addFormShare();
    if (!f.title) { $('#fTitle').focus(); return toast('Give it a name first.', 'error'); }
    if (f.repeat !== 'none' && !f.start_date) return toast('Pick a date for it to repeat from.', 'error');
    if (f.kind === 'bill' && !f.start_date) { $('#fDate').focus(); return toast('Pick the date it’s due.', 'error'); }

    const body = {
      title: f.title, kind: f.kind, amount: f.amount, start_date: f.start_date || null, time: f.time || '09:00',
      repeat: f.repeat, alerts: f.start_date ? f.alerts : [], nag_per_day: f.nag_per_day, nag_start: f.nag_start,
      nag_end: f.nag_end, priority: f.priority, notes: f.notes, starred: f.starred,
    };
    if (!editing) body.share_with = f.share;
    const btn = $('#fSave');
    btn.disabled = true;
    btn.textContent = 'Saving…';
    try {
      const data = editing
        ? await api(`/reminders/${f.id}`, { method: 'PATCH', body })
        : await api('/reminders', { method: 'POST', body });
      upsert(data.reminder);
      render();
      if (editing) {
        renderDetail(data.reminder);
        toast('Saved ✓', 'success');
      } else {
        closeSheet();
        const invited = (data.shares || []).filter(s => s.status === 'invited');
        const failed = (data.shares || []).filter(s => s.error);
        if (failed.length) toast(`Couldn’t share with ${failed[0].email}: ${failed[0].error}`, 'error');
        else if (invited.length) toast(`Added. ${invited[0].email} will see it after they sign up.`, 'success', { label: 'Send invite', run: () => sendInviteMessage(data.reminder.id, invited[0].email) });
        else toast('Reminder added ✓', 'success');
        if (!local.get('tf_onboarded', false)) { local.set('tf_onboarded', true); setTimeout(openNotifOnboarding, 900); }
      }
    } catch (e) {
      toast(e.message, 'error');
      if (btn.isConnected) { btn.disabled = false; btn.textContent = editing ? 'Save changes' : 'Add reminder'; }
    }
  }

  // ─── Reminder actions ───
  async function toggleDone(id, btn) {
    const r = byId(id);
    if (!r) return;
    const today = todayYMD();
    const wasDone = S.status(r, today) === 'done';
    const occ = S.currentOccurrence(r, today);
    if (btn && btn.classList.contains('check')) btn.classList.add('checking');
    try {
      const data = await api(`/reminders/${id}/${wasDone ? 'undo' : 'done'}`, { method: 'POST', body: wasDone ? {} : { occ } });
      if (!wasDone) await wait(220);
      upsert(data.reminder);
      render();
      if (state.sheet && state.sheet.type === 'detail' && state.sheet.id === id) renderDetail(data.reminder);
      if (!wasDone) {
        const msg = S.isRepeating(r)
          ? `${r.kind === 'bill' ? 'Paid' : 'Done'} for ${S.formatDate(occ)}. Next: ${S.formatDate(S.currentOccurrence(data.reminder, today))}`
          : 'Nice work! ✓';
        toast(msg, 'success', { label: 'Undo', run: () => undoDone(id) });
      }
    } catch (e) {
      if (btn) btn.classList.remove('checking');
      toast(e.message, 'error');
    }
  }

  async function undoDone(id) {
    try {
      const data = await api(`/reminders/${id}/undo`, { method: 'POST' });
      upsert(data.reminder);
      render();
      if (state.sheet && state.sheet.type === 'detail' && state.sheet.id === id) renderDetail(data.reminder);
    } catch (e) { toast(e.message, 'error'); }
  }

  async function toggleStar(id) {
    const r = byId(id);
    try {
      const data = await api(`/reminders/${id}`, { method: 'PATCH', body: { starred: !r.starred } });
      upsert(data.reminder);
      render();
      renderDetail(data.reminder);
    } catch (e) { toast(e.message, 'error'); }
  }

  async function deleteReminder(id) {
    const r = byId(id);
    if (!r) return;
    const shared = r.shared_with.length > 0;
    const question = !r.is_owner ? `Remove “${r.title}” from your list? ${firstName(r.owner.name)} will still have it.`
      : shared ? `Delete “${r.title}” for everyone it’s shared with?` : `Delete “${r.title}”?`;
    if (!confirm(question)) return;
    try {
      await api(`/reminders/${id}`, { method: 'DELETE' });
      state.reminders = state.reminders.filter(x => x.id !== id);
      saveCache();
      closeSheet();
      render();
      toast(r.is_owner ? 'Deleted' : 'Removed from your list');
    } catch (e) { toast(e.message, 'error'); }
  }

  async function snoozeReminder(id, minutes) {
    try {
      await api(`/reminders/${id}/snooze`, { method: 'POST', body: { minutes } });
      const when = minutes >= 600 ? 'tomorrow at 9 AM' : minutes >= 120 ? `in ${Math.round(minutes / 60)} hours` : 'in 1 hour';
      toast(`Okay, I’ll remind you ${when} ⏰`, 'success');
      if (notifState() !== 'on') setTimeout(() => toast('Turn on notifications so the reminder can reach you.'), 1500);
    } catch (e) { toast(e.message, 'error'); }
  }

  async function shareReminder(id) {
    const input = $('#shareEmail');
    const email = input.value.trim();
    if (!email) return input.focus();
    try {
      const data = await api(`/reminders/${id}/share`, { method: 'POST', body: { email } });
      upsert(data.reminder);
      render();
      renderDetail(data.reminder);
      if (data.status === 'shared') toast(`Shared with ${data.name} ✓`, 'success');
      else toast(`${data.email} doesn’t have TaskFlow yet.`, '', { label: 'Send invite', run: () => sendInviteMessage(id, data.email) });
    } catch (e) { toast(e.message, 'error'); }
  }

  async function unshare(id, userId) {
    const r = byId(id);
    const leaving = state.user && userId === state.user.id;
    if (leaving && !confirm(`Leave “${r.title}”? You’ll stop getting its reminders.`)) return;
    try {
      const data = await api(`/reminders/${id}/share/${userId}`, { method: 'DELETE' });
      if (leaving) {
        state.reminders = state.reminders.filter(x => x.id !== id);
        saveCache();
        closeSheet();
        toast('You left the reminder');
      } else {
        upsert(data.reminder);
        renderDetail(data.reminder);
      }
      render();
    } catch (e) { toast(e.message, 'error'); }
  }

  async function cancelInvite(id, email) {
    try {
      const data = await api(`/reminders/${id}/invites/${encodeURIComponent(email)}`, { method: 'DELETE' });
      upsert(data.reminder);
      renderDetail(data.reminder);
      render();
    } catch (e) { toast(e.message, 'error'); }
  }

  async function shareOrCopy({ title, text, url }) {
    if (navigator.share) {
      try { await navigator.share({ title, text, url }); return; } catch (e) { if (e.name === 'AbortError') return; }
    }
    const full = `${text} ${url}`;
    try { await navigator.clipboard.writeText(full); toast('Copied! Paste it into a message.', 'success'); } catch { window.prompt('Copy this message:', full); }
  }

  function sendInviteMessage(id, email) {
    const r = byId(id);
    shareOrCopy({
      title: 'TaskFlow',
      text: `I shared “${r ? r.title : 'a reminder'}” with you on TaskFlow so we both get reminded. Sign up with ${email} to see it:`,
      url: location.origin,
    });
  }

  function sendCalendarInvite(id) {
    const r = byId(id);
    shareOrCopy({ title: r.title, text: `Add “${r.title}” to your calendar so you get reminded:`, url: location.origin + r.ics_url });
  }

  function openSharePicker() {
    const today = todayYMD();
    const mine = sortItems(state.reminders.filter(r => r.is_owner && !r.done).map(r => annotate(r, today)));
    if (!mine.length) return openForm(null);
    openSheet(`${sheetHead('Pick a reminder to share')}<div class="sheet-body"><div class="list">
      ${mine.map(x => rowHTML(x, today, { check: false }).replace('data-action="open"', 'data-action="open-share"')).join('')}</div></div>`, { type: 'pick' });
  }

  // ─── Onboarding / install / assistant ───
  function openNotifOnboarding() {
    const st = notifState();
    if (state.sheet || st === 'on' || st === 'denied' || st === 'unsupported') return;
    if (st === 'needs-install') return openInstallGuide();
    openSheet(`${sheetHead('')}
      <div class="sheet-body center">
        <div style="font-size:60px;line-height:1">🔔</div>
        <h2 style="margin:10px 0 8px">Get your reminders</h2>
        <p class="muted">Allow notifications so TaskFlow can remind you about bills and to-dos, even when the app is closed.</p>
        <button type="button" class="btn btn-primary btn-block mt" data-action="enable-push">Turn on notifications</button>
        <button type="button" class="btn btn-ghost btn-block" data-action="close-sheet">Not now</button>
      </div>`, { type: 'onboard' });
  }

  function openInstallGuide() {
    let body;
    let qr = false;
    if (isIOS) {
      const inApp = /FBAN|FBAV|Instagram|Line|GSA|CriOS|FxiOS|EdgiOS/i.test(navigator.userAgent);
      body = `<p class="muted">On iPhone, notifications work once TaskFlow is on your Home Screen (iOS 16.4 or newer).</p>
        <ol class="steps">
          <li><div>Open this page in <strong>Safari</strong>.${inApp ? ' <br><span class="muted">You’re in another app’s browser right now. Copy the link and paste it into Safari.</span>' : ''}</div></li>
          <li><div>Tap the <strong>Share</strong> button <span class="ios-glyph">${ICON.iosShare}</span> in Safari’s toolbar.</div></li>
          <li><div>Scroll down and tap <strong>Add to Home Screen</strong> <span class="ios-glyph">${ICON.iosAdd}</span>.</div></li>
          <li><div>Tap <strong>Add</strong>, then open <strong>TaskFlow</strong> from your Home Screen.</div></li>
          <li><div>Log in and tap <strong>Turn on notifications</strong>.</div></li>
        </ol>`;
    } else if (state.installPrompt) {
      body = `<p>Install TaskFlow so it opens like an app and can send you notifications.</p>
        <button type="button" class="btn btn-primary btn-block mt" data-action="install-app">Install TaskFlow</button>`;
    } else if (isAndroid) {
      body = `<ol class="steps">
          <li><div>Open this page in <strong>Chrome</strong>.</div></li>
          <li><div>Tap the <strong>⋮</strong> menu (top right).</div></li>
          <li><div>Tap <strong>Install app</strong> or <strong>Add to Home screen</strong>.</div></li>
          <li><div>Open TaskFlow from your home screen and tap <strong>Turn on notifications</strong>.</div></li>
        </ol>`;
    } else {
      const onlyThisComputer = /^(localhost|127\.|192\.168\.|10\.)/.test(location.hostname);
      qr = !onlyThisComputer;
      body = onlyThisComputer
        ? `<p>TaskFlow is running only on this computer right now, so your phone can’t reach it yet.</p><p class="muted mt">Put it online first (see <strong>DEPLOY.md</strong>), then open that address on your phone.</p>`
        : `<p>Scan this with your phone’s camera to open TaskFlow there, then add it to your Home Screen.</p>
          <div id="qr" class="center mt" style="background:#fff;padding:14px;border-radius:16px;width:max-content;margin:14px auto"></div>
          <p class="center muted" style="word-break:break-all">${esc(location.origin)}</p>`;
    }
    openSheet(`${sheetHead('Add TaskFlow to your phone')}<div class="sheet-body">${body}</div>`, { type: 'install' });
    if (qr) drawQR($('#qr'), location.origin);
  }

  function drawQR(el, text) {
    const draw = () => {
      const qr = window.qrcode(0, 'M');
      qr.addData(text);
      qr.make();
      el.innerHTML = qr.createSvgTag({ cellSize: 5, margin: 0, scalable: false });
    };
    if (window.qrcode) return draw();
    const s = document.createElement('script');
    s.src = '/js/vendor/qrcode.js';
    s.onload = draw;
    document.head.appendChild(s);
  }

  async function promptInstall() {
    if (!state.installPrompt) return openInstallGuide();
    state.installPrompt.prompt();
    const { outcome } = await state.installPrompt.userChoice;
    state.installPrompt = null;
    if (outcome === 'accepted') { closeSheet(); toast('Installed! Open TaskFlow from your home screen.', 'success'); }
    render();
  }

  function openAssistant() {
    openSheet(`${sheetHead('✦ Assistant')}
      <div class="sheet-body">
        <p class="muted" style="margin-top:0">Tell me what you’re working on and I’ll break it into small steps you can add as to-dos.</p>
        <div class="field"><textarea class="input" id="aiInput" placeholder="e.g. Help me get on top of my bills"></textarea></div>
        <div class="chips">${window.Assistant.prompts.map(p => `<button type="button" class="chip" data-action="ai-prompt" data-text="${esc(p.text)}">${p.label}</button>`).join('')}</div>
        <button type="button" class="btn btn-primary btn-block mt" data-action="ai-run">Break it down ✦</button>
        <div id="aiOut"></div>
      </div>`, { type: 'assistant' });
  }

  function runAssistant() {
    const text = $('#aiInput').value.trim();
    if (!text) return toast('Type what you need help with first.');
    const plan = window.Assistant.suggest(text);
    $('#aiOut').innerHTML = `<div class="card mt"><h3>${esc(plan.title)}</h3>
      <div class="ai-steps">${plan.steps.map(s => `<label><input type="checkbox" checked data-step="${esc(s)}"><span>${esc(s)}</span></label>`).join('')}</div>
      <button type="button" class="btn btn-primary btn-block mt" data-action="ai-add">Add selected as to-dos</button></div>`;
    $('#aiOut').scrollIntoView({ behavior: 'smooth', block: 'start' });
  }

  async function addAssistantSteps() {
    const steps = $$('#aiOut input:checked').map(i => i.dataset.step);
    if (!steps.length) return toast('Pick at least one step.');
    try {
      for (const title of steps) {
        const d = await api('/reminders', { method: 'POST', body: { title, kind: 'task', alerts: [] } });
        upsert(d.reminder);
      }
      closeSheet();
      render();
      toast(`Added ${steps.length} to-dos ✓`, 'success');
    } catch (e) { toast(e.message, 'error'); }
  }

  // ─── Auth ───
  function setAuthMode(mode) {
    state.authMode = mode;
    $$('.auth-tabs button').forEach(b => { b.classList.toggle('active', b.dataset.mode === mode); b.setAttribute('aria-selected', b.dataset.mode === mode); });
    $('#nameField').hidden = mode === 'login';
    $('#authSubmit').textContent = mode === 'login' ? 'Log in' : 'Create account';
    $('#authPassword').setAttribute('autocomplete', mode === 'login' ? 'current-password' : 'new-password');
    $('#authPassword').placeholder = mode === 'login' ? 'Your password' : 'At least 6 characters';
    $('#authMsg').hidden = true;
  }

  async function submitAuth(e) {
    e.preventDefault();
    const msg = $('#authMsg');
    const btn = $('#authSubmit');
    const body = {
      name: $('#authName').value.trim(),
      email: $('#authEmail').value.trim(),
      password: $('#authPassword').value,
      timezone: TZ,
    };
    const signup = state.authMode === 'signup';
    if (!body.email || !body.password || (signup && !body.name)) {
      msg.className = 'form-msg error';
      msg.textContent = 'Please fill out every field.';
      msg.hidden = false;
      return;
    }
    btn.disabled = true;
    btn.textContent = signup ? 'Creating account…' : 'Logging in…';
    try {
      const data = await api(signup ? '/signup' : '/login', { method: 'POST', body });
      state.token = data.token;
      state.user = data.user;
      state.tab = 'home';
      local.set('tf_token', data.token);
      local.set('tf_user', data.user);
      local.set('tf_known', true);
      $('#authPassword').value = '';
      await afterLogin(signup);
      toast(signup ? `Welcome, ${firstName(data.user.name)}! 🎉` : `Welcome back, ${firstName(data.user.name)}!`, 'success');
    } catch (err) {
      msg.className = 'form-msg error';
      msg.textContent = err.message;
      msg.hidden = false;
    } finally {
      btn.disabled = false;
      btn.textContent = state.authMode === 'login' ? 'Log in' : 'Create account';
    }
  }

  async function afterLogin(isNewAccount) {
    state.loaded = state.reminders.length > 0;
    render();
    await refresh();
    if (state.user && state.user.timezone !== TZ) {
      api('/me', { method: 'PATCH', body: { timezone: TZ } }).then(d => { state.user = d.user; local.set('tf_user', d.user); }).catch(() => {});
    }
    if (pushSupported() && Notification.permission === 'granted') subscribePush().catch(() => {});
    handleUrl(location.href);
    if (isNewAccount && !local.get('tf_onboarded', false)) { local.set('tf_onboarded', true); setTimeout(openNotifOnboarding, 700); }
  }

  async function signOut(expired = false) {
    if (!expired) {
      let endpoint = null;
      try { const sub = await currentSubscription(); endpoint = sub && sub.endpoint; } catch { /* ignore */ }
      await api('/logout', { method: 'POST', body: { endpoint } }).catch(() => {});
    }
    state.token = null;
    state.user = null;
    state.reminders = [];
    state.loaded = false;
    ['tf_token', 'tf_user', 'tf_cache', 'tf_push_ok'].forEach(k => local.remove(k));
    closeSheet();
    setAuthMode('login');
    render();
    if (expired) toast('Please log in again.');
  }

  function handleUrl(href) {
    const url = new URL(href, location.origin);
    const item = url.searchParams.get('item');
    const wantsNew = url.searchParams.get('new');
    if (url.search) history.replaceState(history.state, '', '/');
    if (!state.token) return;
    if (item) {
      if (byId(item)) openDetail(item);
      else refresh().then(() => byId(item) && openDetail(item));
    } else if (wantsNew) {
      openForm(null);
    }
  }

  // ─── Render / navigation ───
  function updateTabbar() {
    $$('.tabbar [data-tab]').forEach(b => b.classList.toggle('active', b.dataset.tab === state.tab));
    const st = notifState();
    $('.me-label').classList.toggle('tab-dot', st === 'off' || st === 'needs-install');
  }

  function render() {
    const authed = !!state.token;
    $('#welcome').hidden = authed;
    $('#app').hidden = !authed;
    if (!authed) return;
    // Don't yank the keyboard away while someone is typing a search.
    if (state.tab === 'home' && document.activeElement && document.activeElement.id === 'searchInput') renderHomeList();
    else ({ home: renderHome, calendar: renderCalendar, shared: renderShared, me: renderMe })[state.tab]();
    updateTabbar();
    updateBadge();
  }

  function switchTab(tab) {
    if (state.tab === tab) { window.scrollTo({ top: 0, behavior: 'smooth' }); return; }
    state.tab = tab;
    window.scrollTo(0, 0);
    render();
  }

  const actions = {
    'auth-mode': el => setAuthMode(el.dataset.mode),
    new: el => openForm(null, { kind: el.dataset.kind, date: el.dataset.date }),
    open: el => openDetail(el.dataset.id),
    'open-share': el => openDetail(el.dataset.id, { focusShare: true }),
    toggle: el => toggleDone(Number(el.dataset.id), el),
    undo: el => undoDone(Number(el.dataset.id)),
    star: el => toggleStar(Number(el.dataset.id)),
    edit: el => openForm(byId(el.dataset.id)),
    delete: el => deleteReminder(Number(el.dataset.id)),
    snooze: el => snoozeReminder(Number(el.dataset.id), Number(el.dataset.minutes)),
    share: el => shareReminder(Number(el.dataset.id)),
    unshare: el => unshare(Number(el.dataset.id), Number(el.dataset.user)),
    'cancel-invite': el => cancelInvite(Number(el.dataset.id), el.dataset.email),
    'send-invite': el => sendInviteMessage(Number(el.dataset.id), el.dataset.email),
    'send-ics': el => sendCalendarInvite(Number(el.dataset.id)),
    'share-pick': () => openSharePicker(),
    'close-sheet': () => closeSheet(),
    'save-form': () => saveForm(),
    'form-add-share': () => addFormShare(),
    'remove-form-share': el => { state.form.f.share.splice(Number(el.dataset.i), 1); updateForm(); },
    'toggle-search': () => {
      state.searchOpen = !state.searchOpen;
      if (!state.searchOpen) state.search = '';
      render();
      if (state.searchOpen) $('#searchInput').focus();
    },
    'toggle-done': () => { state.showDone = !state.showDone; renderHomeList(); },
    'enable-push': () => enableNotifications(),
    'disable-push': () => disableNotifications(),
    'test-push': () => testPush(),
    'install-guide': () => openInstallGuide(),
    'install-app': () => promptInstall(),
    'dismiss-banner': () => { local.set('tf_banner_hidden_until', Date.now() + 3 * 86400000); render(); },
    assistant: () => openAssistant(),
    'ai-prompt': el => { $('#aiInput').value = el.dataset.text; runAssistant(); },
    'ai-run': () => runAssistant(),
    'ai-add': () => addAssistantSteps(),
    'cal-move': el => {
      const d = new Date(state.cal.y, state.cal.m + Number(el.dataset.dir), 1);
      state.cal.y = d.getFullYear();
      state.cal.m = d.getMonth();
      render();
    },
    'cal-today': () => { const d = new Date(); state.cal = { y: d.getFullYear(), m: d.getMonth(), sel: todayYMD() }; render(); },
    'cal-select': el => { state.cal.sel = el.dataset.date; render(); },
    theme: el => { local.set('tf_theme', el.dataset.theme); applyTheme(); render(); },
    logout: () => { if (confirm('Log out of TaskFlow on this device?')) signOut(); },
  };

  document.addEventListener('click', e => {
    const tab = e.target.closest('[data-tab]');
    if (tab) return switchTab(tab.dataset.tab);
    const el = e.target.closest('[data-action]');
    if (!el || !actions[el.dataset.action]) return;
    e.preventDefault();
    actions[el.dataset.action](el, e);
  });

  document.addEventListener('keydown', e => {
    if (e.key === 'Escape' && state.sheet) return closeSheet();
    if ((e.key === 'Enter' || e.key === ' ') && e.target.matches('[role="button"][data-action]')) {
      e.preventDefault();
      actions[e.target.dataset.action](e.target, e);
    }
    if (e.key === 'Enter' && e.target.id === 'shareEmail') {
      e.preventDefault();
      const btn = $('[data-action="share"]');
      if (btn) shareReminder(Number(btn.dataset.id));
    }
  });

  document.addEventListener('input', e => {
    if (e.target.id === 'searchInput') { state.search = e.target.value; renderHomeList(); }
  });

  document.addEventListener('change', async e => {
    if (e.target.id === 'emailToggle') {
      try {
        const d = await api('/me', { method: 'PATCH', body: { email_reminders: e.target.checked } });
        state.user = d.user;
        local.set('tf_user', d.user);
        toast(e.target.checked ? 'You’ll get emails too' : 'Email reminders off', 'success');
      } catch (err) { toast(err.message, 'error'); }
    }
  });

  window.addEventListener('popstate', () => { if (state.sheet) closeSheet(true); });

  // ─── Welcome background ───
  function spawnFloatingWords() {
    const box = $('#floatingWords');
    if (!box || matchMedia('(prefers-reduced-motion: reduce)').matches) return;
    const words = ['organize', 'focus', 'goals', 'progress', 'clarity', 'balance', 'routine', 'done ✓', 'breathe', 'today', 'step by step', 'you got this', 'calm', 'forward'];
    for (let i = 0; i < 12; i++) {
      const el = document.createElement('div');
      el.className = 'float-word';
      el.textContent = words[Math.floor(Math.random() * words.length)];
      el.style.fontSize = 14 + Math.random() * 26 + 'px';
      el.style.top = Math.random() * 94 + 'vh';
      el.style.setProperty('--rot', (Math.random() - 0.5) * 18 + 'deg');
      el.style.setProperty('--drift', (Math.random() - 0.5) * 70 + 'px');
      el.style.animationDuration = 20000 + Math.random() * 20000 + 'ms';
      el.style.animationDelay = -Math.random() * 30000 + 'ms';
      box.appendChild(el);
    }
  }

  // ─── Start ───
  function init() {
    applyTheme();
    const mq = matchMedia('(prefers-color-scheme: dark)');
    if (mq.addEventListener) mq.addEventListener('change', applyTheme);

    if ('serviceWorker' in navigator) {
      navigator.serviceWorker.register('/sw.js').catch(err => console.warn('Service worker failed:', err));
      navigator.serviceWorker.addEventListener('message', e => {
        if (!e.data) return;
        if (e.data.type === 'refresh') refresh();
        if (e.data.type === 'open') handleUrl(e.data.url || '/');
      });
    }
    window.addEventListener('beforeinstallprompt', e => { e.preventDefault(); state.installPrompt = e; if (state.tab === 'me') render(); });
    document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') refresh(); });
    setInterval(() => { if (document.visibilityState === 'visible') refresh(); }, 60000);
    api('/config').then(c => { state.config = c; if (state.tab === 'me') render(); }).catch(() => {});

    $('#authForm').addEventListener('submit', submitAuth);
    spawnFloatingWords();
    setAuthMode(local.get('tf_known', false) ? 'login' : 'signup');
    render();
    if (state.token) afterLogin(false);
  }

  init();
})();
