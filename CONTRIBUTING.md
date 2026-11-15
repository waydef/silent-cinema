# contributing

bug reports, fixes and translations are welcome.

## setup

```sh
npm ci
MEDIA_DIR=/path/to/some/videos npm start
```

the host page is at `http://127.0.0.1:8088/host`, viewers use `http://localhost:8080/`. a second browser profile or a private window works as a second viewer, since the identity lives in `localStorage`. keep test tabs muted, or use silent test files.

there is no build step. client files in `public/` are served as they are, and open pages reload themselves when one of them changes. `server.js` and `stream.js` need a restart.

## before a pull request

```sh
npm run check
npm test
```

both must pass. the streaming test needs `ffmpeg` and `ffprobe`; it is skipped without them, but ci runs it.

## code

- plain javascript, no frameworks, two runtime dependencies (`ws`, `hls.js`). please do not add more without a good reason.
- comments explain why something is done, not what the next line does.
- every text a user sees goes through `tr()` from `public/i18n.js`, in english and russian. server errors travel as codes (`{ code: 'nick_taken' }`) and are translated in the browser.
- user text is written with `textContent`, never `innerHTML`.
- motion uses `transform` and `opacity` and respects `prefers-reduced-motion`.

## translations

add a language by copying the `en` block in `public/i18n.js` under a new two letter key. values are templates with `{name}` slots or functions of those values, which is how plurals are written.

## commits

short lowercase subject that starts with a verb ("fix", "add", "move"), body with the reason when it is not obvious.
