# changelog

## 1.1.0 (2026-11-15)

reviewed together with gemini 4 hydrogen and checked against a frame-by-frame recording of every animation.

fixes:

- a seek back further than 30 segments made the segment request wait forever and kept ffmpeg from pausing
- a start could pause itself again in the last 40 ms before the agreed moment and begin a second time
- a command from someone else was dropped for up to 5 s while one's own command was still on its way
- after a server restart a player could keep the old stream address and never reload
- paused ffmpeg runs outlived the server on SIGTERM and SIGINT
- a run that moved elsewhere answers 503 with retry-after instead of 500
- play() was retried five times a second when the browser wanted a tap
- the screen could stay awake after a pause that came while the wake lock was being requested

security:

- the map of avatars, which names every nick that set a picture, goes only to pages that joined
- the last x-forwarded-for hop must be an ip address; a one-time hint is logged when a proxy is seen without TRUST_PROXY

motion:

- the settings sheet glides to its new height and slides the next level in, instead of going empty for a moment
- the new-message card goes away as soon as the chat is on screen
- chat and people tabs no longer show both texts at once
- screen changes clear the outgoing text first, so the lobby never shows through the player and the player's chat never lies over the lobby
- the film folder list glides open and follows its content, so the start button moves instead of jumping
- skips from keys and buttons show the same chevrons as a double tap on a phone
- the reaction menu turns opaque in 90 ms; a double click on a message no longer selects a word
- an avatar fades in over its letter without a blank frame

docs: supported systems, cpu cost of transcoding, the TRUST_PROXY limit trap, no room password. the docker health check follows HOST_PORT.

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
