'use strict';
// TaskFlow app, part 1 of 4: shared helpers, state, API, theme, language and notifications.
// The app files are plain scripts that share one scope: core → views → sheets → main.

const S = window.Schedule;
const t = (key, vars) => window.I18n.t(key, vars);
const lang = () => window.I18n.lang;
const $ = (sel, el = document) => el.querySelector(sel);
const $$ = (sel, el = document) => [...el.querySelectorAll(sel)];
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const pad = n => String(n).padStart(2, '0');
const wait = ms => new Promise(r => setTimeout(r, ms));
const capitalize = s => (s ? s[0].toUpperCase() + s.slice(1) : s);

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

const ymdOf = d => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const todayYMD = () => ymdOf(new Date());
const sqlToDate = s => (s ? new Date(s.replace(' ', 'T') + 'Z') : null); // SQLite datetime('now') is UTC
function localInstant(date, time) {
  const [y, m, d] = date.split('-').map(Number);
  const [h, mi] = time.split(':').map(Number);
  return new Date(y, m - 1, d, h, mi).getTime();
}
const firstName = name => String(name || '').trim().split(/\s+/)[0] || '';
function joinList(list) {
  const and = lang() === 'es' ? ' y ' : ' and ';
  return list.length <= 1 ? list.join('') : list.slice(0, -1).join(', ') + and + list[list.length - 1];
}
// "tomorrow" / "Wednesday" / "Oct 15" in English; "mañana" / "el miércoles" / "el 15 oct" in Spanish.
function whenWord(ymd, today) {
  const rel = S.relativeDay(ymd, today, lang());
  return lang() === 'es' ? rel : rel.replace(/^on /, '');
}

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
      headers: {
        'Content-Type': 'application/json',
        'X-Lang': lang(),
        ...(state.token ? { Authorization: 'Bearer ' + state.token } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    });
  } catch {
    throw new Error(navigator.onLine ? t('net.unreachable') : t('net.offline'));
  }
  const data = await res.json().catch(() => ({}));
  if (res.status === 401 && state.token && path !== '/login') {
    signOut(true);
    throw new Error(data.error || t('auth.loginAgain'));
  }
  if (!res.ok) throw new Error(data.error || t('net.generic'));
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

// ─── Theme: light/dark and the color (peach or matcha) ───
function applyTheme() {
  const mode = local.get('tf_theme', 'auto');
  const color = local.get('tf_color', 'matcha');
  const html = document.documentElement;
  if (mode === 'auto') delete html.dataset.theme; else html.dataset.theme = mode;
  html.dataset.color = color;
  const bg = getComputedStyle(html).getPropertyValue('--bg').trim();
  $('meta[name="theme-color"]').setAttribute('content', bg || '#fff7ef');
  // Home Screen icon and app logo follow the color (used when the app is added to the phone).
  const suffix = color === 'matcha' ? '-matcha' : '';
  $('link[rel="apple-touch-icon"]').setAttribute('href', `/icons/apple-touch-icon${suffix}.png`);
  $('link[rel="icon"]').setAttribute('href', `/icons/favicon-32${suffix}.png`);
  $('link[rel="manifest"]').setAttribute('href', color === 'matcha' ? '/manifest-matcha.webmanifest' : '/manifest.webmanifest');
  $$('.app-mark').forEach(img => { img.src = `/icons/icon-192${suffix}.png`; });
}

// ─── Language ───
function setLanguage(next) {
  if (next === lang()) return;
  window.I18n.set(next);
  window.I18n.apply();
  setAuthMode(state.authMode);
  spawnFloatingWords();
  if (state.token) {
    api('/me', { method: 'PATCH', body: { language: lang() } })
      .then(d => { state.user = d.user; local.set('tf_user', d.user); })
      .catch(() => {});
  }
  if (state.sheet && state.sheet.type === 'detail') renderDetail(byId(state.sheet.id));
  else if (state.sheet) closeSheet();
  render();
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
  if (st === 'unsupported') return toast(t('push.unsupported'), 'error');
  try {
    const perm = await Notification.requestPermission();
    if (perm !== 'granted') {
      render();
      return toast(perm === 'denied' ? t('push.blocked') : t('push.stillOff'), 'error');
    }
    await subscribePush();
    if (state.sheet && state.sheet.type === 'onboard') closeSheet();
    toast(t('push.on'), 'success');
  } catch (e) {
    toast(t('push.failed', { msg: e.message }), 'error');
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
    toast(t('push.off'));
  }
}

async function testPush() {
  try {
    const { devices } = await api('/push/test', { method: 'POST' });
    toast(devices ? t('push.testSent') : t('push.noDevices'), devices ? 'success' : 'error');
  } catch (e) { toast(e.message, 'error'); }
}

function updateBadge() {
  if (!('setAppBadge' in navigator)) return;
  const today = todayYMD();
  const n = state.reminders.filter(r => ['overdue', 'today'].includes(S.status(r, today))).length;
  (n ? navigator.setAppBadge(n) : navigator.clearAppBadge()).catch(() => {});
}
