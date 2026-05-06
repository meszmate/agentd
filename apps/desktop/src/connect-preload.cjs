// Preload for the bootstrap connect window only. Exposes a tiny IPC
// surface so the static connect.html page can ask the main process to
// validate + save a daemon URL. The main app window uses preload.cjs
// (empty) — this file is never loaded for the daemon UI.
"use strict";

const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("agentdConnect", {
  getContext: () => ipcRenderer.invoke("agentd-connect:get-context"),
  connect: (url) => ipcRenderer.invoke("agentd-connect:connect", url),
  retryLocal: () => ipcRenderer.invoke("agentd-connect:retry-local"),
  openBun: () => ipcRenderer.invoke("agentd-connect:open-bun"),
  quit: () => ipcRenderer.invoke("agentd-connect:quit"),
});
