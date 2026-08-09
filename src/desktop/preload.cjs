"use strict";

const { contextBridge, ipcRenderer } = require("electron");

const BOOTSTRAP_CHANNEL = "pspore:desktop:bootstrap";
const DISPATCH_CHANNEL = "pspore:desktop:dispatch";
const FRAME_CHANNEL = "pspore:desktop:frame";

const api = Object.freeze({
  bootstrap() {
    return ipcRenderer.invoke(BOOTSTRAP_CHANNEL);
  },
  dispatch(command) {
    return ipcRenderer.invoke(DISPATCH_CHANNEL, command);
  },
  subscribe(listener) {
    if (typeof listener !== "function") throw new TypeError("pSpore frame listener must be a function");
    const receive = (_event, frame) => listener(frame);
    ipcRenderer.on(FRAME_CHANNEL, receive);
    return () => ipcRenderer.removeListener(FRAME_CHANNEL, receive);
  },
});

contextBridge.exposeInMainWorld("pspore", api);
