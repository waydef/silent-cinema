'use strict';
// silent.cinema: one host picks a video file and the people they let into the room watch it in
// sync. the server owns the playback clock; the host and every viewer follow it.
//
// two listeners: the public one for viewers (plain http behind a reverse proxy, or https with
// TLS_CERT and TLS_KEY) and the host one, bound to loopback by default. the host role exists only
// on the host listener, so nothing that reaches the public port can start or stop a film.
const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const { spawn, execFile } = require('child_process');
const { WebSocketServer } = require('ws');
const { Stream } = require('./stream');

const env = process.env;
const HOME = os.homedir();
const words = (v) => String(v || '').split(/[\s,]+/).map((x) => x.trim().toLowerCase()).filter(Boolean);
const expand = (p) => (p && p.startsWith('~') ? path.join(HOME, p.slice(1)) : p);

const PORT = Number(env.PORT || 8080);
const BIND = env.BIND || '0.0.0.0';
const HOST_PORT = Number(env.HOST_PORT || 8088);
const HOST_BIND = env.HOST_BIND || '127.0.0.1';
const TLS_CERT = expand(env.TLS_CERT || '');
const TLS_KEY = expand(env.TLS_KEY || '');
// names the public listener answers to; empty means any. the host listener only knows loopback
// names, so a dns rebinding page can never reach it under its own name
const PUBLIC_HOSTS = new Set(words(env.PUBLIC_HOSTS));
// HOST_HOSTS adds names for a host listener bound to a lan address
const HOST_NAMES = new Set(['localhost', '127.0.0.1', '[::1]', ...words(env.HOST_HOSTS)]);
// shown to the host as the address to send people to
const PUBLIC_URL = env.PUBLIC_URL || (PUBLIC_HOSTS.size ? `https://${[...PUBLIC_HOSTS][0]}` : '');
// behind a reverse proxy every viewer arrives from the proxy; the real address is the last hop
// of x-forwarded-for. only trust it when the public port is reachable through the proxy alone
const TRUST_PROXY = env.TRUST_PROXY === '1' || env.TRUST_PROXY === 'true';
const MEDIA_DIR = path.resolve(expand(env.MEDIA_DIR || path.join(HOME, 'Videos')));
// library: the film folder as a list on the host page; dialog: the desktop file chooser (zenity)
// on the server's own screen; auto: the folder when it exists, the dialog when a display is there
const PICKER = env.PICKER || 'auto';
const CACHE_DIR = path.resolve(expand(env.CACHE_DIR || path.join(HOME, '.cache', 'silent-cinema')));
const PUBLIC_DIR = path.join(__dirname, 'public');
const HLS_JS = require.resolve('hls.js/dist/hls.min.js');

const VIDEO_EXT = new Set(['.mkv', '.mp4', '.m4v', '.mov', '.webm', '.avi', '.ts', '.m2ts', '.wmv', '.flv']);

fs.mkdirSync(CACHE_DIR, { recursive: true, mode: 0o700 });
// the hls cache only lives as long as a session; drop what a crash left behind
for (const f of fs.readdirSync(CACHE_DIR)) fs.rmSync(path.join(CACHE_DIR, f), { recursive: true, force: true });

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.webp': 'image/webp',
};

const CSP = "default-src 'self'; media-src 'self' blob:; worker-src 'self' blob:; connect-src 'self' wss: ws:; img-src 'self' data:; "
  + "style-src 'self' 'unsafe-inline'; script-src 'self'; base-uri 'none'; frame-ancestors 'none'";

const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);

// changes whenever a client file changes, so open pages reload themselves after an update
let lastBuild = '';
function build() {
  const parts = [];
  // editors and sync tools drop temporary files here that come and go at any moment
  for (const f of fs.readdirSync(PUBLIC_DIR).sort()) {
    if (f.startsWith('.') || f.startsWith('~') || f.endsWith('.tmp')) continue;
    try {
      const st = fs.statSync(path.join(PUBLIC_DIR, f));
      parts.push(`${f}:${st.size}:${st.mtimeMs}`);
    } catch { /* vanished meanwhile */ }
  }
  return crypto.createHash('sha1').update(parts.join('|')).digest('hex').slice(0, 12);
}

// set on every connection of the host listener
const VIA_HOST = Symbol('host listener');

// the host role, /host and /api/probe exist only on the host listener. the same check exempts
// it from the bot budgets, so load tests can run against it
function isLocal(req) {
  return !!req.socket[VIA_HOST];
}

function clientIp(req) {
  if (TRUST_PROXY && !isLocal(req)) {
    const hops = String(req.headers['x-forwarded-for'] || '').split(',').map((x) => x.trim()).filter(Boolean);
    if (hops.length) return hops[hops.length - 1].replace(/^::ffff:/, '');
  }
  return (req.socket.remoteAddress || '').replace(/^::ffff:/, '');
}

function hostOf(req) {
  return String(req.headers.host || '').toLowerCase().replace(/:\d+$/, '');
}

function hostAllowed(req) {
  const h = hostOf(req);
  if (isLocal(req)) return HOST_NAMES.has(h);
  return !PUBLIC_HOSTS.size || PUBLIC_HOSTS.has(h);
}

function sendJson(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(body);
}

function sendText(res, code, text) {
  res.writeHead(code, { 'content-type': 'text/plain; charset=utf-8' });
  res.end(text);
}

function serveStatic(res, root, name, extra = {}) {
  const file = path.join(root, name);
  fs.readFile(file, (err, data) => {
    if (err) return sendText(res, 404, 'not found');
    res.writeHead(200, {
      'content-type': MIME[path.extname(file)] || 'application/octet-stream',
      'cache-control': 'no-cache',
      'x-content-type-options': 'nosniff',
      ...extra,
    });
    res.end(data);
  });
}

const M3U8 = 'application/vnd.apple.mpegurl';

function serveHls(req, res, stream, name, query) {
  if (name === 'master.m3u8') {
    res.writeHead(200, { 'content-type': M3U8, 'cache-control': 'no-store' });
    const v = /^\d$/.test(query.get('v') || '') ? Number(query.get('v')) : null;
    return res.end(stream.master(v));
  }
  let m = /^(v\d|a\d+)\.m3u8$/.exec(name);
  if (m) {
    res.writeHead(200, { 'content-type': M3U8, 'cache-control': 'no-store' });
    return res.end(stream.playlist(m[1]));
  }
  m = /^(v\d|a\d+)_(\d+)\.ts$/.exec(name);
  if (m) {
    const kind = m[1];
    const i = Number(m[2]);
    const known = kind[0] === 'v' ? stream.levels.some((l) => l.id === Number(kind.slice(1))) : stream.meta.audio.some((a) => a.index === Number(kind.slice(1)));
    if (!known) return sendText(res, 404, 'not found');
    // a request hls.js gave up on (seek, closed tab) takes its queued ffmpeg job with it
    let answered = false;
    res.on('close', () => { if (!answered) stream.release(kind, i); });
    return stream.segment(kind, i).then((file) => {
      answered = true;
      fs.stat(file, (err, st) => {
        if (err) return sendText(res, 404, 'not found');
        res.writeHead(200, { 'content-type': 'video/mp2t', 'content-length': st.size, 'cache-control': 'private, max-age=600' });
        if (req.method === 'HEAD') return res.end();
        const rs = fs.createReadStream(file, { highWaterMark: 1 << 20 });
        rs.on('error', () => res.destroy());
        res.on('close', () => rs.destroy());
        rs.pipe(res);
        // the top level is the one people watch: prepare it further ahead than the fallbacks
        stream.prefetch(kind, i, kind === 'v0' ? 4 : 1);
      });
    }).catch((e) => {
      answered = true;
      if (res.destroyed || res.writableEnded) return;
      if (e.message === 'busy') { res.setHeader('retry-after', '1'); return sendText(res, 503, 'busy'); }
      log('segment failed', kind, i, e.message);
      sendText(res, 500, 'segment failed');
    });
  }
  m = /^s(\d+)\.vtt$/.exec(name);
  if (m) {
    return stream.subtitle(Number(m[1])).then((file) => {
      if (!file) return sendText(res, 404, 'not found');
      res.writeHead(200, { 'content-type': 'text/vtt; charset=utf-8', 'cache-control': 'no-store' });
      // the file can vanish when the session ends mid-download; an unhandled stream error kills node
      fs.createReadStream(file).on('error', () => res.destroy()).pipe(res);
    }).catch((e) => { log('subtitle failed', e.message); sendText(res, 500, 'subtitle failed'); });
  }
  return sendText(res, 404, 'not found');
}

// ---------- choosing a film (host only) ----------
// the host websocket may only start a file the server itself offered: one from the last listing
// of the film folder, or one picked in the file dialog on the server's screen. a path typed into
// a forged message is refused, so the host page cannot read arbitrary files.

const picked = new Set();
let listed = new Set();
let dialogProc = null;

function resolveSafe(p) {
  try {
    const real = fs.realpathSync(path.resolve(String(p)));
    return picked.has(real) || listed.has(real) ? real : null;
  } catch {
    return null;
  }
}

function onPath(cmd) {
  return String(env.PATH || '').split(path.delimiter).some((d) => {
    try { fs.accessSync(path.join(d, cmd), fs.constants.X_OK); return true; } catch { return false; }
  });
}

const ZENITY = env.ZENITY || 'zenity';
const dialogOn = () => PICKER === 'dialog' || (PICKER === 'auto' && !!(env.WAYLAND_DISPLAY || env.DISPLAY) && onPath(ZENITY));
const libraryOn = () => PICKER === 'library' || (PICKER === 'auto' && fs.existsSync(MEDIA_DIR));
const pickerInfo = () => ({ library: libraryOn(), dialog: dialogOn(), dir: MEDIA_DIR });

// every video file under the film folder, newest first. hidden entries are skipped, the walk is
// bounded so a huge disk cannot stall the server, and symlinked files count as listed
const LIB_DEPTH = 6;
const LIB_MAX = 5000;
async function scanLibrary() {
  const fsp = fs.promises;
  let root;
  try { root = await fsp.realpath(MEDIA_DIR); } catch { return { files: [], missing: true }; }
  const files = [];
  const real = new Set();
  let more = false;
  async function walk(dir, depth) {
    let entries;
    try { entries = await fsp.readdir(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (e.name.startsWith('.')) continue;
      if (files.length >= LIB_MAX) { more = true; return; }
      const full = path.join(dir, e.name);
      if (e.isDirectory()) { if (depth < LIB_DEPTH) await walk(full, depth + 1); continue; }
      if (!VIDEO_EXT.has(path.extname(e.name).toLowerCase())) continue;
      try {
        const r = await fsp.realpath(full);
        const st = await fsp.stat(r);
        if (!st.isFile()) continue;
        real.add(r);
        files.push({ path: r, name: e.name, rel: path.relative(root, full).split(path.sep).join('/'), size: st.size, mtime: st.mtimeMs });
      } catch { /* broken link or gone meanwhile */ }
    }
  }
  await walk(root, 0);
  files.sort((a, b) => b.mtime - a.mtime);
  listed = real;
  return { files, more };
}

function openDialog(ws) {
  if (!dialogOn()) return wsSend(ws, { t: 'dialog', state: 'error' });
  if (dialogProc) return wsSend(ws, { t: 'dialog', state: 'busy' });
  const uid = process.getuid();
  const denv = {
    ...env,
    XDG_RUNTIME_DIR: env.XDG_RUNTIME_DIR || `/run/user/${uid}`,
    DBUS_SESSION_BUS_ADDRESS: env.DBUS_SESSION_BUS_ADDRESS || `unix:path=/run/user/${uid}/bus`,
  };
  const start = (fs.existsSync(MEDIA_DIR) ? MEDIA_DIR : HOME) + path.sep;
  const exts = [...VIDEO_EXT].map((e) => `*${e}`).join(' ');
  const args = [ZENITY, '--file-selection', '--title=choose a film to watch together',
    `--filename=${start}`, `--file-filter=video | ${exts}`, '--file-filter=all files | *'];
  // under systemd the dialog is started in the user's own systemd manager: a service that holds a
  // capability (to bind port 443) has children the desktop file chooser portal cannot identify
  dialogProc = env.INVOCATION_ID && onPath('systemd-run')
    ? spawn('systemd-run', ['--user', '--pipe', '--wait', '--quiet', '--collect', '--unit=silent-cinema-dialog', '--setenv=GTK_USE_PORTAL=1', ...args],
      { env: denv, stdio: ['ignore', 'pipe', 'ignore'] })
    : spawn(args[0], args.slice(1), { env: denv, stdio: ['ignore', 'pipe', 'ignore'] });
  wsSend(ws, { t: 'dialog', state: 'open' });
  let out = '';
  dialogProc.stdout.on('data', (d) => { out += d; });
  dialogProc.on('error', () => { dialogProc = null; wsSend(ws, { t: 'dialog', state: 'error' }); });
  dialogProc.on('close', (code) => {
    dialogProc = null;
    const file = out.trim();
    if (code !== 0 || !file) return wsSend(ws, { t: 'dialog', state: 'cancel' });
    try {
      const real = fs.realpathSync(file);
      const st = fs.statSync(real);
      if (!st.isFile()) throw new Error('not a file');
      picked.add(real);
      S.lastPick = { path: real, name: path.basename(real), size: st.size };
      saveSoon();
      wsSend(ws, { t: 'dialog', state: 'done', ...S.lastPick });
    } catch {
      wsSend(ws, { t: 'dialog', state: 'error' });
    }
  });
}

function probe(file) {
  return new Promise((resolve, reject) => {
    execFile('ffprobe', ['-v', 'error', '-show_format', '-show_streams', '-of', 'json', file],
      { maxBuffer: 32 << 20 }, (err, out) => {
        if (err) return reject(err);
        try { resolve(JSON.parse(out)); } catch (e) { reject(e); }
      });
  });
}

function describeStreams(info) {
  const streams = info.streams || [];
  const pick = (type) => streams.filter((s) => s.codec_type === type).map((s, i) => ({
    index: i,
    codec: s.codec_name,
    channels: s.channels || null,
    lang: (s.tags && s.tags.language) || '',
    title: (s.tags && (s.tags.title || s.tags.TITLE)) || '',
  }));
  const v = streams.find((s) => s.codec_type === 'video');
  return {
    duration: Number(info.format && info.format.duration) || 0,
    video: v ? { codec: v.codec_name, width: v.width, height: v.height, pix: v.pix_fmt || '' } : null,
    audio: pick('audio'),
    subs: pick('subtitle').filter((s) => !['hdmv_pgs_subtitle', 'dvd_subtitle', 'dvb_subtitle'].includes(s.codec)),
  };
}

// ---------- session state ----------

const rid = (n = 16) => crypto.randomBytes(n).toString('hex');
const STATE_DIR = path.resolve(expand(env.STATE_DIR || path.join(HOME, '.local', 'state', 'silent-cinema')));
const STATE_FILE = path.join(STATE_DIR, 'state.json');
// a page that said goodbye (closed or reloaded) gets a short window, a connection that just
// died (phone locked, train tunnel, wifi switch) gets a long one
const GRACE_BYE = { viewer: 15000, host: 30000 };
const GRACE_LOST = 5 * 60000;
const IDLE_VIEWER = 3000;        // a viewer outside a session leaves the list this fast
const BUF_TTL = 8000;            // a buffering flag that is not repeated expires
const BUF_MAX = 45000;           // nobody waits longer than this for one side's loading
// play, resume and seek take effect this far in the future: the state reaches everyone first,
// so all start on the same frame instead of each one as soon as its message arrives
const LEAD = 300;
const HOST = 'host';             // the host's id in the chat, in reactions and in "who pressed it"
// people in one room. the server sends the film to every viewer separately, so the real ceiling
// is the upload bandwidth divided by the film's bitrate; this limit only stops a flood
const MAX_VIEWERS = Number(env.MAX_VIEWERS) || 40;
const PER_ADDR_VIEWERS = 12;     // people behind one vpn or carrier nat share an address

// ---------- bots ----------
// a page has to solve a small proof of work before it may take a nick (about 16 thousand sha256
// rounds, a few tens of ms in a browser, invisible to a person), and every outside address gets
// a budget of connections, joins and plain requests per minute. loopback is exempt: load tests
// and the host page run there.
const POW_BITS = 14;
const BUDGET = { http: 240, ws: 40, join: 20 };   // per outside address and minute
const budgets = new Map();       // `${kind}|${ip}` -> { n, at }
function overBudget(kind, ip) {
  const now = Date.now();
  const key = `${kind}|${ip}`;
  let b = budgets.get(key);
  if (!b || now - b.at > 60000) { b = { n: 0, at: now }; budgets.set(key, b); }
  return ++b.n > BUDGET[kind];
}
function powOk(challenge, nonce) {
  if (!challenge || typeof nonce !== 'string' || nonce.length > 16) return false;
  const h = crypto.createHash('sha256').update(`${challenge}:${nonce}`).digest();
  return (h.readUInt32BE(0) >>> (32 - POW_BITS)) === 0;
}
// chat: a burst of 6 messages, then one every 1.2 s per person
const chatBudget = new Map();    // uid -> { tokens, at }
function chatAllowed(uid) {
  const now = Date.now();
  const b = chatBudget.get(uid) || { tokens: 6, at: now };
  b.tokens = Math.min(6, b.tokens + (now - b.at) / 1200);
  b.at = now;
  chatBudget.set(uid, b);
  if (b.tokens < 1) return false;
  b.tokens -= 1;
  return true;
}

// ---------- avatars, kept per nick ----------
// a picture is cut and shrunk in the browser (square, at most 128 px, at most AVA_MAX bytes) and
// arrives through the websocket; the server only checks the format and stores it under a hash
// of the lowercase nick. whoever holds a nick right now may change its picture.
const AVA_DIR = path.join(STATE_DIR, 'avatars');
const AVA_INDEX = path.join(AVA_DIR, 'index.json');
const AVA_MAX = 6000;
const AVA_KEEP = 400;
const AVA_TYPES = { webp: 'image/webp', jpg: 'image/jpeg', png: 'image/png' };
let avatars = {};                // lowercase nick -> { id, ext, v }
try { avatars = JSON.parse(fs.readFileSync(AVA_INDEX, 'utf8')) || {}; } catch { avatars = {}; }
const avaKey = (name) => String(name || '').toLowerCase();
function avatarMap() {
  const out = {};
  for (const [k, a] of Object.entries(avatars)) out[k] = `/avatar/${a.id}.${a.ext}?v=${a.v}`;
  return out;
}
function sniff(buf) {
  if (buf.length > 12 && buf.toString('latin1', 0, 4) === 'RIFF' && buf.toString('latin1', 8, 12) === 'WEBP') return 'webp';
  if (buf.length > 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'jpg';
  if (buf.length > 8 && buf.readUInt32BE(0) === 0x89504e47) return 'png';
  return null;
}
function setAvatar(name, data, ws) {
  const now = Date.now();
  if (now - (ws.avaAt || 0) < 2500) return wsSend(ws, { t: 'avaerr', code: 'too_fast' });
  ws.avaAt = now;
  const key = avaKey(name);
  if (!key) return;
  const old = avatars[key];
  if (data === null) {
    if (!old) return;
    delete avatars[key];
    fs.rm(path.join(AVA_DIR, `${old.id}.${old.ext}`), { force: true }, () => {});
  } else {
    const m = /^data:image\/(webp|jpeg|png);base64,([A-Za-z0-9+/=]+)$/.exec(String(data || ''));
    const buf = m ? Buffer.from(m[2], 'base64') : null;
    const ext = buf && buf.length <= AVA_MAX ? sniff(buf) : null;
    if (!ext) return wsSend(ws, { t: 'avaerr', code: 'bad_picture' });
    const id = crypto.createHash('sha1').update(key).digest('hex').slice(0, 16);
    try {
      fs.mkdirSync(AVA_DIR, { recursive: true, mode: 0o700 });
      if (old && old.ext !== ext) fs.rmSync(path.join(AVA_DIR, `${old.id}.${old.ext}`), { force: true });
      fs.writeFileSync(path.join(AVA_DIR, `${id}.${ext}`), buf, { mode: 0o600 });
    } catch (e) { log('avatar save failed', e.message); return; }
    avatars[key] = { id, ext, v: now.toString(36), at: now };
    // the oldest pictures go when there are too many, so nobody can fill the disk with nicks
    const keys = Object.keys(avatars);
    if (keys.length > AVA_KEEP) {
      keys.sort((a, b) => (avatars[a].at || 0) - (avatars[b].at || 0));
      for (const k of keys.slice(0, keys.length - AVA_KEEP)) {
        fs.rm(path.join(AVA_DIR, `${avatars[k].id}.${avatars[k].ext}`), { force: true }, () => {});
        delete avatars[k];
      }
    }
  }
  try { fs.writeFileSync(AVA_INDEX, JSON.stringify(avatars), { mode: 0o600 }); } catch (e) { log('avatar index failed', e.message); }
  log('avatar', data === null ? 'removed:' : 'set:', name);
  const msg = JSON.stringify({ t: 'avatars', map: avatarMap() });
  for (const c of wss.clients) if (c.readyState === 1) c.send(msg);
}

const S = {
  host: null,                 // websocket of the host
  viewers: new Map(),         // id -> { id, name, ws, timer, ip }: everyone who typed a nick
  session: null,
  lastPick: null,             // { path, name, size } so a host page reload shows the file again
  hostName: cleanName(env.HOST_NAME) || 'host', // the host's nick in the chat and on the viewers' screens
  open: false,                // people who come during the film enter without the host's tap
  control: true,              // whether newcomers may play, pause and seek; each person in the room has an own switch
};

function wsSend(ws, obj) {
  if (ws && ws.readyState === 1) ws.send(JSON.stringify(obj));
}

const online = (v) => !!(v && v.ws && v.ws.readyState === 1);
const hostOnline = () => !!(S.host && S.host.readyState === 1);
const isMember = (id) => !!(S.session && S.session.members.has(id));
// the host always controls playback; a viewer as long as the host leaves their switch on
const canControl = (uid) => uid === HOST || !!(S.session && (S.session.members.get(uid) || {}).control);

// the lobby: people with a nick who are not in the room
function usersList() {
  return [...S.viewers.values()].filter((v) => online(v) && !isMember(v.id)).map((v) => ({ id: v.id, name: v.name }));
}

// to the host and to everyone in the room
function cast(obj, except) {
  const s = S.session;
  if (!s) return;
  const data = JSON.stringify(obj);
  if (S.host && S.host !== except && S.host.readyState === 1) S.host.send(data);
  for (const id of s.members.keys()) {
    const v = S.viewers.get(id);
    if (online(v) && v.ws !== except) v.ws.send(data);
  }
}

// every person gets an own key to the stream, so a viewer the host removed loses the film too
function sessionView(uid) {
  const s = S.session;
  if (!s) return null;
  const v = { title: s.title, status: s.status, error: s.error || null, duration: s.duration, control: canControl(uid) };
  const token = uid === HOST ? s.token : (s.members.get(uid) || {}).token;
  if (s.status === 'ready' && token) {
    v.master = `/hls/${token}/master.m3u8`;
    v.audio = s.stream.meta.audio.map((a) => ({ index: a.index, lang: a.lang, title: a.title, codec: a.codec, channels: a.channels }));
    v.subs = s.stream.meta.subs.map((t) => ({ index: t.index, lang: t.lang, title: t.title, url: `/hls/${token}/s${t.index}.vtt` }));
    v.levels = s.stream.levels.map((l) => ({ id: l.id, label: l.label }));
    v.pos = position(s);           // where a fresh player starts loading, so it never fetches the opening first
  }
  return v;
}

const loading = (m, now) => !!m.buf && now - m.buf < BUF_TTL && now - m.bufSince < BUF_MAX;

// who is in the room and how each one is doing; goes out only when something changed
function rosterMsg(s, now = Date.now()) {
  const state = (on, m) => (!on ? 'away' : loading(m, now) ? 'buf' : 'on');
  return {
    t: 'roster',
    host: { name: S.hostName, state: state(hostOnline(), s.host) },
    people: [...s.members].map(([id, m]) => ({ id, name: m.name, state: state(online(S.viewers.get(id)), m), control: !!m.control })),
    open: S.open,
    control: S.control,
  };
}

function pushRoster() {
  const s = S.session;
  if (!s) return;
  const m = rosterMsg(s);
  const key = JSON.stringify(m);
  if (key === s.rosterKey) return;
  s.rosterKey = key;
  cast(m);
}

// ---------- the playback clock ----------
// clock = { playing, time, at }: what the room wants. playback is "held" while the host loads or
// is away; then the clock stands still and everyone waits on the same frame. a single viewer
// holds it the same way, so two people always wait for each other. in a group nobody waits
// for a viewer: a slow or lost one catches up by itself and the others never notice.

function holdsOf(s, now) {
  const out = [];
  if (!hostOnline()) out.push({ who: 'host', id: HOST, name: S.hostName, why: 'away' });
  else if (loading(s.host, now)) out.push({ who: 'host', id: HOST, name: S.hostName, why: 'buf' });
  if (s.members.size === 1) {
    const [[id, m]] = s.members;
    if (!online(S.viewers.get(id))) out.push({ who: 'viewer', id, name: m.name, why: 'away' });
    else if (loading(m, now)) out.push({ who: 'viewer', id, name: m.name, why: 'buf' });
  }
  return out;
}

function clampTime(s, t) {
  return Math.max(0, Math.min(t, s.duration || t));
}

function position(s, now = Date.now()) {
  const c = s.clock;
  return c.playing && !s.held ? clampTime(s, c.time + Math.max(0, now - c.at) / 1000) : c.time;
}

// the clock base itself goes out (time at moment `at`, which may lie up to LEAD in the future),
// so every side computes the same position for every moment, the start included
function stateMsg(s) {
  return {
    t: 'state', seq: s.seq, playing: s.clock.playing, held: s.held, time: s.clock.time, at: s.clock.at,
    holds: s.holds, by: s.by || null,
  };
}

function broadcastState() {
  const s = S.session;
  if (!s || s.status !== 'ready') return;
  s.seq++;
  s.lastCast = Date.now();
  cast(stateMsg(s));
  s.by = null;
}

// re-evaluates the holds; when playback stops or resumes because of them, the clock is
// rebased first so not a single frame is lost or skipped
function refresh(force) {
  const s = S.session;
  if (!s || s.status !== 'ready') return;
  const now = Date.now();
  const holds = holdsOf(s, now);
  const held = holds.length > 0;
  const key = JSON.stringify(holds);
  if (held !== s.held) {
    s.clock = { ...s.clock, time: position(s, now), at: held ? now : now + LEAD };
    s.held = held;
  }
  if (s.clock.playing && !s.held && s.duration && position(s, now) >= s.duration - 0.05) {
    s.clock = { playing: false, time: s.duration, at: now };
    force = true;
  }
  if (force || key !== s.holdKey) {
    s.holds = holds;
    s.holdKey = key;
    broadcastState();
  }
}

function command(uid, name, m) {
  const s = S.session;
  if (!s || s.status !== 'ready') return;
  const now = Date.now();
  const base = position(s, now);
  if (m.t === 'play') {
    const t = s.duration && base >= s.duration - 0.5 ? 0 : base;
    s.clock = { playing: true, time: t, at: now + LEAD };
  } else if (m.t === 'pause') {
    // the frame the user saw when pressing pause, if it is close to the shared position
    const t = Number(m.time);
    const time = Number.isFinite(t) && Math.abs(t - base) < 2 ? clampTime(s, t) : base;
    s.clock = { playing: false, time, at: now };
  } else if (m.t === 'seek') {
    const t = Number(m.time);
    if (!Number.isFinite(t)) return;
    s.clock = { ...s.clock, time: clampTime(s, t), at: s.clock.playing ? now + LEAD : now };
  } else return;
  s.by = { who: uid === HOST ? 'host' : 'viewer', id: uid, name, act: m.t };
  refresh(true);
  saveSoon();
}

function setBuf(uid, v) {
  const s = S.session;
  const m = s && (uid === HOST ? s.host : s.members.get(uid));
  if (!m) return;
  const now = Date.now();
  if (v && !m.buf) m.bufSince = now;
  m.buf = v ? now : 0;
  refresh();
  pushRoster();
}

function pushUsers() {
  wsSend(S.host, { t: 'users', users: usersList() });
}

// viewers see whether the host is around and whether a film is already running
function pushHostPresence() {
  const m = { t: 'host', online: hostOnline(), name: S.hostName, busy: !!S.session };
  for (const v of S.viewers.values()) wsSend(v.ws, m);
}

function pushSession(reason) {
  const s = S.session;
  wsSend(S.host, { t: 'session', session: sessionView(HOST), reason });
  if (!s) return;
  for (const id of s.members.keys()) wsSend((S.viewers.get(id) || {}).ws, { t: 'session', session: sessionView(id), reason });
  if (s.status === 'ready') cast(stateMsg(s));
  s.rosterKey = '';
  pushRoster();
}

// ---------- persistence: a restart of the service must not lose the room ----------

let saveTimer = null;
function saveSoon() {
  if (saveTimer) return;
  saveTimer = setTimeout(saveNow, 800);
}

function saveNow() {
  clearTimeout(saveTimer);
  saveTimer = null;
  const s = S.session;
  if (s) s.lastSave = Date.now();
  const data = {
    lastPick: S.lastPick,
    hostName: S.hostName,
    open: S.open,
    control: S.control,
    session: s && s.status !== 'error' ? {
      path: s.path, title: s.title, token: s.token,
      members: [...s.members].map(([id, m]) => ({ id, name: m.name, token: m.token, control: m.control })),
      time: s.status === 'ready' ? position(s) : s.clock.time,
      chat: s.chat,
    } : null,
  };
  try {
    fs.mkdirSync(STATE_DIR, { recursive: true, mode: 0o700 });
    fs.writeFileSync(`${STATE_FILE}.tmp`, JSON.stringify(data), { mode: 0o600 });
    fs.renameSync(`${STATE_FILE}.tmp`, STATE_FILE);
  } catch (e) { log('state save failed', e.message); }
}

// a restart (update, reboot) keeps the exact position, not the one of the last periodic save
for (const sig of ['SIGTERM', 'SIGINT']) {
  process.on(sig, () => { saveNow(); process.exit(0); });
}

const person = (now) => ({ seen: now, bye: false, buf: 0, bufSince: 0 });

function newSession(fields) {
  const now = Date.now();
  return {
    status: 'preparing', stream: null, duration: 0, chat: [], error: null,
    clock: { playing: false, time: 0, at: now }, held: false, holds: [], holdKey: '[]',
    members: new Map(),          // viewer id -> { name, token, seen, bye, buf, bufSince }
    host: person(now),
    kicked: new Set(),           // people the host removed: an open room does not let them back in by itself
    seq: 0, by: null, lastCast: 0, lastSave: 0, rosterKey: '',
    ...fields,
  };
}

function addMember(s, id, name, token, control) {
  s.members.set(id, { name, token: token || rid(16), control: typeof control === 'boolean' ? control : S.control, ...person(Date.now()) });
}

// the stream keys that are valid right now: the host's and one per person in the room
function streamKey(s, token) {
  if (!token) return false;
  if (token === s.token) return true;
  for (const m of s.members.values()) if (m.token === token) return true;
  return false;
}

async function prepare(sess) {
  const meta = describeStreams(await probe(sess.path));
  if (!meta.video) throw new Error('no_video');
  const stream = new Stream(sess.path, meta, path.join(CACHE_DIR, 'hls', sess.token));
  sess.stream = stream;
  await stream.init();
  if (S.session !== sess) { stream.destroy(); return false; }
  // a container without a duration still has an end: the last keyframe segment
  sess.duration = meta.duration || stream.segs[stream.segs.length - 1].end;
  sess.clock.time = clampTime(sess, sess.clock.time);
  sess.status = 'ready';
  return true;
}

async function restoreState() {
  let data;
  try { data = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')); } catch { return; }
  if (typeof data.hostName === 'string' && cleanName(data.hostName)) S.hostName = cleanName(data.hostName);
  if (typeof data.open === 'boolean') S.open = data.open;
  if (typeof data.control === 'boolean') S.control = data.control;
  if (data.lastPick && fs.existsSync(data.lastPick.path)) {
    S.lastPick = data.lastPick;
    picked.add(fs.realpathSync(data.lastPick.path));
  }
  const d = data.session;
  if (!d || !fs.existsSync(d.path)) return;
  const list = Array.isArray(d.members) ? d.members : [];
  if (!list.length) return;
  const time = Number(d.time) || 0;
  const sess = newSession({
    path: d.path, title: d.title, token: d.token,
    chat: d.chat || [], clock: { playing: false, time, at: Date.now() },
  });
  for (const m of list) {
    S.viewers.set(m.id, { id: m.id, name: m.name, ws: null, timer: null });
    addMember(sess, m.id, m.name, m.token, m.control);
  }
  chatIds(sess);
  S.session = sess;
  picked.add(fs.realpathSync(d.path));
  try {
    if (await prepare(sess)) {
      log(`session restored: ${sess.title} for ${list.map((m) => m.name).join(', ')} at ${Math.round(time)} s`);
      pushSession();
    }
  } catch (e) {
    log('restore failed:', e.message);
    if (S.session === sess) endSession();
  }
}

// a person leaves the room: by an own tap ('left'), by a dead line ('lost') or by the host
// ('kicked'). the film goes on for the others; with nobody left it ends, as it did for two
function removeMember(id, why) {
  const s = S.session;
  if (!s || !s.members.has(id)) return;
  const m = s.members.get(id);
  s.members.delete(id);
  log(`left the room (${why}):`, m.name);
  if (!s.members.size) return endSession(why === 'left' ? 'room_left' : why === 'kicked' ? 'host_ended' : 'room_lost');
  cast({ t: 'gone', id, name: m.name, why });
  refresh();
  pushRoster();
  saveSoon();
}

function dropViewer(id) {
  const v = S.viewers.get(id);
  if (!v) return;
  clearTimeout(v.timer);
  S.viewers.delete(id);
  log('viewer left:', v.name);
  removeMember(id, 'lost');
  pushUsers();
}

function endSession(reason) {
  const s = S.session;
  if (!s) return;
  if (s.stream) s.stream.destroy();
  S.session = null;
  log('session ended:', s.title, reason ? `(${reason})` : '');
  wsSend(S.host, { t: 'session', session: null, reason });
  for (const id of s.members.keys()) {
    const v = S.viewers.get(id);
    if (!v) continue;
    wsSend(v.ws, { t: 'session', session: null, reason });
    // someone who is offline has nothing to come back to
    if (!online(v)) { clearTimeout(v.timer); S.viewers.delete(id); }
  }
  // the picked film stays in the host's field after the end, so the same film can start again
  pushUsers();
  pushHostPresence();
  saveSoon();
}

// one second watchdog: holds expire, the state is repeated every 5 s, the position is saved
// every 10 s, and whoever stays away too long leaves the room (the host takes the film along)
setInterval(() => {
  const s = S.session;
  if (!s) return;
  const now = Date.now();
  if (hostOnline()) s.host.seen = now;
  if (now - s.host.seen > (s.host.bye ? GRACE_BYE.host : GRACE_LOST)) return endSession('host_left');
  for (const [id, m] of [...s.members]) {
    if (online(S.viewers.get(id))) m.seen = now;
    else if (now - m.seen > (m.bye ? GRACE_BYE.viewer : GRACE_LOST)) dropViewer(id);
  }
  if (S.session !== s) return;
  pushRoster();
  if (s.status !== 'ready') return;
  refresh(now - s.lastCast > 5000);
  if (s.clock.playing && !s.held && now - s.lastSave > 10000) saveSoon();
}, 1000).unref();

async function startSession(hostWs, msg) {
  const file = resolveSafe(msg.path);
  let st = null;
  try { st = file && fs.statSync(file); } catch { /* gone meanwhile */ }
  if (!st || !st.isFile()) return wsSend(hostWs, { t: 'error', code: 'file_unavailable' });
  const ids = Array.isArray(msg.viewers) ? msg.viewers.slice(0, MAX_VIEWERS).map(String) : [];
  const chosen = [...new Set(ids)].map((id) => S.viewers.get(id)).filter(online);
  if (!chosen.length) return wsSend(hostWs, { t: 'error', code: 'nobody_online' });
  picked.add(file);
  S.lastPick = { path: file, name: path.basename(file), size: st.size };
  endSession();
  const sess = newSession({ path: file, title: path.basename(file), token: rid(16) });
  for (const v of chosen) addMember(sess, v.id, v.name);
  S.session = sess;
  log('session start:', sess.title, 'for', chosen.map((v) => v.name).join(', '));
  pushSession();
  pushUsers();
  pushHostPresence();
  try {
    if (!(await prepare(sess))) return;
  } catch (e) {
    if (S.session !== sess) return;
    if (sess.stream) sess.stream.destroy();
    sess.status = 'error';
    // viewers see the error too: a known code, never an ffmpeg message with the host's paths in it
    const msg = String(e.message || e);
    sess.error = ['no_video', 'no_keyframes'].includes(msg) ? msg : 'open_failed';
    log('session error:', msg);
  }
  pushSession();
  saveSoon();
}

// someone from the lobby enters a film that is already running and lands on the current frame.
// `auto` is the open room letting people in by itself; the host's own tap also forgives a removal
function admit(v, auto) {
  const s = S.session;
  if (!s || s.status === 'error' || !online(v) || s.members.has(v.id)) return false;
  if (auto && s.kicked.has(v.id)) return false;
  s.kicked.delete(v.id);
  if (s.members.size >= MAX_VIEWERS) { wsSend(S.host, { t: 'error', code: 'room_full', n: MAX_VIEWERS }); return false; }
  addMember(s, v.id, v.name);
  log('entered the room:', v.name);
  wsSend(v.ws, { t: 'session', session: sessionView(v.id), chat: s.chat });
  if (s.status === 'ready') wsSend(v.ws, stateMsg(s));
  cast({ t: 'came', id: v.id, name: v.name }, v.ws);
  refresh();
  pushRoster();
  pushUsers();
  saveSoon();
  return true;
}

function cleanName(raw) {
  return String(raw || '').replace(/[\u0000-\u001f\u007f<>]/g, '').replace(/\s+/g, ' ').trim().slice(0, 24);
}

function cleanText(raw) {
  return String(raw || '').replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, '').trim().slice(0, 400);
}

// chat lives in the session, so a reload of any page gets the whole history back
function chatIds(s) {
  s.chatId = 0;
  for (const m of s.chat) { if (!m.id) m.id = 0; s.chatId = Math.max(s.chatId, m.id); }
  for (const m of s.chat) if (!m.id) m.id = ++s.chatId;
}

function addChat(uid, from, text, replyId) {
  const s = S.session;
  if (!s) return;
  if (s.chatId === undefined) chatIds(s);
  const msg = { id: ++s.chatId, uid, from, text, at: Date.now() };
  // a reply carries a short copy of the quoted message, so it reads right even if that one scrolled out
  const q = s.chat.find((x) => x.id === Number(replyId));
  if (q) msg.reply = { id: q.id, uid: q.uid, from: q.from, text: q.text.slice(0, 120) };
  s.chat.push(msg);
  if (s.chat.length > 300) s.chat.shift();
  cast({ t: 'chat', ...msg });
  saveSoon();
}

// a reaction is one per person and message: the same emoji again takes it back, another one
// replaces it. kept in the history.
const REACTIONS = new Set(['2764_fe0f', '1f44d', '1f602', '1f62e', '1f622', '1f525', '1f440', '1f60e', '1f970', '1f631', '1f92f', '1f389']);
function react(uid, m) {
  const s = S.session;
  if (!s || !REACTIONS.has(m.e)) return;
  const msg = s.chat.find((x) => x.id === Number(m.id));
  if (!msg) return;
  msg.reacts = { ...(msg.reacts || {}) };
  if (msg.reacts[uid] === m.e) delete msg.reacts[uid]; else msg.reacts[uid] = m.e;
  cast({ t: 'reacts', id: msg.id, reacts: msg.reacts, by: uid });
  saveSoon();
}

// "is typing" is a moment, not history: it goes to the others and is not kept
function signal(uid, from, m, ws) {
  if (!S.session) return;
  if (m.t === 'react') return react(uid, m);
  if (m.t === 'typing') cast({ t: 'typing', uid, from, v: !!m.v }, ws);
}

function diag(who, text) {
  log('client report', who, cleanText(text).replace(/\s+/g, ' ').slice(0, 300));
}

// at most 20 commands a second per connection; a stuck key or a script cannot flood the room
function limited(ws) {
  const now = Date.now();
  if (now - (ws.rlAt || 0) > 1000) { ws.rlAt = now; ws.rlN = 0; }
  return ++ws.rlN > 20;
}

const PLAYER_CMDS = new Set(['play', 'pause', 'seek']);
// nobody may pose as the host, whatever the host's own nick is
const RESERVED = new Set(['host', 'хост']);
const nameTaken = (name) => [...S.viewers.values()].some((v) => v.name.toLowerCase() === name.toLowerCase() && (online(v) || isMember(v.id)));

function onHost(ws, req) {
  if (S.host && S.host !== ws) {
    wsSend(S.host, { t: 'kicked' });
    S.host.close();
  }
  S.host = ws;
  if (S.session) S.session.host.bye = false;
  pushHostPresence();
  wsSend(ws, { t: 'ver', build: build() });
  wsSend(ws, {
    t: 'hello', users: usersList(), session: sessionView(HOST),
    state: S.session && S.session.status === 'ready' ? stateMsg(S.session) : null,
    chat: S.session ? S.session.chat : [], lastPick: S.lastPick, hostName: S.hostName,
    open: S.open, control: S.control, max: MAX_VIEWERS, picker: pickerInfo(), publicUrl: PUBLIC_URL,
  });
  wsSend(ws, { t: 'avatars', map: avatarMap() });
  if (S.session) wsSend(ws, rosterMsg(S.session));
  refresh();
  pushRoster();

  ws.on('message', (data) => {
    let m;
    try { m = JSON.parse(data); } catch { return; }
    if (!m || typeof m.t !== 'string') return;
    if (limited(ws)) return;
    if (m.t === 'ping') return wsSend(ws, { t: 'pong', c: m.c, s: Date.now() });
    if (PLAYER_CMDS.has(m.t)) return command(HOST, S.hostName, m);
    switch (m.t) {
      case 'bye': ws.leaving = true; break;
      case 'dialog': openDialog(ws); break;
      case 'library':
        if (!libraryOn()) { wsSend(ws, { t: 'library', files: [], missing: true }); break; }
        scanLibrary().then((r) => wsSend(ws, { t: 'library', ...r, files: r.files.map(({ mtime, ...f }) => f) }))
          .catch((e) => { log('library scan failed', e.message); wsSend(ws, { t: 'library', files: [] }); });
        break;
      case 'pick': startSession(ws, m).catch(() => {}); break;
      case 'stop': endSession('host_ended'); break;
      case 'diag': diag('host', m.text); break;
      case 'buf': setBuf(HOST, !!m.v); break;
      case 'sync': if (S.session && S.session.status === 'ready') wsSend(ws, stateMsg(S.session)); break;
      case 'admit': admit(S.viewers.get(String(m.id))); break;
      case 'kick': {
        // back to the lobby: the page stays connected and the host can let the person in again
        const v = S.viewers.get(String(m.id));
        if (!isMember(String(m.id))) break;
        S.session.kicked.add(String(m.id));
        if (v) wsSend(v.ws, { t: 'session', session: null, reason: 'kicked' });
        removeMember(String(m.id), 'kicked');
        if (v && !online(v)) S.viewers.delete(v.id);
        pushUsers();
        pushHostPresence();
        break;
      }
      case 'open':
        S.open = !!m.v;
        if (S.open && S.session) for (const v of [...S.viewers.values()]) admit(v, true);
        wsSend(ws, { t: 'opts', open: S.open, control: S.control });
        pushRoster();
        saveSoon();
        break;
      case 'control':
        // the switch over the list: everyone in the room and everyone who comes later
        S.control = !!m.v;
        if (S.session) for (const mem of S.session.members.values()) mem.control = S.control;
        wsSend(ws, { t: 'opts', open: S.open, control: S.control });
        pushRoster();
        saveSoon();
        break;
      case 'pctl': {
        // one person's switch; when everyone ends up the same, newcomers follow them
        const mem = S.session && S.session.members.get(String(m.id));
        if (!mem) break;
        mem.control = !!m.v;
        const all = [...S.session.members.values()].map((x) => x.control);
        if (all.every((x) => x === all[0])) S.control = all[0];
        pushRoster();
        saveSoon();
        break;
      }
      case 'avatar': setAvatar(S.hostName, m.data, ws); break;
      case 'name': {
        // the host's own nick; a nick a viewer already uses is refused
        const name = cleanName(m.name);
        if (!name || nameTaken(name)) { wsSend(ws, { t: 'hostname', name: S.hostName, error: name ? 'viewer_nick' : 'empty_nick' }); break; }
        S.hostName = name;
        saveSoon();
        wsSend(ws, { t: 'hostname', name });
        pushHostPresence();
        pushRoster();
        break;
      }
      case 'chat': {
        const text = cleanText(m.text);
        if (text && chatAllowed(HOST)) addChat(HOST, S.hostName, text, m.reply);
        break;
      }
      case 'typing': case 'react': signal(HOST, S.hostName, m, ws); break;
      default: break;
    }
  });
  ws.on('close', () => {
    if (S.host !== ws) return;
    S.host = null;
    if (S.session) { S.session.host.bye = !!ws.leaving; S.session.host.buf = 0; }
    pushHostPresence();
    refresh();
    pushRoster();
  });
}

function onViewer(ws, req) {
  let me = null;
  const local = isLocal(req);
  const challenge = rid(8);
  let solved = local;
  wsSend(ws, { t: 'ver', build: build() });
  wsSend(ws, { t: 'pow', c: challenge, bits: POW_BITS });
  wsSend(ws, { t: 'avatars', map: avatarMap() });
  wsSend(ws, { t: 'host', online: hostOnline(), name: S.hostName, busy: !!S.session });
  ws.on('message', (data) => {
    let m;
    try { m = JSON.parse(data); } catch { return; }
    if (!m || typeof m.t !== 'string') return;
    if (limited(ws)) return;
    if (m.t === 'ping') return wsSend(ws, { t: 'pong', c: m.c, s: Date.now() });
    if (m.t === 'join') {
      if (!solved) {
        // a page from an older build has no answer; it reloads itself when it sees the new build
        if (!powOk(challenge, m.pow)) return wsSend(ws, { t: 'joinerr', code: 'reload' });
        solved = true;
      }
      if (!local && overBudget('join', clientIp(req))) return wsSend(ws, { t: 'joinerr', code: 'too_many_tries' });
      const name = cleanName(m.name);
      if (!name) return wsSend(ws, { t: 'joinerr', code: 'no_nick' });
      if (RESERVED.has(name.toLowerCase()) || name.toLowerCase() === S.hostName.toLowerCase()) return wsSend(ws, { t: 'joinerr', code: 'host_nick' });
      const id = /^[0-9a-f]{16}$/.test(String(m.id || '')) ? String(m.id) : null;
      // one connection is one viewer: a second join replaces the first entry instead of adding
      // places, so a single page cannot fill the room
      if (me) {
        if (isMember(me.id) && me.name !== name) return wsSend(ws, { t: 'joinerr', code: 'nick_locked' });
        if (me.name !== name) { S.viewers.delete(me.id); me = null; }
      }
      const prev = id && S.viewers.get(id);
      if (prev && prev.name === name) {
        clearTimeout(prev.timer);
        // the same person opened the page again (another tab or a duplicated one): the old
        // page is told so and stops reconnecting, otherwise the two would kick each other forever
        if (prev.ws && prev.ws !== ws) { wsSend(prev.ws, { t: 'replaced' }); prev.ws.leaving = true; prev.ws.close(); }
        prev.ws = ws;
        me = prev;
      } else {
        // someone in the room keeps the nick while away (up to 5 minutes), so nobody can step into the film
        if (nameTaken(name)) {
          const holder = [...S.viewers.values()].find((v) => v.name.toLowerCase() === name.toLowerCase());
          log(`nick refused: ${name} (held by ${holder ? (online(holder) ? 'an online page' : 'a member away') : '?'}, ${clientIp(req)})`);
          return wsSend(ws, { t: 'joinerr', code: 'nick_taken' });
        }
        if (S.viewers.size >= MAX_VIEWERS + 20) return wsSend(ws, { t: 'joinerr', code: 'crowded' });
        const ip = clientIp(req);
        if (!isLocal(req) && [...S.viewers.values()].filter((v) => online(v) && v.ip === ip).length >= PER_ADDR_VIEWERS) return wsSend(ws, { t: 'joinerr', code: 'too_many_tabs' });
        me = { id: id && !prev ? id : rid(8), name, ws, timer: null, ip };
        S.viewers.set(me.id, me);
        log('viewer joined:', name, clientIp(req));
      }
      // the room is open: whoever comes during the film is in at once
      if (!isMember(me.id) && S.open && S.session && S.session.status !== 'error' && S.session.members.size < MAX_VIEWERS && !S.session.kicked.has(me.id)) {
        addMember(S.session, me.id, me.name);
        log('entered the room:', me.name);
        cast({ t: 'came', id: me.id, name: me.name }, ws);
        saveSoon();
      }
      const mine = isMember(me.id);
      if (mine) S.session.members.get(me.id).bye = false;
      wsSend(ws, {
        t: 'joined', id: me.id, name: me.name, session: mine ? sessionView(me.id) : null, chat: mine ? S.session.chat : [],
        host: hostOnline(), hostName: S.hostName, busy: !!S.session,
      });
      if (mine && S.session.status === 'ready') wsSend(ws, stateMsg(S.session));
      if (mine) wsSend(ws, rosterMsg(S.session));
      pushUsers();
      refresh();
      pushRoster();
      return;
    }
    if (m.t === 'drop') {
      // a page that left while its line was down (a phone switching apps) says so after the
      // reconnect; the id is the secret of that browser, so its place and nick are freed now
      // instead of being held for five minutes
      const id = String(m.id || '');
      const v = /^[0-9a-f]{16}$/.test(id) && S.viewers.get(id);
      if (!v || v.name !== cleanName(m.name) || v === me) return;
      log('viewer left the room (after reconnect):', v.name);
      clearTimeout(v.timer);
      S.viewers.delete(id);
      if (v.ws && v.ws !== ws) { wsSend(v.ws, { t: 'left' }); v.ws.leaving = true; }
      removeMember(id, 'left');
      pushUsers();
      return;
    }
    if (!me || me.ws !== ws) return;
    const inSession = isMember(me.id);
    if (m.t === 'bye') ws.leaving = true;
    else if (m.t === 'leave') {
      // the viewer leaves the room on purpose: the place is free at once, the others watch on
      log('viewer left the room:', me.name);
      const gone = me;
      me = null;
      clearTimeout(gone.timer);
      S.viewers.delete(gone.id);
      removeMember(gone.id, 'left');
      wsSend(ws, { t: 'left' });
      pushUsers();
    }
    else if (m.t === 'diag') diag(me.name, m.text);
    else if (m.t === 'avatar') setAvatar(me.name, m.data, ws);
    else if (!inSession) return;
    else if (m.t === 'buf') setBuf(me.id, !!m.v);
    else if (m.t === 'sync' && S.session.status === 'ready') wsSend(ws, stateMsg(S.session));
    else if (PLAYER_CMDS.has(m.t)) { if (canControl(me.id)) command(me.id, me.name, m); }
    else if (m.t === 'chat') {
      const text = cleanText(m.text);
      if (!text) return;
      if (chatAllowed(me.id)) addChat(me.id, me.name, text, m.reply);
      else wsSend(ws, { t: 'slow' });
    }
    else if (m.t === 'typing' || m.t === 'react') signal(me.id, me.name, m, ws);
  });
  ws.on('close', () => {
    if (!me || me.ws !== ws) return;
    me.ws = null;
    const mem = S.session && S.session.members.get(me.id);
    clearTimeout(me.timer);
    if (mem) {
      // the watchdog decides when this person is gone for good; two people wait for each other meanwhile
      mem.bye = !!ws.leaving;
      mem.buf = 0;
      refresh();
      pushRoster();
    } else {
      const id = me.id;
      me.timer = setTimeout(() => dropViewer(id), ws.leaving ? 0 : IDLE_VIEWER);
    }
    pushUsers();
  });
}

// ---------- http ----------

function handle(req, res) {
  if (!hostAllowed(req)) return sendText(res, 421, 'misdirected');
  const url = new URL(req.url, 'https://x');
  const p = url.pathname;
  if (req.method !== 'GET' && req.method !== 'HEAD') return sendText(res, 405, 'method not allowed');
  // the film itself is not counted: one person fetches a segment every few seconds anyway
  if (!p.startsWith('/hls/') && !isLocal(req) && overBudget('http', clientIp(req))) {
    res.writeHead(429, { 'content-type': 'text/plain; charset=utf-8', 'retry-after': '30' });
    return res.end('too many requests');
  }
  if (p === '/robots.txt') return sendText(res, 200, 'User-agent: *\nDisallow: /\n');
  if (p.startsWith('/avatar/')) {
    const am = /^\/avatar\/([0-9a-f]{16})\.(webp|jpg|png)$/.exec(p);
    if (!am) return sendText(res, 404, 'not found');
    return serveStatic(res, AVA_DIR, `${am[1]}.${am[2]}`, { 'content-type': AVA_TYPES[am[2]], 'cache-control': 'public, max-age=31536000, immutable' });
  }

  if (p === '/' || p === '/index.html') return serveStatic(res, PUBLIC_DIR, 'index.html', { 'content-security-policy': CSP, 'x-robots-tag': 'noindex, nofollow' });
  if (p === '/host') {
    if (!isLocal(req)) return sendText(res, 404, 'not found');
    return serveStatic(res, PUBLIC_DIR, 'host.html', { 'content-security-policy': CSP });
  }
  if (p === '/static/hls.min.js') return serveStatic(res, path.dirname(HLS_JS), path.basename(HLS_JS));
  if (p.startsWith('/static/')) {
    const name = p.slice(8);
    if (!/^[\w.-]+$/.test(name) || name === 'index.html' || name === 'host.html' || !fs.existsSync(path.join(PUBLIC_DIR, name))) return sendText(res, 404, 'not found');
    return serveStatic(res, PUBLIC_DIR, name);
  }
  // reaction emoji (noto emoji, see NOTICE.md): the files never change, so browsers keep them
  if (p.startsWith('/emoji/')) {
    const name = p.slice(7);
    if (!/^[0-9a-f_]+\.(webp|svg)$/.test(name)) return sendText(res, 404, 'not found');
    return serveStatic(res, path.join(PUBLIC_DIR, 'emoji'), name, { 'cache-control': 'public, max-age=2592000, immutable' });
  }

  if (p.startsWith('/hls/')) {
    const [, , token, name] = p.split('/');
    const sess = S.session;
    if (!sess || sess.status !== 'ready' || !streamKey(sess, token) || !name) return sendText(res, 404, 'not found');
    return serveHls(req, res, sess.stream, name, url.searchParams);
  }

  if (p === '/api/probe') {
    if (!isLocal(req)) return sendText(res, 404, 'not found');
    const file = resolveSafe(url.searchParams.get('path'));
    if (!file) return sendJson(res, 400, { error: 'bad path' });
    return probe(file).then((info) => sendJson(res, 200, describeStreams(info)))
      .catch(() => sendJson(res, 500, { error: 'ffprobe failed' }));
  }
  return sendText(res, 404, 'not found');
}

const tls = !!(TLS_CERT && TLS_KEY);
const tlsOptions = () => ({ key: fs.readFileSync(TLS_KEY), cert: fs.readFileSync(TLS_CERT), minVersion: 'TLSv1.2' });
const server = tls ? https.createServer(tlsOptions(), safeHandle) : http.createServer(safeHandle);
// a renewed certificate is picked up on SIGHUP without dropping anyone (systemctl reload)
process.on('SIGHUP', () => {
  if (!tls) return;
  try { server.setSecureContext(tlsOptions()); log('certificate reloaded'); } catch (e) { log('certificate reload failed', e.message); }
});
// the host page and its websocket: plain http, loopback by default
const local = http.createServer(safeHandle);
local.on('connection', (sock) => { sock[VIA_HOST] = true; });

for (const s of [server, local]) {
  s.requestTimeout = 0;
  s.headersTimeout = 15000;
  s.keepAliveTimeout = 30000;
}

const wss = new WebSocketServer({ noServer: true, maxPayload: 8192 });

// a malformed request line (`GET //[`) makes new URL() throw. uncaught, that would take the whole
// process and everyone watching down, and anyone on the internet could repeat it in a loop.
function safeHandle(req, res) {
  try {
    handle(req, res);
  } catch (e) {
    log('bad request', e.message);
    try { sendText(res, 400, 'bad request'); } catch { res.destroy(); }
  }
}

function safeUpgrade(req, sock, head) {
  try {
    onUpgrade(req, sock, head);
  } catch (e) {
    log('bad upgrade', e.message);
    sock.destroy();
  }
}

function onUpgrade(req, sock, head) {
  const deny = (code) => { sock.write(`HTTP/1.1 ${code}\r\nConnection: close\r\n\r\n`); sock.destroy(); };
  const url = new URL(req.url, 'https://x');
  if (url.pathname !== '/ws' || !hostAllowed(req)) return deny('404 Not Found');
  try {
    const o = new URL(req.headers.origin);
    const oh = o.host.toLowerCase();
    const hh = String(req.headers.host).toLowerCase();
    if (oh !== hh && oh !== hh.replace(/:(443|80)$/, '')) return deny('403 Forbidden');
  } catch { return deny('403 Forbidden'); }
  const role = url.searchParams.get('role');
  if (role !== 'host' && role !== 'viewer') return deny('400 Bad Request');
  if (role === 'host' && !isLocal(req)) return deny('404 Not Found');
  const ip = clientIp(req);
  if (!isLocal(req) && ([...wss.clients].filter((c) => c.ip === ip).length >= 24 || overBudget('ws', ip))) return deny('429 Too Many Requests');
  wss.handleUpgrade(req, sock, head, (ws) => {
    ws.isAlive = true;
    ws.ip = ip;
    ws.on('pong', () => { ws.isAlive = true; });
    ws.on('error', () => {});
    if (role === 'host') onHost(ws, req); else onViewer(ws, req);
  });
}
server.on('upgrade', safeUpgrade);
local.on('upgrade', safeUpgrade);

setInterval(() => {
  for (const ws of wss.clients) {
    if (!ws.isAlive) { ws.terminate(); continue; }
    ws.isAlive = false;
    ws.ping();
  }
  const now = Date.now();
  for (const [k, v] of budgets) if (now - v.at > 60000) budgets.delete(k);
  for (const [k, v] of chatBudget) if (now - v.at > 60000) chatBudget.delete(k);
  const b = build();
  if (b !== lastBuild) {
    lastBuild = b;
    for (const ws of wss.clients) wsSend(ws, { t: 'ver', build: b });
  }
}, 5000).unref();

for (const s of [server, local]) {
  s.on('error', (e) => { console.error(`cannot listen: ${e.message}`); process.exit(1); });
}
local.listen(HOST_PORT, HOST_BIND, () => {
  server.listen(PORT, BIND, () => {
    const p = pickerInfo();
    log(`silent.cinema: viewers on ${tls ? 'https' : 'http'}://${BIND}:${PORT}, host page on http://${HOST_BIND}:${HOST_PORT}/host, build ${build()}`);
    log(`films: ${[p.library && `folder ${MEDIA_DIR}`, p.dialog && 'file dialog'].filter(Boolean).join(' and ') || `nothing (no folder ${MEDIA_DIR}, no display for the dialog)`}`);
    restoreState().catch((e) => log('restore error', e.message));
  });
});
