'use strict';
const $ = (id) => document.getElementById(id);
const video = $('video');
const media = createMedia(video);

let users = [];         // the lobby as the setup screen shows it
let latest = [];        // the lobby as it is right now
// from the start press until the setup screen is shown again it stands still: the people who
// were picked leave the lobby for the room, and their chips must not fold away (with
// "nobody yet" in their place) while the film fades in over them
let frozen = false;
// everyone who is waiting watches by default; a tap on a chip leaves that person out
let skipped = new Set(JSON.parse(sessionStorage.getItem('wp.skip') || '[]'));
let selFile = null;
let session = null;
let loadedMedia = null;
let endGen = 0;
// how the host chooses a film: a list of the server's film folder, the desktop file dialog, or both
let picker = { library: false, dialog: false, dir: '' };
const show = screens(['setup', 'playerbox', 'kicked']);

const sock = openSocket('host', {
  open() { conn(true); },
  avatars() { carryAvatar(savedName, (x) => sock.send(x)); },
  close() { conn(false); sync.offline(); peer(); },
  message(m) {
    if (m.t === 'hello') {
      users = latest = m.users;
      if (!m.session) frozen = false;
      renderUsers();
      people.lobby(users);
      chat.history(m.chat);
      onSession(m.session);
      if (m.state) { sync.apply(m.state); sync.flush(); }
      if (m.picker) { picker = m.picker; pickHint(); }
      nobodyText(m.publicUrl);
      if (m.hostName) { savedName = m.hostName; if (document.activeElement !== $('hostname')) $('hostname').value = m.hostName; fitName(); }
      AVA.fill($('myavaimg'), savedName);
      if (m.lastPick && !selFile) showFile(m.lastPick);
      else if (!m.lastPick && !(m.session)) clearFile();
    } else if (m.t === 'users') {
      latest = m.users;
      if (!frozen) { users = latest; renderUsers(); }
      // during the film a newcomer waits at the door until the host lets them in
      for (const u of people.lobby(latest)) if (loadedMedia && !removed.has(u.id)) ui.toast(tr('door', { name: u.name }));
      peer();
    } else if (m.t === 'roster') { people.set(m); peer(); }
    else if (m.t === 'opts') { if (people.roster) people.set({ ...people.roster, open: m.open, control: m.control }); }
    else if (m.t === 'came') { if (loadedMedia) ui.toast(tr('came', { name: m.name })); }
    else if (m.t === 'gone') { if (loadedMedia && m.why !== 'kicked') ui.toast(tr(m.why === 'lost' ? 'gone.lost' : 'gone.left', { name: m.name })); }
    else if (m.t === 'session') onSession(m.session, m.reason);
    else if (m.t === 'state') { if (loadedMedia) sync.apply(m); }
    else if (m.t === 'dialog') onDialog(m);
    else if (m.t === 'library') onLibrary(m);
    else if (m.t === 'hostname') onHostName(m);
    else if (m.t === 'typing') chat.typing(m);
    else if (m.t === 'reacts') chat.reacts(m);
    else if (m.t === 'chat') { chat.add(m); if (!chat.mine(m) && loadedMedia) ui.notify(m, chat.shown()); }
    else if (m.t === 'error') {
      $('err').textContent = errText(m.code, m);
      // a refused start (nobody picked is online any more) unfreezes the setup screen
      if (frozen && !session) { frozen = false; users = latest; renderUsers(); }
    }
    else if (m.t === 'avaerr') { const text = errText(m.code); AVA.drop(savedName); nameNote(text, true); if (loadedMedia) ui.toast(text); }
    else if (m.t === 'kicked') {
      sock.stop();
      video.pause();
      media.destroy();
      show('kicked');
    }
  },
});

const sync = createSync({ video, sock, role: 'host', uid: () => 'host' });
media.positionFrom(() => (sync.state ? sync.target() : video.currentTime));
const ui = initPlayer({
  root: $('playerbox'), stage: $('stage'), video, media, sync, role: 'host',
  chat: { toggle: () => chat.toggle(), people: () => { chat.open(); people.tab('people'); } },
  stopLabel: tr('stop.host'),
  onStop: () => sock.send({ t: 'stop' }),
  stopHint: () => tr('stop.hostHint'),
});
const chat = createChat({ root: $('chatpanel'), button: $('chatbtn'), role: 'host', uid: () => 'host' });
// someone the host just removed lands in the lobby again; that is no news to the host
const removed = new Set();
const people = createPeople({ root: $('chatpanel'), uid: () => 'host', hostPage: true, send: (m) => { if (m.t === 'kick') removed.add(m.id); else if (m.t === 'admit') removed.delete(m.id); sock.send(m); }, onTab: (t) => { if (t === 'chat') chat.seen(); }, onAva: () => changeAva() });
function changeAva() { pickAvatar(() => savedName, (m) => sock.send(m), (t) => { nameNote(t, true); if (loadedMedia) ui.toast(t); }); }
$('myava').onclick = changeAva;
chat.onSend((text, reply) => sock.send({ t: 'chat', text, reply }));
chat.onSignal((m) => sock.send(m));
$('takeback').onclick = () => location.reload();

// only a lost line is worth a word; while all is well the corner stays empty
let connTimer = null;
function conn(on) {
  clearTimeout(connTimer);
  if (on) $('conn').classList.add('hidden');
  else connTimer = setTimeout(() => $('conn').classList.remove('hidden'), 1500);
}

// ---------- setup screen ----------

// the host's nick: applied as you type (short debounce), on enter and on blur
let savedName = tr('host.default');
let nameNoteTimer = null;
function nameNote(text, bad) {
  const n = $('hostnamenote');
  n.textContent = text;
  n.className = bad ? 'err' : 'note';
  clearTimeout(nameNoteTimer);
  if (!bad) nameNoteTimer = setTimeout(() => { n.textContent = ''; }, 1800);
}
function saveName() {
  const name = $('hostname').value.trim();
  if (!name) { $('hostname').value = savedName; return; }
  if (name !== savedName) sock.send({ t: 'name', name });
}
function onHostName(m) {
  const renamed = !m.error && m.name !== savedName;
  savedName = m.name;
  AVA.fill($('myavaimg'), m.name);
  if (renamed) carryAvatar(m.name, (x) => sock.send(x));
  $('hostname').value = m.name;
  fitName();
  if (m.error) nameNote(errText(m.error), true); else nameNote('');
}
// the line under the nick follows the text: measured on a canvas, the width eases in css
const nameCtx = document.createElement('canvas').getContext('2d');
function fitName() {
  const input = $('hostname');
  nameCtx.font = getComputedStyle(input).font;
  const w = nameCtx.measureText(input.value || ' ').width;
  $('hostnameform').style.width = Math.ceil(Math.min(Math.max(w + 28, 120), 320)) + 'px';
}
$('hostnameform').onsubmit = (e) => { e.preventDefault(); saveName(); $('hostname').blur(); };
$('hostname').addEventListener('blur', saveName);
fitName();
document.fonts?.ready.then(fitName);
let nameTimer = null;
$('hostname').addEventListener('input', () => {
  fitName();
  clearTimeout(nameTimer);
  nameTimer = setTimeout(() => { if ($('hostname').value.trim()) saveName(); }, 400);
});

const chosen = () => users.filter((u) => !skipped.has(u.id)).map((u) => u.id);

function steps() {
  // from the start press on the button keeps its words; only a soft light runs over it
  if (frozen) { $('start').disabled = true; $('start').classList.add('busy'); return; }
  $('start').classList.remove('busy');
  const n = chosen().length;
  const preparing = frozen || (!!session && session.status === 'preparing');
  $('s2').classList.toggle('dim', !n);
  $('start').disabled = !(selFile && n) || preparing;
  $('start').classList.toggle('busy', preparing);
  // the button names how many people get the film, so nobody slips in unnoticed
  const label = preparing ? tr('start.opening') : n > 1 ? tr('start.for', { n }) : tr('start');
  if ($('startlabel').textContent !== label) $('startlabel').textContent = label;
}

// chips are kept by person: a newcomer pops in, someone who left folds away and the rest close
// the gap, a tap only flips the one chip
function renderUsers() {
  const box = $('users');
  const have = new Map([...box.children].filter((el) => !el.classList.contains('out')).map((el) => [el.dataset.id, el]));
  const ids = new Set(users.map((u) => u.id));
  for (const [id, el] of have) if (!ids.has(id)) leaveEl(el);
  const add = () => {
    for (const u of users) {
      let c = have.get(u.id);
      if (!c) {
        c = document.createElement('button');
        c.className = 'chip new';
        c.dataset.id = u.id;
        c.innerHTML = '<i class="tick"></i><span></span>';
        c.onclick = () => {
          if (skipped.has(u.id)) skipped.delete(u.id); else skipped.add(u.id);
          sessionStorage.setItem('wp.skip', JSON.stringify([...skipped]));
          renderUsers();
        };
        box.append(c);
      }
      const on = !skipped.has(u.id);
      c.querySelector('span').textContent = u.name;
      c.classList.toggle('sel', on);
      c.setAttribute('aria-pressed', String(on));
    }
  };
  if (users.some((u) => !have.has(u.id)) && have.size) glide(box, add); else add();
  $('nousers').classList.toggle('hidden', users.length > 0);
  steps();
}

// the line under "nobody yet" names the public address when the server knows it
function nobodyText(url) {
  const p = $('nousers');
  if (!url) { p.textContent = tr('host.nobodyNoAddr'); return; }
  const [before, after] = tr('host.nobody', { addr: '\u0000' }).split('\u0000');
  const b = document.createElement('b');
  b.textContent = url.replace(/^https?:\/\//, '').replace(/\/$/, '');
  p.replaceChildren(before, b, after || '');
}

const pickHintText = () => (picker.library ? tr('pick.hintLibrary', { dir: picker.dir }) : picker.dialog ? tr('pick.hintDialog') : tr('pick.noPicker'));
function pickHint() {
  if (!$('pickbtn').classList.contains('has')) $('fmeta').textContent = pickHintText();
}

$('pickbtn').onclick = () => {
  $('err').textContent = '';
  if (picker.library) toggleLibrary();
  else if (picker.dialog) sock.send({ t: 'dialog' });
  else $('err').textContent = tr('pick.noPicker');
};

function onDialog(m) {
  const b = $('pickbtn');
  b.classList.toggle('busy', m.state === 'open');
  if (m.state === 'open') { b.disabled = true; if (!selFile) $('fmeta').textContent = tr('pick.dialogOpen'); return; }
  b.disabled = false;
  if (!selFile && !b.classList.contains('has')) $('fmeta').textContent = pickHintText();
  if (m.state === 'busy') $('err').textContent = tr('pick.dialogBusy');
  else if (m.state === 'error') $('err').textContent = tr('pick.dialogError');
  if (m.state === 'done') showFile(m);
}

// ---------- the film folder ----------
// the server lists the video files under its film folder; the list opens under the picker,
// newest first, with a filter once it is long

let libFiles = [];
const LIB_SHOW = 200;
function toggleLibrary(open = $('lib').classList.contains('hidden')) {
  $('lib').classList.toggle('hidden', !open);
  $('pickbtn').setAttribute('aria-expanded', String(open));
  if (!open) return;
  $('libsearch').value = '';
  $('libnote').textContent = tr('lib.loading');
  $('liblist').replaceChildren();
  $('libother').classList.toggle('hidden', !picker.dialog);
  sock.send({ t: 'library' });
}

function onLibrary(m) {
  libFiles = m.files || [];
  $('libsearch').classList.toggle('hidden', libFiles.length < 8);
  renderLibrary(m);
  if (libFiles.length >= 8 && !isTouch()) $('libsearch').focus({ preventScroll: true });
}

function renderLibrary(m = {}) {
  const q = $('libsearch').value.trim().toLowerCase();
  const hits = q ? libFiles.filter((f) => f.rel.toLowerCase().includes(q)) : libFiles;
  const list = $('liblist');
  list.replaceChildren();
  for (const f of hits.slice(0, LIB_SHOW)) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'lib-item';
    const name = document.createElement('span');
    name.className = 'fname';
    name.textContent = f.name;
    const meta = document.createElement('span');
    meta.className = 'fmeta';
    const dir = f.rel.includes('/') ? f.rel.slice(0, f.rel.lastIndexOf('/')) : '';
    meta.textContent = [dir, fmtSize(f.size)].filter(Boolean).join(' · ');
    b.append(name, meta);
    b.onclick = () => { toggleLibrary(false); showFile(f); };
    list.append(b);
  }
  let note = '';
  if (m.missing) note = tr('lib.missing', { dir: picker.dir });
  else if (!libFiles.length) note = tr('lib.empty', { dir: picker.dir });
  else if (!hits.length) note = tr('lib.nomatch');
  else if (hits.length > LIB_SHOW || m.more) note = tr('lib.more', { n: Math.min(hits.length, LIB_SHOW) });
  $('libnote').textContent = note;
}
$('libsearch').addEventListener('input', () => renderLibrary());
$('libother').onclick = () => { toggleLibrary(false); sock.send({ t: 'dialog' }); };
document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !$('lib').classList.contains('hidden')) toggleLibrary(false); });

function clearFile() {
  selFile = null;
  $('pickbtn').classList.remove('has');
  $('pickbtn').removeAttribute('title');
  $('pickbtn').setAttribute('aria-label', tr('pick.choose'));
  $('fname').textContent = tr('pick.choose');
  $('fmeta').textContent = pickHintText();
  steps();
}

async function showFile(f) {
  selFile = null;
  steps();
  $('fname').textContent = f.name;
  $('fmeta').textContent = tr('file.reading', { size: fmtSize(f.size) });
  $('pickbtn').classList.add('has');
  let info;
  try {
    const r = await fetch('/api/probe?path=' + encodeURIComponent(f.path));
    if (!r.ok) throw new Error();
    info = await r.json();
  } catch {
    $('fmeta').textContent = tr('file.unreadable');
    return;
  }
  selFile = f.path;
  $('pickbtn').setAttribute('aria-label', tr('file.aria', { name: f.name }));
  $('pickbtn').title = tr('file.title', { name: f.name });
  const v = info.video ? `${info.video.width}×${info.video.height}` : tr('file.noVideo');
  const a = tr('file.audio', { n: info.audio.length });
  $('fmeta').textContent = [fmtTime(info.duration), v, fmtSize(f.size), a, info.subs.length ? tr('file.subs', { n: info.subs.length }) : ''].filter(Boolean).join(' · ');
  steps();
}

$('start').onclick = () => {
  $('err').textContent = '';
  frozen = true;
  steps();
  sock.send({ t: 'pick', path: selFile, viewers: chosen() });
};

// ---------- session ----------

const REASONS = new Set(['room_lost', 'room_left']);

function onSession(s, reason) {
  session = s;
  // the setup screen is back (end, error): it shows the lobby as it is now
  if (frozen && (!s || s.status === 'error')) { frozen = false; users = latest; renderUsers(); }
  // while the setup screen stands still after the start press, its lines stay as they are
  if (!(frozen && s)) $('reason').textContent = !s && REASONS.has(reason) ? tr(`reason.${reason}`) : '';
  if (s && s.status === 'error') $('err').textContent = errText(s.error);
  steps();

  const play = !!s && s.status === 'ready';
  show(play ? 'playerbox' : 'setup');
  if (play) {
    ui.setTitle(s.title);
    sync.setDuration(s.duration);
    if (loadedMedia !== s.master) {
      endGen++;
      loadedMedia = s.master;
      ui.fail('');
      sync.reset();
      media.load(s, sync.state ? sync.target() : s.pos);
      sock.send({ t: 'sync' });
    }
    peer();
  } else if (loadedMedia) {
    // the film fades out with its sound over the setup screen, then the player is emptied
    loadedMedia = null;
    const gen = ++endGen;
    const restore = ui.fadeOut(650);
    document.title = `${tr('host.doc')} · silent.cinema`;
    if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
    setTimeout(() => {
      if (gen !== endGen) return;
      video.pause();
      media.destroy();
      sync.reset();
      chat.clear();
      people.clear();
      people.lobby(latest);
      restore();
    }, 800);
  }
}

function peer() {
  if (!session || session.status !== 'ready') return;
  const st = sync.state;
  const holds = (st && st.holds) || [];
  // only a single viewer makes the film wait; in a group the list shows who is behind
  const away = holds.find((h) => h.who === 'viewer' && h.why === 'away');
  const vbuf = holds.find((h) => h.who === 'viewer' && h.why === 'buf');
  const mbuf = holds.find((h) => h.who === 'host' && h.why === 'buf');
  const list = people.roster ? people.roster.people : [];
  const name = (away || vbuf || list[0] || {}).name || tr('word.viewer');
  const n = list.length;
  if (!sock.online()) ui.setPeer(tr('peer.serverOff'), 'warn');
  else if (away) ui.setPeer(tr('peer.reconnecting', { name }), 'warn');
  else if (vbuf) ui.setPeer(tr('peer.loading', { name }), 'warn');
  else ui.setPeer(n > 1 ? tr('peer.count', { n }) : name, 'on');
  let note = '';
  if (st && st.playing && st.held) {
    if (!sock.online()) note = tr('note.serverOff');
    else if (away) note = tr('note.lost', { name });
    else if (vbuf) note = tr('note.loading', { name });
    else if (mbuf) note = tr('note.me');
  }
  ui.setNotice(note);
}
sync.on('state', peer);
sync.on('remote', (by, st) => {
  const name = by.name || tr('word.viewer');
  if (by.act === 'pause') ui.toast(tr('by.pause', { name }));
  else if (by.act === 'play') ui.toast(tr('by.play', { name }));
  else if (by.act === 'seek') ui.toast(tr('by.seek', { name, time: fmtTime(st.time) }));
});

media.onError((text, fatal) => {
  sock.send({ t: 'diag', text });
  if (fatal) ui.fail(text === 'fatal' ? tr('fail.server') : text);
});
ui.onRetry(() => media.reload());

steps();
window.__wp = { sync, sock, video, media };
