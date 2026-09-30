'use strict';
// TaskFlow app, part 2 of 4: the Home, Calendar, Shared and Me screens.

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

// Short "when is it due" text for a row (already HTML-escaped).
function dueLabel(x, today) {
  const { r, st, occ } = x;
  if (st === 'done') {
    const d = sqlToDate(r.done_at);
    return esc(d ? t('due.doneWhen', { when: S.relativeDay(ymdOf(d), today, lang()) }) : t('due.done'));
  }
  if (!occ) return '';
  if (st === 'overdue') return `<span class="due-overdue">${esc(t('due.overdue', { date: S.formatDate(occ, false, lang()) }))}</span>`;
  if (st === 'today') {
    const at = r.alerts && r.alerts.length ? ` · ${S.formatTime(r.time, lang())}` : '';
    return `<span class="due-today">${esc((r.kind === 'bill' ? t('due.todayBill') : t('due.today')) + at)}</span>`;
  }
  return esc(t('due.when', { when: whenWord(occ, today) }));
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
  if (S.isRepeating(r)) bits.push('🔁 ' + esc(t(`repeat.${r.repeat}`)));
  if (r.nag_per_day && st !== 'done') bits.push(`🔔 ${esc(t('row.perDay', { n: r.nag_per_day }))}`);
  const people = peopleOf(r);
  const checkLabel = st === 'done' ? t('row.markNotDone') : t('row.markDone');
  const checkHtml = check
    ? `<button type="button" class="check ${st === 'done' ? 'checked' : ''}" data-action="toggle" data-id="${r.id}" aria-label="${esc(checkLabel)}">${ICON.check}</button>`
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
        ${r.starred ? `<span class="star" aria-label="${esc(t('row.starred'))}">★</span>` : ''}
      </div>
    </div>`;
}

function section(key, label, list, today) {
  return `<div class="section ${key}"><div class="section-head"><h2>${esc(label)}</h2><span class="count">${list.length}</span></div>
    <div class="list">${list.map(x => rowHTML(x, today)).join('')}</div></div>`;
}

function banner(icon, title, text, button, action, dismissible = true) {
  return `<div class="banner"><span class="b-icon">${icon}</span><div class="b-text"><strong>${esc(title)}</strong>${esc(text)}</div>
    ${button ? `<button type="button" class="btn btn-primary btn-sm" data-action="${action}">${esc(button)}</button>` : ''}
    ${dismissible ? `<button type="button" class="link-btn" data-action="dismiss-banner" aria-label="${esc(t('banner.hide'))}">${ICON.close.replace('<svg', '<svg width="18" height="18"')}</button>` : ''}</div>`;
}

function notificationBanner() {
  const st = notifState();
  if (st === 'on' || local.get('tf_banner_hidden_until', 0) > Date.now()) return '';
  if (st === 'needs-install') return banner('📲', t('banner.installTitle'), t('banner.installText'), t('banner.showMe'), 'install-guide');
  if (st === 'off') return banner('🔔', t('banner.offTitle'), t('banner.offText'), t('banner.turnOn'), 'enable-push');
  if (st === 'denied') return banner('🔕', t('banner.deniedTitle'), isIOS ? t('banner.deniedIos') : t('banner.deniedOther'));
  return banner('ℹ️', t('banner.unsupportedTitle'), isIOS ? t('banner.unsupportedIos') : t('banner.unsupportedOther'));
}

function topbar(html) { $('#topbar').innerHTML = html; }
function view(html) { $('#view').innerHTML = html; }

// ─── Home ───
function renderHome() {
  const hour = new Date().getHours();
  const greet = t(hour < 12 ? 'home.morning' : hour < 18 ? 'home.afternoon' : 'home.evening');
  const dateLine = new Date().toLocaleDateString(window.I18n.locale, { weekday: 'short', month: 'short', day: 'numeric' });
  const hi = state.user ? t('home.hi', { name: firstName(state.user.name) }) : t('home.hiNoName');
  topbar(`
    <div class="tb-title"><div class="tb-sub">${esc(greet)} · ${esc(dateLine)}</div><h1>${esc(hi)}</h1></div>
    <button type="button" class="icon-btn" data-action="toggle-search" aria-label="${esc(t('home.search'))}">${ICON.search}</button>
    <button type="button" class="icon-btn" data-action="assistant" aria-label="${esc(t('home.assistant'))}">✦</button>`);

  let html = '';
  if (state.searchOpen) {
    html += `<div class="search">${ICON.search}<input class="input" id="searchInput" type="search" placeholder="${esc(t('home.searchPlaceholder'))}" value="${esc(state.search)}" autocomplete="off"></div>`;
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
  const day = S.toDay(today);
  const all = state.reminders.map(r => annotate(r, today));
  const q = state.search.trim().toLowerCase();
  const items = q ? all.filter(x => `${x.r.title} ${x.r.notes} ${x.r.amount}`.toLowerCase().includes(q)) : all;

  if (!state.loaded && !all.length) { box.innerHTML = `<div class="spinner" aria-label="${esc(t('home.loading'))}"></div>`; return; }
  if (!all.length) {
    box.innerHTML = `<div class="empty"><div class="e-icon">🌤️</div><h3>${esc(t('home.emptyTitle'))}</h3>
      <p>${esc(t('home.emptyText'))}</p>
      <div class="quick"><button type="button" class="btn btn-primary" data-action="new" data-kind="bill">${esc(t('home.addBill'))}</button>
      <button type="button" class="btn btn-outline" data-action="new" data-kind="task">${esc(t('home.addTodo'))}</button></div></div>`;
    return;
  }
  const groups = [
    ['overdue', t('sec.overdue'), items.filter(x => x.st === 'overdue')],
    ['today', t('sec.today'), items.filter(x => x.st === 'today')],
    ['soon', t('sec.soon'), items.filter(x => x.st === 'upcoming' && S.toDay(x.occ) - day <= 7)],
    ['later', t('sec.later'), items.filter(x => x.st === 'upcoming' && S.toDay(x.occ) - day > 7)],
    ['nodate', t('sec.nodate'), items.filter(x => x.st === 'nodate')],
  ];
  const done = items.filter(x => x.st === 'done').sort((a, b) => String(b.r.done_at).localeCompare(String(a.r.done_at)));
  let html = groups.filter(g => g[2].length).map(([key, label, list]) => section(key, label, sortItems(list), today)).join('');
  if (q && !items.length) html += `<div class="empty"><p>${esc(t('home.noMatches', { q: state.search }))}</p></div>`;
  if (done.length) {
    html += `<div class="section"><div class="section-head"><h2>${esc(t('sec.completed'))}</h2>
      <button type="button" class="link-btn" data-action="toggle-done">${esc(state.showDone ? t('sec.hide') : t('sec.show', { n: done.length }))}</button></div>
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
  const quotes = window.I18n.quotes();
  const quote = quotes[new Date().getDate() % quotes.length];
  const title = total === 0 ? t('progress.none') : due === 0 ? t('progress.allDone') : t('progress.count', { done: doneToday, total });
  return `<div class="card progress-card">
    <svg class="ring" viewBox="0 0 64 64" aria-hidden="true">
      <circle class="ring-bg" cx="32" cy="32" r="26"/>
      <circle class="ring-fg" cx="32" cy="32" r="26" transform="rotate(-90 32 32)" stroke-dasharray="${C.toFixed(1)}" stroke-dashoffset="${(C * (1 - pct / 100)).toFixed(1)}"/>
      <text x="32" y="37" text-anchor="middle">${total ? pct + '%' : '☀︎'}</text>
    </svg>
    <div class="pc-text"><div class="pc-title">${esc(title)}</div><div class="quote">“${esc(quote.text)}” — ${esc(quote.author)}</div></div>
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

  topbar(`<div class="tb-title"><h1>${esc(t('cal.title'))}</h1></div><button type="button" class="btn btn-sm btn-outline" data-action="cal-today">${esc(t('cal.today'))}</button>`);
  let grid = t('cal.weekdays').split(',').map(d => `<div class="cal-head" aria-hidden="true">${esc(d)}</div>`).join('');
  for (let i = 0; i < new Date(y, m, 1).getDay(); i++) grid += '<div class="cal-day other"></div>';
  for (let d = 1; d <= days; d++) {
    const ymd = `${y}-${pad(m + 1)}-${pad(d)}`;
    const list = byDate[ymd] || [];
    const dots = list.slice(0, 3).map(r => `<i class="k-${esc(r.kind)} ${occDone(r, ymd) ? 'done' : ''}"></i>`).join('');
    const label = S.formatDate(ymd, true, lang()) + (list.length ? `, ${t('cal.dueCount', { n: list.length })}` : '');
    grid += `<button type="button" class="cal-day ${ymd === today ? 'today' : ''} ${ymd === sel ? 'selected' : ''}" data-action="cal-select" data-date="${ymd}"
      aria-label="${esc(label)}"><span class="num">${d}</span><span class="cal-dots">${dots}</span></button>`;
  }
  const monthName = capitalize(new Date(y, m, 1).toLocaleDateString(window.I18n.locale, { month: 'long', year: 'numeric' }));
  const selItems = state.reminders.filter(r => S.occurrencesBetween(r, sel, sel).length).map(r => {
    const st = occDone(r, sel) ? 'done' : sel < today ? 'overdue' : sel === today ? 'today' : 'upcoming';
    return { r, st, occ: sel, current: S.currentOccurrence(r, today) === sel };
  });
  const selTitle = sel === today ? t('cal.today') : S.formatDate(sel, true, lang());
  view(`
    <div class="card">
      <div class="cal-nav">
        <button type="button" class="icon-btn" data-action="cal-move" data-dir="-1" aria-label="${esc(t('cal.prev'))}">${ICON.chevL}</button>
        <h2>${esc(monthName)}</h2>
        <button type="button" class="icon-btn" data-action="cal-move" data-dir="1" aria-label="${esc(t('cal.next'))}">${ICON.chevR}</button>
      </div>
      <div class="cal-grid">${grid}</div>
    </div>
    <div class="section"><div class="section-head"><h2>${esc(selTitle)}</h2>
      <button type="button" class="link-btn" data-action="new" data-date="${sel}">${esc(t('cal.add'))}</button></div>
      ${selItems.length
        ? `<div class="list">${selItems.map(x => rowHTML(x, today, { check: x.current && x.st !== 'done' })).join('')}</div>`
        : `<div class="card"><p>${esc(t('cal.nothing'))}</p></div>`}
    </div>`);
}

// ─── Shared ───
function renderShared() {
  topbar(`<div class="tb-title"><h1>${esc(t('shared.title'))}</h1><div class="tb-sub">${esc(t('shared.sub'))}</div></div>`);
  const today = todayYMD();
  const withMe = state.reminders.filter(r => !r.is_owner).map(r => annotate(r, today));
  const byMe = state.reminders.filter(r => r.is_owner && (r.shared_with.length || r.invites.length)).map(r => annotate(r, today));
  let html = `<div class="card"><h3>${esc(t('shared.cardTitle'))}</h3>
    <p>${esc(t('shared.cardText'))}</p>
    <button type="button" class="btn btn-primary btn-sm mt" data-action="share-pick">${esc(t('shared.cta'))}</button></div>`;
  if (withMe.length) html += section('with-me', t('shared.withMe'), sortItems(withMe), today);
  if (byMe.length) html += section('by-me', t('shared.byMe'), sortItems(byMe), today);
  if (!withMe.length && !byMe.length) {
    html += `<div class="empty"><div class="e-icon">💌</div><h3>${esc(t('shared.emptyTitle'))}</h3><p>${t('shared.emptyText')}</p></div>`;
  }
  view(html);
}

// ─── Me ───
function seg(options, current, action, attr) {
  return `<div class="seg">${options.map(([value, label]) =>
    `<button type="button" class="${current === value ? 'active' : ''}" data-action="${action}" data-${attr}="${value}">${esc(label)}</button>`).join('')}</div>`;
}

function renderMe() {
  topbar(`<div class="tb-title"><h1>${esc(t('me.title'))}</h1></div>`);
  const u = state.user || {};
  const st = notifState();
  const notifBody = {
    on: `<p>${esc(t('me.notifOn'))}</p>
      <div class="snooze-row mt"><button type="button" class="btn btn-primary btn-sm" data-action="test-push">${esc(t('me.sendTest'))}</button>
      <button type="button" class="btn btn-ghost btn-sm" data-action="disable-push">${esc(t('me.turnOff'))}</button></div>`,
    off: `<p>${esc(t('me.notifOffText'))}</p>
      <button type="button" class="btn btn-primary btn-block mt" data-action="enable-push">${esc(t('me.turnOnBtn'))}</button>`,
    'needs-install': `<p>${esc(t('me.needsInstall'))}</p>
      <button type="button" class="btn btn-primary btn-block mt" data-action="install-guide">${esc(t('me.showHow'))}</button>`,
    denied: `<p>${isIOS ? t('me.deniedIos') : esc(t('me.deniedOther'))}</p>`,
    unsupported: `<p>${t('me.unsupported')}</p>`,
  }[st];

  let installCard = '';
  if (!isStandalone()) {
    installCard = `<div class="card"><h3>${esc(t('me.installTitle'))}</h3>
      <p>${esc(isIOS || isAndroid ? t('me.installMobile') : t('me.installDesktop'))}</p>
      <button type="button" class="btn btn-outline btn-block mt" data-action="${state.installPrompt ? 'install-app' : 'install-guide'}">${esc(state.installPrompt ? t('me.installApp') : t('me.showMeHow'))}</button></div>`;
  }

  const emailRow = state.config && state.config.emailEnabled
    ? `<label class="switch-row"><span><span class="sr-text">${esc(t('me.emailTitle'))}</span><br><span class="sr-sub">${esc(t('me.emailSub'))}</span></span>
        <span class="switch"><input type="checkbox" id="emailToggle" aria-label="${esc(t('me.emailTitle'))}" ${u.email_reminders ? 'checked' : ''}><span></span></span></label>`
    : '';

  view(`
    <div class="card" style="display:flex;gap:14px;align-items:center">${avatar(u, 'lg')}
      <div style="min-width:0"><div style="font-weight:700;font-size:18px">${esc(u.name)}</div><div class="muted" style="font-size:14px;overflow:hidden;text-overflow:ellipsis">${esc(u.email)}</div></div></div>
    <div class="card"><h3>${esc(t('me.notifTitle'))}</h3>${notifBody}</div>
    ${installCard}
    <div class="card"><h3>${esc(t('me.settings'))}</h3>
      <div class="field mt"><span class="label">${esc(t('me.language'))}</span>
        ${seg([['en', 'English'], ['es', 'Español']], lang(), 'lang', 'lang')}</div>
      <div class="field"><span class="label">${esc(t('me.color'))}</span>
        ${seg([['peach', t('me.peach')], ['matcha', t('me.matcha')]], local.get('tf_color', 'matcha'), 'color', 'color')}</div>
      <div class="field"><span class="label">${esc(t('me.appearance'))}</span>
        ${seg([['auto', t('me.auto')], ['light', t('me.light')], ['dark', t('me.dark')]], local.get('tf_theme', 'auto'), 'theme', 'theme')}</div>
      ${emailRow}
      <p class="hint">${esc(t('me.timezone', { tz: TZ }))}</p>
    </div>
    <div class="card"><h3>${esc(t('me.assistantTitle'))}</h3><p>${esc(t('me.assistantText'))}</p>
      <button type="button" class="btn btn-outline btn-block mt" data-action="assistant">${esc(t('me.openAssistant'))}</button></div>
    <button type="button" class="btn btn-danger btn-block" data-action="logout">${esc(t('me.logout'))}</button>
    <p class="center muted mt" style="font-size:13px">${esc(t('footer.credit'))}</p>`);
}
