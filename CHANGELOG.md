# changelog

## 1.0.0 (2026-11-15)

first public release.

- watch party for one host and up to 40 viewers with a server-owned playback clock
- on-demand hls from a local file: bit-exact copy for h264, x264 for other codecs, 720p and 480p levels
- per viewer audio track, text subtitles and quality
- chat with replies, reactions, typing state and avatars
- film folder list on the host page, desktop file dialog as an option
- english and russian interface
- plain http behind a reverse proxy or https with its own certificate, reloaded on SIGHUP
- docker image, compose file, systemd unit, caddy and nginx examples
- end to end tests and github actions ci
