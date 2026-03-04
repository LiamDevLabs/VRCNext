// Timeline - Tab 12
// Globals: timelineEvents, tlFilter  (declared in core.js)

// Pending scroll-to target: consumed by filterTimeline() after DOM is built
let _tlScrollTarget = null;

// Personal Timeline pagination state
let tlOffset = 0, tlLoading = false, tlHasMore = false, tlObserver = null;

// Friends Timeline pagination state
let ftlOffset = 0, ftlLoading = false, ftlHasMore = false, ftlObserver = null;

// Active date filter (ISO string like "2026-03-01", empty = no filter)
let tlDateFilter = '';
let tlTabInited  = false;

// Server-side search state – Personal Timeline
let _tlSearchTimer = null;
let _tlSearchMode  = false;
let _tlSearchEvents = [];
let _tlSearchQuery  = '';
let _tlSearchDate   = '';

// Server-side search state – Friends Timeline
let _ftlSearchTimer = null;
let _ftlSearchMode  = false;
let _ftlSearchEvents = [];
let _ftlSearchQuery  = '';
let _ftlSearchDate   = '';

// Filter button map
const TL_FILTER_IDS = {
    all:           'tlFAll',
    instance_join: 'tlFJoin',
    photo:         'tlFPhoto',
    first_meet:    'tlFMeet',
    meet_again:    'tlFMeetAgain',
    notification:  'tlFNotif',
};

// Type colours
const TL_TYPE_COLOR = {
    instance_join: 'var(--accent)',
    photo:         'var(--ok)',
    first_meet:    'var(--cyan)',
    meet_again:    '#AB47BC',
    notification:  'var(--warn)',
};

// Type labels and icons
const TL_TYPE_META = {
    instance_join: { icon: 'travel_explore', label: 'Instance Join' },
    photo:         { icon: 'camera',         label: 'Photo'         },
    first_meet:    { icon: 'person_add',     label: 'First Meet'    },
    meet_again:    { icon: 'person_check',   label: 'Meet Again'    },
    notification:  { icon: 'notifications',  label: 'Notification'  },
};

// Notification type labels
const NOTIF_TYPE_LABELS = {
    friendRequest:  'Friend Request',
    invite:         'Invite',
    requestInvite:  'Invite Request',
    votetokick:     'Vote to Kick',
    message:        'Message',
    halted:         'Instance Closed',
};

// Public API

function setTlMode(mode) {
    tlMode = mode;
    document.getElementById('tlModePersonal')?.classList.toggle('active', mode === 'personal');
    document.getElementById('tlModeFriends')?.classList.toggle('active',  mode === 'friends');
    const pf = document.getElementById('tlPersonalFilters');
    const ff = document.getElementById('tlFriendsFilters');
    if (pf) pf.style.display = mode === 'personal' ? '' : 'none';
    if (ff) ff.style.display = mode === 'friends'  ? '' : 'none';
    refreshTimeline();
}

function refreshTimeline() {
    if (tlMode === 'friends') { refreshFriendTimeline(); return; }
    if (!tlTabInited) {
        tlTabInited = true;
        const t = new Date();
        applyTlDateFilter(`${t.getFullYear()}-${String(t.getMonth()+1).padStart(2,'0')}-${String(t.getDate()).padStart(2,'0')}`);
        return;
    }
    // If we're navigating to a specific event and already have data, skip re-fetching
    // and render directly so _tlScrollTarget is consumed synchronously
    if (_tlScrollTarget && timelineEvents.length > 0) {
        filterTimeline();
        return;
    }
    timelineEvents = [];
    tlOffset  = 0;
    tlHasMore = false;
    tlLoading = false;
    // If search is active, keep showing existing results during refresh instead of a loading flash
    const activeSearch = (document.getElementById('tlSearchInput')?.value ?? '').trim();
    disconnectTlObserver();
    const c = document.getElementById('tlContainer');
    if (c && !(_tlSearchMode && activeSearch)) {
        c.innerHTML = '<div class="tl-loading"><div class="tl-sk-line"></div><div class="tl-sk-line tl-sk-short"></div><div class="tl-sk-line"></div><div class="tl-sk-line tl-sk-short"></div><div class="tl-sk-line"></div></div>';
    }
    if (tlDateFilter) sendToCS({ action: 'getTimelineByDate', date: tlDateFilter });
    else              sendToCS({ action: 'getTimeline' });
}

function renderTimeline(payload) {
    const events  = Array.isArray(payload) ? payload : (payload?.events  ?? []);
    const hasMore = Array.isArray(payload) ? false   : (payload?.hasMore ?? false);
    const offset  = Array.isArray(payload) ? 0       : (payload?.offset  ?? 0);

    if (offset === 0) {
        timelineEvents = events;
    } else {
        timelineEvents = timelineEvents.concat(events);
    }
    tlOffset  = offset + events.length;
    tlHasMore = hasMore;
    tlLoading = false;
    filterTimeline();
    if (typeof updateFdTlPreview === 'function') updateFdTlPreview();
}

function handleTimelineEvent(ev) {
    if (!ev || !ev.id) return;
    const idx = timelineEvents.findIndex(e => e.id === ev.id);
    if (idx >= 0) timelineEvents[idx] = ev;
    else timelineEvents.unshift(ev);
    // Re-sort by timestamp descending
    timelineEvents.sort((a, b) => b.timestamp.localeCompare(a.timestamp));
    filterTimeline();
    // Update friend-detail preview if it's currently open
    if (typeof updateFdTlPreview === 'function') updateFdTlPreview();
}

function setTlFilter(f) {
    tlFilter = f;
    document.querySelectorAll('#tlPersonalFilters .sub-tab-btn').forEach(b => b.classList.remove('active'));
    const btn = document.getElementById(TL_FILTER_IDS[f]);
    if (btn) btn.classList.add('active');
    filterTimeline();
}

function filterTimeline() {
    if (tlMode !== 'personal') return;
    const search = (document.getElementById('tlSearchInput')?.value ?? '').toLowerCase().trim();

    // When a search query is active: use server-side search for complete results
    if (search) {
        if (_tlSearchMode && search === _tlSearchQuery && tlDateFilter === _tlSearchDate) {
            // We have fresh results for exactly this query+date – render (handles filter-only changes)
            _renderTlSearchResults(search);
            return;
        }
        // Query or date changed → clear stale state, show loading, debounce
        _tlSearchMode  = false;
        _tlSearchQuery = '';
        _tlSearchDate  = '';
        disconnectTlObserver();
        const c = document.getElementById('tlContainer');
        if (c) c.innerHTML = '<div class="tl-loading"><div class="tl-sk-line"></div><div class="tl-sk-line tl-sk-short"></div><div class="tl-sk-line"></div></div>';
        clearTimeout(_tlSearchTimer);
        _tlSearchTimer = setTimeout(() => {
            sendToCS({ action: 'searchTimeline', query: search, date: tlDateFilter });
        }, 300);
        return;
    }

    // No search – clear search mode and show paginated events
    _tlSearchMode   = false;
    _tlSearchEvents = [];

    let filtered = timelineEvents;
    if (tlFilter !== 'all')
        filtered = filtered.filter(e => e.type === tlFilter);

    const c = document.getElementById('tlContainer');
    if (!c) return;

    if (!filtered.length && !tlLoading) {
        c.innerHTML = '<div class="empty-msg">No timeline events match your filter.</div>';
        return;
    }

    const prevScrollTop = c.scrollTop;
    let html = buildTimelineHtml(filtered);

    if (tlHasMore) {
        html += '<div id="tlSentinel" style="height:40px;display:flex;align-items:center;justify-content:center;">'
              + '<span style="font-size:11px;color:var(--tx3);">Loading more…</span></div>';
    }

    c.innerHTML = html;
    if (prevScrollTop > 0) c.scrollTop = prevScrollTop;

    if (tlHasMore) setupTlObserver(c);

    // Scroll to and highlight a specific card if requested (e.g. from friend detail preview).
    // Only consume _tlScrollTarget if the card is actually in the newly-built DOM.
    if (_tlScrollTarget) {
        const probe = c.querySelector('[data-tlid="' + _tlScrollTarget + '"]');
        if (probe) {
            const target = _tlScrollTarget;
            _tlScrollTarget = null;
            setTimeout(() => {
                const card = c.querySelector('[data-tlid="' + target + '"]');
                if (card) {
                    card.scrollIntoView({ behavior: 'instant', block: 'center' });
                    card.classList.add('tl-card-highlight');
                    setTimeout(() => card.classList.remove('tl-card-highlight'), 2000);
                }
            }, 50);
        }
    }
}

function _renderTlSearchResults(search) {
    const c = document.getElementById('tlContainer');
    if (!c) return;

    // Apply type filter client-side on the server results
    let events = _tlSearchEvents;
    if (tlFilter !== 'all') events = events.filter(e => e.type === tlFilter);

    if (!events.length) {
        c.innerHTML = `<div class="empty-msg">No results for "<b>${esc(search)}</b>".</div>`;
        return;
    }

    const banner = `<div style="padding:6px 12px;font-size:11px;color:var(--tx3);border-bottom:1px solid var(--brd);">`
        + `${events.length} result${events.length !== 1 ? 's' : ''} for "<b>${esc(search)}</b>"</div>`;
    c.innerHTML = banner + buildTimelineHtml(events);
}

// Called when backend delivers search results
function handleTlSearchResults(payload) {
    const q = (payload.query || '').toLowerCase().trim();
    // Ignore stale responses: user has already typed something different or changed the date
    const currentSearch = (document.getElementById('tlSearchInput')?.value ?? '').toLowerCase().trim();
    if (q !== currentSearch) return;
    if ((payload.date || '') !== tlDateFilter) return;
    _tlSearchMode   = true;
    _tlSearchQuery  = q;
    _tlSearchDate   = payload.date || '';
    _tlSearchEvents = payload.events || [];
    filterTimeline();
}

// Personal Timeline pagination helpers

function loadMoreTimeline() {
    if (tlLoading || !tlHasMore) return;
    tlLoading = true;
    sendToCS({ action: 'getTimelinePage', offset: tlOffset });
}

function setupTlObserver(container) {
    disconnectTlObserver();
    const sentinel = document.getElementById('tlSentinel');
    if (!sentinel) return;
    tlObserver = new IntersectionObserver(entries => {
        if (entries[0].isIntersecting && !tlLoading && tlHasMore) loadMoreTimeline();
    }, { root: container, threshold: 0.1 });
    tlObserver.observe(sentinel);
}

function disconnectTlObserver() {
    if (tlObserver) { tlObserver.disconnect(); tlObserver = null; }
}

// Date filter

let _dpYear = 0, _dpMonth = 0; // currently rendered calendar month

function toggleTlDatePicker() {
    const picker = document.getElementById('tlDatePicker');
    if (!picker) return;
    if (picker.style.display !== 'none') { picker.style.display = 'none'; return; }

    const btn = document.getElementById('tlDateBtn');
    const rect = btn.getBoundingClientRect();

    // Init calendar to selected date or today
    const base = tlDateFilter ? new Date(tlDateFilter + 'T00:00:00') : new Date();
    _dpYear  = base.getFullYear();
    _dpMonth = base.getMonth();
    renderDatePickerCalendar();

    picker.style.display = '';
    // Position below (or above if not enough room)
    const ph = picker.offsetHeight || 290;
    const top = rect.bottom + 6 + ph > window.innerHeight ? rect.top - ph - 6 : rect.bottom + 6;
    picker.style.top  = Math.max(6, top) + 'px';
    picker.style.left = Math.min(rect.left, window.innerWidth - 268) + 'px';

    // Close on outside click
    setTimeout(() => document.addEventListener('click', _closeDpOutside), 0);
}

function _closeDpOutside(e) {
    const picker = document.getElementById('tlDatePicker');
    const btn    = document.getElementById('tlDateBtn');
    if (!picker) return;
    if (!picker.contains(e.target) && e.target !== btn && !btn.contains(e.target)) {
        picker.style.display = 'none';
        document.removeEventListener('click', _closeDpOutside);
    } else {
        // Re-attach for next click
        setTimeout(() => document.addEventListener('click', _closeDpOutside), 0);
    }
}

function renderDatePickerCalendar() {
    const monthNames = ['January','February','March','April','May','June',
                        'July','August','September','October','November','December'];
    const label = document.getElementById('tlDpMonthLabel');
    const grid  = document.getElementById('tlDpDaysGrid');
    if (!label || !grid) return;

    label.textContent = monthNames[_dpMonth] + ' ' + _dpYear;

    const today    = new Date();
    const todayStr = _dpFmt(today.getFullYear(), today.getMonth(), today.getDate());
    const selStr   = tlDateFilter || '';

    const firstDow      = new Date(_dpYear, _dpMonth, 1).getDay();     // 0=Sun
    const daysInMonth   = new Date(_dpYear, _dpMonth + 1, 0).getDate();
    const daysInPrevMo  = new Date(_dpYear, _dpMonth, 0).getDate();

    let html = '';
    // Leading prev-month days
    for (let i = firstDow - 1; i >= 0; i--) {
        const d   = daysInPrevMo - i;
        const ds  = _dpFmt(_dpYear, _dpMonth - 1, d);
        html += `<button class="tl-dp-day other-month${ds === selStr ? ' selected' : ''}" onclick="selectDpDate('${ds}')">${d}</button>`;
    }
    // Current month
    for (let d = 1; d <= daysInMonth; d++) {
        const ds  = _dpFmt(_dpYear, _dpMonth, d);
        const cls = (ds === todayStr ? ' today' : '') + (ds === selStr ? ' selected' : '');
        html += `<button class="tl-dp-day${cls}" onclick="selectDpDate('${ds}')">${d}</button>`;
    }
    // Trailing next-month days
    const used      = firstDow + daysInMonth;
    const remaining = used % 7 === 0 ? 0 : 7 - (used % 7);
    for (let d = 1; d <= remaining; d++) {
        const ds  = _dpFmt(_dpYear, _dpMonth + 1, d);
        html += `<button class="tl-dp-day other-month${ds === selStr ? ' selected' : ''}" onclick="selectDpDate('${ds}')">${d}</button>`;
    }
    grid.innerHTML = html;
}

function _dpFmt(year, month, day) {
    const d = new Date(year, month, day);
    return d.getFullYear() + '-'
        + String(d.getMonth() + 1).padStart(2, '0') + '-'
        + String(d.getDate()).padStart(2, '0');
}

function dpNavMonth(dir) {
    _dpMonth += dir;
    if (_dpMonth < 0)  { _dpMonth = 11; _dpYear--; }
    if (_dpMonth > 11) { _dpMonth = 0;  _dpYear++; }
    renderDatePickerCalendar();
}

function selectDpDate(dateStr) {
    document.getElementById('tlDatePicker').style.display = 'none';
    document.removeEventListener('click', _closeDpOutside);
    applyTlDateFilter(dateStr);
}

function dpSelectToday() {
    const t = new Date();
    selectDpDate(_dpFmt(t.getFullYear(), t.getMonth(), t.getDate()));
}

function dpClear() {
    document.getElementById('tlDatePicker').style.display = 'none';
    document.removeEventListener('click', _closeDpOutside);
    clearTlDateFilter();
}

function applyTlDateFilter(dateStr) {
    if (!dateStr) { clearTlDateFilter(); return; }
    tlDateFilter = dateStr;

    const label = document.getElementById('tlDateLabel');
    const clear = document.getElementById('tlDateClear');
    const btn   = document.getElementById('tlDateBtn');
    if (label) {
        const d = new Date(dateStr + 'T00:00:00');
        label.textContent = d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
        label.style.display = '';
    }
    if (clear) clear.style.display = '';
    if (btn)   btn.classList.add('dp-active');

    // Reset state and reload for current mode
    if (tlMode === 'friends') {
        friendTimelineEvents = [];
        ftlOffset = 0; ftlHasMore = false; ftlLoading = false;
        disconnectFtlObserver();
        const c = document.getElementById('tlContainer');
        if (c) c.innerHTML = '<div class="tl-loading"><div class="tl-sk-line"></div><div class="tl-sk-line tl-sk-short"></div><div class="tl-sk-line"></div><div class="tl-sk-line tl-sk-short"></div><div class="tl-sk-line"></div></div>';
        sendToCS({ action: 'getFriendTimelineByDate', date: dateStr, type: ftFilter === 'all' ? '' : ftFilter });
    } else {
        timelineEvents = [];
        tlOffset = 0; tlHasMore = false; tlLoading = false;
        disconnectTlObserver();
        const c = document.getElementById('tlContainer');
        if (c) c.innerHTML = '<div class="tl-loading"><div class="tl-sk-line"></div><div class="tl-sk-line tl-sk-short"></div><div class="tl-sk-line"></div><div class="tl-sk-line tl-sk-short"></div><div class="tl-sk-line"></div></div>';
        sendToCS({ action: 'getTimelineByDate', date: dateStr });
    }
}

function clearTlDateFilter() {
    tlDateFilter = '';
    const label = document.getElementById('tlDateLabel');
    const clear = document.getElementById('tlDateClear');
    const btn   = document.getElementById('tlDateBtn');
    if (label) { label.textContent = ''; label.style.display = 'none'; }
    if (clear) clear.style.display = 'none';
    if (btn)   btn.classList.remove('dp-active');
    refreshTimeline();
}

// Rendering helpers

function tlSearchable(e) {
    return [
        e.worldName, e.userName, e.senderName, e.notifType,
        NOTIF_TYPE_LABELS[e.notifType],
        e.message,
        e.photoPath ? e.photoPath.split(/[\\/]/).pop() : '',
        ...(e.players || []).map(p => p.displayName),
    ].filter(Boolean).join(' ').toLowerCase();
}

function buildTimelineHtml(events) {
    // Group by local date
    const byDate = {};
    events.forEach(e => {
        const d   = new Date(e.timestamp);
        const key = d.toLocaleDateString('en-US', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' });
        if (!byDate[key]) byDate[key] = [];
        byDate[key].push(e);
    });

    let html = '<div class="tl-wrap">';
    let cardIdx = 0;

    Object.entries(byDate).forEach(([date, evs]) => {
        html += `<div class="tl-date-sep"><span class="tl-date-label">${esc(date)}</span></div>`;
        evs.forEach(e => {
            const side = cardIdx % 2 === 0 ? 'left' : 'right';
            html += renderTlRow(e, side);
            cardIdx++;
        });
    });

    html += '</div>';
    return html;
}

function renderTlRow(ev, side) {
    const color   = TL_TYPE_COLOR[ev.type]  ?? 'var(--tx3)';
    const cardHtml = renderTlCard(ev);
    const dotHtml  = `<div class="tl-dot" style="background:${color}"></div>`;

    if (side === 'left') {
        return `<div class="tl-row">
            <div class="tl-card-side tl-side-left">${cardHtml}</div>
            <div class="tl-center-col">${dotHtml}</div>
            <div class="tl-card-side tl-side-right"></div>
        </div>`;
    }
    return `<div class="tl-row">
        <div class="tl-card-side tl-side-left"></div>
        <div class="tl-center-col">${dotHtml}</div>
        <div class="tl-card-side tl-side-right">${cardHtml}</div>
    </div>`;
}

function renderTlCard(ev) {
    const d     = new Date(ev.timestamp);
    const time  = d.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' });
    const date  = d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
    const meta  = TL_TYPE_META[ev.type] ?? { icon: 'circle', label: ev.type };
    const color = TL_TYPE_COLOR[ev.type] ?? 'var(--tx3)';
    const ei    = jsq(ev.id);

    const header = `<div class="tl-card-header">
        <span class="msi tl-type-icon" style="color:${color}">${meta.icon}</span>
        <span class="tl-type-label">${esc(meta.label)}</span>
        <div class="tl-time-col"><span class="tl-time">${esc(time)}</span><span class="tl-date">${esc(date)}</span></div>
    </div>`;

    let body = '';
    switch (ev.type) {
        case 'instance_join': body = renderTlJoinBody(ev);      break;
        case 'photo':         body = renderTlPhotoBody(ev);     break;
        case 'first_meet':    body = renderTlMeetBody(ev);      break;
        case 'meet_again':    body = renderTlMeetAgainBody(ev); break;
        case 'notification':  body = renderTlNotifBody(ev);     break;
    }

    return `<div class="tl-card" data-tlid="${esc(ev.id)}" onclick="openTlDetail('${ei}')">${header}${body}</div>`;
}

// Card bodies

function renderTlJoinBody(ev) {
    const thumb = ev.worldThumb
        ? `<div class="tl-thumb" style="background-image:url('${cssUrl(ev.worldThumb)}')"></div>`
        : `<div class="tl-thumb tl-thumb-empty"><span class="msi" style="font-size:18px;color:var(--tx3);">travel_explore</span></div>`;
    const name  = ev.worldName || ev.worldId || 'Unknown World';
    const cnt   = (ev.players || []).length;
    const avs   = tlPlayerAvatars(ev.players, 3);
    const more  = cnt > 3 ? `<span class="tl-player-more">+${cnt - 3}</span>` : '';
    const bottom = cnt > 0
        ? `<div class="tl-player-row">${avs}${more}<span class="tl-player-label">${cnt} player${cnt !== 1 ? 's' : ''}</span></div>`
        : `<div class="tl-no-players">No player data yet</div>`;
    return `<div class="tl-card-body">${thumb}<div class="tl-card-info"><div class="tl-main-label">${esc(name)}</div>${bottom}</div></div>`;
}

function renderTlPhotoBody(ev) {
    const thumb = ev.photoUrl
        ? `<div class="tl-thumb tl-thumb-photo" style="background-image:url('${cssUrl(ev.photoUrl)}')"></div>`
        : `<div class="tl-thumb tl-thumb-empty"><span class="msi" style="font-size:18px;color:var(--tx3);">camera</span></div>`;
    const name   = ev.photoPath ? ev.photoPath.split(/[\\/]/).pop() : 'Photo';
    const sub    = ev.worldName ? `<div class="tl-sub-label">${esc(ev.worldName)}</div>` : '';
    const cnt    = (ev.players || []).length;
    const avs    = tlPlayerAvatars(ev.players, 3);
    const more   = cnt > 3 ? `<span class="tl-player-more">+${cnt - 3}</span>` : '';
    const bottom = cnt > 0
        ? `<div class="tl-player-row">${avs}${more}<span class="tl-player-label">${cnt} player${cnt !== 1 ? 's' : ''}</span></div>`
        : `<div class="tl-no-players">No player data yet</div>`;
    return `<div class="tl-card-body">${thumb}<div class="tl-card-info"><div class="tl-main-label">${esc(name)}</div>${sub}${bottom}</div></div>`;
}

function renderTlMeetBody(ev) {
    const av   = ev.userImage
        ? `<div class="tl-av" style="background-image:url('${cssUrl(ev.userImage)}')"></div>`
        : `<div class="tl-av tl-av-letter">${esc((ev.userName || '?')[0].toUpperCase())}</div>`;
    const sub  = ev.worldName ? `<div class="tl-sub-label">${esc(ev.worldName)}</div>` : '';
    return `<div class="tl-card-body">${av}<div class="tl-card-info"><div class="tl-main-label">${esc(ev.userName || 'Unknown')}</div>${sub}</div></div>`;
}

function renderTlMeetAgainBody(ev) {
    const av  = ev.userImage
        ? `<div class="tl-av" style="background-image:url('${cssUrl(ev.userImage)}')"></div>`
        : `<div class="tl-av tl-av-letter">${esc((ev.userName || '?')[0].toUpperCase())}</div>`;
    const sub = ev.worldName ? `<div class="tl-sub-label">${esc(ev.worldName)}</div>` : '';
    return `<div class="tl-card-body">${av}<div class="tl-card-info"><div class="tl-main-label">${esc(ev.userName || 'Unknown')}</div>${sub}</div></div>`;
}

function renderTlNotifBody(ev) {
    const typeLabel = NOTIF_TYPE_LABELS[ev.notifType] || ev.notifType || 'Notification';
    const av  = ev.senderImage
        ? `<div class="tl-av" style="background-image:url('${cssUrl(ev.senderImage)}')"></div>`
        : `<div class="tl-av tl-av-letter">${esc((ev.senderName || '?')[0].toUpperCase())}</div>`;
    const sub = ev.message ? `<div class="tl-sub-label">${esc(ev.message.slice(0, 70))}${ev.message.length > 70 ? '…' : ''}</div>` : '';
    return `<div class="tl-card-body">${av}<div class="tl-card-info"><div class="tl-main-label">${esc(ev.senderName || 'Unknown')}</div><div class="tl-type-chip">${esc(typeLabel)}</div>${sub}</div></div>`;
}

function tlPlayerAvatars(players, max) {
    return (players || []).slice(0, max).map(p => {
        return p.image
            ? `<div class="tl-player-av" style="background-image:url('${cssUrl(p.image)}')" title="${esc(p.displayName)}"></div>`
            : `<div class="tl-player-av tl-player-av-letter" title="${esc(p.displayName)}">${esc((p.displayName || '?')[0].toUpperCase())}</div>`;
    }).join('');
}

// Detail modals (reuses #modalDetail / #detailModalContent)

function openTlDetail(id) {
    const ev = timelineEvents.find(e => e.id === id)
             || _tlSearchEvents.find(e => e.id === id);
    if (!ev) return;
    const el = document.getElementById('detailModalContent');
    if (!el) return;

    switch (ev.type) {
        case 'instance_join': renderTlDetailJoin(ev, el);      break;
        case 'photo':         renderTlDetailPhoto(ev, el);     break;
        case 'first_meet':    renderTlDetailMeet(ev, el);      break;
        case 'meet_again':    renderTlDetailMeetAgain(ev, el); break;
        case 'notification':  renderTlDetailNotif(ev, el);     break;
    }

    document.getElementById('modalDetail').style.display = 'flex';
}

// Navigate to a specific event in the Timeline tab
function navigateToTlEvent(id) {
    if (!id) return;
    // Set the scroll target BEFORE switching tabs. filterTimeline() will consume it
    // once the cards are actually in the DOM (after C# responds to getTimeline).
    _tlScrollTarget = id;
    // Reset filter button state silently (don't call filterTimeline() yet, that
    // would consume _tlScrollTarget before the tab has rendered its cards)
    tlFilter = 'all';
    tlMode = 'personal';
    document.querySelectorAll('#tlPersonalFilters .sub-tab-btn').forEach(b => b.classList.remove('active'));
    document.getElementById('tlModePersonal')?.classList.add('active');
    document.getElementById('tlModeFriends')?.classList.remove('active');
    const pf = document.getElementById('tlPersonalFilters');
    const ff = document.getElementById('tlFriendsFilters');
    if (pf) pf.style.display = '';
    if (ff) ff.style.display = 'none';
    const allBtn = document.getElementById(TL_FILTER_IDS['all']);
    if (allBtn) allBtn.classList.add('active');
    // Switch to Tab 12 -> refreshTimeline() -> C# sends timelineData -> renderTimeline()
    // -> filterTimeline() -> _tlScrollTarget consumed there
    showTab(12);
}

// Detail: instance join

function renderTlDetailJoin(ev, el) {
    const d       = new Date(ev.timestamp);
    const dateStr = d.toLocaleDateString('en-US', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' });
    const timeStr = d.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' });
    const banner  = ev.worldThumb
        ? `<div class="fd-banner"><img src="${ev.worldThumb}" onerror="this.parentElement.style.display='none'"><div class="fd-banner-fade"></div></div>`
        : '';
    const players = ev.players || [];

    let playersHtml = '';
    if (players.length > 0) {
        playersHtml = `<div class="tl-detail-sect">PLAYERS IN INSTANCE (${players.length})</div><div class="photo-players-list">`;
        players.forEach(p => {
            const onclick = p.userId ? `document.getElementById('modalDetail').style.display='none';openFriendDetail('${jsq(p.userId)}')` : '';
            playersHtml += renderProfileItemSmall({ id: p.userId, displayName: p.displayName, image: p.image }, onclick);
        });
        playersHtml += '</div>';
    }

    const worldClick = ev.worldId
        ? ` style="cursor:pointer;" onclick="document.getElementById('modalDetail').style.display='none';openWorldSearchDetail('${esc(ev.worldId)}')"` : '';

    el.innerHTML = `${banner}<div class="fd-content${banner ? ' fd-has-banner' : ''}" style="padding:20px;">
        <h2 style="margin:0 0 12px;color:var(--tx0);font-size:16px;">${esc(ev.worldName || ev.worldId || 'Unknown World')}</h2>
        <div class="fd-meta">
            <div class="fd-meta-row"><span class="fd-meta-label">Date</span><span>${esc(dateStr)}</span></div>
            <div class="fd-meta-row"><span class="fd-meta-label">Time</span><span>${esc(timeStr)}</span></div>
            ${ev.worldId ? `<div class="fd-meta-row"${worldClick}><span class="fd-meta-label">World</span><span style="color:var(--accent-lt);">${esc(ev.worldName || ev.worldId)}</span></div>` : ''}
        </div>
        ${playersHtml}
        <div style="margin-top:14px;text-align:right;">
            <button class="fd-btn" onclick="document.getElementById('modalDetail').style.display='none'">Close</button>
        </div>
    </div>`;
}

// Detail: photo

function renderTlDetailPhoto(ev, el) {
    const d       = new Date(ev.timestamp);
    const dateStr = d.toLocaleDateString('en-US', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' });
    const timeStr = d.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' });
    const photoJs = ev.photoUrl ? jsq(ev.photoUrl) : '';
    const banner  = ev.photoUrl
        ? `<div class="fd-banner" style="cursor:pointer;" onclick="openLightbox('${photoJs}','image')"><img src="${ev.photoUrl}" onerror="this.parentElement.style.display='none'"><div class="fd-banner-fade"></div></div>`
        : '';
    const fileName = ev.photoPath ? ev.photoPath.split(/[\\/]/).pop() : 'Photo';
    const players  = ev.players || [];

    let playersHtml = '';
    if (players.length > 0) {
        playersHtml = `<div class="tl-detail-sect">PLAYERS IN INSTANCE (${players.length})</div><div class="photo-players-list">`;
        players.forEach(p => {
            const onclick = p.userId ? `document.getElementById('modalDetail').style.display='none';openFriendDetail('${jsq(p.userId)}')` : '';
            playersHtml += renderProfileItemSmall({ id: p.userId, displayName: p.displayName, image: p.image }, onclick);
        });
        playersHtml += '</div>';
    }

    const worldClick = ev.worldId
        ? ` style="cursor:pointer;" onclick="document.getElementById('modalDetail').style.display='none';openWorldSearchDetail('${esc(ev.worldId)}')"` : '';

    el.innerHTML = `${banner}<div class="fd-content${banner ? ' fd-has-banner' : ''}" style="padding:20px;">
        <h2 style="margin:0 0 12px;color:var(--tx0);font-size:16px;">${esc(fileName)}</h2>
        <div class="fd-meta">
            <div class="fd-meta-row"><span class="fd-meta-label">Date</span><span>${esc(dateStr)}</span></div>
            <div class="fd-meta-row"><span class="fd-meta-label">Time</span><span>${esc(timeStr)}</span></div>
            ${ev.worldId ? `<div class="fd-meta-row"${worldClick}><span class="fd-meta-label">World</span><span style="color:var(--accent-lt);">${esc(ev.worldName || ev.worldId)}</span></div>` : ''}
        </div>
        ${playersHtml}
        <div style="margin-top:14px;display:flex;gap:8px;justify-content:flex-end;">
            ${ev.photoUrl ? `<button class="fd-btn fd-btn-join" onclick="openLightbox('${photoJs}','image')"><span class="msi" style="font-size:14px;">open_in_full</span> Full Size</button>` : ''}
            <button class="fd-btn" onclick="document.getElementById('modalDetail').style.display='none'">Close</button>
        </div>
    </div>`;
}

// Detail: first meet

function renderTlDetailMeet(ev, el) {
    const d       = new Date(ev.timestamp);
    const dateStr = d.toLocaleDateString('en-US', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' });
    const timeStr = d.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' });
    const av      = ev.userImage
        ? `<div class="tl-detail-av" style="background-image:url('${cssUrl(ev.userImage)}')"></div>`
        : `<div class="tl-detail-av tl-detail-av-letter">${esc((ev.userName || '?')[0].toUpperCase())}</div>`;

    const worldClickMeet = ev.worldId ? ` style="cursor:pointer;" onclick="document.getElementById('modalDetail').style.display='none';openWorldSearchDetail('${esc(ev.worldId)}')"` : '';
    el.innerHTML = `<div class="fd-content" style="padding:20px;">
        <div style="display:flex;gap:16px;align-items:center;margin-bottom:20px;">
            ${av}
            <div>
                <h2 style="margin:0 0 4px;color:var(--tx0);font-size:18px;">${esc(ev.userName || 'Unknown')}</h2>
                <div style="font-size:11px;color:var(--cyan);font-weight:700;letter-spacing:.05em;">FIRST MEET</div>
            </div>
        </div>
        <div class="fd-meta">
            <div class="fd-meta-row"><span class="fd-meta-label">Date</span><span>${esc(dateStr)}</span></div>
            <div class="fd-meta-row"><span class="fd-meta-label">Time</span><span>${esc(timeStr)}</span></div>
            ${ev.worldId ? `<div class="fd-meta-row"${worldClickMeet}><span class="fd-meta-label">World</span><span style="color:var(--accent-lt);">${esc(ev.worldName || ev.worldId)}</span></div>` : ''}
        </div>
        <div style="margin-top:14px;display:flex;gap:8px;justify-content:flex-end;">
            ${ev.userId ? `<button class="fd-btn fd-btn-join" onclick="document.getElementById('modalDetail').style.display='none';openFriendDetail('${esc(ev.userId)}')">View Profile</button>` : ''}
            <button class="fd-btn" onclick="document.getElementById('modalDetail').style.display='none'">Close</button>
        </div>
    </div>`;
}

// Detail: meet again

function renderTlDetailMeetAgain(ev, el) {
    const d       = new Date(ev.timestamp);
    const dateStr = d.toLocaleDateString('en-US', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' });
    const timeStr = d.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' });
    const av      = ev.userImage
        ? `<div class="tl-detail-av" style="background-image:url('${cssUrl(ev.userImage)}')"></div>`
        : `<div class="tl-detail-av tl-detail-av-letter">${esc((ev.userName || '?')[0].toUpperCase())}</div>`;

    const worldClickAgain = ev.worldId ? ` style="cursor:pointer;" onclick="document.getElementById('modalDetail').style.display='none';openWorldSearchDetail('${esc(ev.worldId)}')"` : '';
    el.innerHTML = `<div class="fd-content" style="padding:20px;">
        <div style="display:flex;gap:16px;align-items:center;margin-bottom:20px;">
            ${av}
            <div>
                <h2 style="margin:0 0 4px;color:var(--tx0);font-size:18px;">${esc(ev.userName || 'Unknown')}</h2>
                <div style="font-size:11px;color:#AB47BC;font-weight:700;letter-spacing:.05em;">MET AGAIN</div>
            </div>
        </div>
        <div class="fd-meta">
            <div class="fd-meta-row"><span class="fd-meta-label">Date</span><span>${esc(dateStr)}</span></div>
            <div class="fd-meta-row"><span class="fd-meta-label">Time</span><span>${esc(timeStr)}</span></div>
            ${ev.worldId ? `<div class="fd-meta-row"${worldClickAgain}><span class="fd-meta-label">World</span><span style="color:var(--accent-lt);">${esc(ev.worldName || ev.worldId)}</span></div>` : ''}
        </div>
        <div style="margin-top:14px;display:flex;gap:8px;justify-content:flex-end;">
            ${ev.userId ? `<button class="fd-btn fd-btn-join" onclick="document.getElementById('modalDetail').style.display='none';openFriendDetail('${esc(ev.userId)}')">View Profile</button>` : ''}
            <button class="fd-btn" onclick="document.getElementById('modalDetail').style.display='none'">Close</button>
        </div>
    </div>`;
}

// Detail: notification

function renderTlDetailNotif(ev, el) {
    const d         = new Date(ev.timestamp);
    const dateStr   = d.toLocaleDateString('en-US', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' });
    const timeStr   = d.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' });
    const typeLabel = NOTIF_TYPE_LABELS[ev.notifType] || ev.notifType || 'Notification';
    const av        = ev.senderImage
        ? `<div class="tl-detail-av" style="background-image:url('${cssUrl(ev.senderImage)}')"></div>`
        : `<div class="tl-detail-av tl-detail-av-letter">${esc((ev.senderName || '?')[0].toUpperCase())}</div>`;

    el.innerHTML = `<div class="fd-content" style="padding:20px;">
        <div style="display:flex;gap:16px;align-items:center;margin-bottom:20px;">
            ${av}
            <div>
                <h2 style="margin:0 0 4px;color:var(--tx0);font-size:18px;">${esc(ev.senderName || 'Unknown')}</h2>
                <div style="font-size:11px;color:var(--warn);font-weight:700;letter-spacing:.05em;">${esc(typeLabel.toUpperCase())}</div>
            </div>
        </div>
        <div class="fd-meta">
            <div class="fd-meta-row"><span class="fd-meta-label">Date</span><span>${esc(dateStr)}</span></div>
            <div class="fd-meta-row"><span class="fd-meta-label">Time</span><span>${esc(timeStr)}</span></div>
            <div class="fd-meta-row"><span class="fd-meta-label">Type</span><span>${esc(typeLabel)}</span></div>
            ${ev.message ? `<div class="fd-meta-row"><span class="fd-meta-label">Message</span><span>${esc(ev.message)}</span></div>` : ''}
        </div>
        <div style="margin-top:14px;display:flex;gap:8px;justify-content:flex-end;">
            ${ev.senderId ? `<button class="fd-btn fd-btn-join" onclick="document.getElementById('modalDetail').style.display='none';openFriendDetail('${esc(ev.senderId)}')">View Profile</button>` : ''}
            <button class="fd-btn" onclick="document.getElementById('modalDetail').style.display='none'">Close</button>
        </div>
    </div>`;
}

// === Friends Timeline ===

const FT_FILTER_IDS = {
    all:               'ftFAll',
    friend_gps:        'ftFGps',
    friend_status:     'ftFStatus',
    friend_statusdesc: 'ftFStatusDesc',
    friend_online:     'ftFOnline',
    friend_offline:    'ftFOffline',
    friend_bio:        'ftFBio',
};

const FT_TYPE_COLOR = {
    friend_gps:        'var(--accent)',
    friend_status:     'var(--cyan)',
    friend_statusdesc: 'var(--cyan)',
    friend_online:     'var(--ok)',
    friend_offline:    'var(--tx3)',
    friend_bio:        '#AB47BC',
};

const FT_TYPE_META = {
    friend_gps:        { icon: 'location_on',       label: 'Location'    },
    friend_status:     { icon: 'circle',             label: 'Status'      },
    friend_statusdesc: { icon: 'chat_bubble_outline', label: 'Status Text' },
    friend_online:     { icon: 'login',              label: 'Online'      },
    friend_offline:    { icon: 'power_settings_new', label: 'Offline'     },
    friend_bio:        { icon: 'edit_note',          label: 'Bio Change'  },
};

const STATUS_COLORS = {
    'join me': 'var(--accent)',
    'active':  'var(--ok)',
    'ask me':  'var(--warn)',
    'busy':    'var(--err)',
    'offline': 'var(--tx3)',
};

function statusCssClass(s) {
    return (s || '').toLowerCase().replace(/\s+/g, '-');
}

// Public API

function refreshFriendTimeline() {
    friendTimelineEvents = [];
    ftlOffset  = 0;
    ftlHasMore = false;
    ftlLoading = false;
    const activeSearch = (document.getElementById('tlSearchInput')?.value ?? '').trim();
    disconnectFtlObserver();
    const c = document.getElementById('tlContainer');
    if (c && !(_ftlSearchMode && activeSearch)) {
        c.innerHTML = '<div class="tl-loading"><div class="tl-sk-line"></div><div class="tl-sk-line tl-sk-short"></div><div class="tl-sk-line"></div><div class="tl-sk-line tl-sk-short"></div><div class="tl-sk-line"></div></div>';
    }
    if (tlDateFilter) sendToCS({ action: 'getFriendTimelineByDate', date: tlDateFilter, type: ftFilter === 'all' ? '' : ftFilter });
    else              sendToCS({ action: 'getFriendTimeline', type: ftFilter === 'all' ? '' : ftFilter });
}

function renderFriendTimeline(payload) {
    const events  = Array.isArray(payload) ? payload : (payload?.events  ?? []);
    const hasMore = Array.isArray(payload) ? false   : (payload?.hasMore ?? false);
    const offset  = Array.isArray(payload) ? 0       : (payload?.offset  ?? 0);

    if (offset === 0) {
        friendTimelineEvents = events;
    } else {
        friendTimelineEvents = friendTimelineEvents.concat(events);
    }
    ftlOffset  = offset + events.length;
    ftlHasMore = hasMore;
    ftlLoading = false;
    filterFriendTimeline();
}

function handleFriendTimelineEvent(ev) {
    if (!ev || !ev.id) return;
    const idx = friendTimelineEvents.findIndex(e => e.id === ev.id);
    if (idx >= 0) friendTimelineEvents[idx] = ev;
    else friendTimelineEvents.unshift(ev);
    friendTimelineEvents.sort((a, b) => b.timestamp.localeCompare(a.timestamp));
    if (tlMode === 'friends') filterFriendTimeline();
}

function setFtFilter(f) {
    ftFilter = f;
    document.querySelectorAll('#tlFriendsFilters .sub-tab-btn').forEach(b => b.classList.remove('active'));
    const btn = document.getElementById(FT_FILTER_IDS[f]);
    if (btn) btn.classList.add('active');
    // Reset pagination and reload from server with new type filter
    friendTimelineEvents = [];
    ftlOffset  = 0;
    ftlHasMore = false;
    ftlLoading = false;
    disconnectFtlObserver();
    const c = document.getElementById('tlContainer');
    if (c) c.innerHTML = '<div class="tl-loading"><div class="tl-sk-line"></div><div class="tl-sk-line tl-sk-short"></div><div class="tl-sk-line"></div><div class="tl-sk-line tl-sk-short"></div><div class="tl-sk-line"></div></div>';
    if (tlDateFilter) sendToCS({ action: 'getFriendTimelineByDate', date: tlDateFilter, type: f === 'all' ? '' : f });
    else              sendToCS({ action: 'getFriendTimeline', type: f === 'all' ? '' : f });
}

function filterFriendTimeline() {
    const search = (document.getElementById('tlSearchInput')?.value ?? '').toLowerCase().trim();
    const c = document.getElementById('tlContainer');
    if (!c) return;

    if (search) {
        if (_ftlSearchMode && search === _ftlSearchQuery && tlDateFilter === _ftlSearchDate) {
            _renderFtlSearchResults(search);
            return;
        }
        _ftlSearchMode  = false;
        _ftlSearchQuery = '';
        _ftlSearchDate  = '';
        disconnectFtlObserver();
        c.innerHTML = '<div class="tl-loading"><div class="tl-sk-line"></div><div class="tl-sk-line tl-sk-short"></div><div class="tl-sk-line"></div></div>';
        clearTimeout(_ftlSearchTimer);
        _ftlSearchTimer = setTimeout(() => {
            sendToCS({ action: 'searchFriendTimeline', query: search, date: tlDateFilter });
        }, 300);
        return;
    }

    // No search – clear search mode and show paginated events
    _ftlSearchMode  = false;
    _ftlSearchEvents = [];

    let filtered = ftFilter === 'all'
        ? friendTimelineEvents
        : friendTimelineEvents.filter(e => e.type === ftFilter);

    if (!filtered.length && !ftlLoading) {
        c.innerHTML = '<div class="empty-msg">No friend activity logged yet. Events appear here as friends move, change status, etc.</div>';
        return;
    }

    const prevScrollTop = c.scrollTop;
    let html = buildFriendTimelineHtml(filtered);

    if (ftlHasMore) {
        html += '<div id="ftlSentinel" style="height:40px;display:flex;align-items:center;justify-content:center;">'
              + '<span style="font-size:11px;color:var(--tx3);">Loading more…</span></div>';
    }

    c.innerHTML = html;
    if (prevScrollTop > 0) c.scrollTop = prevScrollTop;

    if (ftlHasMore) setupFtlObserver(c);
}

function _renderFtlSearchResults(search) {
    const c = document.getElementById('tlContainer');
    if (!c) return;

    let events = _ftlSearchEvents;
    if (ftFilter !== 'all') events = events.filter(e => e.type === ftFilter);

    if (!events.length) {
        c.innerHTML = `<div class="empty-msg">No results for "<b>${esc(search)}</b>".</div>`;
        return;
    }

    const banner = `<div style="padding:6px 12px;font-size:11px;color:var(--tx3);border-bottom:1px solid var(--brd);">`
        + `${events.length} result${events.length !== 1 ? 's' : ''} for "<b>${esc(search)}</b>"</div>`;
    c.innerHTML = banner + buildFriendTimelineHtml(events);
}

function handleFtlSearchResults(payload) {
    const q = (payload.query || '').toLowerCase().trim();
    const currentSearch = (document.getElementById('tlSearchInput')?.value ?? '').toLowerCase().trim();
    if (q !== currentSearch) return;
    if ((payload.date || '') !== tlDateFilter) return;
    _ftlSearchMode   = true;
    _ftlSearchQuery  = q;
    _ftlSearchDate   = payload.date || '';
    _ftlSearchEvents = payload.events || [];
    filterFriendTimeline();
}

function ftSearchable(e) {
    return [e.friendName, e.worldName, e.newValue, e.oldValue, e.location]
        .filter(Boolean).join(' ').toLowerCase();
}

// Friends Timeline pagination helpers

function loadMoreFriendTimeline() {
    if (ftlLoading || !ftlHasMore) return;
    ftlLoading = true;
    sendToCS({ action: 'getFriendTimelinePage', offset: ftlOffset, type: ftFilter === 'all' ? '' : ftFilter });
}

function setupFtlObserver(container) {
    disconnectFtlObserver();
    const sentinel = document.getElementById('ftlSentinel');
    if (!sentinel) return;
    ftlObserver = new IntersectionObserver(entries => {
        if (entries[0].isIntersecting && !ftlLoading && ftlHasMore) loadMoreFriendTimeline();
    }, { root: container, threshold: 0.1 });
    ftlObserver.observe(sentinel);
}

function disconnectFtlObserver() {
    if (ftlObserver) { ftlObserver.disconnect(); ftlObserver = null; }
}

// Rendering

function buildFriendTimelineHtml(events) {
    const byDate = {};
    events.forEach(e => {
        const d   = new Date(e.timestamp);
        const key = d.toLocaleDateString('en-US', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' });
        if (!byDate[key]) byDate[key] = [];
        byDate[key].push(e);
    });

    let html = '<div class="tl-wrap">';
    let cardIdx = 0;
    Object.entries(byDate).forEach(([date, evs]) => {
        html += `<div class="tl-date-sep"><span class="tl-date-label">${esc(date)}</span></div>`;
        evs.forEach(e => {
            const side = cardIdx % 2 === 0 ? 'left' : 'right';
            html += renderFtRow(e, side);
            cardIdx++;
        });
    });
    html += '</div>';
    return html;
}

function renderFtRow(ev, side) {
    const color   = FT_TYPE_COLOR[ev.type] ?? 'var(--tx3)';
    const cardHtml = renderFtCard(ev);
    const dotHtml  = `<div class="tl-dot" style="background:${color}"></div>`;

    if (side === 'left') {
        return `<div class="tl-row">
            <div class="tl-card-side tl-side-left">${cardHtml}</div>
            <div class="tl-center-col">${dotHtml}</div>
            <div class="tl-card-side tl-side-right"></div>
        </div>`;
    }
    return `<div class="tl-row">
        <div class="tl-card-side tl-side-left"></div>
        <div class="tl-center-col">${dotHtml}</div>
        <div class="tl-card-side tl-side-right">${cardHtml}</div>
    </div>`;
}

function renderFtCard(ev) {
    const d     = new Date(ev.timestamp);
    const time  = d.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' });
    const date  = d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
    const meta  = FT_TYPE_META[ev.type] ?? { icon: 'circle', label: ev.type };
    const color = FT_TYPE_COLOR[ev.type] ?? 'var(--tx3)';
    const ei    = jsq(ev.id);

    const header = `<div class="tl-card-header">
        <span class="msi tl-type-icon" style="color:${color}">${meta.icon}</span>
        <span class="tl-type-label">${esc(meta.label)}</span>
        <div class="tl-time-col"><span class="tl-time">${esc(time)}</span><span class="tl-date">${esc(date)}</span></div>
    </div>`;

    let body = '';
    switch (ev.type) {
        case 'friend_gps':        body = renderFtGpsBody(ev);        break;
        case 'friend_status':     body = renderFtStatusBody(ev);     break;
        case 'friend_statusdesc': body = renderFtStatusDescBody(ev); break;
        case 'friend_online':     body = renderFtOnlineBody(ev);     break;
        case 'friend_offline':    body = renderFtOfflineBody(ev);    break;
        case 'friend_bio':        body = renderFtBioBody(ev);        break;
    }

    const clickAction = ev.type === 'friend_gps'
        ? `openFtGpsDetail('${ei}')`
        : `openFtDetail('${ei}')`;

    return `<div class="tl-card" data-ftid="${esc(ev.id)}" onclick="${clickAction}">${header}${body}</div>`;
}

// Card bodies

function ftFriendAv(ev, cssClass) {
    return ev.friendImage
        ? `<div class="${cssClass}" style="background-image:url('${cssUrl(ev.friendImage)}')"></div>`
        : `<div class="${cssClass} tl-av-letter">${esc((ev.friendName || '?')[0].toUpperCase())}</div>`;
}

function renderFtGpsBody(ev) {
    const thumb = ev.worldThumb
        ? `<div class="tl-thumb" style="background-image:url('${cssUrl(ev.worldThumb)}')"></div>`
        : `<div class="tl-thumb tl-thumb-empty"><span class="msi" style="font-size:18px;color:var(--tx3);">travel_explore</span></div>`;
    const wname = ev.worldName || ev.worldId || 'Unknown World';
    const av    = ftFriendAv(ev, 'tl-player-av');
    return `<div class="tl-card-body">${thumb}<div class="tl-card-info">
        <div class="tl-main-label">${esc(wname)}</div>
        <div class="tl-player-row">${av}<span class="tl-player-label">${esc(ev.friendName || 'Unknown')}</span></div>
    </div></div>`;
}

function renderFtStatusBody(ev) {
    const av      = ftFriendAv(ev, 'tl-av');
    const oldCls  = statusCssClass(ev.oldValue);
    const newCls  = statusCssClass(ev.newValue);
    const chips   = `<div style="display:flex;align-items:center;gap:6px;margin-top:4px;">
        <span class="ft-status-chip ${oldCls}">${esc(ev.oldValue || '?')}</span>
        <span class="msi" style="font-size:12px;color:var(--tx3);">arrow_forward</span>
        <span class="ft-status-chip ${newCls}">${esc(ev.newValue || '?')}</span>
    </div>`;
    return `<div class="tl-card-body">${av}<div class="tl-card-info">
        <div class="tl-main-label">${esc(ev.friendName || 'Unknown')}</div>${chips}
    </div></div>`;
}

function renderFtOnlineBody(ev) {
    const av = ftFriendAv(ev, 'tl-av');
    return `<div class="tl-card-body">${av}<div class="tl-card-info">
        <div class="tl-main-label">${esc(ev.friendName || 'Unknown')}</div>
        <div class="tl-sub-label" style="color:var(--ok);">Came online</div>
    </div></div>`;
}

function renderFtOfflineBody(ev) {
    const av = ftFriendAv(ev, 'tl-av');
    return `<div class="tl-card-body">${av}<div class="tl-card-info">
        <div class="tl-main-label">${esc(ev.friendName || 'Unknown')}</div>
        <div class="tl-sub-label" style="color:var(--tx3);">Went offline</div>
    </div></div>`;
}

function renderFtStatusDescBody(ev) {
    const av      = ftFriendAv(ev, 'tl-av');
    const preview = (ev.newValue || '').slice(0, 60);
    const ellipsis = (ev.newValue || '').length > 60 ? '...' : '';
    return `<div class="tl-card-body">${av}<div class="tl-card-info">
        <div class="tl-main-label">${esc(ev.friendName || 'Unknown')}</div>
        <div class="tl-sub-label">${esc(preview)}${ellipsis}</div>
    </div></div>`;
}

function renderFtBioBody(ev) {
    const av      = ftFriendAv(ev, 'tl-av');
    const preview = (ev.newValue || '').slice(0, 60);
    const ellipsis = (ev.newValue || '').length > 60 ? '...' : '';
    return `<div class="tl-card-body">${av}<div class="tl-card-info">
        <div class="tl-main-label">${esc(ev.friendName || 'Unknown')}</div>
        <div class="tl-sub-label">${esc(preview)}${ellipsis}</div>
    </div></div>`;
}

// Detail modals

/* === Friend GPS Instance Log Modal === */
function openFtGpsDetail(evId) {
    const ev = friendTimelineEvents.find(e => e.id === evId);
    if (!ev) return;
    renderFtGpsDetailModal(ev);
    document.getElementById('modalFtGpsDetail').style.display = 'flex';
}

function closeFtGpsDetail() {
    document.getElementById('modalFtGpsDetail').style.display = 'none';
}

function switchFtGpsTab(tab) {
    document.getElementById('ftGpsTabInfo').style.display = tab === 'info' ? '' : 'none';
    document.getElementById('ftGpsTabAlso').style.display = tab === 'also' ? '' : 'none';
    document.querySelectorAll('#ftGpsDetailContent .ftgps-tab-btn').forEach(b => b.classList.toggle('active', b.dataset.tab === tab));
}

function renderFtGpsDetailModal(ev) {
    const loc = ev.location || '';
    const { instanceType } = parseFriendLocation(loc);
    const { cls: instCls, label: instLabel } = getInstanceBadge(instanceType);

    const instIdMatch = loc.match(/:(\d+)/);
    const instanceId = instIdMatch ? instIdMatch[1] : '';

    const { dateStr, timeStr } = ftDetailDatetime(ev);

    const banner = ev.worldThumb
        ? `<div class="fd-banner"><img src="${ev.worldThumb}" onerror="this.parentElement.style.display='none'"><div class="fd-banner-fade"></div></div>`
        : '';
    const worldName = ev.worldName || ev.worldId || 'Unknown World';

    // Was Also Here: other friends who were logged in the same instance
    const stripNonce = l => (l || '').replace(/~nonce\([^)]*\)/g, '');
    const evLocStripped = stripNonce(loc);
    const alsoMap = {};
    friendTimelineEvents.forEach(e => {
        if (e.type !== 'friend_gps' || e.id === ev.id || !e.friendId || !e.location) return;
        if (evLocStripped && stripNonce(e.location) === evLocStripped) {
            if (!alsoMap[e.friendId]) alsoMap[e.friendId] = e;
        }
    });
    const alsoList = Object.values(alsoMap);

    const infoHtml = `<div class="fd-meta">
        <div class="fd-meta-row"><span class="fd-meta-label">Date</span><span>${esc(dateStr)}</span></div>
        <div class="fd-meta-row"><span class="fd-meta-label">Time</span><span>${esc(timeStr)}</span></div>
        <div class="fd-meta-row"><span class="fd-meta-label">Instance Type</span><span class="fd-instance-badge ${instCls}">${instLabel}</span></div>
        ${instanceId ? `<div class="fd-meta-row"><span class="fd-meta-label">Instance ID</span><span style="font-family:monospace;font-size:12px;color:var(--tx2);">#${esc(instanceId)}</span></div>` : ''}
        <div class="fd-meta-row"><span class="fd-meta-label">Event</span><span style="color:var(--tx2);">${esc(ev.friendName || 'Unknown')} joined this world</span></div>
    </div>`;

    let alsoHtml;
    if (alsoList.length === 0) {
        alsoHtml = '<div style="font-size:12px;color:var(--tx3);padding:12px 0;">No other friends tracked in this instance.</div>';
    } else {
        alsoHtml = alsoList.map(e => {
            const { timeStr: fTime } = ftDetailDatetime(e);
            return renderProfileItemSmall(
                { id: e.friendId, displayName: e.friendName || 'Unknown', image: e.friendImage, subtitle: fTime || '' },
                `closeFtGpsDetail();openFriendDetail('${jsq(e.friendId)}')`
            );
        }).join('');
    }

    const alsoCount = alsoList.length > 0 ? ` (${alsoList.length})` : '';
    const el = document.getElementById('ftGpsDetailContent');
    el.innerHTML = `${banner}<div class="fd-content${banner ? ' fd-has-banner' : ''}" style="padding:16px;">
        <h2 style="margin:0 0 4px;color:var(--tx0);font-size:18px;">${esc(worldName)}</h2>
        <div style="margin-bottom:12px;">${idBadge(ev.worldId || '')}</div>
        <div class="fd-tabs" style="margin-bottom:14px;">
            <button class="fd-tab active ftgps-tab-btn" data-tab="info" onclick="switchFtGpsTab('info')">Info</button>
            <button class="fd-tab ftgps-tab-btn" data-tab="also" onclick="switchFtGpsTab('also')">Was also here${esc(alsoCount)}</button>
        </div>
        <div id="ftGpsTabInfo">${infoHtml}</div>
        <div id="ftGpsTabAlso" style="display:none;">${alsoHtml}</div>
        <div style="margin-top:14px;display:flex;gap:8px;justify-content:flex-end;">
            ${ev.worldId ? `<button class="fd-btn fd-btn-join" onclick="closeFtGpsDetail();openWorldSearchDetail('${esc(ev.worldId)}')"><span class="msi" style="font-size:14px;">travel_explore</span> Open World</button>` : ''}
            <button class="fd-btn" onclick="closeFtGpsDetail()">Close</button>
        </div>
    </div>`;
}

function openFtDetail(id) {
    const ev = friendTimelineEvents.find(e => e.id === id);
    if (!ev) return;
    const el = document.getElementById('detailModalContent');
    if (!el) return;

    switch (ev.type) {
        case 'friend_gps':        renderFtDetailGps(ev, el);        break;
        case 'friend_status':     renderFtDetailStatus(ev, el);     break;
        case 'friend_statusdesc': renderFtDetailStatusDesc(ev, el); break;
        case 'friend_online':     renderFtDetailOnline(ev, el);     break;
        case 'friend_offline':    renderFtDetailOffline(ev, el);    break;
        case 'friend_bio':        renderFtDetailBio(ev, el);        break;
    }

    document.getElementById('modalDetail').style.display = 'flex';
}

function ftDetailDatetime(ev) {
    const d = new Date(ev.timestamp);
    return {
        dateStr: d.toLocaleDateString('en-US', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' }),
        timeStr: d.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' }),
    };
}

function ftDetailAvRow(ev) {
    const av = ev.friendImage
        ? `<div class="tl-detail-av" style="background-image:url('${cssUrl(ev.friendImage)}')"></div>`
        : `<div class="tl-detail-av tl-detail-av-letter">${esc((ev.friendName || '?')[0].toUpperCase())}</div>`;
    return `<div style="display:flex;gap:16px;align-items:center;margin-bottom:20px;">${av}
        <div><h2 style="margin:0 0 4px;color:var(--tx0);font-size:18px;">${esc(ev.friendName || 'Unknown')}</h2>
        ${ev.friendId ? `<div style="font-size:10px;color:var(--tx3);">${esc(ev.friendId)}</div>` : ''}
        </div></div>`;
}

function ftDetailClose() {
    return `<button class="fd-btn" onclick="document.getElementById('modalDetail').style.display='none'">Close</button>`;
}

function ftDetailViewProfile(ev) {
    return ev.friendId
        ? `<button class="fd-btn fd-btn-join" onclick="document.getElementById('modalDetail').style.display='none';openFriendDetail('${esc(ev.friendId)}')">View Profile</button>`
        : '';
}

function renderFtDetailGps(ev, el) {
    const { dateStr, timeStr } = ftDetailDatetime(ev);
    const banner = ev.worldThumb
        ? `<div class="fd-banner"><img src="${ev.worldThumb}" onerror="this.parentElement.style.display='none'"><div class="fd-banner-fade"></div></div>`
        : '';
    const wname = ev.worldName || ev.worldId || 'Unknown World';
    const worldClick = ev.worldId
        ? ` style="cursor:pointer;" onclick="document.getElementById('modalDetail').style.display='none';openWorldDetail('${esc(ev.worldId)}')"` : '';

    el.innerHTML = `${banner}<div class="fd-content${banner ? ' fd-has-banner' : ''}" style="padding:20px;">
        ${ftDetailAvRow(ev)}
        <div class="fd-meta">
            <div class="fd-meta-row"><span class="fd-meta-label">Date</span><span>${esc(dateStr)}</span></div>
            <div class="fd-meta-row"><span class="fd-meta-label">Time</span><span>${esc(timeStr)}</span></div>
            <div class="fd-meta-row"${worldClick}><span class="fd-meta-label">World</span><span style="color:var(--accent-lt);">${esc(wname)}</span></div>
        </div>
        <div style="margin-top:14px;display:flex;gap:8px;justify-content:flex-end;">
            ${ev.worldId ? `<button class="fd-btn fd-btn-join" onclick="document.getElementById('modalDetail').style.display='none';openWorldDetail('${esc(ev.worldId)}')"><span class="msi" style="font-size:14px;">travel_explore</span> Open World</button>` : ''}
            ${ftDetailViewProfile(ev)}
            ${ftDetailClose()}
        </div>
    </div>`;
}

function renderFtDetailStatus(ev, el) {
    const { dateStr, timeStr } = ftDetailDatetime(ev);
    const oldCls = statusCssClass(ev.oldValue);
    const newCls = statusCssClass(ev.newValue);

    el.innerHTML = `<div class="fd-content" style="padding:20px;">
        ${ftDetailAvRow(ev)}
        <div class="fd-meta">
            <div class="fd-meta-row"><span class="fd-meta-label">Date</span><span>${esc(dateStr)}</span></div>
            <div class="fd-meta-row"><span class="fd-meta-label">Time</span><span>${esc(timeStr)}</span></div>
            <div class="fd-meta-row"><span class="fd-meta-label">Change</span>
                <span style="display:flex;align-items:center;gap:6px;">
                    <span class="ft-status-chip ${oldCls}">${esc(ev.oldValue || '?')}</span>
                    <span class="msi" style="font-size:12px;color:var(--tx3);">arrow_forward</span>
                    <span class="ft-status-chip ${newCls}">${esc(ev.newValue || '?')}</span>
                </span>
            </div>
        </div>
        <div style="margin-top:14px;display:flex;gap:8px;justify-content:flex-end;">
            ${ftDetailViewProfile(ev)}${ftDetailClose()}
        </div>
    </div>`;
}

function renderFtDetailOnline(ev, el) {
    const { dateStr, timeStr } = ftDetailDatetime(ev);
    el.innerHTML = `<div class="fd-content" style="padding:20px;">
        ${ftDetailAvRow(ev)}
        <div class="fd-meta">
            <div class="fd-meta-row"><span class="fd-meta-label">Date</span><span>${esc(dateStr)}</span></div>
            <div class="fd-meta-row"><span class="fd-meta-label">Time</span><span>${esc(timeStr)}</span></div>
            <div class="fd-meta-row"><span class="fd-meta-label">Event</span><span style="color:var(--ok);">Came online</span></div>
        </div>
        <div style="margin-top:14px;display:flex;gap:8px;justify-content:flex-end;">
            ${ftDetailViewProfile(ev)}${ftDetailClose()}
        </div>
    </div>`;
}

function renderFtDetailOffline(ev, el) {
    const { dateStr, timeStr } = ftDetailDatetime(ev);
    el.innerHTML = `<div class="fd-content" style="padding:20px;">
        ${ftDetailAvRow(ev)}
        <div class="fd-meta">
            <div class="fd-meta-row"><span class="fd-meta-label">Date</span><span>${esc(dateStr)}</span></div>
            <div class="fd-meta-row"><span class="fd-meta-label">Time</span><span>${esc(timeStr)}</span></div>
            <div class="fd-meta-row"><span class="fd-meta-label">Event</span><span style="color:var(--tx3);">Went offline</span></div>
        </div>
        <div style="margin-top:14px;display:flex;gap:8px;justify-content:flex-end;">
            ${ftDetailViewProfile(ev)}${ftDetailClose()}
        </div>
    </div>`;
}

function renderFtDetailStatusDesc(ev, el) {
    const { dateStr, timeStr } = ftDetailDatetime(ev);
    el.innerHTML = `<div class="fd-content" style="padding:20px;">
        ${ftDetailAvRow(ev)}
        <div class="fd-meta">
            <div class="fd-meta-row"><span class="fd-meta-label">Date</span><span>${esc(dateStr)}</span></div>
            <div class="fd-meta-row"><span class="fd-meta-label">Time</span><span>${esc(timeStr)}</span></div>
        </div>
        ${ev.oldValue ? `<div style="margin-top:12px;"><div style="font-size:10px;color:var(--tx3);margin-bottom:4px;">PREVIOUS STATUS TEXT</div>
            <div style="font-size:12px;color:var(--tx2);background:var(--bg2);padding:8px 10px;border-radius:6px;">${esc(ev.oldValue)}</div></div>` : ''}
        ${ev.newValue !== undefined ? `<div style="margin-top:10px;"><div style="font-size:10px;color:var(--tx3);margin-bottom:4px;">NEW STATUS TEXT</div>
            <div style="font-size:12px;color:var(--tx1);background:var(--bg2);padding:8px 10px;border-radius:6px;">${esc(ev.newValue) || '<em style="color:var(--tx3)">cleared</em>'}</div></div>` : ''}
        <div style="margin-top:14px;display:flex;gap:8px;justify-content:flex-end;">
            ${ftDetailViewProfile(ev)}${ftDetailClose()}
        </div>
    </div>`;
}

function renderFtDetailBio(ev, el) {
    const { dateStr, timeStr } = ftDetailDatetime(ev);
    el.innerHTML = `<div class="fd-content" style="padding:20px;">
        ${ftDetailAvRow(ev)}
        <div class="fd-meta">
            <div class="fd-meta-row"><span class="fd-meta-label">Date</span><span>${esc(dateStr)}</span></div>
            <div class="fd-meta-row"><span class="fd-meta-label">Time</span><span>${esc(timeStr)}</span></div>
        </div>
        ${ev.oldValue ? `<div style="margin-top:12px;"><div style="font-size:10px;color:var(--tx3);margin-bottom:4px;">PREVIOUS BIO</div>
            <div style="font-size:12px;color:var(--tx2);background:var(--bg2);padding:8px 10px;border-radius:6px;white-space:pre-wrap;">${esc(ev.oldValue)}</div></div>` : ''}
        ${ev.newValue ? `<div style="margin-top:10px;"><div style="font-size:10px;color:var(--tx3);margin-bottom:4px;">NEW BIO</div>
            <div style="font-size:12px;color:var(--tx1);background:var(--bg2);padding:8px 10px;border-radius:6px;white-space:pre-wrap;">${esc(ev.newValue)}</div></div>` : ''}
        <div style="margin-top:14px;display:flex;gap:8px;justify-content:flex-end;">
            ${ftDetailViewProfile(ev)}${ftDetailClose()}
        </div>
    </div>`;
}
