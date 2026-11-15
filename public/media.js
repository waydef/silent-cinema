'use strict';
// loads the hls stream of a session into a video element and lets every client pick its own
// audio track, subtitles and quality (stored in this browser only). the quality is one fixed
// level per load: no automatic switching mid film. apple browsers play hls natively, the rest
// go through hls.js.
function createMedia(video) {
  let hls = null;
  let session = null;
  let native = false;
  const state = { audio: 0, sub: -1, quality: 'q0' };
  let onChange = () => {};
  let onError = () => {};
  let resets = [];
  let position = () => video.currentTime;               // times of media resets, a loop of them ends in the error cover

  const apple = () => /Apple/.test(navigator.vendor || '') && !!video.canPlayType('application/vnd.apple.mpegurl');

  function audioName(a) {
    const lang = a.lang && a.lang !== 'und' ? a.lang : '';
    const ch = a.channels ? (a.channels > 2 ? `${a.channels - 1}.1` : a.channels === 1 ? tr('track.mono') : tr('track.stereo')) : '';
    return [a.title || '', lang, ch].filter(Boolean).join(' · ') || tr('track.audio', { n: a.index + 1 });
  }
  function subName(s) {
    return [s.title || '', s.lang && s.lang !== 'und' ? s.lang : ''].filter(Boolean).join(' · ') || tr('track.sub', { n: s.index + 1 });
  }
  const level = () => (session && session.levels.find((l) => 'q' + l.id === state.quality)) || (session && session.levels[0]);
  const levelName = (l) => (l.label === 'original' ? tr('q.original') : l.label);

  function applyAudio() {
    if (hls && hls.audioTracks.length) hls.audioTrack = Math.min(state.audio, hls.audioTracks.length - 1);
    const list = native && video.audioTracks;
    if (list && list.length) for (let i = 0; i < list.length; i++) list[i].enabled = i === Math.min(state.audio, list.length - 1);
  }
  function applySub() {
    for (const t of video.querySelectorAll('track')) t.remove();
    if (!session || state.sub < 0) return;
    const s = session.subs[state.sub];
    if (!s) return;
    const t = document.createElement('track');
    t.kind = 'subtitles';
    t.label = subName(s);
    t.srclang = (s.lang || 'und').slice(0, 3);
    t.src = s.url;
    t.default = true;
    video.append(t);
    t.addEventListener('load', () => { t.track.mode = 'showing'; });
    t.track.mode = 'showing';
  }

  function destroy() {
    if (hls) { hls.destroy(); hls = null; }
    video.removeAttribute('src');
    for (const t of video.querySelectorAll('track')) t.remove();
    video.load();
  }

  function load(s, startAt) {
    destroy();
    session = s;
    state.audio = Math.max(0, Math.min(PREF.get('audio', 0), s.audio.length - 1));
    state.sub = Math.min(PREF.get('sub', -1), s.subs.length - 1);
    state.quality = PREF.get('q', 'q0');
    if (!s.levels.some((l) => 'q' + l.id === state.quality)) state.quality = 'q0';
    const url = `${s.master}?v=${level().id}`;
    native = apple() || !(window.Hls && Hls.isSupported());
    if (!native) {
      hls = new Hls({
        maxBufferLength: 60, maxMaxBufferLength: 120, backBufferLength: 30,
        capLevelToPlayerSize: false, startFragPrefetch: true, enableWorker: true,
        startPosition: Number.isFinite(startAt) ? startAt : (Number.isFinite(s.pos) ? s.pos : -1),
      });
      hls.on(Hls.Events.AUDIO_TRACKS_UPDATED, applyAudio);
      let retries = 0;
      hls.on(Hls.Events.FRAG_LOADED, () => { retries = 0; });
      hls.on(Hls.Events.ERROR, (e, d) => {
        if (!d.fatal) return;
        onError(`hls ${d.type} ${d.details}${d.response ? ' http ' + d.response.code : ''}`);
        if (d.type === Hls.ErrorTypes.NETWORK_ERROR && ++retries <= 6) return setTimeout(() => hls && hls.startLoad(), 800 * retries);
        if (d.type === Hls.ErrorTypes.MEDIA_ERROR) {
          // a media reset is fine once in a while; several in a row means it cannot play
          const now = Date.now();
          resets = resets.filter((t) => now - t < 20000);
          resets.push(now);
          if (resets.length <= 3) return hls.recoverMediaError();
        }
        onError('fatal', true);
      });
      hls.loadSource(url);
      hls.attachMedia(video);
    } else if (video.canPlayType('application/vnd.apple.mpegurl')) {
      video.src = url;
      if (video.audioTracks) video.audioTracks.onaddtrack = applyAudio;
    } else {
      onError(tr('fail.nomse'), true);
    }
    applySub();
    onChange();
  }

  return {
    load,
    destroy,
    bind(fn) { onChange = fn; },
    positionFrom(fn) { position = fn; },
    onError(fn) { onError = fn; },
    reload(at) { if (session) { resets = []; load(session, at ?? position()); } },
    get session() { return session; },
    get hls() { return hls; },
    get quality() { return state.quality; },
    options() {
      if (!session) return [];
      const out = [];
      const audioSwitch = !native || (video.audioTracks && video.audioTracks.length > 1);
      if (session.audio.length > 1 && audioSwitch) {
        out.push({ title: tr('set.audio'), key: 'audio', items: session.audio.map((a, i) => ({ value: i, label: audioName(a) })), current: state.audio });
      }
      if (session.subs.length) {
        out.push({ title: tr('set.subs'), key: 'sub', items: [{ value: -1, label: tr('set.subsOff') }, ...session.subs.map((s, i) => ({ value: i, label: subName(s) }))], current: state.sub });
      }
      if (session.levels.length > 1) {
        out.push({ title: tr('set.quality'), key: 'q', current: state.quality, items: session.levels.map((l) => ({ value: 'q' + l.id, label: levelName(l) })) });
      }
      return out;
    },
    choose(key, value) {
      if (key === 'audio') { state.audio = value; PREF.set('audio', value); applyAudio(); }
      else if (key === 'sub') { state.sub = value; PREF.set('sub', value); applySub(); }
      else if (key === 'q') {
        const changed = value !== state.quality;
        state.quality = value;
        PREF.set('q', value);
        // one level per load: a new quality is a fresh load, the sync puts it back on the frame
        if (changed && session) load(session, position());
      }
      onChange();
    },
  };
}
