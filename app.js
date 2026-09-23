/* Robert Moses Atlas — map + time scrubber + a game layer. Plain browser JS, no build step. */
(function () {
  'use strict';
  const D = window.ATLAS;
  const X = window.ATLAS_EXTRA || { events: {}, finds: [], missions: [], achievements: [] };
  const GEO = window.ATLAS_GEO || {};
  const PHOTOS = window.ATLAS_PHOTOS || {};
  const [T0, T1] = D.range;
  const events = D.events.slice().sort((a, b) => a.t - b.t);
  for (const e of events) Object.assign(e, X.events[e.id] || {});
  const finds = (X.finds || []).slice().sort((a, b) => a.t - b.t);
  const byId = Object.fromEntries(events.map(e => [e.id, e]));
  const findById = Object.fromEntries(finds.map(f => [f.id, f]));
  const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
  const TYPE_COLOR = {
    parkway: '#e2a93d', expressway: '#d9584a', bridge: '#e0865a', park: '#7fb77a', housing: '#b08ad6',
    culture: '#5fb8c4', power: '#7aa7e8', office: '#ece4d0', cost: '#ff5d6c', unbuilt: '#8f8a7f', find: '#f3d896',
  };
  const NYC = [40.72, -73.92];
  const phone = () => window.innerWidth < 720;
  const NYC_ZOOM = () => (phone() ? 9 : 10);
  const $ = id => document.getElementById(id);

  // ---------- progress (localStorage, optional) ----------
  const SAVE_KEY = 'moses-atlas-v2';
  const P = { found: [], secrets: [], ach: [], missions: [], peak: false, reachedEnd: false, sound: false };
  try {
    const raw = localStorage.getItem(SAVE_KEY);
    if (raw) { const s = JSON.parse(raw); for (const k in P) if (k in s) P[k] = s[k]; }
  } catch (e) { /* private mode or blocked storage: play without saving */ }
  function save() { try { localStorage.setItem(SAVE_KEY, JSON.stringify(P)); } catch (e) { /* ignore */ } }
  const maxOffices = Math.max(...Array.from({ length: T1 - T0 + 1 }, (_, i) => D.offices.filter(o => T0 + i >= o.from && T0 + i <= o.to).length));

  // ---------- state ----------
  const S = { t: T0, playing: false, speed: 1, selected: null, selectedFind: null, raf: 0, lastTs: 0, mission: null, step: 0 };

  // ---------- map ----------
  const map = L.map('map', { zoomControl: false, attributionControl: true, worldCopyJump: false, zoomSnap: 0.5 })
    .setView(NYC, NYC_ZOOM());
  // ponytail: Esri's free Dark Gray Canvas; CARTO now watermarks keyless tiles. Upgrade path: a keyed CARTO/Stadia style.
  L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/Canvas/World_Dark_Gray_Base/MapServer/tile/{z}/{y}/{x}', {
    maxZoom: 16,
    attribution: 'Tiles &copy; Esri &mdash; Esri, HERE, Garmin, &copy; OpenStreetMap contributors',
  }).addTo(map);
  const shapeLayer = L.layerGroup().addTo(map);
  const markerLayer = L.layerGroup().addTo(map);
  const findLayer = L.layerGroup().addTo(map);
  map.on('zoomend moveend', () => scheduleDeclutter());

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

  // Real geometry from OpenStreetMap: roads and bridges as lines, parks as polygons. Clickable.
  const shapes = {};
  for (const e of events) {
    if (!e.geo) continue;
    const group = L.featureGroup();
    for (const key of e.geo) {
      const g = GEO[key]; if (!g || !g.coords.length) continue;
      const color = TYPE_COLOR[e.type];
      const weight = e.type === 'bridge' ? 6 : 3.5;
      if (g.kind === 'poly') {
        L.polygon(g.coords, { color, weight: 1.5, opacity: 0.9, fillColor: color, fillOpacity: 0.22, className: 'shape' }).addTo(group);
      } else {
        const dashed = e.type === 'unbuilt';
        L.polyline(g.coords, { color, weight, opacity: 0.9, dashArray: dashed ? '6 6' : null, className: 'shape', lineCap: 'round' }).addTo(group);
      }
    }
    if (!group.getLayers().length) continue;
    group.bindTooltip(e.title, { className: 'mk-tip', sticky: true, opacity: 1 });
    group.on('click', ev => { L.DomEvent.stop(ev); selectEvent(e.id, { fly: true, pushHash: true }); });
    shapes[e.id] = group;
  }

  const findMarkers = {};
  for (const f of finds) {
    const icon = L.divIcon({ className: 'mk mk-find', iconSize: [0, 0], iconAnchor: [0, 0], html: '<i>?</i><span class="mk-label">' + escapeHtml(f.title) + '</span>' });
    const m = L.marker([f.lat, f.lon], { icon, keyboard: false, riseOnHover: true, zIndexOffset: 600 });
    m.bindTooltip('A secret', { className: 'mk-tip', direction: 'top', offset: [0, -10], opacity: 1 });
    m.on('click', () => selectFind(f.id));
    findMarkers[f.id] = m;
  }

  // ---------- timeline svg ----------
  const svg = $('tl-svg');
  const track = $('track');
  const NS = 'http://www.w3.org/2000/svg';
  const G = { W: 0, H: 0, pad: 6 };
  const tlEls = { chapters: [], ticks: {} };

  function buildTimeline() {
    const r = track.getBoundingClientRect();
    G.W = Math.max(200, r.width); G.H = Math.max(60, r.height);
    svg.setAttribute('viewBox', `0 0 ${G.W} ${G.H}`);
    svg.innerHTML = '';
    const x = t => G.pad + ((t - T0) / (T1 - T0)) * (G.W - 2 * G.pad);
    G.x = x; G.tOf = px => T0 + ((px - G.pad) / (G.W - 2 * G.pad)) * (T1 - T0);
    const mobile = phone();
    const rowChap = 2, chapH = mobile ? 14 : 16, rowTick = mobile ? 22 : 26, tickH = mobile ? 20 : 24, rowAxis = G.H - (mobile ? 16 : 18);

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

    tlEls.axisFuture = el('line', { x1: x(T0), x2: x(T1), y1: rowAxis, y2: rowAxis, class: 'tl-axis-future' });
    tlEls.axisPast = el('line', { x1: x(T0), x2: x(T0), y1: rowAxis, y2: rowAxis, class: 'tl-axis' });
    svg.appendChild(tlEls.axisFuture); svg.appendChild(tlEls.axisPast);
    const step = mobile ? 10 : 5;
    for (let y = 1925; y <= T1; y += step) {
      svg.appendChild(el('line', { x1: x(y), x2: x(y), y1: rowAxis - 3, y2: rowAxis + 3, stroke: 'rgba(236,228,208,0.35)' }));
      if (y % 10 === 0 || !mobile) {
        const tx = el('text', { x: x(y), y: rowAxis + 14, class: 'tl-year', 'text-anchor': 'middle' });
        tx.textContent = y; svg.appendChild(tx);
      }
    }
    tlEls.headLine = el('line', { x1: x(S.t), x2: x(S.t), y1: rowChap, y2: rowAxis, class: 'tl-head-line' });
    tlEls.head = el('circle', { cx: x(S.t), cy: rowAxis, r: mobile ? 6 : 7, class: 'tl-head' });
    svg.appendChild(tlEls.headLine); svg.appendChild(tlEls.head);
  }
  function el(name, attrs) { const n = document.createElementNS(NS, name); if (attrs) for (const k in attrs) n.setAttribute(k, attrs[k]); return n; }
  function fitLabel(s, w, cw) { const max = Math.floor(w / cw); if (max < 4) return ''; return s.length <= max ? s : s.slice(0, max - 1).trimEnd() + '…'; }

  let dragging = false;
  function pointerT(ev) { const r = track.getBoundingClientRect(); return clamp(G.tOf(((ev.clientX - r.left) / r.width) * G.W), T0, T1); }
  track.addEventListener('pointerdown', ev => { dragging = true; track.setPointerCapture(ev.pointerId); stop(); setT(pointerT(ev), { fromScrub: true }); });
  track.addEventListener('pointermove', ev => { if (dragging) setT(pointerT(ev), { fromScrub: true }); });
  const endDrag = () => { if (!dragging) return; dragging = false; commitHash(); };
  track.addEventListener('pointerup', endDrag);
  track.addEventListener('pointercancel', endDrag);

  // ---------- time ----------
  function setT(t, opts) {
    opts = opts || {};
    S.t = clamp(t, T0, T1);
    if (!opts.keepSelection) { S.selected = null; S.selectedFind = null; }
    render();
    if (!opts.fromScrub) commitHash();
  }
  function currentEvent() { let cur = null; for (const e of events) { if (e.t <= S.t + 1e-9) cur = e; else break; } return cur; }
  function chapterAt(t) { return D.chapters.find(c => t >= c.from && t < c.to) || D.chapters[D.chapters.length - 1]; }

  const playBtn = $('play-btn'), playIcon = $('play-icon'), speedBtn = $('speed-btn');
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
      S.selected = null; S.selectedFind = null;
      render();
      if (S.t >= T1) { stop(); return; }
    }
    S.lastTs = ts;
    S.raf = requestAnimationFrame(tick);
  }
  playBtn.addEventListener('click', () => (S.playing ? stop() : play()));
  speedBtn.addEventListener('click', () => { S.speed = SPEEDS[(SPEEDS.indexOf(S.speed) + 1) % SPEEDS.length]; speedBtn.textContent = S.speed + '×'; });

  // ---------- selection + discovery ----------
  function selectEvent(id, opts) {
    opts = opts || {};
    const e = byId[id]; if (!e) return;
    stop();
    S.t = Math.max(S.t, e.t);
    S.selected = id; S.selectedFind = null;
    const fresh = !P.found.includes(id);
    if (fresh) { P.found.push(id); save(); }
    render({ forceFly: !!opts.fly });
    if (fresh) { ping('found'); toast('Discovered', e.title, TYPE_COLOR[e.type]); }
    checkAchievements();
    if (S.mission) missionProgress(id);
    if (opts.pushHash !== false) commitHash();
    if (phone() && !opts.quiet) setExpanded(true);
  }
  function selectFind(id) {
    const f = findById[id]; if (!f) return;
    stop();
    S.t = Math.max(S.t, f.t);
    S.selectedFind = id; S.selected = null;
    const fresh = !P.secrets.includes(id);
    if (fresh) { P.secrets.push(id); save(); }
    render({ forceFly: true });
    if (fresh) { ping('secret'); toast('Secret found', f.title, TYPE_COLOR.find); }
    checkAchievements();
    commitHash();
    if (phone()) setExpanded(true);
  }
  function stepEvent(dir) {
    const cur = S.selected ? byId[S.selected] : currentEvent();
    let i = cur ? events.indexOf(cur) : -1;
    i = clamp(i + dir, 0, events.length - 1);
    selectEvent(events[i].id, { fly: true });
  }
  $('prev-btn').addEventListener('click', () => stepEvent(-1));
  $('next-btn').addEventListener('click', () => stepEvent(1));

  // ---------- toasts + achievements + sound ----------
  const toastBox = $('toasts');
  const toastQueue = []; let toastBusy = false;
  function toast(kicker, title, color, opts) {
    toastQueue.push({ kicker, title, color, opts: opts || {} });
    if (!toastBusy) nextToast();
  }
  function nextToast() {
    const t = toastQueue.shift(); if (!t) { toastBusy = false; return; }
    toastBusy = true;
    const d = document.createElement('div'); d.className = 'toast' + (t.opts.big ? ' big' : '');
    d.style.setProperty('--tc', t.color || '#e2a93d');
    d.innerHTML = '<span class="toast-k">' + escapeHtml(t.kicker) + '</span><span class="toast-t">' + escapeHtml(t.title) + '</span>';
    toastBox.appendChild(d);
    requestAnimationFrame(() => d.classList.add('in'));
    setTimeout(() => { d.classList.remove('in'); setTimeout(() => { d.remove(); nextToast(); }, 350); }, t.opts.big ? 3600 : 2200);
  }
  function checkAchievements() {
    for (const a of X.achievements) {
      if (P.ach.includes(a.id)) continue;
      let ok = false; try { ok = a.test(P, { events, finds }); } catch (e) { ok = false; }
      if (ok) { P.ach.push(a.id); save(); ping('ach'); toast('Achievement', a.title, '#f3d896', { big: true }); }
    }
    renderHud();
  }

  let audio = null;
  function ping(kind) {
    if (!P.sound) return;
    try {
      audio = audio || new (window.AudioContext || window.webkitAudioContext)();
      const notes = { found: [660, 880], secret: [523, 784, 1047], ach: [523, 659, 784, 1047] }[kind] || [660];
      notes.forEach((f, i) => {
        const o = audio.createOscillator(), g = audio.createGain();
        o.type = 'triangle'; o.frequency.value = f;
        g.gain.setValueAtTime(0.0001, audio.currentTime + i * 0.09);
        g.gain.exponentialRampToValueAtTime(0.12, audio.currentTime + i * 0.09 + 0.02);
        g.gain.exponentialRampToValueAtTime(0.0001, audio.currentTime + i * 0.09 + 0.25);
        o.connect(g).connect(audio.destination);
        o.start(audio.currentTime + i * 0.09); o.stop(audio.currentTime + i * 0.09 + 0.3);
      });
    } catch (e) { /* no audio */ }
  }
  const soundBtn = $('sound-btn');
  function renderSound() { soundBtn.setAttribute('aria-pressed', String(P.sound)); soundBtn.title = P.sound ? 'Sound on' : 'Sound off'; soundBtn.textContent = P.sound ? '♪ On' : '♪ Off'; }
  soundBtn.addEventListener('click', () => { P.sound = !P.sound; save(); renderSound(); if (P.sound) ping('found'); });
  renderSound();

  // ---------- missions ----------
  const missionBar = $('mission'), mTitle = $('mission-title'), mStep = $('mission-step'), mNext = $('mission-next');
  function startMission(id) {
    const m = X.missions.find(m => m.id === id); if (!m) return;
    closeModals();
    S.mission = m; S.step = 0;
    missionBar.hidden = false;
    selectEvent(m.steps[0], { fly: true });
    renderMission();
  }
  function renderMission() {
    const m = S.mission; if (!m) { missionBar.hidden = true; return; }
    mTitle.textContent = m.title;
    mStep.textContent = 'Step ' + (S.step + 1) + ' of ' + m.steps.length + ' · ' + byId[m.steps[S.step]].title;
    mNext.textContent = S.step === m.steps.length - 1 ? 'Finish' : 'Next →';
  }
  function missionProgress(eventId) {
    const m = S.mission; if (!m) return;
    const i = m.steps.indexOf(eventId);
    if (i >= 0) { S.step = i; renderMission(); }
  }
  mNext.addEventListener('click', () => {
    const m = S.mission; if (!m) return;
    if (S.step < m.steps.length - 1) { S.step++; selectEvent(m.steps[S.step], { fly: true }); renderMission(); return; }
    if (!P.missions.includes(m.id)) { P.missions.push(m.id); save(); }
    ping('ach'); toast('Mission complete', m.title, '#7fb77a', { big: true });
    S.mission = null; renderMission(); renderMissionList(); renderHud();
  });
  $('mission-quit').addEventListener('click', () => { S.mission = null; renderMission(); });
  function renderMissionList() {
    const box = $('mission-list'); box.innerHTML = '';
    for (const m of X.missions) {
      const done = P.missions.includes(m.id);
      const b = document.createElement('button'); b.type = 'button'; b.className = 'mission-item' + (done ? ' done' : '');
      b.innerHTML = '<span class="mi-t">' + escapeHtml(m.title) + (done ? ' <em>✓ done</em>' : '') + '</span><span class="mi-b">' + escapeHtml(m.blurb) + '</span><span class="mi-n">' + m.steps.length + ' stops</span>';
      b.addEventListener('click', () => startMission(m.id));
      box.appendChild(b);
    }
    const ach = $('ach-list'); ach.innerHTML = '';
    for (const a of X.achievements) {
      const got = P.ach.includes(a.id);
      const li = document.createElement('li'); li.className = got ? 'got' : '';
      li.innerHTML = '<b>' + escapeHtml(a.title) + '</b><span>' + escapeHtml(got ? 'Unlocked' : a.how) + '</span>';
      ach.appendChild(li);
    }
  }
  $('reset-btn').addEventListener('click', () => {
    if (!confirm('Forget everything you have discovered on this device?')) return;
    P.found = []; P.secrets = []; P.ach = []; P.missions = []; P.peak = false; P.reachedEnd = false; save();
    S.mission = null; renderMission(); renderMissionList(); render(); renderHud();
  });

  // ---------- render ----------
  const ui = {
    month: $('clock-month'), year: $('clock-year'), offices: $('offices-line'), works: $('works-count'),
    chN: $('chapter-n'), chTitle: $('chapter-title'), chText: $('chapter-text'),
    ev: $('event'), evDate: $('event-date'), evTitle: $('event-title'), evBody: $('event-body'), evSrc: $('event-src'),
    evFacts: $('event-facts'), evWow: $('event-wow'), evPhoto: $('event-photo'), evImg: $('event-img'), evCredit: $('event-credit'),
    power: $('power-meter'), foundBar: $('found-bar'), foundN: $('found-count'), secretBar: $('secret-bar'), secretN: $('secret-count'),
  };
  let lastChapter = null, lastShown = null, lastShownFind = null;

  function renderHud() {
    const year = Math.floor(S.t + 1e-9);
    const held = D.offices.filter(o => year >= o.from && year <= o.to);
    ui.offices.textContent = held.length + (held.length === 1 ? ' office' : ' offices');
    ui.offices.title = held.map(o => o.name).join('\n') || 'No office yet';
    ui.power.innerHTML = Array.from({ length: maxOffices }, (_, i) => '<i class="' + (i < held.length ? 'on' : '') + '"></i>').join('');
    if (held.length === maxOffices && !P.peak) { P.peak = true; save(); }
    ui.foundN.textContent = P.found.length + ' / ' + events.length;
    ui.foundBar.style.width = (100 * P.found.length / events.length) + '%';
    ui.secretN.textContent = P.secrets.length + ' / ' + finds.length;
    ui.secretBar.style.width = (100 * P.secrets.length / finds.length) + '%';
  }

  let declutterQueued = false;
  function scheduleDeclutter() { if (declutterQueued) return; declutterQueued = true; requestAnimationFrame(() => { declutterQueued = false; declutter(); }); }
  function declutter() {
    const cur = S.selected ? byId[S.selected] : currentEvent();
    const shown = events.filter(e => e.t <= S.t).sort((a, b) => (b === cur) - (a === cur) || b.t - a.t);
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

  function sourceHtml(o) {
    let s = 'Source: <a href="' + o.src + '" target="_blank" rel="noopener">' + escapeHtml(o.srcName) + '</a>';
    if (o.src2) s += ' · <a href="' + o.src2 + '" target="_blank" rel="noopener">' + escapeHtml(o.src2Name) + '</a>';
    return s;
  }
  function showCard(o, kindLabel, color) {
    ui.ev.hidden = false;
    ui.ev.style.setProperty('--evt', color);
    ui.evDate.textContent = kindLabel;
    ui.evTitle.textContent = o.title;
    ui.evBody.textContent = o.body;
    ui.evFacts.innerHTML = (o.facts || []).map(f => '<li><span>' + escapeHtml(f[0]) + '</span><b>' + escapeHtml(f[1]) + '</b></li>').join('');
    ui.evFacts.hidden = !(o.facts && o.facts.length);
    ui.evWow.hidden = !o.wow; ui.evWow.textContent = o.wow || '';
    ui.evSrc.innerHTML = sourceHtml(o);
    const ph = PHOTOS[o.id];
    if (ph) {
      ui.evPhoto.hidden = false; ui.evImg.src = ph.thumb; ui.evImg.alt = o.title;
      ui.evCredit.innerHTML = '<a href="' + ph.descUrl + '" target="_blank" rel="noopener">' + escapeHtml(ph.artist || 'Wikimedia Commons') + '</a> · ' +
        (ph.licenseUrl ? '<a href="' + ph.licenseUrl + '" target="_blank" rel="noopener">' + escapeHtml(ph.license) + '</a>' : escapeHtml(ph.license));
    } else { ui.evPhoto.hidden = true; ui.evImg.removeAttribute('src'); }
    const body = $('clock-body'); if (body) body.scrollTop = 0;
  }

  function render(opts) {
    opts = opts || {};
    const t = S.t;
    const year = Math.floor(t + 1e-9);
    const month = clamp(Math.floor((t - year) * 12), 0, 11);
    ui.month.textContent = MONTHS[month];
    ui.year.textContent = year;
    ui.works.textContent = events.filter(e => e.t <= t && !['office', 'cost'].includes(e.type)).length;
    if (t >= T1 - 0.5 && !P.reachedEnd) { P.reachedEnd = true; save(); checkAchievements(); }
    renderHud();

    const ch = chapterAt(t);
    if (ch !== lastChapter) {
      lastChapter = ch;
      ui.chN.textContent = 'Chapter ' + ch.n + ' of ' + D.chapters.length;
      ui.chTitle.textContent = ch.title;
      ui.chText.textContent = ch.text;
      tlEls.chapters.forEach((r, i) => r.classList.toggle('active', D.chapters[i] === ch));
    }

    const cur = S.selected ? byId[S.selected] : currentEvent();
    const curFind = S.selectedFind ? findById[S.selectedFind] : null;
    if (curFind) {
      if (curFind !== lastShownFind) { lastShownFind = curFind; lastShown = null; showCard(curFind, 'Secret · from ' + Math.floor(curFind.t), TYPE_COLOR.find); if (opts.forceFly) flyToPoint(curFind, 14); }
    } else if (cur !== lastShown || lastShownFind) {
      lastShown = cur; lastShownFind = null;
      if (cur) {
        showCard(cur, cur.date, TYPE_COLOR[cur.type]);
        if (S.playing || opts.forceFly || S.selected) flyTo(cur);
      } else ui.ev.hidden = true;
    }

    for (const e of events) {
      const on = e.t <= t;
      const elx = markers[e.id].getElement();
      if (elx) {
        elx.classList.toggle('on', on);
        elx.classList.toggle('current', cur === e && !curFind);
        elx.classList.toggle('found', P.found.includes(e.id));
        elx.style.zIndex = cur === e ? 1000 : (on ? 500 : 100);
      }
      const sh = shapes[e.id];
      if (sh) {
        if (on && !shapeLayer.hasLayer(sh)) sh.addTo(shapeLayer);
        if (!on && shapeLayer.hasLayer(sh)) shapeLayer.removeLayer(sh);
        if (on) {
          const isCur = cur === e && !curFind;
          sh.eachLayer(l => l.setStyle({ opacity: isCur ? 1 : 0.55, fillOpacity: isCur ? 0.35 : 0.15, weight: (e.type === 'bridge' ? 6 : 3.5) * (isCur ? 1.3 : 1) }));
          if (isCur) sh.bringToFront();
        }
      }
    }
    for (const f of finds) {
      const on = f.t <= t;
      const m = findMarkers[f.id];
      if (on && !findLayer.hasLayer(m)) m.addTo(findLayer);
      if (!on && findLayer.hasLayer(m)) findLayer.removeLayer(m);
      const elx = m.getElement();
      if (elx) { elx.classList.toggle('on', on); elx.classList.toggle('found', P.secrets.includes(f.id)); elx.classList.toggle('current', curFind === f); }
    }
    scheduleDeclutter();

    if (G.x) {
      const px = G.x(t);
      tlEls.headLine.setAttribute('x1', px); tlEls.headLine.setAttribute('x2', px);
      tlEls.head.setAttribute('cx', px);
      tlEls.axisPast.setAttribute('x2', px);
      for (const e of events) { const l = tlEls.ticks[e.id]; l.classList.toggle('past', e.t <= t); l.classList.toggle('current', cur === e); }
    }
  }

  function panelPadding() {
    // keep the target out from under the clock panel (left, desktop) and the timeline (bottom)
    return phone() ? { tl: [20, 90], br: [20, 130] } : { tl: [380, 110], br: [40, 150] };
  }
  function flyTo(e) {
    const sh = shapes[e.id];
    if (sh && S.selected === e.id && !S.playing) {
      const pad = panelPadding();
      map.flyToBounds(sh.getBounds(), { paddingTopLeft: pad.tl, paddingBottomRight: pad.br, maxZoom: Math.max(e.zoom || 12, 11), duration: 1.2, easeLinearity: 0.3 });
      return;
    }
    flyToPoint(e, e.zoom);
  }
  function flyToPoint(e, z) {
    const far = map.distance(map.getCenter(), [e.lat, e.lon]) > 60000;
    const targetZoom = z ? Math.min(z, phone() ? Math.max(z - 1, 7) : z) : map.getZoom();
    const zoom = S.playing && !far ? Math.max(map.getZoom(), Math.min(targetZoom, NYC_ZOOM() + 1)) : targetZoom;
    const offsetX = phone() ? 0 : -180;
    const p = map.project([e.lat, e.lon], zoom).subtract([offsetX, phone() ? 40 : 0]);
    map.flyTo(map.unproject(p, zoom), zoom, { duration: far ? 1.6 : 1.0, easeLinearity: 0.3 });
  }

  // ---------- hash ----------
  let hashTimer = 0;
  function commitHash() {
    clearTimeout(hashTimer);
    hashTimer = setTimeout(() => {
      const h = S.selectedFind ? '#s=' + S.selectedFind : S.selected ? '#e=' + S.selected : '#t=' + S.t.toFixed(2);
      if (location.hash !== h) history.replaceState(null, '', h);
    }, 120);
  }
  function readHash() {
    const h = location.hash.slice(1);
    const m = /^t=([\d.]+)$/.exec(h), e = /^e=([\w-]+)$/.exec(h), s = /^s=([\w-]+)$/.exec(h);
    if (s && findById[s[1]]) { selectFind(s[1]); return true; }
    if (e && byId[e[1]]) { selectEvent(e[1], { fly: true, pushHash: false, quiet: true }); return true; }
    if (m) { setT(parseFloat(m[1])); return true; }
    return false;
  }
  window.addEventListener('hashchange', readHash);

  // ---------- modals, legend, keys ----------
  document.querySelectorAll('[data-modal]').forEach(b => b.addEventListener('click', () => openModal(b.dataset.modal)));
  document.querySelectorAll('[data-close]').forEach(b => b.addEventListener('click', closeModals));
  document.querySelectorAll('.modal').forEach(m => m.addEventListener('click', ev => { if (ev.target === m) closeModals(); }));
  function openModal(id) { closeModals(); if (id === 'missions') renderMissionList(); $(id).hidden = false; }
  function closeModals() { document.querySelectorAll('.modal').forEach(m => (m.hidden = true)); }

  const keyBtn = $('key-btn'), legend = $('legend');
  keyBtn.addEventListener('click', () => { legend.hidden = !legend.hidden; keyBtn.setAttribute('aria-pressed', String(!legend.hidden)); });

  const clock = $('clock'), expandBtn = $('clock-expand');
  function setExpanded(v) { clock.classList.toggle('expanded', v); expandBtn.setAttribute('aria-expanded', String(v)); expandBtn.textContent = v ? 'Less' : 'More'; }
  expandBtn.addEventListener('click', () => setExpanded(!clock.classList.contains('expanded')));
  $('clock-head').addEventListener('click', () => { if (phone()) setExpanded(!clock.classList.contains('expanded')); });

  document.addEventListener('keydown', ev => {
    if (ev.target.matches('input, textarea')) return;
    if (ev.key === 'Escape') { closeModals(); return; }
    if (ev.key === ' ') { ev.preventDefault(); S.playing ? stop() : play(); }
    else if (ev.key === 'ArrowRight') { ev.preventDefault(); stepEvent(1); }
    else if (ev.key === 'ArrowLeft') { ev.preventDefault(); stepEvent(-1); }
    else if (ev.key === 'Enter' && S.mission) { mNext.click(); }
    else if (ev.key === 'm' || ev.key === 'M') { openModal('missions'); }
    else if (ev.key === '?' || ev.key === 'k') { keyBtn.click(); }
  });

  (function buildChronicle() {
    const body = $('chronicle-body');
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
  function shortTitle(e) { return e.title.replace(/\s*\(.*?\)\s*/g, ' ').replace(/^(The |Joins the |Chairman, |Seat on the )/, '').split(/[:—–]/)[0].trim(); }

  // ---------- boot ----------
  let resizeTimer = 0;
  window.addEventListener('resize', () => { clearTimeout(resizeTimer); resizeTimer = setTimeout(() => { buildTimeline(); render(); map.invalidateSize(); }, 120); });
  buildTimeline();
  if (!readHash()) { setT(T0); commitHash(); }
  render();
  renderMissionList();
  $('app').classList.add('ready');
  if (!P.found.length) setTimeout(() => toast('Welcome', 'Click anything on the map. Every card is a find.', '#e2a93d', { big: true }), 900);
})();
