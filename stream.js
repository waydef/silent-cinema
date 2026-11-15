'use strict';
// on-demand hls for one local file. nothing is prepared up front: playlists come from the
// keyframe index (matroska cues or an ffprobe packet scan) and segments are cut when a player
// asks for them. the "original" level copies the video bit for bit, and it and every audio track
// come from one continuous ffmpeg run each (a lane), so segment borders are gapless. the lower
// levels are encoded segment by segment.
const fs = require('fs');
const path = require('path');
const { spawn, execFile } = require('child_process');

const SHIFT = 10;            // seconds added to every timestamp so b-frame dts never goes negative
const MIN_SEG = 5;           // shortest segment, cut only on keyframes
const KEEP_BEHIND = 30;      // segments kept behind the last request, older ones are deleted
const LANE_AHEAD = 12;       // a continuous run pauses this many segments ahead of the player
const LANE_REACH = 8;        // a request this far past the run's progress restarts it there
const MAX_JOBS = 4;
const MAX_PREFETCH_QUEUE = 8;  // prefetches beyond this are refused; a seek never waits behind them
const MAX_URGENT_QUEUE = 8;    // waiting ffmpeg jobs players asked for; beyond this a request gets 503

const LEVELS = [
  { id: 0, label: 'original', height: 0 },
  { id: 1, label: '720p', height: 720, kbps: 3500 },
  { id: 2, label: '480p', height: 480, kbps: 1500 },
];

// ---------- keyframe index ----------

function readVint(buf, pos, keepMarker) {
  const b = buf[pos];
  let len = 1;
  let mask = 0x80;
  while (len <= 8 && !(b & mask)) { len++; mask >>= 1; }
  let val = keepMarker ? b : (b & (mask - 1));
  let unknown = !keepMarker && (b & (mask - 1)) === mask - 1;
  for (let i = 1; i < len; i++) {
    val = val * 256 + buf[pos + i];
    if (buf[pos + i] !== 0xff) unknown = false;
  }
  return { val, len, unknown };
}

function* children(buf, start, end) {
  let p = start;
  while (p < end) {
    const id = readVint(buf, p, true);
    p += id.len;
    const sz = readVint(buf, p, false);
    p += sz.len;
    const dataEnd = sz.unknown ? end : p + sz.val;
    yield { id: id.val, start: p, end: Math.min(dataEnd, end) };
    p = dataEnd;
  }
}

function uint(buf, a, b) {
  let v = 0;
  for (let i = a; i < b; i++) v = v * 256 + buf[i];
  return v;
}

// keyframe times from the matroska Cues element, or null when the file has none
function matroskaCues(file) {
  const fd = fs.openSync(file, 'r');
  try {
    const head = Buffer.alloc(1 << 20);
    fs.readSync(fd, head, 0, head.length, 0);
    let seg = null;
    for (const e of children(head, 0, head.length)) if (e.id === 0x18538067) { seg = e; break; }
    if (!seg) return null;
    let cuesPos = null;
    let scale = 1e6;
    for (const e of children(head, seg.start, head.length)) {
      if (e.id === 0x114D9B74) {
        for (const sk of children(head, e.start, e.end)) {
          if (sk.id !== 0x4DBB) continue;
          let id = null;
          let pos = null;
          for (const f of children(head, sk.start, sk.end)) {
            if (f.id === 0x53AB) id = uint(head, f.start, f.end);
            if (f.id === 0x53AC) pos = uint(head, f.start, f.end);
          }
          if (id === 0x1C53BB6B) cuesPos = pos;
        }
      }
      if (e.id === 0x1549A966) {
        for (const f of children(head, e.start, e.end)) if (f.id === 0x2AD7B1) scale = uint(head, f.start, f.end);
      }
    }
    if (cuesPos === null) return null;
    const hh = Buffer.alloc(16);
    fs.readSync(fd, hh, 0, 16, seg.start + cuesPos);
    const id = readVint(hh, 0, true);
    if (id.val !== 0x1C53BB6B) return null;
    const sz = readVint(hh, id.len, false);
    if (sz.unknown || sz.val > 64 << 20) return null;
    const body = Buffer.alloc(sz.val);
    fs.readSync(fd, body, 0, sz.val, seg.start + cuesPos + id.len + sz.len);
    const times = [];
    for (const cp of children(body, 0, body.length)) {
      if (cp.id !== 0xBB) continue;
      for (const f of children(body, cp.start, cp.end)) if (f.id === 0xB3) times.push((uint(body, f.start, f.end) * scale) / 1e9);
    }
    times.sort((a, b) => a - b);
    return times.length > 1 ? times : null;
  } catch {
    return null;
  } finally {
    fs.closeSync(fd);
  }
}

function run(cmd, args, opts = {}) {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { maxBuffer: 256 << 20, ...opts }, (err, out) => (err ? reject(err) : resolve(out)));
  });
}

// reorder delay (pts - dts of a keyframe) read from a small window around one cue
async function keyframeDelay(file, t) {
  const out = await run('ffprobe', ['-v', 'error', '-select_streams', 'v:0', '-read_intervals', `${Math.max(0, t - 1)}%+4`,
    '-show_entries', 'packet=pts_time,dts_time,flags', '-of', 'csv=p=0', file]);
  for (const line of out.split('\n')) {
    const [pts, dts, flags] = line.split(',');
    if (flags && flags.includes('K') && Math.abs(Number(pts) - t) < 0.003 && Number.isFinite(Number(dts))) return Number(pts) - Number(dts);
  }
  return 0;
}

// every keyframe as { pts, dts }, by reading the packet list (slow on big non-indexed files)
function scanKeyframes(file) {
  return new Promise((resolve, reject) => {
    const p = spawn('nice', ['-n', '10', 'ffprobe', '-v', 'error', '-select_streams', 'v:0', '-show_entries',
      'packet=pts_time,dts_time,flags', '-of', 'csv=p=0', file], { stdio: ['ignore', 'pipe', 'ignore'] });
    const kf = [];
    let rest = '';
    p.stdout.on('data', (d) => {
      rest += d;
      let i;
      while ((i = rest.indexOf('\n')) >= 0) {
        const [pts, dts, flags] = rest.slice(0, i).split(',');
        rest = rest.slice(i + 1);
        if (flags && flags.includes('K') && Number.isFinite(Number(pts))) {
          kf.push({ pts: Number(pts), dts: Number.isFinite(Number(dts)) ? Number(dts) : Number(pts) });
        }
      }
    });
    p.on('error', reject);
    p.on('close', (code) => (code === 0 && kf.length ? resolve(kf) : reject(new Error('no_keyframes'))));
  });
}

async function keyframeIndex(file) {
  const cues = matroskaCues(file);
  if (cues) {
    const d = await keyframeDelay(file, cues[Math.min(2, cues.length - 1)]).catch(() => 0);
    return cues.map((t) => ({ pts: t, dts: t - d, d }));
  }
  return scanKeyframes(file);
}

// ---------- segments ----------

function cutSegments(kf, duration) {
  const segs = [];
  let start = kf[0];
  for (let i = 1; i < kf.length; i++) {
    if (kf[i].pts - start.pts >= MIN_SEG) {
      segs.push({ start: start.pts, startDts: start.dts, end: kf[i].pts, endDts: kf[i].dts });
      start = kf[i];
    }
  }
  const end = Math.max(duration, start.pts + 0.5);
  segs.push({ start: start.pts, startDts: start.dts, end, endDts: null });
  return segs;
}

const safe = (s) => String(s || '').replace(/["\r\n,]/g, ' ').trim();

// one continuous ffmpeg run that writes consecutive segments of one kind. cutting every segment
// in its own run lost a frame of the copied video at each border (open gop) and let the separately
// encoded aac pieces overlap by about 30 ms, which the browser heard as a click every few seconds.
// inside one run the stream stays continuous. the run pauses (SIGSTOP) when it is far ahead of the
// player and restarts at the requested segment after a seek.
class Lane {
  constructor(stream, kind) {
    this.st = stream;
    this.kind = kind;
    this.run = null;
    this.want = 0;               // highest segment a player asked for lately
  }

  file(i) { return path.join(this.st.dir, `${this.kind}_${i}.ts`); }

  get(i) {
    if (fs.existsSync(this.file(i))) return Promise.resolve(this.file(i));
    this.want = i;
    let r = this.run;
    // the run only moves forward: a segment it already wrote and that was deleted since (a seek
    // back further than KEEP_BEHIND) needs a new run, or the request would wait forever
    if (!r || r.dead || i < r.next || i >= r.next + LANE_REACH) r = this.start(i);
    else if (r.paused && i >= r.next - LANE_AHEAD / 2) this.resume(r);
    return new Promise((resolve, reject) => {
      if (!r.waiters.has(i)) r.waiters.set(i, []);
      r.waiters.get(i).push({ resolve, reject });
    });
  }

  touch(i) {
    this.want = Math.max(this.want, i);
    const r = this.run;
    if (r && r.paused && r.next < this.want + LANE_AHEAD / 2) this.resume(r);
  }

  resume(r) {
    r.paused = false;
    try { r.proc.kill('SIGCONT'); } catch { /* already gone */ }
  }

  start(i) {
    const old = this.run;
    const segs = this.st.segs;
    const s = segs[i];
    const r = { from: i, next: i, waiters: new Map(), paused: false, dead: false, proc: null };
    if (old && !old.dead) {
      old.dead = true;
      try { old.proc.kill('SIGCONT'); old.proc.kill('SIGKILL'); } catch { /* gone */ }
      // players waiting just ahead get their segment from the new run; the rest retry. a request
      // far ahead (another player's old position after a seek back) must not ride along: the new run
      // pauses near the seek target and that player would hang until the film reached its segment
      for (const [k, w] of old.waiters) {
        if (k >= i && k < i + LANE_REACH) r.waiters.set(k, w); else w.forEach((x) => x.reject(new Error('lane restarted')));
      }
    }
    this.run = r;
    const video = this.kind === 'v0';
    // the copy has to start on the keyframe itself, so the seek lands just behind it
    const ss = video ? s.start + (s.start - s.startDts) + 0.2 : s.start;
    const times = [];
    for (let j = i + 1; j < segs.length; j++) times.push((segs[j].start - ss).toFixed(3));
    const args = ['-nostdin', '-v', 'error', '-y', '-ss', ss.toFixed(3), '-i', this.st.file];
    if (video) args.push('-map', '0:v:0', '-an', '-sn', '-dn', '-c:v', 'copy', '-avoid_negative_ts', 'disabled');
    else args.push('-map', `0:a:${Number(this.kind.slice(1))}`, '-vn', '-sn', '-dn', '-c:a', 'aac', '-b:a', '192k', '-ac', '2');
    args.push('-output_ts_offset', (ss + SHIFT).toFixed(3), '-muxdelay', '0', '-muxpreload', '0', '-f', 'segment');
    if (times.length) args.push('-segment_times', times.join(','));
    args.push('-segment_start_number', String(i), '-segment_format', 'mpegts', '-segment_list', 'pipe:1', '-segment_list_type', 'flat',
      path.join(this.st.dir, `${this.kind}_%d.part.ts`));
    const p = spawn('nice', ['-n', '10', 'ffmpeg', ...args], { stdio: ['ignore', 'pipe', 'pipe'] });
    r.proc = p;
    this.st.procs.add(p);
    let rest = '';
    let err = '';
    p.stdout.on('data', (d) => {
      rest += d;
      let k;
      while ((k = rest.indexOf('\n')) >= 0) {
        const name = rest.slice(0, k).trim();
        rest = rest.slice(k + 1);
        const m = /_(\d+)\.part\.ts$/.exec(name);
        if (!m || r.dead) continue;
        const n = Number(m[1]);
        try { fs.renameSync(path.join(this.st.dir, name), this.file(n)); } catch { continue; }
        r.next = n + 1;
        const w = r.waiters.get(n);
        if (w) { r.waiters.delete(n); w.forEach((x) => x.resolve(this.file(n))); }
        // never pause while somebody still waits for a segment of this run
        if (!r.paused && r.next > this.want + LANE_AHEAD && !r.waiters.size) {
          r.paused = true;
          try { p.kill('SIGSTOP'); } catch { /* gone */ }
        }
      }
    });
    p.stderr.on('data', (d) => { err = (err + d).slice(-600); });
    p.on('error', () => {});
    p.on('close', (code) => {
      this.st.procs.delete(p);
      if (r.dead) return;
      r.dead = true;
      const e = new Error(code === 0 ? 'lane ended' : `ffmpeg ${code}: ${err.trim().split('\n').pop()}`);
      for (const w of r.waiters.values()) w.forEach((x) => x.reject(e));
      r.waiters.clear();
    });
    return r;
  }

  stop() {
    const r = this.run;
    if (!r || r.dead) return;
    r.dead = true;
    try { r.proc.kill('SIGCONT'); r.proc.kill('SIGKILL'); } catch { /* gone */ }
    for (const w of r.waiters.values()) w.forEach((x) => x.reject(new Error('stopped')));
  }
}

class Stream {
  constructor(file, meta, dir) {
    this.file = file;
    this.meta = meta;           // { duration, video:{codec,width,height}, audio:[], subs:[] }
    this.dir = dir;
    this.sizeBytes = fs.statSync(file).size;
    this.segs = [];
    this.inflight = new Map();
    this.queue = [];             // jobs a player is waiting for
    this.bgQueue = [];           // prefetches, run only when nothing urgent waits
    this.active = 0;
    this.procs = new Set();
    this.dead = false;
    this.subJob = null;
    this.lanes = new Map();
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  }

  async init() {
    const kf = await keyframeIndex(this.file);
    this.segs = cutSegments(kf, this.meta.duration);
    // browsers decode 8-bit h264 only; hevc, av1 or 10-bit sources get a 1080p x264 top level instead
    // of the copy. so do blu-ray remuxes whose keyframes are not idr frames (open gop): a browser
    // cannot start decoding there, so every seek or join in the middle of such a copy hangs
    const v = this.meta.video || {};
    this.copyOk = v.codec === 'h264' && /^yuvj?420p$/.test(v.pix || 'yuv420p') && await this.idrKeyframes();
    const h = Math.min(v.height || 1080, 1080);
    const top = this.copyOk ? LEVELS[0] : { id: 0, label: `${h}p`, height: h, kbps: 14000, crf: 19 };
    const topHeight = this.copyOk ? v.height || 0 : top.height;
    this.levels = [top, ...LEVELS.slice(1).filter((l) => topHeight > l.height)];
    if (this.meta.subs.length) this.subJob = this.extractSubs();
  }

  // looks at three keyframes in the middle of the film: are they real idr frames?
  async idrKeyframes() {
    const segs = this.segs;
    for (const f of [0.25, 0.5, 0.75]) {
      const s = segs[Math.floor(segs.length * f)];
      if (!s) continue;
      const ss = s.start + (s.start - s.startDts) + 0.2;
      const out = await new Promise((resolve) => {
        execFile('ffmpeg', ['-v', 'trace', '-nostdin', '-ss', ss.toFixed(3), '-i', this.file, '-map', '0:v:0', '-c', 'copy',
          '-bsf:v', 'trace_headers', '-frames:v', '1', '-f', 'null', '-'], { maxBuffer: 64 << 20 }, (err, so, se) => resolve(String(se || '')));
      });
      // only the bitstream filter sees the packet after the seek; the probe lines are from the file start
      const m = /\[trace_headers[^\]]*\] nal_unit_type: (1|5)\(/.exec(out);
      if (m && m[1] === '1') return false;
    }
    return true;
  }

  // one pass over the file for all text subtitle tracks
  extractSubs() {
    const args = ['-nostdin', '-v', 'error', '-y', '-i', this.file];
    for (const s of this.meta.subs) args.push('-map', `0:s:${s.index}`, '-f', 'webvtt', path.join(this.dir, `s${s.index}.vtt.part`));
    return this.spawnJob(args).then(() => {
      for (const s of this.meta.subs) {
        const p = path.join(this.dir, `s${s.index}.vtt`);
        try { fs.renameSync(`${p}.part`, p); } catch { /* track failed to convert */ }
      }
    }).catch(() => {});
  }

  async subtitle(k) {
    await this.subJob;
    const p = path.join(this.dir, `s${k}.vtt`);
    return fs.existsSync(p) ? p : null;
  }

  playlist(kind) {
    const segs = this.segs;
    const target = Math.ceil(Math.max(...segs.map((s) => s.end - s.start)));
    const out = ['#EXTM3U', '#EXT-X-VERSION:3', `#EXT-X-TARGETDURATION:${target}`, '#EXT-X-MEDIA-SEQUENCE:0', '#EXT-X-PLAYLIST-TYPE:VOD'];
    segs.forEach((s, i) => { out.push(`#EXTINF:${(s.end - s.start).toFixed(3)},`, `${kind}_${i}.ts`); });
    out.push('#EXT-X-ENDLIST');
    return out.join('\n') + '\n';
  }

  // `only` limits the playlist to one video level: the quality is chosen by the person, never
  // switched by the player mid film (switching between the copy and an encode needs a media reset)
  master(only = null) {
    const m = this.meta;
    const out = ['#EXTM3U', '#EXT-X-VERSION:3'];
    m.audio.forEach((a, i) => {
      const name = safe(`${a.index + 1} ${a.lang || ''} ${a.title || a.codec}`) || `track ${a.index + 1}`;
      out.push(`#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="aud",NAME="${name}",LANGUAGE="${safe(a.lang) || 'und'}",DEFAULT=${i === 0 ? 'YES' : 'NO'},AUTOSELECT=YES,URI="a${a.index}.m3u8"`);
    });
    const w = (m.video && m.video.width) || 1920;
    const h = (m.video && m.video.height) || 1080;
    const origBw = Math.max(2e6, Math.round((this.sizeBytes * 8) / Math.max(1, m.duration)));
    for (const l of this.levels) {
      if (only !== null && l.id !== only && this.levels.some((x) => x.id === only)) continue;
      const copy = l.id === 0 && this.copyOk;
      const bw = copy ? origBw : l.kbps * 1000 + 192000;
      const res = copy ? `${w}x${h}` : `${Math.round((w * l.height) / h / 2) * 2}x${l.height}`;
      out.push(`#EXT-X-STREAM-INF:BANDWIDTH=${bw},RESOLUTION=${res},NAME="${l.label}"${m.audio.length ? ',AUDIO="aud"' : ''}`, `v${l.id}.m3u8`);
    }
    return out.join('\n') + '\n';
  }

  // path of a finished segment, cutting it first when it does not exist yet
  // the copied video and every audio track come from continuous runs, the scaled levels per segment
  laneKind(kind) { return (kind === 'v0' && this.copyOk) || kind[0] === 'a'; }

  segment(kind, i, urgent = true) {
    if (this.dead || !this.segs[i]) return Promise.reject(new Error('no segment'));
    if (this.laneKind(kind)) {
      if (!this.lanes.has(kind)) this.lanes.set(kind, new Lane(this, kind));
      return this.lanes.get(kind).get(i);
    }
    const file = path.join(this.dir, `${kind}_${i}.ts`);
    if (fs.existsSync(file)) return Promise.resolve(file);
    const key = `${kind}_${i}`;
    let e = this.inflight.get(key);
    if (!e) {
      e = { job: null, waiters: 0 };
      e.promise = this.cut(kind, i, file, e, urgent).finally(() => this.inflight.delete(key));
      this.inflight.set(key, e);
    } else if (urgent && e.job && this.bgQueue.includes(e.job)) {
      // a player now waits for a segment that was only prefetched: move it to the front
      this.bgQueue.splice(this.bgQueue.indexOf(e.job), 1);
      this.queue.unshift(e.job);
      this.pump();
    }
    if (urgent) e.waiters++;
    return e.promise;
  }

  // a player gave up on a segment (seek, closed tab): a job nobody waits for any more leaves the queue
  // instead of holding up the segment that is wanted now. a job already running is left to finish
  release(kind, i) {
    const e = this.inflight.get(`${kind}_${i}`);
    if (!e || !e.waiters) return;
    e.waiters--;
    if (e.waiters || !e.job) return;
    const at = this.queue.indexOf(e.job);
    if (at < 0) return;
    this.queue.splice(at, 1);
    e.job.reject(new Error('abandoned'));
  }

  prefetch(kind, i, n) {
    if (this.laneKind(kind)) { const l = this.lanes.get(kind); if (l) l.touch(i); }
    else for (let k = 1; k <= n; k++) if (this.segs[i + k]) this.segment(kind, i + k, false).catch(() => {});
    const old = path.join(this.dir, `${kind}_${i - KEEP_BEHIND}.ts`);
    fs.rm(old, { force: true }, () => {});
  }

  async cut(kind, i, file, entry, urgent) {
    const s = this.segs[i];
    const part = `${file}.part`;
    const dur = s.end - s.start;
    const args = ['-nostdin', '-v', 'error', '-y'];
    if (kind === 'v0' && this.copyOk) {
      const d = s.start - s.startDts;
      args.push('-ss', (s.start + d + 0.2).toFixed(3), '-i', this.file, '-copyts');
      if (s.endDts !== null) args.push('-to', (s.endDts - 0.0005).toFixed(4));
      args.push('-map', '0:v:0', '-an', '-sn', '-dn', '-c:v', 'copy', '-avoid_negative_ts', 'disabled',
        '-output_ts_offset', String(SHIFT), '-muxdelay', '0', '-muxpreload', '0', '-f', 'mpegts', part);
    } else if (kind[0] === 'v') {
      const lv = this.levels.find((l) => l.id === Number(kind.slice(1)));
      args.push('-ss', s.start.toFixed(3), '-i', this.file, '-t', dur.toFixed(3), '-map', '0:v:0', '-an', '-sn', '-dn',
        '-vf', `scale=-2:${lv.height}`, '-c:v', 'libx264', '-preset', 'veryfast', '-pix_fmt', 'yuv420p',
        ...(lv.crf ? ['-crf', String(lv.crf), '-maxrate', `${lv.kbps}k`, '-bufsize', `${lv.kbps * 2}k`]
          : ['-b:v', `${lv.kbps}k`, '-maxrate', `${Math.round(lv.kbps * 1.4)}k`, '-bufsize', `${lv.kbps * 2}k`]),
        '-g', '250', '-output_ts_offset', (s.start + SHIFT).toFixed(3), '-muxdelay', '0', '-muxpreload', '0', '-f', 'mpegts', part);
    } else {
      const k = Number(kind.slice(1));
      args.push('-ss', s.start.toFixed(3), '-i', this.file, '-t', dur.toFixed(3), '-map', `0:a:${k}`, '-vn', '-sn', '-dn',
        '-c:a', 'aac', '-b:a', '192k', '-ac', '2', '-output_ts_offset', (s.start + SHIFT).toFixed(3),
        '-muxdelay', '0', '-muxpreload', '0', '-f', 'mpegts', part);
    }
    await this.spawnJob(args, urgent, entry);
    fs.renameSync(part, file);
    return file;
  }

  spawnJob(args, urgent = true, entry = null) {
    return new Promise((resolve, reject) => {
      const go = () => {
        if (this.dead) return reject(new Error('stopped'));
        this.active++;
        const p = spawn('nice', ['-n', '10', 'ffmpeg', ...args], { stdio: ['ignore', 'ignore', 'pipe'] });
        this.procs.add(p);
        let err = '';
        p.stderr.on('data', (d) => { err = (err + d).slice(-600); });
        p.on('error', reject);
        p.on('close', (code) => {
          this.procs.delete(p);
          this.active--;
          this.pump();
          if (code === 0) resolve(); else reject(new Error(`ffmpeg ${code}: ${err.trim().split('\n').pop()}`));
        });
      };
      go.reject = reject;
      if (entry) entry.job = go;
      if (urgent && this.queue.length >= MAX_URGENT_QUEUE) return reject(new Error('busy'));
      if (urgent) this.queue.push(go);
      else if (this.bgQueue.length >= MAX_PREFETCH_QUEUE) return reject(new Error('prefetch dropped'));
      else this.bgQueue.push(go);
      this.pump();
    });
  }

  // urgent jobs first; prefetches never take the last slot, so a seek always finds one free
  pump() {
    while (!this.dead) {
      if (this.queue.length && this.active < MAX_JOBS) this.queue.shift()();
      else if (this.bgQueue.length && this.active < MAX_JOBS - 1) this.bgQueue.shift()();
      else break;
    }
  }

  destroy() {
    this.dead = true;
    for (const l of this.lanes.values()) l.stop();
    for (const p of this.procs) { try { p.kill('SIGCONT'); p.kill('SIGKILL'); } catch { /* gone */ } }
    for (const job of [...this.queue, ...this.bgQueue]) job.reject(new Error('stopped'));
    this.queue.length = 0;
    this.bgQueue.length = 0;
    fs.rm(this.dir, { recursive: true, force: true }, () => {});
  }
}

module.exports = { Stream, LEVELS };
