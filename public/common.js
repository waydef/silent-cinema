'use strict';
// websocket that survives flaky networks and phones: reconnects with backoff and at once when
// the page comes back to the foreground or the network returns, drops a silent connection after
// 10 s, estimates the server clock (ntp style, best of the recent round trips), says goodbye
// when the page goes away and reloads the page after a server update

function openSocket(role, handlers) {
  let ws = null;
  let wait = 400;
  let pingTimer = null;
  let retryTimer = null;
  let lastSeen = 0;
  let connAt = 0;
  let stopped = false;    // for good: replaced or kicked
  let away = false;       // page hidden into the back-forward cache or closing
  let samples = [];       // { at, rtt, off, skew }
  let offset = 0;
  let rtt = 0;

  // the wall clock keeps running while a phone sleeps (performance.now may not); the gap between
  // the two only changes when one of them jumped, and then the old samples are worthless
  const local = () => Date.now();
  const skew = () => Date.now() - performance.now();

  function build(b) {
    const prev = sessionStorage.getItem('wp.build');
    sessionStorage.setItem('wp.build', b);
    if (prev && prev !== b) location.reload();
  }

  function onPong(m) {
    const now = local();
    const r = now - m.c;
    if (!(r >= 0) || !Number.isFinite(m.s)) return;
    const k = skew();
    samples.push({ at: now, rtt: r, off: m.s + r / 2 - now, skew: k });
    samples = samples.filter((x) => now - x.at < 60000 && Math.abs(x.skew - k) < 500).slice(-12);
    const best = samples.reduce((a, b) => (b.rtt < a.rtt ? b : a));
    offset = best.off;
    rtt = rtt ? rtt * 0.7 + r * 0.3 : r;
  }

  const ping = () => send({ t: 'ping', c: local() });

  function connect() {
    clearTimeout(retryTimer);
    if (ws && ws.readyState <= 1) return;
    connAt = Date.now();
    ws = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws?role=${role}`);
    const mine = ws;
    ws.onopen = () => {
      wait = 400;
      lastSeen = Date.now();
      clearInterval(pingTimer);
      // a short burst first so the clock estimate is good right away
      ping();
      [250, 500, 750, 1000].forEach((d) => setTimeout(() => mine === ws && ping(), d));
      pingTimer = setInterval(() => {
        if (Date.now() - lastSeen > 10000) return restart();
        ping();
      }, 3000);
      handlers.open && handlers.open();
    };
    ws.onmessage = (e) => {
      lastSeen = Date.now();
      let m;
      try { m = JSON.parse(e.data); } catch { return; }
      if (m.t === 'pong') onPong(m);
      else if (m.t === 'ver') build(m.build);
      else if (m.t === 'avatars') { AVA.set(m.map); if (handlers.avatars) handlers.avatars(); }
      else handlers.message && handlers.message(m);
    };
    ws.onclose = () => {
      if (ws !== mine) return;
      clearInterval(pingTimer);
      handlers.close && handlers.close();
      if (!stopped && !away) retryTimer = setTimeout(connect, wait = Math.min(wait * 2, 4000));
    };
  }

  function send(obj) {
    if (!ws || ws.readyState !== 1) return false;
    ws.send(JSON.stringify(obj));
    return true;
  }

  // a dead line is dropped at once instead of waiting for the browser's close handshake,
  // which on a half-open connection (wifi switch, tunnel) can take half a minute
  function restart() {
    if (ws && ws.readyState <= 1) {
      const old = ws;
      ws = null;
      old.onclose = null;
      old.close();
      clearInterval(pingTimer);
      handlers.close && handlers.close();
    }
    wait = 400;
    connect();
  }

  // phones freeze background pages: when the page is back, check the line at once
  function revive() {
    if (stopped) return;
    away = false;
    // a connection that is still being set up gets its chance; a hung one is replaced
    if (ws && ws.readyState === 0 && Date.now() - connAt < 6000) return;
    if (!ws || ws.readyState > 1 || Date.now() - lastSeen > 5000) restart();
    else ping();
  }
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') revive(); });
  window.addEventListener('online', revive);
  window.addEventListener('focus', revive);

  // a closed or reloaded tab says goodbye, the server then knows it was not a network loss
  window.addEventListener('pagehide', () => { send({ t: 'bye' }); away = true; if (ws) ws.close(); });
  window.addEventListener('pageshow', (e) => { if (e.persisted) revive(); });

  connect();
  return {
    send,
    rtt: () => rtt,
    now: () => local() + offset,                 // server clock in ms
    online: () => !!ws && ws.readyState === 1,
    synced: () => samples.length > 0,
    stop: () => { stopped = true; clearTimeout(retryTimer); if (ws) ws.close(); },
    drop: () => { if (ws) ws.close(); },          // test hook: behaves like a lost connection
  };
}

function fmtSize(n) {
  if (n >= 2 ** 30) return tr('size.gb', { n: (n / 2 ** 30).toFixed(1) });
  return tr('size.mb', { n: Math.round(n / 2 ** 20) });
}

function fmtTime(s) {
  s = Math.max(0, Math.floor(s || 0));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const x = String(s % 60).padStart(2, '0');
  return h ? `${h}:${String(m).padStart(2, '0')}:${x}` : `${m}:${x}`;
}

const PREF = {
  get(k, d) { try { const v = localStorage.getItem('wp.' + k); return v === null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { localStorage.setItem('wp.' + k, JSON.stringify(v)); } catch { /* private mode */ } },
  del(k) { try { localStorage.removeItem('wp.' + k); } catch { /* private mode */ } },
};

const isTouch = () => matchMedia('(hover: none) and (pointer: coarse)').matches;

// ios keeps the layout viewport when the keyboard opens; the app follows the visible part instead
function trackViewport() {
  const vv = window.visualViewport;
  const set = () => {
    // a pinch zoom shrinks the visual viewport too; only the keyboard should resize the app
    const h = vv && Math.abs(vv.scale - 1) < 0.01 ? vv.height : window.innerHeight;
    document.documentElement.style.setProperty('--app-h', `${Math.round(h)}px`);
    if (vv && vv.offsetTop) window.scrollTo(0, 0);
  };
  set();
  (vv || window).addEventListener('resize', set);
  if (vv) vv.addEventListener('scroll', set);
  window.addEventListener('orientationchange', () => setTimeout(set, 300));
}
trackViewport();

// layout follows how the phone is held. an open keyboard makes the visible area wider than tall,
// and a layout switch at that moment hid the chat input and closed the keyboard again; so while a
// text field has the focus the layout stays as it is
function trackPose() {
  const root = document.documentElement;
  const typing = () => { const a = document.activeElement; return !!a && a.tagName === 'INPUT' && a.type !== 'range'; };
  const set = () => {
    if (typing()) return;
    const phone = isTouch() && Math.min(screen.width, screen.height) < 700;
    const upright = phone ? window.innerHeight >= window.innerWidth : window.innerWidth <= 760 && window.innerHeight > window.innerWidth;
    root.classList.toggle('phone', phone);
    root.classList.toggle('upright', upright);
    root.classList.toggle('sideways', phone && !upright);
  };
  set();
  window.addEventListener('resize', set);
  window.addEventListener('orientationchange', () => setTimeout(set, 250));
  document.addEventListener('focusout', () => setTimeout(set, 400));
}
trackPose();

// ---------- chat panel (history comes from the server) ----------

// reaction emoji: animated noto emoji (apache 2.0) served from /emoji/, the code is the file name
const EMOJI = [
  ['2764_fe0f', '❤️'], ['1f44d', '👍'], ['1f602', '😂'], ['1f62e', '😮'], ['1f622', '😢'], ['1f525', '🔥'],
  ['1f440', '👀'], ['1f60e', '😎'], ['1f970', '🥰'], ['1f631', '😱'], ['1f92f', '🤯'], ['1f389', '🎉'],
];
const EMOJI_CHAR = Object.fromEntries(EMOJI);

function emojiImg(code, animated) {
  const img = document.createElement('img');
  img.className = 'emo';
  img.alt = EMOJI_CHAR[code] || '';
  img.draggable = false;
  img.src = `/emoji/${code}.${animated ? 'webp' : 'svg'}`;
  return img;
}

function createChat({ root, button, role, uid, onSeen = () => {} }) {
  const self = () => (uid ? uid() : role);
  const log = root.querySelector('.log');
  const form = root.querySelector('form');
  const input = form.querySelector('input');
  const watch = root.closest('.watch');
  const typingBox = root.querySelector('.typing');
  const replyBar = root.querySelector('.replybar');
  let unread = 0;
  let sender = () => {};
  let signal = () => {};
  let last = null;               // { key, at, row } of the newest message, for grouping
  let replyTo = null;            // message the next one answers
  const byId = new Map();        // id -> { m, row }

  // on a phone held upright the chat is always under the picture
  const visible = () => root.getClientRects().length > 0 && getComputedStyle(root).visibility !== 'hidden' && !root.classList.contains('tab-people');
  const badge = () => {
    let b = button.querySelector('.badge');
    // the same count as a dot on the chat tab, for when the people list is open
    root.classList.toggle('unread', unread > 0);
    if (!unread) { if (b) b.remove(); return; }
    if (!b) { b = document.createElement('span'); b.className = 'badge'; button.append(b); }
    b.textContent = unread > 9 ? '9+' : String(unread);
  };
  const nearBottom = () => log.scrollHeight - log.scrollTop - log.clientHeight < 60;
  const isMine = (m) => m.uid === self();
  const nameOf = (m) => (isMine(m) ? tr('you') : m.from);

  // messages of one sender in a row form a group: the nick above the first, the
  // time under the last, and the corners where two bubbles touch are tight (single, first, mid, last)
  const GROUP_GAP = 5 * 60000;
  const stamp = (at) => new Date(at || Date.now()).toLocaleTimeString(LANG === 'en' ? undefined : LANG, { hour: '2-digit', minute: '2-digit' });

  function quote(r) {
    const q = document.createElement('div');
    q.className = 'quote' + (isMine(r) ? ' mine' : '');
    const b = document.createElement('b');
    b.textContent = nameOf(r);
    const t = document.createElement('span');
    t.textContent = r.text;
    q.append(b, t);
    return q;
  }

  // a bubble that changes size glides instead of jumping (flip): the new layout is applied at once,
  // then everything that moved is shifted back with transforms and the bubble is clipped to its old
  // size, and both run to zero. transforms and clip-path move by fractions of a pixel, so nothing
  // reflows during the animation and the text does not shake; the scroll position is set once
  const FLIP = 200;
  function flip(entry, change, stick) {
    const row = entry.row;
    const bubble = row.querySelector('.bubble');
    if (log._flipEnd) log._flipEnd();
    const lr = log.getBoundingClientRect();
    const near = (r) => r.bottom > lr.top - 200 && r.top < lr.bottom + 200;
    const rows = [...log.children].filter((r) => r !== row && near(r.getBoundingClientRect()));
    const parts = [...row.children];
    // the sender's face sits at the bottom of the bubble and has to travel with it
    const face = row.querySelector('.mava');
    if (face) parts.push(face);
    const top = (el) => el.getBoundingClientRect().top;
    const before = new Map([...rows, ...parts].map((el) => [el, top(el)]));
    const b0 = bubble.getBoundingClientRect();
    change();
    if (stick) log.scrollTop = log.scrollHeight;
    const b1 = bubble.getBoundingClientRect();
    const dw = b1.width - b0.width;
    const dh = b1.height - b0.height;
    const moved = [];
    for (const [el, t] of before) {
      const d = t - top(el);
      if (Math.abs(d) < 0.5 || !el.isConnected) continue;
      el.style.transition = 'none';
      el.style.transform = `translateY(${d}px)`;
      moved.push(el);
    }
    const mine = row.classList.contains('mine');
    const inner = [...bubble.children];
    let clipped = false;
    if (Math.abs(dw) >= 0.5 || Math.abs(dh) >= 0.5) {
      clipped = true;
      const rad = getComputedStyle(bubble).borderRadius;
      const side = Math.max(0, dw);
      bubble.style.transition = 'none';
      bubble.style.clipPath = `inset(0 ${mine ? 0 : side}px ${Math.max(0, dh)}px ${mine ? side : 0}px round ${rad})`;
      bubble.dataset.rad = rad;
      // an own bubble grows to the left: its content keeps its place until the edge has passed
      if (mine && dw) for (const c of inner) { c.style.transition = 'none'; c.style.transform = `translateX(${dw}px)`; }
    }
    if (!moved.length && !clipped) return;
    void log.offsetWidth;
    const tr = `transform ${FLIP}ms var(--ease), clip-path ${FLIP}ms var(--ease)`;
    for (const el of moved) { el.style.transition = tr; el.style.transform = ''; }
    if (clipped) {
      bubble.style.transition = tr;
      bubble.style.clipPath = `inset(0 0 0 0 round ${bubble.dataset.rad})`;
      if (mine && dw) for (const c of inner) { c.style.transition = tr; c.style.transform = ''; }
    }
    const timer = setTimeout(() => log._flipEnd && log._flipEnd(), FLIP + 40);
    log._flipEnd = () => {
      clearTimeout(timer);
      log._flipEnd = null;
      for (const el of [...moved, bubble, ...inner]) { el.style.transition = ''; el.style.transform = ''; }
      bubble.style.clipPath = '';
    };
  }

  function chipFor(m, code) {
    const chip = document.createElement('button');
    chip.type = 'button';
    chip.className = 'rchip';
    chip.dataset.code = code;
    const img = emojiImg(code, false);
    const n = document.createElement('span');
    n.className = 'n';
    chip.append(img, n);
    chip.onmouseenter = () => { img.src = `/emoji/${code}.webp`; };
    chip.onmouseleave = () => { if (!chip._playing) img.src = `/emoji/${code}.svg`; };
    chip.onclick = (e) => { e.stopPropagation(); signal({ t: 'react', id: m.id, e: code }); };
    return chip;
  }

  // chips are kept and updated in place, so only what really changed moves
  function paintReacts(entry, fresh, animate) {
    const { m, row } = entry;
    const bubble = row.querySelector('.bubble');
    const groups = new Map();
    for (const [who, code] of Object.entries(m.reacts || {})) { if (!groups.has(code)) groups.set(code, []); groups.get(code).push(who); }
    const stick = animate && nearBottom();
    const apply = () => {
      let box = bubble.querySelector('.rx');
      if (!groups.size) { if (box) box.remove(); return; }
      if (!box) { box = document.createElement('div'); box.className = 'rx'; bubble.append(box); }
      for (const chip of [...box.children]) if (!groups.has(chip.dataset.code)) chip.remove();
      for (const [code, who] of groups) {
        let chip = box.querySelector(`.rchip[data-code="${code}"]`);
        const isNew = !chip;
        if (isNew) { chip = chipFor(m, code); box.append(chip); }
        chip.classList.toggle('own', who.includes(self()));
        const count = who.length > 1 ? String(who.length) : '';
        const n = chip.querySelector('.n');
        if (n.textContent !== count) {
          n.textContent = count;
        }
        if (animate && isNew) { chip.classList.add('enter'); chip.addEventListener('animationend', () => chip.classList.remove('enter'), { once: true }); }
        if (fresh === code) {
          // telegram plays the animation once and then shows the still picture
          const img = chip.querySelector('.emo');
          img.src = `/emoji/${code}.webp`;
          chip._playing = true;
          clearTimeout(chip._still);
          chip._still = setTimeout(() => { chip._playing = false; if (!chip.matches(':hover')) img.src = `/emoji/${code}.svg`; }, 3000);
        }
      }
    };
    if (!animate) return apply();
    // a chip that goes away fades first, then the bubble closes the gap
    const box = bubble.querySelector('.rx');
    const leaving = box ? [...box.children].filter((c) => !groups.has(c.dataset.code)) : [];
    if (!leaving.length) return flip(entry, apply, stick);
    leaving.forEach((c) => c.classList.add('leave'));
    if (groups.size) return setTimeout(() => flip(entry, apply, stick), 140);
    // the last reaction goes: its row folds away (the bubble shrinks with it), then it is removed
    const r = box.getBoundingClientRect();
    box.style.width = `${r.width}px`;
    box.style.height = `${r.height}px`;
    void box.offsetWidth;
    box.classList.add('fold');
    setTimeout(apply, FLIP + 40);
  }

  function render(m, animate) {
    const at = m.at || Date.now();
    const key = (isMine(m) ? 'me' : 'them') + '|' + m.from;
    const cont = !!last && last.key === key && at - last.at < GROUP_GAP;
    const row = document.createElement('div');
    row.className = 'msg' + (isMine(m) ? ' mine' : '') + (cont ? ' cont last' : ' single') + (animate ? ' fresh' : '');
    if (m.id) row.dataset.id = m.id;
    const bubble = document.createElement('div');
    bubble.className = 'bubble';
    if (m.reply) {
      const q = quote(m.reply);
      q.onclick = (e) => { e.stopPropagation(); jump(m.reply.id); };
      bubble.append(q);
    }
    const body = document.createElement('div');
    body.className = 'text';
    body.textContent = m.text;
    bubble.append(body);
    const t = document.createElement('time');
    t.textContent = stamp(at);
    const wrap = document.createElement('div');
    wrap.className = 'bwrap';
    wrap.append(bubble);
    // the face of the sender stands next to the last bubble of a group, as in telegram
    if (!isMine(m)) wrap.append(avaEl(m.from, 'mava'));
    if (cont) {
      row.append(wrap, t);
      const p = last.row.classList;
      p.add('more');
      if (p.contains('single')) p.replace('single', 'first');
      else if (p.contains('last')) p.replace('last', 'mid');
    } else {
      const head = document.createElement('div');
      head.className = 'head';
      const who = document.createElement('b');
      who.textContent = nameOf(m);
      head.append(who);
      row.append(head, wrap, t);
    }
    if (animate) row.addEventListener('animationend', () => row.classList.remove('fresh'), { once: true });
    log.append(row);
    last = { key, at, row };
    const entry = { m, row };
    if (m.id) byId.set(m.id, entry);
    paintReacts(entry);
    gestures(entry, bubble);
    root.classList.remove('empty');
  }

  function jump(id) {
    const e = byId.get(id);
    if (!e) return;
    e.row.scrollIntoView({ block: 'center', behavior: 'smooth' });
    e.row.classList.remove('flash'); void e.row.offsetWidth; e.row.classList.add('flash');
  }

  // ---------- reply ----------

  function setReply(m) {
    replyTo = m;
    replyBar.classList.toggle('show', !!m);
    if (!m) return;
    replyBar.querySelector('b').textContent = isMine(m) ? tr('reply.self') : tr('reply.to', { name: m.from });
    replyBar.querySelector('span').textContent = m.text;
    input.focus({ preventScroll: true });
  }
  replyBar.querySelector('button').onclick = (e) => { e.stopPropagation(); setReply(null); };

  // ---------- message menu: reactions on top, actions below (right click, long press, hover button) ----------

  const menu = document.createElement('div');
  menu.className = 'msgmenu';
  const pick = document.createElement('div');
  pick.className = 'pick';
  const acts = document.createElement('div');
  acts.className = 'acts';
  menu.append(pick, acts);
  root.append(menu);
  let menuFor = null;
  for (const [code] of EMOJI) {
    const b = document.createElement('button');
    b.type = 'button';
    b.dataset.code = code;
    b.setAttribute('aria-label', tr('react.aria', { e: EMOJI_CHAR[code] }));
    b.append(emojiImg(code, true));
    b.onclick = (e) => { e.stopPropagation(); if (menuFor) signal({ t: 'react', id: menuFor.m.id, e: code }); closeMenu(); };
    pick.append(b);
  }
  const act = (label, fn) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.textContent = label;
    b.onclick = (e) => { e.stopPropagation(); const f = menuFor; closeMenu(); if (f) fn(f.m); };
    acts.append(b);
  };
  act(tr('act.reply'), (m) => setReply(m));
  act(tr('act.copy'), (m) => { if (navigator.clipboard) navigator.clipboard.writeText(m.text).catch(() => {}); });

  function openMenu(entry) {
    if (!entry.m.id) return;
    menuFor = entry;
    const mine = (entry.m.reacts || {})[self()];
    for (const b of pick.children) b.classList.toggle('on', b.dataset.code === mine);
    menu.classList.add('show');
    entry.row.classList.add('picked');
    // above the bubble when it fits, otherwise under it, always inside the panel
    const pr = root.getBoundingClientRect();
    const br = entry.row.querySelector('.bubble').getBoundingClientRect();
    const mw = menu.offsetWidth;
    const mh = menu.offsetHeight;
    let top = br.top - pr.top - mh - 6;
    if (top < 56) top = Math.min(br.bottom - pr.top + 6, pr.height - mh - 70);
    const left = Math.max(8, Math.min(pr.width - mw - 8, (isMine(entry.m) ? br.right - pr.left - mw : br.left - pr.left)));
    menu.style.top = `${Math.max(56, top)}px`;
    menu.style.left = `${left}px`;
  }
  function closeMenu() {
    if (menuFor) menuFor.row.classList.remove('picked');
    menuFor = null;
    menu.classList.remove('show');
  }
  document.addEventListener('pointerdown', (e) => { if (menuFor && !menu.contains(e.target)) closeMenu(); }, true);
  log.addEventListener('scroll', () => { if (menuFor) closeMenu(); });
  document.addEventListener('keydown', (e) => { if (menuFor && e.key === 'Escape') { e.stopPropagation(); closeMenu(); } }, true);

  function gestures(entry, bubble) {
    // hover tools (desktop), in the middle of the bubble's side whatever its height
    const tools = document.createElement('div');
    tools.className = 'tools';
    const pill = document.createElement('div');
    pill.className = 'pill';
    tools.append(pill);
    const tool = (label, svg, fn) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.setAttribute('aria-label', label);
      b.innerHTML = svg;
      b.onclick = (e) => { e.stopPropagation(); fn(); };
      pill.append(b);
    };
    tool(tr('act.reply'), '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M10 7l-5 5 5 5"/><path d="M5 12h9a5 5 0 0 1 5 5v1"/></svg>',
      () => { if (entry.m.id) setReply(entry.m); });
    tool(tr('act.react'), '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"><circle cx="12" cy="12" r="8.5"/><path d="M8.8 14.2c.8 1 1.9 1.6 3.2 1.6s2.4-.6 3.2-1.6"/><path d="M9.3 10h.01M14.7 10h.01" stroke-width="2.4"/></svg>',
      () => { if (menuFor === entry) closeMenu(); else openMenu(entry); });
    bubble.after(tools);
    bubble.addEventListener('contextmenu', (e) => { e.preventDefault(); openMenu(entry); });
    // double click or double tap: the heart, as the quick reaction in telegram
    bubble.addEventListener('dblclick', (e) => { e.preventDefault(); window.getSelection()?.removeAllRanges(); if (entry.m.id) signal({ t: 'react', id: entry.m.id, e: '2764_fe0f' }); });
    // touch: long press opens the menu, a swipe to the left answers
    let press = null;
    bubble.addEventListener('pointerdown', (e) => {
      if (e.pointerType === 'mouse') return;
      press = { x: e.clientX, y: e.clientY, dx: 0, timer: setTimeout(() => { if (press) { press.long = true; openMenu(entry); if (navigator.vibrate) navigator.vibrate(10); } }, 450) };
    });
    bubble.addEventListener('pointermove', (e) => {
      if (!press) return;
      const dx = e.clientX - press.x;
      const dy = e.clientY - press.y;
      if (Math.abs(dy) > 12 && Math.abs(dy) > Math.abs(dx)) { clearTimeout(press.timer); press = null; entry.row.style.transform = ''; return; }
      if (Math.abs(dx) > 8) clearTimeout(press.timer);
      if (dx < 0) { press.dx = Math.max(dx, -80); entry.row.style.transform = `translateX(${press.dx}px)`; }
    });
    const end = () => {
      if (!press) return;
      clearTimeout(press.timer);
      if (press.dx < -55 && entry.m.id) setReply(entry.m);
      entry.row.style.transition = 'transform .2s var(--ease)';
      entry.row.style.transform = '';
      setTimeout(() => { entry.row.style.transition = ''; }, 220);
      press = null;
    };
    bubble.addEventListener('pointerup', end);
    bubble.addEventListener('pointercancel', end);
  }

  // ---------- "is typing" ----------

  let typingTimer = null;
  function showTyping(m) {
    clearTimeout(typingTimer);
    if (!m || !m.v) { typingBox.classList.remove('show'); return; }
    const stick = nearBottom();
    typingBox.querySelector('span').textContent = tr('typing', { name: m.from });
    typingBox.classList.add('show');
    if (stick) log.scrollTop = log.scrollHeight;
    // a lost "stopped typing" must not leave the dots forever
    typingTimer = setTimeout(() => typingBox.classList.remove('show'), 6000);
  }
  let typingSent = 0;
  function sendTyping(v) {
    const now = Date.now();
    if (v && typingSent && now - typingSent < 2500) return;
    if (!v && !typingSent) return;
    typingSent = v ? now : 0;
    signal({ t: 'typing', v });
  }
  input.addEventListener('input', () => { sendTyping(input.value.trim().length > 0); fillState(); });
  // the button wakes up when there is something to send
  const go = form.querySelector('button');
  const fillState = () => go.classList.toggle('ready', input.value.trim().length > 0);
  fillState();
  // the arrow leaves through the right edge (the button clips it), a fresh one slides in from
  // the left, and a soft ring runs out of the button: one calm gesture, about half a second
  function sentFx() {
    if (calm()) return;
    const svg = go.querySelector('svg');
    svg.getAnimations().forEach((a) => a.cancel());
    const out = svg.animate([
      { transform: 'none', opacity: 1 },
      { transform: 'translateX(24px) scaleX(1.2)', opacity: 0 },
    ], { duration: 190, easing: 'cubic-bezier(.55, 0, .85, .25)' });
    out.onfinish = () => svg.animate([
      { transform: 'translateX(-20px)', opacity: 0 },
      { transform: 'none', opacity: 1 },
    ], { duration: 420, easing: 'cubic-bezier(.16, 1, .3, 1)' });
    go.classList.remove('sent');
    void go.offsetWidth;
    go.classList.add('sent');
  }
  input.addEventListener('blur', () => sendTyping(false));

  function set(open) {
    watch.classList.toggle('chat-open', open);
    PREF.set('chat', open);
    if (open) {
      if (visible()) { unread = 0; badge(); onSeen(); }
      log.scrollTop = log.scrollHeight;
      if (!isTouch() && !root.classList.contains('tab-people')) input.focus({ preventScroll: true });
    } else closeMenu();
  }

  button.onclick = (e) => { e.stopPropagation(); set(!watch.classList.contains('chat-open')); };
  root.querySelector('.close').onclick = () => set(false);
  form.onsubmit = (e) => {
    e.preventDefault();
    const text = input.value.trim();
    if (!text) return;
    sender(text, replyTo ? replyTo.id : undefined);
    sentFx();
    input.value = '';
    fillState();
    setReply(null);
    sendTyping(false);
  };
  input.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    if (replyTo) { e.stopPropagation(); setReply(null); } else input.blur();
  });
  if (PREF.get('chat', !isTouch())) watch.classList.add('chat-open');
  // the chat came into view by any way (button, key, a phone turned upright): the unread count and
  // the message card over the picture have done their job
  new ResizeObserver(() => { if (visible()) { if (unread) { unread = 0; badge(); } onSeen(); } }).observe(root);

  function reset() {
    log.replaceChildren();
    byId.clear();
    last = null;
    closeMenu();
    setReply(null);
    root.classList.add('empty');
  }

  return {
    onSend(fn) { sender = fn; },
    onSignal(fn) { signal = fn; },
    typing(m) { if (!isMine(m)) showTyping(m); },
    reacts(m) {
      const e = byId.get(m.id);
      if (!e) return;
      const before = e.m.reacts || {};
      e.m.reacts = m.reacts || {};
      // the emoji that was just added plays its animation
      const fresh = e.m.reacts[m.by] && e.m.reacts[m.by] !== before[m.by] ? e.m.reacts[m.by] : null;
      const stick = nearBottom();
      paintReacts(e, fresh, true);
    },
    toggle() { set(!watch.classList.contains('chat-open')); },
    open() { set(true); },
    // the chat tab came back to the front
    seen() { if (visible()) { unread = 0; badge(); onSeen(); log.scrollTop = log.scrollHeight; } },
    shown: () => visible(),
    mine: (m) => isMine(m),
    history(list) {
      reset();
      for (const m of list || []) render(m, false);
      log.scrollTop = log.scrollHeight;
      unread = 0;
      badge();
    },
    add(m) {
      const stick = nearBottom() || isMine(m);
      if (!isMine(m)) showTyping(null);
      render(m, true);
      if (stick) log.scrollTop = log.scrollHeight;
      if (!isMine(m) && !visible()) { unread++; badge(); }
    },
    clear() { reset(); showTyping(null); unread = 0; badge(); },
  };
}

// ---------- avatars (per nick, pictures come from the server) ----------

const AVA = (() => {
  let map = {};
  const local = {};           // a picture just picked here, shown before the server confirms it
  const url = (name) => { const k = String(name || '').toLowerCase(); return local[k] || map[k] || null; };
  function fill(el, name) {
    name = String(name || '');
    if (el.dataset.ava !== name) {
      el.dataset.ava = name;
      el.style.setProperty('--tint', tintOf(name));
      let b = el.querySelector('b');
      if (!b) { b = document.createElement('b'); el.prepend(b); }
      b.textContent = [...name][0] || '?';
    }
    const u = url(name);
    let img = el.querySelector('img');
    if (!u) { if (img) img.remove(); el.classList.remove('pic'); return; }
    if (img && img.getAttribute('src') === u) return;
    const next = new Image();
    next.alt = '';
    next.decoding = 'async';
    next.draggable = false;
    // a new picture fades in over the old one or the letter
    next.onload = () => { el.classList.add('pic'); next.classList.add('ready'); if (img && img.isConnected) setTimeout(() => img.remove(), 260); };
    next.onerror = () => next.remove();
    next.src = u;
    el.append(next);
  }
  return {
    url,
    fill,
    set(m) {
      map = m || {};
      for (const k of Object.keys(local)) if (map[k]) delete local[k];
      document.querySelectorAll('[data-ava]').forEach((el) => fill(el, el.dataset.ava));
    },
    preview(name, dataUrl) {
      local[String(name).toLowerCase()] = dataUrl;
      document.querySelectorAll('[data-ava]').forEach((el) => fill(el, el.dataset.ava));
    },
    drop(name) { delete local[String(name).toLowerCase()]; document.querySelectorAll('[data-ava]').forEach((el) => fill(el, el.dataset.ava)); },
  };
})();

function avaEl(name, cls) {
  const el = document.createElement('span');
  el.className = 'ava' + (cls ? ' ' + cls : '');
  el.setAttribute('aria-hidden', 'true');
  AVA.fill(el, name);
  return el;
}

// a picked image is cut to a square in the middle and shrunk here: at most 128 px and about
// 6 kb, so it travels through the websocket and the server only stores it
async function shrinkAvatar(file) {
  let src;
  try { src = await createImageBitmap(file); } catch {
    src = await new Promise((ok, bad) => { const i = new Image(); i.onload = () => ok(i); i.onerror = bad; i.src = URL.createObjectURL(file); });
  }
  const w = src.width;
  const h = src.height;
  const side = Math.min(w, h);
  for (const size of [128, 104, 80]) {
    const c = document.createElement('canvas');
    c.width = c.height = size;
    const ctx = c.getContext('2d');
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(src, (w - side) / 2, (h - side) / 2, side, side, 0, 0, size, size);
    for (const q of [0.86, 0.76, 0.66, 0.56]) {
      for (const type of ['image/webp', 'image/jpeg']) {
        const url = c.toDataURL(type, q);
        if (!url.startsWith(`data:${type};`)) continue;     // safari cannot write webp
        if ((url.length - url.indexOf(',') - 1) * 0.75 <= 5800) return url;
      }
    }
  }
  throw new Error('too big');
}

function pickAvatar(name, send, onError) {
  const input = document.createElement('input');
  input.type = 'file';
  input.accept = 'image/*';
  input.onchange = async () => {
    const f = input.files && input.files[0];
    if (!f) return;
    try {
      const url = await shrinkAvatar(f);
      AVA.preview(name(), url);
      if (!send({ t: 'avatar', data: url })) { AVA.drop(name()); onError(tr('ava.offline')); return; }
      PREF.set('ava', { name: name(), data: url });
    } catch { onError(tr('ava.unreadable')); }
  };
  input.click();
}

// the picture belongs to the person in this browser, not only to the nick: whoever comes back
// under another nick brings the same picture along (the old nick keeps its copy on the server).
// a picture set before this browser remembered it is fetched once from the server
async function carryAvatar(name, send) {
  if (!name) return;
  const saved = PREF.get('ava', null);
  const same = saved && saved.name && saved.name.toLowerCase() === name.toLowerCase();
  if (saved && saved.data && (!same || !AVA.url(name))) {
    AVA.preview(name, saved.data);
    if (send({ t: 'avatar', data: saved.data })) PREF.set('ava', { name, data: saved.data });
    return;
  }
  const url = AVA.url(name);
  if (saved || !url || !url.startsWith('/avatar/')) return;
  try {
    const blob = await (await fetch(url)).blob();
    const data = await new Promise((ok, bad) => { const r = new FileReader(); r.onload = () => ok(r.result); r.onerror = bad; r.readAsDataURL(blob); });
    PREF.set('ava', { name, data });
  } catch { /* the next visit tries again */ }
}

// ---------- proof of work before taking a nick ----------
// the server asks for a nonce whose sha256 starts with a few zero bits: a few tens of ms for a
// browser, a real cost for a script that wants a thousand nicks. only the first word of the
// hash is needed, the message always fits one block

const SHA_K = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]);
function shaHead(str) {
  const W = new Uint32Array(64);
  for (let i = 0; i < str.length; i++) W[i >> 2] |= str.charCodeAt(i) << (24 - (i & 3) * 8);
  W[str.length >> 2] |= 0x80 << (24 - (str.length & 3) * 8);
  W[15] = str.length * 8;
  for (let t = 16; t < 64; t++) {
    const x = W[t - 15];
    const y = W[t - 2];
    W[t] = (W[t - 16] + (((x >>> 7) | (x << 25)) ^ ((x >>> 18) | (x << 14)) ^ (x >>> 3)) + W[t - 7] + (((y >>> 17) | (y << 15)) ^ ((y >>> 19) | (y << 13)) ^ (y >>> 10))) | 0;
  }
  let a = 0x6a09e667, b = 0xbb67ae85, c = 0x3c6ef372, d = 0xa54ff53a, e = 0x510e527f, f = 0x9b05688c, g = 0x1f83d9ab, h = 0x5be0cd19;
  for (let t = 0; t < 64; t++) {
    const t1 = (h + (((e >>> 6) | (e << 26)) ^ ((e >>> 11) | (e << 21)) ^ ((e >>> 25) | (e << 7))) + ((e & f) ^ (~e & g)) + SHA_K[t] + W[t]) | 0;
    const t2 = ((((a >>> 2) | (a << 30)) ^ ((a >>> 13) | (a << 19)) ^ ((a >>> 22) | (a << 10))) + ((a & b) ^ (a & c) ^ (b & c))) | 0;
    h = g; g = f; f = e; e = (d + t1) | 0; d = c; c = b; b = a; a = (t1 + t2) | 0;
  }
  return (0x6a09e667 + a) >>> 0;
}
// solved in slices, so the page never stutters
function solvePow(challenge, bits) {
  return new Promise((done) => {
    let n = 0;
    const step = () => {
      const end = n + 4000;
      for (; n < end; n++) if (shaHead(`${challenge}:${n.toString(36)}`) >>> (32 - bits) === 0) return done(n.toString(36));
      setTimeout(step, 0);
    };
    step();
  });
}

// ---------- screens ----------
// one screen at a time inside #app, and never an empty frame between two: the film layer always
// fades above the lobby (in when it starts, out when it ends); between two lobby screens the
// logo and the status line stay put and only the middle changes
function screens(ids) {
  const el = (id) => document.getElementById(id);
  const root = document.documentElement;
  let cur = null;
  const settle = (e) => { clearTimeout(e._swap); e.classList.remove('leaving', 'entering', 'steady', 'to-film', 'from-film'); };
  return function show(which) {
    const to = el(which);
    const from = cur && cur !== which ? el(cur) : null;
    const instant = !cur || root.classList.contains('boot') || calm();
    if (which === cur) { if (to.classList.contains('hidden') || to.classList.contains('leaving')) { settle(to); to.classList.remove('hidden'); } booted(which); return; }
    cur = which;
    for (const id of ids) { const e = el(id); if (e !== to && e !== from) { settle(e); e.classList.add('hidden'); } }
    settle(to);
    to.classList.remove('hidden');
    if (!from || instant) {
      if (from) { settle(from); from.classList.add('hidden'); }
      booted(which);
      return;
    }
    settle(from);
    if (to.classList.contains('watch')) {
      // the film fades in over the lobby, which goes only once it is covered; the lobby light
      // is switched off (html.watching) at the same moment, so it never pops
      to.classList.add('entering');
      // the lobby's text clears quickly while the film still fades in, so it never shows through
      // the controls; its background stays, so there is no dark gap
      from.classList.add('to-film');
      root.classList.remove('boot');
      from._swap = setTimeout(() => { settle(from); from.classList.add('hidden'); booted(which); }, 820);
      to._swap = setTimeout(() => to.classList.remove('entering'), 900);
      return;
    }
    const film = from.classList.contains('watch');
    const steady = !film && from.classList.contains('lobby') && to.classList.contains('lobby');
    to.classList.toggle('steady', steady);
    // back from the film: the player's own text goes first, the lobby text comes after it
    to.classList.toggle('from-film', film);
    from.classList.toggle('steady', steady);
    from.classList.add('leaving');
    from._swap = setTimeout(() => { settle(from); from.classList.add('hidden'); }, film ? 760 : 420);
    booted(which);
  };
}

// ---------- a button that asks once more instead of a browser dialog ----------
// the first press turns it red with a question mark and a little bigger; a second press within a
// few seconds does it, anything else (a click elsewhere, escape, the timeout) takes it back
function confirmButton(btn, run, hint) {
  let timer = null;
  const disarm = () => { clearTimeout(timer); btn.classList.remove('armed'); btn.setAttribute('aria-label', btn.dataset.label || btn.textContent); };
  btn.dataset.label = btn.textContent.trim();
  btn.innerHTML = `<span>${btn.dataset.label}</span><i class="q" aria-hidden="true">?</i>`;
  btn.addEventListener('click', (e) => {
    e.stopPropagation();
    if (btn.classList.contains('armed')) { disarm(); run(); return; }
    btn.classList.add('armed');
    btn.setAttribute('aria-label', tr('confirm', { label: btn.dataset.label }));
    if (hint) hint();
    clearTimeout(timer);
    timer = setTimeout(disarm, 4000);
  });
  document.addEventListener('pointerdown', (e) => { if (btn.classList.contains('armed') && !btn.contains(e.target)) disarm(); }, true);
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') disarm(); });
  return { disarm, armed: () => btn.classList.contains('armed') };
}

// ---------- motion helpers ----------

const calm = () => matchMedia('(prefers-reduced-motion: reduce)').matches;

// first, last, invert, play for the children of a box: whatever `change` does to the dom, the
// rows that moved glide to their new place. transforms only, so nothing is laid out per frame
function glide(box, change) {
  if (calm()) return change();
  const before = new Map();
  for (const el of box.children) before.set(el, el.getBoundingClientRect());
  change();
  for (const el of box.children) {
    const a = before.get(el);
    if (!a) continue;
    const b = el.getBoundingClientRect();
    const dx = a.left - b.left;
    const dy = a.top - b.top;
    if (Math.abs(dx) < 0.5 && Math.abs(dy) < 0.5) continue;
    el.animate([{ transform: `translate(${dx}px, ${dy}px)` }, { transform: 'none' }], { duration: 280, easing: 'cubic-bezier(.2, .7, .2, 1)' });
  }
}

// an element fades out where it stands, then its neighbours close the gap. the timer, not an
// animation event, removes it, so a hidden tab or reduced motion never leaves a ghost behind
function leaveEl(el) {
  if (!el.isConnected || el.classList.contains('out')) return;
  const box = el.parentNode;
  if (calm()) return el.remove();
  el.classList.add('out');
  setTimeout(() => { if (el.isConnected) glide(box, () => el.remove()); }, 170);
}

// ---------- people in the room (second tab of the chat panel) ----------

const TINTS = ['#a7a2cc', '#d99b66', '#70a4a2', '#95c2a6', '#c79aa8', '#8fa5c9'];
function tintOf(name) {
  let h = 0;
  for (const ch of name) h = (h * 31 + ch.codePointAt(0)) >>> 0;
  return TINTS[h % TINTS.length];
}

const STATE_TEXT = { away: tr('st.away'), buf: tr('st.buf') };

function createPeople({ root, uid, hostPage, send, onTab, onAva }) {
  const pane = root.querySelector('.people');
  const list = pane.querySelector('.plist');
  const hostBox = pane.querySelector('.phost');
  const sep = pane.querySelector('.psep');
  const num = sep.querySelector('.pnum');
  const waitBox = pane.querySelector('.pwait');
  const waitList = pane.querySelector('.pwait-list');
  const opts = pane.querySelector('.popts');
  const tabs = [...root.querySelectorAll('.tab')];
  const count = root.querySelector('.tab .count');
  let roster = null;
  let lobby = [];
  let first = true;

  function tab(name) {
    const people = name === 'people';
    if (root.classList.contains('tab-people') === people) return;
    root.classList.toggle('tab-people', people);
    for (const t of tabs) { const on = t.dataset.tab === name; t.classList.toggle('on', on); t.setAttribute('aria-selected', String(on)); }
    if (people) root.classList.remove('knock');
    if (onTab) onTab(name);
  }
  for (const t of tabs) t.onclick = () => tab(t.dataset.tab);

  function row(key) {
    const el = document.createElement('div');
    el.className = 'prow in';
    el.dataset.key = key;
    el.innerHTML = '<span class="ava"></span><span class="pname"></span><span class="pstate"></span>';
    return el;
  }

  function fill(el, p) {
    const ava = el.querySelector('.ava');
    AVA.fill(ava, p.name);
    // one's own circle takes a picture
    const own = !!(p.me && onAva);
    if (own !== el.classList.contains('mine')) {
      el.classList.toggle('mine', own);
      if (own) {
        ava.setAttribute('role', 'button');
        ava.tabIndex = 0;
        ava.setAttribute('aria-label', tr('ava.set'));
        ava.removeAttribute('aria-hidden');
        ava.onclick = (e) => { e.stopPropagation(); onAva(); };
        ava.onkeydown = (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onAva(); } };
      } else { ava.removeAttribute('role'); ava.removeAttribute('tabindex'); ava.onclick = null; ava.onkeydown = null; }
    }
    const name = el.querySelector('.pname');
    if (name.textContent !== p.name) name.textContent = p.name;
    // the host is the row above the line, a label would only repeat that
    const text = [p.me ? tr('you') : '', STATE_TEXT[p.state] || ''].filter(Boolean).join(' · ');
    const st = el.querySelector('.pstate');
    if (st.textContent !== text) {
      st.textContent = text;
      // a changed status fades in instead of popping
      st.classList.remove('swap');
      void st.offsetWidth;
      st.classList.add('swap');
    }
    el.classList.toggle('off', p.state === 'away');
    el.classList.toggle('busy', p.state === 'buf');
    let act = el.querySelector('.pact');
    if (p.act && !act) {
      act = document.createElement('button');
      act.className = 'pact';
      el.append(act);
    } else if (!p.act && act) act.remove();
    if (p.act) { act.textContent = p.act.label; act.className = 'pact' + (p.act.main ? ' go' : ''); act.onclick = p.act.run; }
    // the host's switch for this one person: may they play, pause and seek
    let sw = el.querySelector('.psw');
    if (p.ctl && !sw) {
      sw = document.createElement('button');
      sw.className = 'psw';
      sw.setAttribute('role', 'switch');
      sw.innerHTML = '<i></i>';
      el.append(sw);
    } else if (!p.ctl && sw) sw.remove();
    if (p.ctl) {
      const on = !!p.ctl.on;
      if (!sw._pending || sw._pending === on) { sw._pending = null; sw.classList.toggle('on', on); }
      sw.setAttribute('aria-checked', String(sw.classList.contains('on')));
      sw.setAttribute('aria-label', tr('ctl.aria', { name: p.name }));
      sw.title = sw.classList.contains('on') ? tr('ctl.on') : tr('ctl.off');
      sw.onclick = (e) => {
        e.stopPropagation();
        const v = !sw.classList.contains('on');
        sw._pending = v;
        sw.classList.toggle('on', v);
        sw.setAttribute('aria-checked', String(v));
        p.ctl.set(v);
      };
    }
  }

  // rows are kept by key and updated in place: only who came, went or changed moves
  function render(box, items) {
    const have = new Map([...box.children].filter((el) => !el.classList.contains('out')).map((el) => [el.dataset.key, el]));
    const keys = new Set(items.map((p) => p.key));
    for (const [key, el] of have) if (!keys.has(key)) leaveEl(el);
    const fresh = items.filter((p) => !have.has(p.key));
    const add = () => {
      let prev = null;
      for (const p of items) {
        let el = have.get(p.key);
        if (!el) { el = row(p.key); if (first) el.style.animationDelay = `${Math.min(items.indexOf(p), 8) * 35}ms`; }
        fill(el, p);
        const want = prev ? prev.nextElementSibling : box.firstElementChild;
        if (want !== el) box.insertBefore(el, want);
        prev = el;
      }
    };
    if (fresh.length && !first) glide(box, add); else add();
  }

  function paint() {
    const me = uid();
    const people = [];
    if (roster) {
      for (const p of roster.people) {
        people.push({
          key: p.id, name: p.name, state: p.state, me: p.id === me,
          act: hostPage ? { label: tr('act.kick'), run: () => send({ t: 'kick', id: p.id }) } : null,
          ctl: hostPage ? { on: p.control !== false, set: (v) => send({ t: 'pctl', id: p.id, v }) } : null,
        });
      }
    }
    // the host on top, a line, then everyone else
    render(hostBox, roster ? [{ key: 'host', name: roster.host.name, state: roster.host.state, host: true, me: me === 'host' }] : []);
    render(list, people);
    sep.classList.toggle('has', people.length > 0);
    const vn = people.length ? String(people.length) : '';
    if (num.textContent !== vn) num.textContent = vn;
    const n = people.length + (roster ? 1 : 0);
    const text = n ? String(n) : '';
    if (count.textContent !== text) count.textContent = text;
    if (hostPage) {
      const waiting = roster ? lobby : [];
      render(waitList, waiting.map((u) => ({ key: u.id, name: u.name, state: 'on', act: { label: tr('act.admit'), main: true, run: () => send({ t: 'admit', id: u.id }) } })));
      waitBox.classList.toggle('has', waiting.length > 0);
      // someone is at the door while the people tab is closed: the tab says so
      if (!waiting.length) root.classList.remove('knock');
    }
    if (roster) {
      for (const sw of pane.querySelectorAll('[data-opt]')) {
        let on = !!roster[sw.dataset.opt];
        let mixed = false;
        if (sw.dataset.opt === 'control' && roster.people.length) {
          // the switch over the list shows everyone: on, off, or some of each
          const c = roster.people.map((p) => p.control !== false);
          on = c.every(Boolean);
          mixed = !on && c.some(Boolean);
        }
        sw.classList.toggle('on', on);
        sw.classList.toggle('mixed', mixed);
        sw.setAttribute('aria-checked', mixed ? 'mixed' : String(on));
      }
    }
    first = false;
  }

  if (hostPage) {
    for (const sw of pane.querySelectorAll('[data-opt]')) {
      sw.onclick = () => {
        const v = !sw.classList.contains('on');
        // the switch moves at once; the server's answer confirms or corrects it
        sw.classList.toggle('on', v);
        send({ t: sw.dataset.opt, v });
      };
    }
  }

  return {
    set(r) { roster = r; paint(); },
    lobby(users) {
      const known = new Set(lobby.map((u) => u.id));
      const came = users.filter((u) => !known.has(u.id));
      lobby = users;
      paint();
      if (roster && came.length && !root.classList.contains('tab-people')) root.classList.add('knock');
      return roster ? came : [];
    },
    clear() { roster = null; lobby = []; first = true; list.replaceChildren(); hostBox.replaceChildren(); sep.classList.remove('has'); num.textContent = ''; if (waitList) waitList.replaceChildren(); count.textContent = ''; tab('chat'); root.classList.remove('knock'); },
    tab,
    get roster() { return roster; },
    size: () => (roster ? roster.people.length : 0),
  };
}
