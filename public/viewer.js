'use strict';
const $ = (id) => document.getElementById(id);
const video = $('video');
const media = createMedia(video);

let myName = '';
let myId = '';
let current = null;      // session loaded in the player
let hostOn = false;
let hostBusy = false;    // a film is already running without this page
let replaced = false;
let hostName = tr('host.default');
let endGen = 0;          // a film that is fading out; a new one cancels its cleanup
// the host has just started a film for this page: nothing on the waiting screen changes until
// the film fades in over it
let incoming = false;
// the answer to the server's small puzzle; a nick is sent only with it
let pow = null;
let powDone = null;

const identity = {
  get() {
    try {
      // the identity lives per browser, so a closed tab comes back as the same person
      return JSON.parse(localStorage.getItem('wp.id') || 'null');
    } catch { return null; }
  },
  set(v) { try { localStorage.setItem('wp.id', JSON.stringify(v)); } catch { /* private mode */ } },
  clear() { try { localStorage.removeItem('wp.id'); } catch { /* private mode */ } },
};

const sock = openSocket('viewer', {
  open() {
    pow = new Promise((ok) => { powDone = ok; });
    // a leave that may not have reached the server goes first
    const drop = PREF.get('drop', null);
    if (drop && sock.send({ t: 'drop', id: drop.id, name: drop.name })) PREF.del('drop');
    const id = identity.get();
    if (id) { myName = id.name; join(id.name); } else show('join');
    paintHost();
  },
  close() { sync.offline(); paintHost(); peer(); },
  message(m) {
    if (m.t === 'pow') {
      const done = powDone;
      solvePow(m.c, m.bits).then((n) => done && done(n));
    } else if (m.t === 'avaerr') {
      AVA.drop(myName);
      avaNote(errText(m.code));
    } else if (m.t === 'slow') {
      if (current) ui.toast(tr('slow'));
    } else if (m.t === 'joinerr') {
      identity.clear();
      $('joinform').classList.remove('going');
      $('joinerr').textContent = errText(m.code);
      show('join');
      $('nick').focus();
    } else if (m.t === 'joined') {
      myName = m.name;
      myId = m.id;
      hostOn = !!m.host;
      hostBusy = !!m.busy;
      if (m.hostName) hostName = m.hostName;
      identity.set({ id: m.id, name: m.name });
      PREF.set('nick', m.name);
      $('hello').textContent = tr('hello', { name: m.name });
      AVA.fill($('myavaimg'), m.name);
      carryAvatar(m.name, (x) => sock.send(x));
      // the arrow comes back only after the nick screen has gone
      setTimeout(() => $('joinform').classList.remove('going'), 600);
      chat.history(m.chat);
      onSession(m.session);
      paintHost();
      if (current) sync.flush();
    } else if (m.t === 'host') {
      hostOn = !!m.online;
      hostBusy = !!m.busy;
      if (m.name) hostName = m.name;
      paintHost();
      if (!current && !incoming) waitText();
      peer();
    } else if (m.t === 'left') {
      // out of the room on purpose: back to the nick, nothing restores the old place
      PREF.del('drop');
      identity.clear();
      endWatch();
      $('nick').value = myName;
      $('joinerr').textContent = '';
      show('join');
    } else if (m.t === 'session') {
      // let in while the film runs: the chat so far comes along
      if (m.chat) chat.history(m.chat);
      onSession(m.session, m.reason);
    } else if (m.t === 'roster') {
      people.set(m);
      // the host decides for every person on their own
      const mine = m.people.find((p) => p.id === myId);
      ui.setControl(mine ? mine.control !== false : !!m.control);
      if (m.host.name) hostName = m.host.name;
      peer();
    } else if (m.t === 'came') {
      if (current) ui.toast(tr('came', { name: m.name }));
    } else if (m.t === 'gone') {
      if (current) ui.toast(tr(m.why === 'lost' ? 'gone.lost' : 'gone.left', { name: m.name }));
    } else if (m.t === 'state') {
      if (current) sync.apply(m);
    } else if (m.t === 'typing') {
      chat.typing(m);
    } else if (m.t === 'reacts') {
      chat.reacts(m);
    } else if (m.t === 'chat') {
      chat.add(m);
      if (!chat.mine(m) && current) ui.notify(m, chat.shown());
    } else if (m.t === 'replaced') {
      replaced = true;
      sock.stop();
      video.pause();
      media.destroy();
      current = null;
      show('replaced');
    }
  },
});

const sync = createSync({ video, sock, role: 'viewer', uid: () => myId });
media.positionFrom(() => (sync.state ? sync.target() : video.currentTime));
const ui = initPlayer({
  root: $('watch'), stage: $('stage'), video, media, sync, role: 'viewer',
  chat: { toggle: () => chat.toggle(), people: () => { chat.open(); people.tab('people'); } },
  stopLabel: tr('stop.viewer'),
  onStop: () => leave(),
  stopHint: () => tr(people.size() <= 1 ? 'stop.viewerLast' : 'stop.viewerMore'),
});
// the chat button lives in the player hud, so the chat is wired after the player exists
const chat = createChat({ root: $('chatpanel'), button: $('chatbtn'), role: 'viewer', uid: () => myId, onSeen: () => ui.hideNotify() });
const people = createPeople({ root: $('chatpanel'), uid: () => myId, hostPage: false, onTab: (t) => { if (t === 'chat') chat.seen(); }, onAva: () => changeAva() });
chat.onSend((text, reply) => sock.send({ t: 'chat', text, reply }));
chat.onSignal((m) => sock.send(m));

const show = screens(['join', 'wait', 'replaced', 'watch']);
window.bootFallback = () => show(identity.get() ? 'wait' : 'join');

async function join(name) {
  const id = identity.get();
  const nonce = await pow;
  sock.send({ t: 'join', name, id: id && id.name === name ? id.id : undefined, pow: nonce });
}

// ---------- own picture ----------

let avaTimer = null;
function avaNote(text) {
  $('avaerr').textContent = text;
  clearTimeout(avaTimer);
  avaTimer = setTimeout(() => { $('avaerr').textContent = ''; }, 4000);
  if (current) ui.toast(text);
}
function changeAva() {
  pickAvatar(() => myName, (m) => sock.send(m), avaNote);
}
$('myava').onclick = changeAva;

function paintHost() {
  const on = sock.online();
  for (const id of ['hostline', 'hostline2']) {
    const el = $(id);
    el.className = 'status' + (on && hostOn ? ' on' : '');
    el.querySelector('span').textContent = tr(!on ? 'line.reconnecting' : !hostOn ? 'line.hostOff' : hostBusy && !incoming ? 'line.hostBusy' : 'line.hostOn');
  }
}

$('nick').value = PREF.get('nick', '');
$('joinform').onsubmit = (e) => {
  e.preventDefault();
  const name = $('nick').value.trim();
  if (!name) { $('nick').focus(); return; }
  $('joinerr').textContent = '';
  myName = name;
  // the arrow leaves, and on a phone the keyboard closes together with the screen change
  $('joinform').classList.remove('going');
  void $('joinform').offsetWidth;
  $('joinform').classList.add('going');
  if (isTouch()) $('nick').blur();
  join(name);
};
// leaving happens on the page at once. the server is told now, and if the line was down (a
// phone that just came back from another app) once more after the reconnect: otherwise the
// server would hold the place and the nick for five minutes and refuse the same nick
function leave() {
  const id = identity.get();
  if (id) PREF.set('drop', { id: id.id, name: id.name });
  sock.send({ t: 'leave' });
  identity.clear();
  endWatch();
  $('nick').value = myName;
  $('joinerr').textContent = '';
  show('join');
}
$('rename').onclick = leave;
$('takeback').onclick = () => location.reload();

const REASONS = new Set(['host_left', 'host_ended', 'kicked']);

// what the waiting screen says while there is no film for this page
function waitText() {
  $('waitmsg').textContent = tr(hostBusy ? 'wait.busy' : 'wait.msg');
}

function onSession(s, reason) {
  if (replaced) return;
  if (!s || s.status !== 'preparing') incoming = false;
  if (!s) {
    endWatch();
    paintHost();
    waitText();
    $('waitnote').textContent = REASONS.has(reason) ? tr(`reason.${reason}`) : '';
    $('waitnote').className = 'note';
    return show('wait');
  }
  if (s.status === 'preparing') {
    // the host pressed start a moment ago: the screen stays as it is, the film fades in over it
    incoming = true;
    return show('wait');
  }
  if (s.status === 'error') {
    paintHost();
    $('waitmsg').textContent = tr('wait.failed');
    $('waitnote').textContent = errText(s.error);
    $('waitnote').className = 'err';
    return show('wait');
  }
  show('watch');
  ui.setTitle(s.title);
  sync.setDuration(s.duration);
  if (!current || current.master !== s.master) {
    endGen++;
    current = s;
    ui.fail('');
    sync.reset();
    media.load(s, sync.state ? sync.target() : s.pos);
    sock.send({ t: 'sync' });
  }
  peer();
}

// the film is over for this page: the picture and the sound fade out with the whole player,
// the waiting screen is already underneath, and the player is emptied once it is invisible
function endWatch() {
  if (!current) return;
  current = null;
  const gen = ++endGen;
  const restore = ui.fadeOut(650);
  setTimeout(() => {
    if (gen !== endGen) return;
    video.pause();
    media.destroy();
    sync.reset();
    chat.clear();
    people.clear();
    ui.fail('');
    restore();
  }, 800);
}

// ---------- who is where ----------

function peer() {
  const st = sync.state;
  const holds = (st && st.holds) || [];
  const away = holds.find((h) => h.who === 'host' && h.why === 'away');
  const hbuf = holds.find((h) => h.who === 'host' && h.why === 'buf');
  const mbuf = holds.find((h) => h.id === myId && h.why === 'buf');
  const others = Math.max(0, people.size() - 1);
  const name = hostName;
  if (!sock.online()) ui.setPeer(tr('peer.offline'), 'warn');
  else if (away) ui.setPeer(tr('peer.reconnecting', { name }), 'warn');
  else if (hbuf) ui.setPeer(tr('peer.loading', { name }), 'warn');
  else ui.setPeer(others ? tr('peer.andMore', { name, n: others }) : name, 'on');
  let note = '';
  if (st && st.playing && st.held) {
    if (!sock.online()) note = tr('note.offline');
    else if (away) note = tr('note.lost', { name });
    else if (hbuf) note = tr('note.loading', { name });
    else if (mbuf) note = tr('note.me');
  }
  ui.setNotice(note);
}
sync.on('state', peer);
sync.on('remote', (by, st) => {
  const name = by.name || hostName;
  if (by.act === 'pause') ui.toast(tr('by.pause', { name }));
  else if (by.act === 'play') ui.toast(tr('by.play', { name }));
  else if (by.act === 'seek') ui.toast(tr('by.seek', { name, time: fmtTime(st.time) }));
});

// ---------- a line that cannot carry the original steps down once by itself ----------
// more than 6 s of stalls within a minute while playing on the original: switch to 720p and say so.
// a person who goes back to the original by hand is left alone for 5 minutes.

let stalls = [];
let stallAt = 0;
let steppedAt = -Infinity;
video.addEventListener('waiting', () => { if (sync.playingWanted() && !video.seeking) stallAt = performance.now(); });
video.addEventListener('playing', () => {
  if (!stallAt) return;
  const now = performance.now();
  stalls.push([now, now - stallAt]);
  stallAt = 0;
  stalls = stalls.filter(([t]) => now - t < 60000);
  const total = stalls.reduce((a, [, d]) => a + d, 0);
  const lower = current && current.levels.find((l) => l.id === 1);
  if (total > 6000 && media.quality === 'q0' && lower && now - steppedAt > 300000) {
    stalls = [];
    steppedAt = now;
    media.choose('q', 'q1');
    ui.toast(tr('stepdown', { q: lower.label }));
  }
});

// ---------- load failures are shown and reported, never silent ----------

media.onError((text, fatal) => {
  sock.send({ t: 'diag', text });
  if (fatal) ui.fail(text === 'fatal' ? tr('fail.server') : text);
});
video.addEventListener('error', () => {
  const e = video.error;
  sock.send({ t: 'diag', text: `video error ${e && e.code} ${e && e.message}` });
});
ui.onRetry(() => media.reload());

window.__wp = { sync, sock, video, media };
