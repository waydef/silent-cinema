# security

please report vulnerabilities privately through github: "security" tab, "report a vulnerability" (https://github.com/waydef/synced/security/advisories/new). do not open a public issue for them.

include what an attacker can do, the steps to reproduce it and the version or commit.

## scope

the public listener (viewer page, websocket, stream) is meant to face the internet, so anything that lets a viewer or an outsider take the host role, read files the host did not pick, reach another person's stream key, crash the server or exhaust it cheaply is in scope.

the host listener is trusted by design: whoever can open it controls the room and can browse the film folder. keep it on loopback (the default) or behind ssh.
