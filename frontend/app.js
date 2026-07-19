// Personal Calendar — one-day view (T10)
// Vanilla JS, no build step. Renders one day at a time: a merged view of
// appointments (Google Calendar, later) and tasks (grooming routine + ad-hoc).
//
// Visual language matches grooming-checklist.html / the Design Guide exactly.

(function () {
  'use strict';

  // ---------------------------------------------------------------------
  // Date helpers
  // ---------------------------------------------------------------------

  const DOW_FULL = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
  const DOW_SHORT = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  const MONTHS = [
    'January', 'February', 'March', 'April', 'May', 'June',
    'July', 'August', 'September', 'October', 'November', 'December',
  ];

  function pad2(n) {
    return String(n).padStart(2, '0');
  }

  function startOfDay(d) {
    const copy = new Date(d);
    copy.setHours(0, 0, 0, 0);
    return copy;
  }

  function addDays(d, n) {
    const copy = new Date(d);
    copy.setDate(copy.getDate() + n);
    return copy;
  }

  function dateKey(d) {
    return d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate());
  }

  function dayOffset(d, from) {
    const MS_PER_DAY = 24 * 60 * 60 * 1000;
    return Math.round((startOfDay(d).getTime() - startOfDay(from).getTime()) / MS_PER_DAY);
  }

  function formatLongDate(d) {
    return MONTHS[d.getMonth()] + ' ' + d.getDate() + ', ' + d.getFullYear();
  }

  // Parse "6:30 AM" / "9:00 PM" -> minutes since midnight. Returns null for
  // items with no fixed time (they go in the "Anytime" bucket).
  function timeToMinutes(t) {
    if (!t) return null;
    const m = /^(\d{1,2}):(\d{2})\s*(AM|PM)$/i.exec(t.trim());
    if (!m) return null;
    let hours = parseInt(m[1], 10) % 12;
    const minutes = parseInt(m[2], 10);
    if (/PM/i.test(m[3])) hours += 12;
    return hours * 60 + minutes;
  }

  function bucketFor(minutes) {
    if (minutes === null) return 'Anytime';
    if (minutes < 12 * 60) return 'Morning';
    if (minutes < 18 * 60) return 'Afternoon';
    return 'Evening';
  }

  const BUCKET_ORDER = ['Morning', 'Afternoon', 'Evening', 'Anytime'];

  // ---------------------------------------------------------------------
  // Real day data (T12) — GET /api/day?date=YYYY-MM-DD, backed by the MCP
  // get_day tool. The server returns normalized CalendarItems; we map them
  // into the render model this view already speaks:
  //
  //   render day = {
  //     dateKey: 'YYYY-MM-DD',
  //     appointments: [{ id, time: 'H:MM AM/PM', title, note? }],
  //     tasks: [{ id, time?: 'H:MM AM/PM', title, note?, done, grooming? }],
  //   }
  //
  // Fetches are async, but the render code below is synchronous and calls
  // getDay(date) many times per frame (header, 7 day tabs, panel, footer).
  // So results are cached by dateKey; getDay() reads the cache synchronously
  // and returns a { _loading: true } placeholder for days not yet fetched.
  // ensureDay()/refresh helpers fill the cache and re-render.
  // ---------------------------------------------------------------------

  const TODAY = startOfDay(new Date());

  const dayCache = {}; // dateKey -> mapped render day (or _loading/_error placeholder)
  const inflight = {}; // dateKey -> in-progress fetch promise (dedupe)

  // Extract 'H:MM AM/PM' from an ISO datetime's LOCAL wall-clock part (the
  // event's own offset), independent of the browser timezone. Returns null for
  // all-day (date-only 'YYYY-MM-DD') values, which have no 'T'.
  function isoToClock(iso) {
    if (!iso || typeof iso !== 'string') return null;
    const t = iso.indexOf('T');
    if (t < 0) return null;
    const hm = /^(\d{2}):(\d{2})/.exec(iso.slice(t + 1));
    if (!hm) return null;
    let hours = parseInt(hm[1], 10);
    const minutes = hm[2];
    const period = hours >= 12 ? 'PM' : 'AM';
    hours = hours % 12;
    if (hours === 0) hours = 12;
    return hours + ':' + minutes + ' ' + period;
  }

  // Map the server payload { date, appointments, tasks, grooming } into the
  // render model. Grooming routine items become checkbox tasks (recurring
  // routine; done-state is in-memory only, not persisted to Google).
  function mapServerDay(payload) {
    const appointments = (payload.appointments || []).map((a) => ({
      id: a.id,
      time: a.allDay ? null : isoToClock(a.start),
      title: a.title,
      note: a.location || a.notes || undefined,
    }));
    const tasks = [];
    (payload.tasks || []).forEach((t) => {
      tasks.push({
        id: t.id,
        time: t.allDay ? null : isoToClock(t.start),
        title: t.title,
        note: t.notes || undefined,
        done: !!t.done,
      });
    });
    (payload.grooming || []).forEach((g) => {
      tasks.push({
        id: 'grooming:' + g.time + ':' + g.title,
        time: g.time,
        title: g.title,
        note: g.note || undefined,
        done: false,
        grooming: true,
      });
    });
    return { dateKey: payload.date, appointments, tasks };
  }

  // Synchronous cache read for the render path. Missing days render as a
  // brief loading placeholder until ensureDay() fills them.
  function getDay(date) {
    const key = dateKey(date);
    return dayCache[key] || { dateKey: key, appointments: [], tasks: [], _loading: true };
  }

  // Fetch one day from the server, store the mapped result (or an error
  // placeholder) in the cache. Deduped via `inflight`.
  function fetchDay(key) {
    return fetch('/api/day?date=' + encodeURIComponent(key))
      .then((r) => r.json().then((data) => ({ ok: r.ok, data })))
      .then(({ ok, data }) => {
        dayCache[key] = ok
          ? mapServerDay(data)
          : { dateKey: key, appointments: [], tasks: [], _error: data.error || 'error' };
        return dayCache[key];
      })
      .catch(() => {
        dayCache[key] = { dateKey: key, appointments: [], tasks: [], _error: 'network' };
        return dayCache[key];
      });
  }

  // Ensure a day is loaded (fetch once if absent/stale), returning a promise.
  function ensureDay(key) {
    if (dayCache[key] && !dayCache[key]._loading) return Promise.resolve(dayCache[key]);
    if (inflight[key]) return inflight[key];
    const p = fetchDay(key).then((d) => {
      delete inflight[key];
      return d;
    });
    inflight[key] = p;
    return p;
  }

  // Load the selected day (re-render when it lands) and prefetch the visible
  // day-tab neighbors so their counts populate. `force` drops the cache first
  // (used after the assistant changes the calendar).
  function refreshVisible(force) {
    if (force) {
      for (let i = -3; i <= 3; i++) delete dayCache[dateKey(addDays(selected, i))];
    }
    ensureDay(dateKey(selected)).then(() => render());
    for (let i = -3; i <= 3; i++) {
      const k = dateKey(addDays(selected, i));
      ensureDay(k).then(() => renderDayTabs(selected));
    }
  }

  // ---------------------------------------------------------------------
  // State — checkbox toggles are optimistic and layered on top of each
  // task's baseline `done`. Keyed by dateKey -> { taskId: boolean }.
  // For real Google tasks the toggle also persists to Google via
  // POST /api/task/complete (reverting the optimistic flip on failure);
  // grooming routine items are in-memory only.
  // ---------------------------------------------------------------------

  const state = {}; // state[dateKey][taskId] = true/false override

  function effectiveDone(day, task) {
    const override = state[day.dateKey] && state[day.dateKey][task.id];
    return override !== undefined ? override : !!task.done;
  }

  function toggleTask(day, task) {
    if (!state[day.dateKey]) state[day.dateKey] = {};
    const next = !effectiveDone(day, task);
    state[day.dateKey][task.id] = next;
    render();

    // Grooming routine items have no Google event to update — in-memory only.
    if (task.grooming) return;

    // Persist real task done-state to Google; revert the optimistic flip on error.
    fetch('/api/task/complete', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: task.id, done: next }),
    })
      .then((r) => {
        if (!r.ok) throw new Error('failed');
      })
      .catch(() => {
        state[day.dateKey][task.id] = !next;
        render();
      });
  }

  function taskCounts(date) {
    const day = getDay(date);
    const real = day.tasks.filter((t) => !t.tbd);
    const done = real.filter((t) => effectiveDone(day, t)).length;
    return { done, total: real.length };
  }

  // ---------------------------------------------------------------------
  // Rendering
  // ---------------------------------------------------------------------

  let selected = TODAY; // currently viewed day

  const el = {
    eyebrow: document.getElementById('eyebrow'),
    heading: document.getElementById('heading'),
    sub: document.getElementById('sub'),
    daytabs: document.getElementById('daytabs'),
    panel: document.getElementById('panel'),
    progress: document.getElementById('progress-text'),
    resetBtn: document.getElementById('reset-btn'),
    prevBtn: document.getElementById('prev-day'),
    nextBtn: document.getElementById('next-day'),
  };

  function checkSvg() {
    return (
      '<svg viewBox="0 0 24 24" fill="none" stroke="#12180f" stroke-width="3" ' +
      'stroke-linecap="round" stroke-linejoin="round">' +
      '<polyline points="20 6 9 17 4 12"></polyline></svg>'
    );
  }

  function renderHeader(date, day) {
    const offset = dayOffset(date, TODAY);
    const relative = offset === 0 ? 'Today' : offset === 1 ? 'Tomorrow' : offset === -1 ? 'Yesterday' : null;

    el.eyebrow.textContent = DOW_FULL[date.getDay()].toUpperCase();
    el.heading.textContent = formatLongDate(date);

    const apptCount = day.appointments.length;
    const { done, total } = taskCounts(date);
    const parts = [];
    if (relative) parts.push(relative);
    parts.push(apptCount + (apptCount === 1 ? ' appointment' : ' appointments'));
    parts.push(done + '/' + total + ' tasks done');
    el.sub.textContent = parts.join(' · ');
  }

  function renderDayTabs(date) {
    el.daytabs.innerHTML = '';
    // A week of pills centered on the selected day.
    for (let i = -3; i <= 3; i++) {
      const d = addDays(date, i);
      const { done, total } = taskCounts(d);
      const isToday = dayOffset(d, TODAY) === 0;
      const isActive = dayOffset(d, date) === 0;

      const tab = document.createElement('div');
      tab.className = 'daytab' + (isActive ? ' active' : '');
      const label = isToday ? 'Today' : DOW_SHORT[d.getDay()] + ' ' + d.getDate();
      tab.innerHTML = label + '<span class="count">' + done + '/' + total + '</span>';
      tab.onclick = () => selectDay(d);
      el.daytabs.appendChild(tab);
    }
  }

  function buildRow(day, kind, item) {
    const row = document.createElement('div');

    if (item.tbd) {
      row.className = 'item tbd';
      row.innerHTML =
        '<div class="box"></div>' +
        '<div class="item-body">' +
        '<div class="item-title">' + escapeHtml(item.title) + '</div>' +
        (item.note ? '<div class="item-note">' + escapeHtml(item.note) + '</div>' : '') +
        '</div>';
      return row;
    }

    if (kind === 'appointment') {
      row.className = 'item appt';
      row.innerHTML =
        '<div class="box apptbox"><span class="dot"></span></div>' +
        '<div class="item-body">' +
        '<div class="item-title">' + escapeHtml(item.title) + '</div>' +
        (item.time ? '<div class="item-time">' + escapeHtml(item.time) + '</div>' : '') +
        (item.note ? '<div class="item-note">' + escapeHtml(item.note) + '</div>' : '') +
        '</div>';
      return row;
    }

    // task
    const done = effectiveDone(day, item);
    row.className = 'item' + (done ? ' checked' : '');
    row.onclick = () => toggleTask(day, item);
    row.innerHTML =
      '<div class="box">' + checkSvg() + '</div>' +
      '<div class="item-body">' +
      '<div class="item-title">' + escapeHtml(item.title) + '</div>' +
      (item.time ? '<div class="item-time">' + escapeHtml(item.time) + '</div>' : '') +
      (item.note ? '<div class="item-note">' + escapeHtml(item.note) + '</div>' : '') +
      '</div>';
    return row;
  }

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, (c) => (
      { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
    ));
  }

  function renderPanel(date, day) {
    el.panel.innerHTML = '';

    // Group appointments + timed/anytime tasks into Morning/Afternoon/Evening/Anytime.
    const buckets = { Morning: [], Afternoon: [], Evening: [], Anytime: [] };
    day.appointments.forEach((a) => {
      buckets[bucketFor(timeToMinutes(a.time))].push({ kind: 'appointment', item: a, minutes: timeToMinutes(a.time) });
    });
    day.tasks.filter((t) => !t.tbd).forEach((t) => {
      buckets[bucketFor(timeToMinutes(t.time))].push({ kind: 'task', item: t, minutes: timeToMinutes(t.time) });
    });

    let renderedAny = false;

    BUCKET_ORDER.forEach((bucketName) => {
      const entries = buckets[bucketName];
      if (!entries.length) return;
      entries.sort((a, b) => (a.minutes || 0) - (b.minutes || 0));

      const label = document.createElement('div');
      label.className = 'section-label';
      label.textContent = bucketName;
      el.panel.appendChild(label);

      entries.forEach((entry) => {
        el.panel.appendChild(buildRow(day, entry.kind, entry.item));
      });
      renderedAny = true;
    });

    const tbdTasks = day.tasks.filter((t) => t.tbd);
    if (tbdTasks.length) {
      const label = document.createElement('div');
      label.className = 'section-label';
      label.textContent = 'Not yet scheduled';
      el.panel.appendChild(label);
      tbdTasks.forEach((t) => el.panel.appendChild(buildRow(day, 'task', t)));
      renderedAny = true;
    }

    if (!renderedAny) {
      const empty = document.createElement('div');
      empty.className = 'empty-state';
      empty.textContent = day._loading
        ? 'Loading…'
        : day._error
          ? 'Could not load this day. Check your connection or sign in again.'
          : 'No events for this day.';
      el.panel.appendChild(empty);
    }
  }

  function renderFooter(date, day) {
    const { done, total } = taskCounts(date);
    el.progress.textContent = done + ' of ' + total + ' tasks done';
  }

  function render() {
    const day = getDay(selected);
    renderHeader(selected, day);
    renderDayTabs(selected);
    renderPanel(selected, day);
    renderFooter(selected, day);
  }

  function selectDay(d) {
    selected = startOfDay(d);
    render(); // immediate: cached data or a brief loading state
    refreshVisible(false); // fill the selected day + tab neighbors from the server
  }

  el.prevBtn.onclick = () => selectDay(addDays(selected, -1));
  el.nextBtn.onclick = () => selectDay(addDays(selected, 1));
  el.resetBtn.onclick = () => {
    const day = getDay(selected);
    state[day.dateKey] = {};
    render();
  };

  // ---------------------------------------------------------------------
  // Auth gate + assistant ask bar (T11)
  // ---------------------------------------------------------------------

  const gate = {
    signinView: document.getElementById('signin-view'),
    appView: document.getElementById('app-view'),
    accountEmail: document.getElementById('account-email'),
    askInput: document.getElementById('ask-input'),
    askBtn: document.getElementById('ask-btn'),
    askResult: document.getElementById('ask-result'),
  };

  // Tool names that change the calendar — after any of these, re-fetch the
  // visible day so new/edited events appear immediately.
  const MUTATING_ACTION_RE = /(add|update|delete|complete|reschedule)/i;

  function runAsk() {
    const text = gate.askInput.value.trim();
    if (!text) return;
    gate.askResult.hidden = false;
    gate.askResult.textContent = 'Thinking…';
    gate.askBtn.disabled = true;
    fetch('/api/assistant', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ request: text }),
    })
      .then((r) => r.json().then((data) => ({ ok: r.ok, data })))
      .then(({ ok, data }) => {
        if (!ok) {
          gate.askResult.textContent = 'Error: ' + (data.message || data.error || 'request failed');
          return;
        }
        const actions = data.actions || [];
        let msg = '[' + data.route + ' · ' + data.model + ']\n' + (data.finalText || '');
        if (actions.length) {
          msg += '\n\nActions taken: ' + actions.map((a) => a.name).join(', ');
        }
        gate.askResult.textContent = msg;
        gate.askInput.value = '';
        // If the assistant changed the calendar, refresh the current day view.
        if (actions.some((a) => MUTATING_ACTION_RE.test(a.name))) {
          refreshVisible(true);
        }
      })
      .catch(() => {
        gate.askResult.textContent = 'Network error contacting the assistant.';
      })
      .finally(() => {
        gate.askBtn.disabled = false;
      });
  }
  gate.askBtn.onclick = runAsk;
  gate.askInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') runAsk();
  });

  // ---------------------------------------------------------------------
  // Sync settings modal (T27): which Google calendars to sync + Sync now.
  // ---------------------------------------------------------------------
  const settings = {
    btn: document.getElementById('settings-btn'),
    modal: document.getElementById('settings-modal'),
    close: document.getElementById('settings-close'),
    cals: document.getElementById('settings-cals'),
    syncBtn: document.getElementById('sync-now-btn'),
    note: document.getElementById('settings-note'),
  };

  function openSettings() {
    settings.modal.hidden = false;
    settings.note.textContent = '';
    settings.cals.innerHTML = '<div class="empty-state">Loading…</div>';
    fetch('/api/sync/calendars')
      .then((r) => r.json())
      .then((data) => renderCalendars(data))
      .catch(() => {
        settings.cals.innerHTML = '<div class="empty-state">Could not load calendars.</div>';
      });
  }

  function closeSettings() {
    settings.modal.hidden = true;
  }

  function renderCalendars(data) {
    if (!data || !data.configured) {
      settings.cals.innerHTML =
        '<div class="empty-state">Google Calendar sync isn’t configured on the server.</div>';
      settings.syncBtn.disabled = true;
      return;
    }
    settings.syncBtn.disabled = false;
    const cals = data.calendars || [];
    if (!cals.length) {
      settings.cals.innerHTML = '<div class="empty-state">No calendars found.</div>';
      return;
    }
    settings.cals.innerHTML = '';
    cals.forEach((c) => {
      const row = document.createElement('div');
      row.className = 'cal-row';
      const meta = [c.primary ? 'Primary' : null, c.accessRole].filter(Boolean).join(' · ');
      row.innerHTML =
        '<div class="cal-body">' +
        '<div class="cal-name">' + escapeHtml(c.summary || c.googleCalendarId) + '</div>' +
        (meta ? '<div class="cal-meta">' + escapeHtml(meta) + '</div>' : '') +
        '</div>';
      const sw = document.createElement('button');
      sw.type = 'button';
      sw.className = 'switch' + (c.enabled ? ' on' : '');
      sw.setAttribute('aria-label', 'Toggle sync for ' + (c.summary || c.googleCalendarId));
      sw.onclick = () => toggleCalendar(c.googleCalendarId, sw);
      row.appendChild(sw);
      settings.cals.appendChild(row);
    });
  }

  function toggleCalendar(id, sw) {
    const next = !sw.classList.contains('on');
    sw.disabled = true;
    fetch('/api/sync/calendar', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ googleCalendarId: id, enabled: next }),
    })
      .then((r) => r.json().then((data) => ({ ok: r.ok, data })))
      .then(({ ok }) => {
        if (ok) sw.classList.toggle('on', next);
      })
      .catch(() => {})
      .finally(() => {
        sw.disabled = false;
      });
  }

  function runSyncNow() {
    settings.syncBtn.disabled = true;
    settings.note.textContent = 'Syncing…';
    fetch('/api/sync/now', { method: 'POST' })
      .then((r) => r.json().then((data) => ({ ok: r.ok, data })))
      .then(({ ok, data }) => {
        settings.note.textContent = ok
          ? 'Synced ' + (data.imported || 0) + ' new from ' + (data.calendars || 0) + ' calendar(s).'
          : 'Sync failed.';
        if (ok) refreshVisible(true);
      })
      .catch(() => {
        settings.note.textContent = 'Network error.';
      })
      .finally(() => {
        settings.syncBtn.disabled = false;
      });
  }

  settings.btn.onclick = openSettings;
  settings.close.onclick = closeSettings;
  settings.syncBtn.onclick = runSyncNow;
  settings.modal.addEventListener('click', (e) => {
    if (e.target === settings.modal) closeSettings();
  });

  function showSignedOut() {
    gate.signinView.hidden = false;
    gate.appView.hidden = true;
  }

  function showSignedIn(email) {
    gate.signinView.hidden = true;
    gate.appView.hidden = false;
    gate.accountEmail.textContent = email || '';
    render(); // immediate: shows loading state
    refreshVisible(false); // load the selected day + tab neighbors from the server
  }

  fetch('/api/me')
    .then((res) => {
      if (res.status === 200) {
        return res.json().then((data) => showSignedIn(data.email));
      }
      showSignedOut();
    })
    .catch(() => showSignedOut());
})();
