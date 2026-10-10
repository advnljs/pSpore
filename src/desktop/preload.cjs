"use strict";

const { contextBridge, ipcRenderer, webUtils } = require("electron");

const BOOTSTRAP_CHANNEL = "pspore:desktop:bootstrap";
const DISPATCH_CHANNEL = "pspore:desktop:dispatch";
const FRAME_CHANNEL = "pspore:desktop:frame";
const SETTINGS_GET_CHANNEL = "pspore:desktop:settings:get";
const SETTINGS_SAVE_CHANNEL = "pspore:desktop:settings:save";
const INDEXING_GET_CHANNEL = "pspore:desktop:indexing:get";
const INDEXING_SAVE_CHANNEL = "pspore:desktop:indexing:save";
const INDEXING_PICK_CHANNEL = "pspore:desktop:indexing:pick";
const ATTACH_CHANNEL = "pspore:desktop:composer:attach";
const ARTICLE_EXPORT_CHANNEL = "pspore:desktop:article:export";
const OPEN_LOCAL_PATH_CHANNEL = "pspore:desktop:open-local-path";

const api = Object.freeze({
  bootstrap() {
    return ipcRenderer.invoke(BOOTSTRAP_CHANNEL);
  },
  dispatch(command) {
    return ipcRenderer.invoke(DISPATCH_CHANNEL, command);
  },
  getSettings() {
    return ipcRenderer.invoke(SETTINGS_GET_CHANNEL);
  },
  saveSettings(settings) {
    return ipcRenderer.invoke(SETTINGS_SAVE_CHANNEL, settings);
  },
  getIndexing() {
    return ipcRenderer.invoke(INDEXING_GET_CHANNEL);
  },
  saveIndexing(settings) {
    return ipcRenderer.invoke(INDEXING_SAVE_CHANNEL, settings);
  },
  pickIndexDirectory() {
    return ipcRenderer.invoke(INDEXING_PICK_CHANNEL);
  },
  pickAttachments(kind) {
    return ipcRenderer.invoke(ATTACH_CHANNEL, kind);
  },
  getPathForFile(file) {
    return webUtils.getPathForFile(file);
  },
  exportArticle(request) {
    return ipcRenderer.invoke(ARTICLE_EXPORT_CHANNEL, request);
  },
  openLocalPath(pathOrUrl) {
    return ipcRenderer.invoke(OPEN_LOCAL_PATH_CHANNEL, pathOrUrl);
  },
  subscribe(listener) {
    if (typeof listener !== "function") throw new TypeError("pSpore frame listener must be a function");
    const receive = (_event, frame) => listener(frame);
    ipcRenderer.on(FRAME_CHANNEL, receive);
    return () => ipcRenderer.removeListener(FRAME_CHANNEL, receive);
  },
});

contextBridge.exposeInMainWorld("pspore", api);
