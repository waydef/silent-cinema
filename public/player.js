'use strict';
// the player around the video: controls, seek bar with preview, gestures, keyboard,
// fullscreen, settings sheet and status lines. playback itself is driven by sync.js.

const I = {
  play: '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M8 5.2v13.6c0 .8.9 1.3 1.6.8l10.2-6.8c.6-.4.6-1.2 0-1.6L9.6 4.4C8.9 3.9 8 4.4 8 5.2z"/></svg>',
  pause: '<svg viewBox="0 0 24 24" fill="currentColor"><rect x="6" y="4.5" width="4" height="15" rx="1.2"/><rect x="14" y="4.5" width="4" height="15" rx="1.2"/></svg>',
  back: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M4.5 12a7.5 7.5 0 1 0 2.2-5.3"/><path d="M4.5 4v3.5H8"/><text x="12" y="15.2" text-anchor="middle" font-size="7" font-family="system-ui" fill="currentColor" stroke="none">10</text></svg>',
  fwd: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M19.5 12a7.5 7.5 0 1 1-2.2-5.3"/><path d="M19.5 4v3.5H16"/><text x="12" y="15.2" text-anchor="middle" font-size="7" font-family="system-ui" fill="currentColor" stroke="none">10</text></svg>',
  vol: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M4 9.5h3l4.5-4v13l-4.5-4H4z"/><path d="M15.5 9a4 4 0 0 1 0 6M18 6.5a7.5 7.5 0 0 1 0 11"/></svg>',
  mute: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M4 9.5h3l4.5-4v13l-4.5-4H4z"/><path d="M16 9.5l5 5M21 9.5l-5 5"/></svg>',
  gear: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"><path d="M4 7h10M18 7h2M4 17h3M11 17h9"/><circle cx="16" cy="7" r="2"/><circle cx="9" cy="17" r="2"/></svg>',
  fs: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M4 9V5.5C4 4.7 4.7 4 5.5 4H9M15 4h3.5c.8 0 1.5.7 1.5 1.5V9M20 15v3.5c0 .8-.7 1.5-1.5 1.5H15M9 20H5.5C4.7 20 4 19.3 4 18.5V15"/></svg>',
  fsx: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M9 4v3.5C9 8.3 8.3 9 7.5 9H4M20 9h-3.5C15.7 9 15 8.3 15 7.5V4M15 20v-3.5c0-.8.7-1.5 1.5-1.5H20M4 15h3.5c.8 0 1.5.7 1.5 1.5V20"/></svg>',
  pip: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linejoin="round"><rect x="3.5" y="5" width="17" height="14" rx="2"/><rect x="12" y="11.5" width="6" height="5" rx="1" fill="currentColor" stroke="none"/></svg>',
  chat: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linejoin="round"><path d="M5 5.5h14c.6 0 1 .4 1 1v9c0 .6-.4 1-1 1h-8.5L6 20v-3.5H5c-.6 0-1-.4-1-1v-9c0-.6.4-1 1-1z"/></svg>',
  close: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"><path d="M6.5 6.5l11 11M17.5 6.5l-11 11"/></svg>',
};

function initPlayer({ root, stage, video, media, sync, chat, role, onStop, stopLabel, stopHint }) {
  const html = `
    <div class="scrim"></div>
    <div class="hud top">
      <div class="ttl"><div class="name" id="title"></div><button class="peer" id="peer" aria-label="${tr('p.who')}"><span></span></button></div>
      ${onStop ? `<button class="txt stop" id="stop">${stopLabel}</button>` : ''}
      <button class="ib" id="chatbtn" aria-label="${tr('p.chat')}" title="${tr('p.chatKey')}">${I.chat}</button>
    </div>
    <div class="mid">
      <button class="ib skip" data-skip="-10" aria-label="${tr('p.back10')}">${I.back}</button>
      <button class="ib big" id="bigplay" aria-label="${tr('p.play')}">${I.play}</button>
      <button class="ib skip" data-skip="10" aria-label="${tr('p.fwd10')}">${I.fwd}</button>
    </div>
    <div class="flash l" id="flashl"><i></i><i></i><i></i><b></b></div><div class="flash r" id="flashr"><i></i><i></i><i></i><b></b></div>
    <div class="bezel" id="bezel"></div>
    <div class="notice hidden" id="notice"><i class="spin"></i><span></span></div>
    <div class="toasts" id="toasts" aria-live="polite"></div>
    <button class="ping" id="ping" aria-label="${tr('p.openChat')}"><b></b><span></span></button>
    <button class="unmute hidden" id="unmute">${I.mute}<span>${tr('p.unmute')}</span></button>
    <div class="hud bottom">
      <div class="seek" id="seek" role="slider" aria-label="${tr('p.seek')}" tabindex="-1">
        <div class="rail"><i class="buf"></i><i class="pos"></i></div><i class="knob"></i><span class="tip"></span>
      </div>
      <div class="row">
        <button class="ib" id="playbtn" aria-label="${tr('p.playKey')}">${I.play}</button>
        <button class="ib wide" data-skip="-10" aria-label="${tr('p.back10Key')}">${I.back}</button>
        <button class="ib wide" data-skip="10" aria-label="${tr('p.fwd10Key')}">${I.fwd}</button>
        <div class="volume"><button class="ib" id="mutebtn" aria-label="${tr('p.mute')}">${I.vol}</button><input id="vol" type="range" min="0" max="1" step="0.02" aria-label="${tr('p.volume')}"></div>
        <span class="clock"><b id="cur">0:00</b><span> / </span><span id="dur">0:00</span></span>
        <span class="grow"></span>
        <button class="ib" id="setbtn" aria-label="${tr('p.settings')}">${I.gear}</button>
        <button class="ib pip hidden" id="pipbtn" aria-label="${tr('p.pip')}">${I.pip}</button>
        <button class="ib" id="fsbtn" aria-label="${tr('p.fs')}">${I.fs}</button>
      </div>
    </div>
    <div class="cover hidden" id="tap"><button class="ib big" id="tapbtn" aria-label="${tr('p.start')}">${I.play}</button></div>
    <div class="cover hidden" id="fail"><div><h2>${tr('p.failTitle')}</h2><p id="failtext"></p><button class="main" id="retry">${tr('p.retry')}</button></div></div>`;
  stage.insertAdjacentHTML('beforeend', html);
  const sheet = document.createElement('div');
  sheet.className = 'sheet';
  sheet.id = 'sheet';
  sheet.innerHTML = `<div class="sheet-card" role="dialog" aria-label="${tr('p.sheet')}"><div class="sheet-body"></div></div>`;
  root.append(sheet);

  const $ = (id) => document.getElementById(id);
  const seek = $('seek');
  const pos = seek.querySelector('.pos');
  const buf = seek.querySelector('.buf');
  const knob = seek.querySelector('.knob');
  const tip = seek.querySelector('.tip');
  const body = sheet.querySelector('.sheet-body');
  let idleTimer = null;
  let drag = null;           // seconds under the finger while dragging the bar
  let seekW = seek.clientWidth;   // the knob moves by transform, so the bar width is kept at hand
  let lastT = null;
  let jumpTimer = null;
  let peerText = '';
  let peerTimer = null;
  let noticeTimer = null;
  let noticeWant = '';
  let stopArm = null;

  const dur = () => {
    const d = Number.isFinite(video.duration) && video.duration > 0 ? video.duration : 0;
    return d || (media.session && media.session.duration) || 0;
  };
  const shown = () => sync.target();

  // play or pause, whoever pressed it, shows for a moment in the middle of the picture when no
  // button is there to show it: with a mouse the big button only marks a pause, on a phone it
  // hides with the controls
  let wasOn = null;
  const finePointer = matchMedia('(hover: hover) and (pointer: fine)');
  function bezel(on) {
    if (finePointer.matches ? !on : !stage.classList.contains('idle')) return;
    const el = $('bezel');
    el.innerHTML = on ? I.play : I.pause;
    el.classList.remove('go');
    void el.offsetWidth;
    el.classList.add('go');
  }

  function paint() {
    const d = dur();
    const t = drag !== null ? drag : (video.readyState >= 1 ? video.currentTime : shown());
    const f = d ? Math.min(1, t / d) : 0;
    pos.style.transform = `scaleX(${f})`;
    knob.style.transform = `translateX(${f * seekW}px)`;
    // a jump (anybody's seek) glides along the bar and leaves a ring at the knob; steady playback
    // and a drag under the finger stay immediate
    if (lastT !== null && drag === null && Math.abs(t - lastT) > 3) {
      seek.classList.remove('jump');
      void seek.offsetWidth;
      seek.classList.add('jump');
      clearTimeout(jumpTimer);
      jumpTimer = setTimeout(() => seek.classList.remove('jump'), 700);
    }
    lastT = drag === null ? t : null;
    let end = 0;
    for (let i = 0; i < video.buffered.length; i++) {
      if (video.buffered.start(i) <= video.currentTime + 1) end = Math.max(end, video.buffered.end(i));
    }
    buf.style.transform = `scaleX(${d ? Math.min(1, end / d) : 0})`;
    $('cur').textContent = fmtTime(t);
    $('dur').textContent = fmtTime(d);
    const st = sync.state;
    const on = !!st && st.playing;
    stage.classList.toggle('paused', !on);
    const icon = on ? I.pause : I.play;
    for (const b of [$('playbtn'), $('bigplay')]) {
      if (b.dataset.icon !== String(on)) {
        const first = b.dataset.icon === undefined;
        b.innerHTML = icon;
        b.dataset.icon = String(on);
        b.setAttribute('aria-label', on ? tr('p.pause') : tr('p.play'));
        if (!first) { b.classList.remove('swap'); void b.offsetWidth; b.classList.add('swap'); }
      }
    }
    if (wasOn !== null && wasOn !== on) bezel(on);
    wasOn = on;
    seek.setAttribute('aria-valuenow', String(Math.round(t)));
    seek.setAttribute('aria-valuetext', tr('p.of', { a: fmtTime(t), b: fmtTime(d) }));
    if ('mediaSession' in navigator && d && navigator.mediaSession.setPositionState) {
      try { navigator.mediaSession.setPositionState({ duration: d, position: Math.min(t, d), playbackRate: 1 }); } catch { /* ignore */ }
    }
  }
  // nothing to draw while the player is not on screen (lobby, background tab)
  setInterval(() => { if (!document.hidden && !root.classList.contains('hidden')) paint(); }, 250);
  new ResizeObserver(() => { seekW = seek.clientWidth; paint(); }).observe(seek);
  // a wide film on an upright phone leaves a low picture: the big middle buttons then step
  // aside (the row below has play, a double tap skips), so nothing lies on top of the bar
  new ResizeObserver(() => stage.classList.toggle('short', stage.clientHeight < 210)).observe(stage);
  // the picture is waiting for data: a light runs along the bar until it plays again
  const loadingNow = () => stage.classList.toggle('loading', sync.playingWanted() && video.readyState < 3);
  for (const ev of ['waiting', 'playing', 'canplay', 'pause', 'loadstart', 'emptied']) video.addEventListener(ev, loadingNow);
  sync.on('state', loadingNow);
  for (const ev of ['play', 'pause', 'seeked', 'loadedmetadata', 'durationchange']) video.addEventListener(ev, paint);
  sync.on('state', paint);

  // ---------- hud visibility ----------

  const busy = () => drag !== null || sheet.classList.contains('open') || !sync.playingWanted() || (stopArm && stopArm.armed());
  // subtitles step above the controls while those are shown, like on the big services
  function placeCues() {
    const up = !stage.classList.contains('idle') || stage.classList.contains('paused');
    const bar = stage.querySelector('.hud.bottom').offsetHeight;
    const pct = Math.max(40, Math.floor(100 - (bar / Math.max(1, stage.clientHeight)) * 100 - 2));
    for (const tr of video.textTracks) {
      if (tr.mode !== 'showing' || !tr.activeCues) continue;
      for (const c of tr.activeCues) {
        if (up && (c.snapToLines || c.line !== pct)) { c.snapToLines = false; c.lineAlign = 'end'; c.line = pct; }
        else if (!up && !c.snapToLines) { c.snapToLines = true; c.lineAlign = 'start'; c.line = 'auto'; }
      }
    }
  }
  video.textTracks.addEventListener('addtrack', (e) => e.track.addEventListener('cuechange', placeCues));
  new MutationObserver(placeCues).observe(stage, { attributes: true, attributeFilter: ['class'] });
  function wake(ms = 3000) {
    stage.classList.remove('idle');
    clearTimeout(idleTimer);
    idleTimer = setTimeout(() => { if (!busy()) stage.classList.add('idle'); else wake(); }, ms);
  }
  const hideHud = () => { clearTimeout(idleTimer); if (!busy()) stage.classList.add('idle'); };
  stage.addEventListener('mousemove', (e) => { if (e.movementX || e.movementY) wake(); });
  stage.addEventListener('mouseleave', () => { if (!busy()) setTimeout(hideHud, 600); });
  stage.addEventListener('focusin', () => wake());
  wake();

  // ---------- taps and clicks on the picture ----------

  let clickTimer = null;
  let lastTap = { at: 0, side: '' };
  let flashSum = { l: 0, r: 0 };
  let flashTimer = null;
  function flash(side, sec) {
    flashSum[side] += sec;
    const el = $(side === 'l' ? 'flashl' : 'flashr');
    el.querySelector('b').textContent = (side === 'l' ? '−' : '+') + tr('p.sec', { n: Math.abs(flashSum[side]) });
    el.classList.remove('go');
    void el.offsetWidth;
    el.classList.add('go');
    clearTimeout(flashTimer);
    flashTimer = setTimeout(() => { flashSum = { l: 0, r: 0 }; $('flashl').classList.remove('go'); $('flashr').classList.remove('go'); }, 700);
  }
  // every skip shows the chevrons on its side, from a double tap, a button or a key alike
  function skip(d) {
    sync.skip(d);
    if (sync.control) flash(d < 0 ? 'l' : 'r', d);
  }
  const isControl = (t) => t.closest('.hud, .mid button, .sheet, .unmute, .cover, .notice');
  stage.addEventListener('pointerup', (e) => {
    if (isControl(e.target) || e.button > 0) return;
    if (e.pointerType === 'mouse') {
      // one click plays or pauses, a double click goes fullscreen without touching playback
      if (clickTimer) { clearTimeout(clickTimer); clickTimer = null; toggleFs(); return; }
      clickTimer = setTimeout(() => { clickTimer = null; sync.toggle(); wake(); }, 230);
      return;
    }
    const r = stage.getBoundingClientRect();
    const x = (e.clientX - r.left) / r.width;
    const side = x < 0.35 ? 'l' : x > 0.65 ? 'r' : '';
    const now = performance.now();
    if (side && lastTap.side === side && now - lastTap.at < 320) {
      skip(side === 'l' ? -10 : 10);
      lastTap.at = now;
      return;
    }
    lastTap = { at: now, side };
    if (stage.classList.contains('idle')) wake(); else hideHud();
  });

  // ---------- buttons ----------

  for (const b of root.querySelectorAll('[data-skip]')) {
    b.onclick = (e) => { e.stopPropagation(); skip(Number(b.dataset.skip)); wake(); };
  }
  $('playbtn').onclick = $('bigplay').onclick = (e) => { e.stopPropagation(); sync.toggle(); wake(); };
  $('tapbtn').onclick = () => { $('tap').classList.add('hidden'); video.muted = false; sync.tapToPlay(); };
  $('unmute').onclick = (e) => { e.stopPropagation(); sync.unmute(); };
  let policyMuted = false;   // muted by the browser autoplay rule, not by the person
  sync.on('blocked', (v) => { policyMuted = v; $('unmute').classList.toggle('hidden', !v); });
  sync.on('tap', (v) => { $('tap').classList.toggle('hidden', !v); });
  // leaving asks once more right on the button, no browser dialog
  stopArm = onStop ? confirmButton($('stop'), onStop, () => { wake(); if (stopHint) toast(stopHint()); }) : null;

  // ---------- seek bar: drag shows the frame time, the jump happens on release ----------

  const at = (e) => {
    const r = seek.getBoundingClientRect();
    return Math.min(1, Math.max(0, (e.clientX - r.left) / r.width)) * dur();
  };
  const showTip = (t, e) => {
    const r = seek.getBoundingClientRect();
    const x = Math.min(r.width - 28, Math.max(28, e.clientX - r.left));
    tip.textContent = fmtTime(t);
    tip.style.left = `${x}px`;
  };
  seek.addEventListener('pointerdown', (e) => {
    if (!dur() || (e.pointerType === 'mouse' && e.button !== 0)) return;
    e.preventDefault();
    seek.setPointerCapture(e.pointerId);
    drag = at(e);
    seek.classList.add('drag');
    showTip(drag, e);
    paint();
    wake();
  });
  seek.addEventListener('pointermove', (e) => {
    if (!dur()) return;
    const t = at(e);
    if (drag !== null) { drag = t; paint(); }
    showTip(t, e);
  });
  const release = (commit) => {
    if (drag === null) return;
    const t = drag;
    drag = null;
    seek.classList.remove('drag');
    if (commit) sync.seek(t);
    paint();
    wake();
  };
  seek.addEventListener('pointerup', () => release(true));
  seek.addEventListener('pointercancel', () => release(false));
  seek.addEventListener('lostpointercapture', () => release(false));

  // ---------- volume (kept between visits) ----------

  const vol = $('vol');
  video.volume = PREF.get('vol', 1);
  video.muted = PREF.get('muted', false);
  const paintVol = () => {
    vol.value = video.muted ? 0 : video.volume;
    vol.style.setProperty('--v', `${(video.muted ? 0 : video.volume) * 100}%`);
    $('mutebtn').innerHTML = video.muted || video.volume === 0 ? I.mute : I.vol;
  };
  vol.oninput = () => { video.muted = false; video.volume = Number(vol.value); sync.unmute(); };
  $('mutebtn').onclick = (e) => { e.stopPropagation(); video.muted = !video.muted; if (!video.muted) sync.unmute(); };
  let fading = false;          // the end of a film turns the sound down; that is not a choice to save
  video.addEventListener('volumechange', () => {
    if (fading) return;
    PREF.set('vol', video.volume);
    if (!policyMuted) PREF.set('muted', video.muted);
    paintVol();
  });
  paintVol();

  // ---------- fullscreen and picture in picture ----------

  const fsEl = () => document.fullscreenElement || document.webkitFullscreenElement;
  function toggleFs() {
    if (fsEl()) { (document.exitFullscreen || document.webkitExitFullscreen).call(document); return; }
    const req = root.requestFullscreen || root.webkitRequestFullscreen;
    if (req) {
      Promise.resolve(req.call(root, { navigationUI: 'hide' })).then(() => {
        if (isTouch() && screen.orientation && screen.orientation.lock) screen.orientation.lock('landscape').catch(() => {});
      }).catch(() => {});
    } else if (video.webkitEnterFullscreen) {
      video.webkitEnterFullscreen();          // iphone: only the video element itself can go fullscreen
    }
  }
  const paintFs = () => {
    $('fsbtn').innerHTML = fsEl() ? I.fsx : I.fs;
    root.classList.toggle('fs', !!fsEl());
    // the landscape lock taken for fullscreen is given back, the phone may turn upright again
    if (!fsEl() && screen.orientation && screen.orientation.unlock) { try { screen.orientation.unlock(); } catch { /* not locked */ } }
    ambFresh = true;
    ambKick();
  };
  document.addEventListener('fullscreenchange', paintFs);
  document.addEventListener('webkitfullscreenchange', paintFs);
  $('fsbtn').onclick = (e) => { e.stopPropagation(); toggleFs(); };
  if (document.pictureInPictureEnabled && !video.disablePictureInPicture) {
    $('pipbtn').classList.remove('hidden');
    $('pipbtn').onclick = (e) => {
      e.stopPropagation();
      if (document.pictureInPictureElement) document.exitPictureInPicture().catch(() => {});
      else video.requestPictureInPicture().catch(() => {});
    };
  }

  // ---------- settings sheet ----------

  // two levels: the list of what can be chosen with the current value, then the choices of one
  let page = null;
  const chevron = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M9.5 6l6 6-6 6"/></svg>';
  const ambGroup = () => ({
    key: 'amb', title: tr('set.amb'), current: ambOn ? 'on' : 'off',
    items: [{ value: 'on', label: tr('set.on') }, { value: 'off', label: tr('set.off') }],
  });
  // moving between the two levels: the card glides to its new height and the new content slides in
  // from the side it comes from. the stagger of the rows plays only when the sheet opens (.fresh)
  const card = sheet.querySelector('.sheet-card');
  let navDir = 0;
  let navTimer = null;
  function renderSheet() {
    const dir = navDir;
    navDir = 0;
    const glideIt = dir !== 0 && sheet.classList.contains('open') && !calm();
    // a quick second step starts from where the first one is, not from its end
    if (glideIt) for (const a of [...card.getAnimations(), ...body.getAnimations()]) a.cancel();
    const h0 = card.offsetHeight;
    if (dir) sheet.classList.remove('fresh');
    fillSheet();
    if (!glideIt) return;
    const h1 = card.offsetHeight;
    clearTimeout(navTimer);
    card.style.overflow = 'hidden';
    navTimer = setTimeout(() => { card.style.overflow = ''; }, 240);
    if (Math.abs(h1 - h0) > 1) card.animate([{ height: `${h0}px` }, { height: `${h1}px` }], { duration: 220, easing: 'cubic-bezier(.2, .7, .2, 1)' });
    body.animate([{ opacity: 0.25, transform: `translateX(${12 * dir}px)` }, { opacity: 1, transform: 'none' }], { duration: 220, easing: 'cubic-bezier(.16, 1, .3, 1)' });
  }
  function fillSheet() {
    body.replaceChildren();
    const own = media.options();
    const groups = [...own, ambGroup()];
    const g = page && groups.find((x) => x.key === page);
    if (!g) {
      page = null;
      for (const x of groups) {
        const cur = x.items.find((it) => it.value === x.current) || x.items[0];
        const row = document.createElement('button');
        row.className = 'nav';
        const k = document.createElement('span');
        k.className = 'k';
        k.textContent = x.title;
        const v = document.createElement('span');
        v.className = 'v';
        v.textContent = cur.label;
        row.append(k, v);
        row.insertAdjacentHTML('beforeend', chevron);
        row.onclick = (e) => { e.stopPropagation(); page = x.key; navDir = 1; renderSheet(); };
        body.append(row);
      }
      if (!own.length) {
        const p = document.createElement('p');
        p.className = 'muted';
        p.textContent = tr('set.nothing');
        body.append(p);
      }
      return;
    }
    const back = document.createElement('button');
    back.className = 'back';
    back.insertAdjacentHTML('beforeend', chevron);
    const t = document.createElement('span');
    t.textContent = g.title;
    back.append(t);
    back.onclick = (e) => { e.stopPropagation(); page = null; navDir = -1; renderSheet(); };
    body.append(back);
    const list = document.createElement('div');
    list.className = 'opts';
    for (const it of g.items) {
      const row = document.createElement('button');
      row.className = 'opt' + (it.value === g.current ? ' on' : '');
      const l = document.createElement('span');
      l.textContent = it.label;
      row.append(l);
      row.onclick = (e) => {
        e.stopPropagation();
        page = null;
        navDir = -1;
        if (g.key === 'amb') setAmb(it.value === 'on'); else media.choose(g.key, it.value);
        if (navDir) renderSheet();
      };
      list.append(row);
    }
    body.append(list);
    const on = list.querySelector('.on');
    if (on) on.scrollIntoView({ block: 'nearest' });
  }
  media.bind(renderSheet);
  const setSheet = (open) => { sheet.classList.toggle('open', open); sheet.classList.toggle('fresh', open); if (open) { page = null; renderSheet(); } wake(); };
  $('setbtn').onclick = (e) => { e.stopPropagation(); setSheet(!sheet.classList.contains('open')); };
  sheet.addEventListener('click', (e) => { if (e.target === sheet) setSheet(false); });
  document.addEventListener('click', (e) => { if (!sheet.contains(e.target) && e.target !== $('setbtn')) sheet.classList.remove('open', 'fresh'); });

  // ---------- the picture fades in when its first frame is there ----------

  const live = () => { if (video.readyState >= 2) stage.classList.add('live'); };
  video.addEventListener('loadeddata', live);
  video.addEventListener('playing', live);
  video.addEventListener('emptied', () => stage.classList.remove('live'));

  // ---------- ambient light ----------
  // like the ambient light extensions for youtube: the colours of the picture glow around it,
  // centred on the picture, so only a halo shows at its edges. the smoothed picture is drawn,
  // blurred and a bit more saturated, into the middle of a 128x80 canvas, where the blur itself
  // fades it out towards the edges; css only stretches that canvas around the picture. all the blurring happens on
  // about ten thousand pixels instead of a full screen layer (a css blur of the whole layer
  // costs about 40 % of a core per page in software rendering). browsers without canvas
  // filters (older safari) fall back to a css blur. it stands still while the film is paused,
  // in fullscreen and in a hidden tab, and can be switched off in the settings.

  const AMB_W = 128;
  const AMB_H = 80;
  const AMB_IN = 0.5;          // the picture takes this part of the light canvas
  const amb = document.createElement('canvas');
  amb.className = 'ambient';
  amb.width = AMB_W;
  amb.height = AMB_H;
  amb.setAttribute('aria-hidden', 'true');
  root.prepend(amb);
  // three small canvases: `frame` follows the video (read about 12 times a second), `shown`
  // glides towards `frame` about 30 times a second, so the light never changes in visible steps
  // (8 updates a second read as flicker once the light is strong), and `amb`
  // gets `shown` blurred and saturated
  const small = () => { const c = document.createElement('canvas'); c.width = 48; c.height = 27; return c; };
  const frame = small();
  const shownC = small();
  const fctx = frame.getContext('2d', { alpha: false });
  const sctx = shownC.getContext('2d', { alpha: false });
  const actx = amb.getContext('2d');
  actx.filter = 'blur(1px)';
  const canvasBlur = actx.filter === 'blur(1px)';
  actx.filter = 'none';
  amb.classList.toggle('cssblur', !canvasBlur);
  let ambOn = PREF.get('amb', true);
  let ambTimer = null;
  let ambLeft = 0;           // ticks still to run after the picture stopped moving
  let ambFresh = true;
  let sampledAt = 0;
  // whether there should be light at all; a moment without a frame (loading, a seek) only pauses
  // the drawing and keeps the last light, it never switches it off and on again
  const ambWanted = () => ambOn && !fsEl() && !root.classList.contains('hidden') && document.visibilityState === 'visible' && video.videoWidth > 0;
  function ambPlace() {
    const vw = video.videoWidth;
    const vh = video.videoHeight;
    if (!vw || !vh) return;
    const rr = root.getBoundingClientRect();
    const sr = stage.getBoundingClientRect();
    const k = Math.min(sr.width / vw, sr.height / vh);
    const w = vw * k;
    const h = vh * k;
    amb.style.width = `${w}px`;
    amb.style.height = `${h}px`;
    amb.style.setProperty('--ax', `${sr.left - rr.left + (sr.width - w) / 2}px`);
    amb.style.setProperty('--ay', `${sr.top - rr.top + (sr.height - h) / 2}px`);
    amb.style.setProperty('--ab', `${Math.round(Math.max(16, Math.min(40, w * 0.03)))}px`);
  }
  function ambDraw(now) {
    if (video.readyState >= 2 && (ambFresh || now - sampledAt >= 80)) {
      fctx.globalAlpha = ambFresh ? 1 : 0.45;
      fctx.drawImage(video, 0, 0, frame.width, frame.height);
      sampledAt = now;
    }
    sctx.globalAlpha = ambFresh ? 1 : 0.16;
    sctx.drawImage(frame, 0, 0);
    const dw = AMB_W * AMB_IN * 1.14;
    const dh = AMB_H * AMB_IN * 1.14;
    actx.clearRect(0, 0, AMB_W, AMB_H);
    if (canvasBlur) actx.filter = 'blur(9px) saturate(1.7) brightness(1.12)';
    actx.drawImage(shownC, (AMB_W - dw) / 2, (AMB_H - dh) / 2, dw, dh);
    actx.filter = 'none';
  }
  function ambTick() {
    ambTimer = null;
    if (!ambWanted()) { amb.classList.remove('on'); ambFresh = true; return; }
    if (ambFresh && video.readyState < 2) { ambTimer = setTimeout(ambTick, 100); return; }
    try { ambDraw(performance.now()); } catch { return; }
    if (ambFresh) { ambFresh = false; ambPlace(); amb.classList.add('on'); }
    // after a pause or a seek the light keeps gliding for a second until it has settled
    if (!video.paused && !video.seeking) ambLeft = 30;
    else if (--ambLeft <= 0) return;
    ambTimer = setTimeout(ambTick, 33);
  }
  function ambKick() {
    ambLeft = Math.max(ambLeft, 30);
    if (!ambTimer) ambTimer = setTimeout(ambTick, 0);
  }
  function setAmb(v) {
    ambOn = v;
    PREF.set('amb', v);
    ambFresh = true;
    ambKick();
  }
  for (const ev of ['loadeddata', 'playing', 'play', 'seeked', 'resize']) video.addEventListener(ev, ambKick);
  video.addEventListener('emptied', () => { ambFresh = true; amb.classList.remove('on'); });
  document.addEventListener('visibilitychange', ambKick);
  new ResizeObserver(ambPlace).observe(stage);
  video.addEventListener('resize', ambPlace);

  // ---------- keyboard ----------

  document.addEventListener('keydown', (e) => {
    if (/^(input|select|textarea)$/i.test(e.target.tagName) || root.classList.contains('hidden') || e.ctrlKey || e.metaKey || e.altKey) return;
    const k = e.key.toLowerCase();
    const step = e.shiftKey ? 60 : 10;
    let hit = true;
    if (k === ' ' || k === 'k') sync.toggle();
    else if (k === 'arrowright' || k === 'l') skip(step);
    else if (k === 'arrowleft' || k === 'j') skip(-step);
    else if (k === 'arrowup') { video.muted = false; video.volume = Math.min(1, video.volume + 0.05); }
    else if (k === 'arrowdown') video.volume = Math.max(0, video.volume - 0.05);
    // the second letter is the same key on a russian layout
    else if (k === 'f' || k === 'а') toggleFs();
    else if (k === 'm' || k === 'ь') video.muted = !video.muted;
    else if (k === 'c' || k === 'с') chat.toggle();
    else if (k === 'escape') setSheet(false);
    else hit = false;
    if (hit) { e.preventDefault(); wake(); }
  });

  // ---------- status lines ----------

  // a new message from someone else: the film stays clean, only a small card with the message
  // shows up in the top corner (when the chat is not on screen); a tap on it opens the chat
  let pingTimer = null;
  const ping = $('ping');
  function hideNotify() { clearTimeout(pingTimer); ping.classList.remove('show'); }
  ping.onclick = (e) => { e.stopPropagation(); hideNotify(); chat.toggle(); };
  function notify(m, chatShown) {
    if (chatShown) return;
    ping.querySelector('b').textContent = m.from;
    ping.querySelector('span').textContent = m.text;
    ping.classList.remove('show');
    void ping.offsetWidth;
    ping.classList.add('show');
    clearTimeout(pingTimer);
    pingTimer = setTimeout(() => ping.classList.remove('show'), 6000);
  }

  // short lines about what the others did. up to three stand in a column, the oldest leaves
  // first and the rest move up; the same line twice in a row only renews itself
  function toast(text) {
    const box = $('toasts');
    const last = box.lastElementChild;
    let el = last && !last.classList.contains('out') && last.textContent === text ? last : null;
    if (!el) {
      el = document.createElement('div');
      el.className = 'toast';
      el.textContent = text;
      glide(box, () => {
        box.append(el);
        const live = [...box.children].filter((c) => !c.classList.contains('out'));
        for (const old of live.slice(0, -3)) old.remove();
      });
    }
    clearTimeout(el._timer);
    el._timer = setTimeout(() => leaveEl(el), 2600);
  }
  sync.on('denied', () => toast(tr('denied')));
  $('peer').onclick = (e) => { e.stopPropagation(); if (chat.people) chat.people(); };

  return {
    paint,
    toast,
    notify,
    wake,
    setTitle(text) { $('title').textContent = text; document.title = `${text} · synced`; },
    // short blips (a page reload, a quick reconnect) never reach the screen: warnings and the
    // waiting line show up only when the state lasts
    setPeer(text, cls) {
      const p = $('peer');
      // only the state classes change; replacing the whole class list would drop the line's own style
      const name = `peer ${cls || ''}`.trim();
      const put = () => {
        const span = p.querySelector('span');
        const swap = peerText && span.textContent !== text;
        peerText = text;
        p.className = name;
        span.textContent = text;
        if (swap) { span.classList.remove('swap'); void span.offsetWidth; span.classList.add('swap'); }
      };
      clearTimeout(peerTimer);
      if (text === peerText && p.className === name) return;
      if (cls === 'warn' && !p.classList.contains('warn')) peerTimer = setTimeout(put, 900);
      else put();
    },
    setNotice(text) {
      const n = $('notice');
      noticeWant = text;
      if (!text) { clearTimeout(noticeTimer); noticeTimer = null; n.classList.add('hidden'); return; }
      if (!n.classList.contains('hidden')) { n.querySelector('span').textContent = text; return; }
      if (!noticeTimer) {
        noticeTimer = setTimeout(() => {
          noticeTimer = null;
          if (!noticeWant) return;
          n.querySelector('span').textContent = noticeWant;
          n.classList.remove('hidden');
        }, 800);
      }
    },
    fail(text) {
      $('failtext').textContent = text;
      $('fail').classList.toggle('hidden', !text);
    },
    onRetry(fn) { $('retry').onclick = () => { $('fail').classList.add('hidden'); fn(); }; },
    closeSheet() { setSheet(false); },
    hideNotify,
    // the end of a film: the sound goes down with the picture; the returned function puts the
    // saved volume back once the player is empty
    fadeOut(ms) {
      const v0 = video.volume;
      const t0 = performance.now();
      fading = true;
      if (stopArm) stopArm.disarm();
      setSheet(false);
      const step = (t) => {
        if (!fading) return;
        const k = Math.min(1, (t - t0) / ms);
        video.volume = v0 * (1 - k) * (1 - k);
        if (k < 1) requestAnimationFrame(step);
      };
      requestAnimationFrame(step);
      return () => { fading = true; video.volume = v0; setTimeout(() => { fading = false; }, 300); };
    },
    // false: the buttons stay visible but dim, a press says who is in charge
    setControl(v) { sync.setControl(v); stage.classList.toggle('nocontrol', !v); },
  };
}
