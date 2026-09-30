'use strict';
// TaskFlow app, part 3 of 4: pop-up sheets (details, new/edit form, install guide, assistant).

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
  return `<div class="sheet-head"><h2>${esc(title)}</h2>${extra}
    <button type="button" class="icon-btn" data-action="close-sheet" aria-label="${esc(t('sheet.close'))}">${ICON.close}</button></div>`;
}

// ─── Detail ───
function fireWhen(f, today) {
  const diff = S.toDay(f.date) - S.toDay(today);
  const day = diff === 0 ? t('fire.today') : diff === 1 ? t('fire.tomorrow') : S.formatDate(f.date, true, lang());
  return `${day} · ${S.formatTime(f.time, lang())}`;
}
function fireLabel(f) {
  return f.type === 'nag' ? t('fire.nudge', { n: f.n, of: f.of }) : S.alertLabel(f.offset, lang());
}
function nameOf(r, userId) {
  if (state.user && userId === state.user.id) return lang() === 'es' ? 'ti' : 'you';
  const p = [r.owner, ...r.shared_with].find(x => x && x.id === userId);
  return p ? firstName(p.name) : '';
}

function openDetail(id, opts = {}) {
  const r = byId(id);
  if (!r) return toast(t('detail.gone'), 'error');
  renderDetail(r);
  if (opts.focusShare) setTimeout(() => { const el = $('#shareEmail'); if (el) { el.scrollIntoView({ block: 'center' }); el.focus(); } }, 350);
}

function renderDetail(r) {
  if (!r) return closeSheet();
  const L = lang();
  const today = todayYMD();
  const x = annotate(r, today);
  const kind = S.KINDS[r.kind] || S.KINDS.task;
  const repeating = S.isRepeating(r);
  const me = state.user ? state.user.id : null;

  let main, sub;
  if (x.st === 'done') {
    const d = sqlToDate(r.done_at);
    const by = r.done_by ? nameOf(r, r.done_by) : '';
    main = t('detail.done');
    sub = d ? t('detail.checkedOff', { when: S.relativeDay(ymdOf(d), today, L) }) + (by ? t('detail.by', { name: by }) : '') : '';
  } else if (!x.occ) {
    main = t('detail.noDate');
    sub = r.nag_per_day ? t('detail.untilDone') : t('detail.inTodos');
  } else {
    main = x.st === 'overdue' ? t('detail.overdueSince', { date: S.formatDate(x.occ, true, L) }) : t('detail.due', { when: S.relativeDay(x.occ, today, L) });
    sub = [S.formatDate(x.occ, true, L) + (r.alerts.length ? ` ${S.atTime(r.time, L)}` : ''), repeating ? S.repeatSummary(r, L) : ''].filter(Boolean).join(' · ');
  }
  if (r.amount) main += ` · ${r.amount}`;

  const doneLabel = x.st === 'done' ? t('detail.markNotDone')
    : repeating ? t(r.kind === 'bill' ? 'detail.markPaid' : 'detail.markDoneOcc', { date: S.formatDate(x.occ, false, L) })
    : t('detail.markDone');
  const lastDone = repeating && r.completed_through
    ? `<p class="hint center">${esc(t('detail.lastDone', { date: S.formatDate(r.completed_through, false, L) }) + (r.done_by ? t('detail.by', { name: nameOf(r, r.done_by) }) : ''))} ·
       <button type="button" class="link-btn" data-action="undo" data-id="${r.id}">${esc(t('detail.undo'))}</button></p>` : '';

  const next = S.upcoming(r, Date.now(), today, 5, localInstant);
  const nextHtml = next.length
    ? `<ul class="next-list">${next.map(f => `<li><span>${esc(fireWhen(f, today))}</span><span>${esc(fireLabel(f))}</span></li>`).join('')}</ul>`
    : `<p class="muted" style="font-size:14px">${esc(t('detail.noneScheduled'))}</p>`;

  const people = [{ ...r.owner, owner: true }, ...r.shared_with];
  const peopleHtml = people.map(p => {
    const isMe = p.id === me;
    let btn = '';
    if (!p.owner && r.is_owner) btn = `<button type="button" class="btn btn-ghost btn-sm" data-action="unshare" data-id="${r.id}" data-user="${p.id}">${esc(t('detail.remove'))}</button>`;
    else if (isMe && !r.is_owner) btn = `<button type="button" class="btn btn-ghost btn-sm" data-action="unshare" data-id="${r.id}" data-user="${p.id}">${esc(t('detail.leave'))}</button>`;
    return `<div class="person">${avatar(p, 'md')}<div class="p-text"><div class="p-name">${esc(p.name)}${isMe ? esc(t('detail.you')) : ''}</div>
      <div class="p-sub">${p.owner ? esc(t('detail.owner')) : ''}${esc(p.email)}</div></div>${btn}</div>`;
  }).join('') + r.invites.map(email => `<div class="person"><span class="avatar md" style="background:#b9a393">✉</span>
      <div class="p-text"><div class="p-name">${esc(email)}</div><div class="p-sub">${esc(t('detail.invited'))}</div></div>
      <button type="button" class="btn btn-ghost btn-sm" data-action="send-invite" data-id="${r.id}" data-email="${esc(email)}">${esc(t('detail.remind'))}</button>
      <button type="button" class="link-btn" data-action="cancel-invite" data-id="${r.id}" data-email="${esc(email)}" aria-label="${esc(t('detail.cancelInvite'))}">✕</button></div>`).join('');

  const tomorrow9 = new Date(); tomorrow9.setDate(tomorrow9.getDate() + 1); tomorrow9.setHours(9, 0, 0, 0);
  const minsToTomorrow = Math.round((tomorrow9 - Date.now()) / 60000);

  const badges = [
    `<span class="badge badge-kind">${kind.icon} ${esc(S.kindLabel(r.kind, L))}</span>`,
    `<span class="badge badge-${String(r.priority).toLowerCase()}">${esc(t('detail.priority', { p: t(`priority.${r.priority}`) }))}</span>`,
    !r.is_owner ? `<span class="badge badge-shared">${esc(t('detail.sharedBy', { name: firstName(r.owner.name) }))}</span>` : '',
    x.st === 'overdue' ? `<span class="badge badge-overdue">${esc(t('detail.overdue'))}</span>` : '',
  ].join('');

  openSheet(`
    ${sheetHead('', `<button type="button" class="icon-btn" data-action="star" data-id="${r.id}" aria-label="${esc(t(r.starred ? 'detail.unstar' : 'detail.star'))}" style="color:var(--accent)">${r.starred ? '★' : '☆'}</button>
      <button type="button" class="btn btn-outline btn-sm" data-action="edit" data-id="${r.id}">${esc(t('detail.edit'))}</button>`)}
    <div class="sheet-body">
      <h2 class="detail-title">${esc(r.title)}</h2>
      <div class="detail-badges">${badges}</div>
      <div class="due-box"><div class="db-main">${esc(main)}</div>${sub ? `<div class="db-sub">${esc(sub)}</div>` : ''}</div>
      <button type="button" class="btn ${x.st === 'done' ? 'btn-outline' : 'btn-success'} btn-block" data-action="toggle" data-id="${r.id}">${esc(doneLabel)}</button>
      ${lastDone}
      ${x.st !== 'done' ? `<div class="field mt"><span class="label">${esc(t('detail.remindAgain'))}</span><div class="snooze-row">
        <button type="button" class="chip" data-action="snooze" data-id="${r.id}" data-minutes="60">${esc(t('detail.in1h'))}</button>
        <button type="button" class="chip" data-action="snooze" data-id="${r.id}" data-minutes="180">${esc(t('detail.in3h'))}</button>
        <button type="button" class="chip" data-action="snooze" data-id="${r.id}" data-minutes="${minsToTomorrow}">${esc(t('detail.tomorrow9'))}</button></div></div>` : ''}
      ${r.notes ? `<div class="card mt"><p style="white-space:pre-wrap;color:var(--text)">${esc(r.notes)}</p></div>` : ''}
      <div class="card mt">
        <div class="kv"><span class="kv-icon">🔔</span><div class="kv-text">${esc(S.alertSummary(r, L))}<small>${esc(t('detail.notifyEveryone'))}</small></div></div>
        <div class="kv"><span class="kv-icon">🗓️</span><div class="kv-text"><strong style="font-size:14px">${esc(t('detail.comingUp'))}</strong>${nextHtml}</div></div>
      </div>
      <div class="card">
        <h3>${esc(t('detail.people'))}</h3>
        ${peopleHtml}
        <div class="share-add"><input class="input" id="shareEmail" type="email" inputmode="email" autocapitalize="off" autocomplete="email" placeholder="${esc(t('detail.sharePlaceholder'))}" enterkeyhint="send">
          <button type="button" class="btn btn-primary" data-action="share" data-id="${r.id}">${esc(t('detail.share'))}</button></div>
        <p class="hint">${esc(t('detail.shareHint'))}</p>
      </div>
      <div class="actions-grid">
        ${r.start_date ? `<a class="btn btn-outline" href="${esc(r.ics_url)}" target="_blank" rel="noopener">${esc(t('detail.addCalendar'))}</a>
          <button type="button" class="btn btn-outline" data-action="send-ics" data-id="${r.id}">${esc(t('detail.sendInvite'))}</button>` : ''}
        <button type="button" class="btn btn-danger" data-action="delete" data-id="${r.id}" style="grid-column:1/-1">${esc(r.is_owner ? t('detail.delete') : t('detail.removeMine'))}</button>
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
  const L = lang();

  openSheet(`
    ${sheetHead(t(editing ? 'form.edit' : 'form.new'))}
    <div class="sheet-body">
      <form id="reminderForm" novalidate autocomplete="off">
        <div class="kinds" id="fKinds">${Object.keys(S.KINDS).map(k => `<button type="button" data-kind="${k}"><span class="k-icon">${S.KINDS[k].icon}</span>${esc(S.kindLabel(k, L))}</button>`).join('')}</div>
        <div class="field"><label for="fTitle" class="label">${esc(t('form.name'))}</label><input class="input input-title" id="fTitle" maxlength="200" value="${esc(f.title)}" enterkeyhint="done"></div>
        <div class="field" id="fAmountField"><label for="fAmount">${esc(t('form.amount'))}</label><input class="input" id="fAmount" inputmode="decimal" placeholder="$0.00" maxlength="30" value="${esc(f.amount)}"></div>
        <div class="row2">
          <div class="field"><label for="fDate" id="fDateLabel"></label><input class="input" type="date" id="fDate" value="${esc(f.start_date)}"></div>
          <div class="field"><label for="fTime">${esc(t('form.time'))}</label><input class="input" type="time" id="fTime" value="${esc(f.time)}"></div>
        </div>
        <p class="hint" id="fDateHint" style="margin-top:-8px;margin-bottom:14px"></p>
        <div class="field"><span class="label">${esc(t('form.repeat'))}</span><div class="seg" id="fRepeat">${S.REPEATS.map(v => `<button type="button" data-repeat="${v}">${esc(t(`repeat.${v}`))}</button>`).join('')}</div></div>
        <div class="field"><span class="label">${esc(t('form.remindMe'))}</span>
          <div class="chips" id="fAlerts">${S.ALERT_OPTIONS.slice().reverse().map(o => `<button type="button" class="chip" data-alert="${o.value}">${esc(S.alertLabel(o.value, L))}</button>`).join('')}</div>
          <p class="hint" id="fAlertHint"></p></div>
        <div class="card" style="padding:10px 14px">
          <label class="switch-row"><span><span class="sr-text">${esc(t('form.nagTitle'))}</span><br><span class="sr-sub">${esc(t('form.nagSub'))}</span></span>
            <span class="switch"><input type="checkbox" id="fNag" aria-label="${esc(t('form.nagTitle'))}"><span></span></span></label>
          <div id="fNagPanel" class="panel">
            <div class="nag-line"><span class="stepper"><button type="button" data-step="-1" aria-label="${esc(t('form.fewer'))}">−</button><output id="fNagCount"></output><button type="button" data-step="1" aria-label="${esc(t('form.more'))}">+</button></span> ${esc(t('form.timesADay'))}</div>
            <div class="row2 mt">
              <div class="field"><label for="fNagStart">${esc(t('form.from'))}</label><input class="input" type="time" id="fNagStart" value="${esc(f.nag_start)}"></div>
              <div class="field"><label for="fNagEnd">${esc(t('form.until'))}</label><input class="input" type="time" id="fNagEnd" value="${esc(f.nag_end)}"></div>
            </div>
            <p class="hint" id="fNagHint" style="margin-top:0"></p>
          </div>
        </div>
        <div class="field"><span class="label">${esc(t('form.priority'))}</span><div class="seg" id="fPriority">${['Low', 'Medium', 'High'].map(p => `<button type="button" data-priority="${p}">${{ Low: '🟢', Medium: '🟡', High: '🔴' }[p]} ${esc(t(`priority.${p}`))}</button>`).join('')}</div></div>
        <div class="field"><label for="fNotes">${esc(t('form.notes'))}</label><textarea class="input" id="fNotes" maxlength="2000" placeholder="${esc(t('form.notesPlaceholder'))}">${esc(f.notes)}</textarea></div>
        ${editing ? '' : `<div class="field"><label for="fShare">${esc(t('form.shareWith'))}</label>
          <div class="share-add"><input class="input" id="fShare" type="email" inputmode="email" autocapitalize="off" placeholder="${esc(t('form.sharePlaceholder'))}" enterkeyhint="done">
          <button type="button" class="btn btn-outline" data-action="form-add-share">${esc(t('form.add'))}</button></div>
          <div class="chips mt" id="fShareList"></div></div>`}
        <div class="card" id="fPreview"></div>
      </form>
    </div>
    <div class="sheet-foot"><button type="button" class="btn btn-primary btn-block" data-action="save-form" id="fSave">${esc(t(editing ? 'form.save' : 'form.create'))}</button></div>`,
    { type: 'form', id: editing ? r.id : null });

  bindForm();
  updateForm();
  if (!editing) setTimeout(() => { const el = $('#fTitle'); if (el && !el.value) el.focus(); }, 320);
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
    el.addEventListener('input', () => { f[key] = el.value; if (!['title', 'notes', 'amount'].includes(key)) updateForm(); });
    el.addEventListener('change', () => { f[key] = el.value; updateForm(); });
  }
  const share = $('#fShare');
  if (share) share.addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); addFormShare(); } });
  $('#fTitle').addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); e.target.blur(); } });
}

function formReminder() {
  const { f, editing } = state.form;
  const unchanged = editing && f.orig.start_date === f.start_date && f.orig.repeat === f.repeat;
  return {
    ...f,
    start_date: f.start_date || null,
    done: false,
    nag_from: f.nag_per_day ? (f.nag_from || todayYMD()) : null,
    completed_through: unchanged ? f.completed_through : null,
  };
}

function updateForm() {
  if (!state.form) return;
  const { f } = state.form;
  const L = lang();
  const today = todayYMD();
  const hasDate = !!f.start_date;
  const repeating = f.repeat !== 'none';

  $$('#fKinds [data-kind]').forEach(b => b.classList.toggle('active', b.dataset.kind === f.kind));
  $('#fTitle').placeholder = t(`form.placeholder.${f.kind}`);
  $('#fAmountField').hidden = f.kind !== 'bill' && !f.amount;
  $('#fDateLabel').textContent = t(f.kind === 'bill' ? (repeating ? 'form.dateNextDue' : 'form.dateDue') : repeating ? 'form.dateStarts' : 'form.dateOptional');

  const r = formReminder();
  if (repeating && hasDate) $('#fDateHint').textContent = `🔁 ${S.repeatSummary(r, L)}`;
  else if (!hasDate) $('#fDateHint').textContent = t(f.kind === 'bill' ? 'form.hintPickDue' : 'form.hintNoDate');
  else {
    $('#fDateHint').innerHTML = `<button type="button" class="link-btn" id="fClearDate">${esc(t('form.clearDate'))}</button>`;
    $('#fClearDate').onclick = () => { f.start_date = ''; $('#fDate').value = ''; updateForm(); };
  }

  $$('#fRepeat [data-repeat]').forEach(b => b.classList.toggle('active', b.dataset.repeat === f.repeat));
  $$('#fAlerts [data-alert]').forEach(b => {
    b.classList.toggle('active', hasDate && f.alerts.includes(Number(b.dataset.alert)));
    b.disabled = !hasDate;
  });
  $('#fAlertHint').textContent = hasDate ? t('form.alertHint', { time: capitalize(S.atTime(f.time || '09:00', L)) }) : t('form.alertNeedsDate');

  $('#fNag').checked = f.nag_per_day > 0;
  $('#fNagPanel').hidden = !f.nag_per_day;
  $('#fNagCount').textContent = f.nag_per_day;
  if (f.nag_per_day) {
    const nag = S.nagTimes(r);
    const times = nag.map(x => S.formatTime(x, L));
    const when = nag.length === 1 ? S.atTime(nag[0], L)
      : times.length > 4 ? t('form.nagBetween', { n: times.length, a: times[0], b: times[times.length - 1] })
      : t('form.nagAt', { list: joinList(times) });
    $('#fNagHint').textContent = t('form.nagHint', { when, period: t(repeating ? 'form.nagEachDue' : 'form.nagEveryDay') });
  }
  $$('#fPriority [data-priority]').forEach(b => b.classList.toggle('active', b.dataset.priority === f.priority));

  const shareList = $('#fShareList');
  if (shareList) {
    shareList.innerHTML = f.share.map((email, i) => `<span class="chip active">${esc(email)} <button type="button" class="link-btn" style="color:#fff;padding:0" data-action="remove-form-share" data-i="${i}" aria-label="${esc(t('form.removeShare'))}">✕</button></span>`).join('');
  }

  let next = [];
  try { next = S.upcoming(r, Date.now(), today, 4, localInstant); } catch { next = []; }
  $('#fPreview').innerHTML = `<h3 style="font-size:16px">${esc(t('form.previewTitle'))}</h3>` + (next.length
    ? `<ul class="next-list">${next.map(x => `<li><span>${esc(fireWhen(x, today))}</span><span>${esc(fireLabel(x))}</span></li>`).join('')}</ul>`
    : `<p>${esc(t('form.previewNone'))}</p>`);
}

function addFormShare() {
  const input = $('#fShare');
  const email = input.value.trim().toLowerCase();
  if (!email) return input.focus();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return toast(t('form.badEmail'), 'error');
  if (!state.form.f.share.includes(email)) state.form.f.share.push(email);
  input.value = '';
  updateForm();
}

async function saveForm() {
  const { f, editing } = state.form;
  f.title = $('#fTitle').value.trim();
  const pendingShare = $('#fShare') && $('#fShare').value.trim();
  if (pendingShare) addFormShare();
  if (!f.title) { $('#fTitle').focus(); return toast(t('form.needName'), 'error'); }
  if (f.repeat !== 'none' && !f.start_date) return toast(t('form.needRepeatDate'), 'error');
  if (f.kind === 'bill' && !f.start_date) { $('#fDate').focus(); return toast(t('form.needDueDate'), 'error'); }

  const body = {
    title: f.title, kind: f.kind, amount: f.amount, start_date: f.start_date || null, time: f.time || '09:00',
    repeat: f.repeat, alerts: f.start_date ? f.alerts : [], nag_per_day: f.nag_per_day, nag_start: f.nag_start,
    nag_end: f.nag_end, priority: f.priority, notes: f.notes, starred: f.starred,
  };
  if (!editing) body.share_with = f.share;
  const btn = $('#fSave');
  btn.disabled = true;
  btn.textContent = t('form.saving');
  try {
    const data = editing
      ? await api(`/reminders/${f.id}`, { method: 'PATCH', body })
      : await api('/reminders', { method: 'POST', body });
    upsert(data.reminder);
    render();
    if (editing) {
      renderDetail(data.reminder);
      toast(t('form.saved'), 'success');
    } else {
      closeSheet();
      const invited = (data.shares || []).filter(s => s.status === 'invited');
      const failed = (data.shares || []).filter(s => s.error);
      if (failed.length) toast(t('form.shareFailed', { email: failed[0].email, error: failed[0].error }), 'error');
      else if (invited.length) toast(t('form.addedInvited', { email: invited[0].email }), 'success', { label: t('toast.sendInvite'), run: () => sendInviteMessage(data.reminder.id, invited[0].email) });
      else toast(t('form.added'), 'success');
      if (!local.get('tf_onboarded', false)) { local.set('tf_onboarded', true); setTimeout(openNotifOnboarding, 900); }
    }
  } catch (e) {
    toast(e.message, 'error');
    if (btn.isConnected) { btn.disabled = false; btn.textContent = t(editing ? 'form.save' : 'form.create'); }
  }
}

// ─── Onboarding, install guide and assistant ───
function openNotifOnboarding() {
  const st = notifState();
  if (state.sheet || st === 'on' || st === 'denied' || st === 'unsupported') return;
  if (st === 'needs-install') return openInstallGuide();
  openSheet(`${sheetHead('')}
    <div class="sheet-body center">
      <div style="font-size:60px;line-height:1">🔔</div>
      <h2 style="margin:10px 0 8px">${esc(t('onboard.title'))}</h2>
      <p class="muted">${esc(t('onboard.text'))}</p>
      <button type="button" class="btn btn-primary btn-block mt" data-action="enable-push">${esc(t('onboard.turnOn'))}</button>
      <button type="button" class="btn btn-ghost btn-block" data-action="close-sheet">${esc(t('onboard.notNow'))}</button>
    </div>`, { type: 'onboard' });
}

function openInstallGuide() {
  let body;
  let qr = false;
  const glyph = icon => `<span class="ios-glyph">${icon}</span>`;
  if (isIOS) {
    const inApp = /FBAN|FBAV|Instagram|Line|GSA|CriOS|FxiOS|EdgiOS/i.test(navigator.userAgent);
    body = `<p class="muted">${esc(t('install.iosIntro'))}</p>
      <ol class="steps">
        <li><div>${t('install.iosSafari')}${inApp ? `<br><span class="muted">${esc(t('install.iosInApp'))}</span>` : ''}</div></li>
        <li><div>${t('install.iosShare', { icon: glyph(ICON.iosShare) })}</div></li>
        <li><div>${t('install.iosAdd', { icon: glyph(ICON.iosAdd) })}</div></li>
        <li><div>${t('install.iosOpen')}</div></li>
        <li><div>${t('install.iosEnable')}</div></li>
      </ol>`;
  } else if (state.installPrompt) {
    body = `<p>${esc(t('install.promptText'))}</p>
      <button type="button" class="btn btn-primary btn-block mt" data-action="install-app">${esc(t('install.promptBtn'))}</button>`;
  } else if (isAndroid) {
    body = `<ol class="steps">
        <li><div>${t('install.androidChrome')}</div></li>
        <li><div>${t('install.androidMenu')}</div></li>
        <li><div>${t('install.androidInstall')}</div></li>
        <li><div>${t('install.androidOpen')}</div></li>
      </ol>`;
  } else {
    const onlyThisComputer = /^(localhost|127\.|192\.168\.|10\.)/.test(location.hostname);
    qr = !onlyThisComputer;
    body = onlyThisComputer
      ? `<p>${esc(t('install.localOnly'))}</p><p class="muted mt">${t('install.localHint')}</p>`
      : `<p>${esc(t('install.scan'))}</p>
        <div id="qr" class="center mt" style="background:#fff;padding:14px;border-radius:16px;width:max-content;margin:14px auto"></div>
        <p class="center muted" style="word-break:break-all">${esc(location.origin)}</p>`;
  }
  openSheet(`${sheetHead(t('install.title'))}<div class="sheet-body">${body}</div>`, { type: 'install' });
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
  if (outcome === 'accepted') { closeSheet(); toast(t('install.installed'), 'success'); }
  render();
}

function openAssistant() {
  openSheet(`${sheetHead(t('ai.title'))}
    <div class="sheet-body">
      <p class="muted" style="margin-top:0">${esc(t('ai.intro'))}</p>
      <div class="field"><textarea class="input" id="aiInput" placeholder="${esc(t('ai.placeholder'))}"></textarea></div>
      <div class="chips">${window.Assistant.prompts(lang()).map(p => `<button type="button" class="chip" data-action="ai-prompt" data-text="${esc(p.text)}">${esc(p.label)}</button>`).join('')}</div>
      <button type="button" class="btn btn-primary btn-block mt" data-action="ai-run">${esc(t('ai.run'))}</button>
      <div id="aiOut"></div>
    </div>`, { type: 'assistant' });
}

function runAssistant() {
  const text = $('#aiInput').value.trim();
  if (!text) return toast(t('ai.needText'));
  const plan = window.Assistant.suggest(text, lang());
  $('#aiOut').innerHTML = `<div class="card mt"><h3>${esc(plan.title)}</h3>
    <div class="ai-steps">${plan.steps.map(s => `<label><input type="checkbox" checked data-step="${esc(s)}"><span>${esc(s)}</span></label>`).join('')}</div>
    <button type="button" class="btn btn-primary btn-block mt" data-action="ai-add">${esc(t('ai.add'))}</button></div>`;
  $('#aiOut').scrollIntoView({ behavior: 'smooth', block: 'start' });
}

async function addAssistantSteps() {
  const steps = $$('#aiOut input:checked').map(i => i.dataset.step);
  if (!steps.length) return toast(t('ai.pickOne'));
  try {
    for (const title of steps) {
      const d = await api('/reminders', { method: 'POST', body: { title, kind: 'task', alerts: [] } });
      upsert(d.reminder);
    }
    closeSheet();
    render();
    toast(t('ai.added', { n: steps.length }), 'success');
  } catch (e) { toast(e.message, 'error'); }
}
