/* Robert Moses Atlas — map + time scrubber. Plain browser JS, no build step. */
(function () {
  'use strict';
  const D = window.ATLAS;
  const [T0, T1] = D.range;
  const events = D.events.slice().sort((a, b) => a.t - b.t);
  const byId = Object.fromEntries(events.map(e => [e.id, e]));
  const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
  const TYPE_COLOR = {
    parkway: '#e2a93d', expressway: '#d9584a', bridge: '#e0865a', park: '#7fb77a', housing: '#b08ad6',
    culture: '#5fb8c4', power: '#7aa7e8', office: '#ece4d0', cost: '#ff5d6c', unbuilt: '#8f8a7f',
  };
  const NYC = [40.72, -73.92];
  const NYC_ZOOM = () => (window.innerWidth < 720 ? 9 : 10);

  // ---------- state ----------
  const S = { t: T0, playing: false, speed: 1, selected: null, lastCurrent: null, raf: 0, lastTs: 0 };

  // ---------- map ----------
  const map = L.map('map', { zoomControl: false, attributionControl: true, worldCopyJump: false, zoomSnap: 0.5 })
    .setView(NYC, NYC_ZOOM());
  // ponytail: Esri's free Dark Gray Canvas; CARTO now watermarks keyless tiles. Upgrade path: a keyed CARTO/Stadia style.
  L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/Canvas/World_Dark_Gray_Base/MapServer/tile/{z}/{y}/{x}', {
    maxZoom: 16,
    attribution: 'Tiles &copy; Esri &mdash; Esri, HERE, Garmin, &copy; OpenStreetMap contributors',
  }).addTo(map);
  const routeLayer = L.layerGroup().addTo(map);
  map.on('zoomend moveend', () => scheduleDeclutter());
  const markerLayer = L.layerGroup().addTo(map);

  const markers = {};
  for (const e of events) {
    const icon = L.divIcon({
      className: 'mk mk-' + e.type, iconSize: [0, 0], iconAnchor: [0, 0],
      html: '<i></i><span class="mk-label">' + escapeHtml(shortTitle(e)) + '</span>',
    });
    const m = L.marker([e.lat, e.lon], { icon, keyboard: false, riseOnHover: true });
    m.bindTooltip(e.title, { className: 'mk-tip', direction: 'top', offset: [0, -10], opacity: 1 });
    m.on('click', () => selectEvent(e.id, { fly: true, pushHash: true }));
    m.addTo(markerLayer);
    markers[e.id] = m;
  }

  const routes = {};
  fetch('routes.json').then(r => (r.ok ? r.json() : null)).then(data => {
    if (!data) return;
    for (const e of events) {
      if (!e.route || !data[e.route]) continue;
      const line = L.polyline(data[e.route], { color: TYPE_COLOR[e.type], weight: 3, opacity: 0, className: 'route', interactive: false });
      line.addTo(routeLayer);
      routes[e.id] = line;
    }
    render();
  }).catch(() => {});

  // ---------- timeline svg ----------
  const svg = document.getElementById('tl-svg');
  const track = document.getElementById('track');
  const NS = 'http://www.w3.org/2000/svg';
  const G = { chapters: null, ticks: null, axis: null, head: null, W: 0, H: 0, pad: 6 };
  const tlEls = { chapters: [], ticks: {} };

  function buildTimeline() {
    const r = track.getBoundingClientRect();
    G.W = Math.max(200, r.width); G.H = Math.max(60, r.height);
    svg.setAttribute('viewBox', `0 0 ${G.W} ${G.H}`);
    svg.innerHTML = '';
    const x = t => G.pad + ((t - T0) / (T1 - T0)) * (G.W - 2 * G.pad);
    G.x = x; G.tOf = px => T0 + ((px - G.pad) / (G.W - 2 * G.pad)) * (T1 - T0);
    const mobile = window.innerWidth < 720;
    const rowChap = 2, chapH = mobile ? 14 : 16, rowTick = mobile ? 22 : 26, tickH = mobile ? 20 : 24, rowAxis = G.H - (mobile ? 16 : 18);

    // chapters
    const gc = el('g'); tlEls.chapters = [];
    for (const c of D.chapters) {
      const x0 = x(c.from), x1 = x(c.to);
      const rect = el('rect', { x: x0 + 1, y: rowChap, width: Math.max(0, x1 - x0 - 2), height: chapH, rx: 3, class: 'tl-chapter' });
      gc.appendChild(rect);
      const label = el('text', { x: x0 + 7, y: rowChap + chapH - 4, class: 'tl-chapter-label' });
      label.textContent = fitLabel(c.title, x1 - x0 - 12, mobile ? 5.6 : 6.2);
      gc.appendChild(label);
      tlEls.chapters.push(rect);
    }
    svg.appendChild(gc);

    // ticks
    const gt = el('g'); tlEls.ticks = {};
    const heights = { office: 0.55, cost: 0.8, unbuilt: 0.8 };
    for (const e of events) {
      const h = tickH * (heights[e.type] || 1);
      const line = el('line', { x1: x(e.t), x2: x(e.t), y1: rowTick + tickH - h, y2: rowTick + tickH, class: 'tl-tick', stroke: TYPE_COLOR[e.type] });
      if (e.type === 'unbuilt') line.setAttribute('stroke-dasharray', '2 2');
      gt.appendChild(line);
      tlEls.ticks[e.id] = line;
    }
    svg.appendChild(gt);

    // axis
    tlEls.axisFuture = el('line', { x1: x(T0), x2: x(T1), y1: rowAxis, y2: rowAxis, class: 'tl-axis-future' });
    tlEls.axisPast = el('line', { x1: x(T0), x2: x(T0), y1: rowAxis, y2: rowAxis, class: 'tl-axis' });
    svg.appendChild(tlEls.axisFuture); svg.appendChild(tlEls.axisPast);
    const step = mobile ? 10 : 5;
    for (let y = 1925; y <= T1; y += step) {
      const tk = el('line', { x1: x(y), x2: x(y), y1: rowAxis - 3, y2: rowAxis + 3, stroke: 'rgba(236,228,208,0.35)' });
      svg.appendChild(tk);
      if (y % 10 === 0 || !mobile) {
        const tx = el('text', { x: x(y), y: rowAxis + 14, class: 'tl-year', 'text-anchor': 'middle' });
        tx.textContent = y; svg.appendChild(tx);
      }
    }

    // playhead
    tlEls.headLine = el('line', { x1: x(S.t), x2: x(S.t), y1: rowChap, y2: rowAxis, class: 'tl-head-line' });
    tlEls.head = el('circle', { cx: x(S.t), cy: rowAxis, r: mobile ? 6 : 7, class: 'tl-head' });
    svg.appendChild(tlEls.headLine); svg.appendChild(tlEls.head);
  }

  function el(name, attrs) {
    const n = document.createElementNS(NS, name);
    if (attrs) for (const k in attrs) n.setAttribute(k, attrs[k]);
    return n;
  }
  function fitLabel(s, w, cw) {
    const max = Math.floor(w / cw);
    if (max < 4) return '';
    return s.length <= max ? s : s.slice(0, max - 1).trimEnd() + '…';
  }

  // scrubbing
  let dragging = false;
  function pointerT(ev) {
    const r = track.getBoundingClientRect();
    const px = ((ev.clientX - r.left) / r.width) * G.W;
    return clamp(G.tOf(px), T0, T1);
  }
  track.addEventListener('pointerdown', ev => {
    dragging = true; track.setPointerCapture(ev.pointerId);
    stop();
    setT(pointerT(ev), { fromScrub: true });
  });
  track.addEventListener('pointermove', ev => { if (dragging) setT(pointerT(ev), { fromScrub: true }); });
  const endDrag = ev => { if (!dragging) return; dragging = false; commitHash(); };
  track.addEventListener('pointerup', endDrag);
  track.addEventListener('pointercancel', endDrag);

  // ---------- time ----------
  function setT(t, opts) {
    opts = opts || {};
    S.t = clamp(t, T0, T1);
    if (!opts.keepSelection) S.selected = null;
    render();
    if (!opts.fromScrub) commitHash();
  }
  function currentEvent() {
    let cur = null;
    for (const e of events) { if (e.t <= S.t + 1e-9) cur = e; else break; }
    return cur;
  }
  function chapterAt(t) {
    return D.chapters.find(c => t >= c.from && t < c.to) || D.chapters[D.chapters.length - 1];
  }

  // playback
  const playBtn = document.getElementById('play-btn');
  const playIcon = document.getElementById('play-icon');
  const speedBtn = document.getElementById('speed-btn');
  const SPEEDS = [1, 2, 4];
  const YEARS_PER_SEC = 1.6;
  function play() {
    if (S.t >= T1 - 1e-6) S.t = T0;
    S.playing = true; S.lastTs = 0;
    playIcon.setAttribute('d', 'M6 5h4v14H6zM14 5h4v14h-4z'); playBtn.setAttribute('aria-label', 'Pause');
    S.raf = requestAnimationFrame(tick);
  }
  function stop() {
    if (!S.playing) return;
    S.playing = false; cancelAnimationFrame(S.raf);
    playIcon.setAttribute('d', 'M7 4l14 8-14 8z'); playBtn.setAttribute('aria-label', 'Play');
    commitHash();
  }
  function tick(ts) {
    if (!S.playing) return;
    if (S.lastTs) {
      const dt = (ts - S.lastTs) / 1000;
      S.t = Math.min(T1, S.t + dt * YEARS_PER_SEC * S.speed);
      S.selected = null;
      render();
      if (S.t >= T1) { stop(); return; }
    }
    S.lastTs = ts;
    S.raf = requestAnimationFrame(tick);
  }
  playBtn.addEventListener('click', () => (S.playing ? stop() : play()));
  speedBtn.addEventListener('click', () => {
    S.speed = SPEEDS[(SPEEDS.indexOf(S.speed) + 1) % SPEEDS.length];
    speedBtn.textContent = S.speed + '×';
  });

  // ---------- selection ----------
  function selectEvent(id, opts) {
    opts = opts || {};
    const e = byId[id]; if (!e) return;
    stop();
    S.t = Math.max(S.t, e.t);
    S.selected = id;
    render({ forceFly: !!opts.fly });
    if (opts.pushHash !== false) commitHash();
  }
  function stepEvent(dir) {
    const cur = S.selected ? byId[S.selected] : currentEvent();
    let i = cur ? events.indexOf(cur) : -1;
    i = clamp(i + dir, 0, events.length - 1);
    const e = events[i];
    S.t = e.t; S.selected = e.id; stop();
    render({ forceFly: true }); commitHash();
  }
  document.getElementById('prev-btn').addEventListener('click', () => stepEvent(-1));
  document.getElementById('next-btn').addEventListener('click', () => stepEvent(1));

  // ---------- render ----------
  const $ = id => document.getElementById(id);
  const ui = {
    month: $('clock-month'), year: $('clock-year'), offices: $('offices-line'), works: $('works-count'),
    chN: $('chapter-n'), chTitle: $('chapter-title'), chText: $('chapter-text'),
    ev: $('event'), evDate: $('event-date'), evTitle: $('event-title'), evBody: $('event-body'), evSrc: $('event-src'),
  };
  let lastChapter = null, lastShown = null;

  // Label collision pass: the current event wins, then newest first; a label that overlaps a kept one is hidden.
  let declutterQueued = false;
  function scheduleDeclutter() {
    if (declutterQueued) return;
    declutterQueued = true;
    requestAnimationFrame(() => { declutterQueued = false; declutter(); });
  }
  function declutter() {
    const cur = S.selected ? byId[S.selected] : currentEvent();
    const shown = events.filter(e => e.t <= S.t)
      .sort((a, b) => (b === cur) - (a === cur) || b.t - a.t);
    const kept = [];
    for (const e of shown) {
      const elx = markers[e.id].getElement();
      const lbl = elx && elx.querySelector('.mk-label');
      if (!lbl) continue;
      elx.classList.remove('lbl-hidden');
      const r = lbl.getBoundingClientRect();
      if (!r.width) continue;
      const hit = kept.some(k => r.left < k.right + 4 && r.right + 4 > k.left && r.top < k.bottom + 2 && r.bottom + 2 > k.top);
      if (hit && e !== cur) elx.classList.add('lbl-hidden'); else kept.push(r);
    }
  }

  function render(opts) {
    opts = opts || {};
    const t = S.t;
    const year = Math.floor(t + 1e-9);
    const month = clamp(Math.floor((t - year) * 12), 0, 11);
    ui.month.textContent = MONTHS[month];
    ui.year.textContent = year;

    const held = D.offices.filter(o => year >= o.from && year <= o.to);
    ui.offices.textContent = held.length === 1 ? '1 office held' : held.length + ' offices held';
    ui.offices.title = held.map(o => o.name).join('\n') || 'No office yet';
    const works = events.filter(e => e.t <= t && !['office', 'cost'].includes(e.type)).length;
    ui.works.textContent = works;

    const ch = chapterAt(t);
    if (ch !== lastChapter) {
      lastChapter = ch;
      ui.chN.textContent = 'Chapter ' + ch.n + ' of ' + D.chapters.length;
      ui.chTitle.textContent = ch.title;
      ui.chText.textContent = ch.text;
      tlEls.chapters.forEach((r, i) => r.classList.toggle('active', D.chapters[i] === ch));
    }

    const cur = S.selected ? byId[S.selected] : currentEvent();
    if (cur !== lastShown) {
      lastShown = cur;
      if (cur) {
        ui.ev.hidden = false;
        ui.ev.style.setProperty('--evt', TYPE_COLOR[cur.type]);
        ui.evDate.textContent = cur.date;
        ui.evTitle.textContent = cur.title;
        ui.evBody.textContent = cur.body;
        let src = 'Source: <a href="' + cur.src + '" target="_blank" rel="noopener">' + escapeHtml(cur.srcName) + '</a>';
        if (cur.src2) src += ' · <a href="' + cur.src2 + '" target="_blank" rel="noopener">' + escapeHtml(cur.src2Name) + '</a>';
        ui.evSrc.innerHTML = src;
      } else {
        ui.ev.hidden = true;
      }
      if (cur && (S.playing || opts.forceFly || S.selected)) flyTo(cur);
      const body = $('clock-body'); if (body) body.scrollTop = 0;
    }

    // markers + routes
    for (const e of events) {
      const on = e.t <= t;
      const elx = markers[e.id].getElement();
      if (elx) {
        elx.classList.toggle('on', on);
        elx.classList.toggle('current', cur === e);
        elx.style.zIndex = cur === e ? 1000 : (on ? 500 : 100);
      }
      if (routes[e.id]) routes[e.id].setStyle({ opacity: on ? (cur === e ? 0.95 : 0.55) : 0 });
    }

    scheduleDeclutter();

    // timeline
    if (G.x) {
      const px = G.x(t);
      tlEls.headLine.setAttribute('x1', px); tlEls.headLine.setAttribute('x2', px);
      tlEls.head.setAttribute('cx', px);
      tlEls.axisPast.setAttribute('x2', px);
      for (const e of events) {
        const l = tlEls.ticks[e.id];
        l.classList.toggle('past', e.t <= t);
        l.classList.toggle('current', cur === e);
      }
    }
  }

  let flyTimer = 0;
  function flyTo(e) {
    const far = map.distance(map.getCenter(), [e.lat, e.lon]) > 60000;
    const targetZoom = e.zoom ? Math.min(e.zoom, window.innerWidth < 720 ? Math.max(e.zoom - 1, 7) : e.zoom) : map.getZoom();
    const zoom = S.playing && !far ? Math.max(map.getZoom(), Math.min(targetZoom, NYC_ZOOM() + 1)) : targetZoom;
    // keep the point out from under the left panel on desktop
    const offsetX = window.innerWidth >= 720 ? -180 : 0;
    const p = map.project([e.lat, e.lon], zoom).subtract([offsetX, window.innerWidth < 720 ? 40 : 0]);
    map.flyTo(map.unproject(p, zoom), zoom, { duration: far ? 1.6 : 1.0, easeLinearity: 0.3 });
  }

  // ---------- hash ----------
  let hashTimer = 0;
  function commitHash() {
    clearTimeout(hashTimer);
    hashTimer = setTimeout(() => {
      const h = S.selected ? '#e=' + S.selected : '#t=' + S.t.toFixed(2);
      if (location.hash !== h) history.replaceState(null, '', h);
    }, 120);
  }
  function readHash() {
    const h = location.hash.slice(1);
    const m = /^t=([\d.]+)$/.exec(h);
    const e = /^e=([\w-]+)$/.exec(h);
    if (e && byId[e[1]]) { selectEvent(e[1], { fly: true, pushHash: false }); return true; }
    if (m) { setT(parseFloat(m[1])); return true; }
    return false;
  }
  window.addEventListener('hashchange', readHash);

  // ---------- modals, legend, keys ----------
  document.querySelectorAll('[data-modal]').forEach(b => b.addEventListener('click', () => openModal(b.dataset.modal)));
  document.querySelectorAll('[data-close]').forEach(b => b.addEventListener('click', closeModals));
  document.querySelectorAll('.modal').forEach(m => m.addEventListener('click', ev => { if (ev.target === m) closeModals(); }));
  function openModal(id) { closeModals(); document.getElementById(id).hidden = false; }
  function closeModals() { document.querySelectorAll('.modal').forEach(m => (m.hidden = true)); }

  const keyBtn = document.getElementById('key-btn'), legend = document.getElementById('legend');
  keyBtn.addEventListener('click', () => { legend.hidden = !legend.hidden; keyBtn.setAttribute('aria-pressed', String(!legend.hidden)); });

  const clock = document.getElementById('clock'), expandBtn = document.getElementById('clock-expand');
  function setExpanded(v) { clock.classList.toggle('expanded', v); expandBtn.setAttribute('aria-expanded', String(v)); expandBtn.textContent = v ? 'Less' : 'More'; }
  expandBtn.addEventListener('click', () => setExpanded(!clock.classList.contains('expanded')));
  document.getElementById('clock-head').addEventListener('click', () => { if (window.innerWidth < 720) setExpanded(!clock.classList.contains('expanded')); });

  document.addEventListener('keydown', ev => {
    if (ev.target.matches('input, textarea')) return;
    if (ev.key === 'Escape') { closeModals(); return; }
    if (ev.key === ' ') { ev.preventDefault(); S.playing ? stop() : play(); }
    else if (ev.key === 'ArrowRight') { ev.preventDefault(); stepEvent(1); }
    else if (ev.key === 'ArrowLeft') { ev.preventDefault(); stepEvent(-1); }
  });

  // chronicle list
  (function buildChronicle() {
    const body = document.getElementById('chronicle-body');
    for (const c of D.chapters) {
      const h = document.createElement('div'); h.className = 'chron-chapter';
      h.innerHTML = '<span>' + c.from + '–' + (c.to - 1) + '</span>' + escapeHtml(c.title);
      body.appendChild(h);
      for (const e of events.filter(e => e.t >= c.from && e.t < c.to)) {
        const b = document.createElement('button'); b.type = 'button'; b.className = 'chron-item';
        b.style.setProperty('--evt', TYPE_COLOR[e.type]);
        b.innerHTML = '<span class="d">' + escapeHtml(e.date) + '</span><span class="t">' + escapeHtml(e.title) + '</span>';
        b.addEventListener('click', () => { closeModals(); selectEvent(e.id, { fly: true }); });
        body.appendChild(b);
      }
    }
  })();

  // ---------- helpers ----------
  function clamp(v, a, b) { return Math.max(a, Math.min(b, v)); }
  function escapeHtml(s) { return String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }
  function shortTitle(e) {
    return e.title.replace(/\s*\(.*?\)\s*/g, ' ').replace(/^(The |Joins the |Chairman, |Seat on the )/, '').split(/[:—–]/)[0].trim();
  }

  // ---------- boot ----------
  let resizeTimer = 0;
  window.addEventListener('resize', () => { clearTimeout(resizeTimer); resizeTimer = setTimeout(() => { buildTimeline(); render(); map.invalidateSize(); }, 120); });
  buildTimeline();
  if (!readHash()) { setT(T0); commitHash(); }
  render();
  document.getElementById('app').classList.add('ready');
})();
