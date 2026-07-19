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
      // edit fields
      kind: 'appointment',
      allDay: !!a.allDay,
      start: a.start,
      end: a.end,
      location: a.location || '',
      notes: a.notes || '',
      recurring: !!a.recurring,
      tags: a.tags || [],
      editable: true,
    }));
    const tasks = [];
    (payload.tasks || []).forEach((t) => {
      tasks.push({
        id: t.id,
        time: t.allDay ? null : isoToClock(t.start),
        title: t.title,
        note: t.notes || undefined,
        done: !!t.done,
        kind: 'task',
        allDay: !!t.allDay,
        start: t.start,
        end: t.end,
        notes: t.notes || '',
        recurring: !!t.recurring,
        tags: t.tags || [],
        editable: true,
      });
    });
    (payload.grooming || []).forEach((g) => {
      tasks.push({
        id: g.id || 'grooming:' + g.time + ':' + g.title,
        time: g.time,
        title: g.title,
        note: g.note || undefined,
        done: !!g.done,
        grooming: true,
        groomingId: g.id,
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

  // Tags: the available tag list + the active filter (tag names).
  let availableTags = [];
  const activeTagFilter = new Set();

  function passesTagFilter(item) {
    if (!activeTagFilter.size) return true;
    return Array.isArray(item.tags) && item.tags.some((t) => activeTagFilter.has(t));
  }

  function loadTags() {
    return fetch('/api/tags')
      .then((r) => r.json())
      .then((d) => {
        availableTags = d.tags || [];
        renderTagFilter();
      })
      .catch(() => {});
  }

  function renderTagFilter() {
    const bar = document.getElementById('tag-filter');
    if (!bar) return;
    if (!availableTags.length) {
      bar.hidden = true;
      bar.innerHTML = '';
      return;
    }
    bar.hidden = false;
    bar.innerHTML = '';
    availableTags.forEach((t) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'tag-pill' + (activeTagFilter.has(t) ? ' active' : '');
      b.textContent = t;
      b.onclick = () => {
        if (activeTagFilter.has(t)) activeTagFilter.delete(t);
        else activeTagFilter.add(t);
        renderTagFilter();
        render();
      };
      bar.appendChild(b);
    });
    if (activeTagFilter.size) {
      const c = document.createElement('button');
      c.type = 'button';
      c.className = 'tag-pill clear';
      c.textContent = '✕ Clear';
      c.onclick = () => {
        activeTagFilter.clear();
        renderTagFilter();
        render();
      };
      bar.appendChild(c);
    }
  }

  function effectiveDone(day, task) {
    const override = state[day.dateKey] && state[day.dateKey][task.id];
    return override !== undefined ? override : !!task.done;
  }

  function toggleTask(day, task) {
    if (!state[day.dateKey]) state[day.dateKey] = {};
    const next = !effectiveDone(day, task);
    state[day.dateKey][task.id] = next;
    render();

    // Grooming routine done-state persists to Firestore (groomingDone/{date}).
    if (task.grooming) {
      fetch('/api/grooming/complete', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ date: day.dateKey, id: task.groomingId, done: next }),
      })
        .then((r) => {
          if (!r.ok) throw new Error('failed');
        })
        .catch(() => {
          state[day.dateKey][task.id] = !next;
          render();
        });
      return;
    }

    // Persist real task done-state; revert the optimistic flip on error.
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
    todayBtn: document.getElementById('today-btn'),
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
    let activeTab = null;
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
      if (isActive) activeTab = tab;
    }

    // Keep the selected pill centered. The strip is a fixed 7-day window on the
    // selected day and rebuilds whenever a neighbor's counts load (which resets
    // scrollLeft to 0), so re-center on every render. offsetLeft is relative to
    // .daytabs (position:relative), so this math is exact; scrollLeft clamps to
    // the valid range automatically.
    if (activeTab) {
      el.daytabs.scrollLeft = activeTab.offsetLeft - (el.daytabs.clientWidth - activeTab.offsetWidth) / 2;
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
      row.className = 'item appt clickable';
      row.innerHTML =
        '<div class="box apptbox"><span class="dot"></span></div>' +
        '<div class="item-body">' +
        '<div class="item-title">' + escapeHtml(item.title) + '</div>' +
        (item.time ? '<div class="item-time">' + escapeHtml(item.time) + '</div>' : '') +
        (item.note ? '<div class="item-note">' + escapeHtml(item.note) + '</div>' : '') +
        '</div>';
      row.onclick = () => openEventModal(item);
      return row;
    }

    // task
    const done = effectiveDone(day, item);
    row.className = 'item' + (done ? ' checked' : '') + (item.grooming ? '' : ' clickable');
    row.innerHTML =
      '<div class="box">' + checkSvg() + '</div>' +
      '<div class="item-body">' +
      '<div class="item-title">' + escapeHtml(item.title) + '</div>' +
      (item.time ? '<div class="item-time">' + escapeHtml(item.time) + '</div>' : '') +
      (item.note ? '<div class="item-note">' + escapeHtml(item.note) + '</div>' : '') +
      tagsHtml(item) +
      '</div>';
    if (item.grooming) {
      // Grooming routine: whole row toggles the in-routine checkmark.
      row.onclick = () => toggleTask(day, item);
    } else {
      // Real task: the checkbox toggles done; tapping the body opens the editor.
      row.onclick = (e) => {
        if (e.target.closest('.box')) toggleTask(day, item);
        else openEventModal(item);
      };
    }
    return row;
  }

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, (c) => (
      { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
    ));
  }

  function tagsHtml(item) {
    if (!item.tags || !item.tags.length) return '';
    return (
      '<div class="item-tags">' +
      item.tags.map((t) => '<span class="tag">' + escapeHtml(t) + '</span>').join('') +
      '</div>'
    );
  }

  function minutesToClock(min) {
    let hours = Math.floor(min / 60);
    const minutes = min % 60;
    const period = hours >= 12 ? 'PM' : 'AM';
    hours = hours % 12;
    if (hours === 0) hours = 12;
    return hours + ':' + String(minutes).padStart(2, '0') + ' ' + period;
  }

  // The "now" marker row: a dot + current time + a horizontal rule.
  function buildNowLine(min) {
    const div = document.createElement('div');
    div.className = 'now-line';
    div.innerHTML =
      '<span class="now-dot"></span>' +
      '<span class="now-label">' + escapeHtml(minutesToClock(min)) + '</span>';
    return div;
  }

  function renderPanel(date, day) {
    el.panel.innerHTML = '';

    // Group appointments + timed/anytime tasks into Morning/Afternoon/Evening/Anytime.
    const buckets = { Morning: [], Afternoon: [], Evening: [], Anytime: [] };
    day.appointments.forEach((a) => {
      if (!passesTagFilter(a)) return;
      buckets[bucketFor(timeToMinutes(a.time))].push({ kind: 'appointment', item: a, minutes: timeToMinutes(a.time) });
    });
    day.tasks.filter((t) => !t.tbd).forEach((t) => {
      if (!passesTagFilter(t)) return;
      buckets[bucketFor(timeToMinutes(t.time))].push({ kind: 'task', item: t, minutes: timeToMinutes(t.time) });
    });

    let renderedAny = false;

    // "Now" line (only when viewing today, and there's at least one timed item):
    // a labeled horizontal marker placed between what has passed and what's next.
    const isToday = dayOffset(date, TODAY) === 0;
    const now = new Date();
    const nowMin = now.getHours() * 60 + now.getMinutes();
    const allTimed = [];
    BUCKET_ORDER.forEach((b) => buckets[b].forEach((e) => {
      if (e.minutes !== null) allTimed.push(e.minutes);
    }));
    allTimed.sort((a, b) => a - b);
    const showNow = isToday && allTimed.length > 0;
    const crossIndex = showNow ? allTimed.filter((m) => m <= nowMin).length : 0;
    let appendedTimed = 0;
    let nowPlaced = false;
    function maybeNowLine() {
      if (showNow && !nowPlaced && appendedTimed === crossIndex) {
        el.panel.appendChild(buildNowLine(nowMin));
        nowPlaced = true;
      }
    }

    BUCKET_ORDER.forEach((bucketName) => {
      const entries = buckets[bucketName];
      if (!entries.length) return;
      entries.sort((a, b) => (a.minutes || 0) - (b.minutes || 0));

      maybeNowLine(); // boundary at the start of a bucket

      const label = document.createElement('div');
      label.className = 'section-label';
      label.textContent = bucketName;
      el.panel.appendChild(label);

      entries.forEach((entry) => {
        maybeNowLine(); // boundary between rows within a bucket
        el.panel.appendChild(buildRow(day, entry.kind, entry.item));
        if (entry.minutes !== null) appendedTimed++;
      });
      renderedAny = true;
    });

    maybeNowLine(); // now is after all of today's timed items

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
    // "Go to Today" button appears only when we've navigated off today.
    el.todayBtn.hidden = dayOffset(selected, TODAY) === 0;
  }

  function selectDay(d) {
    selected = startOfDay(d);
    render(); // immediate: cached data or a brief loading state
    refreshVisible(false); // fill the selected day + tab neighbors from the server
  }

  el.prevBtn.onclick = () => selectDay(addDays(selected, -1));
  el.nextBtn.onclick = () => selectDay(addDays(selected, 1));
  el.todayBtn.onclick = () => selectDay(TODAY);
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
  // Swipe navigation: swipe left → next day, right → previous day.
  // The selected day always renders as the centered pill (renderDayTabs).
  // ---------------------------------------------------------------------
  let touchX = 0;
  let touchY = 0;
  let tracking = false;

  gate.appView.addEventListener(
    'touchstart',
    (e) => {
      // Ignore swipes that start on the scrollable day strip, inputs, or the modal.
      if (
        e.touches.length !== 1 ||
        (e.target.closest &&
          (e.target.closest('.daytabs') ||
            e.target.closest('.ask-bar') ||
            e.target.closest('input') ||
            e.target.closest('.settings-modal')))
      ) {
        tracking = false;
        return;
      }
      touchX = e.touches[0].clientX;
      touchY = e.touches[0].clientY;
      tracking = true;
    },
    { passive: true }
  );

  gate.appView.addEventListener(
    'touchend',
    (e) => {
      if (!tracking) return;
      tracking = false;
      const t = e.changedTouches[0];
      const dx = t.clientX - touchX;
      const dy = t.clientY - touchY;
      // Horizontal swipe: significant X move, and clearly more horizontal than vertical.
      if (Math.abs(dx) > 55 && Math.abs(dx) > Math.abs(dy) * 1.4) {
        selectDay(addDays(selected, dx < 0 ? 1 : -1));
      }
    },
    { passive: true }
  );

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
    schedEnabled: document.getElementById('sched-enabled'),
    schedInterval: document.getElementById('sched-interval'),
    schedStart: document.getElementById('sched-start'),
    schedEnd: document.getElementById('sched-end'),
    schedSave: document.getElementById('sched-save'),
    schedNote: document.getElementById('sched-note'),
    densitySeg: document.getElementById('density-seg'),
  };

  // List-density preference (per-device): 'normal' | 'compact' | 'ultra'.
  function readDensity() {
    try {
      const d = localStorage.getItem('listDensity');
      if (d === 'normal' || d === 'compact' || d === 'ultra') return d;
      if (localStorage.getItem('compactList') === '1') return 'compact'; // migrate old pref
    } catch (e) {
      /* ignore */
    }
    return 'normal';
  }
  function applyDensity(d) {
    document.body.classList.remove('compact', 'ultra');
    if (d === 'compact' || d === 'ultra') document.body.classList.add(d);
    settings.densitySeg.querySelectorAll('button').forEach((b) => {
      b.classList.toggle('active', b.getAttribute('data-density') === d);
    });
  }
  applyDensity(readDensity());
  settings.densitySeg.querySelectorAll('button').forEach((b) => {
    b.onclick = () => {
      const d = b.getAttribute('data-density');
      applyDensity(d);
      try {
        localStorage.setItem('listDensity', d);
      } catch (e) {
        /* ignore storage errors */
      }
    };
  });

  // Keep the "now" line advancing while the app is open (re-renders only on today).
  setInterval(() => {
    if (dayOffset(selected, TODAY) === 0) render();
  }, 60000);

  // ---------------------------------------------------------------------
  // Event editor modal (T29): create / edit / delete an appointment or task.
  // ---------------------------------------------------------------------
  const ev = {
    modal: document.getElementById('event-modal'),
    heading: document.getElementById('event-modal-title'),
    close: document.getElementById('event-close'),
    fTitle: document.getElementById('ev-title'),
    type: document.getElementById('ev-type'),
    allday: document.getElementById('ev-allday'),
    date: document.getElementById('ev-date'),
    times: document.querySelector('.ev-times'),
    start: document.getElementById('ev-start'),
    end: document.getElementById('ev-end'),
    locWrap: document.querySelector('.ev-loc'),
    location: document.getElementById('ev-location'),
    doneWrap: document.querySelector('.ev-done'),
    done: document.getElementById('ev-done'),
    notes: document.getElementById('ev-notes'),
    recNote: document.getElementById('ev-recurring-note'),
    tags: document.getElementById('ev-tags'),
    save: document.getElementById('ev-save'),
    del: document.getElementById('ev-delete'),
    note: document.getElementById('ev-note'),
    editingId: null,
    selectedTags: new Set(),
  };

  function renderEvTags() {
    ev.tags.innerHTML = '';
    if (!availableTags.length) {
      ev.tags.innerHTML = '<span class="empty-hint">Add tags in Settings</span>';
      return;
    }
    availableTags.forEach((t) => {
      const chip = document.createElement('button');
      chip.type = 'button';
      chip.className = 'tag-chip' + (ev.selectedTags.has(t) ? ' on' : '');
      chip.textContent = t;
      chip.onclick = () => {
        if (ev.selectedTags.has(t)) ev.selectedTags.delete(t);
        else ev.selectedTags.add(t);
        chip.classList.toggle('on');
      };
      ev.tags.appendChild(chip);
    });
  }

  function evKind() {
    const active = ev.type.querySelector('button.active');
    return active ? active.getAttribute('data-kind') : 'appointment';
  }
  function setEvKind(kind) {
    ev.type.querySelectorAll('button').forEach((b) =>
      b.classList.toggle('active', b.getAttribute('data-kind') === kind)
    );
    evVisibility();
  }
  function evVisibility() {
    const allDay = ev.allday.classList.contains('on');
    const kind = evKind();
    ev.times.style.display = allDay ? 'none' : 'flex';
    ev.locWrap.style.display = kind === 'appointment' ? '' : 'none';
    ev.doneWrap.style.display = kind === 'task' ? '' : 'none';
  }

  function openEventModal(item) {
    ev.note.textContent = '';
    if (item) {
      ev.heading.textContent = 'Edit event';
      ev.editingId = item.id;
      ev.fTitle.value = item.title || '';
      setEvKind(item.kind === 'task' ? 'task' : 'appointment');
      ev.allday.classList.toggle('on', !!item.allDay);
      const dateStr = item.allDay
        ? item.start || dateKey(selected)
        : (item.start || '').split('T')[0] || dateKey(selected);
      ev.date.value = dateStr;
      if (!item.allDay && item.start && item.start.indexOf('T') >= 0) {
        ev.start.value = item.start.slice(11, 16);
        ev.end.value = item.end && item.end.indexOf('T') >= 0 ? item.end.slice(11, 16) : ev.start.value;
      } else {
        ev.start.value = '09:00';
        ev.end.value = '10:00';
      }
      ev.location.value = item.location || '';
      ev.notes.value = item.notes || '';
      ev.done.classList.toggle('on', !!item.done);
      ev.del.hidden = false;
      ev.recNote.hidden = !item.recurring;
    } else {
      ev.heading.textContent = 'New event';
      ev.editingId = null;
      ev.fTitle.value = '';
      setEvKind('appointment');
      ev.allday.classList.remove('on');
      ev.date.value = dateKey(selected);
      const nextH = Math.min(23, new Date().getHours() + 1);
      ev.start.value = pad2(nextH) + ':00';
      ev.end.value = pad2(Math.min(23, nextH + 1)) + ':00';
      ev.location.value = '';
      ev.notes.value = '';
      ev.done.classList.remove('on');
      ev.del.hidden = true;
      ev.recNote.hidden = true;
    }
    ev.selectedTags = new Set(item && Array.isArray(item.tags) ? item.tags : []);
    renderEvTags();
    evVisibility();
    ev.modal.hidden = false;
  }

  function closeEventModal() {
    ev.modal.hidden = true;
  }

  function saveEvent() {
    const title = ev.fTitle.value.trim();
    if (!title) {
      ev.note.textContent = 'Title is required.';
      return;
    }
    const kind = evKind();
    const allDay = ev.allday.classList.contains('on');
    const date = ev.date.value || dateKey(selected);
    const body = {
      kind,
      title,
      allDay,
      date,
      notes: ev.notes.value,
      done: ev.done.classList.contains('on'),
    };
    if (!allDay) {
      const st = ev.start.value || '09:00';
      const en = ev.end.value || st;
      body.start = date + 'T' + st + ':00';
      body.end = date + 'T' + en + ':00';
    }
    if (kind === 'appointment') body.location = ev.location.value;
    body.tags = Array.from(ev.selectedTags);
    if (ev.editingId) body.id = ev.editingId;

    ev.save.disabled = true;
    ev.note.textContent = 'Saving…';
    fetch(ev.editingId ? '/api/event/update' : '/api/event/create', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })
      .then((r) => r.json().then((data) => ({ ok: r.ok, data })))
      .then(({ ok, data }) => {
        if (!ok) {
          ev.note.textContent = 'Error: ' + (data.error || 'failed');
          return;
        }
        closeEventModal();
        refreshVisible(true);
      })
      .catch(() => {
        ev.note.textContent = 'Network error.';
      })
      .finally(() => {
        ev.save.disabled = false;
      });
  }

  function deleteEvent() {
    if (!ev.editingId) return;
    if (!window.confirm('Delete this event?')) return;
    ev.del.disabled = true;
    fetch('/api/event/delete', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: ev.editingId }),
    })
      .then((r) => r.json().then((data) => ({ ok: r.ok, data })))
      .then(({ ok }) => {
        if (ok) {
          closeEventModal();
          refreshVisible(true);
        } else {
          ev.note.textContent = 'Delete failed.';
        }
      })
      .catch(() => {
        ev.note.textContent = 'Network error.';
      })
      .finally(() => {
        ev.del.disabled = false;
      });
  }

  ev.close.onclick = closeEventModal;
  ev.save.onclick = saveEvent;
  ev.del.onclick = deleteEvent;
  ev.allday.onclick = () => {
    ev.allday.classList.toggle('on');
    evVisibility();
  };
  ev.done.onclick = () => ev.done.classList.toggle('on');
  ev.type.querySelectorAll('button').forEach((b) => {
    b.onclick = () => setEvKind(b.getAttribute('data-kind'));
  });
  ev.modal.addEventListener('click', (e) => {
    if (e.target === ev.modal) closeEventModal();
  });
  document.getElementById('new-event-btn').onclick = () => openEventModal(null);

  // ---------------------------------------------------------------------
  // Tag management (Settings → Tags)
  // ---------------------------------------------------------------------
  function renderTagManage() {
    const wrap = document.getElementById('tag-manage');
    if (!wrap) return;
    wrap.innerHTML = '';
    if (!availableTags.length) {
      wrap.innerHTML = '<span class="empty-hint">No tags yet.</span>';
      return;
    }
    availableTags.forEach((t) => {
      const chip = document.createElement('span');
      chip.className = 'tag-chip';
      chip.appendChild(document.createTextNode(t + ' '));
      const x = document.createElement('button');
      x.type = 'button';
      x.textContent = '×';
      x.setAttribute('aria-label', 'Remove ' + t);
      x.onclick = () => removeTagUi(t);
      chip.appendChild(x);
      wrap.appendChild(chip);
    });
  }
  function addTagUi() {
    const input = document.getElementById('tag-add-input');
    const name = (input.value || '').trim();
    if (!name) return;
    fetch('/api/tags/add', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name }),
    })
      .then((r) => r.json())
      .then((d) => {
        if (d.tags) {
          availableTags = d.tags;
          input.value = '';
          renderTagManage();
          renderTagFilter();
        }
      })
      .catch(() => {});
  }
  function removeTagUi(name) {
    fetch('/api/tags/remove', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name }),
    })
      .then((r) => r.json())
      .then((d) => {
        if (d.tags) {
          availableTags = d.tags;
          activeTagFilter.delete(name);
          renderTagManage();
          renderTagFilter();
          render();
        }
      })
      .catch(() => {});
  }
  document.getElementById('tag-add-btn').onclick = addTagUi;
  document.getElementById('tag-add-input').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') addTagUi();
  });

  function openSettings() {
    settings.modal.hidden = false;
    settings.note.textContent = '';
    settings.schedNote.textContent = '';
    settings.cals.innerHTML = '<div class="empty-state">Loading…</div>';
    fetch('/api/sync/calendars')
      .then((r) => r.json())
      .then((data) => renderCalendars(data))
      .catch(() => {
        settings.cals.innerHTML = '<div class="empty-state">Could not load calendars.</div>';
      });
    loadSchedule();
    loadTags().then(() => renderTagManage());
  }

  function hm(h, m) {
    return String(h).padStart(2, '0') + ':' + String(m).padStart(2, '0');
  }

  function loadSchedule() {
    fetch('/api/sync/schedule')
      .then((r) => r.json())
      .then((data) => {
        const s = (data && data.schedule) || {};
        settings.schedEnabled.classList.toggle('on', !!s.enabled);
        settings.schedInterval.value = s.intervalMinutes != null ? s.intervalMinutes : 10;
        settings.schedStart.value = hm(s.startHour != null ? s.startHour : 7, s.startMinute || 0);
        settings.schedEnd.value = hm(s.endHour != null ? s.endHour : 22, s.endMinute || 0);
        if (s.lastRunAtMs) {
          settings.schedNote.textContent = 'Last auto-sync: ' + new Date(s.lastRunAtMs).toLocaleString();
        }
      })
      .catch(() => {});
  }

  function saveSchedule() {
    const startParts = (settings.schedStart.value || '07:00').split(':');
    const endParts = (settings.schedEnd.value || '22:00').split(':');
    const body = {
      enabled: settings.schedEnabled.classList.contains('on'),
      intervalMinutes: parseInt(settings.schedInterval.value, 10) || 10,
      startHour: parseInt(startParts[0], 10) || 0,
      startMinute: parseInt(startParts[1], 10) || 0,
      endHour: parseInt(endParts[0], 10) || 0,
      endMinute: parseInt(endParts[1], 10) || 0,
    };
    settings.schedSave.disabled = true;
    settings.schedNote.textContent = 'Saving…';
    fetch('/api/sync/schedule', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })
      .then((r) => r.json().then((data) => ({ ok: r.ok, data })))
      .then(({ ok, data }) => {
        const s = (data && data.schedule) || {};
        settings.schedNote.textContent = ok
          ? s.enabled
            ? 'Saved — every ' + s.intervalMinutes + ' min, ' + hm(s.startHour, s.startMinute) + '–' + hm(s.endHour, s.endMinute)
            : 'Saved — auto-sync off'
          : 'Save failed.';
      })
      .catch(() => {
        settings.schedNote.textContent = 'Network error.';
      })
      .finally(() => {
        settings.schedSave.disabled = false;
      });
  }

  settings.schedEnabled.onclick = () => settings.schedEnabled.classList.toggle('on');
  settings.schedSave.onclick = saveSchedule;

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
    loadTags(); // available tags for the filter bar, row pills, and modal chips
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
