'use strict';
// follows the playback clock of the server. host and viewer run the same code: the server
// state says where the film should be right now (in server time), the local video is pulled
// there with a hard seek when it is far off and with a gentle playback rate change otherwise.
// own buttons are applied at once and sent to the server, which answers with the new state.

// two people in two places do not notice 100 ms, but they do hear every change of playback
// rate and see every jump; so the corrections are rare, small and slow
const HARD_SEEK = 1.2;      // s: further off than this, jump
const RATE_START = 0.12;    // s: start a rate correction above this offset
const RATE_STOP = 0.03;     // s: and stop it below this one
const RATE_STEP = 0.03;     // the one rate change used: 3 % faster or slower, inaudible
const RATE_EVERY = 1000;    // ms between rate decisions
const BUF_DELAY = 1000;     // ms a stall must last before the server is told this side is loading
const START_EARLY = 40;     // ms: play() needs about this long before the first frame moves

function createSync({ video, sock, role, uid }) {
  // who this page is among the people in the room: 'host' or the viewer id
  const self = () => (uid ? uid() : role);
  let allowed = true;            // the host can keep the buttons to himself
  let st = null;                 // { seq, playing, held, time, at, holds }
  let ownPending = 0;            // own commands the server has not answered yet
  let guardUntil = 0;
  let lastHard = 0;
  let correcting = false;
  let playing = null;            // pending play() promise
  let isBuf = false;
  let bufTimer = null;
  let expect = { pause: 0, play: 0, seek: 0 };
  let blocked = false;           // autoplay with sound refused, playing muted
  let listeners = { state: [], remote: [], blocked: [], tap: [], denied: [] };
  let wakeLock = null;
  let duration = 0;
  const trace = [];              // last server states, for diagnostics (window.__wp.sync.trace)
  let pending = {};              // last seek and last play or pause pressed while the line was down

  const emit = (k, ...a) => listeners[k].forEach((f) => f(...a));
  const visible = () => document.visibilityState === 'visible';
  const dur = () => duration || (Number.isFinite(video.duration) ? video.duration : 0);

  function target() {
    if (!st) return 0;
    const t = st.playing && !st.held ? st.time + Math.max(0, sock.now() - st.at) / 1000 : st.time;
    const d = dur();
    return Math.max(0, d ? Math.min(t, d) : t);
  }
  const want = () => !!st && st.playing && !st.held;

  function localPause() {
    if (video.paused) return;
    expect.pause++;
    video.pause();
  }

  function localSeek(t) {
    expect.seek++;
    video.currentTime = t;
  }

  function localPlay() {
    if (!video.paused || playing) return;
    // a hidden phone page must not start sound or fall back to mute; it catches up when shown
    if (!visible() && isTouch()) return;
    expect.play++;
    playing = video.play().then(() => {
      playing = null;
      emit('tap', false);
    }, (err) => {
      playing = null;
      expect.play = Math.max(0, expect.play - 1);
      if (err && err.name === 'NotAllowedError' && visible()) {
        if (!video.muted) {
          // the browser wants a tap before sound: keep in sync silently and offer the sound
          video.muted = true;
          blocked = true;
          emit('blocked', true);
          localPlay();
        } else emit('tap', true);
      }
    });
  }

  let startTimer = null;
  let lastAlign = 0;
  let seekLag = 0;               // how far behind a jump usually lands (decoding up to the frame)
  let measureLag = false;
  let lastRate = 0;
  function tick() {
    checkBuf();
    // no clock estimate yet: the device clock alone could be seconds off
    if (!st || video.readyState < 1 || !sock.synced()) return;
    const t = target();
    const diff = video.currentTime - t;
    // a start in the near future: stand ready on the frame and go at the agreed moment
    const lead = want() ? st.at - sock.now() : 0;
    if (lead > 0) {
      localPause();
      if (Math.abs(diff) > 0.05 && !video.seeking) localSeek(t);
      clearTimeout(startTimer);
      startTimer = setTimeout(tick, Math.max(0, lead - START_EARLY));
      if (lead > START_EARLY) return;
    }
    const now = performance.now();
    if (!want()) {
      localPause();
      if (video.playbackRate !== 1) video.playbackRate = 1;
      correcting = false;
      // throttled: a position the element cannot reach exactly must not loop seek, seeked, seek
      if (Math.abs(diff) > 0.1 && !video.seeking && now - lastAlign > 500) { lastAlign = now; localSeek(t); }
      return;
    }
    if (video.seeking) return;
    // play() on an ended element jumps to 0; at the end there is nothing to start
    if (video.ended) {
      if (t < video.duration - 0.3 && now - lastHard > 1500) { lastHard = now; localSeek(t); }
      return;
    }
    if (measureLag && video.readyState >= 3 && !video.paused) {
      measureLag = false;
      seekLag = Math.max(0, Math.min(0.8, seekLag - diff * 0.7));
    }
    const off = Math.abs(diff);
    if (off > HARD_SEEK) {
      if (now - lastHard > 1500) {
        lastHard = now;
        correcting = false;
        video.playbackRate = 1;
        measureLag = true;
        localSeek(t + seekLag);
      }
    } else if (video.readyState >= 3 && !video.paused && now - lastRate > RATE_EVERY) {
      lastRate = now;
      const r = off > RATE_START || (correcting && off > RATE_STOP) ? (diff > 0 ? 1 - RATE_STEP : 1 + RATE_STEP) : 1;
      correcting = r !== 1;
      if (video.playbackRate !== r) video.playbackRate = r;
    }
    localPlay();
  }
  setInterval(tick, 200);

  // ---------- buffering: the server may hold the room on the same frame ----------

  function sendBuf(v) {
    if (v === isBuf) return;
    isBuf = v;
    sock.send({ t: 'buf', v });
  }
  // loading counts while the room wants to play (held or not): a hold is released only when
  // this side really has data, never by an unrelated media event
  function checkBuf() {
    const loading = video.seeking || video.readyState < 3;
    if (!loading) { clearTimeout(bufTimer); bufTimer = null; sendBuf(false); return; }
    if (!st || !st.playing || video.ended) { clearTimeout(bufTimer); bufTimer = null; return; }
    if (!isBuf && !bufTimer) {
      bufTimer = setTimeout(() => {
        bufTimer = null;
        if (st && st.playing && (video.seeking || video.readyState < 3)) sendBuf(true);
      }, BUF_DELAY);
    }
  }
  for (const ev of ['waiting', 'seeking', 'stalled']) video.addEventListener(ev, checkBuf);
  // right after a stall the picture already stood still, so a small jump back onto the clock
  // goes unnoticed; otherwise the lost time would take half a minute of slower playback
  let stalled = false;
  video.addEventListener('waiting', () => { if (want() && !video.seeking) stalled = true; });
  video.addEventListener('playing', () => {
    if (!stalled) return;
    stalled = false;
    const diff = video.currentTime - target();
    if (want() && Math.abs(diff) > 0.25 && Math.abs(diff) <= HARD_SEEK) { lastHard = performance.now(); measureLag = true; localSeek(target() + seekLag); }
  });
  for (const ev of ['playing', 'canplay', 'canplaythrough', 'seeked', 'loadeddata']) {
    video.addEventListener(ev, () => tick());
  }
  setInterval(() => { if (isBuf) sock.send({ t: 'buf', v: true }); }, 3000);

  // ---------- events the page did not cause (ios native fullscreen, picture in picture) ----------

  const native = () => !!(video.webkitDisplayingFullscreen || document.pictureInPictureElement === video);
  video.addEventListener('pause', () => {
    if (expect.pause) { expect.pause--; return; }
    if (video.ended || !visible() && !native()) return;
    if (want() && native()) api.pause();
  });
  video.addEventListener('play', () => {
    if (expect.play) { expect.play--; return; }
    if (st && !st.playing && native()) api.play();
  });
  video.addEventListener('seeked', () => {
    if (expect.seek) { expect.seek--; return; }
    if (native() && st && Math.abs(video.currentTime - target()) > 1) api.seek(video.currentTime);
  });

  // ---------- keep the screen on while the film runs ----------

  async function wake() {
    const on = want() && visible();
    try {
      if (on && !wakeLock && navigator.wakeLock) {
        wakeLock = await navigator.wakeLock.request('screen');
        wakeLock.addEventListener('release', () => { wakeLock = null; });
      } else if (!on && wakeLock) { await wakeLock.release(); wakeLock = null; }
    } catch { wakeLock = null; }
  }
  document.addEventListener('visibilitychange', () => {
    if (visible()) { sock.send({ t: 'sync' }); tick(); }
    wake();
  });

  // ---------- lock screen and headset buttons ----------

  if ('mediaSession' in navigator) {
    const ms = navigator.mediaSession;
    const h = (a, f) => { try { ms.setActionHandler(a, f); } catch { /* unsupported action */ } };
    h('play', () => api.play());
    h('pause', () => api.pause());
    h('seekbackward', (d) => api.skip(-(d.seekOffset || 10)));
    h('seekforward', (d) => api.skip(d.seekOffset || 10));
    h('seekto', (d) => api.seek(d.seekTime));
  }

  function cmd(m) {
    if (sock.send(m)) return;
    if (m.t === 'seek') pending.seek = m; else pending.toggle = m;
  }

  function own(change) {
    if (!st) return;
    ownPending++;
    guardUntil = performance.now() + 1500;
    st = { ...st, ...change };
    tick();
    emit('state', st);
    wake();
  }

  const api = {
    apply(m) {
      trace.push({ at: Math.round(sock.now()), seq: m.seq, p: m.playing, h: m.held, t: +m.time.toFixed(3), mat: m.at, holds: (m.holds || []).map((x) => x.who[0] + x.why).join(','), by: m.by ? m.by.who + ':' + m.by.act : '', v: +video.currentTime.toFixed(3) });
      if (trace.length > 40) trace.shift();
      // while own commands are on their way, states sent before them would undo them for a moment
      if (m.by && m.by.id === self() && ownPending) ownPending--;
      if (ownPending && performance.now() < guardUntil) return;
      ownPending = 0;
      const prev = st;
      st = m;
      if (m.by && m.by.id !== self() && prev) emit('remote', m.by, st);
      tick();
      emit('state', st);
      wake();
    },
    setDuration(d) { duration = Number(d) || 0; },
    // after a reconnect: a button pressed offline still counts, then fetch the current state
    flush() {
      const list = [pending.seek, pending.toggle].filter(Boolean);
      pending = {};
      if (list.length) { ownPending = list.length; guardUntil = performance.now() + 1500; list.forEach((m) => sock.send(m)); }
      sock.send({ t: 'sync' });
    },
    // without a line to the server this page cannot know the clock, so it stands still
    offline() {
      if (!st || st.held) return;
      st = { ...st, time: target(), at: sock.now(), held: true, holds: [...(st.holds || []), { who: role, id: self(), why: 'away' }] };
      isBuf = false;
      tick();
      emit('state', st);
      wake();
    },
    reset() { st = null; ownPending = 0; pending = {}; sendBuf(false); clearTimeout(bufTimer); bufTimer = null; video.playbackRate = 1; wake(); },
    get state() { return st; },
    target,
    playingWanted: want,
    // false: play, pause and seek belong to the host; a press only says so
    setControl(v) { allowed = !!v; },
    get control() { return allowed; },
    play() {
      if (!st) return;
      if (!allowed) return emit('denied');
      const t = dur() && target() >= dur() - 0.5 ? 0 : target();
      cmd({ t: 'play' });
      own({ playing: true, time: t, at: sock.now() + 300 });
    },
    pause() {
      if (!st) return;
      if (!allowed) return emit('denied');
      const t = video.readyState >= 1 ? video.currentTime : target();
      cmd({ t: 'pause', time: t });
      own({ playing: false, time: t, at: sock.now() });
    },
    toggle() { if (st && st.playing) api.pause(); else api.play(); },
    seek(t) {
      if (!st || !Number.isFinite(t)) return;
      if (!allowed) return emit('denied');
      const d = dur();
      t = Math.max(0, d ? Math.min(t, d - 0.1) : t);
      cmd({ t: 'seek', time: t });
      own({ time: t, at: st.playing ? sock.now() + 300 : sock.now() });
    },
    skip(d) { api.seek(target() + d); },
    unmute() { video.muted = false; blocked = false; emit('blocked', false); localPlay(); },
    tapToPlay() { localPlay(); },
    on(k, f) { listeners[k].push(f); },
    trace,
    drift: () => (st && video.readyState >= 1 ? video.currentTime - target() : null),
  };
  return api;
}
