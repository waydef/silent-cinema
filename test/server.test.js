'use strict';
// end to end: a real server process on free ports with a temporary film folder. the streaming
// part needs ffmpeg and ffprobe on the PATH and is skipped without them.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { spawn, execFileSync } = require('node:child_process');
const crypto = require('node:crypto');
const fs = require('node:fs');
const http = require('node:http');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const WebSocket = require('ws');

const ROOT = path.join(__dirname, '..');
let tmp;
let proc;
let pub;
let host;
let clip;

const hasFfmpeg = (() => {
  try { execFileSync('ffmpeg', ['-version'], { stdio: 'ignore' }); execFileSync('ffprobe', ['-version'], { stdio: 'ignore' }); return true; } catch { return false; }
})();

function freePort() {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)); });
    s.on('error', reject);
  });
}

before(async () => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'silent-cinema-test-'));
  const media = path.join(tmp, 'media');
  fs.mkdirSync(media);
  if (hasFfmpeg) {
    clip = path.join(media, 'clip.mkv');
    execFileSync('ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', 'testsrc=size=320x240:rate=24', '-f', 'lavfi', '-i', 'anullsrc=r=48000:cl=stereo',
      '-t', '12', '-c:v', 'libx264', '-preset', 'ultrafast', '-g', '48', '-c:a', 'aac', clip]);
  }
  pub = await freePort();
  host = await freePort();
  proc = spawn(process.execPath, [path.join(ROOT, 'server.js')], {
    env: {
      ...process.env, PORT: String(pub), BIND: '127.0.0.1', HOST_PORT: String(host), PICKER: 'library',
      MEDIA_DIR: media, STATE_DIR: path.join(tmp, 'state'), CACHE_DIR: path.join(tmp, 'cache'),
      PUBLIC_HOSTS: '', TLS_CERT: '', TLS_KEY: '', TRUST_PROXY: '',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let out = '';
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`server did not start:\n${out}`)), 10000);
    const onData = (d) => {
      out += d;
      if (out.includes('films:')) { clearTimeout(timer); resolve(); }
    };
    proc.stdout.on('data', onData);
    proc.stderr.on('data', onData);
    proc.on('exit', (code) => reject(new Error(`server exited with ${code}:\n${out}`)));
  });
});

after(() => {
  if (proc) proc.kill('SIGTERM');
  if (tmp) fs.rmSync(tmp, { recursive: true, force: true });
});

const get = (port, p) => fetch(`http://127.0.0.1:${port}${p}`);
// fetch does not let a caller set the host header, plain http does
const statusWithHost = (port, p, name) => new Promise((resolve, reject) => {
  http.get({ host: '127.0.0.1', port, path: p, headers: { host: name } }, (res) => { res.resume(); resolve(res.statusCode); }).on('error', reject);
});

// a websocket that keeps every message, with a helper that waits for one of a kind
function connect(port, role) {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/ws?role=${role}`, { origin: `http://127.0.0.1:${port}` });
  const seen = [];
  const waiters = [];
  ws.on('message', (data) => {
    const m = JSON.parse(data);
    seen.push(m);
    for (const w of [...waiters]) if (w.test(m)) { waiters.splice(waiters.indexOf(w), 1); w.resolve(m); }
  });
  ws.next = (test, ms = 15000) => {
    const hit = seen.find(test);
    if (hit) { seen.splice(seen.indexOf(hit), 1); return Promise.resolve(hit); }
    return new Promise((resolve, reject) => {
      const w = { test, resolve: (m) => { clearTimeout(timer); seen.splice(seen.indexOf(m), 1); resolve(m); } };
      const timer = setTimeout(() => { waiters.splice(waiters.indexOf(w), 1); reject(new Error('no such message')); }, ms);
      waiters.push(w);
    });
  };
  ws.json = (obj) => ws.send(JSON.stringify(obj));
  ws.opened = new Promise((resolve, reject) => { ws.on('open', resolve); ws.on('error', reject); });
  return ws;
}

function solve(challenge, bits) {
  for (let n = 0; ; n++) {
    const nonce = n.toString(36);
    const h = crypto.createHash('sha256').update(`${challenge}:${nonce}`).digest();
    if ((h.readUInt32BE(0) >>> (32 - bits)) === 0) return nonce;
  }
}

async function joinViewer(name) {
  const ws = connect(pub, 'viewer');
  await ws.opened;
  const pow = await ws.next((m) => m.t === 'pow');
  ws.json({ t: 'join', name, pow: solve(pow.c, pow.bits) });
  const joined = await ws.next((m) => m.t === 'joined');
  return { ws, joined };
}

test('the viewer page is public and carries its security headers', async () => {
  const r = await get(pub, '/');
  assert.equal(r.status, 200);
  assert.match(r.headers.get('content-security-policy'), /default-src 'self'/);
  assert.equal(r.headers.get('x-robots-tag'), 'noindex, nofollow');
  assert.match(await r.text(), /silent<b>\.<\/b>cinema/);
  assert.equal((await get(pub, '/static/hls.min.js')).status, 200);
  assert.equal((await get(pub, '/static/../server.js')).status, 404);
});

test('the host page exists only on the host listener', async () => {
  assert.equal((await get(pub, '/host')).status, 404);
  assert.equal((await get(pub, '/api/probe?path=/etc/passwd')).status, 404);
  assert.equal((await get(host, '/host')).status, 200);
  // a dns rebinding page would arrive under its own name
  assert.equal(await statusWithHost(host, '/host', 'evil.example'), 421);
  assert.equal(await statusWithHost(host, '/host', `localhost:${host}`), 200);
});

test('the host websocket is refused on the public listener', async () => {
  const ws = new WebSocket(`ws://127.0.0.1:${pub}/ws?role=host`, { origin: `http://127.0.0.1:${pub}` });
  const status = await new Promise((resolve) => ws.on('unexpected-response', (_, res) => resolve(res.statusCode)));
  assert.equal(status, 404);
});

test('a websocket from another site is refused', async () => {
  const ws = new WebSocket(`ws://127.0.0.1:${pub}/ws?role=viewer`, { origin: 'https://evil.example' });
  const status = await new Promise((resolve) => ws.on('unexpected-response', (_, res) => resolve(res.statusCode)));
  assert.equal(status, 403);
});

test('a nick needs the proof of work', async () => {
  const ws = connect(pub, 'viewer');
  await ws.opened;
  await ws.next((m) => m.t === 'pow');
  ws.json({ t: 'join', name: 'bot', pow: 'nope' });
  assert.equal((await ws.next((m) => m.t === 'joinerr')).code, 'reload');
  ws.close();

  const { ws: ok, joined } = await joinViewer('anna');
  assert.equal(joined.name, 'anna');
  assert.match(joined.id, /^[0-9a-f]{16}$/);
  ok.close();
});

test('nobody can take the host\'s nick', async () => {
  const ws = connect(pub, 'viewer');
  await ws.opened;
  const pow = await ws.next((m) => m.t === 'pow');
  ws.json({ t: 'join', name: 'Host', pow: solve(pow.c, pow.bits) });
  assert.equal((await ws.next((m) => m.t === 'joinerr')).code, 'host_nick');
  ws.close();
});

test('the host starts a film from the folder and the viewer gets the stream', { skip: !hasFfmpeg && 'ffmpeg not found' }, async () => {
  const { ws: viewer, joined } = await joinViewer('mira');
  const hostWs = connect(host, 'host');
  await hostWs.opened;
  const hello = await hostWs.next((m) => m.t === 'hello');
  assert.equal(hello.picker.library, true);

  // a forged path is refused: only what the server listed may start
  hostWs.json({ t: 'pick', path: '/etc/passwd', viewers: [joined.id] });
  assert.equal((await hostWs.next((m) => m.t === 'error')).code, 'file_unavailable');

  hostWs.json({ t: 'library' });
  const lib = await hostWs.next((m) => m.t === 'library');
  assert.deepEqual(lib.files.map((f) => f.rel), ['clip.mkv']);
  const probe = await (await get(host, `/api/probe?path=${encodeURIComponent(lib.files[0].path)}`)).json();
  assert.equal(probe.video.width, 320);
  assert.equal(probe.audio.length, 1);

  hostWs.json({ t: 'pick', path: lib.files[0].path, viewers: [joined.id] });
  const ready = await viewer.next((m) => m.t === 'session' && m.session && m.session.status === 'ready', 30000);
  const master = await get(pub, ready.session.master);
  assert.equal(master.status, 200);
  assert.match(await master.text(), /#EXT-X-STREAM-INF/);
  const seg = await get(pub, ready.session.master.replace('master.m3u8', 'v0_0.ts'));
  assert.equal(seg.status, 200);
  assert.ok((await seg.arrayBuffer()).byteLength > 1000);
  // a made up key gets nothing
  assert.equal((await get(pub, '/hls/0123456789abcdef0123456789abcdef/master.m3u8')).status, 404);

  // play: the clock runs for everyone
  viewer.json({ t: 'play' });
  const st = await hostWs.next((m) => m.t === 'state' && m.playing);
  assert.equal(st.by.name, 'mira');

  hostWs.json({ t: 'stop' });
  const end = await viewer.next((m) => m.t === 'session' && m.session === null);
  assert.equal(end.reason, 'host_ended');
  viewer.close();
  hostWs.close();
});
