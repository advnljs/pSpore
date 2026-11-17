"use strict";
const { contextBridge, ipcRenderer } = require("electron");
contextBridge.exposeInMainWorld("psporeNotification", Object.freeze({
  current: () => ipcRenderer.invoke("pspore:notification:current"),
  act: (action, id) => ipcRenderer.invoke("pspore:notification:action", action, id),
  subscribe(listener) {
    if (typeof listener !== "function") throw new TypeError("Notification listener must be a function");
    const receive = (_event, card) => listener(card);
    ipcRenderer.on("pspore:notification:update", receive);
    return () => ipcRenderer.removeListener("pspore:notification:update", receive);
  },
}));
