'use strict';
// TaskFlow app, part 4 of 4: actions, sign-in, navigation and startup.

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
        ? t(r.kind === 'bill' ? 'toast.paidFor' : 'toast.doneFor', {
            date: S.formatDate(occ, false, lang()),
            next: S.formatDate(S.currentOccurrence(data.reminder, today), false, lang()),
          })
        : t('toast.niceWork');
      toast(msg, 'success', { label: t('toast.undo'), run: () => undoDone(id) });
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
  const question = !r.is_owner ? t('confirm.removeShared', { title: r.title, owner: firstName(r.owner.name) })
    : r.shared_with.length ? t('confirm.deleteShared', { title: r.title }) : t('confirm.delete', { title: r.title });
  if (!confirm(question)) return;
  try {
    await api(`/reminders/${id}`, { method: 'DELETE' });
    state.reminders = state.reminders.filter(x => x.id !== id);
    saveCache();
    closeSheet();
    render();
    toast(t(r.is_owner ? 'toast.deleted' : 'toast.removed'));
  } catch (e) { toast(e.message, 'error'); }
}

async function snoozeReminder(id, minutes) {
  try {
    await api(`/reminders/${id}/snooze`, { method: 'POST', body: { minutes } });
    const when = minutes >= 600 ? t('snooze.tomorrow') : minutes >= 120 ? t('snooze.hours', { n: Math.round(minutes / 60) }) : t('snooze.hour');
    toast(t('snooze.ok', { when }), 'success');
    if (notifState() !== 'on') setTimeout(() => toast(t('snooze.needPush')), 1500);
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
    if (data.status === 'shared') toast(t('share.done', { name: data.name }), 'success');
    else toast(t('share.notYet', { email: data.email }), '', { label: t('toast.sendInvite'), run: () => sendInviteMessage(id, data.email) });
  } catch (e) { toast(e.message, 'error'); }
}

async function unshare(id, userId) {
  const r = byId(id);
  const leaving = state.user && userId === state.user.id;
  if (leaving && !confirm(t('confirm.leave', { title: r.title }))) return;
  try {
    const data = await api(`/reminders/${id}/share/${userId}`, { method: 'DELETE' });
    if (leaving) {
      state.reminders = state.reminders.filter(x => x.id !== id);
      saveCache();
      closeSheet();
      toast(t('toast.left'));
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
  try { await navigator.clipboard.writeText(full); toast(t('toast.copied'), 'success'); } catch { window.prompt(t('prompt.copy'), full); }
}

function sendInviteMessage(id, email) {
  const r = byId(id);
  shareOrCopy({ title: 'TaskFlow', text: t('invite.message', { title: r ? r.title : t('invite.aReminder'), email }), url: location.origin });
}

function sendCalendarInvite(id) {
  const r = byId(id);
  shareOrCopy({ title: r.title, text: t('invite.calendar', { title: r.title }), url: location.origin + r.ics_url });
}

function openSharePicker() {
  const today = todayYMD();
  const mine = sortItems(state.reminders.filter(r => r.is_owner && !r.done).map(r => annotate(r, today)));
  if (!mine.length) return openForm(null);
  openSheet(`${sheetHead(t('shared.pick'))}<div class="sheet-body"><div class="list">
    ${mine.map(x => rowHTML(x, today, { check: false }).replace('data-action="open"', 'data-action="open-share"')).join('')}</div></div>`, { type: 'pick' });
}

// ─── Sign in ───
function setAuthMode(mode) {
  state.authMode = mode;
  $$('.auth-tabs button').forEach(b => { b.classList.toggle('active', b.dataset.mode === mode); b.setAttribute('aria-selected', b.dataset.mode === mode); });
  $('#nameField').hidden = mode === 'login';
  $('#authSubmit').textContent = t(mode === 'login' ? 'auth.logIn' : 'auth.createAccount');
  $('#authPassword').setAttribute('autocomplete', mode === 'login' ? 'current-password' : 'new-password');
  $('#authPassword').placeholder = t(mode === 'login' ? 'auth.passwordCurrent' : 'auth.passwordNew');
  $('#authMsg').hidden = true;
  $$('[data-action="lang"]', $('#welcome')).forEach(b => b.classList.toggle('active', b.dataset.lang === lang()));
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
    language: lang(),
  };
  const signup = state.authMode === 'signup';
  if (!body.email || !body.password || (signup && !body.name)) {
    msg.className = 'form-msg error';
    msg.textContent = t('auth.fillAll');
    msg.hidden = false;
    return;
  }
  btn.disabled = true;
  btn.textContent = t(signup ? 'auth.creating' : 'auth.loggingIn');
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
    toast(t(signup ? 'auth.welcomeNew' : 'auth.welcomeBack', { name: firstName(data.user.name) }), 'success');
  } catch (err) {
    msg.className = 'form-msg error';
    msg.textContent = err.message;
    msg.hidden = false;
  } finally {
    btn.disabled = false;
    btn.textContent = t(state.authMode === 'login' ? 'auth.logIn' : 'auth.createAccount');
  }
}

async function afterLogin(isNewAccount) {
  state.loaded = state.reminders.length > 0;
  render();
  await refresh();
  // Keep the account's time zone and language in step with this phone (reminders use both).
  const changes = {};
  if (state.user && state.user.timezone !== TZ) changes.timezone = TZ;
  if (state.user && state.user.language !== lang()) changes.language = lang();
  if (Object.keys(changes).length) {
    api('/me', { method: 'PATCH', body: changes }).then(d => { state.user = d.user; local.set('tf_user', d.user); }).catch(() => {});
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
  if (expired) toast(t('auth.loginAgain'));
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
  lang: el => setLanguage(el.dataset.lang),
  color: el => { local.set('tf_color', el.dataset.color); applyTheme(); render(); },
  theme: el => { local.set('tf_theme', el.dataset.theme); applyTheme(); render(); },
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
  logout: () => { if (confirm(t('me.logoutConfirm'))) signOut(); },
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
      toast(t(e.target.checked ? 'me.emailOn' : 'me.emailOff'), 'success');
    } catch (err) { toast(err.message, 'error'); }
  }
});

window.addEventListener('popstate', () => { if (state.sheet) closeSheet(true); });

// ─── Welcome background ───
function spawnFloatingWords() {
  const box = $('#floatingWords');
  if (!box || matchMedia('(prefers-reduced-motion: reduce)').matches) return;
  box.innerHTML = '';
  const words = window.I18n.floatingWords();
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
  window.I18n.apply();
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
