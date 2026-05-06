// Minimal preload. The web app talks to the daemon via HTTP+WS over
// 127.0.0.1, so it doesn't need any privileged Node/Electron APIs from
// here. Kept intentionally empty so contextIsolation stays clean.
"use strict";
